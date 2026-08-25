#!/bin/bash
# Supervise the Deckhand host with launchd, so a death costs seconds instead of
# however long it takes someone to notice a blank screen.
#
# Why this exists: the host has never once crashed (zero reports filed for the
# bundle) - it HANGS, or exits, and then nothing brings it back. A stuck BLE
# write left it silently dead for five hours in one measured case, with its
# serial reader still logging device lines the whole time so everything looked
# healthy from the Mac.
#
#   ./deckhand-service.sh install     register with launchd and start it
#   ./deckhand-service.sh stop        stop it AND stop launchd restarting it
#   ./deckhand-service.sh start       start it again
#   ./deckhand-service.sh status      is it running, and since when
#   ./deckhand-service.sh uninstall   remove the agent entirely
#
# FLASHING: just run ./flash.sh from the repo root - it handles this for you and
# puts the host back afterwards, including when the upload fails. The hazard it
# hides: KeepAlive re-grabs /dev/cu.usbserial-* within a second of the process
# dying, so a bare `arduino-cli upload` fails on a busy port and looks like a
# hardware fault. Killing the process is NOT enough; only `stop` (which unloads
# the job) prevents the respawn.
set -euo pipefail

LABEL="com.deckhand.host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BIN="$HERE/DeckhandBLE.app/Contents/MacOS/Deckhand"
SCRIPT="$HERE/index.mjs"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    [ -x "$BIN" ] || { echo "missing $BIN - build the app bundle first (see CLAUDE.md)"; exit 1; }
    [ -f "$SCRIPT" ] || { echo "missing $SCRIPT"; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents"
    # ProgramArguments runs the BUNDLE'S BINARY DIRECTLY rather than going through
    # `open`. That is deliberate and was verified, because CLAUDE.md's warning
    # ("must be launched via open") is about OBTAINING the Bluetooth permission
    # prompt - once TCC has granted it, exec'ing the binary keeps the bundle's
    # identity and CoreBluetooth comes up fine (measured: survived, and reached
    # "BLE: adapter state = poweredOn"). Going through `open` would also give
    # launchd nothing to supervise, since `open` returns immediately.
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>$SCRIPT</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- launchd's floor is 10s anyway; being explicit stops a crash-looping build
       from spinning as fast as the machine allows. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- These catch what dies BEFORE the host's own logger exists - a missing dylib
       after a brew upgrade, say, which otherwise leaves no trace anywhere. They
       live in ~/Library/Logs rather than the host's /tmp runtime dir on purpose:
       launchd opens these at SPAWN time, so if the directory were ever missing
       (macOS prunes /tmp) the job would fail to start rather than just lose its
       log. ~/Library/Logs always exists and is per-user by definition. -->
  <key>StandardOutPath</key><string>$HOME/Library/Logs/deckhand-launchd.out</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/deckhand-launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd gives a minimal PATH, and this is deliberately NOT patched up
         with wherever node happens to live: node here is nvm-managed, so that
         path carries a version number and would break silently on the next
         upgrade. Nothing needs it - the host spawns node children through
         process.execPath (the copy inside the bundle) and uses absolute paths
         for whisper and claude. This PATH only has to cover git and security. -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed and started: $PLIST"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "stopped (launchd will NOT restart it until you run: $0 start)"
    ;;
  start)
    [ -f "$PLIST" ] || { echo "not installed - run: $0 install"; exit 1; }
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "started"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) ' | sed 's/^/  /'
    else
      echo "  not loaded"
    fi
    HOST_PAT='DeckhandBLE.app/Contents/MacOS/Deckhand'
    pgrep -f "$HOST_PAT" >/dev/null && echo "  process: running (pid $(pgrep -f "$HOST_PAT" | head -1))" \
                                         || echo "  process: NOT running"
    # The point of the ledger: whether the supervisor is actually catching
    # anything. "0 restarts, longest run 7d" means it is unproven AND unneeded;
    # a pile of restarts means there is still a cause worth fixing rather than
    # a net worth relying on.
    LEDGER="$HOME/.claude/deckhand-restarts.log"
    if [ -s "$LEDGER" ]; then
      echo "  --- restarts ---"
      python3 - "$LEDGER" <<'PYEOF'
import sys, re, datetime, signal
# `status | head` closes stdout early; without this python prints a BrokenPipe
# traceback that looks like a failure and isn't.
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
lines = [l for l in open(sys.argv[1]) if " start #" in l]
now = datetime.datetime.now(datetime.timezone.utc)
def when(l):
    try: return datetime.datetime.fromisoformat(l.split()[0].replace("Z", "+00:00"))
    except Exception: return None
week = [l for l in lines if (t := when(l)) and (now - t).days < 7]
def secs(tok):
    m = re.search(r"previous run ([\d.]+)([hms])", tok)
    if not m: return None
    v, u = float(m.group(1)), m.group(2)
    return v * {"h": 3600, "m": 60, "s": 1}[u]
runs = [s for l in lines if (s := secs(l)) is not None]
def human(x):
    return f"{x/3600:.1f}h" if x >= 3600 else (f"{x/60:.0f}m" if x >= 60 else f"{x:.0f}s")
print(f"    starts total: {len(lines)}    in the last 7 days: {len(week)}")
if runs:
    print(f"    longest run: {human(max(runs))}    shortest: {human(min(runs))}")
stalled = [l for l in lines if "STALLED" in l]
if stalled:
    print(f"    runs that HUNG before dying: {len(stalled)}  <- the failure the watchdog targets")
# A run whose heartbeat was gone by the next start tells us nothing about its
# ticks - /tmp is cleared at boot, so this is the NORMAL reading after a reboot.
# It is counted separately and never as a hang: folding it in is exactly the bug
# that made all four historical "hangs" false. See host/run-ledger.mjs.
unknown = [l for l in lines if "last tick unknown" in l]
if unknown:
    print(f"    runs whose last tick is unknown: {len(unknown)}  <- heartbeat gone (usually a reboot), NOT a hang")
legacy = [l for l in lines if "STALLED" in l and "previous run 0s" in l]
if legacy:
    print(f"    of those hangs, {len(legacy)} predate the run-ledger.mjs fix and are UNRELIABLE")
    print(f"      (before it, a cleared /tmp was reported as a full-length stall)")
if lines:
    print(f"    last: {lines[-1].strip()}")
PYEOF
    else
      echo "  --- restarts --- none recorded yet (ledger starts at the next host start)"
    fi
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $PLIST"
    ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
