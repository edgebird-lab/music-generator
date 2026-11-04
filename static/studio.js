// Tonstudio: Spuren, Clips, Schneiden, Abmischen. Der Ton läuft komplett im Browser (Web Audio API), derselbe Aufbau spielt ab und rendert den Export.
// Der Server speichert Projekte und Dateien und übernimmt die Rechenaufträge (Spurtrennung, neue Stimme).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
const api = async (path, opts = {}) => {
  const headers = { "X-Lang": LANG, ...(opts.raw ? {} : { "Content-Type": "application/json" }), ...opts.headers };
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : r.statusText);
  }
  return r.json();
};
const fmtTime = (s) => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`; };
const fmtShort = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const VOCAL_KINDS = ["vocals", "take", "recording", "converted"];
const RATE = 48000, ROW = 88, RULER = 28, HANDLE = 7, SNAP_PX = 8, PEAK_HOP = 128, MIN_CLIP = 0.02;
const COLORS = { song: "#6d8cff", vocals: "#d1a75c", take: "#7fbf7f", recording: "#e0708c", converted: "#c58af9", instrumental: "#5b9bd5", drums: "#d9705f", bass: "#a07fd0", other: "#4fb3a5" };

let project = null;              // { id, name, data: { bpm, tracks: [], clips: [], lyrics } }
const media = new Map();         // Medien-ID -> { meta, buffer, peaks, loading }
let sel = new Set(), selTrack = null, clipboard = [], fxTrack = null;   // fxTrack: Spur, deren Effekte der Inspektor gerade zeigt
let pxPerSec = 30, playhead = 0, range = null, loopOn = false;
let undoStack = [], redoStack = [];
let songs = [], assets = [];
let busy = false;

const canvas = $("#stCanvas"), scroller = $("#stScroll"), spacer = $("#stSpacer"), heads = $("#stHeads"), g2d = canvas.getContext("2d");
const tracks = () => project?.data.tracks ?? [];
const clips = () => project?.data.clips ?? [];
const clipEnd = (c) => c.start + c.length;
const projectEnd = () => clips().reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const clipById = (id) => clips().find((c) => c.id === id);
const selected = () => clips().filter((c) => sel.has(c.id));

function info(text, kind = "") {
  const el = $("#stInfo");
  el.className = `st-info ${kind}`;
  el.textContent = text;
  $("#stStatus").textContent = text;
}

// ---------------------------------------------------------------- Audio
let ctx = null, master = null, analyser = null, live = null, playStart = 0, playBase = 0, playing = false, rafId = 0;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
    master = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(analyser);
    analyser.connect(ctx.destination);
  }
  return ctx;
}
function trackLevel(t, anySolo) { return t.mute || (anySolo && !t.solo) ? 0 : t.volume; }

// ---------------------------------------------------------------- Effekte
const FX_DEFAULT = { low: 0, mid: 0, high: 0, comp: 0, hall: 0, hallSize: 2.5, echo: 0, echoDiv: 0.5, echoFb: 30 };
const FX_PRESETS = {
  st_preset_off: {},
  st_preset_vocal: { low: -2, mid: 1, high: 3, comp: 45, hall: 18, hallSize: 1.8 },
  st_preset_rap: { low: -3, mid: 2, high: 2, comp: 60, hall: 6, hallSize: 0.9 },
  st_preset_big: { low: -1, high: 2, comp: 30, hall: 45, hallSize: 5, echo: 12, echoDiv: 1, echoFb: 25 },
  st_preset_echo: { comp: 30, echo: 30, echoDiv: 0.75, echoFb: 40, hall: 10, hallSize: 1.5 },
  st_preset_radio: { low: -12, mid: 6, high: -12, comp: 70 },
  st_preset_beat: { low: 2, high: 1, comp: 25 },
};
const fxOf = (t) => ({ ...FX_DEFAULT, ...t.fx });
const fxActive = (t) => { const f = fxOf(t); return f.low || f.mid || f.high || f.comp || f.hall || f.echo; };
// Welche Bausteine die Spur gerade braucht. Nicht benutzte Effekte hängen gar nicht im Weg: Der Kompressor etwa verzögert das Signal um 6 ms.
const fxShape = (f) => [f.low, f.mid, f.high].map((v) => (v ? 1 : 0)).join("") + (f.comp ? 1 : 0) + (f.hall ? 1 : 0) + (f.echo ? 1 : 0);
const hallCache = new Map();
function hallBuffer(seconds) {
  const key = Math.round(seconds * 10) / 10;
  if (hallCache.has(key)) return hallCache.get(key);
  // Künstlicher Raum: abklingendes Rauschen, das mit der Zeit dunkler wird. Fester Startwert, damit Wiedergabe und Export gleich klingen.
  const len = Math.floor(key * RATE), pre = Math.floor(0.012 * RATE), buf = new AudioBuffer({ length: len + pre, numberOfChannels: 2, sampleRate: RATE });
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let x = 123456789 + ch * 987654, lp = 0;
    for (let i = 0; i < len; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      const pos = i / len, cut = 0.5 * (1 - pos) ** 2 + 0.03;
      lp += cut * ((x >>> 0) / 2147483648 - 1 - lp);
      d[pre + i] = lp * Math.exp(-6.9 * pos);
    }
  }
  hallCache.set(key, buf);
  return buf;
}
const compThreshold = (a) => -a * 0.35, compRatio = (a) => 1 + a * 0.09;
const echoSeconds = (f) => f.echoDiv * 60 / (project?.data.bpm || 120);
function buildFx(ac, input, output, f) {
  const nodes = [], chain = [];
  const eq = (type, freq, q, value) => {
    const b = ac.createBiquadFilter();
    b.type = type; b.frequency.value = freq; b.Q.value = q; b.gain.value = value;
    chain.push(b); nodes.push(b);
    return b;
  };
  const low = f.low ? eq("lowshelf", 120, 0.7, f.low) : null;
  const mid = f.mid ? eq("peaking", 1200, 0.8, f.mid) : null;
  const high = f.high ? eq("highshelf", 8000, 0.7, f.high) : null;
  let comp = null;
  if (f.comp) {
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = compThreshold(f.comp); comp.ratio.value = compRatio(f.comp); comp.knee.value = 12; comp.attack.value = 0.005; comp.release.value = 0.15;
    chain.push(comp); nodes.push(comp);
  }
  let last = input;
  for (const n of chain) { last.connect(n); last = n; }
  last.connect(output);
  let hallSend = null, hallNode = null, echoSend = null, delay = null, fb = null;
  if (f.hall) {
    hallSend = ac.createGain(); hallNode = ac.createConvolver();
    hallSend.gain.value = f.hall / 100; hallNode.buffer = hallBuffer(f.hallSize);
    last.connect(hallSend); hallSend.connect(hallNode); hallNode.connect(output);
    nodes.push(hallSend, hallNode);
  }
  if (f.echo) {
    echoSend = ac.createGain(); delay = ac.createDelay(4); fb = ac.createGain();
    echoSend.gain.value = f.echo / 100; delay.delayTime.value = echoSeconds(f); fb.gain.value = f.echoFb / 100;
    last.connect(echoSend); echoSend.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(output);
    nodes.push(echoSend, delay, fb);
  }
  let hallSize = f.hallSize;
  return {
    nodes,
    update(v, now) {
      const set = (param, value) => param?.setTargetAtTime(value, now, 0.02);
      set(low?.gain, v.low); set(mid?.gain, v.mid); set(high?.gain, v.high);
      set(comp?.threshold, compThreshold(v.comp)); set(comp?.ratio, compRatio(v.comp));
      set(hallSend?.gain, v.hall / 100); set(echoSend?.gain, v.echo / 100); set(fb?.gain, v.echoFb / 100); set(delay?.delayTime, echoSeconds(v));
      if (hallNode && v.hallSize !== hallSize) { hallSize = v.hallSize; hallNode.buffer = hallBuffer(hallSize); }
    },
  };
}
// Hall und Echo klingen nach dem letzten Ton noch aus: Der Export darf das nicht abschneiden
function fxTail() {
  let tail = 0;
  for (const t of tracks()) {
    const f = fxOf(t);
    if (f.hall) tail = Math.max(tail, f.hallSize);
    if (f.echo) tail = Math.max(tail, Math.min(12, echoSeconds(f) * Math.log(0.001) / Math.log(Math.max(f.echoFb / 100, 0.01))));
  }
  return tail;
}

// Baut Spuren und Clips als Klanggraph auf: fürs Abspielen und (mit OfflineAudioContext) für den Export, damit der Export genau so klingt.
function buildGraph(ac, dest, from, to, when) {
  const anySolo = tracks().some((t) => t.solo), nodes = new Map(), srcs = [];
  for (const t of tracks()) {
    const input = ac.createGain(), gain = ac.createGain(), pan = ac.createStereoPanner();
    gain.gain.value = trackLevel(t, anySolo);
    pan.pan.value = t.pan;
    const fx = buildFx(ac, input, gain, fxOf(t));
    gain.connect(pan); pan.connect(dest);
    nodes.set(t.id, { input, gain, pan, fx, shape: fxShape(fxOf(t)) });
  }
  for (const c of clips()) {
    const buf = media.get(c.asset)?.buffer, n = nodes.get(c.track);
    const begin = Math.max(c.start, from), end = Math.min(clipEnd(c), to);
    if (!buf || !n || end <= begin) continue;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buf;
    src.connect(g); g.connect(n.input);
    const at = when + begin - from, inClip = begin - c.start;
    const level = (x) => c.gain * Math.min(1, c.fadeIn > 0 ? x / c.fadeIn : 1, c.fadeOut > 0 ? (c.length - x) / c.fadeOut : 1);
    g.gain.setValueAtTime(level(inClip), at);
    if (c.fadeIn > inClip) g.gain.linearRampToValueAtTime(c.gain, at + c.fadeIn - inClip);
    if (c.fadeOut > 0) {
      const foStart = Math.max(c.length - c.fadeOut, inClip);
      g.gain.setValueAtTime(level(foStart), at + foStart - inClip);
      g.gain.linearRampToValueAtTime(0, at + c.length - inClip);
    }
    src.start(at, c.offset + inClip, end - begin);
    srcs.push(src);
  }
  return { nodes, srcs };
}
function stopSources() {
  if (!live) return;
  for (const s of live.srcs) { try { s.stop(); } catch {} s.disconnect(); }
  for (const n of live.nodes.values()) { n.input.disconnect(); n.gain.disconnect(); n.pan.disconnect(); n.fx.nodes.forEach((x) => x.disconnect()); }
  live = null;
}
const currentTime = () => (playing ? playBase + Math.max(0, ctx.currentTime - playStart) : playhead);
const playEnd = () => (loopOn && range ? range.end : projectEnd());
function startPlayback() {
  audio();
  ctx.resume();
  stopSources();
  if (loopOn && range && (playhead < range.start || playhead >= range.end)) playhead = range.start;
  if (playhead >= playEnd()) playhead = loopOn && range ? range.start : 0;
  playBase = playhead;
  playStart = ctx.currentTime + 0.06;
  live = buildGraph(ctx, master, playBase, playEnd(), playStart);
  playing = true;
  $("#stPlay").textContent = "❚❚";
  $("#stPlay").title = t("st_pause");
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}
function pause() {
  if (playing) playhead = Math.min(currentTime(), Math.max(playEnd(), playhead));
  playing = false;
  stopSources();
  cancelAnimationFrame(rafId);
  $("#stPlay").textContent = "▶";
  $("#stPlay").title = t("st_play");
  $("#stMeter").style.width = "0";
  showPlayhead();
}
function replayIfPlaying() { if (playing) { playhead = currentTime(); startPlayback(); } }
const meterData = new Float32Array(2048);
function tick() {
  const now = currentTime();
  if (now >= playEnd()) {
    if (loopOn && range) { playhead = range.start; startPlayback(); return; }
    playhead = playEnd();
    pause();
    return;
  }
  analyser.getFloatTimeDomainData(meterData);
  let peak = 0;
  for (let i = 0; i < meterData.length; i += 4) peak = Math.max(peak, Math.abs(meterData[i]));
  const bar = $("#stMeter");
  bar.style.width = `${Math.min(100, peak * 100)}%`;
  bar.classList.toggle("hot", peak >= 1);
  // Abspielkopf bleibt im Bild
  const x = now * pxPerSec - scroller.scrollLeft;
  if (x > scroller.clientWidth - 40 || x < 0) scroller.scrollLeft = now * pxPerSec - 80;
  showPlayhead(now);
  rafId = requestAnimationFrame(tick);
}
function seek(t) {
  playhead = Math.max(0, t);
  if (playing) startPlayback(); else showPlayhead();
}
function applyMix() {
  if (!live) return;
  const anySolo = tracks().some((t) => t.solo);
  for (const t of tracks()) {
    const n = live.nodes.get(t.id);
    if (!n) continue;
    n.gain.gain.setTargetAtTime(trackLevel(t, anySolo), ctx.currentTime, 0.01);
    n.pan.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
    // Ein Effekt kommt dazu oder fällt weg: Der Graph muss neu aufgebaut werden. Sonst genügt es, die Werte nachzuziehen.
    const fx = fxOf(t);
    if (n.shape !== fxShape(fx)) { replayIfPlaying(); return; }
    n.fx.update(fx, ctx.currentTime);
  }
}

// ---------------------------------------------------------------- Medien laden
function computePeaks(buf) {
  const n = Math.ceil(buf.length / PEAK_HOP), min = new Float32Array(n), max = new Float32Array(n);
  const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  for (let i = 0; i < n; i++) {
    let lo = 1, hi = -1;
    const end = Math.min((i + 1) * PEAK_HOP, buf.length);
    for (let k = i * PEAK_HOP; k < end; k += 4) {
      const v = (l[k] + r[k]) / 2;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, perSec: buf.sampleRate / PEAK_HOP };
}
async function loadAsset(id) {
  const m = media.get(id);
  if (m?.buffer || m?.loading) return m?.loading;
  const rec = m || { meta: assets.find((a) => a.id === id) || { id, name: "?", kind: "song" } };
  media.set(id, rec);
  rec.loading = (async () => {
    const data = await (await fetch(`/api/studio/assets/${id}/audio`)).arrayBuffer();
    rec.buffer = await audio().decodeAudioData(data);
    rec.peaks = computePeaks(rec.buffer);
    rec.loading = null;
    draw();
    replayIfPlaying();
  })();
  return rec.loading;
}
const loadProjectMedia = () => Promise.all([...new Set(clips().map((c) => c.asset))].map(loadAsset));
async function refreshAssets() {
  assets = await api("/api/studio/assets");
  for (const a of assets) if (media.has(a.id)) media.get(a.id).meta = a;
  renderMedia();
}

// ---------------------------------------------------------------- Projekt und Rückgängig
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}
function saveNow(keepalive = false) {
  clearTimeout(saveTimer);
  // keepalive: Beim Schließen der Seite käme die Anfrage sonst nicht mehr an
  if (project) return api(`/api/studio/projects/${project.id}`, { method: "PUT", keepalive, body: JSON.stringify({ data: project.data }) }).catch((e) => info(e.message, "err"));
}
const snapshot = () => JSON.stringify({ bpm: project.data.bpm, beat0: project.data.beat0, tracks: project.data.tracks, clips: project.data.clips, lyrics: project.data.lyrics });
function pushUndo(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  syncButtons();
}
function restore(snap) {
  Object.assign(project.data, JSON.parse(snap));
  sel = new Set([...sel].filter((id) => clipById(id)));
  if (!tracks().some((t) => t.id === selTrack)) selTrack = tracks()[0]?.id ?? null;
  $("#stBpm").value = project.data.bpm || "";
  changed();
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }
// Nach jeder Änderung: neu zeichnen, speichern, laufende Wiedergabe nachziehen
function changed() {
  renderHeads(); layout(); draw(); renderInspector(); syncButtons(); saveSoon(); replayIfPlaying();
}
function edit(fn) { pushUndo(); fn(); changed(); }

async function openProject(id) {
  pause();
  project = await api(`/api/studio/projects/${id}`);
  project.data = { bpm: 0, beat0: 0, tracks: [], clips: [], ...project.data };
  undoStack = []; redoStack = []; sel = new Set(); range = null; loopOn = false; playhead = 0;
  selTrack = tracks()[0]?.id ?? null;
  try { localStorage.setItem("studio_project", id); } catch {}
  $("#stBpm").value = project.data.bpm || "";
  $("#stProject").value = id;
  changed();
  showPlayhead();
  scroller.scrollLeft = 0;
  info(t("st_loading_media"), "busy");
  await loadProjectMedia().catch((e) => info(e.message, "err"));
  info("");
}
async function refreshProjects(selectId) {
  const list = await api("/api/studio/projects");
  $("#stProject").replaceChildren(...list.map((p) => new Option(p.name, p.id)));
  if (selectId) $("#stProject").value = selectId;
  return list;
}
async function newProject(songId = null) {
  const name = songId ? "" : t("st_new_project");
  const p = await api("/api/studio/projects", { method: "POST", body: JSON.stringify({ name, song_id: songId }) });
  await refreshProjects(p.id);
  await refreshAssets();
  await openProject(p.id);
}

// ---------------------------------------------------------------- Spuren
function addTrack(name) {
  const tr = { id: newId(), name: name || `${t("st_track")} ${tracks().length + 1}`, volume: 1, pan: 0, mute: false, solo: false };
  project.data.tracks.push(tr);
  return tr;
}
function renderHeads() {
  heads.innerHTML = tracks().map((tr) => `
    <div class="st-head ${tr.id === selTrack ? "sel" : ""}" data-t="${tr.id}">
      <div class="row"><input type="text" value="${esc(tr.name)}" aria-label="${esc(t("st_track"))}">
        <button type="button" class="m ${tr.mute ? "on" : ""}" aria-pressed="${tr.mute}" title="${esc(t("st_mute"))}">M</button>
        <button type="button" class="s ${tr.solo ? "on" : ""}" aria-pressed="${tr.solo}" title="${esc(t("st_solo"))}">S</button>
        <button type="button" class="fx ${fxActive(tr) ? "on" : ""} ${tr.id === fxTrack ? "open" : ""}" aria-pressed="${tr.id === fxTrack}" title="${esc(t("st_fx_tip"))}" aria-label="${esc(t("st_fx_tip"))}">FX</button>
        <button type="button" class="x" title="${esc(t("st_track_remove"))}" aria-label="${esc(t("st_track_remove"))}">✕</button></div>
      <label title="${esc(t("st_volume"))}"><span>V</span><input type="range" class="vol" min="0" max="1.5" step="0.01" value="${tr.volume}" aria-label="${esc(t("st_volume"))}"></label>
      <label title="${esc(t("st_pan"))}"><span>P</span><input type="range" class="pan" min="-1" max="1" step="0.01" value="${tr.pan}" aria-label="${esc(t("st_pan"))}"></label>
    </div>`).join("");
}
heads.addEventListener("click", (e) => {
  const row = e.target.closest(".st-head");
  if (!row) return;
  const tr = tracks().find((x) => x.id === row.dataset.t);
  if (e.target.matches("button.m")) { tr.mute = !tr.mute; renderHeads(); applyMix(); saveSoon(); return; }
  if (e.target.matches("button.s")) { tr.solo = !tr.solo; renderHeads(); applyMix(); saveSoon(); return; }
  if (e.target.matches("button.fx")) { fxTrack = fxTrack === tr.id ? null : tr.id; renderHeads(); renderInspector(); return; }
  if (e.target.matches("button.x")) {
    if (clips().some((c) => c.track === tr.id) && !confirm(t("st_track_remove_sure"))) return;
    edit(() => {
      project.data.clips = clips().filter((c) => c.track !== tr.id);
      project.data.tracks = tracks().filter((x) => x.id !== tr.id);
      if (selTrack === tr.id) selTrack = tracks()[0]?.id ?? null;
      if (fxTrack === tr.id) fxTrack = null;
    });
    return;
  }
  if (selTrack !== tr.id) { selTrack = tr.id; heads.querySelectorAll(".st-head").forEach((h) => h.classList.toggle("sel", h === row)); }
});
heads.addEventListener("input", (e) => {
  const row = e.target.closest(".st-head");
  if (!row) return;
  const tr = tracks().find((x) => x.id === row.dataset.t);
  if (e.target.matches(".vol")) tr.volume = +e.target.value;
  if (e.target.matches(".pan")) tr.pan = +e.target.value;
  if (e.target.type === "text") tr.name = e.target.value;
  applyMix();
  saveSoon();
});

// ---------------------------------------------------------------- Zeichnen
function layout() {
  const w = Math.max((Math.max(projectEnd(), playhead) + 60) * pxPerSec, scroller.clientWidth);
  const h = Math.max(RULER + tracks().length * ROW + 40, scroller.clientHeight);
  spacer.style.width = `${w}px`;
  spacer.style.height = `${h}px`;
  const dpr = devicePixelRatio || 1, cw = scroller.clientWidth, ch = scroller.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
  }
  $("#stEmpty").hidden = clips().length > 0;
}
const css = getComputedStyle(document.documentElement);
const cssVar = (n) => css.getPropertyValue(n).trim();
function gridStep() {
  const bpm = project?.data.bpm;
  if (!bpm) return null;
  const beat = 60 / bpm;
  let step = beat;
  while (step * pxPerSec < 12) step *= 2;
  return { beat, step };
}
function draw() {
  if (!project) return;
  const dpr = devicePixelRatio || 1, W = scroller.clientWidth, H = scroller.clientHeight;
  const sx = scroller.scrollLeft, sy = scroller.scrollTop, x0 = (t) => t * pxPerSec - sx;
  const c2 = g2d;
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  c2.clearRect(0, 0, W, H);
  c2.font = "11px -apple-system, 'Segoe UI', sans-serif";

  // Zeilen der Spuren
  tracks().forEach((tr, i) => {
    const y = RULER + i * ROW - sy;
    if (tr.id === selTrack) { c2.fillStyle = "rgba(109,140,255,.05)"; c2.fillRect(0, y, W, ROW); }
    c2.fillStyle = cssVar("--border");
    c2.fillRect(0, y + ROW - 1, W, 1);
  });
  // Raster
  const grid = gridStep(), tStart = sx / pxPerSec, tEnd = (sx + W) / pxPerSec;
  if (grid) {
    const b0 = project.data.beat0 || 0;
    for (let k = Math.floor((tStart - b0) / grid.step); b0 + k * grid.step <= tEnd; k++) {
      const pos = ((k * grid.step / grid.beat) % 4 + 4) % 4, isBar = pos < 1e-6 || pos > 4 - 1e-6;
      c2.fillStyle = isBar ? "rgba(255,255,255,.09)" : "rgba(255,255,255,.035)";
      c2.fillRect(Math.round(x0(b0 + k * grid.step)), RULER, 1, H - RULER);
    }
  }
  // Clips
  c2.save();
  c2.beginPath(); c2.rect(0, RULER, W, H - RULER); c2.clip();
  for (const c of clips()) {
    const i = tracks().findIndex((x) => x.id === c.track);
    if (i < 0) continue;
    const y = RULER + i * ROW - sy + 2, h = ROW - 5, x = x0(c.start), w = c.length * pxPerSec;
    if (x + w < 0 || x > W || y + h < RULER || y > H) continue;
    drawClip(c, x, y, w, h);
  }
  c2.restore();
  // Markierter Bereich
  if (range) {
    const a = x0(range.start), b = x0(range.end);
    c2.fillStyle = "rgba(209,167,92,.1)";
    c2.fillRect(a, 0, b - a, H);
    c2.fillStyle = cssVar("--accent2");
    c2.fillRect(a, 0, 1, H); c2.fillRect(b, 0, 1, H);
  }
  // Zeitlineal
  c2.fillStyle = cssVar("--panel");
  c2.fillRect(0, 0, W, RULER);
  c2.fillStyle = cssVar("--border");
  c2.fillRect(0, RULER - 1, W, 1);
  if (range) { c2.fillStyle = "rgba(209,167,92,.35)"; c2.fillRect(x0(range.start), 0, (range.end - range.start) * pxPerSec, RULER - 1); }
  let major = 1;
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300]) { major = s; if (s * pxPerSec >= 70) break; }
  c2.fillStyle = cssVar("--muted");
  c2.textBaseline = "middle";
  for (let k = Math.floor(tStart / major); k * major <= tEnd; k++) {
    const x = x0(k * major);
    c2.fillRect(Math.round(x), RULER - 8, 1, 7);
    c2.fillText(fmtShort(k * major), x + 4, 11);
  }
  showPlayhead();
}
function drawClip(c, x, y, w, h) {
  const c2 = g2d, m = media.get(c.asset), color = COLORS[m?.meta?.kind] || COLORS.song, isSel = sel.has(c.id);
  const left = Math.max(x, -2), right = Math.min(x + w, scroller.clientWidth + 2);
  c2.fillStyle = `${color}2e`;
  c2.beginPath(); c2.roundRect(x, y, w, h, 4); c2.fill();
  // Wellenform
  if (m?.peaks) {
    const { min, max, perSec } = m.peaks, mid = y + h / 2 + 7, amp = (h - 18) / 2 * Math.min(1.6, c.gain);
    c2.fillStyle = `${color}d0`;
    for (let px = Math.floor(left); px < right; px++) {
      const t0 = c.offset + (px - x) / pxPerSec, t1 = t0 + 1 / pxPerSec;
      let i0 = Math.max(0, Math.floor(t0 * perSec)), i1 = Math.min(min.length, Math.ceil(t1 * perSec));
      if (i1 <= i0) continue;
      let lo = 1, hi = -1;
      const stride = Math.max(1, Math.floor((i1 - i0) / 24));
      for (let i = i0; i < i1; i += stride) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
      const f = Math.min(1, c.fadeIn > 0 ? (px - x) / pxPerSec / c.fadeIn : 1, c.fadeOut > 0 ? (x + w - px) / pxPerSec / c.fadeOut : 1);
      const top = mid - hi * amp * f, bot = mid - lo * amp * f;
      c2.fillRect(px, top, 1, Math.max(1, bot - top));
    }
  } else {
    c2.fillStyle = cssVar("--muted");
    c2.fillText(t("st_loading_media"), Math.max(x, 0) + 8, y + h / 2);
  }
  // Blenden als schräge Linien
  c2.strokeStyle = "rgba(255,255,255,.55)";
  c2.lineWidth = 1;
  if (c.fadeIn > 0) { c2.beginPath(); c2.moveTo(x, y + h); c2.lineTo(x + c.fadeIn * pxPerSec, y); c2.stroke(); }
  if (c.fadeOut > 0) { c2.beginPath(); c2.moveTo(x + w, y + h); c2.lineTo(x + w - c.fadeOut * pxPerSec, y); c2.stroke(); }
  // Rahmen und Name
  c2.strokeStyle = isSel ? cssVar("--accent2") : `${color}90`;
  c2.lineWidth = isSel ? 2 : 1;
  c2.beginPath(); c2.roundRect(x + .5, y + .5, w - 1, h - 1, 4); c2.stroke();
  if (w > 30) {
    c2.save();
    c2.beginPath(); c2.rect(x + 2, y, w - 4, 16); c2.clip();
    c2.fillStyle = "#fff";
    c2.textBaseline = "middle";
    c2.fillText(c.name || m?.meta?.name || "", Math.max(x, 0) + 6, y + 9);
    c2.restore();
  }
}
function showPlayhead(t = playing ? currentTime() : playhead) {
  const el = $("#stPlayhead"), x = t * pxPerSec - scroller.scrollLeft;
  el.hidden = x < 0 || x > scroller.clientWidth;
  el.style.transform = `translateX(${x}px)`;
  $("#stTime").textContent = fmtTime(t);
  drawNav(t);
}

// ---------------------------------------------------------------- Übersicht und Suchleiste (unten)
// Der ganze Song in einer Zeile: Klicken oder Ziehen springt an die Stelle, auch während der Wiedergabe. Bisher bestimmte nur die
// Wiedergabe, wo man ist; jetzt kommt man jederzeit vor und zurück. Pfeiltasten springen 1 s, mit Umschalt 10 s.
const nav = $("#stNav"), navCanvas = $("#stNavCanvas"), navG = navCanvas.getContext("2d"), seekBar = $("#stSeek");
let seekDrag = false, scrub = null;   // scrub: Zielposition, solange während der Wiedergabe gezogen wird
const navTotal = () => Math.max(10, projectEnd() + 5, (playing ? currentTime() : playhead) + 1);   // etwas Luft hinter dem letzten Clip
function drawNav(now = playing ? currentTime() : playhead) {
  const dpr = devicePixelRatio || 1, W = nav.clientWidth, H = nav.clientHeight;
  if (!W || !H) return;
  if (navCanvas.width !== W * dpr || navCanvas.height !== H * dpr) { navCanvas.width = W * dpr; navCanvas.height = H * dpr; }
  const g = navG, total = navTotal(), x = (t) => t / total * W;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const n = Math.max(1, tracks().length), rowH = Math.max(2, (H - 10) / n);
  for (const c of clips()) {
    const i = tracks().findIndex((tr) => tr.id === c.track);
    if (i < 0) continue;
    g.fillStyle = `${COLORS[media.get(c.asset)?.meta?.kind] || COLORS.song}b0`;
    g.fillRect(x(c.start), 5 + i * rowH, Math.max(1, x(c.length)), Math.max(1, rowH - 1));
  }
  if (range) { g.fillStyle = "rgba(209,167,92,.18)"; g.fillRect(x(range.start), 0, x(range.end) - x(range.start), H); }
  // sichtbarer Ausschnitt
  const a = x(scroller.scrollLeft / pxPerSec), b = Math.min(W, x((scroller.scrollLeft + scroller.clientWidth) / pxPerSec));
  g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(a, 0, Math.max(2, b - a), H);
  g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 1; g.strokeRect(a + .5, .5, Math.max(2, b - a) - 1, H - 1);
  // Abspielkopf und Zielposition beim Ziehen
  g.fillStyle = cssVar("--accent2"); g.fillRect(Math.round(x(now)) - 1, 0, 2, H);
  if (scrub !== null) { g.fillStyle = cssVar("--accent"); g.fillRect(Math.round(x(scrub)) - 1, 0, 2, H); }
  seekBar.max = Math.ceil(total);
  if (!seekDrag) seekBar.value = now;
  seekBar.setAttribute("aria-valuetext", fmtShort(now));
  $("#stNavTime").textContent = `${fmtShort(scrub ?? now)} / ${fmtShort(Math.max(0, projectEnd()))}`;
}
// Ausschnitt so verschieben, dass die Stelle im Bild ist (mittig, wenn sie außerhalb lag)
function scrollToTime(t) {
  const px = t * pxPerSec;
  if (px < scroller.scrollLeft + 20 || px > scroller.scrollLeft + scroller.clientWidth - 20) { layout(); scroller.scrollLeft = Math.max(0, px - scroller.clientWidth / 2); }
  draw();
}
function seekTo(t) {
  t = Math.max(0, Math.min(navTotal(), t));
  seek(t);
  scrollToTime(t);
}
const seekBy = (d) => seekTo((playing ? currentTime() : playhead) + d);
seekBar.addEventListener("pointerdown", () => { seekDrag = true; });
window.addEventListener("pointerup", () => { if (seekDrag) { seekDrag = false; if (scrub !== null) { const t = scrub; scrub = null; seekTo(t); } } });
seekBar.addEventListener("input", () => {
  const t = +seekBar.value;
  if (playing && seekDrag) { scrub = t; drawNav(); return; }   // beim Ziehen während der Wiedergabe erst beim Loslassen springen (sonst stottert der Ton)
  seekTo(t);
});
seekBar.addEventListener("change", () => { if (scrub !== null) { const t = scrub; scrub = null; seekTo(t); } });
scroller.addEventListener("scroll", () => { heads.scrollTop = scroller.scrollTop; draw(); });
new ResizeObserver(() => requestAnimationFrame(() => { layout(); draw(); })).observe(scroller);
new ResizeObserver(() => requestAnimationFrame(() => drawNav())).observe($("#stNav"));
function zoomTo(px, anchor = playing ? currentTime() : playhead) {
  const viewX = anchor * pxPerSec - scroller.scrollLeft;
  pxPerSec = Math.max(2, Math.min(800, px));
  layout();
  scroller.scrollLeft = anchor * pxPerSec - viewX;
  draw();
}

// ---------------------------------------------------------------- Maus: Auswählen, Verschieben, Trimmen, Bereich
const toTime = (e) => (e.clientX - canvas.getBoundingClientRect().left + scroller.scrollLeft) / pxPerSec;
const toY = (e) => e.clientY - canvas.getBoundingClientRect().top;
const rowAt = (y) => Math.floor((y - RULER + scroller.scrollTop) / ROW);
function hitClip(e) {
  const y = toY(e), row = rowAt(y), tr = tracks()[row], time = toTime(e);
  if (!tr) return null;
  const list = clips().filter((c) => c.track === tr.id);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (time >= c.start && time <= clipEnd(c)) {
      const fromLeft = (time - c.start) * pxPerSec, fromRight = (clipEnd(c) - time) * pxPerSec;
      const zone = c.length * pxPerSec > HANDLE * 3 ? (fromLeft <= HANDLE ? "trimL" : fromRight <= HANDLE ? "trimR" : "move") : "move";
      return { clip: c, zone };
    }
  }
  return null;
}
function snapPoints(ignore) {
  const pts = [0, playing ? currentTime() : playhead];
  for (const c of clips()) if (!ignore.has(c.id)) pts.push(c.start, clipEnd(c));
  return pts;
}
function snap(t, e, points, useGrid = true) {
  if (!$("#stSnap").checked || e.altKey) return t;
  const tol = SNAP_PX / pxPerSec;
  let best = t, bestD = tol;
  for (const p of points) { const d = Math.abs(p - t); if (d < bestD) { bestD = d; best = p; } }
  const bpm = project.data.bpm;
  if (bpm && useGrid) {
    const beat = 60 / bpm, b0 = project.data.beat0 || 0, g = b0 + Math.round((t - b0) / beat) * beat, d = Math.abs(g - t);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (!project || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const time = toTime(e), y = toY(e);
  if (y < RULER) {
    drag = { type: "ruler", t0: time, moved: false };
    return;
  }
  const hit = hitClip(e), row = rowAt(y);
  if (tracks()[row] && selTrack !== tracks()[row].id) { selTrack = tracks()[row].id; renderHeads(); }
  if (!hit) {
    if (!e.shiftKey) sel = new Set();
    seek(snap(time, e, snapPoints(new Set())));
    draw(); renderInspector(); syncButtons();
    return;
  }
  if (fxTrack) { fxTrack = null; renderHeads(); }
  if (e.shiftKey || e.ctrlKey || e.metaKey) { sel.has(hit.clip.id) ? sel.delete(hit.clip.id) : sel.add(hit.clip.id); }
  else if (!sel.has(hit.clip.id)) sel = new Set([hit.clip.id]);
  renderInspector(); syncButtons(); draw();
  const moving = selected();
  drag = { type: hit.zone, clip: hit.clip, x0: time, row0: row, undo: snapshot(), moved: false, plain: !(e.shiftKey || e.ctrlKey || e.metaKey), orig: new Map(moving.map((c) => [c.id, { ...c }])), pts: snapPoints(new Set(moving.map((c) => c.id))) };
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) {
    const hit = project && toY(e) >= RULER ? hitClip(e) : null;
    canvas.style.cursor = hit ? (hit.zone === "move" ? "grab" : "ew-resize") : toY(e) < RULER ? "text" : "default";
    return;
  }
  const time = toTime(e);
  if (drag.type === "ruler") {
    if (Math.abs(time - drag.t0) * pxPerSec > 3) drag.moved = true;
    if (drag.moved) {
      const a = Math.max(0, snap(Math.min(time, drag.t0), e, snapPoints(new Set()))), b = snap(Math.max(time, drag.t0), e, snapPoints(new Set()));
      range = { start: a, end: b };
      draw(); syncButtons();
    }
    return;
  }
  const dx = time - drag.x0;
  if (Math.abs(dx) * pxPerSec > 2) drag.moved = true;
  if (!drag.moved && rowAt(toY(e)) === drag.row0) return;
  const anchor = drag.orig.get(drag.clip.id);
  if (drag.type === "move") {
    drag.moved = true;
    const earliest = Math.min(...[...drag.orig.values()].map((c) => c.start));
    // Der Anfang rastet am Raster und an Kanten ein, das Ende nur an Kanten: Sonst rutschte der Anfang aus dem Takt, weil kaum ein Clip genau Takte lang ist
    const dA = snap(anchor.start + dx, e, drag.pts) - anchor.start - dx, dB = snap(anchor.start + anchor.length + dx, e, drag.pts, false) - anchor.start - anchor.length - dx;
    const delta = Math.max(dx + (dB !== 0 && (dA === 0 || Math.abs(dB) < Math.abs(dA)) ? dB : dA), -earliest);
    const rowDelta = Math.max(-drag.row0, rowAt(toY(e)) - drag.row0);
    for (const [id, o] of drag.orig) {
      const c = clipById(id), from = tracks().findIndex((x) => x.id === o.track);
      c.start = o.start + delta;
      const to = Math.max(0, Math.min(tracks().length - 1, from + rowDelta));
      c.track = tracks()[to].id;
    }
  } else if (drag.type === "trimL") {
    const dur = media.get(drag.clip.asset)?.meta?.duration ?? anchor.offset + anchor.length;
    let d = snap(anchor.start + dx, e, drag.pts) - anchor.start;
    d = Math.max(d, -anchor.offset, -anchor.start);
    d = Math.min(d, anchor.length - MIN_CLIP);
    drag.clip.start = anchor.start + d; drag.clip.offset = anchor.offset + d; drag.clip.length = Math.min(anchor.length - d, dur - drag.clip.offset);
  } else if (drag.type === "trimR") {
    const dur = media.get(drag.clip.asset)?.meta?.duration ?? anchor.offset + anchor.length;
    const end = snap(anchor.start + anchor.length + dx, e, drag.pts);
    drag.clip.length = Math.max(MIN_CLIP, Math.min(end - anchor.start, dur - anchor.offset));
  }
  draw();
});
function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === "ruler") {
    if (!d.moved) { range = null; seek(snap(toTime(e), e, snapPoints(new Set()))); }
    else if (range && range.end - range.start < MIN_CLIP) range = null;
    if (!range) { loopOn = false; }
    draw(); syncButtons();
    return;
  }
  if (d.moved) { pushUndo(d.undo); changed(); }
  // Ein Klick ohne Ziehen auf einen Clip aus einer Mehrfachauswahl wählt nur noch ihn: Beim Drücken bleibt die Auswahl noch stehen, damit man alle zusammen ziehen kann
  else if (d.plain && e.type === "pointerup" && sel.size > 1) { sel = new Set([d.clip.id]); draw(); renderInspector(); syncButtons(); }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomTo(pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2), toTime(e)); }
}, { passive: false });

// ---------------------------------------------------------------- Schneiden, Kopieren, Einfügen
function clipDefaults(asset, track, start, offset = 0, length = null) {
  const dur = media.get(asset)?.meta?.duration ?? assets.find((a) => a.id === asset)?.duration ?? 0;
  return { id: newId(), asset, track, start, offset, length: length ?? dur - offset, gain: 1, fadeIn: 0, fadeOut: 0 };
}
function splitAt(time) {
  // Ohne Auswahl: alles, was unter dem Abspielkopf liegt, auf der gewählten Spur
  const targets = selected().length ? selected() : clips().filter((c) => c.track === selTrack);
  const hits = targets.filter((c) => time > c.start + MIN_CLIP && time < clipEnd(c) - MIN_CLIP);
  if (!hits.length) return;
  edit(() => {
    for (const c of hits) {
      const inner = time - c.start;
      const right = { ...c, id: newId(), start: time, offset: c.offset + inner, length: c.length - inner, fadeIn: 0 };
      c.length = inner; c.fadeOut = 0;
      project.data.clips.push(right);
      if (sel.has(c.id)) sel.add(right.id);
    }
  });
}
function copySel() {
  const list = selected();
  if (!list.length) return;
  const first = Math.min(...list.map((c) => c.start));
  clipboard = list.map((c) => ({ ...c, rel: c.start - first }));
  syncButtons();
}
function paste(at = playing ? currentTime() : playhead) {
  if (!clipboard.length) return;
  edit(() => {
    if (!tracks().length) selTrack = addTrack().id;
    const firstTrack = tracks().findIndex((x) => x.id === clipboard[0].track);
    const base = tracks().findIndex((x) => x.id === selTrack);
    sel = new Set();
    for (const { rel, ...c } of clipboard) {
      const from = tracks().findIndex((x) => x.id === c.track);
      // Mehrere Spuren behalten ihren Abstand; die oberste landet auf der gewählten Spur
      const row = from < 0 || firstTrack < 0 ? base : Math.min(tracks().length - 1, base + from - firstTrack);
      const nc = { ...c, id: newId(), track: tracks()[Math.max(0, row)].id, start: at + rel };
      project.data.clips.push(nc);
      sel.add(nc.id);
    }
  });
}
function duplicateSel() {
  const list = selected();
  if (!list.length) return;
  const first = Math.min(...list.map((c) => c.start)), last = Math.max(...list.map(clipEnd));
  edit(() => {
    sel = new Set();
    for (const c of list) {
      const nc = { ...c, id: newId(), start: last + (c.start - first) };
      project.data.clips.push(nc);
      sel.add(nc.id);
    }
  });
}
function removeSel() {
  if (!sel.size) return;
  edit(() => { project.data.clips = clips().filter((c) => !sel.has(c.id)); sel = new Set(); });
}
// Bereich auf allen Spuren entfernen und die Lücke schließen: das klassische „Zurechtschneiden“ eines ganzen Lieds
function cutRange() {
  if (!range) return;
  const { start, end } = range, gap = end - start;
  edit(() => {
    const out = [];
    for (const c of clips()) {
      const a = c.start, b = clipEnd(c);
      if (b <= start) { out.push(c); continue; }
      if (a >= end) { out.push({ ...c, start: a - gap }); continue; }
      if (a < start) out.push({ ...c, length: start - a, fadeOut: 0 });
      if (b > end) out.push({ ...c, id: a < start ? newId() : c.id, start, offset: c.offset + (end - a), length: b - end, fadeIn: 0 });
    }
    project.data.clips = out;
    sel = new Set([...sel].filter((id) => clipById(id)));
    range = null; loopOn = false;
    if (playhead > end) playhead -= gap; else if (playhead > start) playhead = start;
  });
}

// ---------------------------------------------------------------- Clip-Eigenschaften
function renderFxPanel(el, tr) {
  const f = fxOf(tr), div = t("st_echo_div");
  const presetKey = Object.keys(FX_PRESETS).find((k) => { const p = { ...FX_DEFAULT, ...FX_PRESETS[k] }; return Object.keys(FX_DEFAULT).every((x) => p[x] === f[x]); }) || "";
  const slider = (id, label, min, max, step, value, unit) => `<label>${esc(t(label))}<input type="range" data-fx="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}${unit}</output></label>`;
  el.classList.add("fx");
  el.innerHTML = `<div class="st-fxgroup"><b>${esc(t("st_fx_of", tr.name))}</b>
      <select id="fxPreset" aria-label="${esc(t("st_fx_preset"))}"><option value="" ${presetKey ? "" : "selected"} disabled>${esc(t("st_fx_custom"))}</option>${Object.keys(FX_PRESETS).map((k) => `<option value="${k}" ${k === presetKey ? "selected" : ""}>${esc(t(k))}</option>`).join("")}</select></div>
    <div class="st-fxgroup"><b>${esc(t("st_eq"))}</b>${slider("low", "st_eq_low", -12, 12, 0.5, f.low, " dB")}${slider("mid", "st_eq_mid", -12, 12, 0.5, f.mid, " dB")}${slider("high", "st_eq_high", -12, 12, 0.5, f.high, " dB")}</div>
    <div class="st-fxgroup"><b>${esc(t("st_comp"))}</b>${slider("comp", "st_comp_amount", 0, 100, 1, f.comp, " %")}</div>
    <div class="st-fxgroup"><b>${esc(t("st_hall"))}</b>${slider("hall", "st_hall_amount", 0, 100, 1, f.hall, " %")}${slider("hallSize", "st_hall_size", 0.3, 8, 0.1, f.hallSize, " s")}</div>
    <div class="st-fxgroup"><b>${esc(t("st_echo"))}</b>${slider("echo", "st_echo_amount", 0, 100, 1, f.echo, " %")}
      <label>${esc(t("st_echo_time"))}<select data-fx="echoDiv">${Object.entries(div).sort((a, b) => a[0] - b[0]).map(([v, n]) => `<option value="${v}" ${+v === f.echoDiv ? "selected" : ""}>${n}</option>`).join("")}</select><span></span></label>
      ${slider("echoFb", "st_echo_fb", 0, 80, 1, f.echoFb, " %")}</div>`;
  let undoSnap = null;
  const change = () => { renderHeads(); applyMix(); draw(); saveSoon(); };
  el.querySelector("#fxPreset").addEventListener("change", (e) => {
    pushUndo();
    tr.fx = { ...FX_PRESETS[e.target.value] };
    change(); renderInspector();
  });
  el.querySelectorAll("[data-fx]").forEach((inp) => {
    inp.addEventListener("input", () => {
      undoSnap ??= snapshot();
      tr.fx = { ...tr.fx, [inp.dataset.fx]: +inp.value };
      if (inp.type === "range") { const unit = inp.nextElementSibling.textContent.replace(/^[-\d.]+/, ""); inp.nextElementSibling.textContent = `${inp.value}${unit}`; }
      change();
    });
    inp.addEventListener("change", () => { if (undoSnap) { pushUndo(undoSnap); undoSnap = null; } const p = el.querySelector("#fxPreset"); if (!Object.keys(FX_PRESETS).some((k) => k === p.value && Object.keys(FX_DEFAULT).every((x) => ({ ...FX_DEFAULT, ...FX_PRESETS[k] })[x] === fxOf(tr)[x]))) p.value = ""; });
  });
}
function renderInspector() {
  const el = $("#stInspector"), list = selected();
  el.classList.remove("fx");
  const fxT = tracks().find((x) => x.id === fxTrack);
  if (fxT) { renderFxPanel(el, fxT); return; }
  if (!list.length) { el.innerHTML = `<span class="st-info">${esc(t("st_nothing"))}</span>`; return; }
  if (list.length > 1) { el.innerHTML = `<span class="st-info">${esc(t("st_selected", list.length))}</span>`; return; }
  const c = list[0], m = media.get(c.asset), db = (20 * Math.log10(Math.max(c.gain, 1e-4))).toFixed(1);
  el.innerHTML = `<span class="name">${esc(m?.meta?.name || t("st_clip"))}</span>
    <span class="st-info">${fmtShort(c.start)} · ${c.length.toFixed(2)} s</span>
    <label>${esc(t("st_gain"))}<input type="range" id="inGain" min="-30" max="12" step="0.5" value="${db}"><output>${db} dB</output></label>
    <label>${esc(t("st_fade_in"))}<input type="range" id="inFadeIn" min="0" max="${Math.min(10, c.length).toFixed(2)}" step="0.05" value="${c.fadeIn}"><output>${c.fadeIn.toFixed(2)} s</output></label>
    <label>${esc(t("st_fade_out"))}<input type="range" id="inFadeOut" min="0" max="${Math.min(10, c.length).toFixed(2)}" step="0.05" value="${c.fadeOut}"><output>${c.fadeOut.toFixed(2)} s</output></label>`;
  const bind = (id, fn) => {
    const inp = el.querySelector(id);
    let undoSnap = null;
    inp.addEventListener("pointerdown", () => { undoSnap = snapshot(); });
    inp.addEventListener("input", () => { undoSnap ??= snapshot(); fn(+inp.value, inp.nextElementSibling); draw(); replayIfPlaying(); saveSoon(); });
    inp.addEventListener("change", () => { if (undoSnap) { pushUndo(undoSnap); undoSnap = null; } });
  };
  bind("#inGain", (v, o) => { c.gain = 10 ** (v / 20); o.textContent = `${v.toFixed(1)} dB`; });
  bind("#inFadeIn", (v, o) => { c.fadeIn = Math.min(v, c.length - c.fadeOut); o.textContent = `${c.fadeIn.toFixed(2)} s`; });
  bind("#inFadeOut", (v, o) => { c.fadeOut = Math.min(v, c.length - c.fadeIn); o.textContent = `${c.fadeOut.toFixed(2)} s`; });
}
function syncButtons() {
  const n = selected().length;
  $("#stCopy").disabled = !n; $("#stDuplicate").disabled = !n; $("#stRemove").disabled = !n;
  $("#stPaste").disabled = !clipboard.length;
  $("#stSeparate").disabled = n !== 1 || busy; $("#stSeparate4").disabled = n !== 1 || busy;
  $("#stLoop").disabled = !range; $("#stCutRange").disabled = !range;
  $("#stLoop").setAttribute("aria-pressed", loopOn && !!range);
  $("#stUndo").disabled = !undoStack.length; $("#stRedo").disabled = !redoStack.length;
  $("#stNewVoice").disabled = busy || !project;
  $("#stRec").disabled = !project;
  $("#stConvert").disabled = n !== 1 || busy;
}

