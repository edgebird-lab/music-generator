"""Tonstudio: Projekte aus mehreren Spuren, Spurtrennung (Demucs), neue Gesangsspuren über einen vorhandenen Beat, Export in die Bibliothek.

Ein Projekt ist nur JSON (Spuren und Clips); geschnitten, abgespielt und abgemischt wird im Browser. Hier liegen die Audiodateien (Medien) und die
Rechenaufträge. Medien sind eigene Dateien unter data/studio: Ein Projekt bleibt also heil, wenn der Song in der Bibliothek gelöscht wird.
"""
import asyncio
import json
import logging
import os
import random
import re
import shutil
import signal
import sys
import time
import tempfile
import uuid
import wave
from datetime import datetime
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import db, texter, voices
from .engines import make_engine
from .klang import beat_raster, beat_tempo, einsaetze
from .messages import tr

log = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api/studio")

MEDIA = db.DATA / "studio"
STEMS_ENV = db.ROOT / "engine" / "stems"
STEMS_PY = STEMS_ENV / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
STEMS_SCRIPT = db.ROOT / "scripts" / "stems.py"
# Nur die CPU-Fassung von Torch: Die GPU gehört ACE-Step und dem Texter, und die Spurtrennung ist auf der CPU schnell genug.
STEMS_PACKAGES = ["torch==2.5.1", "torchaudio==2.5.1", "demucs", "soundfile", "numpy<2"]
STEM_NAMES = {"vocals": "Gesang", "instrumental": "Beat", "drums": "Schlagzeug", "bass": "Bass", "other": "Instrumente"}

TAKE_STEPS = 80

_jobs: dict = {}                # laufende und fertige Rechenaufträge: id -> {"status", "message", "assets"}
_job_tasks: dict = {}           # id -> asyncio.Task des laufenden Auftrags, zum Abbrechen
_stems_lock = asyncio.Lock()    # eine Spurtrennung nach der anderen, jede nutzt alle Kerne
_groups: set = set()            # Prozessgruppen der laufenden Rechnungen
_stopping = False


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _read_mono(path: Path) -> tuple["np.ndarray", int]:
    with wave.open(str(path)) as w:
        ch, fs = w.getnchannels(), w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, ch).astype(np.float32) / 32768.0
    return pcm.mean(axis=1), fs


def _wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def _asset_path(a: dict) -> Path:
    return MEDIA / a["file"]


def _add_asset(file: Path, name: str, kind: str, source_song: str | None = None, parent: str | None = None) -> dict:
    """Datei gehört jetzt dem Studio (liegt schon unter MEDIA)."""
    aid = new_id()
    rec = {"id": aid, "name": name, "kind": kind, "file": file.name, "duration": _wav_seconds(file), "source_song": source_song, "parent": parent, "created_at": now()}
    db.execute("INSERT INTO studio_assets(id, name, kind, file, duration, source_song, parent, created_at) VALUES(?,?,?,?,?,?,?,?)",
               (aid, name, kind, file.name, rec["duration"], source_song, parent, rec["created_at"]))
    return rec


# ---------------------------------------------------------------- Projekte

class ProjectIn(BaseModel):
    name: str = ""
    song_id: str | None = None      # nur beim Anlegen: Dieser Song liegt dann schon auf der ersten Spur
    data: dict | None = None


def _empty_project() -> dict:
    return {"bpm": 0, "beat0": 0.0, "tracks": [], "clips": []}


def _measure_beat(asset: dict, hint: float = 0) -> dict:
    """Tempo und erster Schlag aus dem Ton. Das Tempo aus den Metadaten des Songs ist nur der Anhaltspunkt: Es lag in Stichproben gut 1 % daneben."""
    mono, fs = _read_mono(_asset_path(asset))
    bpm, beat0 = beat_raster(einsaetze(mono), fs, hint)
    return {"bpm": round(bpm, 2), "beat0": round(beat0, 3)}


def _song_name(r: dict) -> str:
    return r["title"] or r["caption"].split(",")[0].strip() or "Song"


