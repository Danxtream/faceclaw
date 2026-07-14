#!/bin/bash
# Push a shared-preferences file to faceclaw on the attached device.
# Usage: push_config.sh [input-file]   (default: faceclaw_settings.xml)
# Validates the XML, force-stops the app (so a running instance doesn't
# overwrite the pushed file from its in-memory prefs), then installs it.
set -euo pipefail

PACKAGE=com.faceclaw.app
PREFS=shared_prefs/faceclaw_settings.xml
IN="${1:-faceclaw_settings.xml}"
STAGE=/data/local/tmp/faceclaw_settings_push.xml

if [ ! -f "$IN" ]; then
    echo "Error: $IN not found" >&2
    exit 1
fi

if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "$IN"
elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$IN"
else
    echo "Error: need xmllint or python3 to validate XML" >&2
    exit 1
fi

adb shell am force-stop "$PACKAGE"
adb push "$IN" "$STAGE"
adb shell run-as "$PACKAGE" cp "$STAGE" "$PREFS"
adb shell rm "$STAGE"
echo "Pushed $IN to $PREFS (app was force-stopped; relaunch it to pick up the new settings)"