// ---------------------------------------------------------------- Medienleiste
function renderMedia() {
  const q = $("#stSearch").value.toLowerCase();
  const stems = assets.filter((a) => a.kind !== "song" && a.name.toLowerCase().includes(q));
  $("#stStems").innerHTML = stems.length ? stems.map((a) => `<div class="st-item" draggable="true" data-asset="${a.id}">
      <span class="n" title="${esc(a.name)}">${esc(a.name)}</span><span class="m">${fmtShort(a.duration)}</span>
      <span class="a"><button type="button" data-do="preview" title="${esc(t("st_preview"))}" aria-label="${esc(t("st_preview"))}">▶</button><button type="button" data-do="add" title="${esc(t("st_add"))}" aria-label="${esc(t("st_add"))}">＋</button><button type="button" data-do="del" title="${esc(t("st_remove"))}" aria-label="${esc(t("st_remove"))}">✕</button></span></div>`).join("")
    : `<div class="st-none">${esc(t("st_none_stems"))}</div>`;
  const list = songs.filter((s) => (s.title || s.caption).toLowerCase().includes(q)).slice(0, 200);
  $("#stSongs").innerHTML = list.length ? list.map((s) => `<div class="st-item" draggable="true" data-song="${s.id}">
      <span class="n" title="${esc(s.title || s.caption)}">${esc((s.title || s.caption.split(",").slice(0, 3).join(",")) + (s.letter ? ` ${s.letter}` : ""))}</span><span class="m">${esc(s.caption.split(",").slice(0, 2).join(","))}</span>
      <span class="a"><button type="button" data-do="preview" title="${esc(t("st_preview"))}" aria-label="${esc(t("st_preview"))}">▶</button><button type="button" data-do="add" title="${esc(t("st_add"))}" aria-label="${esc(t("st_add"))}">＋</button></span></div>`).join("")
    : `<div class="st-none">${esc(t("st_none_songs"))}</div>`;
}
$("#stSearch").addEventListener("input", renderMedia);
async function refreshSongs() {
  const all = await api("/api/songs");
  songs = all.filter((s) => s.status === "done" && s.file?.toLowerCase().endsWith(".wav"));
  renderMedia();
}
let previewAudio = null, previewBtn = null;
function preview(btn, url) {
  if (previewAudio) { previewAudio.pause(); previewBtn.classList.remove("on"); previewBtn.textContent = "▶"; }
  if (previewBtn === btn) { previewAudio = null; previewBtn = null; return; }
  previewAudio = new Audio(url); previewBtn = btn;
  btn.classList.add("on"); btn.textContent = "❚❚";
  previewAudio.addEventListener("ended", () => { btn.classList.remove("on"); btn.textContent = "▶"; previewAudio = null; previewBtn = null; });
  previewAudio.play().catch(() => {});
}
async function assetFromSong(sid) {
  const a = await api(`/api/studio/assets/song/${sid}`, { method: "POST" });
  await refreshAssets();
  return a;
}
// Legt ein Medium auf die Zeitleiste: auf eine vorhandene Spur (trackId) oder auf eine neue
async function placeAsset(aid, trackId, start) {
  if (!project) await newProject();
  const a = assets.find((x) => x.id === aid);
  media.set(aid, media.get(aid) || { meta: a });
  media.get(aid).meta = a;
  edit(() => {
    const tr = trackId || addTrack(a.name.split(": ").pop()).id;
    if (!selTrack || !trackId) selTrack = tr;
    const c = clipDefaults(aid, tr, start);
    project.data.clips.push(c);
    sel = new Set([c.id]);
  });
  loadAsset(aid).catch((e) => info(e.message, "err"));
  // Das erste Medium gibt Tempo und Raster vor
  if (!project.data.bpm) {
    const song = songs.find((s) => s.id === a.source_song);
    const beat = await api(`/api/studio/assets/${aid}/beat?hint=${song?.result_meta?.bpm || 0}`);
    project.data.bpm = beat.bpm; project.data.beat0 = beat.beat0;
    $("#stBpm").value = beat.bpm;
    draw(); saveSoon();
  }
}
$(".st-media").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-do]");
  if (!btn) return;
  const item = btn.closest(".st-item"), sid = item.dataset.song, aid = item.dataset.asset;
  try {
    if (btn.dataset.do === "preview") return preview(btn, sid ? `/api/songs/${sid}/audio` : `/api/studio/assets/${aid}/audio`);
    if (btn.dataset.do === "del") { await api(`/api/studio/assets/${aid}`, { method: "DELETE" }); media.delete(aid); await refreshAssets(); return; }
    await placeAsset(aid || (await assetFromSong(sid)).id, null, playing ? currentTime() : playhead);
  } catch (err) { info(err.message, "err"); }
});
$(".st-media").addEventListener("dragstart", (e) => {
  const item = e.target.closest?.(".st-item");
  if (!item) return;
  e.dataTransfer.setData("text/st-media", item.dataset.asset ? `a:${item.dataset.asset}` : `s:${item.dataset.song}`);
  e.dataTransfer.effectAllowed = "copy";
});
scroller.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/st-media")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
scroller.addEventListener("drop", async (e) => {
  const raw = e.dataTransfer.getData("text/st-media");
  if (!raw) return;
  e.preventDefault();
  try {
    const [kind, id] = raw.split(":");
    const aid = kind === "a" ? id : (await assetFromSong(id)).id;
    const tr = project ? tracks()[rowAt(toY(e))] : null;
    await placeAsset(aid, tr?.id ?? null, Math.max(0, snap(toTime(e), e, project ? snapPoints(new Set()) : [0])));
  } catch (err) { info(err.message, "err"); }
});

