"""FastAPI-Backend: Job-Queue, Bibliothek, Einstellungen."""
import asyncio
import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import db, studio, texter, updater, voices
from .engines import DIT_MODELS, EngineError, make_engine
from .klang import hoehen_ausgleichen
from .messages import tr

log = logging.getLogger("uvicorn.error")

STATIC = db.ROOT / "static"
_wakeup = asyncio.Event()
_running: dict = {}   # laufender Auftrag: {"sid", "task", "engine"} – zum Abbrechen


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- Worker

class WachHalten:
    """Verhindert den Ruhezustand, solange Songs gerechnet werden (sonst bleibt die Berechnung
    nach 10-20 Minuten Inaktivität einfach stehen). Mac: caffeinate, Windows: SetThreadExecutionState."""
    def __init__(self):
        self._proc = None

    def an(self):
        try:
            if sys.platform == "darwin" and self._proc is None:
                self._proc = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())],
                                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            elif sys.platform == "win32":
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        except Exception:  # noqa: BLE001 – Wachhalten ist Komfort, kein Grund zum Abbruch
            pass

    def aus(self):
        try:
            if self._proc is not None:
                self._proc.terminate(); self._proc = None
            elif sys.platform == "win32":
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)   # ES_CONTINUOUS
        except Exception:  # noqa: BLE001
            pass


_wach = WachHalten()


async def run_job(sid: str) -> None:
    job = db.one("SELECT * FROM songs WHERE id=? AND status='queued'", (sid,))
    if not job:
        return   # beim Warten auf die GPU abgebrochen
    db.execute("UPDATE songs SET status='running', message='0:00', started_at=? WHERE id=?", (now(), sid))
    engine = make_engine(db.get_settings())

    async def progress(msg: str):
        db.execute("UPDATE songs SET message=? WHERE id=? AND status='running'", (msg, sid))

    try:
        await texter.release()
        params = json.loads(job["params"])
        voice = await asyncio.to_thread(voices.read, params.get("voice_id"))
        gen = asyncio.create_task(engine.generate(params, progress, voice))
        _running.update(sid=sid, task=gen, engine=engine)
        try:
            audio, ext, meta = await gen
        except asyncio.CancelledError:
            if not gen.cancelled() or asyncio.current_task().cancelling():
                raise                   # die App selbst wird beendet
            await engine.cancel()       # vom Nutzer abgebrochen (Status steht schon auf "cancelled")
            return
        finally:
            _running.clear()
        if ext == "wav" and db.get_settings().get("highs") == "on":
            audio = await asyncio.to_thread(hoehen_ausgleichen, audio)
        fname = f"{sid}.{ext}"
        (db.songs_dir() / fname).write_bytes(audio)
        if db.one("SELECT status FROM songs WHERE id=?", (sid,))["status"] == "running":
            db.execute(
                "UPDATE songs SET status='done', message=NULL, file=?, engine=?, result_meta=?, finished_at=? WHERE id=?",
                (fname, engine.name, json.dumps(meta), now(), sid),
            )
    except (EngineError, Exception) as e:  # noqa: BLE001 – Fehler landen sichtbar im UI
        text = str(e) or e.__class__.__name__
        if "ConnectError" in repr(e) or "connect" in text.lower():
            text = f"Modellserver nicht erreichbar ({db.get_settings()['server_url']}). Läuft ace-server?"
        db.execute("UPDATE songs SET status='error', message=?, finished_at=? WHERE id=?", (text, now(), sid))


