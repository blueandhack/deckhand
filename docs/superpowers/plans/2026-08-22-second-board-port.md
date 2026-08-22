# Second board port (ES3C35P) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The firmware builds and runs on a second board — LCDwiki ES3C35P (ESP32-S3, 320x480 ST77922 over QSPI) — from the same source tree, selected by `--fqbn` alone, with the existing 240x320 ESP32 board unchanged.

**Architecture:** A TFT_eSPI-compatible shim implements the 27 methods the UI actually calls, drawing into a 320x480 RGB565 shadow framebuffer in PSRAM and flushing dirty rectangles to the panel in <=32-line strips. Board differences (pins, layout constants, capabilities, touch, sleep, BLE backend) live behind per-board headers chosen automatically from the compile target.

**Tech Stack:** Arduino ESP32 core 3.3.11 (Bluedroid on board 1, **NimBLE on board 2**), TFT_eSPI on board 1, `ESP32_Display_Panel` + the demo's recovered ST77922 init on board 2, Adafruit-GFX bitmap fonts, Node 20+ host.

**Spec:** `docs/superpowers/specs/2026-08-22-second-board-port-design.md`

**Reference bring-up:** `/Users/yujia/projects/demo` — a FINISHED diagnosis of this board, not a sketch. `FINDINGS.md` there is required reading for tasks 2 and 5.

## Global Constraints

- **Board 1 must not change behaviour.** Its screenshots are the reference; a visual difference on board 1 is a regression, not a side effect.
- **Board selection is automatic:** `CONFIG_IDF_TARGET_ESP32S3` is defined by the toolchain, so `board.h` picks the per-board header. Never a hand-edited switch — a forgotten one yields a binary that looks right and is wrong.
- **Board 1 FQBN:** `esp32:esp32:esp32:PartitionScheme=huge_app` (compile), and for upload `esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app`.
- **Board 2 FQBN:** `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,PartitionScheme=huge_app` — `PSRAM=opi`, `FlashMode=dio` and `USBMode=hwcdc` are taken from the demo's own working build, not guessed.
- **Board 2 is native USB:** `/dev/cu.usbmodem*`, NOT `/dev/cu.usbserial-*`. Its USB-Serial/JTAG unit is autonomous, so **enumeration proves nothing** — it keeps enumerating with the CPU wedged.
- **Board 2 recovery from a boot loop is POWER-ON entry:** unplug, hold BOOT, plug in, hold ~2s, release. Software resets all fail once firmware aborts every ~300ms.
- **Any ad-hoc pyserial probe must set `.dtr = False` and `.rts = False` before `.open()`**, or every reset lands in download mode (`boot:0x23` instead of `boot:0x2b`).
- **Legacy `driver/i2c.h` ONLY on board 2, never `Wire`.** Core 3.x's `Wire` uses `i2c_master`; linking both aborts in a global constructor BEFORE `main()` and the board boot-loops with no output. `i2c_driver_install` returns `ESP_FAIL` (not `ESP_ERR_INVALID_STATE`) when already installed, so track install state yourself.
- **A full frame cannot go out in one SPI transfer** (300KB needs an equally large internal bounce buffer). Flush in <=32-line strips. `drawBitmap()` defaults to `timeout_ms = 0` which is NON-BLOCKING — pass -1, or DMA reads the framebuffer while you overwrite it.
- **`textWidth()` must match TFT_eSPI byte-for-byte.** Every lane, clear box and `fitText` ladder in ~6,000 lines is computed from it. Task 3 gates all layout work.
- **No function signature may name `SessionInfo`, `Usage`, `HostLink`, `HostPairing`, `Theme` or `ConfirmAction`** — the Arduino build inserts generated prototypes above those declarations. Helpers take/return int indices or `const char*`.
- **Long commands are backgrounded and polled**, never run as a silent foreground call: `nohup <cmd> > /tmp/x.log 2>&1 &` then `sleep 20; tail -3 /tmp/x.log`. A silent foreground compile or flash has repeatedly tripped an inactivity watchdog on this project.
- **Confirm `Sketch uses` appears in the compile log BEFORE flashing.** `flash.sh --no-compile` will happily flash the previous artifact; that has already produced a falsely "verified" fix here.
- **The device is live and the user depends on it.** Board 1 is attached over USB with a supervised host; a second real Mac comes and goes over BLE. Leave both working.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `firmware/deckhand_display/board.h` | picks the per-board header from the compile target | **create** |
| `firmware/deckhand_display/board_e32r28t.h` | board 1: pins, layout constants, capabilities | **create** (extracted) |
| `firmware/deckhand_display/board_es3c35p.h` | board 2: pins (from the demo), layout constants, capabilities | **create** |
| `firmware/deckhand_display/panel_shim.h` / `.cpp` | the 27-method TFT_eSPI-compatible surface + framebuffer + strip flush | **create** |
| `firmware/deckhand_display/panel_text.cpp` | the shim's GFX-font text renderer and `textWidth` | **create** |
| `firmware/deckhand_display/panel_sprite.h` | the shim's `TFT_eSprite` equivalent | **create** |
| `firmware/deckhand_display/esp_panel_board_custom_conf.h` | board 2 display config + recovered init | **create** (from demo) |
| `firmware/deckhand_display/st77922_touch.h` / `.cpp` | board 2 touch driver | **create** (from demo, verbatim) |
| `firmware/deckhand_display/touch_hal.ino` | one touch entry point over both boards | **create** |
| `firmware/deckhand_display/deckhand_display.ino` | guarded includes, board-conditional sleep/BLE, constants moved out | modify |
| `firmware/deckhand_display/usage.ino`, `sessions.ino`, `settings.ino`, `keyboard.ino`, `reader.ino` | re-derived layout for board 2 | modify |
| `firmware/deckhand_display/pairing.ino`, `audio.ino`, `power.ino` | capability-gated compile-out | modify |
| `host/index.mjs` | widen the serial port matcher | modify |
| `flash.sh` | board argument | modify |
| `CLAUDE.md`, `README.md` | the two-board model and its traps | modify |

---

### Task 1: Board abstraction, with board 1 provably unchanged

The riskiest thing in this task is silently changing board 1. It ends by proving it did not.

