"""Songtexter: schreibt mit einem lokalen Ollama-Modell Songtexte fürs Lyrics-Feld.

Zwei Betriebsarten: „Normal“ (jugendfrei, radiotauglich, jedes installierte Modell) und „Ohne Filter“ (unzensierte Modelle,
derbe Sprache mit wählbarem Härtegrad). Welches Modell voreingestellt ist, entscheidet der Installer nach Grafikspeicher
(TEXTER_MODEL und LYRICS_MODEL in data/engine.conf).

Das Modell teilt sich die GPU mit ACE-Step und belegt sie nur, solange es gebraucht wird:
- Songtexter oder Seite zu: die Verbindung zu /presence reißt ab, das Modell wird entladen.
- Song oder Analyse startet: release() räumt den Grafikspeicher vorher frei, das Schloss gpu verhindert, dass beides zugleich läuft.
- KEEP_ALIVE ist die Notbremse, falls die App hart beendet wird: Dann entlädt Ollama von selbst.
"""
import asyncio
import json
import logging
import re
import signal
import threading
from pathlib import Path

import httpx
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import db
from .engines import OLLAMA_URL, VRAM_SETTLED, EngineError, _vram_used

log = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api/texter")

_CONF = db.engine_conf()
DEFAULT_MODEL = _CONF.get("TEXTER_MODEL") or "orcarouter/Qwen3.8-27B-Uncensored:q3_k_m"   # Ohne Filter
CLEAN_MODEL = _CONF.get("LYRICS_MODEL") or "gemma4:26b"                                   # Normal
UNCENSORED = re.compile(r"abliterat|uncensored|heretic|dolphin|decensored", re.IGNORECASE)
NOT_A_WRITER = re.compile(r"embed|bge|rerank|whisper|minilm|e5-|nomic", re.IGNORECASE)             # keine Sprachmodelle: schreiben keinen Text
BROKEN = {"huihui_ai/gemma-4-abliterated:26b"}   # zerfällt auf Deutsch zu Wortmüll ("imgetupft"), das normale gemma4:26b nicht (getestet Nov. 2026)
TONES = ("clean", "explicit")
KEEP_ALIVE = "10m"
NUM_CTX = 8192        # fest: Ollama lädt das Modell neu, sobald sich der Wert ändert
NUM_PREDICT = 3000    # Bremse für Modelle, die sich in Wiederholungen verlieren
GRACE_SECONDS = 5     # überbrückt das Neuladen der Seite
STATUS_SECONDS = 3

CATALOG = json.loads((Path(__file__).parent / "songtexter.json").read_text(encoding="utf-8"))
LANGUAGES = {"de": "Deutsch", "en": "Englisch", "fr": "Französisch", "es": "Spanisch", "it": "Italienisch",
             "pt": "Portugiesisch", "ja": "Japanisch", "ko": "Koreanisch", "zh": "Chinesisch", "ru": "Russisch"}

gpu = asyncio.Lock()          # Texter und Song teilen sich die GPU, nie beide zugleich (sonst stürzt der Desktop ab, siehe engines.py)
_loaded: set[str] = set()     # Modelle, die der Texter geladen hat
_vram_base: int | None = None  # belegter Grafikspeicher, bevor der Texter geladen hat
_clients = 0                  # offene /presence-Verbindungen
_release_task: asyncio.Task | None = None
_stopping = False


# ---------------------------------------------------------------- Grafikspeicher