def _import_song(sid: str, lang: str) -> dict:
    existing = db.one("SELECT * FROM studio_assets WHERE source_song=? AND kind='song'", (sid,))
    if existing and _asset_path(existing).is_file():
        return existing
    r = db.one("SELECT * FROM songs WHERE id=? AND status='done' AND file IS NOT NULL", (sid,))
    if not r:
        raise HTTPException(404)
    src = db.songs_dir() / r["file"]
    if src.suffix.lower() != ".wav" or not src.is_file():
        raise HTTPException(422, tr(lang, "studio_no_wav"))
    MEDIA.mkdir(parents=True, exist_ok=True)
    target = MEDIA / f"{new_id()}.wav"
    try:
        os.link(src, target)            # gleiche Platte: kostet keinen Platz und überlebt das Löschen des Songs
    except OSError:
        shutil.copyfile(src, target)
    return _add_asset(target, _song_name(r), "song", source_song=sid)


@router.get("/projects")
def list_projects():
    return db.query("SELECT id, name, updated_at FROM studio_projects ORDER BY updated_at DESC")


@router.post("/projects")
def create_project(p: ProjectIn, x_lang: str = Header()):
    data = _empty_project()
    name = p.name.strip()[:80]
    if p.song_id:
        asset = _import_song(p.song_id, x_lang)
        song = db.one("SELECT * FROM songs WHERE id=?", (p.song_id,))
        meta = json.loads(song["result_meta"]) if song and song["result_meta"] else {}
        track = new_id()
        data = {**_measure_beat(asset, float(meta.get("bpm") or 0)), "tracks": [{"id": track, "name": asset["name"], "volume": 1.0, "pan": 0.0, "mute": False, "solo": False}],
                "clips": [{"id": new_id(), "asset": asset["id"], "track": track, "start": 0.0, "offset": 0.0, "length": asset["duration"], "gain": 1.0, "fadeIn": 0.0, "fadeOut": 0.0}]}
        name = name or asset["name"]
    pid = new_id()
    db.execute("INSERT INTO studio_projects(id, name, data, updated_at) VALUES(?,?,?,?)", (pid, name or "Neues Projekt", json.dumps(data), now()))
    return get_project(pid)


@router.get("/projects/{pid}")
def get_project(pid: str):
    r = db.one("SELECT * FROM studio_projects WHERE id=?", (pid,))
    if not r:
        raise HTTPException(404)
    return {"id": r["id"], "name": r["name"], "updated_at": r["updated_at"], "data": json.loads(r["data"])}


@router.put("/projects/{pid}")
def save_project(pid: str, p: ProjectIn, x_lang: str = Header()):
    if not db.one("SELECT id FROM studio_projects WHERE id=?", (pid,)):
        raise HTTPException(404)
    if p.data is not None:
        db.execute("UPDATE studio_projects SET data=?, updated_at=? WHERE id=?", (json.dumps(p.data), now(), pid))
    if p.name.strip():
        db.execute("UPDATE studio_projects SET name=? WHERE id=?", (p.name.strip()[:80], pid))
    return {"ok": True}


def _assets_in_use() -> set:
    used = set()
    for r in db.query("SELECT data FROM studio_projects"):
        used |= {c["asset"] for c in json.loads(r["data"]).get("clips", [])}
    return used


@router.delete("/projects/{pid}")
def delete_project(pid: str, x_lang: str = Header()):
    """Löscht auch die Medien, die kein anderes Projekt mehr braucht. Die Songs in der Bibliothek bleiben unberührt."""
    db.execute("DELETE FROM studio_projects WHERE id=?", (pid,))
    used = _assets_in_use()
    for a in db.query("SELECT * FROM studio_assets WHERE kind != 'recording'"):   # Aufnahmen bleiben: Sie sind das Rohmaterial für Meine Stimme
        if a["id"] not in used:
            _asset_path(a).unlink(missing_ok=True)
            db.execute("DELETE FROM studio_assets WHERE id=?", (a["id"],))
    return {"deleted": True}


# ---------------------------------------------------------------- Medien

@router.get("/assets")
def list_assets():
    return db.query("SELECT * FROM studio_assets ORDER BY created_at DESC")


@router.post("/assets/song/{sid}")
def asset_from_song(sid: str, x_lang: str = Header()):
    return _import_song(sid, x_lang)


