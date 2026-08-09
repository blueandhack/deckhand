#!/bin/sh
# Decode the newest MICREC capture and transcribe it locally with whisper.cpp.
#
#   ./mic-stt.sh [loudest|last|<index>]
#
# Local and free: no audio leaves the machine, which matters for a mic that sits
# on the desk all day. On Apple Silicon whisper.cpp runs on Metal - a 4s clip
# transcribes in ~0.5s, i.e. ~8x realtime.
#
# Feeds the CLEANED wav, not the raw one: the raw capture carries the BLE radio's
# 33Hz comb across the whole speech band (see mic-wav.mjs), and Whisper has no
# reason to cope with interference we can simply remove first.
set -e
cd "$(dirname "$0")"

MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin}"
OUT="${DECKHAND_AUDIO:-$HOME/Deckhand-audio}"
PICK="${1:-last}"

if [ ! -f "$MODEL" ]; then
  echo "No Whisper model at $MODEL" >&2
  echo "Get one:  curl -L -o \"$MODEL\" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" >&2
  exit 1
fi

mkdir -p "$OUT"
# Deliberately NOT /tmp: macOS prunes it, and it has already eaten recordings we
# wanted to compare against later.
# mic-wav.mjs exits non-zero on a truncated capture; transcribing one produces
# invented words, so stop rather than print something misleading.
if ! node mic-wav.mjs "" "$OUT/latest.wav" "$PICK"; then
  echo "Refusing to transcribe an incomplete capture." >&2
  exit 2
fi

echo
echo "--- transcript (whisper.cpp, $(basename "$MODEL")) ---"
# Vocabulary priming: "update CLAUDE.md" came back as "update core code MD5"
# without it. Costs nothing and needs no bigger model.
PROMPT="${WHISPER_PROMPT:-Deckhand, CLAUDE.md, README.md, ESP32, firmware, flash, BLE, ADPCM, Whisper, git commit, refactor, repository, session, transcript, host script, microphone.}"
whisper-cli -m "$MODEL" -f "$OUT/latest-clean.wav" -nt \
  --prompt "$PROMPT" --carry-initial-prompt 2>/dev/null | sed '/^$/d'
echo "-------------------------------------------------------"
