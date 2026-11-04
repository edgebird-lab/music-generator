const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  // Bei FormData (Datei-Upload) setzt der Browser Content-Type inkl. Boundary selbst — nicht überschreiben.
  // X-Lang: Meldungen des Servers (z. B. beim Update) kommen in der gewählten Sprache zurück.
  const headers = { "X-Lang": LANG, ...(opts.body instanceof FormData ? opts.headers : { "Content-Type": "application/json", ...opts.headers }) };
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail) || r.statusText);
  }
  return r.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (sec) => (isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}` : "");
// Ansage für Screenreader (VoiceOver, NVDA …): unsichtbare Statuszeile; urgent = sofort, unterbricht (Fehler)
function announce(text, urgent = false) {
  const el = $(urgent ? "#srAlert" : "#srStatus");
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 50);   // erst leeren, damit gleiche Texte erneut angesagt werden
  clearTimeout(el._t); el._t = setTimeout(() => { el.textContent = ""; }, 8000);   // nicht beim späteren Durchblättern erneut vorlesen
}

// Stil-Karten, nach Art gruppiert; der Würfel mischt daraus einen Stil
const STYLE_GROUPS = {
  genre: ["trip hop", "downtempo", "dub", "deep house", "techno", "drum and bass", "post-rock", "neo-soul", "dark ambient", "boom bap", "orchestral",
    "pop", "rock", "hip hop", "electronic", "lo-fi", "jazz", "ambient", "synthwave", "acoustic", "cinematic",
    "country", "80s pop", "eurotrash", "90s dance", "chillout"],
  vocals: ["female vocals", "male vocals"],
  instr: ["piano", "guitar"],
  mood: ["upbeat", "melancholic", "dreamy"],
};
const STYLE_TAGS = [...STYLE_GROUPS.genre, ...STYLE_GROUPS.vocals, ...STYLE_GROUPS.instr, ...STYLE_GROUPS.mood];
const SECTIONS = ["[intro]", "[verse]", "[pre-chorus]", "[chorus]", "[bridge]", "[outro]", "[instrumental]"];

let songs = [];
let currentId = null;
let onlyFav = false;       // Favoriten-Filter der Bibliothek
const openLyrics = new Set();   // Songs, deren generierte Lyrics gerade aufgeklappt sind
let exportFmt = "wav";   // Download-Format laut Einstellung (nur für die Beschriftung des Download-Knopfs)
let folders = { folders: [], all: 0, none: 0 };
let curFolder = "";      // "" = alle, "none" = unsortiert, sonst Ordner-ID
try { curFolder = localStorage.getItem("folder") || ""; } catch {}
let dragging = false;    // während des Ziehens nicht neu zeichnen
let editingId = null;   // id des Songs, dessen Titel gerade bearbeitet wird

// Erstellungszeit anzeigen, bis ein Song zum ersten Mal abgespielt wurde (danach dauerhaft ausgeblendet)
let played = new Set();
try { played = new Set(JSON.parse(localStorage.getItem("played") || "[]")); } catch {}
const markPlayed = (id) => { played.add(id); try { localStorage.setItem("played", JSON.stringify([...played])); } catch {} };
// started_at = Beginn der Berechnung (ohne Wartezeit in der Schlange); ältere Songs haben nur created_at
const genTime = (s) => { const t = (Date.parse(s.finished_at) - Date.parse(s.started_at || s.created_at)) / 1000; return isFinite(t) && t >= 0 ? fmt(t) : null; };

// Würfel: zufälliger Prompt. Sechs Bauformen von kurz bis lang, gespeist aus Stimmungen, Szenen, Besetzungen,
// Produktion, Verlauf und ganzen Ideen; Gesang nur, wenn der Song nicht instrumental ist. Der Stil bleibt deine Wahl.
const R = {
  mood: ["dark", "dreamy", "melancholic", "hypnotic", "warm", "tense", "nostalgic", "euphoric", "lonely", "mysterious", "hopeful", "gritty",
    "serene", "haunting", "playful", "triumphant", "bittersweet", "restless", "tender", "icy", "sun-drenched", "menacing", "weightless", "feverish",
    "majestic", "wistful", "cheeky", "solemn", "glowing", "ghostly"],
  scene: ["a late night drive through a neon city", "a rainy afternoon in an empty café", "walking through fog at dawn", "an abandoned space station",
    "a quiet forest after snowfall", "a crowded market at sunset", "floating above the clouds", "a smoky club after midnight", "a desert road at sunrise",
    "an old arcade at closing time", "a lighthouse during a storm", "the last train home", "a rooftop above a sleeping city", "an underwater research lab",
    "a ballroom after the guests have left", "a carnival packing up at dawn", "a cathedral filled with candlelight", "a slow river at golden hour",
    "a highway at 3 a.m. with the windows down", "a childhood bedroom found years later", "a spaceship drifting past Jupiter", "a wedding in a thunderstorm",
    "a boxing gym before the big fight", "a lonely gas station in the snow", "a parade marching through a ghost town", "a greenhouse humming with bees",
    "a submarine running silent", "a rooftop garden in the rain", "a film noir stakeout", "a summer fair at twilight", "the first morning after a breakup",
    "a mountain village waking up", "a chase across the rooftops of an old city", "a cold war radio station at night", "a jazz bar on a cruise ship",
    "a library where the books whisper", "the final lap of a race", "a long goodbye at an airport", "a campfire by a black lake", "a robot learning to dance"],
  band: ["a full symphony orchestra", "a string quartet", "solo piano", "a brass band", "a lone acoustic guitar", "a big band with screaming horns",
    "a church organ", "a chamber choir", "vintage analog synthesizers", "a drum machine and a single bass line", "a mariachi ensemble", "a gospel choir and Hammond organ",
    "a harp and distant woodwinds", "marching drums and a trumpet", "a jazz trio late in the set", "a wall of distorted guitars", "a music box and cello",
    "steel drums and upright bass", "a bluegrass band on a porch", "a lone trumpet over sparse piano", "pipe organ and timpani", "a ukulele and whistling",
    "a tango orchestra", "a string section and a ticking drum machine", "an accordion and a double bass", "a 90s rave rig", "a bedroom producer with a cheap sampler",
    "a children's choir and glockenspiel", "an 80s synth-pop setup with gated drums", "a lo-fi cassette four-track"],
  production: ["recorded live in one take", "lo-fi and dusty", "polished and radio-ready", "wide and cinematic", "dry and intimate", "drenched in reverb",
    "crisp and modern", "warm tape saturation", "slightly out of tune on purpose", "huge stadium sound", "crackling like an old record", "crystal clear and spacious",
    "raw garage recording", "glossy 80s production", "muffled as if heard through a wall"],
  arc: ["building gradually to a huge finale", "starting almost silent", "with a sudden drop in the middle", "quiet verses and an explosive chorus",
    "slowly falling apart at the end", "with a false ending", "steady from the first second to the last", "with a long atmospheric intro",
    "breaking down to a single instrument halfway", "ending on an unresolved chord", "getting faster and faster", "like a dream that keeps changing shape",
    "with a breakdown that feels like holding your breath", "circling the same idea until it transforms"],
  detail: ["slow and spacious", "with a steady pulse", "sparse and minimal", "with swelling strings", "with a soft melodic hook", "with a hypnotic repeating motif",
    "with deep warm bass", "with distant echoing textures", "with a syncopated groove", "with a bright, singable melody", "with odd time signatures",
    "with handclaps and stomps", "with a driving half-time beat", "with shimmering arpeggios", "with a wordless hum in the background", "with a melody that aches",
    "with playful call and response", "with a bass line that never stops moving", "with silence used as an instrument", "with a riff you can't shake"],
  vocals: ["sung by a raspy male voice", "with a soft female lead", "with layered harmonies", "with a choir answering the lead", "half spoken, half sung",
    "with a powerful belting vocal", "whispered close to the mic", "with a lazy, laid-back delivery", "with a soulful ad-lib at the end", "a duet between two voices"],
  idea: ["a sea shanty sung on a spaceship", "a tango for two robots", "a lullaby for a thunderstorm", "a marching band in slow motion", "a love song to a city that doesn't exist",
    "a western theme for a dusty planet", "a waltz for the last day of summer", "a funeral march that turns into a party", "a video game boss fight as an opera",
    "a disco track for ghosts", "a hymn for a lighthouse keeper", "a jingle for a shop that sells time", "a spy theme set in a rainforest", "a cowboy lost in Tokyo",
    "a tiny orchestra inside a music box", "a victory anthem for a losing team", "a dance track for a thunder god", "a lullaby a robot sings to itself",
    "a chase scene scored by a string quartet", "a sad song that pretends to be happy", "the national anthem of a country made of clouds", "a monk discovering techno",
    "a pirate ballad about missing home", "a late-night infomercial from the future", "a bedtime story for a dragon", "the sound of a train station remembering everyone",
    "a surf rock song about the moon", "an opera about a lost sock", "a reggae song for a snowstorm", "a baroque fugue played by a jazz trio"],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);
const randomPrompt = () => {
  const vox = !form.instrumental.checked && Math.random() < 0.4 ? pick(R.vocals) : "";
  const forms = [
    () => pick(R.idea),                                                           // ganze Idee, kurz
    () => `${pick(R.mood)} ${pick(R.band)}, ${pick(R.scene)}`,                     // Stimmung + Besetzung + Szene
    () => `${pick(R.mood)}, ${pick(R.scene)}, ${pick(R.detail)}`,                  // klassisch
    () => `${pick(R.idea)}, ${pick(R.production)}, ${pick(R.arc)}`,                // Idee ausgebaut
    () => `${pick(R.band)} playing something ${pick(R.mood)} and ${pick(R.mood)}, ${pick(R.detail)}, ${pick(R.production)}`,
    () => `${pick(R.scene)}: ${pick(R.band)}, ${pick(R.mood)} and ${pick(R.mood)}, ${pick(R.detail)}, ${pick(R.production)}, ${pick(R.arc)}`,   // lang
  ];
  let text = pick(forms)();
  text = text.replace(/\b(\w+) and \1\b/, "$1");   // zweimal dieselbe Stimmung vermeiden
  return cap(vox ? `${text}, ${vox}` : text);
};

// ---------------------------------------------------------------- Formular
const form = $("#genForm");
function addChips(el, items, onClick) {
  el.innerHTML = items.map((t) => `<span class="chip" role="button" tabindex="0">${esc(t)}</span>`).join("");
  el.querySelectorAll(".chip").forEach((c, i) => c.addEventListener("click", () => onClick(items[i])));
}
// Karten sind Schaltflächen: mit Tab erreichbar, Enter und Leertaste lösen einen Klick aus
document.addEventListener("keydown", (e) => {
  const c = e.target.closest?.('[role="button"]');
  if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); c.click(); }
});

// Stil-Karten sind Schalter: an = steht im Stil-Feld (gold umrandet), aus = wird dort wieder entfernt
const styleParts = () => form.style.value.split(",").map((x) => x.trim()).filter(Boolean);
function syncStyleChips() {
  const have = new Set(styleParts().map((x) => x.toLowerCase()));
  $("#tagChips").querySelectorAll(".chip").forEach((c) => {
    const on = have.has(c.textContent.toLowerCase());
    c.classList.toggle("on", on); c.setAttribute("aria-pressed", on);
  });
}
addChips($("#tagChips"), STYLE_TAGS, (tag) => {
  const parts = styleParts(), rest = parts.filter((x) => x.toLowerCase() !== tag.toLowerCase());
  form.style.value = (rest.length < parts.length ? rest : [...parts, tag]).join(", ");
  syncStyleChips();
});
form.style.addEventListener("input", syncStyleChips);
addChips($("#sectionChips"), SECTIONS, (t) => {
  if (t === "[instrumental]") { form.instrumental.checked = true; syncLyrics(); return; }   // zurück zu ohne Gesang
  const f = form.lyrics, pos = f.selectionStart ?? f.value.length;
  const before = f.value.slice(0, pos), ins = (before && !before.endsWith("\n") ? "\n\n" : "") + t + "\n";
  f.value = before + ins + f.value.slice(pos);
  f.focus(); f.selectionStart = f.selectionEnd = pos + ins.length;
});
// Bubble-Slider: Füllstand + Wert im Knopf (BPM ganz links = Auto)
const SLIDER_FMT = { dur: (v) => fmt(v), int: (v) => String(v), temp: (v) => v.toFixed(2), bpm: (v, min) => (v <= min ? ["AUTO", true] : String(v)) };
function updateSlider(box) {
  const inp = box.querySelector("input"), min = +inp.min, max = +inp.max, v = +inp.value;
  box.style.setProperty("--p", (v - min) / (max - min));
  const out = SLIDER_FMT[box.dataset.fmt](v, min), span = box.querySelector(".knob span");
  span.textContent = Array.isArray(out) ? out[0] : out;
  span.classList.toggle("small", Array.isArray(out));
  inp.setAttribute("aria-valuetext", box.dataset.fmt === "dur" ? t("vt_dur", Math.floor(v / 60), v % 60)
    : box.dataset.fmt === "bpm" ? (v <= min ? t("vt_auto") : `${v} BPM`) : span.textContent);
  if (inp.name === "duration") $("#lenHint").hidden = v <= 300;   // ab 5:00 ehrlicher Hinweis: dauert lange, braucht viel Speicher
  if (inp.name === "variants") $("#genBtn").textContent = v > 1 ? t("generate_n", v) : t("generate");
}
const showDur = () => document.querySelectorAll(".slider").forEach(updateSlider);
document.querySelectorAll(".slider").forEach((b) => { b.querySelector("input").addEventListener("input", () => updateSlider(b)); updateSlider(b); });
// Lyrics: eingeklappt; bei Instrumental steht "[Instrumental]" im Feld, Klick ins Feld schaltet Instrumental aus
const LYRICS_PLACEHOLDER = "[verse]\n…\n\n[chorus]\n…";
let lyricsStash = "";
function syncLyrics() {
  const on = form.instrumental.checked, f = form.lyrics;
  if (on) { if (f.value !== "[Instrumental]") lyricsStash = f.value; f.value = "[Instrumental]"; }
  else if (f.value === "[Instrumental]") f.value = lyricsStash;
  f.classList.toggle("dim", on);
  // Leeres Feld ohne Instrumental = automatisch: das Modell schreibt die Lyrics erst beim Generieren
  const auto = !on && !f.value.trim();
  f.classList.toggle("auto", auto);
  f.placeholder = auto ? t("auto_ph") : LYRICS_PLACEHOLDER;
  $("#lyricsHint").textContent = on ? "[Instrumental]" : auto ? t("auto_lbl") : t("own_lyrics");
}
const TITLE = {
  adj: ["Midnight", "Velvet", "Neon", "Silent", "Golden", "Hollow", "Electric", "Faded", "Distant", "Crimson", "Slow", "Lunar", "Paper", "Glass", "Amber"],
  noun: ["Static", "Horizon", "Rain", "Echoes", "Signal", "Drift", "Skyline", "Mirror", "Ember", "Tide", "Orbit", "Harbor", "Afterglow", "Motel", "Garden"],
};
// Ein Genre, dazu null bis zwei weitere Begriffe (zweites Genre, Instrument, Stimmung, bei Gesang auch Stimme):
// höchstens drei Begriffe, gern auch nur einer
const randomStyle = () => {
  const genre = pick(STYLE_GROUPS.genre);
  let second;
  do second = pick(STYLE_GROUPS.genre); while (second === genre);
  const pool = [second, pick(STYLE_GROUPS.instr), pick(STYLE_GROUPS.mood)];
  if (!form.instrumental.checked) pool.push(pick(STYLE_GROUPS.vocals));
  const extra = Math.floor(Math.random() * 3);   // 0, 1 oder 2
  const parts = [genre];
  for (let i = 0; i < extra; i++) parts.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return parts.join(", ");
};
const randomTitle = () => `${pick(TITLE.adj)} ${pick(TITLE.noun)}`;
function rollAnim(btn) { btn.classList.remove("roll"); void btn.offsetWidth; btn.classList.add("roll"); }
function rollDice(btn, field, gen) { field.value = gen(); rollAnim(btn); }
$("#diceBtn").addEventListener("click", (e) => { rollDice(e.currentTarget, form.prompt, randomPrompt); });
$("#titleDice").addEventListener("click", (e) => rollDice(e.currentTarget, form.title, randomTitle));
$("#styleDice").addEventListener("click", (e) => { rollDice(e.currentTarget, form.style, randomStyle); syncStyleChips(); });

// Lyrics-Würfel: lässt das Modell bei der Generierung eigene Lyrics schreiben (kein Text hier, nur "auto"),
// geht nur mit vorhandenem Prompt, weil das Modell sonst nichts hat, worüber es schreiben kann.
const lyricsDice = $("#lyricsDice");
lyricsDice.addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();   // <summary> soll dabei nicht auf-/zuklappen
  form.instrumental.checked = false; lyricsStash = ""; form.lyrics.value = "";
  syncLyrics();
  rollAnim(e.currentTarget);
});
// Einklappen der Lyrics (Klick auf die Kopfzeile) heißt: Instrumental. Der Würfel in der Kopfzeile ist ausgenommen (stoppt oben).
$("#lyricsBox > summary").addEventListener("click", () => {
  if ($("#lyricsBox").open && !form.instrumental.checked) { form.instrumental.checked = true; syncLyrics(); }
});
form.instrumental.addEventListener("change", () => { syncLyrics(); if (!form.instrumental.checked) $("#lyricsBox").open = true; });
form.lyrics.addEventListener("focus", () => { if (form.instrumental.checked) { form.instrumental.checked = false; syncLyrics(); } });
form.lyrics.addEventListener("input", syncLyrics);
syncLyrics();

function readForm() {
  const d = Object.fromEntries(new FormData(form));
  const num = (k, def) => (d[k] === "" || d[k] == null ? def : Number(d[k]));
  return {
    folder_id: curFolder && curFolder !== "none" ? curFolder : null,
    title: d.title || "", prompt: d.prompt || "", style: d.style || "", lyrics: form.instrumental.checked ? "" : d.lyrics || "", instrumental: form.instrumental.checked, keep_caption: form.keep_caption.checked,
    duration: Number(form.duration.value), bpm: Number(form.bpm.value) <= Number(form.bpm.min) ? 0 : Number(form.bpm.value), keyscale: d.keyscale || "", timesignature: d.timesignature || "", vocal_language: form.instrumental.checked ? "" : d.vocal_language || "en",
    seed: num("seed", -1), variants: num("variants", 1),
    voice_id: voice && !form.instrumental.checked ? voice.id : "", voice_name: voice && !form.instrumental.checked ? voice.name : "",
    inference_steps: Number(form.inference_steps.value), lm_temperature: Number(form.lm_temperature.value),
  };
}

// Stimme: Neue Songs übernehmen die Klangfarbe eines früheren Songs, bis sie im Formular entfernt wird. Der Seed kann das nicht,
// denn das Sprachmodell würfelt davor jedes Mal neu (gemessen Nov. 2026: Stimmabdruck 0,91 mit gleichem Seed, 0,96 mit Referenz).
let voice = null;
try { voice = JSON.parse(localStorage.getItem("voice")); } catch {}
function setVoice(v) {
  voice = v;
  try { localStorage.setItem("voice", JSON.stringify(v)); } catch {}
  $("#voiceChip").hidden = !v;
  if (v) $("#voiceName").textContent = t("voice_chip", v.name);
}
setVoice(voice);
$("#voiceClear").addEventListener("click", () => { setVoice(null); render(); });
const songName = (s) => (s.title || s.caption.split(",").slice(0, 3).join(",")) + (s.letter ? ` ${s.letter}` : "");
async function toggleVoice(s) {
  if (voice?.id === s.id) { setVoice(null); render(); return; }
  try { await api(`/api/songs/${s.id}/voice`, { method: "POST" }); } catch (err) { alert(`${t("error")}: ${err.message}`); return; }
  setVoice({ id: s.id, name: songName(s) });
  form.instrumental.checked = false; syncLyrics();   // eine Stimme gibt es nur mit Gesang
  $("#lyricsBox").open = true;
  $("#lyricsBox").scrollIntoView({ block: "nearest", behavior: "smooth" });
  announce(t("voice_on", voice.name));
  render();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!form.prompt.value.trim() && !form.style.value.trim()) { form.prompt.focus(); return; }
  const btn = $("#genBtn");
  if (btn.disabled) return;
  btn.classList.remove("fired"); void btn.offsetWidth; btn.classList.add("fired");   // Animation auch bei Enter/Alt+G
  btn.disabled = true;
  try {
    const r = await api("/api/generate", { method: "POST", body: JSON.stringify(readForm()) });
    announce(t("an_queued", r.ids.length));
    refresh();
  } catch (err) { alert(t("error") + ": " + err.message); }
  setTimeout(() => { btn.disabled = false; }, 600);
});
form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") e.preventDefault(); });

// Auswahlfeld setzen; unbekannte Werte werden ergänzt (Tonart aus der Analyse) oder fallen auf Auto zurück
function setSelect(sel, val, add = false) {
  val = val || "";
  if (![...sel.options].some((o) => o.value === val)) {
    if (add) sel.add(new Option(val, val)); else val = "";
  }
  sel.value = val;
}

function fillForm(s) {
  const p = s.params;
  form.title.value = s.title || "";
  form.style.value = p.style ?? p.caption;   // ältere Songs haben nur einen Text
  form.prompt.value = p.prompt ?? ""; syncStyleChips();
  form.instrumental.checked = p.lyrics === "[Instrumental]";
  form.keep_caption.checked = true;   // Prompt wörtlich ist fest die Vorgabe
  lyricsStash = ""; form.lyrics.value = form.instrumental.checked ? "" : p.lyrics || "";
  syncLyrics(); $("#lyricsBox").open = !form.instrumental.checked && !!(p.lyrics || "").trim();
  form.duration.value = p.duration || 90;
  form.bpm.value = p.bpm || form.bpm.min;
  form.inference_steps.value = p.inference_steps || 50;
  form.lm_temperature.value = p.lm_temperature ?? 0.85;   // ältere Songs liefen mit der Modell-Vorgabe
  showDur();
  setSelect(form.keyscale, p.keyscale, true);
  setSelect(form.timesignature, p.timesignature);
  form.vocal_language.value = p.vocal_language || "en";
  form.seed.value = p.seed;
  form.variants.value = 1; showDur();
  if (p.voice_id) setVoice({ id: p.voice_id, name: p.voice_name || songName(s) });   // ohne Stimme im alten Song bleibt die gewählte stehen
  $("#advBox").open = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- Song-Upload (Analyse)
// Geheime Dropzone: das Logo. Unauffällig, bis man draufzeigt, zieht oder es gerade etwas tut.
const dz = $("#dropzone"), bubble = $("#dzBubble"), fileInput = $("#fileInput");
let dzHideTimer = null;
function dzState(cls, text) {
  clearTimeout(dzHideTimer);
  dz.className = "logo-wrap" + (cls ? ` ${cls}` : "");
  bubble.textContent = text || "";
  bubble.classList.toggle("show", !!text);
  if (cls === "ok") dzHideTimer = setTimeout(() => { dz.className = "logo-wrap"; bubble.classList.remove("show"); }, 4000);
}
// Stilbegriffe aus der Beschreibung der Analyse ziehen: [Tag, Muster, Art]. Art "v" = Stimme (nur bei Songs mit Gesang).
// Die Tags heißen wie die Stil-Karten, damit diese aufleuchten. Weitere Begriffe stehen einfach im Stil-Feld.
const STYLE_VOCAB = [
  ["hip hop", "hip ?hop"], ["rap", "\\brap(?:per|ping)?\\b", "v"], ["boom bap", "boom ?bap"], ["trap", "\\btrap\\b"], ["lo-fi", "lo ?fi"],
  ["trip hop", "trip ?hop"], ["downtempo", "downtempo"], ["dub", "\\bdub\\b"], ["dubstep", "dubstep"],
  ["deep house", "deep house"], ["house", "\\bhouse (?:music|track|beat|groove|vibe|style|rhythm)\\b|\\b(?:tech|progressive|acid|funky|french|chicago|piano) house\\b"],
  ["techno", "techno"], ["trance", "\\btrance\\b"], ["drum and bass", "drum ?(?:and|&|n) ?bass|\\bdnb\\b|\\bjungle\\b"],
  ["breakbeat", "break ?beat"], ["garage", "uk garage|2 step|garage (?:beat|track)"], ["electro", "\\belectro\\b"], ["electronic", "electronic|\\bedm\\b"],
  ["synthwave", "synthwave|retrowave|outrun"], ["synthpop", "synth ?pop"], ["new wave", "new wave"],
  ["disco", "disco"], ["funk", "\\bfunk(?:y)?\\b"], ["soul", "\\bsoul(?:ful)?\\b"], ["neo-soul", "neo ?soul"], ["r&b", "\\br ?(?:&|and|n) ?b\\b|rhythm and blues"],
  ["gospel", "gospel"], ["jazz", "\\bjazz(?:y)?\\b"], ["blues", "\\bblues\\b"], ["rock", "\\brock\\b"], ["post-rock", "post ?rock"], ["hard rock", "hard rock"],
  ["punk", "\\bpunk\\b"], ["metal", "heavy metal|\\bmetal (?:music|track|riffs?|guitars?|band)\\b"], ["grunge", "grunge"], ["indie", "\\bindie\\b"],
  ["shoegaze", "shoegaze"], ["pop", "\\bpop\\b"], ["folk", "\\bfolk\\b"], ["country", "country (?:music|ballad|song|track|guitar)"],
  ["80s pop", "(?:80s|eighties|1980s) pop"], ["eurotrash", "euro ?trash|euro ?dance"], ["90s dance", "(?:90s|nineties|1990s) dance"], ["chillout", "chill ?out"],
  ["reggae", "reggae"], ["ska", "\\bska\\b"], ["reggaeton", "reggaeton"], ["afrobeat", "afro ?beats?"], ["latin", "\\blatin\\b|salsa|bossa ?nova|samba|cumbia"],
  ["orchestral", "orchestra"], ["cinematic", "cinematic|film score|soundtrack"], ["classical", "classical"],
  ["ambient", "\\bambient\\b"], ["dark ambient", "dark ambient"], ["acoustic", "acoustic"], ["chill", "chillhop|\\bchill\\b(?! ?out)"],
  ["piano", "\\bpiano\\b"], ["electric piano", "electric piano|rhodes|wurlitzer"], ["organ", "\\borgan\\b|hammond"], ["synth", "\\bsynth(?:esizers?|s)?\\b"],
  ["guitar", "guitar"], ["funk guitar", "funk(?:y)? guitar|wah ?wah|chicken scratch"], ["slap bass", "slap bass"], ["808 bass", "\\b808\\b"], ["bass", "\\bbass(?:line)?\\b"],
  ["drums", "\\bdrums?\\b|drum (?:break|machine|beat)"], ["strings", "\\bstrings?\\b|violin|cello"], ["brass", "\\bbrass\\b|\\bhorns?\\b|trumpet|trombone"],
  ["saxophone", "\\bsax(?:ophone)?\\b"], ["flute", "flute"], ["harp", "\\bharp\\b"], ["clavinet", "clavinet"], ["vinyl crackle", "vinyl|crackle"],
  ["turntable scratches", "scratch(?:es|ing)?\\b|turntable"], ["choir", "choir|choral"], ["vocoder", "vocoder|talk ?box"],
  ["male vocals", "\\bmale (?:vocals?|singer|voice|rapper|lead)\\b", "v"], ["female vocals", "\\bfemale (?:vocals?|singer|voice|rapper|lead)\\b", "v"], ["falsetto", "falsetto", "v"],
  ["upbeat", "upbeat|energetic|uplifting"], ["melancholic", "melancholi[cy]"], ["dreamy", "dreamy|ethereal"], ["dark", "\\bdark\\b"],
  ["groovy", "\\bgroov(?:y|e)\\b"], ["mellow", "mellow|laid ?back|relaxed"], ["gritty", "gritty|\\braw\\b"],
].map(([tag, re, kind]) => ({ tag, re: new RegExp(re, "g"), vocal: kind === "v" }));

// Reihenfolge der Plätze: Genre, Stimme, Instrument, Stimmung. Innerhalb davon in der Reihenfolge des Textes.
const TAG_VOICE = new Set(["rap", "male vocals", "female vocals", "falsetto"]);
const TAG_MOOD = new Set(["upbeat", "melancholic", "dreamy", "dark", "groovy", "mellow", "gritty"]);
const TAG_INSTR = new Set(["piano", "electric piano", "organ", "synth", "guitar", "funk guitar", "slap bass", "808 bass", "bass", "drums", "strings", "brass",
  "saxophone", "flute", "harp", "clavinet", "vinyl crackle", "turntable scratches", "choir", "vocoder"]);
const tagRank = (tag) => (TAG_VOICE.has(tag) ? 1 : TAG_INSTR.has(tag) ? 2 : TAG_MOOD.has(tag) ? 3 : 0);

function extractStyleTags(text, hasVocals, max = 6) {
  const t = String(text || "").toLowerCase().replace(/[-_/]/g, " ");
  const hits = [];
  for (const v of STYLE_VOCAB) {
    if (v.vocal && !hasVocals) continue;
    v.re.lastIndex = 0;
    const m = v.re.exec(t);
    if (m) hits.push({ tag: v.tag, start: m.index });
  }
  // allgemeiner Begriff entfällt, wenn ein genauerer da ist: "deep house" statt auch "house", "808 bass" statt auch "bass"
  const keep = hits.filter((h) => !hits.some((o) => o.tag !== h.tag && (o.tag.endsWith(" " + h.tag) || o.tag.endsWith("-" + h.tag))));
  return keep.sort((a, b) => tagRank(a.tag) - tagRank(b.tag) || a.start - b.start).slice(0, max).map((h) => h.tag);
}

async function analyzeFile(file, idea = null) {   // idea = Messwerte einer Mikrofon-Aufnahme (measureMelody)
  if (!file) return;
  dzState("busy", t("analyzing", file.name));
  const body = new FormData(); body.append("audio", file);
  try {
    const r = await api("/api/analyze", { method: "POST", body });
    form.prompt.value = idea ? describeIdea(idea, r.caption, r.keyscale) : r.caption || "";
    form.title.value = randomTitle();
   
    // Nur echter Text außerhalb von [Strukturmarkern] zählt als Gesang — sonst schreibt das
    // Modell manchmal Dinge wie "[Acoustic guitar intro]" gefolgt von "[Instrumental]".
    const hasVocals = (r.lyrics || "").replace(/\[[^\]]*\]/g, "").trim().length > 0;
    if (hasVocals) {
      // Song hat Gesang: nicht den transkribierten Text übernehmen, sondern wie beim Lyrics-Würfel
      // das Modell bei der Generierung selbst welche schreiben lassen (Prompt ist ja gerade gesetzt).
      form.instrumental.checked = false; lyricsStash = ""; form.lyrics.value = "";
      $("#lyricsBox").open = true;
      const lang = (r.vocal_language || "").toLowerCase();
      if ([...form.vocal_language.options].some(o => o.value === lang)) form.vocal_language.value = lang;
    } else { form.instrumental.checked = true; }
    syncLyrics();
    // Stil: Begriffe aus der Beschreibung ergänzen; was schon im Stil-Feld steht, bleibt
    const have = styleParts(), low = new Set(have.map((x) => x.toLowerCase()));
    const add = idea ? [] : extractStyleTags(r.caption, hasVocals).filter((x) => !low.has(x.toLowerCase()));   // bei Ideen rät die Analyse das Instrument falsch
    form.style.value = [...have, ...add].join(", "); syncStyleChips();
    if (r.bpm) { form.bpm.value = r.bpm; }
    if (r.duration && !idea) form.duration.value = Math.min(+form.duration.max, Math.max(+form.duration.min, Math.round(r.duration / 5) * 5));
    showDur();
    setSelect(form.keyscale, r.keyscale, true);
    setSelect(form.timesignature, String(r.timesignature || ""));
    dzState("ok", idea ? t("idea_ready") : t("analyzed", file.name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    dzState("err", `${t("error")}: ${err.message}`);
  }
}
dz.addEventListener("click", () => fileInput.click());

// ---------------------------------------------------------------- Ideengeber (Aufnahme vom Mikrofon)
// Knopf im Kopf: gedrückt halten = aufnehmen (Maus, Finger oder Leertaste), 5 bis REC_MAX Sekunden.
// Die Aufnahme geht als WAV durch dieselbe Analyse wie ein hochgeladener Song: Beschreibung, Tempo, Tonart, Takt
// kommen ins Formular; Stil und Länge bleiben unverändert. Die Melodie selbst wird nicht übernommen (ACE-Step kann keine Melodie als
// Vorgabe verarbeiten, getestet im Oktober 2026). Bewusst nur Mikrofon, kein Datei-Upload.
const REC_MAX = 30, REC_MIN = 5;
// Die Analyse des Modells kennt nur fertige Songs und hält Summen für Glockenspiel oder Synthesizer (getestet Okt. 2026).
// Deshalb beschreiben wir eine Mikrofon-Idee selbst aus Messungen: Tonhöhenverlauf (YIN), Tempo der Töne, Bindung.
// Vom Modell übernehmen wir nur Stimmungswörter, dazu Tempo und Tonart; den Stil wählt der Nutzer.
function measureMelody(mono, rate) {
  const step = Math.max(1, Math.round(rate / 16000)), sr = rate / step;      // auf etwa 16 kHz herunter
  const x = new Float32Array(Math.floor(mono.length / step));
  for (let i = 0; i < x.length; i++) { let a = 0; for (let k = 0; k < step; k++) a += mono[i * step + k]; x[i] = a / step; }
  const W = 1024, H = 256, tauMin = Math.floor(sr / 2500), tauMax = Math.ceil(sr / 70);   // 70 Hz (tiefe Stimme) bis 2,5 kHz (Pfeifen)
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const frames = [], d = new Float32Array(tauMax + 1);
  for (let start = 0; start + W + tauMax < x.length; start += H) {
    let e = 0; for (let i = 0; i < W; i++) e += x[start + i] ** 2;
    const rms = Math.sqrt(e / W);
    let pitch = null;
    if (rms > peak * 0.04) {
      let run = 0;
      for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0; for (let i = 0; i < W; i++) { const df = x[start + i] - x[start + i + tau]; sum += df * df; }
        run += sum; d[tau] = run ? (sum * tau) / run : 1;            // kumulierte mittlere normierte Differenz
      }
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (d[tau] < 0.15) { while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++; pitch = 69 + 12 * Math.log2(sr / tau / 440); break; }
      }
    }
    frames.push({ t: start / sr, rms, pitch, loud: rms > peak * 0.04 });
  }
  const voiced = frames.filter((f) => f.pitch !== null);
  if (voiced.length < 10) return null;
  const ps = voiced.map((f) => f.pitch).sort((a, b) => a - b), q = (p) => ps[Math.floor(p * (ps.length - 1))];
  // Tonwechsel: Sprung um mehr als einen Dreiviertelton gegenüber der laufenden Note
  let notes = 1, cur = voiced[0].pitch;
  for (const f of voiced) if (Math.abs(f.pitch - cur) > 0.75) { notes++; cur = f.pitch; }
  const n = voiced.length, mt = voiced.reduce((a, f) => a + f.t, 0) / n, mp = voiced.reduce((a, f) => a + f.pitch, 0) / n;
  const slope = voiced.reduce((a, f) => a + (f.t - mt) * (f.pitch - mp), 0) / Math.max(1e-9, voiced.reduce((a, f) => a + (f.t - mt) ** 2, 0));
  const dur = frames.length * H / sr;
  // gebunden = Anteil der klingenden Stellen mit fester Tonhöhe (Pausen zählen nicht, Konsonanten und Atem schon)
  return { range: q(0.95) - q(0.05), rate: notes / dur, drift: slope * dur, legato: voiced.length / Math.max(1, frames.filter((f) => f.loud).length) };
}
const MOODS = ["magical", "mysterious", "whimsical", "dreamy", "melancholic", "nostalgic", "playful", "gentle", "tender", "hopeful", "haunting",
  "warm", "calm", "peaceful", "uplifting", "dark", "sad", "joyful", "epic", "triumphant", "eerie", "romantic", "serene", "wistful",
  "cheerful", "energetic", "intense", "bittersweet", "soothing", "somber", "lighthearted"];
function describeIdea(m, caption, key) {
  const minor = /minor/i.test(key || "");
  const pace = m.rate < 2 ? "slow" : m.rate < 3.5 ? "moderately paced" : "lively";
  const shape = m.drift < -2 ? "descending" : m.drift > 2 ? "rising" : "gently circling";
  const width = m.range < 5 ? "narrow" : m.range > 9 ? "wide" : "medium-range";
  const smooth = m.legato > 0.6;   // Summen hat Atem- und Konsonantenlücken, 0,6 ist schon gebunden
  const like = m.rate < 2 && smooth ? (minor || m.drift < -2 ? "like a gentle lullaby or a film ballad theme" : "like a tender lullaby or a folk ballad")
    : m.rate < 3.5 ? (smooth ? "like a heartfelt ballad melody" : "like a simple folk tune")
    : smooth ? "like a soaring pop melody" : minor ? "like a driving, rhythmic theme" : "like a cheerful dance tune";
  const low = (caption || "").toLowerCase();
  const moods = MOODS.filter((w) => new RegExp(`\\b${w}\\b`).test(low)).slice(0, 2);
  return `${pace[0].toUpperCase() + pace.slice(1)} melody with a ${width}, ${shape} line and ${smooth ? "smooth, flowing" : "detached, rhythmic"} phrasing, ${like}` +
    (moods.length ? `, ${moods.join(" and ")}` : "");
}

const recBtn = $("#recBtn"), recTime = $("#recTime");
let rec = null;   // laufende Aufnahme: { stream, mr, chunks, start, timer }
let recToggle = false;   // Screenreader: einmal aktivieren = Start, noch einmal = Stopp (Gedrückthalten geht mit VoiceOver nicht)

async function recStart() {
  if (rec || recBtn.classList.contains("busy")) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { dzState("err", t("rec_unsupported")); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } });
  } catch { dzState("err", t("rec_denied")); return; }
  if (!recBtn.classList.contains("held") && !recToggle) { stream.getTracks().forEach((tr) => tr.stop()); return; }   // beim Nachfragen schon losgelassen
  const mr = new MediaRecorder(stream);
  rec = { stream, mr, chunks: [], start: performance.now(), timer: 0 };
  mr.addEventListener("dataavailable", (e) => { if (e.data.size) rec.chunks.push(e.data); });
  mr.addEventListener("stop", recFinish);
  mr.start();
  recBtn.classList.add("on");
  recBtn.setAttribute("aria-pressed", "true");
  rec.timer = setInterval(() => {
    const sec = (performance.now() - rec.start) / 1000;
    recBtn.style.setProperty("--p", Math.min(1, sec / REC_MAX));
    recTime.textContent = String(Math.floor(sec));
    if (sec >= REC_MAX) recStop();
  }, 100);
}
function recStop() {
  recBtn.classList.remove("held");
  recToggle = false;
  if (!rec) return;
  clearInterval(rec.timer);
  if (rec.mr.state === "recording") rec.mr.stop();
}
async function recFinish() {
  const { stream, chunks, mr, start } = rec;
  rec = null;
  stream.getTracks().forEach((tr) => tr.stop());
  recBtn.classList.remove("on"); recBtn.style.removeProperty("--p"); recTime.textContent = "";
  recBtn.setAttribute("aria-pressed", "false");
  if (performance.now() - start < REC_MIN * 1000) { dzState("err", t("rec_short")); return; }
  recBtn.classList.add("busy");
  try {
    const { wav, mono, rate } = await toWav(new Blob(chunks, { type: mr.mimeType }));
    const idea = measureMelody(mono, rate) || { range: 5, rate: 2.5, drift: 0, legato: 0.8 };   // nichts Tonales gefunden: neutrale Werte
    await analyzeFile(new File([wav], t("rec_name"), { type: "audio/wav" }), idea);   // Name ohne Endung: so steht er in der Meldung
  } catch (err) { dzState("err", `${t("error")}: ${err.message}`); }
  recBtn.classList.remove("busy");
}
// Browser-Aufnahme (webm/mp4) in Mono-WAV 16 Bit umwandeln; leise Mikrofone werden auf -1 dB angehoben
async function toWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close?.();
  const n = buf.length, ch = buf.numberOfChannels, mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const gain = peak > 0 ? Math.min(0.89 / peak, 20) : 1;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, v) => { for (let i = 0; i < v.length; i++) out.setUint8(o + i, v.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, mono[i] * gain)); out.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
  return { wav: out.buffer, mono, rate: buf.sampleRate };
}
// Gedrückt halten: Zeigerereignisse decken Maus und Finger ab, Tastatur über Leertaste/Enter
recBtn.addEventListener("pointerdown", (e) => { if (e.button === 0) { recBtn.classList.add("held"); recStart(); } });
["pointerup", "pointercancel"].forEach((ev) => window.addEventListener(ev, () => { if (recBtn.classList.contains("held")) recStop(); }));
recBtn.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); recBtn.classList.add("held"); recStart(); } });
recBtn.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); recStop(); } });
recBtn.addEventListener("contextmenu", (e) => e.preventDefault());
// Klick ohne Maus (detail 0) kommt vom Screenreader: umschalten statt halten. Erst ansagen, dann das Mikrofon öffnen,
// damit die Ansage nicht mit aufgenommen wird.
recBtn.addEventListener("click", (e) => {
  if (e.detail !== 0) return;
  if (rec) { recStop(); return; }
  recToggle = true;
  announce(t("an_rec_start"));
  setTimeout(() => { if (recToggle) recStart(); }, 1800);
});
window.addEventListener("blur", recStop);
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => analyzeFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "dragend"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); analyzeFile(e.dataTransfer.files[0]); });

// ---------------------------------------------------------------- Bibliothek
async function refresh() {
  let busy = true;   // bei einem Fehler (Server startet gerade neu) zügig erneut versuchen
  try {
    folders = await api("/api/folders");
    if (curFolder && curFolder !== "none" && !folders.folders.some((f) => f.id === curFolder)) setFolder("", false);
    if (!dragging) renderFolders();
    const q = new URLSearchParams({ q: $("#search").value, favorites: onlyFav, folder: curFolder });
    songs = await api("/api/songs?" + q);
    announceChanges(songs);
    if (!editingId && !dragging) render();   // während des Umbenennens nicht neu zeichnen, sonst verliert das Feld den Fokus
    const qu = await api("/api/queue");
    busy = qu.running.length || qu.queued;
    libStats = qu.library; showLibStats();
  } catch {}
  clearTimeout(refresh.t);
  refresh.t = setTimeout(refresh, busy ? 1500 : 8000);
}

// Ansage, wenn ein Song fertig wird oder scheitert (beim ersten Laden nur merken, nichts sagen)
const lastStatus = new Map();
function announceChanges(list) {
  const first = lastStatus.size === 0;
  for (const s of list) {
    const was = lastStatus.get(s.id);
    if (!first && was && was !== s.status) {
      const name = (s.title || s.caption.split(",").slice(0, 3).join(",")) + (s.letter ? ` ${s.letter}` : "");
      if (s.status === "done") announce(t("an_done", name));
      if (s.status === "error") announce(t("an_error", name), true);
    }
    lastStatus.set(s.id, s.status);
  }
}

// Tastenkürzel (mit Alt bzw. Option, damit sie nicht mit dem Tippen oder dem Screenreader kollidieren):
// Alt+G generieren, Alt+R Aufnahme starten/beenden, Alt+B zur Bibliothek, Alt+N zum Formular
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const act = { KeyG: () => form.requestSubmit(), KeyR: () => recBtn.dispatchEvent(new MouseEvent("click", { detail: 0 })),
                KeyB: () => $("#libHeading").focus(), KeyN: () => form.prompt.focus() }[e.code];
  if (act) { e.preventDefault(); act(); }
});

let libStats = null;
function showLibStats() {
  if (!libStats) return;
  const mb = libStats.bytes / 1048576, nf = (v, d) => v.toLocaleString(LANG, { maximumFractionDigits: d });
  $("#libStats").textContent = libStats.count ? `${libStats.count} Songs · ${mb >= 1024 ? nf(mb / 1024, 1) + " GB" : nf(mb, 0) + " MB"}` : "";
}

function render() {
  const lib = $("#library");
  if (!songs.length) { lib.innerHTML = `<div class="empty">${t("empty")}</div>`; return; }
  lib.innerHTML = songs.map((s, i) => {
    const m = s.result_meta || {}, p = s.params || {};
    const newGroup = i > 0 && songs[i - 1].group_id !== s.group_id;
    const title = (s.title || s.caption.split(",").slice(0, 3).join(",")) + (s.letter ? ` ${s.letter}` : "");
    const meta = [
      m.bpm && `${m.bpm}BPM`,
      p.inference_steps ? `${p.inference_steps}IT` : null,
      p.lm_temperature != null ? `${(+p.lm_temperature).toFixed(1)}VAR` : null,
      m.keyscale, m.duration && fmt(m.duration),
      p.voice_name && t("voice_meta", p.voice_name),
    ].filter(Boolean).join(" · ");
    const playing = s.id === currentId && ws?.isPlaying();
    let left, state = "";
    if (s.status === "done") left = `<button class="aktion round" data-a="play" aria-label="${t("play")}">${playing ? "❚❚" : "▶"}</button>`;
    else if (s.status === "error") left = `<div class="slot err" title="${esc(s.message)}">!</div>`;
    else if (s.status === "running") left = `<div class="slot run">♪</div>`;
    else left = `<div class="slot">${s.status === "cancelled" ? "✕" : "…"}</div>`;
    if (s.status === "running") state = `<div class="s run">${esc(s.message || "0:00")}</div><div class="mini-bar"></div>`;
    if (s.status === "queued") state = `<div class="s">${t("waiting")}</div>`;
    if (s.status === "cancelled") state = `<div class="s">${t("cancelled")}</div>`;
    if (s.status === "error") state = `<div class="s err" title="${esc(s.message)}">${t("error")} · ${esc(shortErr(s.message))}</div>`;
    if (s.status === "done" && !played.has(s.id)) { const tm = genTime(s); if (tm) state = `<div class="s took">${t("created_in")} ${tm}</div>`; }
    // Vom Modell geschriebener Text (nur bei Songs mit Gesang)
    const lyr = s.status === "done" && s.lyrics !== "[Instrumental]" && /[^\s\[\]]/.test((m.lyrics || "").replace(/\[[^\]]*\]/g, "")) ? m.lyrics.trim() : "";
    const actions = [
      s.status === "done" && `<button class="sek icon ${s.favorite ? "on" : ""}" data-a="fav" title="${t("fav")}">${s.favorite ? "★" : "☆"}</button>`,
      s.status === "done" && `<a class="download icon fmt" href="${s.url}?download=1" title="${t("download")}">${exportFmt === "mp3" || s.file.endsWith(".mp3") ? "MP3" : "WAV"}</a>`,
      lyr && `<button class="sek icon txt ${openLyrics.has(s.id) ? "on" : ""}" data-a="lyrics" title="${t("show_lyrics")}">TXT</button>`,
      lyr && s.file.toLowerCase().endsWith(".wav") && `<button class="sek icon ${voice?.id === s.id ? "on" : ""}" data-a="voice" aria-pressed="${voice?.id === s.id}" title="${t(voice?.id === s.id ? "voice_stop" : "voice_use")}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg></button>`,
      folders.folders.length > 0 && `<button class="sek icon" data-a="move" title="${t("move")}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>`,
      !p.studio && `<button class="sek icon" data-a="more" title="${t("more")}">＋</button>`,
      !p.studio && `<button class="sek icon" data-a="reuse" title="${t("reuse")}"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 3l7 7h-4v10h-6V10H5l7-7z"/></svg></button>`,
      s.status === "done" && s.file.toLowerCase().endsWith(".wav") && `<a class="sek icon" href="/studio?song=${s.id}" title="${t("st_open")}" aria-label="${t("st_open")}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/><rect x="7" y="5" width="3" height="4" rx="1" fill="currentColor"/><rect x="14" y="10" width="3" height="4" rx="1" fill="currentColor"/><rect x="9" y="15" width="3" height="4" rx="1" fill="currentColor"/></svg></a>`,
      ["error", "cancelled"].includes(s.status) && `<button class="sek icon" data-a="retry" title="${t("retry")}">↻</button>`,
      armedKey === `song:${s.id}`
        ? `<button class="sek icon del armed" data-a="del" data-arm="song:${s.id}" title="${t("del_q")}">?</button>`
        : `<button class="sek icon del" data-a="del" data-arm="song:${s.id}" title="${["queued", "running"].includes(s.status) ? t("cancel") : t("del")}">✕</button>`,
    ].filter(Boolean).join("");
    return `<div class="song ${s.id === currentId ? "playing" : ""}${newGroup ? " new-group" : ""}" data-id="${s.id}" draggable="${folders.folders.length > 0 && s.id !== editingId}">
      ${left}
      <div style="min-width:0">${s.id === editingId
        ? `<input class="t-edit" data-id="${s.id}" value="${esc(s.title || "")}" placeholder="${esc(s.caption.split(",").slice(0, 3).join(","))}">`
        : `<div class="t" data-a="rename" role="heading" aria-level="3" title="${t("rename")}">${esc(title)}</div>`
      }<div class="m" title="${t("meta_tip")}">${esc(meta)}</div>${state}</div>
      <div class="actions">${actions}</div>${lyr && openLyrics.has(s.id)
        ? `<div class="lyr-wrap"><pre class="lyr">${esc(lyr)}</pre><a class="download mini lyr-dl" download="${esc((title || s.id).replace(/[\\/:*?"<>|]+/g, "_"))}.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(lyr)}" title="${t("lyrics_dl")}">TXT ↓</a></div>`
        : ""}</div>`;
  }).join("");
  // Symbolknöpfe: Tooltip auch als Name für Screenreader
  lib.querySelectorAll("button[title]:not([aria-label]), a[title]:not([aria-label])")
    .forEach((el) => el.setAttribute("aria-label", el.title));
}
function shortErr(msg = "") {
  if (/nicht erreichbar/i.test(msg)) return t("err_offline");
  if (/Codes/i.test(msg)) return t("err_codes");
  if (/Zeitüberschreitung/i.test(msg)) return t("err_timeout");
  return t("err_details");
}

$("#library").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-a]");
  if (!btn) return;
  const id = btn.closest(".song").dataset.id, s = songs.find((x) => x.id === id);
  const a = btn.dataset.a;
  if (a === "play") return play(s);
  if (a === "rename") { editingId = id; render(); const inp = $(`.t-edit[data-id="${id}"]`); inp?.focus(); inp?.select(); return; }
  if (a === "fav") await api(`/api/songs/${id}`, { method: "PATCH", body: JSON.stringify({ favorite: !s.favorite }) });
  if (a === "reuse") return fillForm(s);
  if (a === "move") return moveMenu(btn, id);
  if (a === "lyrics") { openLyrics.has(id) ? openLyrics.delete(id) : openLyrics.add(id); return render(); }
  if (a === "voice") return toggleVoice(s);
  if (a === "retry") await api(`/api/songs/${id}/retry`, { method: "POST" });
  if (a === "more") {
    const p = s.params;
    await api("/api/generate", { method: "POST", body: JSON.stringify({ ...p, instrumental: false, keep_caption: p.use_cot_caption !== true, title: s.title || "", seed: -1, variants: 1, group_id: s.group_id, folder_id: s.folder_id }) });
  }
  if (a === "del") {
    // Löschen in zwei Klicks: erster Klick macht aus ✕ ein ?, zweiter Klick auf dieselbe Stelle löscht.
    // Abbrechen laufender oder wartender Songs geht weiter mit einem Klick.
    if (!["queued", "running"].includes(s.status) && armedKey !== `song:${id}`) { arm(`song:${id}`); return; }
    disarm(false);
    await api(`/api/songs/${id}`, { method: "DELETE" }).catch((err) => alert(err.message));
  }
  refresh();
});
// Zwei-Klick-Bestätigung statt Browser-Dialog (Song löschen, Ordner löschen, Server stoppen): der erste Klick
// schaltet den Knopf scharf (rot, Rückfrage im Knopf), der zweite an derselben Stelle führt aus. Nach 3 s oder bei
// einem Klick woandershin fällt er zurück. armedKey sagt, welcher Knopf scharf ist: "song:<id>", "folder:<id>", "stop".
let armedKey = null, armedTimer = 0;
function arm(key) {
  armedKey = key;
  clearTimeout(armedTimer);
  armedTimer = setTimeout(() => disarm(), 3000);
  redrawArmed();
  document.querySelector(`[data-arm="${CSS.escape(key)}"]`)?.focus();   // Tastatur: Enter ein zweites Mal führt aus
  announce(t("an_armed"));
}
function disarm(redraw = true) {
  if (!armedKey) return;
  armedKey = null;
  clearTimeout(armedTimer);
  if (redraw) redrawArmed();
}
function redrawArmed() { render(); renderFolders(); syncStopBtn(); }
document.addEventListener("click", (e) => { if (armedKey && !e.target.closest("[data-arm]")) disarm(); }, true);

// ---------------------------------------------------------------- Ordner
function setFolder(id, reload = true) {
  curFolder = id;
  try { localStorage.setItem("folder", id); } catch {}
  if (reload) refresh();
}
function renderFolders() {
  const chip = (id, name, n) => `<span class="chip fold${id === curFolder ? " on" : ""}" role="button" tabindex="0" aria-pressed="${id === curFolder}" data-f="${id}" title="${esc(name)}">${esc(name)} <b>${n}</b></span>`;
  const cur = folders.folders.find((f) => f.id === curFolder);
  const hadFocus = document.activeElement?.closest?.("#folderBar") ? document.activeElement.dataset.f : undefined;   // Tastaturfokus nach dem Neuzeichnen behalten
  $("#folderBar").innerHTML =
    chip("", t("f_all"), folders.all) +
    (folders.folders.length ? chip("none", t("f_none"), folders.none) : "") +
    folders.folders.map((f) => chip(f.id, f.name, f.count)).join("") +
    `<button type="button" class="chip add" data-fa="new" title="${t("f_new")}" aria-label="${t("f_new")}">＋</button>` +
    `<span class="fold-actions">` +
    (cur ? `<button type="button" class="sek mini" data-fa="rename">${t("f_rename")}</button>${armedKey === `folder:${cur.id}`
      ? `<button type="button" class="sek mini armed" data-fa="delete" data-arm="folder:${cur.id}" title="${esc(t("f_delete_q", cur.name))}">${t("f_delete_sure")}</button>`
      : `<button type="button" class="sek mini" data-fa="delete" data-arm="folder:${cur.id}">${t("f_delete")}</button>`}` : "") +
    `<a class="download mini" data-fa="zip" href="/api/download?folder=${encodeURIComponent(curFolder)}" title="${t("f_zip_tip")}">${cur ? t("f_zip") : t("f_zip_all")}</a></span>`;
  if (hadFocus !== undefined) $("#folderBar").querySelector(`[data-f="${CSS.escape(hadFocus)}"]`)?.focus();
}
async function moveSong(id, folderId) {
  await api(`/api/songs/${id}`, { method: "PATCH", body: JSON.stringify({ folder_id: folderId === "none" ? null : folderId }) }).catch((e) => alert(e.message));
  refresh();
}
$("#folderBar").addEventListener("click", async (e) => {
  const c = e.target.closest("[data-f]");
  if (c) return setFolder(c.dataset.f);
  const a = e.target.closest("[data-fa]")?.dataset.fa;
  const cur = folders.folders.find((f) => f.id === curFolder);
  try {
    if (a === "new") {
      const name = prompt(t("f_name_q"));
      if (name?.trim()) setFolder((await api("/api/folders", { method: "POST", body: JSON.stringify({ name }) })).id);
    } else if (a === "rename" && cur) {
      const name = prompt(t("f_name_q"), cur.name);
      if (name?.trim()) { await api(`/api/folders/${cur.id}`, { method: "PATCH", body: JSON.stringify({ name }) }); refresh(); }
    } else if (a === "delete" && cur) {
      if (armedKey !== `folder:${cur.id}`) { arm(`folder:${cur.id}`); return; }
      disarm(false);
      await api(`/api/folders/${cur.id}`, { method: "DELETE" }); setFolder("");
    } else if (a === "zip" && !songs.some((s) => s.status === "done")) { e.preventDefault(); }
  } catch (err) { alert(t("error") + ": " + err.message); }
});
// Song auf einen Ordner ziehen
// (Text in den Lyrics soll markierbar bleiben, Knöpfe sollen klicken statt ziehen)
$("#library").addEventListener("mousedown", (e) => {
  const row = e.target.closest(".song");
  if (row) row.draggable = folders.folders.length > 0 && !e.target.closest(".lyr, .t-edit, button, a");
});
$("#library").addEventListener("dragstart", (e) => {
  const row = e.target.closest?.(".song");
  if (!row) return;
  dragging = true;
  e.dataTransfer.setData("text/song", row.dataset.id);
  e.dataTransfer.effectAllowed = "move";
});
document.addEventListener("dragend", () => { dragging = false; document.querySelectorAll(".chip.drop").forEach((c) => c.classList.remove("drop")); });
const dropChip = (e) => (e.dataTransfer.types.includes("text/song") ? e.target.closest?.(".chip.fold:not([data-f=''])") : null);
$("#folderBar").addEventListener("dragover", (e) => { const c = dropChip(e); if (c) { e.preventDefault(); c.classList.add("drop"); } });
$("#folderBar").addEventListener("dragleave", (e) => e.target.closest?.(".chip")?.classList.remove("drop"));
$("#folderBar").addEventListener("drop", (e) => {
  const c = dropChip(e);
  if (!c) return;
  e.preventDefault(); dragging = false;
  moveSong(e.dataTransfer.getData("text/song"), c.dataset.f);
});
// Ordner-Knopf in der Songzeile: kleines Menü mit allen Ordnern
function moveMenu(btn, id) {
  document.querySelector(".movemenu")?.remove();
  const s = songs.find((x) => x.id === id), m = document.createElement("div");
  m.className = "movemenu";
  m.innerHTML = [["none", t("f_none")], ...folders.folders.map((f) => [f.id, f.name])]
    .map(([fid, name]) => `<button type="button" data-f="${fid}" class="${(s.folder_id || "none") === fid ? "on" : ""}">${esc(name)}</button>`).join("");
  document.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  m.addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { m.remove(); moveSong(id, b.dataset.f); } });
  setTimeout(() => document.addEventListener("click", function close(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("click", close); } }), 0);
}
window.addEventListener("scroll", () => document.querySelector(".movemenu")?.remove(), true);

async function commitRename(inp) {
  const id = inp.dataset.id;
  if (editingId !== id) return;   // per Escape schon abgebrochen
  editingId = null;
  const s = songs.find((x) => x.id === id), title = inp.value.trim();
  if (s && title !== (s.title || "")) await api(`/api/songs/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  refresh();
}
$("#library").addEventListener("focusout", (e) => { const inp = e.target.closest(".t-edit"); if (inp) commitRename(inp); });
$("#library").addEventListener("keydown", (e) => {
  const inp = e.target.closest(".t-edit");
  if (!inp) return;
  if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
  if (e.key === "Escape") { e.preventDefault(); editingId = null; render(); }
});
$("#search").addEventListener("input", () => { clearTimeout(refresh.s); refresh.s = setTimeout(refresh, 250); });
$("#onlyFav").addEventListener("click", (e) => {
  onlyFav = !onlyFav;
  e.currentTarget.setAttribute("aria-pressed", onlyFav);
  e.currentTarget.textContent = onlyFav ? "★" : "☆";
  refresh();
});