// ---------------------------------------------------------------- Spurtrennung
let currentJob = null;
class Cancelled extends Error {}
async function waitJob(jid) {
  currentJob = jid;
  $("#stJobCancel").hidden = false;
  try {
    for (;;) {
      const j = await api(`/api/studio/jobs/${jid}`);
      if (j.status === "cancelled") throw new Cancelled();
      if (j.status !== "running") return j;
      info(j.message, "busy");
      await new Promise((r) => setTimeout(r, 700));
    }
  } finally {
    currentJob = null;
    $("#stJobCancel").hidden = true;
  }
}
const jobFailed = (err) => { if (err instanceof Cancelled) info(t("st_job_cancelled")); else info(err.message, "err"); };
$("#stJobCancel").addEventListener("click", () => { if (currentJob) api(`/api/studio/jobs/${currentJob}/cancel`, { method: "POST" }).catch((e) => info(e.message, "err")); });
async function separateClip(parts) {
  const c = selected()[0];
  if (!c || busy) return;
  busy = true; syncButtons();
  info(t("st_loading_media"), "busy");
  try {
    let r = await api(`/api/studio/assets/${c.asset}/separate`, { method: "POST", body: JSON.stringify({ parts }) });
    if (r.job) {
      const j = await waitJob(r.job);
      if (j.status === "error") throw new Error(j.message);
      r = j;
    }
    await refreshAssets();
    for (const a of r.assets) { media.set(a.id, media.get(a.id) || { meta: a }); media.get(a.id).meta = a; }
    await Promise.all(r.assets.map((a) => loadAsset(a.id)));
    if (!clipById(c.id)) return;   // der Clip wurde währenddessen gelöscht
    // Der Clip wird zu mehreren Spuren: gleiche Stelle, gleicher Ausschnitt, gleicher Pegel. Gesang zuerst.
    const order = (k) => ["vocals", "instrumental", "drums", "bass", "other"].indexOf(k);
    edit(() => {
      const at = tracks().findIndex((x) => x.id === c.track);
      const made = [...r.assets].sort((a, b) => order(a.kind) - order(b.kind)).map((a, i) => {
        const tr = { id: newId(), name: a.name.split(": ").pop(), volume: 1, pan: 0, mute: false, solo: false };
        project.data.tracks.splice(at + 1 + i, 0, tr);
        return { ...c, id: newId(), asset: a.id, track: tr.id };
      });
      project.data.clips = clips().filter((x) => x.id !== c.id).concat(made);
      if (!clips().some((x) => x.track === c.track)) project.data.tracks = tracks().filter((x) => x.id !== c.track);
      sel = new Set(made.map((x) => x.id));
      selTrack = made[0].track;
    });
    info("");
  } catch (err) { jobFailed(err); }
  busy = false; syncButtons();
}

