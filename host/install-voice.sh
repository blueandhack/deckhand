#!/usr/bin/env bash
# Install what dictation needs: whisper.cpp and its model. Idempotent - safe to re-run,
# and it resumes a part-downloaded model rather than starting again.
#
# This is SEPARATE from install.sh on purpose. The model is ~550MB, and someone who has
# not fitted the microphone should not be made to download it to set up a status
# display. install.sh checks for these two things and points here.
#
# THERE ARE TWO PREREQUISITES, and that is the trap this script exists to close.
# `brew install whisper-cpp` gives you the binary but deliberately NOT any model, so
# installing only the binary swaps "whisper-cli: ENOENT" for a nearly identical
# "failed to load model" - easy to read as the install not having worked. Both are
# checked and reported separately below.
set -euo pipefail

BIN="${WHISPER_BIN:-/opt/homebrew/bin/whisper-cli}"
MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin}"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
# A truncated model is the dangerous failure, not a loud one: whisper will happily
# emit confident nonsense from a damaged file, and this pipeline already refuses
# under-98% audio captures for exactly that reason. Anything much under the real
# ~547MB means the download was cut off.
MIN_BYTES=500000000

echo "== Deckhand voice setup =="

# --- 1. the binary ---
if [ -x "$BIN" ] || command -v whisper-cli >/dev/null 2>&1; then
  echo "[1/2] whisper-cli: already installed"
else
  if ! command -v brew >/dev/null 2>&1; then
    echo "[1/2] whisper-cli: MISSING, and Homebrew is not installed."
    echo "      Install it from https://brew.sh then re-run, or build whisper.cpp"
    echo "      yourself and point WHISPER_BIN at the binary."
    exit 1
  fi
  echo "[1/2] whisper-cli: installing via Homebrew"
  brew install whisper-cpp
fi

# --- 2. the model ---
size_of() { [ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo 0; }
have=$(size_of "$MODEL")
if [ "$have" -ge "$MIN_BYTES" ]; then
  echo "[2/2] model: already present ($((have / 1000000)) MB)"
else
  mkdir -p "$(dirname "$MODEL")"
  if [ "$have" -gt 0 ]; then
    echo "[2/2] model: resuming a partial download ($((have / 1000000)) MB so far)"
  else
    echo "[2/2] model: downloading ~547 MB (ggml-large-v3-turbo-q5_0)"
  fi
  # -C - resumes; --fail so an HTML error page never lands on disk looking like a model.
  curl -L --fail --retry 3 -C - -o "$MODEL" "$URL"
  have=$(size_of "$MODEL")
  if [ "$have" -lt "$MIN_BYTES" ]; then
    echo "      FAILED: got only $((have / 1000000)) MB. Leaving the partial file so a"
    echo "      re-run resumes it. A truncated model transcribes as confident nonsense,"
    echo "      so it is not left in place as if it worked."
    exit 1
  fi
fi

# Why this model and not a smaller one: measured on real captures from this mic,
# base.en (141MB) turned "Update CLAUDE.md" into "update, CLAUDE and D5" and invented
# a person's name outright, while large-v3-turbo got both right and still runs at
# ~42x realtime because its decoder is 4 layers rather than 32.
echo
echo "== Voice ready =="
echo "  binary: $(command -v whisper-cli || echo "$BIN")"
echo "  model:  $MODEL ($(( $(size_of "$MODEL") / 1000000 )) MB)"
echo
echo "Restart the host so it picks this up:"
echo "  ./host/deckhand-service.sh stop && ./host/deckhand-service.sh start"
