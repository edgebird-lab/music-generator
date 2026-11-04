#!/usr/bin/env bash
# Richtet „Meine Stimme“ ein (einmalig, etwa 17 GB): Applio (MIT-Lizenz, github.com/IAHispano/Applio) in engine/vc, mit PyTorch für AMD (ROCm) und den vortrainierten Modellen.
# ROCm-Torch bietet dieselbe Schnittstelle wie CUDA, Applio läuft damit unverändert. Getestet mit einer RX 7900 XTX (Nov. 2026). Auf NVIDIA TORCH_INDEX auf .../whl/cu128 setzen.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
VC="$ROOT/engine/vc"
COMMIT=140404bda545cbb3a7c438bf2c77209d11cee242   # getesteter Stand
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/rocm6.4}"
mkdir -p "$VC"
cd "$VC"
[ -d applio/.git ] || git clone --quiet https://github.com/IAHispano/Applio.git applio
git -C applio fetch --quiet --depth 1 origin "$COMMIT" 2>/dev/null || true
git -C applio checkout --quiet "$COMMIT"
[ -x env/bin/python ] || uv venv --quiet --python 3.12 env
uv pip install --quiet --python env/bin/python --index-url https://pypi.org/simple --extra-index-url "$TORCH_INDEX" "torch>=2.9,<2.12" "torchaudio>=2.9,<2.12"
grep -vE '^\s*$|^#|nvidia-|onnxruntime-gpu|^torch==|^torchaudio==|sounddevice|edge-tts|uvicorn|fastapi|websockets' applio/requirements-engine.txt > env/requirements-vc.txt
uv pip install --quiet --python env/bin/python --index-url https://pypi.org/simple -r env/requirements-vc.txt
cd applio
../env/bin/python core.py prerequisites --pretraineds-hifigan --models --no-exe
echo "Fertig: Meine Stimme ist eingerichtet."