// ---------------------------------------------------------------- Abmischen und Export
async function renderMix(from, to, onlyTracks = null) {
  await loadProjectMedia();
  const len = Math.ceil((to - from) * RATE);
  const off = new OfflineAudioContext(2, len, RATE);
  let dest = off.destination;
  // Für den Beat einer neuen Stimme: nur die gewählten Spuren, Stumm- und Solo-Schalter zählen dann nicht
  const keep = project.data.tracks;
  if (onlyTracks) project.data.tracks = keep.filter((x) => onlyTracks.has(x.id)).map((x) => ({ ...x, mute: false, solo: false }));
  try { buildGraph(off, dest, from, to, 0); } finally { project.data.tracks = keep; }
  return off.startRendering();
}
function encodeWav(buf, gain = 1) {
  const n = buf.length, ch = buf.numberOfChannels, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, v) => { for (let i = 0; i < v.length; i++) out.setUint8(o + i, v.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE"); str(12, "fmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch).keys()].map((c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) {
    const v = Math.max(-1, Math.min(1, data[c][i] * gain));
    out.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
  }
  return out.buffer;
}
function peakOf(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  return peak;
}
async function exportMix() {
  const end = projectEnd();
  if (!end) { info(t("st_nothing_to_export"), "err"); return; }
  busy = true; syncButtons();
  info(t("st_rendering"), "busy");
  $("#stExport").disabled = true;
  try {
    await saveNow();
    const mix = await renderMix(0, end + fxTail());
    // Mehrere Stimmen übereinander werden schnell zu laut: lieber absenken als hart abschneiden
    const peak = peakOf(mix), gain = peak > 0.98 ? 0.98 / peak : 1;
    const r = await api(`/api/studio/projects/${project.id}/export`, { method: "POST", raw: true, body: encodeWav(mix, gain), headers: { "Content-Type": "audio/wav" } });
    await refreshSongs();
    info(t("st_exported", r.title) + (gain < 1 ? ` ${t("st_clipped", (20 * Math.log10(1 / gain)).toFixed(1))}` : ""));
  } catch (err) { info(err.message, "err"); }
  $("#stExport").disabled = false;
  busy = false; syncButtons();
}