**Files:**
- Create: `firmware/deckhand_display/board.h`, `board_e32r28t.h`, `board_es3c35p.h`
- Modify: `firmware/deckhand_display/deckhand_display.ino` (guard the TFT_eSPI include; remove the moved constants)
- Modify: `host/index.mjs:2568-2577` (`findUsbPort`)
- Modify: `flash.sh:20,23,65,67`

**Interfaces:**
- Produces: `BOARD_NAME` (string), `BOARD_W`/`BOARD_H`, every layout constant by its EXISTING name, and capability macros `BOARD_HAS_MIC`, `BOARD_HAS_BEEPER`, `BOARD_HAS_SD`, `BOARD_HAS_RGBLED`, `BOARD_TOUCH_NEEDS_CAL`, `BOARD_USES_TFT_ESPI`, `BOARD_BLE_NIMBLE`.
- Produces: `./flash.sh [--board 1|2] [--no-compile]`, defaulting to board 1 so every existing habit keeps working.

- [ ] **Step 1: Capture the board 1 reference screenshots FIRST**

Before touching anything:
```bash
for t in 0 1 2; do echo "TAB $t" > ~/.claude/deckhand-device-command; sleep 3; echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 22; done
ls -t ~/Deckhand-shots | head -3
```
Record those three filenames in your report. They are the regression reference for every later task, and they cannot be recreated after the refactor.

- [ ] **Step 2: Create `board.h`**

```cpp
// Which board this build targets. Selected from the COMPILE TARGET, never a
// hand-edited switch: the toolchain defines CONFIG_IDF_TARGET_ESP32S3 for the
// S3, so `arduino-cli compile --fqbn esp32:esp32:esp32s3,...` picks board 2 and
// plain esp32 picks board 1. A manual switch is a binary that looks right and
// is wrong when someone forgets to flip it.
#pragma once
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #include "board_es3c35p.h"
#else
  #include "board_e32r28t.h"
#endif
```

- [ ] **Step 3: Extract board 1's constants into `board_e32r28t.h`**

Move — do not retype — the pin defines and every layout constant currently in `deckhand_display.ino`: `TAB_BAR_H`, `CONTENT_Y`, `FOOTER_H`, `CARD_X/W/H`, `CARD1_Y`, `CARD2_Y`, `CODEX_Y`, `CODEX_H`, `PAD`, `BAR_H`, `RADIUS`, `SESSION_ROW_*`, `SESSION_DOT_CX`, `SESSION_TITLE_MIN_H`, `ASK_*`, `DROW_*`, `DEV_CARD_*`, `PAGER_*`, `KB_*`, `OCTO_*`, `TAP_MIN`, `TAB_REC_W`, `REC_R`, `MAC_ROW_W`. Add:

```cpp
#define BOARD_NAME "E32R28T"
#define BOARD_USES_TFT_ESPI  1
#define BOARD_BLE_NIMBLE     0
#define BOARD_HAS_MIC        1
#define BOARD_HAS_BEEPER     1
#define BOARD_HAS_SD         0
#define BOARD_HAS_RGBLED     0
#define BOARD_TOUCH_NEEDS_CAL 1
```

Keep each constant's existing comment WITH it — several document derivations (`CODEX_H` explains why 44 and not 46, `SESSION_TITLE_MIN_H` explains why 85). A constant separated from its derivation is how the next person picks a wrong number.

- [ ] **Step 4: Write `board_es3c35p.h` with pins and capabilities only**

Pins verbatim from `/Users/yujia/projects/demo/ES3C35P_Selftest/board_pins.h`. Capabilities:

```cpp
#define BOARD_NAME "ES3C35P"
#define BOARD_USES_TFT_ESPI  0
#define BOARD_BLE_NIMBLE     1
#define BOARD_HAS_MIC        0   // I2S codec exists; the mic PATH is a later spec
#define BOARD_HAS_BEEPER     0   // same - LEDC square wave does not port to I2S
#define BOARD_HAS_SD         1
#define BOARD_HAS_RGBLED     1
#define BOARD_TOUCH_NEEDS_CAL 0  // capacitive, factory-aligned
```

**Leave the layout constants OUT for now** — Task 6 derives them, and a set of guessed numbers sitting in a header is worse than a compile error, because it looks finished.

- [ ] **Step 5: Guard the TFT_eSPI include**

In `deckhand_display.ino`, `#include <TFT_eSPI.h>` and `TFT_eSPI tft = TFT_eSPI();` become:

```cpp
#include "board.h"
#if BOARD_USES_TFT_ESPI
  #include <TFT_eSPI.h>
  TFT_eSPI tft = TFT_eSPI();
#else
  #include "panel_shim.h"   // arrives in Task 2
  PanelShim tft;
#endif
```

Board 2 will not compile until Task 2. That is expected and correct for this task.

- [ ] **Step 6: Widen the host's port matcher**

`host/index.mjs`'s `findUsbPort` matches the CH340 family only, so board 2 would **silently never attach over USB** while BLE kept working — which is what makes it silent.

```js
  const usb = ports.find(
    (p) =>
      (p.vendorId ?? "").toLowerCase() === "1a86" || // CH340 (board 1)
      (p.vendorId ?? "").toLowerCase() === "303a" || // Espressif native USB (board 2)
      /usbserial|wchusbserial|SLAB_USBtoUART|usbmodem/i.test(p.path)
  );
```

- [ ] **Step 7: Give `flash.sh` a board argument**

Default to board 1 so every existing habit still works. Board 2 needs its own FQBN and its own port glob (`/dev/cu.usbmodem*`). Keep the existing host stop/restore logic for both — it is what makes flashing one command, and it must still restore the host when an upload FAILS.

- [ ] **Step 8: Rebuild board 1 and prove it is byte-identical in behaviour**

```bash
nohup arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display > /tmp/c1.log 2>&1 &
sleep 25; grep -E "Sketch uses|Global variables|Error" /tmp/c1.log
```
Compare the flash and RAM figures against the pre-refactor build (`git stash` the working tree and rebuild if you did not record them). **Identical byte counts are the goal** — moving constants between files must not change the binary. If they differ, something was retyped rather than moved; find it.

Then flash and re-capture the three tabs, and compare against Step 1's screenshots. Report any pixel difference.

- [ ] **Step 9: Commit**

