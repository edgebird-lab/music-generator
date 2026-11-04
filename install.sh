#!/usr/bin/env bash
# Music Generator (EdgeBird-Lab) · Installer für Linux
#
# Ein Befehl für alles: prüft den Rechner (Grafikkarte, Grafikspeicher, Arbeitsspeicher, freier Platz), wählt daraus das Backend
# und die bestmögliche Modellkombination, installiert die Abhängigkeiten nacheinander, baut den Modellserver, lädt die Modelle
# (mit SHA-256-Prüfung), richtet Ollama mit passenden Textmodellen für den Songtexter ein, dazu die Spurtrennung fürs Studio
# und auf Wunsch „Meine Stimme“ (Applio), und startet die App. Kann jederzeit erneut laufen: Erledigtes wird übersprungen.
#
# Getestet: Ubuntu 26.04 mit Radeon RX 7900 XTX (Vulkan). Vorgesehen: Ubuntu/Debian/Linux Mint (apt), Arch/CachyOS/EndeavourOS/
# Manjaro (pacman), Fedora (dnf, experimentell), openSUSE (zypper, experimentell).
#
# Aufruf:  ./install.sh [Optionen]
#   --yes, -y            keine Rückfragen, Empfehlungen übernehmen
#   --dry-run            nur zeigen, was passieren würde (nichts installieren)
#   --backend X          auto | vulkan | rocm | cuda | cpu   (Standard: auto)
#   --lm 0.6B|1.7B|4B    Sprachmodell erzwingen
#   --xl | --no-xl       XL-Klangmodell (Q8) laden bzw. weglassen
#   --xl-bf16            zusätzlich XL in voller Genauigkeit (10 GB, ab 20 GB Grafikspeicher)
#   --full               alles einrichten: auch Spurtrennung (Demucs) und „Meine Stimme“ (Applio, etwa 17 GB)
#   --no-ollama          Songtexter (Ollama) auslassen
#   --no-stems           Spurtrennung nicht vorab einrichten (die App holt sie sonst beim ersten Gebrauch nach)
#   --no-start           am Ende nicht starten
#   --start | --stop | --status | --uninstall
#   --help, -h
set -Eeuo pipefail
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SOURCE_DIR/scripts/common.sh" ]]; then echo "✗ install.sh gehört in den Programmordner des Music Generators (neben app/ und static/)." >&2; exit 1; fi
# shellcheck source=scripts/common.sh
source "$SOURCE_DIR/scripts/common.sh"
cd "$ROOT"

AUTO=0; DRY=0; BACKEND=auto; LM_SIZE=""; XL=""; XL_BF16=""; FULL=0; OLLAMA=1; STEMS=1; VC=""; START=1; ACTION=install
while (($#)); do
  case "$1" in
    --yes|-y) AUTO=1 ;;
    --dry-run) DRY=1 ;;
    --backend) BACKEND="${2:-}"; shift ;;
    --lm) LM_SIZE="${2:-}"; shift ;;
    --xl) XL=1 ;;
    --no-xl) XL=0 ;;
    --xl-bf16) XL=1; XL_BF16=1 ;;
    --full) FULL=1; VC=1 ;;
    --no-ollama) OLLAMA=0 ;;
    --no-stems) STEMS=0 ;;
    --no-voice) VC=0 ;;
    --no-start) START=0 ;;
    --start) ACTION=start ;;
    --stop) ACTION=stop ;;
    --status) ACTION=status ;;
    --uninstall) ACTION=uninstall ;;
    --help|-h) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (Hilfe: $0 --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$BACKEND" in auto|vulkan|rocm|hip|cuda|cpu) ;; *) echo "Ungültiges Backend: $BACKEND" >&2; exit 2 ;; esac
[[ "$BACKEND" == hip ]] && BACKEND=rocm
if [[ -n "$LM_SIZE" ]]; then case "$LM_SIZE" in 0.6B|1.7B|4B) ;; *) echo "Ungültige Modellgröße: $LM_SIZE (0.6B, 1.7B, 4B)" >&2; exit 2 ;; esac; fi

