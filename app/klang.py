"""Klang-Nachbearbeitung der fertigen Songs.

Höhen ausgleichen: Der Klang-Decoder (VAE) von ACE-Step 1.5 verliert über 16 kHz rund 8 dB und zwischen
8 und 16 kHz knapp 3 dB. Gemessen, indem ein fertiges Musikstück nur durch den VAE kodiert und wieder
dekodiert wurde. Keine Synthese-Einstellung ändert daran viel (XL bringt etwa 2 dB). Die Songs klingen
dadurch dumpf, „wie eine alte Kassette“. Ausgleichen lässt sich das nur danach: ein sanfter High-Shelf
(+6 dB ab 12 kHz, wie ffmpeg „treble=g=6:f=12000:t=s:w=0.7“), danach die Spitze auf 0,95 begrenzen.
"""
import io
import math
import wave

import numpy as np

SHELF_GAIN_DB = 6.0
SHELF_FREQ = 12000.0
SHELF_SLOPE = 0.7
PEAK = 0.95
_IR_LEN = 4096       # Impulsantwort des Filters; klingt nach wenigen Millisekunden aus
_BLOCK = 1 << 16


def _shelf(fs: int) -> tuple[list[float], list[float]]:
    """Biquad-High-Shelf nach dem Audio-EQ-Cookbook (R. Bristow-Johnson), Steilheit S wie ffmpeg „treble“."""
    a = 10 ** (SHELF_GAIN_DB / 40)
    w0 = 2 * math.pi * SHELF_FREQ / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / 2 * math.sqrt((a + 1 / a) * (1 / SHELF_SLOPE - 1) + 2)
    sa = 2 * math.sqrt(a) * alpha
    b = [a * ((a + 1) + (a - 1) * cw + sa), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - sa)]
    den = [(a + 1) - (a - 1) * cw + sa, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - sa]
    return [x / den[0] for x in b], [x / den[0] for x in den]


def _impulse(fs: int) -> np.ndarray:
    b, a = _shelf(fs)
    h = np.zeros(_IR_LEN)
    x1 = x2 = y1 = y2 = 0.0
    for n in range(_IR_LEN):
        x0 = 1.0 if n == 0 else 0.0
        y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        h[n] = y0
        x2, x1, y2, y1 = x1, x0, y1, y0
    return h


