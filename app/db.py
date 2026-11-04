"""SQLite-Speicher für Songs (Metadaten) und Einstellungen."""
import json
import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SONGS_DIR = DATA / "songs"
VOICES_DIR = DATA / "voices"   # Referenz-Ausschnitte für „Stimme verwenden“; bleiben, auch wenn der Song gelöscht wird
MODELS_DIR = ROOT / "engine" / "acestep.cpp" / "models"
DB_PATH = DATA / "music.db"

def _engine_conf() -> dict:
    """Vom Installer geschrieben (data/engine.conf): MODE=single|split, LM_FILE=…"""
    conf = {}
    try:
        for line in (DATA / "engine.conf").read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip()
    except OSError:
        pass
    return conf


_conf = _engine_conf()


def engine_conf() -> dict:
    """data/engine.conf frisch gelesen (Installer-Entscheidungen: Backend, Modelle, Texter-Modelle)."""
    return _engine_conf()


if _conf.get("LM_DEVICE") == "cpu":
    _conf["MODE"] = "split"   # Sprachmodell erzwungen auf der CPU (Einstellung oder Installer)


def lm_device() -> str:
    """„cpu“ = Sprachmodell erzwungen auf der CPU, sonst „auto“ (Wert aus data/engine.conf, immer frisch gelesen)."""
    return "cpu" if _engine_conf().get("LM_DEVICE") == "cpu" else "auto"


def set_lm_device(value: str) -> None:
    """Schreibt LM_DEVICE in data/engine.conf (alle anderen Zeilen bleiben). Wirkt nach „OFF“ und „ON“."""
    path = DATA / "engine.conf"
    try:
        lines = [l for l in path.read_text().splitlines() if not l.startswith("LM_DEVICE=")]
    except OSError:
        lines = []
    if value == "cpu":
        lines.append("LM_DEVICE=cpu")
    DATA.mkdir(exist_ok=True)
    path.write_text("\n".join(lines) + ("\n" if lines else ""))

DEFAULT_SETTINGS = {
    "server_url": "http://127.0.0.1:8085",   # Synthese (DiT + VAE, Metal)
    # Sprachmodell: eigener CPU-Server (Modus split) oder leer = gleicher Server wie Synthese (single)
    "lm_url": "" if _conf.get("MODE") == "single" else "http://127.0.0.1:8086",
    "lm_model": _conf.get("LM_FILE", ""),     # leer = erstes Sprachmodell im Modellordner
    "poll_interval": 1.5,
    "timeout_minutes": 30,
    "dit": "standard",                 # Klangmodell: "standard" (2B), "xl" (4B, braucht die XL-Datei) oder "xl_bf16" (4B, höhere Genauigkeit)
    "lyrics_model": _conf.get("LYRICS_MODEL", "gemma4:26b"),   # Ollama-Modell, das leere Lyrics schreibt (vom Installer nach Grafikspeicher gewählt); leer = das ACE-Step-Sprachmodell erfindet sie
    "highs": "off",                    # Höhen ausgleichen: "on" hebt die Höhen an, die der Klang-Decoder verliert (app/klang.py)
    "export_format": "wav",            # Download/Export: "wav" (verlustfrei, wie erzeugt) oder "mp3" (umgewandelt, kleiner)
    "songs_dir": "",                   # leer = data/songs im Programmordner, sonst absoluter Pfad
}

_lock = threading.Lock()


def songs_dir() -> Path:
    """Ordner für die fertigen Songs: Einstellung oder data/songs."""
    custom = ""
    try:
        r = one("SELECT value FROM settings WHERE key='songs_dir'")
        custom = json.loads(r["value"]) if r else ""
    except Exception:  # noqa: BLE001 – vor der ersten Initialisierung oder bei kaputtem Wert
        custom = ""
    d = Path(custom).expanduser() if custom else SONGS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def connect() -> sqlite3.Connection:
    DATA.mkdir(exist_ok=True)
    SONGS_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


