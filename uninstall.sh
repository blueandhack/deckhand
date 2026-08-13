#!/usr/bin/env bash
# Back Deckhand out of ~/.claude. The mirror of install.sh, in reverse.
#
#   ./uninstall.sh              # confirm, then remove
#   ./uninstall.sh --dry-run    # print exactly what would happen, change nothing
#   ./uninstall.sh --purge      # ALSO forget the device pairing keys
#   ./uninstall.sh --yes        # skip the confirmation
#
# Two things it deliberately does NOT do:
#
#   - It does not touch this repo. host/node_modules and host/DeckhandBLE.app are build
#     artifacts, and an uninstaller reaching into your working tree is a surprise; the
#     command to remove them is printed instead.
#   - It does not remove ~/Deckhand-backups or ~/Deckhand-audio. Those are your data -
#     pairing keys, settings snapshots and recordings - and an uninstall is not consent
#     to delete them. --purge covers the keys in ~/.claude only.
#
# Un-registering from settings.json is SURGICAL (install-hooks.mjs --remove), not a
# restore of the pre-install file: you may have added hooks or changed settings since
# installing, and those have to survive. To go back to an exact earlier state, restore a
# snapshot instead - see the closing message.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

DRY=0
PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --purge)   PURGE=1 ;;
    --yes|-y)  YES=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

SECRET="$CLAUDE_DIR/deckhand-secret"
# TEST SEAM, and it is load-bearing. The host's runtime state lives at ABSOLUTE /tmp
# paths, so unlike everything else here it is not covered by pointing $HOME at a
# throwaway tree - claude-hooks/test-install-cycle.sh ran the real uninstall and deleted
# the live host's log AND its persisted OAuth throttle state, which is what stops a
# restart bursting the usage endpoint into a 429. Overriding this is how the test stays
# hermetic; in normal use it is /tmp.
DECK_TMP="${DECKHAND_TMP:-/tmp}"

echo "== Deckhand uninstall${DRY:+}$([ "$DRY" = 1 ] && echo "  [dry run]") =="
echo ""

# A host holding these files open while we delete them just leaves it writing into
# nothing - and it would keep refreshing the heartbeat that makes hooks wait.
if pgrep -qf 'DeckhandBLE.app|deckhand/host/index.mjs' 2>/dev/null; then
  echo "warning: the Deckhand host looks like it is still running."
  echo "         Stop it first (menu-bar app -> Stop syncing, or kill the process),"
  echo "         or it will keep recreating $DECK_TMP/deckhand-host-alive."
  echo ""
fi

echo "Will remove:"
echo "  - Deckhand's entries in $CLAUDE_DIR/settings.json (surgically; yours are kept)"
echo "  - $CLAUDE_DIR/deckhand-session-hook.mjs, deckhand-statusline.mjs"
echo "  - $CLAUDE_DIR/deckhand-sessions/, deckhand-answers/, deckhand-device-command"
echo "  - $CLAUDE_DIR/deckhand-session-hook-debug.log (and .1)"
echo "  - $DECK_TMP/deckhand-* (heartbeat, host log, OAuth throttle state)"
if [ "$PURGE" = 1 ]; then
  echo "  - $SECRET   <-- --purge: every device must be re-paired over USB afterwards"
fi
echo ""
echo "Will KEEP:"
[ "$PURGE" = 1 ] || echo "  - $SECRET (pairing keys; pass --purge to remove)"
echo "  - ~/Deckhand-backups (snapshots, incl. your keys and settings.json)"
echo "  - ~/Deckhand-audio (recordings)"
echo "  - this repo, including host/node_modules and host/DeckhandBLE.app"
echo ""

if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted - nothing changed."; exit 0 ;;
  esac
  echo ""
fi

# Echo every mutation, and under --dry-run echo it INSTEAD of running it. One helper for
# both means the dry run can never drift from what the real run does.
run() {
  echo "  \$ $*"
  [ "$DRY" = 1 ] || "$@"
}

# Snapshot first, so the uninstall itself is undoable. Skipped under --dry-run (a dry run
# must write nothing at all, and a snapshot is a write).
if [ "$DRY" = 0 ]; then
  echo "[1/4] Snapshotting current state first, so this is undoable"
  node "$REPO/claude-hooks/deckhand-backup.mjs" backup || \
    echo "  warning: snapshot failed - continuing, but you will have no undo." >&2
else
  echo "[1/4] (dry run) would snapshot to ~/Deckhand-backups"
fi

echo "[2/4] Un-registering from settings.json"
if [ "$DRY" = 1 ]; then
  echo "  \$ node $REPO/claude-hooks/install-hooks.mjs --remove"
else
  node "$REPO/claude-hooks/install-hooks.mjs" --remove
fi

echo "[3/4] Removing hook scripts and per-session state"
run rm -f "$CLAUDE_DIR/deckhand-session-hook.mjs" "$CLAUDE_DIR/deckhand-statusline.mjs"
run rm -rf "$CLAUDE_DIR/deckhand-sessions" "$CLAUDE_DIR/deckhand-answers"
run rm -f "$CLAUDE_DIR/deckhand-device-command" \
          "$CLAUDE_DIR/deckhand-session-hook-debug.log" \
          "$CLAUDE_DIR/deckhand-session-hook-debug.log.1"
if [ "$PURGE" = 1 ]; then
  run rm -f "$SECRET"
fi

echo "[4/4] Removing host runtime state"
# Globbed rather than listed so a file added later is still cleaned up. nullglob-ish:
# under `set -u` an unmatched glob would otherwise be passed through literally.
for f in "$DECK_TMP/deckhand-host-alive" "$DECK_TMP/deckhand-host.log" \
         "$DECK_TMP/deckhand-host.log.1" "$DECK_TMP/deckhand-oauth-usage.json" \
         "$DECK_TMP/deckhand-oauth-backoff.json" "$DECK_TMP/deckhand-oauth-attempt.json"; do
  [ -e "$f" ] || continue
  run rm -f "$f"
done

cat <<EOF

== $([ "$DRY" = 1 ] && echo "Dry run complete - nothing was changed" || echo "Uninstalled") ==

$([ "$DRY" = 1 ] && echo "Drop --dry-run to apply." || echo "Restart the Claude Code app/CLI so it stops running the hook.")

To put everything back:
  node claude-hooks/deckhand-backup.mjs list
  node claude-hooks/deckhand-backup.mjs restore latest --dry-run
  node claude-hooks/deckhand-backup.mjs restore latest
...or reinstall from scratch with ./install.sh

To remove the repo's build artifacts too:
  rm -rf "$REPO/host/node_modules" "$REPO/host/DeckhandBLE.app"
EOF