// ---------------------------------------------------------------- Neue Stimme über den Beat
const takeDlg = $("#stTakeDlg"), takeForm = $("#stTakeForm");
function openTakeDialog() {
  if (!project) return;
  const beats = tracks().filter((x) => clips().some((c) => c.track === x.id));
  const isVocal = (x) => clips().some((c) => c.track === x.id && VOCAL_KINDS.includes(media.get(c.asset)?.meta?.kind));
  takeForm.beat.replaceChildren(...beats.map((x) => new Option(x.name, x.id, !isVocal(x), !isVocal(x))));
  // Stimmen: die im Generator gewählte, dann alles mit Gesang aus dem Projekt und der Bibliothek
  let chosen = null;
  try { chosen = JSON.parse(localStorage.getItem("voice")); } catch {}
  const opts = [new Option(t("st_take_voice_free"), "")];
  const seen = new Set();
  const add = (value, label) => { if (!seen.has(value)) { seen.add(value); opts.push(new Option(label, value)); } };
  if (chosen) add(`voice:${chosen.id}`, chosen.name);
  for (const c of clips()) { const m = media.get(c.asset)?.meta; if (m && (m.kind === "song" || VOCAL_KINDS.includes(m.kind))) add(`asset:${m.id}`, m.name); }
  for (const s of songs) if (s.lyrics !== "[Instrumental]") add(`song:${s.id}`, (s.title || s.caption.split(",")[0]) + (s.letter ? ` ${s.letter}` : ""));
  takeForm.voice.replaceChildren(...opts);
  takeForm.voice.selectedIndex = opts.length > 1 ? 1 : 0;
  takeForm.convert.replaceChildren(new Option(t("vm_take_none"), ""), ...readyModels().map((m) => new Option(m.name, m.id)));
  takeForm.convert.closest("label").hidden = !readyModels().length;
  // Stil und Tonart vom Song übernehmen, aus dem der Beat stammt
  const beatSong = songs.find((s) => clips().some((c) => media.get(c.asset)?.meta?.source_song === s.id));
  takeDlg.dataset.key = beatSong?.result_meta?.keyscale || "";
  if (!takeForm.style.value && beatSong) takeForm.style.value = beatSong.caption;
  const end = projectEnd(), from = range ? range.start : playhead >= end ? 0 : playhead, to = range ? range.end : end;
  takeDlg.dataset.from = from; takeDlg.dataset.to = to;
  $("#stTakeWhere").textContent = t("st_take_where", fmtShort(from), fmtShort(to));
  $("#stTakeWhere").className = "st-info";
  takeDlg.showModal();
}
$("#stTakePaste").addEventListener("click", () => {
  try { const s = JSON.parse(localStorage.getItem("texter") || "{}").song; if (s?.lyrics) takeForm.lyrics.value = s.lyrics; } catch {}
});
$("#stTakeCancel").addEventListener("click", () => takeDlg.close());
async function runTake() {
  const lyrics = takeForm.lyrics.value.trim(), beatIds = new Set([...takeForm.beat.selectedOptions].map((o) => o.value));
  const say = (text) => { $("#stTakeWhere").textContent = text; $("#stTakeWhere").className = "st-info err"; };
  if (!lyrics) return say(t("st_take_no_text"));
  if (!beatIds.size) return say(t("st_take_no_beat"));
  const from = +takeDlg.dataset.from, to = +takeDlg.dataset.to, voiceSel = takeForm.voice.value, style = takeForm.style.value.trim(), convertTo = takeForm.convert.value;
  takeDlg.close();
  busy = true; syncButtons();
  info(t("st_take_wait"), "busy");
  try {
    const mix = await renderMix(from, to, beatIds), peak = peakOf(mix);
    const body = new FormData();
    body.append("beat", new Blob([encodeWav(mix, peak > 0.98 ? 0.98 / peak : 1)], { type: "audio/wav" }), "beat.wav");
    for (const [k, v] of Object.entries({ lyrics, style, voice: voiceSel, bpm: project.data.bpm || 0, key: takeDlg.dataset.key, language: takeForm.language.value, seconds: to - from })) body.append(k, v);
    const r = await api(`/api/studio/projects/${project.id}/take`, { method: "POST", raw: true, body });
    const j = await waitJob(r.job);
    if (j.status === "error") throw new Error(j.message);
    await refreshAssets();
    const a = convertTo ? await convertAsset(j.assets[0].id, convertTo, 0) : j.assets[0];
    media.set(a.id, { meta: a });
    await loadAsset(a.id);
    edit(() => {
      const tr = addTrack(a.name);
      // Der Server hat gemessen, wo die Stimme auf dem Beat liegt. Rutscht der Anfang damit vor 0:00, fehlt eben dieses Stück.
      const start = from + (j.shift || 0), cut = Math.max(0, -start);
      const c = clipDefaults(a.id, tr.id, start + cut, cut);
      project.data.clips.push(c);
      project.data.lyrics = [project.data.lyrics, lyrics].filter(Boolean).join("\n\n");
      sel = new Set([c.id]);
      selTrack = tr.id;
    });
    info(t("st_take_done"));
  } catch (err) { jobFailed(err); }
  busy = false; syncButtons();
}
$("#stTakeGo").addEventListener("click", runTake);