@router.post("/assets/upload")
async def upload_asset(request: Request, name: str = "", x_lang: str = Header()):
    """Mikrofon-Aufnahme oder importierte Datei: Der Browser hat sie schon zu WAV umgewandelt."""
    audio = await request.body()
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise HTTPException(422, tr(x_lang, "studio_no_wav"))
    MEDIA.mkdir(parents=True, exist_ok=True)
    target = MEDIA / f"{new_id()}.wav"
    await asyncio.to_thread(target.write_bytes, audio)
    return _add_asset(target, name.strip()[:80] or "Aufnahme", "recording")


@router.delete("/assets/{aid}")
def delete_asset(aid: str, x_lang: str = Header()):
    """Aufnahmen und Spuren, die kein Projekt mehr nutzt."""
    a = db.one("SELECT * FROM studio_assets WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404)
    if aid in _assets_in_use():
        raise HTTPException(409, tr(x_lang, "studio_in_use"))
    _asset_path(a).unlink(missing_ok=True)
    db.execute("DELETE FROM studio_assets WHERE id=?", (aid,))
    return {"deleted": True}


@router.get("/assets/{aid}/audio")
def asset_audio(aid: str):
    a = db.one("SELECT * FROM studio_assets WHERE id=?", (aid,))
    if not a or not _asset_path(a).is_file():
        raise HTTPException(404)
    return FileResponse(_asset_path(a), media_type="audio/wav")


@router.get("/assets/{aid}/beat")
def asset_beat(aid: str, hint: float = 0):
    a = db.one("SELECT * FROM studio_assets WHERE id=?", (aid,))
    if not a or not _asset_path(a).is_file():
        raise HTTPException(404)
    return _measure_beat(a, hint)


# ---------------------------------------------------------------- Spurtrennung

async def _run(*cmd: str, env: dict | None = None, cwd: Path | None = None, on_output=None) -> None:
    """Eigene Prozessgruppe: Das Training startet Unterprozesse, die beim Abbrechen mit beendet werden müssen."""
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env={**os.environ, **(env or {})}, cwd=cwd, start_new_session=True)
    out = b""
    _groups.add(proc.pid)
    try:
        while chunk := await proc.stdout.read(8192):
            out = (out + chunk)[-4000:]
            if on_output:
                on_output(chunk.decode("utf-8", "replace"))
        await proc.wait()
    except asyncio.CancelledError:
        # abgebrochen: Die Rechnung soll nicht im Hintergrund weiterlaufen
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
        await proc.wait()
        raise
    finally:
        _groups.discard(proc.pid)
    if _stopping:
        raise asyncio.CancelledError   # beim Beenden der App getötet: kein Fehler, sondern ein Abbruch
    if proc.returncode:
        tail = out.decode("utf-8", "replace").replace("\r", "\n").strip()[-800:]
        log.warning("Studio: %s scheiterte (%s): %s", Path(cmd[0]).name, proc.returncode, tail)
        raise RuntimeError(tail.splitlines()[-1] if tail else f"Rückgabewert {proc.returncode}")


async def _ensure_stems_env(job: dict, lang: str) -> None:
    if STEMS_PY.is_file():
        return
    job["message"] = tr(lang, "studio_installing")
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv nicht gefunden / uv not found")
    await _run(uv, "venv", "--quiet", "--python", "3.11", str(STEMS_ENV))
    # uv fragt den Extra-Index zuerst: So kommt Torch aus dem CPU-Index, alles andere von PyPI. Andersherum käme die 5 GB große CUDA-Fassung.
    await _run(uv, "pip", "install", "--quiet", "--python", str(STEMS_PY), "--index-url", "https://pypi.org/simple",
               "--extra-index-url", "https://download.pytorch.org/whl/cpu", *STEMS_PACKAGES)


