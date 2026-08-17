#!/usr/bin/env bash
# One-command setup for Deckhand on macOS. Idempotent - safe to re-run.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "== Deckhand setup =="

# Snapshot BEFORE anything is overwritten. The cp below replaces the two hook scripts
# outright, so without this a re-run silently destroys any local edits you made to them
# (install-hooks.mjs backs up settings.json, but it cannot back up files it is about to
# be handed). Also captures ~/.claude/deckhand-secret, whose loss means re-pairing every
# device over USB.
echo "[1/7] Snapshotting existing Deckhand state -> ~/Deckhand-backups"
HAD_INSTALL=0
if [ -f "$CLAUDE_DIR/deckhand-session-hook.mjs" ] || [ -f "$CLAUDE_DIR/deckhand-statusline.mjs" ]; then
  HAD_INSTALL=1
fi
if ! node "$REPO/claude-hooks/deckhand-backup.mjs" backup; then
  # Conditional on purpose. With something already installed, proceeding would destroy
  # the only copy - so stop. With nothing installed there is nothing to lose, and
  # refusing to install over a backup hiccup would be obstructive.
  if [ "$HAD_INSTALL" = 1 ]; then
    echo "error: backup failed, and hook scripts are already installed." >&2
    echo "       Refusing to overwrite them. Fix the backup problem (is ~/Deckhand-backups" >&2
    echo "       writable?) or move them aside, then re-run." >&2
    exit 1
  fi
  echo "  warning: backup failed, but nothing is installed yet - continuing." >&2
fi

echo "[2/7] Installing Claude Code hook scripts -> $CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
cp "$REPO/claude-hooks/deckhand-statusline.mjs"  "$CLAUDE_DIR/"
cp "$REPO/claude-hooks/deckhand-session-hook.mjs" "$CLAUDE_DIR/"

echo "[3/7] Registering hooks in settings.json (backs up first, merges safely)"
node "$REPO/claude-hooks/install-hooks.mjs"

echo "[4/7] Registering Codex hooks (only if Codex is installed)"
node "$REPO/claude-hooks/install-codex-hooks.mjs" || \
  echo "  warning: Codex hook registration failed - continuing (Codex threads stay read-only)." >&2

echo "[5/7] Installing host dependencies (npm)"
( cd "$REPO/host" && npm install --no-fund --no-audit )

echo "[6/7] Building DeckhandBLE.app from your node"
"$REPO/host/build-app.sh"

# Reported, NOT auto-installed. The model alone is ~550MB, and someone who has not
# fitted the microphone should not have to download it to set up a status display.
# But it is checked HERE rather than left to be discovered, because the failure mode
# is bad: the host accepts a capture, spends the transfer, and only then fails - which
# reads as "dictation is broken" instead of "a dependency is missing".
echo "[7/7] Checking dictation prerequisites (optional - only if you fitted the mic)"
WBIN="${WHISPER_BIN:-/opt/homebrew/bin/whisper-cli}"
WMODEL="${WHISPER_MODEL:-$HOME/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin}"
if [ -x "$WBIN" ] && [ -s "$WMODEL" ]; then
  echo "      whisper + model present - dictation will work."
else
  [ -x "$WBIN" ] || echo "      whisper-cli missing ($WBIN)"
  [ -s "$WMODEL" ] || echo "      model missing ($WMODEL)"
  echo "      Dictation is OFF until both exist. To set it up (~550MB download):"
  echo "        ./host/install-voice.sh"
  echo "      Everything else works without it."
fi

cat <<EOF

== Setup complete ==

Still to do by hand (see README):
  1. Copy firmware/tft_setup/User_Setup.h into your TFT_eSPI library folder,
     then flash the firmware:
       ./flash.sh
     One command: it compiles, frees the serial port, uploads, and puts the
     host back afterwards - including if the upload fails.
  2. Start the host ONCE by hand, because the first launch is what asks for
     Bluetooth permission and only a real app launch can show that prompt:
       open "$REPO/host/DeckhandBLE.app" --args "$REPO/host/index.mjs"
     Click Allow, then quit it.
  3. Have it run itself from then on (restarts after a crash or hang, and
     starts at login):
       ./host/deckhand-service.sh install
     Check on it any time with:
       ./host/deckhand-service.sh status

Pairing is automatic: while the device is on USB, the host generates a
secret (~/.claude/deckhand-secret) and provisions it to the device, so only
your Mac can answer prompts from it. Keep it plugged in via USB at least
once; the SETTINGS tab shows "paired" once done.

Launch via the bundle even for USB-only work: plain \`node index.mjs\` is
killed by macOS (SIGABRT/exit 134) as soon as noble touches CoreBluetooth,
so there is no bare-node fallback.

If you use Codex: start it once and choose "Trust all and continue" on the
hooks review prompt. Codex hooks do not run until trusted, and changing them
asks again. Until then Deckhand still shows Codex threads, just read-only.

To back out: ./uninstall.sh  (--dry-run to see it first). Snapshots and
pairing keys are kept unless you pass --purge, and any snapshot can be put
back with:  node claude-hooks/deckhand-backup.mjs restore latest
EOF