# ---------------------------------------------------------------- Hilfen
schritt() { echo ""; echo "▸ $1"; }
hinweis() { echo "  $1"; }
abbruch() { echo ""; echo "✗ $1" >&2; exit 1; }
ja() {   # ja "Frage" [n]: Enter = ja (bzw. nein, wenn n als Standard)
  [[ "$AUTO" == 1 ]] && { [[ "${2:-j}" != n ]]; return; }
  local a hint="[Enter = ja, n = nein]"
  [[ "${2:-j}" == n ]] && hint="[Enter = nein, j = ja]"
  read -r -p "$1 $hint " a
  if [[ -z "$a" ]]; then [[ "${2:-j}" != n ]]; else [[ "$a" =~ ^[jJyY] ]]; fi
}
sudo_tun() {
  if [[ "$DRY" == 1 ]]; then echo "  PLAN: sudo $*"; return 0; fi
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}
sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# ---------------------------------------------------------------- Start, Stopp, Status, Deinstallation (gemeinsam für alle Distributionen)
ollama_starten() {   # Ollama ist optional: läuft es nicht, schreibt das ACE-Step-Sprachmodell die Texte
  command -v ollama >/dev/null 2>&1 || return 0
  curl -s --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && return 0
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    systemctl start ollama 2>/dev/null || sudo systemctl start ollama 2>/dev/null || true
  else
    (setsid ollama serve >"$DATA/ollama.log" 2>&1 &) ; sleep 1
  fi
}
case "$ACTION" in
  start)  mkdir -p "$DATA"; ollama_starten; exec bash "$ROOT/arch_linux.sh" --start ;;
  stop)   exec bash "$ROOT/arch_linux.sh" --stop ;;
  status) bash "$ROOT/arch_linux.sh" --status; echo "  Ollama: $(curl -s --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && echo läuft || echo aus)"; exit 0 ;;
  uninstall) if [[ "$AUTO" == 1 ]]; then exec bash "$ROOT/scripts/uninstall.sh" --yes; else exec bash "$ROOT/scripts/uninstall.sh"; fi ;;
esac

echo "═══════════════════════════════════════════════════════════"
echo "  MUSIC GENERATOR · EdgeBird-Lab · Installation für Linux"
[[ "$DRY" == 1 ]] && echo "  (Probelauf: es wird nichts verändert)"
echo "═══════════════════════════════════════════════════════════"

# ---------------------------------------------------------------- 1. System
schritt "1. System"
[[ "$(uname -s)" == Linux ]] || abbruch "Dieses Skript ist für Linux (erkannt: $(uname -s)). Mac: Mac-Install.command, Windows: Windows-Install.bat."
ID=""; ID_LIKE=""; PRETTY_NAME=""
# shellcheck source=/dev/null
[[ -f /etc/os-release ]] && source /etc/os-release
PM=none
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v pacman >/dev/null 2>&1; then PM=pacman
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v zypper >/dev/null 2>&1; then PM=zypper
fi
ARCH=$(uname -m)
hinweis "Distribution:  ${PRETTY_NAME:-unbekannt} (Paketverwaltung: $PM)"
hinweis "Architektur:   $ARCH"
[[ "$ARCH" == x86_64 || "$ARCH" == aarch64 ]] || hinweis "Warnung: ungewöhnliche Architektur, acestep.cpp ist dafür nicht getestet."
[[ "$PM" == none ]] && hinweis "Keine bekannte Paketverwaltung: Werkzeuge (git, cmake, Compiler) müssen schon da sein."

# ---------------------------------------------------------------- 2. Hardware
schritt "2. Hardware"
RAM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 ))
FREE_GB=$(( $(df -k "$ROOT" | awk 'NR==2 {print $4}') / 1048576 ))
CORES=$(nproc 2>/dev/null || echo 4)
GPU_INFO=$(lspci 2>/dev/null | grep -iE 'vga|3d controller|display controller' || true)
HAS_NVIDIA=0; HAS_AMD=0; HAS_INTEL=0; VRAM_GB=0; AMD_GFX=""
echo "$GPU_INFO" | grep -iq nvidia && HAS_NVIDIA=1
echo "$GPU_INFO" | grep -iqE 'amd|radeon|advanced micro devices' && HAS_AMD=1
echo "$GPU_INFO" | grep -iq intel && HAS_INTEL=1
if [[ "$HAS_NVIDIA" == 1 ]] && command -v nvidia-smi >/dev/null 2>&1; then
  mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1 || echo 0)
  VRAM_GB=$(( (${mb:-0} + 512) / 1024 ))
fi
if [[ "$VRAM_GB" == 0 ]]; then   # AMD, Intel oder NVIDIA ohne nvidia-smi: größte Karte laut Kernel
  for f in /sys/class/drm/card*/device/mem_info_vram_total; do
    [[ -r "$f" ]] || continue
    b=$(cat "$f" 2>/dev/null || echo 0); g=$(( (b / 1048576 + 512) / 1024 ))
    (( g > VRAM_GB )) && VRAM_GB=$g
  done
fi
if [[ "$VRAM_GB" == 0 && "$HAS_AMD" == 1 ]] && command -v rocm-smi >/dev/null 2>&1; then
  raw=$(rocm-smi --showmeminfo vram 2>/dev/null | grep -o 'VRAM Total Memory (B): [0-9]*' | awk '{print $NF}' | head -1 || echo 0)
  [[ "${raw:-0}" -gt 0 ]] && VRAM_GB=$(( (raw / 1048576 + 512) / 1024 ))
