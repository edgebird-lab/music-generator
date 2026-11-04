#!/usr/bin/env python3
"""Trennt einen Song mit Demucs in Spuren. Läuft in einer eigenen Umgebung (engine/stems, siehe app/studio.py), weil Torch groß ist.

Aufruf: stems.py <eingang.wav> <ausgabeordner> <2|4>
  2: vocals.wav und instrumental.wav. Das Instrumental ist Song minus Gesang, beide zusammen ergeben wieder genau den Song.
  4: zusätzlich drums.wav, bass.wav und other.wav statt des Instrumentals.
Aufruf: stems.py <eingang.wav> <ausgabeordner> place <beat.wav> <bpm>
  Trennt den Gesang eines frisch erzeugten Songs und legt ihn auf einen vorhandenen Beat: vocals.wav und place.json (Versatz in Sekunden, Streckung, Güte).
Aufruf: stems.py <umgewandelter_gesang.wav> <ausgabeordner> mix <instrumental.wav> <gesang_original.wav>
  Mischt einen umgewandelten Gesang (z. B. Mono 40 kHz aus Applio) wieder mit dem Beat: Abtastrate und Länge werden angeglichen, die Lautstärke
  an den ursprünglichen Gesang, Spitzen werden begrenzt. Ergebnis mix.wav und mix.json.
Rechnet auf der CPU: Die GPU gehört ACE-Step und dem Texter, auf 16 Kernen dauert ein 3-Minuten-Song rund 30 Sekunden.
"""
import json
import pathlib
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio
from demucs.apply import apply_model
from demucs.pretrained import get_model

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from app.klang import beat_lage, beat_tempo, einsaetze  # noqa: E402

MAX_STRETCH = 0.03   # mehr wäre als Tonhöhe zu hören; dann lieber von Hand im Studio anlegen


def place(wav: np.ndarray, vocals: np.ndarray, rate: int, out: pathlib.Path, beat_path: str, bpm: float) -> None:
    """Der Gesang sitzt im Takt seines eigenen Beats. Also: dessen Tempo und Lage messen und auf den Ziel-Beat umrechnen."""
    target, target_rate = sf.read(beat_path, dtype="float32", always_2d=True)
    assert target_rate == rate
    curve_target, curve_own = einsaetze(target.mean(axis=1)), einsaetze((wav - vocals).mean(axis=1))
    tempo_target, tempo_own = beat_tempo(curve_target, rate, bpm), beat_tempo(curve_own, rate, bpm)
    ratio = tempo_own / tempo_target    # > 1: Der neue Song ist zu schnell und wird gestreckt
    if abs(ratio - 1) > MAX_STRETCH:
        sf.write(out / "vocals.wav", np.clip(vocals, -1, 1), rate, subtype="PCM_16")
        (out / "place.json").write_text(json.dumps({"shift": 0.0, "ratio": 1.0, "quality": 0.0}))
        return
    # Umrechnen wie langsameres Abspielen: Die Dauer passt danach genau, die Tonhöhe ändert sich um denselben kleinen Faktor (1 % sind 17 Cent)
    x = torch.from_numpy(vocals.T)
    y = torch.from_numpy((wav - vocals).T)
    new_rate = int(round(rate * ratio))
    vocals_fit = torchaudio.functional.resample(x, rate, new_rate).numpy().T
    rest_fit = torchaudio.functional.resample(y, rate, new_rate).numpy().T
    shift, quality = beat_lage(curve_target, einsaetze(rest_fit.mean(axis=1)), rate, tempo_target)
    sf.write(out / "vocals.wav", np.clip(vocals_fit, -1, 1), rate, subtype="PCM_16")
    (out / "place.json").write_text(json.dumps({"shift": shift, "ratio": ratio, "quality": quality, "bpm": tempo_target, "own_bpm": tempo_own}))


def mix(conv_path: pathlib.Path, out: pathlib.Path, instr_path: str, orig_vocals_path: str) -> None:
    """Umgewandelter Gesang plus Beat = neuer Song. Der Pegel des neuen Gesangs wird dem des alten angeglichen (RMS, höchstens ±12 dB)."""
    instr, rate = sf.read(instr_path, dtype="float32", always_2d=True)
    conv, crate = sf.read(conv_path, dtype="float32", always_2d=True)
    orig, _ = sf.read(orig_vocals_path, dtype="float32", always_2d=True)
    if crate != rate:
        conv = torchaudio.functional.resample(torch.from_numpy(conv.T), crate, rate).numpy().T
    if conv.shape[1] != instr.shape[1]:
        conv = np.repeat(conv.mean(axis=1, keepdims=True), instr.shape[1], axis=1)
    conv = conv[:len(instr)]
    conv = np.pad(conv, ((0, len(instr) - len(conv)), (0, 0)))
    rms = lambda a: float(np.sqrt((a ** 2).mean()) + 1e-9)   # noqa: E731
    gain = float(np.clip(rms(orig) / rms(conv), 0.25, 4.0))
    mixed = instr + conv * gain
    peak = float(np.abs(mixed).max())
    limit = 0.98 / peak if peak > 0.98 else 1.0
    sf.write(out / "mix.wav", mixed * limit, rate, subtype="PCM_16")
    (out / "mix.json").write_text(json.dumps({"gain_db": round(20 * np.log10(gain), 1), "limit_db": round(20 * np.log10(limit), 1), "seconds": round(len(instr) / rate, 2)}))


def main() -> None:
    src, out, parts = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
    if parts == "mix":
        mix(src, out, sys.argv[4], sys.argv[5])
        return
    wav, rate = sf.read(src, dtype="float32", always_2d=True)
    if wav.shape[1] == 1:
        wav = np.repeat(wav, 2, axis=1)
    model = get_model("htdemucs")
    model.eval()
    x = torchaudio.functional.resample(torch.from_numpy(wav.T), rate, model.samplerate)
    ref = x.mean(0)
    with torch.no_grad():
        stems = apply_model(model, ((x - ref.mean()) / (ref.std() + 1e-8))[None], device="cpu", shifts=0, split=True, overlap=0.25, progress=False)[0]
    stems = stems * (ref.std() + 1e-8) + ref.mean()

    def save(name: str, data: np.ndarray) -> None:
        sf.write(out / f"{name}.wav", np.clip(data, -1, 1), rate, subtype="PCM_16")

    def stem(name: str) -> np.ndarray:
        data = torchaudio.functional.resample(stems[model.sources.index(name)], model.samplerate, rate).numpy().T[:len(wav)]
        return np.pad(data, ((0, len(wav) - len(data)), (0, 0)))

    vocals = stem("vocals")
    if parts == "place":
        place(wav, vocals, rate, out, sys.argv[4], float(sys.argv[5]))
        return
    save("vocals", vocals)
    if parts == "4":
        for name in ("drums", "bass", "other"):
            save(name, stem(name))
    else:
        save("instrumental", wav - vocals)


if __name__ == "__main__":
    main()
