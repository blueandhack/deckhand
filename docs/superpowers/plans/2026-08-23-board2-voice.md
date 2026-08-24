# Board 2 voice: the capture direction

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give board 2 dictation, voice answers and the mic probes, by implementing the
four capture entry points against the ES8311 instead of board 1's ADC-DMA.

**Architecture:** The shared I2S channel and codec handle already exist
(`audioOutBegin()` in `audio.ino`, added by the beeper work) and `begin()` already
enabled the **RX** channel, because `setPins()` passes both `dout` and `din`. So capture
is not a bring-up: it is `es8311_microphone_config()` plus `readBytes()`. The four
functions gain a board-2 implementation beside board 1's, split on
`BOARD_USES_TFT_ESPI` exactly as `startBeep()`/`updateBeep()` now are; everything above
the capture layer (UI pill, wire protocol, host decode, whisper, delivery, HMAC answer
flow) is board-agnostic and reused.

**Tech Stack:** ESP_I2S (`readBytes`), vendored Espressif ES8311 driver, PSRAM for
capture buffers, existing `AUDIO stream`/`bin`/`streamend` protocol, `host/mic-wav.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-24-board2-voice-design.md`

## Global Constraints

- **Board 1 must stay byte-identical: flash 1382802, RAM 69236.** Compile it and compare
  both numbers before believing a change touched only board 2.
- **Never compile both boards concurrently** — one sketch build directory, and the second
  build silently links the first board's objects.
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`
- Flash only via `./flash.sh --board 2`; device commands only via
  `~/.claude/deckhand-device-command`.
- **Legacy `driver/i2c.h` only, never `Wire`** — linking both aborts before `main()`.
- There is no test suite. Verification is: compile, flash, trigger, read the host log,
  look at the glass. State which of those was actually done.
- `es8311_microphone_config(dev, false)` — the mic is ANALOG (`LMA2718B381-OA7` into
  `MIC1P`/`MIC1N`, no clock line). Do not pass `true`.
- MCLK/rate must stay the verified pair: `TONE_MCLK_HZ` (4096000) / `TONE_SAMPLE_HZ`
  (16000).
- Silence is `es8311_voice_mute()`. `PIN_AMP_EN` gates nothing — never use it to mute.

---

### Task 1: Split the guards, and configure the mic

Makes the four functions board-selectable and turns the codec's ADC on. No capture yet —
this task's deliverable is that board 2 compiles with `BOARD_HAS_MIC 1` and reports its
mic configuration, while board 1 stays byte-identical.

**Files:**
- Modify: `firmware/deckhand_display/audio.ino` (guards at lines ~20, ~76, ~444, ~1090)
- Modify: `firmware/deckhand_display/board_es3c35p.h` (`BOARD_HAS_MIC` 0 → 1, mic gain)

- [ ] **Step 1: narrow board 1's two capture blocks**

Change `#if BOARD_HAS_MIC` → `#if BOARD_HAS_MIC && BOARD_USES_TFT_ESPI` at both the
level-probe block (~line 20) and the four-implementation block (~line 444). Board 1's
bodies use `adc_continuous`, `MIC_ADC_PIN` and `analogSetPinAttenuation`, none of which
exist or apply on board 2 — compiling them there is the failure this split prevents.

- [ ] **Step 2: add board 2's block skeleton**

Immediately before the `#else` that holds the stubs, open `#elif BOARD_HAS_MIC` and
define all four functions as bodies that print one line each and nothing more. This keeps
the `#else` stubs for a hypothetical third board with no mic at all — three cases, one
signature each.

- [ ] **Step 3: mic gain constant and flag**

In `board_es3c35p.h`: `BOARD_HAS_MIC 1`, and `#define MIC_GAIN ES8311_MIC_GAIN_30DB` with
a comment recording that the driver offers 0..42dB in 6dB steps and that 30 is a starting
point to be settled by Task 2's meter, not a measured value.

- [ ] **Step 4: configure capture in `audioOutBegin()`**

After `es8311_init()`, add `es8311_microphone_config(audioCodec, false)` and
`es8311_microphone_gain_set(audioCodec, MIC_GAIN)`, each with its return code checked and
logged on the existing `AUDIO OUT:` line. `es8311_init()` already configures both
directions; these two calls are what select the analog input and its gain.

- [ ] **Step 5: compile board 2, then board 1**

```
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/v1b2 firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/v1b1 firmware/deckhand_display
```
Expected: board 2 succeeds; board 1 reports exactly 1382802 / 69236.

- [ ] **Step 6: commit**

---

### Task 2: `MICTEST` — the level probe that proves samples arrive

The spec's Decision 3 step 2. This is the task that distinguishes "no samples at all"
from "a quiet mic", and it must exist before any recording is trusted.

**Files:**
- Modify: `firmware/deckhand_display/audio.ino` (`micLevelTest()` in the board-2 block)

- [ ] **Step 1: read a window and reduce it**

Implement `micLevelTest()`: for each of ten 1-second windows, `readBytes()` into a
stack-modest buffer in a loop, and per window track min, max, mean and a count of samples
at full scale. Report peak-to-peak and the mean as the DC figure.

- [ ] **Step 2: the verdicts, which are the point**