```bash
git add firmware/deckhand_display/board*.h firmware/deckhand_display/deckhand_display.ino host/index.mjs flash.sh
git commit -m "Split board-specific pins, layout and capabilities behind board.h

Selected from the compile target, never a hand-edited switch: a forgotten
switch is a binary that looks right and is wrong. Board 1's constants MOVED
with their comments intact - several document derivations, and a constant
separated from its derivation is how the next person picks a wrong number.
Board 2's layout constants are deliberately absent until they are derived;
guessed numbers in a header look finished, a compile error does not.

The host's port matcher also widens: it matched the CH340 family only, so a
native-USB board would silently never attach over USB while BLE kept working."
```

---

### Task 2: The shim — framebuffer, primitives, and a lit screen

**Files:**
- Create: `firmware/deckhand_display/panel_shim.h`, `panel_shim.cpp`
- Create: `firmware/deckhand_display/esp_panel_board_custom_conf.h` (from the demo, including its recovered init sequence)

**Interfaces:**
- Produces: `class PanelShim` with the non-text half of the surface:
```cpp
class PanelShim {
public:
  void init();                       // panel bring-up + framebuffer alloc
  int  width()  const;               // 320
  int  height() const;               // 480
  void setRotation(uint8_t r);
  void fillScreen(uint16_t c);
  void fillRect(int x, int y, int w, int h, uint16_t c);
  void drawRect(int x, int y, int w, int h, uint16_t c);
  void drawFastHLine(int x, int y, int w, uint16_t c);
  void drawFastVLine(int x, int y, int h, uint16_t c);
  void drawPixel(int x, int y, uint16_t c);
  void pushImage(int x, int y, int w, int h, const uint16_t* data);
  void readRect(int x, int y, int w, int h, uint16_t* out);
  void setSwapBytes(bool s);
  bool getSwapBytes() const;
  void writecommand(uint8_t c);      // no-op on this panel; see the note
  void flush();                      // push dirty rect(s) to the panel
};
```
- Produces: `PanelShim tft;` satisfying Task 1's `#else` branch.

- [ ] **Step 1: Read the demo's bring-up before writing anything**

```bash
sed -n 1,120p /Users/yujia/projects/demo/FINDINGS.md
cat /Users/yujia/projects/demo/ES3C35P_Selftest/esp_panel_board_custom_conf.h
head -40 /Users/yujia/projects/demo/ES3C35P_Selftest/st77922_init_cmds.h
```
The init sequence is **the fix** for this panel — the library's default is for a 532x300 display, and with it every call succeeds while the screen stays black. Copy that config and that sequence; do not write your own.

- [ ] **Step 2: Allocate the framebuffer in PSRAM**

320x480x2 = 300KB via `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`. Fail loudly if it does not allocate — a null framebuffer must not degrade into silent no-op drawing. Report `ESP.getPsramSize()` and the allocation result over serial at boot.

- [ ] **Step 3: Implement the primitives against the framebuffer**

All of them are memory writes into the shadow buffer plus a dirty-rect union. Two that are not obvious:

- **`pushImage`** must honour `swapBytes` exactly as TFT_eSPI does, because the existing art (`ClawdCrab.h`, `DeckhandLogo.h`, the emoji sprites) relies on that behaviour, and getting it wrong is the documented reason the crab's colours came out inverted once already.
- **`readRect`** is a straight framebuffer read. It is the ONLY reason `SCREENSHOT` can work on this board — QSPI has no readback at all. Note that board 1 returns pixels BYTE-SWAPPED from `readRect` while `readPixel` does not; the firmware un-swaps before encoding, so **match board 1's byte order** or every screenshot comes out with the wrong colours.
- **`writecommand`** has two call sites on board 1 (panel sleep in/out). On this panel that goes through the panel driver instead, so make it a no-op with a comment naming what board 1 uses it for, and handle sleep in Task 8.

- [ ] **Step 4: Flush dirty rectangles in <=32-line strips**

Track a dirty rectangle (union of writes since the last flush). `flush()` pushes only that region, split into <=32-line strips, with `drawBitmap(..., timeout_ms = -1)`. **Both halves are from the demo's findings and both are load-bearing**: a full 300KB frame fails to allocate an internal bounce buffer, and the default `timeout_ms = 0` is non-blocking, so DMA reads the framebuffer while you overwrite it.

Where does `flush()` get called from? The UI never calls it. Add it at the end of `loop()` and after each render entry point, so a dirty rect is pushed within one loop iteration. Say in your report which sites you chose.

- [ ] **Step 5: Compile and light the screen**

Add a temporary block at the end of `setup()` — colour bars, a white frame, and a few `fillRect`s at known coordinates:
```bash
nohup arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,PartitionScheme=huge_app" firmware/deckhand_display > /tmp/c2.log 2>&1 &
sleep 30; grep -E "Sketch uses|Error during build" /tmp/c2.log
```
Then flash board 2 (`./flash.sh --board 2 --no-compile`) and LOOK at the screen. Expected: the bars appear in the right places with the right colours, and the backlight is on.

If the screen stays black while every call succeeds, that is the documented failure mode and it means the init sequence did not take — re-check Step 1 rather than the drawing code.

- [ ] **Step 6: Measure the flush**

Time a full-screen flush and a small dirty-rect flush (`micros()` around `flush()`), and print both. Record the numbers: Task 6 needs them, and the animated surfaces (a 120ms spinner tick, a 20-frame crab) live or die on the small-rect figure. Remove the temporary drawing block before committing; keep the timing print behind a `SHIMBENCH` command so it can be re-run.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/panel_shim.* firmware/deckhand_display/esp_panel_board_custom_conf.h
git commit -m "Shim TFT_eSPI's drawing surface onto a PSRAM shadow framebuffer

The UI calls 27 TFT_eSPI methods; this is the non-text half. Drawing goes to a
320x480 RGB565 buffer in PSRAM and only the dirty rectangle is pushed, in
<=32-line strips - a full 300KB frame cannot get an internal bounce buffer, and
drawBitmap defaults to a NON-BLOCKING timeout that lets DMA read the buffer
while you overwrite it. Both facts come from the demo bring-up.

