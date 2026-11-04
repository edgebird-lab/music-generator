// ---------------------------------------------------------------- Songtexter
// Leiste neben dem Formular: Thema und Genre rein, Songtext raus. Der Text kommt per Knopf oder Ziehen ins Lyrics-Feld.
// Solange die Leiste offen ist, hält sie eine Verbindung zum Server. Reißt sie ab (Leiste, Seite oder Browser zu), entlädt der Server das Modell.
const txBox = $("#texter"), txForm = $("#txForm"), txSetup = $("#txSetup"), txOut = $("#txOut");
const txLyrics = $("#txLyrics"), txTitle = $("#txTitle"), txStyle = $("#txStyle"), txInfo = $("#txInfo"), txGo = $("#txGo"), txWish = $("#txWish");
const TX_FIELDS = ["theme", "custom_genre", "language", "heat", "perspective", "rhyme", "title", "extra", "creativity"];
const txModel = $("#txModel");   // Modellwahl: je Betriebsart gemerkt (txSaved.models)
// Schnellwünsche fürs Überarbeiten: Die Anweisung ans Modell bleibt deutsch wie der ganze Prompt, die Sprache des Songs steht im Auftrag.
// „Härter“ gibt es nur ohne Filter; im Normalbetrieb steht dort „Emotionaler“.
const TX_WISHES = [
  ["tx_w_harder", "Mach den Text deutlich härter, direkter und respektloser."],
  ["tx_w_deeper", "Mach den Text emotionaler und persönlicher: konkrete Szenen, echte Details, keine Floskeln."],
  ["tx_w_rhymes", "Ersetze schwache und unsaubere Reime durch überraschende, die beim Sprechen wirklich klingen."],
  ["tx_w_cliche", "Streiche jede Floskel und jedes Klischee und ersetze sie durch konkrete, ungewöhnliche Bilder."],
  ["tx_w_hook", "Schreib den Refrain beziehungsweise die Hook neu: kürzer, eingängiger, zum Mitbrüllen."],
  ["tx_w_shorter", "Kürze jede Strophe um etwa ein Drittel und behalte die stärksten Zeilen."],
  ["tx_w_longer", "Mach die Strophen länger und bring neue Details und Wendungen hinein."],
];
const TX_TAG = /^\[[^\]]+\]$/;
let txCfg = null;       // Genre-Katalog und Modelle vom Server
let txEvents = null;    // offene Verbindung zum Server
let txAbort = null;     // läuft gerade ein Schreibauftrag?
let txUndo = [];        // frühere Fassungen
let txModelLoaded = false, txLastStatus = {};
const txSel = { family: "", genre: "", moods: [], structure: [], tone: "clean" };   // tone: clean = Normal, explicit = Ohne Filter
let txSaved = {};
try { txSaved = JSON.parse(localStorage.getItem("texter") || "{}"); } catch {}

function txSay(text, err = false) {
  txInfo.className = "tx-hint" + (err ? " err" : "");
  txInfo.textContent = text;
}
function txSave() {
  // Solange der Katalog nicht geladen ist (Server gerade weg), bleibt der gespeicherte Auftrag stehen
  const s = { ...txSaved, ...(txCfg ? txSel : {}), open: !txBox.hidden, song: { title: txTitle.value, style: txStyle.value, lyrics: txLyrics.value } };
  if (txCfg) for (const f of TX_FIELDS) s[f] = txForm[f].value;
  if (txCfg && txModel.value) s.models = { ...(txSaved.models || {}), [txSel.tone]: txModel.value };
  try { localStorage.setItem("texter", JSON.stringify(s)); } catch {}
}
let txSaveTimer = 0;
const txSaveSoon = () => { clearTimeout(txSaveTimer); txSaveTimer = setTimeout(txSave, 300); };