async def release() -> None:
    """Modelle des Texters entladen und warten, bis der Grafikspeicher wirklich frei ist.
    Bleibt ein Modell hängen, gibt es einen Fehler: Der Song dahinter würde den Grafikspeicher sonst überfüllen."""
    global _vram_base
    async with httpx.AsyncClient(timeout=30) as c:
        async def still_loaded() -> list[str]:
            ps = (await c.get(f"{OLLAMA_URL}/api/ps")).json().get("models") or []
            return [m["name"] for m in ps if m["name"] in _loaded or UNCENSORED.search(m["name"])]   # auch Reste, falls die App hart beendet wurde
        try:
            models = await still_loaded()
            for _ in range(240):      # lädt Ollama gerade noch, gilt das Entladen erst danach: also dranbleiben
                if not models:
                    break
                for model in models:
                    await c.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "keep_alive": 0})
                await asyncio.sleep(0.5)
                models = await still_loaded()
        except (httpx.HTTPError, ValueError) as e:
            log.warning("Texter: Ollama nicht erreichbar beim Entladen: %r", e)   # dann belegt es auch nichts
            models = []
    if models:
        raise EngineError(f"Texter-Modell {models[0]} lässt sich nicht entladen. Läuft es noch in einem anderen Programm?")
    if _loaded:
        # /api/ps ist schon leer, solange der Grafikspeicher noch belegt ist (siehe write_lyrics in engines.py)
        for _ in range(120):
            if _vram_base is None or (_vram_used() or 0) < _vram_base + VRAM_SETTLED:
                break
            await asyncio.sleep(0.25)
    _loaded.clear()
    _vram_base = None


async def shutdown() -> None:
    try:
        await release()
    except EngineError as e:
        log.warning("Texter: %s", e)


async def _release_when_alone() -> None:
    await asyncio.sleep(GRACE_SECONDS)
    if _clients or not _loaded:
        return
    async with gpu:
        if not _clients:
            await shutdown()


def watch_shutdown(on_signal=None) -> None:
    """Uvicorn beendet sich erst, wenn alle Antworten fertig sind. Die offene /presence-Verbindung muss also beim Beenden selbst zugehen."""
    if threading.current_thread() is not threading.main_thread():
        return

    def wrap(previous):
        def handler(sig, frame):
            global _stopping
            _stopping = True
            if on_signal:
                on_signal()
            if callable(previous):
                previous(sig, frame)
        return handler
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, wrap(signal.getsignal(sig)))


# ---------------------------------------------------------------- Prompts

# Steht im System-Prompt und noch einmal direkt im Auftrag: Nur im System-Prompt schreiben die Modelle zu brav (getestet Nov. 2026).
ATTITUDE = {
    1: "Radiotauglich. Keine Schimpfwörter und keine expliziten Inhalte, Schärfe entsteht nur durch Witz und Andeutung.",
    2: "Direkt. Klartext ohne Beschönigung, einzelne Flüche sind erwünscht. Tabus werden benannt, aber nicht ausgemalt.",
    3: "Explizit. Flüche, derbe und vulgäre Wörter sind ausdrücklich erwünscht. Sex, Drogen und Gewalt werden offen ausgesprochen. Keine Sternchen, keine Umschreibungen.",
    4: "Komplett ohne Filter, du nimmst kein Blatt vor den Mund. Flüche, derbe Beleidigungen und vulgäre Wörter sind ausdrücklich erwünscht und gehören in jeden Abschnitt. "
       "Sexuelles zwischen Erwachsenen wird mit den direkten, vulgären Wörtern benannt, nie umschrieben. Kein Thema wird umschifft, keine Zeile entschärft, kein Wort mit Sternchen zensiert. "
       "Keine Moral, keine Läuterung am Ende, keine Warnhinweise. Klingt eine Zeile brav, schreib sie härter.",
}

# Betriebsart „Normal“: ein Härtegrad, dafür mehr Handwerk. Steht wie ATTITUDE im System-Prompt und im Auftrag.
CLEAN = ("Jugendfrei und radiotauglich: keine Schimpfwörter, keine expliziten Inhalte, keine Verherrlichung von Gewalt oder Drogen. "
         "Die Kraft kommt aus dem Handwerk: echte Gefühle, konkrete Szenen, ein Refrain, der nach einmal Hören sitzt, "
         "und Zeilen, die ein Sänger wirklich tragen kann.")