_con = connect()


def init():
    with _lock:
        _con.executescript(
            """
            CREATE TABLE IF NOT EXISTS songs (
                id          TEXT PRIMARY KEY,
                group_id    TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                finished_at TEXT,
                status      TEXT NOT NULL,          -- queued | running | done | error | cancelled
                message     TEXT,
                title       TEXT,
                caption     TEXT NOT NULL,
                lyrics      TEXT,
                seed        INTEGER NOT NULL,
                params      TEXT NOT NULL,          -- JSON: vollständige Anfrage
                result_meta TEXT,                   -- JSON: vom Modell ergänzte Werte (bpm, key, lyrics …)
                engine      TEXT,
                file        TEXT,
                favorite    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);
            CREATE INDEX IF NOT EXISTS idx_songs_group ON songs(group_id);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS studio_voice_models (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                status      TEXT NOT NULL,          -- training | ready | failed
                message     TEXT,
                seconds     REAL NOT NULL,          -- so viel Aufnahme lag dem Training zugrunde
                epochs      INTEGER NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS studio_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS studio_assets (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                kind        TEXT NOT NULL,          -- song | vocals | instrumental | drums | bass | other | take
                file        TEXT NOT NULL,          -- Dateiname unter data/studio
                duration    REAL NOT NULL,
                source_song TEXT,
                parent      TEXT,                   -- aus welchem Medium diese Spur abgetrennt wurde
                created_at  TEXT NOT NULL
            );
            """
        )
        # Ordner der Bibliothek (nur in der App; die Dateien bleiben, wo sie sind). NULL = unsortiert
        if "folder_id" not in [r["name"] for r in _con.execute("PRAGMA table_info(songs)")]:
            _con.execute("ALTER TABLE songs ADD COLUMN folder_id TEXT")
        # Beginn der Berechnung (created_at ist der Zeitpunkt des Einreihens; wartende Songs würden sonst die Wartezeit mitzählen)
        if "started_at" not in [r["name"] for r in _con.execute("PRAGMA table_info(songs)")]:
            _con.execute("ALTER TABLE songs ADD COLUMN started_at TEXT")
        # Meine Stimme: Grundfrequenz der Trainingsaufnahmen (für die Oktav-Automatik) und welche Aufnahmen es waren
        cols = [r["name"] for r in _con.execute("PRAGMA table_info(studio_voice_models)")]
        if "f0" not in cols:
            _con.execute("ALTER TABLE studio_voice_models ADD COLUMN f0 REAL")
        if "recordings" not in cols:
            _con.execute("ALTER TABLE studio_voice_models ADD COLUMN recordings TEXT")
        # Nach einem Absturz hängengebliebene Jobs wieder einreihen
        _con.execute("UPDATE songs SET status='queued', message=NULL WHERE status='running'")
        _con.execute("UPDATE studio_voice_models SET status='failed', message='interrupted' WHERE status='training'")
        _con.commit()


def execute(sql: str, args: tuple = ()) -> None:
    with _lock:
        _con.execute(sql, args)
        _con.commit()


def query(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _con.execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    rows = query(sql, args)
    return rows[0] if rows else None


def get_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    for r in query("SELECT key, value FROM settings"):
        s[r["key"]] = json.loads(r["value"])
    # Früher gespeicherte Standardadresse des CPU-Servers: im Ein-Server-Modus läuft dort nichts
    if _conf.get("MODE") == "single" and s["lm_url"].rstrip("/") == "http://127.0.0.1:8086":
        s["lm_url"] = ""
    return s


def save_settings(values: dict) -> dict:
    for k, v in values.items():
        if k not in DEFAULT_SETTINGS:
            continue
        if v == DEFAULT_SETTINGS[k]:
            # Vorgaben nicht festschreiben, sonst überstimmen sie später den Installer (engine.conf)
            execute("DELETE FROM settings WHERE key=?", (k,))
        else:
            execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v)),
            )
    return get_settings()