async def _separate(jid: str, asset: dict, parts: int, lang: str) -> None:
    job = _jobs[jid]
    try:
        async with _stems_lock:
            await _ensure_stems_env(job, lang)
            job["message"] = tr(lang, "studio_separating")
            with tempfile.TemporaryDirectory(dir=MEDIA) as tmp:
                await _run(str(STEMS_PY), str(STEMS_SCRIPT), str(_asset_path(asset)), tmp, str(parts), env={"TORCH_HOME": str(STEMS_ENV / "torch")})
                made = []
                for f in sorted(Path(tmp).glob("*.wav")):
                    target = MEDIA / f"{new_id()}.wav"
                    shutil.move(str(f), target)
                    made.append(_add_asset(target, f"{asset['name']}: {STEM_NAMES.get(f.stem, f.stem)}", f.stem, source_song=asset["source_song"], parent=asset["id"]))
        job.update(status="done", assets=made, message="")
    except asyncio.CancelledError:
        job.update(status="cancelled", message="")
    except Exception as e:  # noqa: BLE001 – der Fehler landet sichtbar im Studio
        log.exception("Studio: Spurtrennung von %s gescheitert", asset["id"])
        job.update(status="error", message=str(e) or e.__class__.__name__)


class SeparateIn(BaseModel):
    parts: int = 2


@router.post("/assets/{aid}/separate")
async def separate(aid: str, p: SeparateIn, x_lang: str = Header()):
    """Startet die Spurtrennung (oder liefert das fertige Ergebnis, wenn es diese Spuren schon gibt)."""
    a = db.one("SELECT * FROM studio_assets WHERE id=?", (aid,))
    if not a or not _asset_path(a).is_file():
        raise HTTPException(404)
    parts = 4 if p.parts == 4 else 2
    wanted = {"vocals", "drums", "bass", "other"} if parts == 4 else {"vocals", "instrumental"}
    have = [x for x in db.query("SELECT * FROM studio_assets WHERE parent=?", (aid,)) if x["kind"] in wanted and _asset_path(x).is_file()]
    if {x["kind"] for x in have} == wanted:
        return {"job": None, "status": "done", "assets": have}
    jid = new_id()
    _jobs[jid] = {"status": "running", "message": tr(x_lang, "studio_separating"), "assets": []}
    _start_job(jid, _separate(jid, a, parts, x_lang))
    return {"job": jid, "status": "running", "assets": []}


def _start_job(jid: str, coro) -> None:
    task = asyncio.create_task(coro)
    _job_tasks[jid] = task
    task.add_done_callback(lambda _t: _job_tasks.pop(jid, None))


@router.get("/jobs/{jid}")
def job_status(jid: str):
    job = _jobs.get(jid)
    if not job:
        raise HTTPException(404)
    return job


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: str, x_lang: str = Header()):
    task = _job_tasks.get(jid)
    if task:
        task.cancel()
    return {"ok": True}


# ---------------------------------------------------------------- Neue Stimme über einen vorhandenen Beat

async def _resolve_voice(choice: str, lang: str) -> str:
    """Auswahl aus dem Dialog (voice:<id>, song:<id>, asset:<id>, leer) zu einer Stimme."""
    kind, _, ref = choice.partition(":")
    if kind == "song":
        r = db.one("SELECT file FROM songs WHERE id=? AND status='done' AND file IS NOT NULL", (ref,))
        if not r:
            raise HTTPException(404)
        await voices.create(ref, db.songs_dir() / r["file"])
    elif kind == "asset":
        a = db.one("SELECT * FROM studio_assets WHERE id=?", (ref,))
        if not a:
            raise HTTPException(404)
        await voices.create(ref, _asset_path(a))
    if ref and not voices.exists(ref):
        raise HTTPException(422, tr(lang, "voice_missing"))
    return ref


