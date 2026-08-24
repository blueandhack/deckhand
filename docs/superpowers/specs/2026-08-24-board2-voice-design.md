# Board 2: voice, on a codec instead of an ADC

**Status:** design, PARTLY IMPLEMENTED. Approved in outline: vendor Espressif's ES8311 driver
rather than hand-writing an init; do capture AND the needs-input beep rather than capture alone.

**What has already landed, so a reader does not plan it twice:** Decision 1 in full (the driver is
vendored and in use), the BEEP half of Decision 2 (`BOARD_HAS_BEEPER` is 1 and confirmed audible),
and step 1 of Decision 3 (the register dump, as `TONETEST`). The output path is proven end to end -
codec to amp to speaker. **What remains is the CAPTURE direction and its probes**, plus the host's
`codec=pcm16` branch.

Implementation also produced something this spec did not anticipate and which the capture work
should build on rather than duplicate: **one shared I2S channel and codec handle**
(`audioOutBegin()` in `audio.ino`), up at boot and never torn down. Capture needs the SAME
peripheral - the ES8311 records and plays over one I2S channel - and a second `begin()` on that
port FAILS, which is what forced `TONETEST` onto the shared context too.

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
and `BOARD_HAS_BEEPER` flips to 1. **DONE, and confirmed audible.**

**This spec's original instruction here was WRONG and is corrected rather than deleted, because an
implementer would have followed it.** It said the amp enable "must be driven only while a tone
plays... or the speaker hisses", by analogy with board 1's FM8002E. Measured: a 2s tone at EACH
level of GPIO1 was audible, so **the pin gates nothing**. U6's VDD is +5, so its shutdown threshold
sits near that rail and a 3.3V GPIO high cannot reach it. Consequences for the capture work:
silence comes from `es8311_voice_mute()` and never from that pin, and the amp's idle noise floor is
always present - unlike board 1, there is nothing to gate it with. If a hiss turns out to sit in
recordings, it is acoustic or supply-borne, not a mute that was forgotten.

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
   **DONE**, but NOT with the driver's own function: `es8311_register_dump()` writes to UART0's pads
   rather than the USB CDC, so a healthy codec reads as a dead bus, and it `ESP_ERROR_CHECK`s each
   read, so it aborts on exactly the failure it exists to report. `TONETEST` prints all 74 registers
   over `Serial` instead, with `--` per failed read: all dashes is a dead bus, one dash is one bad
   register.
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
- ~~**Where is the microphone physically, and is it analog or digital?**~~ **ANSWERED from
  `vendor/schematic.pdf`, by reading it rather than guessing.** MIC1 is an **`LMA2718B381-OA7`**, a
  4-pin capsule: `OUT` -> net `MIC_OUT`, `VDD` -> `MIC_VDD` (from AU_VCC3V3 through L3, decoupled
  by C33 10uF + C32 100nF), and two GNDs. Its output reaches the codec's **analog `MIC1P`/`MIC1N`**
  inputs (U5 pins 18 and 17) through coupling caps with RF filtering (C34-C40, 10-33pF). **There is
  no clock line to the capsule at all**, which is what rules out PDM - a digital mic would need one,
  and `MIC1P` doubles as `DMIC_SDA` precisely for that case. So
  **`es8311_microphone_config(dev, false)`**. The board pin table names no mic pin because the mic
  does not touch the ESP32: it is entirely on the codec's side of the I2C/I2S boundary.
- ~~**MCLK ratio.**~~ **ANSWERED, and verified on hardware.** `ESP_I2S` hardcodes
  `mclk_multiple = 256`, so at 16kHz MCLK is **4,096,000 Hz** - established by reading
  `ESP_I2S.cpp` rather than assuming, then confirmed by
  `es8311_sample_frequency_config(4096000, 16000)` returning `ESP_OK`, which is the call that fails
  when the two numbers have no `coeff_div[]` row. Capture must pass the same pair; it now comes from
  `TONE_MCLK_HZ`/`TONE_SAMPLE_HZ` in `audio.ino`.

## Out of scope

- Board 1. Untouched; byte-identity is the check.
- The 120s streaming cap and the tap-to-stop interaction - both arbitrary choices that already
  work and are not audio-path decisions.
- Removing board 1's mu-law/ADPCM paths. They are that board's only option and stay.
