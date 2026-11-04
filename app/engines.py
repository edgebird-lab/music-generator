"""Anbindung an Modell-Server.

acestep.cpp (ace-server) arbeitet asynchron:
  POST /lm    -> {"id": ...}   LM ergänzt Metadaten, Lyrics und audio_codes
  POST /synth -> {"id": ...}   DiT + VAE rendern Audio
  GET  /job?id=X            -> {"status": ...}
  GET  /job?id=X&result=1   -> Ergebnis (/lm: JSON-Array, /synth: multipart/mixed)
"""
import asyncio
import email
import email.policy
import glob
import json
import logging
import re
import time
from pathlib import Path
from typing import Awaitable, Callable

import httpx

Progress = Callable[[str], Awaitable[None]]
log = logging.getLogger(__name__)


def _fmt_time(seconds: int) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"



async def _get_retry(c: httpx.AsyncClient, base: str, params: dict, tries: int = 4) -> httpx.Response:
    """GET /job mit Wiederholung: bricht die Verbindung zum Modellserver kurz ab (z. B. beim Abholen des fertigen
    Songs), ist das Ergebnis dort weiter abrufbar. Beim Retry mit frischer Verbindung statt gleich als Fehler zu melden."""
    last: Exception | None = None
    for i in range(tries):
        try:
            if i == 0:
                return await c.get(f"{base}/job", params=params)
            async with httpx.AsyncClient(timeout=120) as fresh:
                return await fresh.get(f"{base}/job", params=params)
        except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.WriteError) as e:
            last = e
            await asyncio.sleep(1.5 * (i + 1))
    raise EngineError(f"Verbindung zum Modellserver abgebrochen ({last.__class__.__name__}) – bitte erneut versuchen")


class EngineError(Exception):
    pass


# Felder, die wir an ace-server durchreichen (Rest bleibt auf Server-Defaults)
ACE_FIELDS = {
    "caption", "lyrics", "bpm", "duration", "keyscale", "timesignature",
    "vocal_language", "seed", "lm_temperature", "lm_cfg_scale", "inference_steps",
    "guidance_scale", "output_format", "lm_model", "synth_model", "use_cot_caption",
}


# DiT-Modell: SFT (50 Schritte, klingt deutlich besser als turbo). Standard mit 2 Mrd. Parametern, optional XL mit 4 Mrd.
DIT_MODELS = {"standard": "acestep-v15-sft-Q8_0.gguf", "xl": "acestep-v15-xl-sft-Q8_0.gguf", "xl_bf16": "acestep-v15-xl-sft-BF16.gguf"}

OLLAMA_URL = "http://127.0.0.1:11434"
_lyrics_task: asyncio.Task | None = None
VRAM_SETTLED = 2**30   # so viel über dem Stand vor dem Texter gilt der Grafikspeicher wieder als frei
LYRICS_PROMPT = """You are an experienced songwriter. Write complete, original song lyrics in {language} for this song idea:
"{idea}"
Length: about {seconds} seconds of music. Use these section tags, each on its own line: {sections}
Rules: concrete images instead of cliches, a memorable chorus that comes back with the same words, verses that tell a story and do not repeat each other, natural rhythm and rhyme, singable lines of 6-10 syllables. Output only the lyrics with their section tags, no explanation, no stage directions."""


def _vram_used() -> int | None:
    """Belegter Grafikspeicher in Bytes (Linux, AMD); None, wenn sich das nicht lesen lässt."""
    for path in glob.glob("/sys/class/drm/card*/device/mem_info_vram_used"):
        try:
            return int(Path(path).read_text())
        except (OSError, ValueError):
            pass
    return None


def _lyrics_sections(seconds: float) -> str:
    if seconds < 60:
        return "[Verse] [Chorus]"
    if seconds < 240:
        return "[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Pre-Chorus] [Chorus] [Bridge] [Chorus] [Outro]"
    return "[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Pre-Chorus] [Chorus] [Instrumental Break] [Verse 3] [Bridge] [Chorus] [Verse 4] [Chorus] [Outro]"