SYSTEM = """Du bist Profi-Songwriter und Ghostwriter für alle Genres. Du lieferst fertige Songtexte, die genau so gesungen oder gerappt werden: keine Gedichte, keine Erklärungen.

Handwerk:
- Konkrete Bilder, Szenen und Details statt Floskeln: zeigen, nicht behaupten.
- Die Zeilenenden reimen sich paarweise oder über Kreuz, außer es ist anders verlangt. Reime müssen beim lauten Sprechen wirklich klingen. Verbiege nie die Satzstellung für einen Reim und erfinde keine Wörter.
- Natürliches {language}, wie Muttersprachler es sprechen. Der gesamte Songtext ist auf {language}, nur die Abschnittsmarken bleiben englisch.
- Die Zeilen eines Abschnitts haben ähnlichen Rhythmus und ähnliche Silbenzahl. Jede Zeile ist eine ganze Phrase, nie nur ein einzelnes Wort.
- Jede Strophe bringt etwas Neues und wiederholt keine ihrer Zeilen. Refrain und Hook bleiben bei jeder Wiederholung Wort für Wort gleich und werden jedes Mal vollständig ausgeschrieben.
- Keine abgedroschenen Reime wie Herz/Schmerz, Nacht/Macht, Licht/Gesicht.
- Alles zwischen den Abschnittsmarken wird von einem KI-Sänger gesungen. Deshalb keine Regieanweisungen, keine Beschreibung von Instrumenten, kein „(Beat setzt ein)“ und kein „(geflüstert)“. Runde Klammern nur für Worte, die wirklich gesungen oder gerufen werden, eckige Klammern nur für die Abschnittsmarken.

Haltung: {attitude}

Absolute Grenze: keine sexuellen Inhalte mit Minderjährigen.

Antworte exakt in diesem Format und ohne jeden Kommentar davor oder danach:
Titel: <Songtitel>
Stil: <6-10 kommagetrennte englische Stil-Tags für einen KI-Musikgenerator: Genre, Stimme, Instrumente, Stimmung, Tempo>

[Abschnittsmarke]
<Text>"""


class WriteRequest(BaseModel):
    mode: str = "new"              # new = neuer Song, revise = ganzen Text überarbeiten, section = nur einen Abschnitt neu
    tone: str = "clean"            # clean = Normal (jugendfrei), explicit = Ohne Filter (unzensiert, Härtegrad)
    model: str = ""
    theme: str = ""
    family: str = ""
    genre: str = ""
    custom_genre: str = ""
    language: str = "de"
    moods: list[str] = []
    heat: int = Field(4, ge=1, le=4)
    structure: list[str] = []
    perspective: str = ""
    rhyme: str = ""
    title: str = ""
    extra: str = ""
    creativity: float = Field(0.8, ge=0, le=2)
    lyrics: str = ""               # revise und section: der aktuelle Text
    style: str = ""
    wish: str = ""
    section: str = ""


def _section_guide(names: list[str]) -> list[str]:
    """Pro Abschnittstyp eine Zeile: was dort hingehört. Fürs Modell bleibt "Verse 2" ein "Verse"."""
    lines = []
    for name in dict.fromkeys(re.sub(r"\s+\d+$", "", n) for n in names):
        if name in CATALOG["sections"]:
            lines.append(f"- [{name}]: {CATALOG['sections'][name]}")
    return lines


def _genre_lines(req: WriteRequest) -> list[str]:
    family = next((f for f in CATALOG["families"] if f["name"] == req.family), None)
    genre = next((g for g in family["genres"] if g["name"] == req.genre), None) if family else None
    if req.custom_genre.strip():
        return [f"Genre: {req.custom_genre.strip()}. Triff Sprache, Bilder und Form dieses Genres genau."]
    if not genre:
        return []
    return [f"Genre: {genre['name']} ({family['name']})", f"So klingt das Genre im Text: {family['guide']} {genre['guide']}"]


def _song(req: WriteRequest) -> str:
    return f"Titel: {req.title}\nStil: {req.style}\n\n{req.lyrics.strip()}"