// ---------------------------------------------------------------- Auswahl: Genre, Stimmung, Aufbau
const txFamily = () => txCfg.families.find((f) => f.name === txSel.family) || txCfg.families[0];
const txGenre = () => txFamily().genres.find((g) => g.name === txSel.genre) || txFamily().genres[0];
function txMark(el, isOn) {
  el.querySelectorAll(".chip").forEach((c) => { const on = isOn(c.textContent); c.classList.toggle("on", on); c.setAttribute("aria-pressed", on); });
}
function txShowGenre() {
  const fam = txFamily(), gen = txGenre(), custom = txForm.custom_genre.value.trim();
  txMark($("#txFamilies"), (n) => !custom && n === fam.name);
  addChips($("#txGenres"), fam.genres.map((g) => g.name), txPickGenre);
  txMark($("#txGenres"), (n) => !custom && n === gen.name);
  $("#txGuide").textContent = custom ? "" : gen.guide;
}
function txPickFamily(name) {
  txSel.family = name; txPickGenre(txFamily().genres[0].name);
}
function txPickGenre(name) {
  txSel.family = txFamily().name; txSel.genre = name; txForm.custom_genre.value = "";
  txSel.structure = [...(txGenre().structure || txFamily().structure)];
  txRenderStruct(); txShowGenre(); txSaveSoon();
}
function txToggleMood(mood) {
  txSel.moods = txSel.moods.includes(mood) ? txSel.moods.filter((m) => m !== mood) : [...txSel.moods, mood];
  txMark($("#txMoods"), (n) => txSel.moods.includes(n)); txSaveSoon();
}
function txShowHeat() {
  const h = txCfg.heat[+txForm.heat.value - 1];
  $("#txHeatName").textContent = h.name; $("#txHeatHint").textContent = h.hint;
}
function txRenderStruct(focus = -1) {
  const el = $("#txStruct");
  let n = 0;
  txSel.structure = txSel.structure.map((s) => (/^Verse\b/.test(s) ? `Verse ${++n}` : s));   // Strophen zählen immer von vorn durch
  el.innerHTML = txSel.structure.map((s, i) => `<span class="chip tx-sec" draggable="true" tabindex="0" data-i="${i}">${esc(s)}<button type="button" aria-label="${esc(t("tx_remove", s))}">×</button></span>`).join("");
  if (focus >= 0) el.children[Math.min(focus, el.children.length - 1)]?.focus();
  txSaveSoon();
}
function txMoveSection(from, to) {
  const [s] = txSel.structure.splice(from, 1);
  txSel.structure.splice(to, 0, s);
  txRenderStruct(to);
}
const txStruct = $("#txStruct");
txStruct.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) { txSel.structure.splice(+b.parentElement.dataset.i, 1); txRenderStruct(); }
});
txStruct.addEventListener("keydown", (e) => {   // Tastatur: Pfeile verschieben, Entf entfernt
  const c = e.target.closest?.(".tx-sec"), i = c ? +c.dataset.i : -1;
  if (!c || e.target.tagName === "BUTTON") return;
  if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); txMoveSection(i, i - 1); }
  if (e.key === "ArrowRight" && i < txSel.structure.length - 1) { e.preventDefault(); txMoveSection(i, i + 1); }
  if (e.key === "Delete") { e.preventDefault(); txSel.structure.splice(i, 1); txRenderStruct(i); }
});
txStruct.addEventListener("dragstart", (e) => {
  const c = e.target.closest?.(".tx-sec");
  if (c) { e.dataTransfer.setData("text/tx-sec", c.dataset.i); e.dataTransfer.effectAllowed = "move"; }
});
txStruct.addEventListener("dragover", (e) => {
  const c = e.target.closest?.(".tx-sec");
  if (c && e.dataTransfer.types.includes("text/tx-sec")) { e.preventDefault(); c.classList.add("drop"); }
});
txStruct.addEventListener("dragleave", (e) => e.target.closest?.(".tx-sec")?.classList.remove("drop"));
txStruct.addEventListener("drop", (e) => {
  const c = e.target.closest?.(".tx-sec");
  if (c && e.dataTransfer.types.includes("text/tx-sec")) { e.preventDefault(); txMoveSection(+e.dataTransfer.getData("text/tx-sec"), +c.dataset.i); }
});