async def _take(jid: str, beat: Path, params: dict, name: str, lang: str) -> None:
    """Der Weg, der im Test (Nov. 2026) den neuen Text verlässlich singt und trotzdem im Takt liegt: Ein Song im gemessenen Tempo des Beats wird frisch erzeugt, sein Gesang
    abgetrennt und über den eigenen Beat des neuen Songs auf den vorhandenen gelegt. lego und Repaint singen den Text nicht, der Cover-Modus nur mal mehr, mal weniger."""
    job = _jobs[jid]
    work = Path(tempfile.mkdtemp(dir=MEDIA))
    try:
        async def progress(_msg: str) -> None:
            pass
        mono, fs = await asyncio.to_thread(_read_mono, beat)
        bpm = await asyncio.to_thread(beat_tempo, await asyncio.to_thread(einsaetze, mono), fs, params["bpm"])
        params["bpm"] = int(round(bpm))
        job["message"] = tr(lang, "studio_take_queue")
        async with texter.gpu:   # teilt sich die GPU mit Songs und Texter
            job["message"] = tr(lang, "studio_take_sing")
            await texter.release()
            voice = await asyncio.to_thread(voices.read, params.get("voice_id"))
            engine = make_engine(db.get_settings())
            try:
                audio, _ext, _meta = await engine.generate(params, progress, voice)
            except asyncio.CancelledError:
                await engine.cancel()    # Der Modellserver soll nicht am alten Auftrag weiterrechnen
                raise
        song = work / "song.wav"
        song.write_bytes(audio)
        async with _stems_lock:
            await _ensure_stems_env(job, lang)
            job["message"] = tr(lang, "studio_take_split")
            await _run(str(STEMS_PY), str(STEMS_SCRIPT), str(song), str(work), "place", str(beat), str(bpm), env={"TORCH_HOME": str(STEMS_ENV / "torch")})
        placed = json.loads((work / "place.json").read_text())
        log.info("Studio: neue Stimme, %s", placed)
        target = MEDIA / f"{new_id()}.wav"
        shutil.move(str(work / "vocals.wav"), target)
        # Bei schwacher Güte ist kein Beat erkennbar: dann lieber am Anfang des Bereichs anlegen, zurechtschieben geht von Hand
        job.update(status="done", assets=[_add_asset(target, name, "take")], shift=placed["shift"] if placed["quality"] >= 0.1 else 0.0, message="")
    except asyncio.CancelledError:
        job.update(status="cancelled", message="")
    except Exception as e:  # noqa: BLE001 – der Fehler landet sichtbar im Studio
        log.exception("Studio: neue Stimme gescheitert")
        job.update(status="error", message=str(e) or e.__class__.__name__)
    finally:
        beat.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)


@router.post("/projects/{pid}/take")
async def new_take(pid: str, beat: UploadFile, lyrics: str = Form(), style: str = Form(""), voice: str = Form(""), bpm: float = Form(0), key: str = Form(""),
                   language: str = Form("de"), seconds: float = Form(0), x_lang: str = Header()):
    """Der Browser schickt den Beat (die gewählten Spuren, abgemischt); zurück kommt die neue Stimme als eigene Aufnahme."""
    if not db.one("SELECT id FROM studio_projects WHERE id=?", (pid,)):
        raise HTTPException(404)
    voice_id = await _resolve_voice(voice, x_lang)
    MEDIA.mkdir(parents=True, exist_ok=True)
    beat_path = MEDIA / f"beat-{new_id()}.wav"
    beat_path.write_bytes(await beat.read())
    params = {"caption": style.strip() or "vocals", "lyrics": lyrics.strip(), "bpm": bpm, "keyscale": key, "vocal_language": language, "duration": min(max(seconds, 10), 600),
              "seed": random.randint(0, 2**31 - 1), "inference_steps": TAKE_STEPS, "lm_temperature": 0.85, "voice_id": voice_id}
    count = db.one("SELECT COUNT(*) AS n FROM studio_assets WHERE kind='take'")["n"]
    jid = new_id()
    _jobs[jid] = {"status": "running", "message": tr(x_lang, "studio_take_queue"), "assets": []}
    _start_job(jid, _take(jid, beat_path, params, f"Stimme {count + 1}", x_lang))
    return {"job": jid}


# ---------------------------------------------------------------- Meine Stimme: Stimm-Umwandlung mit Applio (RVC)
# Applio läuft als eigener Prozess in engine/vc (siehe scripts/vc_setup.sh), die Modelle liegen unter data/voice_models. ROCm-Torch verhält sich wie CUDA.
VC_DIR = db.ROOT / "engine" / "vc"
VC_PY = VC_DIR / "env" / "bin" / "python"
APPLIO = VC_DIR / "applio"
VC_MODELS = db.DATA / "voice_models"
VC_EPOCHS = {"fast": 100, "good": 200, "best": 400}
VC_RATE = "40000"