def build_messages(req: WriteRequest) -> list[dict]:
    language = LANGUAGES.get(req.language, LANGUAGES["de"])
    attitude = CLEAN if req.tone != "explicit" else ATTITUDE[req.heat]
    system = SYSTEM.format(language=language, attitude=attitude)
    if req.mode == "section":
        wish = f" Wunsch: {req.wish.strip()}" if req.wish.strip() else ""
        user = (f"Hier ist der aktuelle Song:\n\n{_song(req)}\n\nSchreibe nur den Abschnitt [{req.section}] neu.{wish} "
                f"Er muss stärker sein als vorher und mit Thema, Reimen und Rhythmus zum Rest passen. Härtegrad: {attitude} "
                f"Antworte nur mit den neuen Zeilen dieses Abschnitts, ohne Abschnittsmarke, ohne Titel und ohne Kommentar.")
    elif req.mode == "revise":
        user = (f"Hier ist der aktuelle Song:\n\n{_song(req)}\n\nÜberarbeite ihn. Wunsch: {req.wish.strip()}\n"
                f"Härtegrad: {attitude}\nBehalte alles, was der Wunsch nicht berührt. Gib den vollständigen Song im vorgegebenen Format aus.")
    else:
        lines = ["Schreibe einen neuen Song.", f"Thema: {req.theme.strip()}", *_genre_lines(req), f"Sprache: {language}"]
        if req.moods:
            lines.append(f"Stimmung: {', '.join(req.moods)}")
        if req.perspective:
            lines.append(f"Perspektive: {req.perspective}")
        if req.rhyme:
            lines.append(f"Reimschema: {req.rhyme}")
        if req.title.strip():
            lines.append(f"Titel: {req.title.strip()} (genau so verwenden)")
        if req.extra.strip():
            lines.append(f"Zusatzwünsche: {req.extra.strip()}")
        lines.append(f"Härtegrad: {attitude}")
        if req.structure:
            lines += ["", "Aufbau, genau diese Abschnittsmarken in genau dieser Reihenfolge:", " ".join(f"[{s}]" for s in req.structure),
                      "", "Was in die Abschnitte gehört:", *_section_guide(req.structure)]
        user = "\n".join(lines)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- API

class _Stream(StreamingResponse):
    """Räumt den Generator sofort ab, wenn der Browser die Verbindung trennt. Stünde er dabei an einem yield, liefe sein
    Aufräumen (GPU-Schloss, Anfrage an Ollama) sonst erst, wenn ihn die Speicherbereinigung findet."""
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.body_iterator.aclose()


def _line(**data) -> str:
    return json.dumps(data, ensure_ascii=False) + "\n"


async def _write_stream(model: str, messages: list[dict], temperature: float):
    """Liefert das Ergebnis Zeile für Zeile als JSON. Bricht der Browser ab, endet auch die Anfrage an Ollama, und Ollama hört auf zu rechnen."""
    global _vram_base
    if gpu.locked():
        yield _line(status="wait")   # ein Song rechnet gerade: danach ist der Texter dran
    async with gpu:
        if _loaded - {model}:
            await release()          # Modellwechsel: nicht zwei Modelle in den Grafikspeicher
        if not _loaded:
            _vram_base = _vram_used()
        _loaded.add(model)
        yield _line(status="start")
        body = {"model": model, "messages": messages, "stream": True, "think": False, "keep_alive": KEEP_ALIVE,
                "options": {"num_ctx": NUM_CTX, "num_predict": NUM_PREDICT, "temperature": temperature, "repeat_penalty": 1.0}}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=5)) as c:
                async with c.stream("POST", f"{OLLAMA_URL}/api/chat", json=body) as r:
                    if r.status_code != 200:
                        detail = (await r.aread()).decode("utf-8", "replace")[:300]
                        log.warning("Texter: Ollama antwortet %s: %s", r.status_code, detail)
                        yield _line(error="model", detail=detail)
                        return
                    async for raw in r.aiter_lines():
                        if _stopping:
                            return
                        if not raw.strip():
                            continue
                        chunk = json.loads(raw)
                        if chunk.get("error"):
                            yield _line(error="model", detail=str(chunk["error"])[:300])
                            return
                        text = (chunk.get("message") or {}).get("content")
                        if text:
                            yield _line(text=text)
                        if chunk.get("done"):
                            yield _line(done=True, reason=chunk.get("done_reason"), tokens=chunk.get("eval_count"),
                                        seconds=round(chunk.get("eval_duration", 0) / 1e9, 1))
        except httpx.ConnectError:
            yield _line(error="ollama")
        except httpx.HTTPError as e:
            log.warning("Texter: Verbindung zu Ollama abgebrochen: %r", e)
            yield _line(error="model", detail=e.__class__.__name__)


