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
# STOP BEFORE FLASHING. KeepAlive means launchd re-grabs /dev/cu.usbserial-* the
# instant the process dies, so `arduino-cli upload` will fail on a busy port if
# the agent is merely killed rather than stopped. `stop` unloads the job, which
# is what actually prevents the respawn.
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
  <!-- The host writes its own /tmp/deckhand-host.log. These two catch what dies
       BEFORE that logger exists - a missing dylib after a brew upgrade, say,
       which otherwise leaves no trace anywhere. -->
  <key>StandardOutPath</key><string>/tmp/deckhand-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/deckhand-launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd gives a minimal PATH. The host uses absolute paths for whisper
         and claude, but ccusage resolves through node_modules/.bin and anything
         it shells out to needs the usual places. -->
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
    pgrep -f 'MacOS/Deckhand' >/dev/null && echo "  process: running (pid $(pgrep -f 'MacOS/Deckhand' | head -1))" \
                                         || echo "  process: NOT running"
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
