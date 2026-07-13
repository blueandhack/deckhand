#!/usr/bin/env bash
# One-command setup for Deckhand on macOS. Idempotent - safe to re-run.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "== Deckhand setup =="

echo "[1/4] Installing Claude Code hook scripts -> $CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
cp "$REPO/claude-hooks/deckhand-statusline.mjs"  "$CLAUDE_DIR/"
cp "$REPO/claude-hooks/deckhand-session-hook.mjs" "$CLAUDE_DIR/"

echo "[2/4] Registering hooks in settings.json (backs up first, merges safely)"
node "$REPO/claude-hooks/install-hooks.mjs"

echo "[3/4] Installing host dependencies (npm)"
( cd "$REPO/host" && npm install --no-fund --no-audit )

echo "[4/4] Building DeckhandBLE.app from your node"
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
once; the SETUP tab shows "paired" once done.

USB-only, no Bluetooth needed? Just run:  node "$REPO/host/index.mjs"
EOF