@router.post("/write")
async def write(req: WriteRequest, x_lang: str = Header()):   # Pflicht-Header wie bei /api/shutdown: fremde Webseiten können ihn nicht mitschicken
    if req.mode == "new" and not req.theme.strip():
        raise HTTPException(422, "theme")
    if req.tone not in TONES:
        req.tone = "clean"
    model = req.model or (CLEAN_MODEL if req.tone == "clean" else DEFAULT_MODEL)
    return _Stream(_write_stream(model, build_messages(req), req.creativity),
                   media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.post("/unload")
async def unload(x_lang: str = Header()):
    if _loaded:
        async with gpu:
            try:
                await release()
            except EngineError as e:
                raise HTTPException(500, str(e)) from e
    return {"ok": True}


def _is_writer(m: dict) -> bool:
    """Ein Sprachmodell, das Text schreibt: keine Einbettungs- oder Cloud-Modelle, keine bekannt kaputten."""
    name = m["name"]
    family = str((m.get("details") or {}).get("family") or "")
    return (name not in BROKEN and not name.endswith("cloud") and not NOT_A_WRITER.search(name)
            and family not in ("bert", "nomic-bert"))


@router.get("/config")
async def config():
    """Genre-Katalog und die installierten Modelle: „models“ (unzensiert, für Ohne Filter) und „models_clean“ (alle, für Normal),
    jeweils das voreingestellte Modell zuerst."""
    models, clean, ollama = [], [], True
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            for m in (await c.get(f"{OLLAMA_URL}/api/tags")).json().get("models") or []:
                if not _is_writer(m):
                    continue
                entry = {"name": m["name"], "gb": round(m.get("size", 0) / 1e9, 1), "uncensored": bool(UNCENSORED.search(m["name"]))}
                clean.append(entry)
                if entry["uncensored"]:
                    models.append(entry)
    except (httpx.HTTPError, ValueError):
        ollama = False
    models.sort(key=lambda m: (m["name"] != DEFAULT_MODEL, m["name"].lower()))
    # Normal: das voreingestellte Modell zuerst, dann die übrigen „normalen“, unzensierte zuletzt
    clean.sort(key=lambda m: (m["name"] != CLEAN_MODEL, m["uncensored"], m["name"].lower()))
    return {**CATALOG, "models": models, "models_clean": clean, "ollama": ollama,
            "defaults": {"explicit": DEFAULT_MODEL, "clean": CLEAN_MODEL}}


async def _status() -> dict:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            models = (await c.get(f"{OLLAMA_URL}/api/ps")).json().get("models") or []
    except (httpx.HTTPError, ValueError):
        return {"ollama": False, "loaded": []}
    return {"ollama": True, "loaded": [{"name": m["name"], "gb": round(m.get("size_vram", 0) / 1e9, 1)} for m in models if m["name"] in _loaded or UNCENSORED.search(m["name"])]}


async def _presence_stream():
    global _clients, _release_task
    _clients += 1
    try:
        while not _stopping:
            yield f"data: {json.dumps(await _status())}\n\n"
            for _ in range(STATUS_SECONDS):
                if _stopping:
                    return
                await asyncio.sleep(1)
    finally:
        _clients -= 1
        if not _clients and not _stopping:
            _release_task = asyncio.create_task(_release_when_alone())


@router.get("/presence")
async def presence():
    """Bleibt offen, solange der Songtexter im Browser offen ist, und meldet nebenbei den Stand des Modells."""
    return _Stream(_presence_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