// ---------------------------------------------------------------- Laden und Wiederherstellen
function txFillLanguages() {
  const keep = txForm.language.value;
  txForm.language.replaceChildren(...[...form.vocal_language.options].map((o) => new Option(o.textContent, o.value)));
  txForm.language.value = keep || "de";
}
const txWishes = () => TX_WISHES.filter(([k]) => k !== (txSel.tone === "clean" ? "tx_w_harder" : "tx_w_deeper"));
function txRenderWishes() {
  addChips($("#txWishes"), txWishes().map(([k]) => t(k)), (label) => {
    const w = txWishes().find(([k]) => t(k) === label);
    txRevise(w[1]);
  });
}
// ---------------------------------------------------------------- Betriebsart: Normal (jugendfrei, jedes Modell) oder Ohne Filter (unzensierte Modelle, Härtegrad)
function txFillModels() {
  const list = (txSel.tone === "clean" ? txCfg.models_clean : txCfg.models) || [];
  txModel.replaceChildren(...list.map((m) => new Option(`${m.name} (${m.gb} GB)`, m.name)));
  const wanted = (txSaved.models || {})[txSel.tone] || txCfg.defaults?.[txSel.tone];
  if (wanted && list.some((m) => m.name === wanted)) txModel.value = wanted;
  txModel.disabled = !list.length;
  if (!list.length) txSay(txCfg.ollama ? t(txSel.tone === "clean" ? "tx_no_model_clean" : "tx_no_model") : t("tx_err_ollama"), true);
  else if (txInfo.classList.contains("err")) txSay("");
}
function txSetTone(tone, save = true) {
  txSel.tone = tone === "explicit" ? "explicit" : "clean";
  document.querySelectorAll(".tx-tabs [data-tone]").forEach((b) => { const on = b.dataset.tone === txSel.tone; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  $("#txHeatField").hidden = txSel.tone === "clean";
  $("#txToneHint").textContent = t(txSel.tone === "clean" ? "tx_tone_clean_hint" : "tx_tone_explicit_hint");
  if (txCfg) { txFillModels(); txRenderWishes(); }
  if (save) txSaveSoon();
}
document.querySelectorAll(".tx-tabs [data-tone]").forEach((b) => b.addEventListener("click", () => txSetTone(b.dataset.tone)));
txModel.addEventListener("change", txSaveSoon);
async function txLoad() {
  if (txCfg) return;
  let cfg;
  try { cfg = await api("/api/texter/config"); } catch (err) { txSay(err.message, true); return; }
  txCfg = cfg;
  const fill = (sel, items) => sel.replaceChildren(...items.map((x, i) => new Option(x, i ? x : "")));   // der erste Eintrag heißt „Passend zum Genre“: nichts vorgeben
  fill(txForm.perspective, cfg.perspectives);
  fill(txForm.rhyme, cfg.rhymes);
  txFillLanguages();
  addChips($("#txFamilies"), cfg.families.map((f) => f.name), txPickFamily);
  addChips($("#txMoods"), cfg.moods, txToggleMood);
  addChips($("#txAdd"), Object.keys(cfg.sections).map((s) => `+ ${s}`), (label) => {
    const s = label.slice(2), last = txSel.structure.at(-1);
    txSel.structure.splice(last === "Outro" && s !== "Outro" ? txSel.structure.length - 1 : txSel.structure.length, 0, s);   // vor das Outro, wenn es eines gibt
    txRenderStruct();
  });
  for (const f of TX_FIELDS) {
    const el = txForm[f], v = txSaved[f];
    if (v == null) continue;
    if (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === v)) el.value = v;
  }
  txSel.family = txSaved.family || cfg.families[1].name;   // Vorgabe beim ersten Öffnen: Rap
  txSel.genre = txSaved.genre || txFamily().genres[0].name;
  txSel.moods = (txSaved.moods || []).filter((m) => cfg.moods.includes(m));
  txSel.structure = txSaved.structure || [...(txGenre().structure || txFamily().structure)];
  txMark($("#txMoods"), (n) => txSel.moods.includes(n));
  txShowGenre(); txShowHeat(); txRenderStruct(); showDur();
  txSetTone(txSaved.tone || "clean", false);   // füllt auch Modelle und Wünsche
}
function txRestoreSong() {
  const s = txSaved.song;
  if (!s?.lyrics) return;
  txTitle.value = s.title || ""; txStyle.value = s.style || ""; txLyrics.value = s.lyrics;
  txOut.hidden = false; txRenderSections();
}

// ---------------------------------------------------------------- Text zerlegen
// Modellantwort: "Titel: …", "Stil: …", dann die Abschnitte. Was davor steht (Vorgeplänkel), fällt weg; Sternchen um Marken auch.
function txParse(raw) {
  let title = "", style = "", inBody = false;
  const body = [];
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const plain = line.replace(/^[\s*#_>]+|[\s*_]+$/g, "");
    if (!inBody) {
      const m = plain.match(/^(Titel|Title|Stil|Style)\s*\**:\**\s*(.*)$/i);
      if (m) { if (/^t/i.test(m[1])) title = m[2]; else style = m[2]; continue; }
      if (!TX_TAG.test(plain)) continue;
      inBody = true;
    }
    body.push(TX_TAG.test(plain) ? plain : line.trimEnd());
  }
  return { title: title.replace(/^["„“»]|["“”«]$/g, ""), style, lyrics: body.join("\n").trim() };
}
function txSplit(text) {
  const parts = [];
  for (const line of text.split("\n")) {
    if (TX_TAG.test(line.trim())) parts.push({ name: line.trim().slice(1, -1), body: [] });
    else { if (!parts.length) parts.push({ name: "", body: [] }); parts.at(-1).body.push(line); }
  }
  return parts.map((p) => ({ name: p.name, body: p.body.join("\n").trim() })).filter((p) => p.name || p.body);
}
const txJoin = (parts) => parts.map((p) => [p.name && `[${p.name}]`, p.body].filter(Boolean).join("\n")).join("\n\n");
// Das Modell soll beim Abschnitt nur die neuen Zeilen liefern; schreibt es trotzdem Marken dazu, gilt nur der erste Abschnitt.
function txSectionText(raw) {
  const parts = txSplit(raw.replace(/\r/g, ""));
  return (parts[0]?.body || parts[1]?.body || "").trim();
}
// Klammern, die nur eine Regieanweisung sind, würde der Sänger mitsingen (siehe _clean_lyrics in engines.py).
const TX_DIRECTION = /\b(beat|bass|synth\w*|gitarre\w*|guitar\w*|riff\w*|solo|soli|drums?|schlagzeug|fade\w*|stille|silence|instrumental\w*|sample\w*|scratch\w*|klavier|piano|streicher|strings|setzt\s+ein|verebbt|verstummt|klingt\s+aus|ausklingend\w*|langsamer|schneller|gefl(ü|ue)stert|gesprochen|whisper\w*|spoken|bpm|feedback|tempo)\b/i;
function txTidy(text) {
  return text.split("\n")
    .map((l) => l.replace(/\*\*/g, "").replace(/^\s*\(([^)]*)\)\s*(?=\S)/, (m, inner) => (TX_DIRECTION.test(inner) ? "" : m)))   // "(Geflüstert) Du wirst zahlen"
    .map((l) => l.replace(/(\S)\s*\[([^\]]+)\]\s*$/, "$1 ($2)"))                     // Ad-Lib in eckigen Klammern sähe sonst aus wie eine Abschnittsmarke
    .filter((l) => { const m = l.trim().match(/^\((.*)\)$/); return !(m && TX_DIRECTION.test(m[1])); })
    .filter((l) => !/^\s*\[[^\]]*[,.][^\]]*\]\s*$/.test(l))                          // "[Stille, dann ein dumpfer Basslauf]" ist keine Marke
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function txRenderSections() {
  const names = [...new Set(txSplit(txLyrics.value).map((p) => p.name).filter(Boolean))];
  addChips($("#txSections"), names, txRewrite);
}
// Geschätzte Länge für den Regler: eine Zeile pro Takt, instrumentale Abschnitte pauschal. Zu kurze Songs schneiden den Gesang sonst ab.
function txSeconds(lyrics) {
  const bpm = +form.bpm.value > +form.bpm.min ? +form.bpm.value : 0;
  const perLine = bpm ? 240 / bpm : /Rap/.test(txSel.family) && !txForm.custom_genre.value.trim() ? 2.8 : 3.6;
  let secs = 0;
  for (const p of txSplit(lyrics)) {
    const lines = p.body.split("\n").filter((l) => l.trim()).length;
    secs += lines ? lines * perLine : 12;
  }
  return Math.max(+form.duration.min, Math.min(+form.duration.max, Math.round(secs / 5) * 5));
}

