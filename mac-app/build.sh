#!/usr/bin/env bash
# Build DeckhandMenuBar.app - a native menu-bar controller for the host.
# macOS only (needs the Swift toolchain from Xcode command-line tools).
# The built .app is machine-specific (it embeds this repo's host path) and is
# not committed; re-run this if you move the repo.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
HOSTDIR="$REPO/host"
APP="DeckhandMenuBar.app"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode command-line tools: xcode-select --install" >&2
  exit 1
fi

echo "Building $APP (host dir: $HOSTDIR)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O DeckhandMenuBar.swift -o "$APP/Contents/MacOS/DeckhandMenuBar" \
  -framework Cocoa -framework ServiceManagement

[ -f "$HOSTDIR/Deckhand.icns" ] && cp "$HOSTDIR/Deckhand.icns" "$APP/Contents/Resources/Deckhand.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>DeckhandMenuBar</string>
  <key>CFBundleIdentifier</key>
  <string>com.deckhand.menubar</string>
  <key>CFBundleName</key>
  <string>Deckhand</string>
  <key>CFBundleIconFile</key>
  <string>Deckhand</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>DeckhandHostDir</key>
  <string>$HOSTDIR</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
echo "Built $APP. Launch it with:  open \"$(pwd)/$APP\""