def _applio() -> tuple[list[str], dict]:
    if not (VC_PY.is_file() and (APPLIO / "core.py").is_file()):
        raise RuntimeError("Meine Stimme ist nicht eingerichtet: scripts/vc_setup.sh ausführen. / Not set up: run scripts/vc_setup.sh.")
    VC_MODELS.mkdir(parents=True, exist_ok=True)
    for name in ("mute", "mute_spin", "mute_spin-v2", "reference"):     # Hilfsdaten, die Applio im Modellordner erwartet
        link = VC_MODELS / name
        if not link.exists():
            link.symlink_to(APPLIO / "logs" / name)
    return [str(VC_PY), "core.py"], {"APPLIO_LOGS_DIR": str(VC_MODELS), "PYTHONWARNINGS": "ignore"}


def _model_files(mid: str) -> tuple[Path, Path | None]:
    return VC_MODELS / mid / "model.pth", next(iter(sorted((VC_MODELS / mid).glob("*.index"))), None)


async def _train(jid: str, mid: str, recordings: list[dict], epochs: int, lang: str) -> None:
    job = _jobs[jid]
    # Gemessen auf einer RX 7900 XTX: 0,6 s je Schritt, 8 Ausschnitte je Schritt, ein Ausschnitt deckt rund 2,2 s Aufnahme ab (Gesang 1,9 s, Sprache 2,3 s)
    epoch_guess = max(1, sum(a["duration"] for a in recordings) / 2.2 / 8) * 0.6
    data = Path(tempfile.mkdtemp(dir=MEDIA))
    try:
        core, env = _applio()
        for i, a in enumerate(recordings):
            os.link(_asset_path(a), data / f"{i}.wav")
        job["message"] = tr(lang, "vm_queue")
        async with texter.gpu:   # teilt sich die GPU mit Songs und Texter: Solange trainiert wird, warten sie
            await texter.release()
            job["message"] = tr(lang, "vm_prepare")
            cores = str(max(1, (os.cpu_count() or 2) - 2))
            await _run(*core, "preprocess", "--model-name", mid, "--dataset-path", str(data), "--sample-rate", VC_RATE, "--cpu-cores", cores,
                       "--cut-preprocess", "Automatic", "--chunk-len", "3.0", "--overlap-len", "0.3", "--normalization-mode", "post", env=env, cwd=APPLIO)
            await _run(*core, "extract", "--model-name", mid, "--f0-method", "rmvpe", "--cpu-cores", cores, "--gpu", "0", "--sample-rate", VC_RATE,
                       "--embedder-model", "contentvec", "--include-mutes", "2", env=env, cwd=APPLIO)
            clock = {}

            def progress(text: str) -> None:
                done = [int(x) for x in re.findall(r"epoch=(\d+) \| step=\d+ \| time=", text)]
                if not done:
                    return
                # Gezählt ab dem ersten fertigen Durchlauf: Der enthält das Laden der Modelle und würde die Restzeit stark überschätzen
                clock.setdefault("first", (done[-1], time.monotonic()))
                ran = done[-1] - clock["first"][0]
                each = (time.monotonic() - clock["first"][1]) / ran if ran else epoch_guess
                job.update(epoch=done[-1], epochs=epochs, message=tr(lang, "vm_training", n=done[-1], total=epochs, left=int(each * (epochs - done[-1]) / 60) + 1))
            job.update(epoch=0, epochs=epochs, message=tr(lang, "vm_training_start"))
            await _run(*core, "train", "--model-name", mid, "--vocoder", "HiFi-GAN", "--save-every-epoch", str(min(epochs, 100)), "--save-only-latest",
                       "--total-epoch", str(epochs), "--sample-rate", VC_RATE, "--batch-size", "8", "--gpu", "0", "--pretrained", "--index-algorithm", "Auto",
                       env=env, cwd=APPLIO, on_output=progress)
        # Nur das fertige Modell und seinen Index behalten: Die Zwischenstände kosten über 1 GB
        folder = VC_MODELS / mid
        weights = sorted(folder.glob(f"{mid}_*e_*s.pth"), key=lambda p: p.stat().st_mtime)
        if not weights:
            raise RuntimeError(tr(lang, "vm_no_result"))
        weights[-1].replace(folder / "model.pth")
        for p in folder.iterdir():
            if p.name != "model.pth" and p.suffix != ".index":
                shutil.rmtree(p) if p.is_dir() else p.unlink()
        db.execute("UPDATE studio_voice_models SET status='ready', message=NULL WHERE id=?", (mid,))
        job.update(status="done", message="")
    except asyncio.CancelledError:
        shutil.rmtree(VC_MODELS / mid, ignore_errors=True)
        db.execute("DELETE FROM studio_voice_models WHERE id=?", (mid,))
        job.update(status="cancelled", message="")
    except Exception as e:  # noqa: BLE001 – der Fehler landet sichtbar im Studio
        log.exception("Studio: Training gescheitert")
        shutil.rmtree(VC_MODELS / mid, ignore_errors=True)
        db.execute("UPDATE studio_voice_models SET status='failed', message=? WHERE id=?", (str(e) or e.__class__.__name__, mid))
        job.update(status="error", message=str(e) or e.__class__.__name__)
    finally:
        shutil.rmtree(data, ignore_errors=True)