fi
[[ "$HAS_AMD" == 1 ]] && command -v rocminfo >/dev/null 2>&1 && AMD_GFX=$(rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9a-z]*' || true)
GPU_KIND=cpu; (( HAS_NVIDIA )) && GPU_KIND=nvidia; (( HAS_AMD )) && GPU_KIND=amd; (( HAS_INTEL && !HAS_AMD && !HAS_NVIDIA )) && GPU_KIND=intel
# Integrierte Grafik meldet oft nur 0,5-2 GB eigenen Speicher und teilt sich den Rest mit dem Arbeitsspeicher: wie CPU behandeln
DEDICATED=1; (( VRAM_GB < 3 )) && DEDICATED=0
hinweis "Arbeitsspeicher: ${RAM_GB} GB · Kerne: $CORES · frei auf der Platte: ${FREE_GB} GB"
if [[ -n "$GPU_INFO" ]]; then echo "$GPU_INFO" | sed 's/^/  Grafik: /'; else hinweis "Grafik: keine gefunden"; fi
hinweis "Grafikspeicher: ${VRAM_GB} GB$( (( DEDICATED )) || echo ' (keine eigene Grafikkarte: rechnet auf dem Prozessor)')${AMD_GFX:+ · $AMD_GFX}"

# ---------------------------------------------------------------- 3. Backend
schritt "3. Backend für den Modellserver"
export PATH="/usr/local/cuda/bin:/opt/cuda/bin:$PATH"
HAS_VULKAN_ICD=0; compgen -G '/usr/share/vulkan/icd.d/*.json' >/dev/null 2>&1 && HAS_VULKAN_ICD=1
HAS_ROCM=0; { [[ -d /opt/rocm ]] || command -v hipcc >/dev/null 2>&1; } && HAS_ROCM=1
HAS_NVCC=0; command -v nvcc >/dev/null 2>&1 && HAS_NVCC=1
if [[ "$BACKEND" == auto ]]; then
  if (( !DEDICATED )) && (( !HAS_INTEL )); then BACKEND=cpu
  elif (( HAS_NVIDIA )) && (( HAS_NVCC )); then BACKEND=cuda
  elif (( HAS_NVIDIA || HAS_AMD || HAS_INTEL )); then BACKEND=vulkan   # AMD: Vulkan hat sich bewährt (RX 7900 XTX, Linux-Mint-Berichte); ROCm mit --backend rocm
  else BACKEND=cpu
  fi
fi
case "$BACKEND" in
  cuda)   (( HAS_NVCC )) || hinweis "CUDA gewählt, aber nvcc fehlt: das CUDA-Toolkit wird mit installiert (apt/pacman) oder muss von NVIDIA kommen." ;;
  rocm)   (( HAS_ROCM )) || hinweis "ROCm gewählt, aber /opt/rocm fehlt: wird mit installiert (nur Arch) oder muss von AMD kommen (https://rocm.docs.amd.com)." ;;
esac
hinweis "Backend: $BACKEND"

# ---------------------------------------------------------------- 4. Modellplan (die bestmögliche Kombination für diesen Rechner)
schritt "4. Modellplan"
# Sprachmodell von ACE-Step (plant Aufbau, Tempo, Tonart; größer = bessere Songs). Es liegt mit auf der Grafikkarte.
EMPF="0.6B"
if (( DEDICATED )); then
  if (( VRAM_GB >= 8 && RAM_GB >= 12 )); then EMPF="4B"; elif (( VRAM_GB >= 6 || RAM_GB >= 16 )); then EMPF="1.7B"; fi
else
  (( RAM_GB >= 12 )) && EMPF="1.7B"   # 4B rechnet auf dem Prozessor zu langsam
fi
[[ -z "$LM_SIZE" ]] && LM_SIZE="$EMPF"
LM_FILE="acestep-5Hz-lm-${LM_SIZE}-Q8_0.gguf"
# Klangmodelle: SFT (2 Mrd.) immer; XL (4 Mrd., 5,3 GB) ab 12 GB Grafikspeicher; XL BF16 (10 GB, höchste Genauigkeit) ab 20 GB
XL_FILE="acestep-v15-xl-sft-Q8_0.gguf"; XL16_FILE="acestep-v15-xl-sft-BF16.gguf"
[[ -z "$XL" ]] && { XL=0; (( DEDICATED && VRAM_GB >= 12 )) && XL=1; }
[[ -f "$MODELS/$XL_FILE" ]] && XL=1
[[ -z "$XL_BF16" ]] && { XL_BF16=0; (( DEDICATED && VRAM_GB >= 20 )) && XL_BF16=1; }
[[ -f "$MODELS/$XL16_FILE" ]] && XL_BF16=1
# Kachelgröße des Klang-Decoders: kleiner = weniger Speicher auf einmal (ohne Kachelung braucht er für 30 s Ton 6,7 GB am Stück)
VAE_CHUNK=""
if (( DEDICATED )); then
  if (( VRAM_GB < 8 )); then VAE_CHUNK=128; elif (( VRAM_GB < 12 )); then VAE_CHUNK=256; elif (( VRAM_GB < 16 )); then VAE_CHUNK=512; fi