readRect is a framebuffer read, which is the only reason SCREENSHOT can work on
a panel with no readback - and it matches board 1's byte-swapped order, because
the firmware un-swaps before encoding."
```

---

### Task 3: The shim — text, and the equivalence gate

**This task gates every layout task after it.** If `textWidth` disagrees with TFT_eSPI by one pixel, every lane on board 2 is wrong and no amount of screenshot review finds it as fast as a diff.

**Files:**
- Create: `firmware/deckhand_display/panel_text.cpp`
- Modify: `firmware/deckhand_display/panel_shim.h` (text methods)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (the `TEXTPROBE` command)

**Interfaces:**
- Produces, on `PanelShim`:
```cpp
  void setFreeFont(const GFXfont* f);
  void setTextFont(uint8_t f);        // legacy numbered fonts
  void setTextSize(uint8_t s);
  void setTextColor(uint16_t fg, uint16_t bg);
  void setTextDatum(uint8_t d);
  void drawString(const char* s, int x, int y);
  int  textWidth(const char* s);
  uint8_t textsize;                   // read at one site in drawIfChanged
```
- Produces: `TEXTPROBE` — prints `WIDTH <font> <size> <len> "<string>"` lines for a fixed table, on BOTH boards.

- [ ] **Step 1: Read how the fonts are used before implementing**

```bash
grep -n "setUIFont\|UI_FONTS\|uiLineH\|applyContentFont\|FONT_CODE" firmware/deckhand_display/deckhand_display.ino | head -20
```
Three faces exist (`Cozette6x13`, `Terminus10x18b`, and Cozette at size 2), reached through a small registry. `FONT_CODE` (200) is a sentinel, not a real font number. The shim must honour: a GFX free font with `setTextSize` multiplying both axes, and the datum system.

- [ ] **Step 2: Implement the datums the UI actually uses**

```bash
grep -ohE "TL_DATUM|TR_DATUM|MC_DATUM|MR_DATUM|ML_DATUM|TC_DATUM|BL_DATUM|BC_DATUM|BR_DATUM|MC_DATUM" firmware/deckhand_display/*.ino | sort | uniq -c
```
Implement exactly those, and make an unimplemented datum **fail loudly** (log once) rather than silently drawing top-left — a silently wrong datum is a layout bug that looks like a design mistake.

TFT_eSPI's free-font path with `TL_DATUM` adds the font's ascent so the text TOP lands at the given y. Reproduce that, or every string on board 2 sits a few pixels off from board 1.

- [ ] **Step 3: Implement `drawString` and `textWidth` from the same advance table**

Both must walk the same `GFXglyph.xAdvance` sum, times `textsize`. Any divergence between what is drawn and what is measured reproduces the exact 8px overlap the measured-lane code in `drawSessionRow` exists to prevent.

Non-printable and out-of-range characters: Cozette covers `0x20..0x7E` only. Match TFT_eSPI's behaviour for a byte outside that range (it draws nothing and advances nothing) — this matters because the ASCII-only rule is enforced elsewhere by convention, not by validation.

- [ ] **Step 4: Add `TEXTPROBE` to both boards**

A fixed table exercising every font and every string shape the UI measures — the longest labels, the tag forms, digits, and the padded strings that clear boxes are sized from:

```cpp
} else if (buf == "TEXTPROBE") {
  static const char* probe[] = {
    "SESSION - 5 HOUR WINDOW", "WEEK - 7 DAY, ALL MODELS", "CODEX  7d", "CX pro",
    "CLAUDE", "CODEX", "CLAUDE/studio", "WORKING", "NEEDS INPUT", "READY",
    "100% 4.20V ~99h", "0000000", "12:34:56", "100.00M tok", "3d 5h left",
    "Mac  studio  120s ago", "AGENT / MAC", "deckhand", "spectrum-api", "M", "W", "i", "1",
  };
  for (uint8_t f : { (uint8_t)1, (uint8_t)2, (uint8_t)3, (uint8_t)4 })
    for (const char* s : probe) {
      setUIFont(f);
      Serial.printf("WIDTH %u %u %d \"%s\"\n", f, tft.textsize, tft.textWidth(s), s);
    }
}
```

- [ ] **Step 5: Run it on BOTH boards and diff**

```bash
# board 1 (reference: real TFT_eSPI)
echo "TEXTPROBE" > ~/.claude/deckhand-device-command
sleep 4; grep -a "^\[device/usb\] WIDTH" /tmp/deckhand-$(id -u)/host.log | sed 's/.*WIDTH/WIDTH/' | sort > /tmp/width-board1.txt
# then flash board 2, run the same, and:
diff /tmp/width-board1.txt /tmp/width-board2.txt && echo "MEASUREMENTS MATCH"
```
Expected: **no differences at all.** Any line that differs is a bug in the shim's advance summation or datum handling — fix it before Task 6, because Task 6 derives numbers from these measurements.

If board 2's host connection is not up yet, capture over serial directly — but remember DTR/RTS must be false or the board reboots into download mode.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/panel_text.cpp firmware/deckhand_display/panel_shim.h firmware/deckhand_display/deckhand_display.ino
git commit -m "Render GFX-font text in the shim, and prove the widths match

textWidth is the linchpin: every lane, clear box and fitText ladder in the UI
is computed from it, so a one-pixel disagreement mis-sizes the whole board.
drawString and textWidth walk the SAME advance table for that reason - a
divergence between drawn and measured reproduces the exact overlap the
measured-lane code exists to prevent.

TEXTPROBE prints widths for a fixed table on both boards; board 1 runs real
TFT_eSPI, so its output is the reference and the check is a diff rather than a
judgement."
```

---

### Task 4: The shim — anti-aliased primitives and sprites

**Files:**
- Modify: `firmware/deckhand_display/panel_shim.h`, `panel_shim.cpp`
- Create: `firmware/deckhand_display/panel_sprite.h`

**Interfaces:**
- Produces, on `PanelShim`: `fillSmoothCircle`, `drawSmoothCircle`, `drawSmoothArc`, `fillSmoothRoundRect`, `drawSmoothRoundRect`, `fillTriangle` — 11 call sites total.
- Produces: `class PanelSprite` with `createSprite(w,h)` (returns non-null on success), `deleteSprite()`, `fillSprite(uint16_t)`, `pushSprite(int x, int y)`, plus `fillRect`/`drawPixel` so the existing templated `drawCrab` works against it unchanged.

- [ ] **Step 1: Find what the UI actually needs from each**

```bash
grep -n "fillSmoothCircle\|drawSmoothCircle\|drawSmoothArc\|fillSmoothRoundRect\|drawSmoothRoundRect\|fillTriangle" firmware/deckhand_display/*.ino
```
Read `uiCard`, `uiFillRound`, `uiStrokeRound` and `drawStatusDot`. Note the documented `+1`: TFT_eSPI's inner radius is INCLUSIVE for `drawSmoothRoundRect`, and the existing call sites compensate — so the shim must match that convention or every card border shifts by a pixel.

- [ ] **Step 2: Implement the AA primitives against the framebuffer**

Coverage-based anti-aliasing: for each pixel compute distance to the shape edge, blend with the destination using the existing `blend565`. The destination is readable (it is the shadow buffer), which is exactly why the shadow buffer makes these easy.

- [ ] **Step 3: Implement `PanelSprite`**

A sprite is a small RGB565 buffer (PSRAM for the 240x108 crab surface, ~51KB). `pushSprite` blits into the shadow framebuffer and marks the dirty rect. **`createSprite` must return non-null/null the way TFT_eSPI does**, because `startOctopus()` tests exactly that and falls back to direct drawing when a sprite cannot be allocated.

**Do not replicate TFT_eSPI's internal byte-swapped sprite storage.** Board 1's `drawCrab` is templated and uses `fillRect` precisely so it works on either target without byte-order juggling; keep `PanelSprite::fillRect` taking an ordinary `0xF800`-style colour.

- [ ] **Step 4: Verify on the glass**

Board 2 will not render real screens until Task 6, so verify these directly: a temporary `SHIMTEST` command drawing a rounded card, a filled and an outlined status dot, an arc, a triangle and a pushed sprite at known coordinates. Screenshot it (`readRect` works, so `SCREENSHOT` should produce a real PNG — that also proves Task 2's `readRect`), and compare shapes and edge quality against board 1's equivalents.

- [ ] **Step 5: Commit**

```bash
git add firmware/deckhand_display/panel_shim.* firmware/deckhand_display/panel_sprite.h
git commit -m "Anti-aliased primitives and a sprite surface for the shim

Both are easy only because drawing goes to a readable shadow buffer: coverage
blending needs the destination pixel, and a sprite is just another buffer.
createSprite returns null the way TFT_eSPI's does, because startOctopus tests
exactly that and falls back to direct drawing. The sprite deliberately does NOT
copy TFT_eSPI's byte-swapped internal storage - drawCrab is templated and uses
fillRect precisely to avoid that juggling."
```

---

### Task 5: Touch, behind one entry point

**Files:**
- Create: `firmware/deckhand_display/st77922_touch.h`, `st77922_touch.cpp` (verbatim from the demo)
- Create: `firmware/deckhand_display/touch_hal.ino`
- Modify: `firmware/deckhand_display/touch_cal.ino` (board 1 path behind the HAL; `runCalibration()` no-op on board 2)

**Interfaces:**
- Produces: `bool getTouchPoint(int& sx, int& sy)` — the EXISTING name and signature the UI already calls, now board-dispatched. Board 1 keeps XPT2046 plus the affine fit and its screen-flip mirroring; board 2 reads `ST77922Touch`.
- Produces: `void runCalibration()` — unchanged on board 1; on board 2 it prints and draws a one-line "not needed on this panel" notice and returns.

- [ ] **Step 1: Copy the demo's driver verbatim and read its I2C note**

```bash
cp /Users/yujia/projects/demo/ES3C35P_Selftest/st77922_touch.{h,cpp} firmware/deckhand_display/
grep -n -A 8 -i "wire\|legacy" firmware/deckhand_display/st77922_touch.cpp | head -24
```
**This is the boot-loop trap:** core 3.x's `Wire` uses `i2c_master`, and linking it alongside legacy `driver/i2c.h` aborts in a global constructor before `main()` — the board boot-loops with no serial output at all, which looks exactly like bricked firmware. Confirm nothing else in the sketch pulls in `Wire`:
```bash
grep -rn "#include <Wire.h>\|Wire\." firmware/deckhand_display/ | grep -v st77922
```

- [ ] **Step 2: Write the HAL**

```cpp
// One entry point, both boards. The UI calls this and nothing else, so no
// screen, handler or gesture knows which panel it is running on.
bool getTouchPoint(int& sx, int& sy) {
#if BOARD_TOUCH_NEEDS_CAL
  // ... board 1's existing body: raw XPT2046 read, affine map, flip mirroring
#else
  ST77922Point p[1];
  if (g_touch.read(p, 1) < 1) return false;
  sx = p[0].x; sy = p[0].y;   // already panel coordinates, factory-aligned
  return true;
#endif
}
```
Check the controller's reported `x_res`/`y_res` against `BOARD_W`/`BOARD_H` at boot and log a warning if they disagree — a mismatch there would silently halve every coordinate, and it is far cheaper to see the warning than to debug taps landing in the wrong place.

- [ ] **Step 3: Make `runCalibration()` honest on board 2**

It must not draw crosshairs nobody needs, and it must not leave the caller waiting for taps. Print a line and return; the `RECAL` command then reports that this panel is factory-aligned. This matters because `RECAL` is documented as the escape hatch when touch is misaligned — on board 2 the honest answer is "there is nothing to calibrate", not a silent no-op.

- [ ] **Step 4: Verify board 1 is untouched, then board 2 works**

Board 1: flash and confirm touch still works — switch tabs, open a session, page a settings screen. Any change here is a regression.

Board 2: flash and print raw touch reports over serial first (`TOUCHDUMP`, or reuse the demo's probe), confirming coordinates track your finger across all four corners. Only then wire the UI. The tab bar is the easiest real target once Task 6 lands; if it has not, verify with the coordinate dump and say so plainly.

- [ ] **Step 5: Commit**

```bash
git add firmware/deckhand_display/st77922_touch.* firmware/deckhand_display/touch_hal.ino firmware/deckhand_display/touch_cal.ino
git commit -m "One touch entry point over a resistive and a capacitive panel

getTouchPoint keeps its name and signature, so no screen, handler or gesture
knows which panel it runs on. Board 2's controller is factory-aligned, so
runCalibration says so rather than drawing crosshairs nobody needs - RECAL is
documented as the escape hatch for misaligned touch, and on this panel the
honest answer is that there is nothing to calibrate.

The driver comes from the demo verbatim, including its legacy-I2C constraint:
linking Wire alongside driver/i2c.h aborts in a global constructor before
main(), and the board boot-loops with no output, which looks like bricked
firmware rather than a link error."
```

---

### Task 6: Re-derive the layout for 320x480 — USAGE tab

Tasks 6, 7 and 8 are the same shape, one screen group each, and they are the bulk of the port. They are split because a reviewer can meaningfully reject one and approve another.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the USAGE constants)
- Modify: `firmware/deckhand_display/usage.ino` (only where a constant cannot express the change)

**Interfaces:**
- Consumes: proven `textWidth` (Task 3), the shim's primitives (Tasks 2 and 4).
- Produces: `CARD_X`, `CARD_W`, `CARD_H`, `CARD1_Y`, `CARD2_Y`, `CODEX_Y`, `CODEX_H`, `PAD`, `BAR_H`, `RADIUS` for board 2.

- [ ] **Step 1: Re-derive, do not scale**

Read the existing derivations first — they are documented in `usage.ino` and `deckhand_display.ino`, and they are the model for the new ones:
```bash
grep -n -B 4 -A 12 "const int CARD_X" firmware/deckhand_display/deckhand_display.ino
grep -n -B 2 -A 20 "CODEX_H 46 -> 44\|the column ends at 298" firmware/deckhand_display/deckhand_display.ino
```
Board 1's column is derived: content area `320 - 34 - 18 = 268`, spent as `4 + 104 + 4 + 104 + 4 + 44 = 264` with 4px of air. Board 2's content area is `480 - TAB_BAR_H - FOOTER_H`. Write the new arithmetic out in the header comment the same way — a number without its derivation is the thing this codebase keeps getting bitten by.

- [ ] **Step 2: Re-derive the Codex row's label lane**

On board 1 it is 11 characters, because the right-hand field draws at x=214 with `TR_DATUM` and a 20-char padded string (120px), spanning 94..214, so its clear box starts at 93, and the label starts at x=26: `(93 - 26) / 6 = 11`. **Every one of those numbers changes on a wider card.** Recompute and update both the constant and the comment that derives it; `usage.ino` has a long comment doing exactly this, and it must not be left describing board 1's geometry as though it were universal.

- [ ] **Step 3: Check the two clear-box invariants still hold**

Board 1 documents that nothing on a card may end past `y0+101` (the 2px border owns `+102..+103`) and that the label row is `y0+6..y0+19` because the hero number's box starts at `y0+20`. Re-derive both for the new `CARD_H`, and state them in the header.

- [ ] **Step 4: Compile, flash, screenshot, look**

```bash
nohup arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,PartitionScheme=huge_app" firmware/deckhand_display > /tmp/c6.log 2>&1 &
sleep 30; grep -E "Sketch uses|Error during build" /tmp/c6.log
# then ./flash.sh --board 2 --no-compile, then:
echo "TAB 0" > ~/.claude/deckhand-device-command; sleep 3
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```
Read the PNG. Check: both cards and the Codex row fit with air below, no text crosses a border, the hero numbers are not clipped, the pace bars span the right width, and the Mac icon and pin bar sit in the label row correctly.

- [ ] **Step 5: Verify board 1 did not move**

Rebuild and reflash board 1, capture TAB 0, and compare against Task 1's reference screenshot. It must be identical. This step exists because per-board headers make it very easy to edit the wrong one.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage.ino
git commit -m "Derive the USAGE tab's geometry for 320x480

Derived, not scaled: the content area, the card column's air budget, the Codex
row's label lane and both clear-box invariants are each recomputed from this
panel's numbers, with the arithmetic in the comment. The lane in particular is
(clear-box start - label x) / 6 - four numbers that all change on a wider
card, and a copied 11 would have been wrong in a way only a screenshot shows."
```

---

### Task 7: Re-derive the layout for 320x480 — SESSIONS, rows and the detail card

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the session constants)
- Modify: `firmware/deckhand_display/sessions.ino` (only where a constant cannot express the change)

**Interfaces:**
- Produces: `SESSION_ROW_Y0`, `SESSION_ROW_X`, `SESSION_ROW_W`, `SESSION_ROW_GAP`, `SESSION_DOT_CX`, `SESSION_TITLE_MIN_H`, `MAX_SESSIONS`' row-height ladder, `ASK_*`, and the detail card's geometry for board 2.

- [ ] **Step 1: Decide the row count deliberately**

More vertical space means more rows fit — but `MAX_SESSIONS` is 6 **on the host side too** (it caps and urgency-sorts the list before sending, and the device's `sessionsTotal`/`hiddenAsking` strip describes what was cut). Raising it is a protocol-wide change touching `host/index.mjs` and the payload size on a BLE link already measured as the bottleneck. **For this task, keep 6 and use the space for taller rows** — a bigger row count is a separate decision with its own cost, and this plan does not smuggle it in. Say in your report what row height you chose and how much space is left over.

- [ ] **Step 2: Re-derive the row-height ladder**

Board 1 computes row height from the session count (`avail = 264`, tall rows up to 90px for 1-3 sessions, compact 63/50/41 for 4-6) and documents that `SESSION_TITLE_MIN_H` is 85 because the sub-line ends at `y+60` and the pill top is `y+rowH-22`. Recompute from board 2's `avail`, and re-derive `SESSION_TITLE_MIN_H` rather than copying 85.

- [ ] **Step 3: Re-check the name lane and the tag**

`drawSessionRow` measures the name's lane against the tag or pill width. Those are text widths, so they come from Task 3's proven `textWidth` — but the lane's right edge is `SESSION_ROW_X + SESSION_ROW_W - 12`, which moves. Confirm the three-rung font ladder still behaves: on a wider row a long name may now fit at a bigger rung, which is a visible improvement to note rather than a bug.

- [ ] **Step 4: Re-derive the detail card and the ask screen**

The detail card runs 60..284 on board 1 with the history hint at 285..299 against `contentBottom()` 302, and the ask screen's option buttons are `contentBottom() - ASK_OPT_H`. Recompute. Check the keyboard's peek overlay still clears the text card (Task 8 covers the keyboard itself, but the ask screen's geometry is here).

- [ ] **Step 5: Screenshot every state**

With `MULTITEST` for synthetic sessions:
```bash
for n in 1 3 6; do echo "MULTITEST $n" > ~/.claude/deckhand-device-command; sleep 3; echo "TAB 1" > ~/.claude/deckhand-device-command; sleep 2; echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 22; done
```
Read all three PNGs: tall rows (1 and 3 sessions), compact rows (6), the "+N more" strip, status pills clear of the sub-line, the spinner's blit box not biting the row's rounded corner, and the Mac icon/tag not overlapping the name.

- [ ] **Step 6: Verify board 1 unchanged, then commit**

Same board 1 regression check as Task 6, Step 5, with TAB 1.

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/sessions.ino
git commit -m "Derive the sessions list and detail card for 320x480

Row heights, SESSION_TITLE_MIN_H and the detail card's cursor budget are all
recomputed from this panel's content area rather than scaled. MAX_SESSIONS
stays 6 on purpose: it is a host-side cap too, and raising it changes the
payload on a link already measured as the bottleneck - that is a separate
decision, not a side effect of a bigger screen."
```

---

### Task 8: Re-derive the layout for 320x480 — SETTINGS, keyboard, reader

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the remaining constants)
- Modify: `firmware/deckhand_display/settings.ino`, `keyboard.ino`, `reader.ino` (only where a constant cannot express the change)

**Interfaces:**
- Produces: `PAGER_*`, `DROW_*`, `DEV_CARD_*`, `TAP_MIN`, stepper geometry, `KB_*` (key grid, text card, meta row), and the reader's line budget for board 2.

- [ ] **Step 1: SETTINGS pages and steppers**

Board 1's steppers put the label in the middle column so the keys can be 44px (4px over `TAP_MIN`) inside a 56px card whose 2px border owns `+54..+55`. Recompute for the new card height, and keep the property that keys exceed `TAP_MIN` — this is a touch target, and the old geometry was reworked precisely to get there.

Also re-derive the STATUS page's row pitch and the per-Mac rows added for the two-board era.

- [ ] **Step 2: The keyboard's provable budget**

Board 1's keyboard is a derived system: `KB_COLS` 34 comes from `(CARD_W - 8) / 6`, `KB_MAX_BYTES` 150 gives `ceil(150/34) = 5` text lines, keys are drawn 22x40 with a 22x44 touch band, and the meta row and text lines are placed to share no pixel row because `drawString` paints an opaque box. **Re-derive all of it, and state the new `ceil(bytes/cols)` line count.** If a wider card changes `KB_COLS`, the line budget changes with it, and that arithmetic is what keeps SEND from signing text scrolled off the bottom.

Note `ANSWER_TEXT_MAX_BYTES` is 150 on the HOST as well (`host/voice-answer.mjs`), so do not change the byte cap — only the columns and the resulting line count.

- [ ] **Step 3: The reader and history pager**

Recompute the visible-line count and the scrubber's track. `visLines` reserves a row for the "ANSWER ON YOUR MAC" caption on a read-only ask; keep that reservation.

- [ ] **Step 4: Screenshot every page and surface**

```bash
for p in 0 1 2 3; do echo "TAB 2" > ~/.claude/deckhand-device-command; sleep 2; echo "PAGE $p" > ~/.claude/deckhand-device-command; sleep 2; echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 22; done
echo "KBTEST" > ~/.claude/deckhand-device-command; sleep 3; echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```
Read all of them: no row pushed off a page, the pager reachable, steppers' keys big enough, the keyboard's five rows and meta row not overlapping, the caps key legible.

- [ ] **Step 5: Verify board 1 unchanged, then commit**

Same regression check with TAB 2 and `KBTEST`.

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/settings.ino firmware/deckhand_display/keyboard.ino firmware/deckhand_display/reader.ino
git commit -m "Derive settings, keyboard and reader geometry for 320x480

The keyboard is the one that has to be re-derived rather than adjusted: its
column count is (card width - 8) / 6 and its line budget is
ceil(max bytes / columns), and that arithmetic is what stops SEND signing text
scrolled off the bottom. The byte cap stays 150 - it is shared with the host -
so only the columns and the line count move."
```

---

### Task 9: BLE on NimBLE, battery, and sleep

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (BLE callbacks, the demux accessor, sleep)
- Modify: `firmware/deckhand_display/power.ino` (battery ADC pin, backlight hold)

**Interfaces:**
- Produces: `uint16_t bleConnHandle(<callback param>)` — one accessor returning the peer identity per backend, so `bleSlotForConn` and the reap are written once.

- [ ] **Step 1: Confirm the backend and the callback shapes before writing**

```bash
D=$(ls -d ~/Library/Arduino15/packages/esp32/tools/esp32s3-libs/*/ | head -1)
grep -hE "CONFIG_BT_NIMBLE_ENABLED|CONFIG_BT_BLUEDROID_ENABLED|CONFIG_BT_NIMBLE_MAX_CONNECTIONS" $D*/include/sdkconfig.h | sort -u
L=~/Library/Arduino15/packages/esp32/hardware/esp32/3.3.11/libraries/BLE/src
grep -n "virtual void onWrite\|virtual void onConnect\|virtual void onDisconnect" $L/BLECharacteristic.h $L/BLEServer.h
```
Expected: NimBLE enabled, no Bluedroid, `CONFIG_BT_NIMBLE_MAX_CONNECTIONS 3` (so `MAX_LINKS = 2` still fits), and a `ble_gap_conn_desc*` overload alongside the `esp_ble_gatts_cb_param_t*` one board 1 uses.

- [ ] **Step 2: Put the peer identity behind one accessor**

The per-connection demux is the load-bearing piece of the two-Mac feature. Board 1 reads `param->write.conn_id`; board 2 reads `desc->conn_handle`. Write both callback overloads, each extracting the handle and calling the SAME existing framing code — do not fork `drainBleRx`, the reap, or the slot helpers.

**The failure mode if this is wrong is silent**: two Macs' chunks interleave into corrupt JSON, `handleLine` returns early on the parse error, and the screen freezes while both links, both heartbeats and both menu bars look healthy. Say in your report which overload the library actually calls on board 2 — verify it with a temporary log line, do not assume.

- [ ] **Step 3: `BLE2902`**

It is Bluedroid-only; NimBLE manages the CCCD itself. Guard the descriptor's creation on the backend and confirm notifications still reach the host on board 2 (the host logs `[device/ble]` lines for `BATT`).

- [ ] **Step 4: Battery and sleep**

Battery: the divider is on GPIO8. Keep the EMA and the same `pctFromMv` curve — only the pin and any attenuation change. Verify a plausible voltage before trusting the percentage.

Sleep: the S3 has no `ext0`. Use `ext1` on the touch INT (GPIO47, active low) and hold GPIO41 for the backlight. Keep the held-touch wake qualification (`WAKE_HOLD_MS`), because a sleeve or a knock waking the device fully is the reason it exists.

- [ ] **Step 5: Verify with two real Macs**

```bash
grep -a "BLE: connected\|\[device/ble\]" /tmp/deckhand-$(id -u)/host.log | tail -5
```
Then with a second Mac connected, confirm both hosts' payloads parse (the sessions list shows rows from both, tagged), and answer a real prompt from board 2. That last one needs a tap on the glass — if you cannot get a real prompt, say so plainly rather than implying the answer path was exercised.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/power.ino
git commit -m "Run the BLE link, battery and sleep on the S3

The S3 core is NimBLE, not Bluedroid, so the peer identity in a write callback
arrives as ble_gap_conn_desc::conn_handle rather than
esp_ble_gatts_cb_param_t::write.conn_id. That single value is what the
per-connection demux keys on, so it goes behind one accessor and the framing,
reap and slot helpers stay written once - forking them would double the surface
of a failure whose symptom is a frozen screen with everything looking healthy.

Sleep moves to ext1 on the touch INT because the S3 has no ext0, and the
held-touch wake qualification stays: a sleeve waking the device fully is why it
exists."
```

