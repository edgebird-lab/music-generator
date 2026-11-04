# shellcheck shell=bash
# Gemeinsame Einstellungen für Install, Start und Stopp. Wird per "source" eingebunden.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/engine/acestep.cpp"
MODELS="$ENGINE/models"
DATA="$ROOT/data"
CONF="$DATA/engine.conf"          # vom Installer geschrieben: MODE, LM_FILE, LM_DEVICE (cpu = Sprachmodell erzwungen auf CPU)

PORT=8765         # Web-App
SYNTH_PORT=8085   # ace-server Synthese (Metal)
LM_PORT=8086      # ace-server Sprachmodell (nur im Modus "split", auf CPU)

# Getestete acestep.cpp-Version (voller Commit-Hash); neuere könnten die API ändern.
ACESTEP_REPO="https://github.com/ServeurpersoCom/acestep.cpp"
ACESTEP_REV="b7ba6d9ce2f19ca7627fb8f340032c3ebe8ae253"
# Modelle: feste Revision des Hugging-Face-Repos, Dateien werden nach dem Download per SHA-256 geprüft.
HF_BASE="https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/resolve/666ac70204440867d8c01ba4b119cc79c95b370a"
# Datei:Größe in MB:SHA-256. xl-sft ist das optionale XL-Klangmodell (Q8, nur auf Wunsch), xl-sft-BF16 die volle Genauigkeit (ab 20 GB Grafikspeicher), lm-* wird nach Auswahl geladen.
MODEL_FILES="vae-BF16.gguf:340:0599862ac5d15cd308e1d2e368373aea6c02e25ebd1737ad4a4562a0901b0ef8
Qwen3-Embedding-0.6B-Q8_0.gguf:780:972f23255e46adfe744a0eb9a0039f3c63988f65753b0968d776e8b27168c321
acestep-v15-sft-Q8_0.gguf:2550:17f1984e48aaab27b3eb8ccbf0b754a6656e677884c60ea7003845cfc0059b70
acestep-v15-xl-sft-Q8_0.gguf:5060:d7b06fadab214375ef5ebcfa44bf4a10489ea364b119f5b9ecbcd870408bdab9
acestep-v15-xl-sft-BF16.gguf:9980:c998effb0c3b447202c49242fd9ebf55ea7afccf766d4b4dd4ecedaed92bcbbb
acestep-5Hz-lm-0.6B-Q8_0.gguf:710:bdaf9e292d4470f31c19cafeaca1b74936a114667e3a85e5d33b65247e9908ec
acestep-5Hz-lm-1.7B-Q8_0.gguf:1980:726f99a82f050b32ebc5c5e36acaa9d7acd06bfe5e579a62b00e0d0d6d0b7ec6
acestep-5Hz-lm-4B-Q8_0.gguf:4460:972f91147a167f0c041f1b158d67985a82c0f6a852e68cdf70e46030cf08b1bc"
# Nur Windows (gelesen von scripts/common.ps1): unveränderte fertige Programmdateien des acestep.cpp-Autors
# als eigene, versionierte Veröffentlichung in diesem Projekt (GitHub-Vorabrelease engine-win64-*), nach dem Download per SHA-256 geprüft.
# shellcheck disable=SC2034
ENGINE_WIN_REV="6013134"
# shellcheck disable=SC2034
ENGINE_WIN_URL="https://github.com/edgebird-lab/music-generator/releases/download/engine-win64-6013134/acestep-cpp-win64-6013134.zip"
# shellcheck disable=SC2034
ENGINE_WIN_SHA256="647f4ffd1cb2f2e20ac3d54e92a45ed83d3cf9278e55e8b4da1c788fbfb74ac2"
# Nur Windows: cuBLAS 13 von NVIDIA (ggml-cuda.dll braucht cublas64_13.dll, das Archiv oben bringt sie nicht mit).
# Der Installer lädt das Archiv direkt von NVIDIA (nicht von uns), prüft die SHA-256 (aus NVIDIAs redistrib_13.0.2.json,
# selbst nachgerechnet) und kopiert nur cublas64_13.dll und cublasLt64_13.dll neben ace-server.exe.
# shellcheck disable=SC2034
CUBLAS_WIN_URL="https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-13.1.0.3-archive.zip"
# shellcheck disable=SC2034
CUBLAS_WIN_SHA256="4ac4847bbe4f7709b244956fcfc32197a2954ee70b155cb67eebd9ee26f7e339"
# Nur Mac: fertige Programmdateien (aus ACESTEP_REV gebaut, alle drei Apple-CPU-Varianten, ab macOS 26) als eigene
# Veröffentlichung im Projekt. Ältere macOS-Versionen und "Mac-Install.command --build" bauen weiterhin selbst.
ENGINE_MAC_REV="b7ba6d9"
ENGINE_MAC_MIN_OS=26
ENGINE_MAC_URL="https://github.com/edgebird-lab/music-generator/releases/download/engine-macos-arm64-b7ba6d9-2/acestep-cpp-macos-arm64-b7ba6d9-2.zip"   # zweite Ausgabe: mit mp3-codec
ENGINE_MAC_SHA256="95daee3a8c54b3edf1e390992e01581edb8a1f0c29971532397be36fc5c47951"

