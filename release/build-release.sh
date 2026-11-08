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
for a in "$@"; do
  case "$a" in
    --no-notarize) NOTARIZE=0 ;;
    --working-tree) WORKING_TREE=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z> [--no-notarize] [--working-tree]" >&2; exit 2; }

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
FEED_URL="https://github.com/blueandhack/deckhand/releases/latest/download/appcast.xml"
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
# A smoke test of the staged tree with the shipped Node. NOT `import noble`: that
# starts CoreBluetooth, and a Node with no Info.plist is killed by TCC on the spot
# (CLAUDE.md, "THE HOST MUST RUN VIA DeckhandBLE.app"). Loading noble's native addon
# through its own loader proves the same thing - the addon loads into this Node -
# without creating a Bluetooth manager. serialport is safe to import whole.
( cd "$STAGE" && "$NODE_DIR/bin/node" --input-type=module -e '
  import { createRequire } from "node:module";
  const require = createRequire(process.cwd() + "/");
  const nobleDir = require.resolve("@abandonware/noble/package.json").replace(/package\.json$/, "");
  const b = require("node-gyp-build")(nobleDir);
  if (typeof b.NobleMac !== "function") throw new Error("noble mac binding has no NobleMac");
  await import("serialport");
  console.log("  host modules load");' )
# Every import in the staged host must resolve in the staged tree - see the script.
"$NODE_DIR/bin/node" "$R/check-host-imports.mjs" "$STAGE" \
  || die "the staged host imports something the bundle does not contain - commit it, or add it to package.json"

# ---- 3. compile ----
say "Compiling"
BIN="$BUILD/app/bin"
mkdir -p "$BIN"
swiftc -O -target arm64-apple-macos14.0 -D SPARKLE \
  -F "$SPARKLE_DIR" -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "$SRC/mac-app/DeckhandMenuBar.swift" -o "$BIN/Deckhand" \
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
              -e "s|@SU_PUBLIC_KEY@|$SU_PUBLIC_KEY|g" -e "s|@COMMIT@|$COMMIT|g" -e "s|@ARGS@||g" "$1"; }
subst "$R/Info-app.plist" > "$C/Info.plist"
subst "$R/Info-host.plist" > "$HC/Info.plist"
subst "$R/agent.plist" > "$C/Library/LaunchAgents/io.github.blueandhack.deckhand.host.plist"
plutil -lint -s "$C/Info.plist" "$HC/Info.plist" "$C/Library/LaunchAgents/io.github.blueandhack.deckhand.host.plist"
cp "$BIN/Deckhand" "$C/MacOS/Deckhand"
cp "$NODE_DIR/bin/node" "$HC/MacOS/Deckhand Host"
cp "$BIN/deckhand-host-launch" "$HC/MacOS/deckhand-host-launch"
cp "$SRC/host/Deckhand.icns" "$C/Resources/Deckhand.icns"
cp "$SRC/host/Deckhand.icns" "$HC/Resources/Deckhand.icns"
mv "$STAGE" "$C/Resources/host"
mkdir -p "$C/Resources/hooks"
for f in deckhand-session-hook.mjs deckhand-statusline.mjs install-hooks.mjs \
         install-codex-hooks.mjs hook-command.mjs deckhand-backup.mjs; do
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
#    ccusage runs a native binary of its own (@ccusage/ccusage-darwin-arm64/bin/ccusage),
#    which the first notarization rejected unsigned. npm also stages that binary 0644
#    and ccusage's cli.js chmods it on first run - a write into a signed, installed
#    bundle that may not be writable - so it is made executable here, before signing.
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
DMG="$DIST/Deckhand-$VERSION.dmg"
DMGROOT="$BUILD/app/dmg"
rm -rf "$DMGROOT"; mkdir -p "$DMGROOT"
ditto "$APP" "$DMGROOT/Deckhand.app"
ln -s /Applications "$DMGROOT/Applications"
hdiutil create -quiet -volname "Deckhand $VERSION" -srcfolder "$DMGROOT" -fs HFS+ -format UDZO -ov "$DMG"
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
ls -la "$DIST"
echo "Publish with: release/publish.sh $VERSION"
