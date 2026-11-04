"""Updates: holt die neueste Veröffentlichung (Release) des EdgeBird-Lab-Repositorys von GitHub, spielt sie ein und startet neu.

Maßgeblich ist die neueste Veröffentlichung (GitHub-Release, kein Vorab-Release), nicht der letzte Stand des Branches:
So bekommen Nutzer nur Stände, die ausdrücklich freigegeben wurden. Ohne Verbindung zur GitHub-API (z. B. Ratenbegrenzung)
zählt der höchste Versions-Tag im Repository.
"""
import asyncio
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Header, HTTPException, Request

from . import db
from .messages import tr

ROOT = Path(__file__).resolve().parent.parent
BRANCH = "main"
OWNER_REPO = "edgebird-lab/music-generator"
REPO_URL = f"https://github.com/{OWNER_REPO}.git"
REPO_WEB = f"https://github.com/{OWNER_REPO}"
API_LATEST = f"https://api.github.com/repos/{OWNER_REPO}/releases/latest"
VERSION_FILE = ROOT / "VERSION"
# Ändern sich diese Dateien, muss nach dem Update der Installer noch einmal laufen (neue Engine-Version, neue Modelle, neue Pakete)
INSTALL_FILES = {"scripts/common.sh", "scripts/common.ps1"}
router = APIRouter(prefix="/api/update")


def git(*args: str, timeout: int = 60) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}   # nie nach Passwort fragen
    # encoding fest auf UTF-8: git gibt Commit-Texte als UTF-8 aus, text=True nähme unter Windows cp1252 (Umlaute kaputt)
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env=env)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"git {args[0]} fehlgeschlagen")
    return r.stdout.strip()


def _has_head() -> bool:
    """Git-Ordner mit mindestens einem Commit? (Falsch auch nach einer abgebrochenen Umstellung auf Git.)"""
    if not (ROOT / ".git").exists():
        return False
    try:
        git("rev-parse", "--verify", "--quiet", "HEAD")
        return True
    except RuntimeError:
        return False


def _version_key(tag: str) -> tuple:
    """v1.2.10 > v1.2.9: Zahlen vergleichen, nicht Text."""
    return tuple(int(x) for x in re.findall(r"\d+", tag))


def file_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def current_version() -> str:
    """Installierte Version: der Tag der Veröffentlichung, sonst Versionsnummer aus VERSION plus kurzer Commit-Hash."""
    if not _has_head():
        return file_version() or "?"
    try:
        return git("describe", "--tags", "--exact-match", "HEAD")
    except RuntimeError:
        pass
    try:
        short = git("rev-parse", "--short", "HEAD")
    except RuntimeError:
        short = ""
    v = file_version()
    return f"{v}+{short}" if v and short else (v or short or "?")


def _latest_release(lang: str) -> dict:
    """Neueste Veröffentlichung: Tag, Titel, Notizen, Adresse. Erst die GitHub-API, sonst die Tags des Repositorys."""
    try:
        r = httpx.get(API_LATEST, timeout=15, headers={"Accept": "application/vnd.github+json", "User-Agent": "music-generator-updater"})
        if r.status_code == 200:
            d = r.json()
            if d.get("tag_name"):
                return {"tag": d["tag_name"], "name": d.get("name") or d["tag_name"], "notes": d.get("body") or "", "url": d.get("html_url") or REPO_WEB}
        if r.status_code == 404:
            raise RuntimeError(tr(lang, "no_release"))
    except httpx.HTTPError:
        pass   # kein Netz oder Ratenbegrenzung: unten über die Tags
    tags = []
    for line in git("ls-remote", "--tags", "--refs", REPO_URL, timeout=30).splitlines():
        name = line.split("refs/tags/", 1)[-1].strip()
        if re.fullmatch(r"v?\d+(\.\d+)*", name):
            tags.append(name)
    if not tags:
        raise RuntimeError(tr(lang, "no_release"))
    tag = max(tags, key=_version_key)
    return {"tag": tag, "name": tag, "notes": "", "url": f"{REPO_WEB}/releases/tag/{tag}"}


def _notes_lines(notes: str, limit: int = 15) -> list[str]:
    """Aufzählungspunkte der Release-Notizen für die Liste in den Einstellungen."""
    out = []
    for line in notes.replace("\r", "").splitlines():
        m = re.match(r"\s*[-*•]\s+(.*)", line)
        if m and m.group(1).strip():
            out.append(re.sub(r"[*_`]", "", m.group(1)).strip())
        if len(out) >= limit:
            break
    return out


def _ensure_origin() -> None:
    """origin muss auf das EdgeBird-Lab-Repository zeigen (Installationen aus dem Ursprungsprojekt sonst nicht)."""
    try:
        url = git("remote", "get-url", "origin")
    except RuntimeError:
        git("remote", "add", "origin", REPO_URL)
        return
    if OWNER_REPO.lower() not in url.lower():
        git("remote", "set-url", "origin", REPO_URL)


