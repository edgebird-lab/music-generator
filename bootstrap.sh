#!/usr/bin/env bash
# Music Generator (EdgeBird-Lab) · Ein-Zeilen-Installation für Linux
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/edgebird-lab/music-generator/main/bootstrap.sh)
#
# Holt die neueste Veröffentlichung nach ~/MusicGenerator (anderer Ordner: MUSIC_GENERATOR_DIR=/pfad davor setzen) und startet
# den Installer install.sh, der Hardware prüft, Modelle wählt und alles einrichtet. Optionen werden durchgereicht, z. B. --yes.
set -Eeuo pipefail
REPO="https://github.com/edgebird-lab/music-generator.git"
DIR="${MUSIC_GENERATOR_DIR:-$HOME/MusicGenerator}"
command -v git >/dev/null 2>&1 || { echo "git fehlt. Bitte erst installieren, zum Beispiel: sudo apt install git  (Arch: sudo pacman -S git)"; exit 1; }
if [ -d "$DIR/.git" ]; then
  echo "▸ $DIR gibt es schon: hole die neueste Veröffentlichung"
  git -C "$DIR" fetch --quiet --force --tags origin
else
  echo "▸ Lade den Music Generator nach $DIR"
  git clone --quiet "$REPO" "$DIR"
  git -C "$DIR" fetch --quiet --force --tags origin
fi
latest=$(git -C "$DIR" tag -l 'v*' --sort=-v:refname | head -1)
if [ -n "$latest" ]; then
  echo "▸ Version $latest"
  git -C "$DIR" checkout --quiet -B main "refs/tags/$latest^{commit}"
fi
cd "$DIR"
exec ./install.sh "$@"