def _convolve(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Overlap-Add mit FFT, blockweise, damit auch ein 10-Minuten-Song wenig Speicher braucht."""
    n_fft = 1 << int(math.ceil(math.log2(_BLOCK + len(h) - 1)))
    hf = np.fft.rfft(h, n_fft)
    out = np.zeros(len(x) + len(h) - 1)
    for start in range(0, len(x), _BLOCK):
        seg = x[start:start + _BLOCK]
        y = np.fft.irfft(np.fft.rfft(seg, n_fft) * hf, n_fft)[:len(seg) + len(h) - 1]
        out[start:start + len(y)] += y
    return out[:len(x)]


def hoehen_ausgleichen(wav_bytes: bytes) -> bytes:
    """16-Bit-WAV rein, 16-Bit-WAV raus (gleiche Rate und Kanäle). Andere Formate bleiben unverändert."""
    with wave.open(io.BytesIO(wav_bytes)) as w:
        ch, width, fs, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        if width != 2 or fs < 2 * SHELF_FREQ:
            return wav_bytes
        pcm = np.frombuffer(w.readframes(n), dtype="<i2").reshape(-1, ch).astype(np.float64) / 32768.0
    h = _impulse(fs)
    out = np.stack([_convolve(pcm[:, c], h) for c in range(ch)], axis=1)
    peak = float(np.abs(out).max()) if out.size else 0.0
    if peak > PEAK:
        out *= PEAK / peak
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(np.clip(np.round(out * 32767.0), -32768, 32767).astype("<i2").tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------- Stimme verwenden
REF_PARTS = 3        # drei Stellen zu je 10 s, so bildet auch ACE-Step im Original seine Referenzen
REF_SECONDS = 10
_REF_FRAME = 4096


def _stimm_kurve(pcm: np.ndarray, fs: int) -> np.ndarray:
    """Wie viel Stimme steckt vermutlich in jeder Sekunde? Pegel im Stimmband, soweit er in der Stereo-Mitte liegt: Gesang ist fast immer
    mittig gemischt, breite Gitarren und Synths fallen so heraus. Nachgemessen an 8 Songs gegen die Demucs-Gesangsspur (Nov. 2026): 90-100 % der
    bestmöglichen Stellen. Der reine Pegel im Stimmband greift bei Metal daneben (65 %, die Gitarren sind lauter als der Gesang)."""
    left, right = pcm[:, 0].astype(np.float32), pcm[:, -1].astype(np.float32)
    mid, side = (left + right) / 2, (left - right) / 2
    win = np.hanning(_REF_FRAME)
    freqs = np.fft.rfftfreq(_REF_FRAME, 1 / fs)
    band = (freqs >= 200) & (freqs < 4000)
    curve = []
    for sec in range(len(pcm) // fs):
        starts = range(sec * fs, max(sec * fs + 1, (sec + 1) * fs - _REF_FRAME), _REF_FRAME // 2)
        m = np.abs(np.fft.rfft(np.stack([mid[i:i + _REF_FRAME] for i in starts]) * win))[:, band]
        d = np.abs(np.fft.rfft(np.stack([side[i:i + _REF_FRAME] for i in starts]) * win))[:, band]
        curve.append(float(np.sqrt((np.clip(m - d, 0, None) ** 2).mean())))
    return np.array(curve)


def stimm_referenz(wav_bytes: bytes) -> bytes:
    """Klangfarben-Referenz aus einem fertigen Song schneiden: die drei Stellen mit der meisten Stimme, 16-Bit-WAV rein und raus.
    ValueError, wenn die Datei kein lesbares 16-Bit-WAV ist."""
    try:
        with wave.open(io.BytesIO(wav_bytes)) as w:
            ch, width, fs, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if width != 2 or ch not in (1, 2):
                raise ValueError(f"{width * 8} Bit, {ch} Kanäle")
            pcm = np.frombuffer(w.readframes(n), dtype="<i2").reshape(-1, ch)
    except (wave.Error, EOFError) as e:
        raise ValueError(str(e)) from e
    if n <= REF_PARTS * REF_SECONDS * fs:
        return wav_bytes
    score = np.convolve(_stimm_kurve(pcm, fs), np.ones(REF_SECONDS) / REF_SECONDS, mode="valid")
    picked: list[int] = []
    for sec in np.argsort(-score):
        if all(abs(int(sec) - p) >= REF_SECONDS + 2 for p in picked):
            picked.append(int(sec))
        if len(picked) == REF_PARTS:
            break
    clip = np.concatenate([pcm[p * fs:(p + REF_SECONDS) * fs] for p in sorted(picked)])
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(clip.astype("<i2").tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------- Auf den Beat legen
ONSET_HOP = 256
_ONSET_FFT = 1024


def einsaetze(mono: np.ndarray) -> np.ndarray:
    """Einsatzkurve: Wie stark nimmt der Pegel von Fenster zu Fenster zu? Schläge und Silben erscheinen als Spitzen."""
    win = np.hanning(_ONSET_FFT)
    frames = np.lib.stride_tricks.sliding_window_view(mono, _ONSET_FFT)[::ONSET_HOP]
    prev, out = None, []
    for start in range(0, len(frames), 2048):
        spec = np.log1p(np.abs(np.fft.rfft(frames[start:start + 2048] * win, axis=1)) * 100)
        full = spec if prev is None else np.vstack([prev, spec])
        out.append(np.clip(np.diff(full, axis=0), 0, None).sum(axis=1))
        prev = spec[-1:]
    curve = np.concatenate(out)
    return (curve - curve.mean()) / (curve.std() + 1e-9)


def beat_tempo(curve: np.ndarray, fs: int, bpm_hint: float = 0) -> float:
    """Genaues Tempo aus der Einsatzkurve: das Viertel-Raster, auf dem die meisten Einsätze liegen. Das Tempo in den Metadaten taugt dafür nicht:
    Es war in Stichproben um gut 1 % daneben, und das reicht, damit zwei Spuren in 45 Sekunden eine halbe Sekunde auseinanderlaufen."""
    frame_s = ONSET_HOP / fs
    if not bpm_hint:
        lags = np.arange(int(60 / 180 / frame_s), int(60 / 70 / frame_s))
        auto = np.fft.irfft(np.abs(np.fft.rfft(curve, 2 * len(curve))) ** 2)[lags]
        bpm_hint = 60 / (lags[int(np.argmax(auto))] * frame_s)
    t = np.arange(len(curve)) * frame_s
    w = np.clip(curve, 0, None)
    periods = np.linspace(0.94, 1.06, 481) * 60 / bpm_hint
    strength = [abs((w * np.exp(2j * np.pi * t / p)).sum()) for p in periods]
    return float(60 / periods[int(np.argmax(strength))])


def beat_raster(curve: np.ndarray, fs: int, bpm_hint: float = 0) -> tuple[float, float]:
    """Tempo und Lage des ersten Schlags in Sekunden: daran richtet sich das Raster im Studio aus."""
    bpm = beat_tempo(curve, fs, bpm_hint)
    period = 60 / bpm
    t = np.arange(len(curve)) * ONSET_HOP / fs
    angle = float(np.angle((np.clip(curve, 0, None) * np.exp(2j * np.pi * t / period)).sum()))
    return bpm, (angle / (2 * np.pi) * period) % period


def beat_lage(ziel: np.ndarray, neu: np.ndarray, fs: int, bpm: float) -> tuple[float, float]:
    """Um wie viele Sekunden muss die Einsatzkurve neu verschoben werden, damit sie auf ziel liegt? Gleich schnelle Beats passen jeden Takt wieder:
    Gesucht wird innerhalb eines Takts, und von fast gleich guten Lagen gilt die kleinste Verschiebung. Liefert (Versatz, Güte 0..1)."""
    n = min(len(ziel), len(neu))
    corr = np.fft.irfft(np.fft.rfft(ziel[:n], 2 * n) * np.conj(np.fft.rfft(neu[:n], 2 * n))) / n
    bar = int(4 * 60 / bpm * fs / ONSET_HOP)
    lags = np.r_[-bar:bar + 1]
    values = corr[lags]
    good = lags[values >= 0.9 * values.max()]
    best = int(good[int(np.argmin(np.abs(good)))])
    return best * ONSET_HOP / fs, float(max(0.0, corr[best]))