async def _convert(jid: str, asset: dict, mid: str, pitch: int, name: str, lang: str) -> None:
    job = _jobs[jid]
    target = MEDIA / f"{new_id()}.wav"
    try:
        core, env = _applio()
        pth, index = _model_files(mid)
        job["message"] = tr(lang, "vm_queue")
        async with texter.gpu:
            await texter.release()
            job["message"] = tr(lang, "vm_converting")
            await _run(*core, "infer", "--input-path", str(_asset_path(asset)), "--output-path", str(target), "--pth-path", str(pth), "--index-path", str(index or ""),
                       "--pitch", str(pitch), "--index-rate", "0.5", "--protect", "0.33", "--volume-envelope", "0.0", "--f0-method", "rmvpe", "--export-format", "WAV", "--embedder-model", "contentvec",
                       env=env, cwd=APPLIO)
        if not target.is_file():
            raise RuntimeError(tr(lang, "vm_no_result"))
        job.update(status="done", assets=[_add_asset(target, name, "converted", source_song=asset["source_song"], parent=asset["id"])], message="")
    except asyncio.CancelledError:
        target.unlink(missing_ok=True)
        job.update(status="cancelled", message="")
    except Exception as e:  # noqa: BLE001 – der Fehler landet sichtbar im Studio
        log.exception("Studio: Umwandlung gescheitert")
        target.unlink(missing_ok=True)
        job.update(status="error", message=str(e) or e.__class__.__name__)


class VoiceModelIn(BaseModel):
    name: str = ""
    assets: list[str] = []
    quality: str = "good"


class ConvertIn(BaseModel):
    model: str
    pitch: int = 0


def _training_job(mid: str) -> str | None:
    return next((jid for jid, j in _jobs.items() if j.get("model") == mid and j["status"] == "running"), None)


@router.get("/voice-models")
def list_voice_models():
    models = db.query("SELECT * FROM studio_voice_models ORDER BY created_at DESC")
    for m in models:
        m["job"] = _training_job(m["id"]) if m["status"] == "training" else None
    return {"available": VC_PY.is_file() and (APPLIO / "core.py").is_file(), "models": models}


@router.post("/voice-models")
async def create_voice_model(p: VoiceModelIn, x_lang: str = Header()):
    """Trainiert ein Stimm-Modell aus eigenen Aufnahmen (eigene Stimme oder mit Erlaubnis, siehe Nutzungsbedingungen von Applio)."""
    recordings = [a for a in (db.one("SELECT * FROM studio_assets WHERE id=?", (aid,)) for aid in p.assets) if a and _asset_path(a).is_file()]
    seconds = sum(a["duration"] for a in recordings)
    if seconds < 30:
        raise HTTPException(422, tr(x_lang, "vm_too_short"))
    mid, jid, epochs = new_id(), new_id(), VC_EPOCHS.get(p.quality, VC_EPOCHS["good"])
    db.execute("INSERT INTO studio_voice_models(id, name, status, seconds, epochs, created_at) VALUES(?,?,?,?,?,?)", (mid, p.name.strip()[:60] or "Meine Stimme", "training", seconds, epochs, now()))
    _jobs[jid] = {"status": "running", "message": tr(x_lang, "vm_queue"), "assets": [], "model": mid}
    _start_job(jid, _train(jid, mid, recordings, epochs, x_lang))
    return {"job": jid, "id": mid}