// ---------------------------------------------------------------- Mikrofon-Aufnahme und Datei-Import
// Der Aufnahme-Baustein liefert die Rohdaten samt Zeitstempel der Audio-Uhr: verlustfrei und mit derselben Uhr wie die Wiedergabe.
const REC_WORKLET = `class StRec extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input.length) this.port.postMessage({ t: currentTime, ch: input.map((c) => c.slice(0)) });
    return true;
  }
}
registerProcessor("st-rec", StRec);`;
let rec = null;   // laufende Aufnahme: { stream, node, source, cap, chunks, timer, firstAt, base, startAt, inLatency, peak }
async function openCapture() {
  audio();
  await ctx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch { throw new Error(t("st_rec_denied")); }
  // Firefox verlangt, dass Mikrofon und Audio-Kontext dieselbe Abtastrate haben. Passt sie nicht, nimmt ein eigener Kontext auf, umgerechnet wird danach.
  let cap = ctx, source;
  try { source = ctx.createMediaStreamSource(stream); } catch { cap = new AudioContext(); source = cap.createMediaStreamSource(stream); }
  const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: "text/javascript" }));
  await cap.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(cap, "st-rec", { numberOfOutputs: 0 });
  const r = { stream, node, source, cap, chunks: [], firstAt: null, peak: 0, inLatency: stream.getAudioTracks()[0].getSettings().latency || 0, clockShift: ctx.currentTime - cap.currentTime };
  node.port.onmessage = (e) => {
    if (r.firstAt === null) r.firstAt = e.data.t + r.clockShift;
    r.chunks.push(e.data.ch);
    for (const v of e.data.ch[0]) { const a = Math.abs(v); if (a > r.peak) r.peak = a; }
    $("#stMeter").style.width = `${Math.min(100, r.peak * 100)}%`;
    r.peak *= 0.9;
  };
  source.connect(node);
  return r;
}
// Beendet die Aufnahme und liefert sie als AudioBuffer in 48 kHz (oder null, wenn nichts ankam)
async function closeCapture(r) {
  r.source.disconnect(); r.node.port.onmessage = null;
  r.stream.getTracks().forEach((x) => x.stop());
  const length = r.chunks.reduce((n, c) => n + c[0].length, 0);
  if (!length) { info(t("st_rec_empty"), "err"); return null; }
  const channels = Math.min(2, r.chunks[0].length);
  let buf = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: r.cap.sampleRate });
  for (let c = 0; c < channels; c++) { let o = 0; const d = buf.getChannelData(c); for (const ch of r.chunks) { d.set(ch[c] || ch[0], o); o += ch[0].length; } }
  if (r.cap !== ctx) {
    const off = new OfflineAudioContext(channels, Math.ceil(buf.duration * RATE), RATE), s = off.createBufferSource();
    s.buffer = buf; s.connect(off.destination); s.start();
    buf = await off.startRendering();
    await r.cap.close();
  }
  $("#stMeter").style.width = "0";
  return buf;
}
async function startRecording() {
  if (!project) return;
  let r;
  try { r = await openCapture(); } catch (err) { info(err.message, "err"); return; }
  rec = r;
  if (playing) playhead = currentTime();
  r.base = playhead;
  startPlaybackForRecording();
  r.startAt = playStart;
  $("#stRec").setAttribute("aria-pressed", "true");
  const t0 = performance.now();
  const say = () => info(t("st_rec_running", fmtShort((performance.now() - t0) / 1000)));
  say();
  r.timer = setInterval(say, 500);
}
function startPlaybackForRecording() {
  // Auch in einem leeren Projekt oder hinter dem letzten Clip läuft die Uhr weiter, solange aufgenommen wird
  audio();
  stopSources();
  playBase = playhead;
  playStart = ctx.currentTime + 0.06;
  live = buildGraph(ctx, master, playBase, Math.max(playBase, projectEnd()), playStart);
  playing = true;
  $("#stPlay").textContent = "❚❚";
  cancelAnimationFrame(rafId);
  const follow = () => {
    if (!rec) return;
    const now = currentTime();
    if (now * pxPerSec - scroller.scrollLeft > scroller.clientWidth - 40) { playhead = now; layout(); scroller.scrollLeft = now * pxPerSec - 80; }
    showPlayhead(now);
    rafId = requestAnimationFrame(follow);
  };
  rafId = requestAnimationFrame(follow);
}
async function stopRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  clearInterval(r.timer);
  const stopAt = currentTime();
  playhead = stopAt;
  pause();
  $("#stRec").setAttribute("aria-pressed", "false");
  try {
    const buf = await closeCapture(r);
    if (!buf) return;
    const n = assets.filter((a) => a.kind === "recording").length + 1;
    const a = await api(`/api/studio/assets/upload?name=${encodeURIComponent(t("st_rec_name", n))}`, { method: "POST", raw: true, body: encodeWav(buf), headers: { "Content-Type": "audio/wav" } });
    await refreshAssets();
    media.set(a.id, { meta: a, buffer: buf, peaks: computePeaks(buf) });
    // Wer singt, hört den Beat um die Ausgabe-Latenz zu spät und kommt um die Eingabe-Latenz zu spät beim Rechner an: das wird herausgerechnet
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + r.inLatency;
    const start = r.base + (r.firstAt - r.startAt) - latency, cut = Math.max(0, -start);
    edit(() => {
      const free = tracks().find((x) => x.id === selTrack && !clips().some((c) => c.track === x.id));
      const tr = free || addTrack(a.name);
      const c = clipDefaults(a.id, tr.id, start + cut, cut);
      project.data.clips.push(c);
      sel = new Set([c.id]);
      selTrack = tr.id;
    });
    info("");
  } catch (err) { info(err.message, "err"); }
}
const toggleRecording = () => (rec ? stopRecording() : startRecording());
let importToProject = true;
async function importFiles(e) {
  const files = [...e.target.files], place = importToProject;
  importToProject = true;
  e.target.value = "";
  for (const file of files) {
    info(t("st_loading_media"), "busy");
    try {
      audio();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const a = await api(`/api/studio/assets/upload?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ""))}`, { method: "POST", raw: true, body: encodeWav(buf), headers: { "Content-Type": "audio/wav" } });
      await refreshAssets();
      media.set(a.id, { meta: a, buffer: buf, peaks: computePeaks(buf) });
      if (place) await placeAsset(a.id, null, playing ? currentTime() : playhead);
      else { lastVoiceRec = a.id; renderVoiceDlg(); }
      info("");
    } catch (err) { info(err.message, "err"); }
  }
}