---

### Task 10: Document the two-board model

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Write the CLAUDE.md section**

In this file's voice — fact, then why, then what breaks if undone. It must record:

- **The two boards and their FQBNs**, including that board selection is automatic from `CONFIG_IDF_TARGET_ESP32S3` and why a manual switch was rejected.
- **The shim exists because TFT_eSPI cannot drive a QSPI panel**, and it was viable because the UI uses only 27 distinct methods across 563 call sites. Name the number — it is the reason this was a port.
- **The shadow framebuffer is not a convenience:** QSPI has no readback, so it is the only way `SCREENSHOT` and sprites work at all. Include the measured flush timings from Task 2.
- **`textWidth` equivalence is a gate, and `TEXTPROBE` is how it is proven** — a diff between the two boards, board 1 being real TFT_eSPI.
- **The demo project's four traps**, because they will bite again: the recovered init sequence (or a black screen with every call succeeding), 32-line strips, `drawBitmap(timeout_ms = -1)`, and legacy-I2C-or-boot-loop-before-main.
- **Board 2 is native USB**: `/dev/cu.usbmodem*`, enumeration proves nothing, DTR/RTS false for ad-hoc probes, power-on download-mode recovery.
- **NimBLE versus Bluedroid**, and that the demux's peer identity is the one value that differs.
- **What board 2 does not have:** mic, beeper, and therefore no record button, no MIC TEST, no SPEAK-your-answer — hidden, not disabled, per the existing rule.
- **`MAX_SESSIONS` stayed 6** and why raising it is a protocol change, not a screen change.
- Whatever Task 6-8 measured that contradicts an assumption in this plan.

