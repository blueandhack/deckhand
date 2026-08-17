#!/bin/bash
# Compile and flash the firmware, handling the serial port for you.
#
#   ./flash.sh              compile + upload
#   ./flash.sh --no-compile  upload the last build (skips ~3 min)
#
# This exists so flashing stays ONE command. The host holds /dev/cu.usbserial-*,
# and under launchd it re-grabs the port within a second of being killed - so a
# bare `arduino-cli upload` fails on a busy port, which looks like a hardware
# fault rather than a supervisor doing its job. Rather than making you remember a
# stop/start dance, this stops the host the right way, flashes, and puts it back
# exactly as it found it - INCLUDING when the upload fails, via the trap below.
#
# It handles both ways of running the host: supervised by launchd, or started by
# hand with `open DeckhandBLE.app`.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SKETCH="firmware/deckhand_display"
FQBN_COMPILE="esp32:esp32:esp32:PartitionScheme=huge_app"
# FlashMode=dio and 115200 are required for THIS board: the default QIO mode
# fails to upload on it. See CLAUDE.md.
FQBN_UPLOAD="esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app"
LABEL="com.deckhand.host"
DOMAIN="gui/$(id -u)"

WAS_SUPERVISED=0
WAS_MANUAL=0

restore() {
  if [ "$WAS_SUPERVISED" = "1" ]; then
    echo "==> restarting supervised host"
    ./host/deckhand-service.sh start >/dev/null 2>&1 || \
      echo "    WARNING: could not restart the service - run ./host/deckhand-service.sh start"
  elif [ "$WAS_MANUAL" = "1" ]; then
    echo "==> restarting host (was started by hand)"
    (cd host && open DeckhandBLE.app --args "$(pwd)/index.mjs")
  fi
}
# Runs on success, failure, and Ctrl-C alike: leaving the display dead because an
# upload failed would be a worse bug than the one this script prevents.
trap restore EXIT

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  WAS_SUPERVISED=1
  echo "==> stopping supervised host (launchd would otherwise re-grab the port)"
  ./host/deckhand-service.sh stop >/dev/null
elif pgrep -f 'MacOS/Deckhand' >/dev/null; then
  WAS_MANUAL=1
  echo "==> stopping hand-started host"
  pkill -f 'MacOS/Deckhand'
fi
# Wait for the port to actually be released rather than assuming it: the process
# can outlive the signal by a moment, and a race here is exactly the confusing
# "busy port" failure this script exists to avoid.
for _ in $(seq 1 20); do pgrep -f 'MacOS/Deckhand' >/dev/null || break; sleep 0.5; done

if [ "${1:-}" != "--no-compile" ]; then
  echo "==> compiling"
  arduino-cli compile --fqbn "$FQBN_COMPILE" "$SKETCH" | tail -3 || exit 1
fi

# The port renumbers between plug-ins (it has been both usbserial-110 and -10), so
# it is resolved every time rather than hardcoded.
PORT=$(ls /dev/cu.usbserial-* 2>/dev/null | head -1)
if [ -z "$PORT" ]; then
  echo "no /dev/cu.usbserial-* found - is the board plugged in?"
  exit 1
fi

echo "==> uploading to $PORT"
arduino-cli upload -p "$PORT" --fqbn "$FQBN_UPLOAD" "$SKETCH" | tail -3