def _clean_lyrics(text: str) -> str:
    """Nur Text und Abschnittsmarken behalten: Regieanweisungen in Klammern würden sonst mitgesungen."""
    lines = [l.rstrip() for l in text.strip().splitlines() if not l.strip().startswith("```")]
    return "\n".join(l for l in lines if not re.fullmatch(r"\s*\(.*\)\s*", l)).strip()


async def write_lyrics(model: str, idea: str, language: str, seconds: float) -> str:
    """Lokales Ollama-Modell schreibt den Songtext und wird danach entladen, damit ACE-Step den Grafikspeicher frei hat."""
    seconds = seconds or 180
    prompt = LYRICS_PROMPT.format(language=language or "the language of the song idea", idea=idea, seconds=int(seconds), sections=_lyrics_sections(seconds))
    vram_before = _vram_used()
    async with httpx.AsyncClient(timeout=300) as c:
        r = await c.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "prompt": prompt, "stream": False, "think": False, "keep_alive": 0,
                                                             "options": {"temperature": 0.8, "num_predict": 2500}})
        r.raise_for_status()
        text = _clean_lyrics(r.json().get("response", ""))
        for _ in range(60):
            ps = (await c.get(f"{OLLAMA_URL}/api/ps")).json().get("models") or []
            if not any(m.get("name") == model or m.get("model") == model for m in ps):
                break
            await asyncio.sleep(0.5)
    # /api/ps ist schon leer, solange der Grafikspeicher noch belegt ist (gemessen 19 GiB für 0,2 s)
    for _ in range(120):
        if vram_before is None or (_vram_used() or 0) < vram_before + VRAM_SETTLED:
            break
        await asyncio.sleep(0.25)
    return "" if _missing_vocals(text) else text


