# A second board: LCDwiki ES3C35P (ESP32-S3, 320x480) — design

**Status:** approved for planning
**Date:** 2026-08-22
**Scope:** phase 1 of 2. Audio (mic, dictation, beeps) is explicitly out and gets its
own spec.

## What this adds

The firmware builds and runs on a SECOND board — the LCDwiki 3.5" ESP32-S3 Display
(ES3C35P), 320x480 ST77922 over QSPI — from the same source tree, chosen by the
`--fqbn` alone. The existing 240x320 ESP32 board keeps working unchanged.

Everything visual and interactive ports: USAGE, SESSIONS, SETTINGS, the keyboard, the
history reader, per-Mac icons, prompt answering, pairing, battery, sleep. **Audio does
not**, by decision — see "Out of scope".

## Why this is a port and not a rewrite

The whole UI is written against TFT_eSPI, which **cannot drive a QSPI panel**. But it
uses only **27 distinct TFT_eSPI methods** across 563 call sites, concentrated in text
and rectangles:

| calls | methods |
|---|---|
| 350 | `setTextDatum`, `drawString`, `setTextColor`, `textWidth`, `setTextSize`, `setFreeFont`, `textsize` |
| 92 | `width`, `height` |
| 78 | `fillRect`, `fillScreen`, `drawRect`, `drawFastHLine`, `drawFastVLine` |
| 11 | `fillSmoothCircle`, `drawSmoothCircle`, `drawSmoothArc`, `fillSmoothRoundRect`, `drawSmoothRoundRect`, `fillTriangle` |
| 8 | `pushImage`, `readRect`, `setSwapBytes`, `getSwapBytes`, `init`, `setRotation`, `writecommand` |

Implement those 27 and ~6,000 lines of UI compile unchanged. That is the entire basis
for this being tractable.

## What the demo project already established

`/Users/yujia/projects/demo` is not a starting point, it is a finished bring-up, and
its findings are load-bearing here rather than background reading:

- **The recovered 63-command ST77922 init sequence** (`st77922_init_cmds.h`). The
  library's default is for a 532x300 panel; with it, `begin()` succeeds, `drawBitmap()`
  returns OK, benchmarks hit 25fps and **the screen stays black**. QSPI has no
  readback, so nothing reports an error.
- **A full frame cannot go out in one SPI transfer.** 320x480 RGB565 is 300KB and
  `spi_master` wants an equally large internal bounce buffer. Push ~32-line strips.
- **`drawBitmap()` defaults to `timeout_ms = 0`, which is non-blocking** — pass -1 or
  DMA reads the framebuffer while you overwrite it.
- **Legacy `driver/i2c.h` only, never `Wire`.** Core 3.x's `Wire` uses `i2c_master`,
  and linking both aborts in a global constructor BEFORE `main()`: the board
  boot-loops with no output at all. `i2c_driver_install` also returns `ESP_FAIL`
  (not `ESP_ERR_INVALID_STATE`) when already installed, so track install state.
- **Recovery from a boot loop is power-on entry**: unplug, hold BOOT, plug in, hold
  ~2s, release. Software resets all fail once firmware aborts every ~300ms.
- **Enumeration proves nothing.** The USB-Serial/JTAG unit is autonomous and keeps
  enumerating with the CPU wedged.
- **pyserial asserts DTR/RTS on open**, pulling IO0 low and landing every reset in
  download mode (`boot:0x23` instead of `boot:0x2b`). Set `.dtr = False` /
  `.rts = False` before `.open()`.
- Verified hardware: 8MB PSRAM (4MB written and verified, 0 bad words), touch alive at
  I2C 0x55, the documented wiring is the only one that answers a QSPI ID read.

## The two boards

