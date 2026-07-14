#!/bin/bash
# Pull faceclaw's shared preferences off the attached device.
# Usage: pull_config.sh [output-file]   (default: faceclaw_settings.xml)
set -euo pipefail

PACKAGE=com.faceclaw.app
PREFS=shared_prefs/faceclaw_settings.xml
OUT="${1:-faceclaw_settings.xml}"

adb exec-out run-as "$PACKAGE" cat "$PREFS" > "$OUT"
echo "Pulled $PREFS to $OUT"