async def worker():
    """Arbeitet die Queue strikt nacheinander ab (eine GPU, ein Job). Der Songtexter bekommt die GPU zwischen zwei Songs."""
    while True:
        job = db.one("SELECT * FROM songs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1")
        if not job:
            _wach.aus()
            _wakeup.clear()
            await _wakeup.wait()
            continue
        _wach.an()
        async with texter.gpu:
            await run_job(job["id"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    for old in db.DATA.glob("mg-*.zip"):   # Reste abgebrochener Downloads
        old.unlink(missing_ok=True)
    if sys.platform == "darwin":   # Symbole der Start-Dateien erneuern (Git/ZIP setzen sie zurück)
        subprocess.Popen(["bash", str(Path(__file__).resolve().parent.parent / "scripts" / "symbole.sh")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    task = asyncio.create_task(worker())
    texter.watch_shutdown(studio.kill_processes)
    _wakeup.set()
    yield
    task.cancel()
    await studio.shutdown()
    await texter.shutdown()


app = FastAPI(title="Music Generator · EdgeBird-Lab", version=updater.file_version() or "0", lifespan=lifespan)


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    """Unerwartete Fehler: ins Log schreiben und eine verständliche Meldung in der Sprache der Oberfläche liefern."""
    log.exception("Unerwarteter Fehler bei %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": tr(request.headers.get("x-lang", "en"), "unexpected", e=type(exc).__name__)})

# Nur Aufrufe an localhost annehmen: schützt gegen DNS-Rebinding (fremde Domain, die auf 127.0.0.1 zeigt)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
app.include_router(updater.router)
app.include_router(texter.router)
app.include_router(studio.router)


@app.middleware("http")
async def no_cache(request, call_next):
    """Oberfläche nie aus dem Browser-Cache laden, sonst sieht man alte Stände."""
    resp = await call_next(request)
    if request.url.path in ("/", "/studio") or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------------------------------------------------------------- Modelle

class GenerateRequest(BaseModel):
    prompt: str = ""               # Idee / Beschreibung für den Song
    style: str = ""                # Stilrichtung (Genre-Tags)
    caption: str = ""              # nur für ältere Songs: fertiger Text; sonst aus style + prompt gebaut
    lyrics: str = ""
    instrumental: bool = True
    keep_caption: bool = True      # True = Modell schreibt die Beschreibung nicht um
    title: str = ""
    duration: float = 0            # 0 = Modell entscheidet
    bpm: int = 0
    keyscale: str = ""
    timesignature: str = ""
    vocal_language: str = ""
    seed: int = -1                 # -1 = zufällig (wird trotzdem gespeichert)
    variants: int = Field(1, ge=1, le=50)
    inference_steps: int = 0
    lm_temperature: float | None = None
    group_id: str | None = None    # für "weitere Variante" einer bestehenden Gruppe
    folder_id: str | None = None   # Ordner der Bibliothek, in dem die neuen Songs landen
    voice_id: str = ""             # Stimme eines früheren Songs (siehe /api/songs/{sid}/voice), leer = das Modell wählt frei
    voice_name: str = ""           # nur zur Anzeige


class SongPatch(BaseModel):
    favorite: bool | None = None
    title: str | None = None
    folder_id: str | None = None   # None/"" = unsortiert (nur ausgewertet, wenn mitgeschickt)


class FolderIn(BaseModel):
    name: str


def letters() -> dict:
    """Versionen desselben Prompts heißen in Entstehungsreihenfolge A, B, C … (über alle Ordner hinweg)."""
    groups: dict = {}
    for r in db.query("SELECT id, group_id FROM songs ORDER BY created_at, rowid"):
        groups.setdefault(r["group_id"], []).append(r["id"])
    return {sid: chr(65 + i) for ids in groups.values() if len(ids) > 1 for i, sid in enumerate(ids) if i < 26}


def folder_where(folder: str) -> tuple[str, list]:
    """Filter der Bibliothek: "" = alle, "none" = unsortiert, sonst Ordner-ID."""
    if folder == "none":
        return " AND folder_id IS NULL", []
    if folder:
        return " AND folder_id=?", [folder]
    return "", []


def song_out(r: dict, letter: dict | None = None) -> dict:
    r["letter"] = (letter or {}).get(r["id"], "")
    r["params"] = json.loads(r["params"])
    r["result_meta"] = json.loads(r["result_meta"]) if r["result_meta"] else None
    r["favorite"] = bool(r["favorite"])
    r["url"] = f"/api/songs/{r['id']}/audio" if r["file"] else None
    return r


# ---------------------------------------------------------------- API

@app.post("/api/generate")
async def generate(req: GenerateRequest, x_lang: str = Header("de")):
    group = req.group_id or uuid.uuid4().hex[:12]
    lyrics = "[Instrumental]" if req.instrumental else req.lyrics.strip()
    parts = [p.strip().strip(",") for p in (req.style, req.prompt) if p.strip()]
    caption = ", ".join(parts) if parts else req.caption.strip()
    if not caption:
        raise HTTPException(422, tr(x_lang, "no_prompt"))
    if req.voice_id and not voices.exists(req.voice_id):
        raise HTTPException(422, tr(x_lang, "voice_missing"))
    base = req.model_dump(exclude={"variants", "group_id", "folder_id", "instrumental", "title", "keep_caption"})
    base["caption"] = caption
    base["use_cot_caption"] = not req.keep_caption
    base["lyrics"] = lyrics
    folder = req.folder_id if req.folder_id and db.one("SELECT id FROM folders WHERE id=?", (req.folder_id,)) else None
    ids = []
    for i in range(req.variants):
        # Erste Variante nimmt den festen Seed, weitere zählen hoch -> alles reproduzierbar
        seed = random.randint(0, 2**31 - 1) if req.seed < 0 else req.seed + i
        params = {**base, "seed": seed}
        sid = uuid.uuid4().hex[:12]
        db.execute(
            "INSERT INTO songs(id, group_id, created_at, status, title, caption, lyrics, seed, params, folder_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (sid, group, now(), "queued", req.title.strip() or None, caption, lyrics, seed, json.dumps(params), folder),
        )
        ids.append(sid)
    _wakeup.set()
    return {"group_id": group, "ids": ids}


@app.get("/api/songs")
def list_songs(q: str = "", favorites: bool = False, group: str = "", folder: str = ""):
    sql, args = "SELECT * FROM songs WHERE 1=1", []
    if q:
        sql += " AND (caption LIKE ? OR lyrics LIKE ? OR title LIKE ?)"
        args += [f"%{q}%"] * 3
    if favorites:
        sql += " AND favorite=1"
    if group:
        sql += " AND group_id=?"
        args.append(group)
    fw, fa = folder_where(folder)
    sql += fw + " ORDER BY created_at DESC, rowid DESC LIMIT 500"
    lt = letters()
    return [song_out(r, lt) for r in db.query(sql, tuple(args + fa))]


@app.get("/api/songs/{sid}")
def get_song(sid: str):
    r = db.one("SELECT * FROM songs WHERE id=?", (sid,))
    if not r:
        raise HTTPException(404)
    return song_out(r)


@app.patch("/api/songs/{sid}")
def patch_song(sid: str, p: SongPatch):
    if p.favorite is not None:
        db.execute("UPDATE songs SET favorite=? WHERE id=?", (int(p.favorite), sid))
    if p.title is not None:
        db.execute("UPDATE songs SET title=? WHERE id=?", (p.title.strip() or None, sid))
    if "folder_id" in p.model_fields_set:
        db.execute("UPDATE songs SET folder_id=? WHERE id=?", (p.folder_id or None, sid))
    return get_song(sid)


@app.post("/api/songs/{sid}/retry")
async def retry_song(sid: str):
    db.execute("UPDATE songs SET status='queued', message=NULL WHERE id=? AND status IN ('error','cancelled')", (sid,))
    _wakeup.set()
    return get_song(sid)


@app.post("/api/songs/{sid}/voice")
async def use_voice(sid: str, x_lang: str = Header()):
    """Merkt sich die Stimme eines fertigen Songs: Ein Ausschnitt wird zur Klangfarben-Referenz für neue Songs."""
    r = db.one("SELECT file FROM songs WHERE id=? AND status='done' AND file IS NOT NULL", (sid,))
    if not r:
        raise HTTPException(404)
    try:
        await voices.create(sid, db.songs_dir() / r["file"])
    except (OSError, ValueError) as e:
        log.warning("Stimme aus %s nicht lesbar: %r", r["file"], e)
        raise HTTPException(422, tr(x_lang, "voice_unreadable")) from e
    return {"id": sid}


@app.delete("/api/songs/{sid}")
async def delete_song(sid: str):
    r = db.one("SELECT * FROM songs WHERE id=?", (sid,))
    if not r:
        raise HTTPException(404)
    if r["status"] == "queued":
        db.execute("UPDATE songs SET status='cancelled' WHERE id=?", (sid,))
        return {"cancelled": True}
    if r["status"] == "running":
        db.execute("UPDATE songs SET status='cancelled', message=NULL, finished_at=? WHERE id=?", (now(), sid))
        if _running.get("sid") == sid:
            _running["task"].cancel()
        return {"cancelled": True}
    if r["file"]:
        (db.songs_dir() / r["file"]).unlink(missing_ok=True)
    for old in (db.DATA / "export").glob(f"{sid}_*.mp3"):   # umgewandelte MP3-Kopien des Downloads
        old.unlink(missing_ok=True)
    db.execute("DELETE FROM songs WHERE id=?", (sid,))
    return {"deleted": True}


MP3_KBPS = 192


def _mp3_tool() -> Path | None:
    """Der MP3-Wandler der Engine (mp3-codec), wenn er mitgeliefert wurde."""
    b = db.ROOT / "engine" / "acestep.cpp" / "build"
    for p in (b / "mp3-codec", b / "mp3-codec.exe", b / "Release" / "mp3-codec.exe", b / "bin" / "mp3-codec.exe"):
        if p.is_file():
            return p
    return None


def _export_file(r: dict, lang: str = "de") -> Path:
    """Datei für den Download: das Original (WAV) oder, wenn unter Einstellungen MP3 gewählt ist, eine umgewandelte Kopie.
    Die Bibliothek behält immer das verlustfreie Original; die MP3 liegt nur als Zwischenspeicher in data/export."""
    src = db.songs_dir() / r["file"]
    if db.get_settings().get("export_format") != "mp3" or src.suffix.lower() == ".mp3":
        return src
    tool = _mp3_tool()
    if not tool:
        raise HTTPException(500, tr(lang, "mp3_failed"))
    cache = db.DATA / "export"
    cache.mkdir(exist_ok=True)
    out = cache / f"{r['id']}_{MP3_KBPS}.mp3"
    if out.is_file() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    part = cache / f"{r['id']}_{MP3_KBPS}.part.mp3"
    try:
        res = subprocess.run([str(tool), "-i", str(src), "-o", str(part), "-b", str(MP3_KBPS)],
                             capture_output=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("MP3-Wandler %s ließ sich nicht ausführen: %r", tool, e)   # z. B. Virenscanner oder fehlende Rechte
        part.unlink(missing_ok=True)
        raise HTTPException(500, tr(lang, "mp3_failed"))
    if res.returncode or not part.is_file() or part.stat().st_size < 1000:
        log.warning("MP3-Wandler %s: Rückgabewert %s, Ausgabe %s Byte, Quelle %s, Meldung: %s", tool, res.returncode,
                    part.stat().st_size if part.is_file() else "keine", src,
                    (res.stderr or b"").decode("utf-8", "replace").strip()[-400:])
        part.unlink(missing_ok=True)
        raise HTTPException(500, tr(lang, "mp3_failed"))
    part.replace(out)
    return out


@app.get("/api/songs/{sid}/audio")
def song_audio(sid: str, download: bool = False, x_lang: str = Header("de")):
    r = db.one("SELECT * FROM songs WHERE id=?", (sid,))
    if not r or not r["file"]:
        raise HTTPException(404)
    path = _export_file(r, x_lang) if download else db.songs_dir() / r["file"]
    name = None
    if download:
        base = r["title"] or r["caption"][:40]
        base = re.sub(r"[^\w\- ]+", "", base).strip().replace(" ", "_") or "song"
        name = f"{base}_{r['seed']}{path.suffix}"
    return FileResponse(path, filename=name)


# ---------------------------------------------------------------- Ordner

@app.get("/api/folders")
def list_folders():
    counts = {r["folder_id"]: r["n"] for r in db.query("SELECT folder_id, COUNT(*) AS n FROM songs GROUP BY folder_id")}
    folders = db.query("SELECT id, name FROM folders ORDER BY name COLLATE NOCASE")
    known = {f["id"] for f in folders}
    for f in folders:
        f["count"] = counts.get(f["id"], 0)
    # Songs, deren Ordner es nicht mehr gibt, zählen als unsortiert
    return {"folders": folders, "all": sum(counts.values()), "none": sum(n for k, n in counts.items() if k not in known)}


@app.post("/api/folders")
def create_folder(f: FolderIn, x_lang: str = Header("de")):
    name = f.name.strip()[:60]
    if not name:
        raise HTTPException(422, tr(x_lang, "no_name"))
    fid = uuid.uuid4().hex[:12]
    db.execute("INSERT INTO folders(id, name, created_at) VALUES(?,?,?)", (fid, name, now()))
    return {"id": fid, "name": name}


@app.patch("/api/folders/{fid}")
def rename_folder(fid: str, f: FolderIn, x_lang: str = Header("de")):
    name = f.name.strip()[:60]
    if not name:
        raise HTTPException(422, tr(x_lang, "no_name"))
    db.execute("UPDATE folders SET name=? WHERE id=?", (name, fid))
    return {"id": fid, "name": name}


@app.delete("/api/folders/{fid}")
def delete_folder(fid: str):
    """Löscht nur den Ordner; seine Songs werden wieder unsortiert."""
    db.execute("UPDATE songs SET folder_id=NULL WHERE folder_id=?", (fid,))
    db.execute("DELETE FROM folders WHERE id=?", (fid,))
    return {"deleted": True}


@app.get("/api/download")
def download_zip(folder: str = "", x_lang: str = Header("de")):
    """Alle fertigen Songs der Ansicht (alle / unsortiert / ein Ordner) als ZIP mit lesbaren Dateinamen."""
    fw, fa = folder_where(folder)
    rows = db.query("SELECT * FROM songs WHERE status='done' AND file IS NOT NULL" + fw + " ORDER BY created_at, rowid", tuple(fa))
    rows = [r for r in rows if (db.songs_dir() / r["file"]).is_file()]
    if not rows:
        raise HTTPException(404, tr(x_lang, "no_done_songs"))
    clean = lambda s: re.sub(r"[^\w\- ]+", "", s).strip()   # noqa: E731
    f = db.one("SELECT name FROM folders WHERE id=?", (folder,)) if folder not in ("", "none") else None
    zip_name = clean(f["name"] if f else "Music Generator") or "Music Generator"
    lt, used = letters(), set()
    tmp = tempfile.NamedTemporaryFile(prefix="mg-", suffix=".zip", dir=db.DATA, delete=False)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:   # WAV und MP3 lassen sich kaum packen -> nur bündeln
        for r in rows:
            path = _export_file(r, x_lang)
            base = " ".join(x for x in (clean(r["title"] or r["caption"][:40]) or "Song", lt.get(r["id"], "")) if x)
            name = f"{base}{path.suffix}"
            if name.lower() in used:
                name = f"{base} {r['seed']}{path.suffix}"
            used.add(name.lower())
            z.write(path, f"{zip_name}/{name}")
    tmp.close()
    return FileResponse(tmp.name, filename=f"{zip_name}.zip", media_type="application/zip",
                        background=BackgroundTask(Path(tmp.name).unlink, missing_ok=True))


@app.get("/api/queue")
def queue():
    rows = db.query("SELECT id, status, message, caption FROM songs WHERE status IN ('queued','running') ORDER BY created_at, rowid")
    files = [f.stat().st_size for f in db.songs_dir().iterdir() if f.is_file()]
    return {"running": [r for r in rows if r["status"] == "running"], "queued": len([r for r in rows if r["status"] == "queued"]),
            "library": {"count": len(files), "bytes": sum(files)}}


@app.get("/api/settings")
def get_settings():
    return {**db.get_settings(), "lm_device": db.lm_device(), "mp3_available": _mp3_tool() is not None, "songs_dir_default": str(db.SONGS_DIR),
            "dit_xl_available": (db.MODELS_DIR / DIT_MODELS["xl"]).is_file(),
            "dit_xl_bf16_available": (db.MODELS_DIR / DIT_MODELS["xl_bf16"]).is_file(),
            "version": updater.current_version(), "repo_url": updater.REPO_WEB}


@app.put("/api/settings")
def put_settings(values: dict, x_lang: str = Header("de")):
    for k in ("timeout_minutes", "poll_interval"):   # Zahlen prüfen: ein Textwert würde später jede Erzeugung abbrechen
        if k in values:
            try:
                values[k] = float(values[k])
                if not values[k] > 0:
                    raise ValueError
            except (TypeError, ValueError):
                raise HTTPException(422, tr(x_lang, "bad_number", field=k))
            if k == "timeout_minutes" and values[k].is_integer():
                values[k] = int(values[k])
    if "dit" in values:
        if values["dit"] not in DIT_MODELS:
            values["dit"] = "standard"
        if values["dit"] != "standard" and not (db.MODELS_DIR / DIT_MODELS[values["dit"]]).is_file():
            raise HTTPException(400, tr(x_lang, "xl_missing"))
    if "lyrics_model" in values:
        values["lyrics_model"] = str(values["lyrics_model"] or "").strip()
    if "highs" in values:
        values["highs"] = "on" if values["highs"] == "on" else "off"
    if "export_format" in values:
        values["export_format"] = "mp3" if values["export_format"] == "mp3" else "wav"
        if values["export_format"] == "mp3" and not _mp3_tool():
            raise HTTPException(400, tr(x_lang, "mp3_failed"))
    if "lm_device" in values:   # steht nicht in der Datenbank, sondern in data/engine.conf (gilt nach OFF und ON)
        dev = values.pop("lm_device")
        db.set_lm_device("cpu" if dev == "cpu" else "auto")
    if "songs_dir" in values:
        values["songs_dir"] = _move_songs(str(values["songs_dir"] or "").strip(), x_lang)
    return db.save_settings(values)


def _move_songs(new: str, lang: str) -> str:
    """Song-Ordner wechseln: prüfen, anlegen, vorhandene Songs hinüber verschieben. Gibt den zu speichernden Wert zurück."""
    old_dir = db.songs_dir()
    new_dir = Path(new).expanduser() if new else db.SONGS_DIR
    if new and not new_dir.is_absolute():
        raise HTTPException(400, tr(lang, "path_abs"))
    try:
        new_dir.mkdir(parents=True, exist_ok=True)
        probe = new_dir / ".schreibtest"
        probe.write_text("ok"); probe.unlink()
    except OSError as e:
        raise HTTPException(400, tr(lang, "folder_unusable", e=e.strerror or e)) from e
    if new_dir.resolve() != old_dir.resolve():
        busy = db.one("SELECT COUNT(*) AS n FROM songs WHERE status IN ('queued','running')")["n"]
        if busy:
            raise HTTPException(409, tr(lang, "busy"))
        for r in db.query("SELECT file FROM songs WHERE file IS NOT NULL"):
            src = old_dir / r["file"]
            if src.is_file() and not (new_dir / r["file"]).exists():
                try:
                    shutil.move(str(src), str(new_dir / r["file"]))
                except OSError as e:
                    raise HTTPException(400, tr(lang, "move_failed", f=r["file"], e=e)) from e
    return "" if new_dir.resolve() == db.SONGS_DIR.resolve() else str(new_dir)


@app.post("/api/analyze")
async def analyze(audio: UploadFile, x_lang: str = Header("de")):
    """Song hochladen -> Modell liefert Stil, Tempo, Tonart, Lyrics als Vorschlag fürs Formular."""
    if not (audio.content_type or "").startswith("audio/") and not audio.filename.lower().endswith((".wav", ".mp3", ".flac", ".m4a", ".ogg")):
        raise HTTPException(415, tr(x_lang, "audio_only"))
    data = await audio.read()
    if len(data) > 60 * 1024 * 1024:
        raise HTTPException(413, tr(x_lang, "too_big"))
    engine = make_engine(db.get_settings())
    try:
        async with texter.gpu:   # rechnet auf der GPU wie ein Song (siehe worker)
            await texter.release()
            result = await engine.analyze(data, audio.filename or "upload")
    except EngineError as e:
        raise HTTPException(502, str(e) or "Analyse fehlgeschlagen") from e
    return {
        "caption": result.get("caption", ""),
        "lyrics": result.get("lyrics", ""),
        "bpm": result.get("bpm") or 0,
        "keyscale": result.get("keyscale") or "",
        "timesignature": result.get("timesignature") or "",
        "vocal_language": result.get("vocal_language") or "",
        "duration": result.get("duration") or 0,
    }


@app.post("/api/shutdown")
async def shutdown(x_lang: str = Header()):   # Pflicht-Header: fremde Webseiten können ihn nicht mitschicken
    if sys.platform == "win32":
        name = "Music Generator OFF.ps1"
    elif sys.platform == "darwin":
        name = "Music Generator OFF.command"
    elif (db.ROOT / "Music Generator OFF.sh").is_file():
        name = "Music Generator OFF.sh"
    else:
        name = "Music Generator OFF.command"
    script = db.ROOT / name
    if not script.is_file():
        raise HTTPException(404, tr(x_lang, "script_missing", name=name))
    # abgekoppelt und leicht verzögert, damit diese Antwort noch ankommt, bevor die App beendet wird
    if sys.platform == "win32":
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
               f'Start-Sleep -Milliseconds 500; & "{script}"']
        # CREATE_NO_WINDOW (eigene unsichtbare Konsole), nicht DETACHED_PROCESS: ohne Konsole startet
        # PowerShell 5.1 zwar, führt den Befehl aber nicht aus (Exit 0, keine Ausgabe).
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        cmd = ["/bin/sh", "-c", 'sleep 0.5; exec bash "$0"', str(script)]
        flags = {"start_new_session": True}
    subprocess.Popen(cmd, cwd=db.ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
    return {"ok": True}


@app.get("/api/health")
async def health():
    s = db.get_settings()
    try:
        return await make_engine(s).health()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e) or e.__class__.__name__}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/studio")
def studio_page():
    return FileResponse(STATIC / "studio.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