else
  if (( RAM_GB < 12 )); then VAE_CHUNK=256; elif (( RAM_GB < 16 )); then VAE_CHUNK=512; fi
fi
# Textmodelle für den Songtexter (Ollama): „Normal“ und „Ohne Filter“, nach Grafikspeicher. Der Modellserver bleibt dabei geladen,
# deshalb rechnen wir rund 4 GB weniger. Ohne eigene Grafikkarte zählt der Arbeitsspeicher (Ollama rechnet dann auf dem Prozessor).
if (( DEDICATED )); then EFF=$(( VRAM_GB - 4 )); else EFF=$(( RAM_GB / 2 - 2 )); fi
LYRICS_MODEL=""; TEXTER_MODEL=""; TIER=""
if   (( EFF >= 18 )); then LYRICS_MODEL="gemma4:26b";  TEXTER_MODEL="orcarouter/Qwen3.8-27B-Uncensored:q3_k_m"; TIER="groß (17 GB + 14 GB)"
elif (( EFF >= 10 )); then LYRICS_MODEL="gemma4:12b";  TEXTER_MODEL="huihui_ai/qwen3-abliterated:14b";          TIER="mittel (8 GB + 9 GB)"
elif (( EFF >= 6 ));  then LYRICS_MODEL="gemma4:e4b";  TEXTER_MODEL="huihui_ai/qwen3-abliterated:8b";           TIER="klein (7 GB + 5 GB)"
elif (( EFF >= 3 ));  then LYRICS_MODEL="gemma4:e2b";  TEXTER_MODEL="huihui_ai/qwen3-abliterated:4b";           TIER="sehr klein (5 GB + 3 GB)"
else OLLAMA=0; TIER="keins (zu wenig Speicher; das ACE-Step-Sprachmodell schreibt die Texte)"
fi
# Spurtrennung (Demucs auf dem Prozessor, etwa 1 GB) und „Meine Stimme“ (Applio mit PyTorch für ROCm/CUDA, etwa 17 GB, nur mit Grafikkarte)
VC_POSSIBLE=0
if (( DEDICATED && VRAM_GB >= 8 )) && { (( HAS_AMD && HAS_ROCM )) || (( HAS_NVIDIA )); }; then VC_POSSIBLE=1; fi
[[ -z "$VC" ]] && VC=0
(( VC && !VC_POSSIBLE )) && { hinweis "„Meine Stimme“ braucht eine Grafikkarte mit ROCm (AMD) oder CUDA (NVIDIA) und mindestens 8 GB: wird ausgelassen."; VC=0; }

NEED_MB=0
needs() { local f="$1" mb; mb=$(printf '%s\n' "$MODEL_FILES" | grep -F "$f:" | cut -d: -f2); [[ -f "$MODELS/$f" ]] || NEED_MB=$(( NEED_MB + ${mb:-0} )); }
WANT=(vae-BF16.gguf Qwen3-Embedding-0.6B-Q8_0.gguf acestep-v15-sft-Q8_0.gguf "$LM_FILE")
(( XL )) && WANT+=("$XL_FILE"); (( XL_BF16 )) && WANT+=("$XL16_FILE")
for f in "${WANT[@]}"; do needs "$f"; done
NEED_GB=$(( (NEED_MB + 999) / 1000 ))
echo "  Sprachmodell (ACE-Step):   $LM_SIZE$( [[ "$LM_SIZE" == "$EMPF" ]] && echo ' (Empfehlung)' )"
echo "  Klangmodell:               SFT Standard$( (( XL )) && echo ' + XL' )$( (( XL_BF16 )) && echo ' + XL BF16' )"
echo "  Decoder-Kachel:            ${VAE_CHUNK:-voll}"
echo "  Songtexter (Ollama):       $( (( OLLAMA )) && echo "$TIER · Normal: $LYRICS_MODEL · Ohne Filter: $TEXTER_MODEL" || echo "ausgelassen")"
echo "  Spurtrennung (Demucs):     $( (( STEMS )) && echo 'wird eingerichtet (etwa 1 GB)' || echo 'später beim ersten Gebrauch')"
echo "  Meine Stimme (Applio):     $( (( VC )) && echo 'wird eingerichtet (etwa 17 GB)' || { (( VC_POSSIBLE )) && echo 'möglich, nicht gewählt (--full)' || echo 'nicht möglich auf diesem Rechner'; } )"
echo "  Modell-Download:           etwa ${NEED_GB} GB · frei: ${FREE_GB} GB"
(( FREE_GB >= NEED_GB + 4 )) || abbruch "Zu wenig Platz: ${FREE_GB} GB frei, etwa $(( NEED_GB + 4 )) GB nötig."
if [[ "$AUTO" != 1 && "$DRY" != 1 ]]; then
  echo ""
  echo "  Sprachmodell ändern? 1) 0.6B (0,7 GB)  2) 1.7B (2 GB)  3) 4B (4,5 GB)"
  read -r -p "  Auswahl [Enter = $LM_SIZE]: " a
  case "$a" in 1) LM_SIZE=0.6B ;; 2) LM_SIZE=1.7B ;; 3) LM_SIZE=4B ;; esac
  LM_FILE="acestep-5Hz-lm-${LM_SIZE}-Q8_0.gguf"
  WANT=(vae-BF16.gguf Qwen3-Embedding-0.6B-Q8_0.gguf acestep-v15-sft-Q8_0.gguf "$LM_FILE"); (( XL )) && WANT+=("$XL_FILE"); (( XL_BF16 )) && WANT+=("$XL16_FILE")
  (( VC_POSSIBLE && !VC )) && { ja "  „Meine Stimme“ (Stimm-Umwandlung mit Applio, etwa 17 GB, dauert lange) mit einrichten?" n && VC=1; }
  ja "  So installieren?" || abbruch "Abgebrochen."