| | board 1 (current) | board 2 (new) |
|---|---|---|
| MCU | ESP32 | ESP32-S3, 8MB PSRAM |
| display | 240x320 ILI9341, SPI, TFT_eSPI | 320x480 ST77922, QSPI, ESP32_Display_Panel |
| backlight | LEDC on IO21 | GPIO41 |
| touch | XPT2046 resistive, separate HSPI, 5-point affine calibration | capacitive in the ST77922, I2C 0x55, **no calibration** |
| mic | MAX4466 analog, ADC1 DMA on IO35 | I2S codec (out of scope) |
| speaker | LEDC square wave + FM8002E, IO26/IO4 | I2S + `AMP_EN` GPIO1 (out of scope) |
| battery | divider on IO34 (ADC1) | divider on GPIO8 |
| USB | CH340 (`/dev/cu.usbserial-*`) | native USB-Serial/JTAG (`/dev/cu.usbmodem*`) |
| BLE stack | **Bluedroid** | **NimBLE** |
| extras | — | microSD (SDMMC 4-bit), WS2812 RGB LED |
| DPI | ~167 | ~171 |

The near-identical DPI is why no font work is needed: Cozette 6x13 is the same
physical size in the hand on both.

## Decisions taken

- **A TFT_eSPI-compatible shim over `ESP32_Display_Panel`, drawing into a 320x480
  RGB565 shadow framebuffer in PSRAM (300KB), flushed as dirty rectangles in <=32-line
  strips.** The shim decouples the driver change from the layout change so the two can
  be verified separately. Three things fall out of the shadow buffer that are not
  conveniences: `readRect` works, so `SCREENSHOT` is possible at all on a panel with no
  readback (and is more reliable than board 1's byte-swapped panel read);
  `TFT_eSprite` works, which the crab easter egg needs; and read-modify-write drawing
  works, which the anti-aliased primitives want.
  Rejected: porting the UI to `ESP32_Display_Panel`/LVGL directly (rewrites all 563
  call sites AND every layout at once), and direct-to-panel with no shadow buffer
  (saves 300KB of 8MB and loses screenshots, sprites and AA).
- **Native 320x480 layouts, re-derived, not a scaled 240x320 image.** The screen was
  bought to be used. The cost is explicit: every measured constant and clear box is
  re-derived per board, and that is where this codebase's documented bugs have lived.
- **Board selection is automatic from the FQBN.** The toolchain defines
  `CONFIG_IDF_TARGET_ESP32S3`, so one `board.h` includes the right per-board header. No
  manual switch to forget - a forgotten switch produces a binary that looks right and
  is wrong.
- **Capability flags, and the UI HIDES what a board lacks.** `BOARD_HAS_MIC`,
  `BOARD_HAS_BEEPER`, `BOARD_TOUCH_NEEDS_CAL`, `BOARD_HAS_SD`, `BOARD_HAS_RGBLED`.
  Phase 1 compiles the audio paths out on board 2 and removes the record button, MIC
  TEST and SPEAK-your-answer from the UI, per this repo's existing rule that it never
  offers a control which cannot work.
- **Audio is deferred**, because analog-ADC-DMA capture and an LEDC square wave are not
  portable to an I2S codec: that is a rewrite of capture, ADPCM streaming and tone
  generation, and it needs its own hardware bring-up.

## Per-board header contents

Identical names on both boards, so no UI code branches on board identity:

1. **Pins.** Board 2's come from the demo's `board_pins.h` verbatim.
2. **Layout constants, RE-DERIVED.** Not copied: many are computed. The Codex row's
   label lane is `(93 - 26) / 6 = 11` characters on board 1 because the neighbouring
   field's clear box starts at x=93; on a wider card both numbers change and the
   comment must show the new arithmetic. Same for the content area
   (`height - TAB_BAR_H - FOOTER_H`), card geometry, row-height ladders, and every
   `drawIfChanged` clear box.
3. **Capability flags** as above.
4. **A touch HAL** - one function returning a mapped point. Board 1 keeps XPT2046 plus
   the affine fit; board 2 uses the demo's `ST77922Touch` unchanged, and
   `runCalibration()` becomes a no-op that says calibration is not needed on this
   panel rather than drawing crosshairs nobody can use.

Board 2's display config lives in the SKETCH (`esp_panel_board_custom_conf.h`), which
is strictly better than board 1's `User_Setup.h` having to be copied into the TFT_eSPI
library - a arrangement this repo documents losing to a library reinstall.

## Board-specific code paths (not config)

- **Deep sleep wake.** The S3 has no `ext0`; board 2 uses `ext1` on the touch INT
  (GPIO47, active low) instead of the XPT2046 PENIRQ, and holds GPIO41 for the
  backlight.
- **The BLE per-connection demux.** Board 1 reads `param->write.conn_id` from
  Bluedroid's `onWrite(BLECharacteristic*, esp_ble_gatts_cb_param_t*)`. **Board 2 is
  NimBLE** (`CONFIG_BT_NIMBLE_ENABLED 1`, no Bluedroid), where the peer arrives as
  `onWrite(BLECharacteristic*, ble_gap_conn_desc*)` and the identity is
  `desc->conn_handle`. The overload exists, so the demux IS portable - behind a
  per-backend accessor. Getting this wrong reproduces the documented silent failure
  exactly: two Macs' chunks interleave into corrupt JSON, `handleLine` returns early on
  the parse error, and the screen freezes while both links, both heartbeats and both
  menu bars look healthy.
  `CONFIG_BT_NIMBLE_MAX_CONNECTIONS` is 3, so `MAX_LINKS = 2` still fits.
  `BLE2902` is Bluedroid-only; NimBLE handles the CCCD itself.

## Mac-side changes (small, but not zero)

The protocol, pairing, HMAC and answering are genuinely board-agnostic, and both boards
advertise `Deckhand-XXXX` from their own MAC - so the host's multi-device pairing and
the menu bar's Device picker already handle two devices with no change.

Two things do change:

- `host/index.mjs` matches serial ports against `/usbserial|wchusbserial|SLAB_USBtoUART/i`,
  which is the CH340 family. Board 2 is native USB and enumerates as
  `/dev/cu.usbmodem*`, so **USB would silently never attach** (BLE would still work,
  which is what makes it silent). The matcher widens.
- `flash.sh` hardcodes `/dev/cu.usbserial-*` and one FQBN, twice. It gains a board
  argument.

## Verification

- **The `textWidth` equivalence probe is the linchpin**, because every lane, clear box
  and `fitText` ladder is computed from it. A `TEXTPROBE` command prints measured widths
  for a fixed table of strings and fonts; run it on BOTH boards and diff. Board 1 runs
  real TFT_eSPI, so its output is the reference. This gates the layout work: no
  re-derivation starts until the measurements match.
- **Layout is verified by screenshot on both boards.** `SCREENSHOT` works on board 2 via
  the shadow buffer, so every tab and settings page is captured and inspected. There is
  no other honest way to review re-derived pixel arithmetic.
- **Flush bandwidth is measured, not assumed** - specifically for the two animated
  surfaces: the working spinner (120ms ticks) and the crab (20 frames). If a dirty-rect
  flush cannot keep up, that is a finding, not a surprise to discover later.
- Existing check scripts are unaffected (they are host-side) and must keep passing.

## Phase 1, in five independently verifiable steps

Each ends with something observable on the glass:

1. Shim + shadow framebuffer: the waiting screen renders, backlight on.
2. `TEXTPROBE` equivalence against board 1: measurements proven before any layout work.
3. Layout re-derivation, tab by tab, each screenshotted.
4. Touch: tabs, paging, the keyboard, prompt answering.
5. BLE on NimBLE (including the two-link demux), battery on GPIO8, deep sleep on ext1.

## Out of scope

- **Audio** - mic capture, dictation, ADPCM streaming, beeps. Its own spec.
- microSD and the RGB LED. No feature needs them.
- Any change to board 1's behaviour. If board 1 renders differently after this work,
  that is a regression, and its screenshots are the reference.

## Risks

1. **The NimBLE demux.** Highest, because its failure mode is silent and it is the
   piece the two-Mac feature rests on. Mitigation: step 5 verifies with two real Macs
   and the same frozen-screen symptom as the acceptance test.
2. **`textWidth` drift.** A single-pixel difference in a glyph advance mis-sizes every
   lane on the board. Mitigated by step 2 gating step 3 - and it is a diff, not a
   judgement.
3. **Flush bandwidth for animation.** Unknown until measured. Fallback: slow the
   spinner on board 2, or drop the crab there.
4. **Layout re-derivation volume.** ~100+ constants, and the derived ones must be
   re-derived. This is the bulk of the work and the likeliest place for a quiet
   off-by-one; screenshots per tab are the control.
