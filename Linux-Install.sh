#!/bin/bash
# Music Generator (EdgeBird-Lab) – Installer für Linux, alle Distributionen: siehe install.sh
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SOURCE_DIR/install.sh" --no-start "$@"