Print, per window and then once overall:
- `pp` pinned at 0 across every window → **no samples are arriving** (I2S RX or the
  codec's ADC), which is a different fault from a quiet mic and must say so by name.
- a floor that never moves under speech → the capsule or its gain.
- full-scale counts > 0 → clipping, so lower `MIC_GAIN`.
Require **3+ elevated windows** before claiming it heard anything, the same rule board 1
uses because speech is sustained and one elevated window is a knock.

- [ ] **Step 3: beep the start cue**

Call `startBeep()` before the window loop so the operator knows when to speak — the
beeper is proven, and board 1's `MICTEST` does the same for the same reason.

- [ ] **Step 4: compile, flash, run**

```
./flash.sh --board 2
echo "MICTEST" > ~/.claude/deckhand-device-command
```
Read the host log. Record the actual DC/floor/peak numbers in the commit message — they
are the first capture measurements this board has ever produced.

- [ ] **Step 5: commit**

---

### Task 3: `MICMON` — the on-device meter, and the gain decision

**Files:**
- Modify: `firmware/deckhand_display/audio.ino` (`micMonitor()` in the board-2 block)

- [ ] **Step 1: implement the loop**

Read a ~30ms window, reduce to a 0..1000 level, draw it with the existing
`micPillMeter()` (board-agnostic, already sized for 16px). Exit on **two consecutive**
`touchPressed()` reads polled at 10ms, and call `micWaitRelease()` **before** the loop —
without it the tap that launched the meter is still down and the loop exits instantly.

- [ ] **Step 2: absorb the tick**

The meter owns the screen, so `handleLine` must not repaint under it — follow whatever
`micStream()` does on board 1 for the same problem, and call `reapBleLinks(true)` in the
loop since `loop()` cannot run during it.

- [ ] **Step 3: verify on the glass, and settle `MIC_GAIN`**

Flash, tap SETTINGS › ACTIONS › MIC TEST, watch the bar while speaking. Pick the highest
gain whose silence floor stays low, and update `MIC_GAIN` to the value actually chosen.
Record both the chosen value and the floor it produced.

- [ ] **Step 4: commit**

---

### Task 4: `MICREC` — one-shot pcm16 capture, and the host branch

Device and host together, because a capture that cannot be decoded proves nothing.

**Files:**
- Modify: `firmware/deckhand_display/audio.ino` (`micRecord()` in the board-2 block)
- Modify: `host/mic-wav.mjs` (a `pcm16` branch)

- [ ] **Step 1: capture into PSRAM**

`heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM)` for the buffer — 8MB available, so a
generous default (say 10s = 320KB) is free where board 1 was capped near 3s by internal
heap. Fail loudly and name the byte count if the allocation fails.

- [ ] **Step 2: emit the existing envelope with the new codec tag**

Reuse `micDumpBase64()` and the `AUDIO begin ... codec=pcm16 rate=16000` header the host
already parses on `codec=`. Do not invent a new envelope; the spec's whole reuse argument
rests on this.

- [ ] **Step 3: host decode branch**

In `mic-wav.mjs`, add `codec=pcm16`: the payload is already little-endian int16 at 16kHz,
so the branch is a passthrough into the WAV writer — no mu-law table, no ADPCM state.
Leave the 98%-completeness refusal untouched; it covers pcm16 for free.

- [ ] **Step 4: decide the comb question with data**

Run one capture with BLE connected and one with it dropped, and compare **spectra**, not
broadband RMS — board 1's notes record RMS calling BLE innocent while a per-tone analysis
found a 33Hz series at +30dB. If no comb is present, say so explicitly in the commit and
do not port the cancellation. If one is present, that is its own task.

- [ ] **Step 5: verify end to end**

```
echo "MICREC" > ~/.claude/deckhand-device-command
node host/mic-wav.mjs
host/mic-stt.sh
```
Expected: a WAV that plays, an SNR figure, and a transcript of what was actually said.

- [ ] **Step 6: commit**

---

### Task 5: `MICSTREAM` and the REC button — streaming pcm16

**Files:**
- Modify: `firmware/deckhand_display/audio.ino` (`micStream()` in the board-2 block)

- [ ] **Step 1: the rate argument, written down**

16kHz x 2 bytes = **32KB/s** raw. Native USB CDC carries it; this is the number that lets
board 2 skip both mu-law and ADPCM, and it belongs in a comment because board 1's entire
codec choice is scar tissue from 11.5KB/s.

- [ ] **Step 2: reuse the protocol and the credit window unchanged**

`AUDIO stream rate=16000 codec=pcm16 chunk=<n>`, then `AUDIO bin <seq> <n>` + raw bytes,
then `AUDIO streamend samples=.. chunks=.. dropped=.. secs=.. by=tap|cap`. Keep the
credit window and its 500ms safety valve: a lost ACK must cost throughput, never wedge
the stream.

- [ ] **Step 3: stop-tap polling separate from the meter repaint**

Poll `touchPressed()` at 10ms requiring two consecutive reads, and repaint the meter on
its own slower timer. Board 1 documents this precisely: sharing one timer made a normal
80-150ms tap fail to register at all.

- [ ] **Step 4: verify a long capture**

Stream ~30s via the REC button. Expected: `dropped=0`, samples matching elapsed time, and
a coherent transcript. Report the real figures.

- [ ] **Step 5: commit**

---

### Task 6: Close the docs and the outstanding items

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-08-24-board2-voice-design.md`

- [ ] **Step 1: retire the stale claims**

`BOARD_HAS_MIC 0` is asserted in several places, including the two-boards table, the
"What board 2 does NOT have" section, and the outstanding item saying **SETTINGS › ACTIONS
› MIC TEST is offered on board 2 and cannot work** — which this plan fixes, so it must be
removed rather than left to mislead.

- [ ] **Step 2: record what is verified and what is not**

Separate "measured on this hardware" from "compiles and looks right", explicitly. The
comb answer, the chosen `MIC_GAIN`, the floor and the streaming figures are measurements;
say so, and say plainly whatever was not checked.

- [ ] **Step 3: commit**