fi

# ---------------------------------------------------------------- 5. Pakete
schritt "5. Werkzeuge und Pakete ($PM)"
PKGS=()
case "$PM" in
  apt)
    PKGS=(build-essential cmake ninja-build git curl pkg-config libcurl4-openssl-dev lsof xdg-utils ca-certificates pciutils)
    [[ "$BACKEND" == vulkan ]] && PKGS+=(libvulkan-dev mesa-vulkan-drivers glslc libshaderc-dev spirv-headers)
    [[ "$BACKEND" == cuda ]] && (( !HAS_NVCC )) && PKGS+=(nvidia-cuda-toolkit) ;;
  pacman)
    PKGS=(base-devel cmake git curl lsof xdg-utils pciutils)
    if [[ "$BACKEND" == vulkan ]]; then
      PKGS+=(vulkan-headers spirv-headers shaderc vulkan-icd-loader)
      (( HAS_AMD )) && PKGS+=(vulkan-radeon); (( HAS_INTEL )) && PKGS+=(vulkan-intel); (( HAS_NVIDIA )) && PKGS+=(nvidia-utils)
    fi
    [[ "$BACKEND" == rocm ]] && (( !HAS_ROCM )) && PKGS+=(rocm-hip-sdk)
    [[ "$BACKEND" == cuda ]] && (( !HAS_NVCC )) && PKGS+=(cuda) ;;
  dnf)
    PKGS=(gcc gcc-c++ cmake ninja-build git curl pkgconf-pkg-config libcurl-devel lsof xdg-utils pciutils)
    [[ "$BACKEND" == vulkan ]] && PKGS+=(vulkan-headers vulkan-loader-devel glslc shaderc-devel spirv-headers-devel mesa-vulkan-drivers) ;;
  zypper)
    PKGS=(gcc gcc-c++ cmake ninja git curl pkgconf lsof xdg-utils pciutils libcurl-devel)
    [[ "$BACKEND" == vulkan ]] && PKGS+=(vulkan-devel shaderc spirv-headers) ;;
esac
if [[ "$PM" != none ]] && ((${#PKGS[@]})); then
  hinweis "Pakete: ${PKGS[*]}"
  if [[ "$DRY" == 1 ]]; then echo "  PLAN: Pakete mit $PM installieren"
  elif ja "  Fehlende Pakete jetzt mit sudo installieren?"; then
    case "$PM" in
      apt) sudo_tun apt-get update; sudo_tun apt-get install -y "${PKGS[@]}" ;;
      pacman) sudo_tun pacman -S --needed --noconfirm "${PKGS[@]}" ;;
      dnf) sudo_tun dnf install -y "${PKGS[@]}" ;;
      zypper) sudo_tun zypper --non-interactive install "${PKGS[@]}" ;;
    esac
  else hinweis "Übersprungen. Fehlt etwas, bricht der Bau des Modellservers ab (data/build.log)."
  fi
fi
for t in git cmake curl; do command -v "$t" >/dev/null 2>&1 || [[ "$DRY" == 1 ]] || abbruch "$t fehlt."; done
if ! command -v uv >/dev/null 2>&1; then
  hinweis "uv (Python-Umgebung) wird installiert (https://astral.sh/uv) …"
  if [[ "$DRY" == 1 ]]; then echo "  PLAN: curl -LsSf https://astral.sh/uv/install.sh | sh"; else curl -LsSf https://astral.sh/uv/install.sh | sh || abbruch "uv ließ sich nicht installieren."; export PATH="$HOME/.local/bin:$PATH"; fi
