#!/usr/bin/env bash
# Regenerate the extension icons (toolbar + store/management sizes).
#
# Source of truth: src-tauri/icons/icon.png (512x512 macOS master). The
# master follows the macOS icon grid: the squircle artwork fills 412x412
# (80.5%) of the canvas, centered, with a transparent margin plus a faint
# drop-shadow falloff around it (measured via alpha scan, not assumed).
#
# Chrome surfaces need two different treatments, so this is two-track:
#   - Toolbar sizes (16, 32; action.default_icon): full-bleed. The master is
#     center-cropped to the squircle bounds (sips -c 412 412) and the crop is
#     downscaled, so the mark fills the canvas like neighboring extensions.
#   - Store/management sizes (48, 128): plain downscales of the uncropped
#     master. The store spec wants the artwork at ~75% of the canvas (96 in
#     128); the macOS margin (~81% fill) is close enough, and a plain
#     downscale preserves that padding.
#
# Idempotent: safe to re-run; outputs are overwritten in place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/src-tauri/icons/icon.png"
OUT="$ROOT/extension/public/icons"
CROP=412 # 512 * 0.805; measured opaque squircle bounds (alpha > 64)

mkdir -p "$OUT"

WORK="$(mktemp -d -t june-icon-crop)"
trap 'rm -rf "$WORK"' EXIT
sips -c "$CROP" "$CROP" "$SRC" --out "$WORK/squircle.png" >/dev/null

for size in 16 32; do
  sips -z "$size" "$size" "$WORK/squircle.png" --out "$OUT/icon-$size.png" >/dev/null
done

for size in 48 128; do
  sips -z "$size" "$size" "$SRC" --out "$OUT/icon-$size.png" >/dev/null
done

echo "wrote $OUT/icon-{16,32,48,128}.png (16/32 full-bleed from ${CROP}px crop, 48/128 plain downscales)"
