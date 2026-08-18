#!/usr/bin/env bash
# Full install/uninstall cycle against a throwaway HOME. Never touches the real ~/.claude.
#
# There is no test framework in this repo, and this is the one place that needs a real
# one: install.sh and uninstall.sh mutate ~/.claude, which is shared by every Claude Code
# session on the machine. So this exercises the whole cycle against a THROWAWAY $HOME -
# all four scripts honour it (bash reads $HOME, node's os.homedir() returns it) - and the
# real ~/.claude is never touched. Run it after changing any of them:
#
#   claude-hooks/test-install-cycle.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

T=$(mktemp -d); mkdir -p "$T/.claude" "$T/tmp"
export HOME="$T"
# The host's runtime state is at ABSOLUTE /tmp paths, so $HOME does not sandbox it. Without
# this the test deleted the LIVE host's log and its persisted OAuth throttle state - the
# guards that stop a restart bursting the usage endpoint into a 429. Redirect them, and
# assert below that the real ones survive.
export DECKHAND_TMP="$T/tmp"
C="$T/.claude"

# Canonical form (2-space + trailing newline) so a byte comparison is meaningful.
cat > "$C/settings.json" <<'EOF'
{
  "enabledPlugins": {},
  "theme": "dark",
  "effortLevel": "high"
}
EOF
ORIG=$(cat "$C/settings.json")

stage() {  # mimic install.sh steps 2-3 plus the runtime state a live install accumulates
  cp "$REPO/claude-hooks/deckhand-session-hook.mjs" "$REPO/claude-hooks/deckhand-statusline.mjs" "$C/"
  node "$REPO/claude-hooks/install-hooks.mjs" >/dev/null
  mkdir -p "$C/deckhand-sessions" "$C/deckhand-answers"
  echo '{}' > "$C/deckhand-sessions/x.json"
  echo 'secret-keys-here' > "$C/deckhand-secret"; chmod 600 "$C/deckhand-secret"
  echo 'log' > "$C/deckhand-session-hook-debug.log"
  echo '{}' > "$C/deckhand-rate-limits.json"
}

echo "== 1. register =="
stage
check "statusLine registered" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json"))["statusLine"]?.command.includes("deckhand-statusline"))')" "true"
check "9 hook events registered" "$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")).hooks).length)')" "9"

echo "== 2. backup includes the new rate-limits file =="
node "$REPO/claude-hooks/deckhand-backup.mjs" backup >/dev/null 2>&1
check "rate-limits captured" "$(ls -A "$T/Deckhand-backups"/backup-*/ | grep -c 'rate-limits')" "1"
check "secret captured" "$(ls -A "$T/Deckhand-backups"/backup-*/ | grep -c 'deckhand-secret')" "1"
check "backup dir mode 700" "$(stat -f%Lp "$T/Deckhand-backups"/backup-*/ | head -1)" "700"

echo "== 3. dry run changes NOTHING =="
BEFORE_BK=$(ls "$T/Deckhand-backups" | wc -l | tr -d ' ')
"$REPO/uninstall.sh" --dry-run >/dev/null
check "settings.json untouched" "$(cat "$C/settings.json" | md5)" "$(node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.env.HOME+"/.claude/settings.json"));' >/dev/null 2>&1; cat "$C/settings.json" | md5)"
check "hook script still present" "$([ -f "$C/deckhand-session-hook.mjs" ] && echo yes || echo no)" "yes"
check "sessions dir still present" "$([ -d "$C/deckhand-sessions" ] && echo yes || echo no)" "yes"
check "no new snapshot written" "$(ls "$T/Deckhand-backups" | wc -l | tr -d ' ')" "$BEFORE_BK"

echo "== 4. real uninstall =="
"$REPO/uninstall.sh" --yes >/dev/null
check "settings.json back to original (bytes)" "$(cat "$C/settings.json")" "$ORIG"
check "hook scripts removed" "$(ls "$C"/deckhand-*.mjs 2>/dev/null | wc -l | tr -d ' ')" "0"
check "sessions dir removed" "$([ -d "$C/deckhand-sessions" ] && echo yes || echo no)" "no"
check "answers dir removed" "$([ -d "$C/deckhand-answers" ] && echo yes || echo no)" "no"
check "debug log removed" "$([ -f "$C/deckhand-session-hook-debug.log" ] && echo yes || echo no)" "no"
check "SECRET KEPT (no --purge)" "$([ -f "$C/deckhand-secret" ] && echo yes || echo no)" "yes"
check "snapshot taken before removing" "$([ "$(ls "$T/Deckhand-backups" | wc -l | tr -d ' ')" -gt "$BEFORE_BK" ] && echo yes || echo no)" "yes"

echo "== 4b. REGRESSION: must not touch the REAL /tmp host state =="
# Sentinels at the real paths. If uninstall ignores DECKHAND_TMP these get deleted, which
# is exactly what happened to the running host before the seam existed.
# These must track RUNTIME_DIR in host/index.mjs. Pointed at the pre-per-user flat
# paths they still PASSED - nothing writes there any more, so the assertion had no
# teeth and would not have caught the bug it exists for a second time.
REAL_DIR="/tmp/deckhand-$(id -u)"
REAL_LOG="$REAL_DIR/host.log"; REAL_ATT="$REAL_DIR/oauth-attempt.json"
mkdir -p "$REAL_DIR"
touch "$REAL_LOG.testsentinel" "$REAL_ATT.testsentinel"
had_log=$([ -e "$REAL_LOG" ] && echo 1 || echo 0)
echo "sentinel" > "$T/tmp/host.log"
stage
"$REPO/uninstall.sh" --yes >/dev/null
check "sandboxed /tmp state was removed" "$([ -e "$T/tmp/host.log" ] && echo yes || echo no)" "no"
check "real /tmp untouched (log)" "$([ -e "$REAL_LOG.testsentinel" ] && echo yes || echo no)" "yes"
check "real /tmp untouched (oauth attempt)" "$([ -e "$REAL_ATT.testsentinel" ] && echo yes || echo no)" "yes"
check "real running host's log not deleted" "$([ "$had_log" = 1 ] && { [ -e "$REAL_LOG" ] && echo kept || echo DELETED; } || echo n/a)" "$([ "$had_log" = 1 ] && echo kept || echo n/a)"
rm -f "$REAL_LOG.testsentinel" "$REAL_ATT.testsentinel"