@router.delete("/voice-models/{mid}")
async def delete_voice_model(mid: str, x_lang: str = Header()):
    job = _training_job(mid)
    if job and job in _job_tasks:
        _job_tasks[job].cancel()
    if not re.fullmatch(r"[0-9a-f]{12}", mid):
        raise HTTPException(404)
    shutil.rmtree(VC_MODELS / mid, ignore_errors=True)
    db.execute("DELETE FROM studio_voice_models WHERE id=?", (mid,))
    return {"deleted": True}


@router.post("/assets/{aid}/convert")
async def convert_asset(aid: str, p: ConvertIn, x_lang: str = Header()):
    """Wandelt einen Gesang in die Stimme eines Modells um: Text, Melodie und Timing bleiben, nur die Stimmfarbe wechselt."""
    a = db.one("SELECT * FROM studio_assets WHERE id=?", (aid,))
    model = db.one("SELECT * FROM studio_voice_models WHERE id=? AND status='ready'", (p.model,))
    if not a or not _asset_path(a).is_file() or not model:
        raise HTTPException(404)
    pitch = max(-24, min(24, p.pitch))
    name = f"{a['name']} → {model['name']}" + (f" ({pitch:+d})" if pitch else "")
    existing = db.one("SELECT * FROM studio_assets WHERE parent=? AND kind='converted' AND name=?", (aid, name))
    if existing and _asset_path(existing).is_file():
        return {"job": None, "status": "done", "assets": [existing]}
    jid = new_id()
    _jobs[jid] = {"status": "running", "message": tr(x_lang, "vm_queue"), "assets": []}
    _start_job(jid, _convert(jid, a, p.model, pitch, name, x_lang))
    return {"job": jid, "status": "running", "assets": []}


def kill_processes() -> None:
    """Direkt beim Signal zum Beenden: Die Rechnungen laufen in eigenen Prozessgruppen und überlebten die App sonst. Ein unbemerkt weiterlaufendes
    Training belegte den Grafikspeicher, und der nächste Song brächte ihn zum Überlaufen. Das Stoppskript greift nach 1 s zu kill -9, bis dahin muss das erledigt sein."""
    global _stopping
    _stopping = True
    for pid in list(_groups):
        try:
            os.killpg(pid, signal.SIGKILL)
        except (OSError, AttributeError):
            pass


async def shutdown() -> None:
    """App wird beendet: Laufende Rechnungen stoppen. Das Training läuft in eigener Prozessgruppe und würde sonst weiterrechnen."""
    tasks = list(_job_tasks.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=0.8)


# ---------------------------------------------------------------- Export

@router.post("/projects/{pid}/export")
async def export_mix(pid: str, request: Request, x_lang: str = Header()):
    """Der Browser mischt ab und schickt das fertige WAV; es landet als neuer Song in der Bibliothek."""
    project = db.one("SELECT * FROM studio_projects WHERE id=?", (pid,))
    if not project:
        raise HTTPException(404)
    audio = await request.body()
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise HTTPException(422, tr(x_lang, "studio_no_wav"))
    sid = new_id()
    fname = f"{sid}.wav"
    path = db.songs_dir() / fname
    await asyncio.to_thread(path.write_bytes, audio)
    data = json.loads(project["data"])
    meta = {"duration": _wav_seconds(path), "bpm": data.get("bpm") or None, "lyrics": data.get("lyrics") or ""}
    title = request.query_params.get("title") or project["name"]
    caption = f"Studio: {project['name']}"
    params = {"caption": caption, "lyrics": data.get("lyrics") or "", "studio": pid}
    stamp = now()
    db.execute("INSERT INTO songs(id, group_id, created_at, finished_at, started_at, status, title, caption, lyrics, seed, params, result_meta, engine, file) "
               "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (sid, sid, stamp, stamp, stamp, "done", title, caption, params["lyrics"], 0, json.dumps(params), json.dumps(meta), "studio", fname))
    return {"id": sid, "title": title}