// ---------------------------------------------------------------- Meine Stimme: Modell trainieren und Gesang umwandeln
let voiceModels = [], vcAvailable = false, trainJob = null, trainTimer = 0;
const readyModels = () => voiceModels.filter((m) => m.status === "ready");
const voiceDlg = $("#stVoiceDlg"), voiceForm = $("#stVoiceForm");
async function refreshVoiceModels() {
  const r = await api("/api/studio/voice-models");
  voiceModels = r.models; vcAvailable = r.available;
  const running = voiceModels.find((m) => m.job);
  if (running && !trainJob) watchTraining(running.job, running.name);
  renderVoiceDlg();
}
function renderVoiceDlg() {
  const label = (m) => (m.status === "ready" ? `${t("vm_ready")} · ${fmtShort(m.seconds)}` : m.status === "training" ? t("vm_training_row") : `${t("vm_failed")}${m.message === "interrupted" ? `: ${t("vm_interrupted")}` : m.message ? `: ${m.message}` : ""}`);
  $("#stVmList").innerHTML = voiceModels.map((m) => `<div class="st-vm ${m.status === "failed" ? "err" : ""}" data-m="${m.id}"><span>${esc(m.name)}</span><span class="m">${esc(label(m))}</span><button type="button" title="${esc(t("vm_delete"))}" aria-label="${esc(t("vm_delete"))}">✕</button></div>`).join("");
  const checked = new Set([...$("#stVmRecs").querySelectorAll("input:checked")].map((x) => x.value));
  const first = !$("#stVmRecs").dataset.ready;
  const recs = assets.filter((a) => a.kind === "recording");
  $("#stVmRecs").innerHTML = recs.length ? recs.map((a) => `<div class="st-vm"><label><input type="checkbox" value="${a.id}" ${first || checked.has(a.id) || a.id === lastVoiceRec ? "checked" : ""}><span>${esc(a.name)}</span></label><span class="m">${fmtShort(a.duration)}</span><span></span></div>`).join("") : `<div class="st-none">${esc(t("vm_none_recs"))}</div>`;
  $("#stVmRecs").dataset.ready = "1";
  if (!voiceForm.name.value) voiceForm.name.value = t("vm_default_name");
  updateVoiceEstimate();
  $("#stVmCancel").hidden = !trainJob;
  $("#stVmTrain").hidden = !!trainJob;
  if (!vcAvailable) { $("#stVmStatus").textContent = t("vm_not_set_up"); $("#stVmStatus").className = "st-info err"; }
}
function updateVoiceEstimate() {
  const secs = [...$("#stVmRecs").querySelectorAll("input:checked")].reduce((n, x) => n + (assets.find((a) => a.id === x.value)?.duration || 0), 0);
  $("#stVmTotal").textContent = t("vm_total", fmtShort(secs));
  // Gemessen auf einer RX 7900 XTX: 8 Ausschnitte je Schritt, ein Ausschnitt deckt bei Gesang rund 1,9 s Aufnahme ab, bei Sprache rund 2,3 s (2:49 Gesang ergab 11 Schritte, 7:38 Sprache 25).
  // Ein Schritt dauert 0,6 s, dazu rund 2 Minuten Vorbereitung. 100 Durchläufe brauchten so 12,7 und 26,7 Minuten.
  const epochs = { fast: 100, good: 200, best: 400 }[voiceForm.quality.value];
  const minutes = Math.ceil((epochs * Math.max(1, Math.round(secs / 2.2 / 8)) * 0.6 + 120) / 60);
  $("#stVmEstimate").textContent = secs >= 30 ? t("vm_estimate", minutes, secs < 300) : t("vm_too_short");
  $("#stVmTrain").disabled = secs < 30 || !vcAvailable;
}
function watchTraining(jid, name) {
  trainJob = jid;
  $("#stMyVoice").classList.add("busy");
  const stop = () => { clearInterval(trainTimer); trainJob = null; $("#stMyVoice").classList.remove("busy"); $("#stMyVoice").textContent = t("vm_title"); };
  const poll = async () => {
    try {
      const j = await api(`/api/studio/jobs/${jid}`);
      $("#stVmStatus").className = "st-info";
      $("#stVmStatus").textContent = j.message;
      if (j.epochs) $("#stMyVoice").textContent = `${t("vm_title")} ${j.epoch}/${j.epochs}`;
      if (j.status === "running") return;
      stop();
      $("#stVmStatus").textContent = j.status === "done" ? t("vm_done", name) : j.status === "cancelled" ? t("st_job_cancelled") : j.message;
      $("#stVmStatus").className = j.status === "error" ? "st-info err" : "st-info";
      if (j.status === "done") info(t("vm_done", name));
      await refreshVoiceModels();
    } catch (err) { stop(); $("#stVmStatus").textContent = err.message; renderVoiceDlg(); }
  };
  clearInterval(trainTimer);
  trainTimer = setInterval(poll, 2000);
  poll();
}
$("#stMyVoice").addEventListener("click", async () => { await refreshAssets(); await refreshVoiceModels(); voiceDlg.showModal(); });
$("#stVmClose").addEventListener("click", () => { if (voiceRec) stopVoiceRecording(); voiceDlg.close(); });
$("#stVmRecs").addEventListener("change", updateVoiceEstimate);
voiceForm.quality.addEventListener("change", updateVoiceEstimate);
$("#stVmList").addEventListener("click", async (e) => {
  const row = e.target.closest("button") && e.target.closest("[data-m]");
  if (!row) return;
  const m = voiceModels.find((x) => x.id === row.dataset.m);
  if (!confirm(t("vm_delete_q", m.name))) return;
  await api(`/api/studio/voice-models/${m.id}`, { method: "DELETE" });
  await refreshVoiceModels();
});
$("#stVmTrain").addEventListener("click", async () => {
  const ids = [...$("#stVmRecs").querySelectorAll("input:checked")].map((x) => x.value);
  try {
    const r = await api("/api/studio/voice-models", { method: "POST", body: JSON.stringify({ name: voiceForm.name.value, assets: ids, quality: voiceForm.quality.value }) });
    watchTraining(r.job, voiceForm.name.value);
    await refreshVoiceModels();
  } catch (err) { $("#stVmStatus").textContent = err.message; $("#stVmStatus").className = "st-info err"; }
});
$("#stVmCancel").addEventListener("click", () => { if (trainJob) api(`/api/studio/jobs/${trainJob}/cancel`, { method: "POST" }); });
$("#stVmImport").addEventListener("click", () => { importToProject = false; $("#stFile").click(); });
// Aufnahme nur fürs Stimm-Modell: ohne Wiedergabe, sie landet nicht auf der Zeitleiste
let voiceRec = null, lastVoiceRec = null;
const showVoiceRec = (time) => { $("#stVmRec").textContent = time === null ? t("vm_rec_start") : t("vm_rec_stop", fmtShort(time)); };
$("#stVmRec").addEventListener("click", async () => {
  if (voiceRec) return stopVoiceRecording();
  try { voiceRec = await openCapture(); } catch (err) { $("#stVmStatus").textContent = err.message; $("#stVmStatus").className = "st-info err"; return; }
  const t0 = performance.now();
  voiceRec.timer = setInterval(() => showVoiceRec((performance.now() - t0) / 1000), 500);
  showVoiceRec(0);
});
async function stopVoiceRecording() {
  const r = voiceRec;
  voiceRec = null;
  clearInterval(r.timer);
  showVoiceRec(null);
  try {
    const buf = await closeCapture(r);
    if (!buf) return;
    const n = assets.filter((a) => a.kind === "recording").length + 1;
    const a = await api(`/api/studio/assets/upload?name=${encodeURIComponent(t("st_rec_name", n))}`, { method: "POST", raw: true, body: encodeWav(buf), headers: { "Content-Type": "audio/wav" } });
    lastVoiceRec = a.id;
    await refreshAssets();
    renderVoiceDlg();
  } catch (err) { $("#stVmStatus").textContent = err.message; }
}
// Umwandeln
const convertDlg = $("#stConvertDlg"), convertForm = $("#stConvertForm");
async function convertAsset(aid, model, pitch) {
  let r = await api(`/api/studio/assets/${aid}/convert`, { method: "POST", body: JSON.stringify({ model, pitch }) });
  if (r.job) {
    const j = await waitJob(r.job);
    if (j.status === "error") throw new Error(j.message);
    r = j;
  }
  await refreshAssets();
  return r.assets[0];
}
$("#stConvert").addEventListener("click", async () => {
  const c = selected()[0];
  if (!c) return;
  if (!VOCAL_KINDS.includes(media.get(c.asset)?.meta?.kind)) { info(t("vm_only_vocals"), "err"); return; }
  await refreshVoiceModels();
  if (!readyModels().length) { await refreshAssets(); renderVoiceDlg(); voiceDlg.showModal(); return; }
  convertForm.model.replaceChildren(...readyModels().map((m) => new Option(m.name, m.id)));
  $("#stConvertWhat").textContent = media.get(c.asset)?.meta?.name || "";
  convertDlg.showModal();
});
convertForm.pitch.addEventListener("input", () => { const v = +convertForm.pitch.value; $("#stConvertPitch").textContent = v > 0 ? `+${v}` : v; });
$("#stConvertCancel").addEventListener("click", () => convertDlg.close());
$("#stConvertGo").addEventListener("click", async () => {
  const c = selected()[0], model = convertForm.model.value, pitch = +convertForm.pitch.value, mute = convertForm.mute.checked;
  convertDlg.close();
  if (!c) return;
  busy = true; syncButtons();
  info(t("st_loading_media"), "busy");
  try {
    const a = await convertAsset(c.asset, model, pitch);
    media.set(a.id, { meta: a });
    await loadAsset(a.id);
    edit(() => {
      const at = tracks().findIndex((x) => x.id === c.track);
      const tr = { id: newId(), name: voiceModels.find((m) => m.id === model)?.name || t("vm_title"), volume: 1, pan: 0, mute: false, solo: false };
      project.data.tracks.splice(at + 1, 0, tr);
      const nc = { ...c, id: newId(), asset: a.id, track: tr.id, length: Math.min(c.length, Math.max(a.duration - c.offset, MIN_CLIP)) };
      project.data.clips.push(nc);
      if (mute) { const old = tracks().find((x) => x.id === c.track); if (old) old.mute = true; }
      sel = new Set([nc.id]);
      selTrack = tr.id;
    });
    info(t("vm_converted"));
  } catch (err) { jobFailed(err); }
  busy = false; syncButtons();
});