// ---------------------------------------------------------------- Schreiben
function txBusy(on) {
  txGo.textContent = t(on ? "tx_stop" : "tx_go");
  txGo.classList.toggle("stop", on);
  txOut.classList.toggle("busy", on);
  txLyrics.readOnly = on;
}
const txCurrent = () => ({ title: txTitle.value, style: txStyle.value, lyrics: txLyrics.value });
function txShowUndo() { $("#txUndoBtn").hidden = !txUndo.length; }
function txStoreUndo() { if (txLyrics.value.trim()) { txUndo.push(txCurrent()); txShowUndo(); } }

async function txRun(body, onText) {
  if (txAbort || !txCfg) return;
  const abort = txAbort = new AbortController(), hadText = !!txLyrics.value.trim();
  txStoreUndo();
  txBusy(true); txSay(t("tx_writing"));
  let raw = "", done = null, failed = false;
  try {
    const r = await fetch("/api/texter/write", {
      method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json", "X-Lang": LANG },
      body: JSON.stringify({
        theme: txForm.theme.value, family: txSel.family, genre: txSel.genre, custom_genre: txForm.custom_genre.value, language: txForm.language.value,
        moods: txSel.moods, heat: +txForm.heat.value, structure: txSel.structure, perspective: txForm.perspective.value, rhyme: txForm.rhyme.value,
        title: txForm.title.value, extra: txForm.extra.value, creativity: +txForm.creativity.value, model: txModel.value, tone: txSel.tone, ...body }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(typeof e.detail === "string" ? e.detail : r.statusText); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.status === "wait") txSay(t("tx_wait"));
        if (ev.status === "start") txSay(t(txModelLoaded ? "tx_writing" : "tx_loading"));
        if (ev.error) { failed = true; txSay(ev.error === "ollama" ? t("tx_err_ollama") : t("tx_err_model", ev.detail || ""), true); }
        if (ev.text) {
          if (!raw) { txSay(t("tx_writing")); txOut.hidden = false; txSetup.open = false; }
          raw += ev.text;
          onText(raw);
        }
        if (ev.done) done = ev;
      }
    }
    if (!done && !failed) txSay(t("tx_stopped"));
  } catch (err) {
    failed = true;
    txSay(err.name === "AbortError" ? t("tx_stopped") : err.message, err.name !== "AbortError");
  }
  txAbort = null;
  txBusy(false);
  if (raw) {
    txLyrics.value = txTidy(txLyrics.value);
    txRenderSections();
    if (done) txSay(done.reason === "length" ? t("tx_cut") : t("tx_done", Math.round(done.seconds || 0)), done.reason === "length");
  } else if (hadText) { txUndo.pop(); txShowUndo(); }   // es kam nichts Neues: die alte Fassung steht noch da
  txSave();
}