def _status(lang: str = "de") -> dict:
    rel = _latest_release(lang)
    tag = rel["tag"]
    if not _has_head():
        # Ohne Git installiert (z. B. als ZIP geladen): Version unbekannt, das Update stellt auf Git um
        return {"current": file_version() or "?", "latest": tag, "behind": 1, "ahead": 0, "dirty": False, "needs_install": False, "nogit": True,
                "changes": _notes_lines(rel["notes"]) or [tr(lang, "nogit_change")], "name": rel["name"], "url": rel["url"]}
    _ensure_origin()
    git("fetch", "--quiet", "--tags", "origin", timeout=60)
    try:
        target = git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}")
    except RuntimeError as e:
        raise RuntimeError(tr(lang, "gh_unreachable")) from e
    behind = int(git("rev-list", "--count", f"HEAD..{target}"))
    ahead = int(git("rev-list", "--count", f"{target}..HEAD"))
    commits = git("log", f"HEAD..{target}", "--format=%s", "-n", "15").splitlines() if behind else []
    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    changed_files = set(git("diff", "--name-only", f"HEAD..{target}").splitlines()) if behind else set()
    return {
        "current": current_version(), "latest": tag, "name": rel["name"], "url": rel["url"],
        "behind": behind, "ahead": ahead, "changes": _notes_lines(rel["notes"]) or commits, "dirty": dirty,
        "needs_install": bool(changed_files & INSTALL_FILES),
    }


@router.get("/check")
async def check(x_lang: str = Header("de")):
    try:
        return {"ok": True, **await asyncio.to_thread(_status, x_lang)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _friendly(e, x_lang)}


def _friendly(e: Exception, lang: str = "de") -> str:
    msg = str(e) or e.__class__.__name__
    if isinstance(e, subprocess.TimeoutExpired):
        return tr(lang, "gh_timeout")
    if "Could not resolve" in msg or "unable to access" in msg:
        return tr(lang, "gh_unreachable")
    return msg


def _apply(lang: str = "de") -> dict:
    s = _status(lang)
    if not s["behind"]:
        raise RuntimeError(tr(lang, "up_to_date"))
    if s["dirty"]:
        raise RuntimeError(tr(lang, "dirty"))
    if s["ahead"]:
        raise RuntimeError(tr(lang, "ahead"))
    if s.get("nogit"):
        return _apply_nogit(s)
    before = git("rev-parse", "HEAD")
    # Nur vorspulen: die Veröffentlichung liegt auf dem Weg vor uns, eigene Commits gibt es nicht (oben geprüft)
    git("merge", "--ff-only", "--quiet", f"refs/tags/{s['latest']}^{{commit}}", timeout=120)
    if {"pyproject.toml", "uv.lock"} & set(git("diff", "--name-only", before, "HEAD").splitlines()):
        subprocess.run(["uv", "sync", "--quiet"], cwd=ROOT, check=True, timeout=300)
    return {**s, "current": current_version()}


def _apply_nogit(s: dict) -> dict:
    """Ordner ohne .git in ein Git-Repository verwandeln und auf die neueste Veröffentlichung bringen.
    data/, engine/ und .venv sind in .gitignore und bleiben unberührt."""
    def acestep_rev() -> str:
        try:
            return next(l for l in (ROOT / "scripts" / "common.sh").read_text().splitlines() if l.startswith("ACESTEP_REV="))
        except (OSError, StopIteration):
            return ""
    old_rev = acestep_rev()
    if not (ROOT / ".git").exists():
        git("init", "-q")   # ohne „-b“: ältere Git-Versionen (vor 2.28, z. B. alte Xcode-Kommandozeilenwerkzeuge) kennen die Option nicht
        git("symbolic-ref", "HEAD", f"refs/heads/{BRANCH}")
    _ensure_origin()
    git("fetch", "--quiet", "--tags", "origin", timeout=180)
    git("checkout", "--quiet", "-B", BRANCH, f"refs/tags/{s['latest']}^{{commit}}", "--force")
    subprocess.run(["uv", "sync", "--quiet"], cwd=ROOT, check=True, timeout=300)
    return {**s, "current": current_version(), "needs_install": acestep_rev() != old_rev}


@router.post("/apply")
async def apply(request: Request, x_lang: str = Header()):   # Pflicht-Header wie bei /api/shutdown: ein Formular-POST fremder Webseiten kann ihn nicht setzen
    busy = db.one("SELECT COUNT(*) AS n FROM songs WHERE status IN ('queued','running')")["n"]
    if busy:
        raise HTTPException(409, tr(x_lang, "busy"))
    try:
        res = await asyncio.to_thread(_apply, x_lang)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, _friendly(e, x_lang)) from e
    asyncio.get_running_loop().call_later(0.8, _restart, request.url.port or 8765)
    return {"ok": True, **res}


def _restart(port: int) -> None:
    """Neuen Server abgekoppelt starten, der wartet, bis der Port frei ist; dann diesen beenden."""
    log = open(ROOT / "data" / "server.log", "ab")
    if sys.platform == "win32":
        script = (f'while (Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 300 }}; '
                  f'& "{sys.executable}" -m uvicorn app.main:app --host 127.0.0.1 --port {port}')
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
        # CREATE_NO_WINDOW statt DETACHED_PROCESS: ohne Konsole führt PowerShell 5.1 den Befehl nicht aus
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        script = f'while (command -v lsof >/dev/null 2>&1 && lsof -i :{port} -sTCP:LISTEN -t >/dev/null 2>&1) || (command -v ss >/dev/null 2>&1 && ss -tlpn "sport = :{port}" 2>/dev/null | grep -q LISTEN); do sleep 0.3; done; ' \
                 f'exec "{sys.executable}" -m uvicorn app.main:app --host 127.0.0.1 --port {port}'
        cmd = ["/bin/sh", "-c", script]
        flags = {"start_new_session": True}
    subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=log, stdin=subprocess.DEVNULL, **flags)
    os.kill(os.getpid(), signal.SIGTERM)
