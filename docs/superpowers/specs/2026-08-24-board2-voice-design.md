# Board 2: voice, on a codec instead of an ADC

**Status:** design. Approved in outline: vendor Espressif's ES8311 driver rather than
hand-writing an init; do capture AND the needs-input beep rather than capture alone.

## Goal

Give board 2 dictation, voice answers and an audible needs-input alert, using the ES8311
I2S codec it actually has instead of porting board 1's analog signal chain.

## The starting position, stated honestly

**Nothing has ever captured audio on this board.** The demo project this port came from
reported "I2S audio PASS - 16 kHz/16-bit stereo, 76800/76800 bytes clocked out", and that
proves only that the I2S peripheral clocked data out: it tested WRITE, it never configured
the codec, and its own notes admit audibility was unverified. The ES8311 is the ADC and the
DAC, so an unconfigured codec produces no samples in either direction no matter how correct
the I2S side is.

So this is bring-up, not wiring, and the failure mode is the one board 1's own notes warn
about at length: a deaf mic is indistinguishable from broken code until something proves the
hardware separately.

## What board 2 changes about the design

Board 1's audio path is almost entirely scar tissue from constraints board 2 does not share:

| board 1 constraint | board 1's answer | board 2 |
|---|---|---|
| CH340 caps at 11.5KB/s | mu-law one-shot, IMA ADPCM streaming | native USB CDC - **linear PCM16 fits at 32KB/s** |
| ~26KB free heap | ~3s capture ceiling, re-measured as features grew | 8MB PSRAM |
| analog amp shares the 3.3V BLE rail | 33.3Hz comb cancelled in software | digital codec - **must be measured, not assumed** |
| MAX4466 needs a trimmer | oscillation at high gain, a live meter to tune it | `es8311_microphone_gain_set()` |

So board 2 sends **raw 16-bit linear PCM at 16kHz**, which is also exactly what Whisper wants -
removing the mu-law and ADPCM decode from its path rather than porting them.

## Decision 1: vendor the driver, do not hand-write the init

Espressif's `components/es8311` from `esp-bsp` (Apache-2.0). The compatibility question that
mattered is already answered: it calls `i2c_master_write_to_device()` and
`i2c_master_write_read_device()`, i.e. **legacy `driver/i2c.h`** - the exact API this board is
pinned to, because linking `Wire` alongside legacy i2c aborts in a global constructor before
`main()` and the board boot-loops with no serial output at all.

`es8311_create(i2c_port_t port, uint16_t addr)` takes an **existing** port, so the codec shares
the bus the touch controller already brought up (touch 0x55, codec 0x18) rather than
initialising a second one.

`es8311_init()` configures capture and playback together, which is why doing the beep as well
costs little beyond the DAC's own volume call - that is the reasoning behind Decision 2.

`es8311_register_dump()` is the diagnostic that makes a wrong register distinguishable from a
dead bus, and it is the reason vendoring beats hand-writing here.

## Decision 2: capture and the needs-input beep

Capture: the REC button, `MICTEST`, `MICMON`, `MICREC`, `MICSTREAM`, dictation, and answering a
pending question by speaking - all of which already exist and are board-agnostic above the
capture layer.

The beep: board 1's is an LEDC square wave on a piezo and **does not port** - board 2 has an
ES8311 DAC into an amplifier whose enable is GPIO1. So the tone becomes generated I2S samples,
and `BOARD_HAS_BEEPER` flips to 1. The amp enable must be driven only while a tone plays, the
same discipline board 1 documents for its own amp (`10K pulled high = muted`), or the speaker
hisses.

## What is reused unchanged, and it is most of the feature

Everything above the capture layer is already written, board-agnostic, and re-derived for 16px
by the type-scale work: the `AUDIO stream`/`bin`/`streamend` wire protocol and its credit
window, `~/Deckhand-audio` capture files, `mic-wav.mjs`, `mic-stt.sh` and whisper, the
clipboard-or-dispatch delivery, the voice result card and its four-stage progress bar, the
answer-by-voice HMAC flow, and the menu-bar surfacing. The host needs **one** new decoder
branch (`codec=pcm16`) because the stream header already carries `codec=`.

Flipping `BOARD_HAS_MIC` to 1 re-enables the REC button, the SETTINGS MIC TEST row and the voice
card - all three of which this branch already gated and sized correctly.

## Decision 3: prove the hardware before trusting a recording

Board 1's bring-up earned this and board 2 gets the same shape:

1. **`es8311_register_dump()` after init** - proves the I2C path and that the registers took.
2. **A DC/level probe before any capture** - board 1's `MICTEST` prints a DC bias that proves
   power AND the signal wire in one number. The codec's equivalent is a silence floor and a
   peak-to-peak under a known sound; a floor pinned at zero means no samples are arriving at all,
   which is a different fault from a quiet mic.
3. **Only then a real capture**, decoded on the Mac and listened to.

`mic-wav.mjs` already refuses a capture under 98% complete, because misaligned audio decodes as
loud garbage and Whisper once transcribed such a file as a confident sentence nobody said. That
guard covers pcm16 for free.

## Open questions this spec does not settle

- **Is there a comb?** Measure with BLE connected and disconnected, as board 1's investigation
  did, and use the spectrum rather than broadband RMS - board 1's own notes record that RMS said
  BLE was innocent while a per-tone analysis found a 33Hz series at +30dB.
- **Where is the microphone physically, and is it analog or digital?**
  `es8311_microphone_config(dev, digital_mic)` needs that answered. The demo's I2C scan found the
  codec but never mentions a capsule, and the board's pin table names no mic pin - so this is a
  hardware fact to establish, not a parameter to guess.
- **MCLK ratio.** Pin 17 is wired; the ES8311 wants a standard multiple of the sample rate
  (256x fs is typical). `es8311_sample_frequency_config()` takes both, so the value must match
  what I2S is actually generating.

## Out of scope

- Board 1. Untouched; byte-identity is the check.
- The 120s streaming cap and the tap-to-stop interaction - both arbitrary choices that already
  work and are not audio-path decisions.
- Removing board 1's mu-law/ADPCM paths. They are that board's only option and stay.