- [ ] **Step 2: Write the README steps**

Which board is which, how to flash each (`./flash.sh --board 2`), what board 2 cannot do yet, and the recovery procedure for a boot loop.

- [ ] **Step 3: Verify the claims against the code**

```bash
grep -n "BOARD_NAME\|BOARD_HAS_MIC\|BOARD_TOUCH_NEEDS_CAL" firmware/deckhand_display/board_*.h | head
grep -c "tft\." firmware/deckhand_display/*.ino | head -3
node host/mac-emoji-check.mjs && node host/host-tag-check.mjs && node host/line-address-check.mjs
```
Every constant the docs name must exist with the value claimed, and the host checks must still pass. A doc naming a constant that no longer exists is worse than no doc.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the two-board model and the traps behind it

Every number here is derived or measured: the 27-method surface that made a
shim viable rather than a rewrite, the flush timings, the re-derived lanes, and
the four bring-up traps from the demo project that will otherwise be
rediscovered the hard way - a black screen where every call succeeds is the
expensive one."
```

---

## Self-Review

**Spec coverage:**

| spec section | task |
|---|---|
| Shim over ESP32_Display_Panel, 27 methods | 2, 3, 4 |
| PSRAM shadow framebuffer, dirty rect, 32-line strips | 2 |
| `readRect`/`SCREENSHOT` and sprites via the buffer | 2, 4 |
| Native 320x480 layouts, re-derived | 6, 7, 8 |
| Board selection automatic from the FQBN | 1 |
| Per-board header: pins, layout, capabilities, touch HAL | 1, 5, 6, 7, 8 |
| Capability flags hide missing controls | 1 (flags), 6-8 (hiding) |
| Audio deferred | out of scope by design; flags in 1 |
| Deep sleep on ext1, backlight hold | 9 |
| NimBLE demux accessor, `BLE2902` | 9 |
| Host port matcher, `flash.sh` board arg | 1 |
| `TEXTPROBE` equivalence gate | 3 |
| Screenshot verification per screen | 6, 7, 8 |
| Flush bandwidth measured | 2 (measure), 10 (record) |
| Board 1 unchanged | 1 (reference shots), 6-8 (regression checks) |
| Demo findings as constraints | Global Constraints, 2, 5, 10 |

**Placeholder scan:** no "TBD"/"TODO". Tasks 2-4 specify the shim's API surface verbatim and name the per-method traps rather than transcribing several hundred lines of renderer body into the plan; each such step names exactly what to read and what the acceptance test is. Tasks 6-8 deliberately do NOT contain the new constant values — deriving them is the work, and a plan that pre-computed them would either be wrong or make the task a transcription exercise with no verification.

**Type consistency:** `PanelShim` and `PanelSprite` are used under those names in Tasks 1, 2, 3 and 4; `getTouchPoint(int&,int&)` and `runCalibration()` keep their existing signatures in Task 5; `bleConnHandle` is introduced and consumed only in Task 9; `BOARD_*` macros are defined in Task 1 and consumed in 1, 5, 6, 7, 8, 9. `MAX_LINKS` (2) and `MAX_SESSIONS` (6) are unchanged throughout.

**One gap found and closed while reviewing:** Task 1 originally left board 2's layout constants as guessed values so the sketch would compile earlier. That is exactly the "looks finished" failure this plan warns about elsewhere, so Task 1 now omits them deliberately and board 2 first compiles in Task 2 — a compile error is a better placeholder than a plausible number.