fi
if [[ "$DRY" != 1 ]]; then
  hinweis "Python-Pakete der App (uv sync) …"
  uv sync --quiet --python 3.12 2>/dev/null || uv sync --quiet || abbruch "Python-Pakete ließen sich nicht installieren."
fi

# ---------------------------------------------------------------- 6. Modellserver bauen (acestep.cpp, feste getestete Version)
schritt "6. Modellserver acestep.cpp (${ACESTEP_REV:0:7}, $BACKEND)"
mkdir -p "$ROOT/engine" "$DATA"
BUILD_DIR="${ENGINE:?}/build"
if [[ "$DRY" == 1 ]]; then
  echo "  PLAN: git clone $ACESTEP_REPO engine/acestep.cpp @ ${ACESTEP_REV:0:7}, cmake mit Backend $BACKEND"
else
  if [[ ! -d "$ENGINE/.git" ]]; then
    if [[ -e "$ENGINE" ]]; then ( cd "$ENGINE" && git init -q && git remote add origin "$ACESTEP_REPO" ) || abbruch "engine/acestep.cpp ist kein Git-Klon."
    else git clone --quiet "$ACESTEP_REPO" "$ENGINE" || abbruch "acestep.cpp ließ sich nicht laden."; fi
  fi
  ( cd "$ENGINE" && { git cat-file -e "$ACESTEP_REV^{commit}" 2>/dev/null || git fetch --quiet origin; } \
    && git checkout --quiet --force "$ACESTEP_REV" && git submodule update --init --recursive --quiet ) || abbruch "Konnte nicht auf Version ${ACESTEP_REV:0:7} wechseln."
  BUILD=1
  if [[ -x "$BUILD_DIR/ace-server" ]] && "$BUILD_DIR/ace-server" --help 2>&1 | head -1 | grep -q "${ACESTEP_REV:0:7}"; then
    # Gleiche Version schon gebaut, aber mit demselben Backend?
    want="$BACKEND"; have=cpu
    if [[ -f "$BUILD_DIR/CMakeCache.txt" ]]; then
      grep -qx 'GGML_CUDA:BOOL=ON' "$BUILD_DIR/CMakeCache.txt" && have=cuda
      grep -qx 'GGML_VULKAN:BOOL=ON' "$BUILD_DIR/CMakeCache.txt" && have=vulkan
      grep -qx 'GGML_HIP:BOOL=ON' "$BUILD_DIR/CMakeCache.txt" && have=rocm
    fi
    [[ "$have" == "$want" ]] && BUILD=0
  fi
  if (( BUILD )); then
    FLAGS=(-DCMAKE_BUILD_TYPE=Release -DGGML_CPU_ALL_VARIANTS=OFF)
    case "$BACKEND" in
      cuda)   FLAGS+=(-DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER="$(command -v nvcc)" -DCMAKE_CUDA_ARCHITECTURES=native) ;;
      rocm)   [[ -d /opt/rocm/bin ]] && export PATH="/opt/rocm/bin:$PATH"; FLAGS+=(-DGGML_HIP=ON); [[ -n "$AMD_GFX" ]] && FLAGS+=(-DAMDGPU_TARGETS="$AMD_GFX") ;;
      vulkan) FLAGS+=(-DGGML_VULKAN=ON) ;;
      cpu)    FLAGS+=(-DGGML_NATIVE=ON) ;;
    esac
    hinweis "Baue (Backend $BACKEND, $CORES Kerne, dauert einige Minuten; Log: data/build.log) …"
    rm -rf "${BUILD_DIR:?}"
    if ! ( cd "$ENGINE" && cmake -S . -B build "${FLAGS[@]}" && cmake --build build --config Release -j "$CORES" ) > "$DATA/build.log" 2>&1; then
      echo "  Bau mit $BACKEND fehlgeschlagen (data/build.log). Letzte Zeilen:"; tail -n 8 "$DATA/build.log" | sed 's/^/    /'
      if [[ "$BACKEND" != cpu ]] && ja "  Stattdessen nur für den Prozessor bauen (langsam, aber es geht)?"; then
        BACKEND=cpu
        rm -rf "${BUILD_DIR:?}"
        ( cd "$ENGINE" && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON && cmake --build build --config Release -j "$CORES" ) > "$DATA/build.log" 2>&1 || abbruch "Auch der CPU-Bau scheiterte (data/build.log)."
      else abbruch "Bau fehlgeschlagen."; fi
    fi
  fi
  [[ -x "$BUILD_DIR/ace-server" ]] || abbruch "ace-server fehlt nach dem Bau."
  hinweis "ace-server: $("$BUILD_DIR/ace-server" --help 2>&1 | head -1)"
fi

