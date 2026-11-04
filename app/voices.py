"""Stimmen: Klangfarben-Referenzen (klang.stimm_referenz) unter data/voices. Eine Stimme heißt wie der Song oder das Studio-Medium, aus dem sie stammt,
und bleibt erhalten, auch wenn das Original gelöscht wird."""
import asyncio
import re
from pathlib import Path

from . import db
from .engines import EngineError
from .klang import stimm_referenz


def voice_file(voice_id: str | None) -> Path | None:
    """Datei einer Stimme; None bei ungültiger ID."""
    return db.VOICES_DIR / f"{voice_id}.wav" if re.fullmatch(r"[0-9a-f]{12}", voice_id or "") else None


def exists(voice_id: str | None) -> bool:
    path = voice_file(voice_id)
    return bool(path and path.is_file())


def read(voice_id: str | None) -> bytes | None:
    if not voice_id:
        return None
    if not exists(voice_id):
        # Ohne Referenz käme eine andere Stimme heraus: lieber sichtbar scheitern
        raise EngineError("Die gewählte Stimme gibt es nicht mehr (data/voices). / The chosen voice no longer exists (data/voices).")
    return voice_file(voice_id).read_bytes()


async def create(voice_id: str, audio: Path) -> None:
    """Schneidet die Referenz aus einer WAV-Datei, wenn es sie noch nicht gibt. ValueError oder OSError, wenn die Datei nicht lesbar ist."""
    target = voice_file(voice_id)
    if target.is_file():
        return
    clip = stimm_referenz(await asyncio.to_thread(audio.read_bytes))
    db.VOICES_DIR.mkdir(exist_ok=True)
    target.write_bytes(clip)