// ---------------------------------------------------------------- Knöpfe und Tastatur
$("#stPlay").addEventListener("click", () => { if (rec) stopRecording(); else if (playing) pause(); else startPlayback(); });
$("#stRec").addEventListener("click", toggleRecording);
$("#stImport").addEventListener("click", () => $("#stFile").click());
$("#stFile").addEventListener("change", importFiles);
$("#stToStart").addEventListener("click", () => { pause(); playhead = 0; scroller.scrollLeft = 0; showPlayhead(); });
$("#stSplit").addEventListener("click", () => splitAt(playing ? currentTime() : playhead));
$("#stCopy").addEventListener("click", copySel);
$("#stPaste").addEventListener("click", () => paste());
$("#stDuplicate").addEventListener("click", duplicateSel);
$("#stRemove").addEventListener("click", removeSel);
$("#stSeparate").addEventListener("click", () => separateClip(2));
$("#stSeparate4").addEventListener("click", () => separateClip(4));
$("#stAddTrack").addEventListener("click", () => { if (project) edit(() => { selTrack = addTrack().id; }); });
$("#stNewVoice").addEventListener("click", openTakeDialog);
$("#stLoop").addEventListener("click", () => { loopOn = !loopOn; syncButtons(); replayIfPlaying(); });
$("#stCutRange").addEventListener("click", cutRange);
$("#stUndo").addEventListener("click", undo);
$("#stRedo").addEventListener("click", redo);
$("#stZoomIn").addEventListener("click", () => zoomTo(pxPerSec * 1.5));
$("#stZoomOut").addEventListener("click", () => zoomTo(pxPerSec / 1.5));
$("#stExport").addEventListener("click", exportMix);
$("#stBpm").addEventListener("change", (e) => { if (project) edit(() => { project.data.bpm = Math.max(0, Math.min(300, Math.round((+e.target.value || 0) * 100) / 100)); }); });
$("#stSnap").addEventListener("change", () => { try { localStorage.setItem("studio_snap", $("#stSnap").checked ? "1" : "0"); } catch {} });
$("#stProject").addEventListener("change", async (e) => { await saveNow(); await openProject(e.target.value); });
$("#stNew").addEventListener("click", async () => { await saveNow(); await newProject().catch((err) => info(err.message, "err")); });
$("#stRename").addEventListener("click", async () => {
  if (!project) return;
  const name = prompt(t("st_project_q"), project.name);
  if (name?.trim()) {
    await api(`/api/studio/projects/${project.id}`, { method: "PUT", body: JSON.stringify({ name }) });
    project.name = name.trim();
    await refreshProjects(project.id);
  }
});
$("#stDelete").addEventListener("click", async () => {
  if (!project || !confirm(`${t("st_delete_sure")} (${project.name})`)) return;
  pause();
  await api(`/api/studio/projects/${project.id}`, { method: "DELETE" });
  project = null;
  await refreshAssets();
  const list = await refreshProjects();
  if (list.length) await openProject(list[0].id); else await newProject();
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, dialog")) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  const act = (fn) => { e.preventDefault(); fn(); };
  if (e.code === "Space") return act(() => { if (rec) stopRecording(); else if (playing) pause(); else startPlayback(); });
  if (e.key === "Home") return act(() => { pause(); playhead = 0; scroller.scrollLeft = 0; showPlayhead(); });
  if (e.key === "Delete" || e.key === "Backspace") return act(removeSel);
  if (key === "s" && !mod) return act(() => splitAt(playing ? currentTime() : playhead));
  if (key === "r" && !mod) return act(toggleRecording);
  if (key === "z" && mod) return act(e.shiftKey ? redo : undo);
  if (key === "y" && mod) return act(redo);
  if (key === "c" && mod) return act(copySel);
  if (key === "x" && mod) return act(() => { copySel(); removeSel(); });
  if (key === "v" && mod) return act(() => paste());
  if (key === "d" && mod) return act(duplicateSel);
  if (key === "+" || key === "=") return act(() => zoomTo(pxPerSec * 1.5));
  if (key === "-") return act(() => zoomTo(pxPerSec / 1.5));
  if (e.key === "ArrowLeft") return act(() => seekBy(e.shiftKey ? -10 : -1));
  if (e.key === "ArrowRight") return act(() => seekBy(e.shiftKey ? 10 : 1));
  if (e.key === "End") return act(() => seekTo(projectEnd()));
  if (e.key === "Escape") return act(() => { sel = new Set(); range = null; loopOn = false; draw(); renderInspector(); syncButtons(); });
});
window.addEventListener("pagehide", () => saveNow(true));
document.addEventListener("langchange", () => { renderHeads(); renderMedia(); renderInspector(); renderVoiceDlg(); showVoiceRec(null); });

// ---------------------------------------------------------------- Start
(async function start() {
  try { if (localStorage.getItem("studio_snap") === "0") $("#stSnap").checked = false; } catch {}
  renderInspector();
  showVoiceRec(null);
  try {
    await Promise.all([refreshSongs(), refreshAssets()]);
    await refreshVoiceModels();
    const song = new URLSearchParams(location.search).get("song");
    const list = await refreshProjects();
    if (song) {
      history.replaceState(null, "", "/studio");
      await newProject(song);
    } else {
      let last = null;
      try { last = localStorage.getItem("studio_project"); } catch {}
      if (list.some((p) => p.id === last)) await openProject(last);
      else if (list.length) await openProject(list[0].id);
      else await newProject();
    }
  } catch (err) { info(err.message, "err"); }
  syncButtons();
})();