# ---------------------------------------------------------------- 7. Modelle (fortsetzbar, SHA-256 geprüft)
schritt "7. Modelle"
mkdir -p "${MODELS:?}"
for f in "${WANT[@]}"; do
  rec=$(printf '%s\n' "$MODEL_FILES" | grep -F "$f:" | head -n 1); [[ -n "$rec" ]] || abbruch "Keine Prüfsumme für $f in scripts/common.sh."
  IFS=: read -r _ mb sha <<< "$rec"
  if [[ -f "$MODELS/$f" ]]; then hinweis "✓ $f"; continue; fi
  if [[ "$DRY" == 1 ]]; then echo "  PLAN: $f laden ($mb MB) und prüfen"; continue; fi
  hinweis "↓ $f ($mb MB)"
  PART="${MODELS:?}/${f:?}.part"
  curl -L --fail -C - --retry 3 --progress-bar -o "$PART" "$HF_BASE/$f" || abbruch "Download von $f fehlgeschlagen. Erneut starten setzt fort."
  if [[ "$(sha256_of "$PART")" != "$sha" ]]; then rm -f "${PART:?}"; abbruch "Prüfsumme von $f stimmt nicht; Datei gelöscht, bitte erneut starten."; fi
  mv "$PART" "$MODELS/$f"
done

# ---------------------------------------------------------------- 8. Selbsttest und Konfiguration
schritt "8. Selbsttest und Konfiguration"
OLD_MODE=""; OLD_LM=""; OLD_REV=""; OLD_DEVICE=""
[[ -f "$CONF" ]] && { OLD_MODE=$(sed -n 's/^MODE=//p' "$CONF" | tail -1); OLD_LM=$(sed -n 's/^LM_FILE=//p' "$CONF" | tail -1); OLD_REV=$(sed -n 's/^TESTED_REV=//p' "$CONF" | tail -1); OLD_DEVICE=$(sed -n 's/^LM_DEVICE=//p' "$CONF" | tail -1); }
MODE=single
if [[ "$DRY" == 1 ]]; then echo "  PLAN: Probelauf des Sprachmodells auf Port 8099, dann data/engine.conf schreiben"
elif [[ -n "$OLD_MODE" && "$OLD_LM" == "$LM_FILE" && "${OLD_REV:0:7}" == "${ACESTEP_REV:0:7}" ]]; then MODE="$OLD_MODE"; hinweis "schon getestet: Modus $MODE"
elif [[ "$BACKEND" == cpu ]]; then hinweis "Prozessor-Backend: kein Grafiktest nötig"
else
  for p in "$SYNTH_PORT" "$LM_PORT"; do laeuft "$p" && { hinweis "Server auf Port $p läuft noch, wird für den Test beendet"; kill $(port_pids "$p") 2>/dev/null || true; }; done
  sleep 1
  TEST_PORT=8099; laeuft "$TEST_PORT" && abbruch "Port $TEST_PORT ist belegt, bitte später erneut versuchen."
  TEST_ARGS=(--host 127.0.0.1 --port "$TEST_PORT" --models "$MODELS" --max-batch 1); [[ -n "$VAE_CHUNK" ]] && TEST_ARGS+=(--vae-chunk "$VAE_CHUNK")
  "$BUILD_DIR/ace-server" "${TEST_ARGS[@]}" > "$DATA/selftest.log" 2>&1 & TEST_PID=$!
  for _ in $(seq 1 120); do curl -s "http://127.0.0.1:$TEST_PORT/health" >/dev/null && break; kill -0 "$TEST_PID" 2>/dev/null || break; sleep 0.5; done
  hinweis "Probelauf des Sprachmodells auf der Grafikkarte (1-2 Minuten) …"
  if uv run python scripts/metal_selftest.py "$TEST_PORT" "$LM_FILE"; then MODE=single; else MODE=split; hinweis "Sprachmodell rechnet auf dem Prozessor (Modus split)."; fi
  kill "$TEST_PID" 2>/dev/null || true; wait "$TEST_PID" 2>/dev/null || true
fi
if [[ "$DRY" != 1 ]]; then
  { echo "MODE=$MODE"; echo "LM_FILE=$LM_FILE"; echo "TESTED_REV=$ACESTEP_REV"; echo "VAE_CHUNK=$VAE_CHUNK"; echo "BACKEND=$BACKEND"
    echo "LYRICS_MODEL=$LYRICS_MODEL"; echo "TEXTER_MODEL=$TEXTER_MODEL"; [[ "$OLD_DEVICE" == cpu ]] && echo "LM_DEVICE=cpu"; } > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
  hinweis "data/engine.conf geschrieben (Modus $MODE, Backend $BACKEND)."
fi

