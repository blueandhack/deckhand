#!/usr/bin/env bash
# Regenerate Deckhand.icns from docs/logo.svg (macOS only - uses the built-in
# QuickLook renderer, sips, and iconutil; no extra installs). Run this after
# editing the logo. build-app.sh copies the resulting .icns into the bundle.
set -euo pipefail
cd "$(dirname "$0")"
SVG="../docs/logo.svg"
TMP="$(mktemp -d)"
ICONSET="$TMP/Deckhand.iconset"
mkdir -p "$ICONSET"

qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1
SRC="$TMP/logo.svg.png"
[ -f "$SRC" ] || { echo "QuickLook failed to render $SVG" >&2; exit 1; }

for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  sips -z "$((sz*2))" "$((sz*2))" "$SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o Deckhand.icns
cp "$SRC" ../docs/logo.png
rm -rf "$TMP"
echo "Wrote host/Deckhand.icns and docs/logo.png from $SVG"
