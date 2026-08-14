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
echo "[1/6] Snapshotting existing Deckhand state -> ~/Deckhand-backups"
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

echo "[2/6] Installing Claude Code hook scripts -> $CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
cp "$REPO/claude-hooks/deckhand-statusline.mjs"  "$CLAUDE_DIR/"
cp "$REPO/claude-hooks/deckhand-session-hook.mjs" "$CLAUDE_DIR/"

echo "[3/6] Registering hooks in settings.json (backs up first, merges safely)"
node "$REPO/claude-hooks/install-hooks.mjs"

echo "[4/6] Registering Codex hooks (only if Codex is installed)"
node "$REPO/claude-hooks/install-codex-hooks.mjs" || \
  echo "  warning: Codex hook registration failed - continuing (Codex threads stay read-only)." >&2

echo "[5/6] Installing host dependencies (npm)"
( cd "$REPO/host" && npm install --no-fund --no-audit )

echo "[6/6] Building DeckhandBLE.app from your node"
"$REPO/host/build-app.sh"

cat <<EOF

== Setup complete ==

Still to do by hand (see README):
  1. Flash the firmware:
       arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
       # (copy firmware/User_Setup.h into your TFT_eSPI library folder first)
  2. Start the host (first launch asks for Bluetooth permission -> click Allow):
       open "$REPO/host/DeckhandBLE.app" --args "$REPO/host/index.mjs"

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