class AceStepCpp:
    name = "acestep_cpp"

    def __init__(self, base_url: str, lm_url: str = "", poll_interval: float = 1.5, timeout_minutes: float = 30,
                 lm_model: str = "", dit: str = "standard", lyrics_model: str = ""):
        self.dit_model = DIT_MODELS.get(dit, DIT_MODELS["standard"])
        self.lyrics_model = lyrics_model
        self.base = base_url.rstrip("/")
        # Auf Apple M4 liefert das LM unter Metal Unsinn (0 Codes) -> eigener CPU-Server
        self.lm_base = (lm_url or base_url).rstrip("/")
        self.poll = poll_interval
        self.timeout = timeout_minutes * 60
        # Liegen mehrere Sprachmodelle im Ordner, nähme der Server sonst das erste (alphabetisch)
        self.lm_model = lm_model
        self._job: tuple[str, str] | None = None   # (Server, Job-ID) des gerade laufenden Auftrags
        self._mark: dict | None = None             # Log-Größen zu Beginn der Synthese (für die Fehlerursache)

    async def cancel(self) -> None:
        """Laufenden Auftrag beim Modellserver abbrechen, damit er nicht weiterrechnet."""
        if not self._job:
            return
        base, job_id = self._job
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                await c.post(f"{base}/job", params={"id": job_id, "cancel": 1})
        except httpx.HTTPError:
            pass

    async def health(self) -> dict:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{self.base}/health")
            r.raise_for_status()
            if self.lm_base != self.base:
                try:
                    (await c.get(f"{self.lm_base}/health")).raise_for_status()
                except Exception as e:
                    raise EngineError(f"LM-Server {self.lm_base} nicht erreichbar") from e
            info = {"ok": True, "health": r.json()}
            try:
                p = await c.get(f"{self.base}/props")
                if p.status_code == 200:
                    info["props"] = p.json()
            except Exception:
                pass
            return info

    async def _wait(self, c: httpx.AsyncClient, base: str, job_id: str, label: str, start: float, progress: Progress) -> httpx.Response:
        self._job = (base, job_id)
        # start = Zeitpunkt des Gesamtauftrags (nicht dieser Phase) -> die Anzeige zählt einfach durch
        while True:
            r = await _get_retry(c, base, {"id": job_id})
            r.raise_for_status()
            status = str(r.json().get("status", "")).lower()
            if status == "done":
                res = await _get_retry(c, base, {"id": job_id, "result": 1})
                res.raise_for_status()
                return res
            if any(w in status for w in ("err", "fail", "cancel")):
                hint = _memory_hint(self._mark) if label == "Synthese" else ""
                raise EngineError(hint or f"{label} fehlgeschlagen: {r.text}")
            elapsed = int(time.monotonic() - start)
            if elapsed > self.timeout:
                await self.cancel()   # Modellserver nicht am alten Auftrag weiterrechnen lassen
                mins = max(1, round(elapsed / 60))
                de, en = ("Minute", "minute") if mins == 1 else ("Minuten", "minutes")
                raise EngineError(f"{label}: Zeitüberschreitung nach {mins} {de}. In den Einstellungen (Zahnrad) die Timeout-Zeit erhöhen, "
                                  f"besonders bei langen Songs. / Timeout after {mins} {en}. Raise the timeout in the settings (gear), "
                                  f"especially for long songs.")
            await progress(_fmt_time(elapsed))
            await asyncio.sleep(self.poll)

    async def generate(self, params: dict, progress: Progress, voice: bytes | None = None) -> tuple[bytes, str, dict]:
        """voice: WAV-Ausschnitt eines früheren Songs (klang.stimm_referenz), gibt die Klangfarbe vor."""
        req = {k: v for k, v in params.items() if k in ACE_FIELDS and v not in (None, "")}
        req.setdefault("use_cot_caption", False)  # Prompt wörtlich übernehmen
        req["output_format"] = "wav16"            # 48 kHz / 16 Bit, verlustfrei
        # ace-server normalisiert sonst auf das 99,999. Perzentil (peak_clip=10) und schneidet alles darüber hart ab (Knacken in lauten
        # Stellen). Mit 0 wird auf die echte Spitze normalisiert, nichts wird abgeschnitten. Hinweis aus der Community (JUKA0920).
        req["peak_clip"] = 0
        req["synth_model"] = self.dit_model
        if self.lm_model:
            req["lm_model"] = self.lm_model
        # Leeres Textfeld mit Gesang: Das Sprachmodell erfindet die Lyrics selbst. Dann braucht es den ausgeschriebenen Sprachnamen
        # ("de" versteht es nicht, heraus kommt z. B. Türkisch) und höchstens die Modell-Vorgabe 0.85 als Temperatur, sonst zerfallen
        # die Texte in Zeichen aus fremden Sprachen. Messreihen von vollhonk26 in music-generator-desktop#54.
        code = req.get("vocal_language", "")
        invent = not str(params.get("lyrics") or "").strip()
        start = time.monotonic()   # zählt über alle Phasen (Texter, Sprachmodell, Synthese) durch
        global _lyrics_task
        # Ein abgebrochener Song lässt den Texter weiterlaufen, bis Ollama ihn entladen hat. Beide zugleich überfüllen den
        # Grafikspeicher, dann verliert die GPU den Kontext und der Desktop stürzt mit ab.
        while _lyrics_task and not _lyrics_task.done():
            await progress(_fmt_time(int(time.monotonic() - start)))
            await asyncio.wait({_lyrics_task}, timeout=self.poll)
        if invent and self.lyrics_model:
            # Fehlt Ollama oder das Modell, erfindet wie bisher das ACE-Step-Sprachmodell den Text
            task = _lyrics_task = asyncio.create_task(write_lyrics(self.lyrics_model, req.get("caption", ""), LANGUAGE_NAMES.get(code, ""), float(params.get("duration") or 0)))
            task.add_done_callback(lambda t: t.cancelled() or t.exception())
            while not task.done():
                await progress(_fmt_time(int(time.monotonic() - start)))
                await asyncio.wait({task}, timeout=self.poll)
            try:
                lyrics = task.result()
            except (httpx.HTTPError, ValueError) as e:
                log.warning("Texter %s nicht nutzbar: %r", self.lyrics_model, e)
                lyrics = ""
            if lyrics:
                req["lyrics"] = lyrics
                invent = False
        lm_req = dict(req)
        if code in LANGUAGE_NAMES:
            lm_req["vocal_language"] = LANGUAGE_NAMES[code]
        if invent:
            lm_req["lm_temperature"] = min(float(req.get("lm_temperature") or INVENTED_LYRICS_TEMPERATURE), INVENTED_LYRICS_TEMPERATURE)
        async with httpx.AsyncClient(timeout=60) as c:
            # 1) Sprachmodell: Songstruktur + Audio-Codes. Liefert es bei erfundenem Gesang nur "[Instrumental]", noch einmal würfeln
            # (der Seed des Sprachmodells ist nicht gesetzt, jeder Versuch zieht neu; der Song-Seed bleibt gleich).
            for attempt in range(1 + LM_RETRIES):
                r = await c.post(f"{self.lm_base}/lm", json=lm_req)
                if r.status_code >= 400:
                    raise EngineError(f"/lm: HTTP {r.status_code} {r.text[:300]}")
                res = await self._wait(c, self.lm_base, str(r.json()["id"]), "Sprachmodell", start, progress)
                enriched = res.json()
                if isinstance(enriched, list):
                    enriched = enriched[0]
                if not (invent and code and _missing_vocals(enriched.get("lyrics"))):
                    break
            if code:
                enriched["vocal_language"] = code   # Synthese und Bibliothek bekommen wieder den Code
            if not enriched.get("audio_codes"):
                raise EngineError("Sprachmodell hat keine Audio-Codes geliefert (LM auf Metal? LM-Server auf CPU nutzen)")
            # Die Klangerzeugung schafft höchstens 3000 Codes (600 s bei 5 Codes je Sekunde, 15000 Latent-Frames). Das Sprachmodell
            # liefert gelegentlich ein paar Codes mehr als angefragt; dann bräche die Synthese ab. Daher auf Länge × 5 kürzen.
            want = float(params.get("duration") or enriched.get("duration") or 0)
            limit = int(round(min(want if want > 0 else MAX_SECONDS, MAX_SECONDS) * 5))
            codes = [c for c in str(enriched.get("audio_codes") or "").split(",") if c.strip()]
            if len(codes) > limit:
                enriched["audio_codes"] = ",".join(codes[:limit])
            enriched["output_format"] = req["output_format"]
            enriched["peak_clip"] = req["peak_clip"]
            enriched["synth_model"] = req["synth_model"]

            # 2) Synthese
            self._mark = _log_sizes()   # nur Log-Zeilen ab hier zählen für die Fehlerursache
            if voice:
                r = await c.post(f"{self.base}/synth", data={"request": json.dumps(enriched)}, files={"ref_audio": ("stimme.wav", voice, "audio/wav")})
            else:
                r = await c.post(f"{self.base}/synth", json=enriched)
            if r.status_code >= 400:
                raise EngineError(f"/synth: HTTP {r.status_code} {r.text[:300]}")
            res = await self._wait(c, self.base, str(r.json()["id"]), "Synthese", start, progress)
            try:
                audio, ext = _extract_audio(res)
            except EngineError:
                hint = _memory_hint(self._mark)
                if hint:
                    raise EngineError(hint)
                raise
        meta = {k: enriched.get(k) for k in ("bpm", "duration", "keyscale", "timesignature", "vocal_language", "lyrics", "caption")}
        return audio, ext, meta


    async def analyze(self, audio: bytes, filename: str) -> dict:
        """Song hochladen, Modell beschreibt Stil, Tempo, Tonart, Lyrics (/understand, läuft auf dem LM-Server)."""
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{self.lm_base}/understand", files={"audio": (filename, audio)})
            if r.status_code >= 400:
                raise EngineError(f"/understand: HTTP {r.status_code} {r.text[:300]}")
            res = await self._wait(c, self.lm_base, str(r.json()["id"]), "Analyse", time.monotonic(), lambda _msg: asyncio.sleep(0))
            data = _extract_json(res)
            return data[0] if isinstance(data, list) else data


