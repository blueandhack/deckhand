#!/usr/bin/env bash
# Build DeckhandBLE.app from YOUR node install.
#
# Why this exists: on macOS, a bare `node` process is killed outright by the
# TCC privacy framework the instant it touches Bluetooth, because it has no
# Info.plist declaring an NSBluetoothAlwaysUsageDescription. Wrapping node in
# a tiny app bundle (whose executable *is* a copy of node) gives it that
# Info.plist, so macOS shows a normal permission dialog instead of crashing.
# See the README "Why an app bundle?" section.
#
# The bundle embeds a copy of node, so it is machine-specific and is NOT
# checked into git - everyone builds their own with this script. Re-run it
# after `brew upgrade node` (or any node upgrade) to refresh the copy.
#
# The signature is ad-hoc (`codesign --sign -`). Ad-hoc signatures do NOT
# expire - there is no 7-day clock here (that's a different thing, free Apple
# Developer *provisioning profiles* for sideloaded iOS apps). You only re-sign
# when the bundle's contents change, which this script does for you.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH. Install Node.js (e.g. 'brew install node') first." >&2
  exit 1
fi

# process.execPath is the fully-resolved absolute path to the node binary -
# portable across Homebrew (Intel & Apple Silicon), the official pkg, nvm, etc.
NODE="$(node -e 'process.stdout.write(process.execPath)')"
APP="DeckhandBLE.app"

echo "Building $APP from $NODE"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp DeckhandBLE.plist "$APP/Contents/Info.plist"
cp "$NODE" "$APP/Contents/MacOS/Deckhand"
# App icon (Info.plist references Deckhand.icns via CFBundleIconFile).
# The `|| true` is load-bearing under `set -e`: a bare `[ -f x ] && cp` is itself the
# last command of the line, so a MISSING icon makes the line return 1 and aborts the
# whole build with no message. The icon is cosmetic; it must never stop the bundle.
if [ -f Deckhand.icns ]; then cp Deckhand.icns "$APP/Contents/Resources/Deckhand.icns"; fi

# Copy any @rpath-linked dylibs node needs (Homebrew's node links
# libnode.<ver>.dylib dynamically; statically-linked node installs have none,
# in which case this loop simply finds nothing and that's fine).
NODE_LIBDIR="$(dirname "$NODE")/../lib"
for lib in $(otool -L "$NODE" | awk '/@rpath\/lib/{print $1}' | sed 's|@rpath/||'); do
  if [ -f "$NODE_LIBDIR/$lib" ]; then
    cp "$NODE_LIBDIR/$lib" "$APP/Contents/MacOS/$lib"
    echo "  bundled $lib"
  else
    echo "  warning: could not find $lib near node; BLE may fail to launch" >&2
  fi
done

codesign --force --deep --sign - "$APP"
echo "Done. Run the host with:"
echo "  open \"$(pwd)/$APP\" --args \"$(pwd)/index.mjs\""
