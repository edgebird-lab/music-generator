#!/usr/bin/env bash
# Kurzbefehl für den Music Generator: musik [start|stop|neustart|status]
# Der Installer (install.sh) legt ihn als ~/.local/bin/musik ab. start und stop kümmern sich auch um Ollama (den Songtexter).
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

ollama_stop() {   # Modelle entladen, damit der Grafikspeicher frei wird; der Dienst selbst darf weiterlaufen
  command -v ollama >/dev/null 2>&1 || return 0
  local modell
  while read -r modell; do ollama stop "$modell" >/dev/null 2>&1 || true; done < <(ollama ps 2>/dev/null | awk 'NR>1 {print $1}')
}

case "${1:-start}" in
  start)    exec bash "$ROOT/install.sh" --start ;;
  stop)     bash "$ROOT/install.sh" --stop; ollama_stop ;;
  neustart) bash "$ROOT/install.sh" --stop; ollama_stop; exec bash "$ROOT/install.sh" --start ;;
  status)   exec bash "$ROOT/install.sh" --status ;;
  *)        echo "Benutzung: musik [start|stop|neustart|status]" >&2; exit 2 ;;
esac