# ---------------------------------------------------------------- 9. Songtexter: Ollama und Textmodelle
schritt "9. Songtexter (Ollama)"
if (( !OLLAMA )); then hinweis "ausgelassen"
else
  if ! command -v ollama >/dev/null 2>&1; then
    if [[ "$DRY" == 1 ]]; then echo "  PLAN: curl -fsSL https://ollama.com/install.sh | sh"
    elif ja "  Ollama installieren (offizielles Skript, braucht sudo)?"; then curl -fsSL https://ollama.com/install.sh | sh || hinweis "Ollama ließ sich nicht installieren; der Songtexter bleibt aus."
    fi
  fi
  if command -v ollama >/dev/null 2>&1 && [[ "$DRY" != 1 ]]; then
    ollama_starten
    for m in "$LYRICS_MODEL" "$TEXTER_MODEL"; do
      [[ -n "$m" ]] || continue
      if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then hinweis "✓ $m"; continue; fi
      hinweis "↓ $m (kann dauern) …"; ollama pull "$m" || hinweis "$m ließ sich nicht laden; in der App unter Zahnrad › Texter ein anderes Modell wählen."
    done
  elif [[ "$DRY" == 1 ]]; then echo "  PLAN: ollama pull $LYRICS_MODEL · ollama pull $TEXTER_MODEL"
  fi
fi

# ---------------------------------------------------------------- 10. Studio: Spurtrennung (Demucs, Prozessor) und „Meine Stimme“ (Applio)
schritt "10. Studio-Werkzeuge"
STEMS_ENV="$ROOT/engine/stems"
if (( STEMS )); then
  if [[ -x "$STEMS_ENV/bin/python" ]]; then hinweis "✓ Spurtrennung ist eingerichtet"
  elif [[ "$DRY" == 1 ]]; then echo "  PLAN: Demucs-Umgebung in engine/stems (Torch für den Prozessor, etwa 1 GB) und Modell htdemucs laden"
  else
    hinweis "Spurtrennung einrichten (etwa 1 GB) …"
    PKG_LIST=$(uv run python -c 'from app.studio import STEMS_PACKAGES; print(" ".join(STEMS_PACKAGES))')
    # shellcheck disable=SC2086
    uv venv --quiet --python 3.11 "$STEMS_ENV" && uv pip install --quiet --python "$STEMS_ENV/bin/python" --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu $PKG_LIST \
      && TORCH_HOME="$STEMS_ENV/torch" "$STEMS_ENV/bin/python" -c 'from demucs.pretrained import get_model; get_model("htdemucs")' \
      || hinweis "Spurtrennung ließ sich nicht vorbereiten; die App versucht es beim ersten Gebrauch erneut."
  fi
else hinweis "Spurtrennung: später beim ersten Gebrauch"
fi
if (( VC )); then
  if [[ -x "$ROOT/engine/vc/env/bin/python" && -f "$ROOT/engine/vc/applio/core.py" ]]; then hinweis "✓ Meine Stimme ist eingerichtet"
  elif [[ "$DRY" == 1 ]]; then echo "  PLAN: scripts/vc_setup.sh (Applio, PyTorch für $GPU_KIND, etwa 17 GB)"
  else
    IDX="https://download.pytorch.org/whl/cu128"; (( HAS_AMD )) && IDX="https://download.pytorch.org/whl/rocm6.4"
    hinweis "Meine Stimme einrichten (Applio, etwa 17 GB, dauert lange) …"
    TORCH_INDEX="$IDX" bash "$ROOT/scripts/vc_setup.sh" || hinweis "Meine Stimme ließ sich nicht einrichten (scripts/vc_setup.sh später erneut ausführen)."
  fi
fi

# ---------------------------------------------------------------- 11. Startbefehl und Menüeintrag
schritt "11. Startbefehl „musik“ und Menüeintrag"
if [[ "$DRY" == 1 ]]; then echo "  PLAN: ~/.local/bin/musik und ~/.local/share/applications/music-generator.desktop anlegen"
else
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
  ln -sf "$ROOT/musik.sh" "$HOME/.local/bin/musik"; chmod +x "$ROOT/musik.sh" "$ROOT/arch_linux.sh" "$ROOT"/*.sh 2>/dev/null || true
  cat > "$HOME/.local/share/applications/music-generator.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Music Generator
Comment=EdgeBird-Lab Music Generator starten (Modellserver und Web-App)
Exec=bash -c '"$ROOT/musik.sh" start'
Icon=$ROOT/assets/icon-on.png
Terminal=true
Categories=AudioVideo;Audio;Music;
DESK
  hinweis "Befehl: musik start | stop | neustart | status  (falls ~/.local/bin nicht im PATH ist: $ROOT/musik.sh)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
if [[ "$DRY" == 1 ]]; then echo "  Probelauf beendet. Ohne --dry-run wird so installiert."
else echo "  Fertig. Starten: musik start (oder ./install.sh --start), Beenden: musik stop"; fi
echo "═══════════════════════════════════════════════════════════"
if [[ "$DRY" != 1 && "$START" == 1 ]]; then exec "$0" --start; fi