function txShowSong(raw) {
  const s = txParse(raw);
  txTitle.value = s.title; txStyle.value = s.style; txLyrics.value = s.lyrics || raw;
  txLyrics.scrollTop = txLyrics.scrollHeight;
}
function txWrite() {
  if (txAbort) { txAbort.abort(); return; }
  if (!txForm.theme.value.trim()) { txSay(t("tx_no_theme"), true); txSetup.open = true; txForm.theme.focus(); return; }
  txRun({ mode: "new" }, txShowSong);
}
function txRevise(wish) {
  if (!wish.trim() || !txLyrics.value.trim()) { txWish.focus(); return; }
  txWish.value = "";
  txRun({ mode: "revise", wish, ...txCurrent() }, txShowSong);
}
function txRewrite(name) {
  const parts = txSplit(txLyrics.value), old = parts.find((p) => p.name === name)?.body;
  const wish = txWish.value; txWish.value = "";
  // Ein wiederholter Refrain ändert sich überall, wo er wortgleich steht
  txRun({ mode: "section", section: name, wish, ...txCurrent() }, (raw) => {
    txLyrics.value = txJoin(parts.map((p) => (p.name === name && p.body === old ? { ...p, body: txSectionText(raw) } : p)));
  });
}

// ---------------------------------------------------------------- Ins Formular übernehmen
function txApply() {
  const lyrics = txLyrics.value.trim();
  if (!lyrics) return;
  form.instrumental.checked = false; lyricsStash = ""; form.lyrics.value = lyrics;
  syncLyrics();
  const box = $("#lyricsBox");
  box.open = true;
  box.classList.remove("tx-flash"); void box.offsetWidth; box.classList.add("tx-flash");
  if (txTitle.value.trim()) form.title.value = txTitle.value.trim();
  if (txStyle.value.trim()) { form.style.value = txStyle.value.trim(); syncStyleChips(); }
  setSelect(form.vocal_language, txForm.language.value);
  form.duration.value = txSeconds(lyrics); showDur();
  txSay(t("tx_applied", fmt(+form.duration.value)));
  if (innerWidth < 1000) txToggle(false);   // schmales Fenster: Die Leiste verdeckt sonst das Formular
}
// Das ganze Lied am Griff aufs Formular ziehen. Einzelne markierte Zeilen zieht der Browser von selbst ins Lyrics-Feld.
const txCard = form.closest(".card");
const txIsSong = (e) => e.dataTransfer?.types.includes("text/x-songtext");
$("#txDrag").addEventListener("dragstart", (e) => {
  e.dataTransfer.setData("text/plain", txLyrics.value);
  e.dataTransfer.setData("text/x-songtext", "1");
  e.dataTransfer.effectAllowed = "copy";
});
$("#txDrag").addEventListener("dragend", () => txCard.classList.remove("tx-drop"));
txCard.addEventListener("dragover", (e) => { if (txIsSong(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; txCard.classList.add("tx-drop"); } });
txCard.addEventListener("dragleave", (e) => { if (!txCard.contains(e.relatedTarget)) txCard.classList.remove("tx-drop"); });
txCard.addEventListener("drop", (e) => { if (txIsSong(e)) { e.preventDefault(); txCard.classList.remove("tx-drop"); txApply(); } });
// Markierte Zeilen: Von selbst fügt der Browser nur beim Verschieben ein, dann wären sie im Songtexter weg. Also kopieren und selbst einfügen.
let txLineDrag = false;
txLyrics.addEventListener("dragstart", (e) => { txLineDrag = true; e.dataTransfer.effectAllowed = "copy"; });
txLyrics.addEventListener("dragend", () => { txLineDrag = false; });
form.lyrics.addEventListener("dragenter", () => { if (form.instrumental.checked) { form.instrumental.checked = false; syncLyrics(); } });
form.lyrics.addEventListener("dragover", (e) => { if (txLineDrag) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
form.lyrics.addEventListener("drop", (e) => {
  if (!txLineDrag) return;
  e.preventDefault();
  const f = form.lyrics, caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const at = caret?.offsetNode === f ? caret.offset : f.value.length;
  const before = f.value.slice(0, at), after = f.value.slice(at);
  f.setRangeText((before && !before.endsWith("\n") ? "\n" : "") + e.dataTransfer.getData("text/plain") + (after && !after.startsWith("\n") ? "\n" : ""), at, at, "end");
  f.focus(); syncLyrics();
});

// ---------------------------------------------------------------- Leiste und Modellanzeige
function txShowModel(s) {
  txLastStatus = s;
  const el = $("#txModelState"), m = s.loaded?.[0];
  txModelLoaded = !!m;
  el.className = "tx-hint" + (m ? " on" : s.ollama === false || s.server === false ? " err" : "");
  el.textContent = m ? t("tx_loaded", m.name.split("/").pop(), m.gb) : s.server === false ? t("tx_server_gone") : s.ollama === false ? t("tx_offline") : t("tx_not_loaded");
  $("#txUnload").hidden = !m;
}
async function txToggle(open) {
  txBox.hidden = !open;
  document.body.classList.toggle("tx-open", open);
  $("#texterBtn").classList.toggle("on", open);
  if (open) {
    if (!txEvents) {
      txEvents = new EventSource("/api/texter/presence");
      txEvents.onmessage = (e) => txShowModel(JSON.parse(e.data));
      txEvents.onerror = () => txShowModel({ server: false });   // EventSource verbindet sich von selbst wieder
    }
    $("#lyricsBox").open = true;
    await txLoad();
  } else {
    txAbort?.abort();
    txEvents?.close(); txEvents = null;
  }
  txSave();
}

$("#texterBtn").addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();   // <summary> soll dabei nicht auf-/zuklappen
  txToggle(txBox.hidden).then(() => { if (!txBox.hidden && txCfg) txForm.theme.focus(); });
});
$("#txClose").addEventListener("click", () => txToggle(false));
$("#txUnload").addEventListener("click", () => api("/api/texter/unload", { method: "POST" }).catch((err) => txSay(err.message, true)));
txGo.addEventListener("click", txWrite);
$("#txApply").addEventListener("click", txApply);
$("#txCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(txLyrics.value); }
  catch { txLyrics.select(); document.execCommand("copy"); }
  txSay(t("tx_copied"));
});
$("#txUndoBtn").addEventListener("click", () => {
  const v = txUndo.pop();
  if (v) { txTitle.value = v.title; txStyle.value = v.style; txLyrics.value = v.lyrics; txRenderSections(); txSave(); }
  txShowUndo();
});
$("#txRevise").addEventListener("click", () => txRevise(txWish.value));
txWish.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); txRevise(txWish.value); } });
txForm.addEventListener("submit", (e) => e.preventDefault());
txForm.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); txWrite(); } });
txForm.addEventListener("input", (e) => {
  if (e.target.name === "heat") txShowHeat();
  if (e.target.name === "custom_genre") txShowGenre();
  txSaveSoon();
});
for (const el of [txTitle, txStyle, txLyrics]) el.addEventListener("input", () => { txRenderSections(); txSaveSoon(); });
document.addEventListener("langchange", () => {
  if (txCfg) { txFillLanguages(); txRenderStruct(); }
  txSetTone(txSel.tone, false);
  txBusy(!!txAbort); txShowModel(txLastStatus);
});

txShowModel({});
txRestoreSong();
if (txSaved.open) txToggle(true);