// ---------------------------------------------------------------- Player
let ws = null;
function initPlayer() {
  const css = getComputedStyle(document.documentElement);
  ws = WaveSurfer.create({
    container: "#waveform", height: 44, barWidth: 2, barGap: 1, barRadius: 2,
    waveColor: css.getPropertyValue("--border").trim() || "#2a2e38",
    progressColor: css.getPropertyValue("--accent2").trim() || "#d1a75c", cursorWidth: 0,
  });
  const upd = () => { $("#pTime").textContent = `${fmt(ws.getCurrentTime())} / ${fmt(ws.getDuration())}`; };
  ws.on("timeupdate", upd); ws.on("ready", upd);
  ws.on("play", () => { $("#playBtn").textContent = "❚❚"; render(); });
  ws.on("pause", () => { $("#playBtn").textContent = "▶"; render(); });
  ws.on("finish", () => { $("#playBtn").textContent = "▶"; render(); });
  $("#playBtn").onclick = () => ws.playPause();
  initVolume();
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.closest?.('input, textarea, select, button, [role="button"]') && currentId) { e.preventDefault(); ws.playPause(); }
  });
}
// Lautstärke: Regler klappt beim Zeigen auf den Lautsprecher aus; Klick auf den Lautsprecher = stumm
let volume = 1, muted = false;
try {
  const saved = localStorage.getItem("volume");
  if (saved !== null && isFinite(+saved)) volume = Math.min(1, Math.max(0, +saved));
  muted = localStorage.getItem("muted") === "1";
} catch {}
function applyVolume() {
  ws?.setVolume(muted ? 0 : volume);
  const v = muted ? 0 : volume;
  $("#vol").dataset.level = v === 0 ? "off" : v < 0.5 ? "low" : "high";
  $("#volRange").value = Math.round(volume * 100);
  $("#volRange").setAttribute("aria-valuetext", `${Math.round(volume * 100)} %`);
  $("#vol").style.setProperty("--v", volume);
  $("#volBtn").title = $("#volBtn").ariaLabel = t(muted ? "unmute" : "mute");
  try { localStorage.setItem("volume", String(volume)); localStorage.setItem("muted", muted ? "1" : "0"); } catch {}
}
function initVolume() {
  $("#volRange").addEventListener("input", (e) => { volume = e.target.value / 100; muted = false; applyVolume(); });
  $("#volBtn").addEventListener("click", () => { muted = !muted; if (!muted && volume === 0) volume = 0.5; applyVolume(); });
  applyVolume();
}