MAX_SECONDS = 600   # Obergrenze der Klangerzeugung (15000 Latent-Frames)

LANGUAGE_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian",
    "pt": "Portuguese", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ru": "Russian",
}
INVENTED_LYRICS_TEMPERATURE = 0.85
LM_RETRIES = 2


def _missing_vocals(lyrics) -> bool:
    """Gesang bestellt, aber das Sprachmodell hat keine Worte geliefert (nur "[Instrumental]" oder Abschnittsmarken)."""
    text = re.sub(r"\[[^\]]*\]", "", str(lyrics or ""))
    return not re.search(r"\w", text)


_LOGS = ("ace-server.log", "ace-server.err.log")   # unter Windows landen Fehler in der .err.log


def _log_sizes() -> dict:
    base = Path(__file__).resolve().parent.parent / "data"
    out = {}
    for name in _LOGS:
        try:
            out[name] = (base / name).stat().st_size
        except OSError:
            out[name] = 0
    return out


def _memory_hint(since: dict | None = None) -> str:
    """Steht in den neuen Zeilen der Server-Logs (seit Beginn der Synthese), warum die Klangerzeugung scheiterte?
    Liefert einen verständlichen Satz oder leer. Alte Zeilen aus früheren Läufen zählen nicht."""
    base = Path(__file__).resolve().parent.parent / "data"
    since = since or {}
    tail = ""
    for name in _LOGS:
        try:
            with open(base / name, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                start = since.get(name, max(0, size - 12000))
                if start > size:      # Log wurde neu begonnen (Server neu gestartet)
                    start = 0
                f.seek(start)
                tail += f.read(200000).decode("utf-8", "replace").lower()
        except OSError:
            continue
    if "exceeds silence_latent" in tail:
        return ("Der Song ist für die Klangerzeugung zu lang (über 10 Minuten). Bitte eine kürzere Länge wählen. "
                "/ The song is too long for the synthesis (over 10 minutes). Please choose a shorter length.")
    if "out of memory" in tail or "failed to allocate" in tail or "outofdevicememory" in tail:
        return ("Der Grafikspeicher reicht für diese Songlänge nicht (out of memory). Kürzeren Song wählen oder die Klangerzeugung "
                "auf der CPU rechnen lassen. / The graphics memory is too small for this song length. Choose a shorter song or run on the CPU.")
    return ""


def _extract_json(res: httpx.Response):
    """/understand liefert wie /synth multipart/mixed: JSON-Teil (Metadaten) + Roh-Latents."""
    ctype = res.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        return res.json()
    if "multipart" not in ctype:
        raise EngineError(f"Unerwartete Antwort von /understand: {ctype}")
    msg = email.message_from_bytes(
        f"Content-Type: {ctype}\r\n\r\n".encode() + res.content, policy=email.policy.HTTP
    )
    for part in msg.iter_parts():
        if part.get_content_type().startswith("application/json"):
            return json.loads(part.get_payload(decode=True))
    raise EngineError("Kein JSON-Teil in der /understand-Antwort gefunden")


def _extract_audio(res: httpx.Response) -> tuple[bytes, str]:
    ctype = res.headers.get("content-type", "")
    if ctype.startswith("audio/"):
        return res.content, _ext_for(ctype)
    if "multipart" not in ctype:
        raise EngineError(f"Unerwartete Antwort von /synth: {ctype}")
    msg = email.message_from_bytes(
        f"Content-Type: {ctype}\r\n\r\n".encode() + res.content, policy=email.policy.HTTP
    )
    for part in msg.iter_parts():
        pt = part.get_content_type()
        if pt.startswith("audio/"):
            return part.get_payload(decode=True), _ext_for(pt)
    raise EngineError("Kein Audio-Teil in der /synth-Antwort gefunden")


def _ext_for(ctype: str) -> str:
    return "mp3" if "mpeg" in ctype or "mp3" in ctype else "wav"


def make_engine(settings: dict):
    return AceStepCpp(settings["server_url"], settings.get("lm_url", ""), settings["poll_interval"],
                      settings["timeout_minutes"], settings.get("lm_model", ""), settings.get("dit", "standard"), settings.get("lyrics_model", ""))
