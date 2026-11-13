#!/usr/bin/env bash
# Build the released Deckhand.app: menu bar + host + its own Node, signed, notarized,
# in a DMG, with a Sparkle appcast. Stops BEFORE publishing (that is publish.sh).
#
#   release/build-release.sh <version>                  full build, notarized
#   release/build-release.sh <version> --no-notarize    everything but Apple's step,
#                                                       for a local test of the bundle
#   release/build-release.sh <version> --working-tree   build the working tree, uncommitted
#                                                       changes and all (testing only)
#
# By default the build is made from `git archive HEAD`, so a release is exactly a
# commit: uncommitted edits and untracked files (an in-progress module next to
# index.mjs) cannot leak into it.
#
# One-time setup (see docs/reference/release.md):
#   xcrun notarytool store-credentials deckhand-notary --team-id GJFJF2K2L3 --apple-id <you>
#   release/.cache/sparkle-*/bin/generate_keys      then paste the public key into
#                                                   release/sparkle-public-key.txt
#
# WHY A STANDALONE NODE. host/build-app.sh copies YOUR node into DeckhandBLE.app,
# and Homebrew's node links ~90 Homebrew libraries by absolute path - one
# `brew upgrade simdjson` (2026-11-06) left that bundle unable to launch. The
# official nodejs.org build links only system libraries, and the `otool` check
# below fails this build if anything in the bundle ever links outside it again.
set -euo pipefail

VERSION="${1:-}"
shift || true
NOTARIZE=1
WORKING_TREE=0
CHANNEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-notarize) NOTARIZE=0 ;;
    --working-tree) WORKING_TREE=1 ;;
    # --channel alpha|beta: a PRE-RELEASE. The version stays x.y.z (CFBundleShort-
    # VersionString must be digits); the channel is stamped into Info.plist as
    # DeckhandChannel, so About says "0.1.0 alpha", and publish.sh marks the GitHub
    # release as a pre-release.
    --channel) shift; CHANNEL="${1:-}"; [[ "$CHANNEL" =~ ^(alpha|beta)$ ]] || { echo "--channel takes alpha or beta" >&2; exit 2; } ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z> [--channel alpha|beta] [--no-notarize] [--working-tree]" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
R="$REPO/release"
CACHE="$R/.cache"
BUILD="$R/build"
DIST="$R/dist/$VERSION"

# ---- pinned inputs. Change a version AND its hash together, never one alone. ----
NODE_VERSION="v26.13.0"   # first Node 26 LTS; also what the dev host runs
NODE_SHA256="d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6"
SPARKLE_VERSION="2.10.1"
SPARKLE_SHA256="1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27"

IDENTITY="${DECKHAND_SIGN_ID:-Developer ID Application: Yujia Lin (GJFJF2K2L3)}"
NOTARY_PROFILE="${DECKHAND_NOTARY_PROFILE:-deckhand-notary}"
# THE FEED IS A FILE IN THE REPO, not a release asset. It used to be
# releases/latest/download/appcast.xml, but GitHub's "latest" SKIPS PRE-RELEASES, so an
# alpha published with the pre-release badge would have left every installed alpha with
# no feed at all. This address is built into every copy shipped and cannot change for
# them later; publish.sh commits the newest appcast here after each release.
FEED_URL="https://raw.githubusercontent.com/blueandhack/deckhand/main/release/appcast.xml"
DOWNLOAD_PREFIX="https://github.com/blueandhack/deckhand/releases/download/v$VERSION/"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cd "$REPO"

# ---- 0. preconditions ----
say "Checking preconditions"
DIRTY=0
git diff --quiet HEAD && [ -z "$(git ls-files --others --exclude-standard host claude-hooks mac-app)" ] || DIRTY=1
if [ "$WORKING_TREE" = 1 ]; then
  COMMIT="$(git rev-parse --short HEAD)$([ "$DIRTY" = 1 ] && echo "-dirty" || true)"
else
  COMMIT="$(git rev-parse --short HEAD)"
  [ "$DIRTY" = 0 ] || echo "note: building HEAD ($COMMIT) - uncommitted changes and untracked files are NOT included"