let playSeq = 0;   // jede Wiedergabe-Anfrage bekommt eine Nummer: nach dem Laden zählt nur die neueste
async function play(s) {
  if (!ws) initPlayer();
  if (currentId === s.id) return ws.playPause();
  const seq = ++playSeq;
  if (ws.isPlaying()) ws.pause();   // der bisherige Song verstummt sofort, nicht erst nach dem Laden des neuen
  if (!played.has(s.id)) { markPlayed(s.id); render(); }
  currentId = s.id;
  $("#player").hidden = false;
  if (!play.ro) {   // Höhe des Players ändert sich, sobald die Wellenform geladen ist
    play.ro = new ResizeObserver(() => document.documentElement.style.setProperty("--player-h", $("#player").offsetHeight + "px"));
    play.ro.observe($("#player"));
  }
  $("#pTitle").textContent = s.title || s.caption;
  $("#pTitle").title = `Seed ${s.seed}` + (s.result_meta?.keyscale ? ` · ${s.result_meta.keyscale}` : "");
  try { await ws.load(s.url); } catch (err) { if (seq === playSeq) throw err; return; }   // abgebrochen, weil inzwischen ein anderer Song gewählt wurde
  if (seq !== playSeq) return;
  ws.play();
  render();
}

// ---------------------------------------------------------------- Einstellungen & Status
async function checkHealth() {
  const el = $("#status");
  try {
    const h = await api("/api/health");
    el.className = "box small " + (h.ok ? "" : "err");
    el.textContent = h.ok ? "" : t("offline");   // bei "alles ok" nichts anzeigen
    el.title = h.error || (h.props ? `${t("models")}: ${Object.values(h.props.models || {}).flat().join(", ")}` : t("model_server"));
    return h;
  } catch { el.className = "box small err"; el.textContent = t("backend_offline"); }
}
const dlg = $("#settingsDlg"), sf = $("#settingsForm");
$("#btnSettings").onclick = async () => {
  const s = await api("/api/settings");
  for (const k of ["server_url", "lm_url", "timeout_minutes", "songs_dir", "dit", "lyrics_model", "highs", "lm_device", "export_format"]) sf[k].value = s[k];
  sf.export_format.querySelector('option[value="mp3"]').disabled = !s.mp3_available;   // MP3 nur, wenn der Wandler der Engine da ist
  $("#expHint").hidden = s.mp3_available;
  sf.dit.querySelector('option[value="xl"]').disabled = !s.dit_xl_available;   // XL nur wählbar, wenn die Datei da ist
  sf.dit.querySelector('option[value="xl_bf16"]').disabled = !s.dit_xl_bf16_available;
  $("#ditHint").hidden = s.dit_xl_available;
  sf.songs_dir.placeholder = s.songs_dir_default;   // Standard als Platzhalter, leer lassen = Standard
  $("#verInfo").textContent = t("upd_installed", s.version || "?");
  if (s.repo_url) $("#repoLink").href = s.repo_url;
  dlg.showModal();
};
const saveSettings = () => api("/api/settings", { method: "PUT", body: JSON.stringify({
  server_url: sf.server_url.value.trim(), lm_url: sf.lm_url.value.trim(), timeout_minutes: Number(sf.timeout_minutes.value) || 30,
  songs_dir: sf.songs_dir.value.trim(), dit: sf.dit.value, lyrics_model: sf.lyrics_model.value.trim(), highs: sf.highs.value, lm_device: sf.lm_device.value, export_format: sf.export_format.value }) }).catch((err) => { alert(err.message); $("#btnSettings").click(); });