echo "== 4c. Codex hooks are registered and removed =="
mkdir -p "$T/.codex"
node "$REPO/claude-hooks/install-codex-hooks.mjs" >/dev/null
check "codex hooks.json created" "$([ -f "$T/.codex/hooks.json" ] && echo yes || echo no)" "yes"
check "PermissionRequest registered" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.codex/hooks.json","utf8"));console.log(c.hooks.PermissionRequest?1:0)')" "1"
node "$REPO/claude-hooks/install-codex-hooks.mjs" --remove >/dev/null
check "codex hooks removed" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.codex/hooks.json","utf8"));console.log(c.hooks?.PermissionRequest?1:0)')" "0"

echo "== 5. --purge removes the keys =="
stage
"$REPO/uninstall.sh" --yes --purge >/dev/null
check "secret removed with --purge" "$([ -f "$C/deckhand-secret" ] && echo yes || echo no)" "no"

echo "== 6. surgical: third-party hooks and a custom statusLine survive =="
cat > "$C/settings.json" <<'EOF'
{
  "theme": "dark",
  "statusLine": {
    "type": "command",
    "command": "node /my/own/statusline.mjs"
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node /my/own/hook.mjs"
          }
        ]
      }
    ]
  }
}
EOF
MINE=$(cat "$C/settings.json")
stage
check "deckhand added alongside mine" "$(node -e 'const h=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")).hooks.PostToolUse;console.log(h.length)')" "2"
"$REPO/uninstall.sh" --yes >/dev/null
check "my settings.json fully restored" "$(cat "$C/settings.json")" "$MINE"
check "my statusLine kept" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")).statusLine.command)')" "node /my/own/statusline.mjs"

echo "== 7. prune caps the backup directory =="
rm -rf "$T/Deckhand-backups"; mkdir -p "$T/Deckhand-backups"
for i in $(seq -w 1 14); do
  d="$T/Deckhand-backups/backup-2020-01-$i" ; mkdir -p "$d"; echo '{"files":[]}' > "$d/manifest.json"
  touch -t 202001010000 "$d/manifest.json"      # far older than KEEP_DAYS
done
OUT=$(node "$REPO/claude-hooks/deckhand-backup.mjs" backup 2>&1)
check "pruned down to KEEP_MIN (newest 10 survive)" "$(ls "$T/Deckhand-backups" | wc -l | tr -d ' ')" "10"
check "prune was reported, not silent" "$(echo "$OUT" | grep -c 'Pruned')" "1"

echo "== 7b. REGRESSION: two snapshots in the same second must not merge =="
rm -rf "$T/Deckhand-backups"
node "$REPO/claude-hooks/deckhand-backup.mjs" backup >/dev/null 2>&1
node "$REPO/claude-hooks/deckhand-backup.mjs" backup >/dev/null 2>&1
check "two distinct snapshot dirs" "$(ls "$T/Deckhand-backups" | wc -l | tr -d ' ')" "2"

echo "== 7c. REGRESSION: restore must not prune the snapshot it restores from =="
rm -rf "$T/Deckhand-backups"
echo 'original-keys' > "$C/deckhand-secret"
node "$REPO/claude-hooks/deckhand-backup.mjs" backup >/dev/null 2>&1
SRC=$(ls -d "$T/Deckhand-backups"/backup-* | head -1)
OLD="$T/Deckhand-backups/backup-2019-01-01T00-00-00-000"
mv "$SRC" "$OLD"; touch -t 201901010000 "$OLD/manifest.json"   # old, and sorts oldest
for i in $(seq -w 1 12); do                                     # push it outside KEEP_MIN
  d="$T/Deckhand-backups/backup-2020-01-$i"; mkdir -p "$d"
  echo '{"files":[]}' > "$d/manifest.json"; touch -t 202001010000 "$d/manifest.json"
done
echo 'CLOBBERED' > "$C/deckhand-secret"
node "$REPO/claude-hooks/deckhand-backup.mjs" restore "$OLD" >/dev/null 2>&1
check "source snapshot still exists after restore" "$([ -d "$OLD" ] && echo yes || echo no)" "yes"
check "restore actually restored the file" "$(cat "$C/deckhand-secret")" "original-keys"

echo "== 8. install.sh aborts rather than clobber when backup fails =="
cp "$REPO/claude-hooks/deckhand-session-hook.mjs" "$C/"      # something to lose
chmod 500 "$T/Deckhand-backups"                                # make snapshotting fail
set +e
ERR=$("$REPO/install.sh" 2>&1); RC=$?
set -e
chmod 700 "$T/Deckhand-backups"
check "install.sh exited non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
check "refused to overwrite" "$(echo "$ERR" | grep -c 'Refusing to overwrite')" "1"
check "hook script survived the abort" "$([ -f "$C/deckhand-session-hook.mjs" ] && echo yes || echo no)" "yes"
check "npm never ran (aborted at step 1)" "$(echo "$ERR" | grep -c '\[5/6\]')" "0"

rm -rf "$T"
echo ""
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