fi
# CFBundleVersion: the commit count on this branch only ever rises, which is the one
# property Sparkle needs to order two builds.
BUILD_NUMBER="$(git rev-list --count HEAD)"
# TEST-ONLY overrides, for an end-to-end Sparkle run on one machine: two working-tree
# builds of one commit share a build number (so Sparkle sees no update between them),
# and the real feed is GitHub's. Refused outside --working-tree, so a release is
# always numbered by its commit and always points at the real feed.
if [ -n "${DECKHAND_BUILD_NUMBER:-}${DECKHAND_FEED_URL:-}" ]; then
  [ "$WORKING_TREE" = 1 ] || die "DECKHAND_BUILD_NUMBER / DECKHAND_FEED_URL are for --working-tree test builds only"
  BUILD_NUMBER="${DECKHAND_BUILD_NUMBER:-$BUILD_NUMBER}"
  FEED_URL="${DECKHAND_FEED_URL:-$FEED_URL}"
  echo "note: TEST overrides - build $BUILD_NUMBER, feed $FEED_URL"
fi
SU_PUBLIC_KEY=""
[ -f "$R/sparkle-public-key.txt" ] && SU_PUBLIC_KEY="$(tr -d '[:space:]' < "$R/sparkle-public-key.txt")"
# DECKHAND_TEST_SU_KEY lets a --no-notarize TEST build run before the real key exists.
# A notarized build with it is refused: a release carrying a placeholder key could
# never be updated, and nothing would say so until the next release failed to install.
if [ -z "$SU_PUBLIC_KEY" ] && [ -n "${DECKHAND_TEST_SU_KEY:-}" ]; then
  [ "$NOTARIZE" = 0 ] || die "DECKHAND_TEST_SU_KEY is for --no-notarize test builds only"
  SU_PUBLIC_KEY="$DECKHAND_TEST_SU_KEY"
  echo "note: TEST Sparkle key - this build cannot be updated by a real release"
