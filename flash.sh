#!/bin/bash
# Compile and flash the firmware, handling the serial port for you.
#
#   ./flash.sh                  compile + upload board 1 (the default)
#   ./flash.sh --board 2        compile + upload board 2
#   ./flash.sh --no-compile     upload the last build (skips ~3 min)
#
# This exists so flashing stays ONE command. The host holds the board's serial
# port, and under launchd it re-grabs the port within a second of being killed -
# so a bare `arduino-cli upload` fails on a busy port, which looks like a
# hardware fault rather than a supervisor doing its job. Rather than making you
# remember a stop/start dance, this stops the host the right way, flashes, and
# puts it back exactly as it found it - INCLUDING when the upload fails, via
# the trap below. That restore logic is board-agnostic and runs the same way
# regardless of --board.
#
# It handles both ways of running the host: supervised by launchd, or started by
# hand with `open DeckhandBLE.app`.
#
# --board defaults to 1 so every existing habit (a bare `./flash.sh`) keeps
# working unchanged now that a second board exists.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# DECKHAND_FLASH_SKETCH is a test seam (same idea as DECKHAND_TMP elsewhere in
# this repo) for flashing a throwaway verification sketch through the same
# stop-host/upload/restore-host safety dance, without a bare `arduino-cli
# upload` fighting the supervised host for the port. Unset, it's exactly the
# real firmware, as always.
SKETCH="${DECKHAND_FLASH_SKETCH:-firmware/deckhand_display}"
BOARD="1"
NO_COMPILE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --board)
      BOARD="$2"
      shift 2
      ;;
    --board=*)
      BOARD="${1#*=}"
      shift
      ;;
    --no-compile)
      NO_COMPILE=1
      shift
      ;;
    *)
      echo "usage: $0 [--board 1|2] [--no-compile]" >&2
      exit 1
      ;;
  esac
done

case "$BOARD" in
  1)
    FQBN_COMPILE="esp32:esp32:esp32:PartitionScheme=huge_app"
    # FlashMode=dio and 115200 are required for THIS board: the default QIO mode
    # fails to upload on it. See CLAUDE.md.
    FQBN_UPLOAD="esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app"
    PORT_GLOB="/dev/cu.usbserial-*"
    ;;
  2)
    # ESP32-S3 Dev Module: the generic esp32s3 target is what defines
    # CONFIG_IDF_TARGET_ESP32S3, which board.h switches on to select
    # board_es3c35p.h. PSRAM=opi is required - the framebuffer is a 300KB
    # heap_caps_malloc(MALLOC_CAP_SPIRAM) allocation, and octal PSRAM must be
    # enabled in the FQBN for that to succeed at all. FlashMode=dio and
    # USBMode=hwcdc match the demo's own verified working build (see
    # /Users/yujia/projects/demo/FINDINGS.md); hwcdc matters because this
    # board enumerates over native USB-Serial/JTAG, not a CH340.
    #
    # CDCOnBoot=cdc is NOT in the demo's own FQBN and was added after this
    # board's Serial output turned out to be a total void without it: with
    # USBMode=hwcdc but CDCOnBoot left at its default (disabled), the ROM
    # boot text and the panel driver's own ESP_LOG lines still arrive (they
    # go out through the USB-Serial/JTAG console directly), but every
    # Serial.print()/printf() call from the sketch itself is silently
    # swallowed - proven with a sketch containing nothing but
    # Serial.println() in setup() and a 1s-tick loop, verified with
    # CDCOnBoot on and off side by side. Without this, the device would look
    # mute over serial for every future task exactly the way "every call
    # succeeds and the screen stays black" looks like a hardware fault.
    #
    # VERIFIED FOR A FULL FIRMWARE UPLOAD, not just bring-up: the whole sketch
    # compiles and has been flashed and run with this exact FQBN (894534 bytes
    # of flash, 57860 of RAM), and the device then reported HELLO/BUILD, stored
    # a PROVISION, delivered payloads over USB and BLE, and rendered all three
    # tabs. An earlier version of this comment said the sketch did not compile
    # yet; it does.
    FQBN_COMPILE="esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app"
    FQBN_UPLOAD="esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app"
    PORT_GLOB="/dev/cu.usbmodem*"
    ;;
  *)
    echo "unknown --board '$BOARD' (expected 1 or 2)" >&2
    exit 1
    ;;
esac

LABEL="com.deckhand.host"
DOMAIN="gui/$(id -u)"

WAS_SUPERVISED=0
WAS_MANUAL=0
# Set only by a SUCCESSFUL upload. The commit stamp below is gated on it because
# stamping after a failed upload would attribute this commit to the firmware
# still running - and "the About page shows a commit it is not running" is the
# one failure that whole page exists to avoid.
UPLOAD_OK=0

restore() {
  if [ "$WAS_SUPERVISED" = "1" ]; then
    echo "==> restarting supervised host"
    ./host/deckhand-service.sh start >/dev/null 2>&1 || \
      echo "    WARNING: could not restart the service - run ./host/deckhand-service.sh start"
  elif [ "$WAS_MANUAL" = "1" ]; then
    echo "==> restarting host (was started by hand)"
    (cd host && open DeckhandBLE.app --args "$(pwd)/index.mjs")
  fi
  # ---- the commit stamp, board 2's SETTINGS > About ------------------------
  # AFTER the host is back, because the trigger file is delivered BY the host.
  # Board 2 only: board 1 has no About page and refuses FWSTAMP by name.
  #
  # The SHA is stored in NVS rather than compiled in, deliberately. A baked-in
  # SHA would change both binaries on every commit, so board-baseline's
  # byte-for-byte --check would report CHANGED for ever; worse, only flash.sh
  # would inject it, so the binary being baselined would differ from the binary
  # being flashed. The device pairs the SHA with the build stamp that was live
  # when this landed and shows it only while that still matches, so a board
  # flashed by any other route says `unknown` instead of lying.
  if [ "$UPLOAD_OK" = "1" ] && [ "$BOARD" = "2" ]; then
    SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    if [ -n "$SHA" ]; then
      # A dirty tree is NOT the commit. Marked rather than hidden: "6ed2a8f+"
      # says the flashed code was not exactly that commit, which is precisely
      # what you need to know when a build behaves unexpectedly.
      git diff --quiet HEAD 2>/dev/null || SHA="$SHA+"
      for _ in $(seq 1 20); do pgrep -f 'MacOS/Deckhand' >/dev/null && break; sleep 0.5; done
      sleep 2   # the host has to open the port before a command can reach it
      echo "FWSTAMP $SHA" > "$HOME/.claude/deckhand-device-command"
      echo "==> stamped commit $SHA"
    fi
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

if [ "$NO_COMPILE" != "1" ]; then
  echo "==> compiling (board $BOARD)"
  arduino-cli compile --fqbn "$FQBN_COMPILE" "$SKETCH" | tail -3 || exit 1
fi

# The port renumbers between plug-ins (board 1 has been both usbserial-110 and
# -10), so it is resolved every time rather than hardcoded.
PORT=$(ls $PORT_GLOB 2>/dev/null | head -1)
if [ -z "$PORT" ]; then
  echo "no $PORT_GLOB found - is board $BOARD plugged in?"
  exit 1
fi

echo "==> uploading to $PORT"
# pipefail in a subshell so the UPLOAD's status is seen rather than tail's -
# without it every upload, including a failed one, would look successful here.
if (set -o pipefail; arduino-cli upload -p "$PORT" --fqbn "$FQBN_UPLOAD" "$SKETCH" | tail -3); then
  UPLOAD_OK=1
fi