export PATH="$HOME/.local/bin:/opt/rocm/bin:/opt/cuda/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d "/opt/rocm/lib" ] && export LD_LIBRARY_PATH="/opt/rocm/lib:${LD_LIBRARY_PATH:-}"
# Auf Mesa/RADV (RX 7900 XTX, Mesa 26.0.8) liefert das Sprachmodell mit Cooperative Matrix unbrauchbare Ausgaben.
export GGML_VK_DISABLE_COOPMAT="${GGML_VK_DISABLE_COOPMAT:-1}"
export GGML_VK_DISABLE_COOPMAT2="${GGML_VK_DISABLE_COOPMAT2:-1}"

laeuft() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -i :"$1" -sTCP:LISTEN -t >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -tlpn "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1"/tcp >/dev/null 2>&1
  else
    return 1
  fi
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -i :"$1" -sTCP:LISTEN -t 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1"/tcp 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    (ss -tlpn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+') || true
  fi
}

# MODE=split  -> Sprachmodell auf CPU (Port 8086), Synthese auf Metal/Vulkan/CUDA (Port 8085)
# MODE=single -> alles auf einem Server (Port 8085)
lade_conf() {   # engine.conf als key=value lesen, nicht ausführen
  MODE=split
  LM_FILE=""
  VAE_CHUNK=""
  LM_DEVICE=""
  [ -f "$CONF" ] || return 0
  MODE=$(sed -n 's/^MODE=//p' "$CONF" | tail -1)
  LM_FILE=$(sed -n 's/^LM_FILE=//p' "$CONF" | tail -1)
  VAE_CHUNK=$(sed -n 's/^VAE_CHUNK=//p' "$CONF" | tail -1)
  LM_DEVICE=$(sed -n 's/^LM_DEVICE=//p' "$CONF" | tail -1)
  [ -n "$MODE" ] || MODE=split
  [ "$LM_DEVICE" = "cpu" ] && MODE=split   # per Einstellung/Installer erzwungen: Sprachmodell auf der CPU
  return 0
}

# Mac: Die gebaute Engine trägt den absoluten Bauordner als Suchpfad (rpath) für ihre Bibliotheken. Wird der
# Projektordner verschoben, findet ace-server sie nicht mehr. Hier auf "@loader_path" (der Ordner der Datei selbst)
# umstellen und ad hoc neu signieren. Läuft nach dem Bauen und bei jedem Start; ohne absolute Pfade passiert nichts.
pfade_reparieren() {
  [ "$(uname)" = "Darwin" ] || return 0
  local f rp changed
  for f in "$ENGINE"/build/*; do
    [ -f "$f" ] && [ -x "$f" ] || continue
    case "$f" in *.dylib|*/ace-*|*/quantize|*/mp3-codec|*/neural-codec|*/test-*) ;; *) continue;; esac
    changed=""
    while IFS= read -r rp; do
      [ -n "$rp" ] || continue
      install_name_tool -rpath "$rp" "@loader_path" "$f" 2>/dev/null || install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null
      changed=1
    done < <(otool -l "$f" 2>/dev/null | sed -n '/LC_RPATH/{n;n;s/^ *path \(\/.*\) (offset.*$/\1/p;}')
    [ -n "$changed" ] && codesign -s - -f "$f" >/dev/null 2>&1
  done
  return 0
}

# Terminal-Fenster nach getaner Arbeit selbst schließen (macOS).
fenster_schliessen() {
  [ "$(uname)" = "Darwin" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  local tty_now
  tty_now=$(tty 2>/dev/null) || return 0
  (sleep 1; osascript -e "tell application \"Terminal\" to close (first window whose tty is \"$tty_now\")" >/dev/null 2>&1) &
  disown
}