fi
[ -n "$SU_PUBLIC_KEY" ] || die "release/sparkle-public-key.txt is missing or empty - run Sparkle's generate_keys once (docs/reference/release.md)"
# The file holds the bare key that `generate_keys -p` prints, nothing else. Pasting the
# <key>/<string> snippet generate_keys suggests would land INSIDE Info.plist's <string>,
# and every update would then fail signature checks. An Ed25519 key is 32 bytes = 44
# base64 characters ending in one '='. A real release must also match the keychain.
[[ "$SU_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || [ -n "${DECKHAND_TEST_SU_KEY:-}" ] \
  || die "release/sparkle-public-key.txt must hold ONLY the 44-character key (generate_keys -p), not the plist snippet"
security find-identity -v -p codesigning | grep -qF "$IDENTITY" || die "signing identity not found: $IDENTITY"
for t in swiftc clang codesign hdiutil xcrun; do command -v "$t" >/dev/null || die "$t not found"; done
echo "version $VERSION  build $BUILD_NUMBER  commit $COMMIT"

# ---- 1. pinned inputs ----
say "Fetching pinned inputs"
mkdir -p "$CACHE"
fetch() { # url file sha256
  local url="$1" f="$CACHE/$2" sum="$3"
  if [ ! -f "$f" ]; then
    curl -fL --retry 3 -o "$f.part" "$url"
    mv "$f.part" "$f"
  fi
  echo "$sum  $f" | shasum -a 256 -c - >/dev/null || { rm -f "$f"; die "checksum mismatch for $2 - deleted, re-run to fetch again"; }
  echo "  $2 ok"
}
NODE_TGZ="node-$NODE_VERSION-darwin-arm64.tar.gz"
fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ" "$NODE_TGZ" "$NODE_SHA256"
fetch "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" \
  "Sparkle-$SPARKLE_VERSION.tar.xz" "$SPARKLE_SHA256"
NODE_DIR="$CACHE/node-$NODE_VERSION-darwin-arm64"
SPARKLE_DIR="$CACHE/sparkle-$SPARKLE_VERSION"
[ -x "$NODE_DIR/bin/node" ] || tar xzf "$CACHE/$NODE_TGZ" -C "$CACHE"
[ -d "$SPARKLE_DIR/Sparkle.framework" ] || { mkdir -p "$SPARKLE_DIR"; tar xJf "$CACHE/Sparkle-$SPARKLE_VERSION.tar.xz" -C "$SPARKLE_DIR"; }
# A real release: the key baked into Info.plist must be the one generate_appcast will
# sign with (the private half in this Mac's login keychain), or every install of this
# version rejects every future update - and nothing says so until that update ships.
if [ "$NOTARIZE" = 1 ]; then
  KC_KEY="$("$SPARKLE_DIR/bin/generate_keys" -p 2>/dev/null | tr -d '[:space:]')" || KC_KEY=""
  [ "$KC_KEY" = "$SU_PUBLIC_KEY" ] || die "release/sparkle-public-key.txt does not match the Sparkle private key in this Mac's keychain (generate_keys -p)"
fi

rm -rf "$BUILD/app" "$DIST"
mkdir -p "$BUILD/app" "$DIST"

# NODE SHIPS STRIPPED OF ITS LOCAL SYMBOLS. `strip -x` measured 146,490,912 -> 108,807,392
# bytes on v26.13.0 (-37.7MB, a quarter of the whole app). It keeps the EXPORTED symbols,
# which are what a native addon resolves against when it loads - so the smoke test below
# runs THIS binary, not the tarball's, and an addon that needed a stripped symbol fails
# the build instead of a user's Mac. strip voids the signature and arm64 will not run an
# unsigned binary, so it is ad-hoc signed here; step 6 re-signs it with the real identity.
SHIP_NODE="$BUILD/app/node"
cp "$NODE_DIR/bin/node" "$SHIP_NODE"
strip -x "$SHIP_NODE" 2>/dev/null
codesign --force --sign - "$SHIP_NODE"
[ "$("$SHIP_NODE" -p process.version)" = "$NODE_VERSION" ] || die "the stripped Node does not run"

# SRC is what gets built: the commit, or (--working-tree) the checkout as it stands.
if [ "$WORKING_TREE" = 1 ]; then
  SRC="$REPO"
else
  SRC="$BUILD/app/src"
  mkdir -p "$SRC"
  git archive HEAD host claude-hooks mac-app | tar -x -C "$SRC"
fi

# ---- 2. stage the host ----
say "Staging the host (npm ci with the bundled Node)"
STAGE="$BUILD/app/stage-host"
mkdir -p "$STAGE"
cp "$SRC/host/package.json" "$SRC/host/package-lock.json" "$SRC/host/whisper-prompt.txt" "$STAGE/"
# An ALLOWLIST by naming rule: every runtime module, none of the checkers or tests.
for f in "$SRC"/host/*.mjs; do
  b="$(basename "$f")"
  case "$b" in *-check.mjs|test-*.mjs) ;; *) cp "$f" "$STAGE/" ;; esac
done
# The tarball's own npm and node, so native addons compile against the Node we ship.
# (Both are N-API today - ABI-stable - but building against the shipped headers
# keeps that true even if a dependency stops being N-API.)
( cd "$STAGE" && PATH="$NODE_DIR/bin:/usr/bin:/bin" npm ci --omit=dev --no-fund --no-audit --loglevel=error )
# Other platforms' prebuilt addons are dead weight; build intermediates likewise.
while IFS= read -r -d '' pb; do
  for p in "$pb"/*; do
    case "$(basename "$p")" in darwin-*) ;; *) rm -rf "$p" ;; esac
  done
done < <(find "$STAGE/node_modules" -type d -name prebuilds -print0)
find "$STAGE/node_modules" -type d \( -name obj.target -o -name .deps \) -prune -exec rm -rf {} +
# A smoke test of the staged tree with the shipped (stripped) Node. NOT `import noble`: that
# starts CoreBluetooth, and a Node with no Info.plist is killed by TCC on the spot
# (CLAUDE.md, "THE HOST MUST RUN VIA DeckhandBLE.app"). Loading noble's native addon
# through its own loader proves the same thing - the addon loads into this Node -
# without creating a Bluetooth manager. serialport is safe to import whole.
( cd "$STAGE" && "$SHIP_NODE" --input-type=module -e '
  import { createRequire } from "node:module";
  const require = createRequire(process.cwd() + "/");
  const nobleDir = require.resolve("@abandonware/noble/package.json").replace(/package\.json$/, "");
  const b = require("node-gyp-build")(nobleDir);
  if (typeof b.NobleMac !== "function") throw new Error("noble mac binding has no NobleMac");
  await import("serialport");
  console.log("  host modules load");' )
# Every import in the staged host must resolve in the staged tree - see the script.
"$SHIP_NODE" "$R/check-host-imports.mjs" "$STAGE" \
  || die "the staged host imports something the bundle does not contain - commit it, or add it to package.json"

# ---- 3. compile ----
say "Compiling"
BIN="$BUILD/app/bin"
mkdir -p "$BIN"
# Every file under mac-app/Sources, as one module (-wmo) - see mac-app/build.sh.
SWIFT_SOURCES=()
while IFS= read -r f; do SWIFT_SOURCES+=("$f"); done < <(find "$SRC/mac-app/Sources" -name '*.swift' | sort)
[ ${#SWIFT_SOURCES[@]} -gt 0 ] || die "no Swift sources under $SRC/mac-app/Sources"
swiftc -O -wmo -target arm64-apple-macos14.0 -D SPARKLE \
  -F "$SPARKLE_DIR" -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "${SWIFT_SOURCES[@]}" -o "$BIN/Deckhand" \
  -framework Cocoa -framework ServiceManagement 2>&1 | grep -E "error|warning: unre" || true
[ -x "$BIN/Deckhand" ] || die "swiftc failed"
clang -O2 -Wall -Werror -mmacosx-version-min=14.0 -arch arm64 -o "$BIN/deckhand-host-launch" "$R/host-launch.c"

# ---- 4. assemble ----
say "Assembling Deckhand.app"
APP="$BUILD/app/Deckhand.app"
C="$APP/Contents"
HC="$C/Helpers/Deckhand Host.app/Contents"
mkdir -p "$C/MacOS" "$C/Resources" "$C/Frameworks" "$C/Library/LaunchAgents" "$HC/MacOS" "$HC/Resources"
subst() { sed -e "s|@VERSION@|$VERSION|g" -e "s|@BUILD@|$BUILD_NUMBER|g" -e "s|@FEED_URL@|$FEED_URL|g" \
              -e "s|@SU_PUBLIC_KEY@|$SU_PUBLIC_KEY|g" -e "s|@COMMIT@|$COMMIT|g" -e "s|@CHANNEL@|$CHANNEL|g" -e "s|@ARGS@||g" "$1"; }
subst "$R/Info-app.plist" > "$C/Info.plist"
subst "$R/Info-host.plist" > "$HC/Info.plist"
subst "$R/agent.plist" > "$C/Library/LaunchAgents/io.github.blueandhack.deckhand.host.plist"
plutil -lint -s "$C/Info.plist" "$HC/Info.plist" "$C/Library/LaunchAgents/io.github.blueandhack.deckhand.host.plist"
cp "$BIN/Deckhand" "$C/MacOS/Deckhand"
mv "$SHIP_NODE" "$HC/MacOS/Deckhand Host"
cp "$BIN/deckhand-host-launch" "$HC/MacOS/deckhand-host-launch"
cp "$SRC/host/Deckhand.icns" "$C/Resources/Deckhand.icns"
cp "$SRC/host/Deckhand.icns" "$HC/Resources/Deckhand.icns"
mv "$STAGE" "$C/Resources/host"
mkdir -p "$C/Resources/hooks"
for f in deckhand-session-hook.mjs deckhand-statusline.mjs install-hooks.mjs \
         install-codex-hooks.mjs hook-command.mjs deckhand-backup.mjs \
         deckhand-antigravity-hook.mjs install-antigravity-hooks.mjs; do
  cp "$SRC/claude-hooks/$f" "$C/Resources/hooks/"
done
# Node's licence travels with Node.
cp "$NODE_DIR/LICENSE" "$C/Resources/NODE-LICENSE"
ditto "$SPARKLE_DIR/Sparkle.framework" "$C/Frameworks/Sparkle.framework"
# Sparkle's XPC services exist for SANDBOXED apps; this one is not (Sparkle's docs
# allow removing them), and each one kept is one more thing to sign and notarize.
rm -rf "$C/Frameworks/Sparkle.framework/Versions/B/XPCServices" "$C/Frameworks/Sparkle.framework/XPCServices"

# ---- 5. nothing may link outside the bundle ----
say "Checking every Mach-O links only system libraries or the bundle"
BAD=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q "Mach-O" || continue
  while read -r dep; do
    case "$dep" in
      /usr/lib/*|/System/*|@rpath/*|@executable_path/*|@loader_path/*) ;;
      *) echo "  OUTSIDE THE BUNDLE: $f -> $dep"; BAD=1 ;;
    esac
  # Lines ending in ':' are headers - the file itself, or one per architecture in a
  # universal binary - not dependencies.
  done < <(otool -L "$f" | awk '!/:$/ {print $1}')
done < <(find "$APP" -type f -print0)
[ "$BAD" = 0 ] || die "a binary links a library outside the bundle - the exact failure this build exists to prevent"
echo "  ok"

# ---- 6. sign, inside out ----
say "Signing with $IDENTITY"
sign() { codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@"; }
# a) EVERY Mach-O in the host's node_modules, not just *.node addons: the addons so
#    library validation can stay ON for Node (host.entitlements), and executables too -
#    ccusage shipped a native binary of its own, which the first notarization rejected
#    unsigned, and npm staged it 0644 (its cli.js chmodded it on first run, a write into
#    a signed bundle). ccusage is no longer a dependency (2026-11-13, host/claude-
#    tokens.mjs), but the loop stays general: any executable a dependency ships is
#    made executable and signed here rather than found by the notary.
while IFS= read -r -d '' f; do
  ft="$(file -b "$f")"
  case "$ft" in *Mach-O*) ;; *) continue ;; esac
  case "$ft" in *executable*) chmod 755 "$f" ;; esac
  sign "$f"
done < <(find "$C/Resources/host/node_modules" -type f -print0)
# b) Sparkle, in its documented order, never --deep
SP="$C/Frameworks/Sparkle.framework/Versions/B"
sign "$SP/Autoupdate"
sign "$SP/Updater.app"
sign "$C/Frameworks/Sparkle.framework"
# c) the launcher, then the helper BUNDLE with Node's entitlements. The entitlements
#    go on the bundle signature: signing the bundle re-signs its main executable, so
#    entitlements applied to the binary alone are silently dropped (measured - Node
#    then dies with "Failed to reserve virtual memory for CodeRange").
sign "$HC/MacOS/deckhand-host-launch"
sign --entitlements "$R/host.entitlements" "$C/Helpers/Deckhand Host.app"
# d) the app
sign "$APP"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | tail -2
codesign -d --entitlements - --xml "$C/Helpers/Deckhand Host.app" 2>/dev/null | grep -q "allow-jit" \
  || die "the helper lost its JIT entitlement"

# ---- 7. DMG ----
say "Building the DMG"
# A DESIGNED window, not a bare folder: the app and an Applications link at fixed
# places over a background with an arrow between them, a hint that the app lives in
# the menu bar, no toolbar, and the app's icon on the mounted volume. Finder is the
# only thing that can write that layout (it lives in the image's .DS_Store), so the
# image is built writable, Finder is told how to show it, and only then is it
# compressed. The background is drawn by the app we just built (--dmg-background), so
# its menu-bar picture is the real boat and the real two-row bar.
DMG="$DIST/Deckhand-$VERSION.dmg"
DMGROOT="$BUILD/app/dmg"
DMGRW="$BUILD/app/rw.dmg"
DMGMNT="/Volumes/Deckhand-build-$$"
rm -rf "$DMGROOT" "$DMGRW"; mkdir -p "$DMGROOT/.background"
ditto "$APP" "$DMGROOT/Deckhand.app"
ln -s /Applications "$DMGROOT/Applications"
"$C/MacOS/Deckhand" --dmg-background "$BUILD/app/bg" "$VERSION${CHANNEL:+ $CHANNEL}" >/dev/null \
  || die "the app could not draw the DMG background"
tiffutil -cathidpicheck "$BUILD/app/bg.png" "$BUILD/app/bg@2x.png" -out "$DMGROOT/.background/background.tiff" >/dev/null 2>&1 \
  || die "could not combine the background into a Retina TIFF"
hdiutil create -quiet -volname "Deckhand" -srcfolder "$DMGROOT" -fs HFS+ -format UDRW -ov "$DMGRW"
hdiutil resize -quiet -size 400m "$DMGRW"   # room for Finder's .DS_Store; compression drops it again
hdiutil attach -quiet -readwrite -noverify -noautoopen -mountpoint "$DMGMNT" "$DMGRW"
# The positions are the background's: app at (170,150), Applications at (490,150),
# 112pt icons. Bounds are 660 x 440 (with the 28pt title bar); a person whose Finder
# shows a tab bar loses ~44pt of that, which the layout leaves room for.
osascript <<OSA || { hdiutil detach -quiet "$DMGMNT"; die "Finder could not lay out the DMG window (Automation permission for Finder?)"; }
tell application "Finder"
  set d to (POSIX file "$DMGMNT" as alias)
  open d
  set w to container window of d
  set current view of w to icon view
  set toolbar visible of w to false
  set statusbar visible of w to false
  set pathbar visible of w to false
  set bounds of w to {200, 120, 860, 560}
  set o to icon view options of w
  set arrangement of o to not arranged
  set icon size of o to 112
  set text size of o to 13
  set background picture of o to (POSIX file "$DMGMNT/.background/background.tiff" as alias)
  set position of item "Deckhand.app" of d to {170, 150}
  set position of item "Applications" of d to {490, 150}
  update d without registering applications
  delay 2
  close w
end tell
OSA
# THE VOLUME'S ICON, AFTER FINDER. Measured twice over: `hdiutil create -srcfolder` drops a
# .VolumeIcon.icns from the source folder, and Finder's own layout pass above DELETES one
# that is already on the volume and clears its custom-icon flag. So it goes in last.
cp "$C/Resources/Deckhand.icns" "$DMGMNT/.VolumeIcon.icns"
SetFile -a C "$DMGMNT"
GetFileInfo -a "$DMGMNT" | grep -q C || { hdiutil detach -quiet "$DMGMNT"; die "the volume did not take its custom icon"; }
sync
for _ in 1 2 3 4 5; do hdiutil detach -quiet "$DMGMNT" && break; sleep 2; done
[ -d "$DMGMNT" ] && die "could not unmount $DMGMNT"
# LZMA (ULMO), not zlib (UDZO): measured on 0.1.2's DMG, 52,420,260 -> 37,548,226 bytes
# with the mount and the drag to Applications about as fast. LZFSE (ULFO) only reached
# 50,668,665. ULMO needs macOS 10.15, and this app needs 14.
hdiutil convert -quiet "$DMGRW" -format ULMO -ov -o "$DMG"
rm -f "$DMGRW"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"   # no runtime flag: not an executable

# ---- 8. notarize ----
if [ "$NOTARIZE" = 1 ]; then
  say "Notarizing (this waits for Apple, usually a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait | tee "$DIST/notary.log"
  grep -q "status: Accepted" "$DIST/notary.log" || die "notarization was not accepted - see $DIST/notary.log and 'xcrun notarytool log <id>'"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  say "Gatekeeper's verdict"
  spctl -a -t open --context context:primary-signature -vv "$DMG"
  # The app inside the stapled DMG is what a user actually runs.
  MNT="$(mktemp -d)"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" "$DMG"
  spctl -a -t exec -vv "$MNT/Deckhand.app" || { hdiutil detach -quiet "$MNT"; die "Gatekeeper rejects the app"; }
  hdiutil detach -quiet "$MNT"
else
  say "Skipping notarization (--no-notarize): this DMG will NOT open on another Mac without a warning"
fi

# ---- 9. appcast ----
if [ "$NOTARIZE" = 1 ]; then
  say "Generating the Sparkle appcast"
  # generate_appcast signs each archive with the EdDSA private key in the login
  # keychain (created once by generate_keys). The appcast lists only this version;
  # Sparkle only ever needs the newest.
  "$SPARKLE_DIR/bin/generate_appcast" --download-url-prefix "$DOWNLOAD_PREFIX" \
    --link "https://github.com/blueandhack/deckhand" -o "$DIST/appcast.xml" "$DIST"
fi

say "Done"
# For publish.sh: which channel this build was made for, so it cannot publish an
# alpha build as a stable release or the reverse.
echo "$CHANNEL" > "$DIST/channel"
ls -la "$DIST"
echo "Publish with: release/publish.sh $VERSION"