// Anordnung: untereinander oder Generator links / Bibliothek rechts
function setLayout(l) {
  document.querySelector(".wrap").classList.toggle("side", l === "side");
  document.documentElement.classList.toggle("side", l === "side");
  document.querySelectorAll("[data-layout]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.layout === l)));
  try { localStorage.setItem("layout", l); } catch {}
}
document.querySelectorAll("[data-layout]").forEach(b => b.onclick = () => setLayout(b.dataset.layout));
try { setLayout(localStorage.getItem("layout") === "side" ? "side" : "stack"); } catch { setLayout("stack"); }

// Updates von GitHub
const updInfo = $("#updInfo"), updList = $("#updList"), updApply = $("#updApply");
async function updCheck() {
  updApply.hidden = true; updList.hidden = true; updInfo.className = "small"; updInfo.textContent = t("upd_search");
  const r = await api("/api/update/check").catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { updInfo.className = "small err-t"; updInfo.textContent = r.error; return; }
  if (!r.behind) { updInfo.textContent = t("upd_current", r.current); return; }
  updInfo.textContent = t("upd_new", r.behind, r.current, r.latest);
  updList.replaceChildren(...r.changes.map(c => Object.assign(document.createElement("li"), { textContent: c })));
  if (r.url) updList.append(Object.assign(document.createElement("li"), { className: "upd-link", innerHTML: `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || r.latest)} ↗</a>` }));
  updList.hidden = false;
  if (r.dirty) { updInfo.className = "small err-t"; updInfo.textContent += t("upd_dirty"); return; }
  if (r.needs_install) updInfo.textContent += t("upd_install");
  updApply.hidden = false;
}
$("#updCheck").onclick = updCheck;
updApply.onclick = async () => {
  updApply.disabled = true; updInfo.className = "small"; updInfo.textContent = t("upd_loading");
  let res;
  try {
    res = await api("/api/update/apply", { method: "POST" });
  } catch (e) { updInfo.className = "small err-t"; updInfo.textContent = e.message; updApply.disabled = false; return; }
  updInfo.textContent = t("upd_restart");
  for (let i = 0; i < 60; i++) {   // warten, bis der neue Server antwortet
    await new Promise(r => setTimeout(r, 1000));
    try { const h = await fetch("/api/queue", { cache: "no-store" }); if (h.ok && i > 1) { if (res.needs_install) { updInfo.textContent = t("upd_restart_install"); return; } return location.reload(); } } catch {}
  }
  updInfo.className = "small err-t"; updInfo.textContent = t("upd_slow");
};
$("#btnSettings").addEventListener("click", () => { updInfo.textContent = ""; updList.hidden = true; updApply.hidden = true; updApply.disabled = false; });

// Server stoppen = „Music Generator OFF“ ausführen
let stopTip = "";
function syncStopBtn() {
  const b = $("#stopBtn"), on = armedKey === "stop";
  b.classList.toggle("armed", on);
  b.textContent = t(on ? "stop_sure" : "stop");
  b.title = on ? stopTip : "";
}
$("#stopBtn").dataset.arm = "stop";
$("#stopBtn").onclick = async () => {
  if (armedKey !== "stop") {
    const qu = await api("/api/queue").catch(() => null);
    stopTip = t(qu && (qu.running.length || qu.queued) ? "stop_q_busy" : "stop_q");
    arm("stop");
    return;
  }
  disarm();
  clearTimeout(refresh.t);
  try {
    await api("/api/shutdown", { method: "POST" });
    $("#stopBtn").disabled = true;
    $("#stopInfo").textContent = t("stopped");
  } catch (e) { $("#stopInfo").className = "small err-t"; $("#stopInfo").textContent = e.message; refresh(); }
};

const loadExportFmt = () => api("/api/settings").then((s) => { exportFmt = s.export_format === "mp3" ? "mp3" : "wav"; }).catch(() => {});
dlg.addEventListener("close", async () => { if (dlg.returnValue === "save") { await saveSettings(); await loadExportFmt(); render(); checkHealth(); } });

// Sprachumschalter (DE | EN)
$("#uiLang").addEventListener("change", (e) => setLang(e.target.value));
document.addEventListener("langchange", () => {
  showDur(); syncLyrics(); setVoice(voice); render(); renderFolders(); showLibStats(); checkHealth();
  updInfo.textContent = ""; updList.hidden = true; updApply.hidden = true;
});

checkHealth();
setInterval(checkHealth, 15000);
loadExportFmt().then(() => render());
refresh();
