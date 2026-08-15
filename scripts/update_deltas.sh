#!/usr/bin/env bash
#
# Build and verify the sibling g2flash custom firmware, then update Faceclaw's
# embedded copy of its byte-patch set.
#
# Usage:
#   scripts/update_deltas.sh
#
# Set G2FLASH_DIR to use a g2flash checkout somewhere other than ../g2flash.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FACECLAW_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
G2FLASH_DIR="${G2FLASH_DIR:-"$FACECLAW_DIR/../g2flash"}"
PATCH_JSON="$G2FLASH_DIR/patches/cfw_patches.json"
OUTPUT_TS="$FACECLAW_DIR/app/g2/firmware/cfw-patches.ts"

if [ ! -x "$G2FLASH_DIR/build_cfw.sh" ]; then
  echo "error: g2flash build script not found or not executable: $G2FLASH_DIR/build_cfw.sh" >&2
  exit 1
fi
if [ ! -f "$PATCH_JSON" ]; then
  echo "error: g2flash patch set not found: $PATCH_JSON" >&2
  exit 1
fi
PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" --version >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo "error: Python 3 is required" >&2
  exit 1
fi

echo "Building and verifying custom firmware in $G2FLASH_DIR..."
(
  cd "$G2FLASH_DIR"
  ./build_cfw.sh --skip-venv
)

"$PYTHON_BIN" - "$PATCH_JSON" "$OUTPUT_TS" <<'PY'
import json
import os
from pathlib import Path
import sys
import tempfile

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])

try:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    patch_set = {
        "base": source["base"],
        "baseSha256": source["base_sha256"],
        "outputSha256": source["output_sha256"],
        "patches": source["patches"],
    }
except (OSError, json.JSONDecodeError, KeyError) as error:
    raise SystemExit(f"error: cannot read g2flash patch set: {error}")

if not isinstance(patch_set["base"], str) or not isinstance(patch_set["patches"], list):
    raise SystemExit("error: g2flash patch set has invalid base or patches fields")

base_name = patch_set["base"]
version = base_name.removeprefix("g2_").removesuffix(".bin")
serialized = json.dumps(patch_set, indent=2, ensure_ascii=False)
generated = f"""// AUTO-GENERATED from g2flash/patches/cfw_patches.json — do not edit by hand.
// Regenerate with scripts/update_deltas.sh.
// Turns the stock G2 {version} image into the Faceclaw custom firmware.

export type FirmwarePatchOp = {{
  offset: number;
  old: string;
  new: string;
  desc?: string;
}};

export type FirmwarePatchSet = {{
  base: string;
  baseSha256: string;
  outputSha256: string;
  patches: FirmwarePatchOp[];
}};

export const CFW_PATCH_SET: FirmwarePatchSet = {serialized};
"""

try:
    current = output_path.read_text(encoding="utf-8")
except FileNotFoundError:
    current = None

if current == generated:
    print(f"Embedded patch set is already current ({len(patch_set['patches'])} patches).")
    raise SystemExit

output_path.parent.mkdir(parents=True, exist_ok=True)
mode = output_path.stat().st_mode & 0o777 if output_path.exists() else 0o644
temporary_name = None
try:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        delete=False,
    ) as temporary:
        temporary.write(generated)
        temporary_name = temporary.name
    os.chmod(temporary_name, mode)
    os.replace(temporary_name, output_path)
except OSError as error:
    if temporary_name is not None:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    raise SystemExit(f"error: cannot update embedded patch set: {error}")

print(f"Updated {output_path} from {source_path} ({len(patch_set['patches'])} patches).")
PY
