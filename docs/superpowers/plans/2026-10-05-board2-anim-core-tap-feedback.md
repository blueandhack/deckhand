# Board 2 Animation Core + Tap Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On board 2, every covered control lights up while pressed, taps act on lift (sliding off cancels), and a small animation core with easing curves drives it. That core is what pieces 2 and 3 build on.

**Architecture:** The press highlight is a single tinted rounded rect that `PanelShim` composites at FLUSH time. It is never drawn into the framebuffer, so nothing can leave a stale tint behind. `anim.ino` owns easing tables, one alpha tween with a 16ms frame clock, and the press state machine. `handleTouch()` defers the tap chain, moved verbatim into `dispatchTap()`, to the lift. The exceptions are the keyboard and the blocking drag lists, which keep their own lift handling.

**Tech Stack:** Arduino C++ for ESP32-S3 (`arduino-cli`), the `PanelShim` renderer (`panel_shim.{h,cpp}`), and Node `.mjs` offline checkers built on `geom-common.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md`. Read it first, especially "Revision 1".

## Global Constraints

- Board 2 only: everything new sits behind `#define BOARD_HAS_ANIM`, which is `1` in `board_es3c35p.h` and `0` in `board_e32r28t.h`. It must be a `#define`, never a `const int`.
- The framebuffer never holds a tint. `anim.ino` must call no drawing primitive; the overlay lives only in `flush()` and `readRect()`.
- Timings: `ANIM_FRAME_MS = 16`, `PRESS_IN_MS = 40`, `PRESS_OUT_MS = 120`, `PRESS_ALPHA = 51` (20%), `PRESS_SLOP_PX = 12`. The tint is `COLOR_ACCENT`.
- Easing: `EASE_OUT_CUBIC` and `EASE_OUT_BACK` (c = 1.5, peak 1106), 33 entries, output 0..1024, using exactly the literals in Task 2.
- Function signatures carry no custom struct types. The `.ino` files are one translation unit with generated prototypes, so rects travel as `int r[6] = {x, y, w, h, radius, identityKey}`.
- A global defined in a later `.ino` is not visible in an earlier one. `anim.ino` sorts first after `deckhand_display.ino`, so it may read only `deckhand_display.ino`'s globals, plus FUNCTIONS from anywhere. Per-surface resolvers live in their own surface's file.
- Every refusal names its cause. `processCompletedLine` handlers set `buf = ""` before every `return`.
- NEVER compile both boards concurrently. Compile board 1, check it, then board 2. A compile takes ~3 minutes, so use a 600000ms timeout.
- `--no-compile` on `flash.sh` is only safe when the last compile was for the same board.
- Commit only on this branch (`anim-core`). Board 1's baseline must be `UNCHANGED` at every commit unless the commit message says why it moved.
- FONTS ARE ASCII `0x20..0x7E`. Every string in this plan is ASCII. Keep it that way.

## Review Focus

1. **The list re-ranks under a held finger.** A session changes status mid-press and a different session slides under the finger. Expected: the tap is DROPPED with a `PRESS: dropped` log line, never opening the wrong session. Pinned by the identity key in `r[5]` plus `pressLift()`'s re-check (Task 3 checker assertion and on-device step).
2. **A payload closes the reply panel between press and lift.** Expected: the tap is dropped and never lands on the screen underneath. Pinned by `pressSurfaceSig()` including `composeOnPanel()` (Task 3).
3. **A press on a scrolling list becomes a drag.** Expected: the tint is gone before the first scroll frame and never sits over moving rows. Pinned by `if (dragged) pressCancel();` in all three drag loops (Task 4 checker plus on-device step).
4. **The host's double delivery of `PRESSTEST`.** Expected: the second copy says "already lit" and changes nothing. Pinned in Task 3's handler and on-device step.
5. **A tap whose action repaints the screen** (THEME segment, tab switch, opening a session). Expected: no ghost tint fading over the new screen. Pinned by `pressAfterDispatch()`'s watch test (Task 3) and the on-device tab-switch step (Task 4).

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `firmware/deckhand_display/panel_shim.h` / `.cpp` | modify | the flush-time overlay; the watch; `extendDirty` split out of `markDirty` |
| `firmware/deckhand_display/anim.ino` | **create** | easing, the tween and `animTick`, the press state machine, `pressRectAt`, `tabPressRect`, `tapBlocksUntilLift`, `pressTestCommand` |
| `firmware/deckhand_display/board_es3c35p.h` / `board_e32r28t.h` | modify | `#define BOARD_HAS_ANIM 1` / `0` |
| `firmware/deckhand_display/sessions.ino` | modify | `sessionsPressRect`, `askPressRect`, `sessionsTapBlocks`; drag-loop hooks |
| `firmware/deckhand_display/projects.ino` | modify | `projPressRect`, `projTapBlocks`; drag-loop hooks |
| `firmware/deckhand_display/settings.ino` | modify | `settingsPressRect` |
| `firmware/deckhand_display/compose.ino` | modify | `composePressRect` |
| `firmware/deckhand_display/scrollback.ino` | modify | `scrollTapBlocks` |
| `firmware/deckhand_display/deckhand_display.ino` | modify | `UI_ACT_GAP`; `handleTouch` split into press/lift plus `dispatchTap`; `animTick` in `loop()`; `PRESSTEST` dispatch and refusal; `PERF anim` line |
| `firmware/deckhand_display/anim-check.mjs` | **create** | the offline checker, grown task by task |
| `firmware/deckhand_display/sessions-geom-check.mjs` | modify | re-anchor the detail-block binding from `handleTouch` to `dispatchTap` |
| `docs/reference/animation.md` | **create** | the reference doc |
| `CLAUDE.md`, `firmware/board-baseline.json` | modify | figures, command row, file map, read-first row |

Compile commands (used by every task):

```bash
# board 1
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
# board 2 - only after board 1 has finished
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```

Driving the device (board 2 cabled, host running via `DeckhandBLE.app`):

```bash
echo "PRESSTEST 160 120" > ~/.claude/deckhand-device-command
tail -n 40 /tmp/deckhand-$(id -u)/host.log        # the device's reply lines
ls -t ~/Deckhand-shots/ | head -1                  # newest SCREENSHOT png
```

---

### Task 1: The flush-time overlay and the watch in `PanelShim`

**Files:**
- Modify: `firmware/deckhand_display/panel_shim.h` (public block after `void flush();`, private block after `markDirty`)
- Modify: `firmware/deckhand_display/panel_shim.cpp:60` (forward-declare `blend565`), `:168` (`markDirty`), `:368` (`readRect`), `:509` (`flush`)
- Create: `firmware/deckhand_display/anim-check.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (on `PanelShim`, used by Task 2 and Task 3):
  - `void setOverlay(int x, int y, int w, int h, int r, uint16_t tint, uint8_t alpha)`: logical rect; `alpha 0` clears it
  - `void clearOverlay()`
  - `void watch(int x, int y, int w, int h)`, `void unwatch()`, `bool watchHit() const`

- [ ] **Step 1: Write the failing checker**

Create `firmware/deckhand_display/anim-check.mjs`:

```js
#!/usr/bin/env node
// anim-check.mjs - board 2's animation core and press feedback (piece 1 of 3).
// docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md, Section 3.
//
// Every assertion reads the firmware's OWN text and transcribes nothing, and each is
// bound to a FUNCTION BODY rather than to a file, so a neighbouring line cannot
// satisfy it. --selftest re-execs this file once per source fault (geom-common's
// sweepSourceFaults) and passes only if every fault is caught BY the assertion it
// was written for.
import { readSource, fnBody, setSourceFault, SOURCE_FAULT_INDEX, faultChildEpilogue,
         sweepSourceFaults } from "./geom-common.mjs";

// [name, file, mutate, expect] - `expect` is a substring of the assertion that must
// catch it. Mutations are functions over the file's text, never transcribed lines.
const FAULTS = [
  ["flush forgets the overlay", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::flush\(\)[\s\S]*?)overlayCovers\(/, "$1overlayGone("),
   "flush()'s OWN BODY composites the press layer"],
  ["readRect forgets the overlay", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::readRect\([\s\S]*?)overlayCovers\(/, "$1overlayGone("),
   "readRect()'s OWN BODY applies the press layer"],
  ["markDirty without the watch", "panel_shim.cpp",
   (t) => t.replace(/_watchHit = true;/, ";"),
   "markDirty()'s OWN BODY runs the watch test"],
  ["setOverlay trips the watch", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::setOverlay\([\s\S]*?)extendDirty\(/, "$1markDirty("),
   "setOverlay's OWN BODY marks through extendDirty"],
];

if (SOURCE_FAULT_INDEX >= 0) {
  const f = FAULTS[SOURCE_FAULT_INDEX];
  setSourceFault(f[1], f[2]);
}
if (process.argv.includes("--selftest")) {
  process.exit(sweepSourceFaults(import.meta.url, FAULTS) ? 0 : 1);
}

let fails = 0;
function chk(ok, msg) {
  if (ok) console.log(`  ok   ${msg}`);
  else { fails++; console.log(`  FAIL ${msg}`); }
}
const strip = (s) => s.replace(/^[ \t]*\/\/.*$/gm, "");

// ---- (3)/(4) the flush-time overlay and the watch: panel_shim.cpp ----
{
  const SHIM = strip(readSource("panel_shim.cpp"));
  const flushB = fnBody(SHIM, "void PanelShim::flush()", "panel_shim.cpp");
  chk(/overlayCovers\(/.test(flushB) && /_ovTint/.test(flushB),
      "flush()'s OWN BODY composites the press layer on the way out - the tint never lives in the framebuffer");
  const rrB = fnBody(SHIM, "void PanelShim::readRect(", "panel_shim.cpp");
  chk(/overlayCovers\(/.test(rrB),
      "readRect()'s OWN BODY applies the press layer, so SCREENSHOT shows what was pushed to the glass");
  const mdB = fnBody(SHIM, "void PanelShim::markDirty(", "panel_shim.cpp");
  chk(/_watchHit = true;/.test(mdB),
      "markDirty()'s OWN BODY runs the watch test - every primitive that dirties a rect can trip it");
  for (const sig of ["void PanelShim::setOverlay(", "void PanelShim::clearOverlay("]) {
    const b = fnBody(SHIM, sig, "panel_shim.cpp");
    const name = sig.slice("void PanelShim::".length, -1);
    chk(/extendDirty\(/.test(b) && !/markDirty\(/.test(b),
        `${name}'s OWN BODY marks through extendDirty, not markDirty - the overlay is not content and must not trip the watch`);
  }
}

faultChildEpilogue();
console.log(fails ? `\n${fails} assertion(s) FAILED` : "\nanim-check: all assertions pass");
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node firmware/deckhand_display/anim-check.mjs`
Expected: it exits non-zero with `fnBody: void PanelShim::setOverlay( not found` (thrown), or with the flush/readRect/markDirty assertions printing `FAIL`.

- [ ] **Step 3: Add the overlay and watch to the header**

In `panel_shim.h`, directly after the line `  void flush();                      // push the dirty rect(s) to the panel`, insert:

```cpp

  // ---- The press layer (anim.ino) ----
  // ONE overlay, composited at FLUSH time and never written into the framebuffer:
  // flush() and readRect() blend `tint` at `alpha` (0..255) into every pixel inside
  // the rounded rect. The framebuffer keeps true content underneath, so anything
  // that redraws there while it is lit stays correct, and clearing it can never
  // paint a stale image back - see docs/reference/animation.md. alpha 0 clears it.
  void setOverlay(int x, int y, int w, int h, int r, uint16_t tint, uint8_t alpha);
  void clearOverlay();
  // "Did anything draw here?" Every primitive that marks a dirty rect tests it
  // against the watched one. The overlay's own marks do not count: it is not content.
  void watch(int x, int y, int w, int h);
  void unwatch();
  bool watchHit() const { return _watchHit; }
```

In the private section, directly after `  void markDirty(int px0, int py0, int px1, int py1);`, insert:

```cpp
  // markDirty minus the watch test - for marks that are not content (the overlay).
  void extendDirty(int px0, int py0, int px1, int py1);
  void logicalToPhysRect(int x, int y, int w, int h, int& px0, int& py0, int& px1, int& py1) const;
  bool overlayCovers(int px, int py) const;
```

and directly after `  int _dirtyX0 = 0, _dirtyY0 = 0, _dirtyX1 = -1, _dirtyY1 = -1;`, insert:

```cpp
  // The press layer, PHYSICAL coordinates. _ovA == 0 means "no overlay".
  int _ovX0 = 0, _ovY0 = 0, _ovX1 = -1, _ovY1 = -1, _ovR = 0;
  uint16_t _ovTint = 0;
  uint8_t  _ovA = 0;
  // The watch, PHYSICAL coordinates. _wX1 < _wX0 means "not watching".
  int _wX0 = 0, _wY0 = 0, _wX1 = -1, _wY1 = -1;
  bool _watchHit = false;
```

- [ ] **Step 4: Implement it in `panel_shim.cpp`**

4a. Directly after the `swap16` definition (around line 60), add the forward declaration. `blend565` is defined at ~line 612, after `flush()` uses it:

```cpp
static inline uint16_t blend565(uint16_t a, uint16_t b, uint8_t t);   // defined below
```

4b. Replace the whole `markDirty` definition (line 168) with:

```cpp
void PanelShim::extendDirty(int px0, int py0, int px1, int py1) {
  if (_dirtyX1 < _dirtyX0) {           // was empty
    _dirtyX0 = px0; _dirtyY0 = py0; _dirtyX1 = px1; _dirtyY1 = py1;
  } else {
    if (px0 < _dirtyX0) _dirtyX0 = px0;
    if (py0 < _dirtyY0) _dirtyY0 = py0;
    if (px1 > _dirtyX1) _dirtyX1 = px1;
    if (py1 > _dirtyY1) _dirtyY1 = py1;
  }
}

void PanelShim::markDirty(int px0, int py0, int px1, int py1) {
  // THE WATCH (anim.ino): did this draw land inside the watched rect? One compare
  // per primitive, and the only way the press layer learns that the action it fired
  // repainted its own control - in which case the change is the feedback and the
  // release flash is skipped.
  if (_wX1 >= _wX0 && px0 <= _wX1 && px1 >= _wX0 && py0 <= _wY1 && py1 >= _wY0)
    _watchHit = true;
  extendDirty(px0, py0, px1, py1);
}

void PanelShim::logicalToPhysRect(int x, int y, int w, int h,
                                  int& px0, int& py0, int& px1, int& py1) const {
  mapPoint(x, y, px0, py0);
  mapPoint(x + w - 1, y + h - 1, px1, py1);
  if (px0 > px1) { int t = px0; px0 = px1; px1 = t; }
  if (py0 > py1) { int t = py0; py0 = py1; py1 = t; }
}

void PanelShim::setOverlay(int x, int y, int w, int h, int r, uint16_t tint, uint8_t alpha) {
  // The OLD rect is pushed too, so moving or shrinking the layer leaves nothing behind.
  if (_ovA) extendDirty(_ovX0, _ovY0, _ovX1, _ovY1);
  clipLogicalRect(x, y, w, h);
  if (alpha == 0 || w <= 0 || h <= 0) { _ovA = 0; return; }
  logicalToPhysRect(x, y, w, h, _ovX0, _ovY0, _ovX1, _ovY1);
  _ovR = r; _ovTint = tint; _ovA = alpha;
  extendDirty(_ovX0, _ovY0, _ovX1, _ovY1);
}

void PanelShim::clearOverlay() {
  if (!_ovA) return;
  extendDirty(_ovX0, _ovY0, _ovX1, _ovY1);
  _ovA = 0;
}

void PanelShim::watch(int x, int y, int w, int h) {
  clipLogicalRect(x, y, w, h);
  _watchHit = false;
  if (w <= 0 || h <= 0) { _wX1 = -1; _wX0 = 0; return; }
  logicalToPhysRect(x, y, w, h, _wX0, _wY0, _wX1, _wY1);
}

void PanelShim::unwatch() { _wX0 = 0; _wX1 = -1; _watchHit = false; }

// Is physical (px,py) inside the overlay's ROUNDED rect? Corners are tested by pixel
// CENTRE against the corner circle, in half-pixel units so it stays integer:
// centre-to-centre distance is (dx + 0.5), squared and doubled -> (2dx+1)^2.
bool PanelShim::overlayCovers(int px, int py) const {
  if (!_ovA || px < _ovX0 || px > _ovX1 || py < _ovY0 || py > _ovY1) return false;
  const int r = _ovR;
  if (r <= 0) return true;
  const int ix = px - _ovX0, iy = py - _ovY0;
  const int w = _ovX1 - _ovX0 + 1, h = _ovY1 - _ovY0 + 1;
  const int dx = ix < r ? r - 1 - ix : (ix >= w - r ? ix - (w - r) : -1);
  const int dy = iy < r ? r - 1 - iy : (iy >= h - r ? iy - (h - r) : -1);
  if (dx < 0 || dy < 0) return true;           // not inside a corner square
  return (2 * dx + 1) * (2 * dx + 1) + (2 * dy + 1) * (2 * dy + 1) <= 4 * r * r;
}
```

4c. In `readRect`, replace the line `        v = _fb[(size_t) py * PANEL_PHYS_W + px];` with:

```cpp
        v = _fb[(size_t) py * PANEL_PHYS_W + px];
        // The press layer too, so a capture shows what flush() pushed to the glass.
        if (overlayCovers(px, py)) v = blend565(v, _ovTint, _ovA);
```

4d. In `flush()`, inside the `for (int r = 0; r < lines; r++)` loop, after the closing `}` of the `if (!panelSwapBytes) { ... } else { ... }` gather and before the loop's own closing `}`, insert:

```cpp
      // THE PRESS LAYER, blended on the way out (setOverlay). AFTER the gather, so it
      // overwrites only the pixels it covers; from the NATIVE source pixel, then the
      // same byte order the gather just used. The framebuffer is never touched.
      const int py = y + r;
      if (_ovA && py >= _ovY0 && py <= _ovY1) {
        const int a = _ovX0 > x0 ? _ovX0 : x0;
        const int b = _ovX1 < x1 ? _ovX1 : x1;
        for (int px = a; px <= b; px++) {
          if (!overlayCovers(px, py)) continue;
          const uint16_t v = blend565(src[px - x0], _ovTint, _ovA);
          dst[px - x0] = panelSwapBytes ? (uint16_t) ((v >> 8) | (v << 8)) : v;
        }
      }
```

- [ ] **Step 5: Run the checker and its selftest**

Run: `node firmware/deckhand_display/anim-check.mjs && node firmware/deckhand_display/anim-check.mjs --selftest`
Expected: `anim-check: all assertions pass`, then `source faults: 4/4 caught`.

- [ ] **Step 6: Compile board 1 (must be untouched), then board 2**

Run the board-1 compile and `--check 1`. Expected: `UNCHANGED`, because `panel_shim.cpp` is wrapped in `#if !defined(CONFIG_IDF_TARGET_ESP32S3)` ... `#endif` and does not compile on board 1. Then compile board 2 and run `--check 2`. Expected: `CHANGED` with a small positive delta (the new methods are present but have no caller yet). Note the size.

Run: `node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2`, then `node firmware/board-baseline.mjs --doc-check`
Expected: `--doc-check` passes (the update rewrote the board-2 figures in `CLAUDE.md`).

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/panel_shim.h firmware/deckhand_display/panel_shim.cpp \
        firmware/deckhand_display/anim-check.mjs firmware/board-baseline.json CLAUDE.md
git commit -m "PanelShim: a press layer composited at flush time, and a draw watch

Board 2 only (panel_shim.cpp does not compile on board 1; --check 1 UNCHANGED).
The overlay is blended into flush()'s gather and readRect(), never into the
framebuffer, so a redraw under a lit control cannot leave a stale tint. The
watch answers one question for anim.ino: did the action repaint its control.
Board 2 re-baselined: +<N> bytes flash, new methods with no caller yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Replace `<N>` with the measured delta from Step 6.)

---

### Task 2: `BOARD_HAS_ANIM`, `anim.ino`'s easing and tween, `animTick` in `loop()`, `PERF anim`

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (after `#define BOARD_SESSIONS_SCROLL 1`, ~line 1248)
- Modify: `firmware/deckhand_display/board_e32r28t.h` (after `#define BOARD_SESSIONS_SCROLL 0`, ~line 103)
- Create: `firmware/deckhand_display/anim.ino`
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`loop()` after `tickSessionAnim();` ~line 9614; the `PERF` handler ~line 8967)
- Modify: `firmware/deckhand_display/anim-check.mjs`

**Interfaces:**
- Consumes: `tft.setOverlay`, `tft.clearOverlay`, `tft.flush` (Task 1); `COLOR_ACCENT` (`deckhand_display.ino`).
- Produces (used by Task 3):
  - `int animEase(uint8_t curve, unsigned long elapsed, unsigned long dur)`, with `ANIM_EASE_CUBIC 0` and `ANIM_EASE_BACK 1`
  - `int animR[6]`, `bool animLit`, `uint8_t animAlpha`, `bool animRunning`
  - `void animLight(const int* r)`: copies 6 ints and sets `animLit`
  - `void animSetAlpha(uint8_t a)`
  - `void animTween(uint8_t to, unsigned long dur)`
  - `void animClear()`
  - `void animTick()`
  - stats `animFrames`, `animFlushTotalUs`, `animFlushWorstUs`, `animTweens`

- [ ] **Step 1: Extend the checker (failing)**

In `anim-check.mjs`, append these entries to `FAULTS`:

```js
  ["cubic table steps back", "anim.ino",
   (t) => t.replace(/(EASE_OUT_CUBIC\[33\]\s*=\s*\{\s*0,\s*)93,/, "$1999,"),
   "EASE_OUT_CUBIC never decreases"],
  ["back table has no overshoot", "anim.ino",
   (t) => t.replace(/(EASE_OUT_BACK\[33\][^}]*?)1106/, "$11024"),
   "EASE_OUT_BACK overshoots by ~8%"],
  ["flag is a const int", "board_es3c35p.h",
   (t) => t.replace(/#define BOARD_HAS_ANIM\s+1/, "const int BOARD_HAS_ANIM = 1;"),
   "board 2: BOARD_HAS_ANIM is a #define"],
  ["anim.ino draws into the framebuffer", "anim.ino",
   (t) => t.replace(/void animSetAlpha\(uint8_t a\) \{/, "void animSetAlpha(uint8_t a) { tft.fillRect(0, 0, 1, 1, 0);"),
   "anim.ino writes nothing into the framebuffer"],
  ["loop forgets animTick", "deckhand_display.ino",
   (t) => t.replace(/#if BOARD_HAS_ANIM\s*\n\s*animTick\(\);\s*\n\s*#endif\s*\n/, ""),
   "loop()'s OWN BODY calls animTick()"],
```

and add this block before `faultChildEpilogue();`:

```js
// ---- (1) easing, (2) flag form, (3) anim.ino draws nothing, loop() ticks it ----
{
  const ANIM_S = strip(readSource("anim.ino"));
  const table = (name) => {
    const m = ANIM_S.match(new RegExp(`${name}\\[33\\]\\s*=\\s*\\{([^}]*)\\}`));
    return m ? m[1].split(",").map((v) => v.trim()).filter((v) => v !== "").map(Number) : [];
  };
  const cub = table("EASE_OUT_CUBIC"), back = table("EASE_OUT_BACK");
  chk(cub.length === 33 && back.length === 33,
      `both easing tables have 33 entries (cubic ${cub.length}, back ${back.length})`);
  chk(cub[0] === 0 && cub[32] === 1024,
      `EASE_OUT_CUBIC starts at 0 and ends at 1024 (${cub[0]}..${cub[32]})`);
  chk(cub.length === 33 && cub.every((v, i) => i === 0 || v >= cub[i - 1]),
      "EASE_OUT_CUBIC never decreases - an ease-out that steps backwards is a visible stutter");
  const peak = back.length ? Math.max(...back) : 0;
  chk(back[0] === 0 && back[32] === 1024,
      `EASE_OUT_BACK starts at 0 and settles at 1024 (${back[0]}..${back[32]})`);
  chk(peak >= 1070 && peak <= 1130,
      `EASE_OUT_BACK overshoots by ~8%: peak ${peak} in [1070, 1130]`);

  for (const [b, file, want] of [["board 1", "board_e32r28t.h", "0"], ["board 2", "board_es3c35p.h", "1"]]) {
    const h = strip(readSource(file));
    const m = h.match(/^\s*#define\s+BOARD_HAS_ANIM\s+(\d+)/m);
    chk(!!m, `${b}: BOARD_HAS_ANIM is a #define - an #if on a const int is silently false`);
    chk(!/const\s+int\s+BOARD_HAS_ANIM/.test(h), `${b}: BOARD_HAS_ANIM is never a const int`);
    chk(m && m[1] === want, `${b}: BOARD_HAS_ANIM is ${want} - the press layer is board 2's alone (spec, Scope)`);
  }

  const DRAW = /\btft\.(fillRect|fillScreen|pushImage|drawPixel|drawString|drawFastHLine|drawFastVLine|drawRect|fillSmooth\w*|drawSmooth\w*|fillTriangle|scrollRect)\(|\bui[A-Z]\w*\(/g;
  const draws = [...ANIM_S.matchAll(DRAW)].map((m) => m[0]);
  chk(draws.length === 0,
      `anim.ino writes nothing into the framebuffer - the press layer is composited at flush time (found: ${draws.join(" ") || "none"})`);

  const MAIN = strip(readSource("deckhand_display.ino"));
  const loopB = fnBody(MAIN, "void loop()", "deckhand_display.ino");
  chk(/#if BOARD_HAS_ANIM\s*\n\s*animTick\(\);\s*\n\s*#endif/.test(loopB),
      "loop()'s OWN BODY calls animTick() under #if BOARD_HAS_ANIM - board 1 never sees the call");
}
```

Run: `node firmware/deckhand_display/anim-check.mjs`
Expected: FAIL (it throws because `anim.ino` cannot be read, or the easing, flag and loop assertions fail).

- [ ] **Step 2: Add the flag to both headers**

In `board_es3c35p.h`, directly after `#define BOARD_SESSIONS_SCROLL 1`:

```cpp
// THE PRESS LAYER AND THE ANIMATION CORE (anim.ino): a tint composited at flush
// time, taps acting on the lift, and the easing every later animation uses. A
// #define, never a const int - an #if on a const int is silently false, which has
// shipped twice. See docs/reference/animation.md.
#define BOARD_HAS_ANIM 1
```

In `board_e32r28t.h`, directly after `#define BOARD_SESSIONS_SCROLL 0`:

```cpp
// No press layer: this board draws straight to the glass through TFT_eSPI, so
// there is no flush to composite a tint into, and taps keep acting on the press.
#define BOARD_HAS_ANIM 0
```

- [ ] **Step 3: Create `anim.ino` with the core**

```cpp
// anim.ino - board 2's animation core: easing, one tween, its frame clock, and the
// press highlight that drives it (further down). ONE #if, the same shape as
// scrollback.ino: board 1 draws straight to the glass and has no flush to composite
// a layer into. See docs/reference/animation.md and
// docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md.
//
// NOTHING IN THIS FILE DRAWS INTO THE FRAMEBUFFER. The press layer is
// PanelShim::setOverlay(), blended on the way out by flush(); anim-check.mjs fails
// by name if a drawing primitive appears here.
#if BOARD_HAS_ANIM

// ---------- EASING ----------
// 33 entries over t = 0..32, output 0..1024, interpolated linearly between entries.
// Generated once (docs/reference/animation.md has the snippet):
//   cubic: 1 - (1-t)^3
//   back:  1 + (c+1)(t-1)^3 + c(t-1)^2, c = 1.5 - the c that peaks at exactly 1.08
// anim-check.mjs validates their SHAPE, not equality to a formula.
static const int16_t EASE_OUT_CUBIC[33] = {
  0, 93, 180, 262, 338, 409, 475, 536, 592, 644, 691, 735, 774, 810, 842, 870, 896,
  919, 938, 955, 970, 982, 993, 1001, 1008, 1013, 1017, 1020, 1022, 1023, 1024, 1024, 1024 };
static const int16_t EASE_OUT_BACK[33] = {
  0, 138, 265, 380, 485, 580, 665, 741, 808, 867, 918, 962, 999, 1030, 1054, 1074, 1088,
  1098, 1104, 1106, 1105, 1102, 1096, 1089, 1080, 1071, 1061, 1052, 1043, 1035, 1029, 1025, 1024 };
#define ANIM_EASE_CUBIC 0
#define ANIM_EASE_BACK  1

int animEase(uint8_t curve, unsigned long elapsed, unsigned long dur) {
  const int16_t* tab = curve == ANIM_EASE_BACK ? EASE_OUT_BACK : EASE_OUT_CUBIC;
  if (dur == 0 || elapsed >= dur) return tab[32];
  const unsigned long fx = elapsed * 32UL * 256UL / dur;   // 8.8 fixed position in the table
  const int i = (int) (fx >> 8), f = (int) (fx & 255);
  return tab[i] + ((tab[i + 1] - tab[i]) * f) / 256;
}

// ---------- THE TWEEN ----------
// ONE tween: the press layer's alpha. Piece 1 never needs two at once; piece 2
// designs its own machinery around the second framebuffer.
const unsigned long ANIM_FRAME_MS = 16;
int animR[6] = {0, 0, 0, 0, 0, 0};   // the lit rect: x, y, w, h, radius, identity key
bool animLit = false;
uint8_t animAlpha = 0;
bool animRunning = false;
uint8_t animFrom = 0, animTo = 0;
unsigned long animT0 = 0, animDur = 0, lastAnimFrameMs = 0;
// PERF anim. n=0 means nothing has animated since boot, which is a different
// statement from "it costs nothing" - the same rule PERF xfade follows.
uint32_t animFrames = 0, animFlushTotalUs = 0, animFlushWorstUs = 0;
uint16_t animTweens = 0;

void animLight(const int* r) {
  memcpy(animR, r, sizeof(animR));
  animLit = true;
}

void animSetAlpha(uint8_t a) {
  animAlpha = a;
  if (!animLit || a == 0) { tft.clearOverlay(); return; }
  tft.setOverlay(animR[0], animR[1], animR[2], animR[3], animR[4], COLOR_ACCENT, a);
}

void animTween(uint8_t to, unsigned long dur) {
  animFrom = animAlpha;
  animTo = to;
  animT0 = millis();
  animDur = dur;
  animRunning = true;
  lastAnimFrameMs = 0;       // the first frame goes out on the very next tick
  animTweens++;
}

// Drops the layer at once, no fade. The next flush pushes the rect without it.
void animClear() {
  animRunning = false;
  animLit = false;
  animAlpha = 0;
  tft.clearOverlay();
}

// One frame per ANIM_FRAME_MS, ONLY while the tween runs - at rest this is one
// comparison, the session crossfade's own contract. A frame is setOverlay plus a
// flush of the lit rect: no compose, the framebuffer is untouched.
void animTick() {
  if (!animRunning) return;
  const unsigned long now = millis();
  if (lastAnimFrameMs != 0 && now - lastAnimFrameMs < ANIM_FRAME_MS) return;
  lastAnimFrameMs = now;
  const int e = animEase(ANIM_EASE_CUBIC, now - animT0, animDur);
  int a = (int) animFrom + ((int) animTo - (int) animFrom) * e / 1024;
  if (a < 0) a = 0;
  if (a > 255) a = 255;
  animSetAlpha((uint8_t) a);
  const uint32_t t0 = micros();
  tft.flush();
  const uint32_t us = micros() - t0;
  animFrames++;
  animFlushTotalUs += us;
  if (us > animFlushWorstUs) animFlushWorstUs = us;
  if (now - animT0 >= animDur) {
    animRunning = false;
    if (animTo == 0) animLit = false;   // faded out: the layer is gone
  }
}

#else
// Board 1: no layer to light. Stubs so the board-2 drag loops carry no #if of
// their own if a future board ever has a scrolling list without this flag.
static inline void animTick() {}
static inline void pressCancel() {}
#endif  // BOARD_HAS_ANIM
```

- [ ] **Step 4: Tick it from `loop()` and report it in `PERF`**

`anim.ino` is concatenated AFTER `deckhand_display.ino`, so its globals are not visible there without declarations (CLAUDE.md: "a global defined in a later file needs an `extern` in `deckhand_display.ino`"). Functions need nothing, because Arduino generates their prototypes. Directly after the existing `extern uint8_t composeScreen;` (~line 1954), add:

```cpp
#if BOARD_HAS_ANIM
// anim.ino is concatenated AFTER this file: its globals need declaring here.
// Tasks 3 and 4 of the anim-core plan add to this block.
extern uint32_t animFrames, animFlushTotalUs, animFlushWorstUs;
extern uint16_t animTweens;
#endif
```

In `deckhand_display.ino`'s `loop()`, directly after the line `  tickSessionAnim();`, insert:

```cpp
#if BOARD_HAS_ANIM
  animTick();
#endif
```

In the `} else if (buf == "PERF") {` handler, directly after the `Serial.printf("PERF shimmer n=%u ...` statement, insert:

```cpp
#if BOARD_HAS_ANIM
    // The press layer (anim.ino): frames are flushes of the lit rect only, so the
    // flush time IS the frame cost. Cumulative since boot, like the lines above.
    Serial.printf("PERF anim    n=%lu flush avg %luus worst %luus tweens=%u\n",
                  (unsigned long) animFrames,
                  (unsigned long) (animFrames ? animFlushTotalUs / animFrames : 0),
                  (unsigned long) animFlushWorstUs, (unsigned) animTweens);
#endif
```

- [ ] **Step 5: Run the checker, its selftest, and the existing checkers**

Run: `node firmware/deckhand_display/anim-check.mjs && node firmware/deckhand_display/anim-check.mjs --selftest && node firmware/deckhand_display/commands-check.mjs`
Expected: all pass; `source faults: 9/9 caught`.

- [ ] **Step 6: Compile board 1, then board 2**

Board 1 `--check 1`: expected `UNCHANGED`. Every new line is behind `BOARD_HAS_ANIM 0`, and the `#else` stubs are uncalled `static inline` functions, which emit no code. If it reports `CHANGED`, stop and find out why before going on: something leaked.
Board 2: compile, then `--update 2`, then `--doc-check`.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/anim.ino firmware/deckhand_display/board_es3c35p.h \
        firmware/deckhand_display/board_e32r28t.h firmware/deckhand_display/deckhand_display.ino \
        firmware/deckhand_display/anim-check.mjs firmware/board-baseline.json CLAUDE.md
git commit -m "anim.ino: easing tables, one alpha tween and its 16ms frame clock

BOARD_HAS_ANIM (#define, 1 on board 2, 0 on board 1). Nothing calls the tween
yet; PERF gains a 'PERF anim' line. Board 1 UNCHANGED (all of it behind the
flag). Board 2 re-baselined: +<N> bytes flash.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The press machine, the per-surface rects, and `PRESSTEST`

This task lights controls but does not change when taps act. It is verified on the glass with `PRESSTEST` plus `SCREENSHOT` before Task 4 touches `handleTouch()`.

**Files:**
- Modify: `firmware/deckhand_display/anim.ino` (inside the `#if BOARD_HAS_ANIM`, after `animTick`)
- Modify: `firmware/deckhand_display/sessions.ino` (after `sessionRowAtY`, ~line 375; after `handleAskTouch`)
- Modify: `firmware/deckhand_display/projects.ino` (after `psessRowAtY`, ~line 697)
- Modify: `firmware/deckhand_display/settings.ino` (before `handleSettingsTouch`, ~line 1638)
- Modify: `firmware/deckhand_display/compose.ino` (before `composeTouch`, ~line 754)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`uiActionRow` ~line 1252; the command chain beside `SESSIONSCROLL` ~line 7698; `UNAVAILABLE_COMMANDS[]` ~line 6880)
- Modify: `firmware/deckhand_display/anim-check.mjs`

**Interfaces:**
- Consumes: everything Task 2 produces; `tft.watch/unwatch/watchHit` (Task 1).
- Produces (used by Task 4):
  - `uint8_t pressState` (0 idle, 1 held, 2 consumed), `int pressX, pressY`
  - `void pressBegin(int sx, int sy)`
  - `void pressMove(int sx, int sy)`
  - `bool pressLift()`
  - `void pressConsume()`
  - `void pressAfterDispatch()`
  - `void pressCancel()`
  - `bool pressRectAt(int sx, int sy, int* r)`, with `r` an `int[6]`
  - `uint32_t pressSurfaceSig()`
  - `void pressTestCommand(String arg)`
  - `const int UI_ACT_GAP`

- [ ] **Step 1: Extend the checker (failing)**

Append to `FAULTS`:

```js
  ["lift trusts a stale surface", "anim.ino",
   (t) => t.replace(/if \(surfaceMoved \|\| !sameRect\)/, "if (false)"),
   "pressLift()'s OWN BODY re-checks"],
  ["session rect guessed by division", "sessions.ino",
   (t) => t.replace(/(bool sessionsPressRect\([\s\S]*?)sessionRowAtY\(sy\)/, "$1((sy - SESSION_ROW_Y0) / SESSION_SCROLL_STEP)"),
   "sessionsPressRect's OWN BODY"],
  ["action row gap transcribed", "deckhand_display.ino",
   (t) => t.replace(/const int gap = UI_ACT_GAP,/, "const int gap = 8,"),
   "uiActionRow's OWN BODY takes its gap from UI_ACT_GAP"],
```

Add before `faultChildEpilogue();`:

```js
// ---- (6) no stale taps; every lit rect comes from its handler's own geometry ----
{
  const ANIM_S = strip(readSource("anim.ino"));
  const liftB = fnBody(ANIM_S, "bool pressLift()", "anim.ino");
  chk(/const bool surfaceMoved = pressSurfaceSig\(\) != pressSig;/.test(liftB) &&
      /pressRectAt\(pressX, pressY, r\)/.test(liftB) &&
      /if \(surfaceMoved \|\| !sameRect\)/.test(liftB),
      "pressLift()'s OWN BODY re-checks the surface and the control under the press point before acting - acting on lift must never act on a control nobody pressed");
  const bind = [
    ["sessions.ino", "bool sessionsPressRect(", [/sessionRowAtY\(sy\)/, /sessionRowYAt\(/, /sessionRowHAt\(/]],
    ["sessions.ino", "bool askPressRect(", [/askOptionsTop\(detailIndex\)/, /ASK_OPT_H \+ ASK_OPT_GAP/]],
    ["projects.ino", "bool projPressRect(", [/projRowAtY\(sy\)/, /psessRowAtY\(sy\)/]],
    ["settings.ino", "bool settingsPressRect(", [/settingsHomeRowY\(i\)/, /CFM_YES_X/]],
    ["compose.ino", "bool composePressRect(", [/composeActX\[i\]/, /UI_ACT_GAP/]],
  ];
  for (const [file, sig, res] of bind) {
    const b = fnBody(strip(readSource(file)), sig, file);
    const name = sig.slice(5, -1);
    chk(res.every((re) => re.test(b)),
        `${name}'s OWN BODY takes its rect from the same helpers its handler hit-tests with - the lit control is the one the tap reaches`);
  }
  const MAIN = strip(readSource("deckhand_display.ino"));
  const rowB = fnBody(MAIN, "int uiActionRow(", "deckhand_display.ino");
  chk(/const int gap = UI_ACT_GAP,/.test(rowB),
      "uiActionRow's OWN BODY takes its gap from UI_ACT_GAP - composePressRect subtracts the same constant, so the lit rect cannot drift off the drawn button");
}
```

Run: `node firmware/deckhand_display/anim-check.mjs`
Expected: FAIL (it throws because `bool pressLift()` is not found).

- [ ] **Step 2: Lift `uiActionRow`'s gap into a constant**

In `deckhand_display.ino`, directly above `int uiActionRow(`, add:

```cpp
// The gap between an action row's buttons. Named because anim.ino's
// composePressRect() subtracts it to light the DRAWN button, not its tested column.
const int UI_ACT_GAP = 8;
```

and in `uiActionRow`'s body change `const int gap = 8, lane = tft.width() - CARD_X * 2;` to `const int gap = UI_ACT_GAP, lane = tft.width() - CARD_X * 2;`.

- [ ] **Step 3: Add the per-surface resolvers beside their hit tests**

`sessions.ino`, directly after `sessionRowAtY()`'s closing brace:

```cpp
#if BOARD_HAS_ANIM
// A 32-bit key for "which thing is this row", so the press layer can tell a
// re-ranked list from an unchanged one: a row's RECT can survive a re-rank while
// the session in it does not. djb2 - collisions only ever DROP a tap, never misfire.
int pressKey(const char* s) {
  uint32_t h = 5381;
  while (*s) h = h * 33 + (uint8_t) *s++;
  return (int) h;
}

// The row the press landed on, from sessionRowAtY() and the SAME two helpers the
// draw uses - so the lit rect is the row the tap opens. Never on the scroll rail:
// sessionDragLoop() treats a press there as a scrub, never a row tap.
bool sessionsPressRect(int sx, int sy, int* r) {
  if (sessionCount <= 0 || sy < SESSION_ROW_Y0) return false;
#if BOARD_SESSIONS_SCROLL
  if (sessionsScrollActive() && sx >= SESSION_RAIL_X - SESSION_RAIL_W) return false;
#endif
  const int pos = sessionRowAtY(sy);
  if (pos < 0) return false;
  r[0] = SESSION_ROW_X; r[1] = sessionRowYAt(pos);
  r[2] = SESSION_ROW_W; r[3] = sessionRowHAt(pos); r[4] = R_MD;
  r[5] = pressKey(sessions[sessionAt(pos)].id);
  return true;
}

// Sessions LIST tab: does the press go to a handler that blocks until the lift?
// The SAME entry condition dispatchTap() tests before sessionDragLoop().
bool sessionsTapBlocks(int sy) {
#if BOARD_SESSIONS_SCROLL
  return sessionCount > 0 && sy >= SESSION_ROW_Y0 && sessionsScrollActive();
#else
  (void) sy;
  return false;
#endif
}
#endif  // BOARD_HAS_ANIM
```

`sessions.ino`, directly after `handleAskTouch()`'s closing brace:

```cpp
#if BOARD_HAS_ANIM
// An answerable option row on the ask screen - handleAskTouch()'s own division,
// so a press in the gap under option k lights k, which is what the tap sends.
// The SPEAK/REPLY row is tested first there and is not lit here.
bool askPressRect(int sx, int sy, int* r) {
  (void) sx;
  if (detailIndex < 0 || detailIndex >= sessionCount) return false;
  const SessionInfo& s = sessions[detailIndex];
  if (!s.askPid[0] || !s.askAnswerable) return false;
  if (askInputRows(detailIndex) && sy >= contentBottom() - ASK_OPT_H) return false;
  const int optTop = askOptionsTop(detailIndex);
  if (sy < optTop) return false;
  const int k = (sy - optTop) / (ASK_OPT_H + ASK_OPT_GAP);
  if (k < 0 || k >= s.askOptCount) return false;
  r[0] = CARD_X; r[1] = optTop + k * (ASK_OPT_H + ASK_OPT_GAP);
  r[2] = CARD_W; r[3] = ASK_OPT_H; r[4] = 8;          // drawSessionDetail's own radius
  r[5] = pressKey(s.askPid) + k;
  return true;
}
#endif
```

`projects.ino`, directly after `psessRowAtY()`'s closing brace. It sits inside the file's existing `#if BOARD_HAS_PROJECTS` region; confirm that by reading the surrounding lines:

```cpp
#if BOARD_HAS_ANIM
// The row under the press on either level, at the same y the row's draw uses.
// The honesty row ("N more", pos == psessCount) opens nothing, so it does not light.
bool projPressRect(int sx, int sy, int* r) {
  (void) sx;
  if (projLevel == 1) {
    if (!psessEverReceived || psessCount == 0) return false;
    const int pos = psessRowAtY(sy);
    if (pos < 0 || pos >= psessCount) return false;
    r[0] = PSESS_ROW_X; r[1] = PSESS_ROW_Y0 + pos * PSESS_STEP - psessScroll;
    r[2] = PSESS_ROW_W; r[3] = PSESS_ROW_H; r[4] = R_MD;
    r[5] = pressKey(psess[pos].id);
    return true;
  }
  if (!projectsEverReceived || projectCount == 0) return false;
  const int pos = projRowAtY(sy);
  if (pos < 0) return false;
  r[0] = PROJ_ROW_X; r[1] = PROJ_ROW_Y0 + pos * PROJ_STEP - projScroll;
  r[2] = PROJ_ROW_W; r[3] = PROJ_ROW_H; r[4] = R_MD;
  r[5] = pressKey(projects[pos].key);
  return true;
}

// Does the press go to one of this tab's blocking drag loops? The SAME entry
// conditions handleProjectsTouch()/handlePSessTouch() test before their loops.
bool projTapBlocks(int sy) {
  if (projLevel == 1)
    return psessEverReceived && psessCount > 0 && sy >= PSESS_ROW_Y0 && psessScrollActive();
  return projectsEverReceived && projectCount > 0 && sy >= PROJ_ROW_Y0 && projScrollActive();
}
#endif
```

`settings.ino`, directly above `void handleSettingsTouch(`:

```cpp
#if BOARD_HAS_ANIM
// HOME's group rows and the confirm dialog's YES/NO - handleSettingsTouch()'s own
// tests, in its own order (the confirm is modal, so it is asked first). Steppers,
// toggles and segments are not lit in piece 1 (docs/reference/animation.md).
bool settingsPressRect(int sx, int sy, int* r) {
  r[5] = 0;
  if (pendingConfirm != CFM_NONE) {
    if (sy < CFM_BTN_Y || sy >= CFM_BTN_Y + H_BTN) return false;
    int x;
    if (sx >= CFM_YES_X && sx < CFM_YES_X + CFM_BTN_W) x = CFM_YES_X;
    else if (sx >= CFM_NO_X && sx < CFM_NO_X + CFM_BTN_W) x = CFM_NO_X;
    else return false;
    r[0] = x; r[1] = CFM_BTN_Y; r[2] = CFM_BTN_W; r[3] = H_BTN; r[4] = R_MD;
    return true;
  }
  if (settingsPage != SET_HOME) return false;
  for (int i = 0; i < SET_GROUP_COUNT; i++) {
    const int y = settingsHomeRowY(i);
    if (sy >= y && sy < y + HOME_ROW_H) {
      r[0] = CARD_X; r[1] = y; r[2] = CARD_W; r[3] = HOME_ROW_H; r[4] = R_MD; r[5] = i;
      return true;
    }
  }
  return false;
}
#endif
```

`compose.ino`, directly above `bool composeTouch(int sx, int sy) {`:

```cpp
#if BOARD_HAS_ANIM
// The reply panel's action band: composeTouch()'s own column test, lighting the
// DRAWN button (uiActionRow draws it UI_ACT_GAP narrower than its tested column,
// except the last one, and KB_ACT_DY down inside the band).
bool composePressRect(int sx, int sy, int* r) {
  if (kbPeekPage >= 0) return false;          // every tap is the pager while peeking
  if (sy < KB_ACT_Y || sy >= KB_ACT_Y + KB_ACT_H) return false;
  for (int i = 0; i < COMPOSE_ACT_MAX; i++) {
    if (composeActW[i] <= 0) continue;
    if (sx < composeActX[i] || sx >= composeActX[i] + composeActW[i]) continue;
    bool last = true;
    for (int j = i + 1; j < COMPOSE_ACT_MAX; j++) if (composeActW[j] > 0) last = false;
    r[0] = composeActX[i]; r[1] = KB_ACT_Y + KB_ACT_DY;
    r[2] = composeActW[i] - (last ? 0 : UI_ACT_GAP); r[3] = KB_ACT_DRAWN; r[4] = R_MD;
    r[5] = i;
    return true;
  }
  return false;
}
#endif
```

- [ ] **Step 4: Add the press machine to `anim.ino`**

Inside `anim.ino`'s `#if BOARD_HAS_ANIM`, after `animTick()`:

```cpp
// ---------- THE PRESS ----------
const uint8_t PRESS_ALPHA = 51;              // 20% toward COLOR_ACCENT
const unsigned long PRESS_IN_MS = 40, PRESS_OUT_MS = 120;
const int PRESS_SLOP_PX = 12;

// 0 = idle; 1 = HELD (a finger is down and the tap waits for its lift);
// 2 = CONSUMED (a blocking handler took the press and acts on its own).
uint8_t pressState = 0;
int pressX = 0, pressY = 0;
uint32_t pressSig = 0;
uint16_t pressSlides = 0, pressDrops = 0;

// Which handler a tap at this instant would reach, packed. Any change between
// press and lift means the lift would land somewhere the press did not.
// composeOnPanel(), not composeScreen: handleTouch() is the only router allowed
// to read the screen directly (settings-geom-check binds that).
uint32_t pressSurfaceSig() {
  uint32_t s = 0;
  s |= (uint32_t) composeActive;
  s |= (uint32_t) composeOnPanel() << 1;
  s |= (uint32_t) pairPanelActive << 2;
  s |= (uint32_t) micProcessing << 3;
  s |= (uint32_t) voiceCardActive << 4;
  s |= (uint32_t) readerActive << 5;
  s |= (uint32_t) histActive << 6;
  s |= (uint32_t) showingDetail << 7;
  s |= (uint32_t) ((int) currentTab & 7) << 8;
  s |= (uint32_t) (settingsPage & 15) << 11;
  s |= (uint32_t) ((int) pendingConfirm & 15) << 15;
#if BOARD_HAS_PROJECTS
  s |= (uint32_t) (projLevel & 3) << 19;
#endif
  s |= (uint32_t) (detailIndex & 255) << 21;
  return s;
}

bool tabPressRect(int sx, int* r) {
  const int tabW = tabsW() / TAB_COUNT;
  const int i = constrain(sx / tabW, 0, TAB_COUNT - 1);
  r[0] = i * tabW; r[1] = 0; r[2] = tabW; r[3] = TAB_BAR_H; r[4] = 0; r[5] = i;
  return true;
}

// The control under (sx, sy), in dispatchTap()'s own surface order. false = no
// covered control: the tap still acts on the lift, it just does not light.
bool pressRectAt(int sx, int sy, int* r) {
  bool lit;
  if (composeActive) lit = composeOnPanel() && !micProcessing && composePressRect(sx, sy, r);
  else if (pairPanelActive || micProcessing || voiceCardActive || readerActive || histActive) lit = false;
  else if (sy < TAB_BAR_H) return tabPressRect(sx, r);
  else if (showingDetail) lit = askPressRect(sx, sy, r);
  else if (sy >= contentBottom()) lit = false;
  else if (currentTab == TAB_SESSIONS) lit = sessionsPressRect(sx, sy, r);
#if BOARD_HAS_PROJECTS
  else if (currentTab == TAB_PROJECTS) lit = projPressRect(sx, sy, r);
#endif
  else if (currentTab == TAB_SETTINGS) lit = settingsPressRect(sx, sy, r);
  else lit = false;                // USAGE: the whole card area pages accounts
  if (!lit) return false;
  // A content rect never tints the chrome: clamp to the content area.
  if (r[1] < TAB_BAR_H) { r[3] -= TAB_BAR_H - r[1]; r[1] = TAB_BAR_H; }
  if (r[1] + r[3] > contentBottom()) r[3] = contentBottom() - r[1];
  return r[3] > 0;
}

// Does the press go to a handler that BLOCKS until the lift (a drag loop) and so
// must be dispatched on the press? Each half lives beside its handler and mirrors
// that handler's own entry condition.
bool tapBlocksUntilLift(int sx, int sy) {
  (void) sx;
  if (composeActive || pairPanelActive || micProcessing || voiceCardActive ||
      readerActive || showingDetail) return false;
#if BOARD_HISTORY_SCROLL
  if (histActive) return scrollTapBlocks(sy);
#endif
  if (sy < TAB_BAR_H || sy >= contentBottom()) return false;
  if (currentTab == TAB_SESSIONS) return sessionsTapBlocks(sy);
#if BOARD_HAS_PROJECTS
  if (currentTab == TAB_PROJECTS) return projTapBlocks(sy);
#endif
  return false;
}

// The finger landed: remember where, and light the control if one is there.
void pressBegin(int sx, int sy) {
  if (animLit) animClear();          // the last tap's release flash, still running
  pressX = sx; pressY = sy;
  pressState = 1;
  pressSig = pressSurfaceSig();
  int r[6];
  if (!pressRectAt(sx, sy, r)) return;
  animLight(r);
  animTween(PRESS_ALPHA, PRESS_IN_MS);
}

static bool pressInside(int sx, int sy) {
  if (!animLit) {
    const int dx = sx - pressX, dy = sy - pressY;
    return dx * dx + dy * dy <= PRESS_SLOP_PX * PRESS_SLOP_PX;
  }
  return sx >= animR[0] - PRESS_SLOP_PX && sx < animR[0] + animR[2] + PRESS_SLOP_PX &&
         sy >= animR[1] - PRESS_SLOP_PX && sy < animR[1] + animR[3] + PRESS_SLOP_PX;
}

// A held finger moved. Off the control (plus slop) cancels: the light fades and
// the lift will act on nothing.
void pressMove(int sx, int sy) {
  if (pressState != 1 || pressInside(sx, sy)) return;
  pressState = 0;
  pressSlides++;
  if (animLit) animTween(0, PRESS_OUT_MS);
}

// The finger lifted. true = act on (pressX, pressY) now. Re-checks that the same
// handler and the same control are still under the press point: acting on the lift
// opened a window the press-commit model never had, and a list that re-ranked or a
// panel that closed in it must DROP the tap, never redirect it.
bool pressLift() {
  if (pressState != 1) { pressState = 0; return false; }
  pressState = 0;
  int r[6];
  const bool lit = pressRectAt(pressX, pressY, r);
  const bool sameRect = lit == animLit && (!lit || memcmp(r, animR, sizeof(animR)) == 0);
  const bool surfaceMoved = pressSurfaceSig() != pressSig;
  if (surfaceMoved || !sameRect) {
    pressDrops++;
    Serial.printf("PRESS: dropped the tap at %d,%d - %s changed while the finger was down, "
                  "so the lift would have landed on a control nobody pressed\n",
                  pressX, pressY, surfaceMoved ? "the screen" : "the control under it");
    if (animLit) animTween(0, PRESS_OUT_MS);
    return false;
  }
  if (animLit) tft.watch(animR[0], animR[1], animR[2], animR[3]);
  return true;
}

// The press went to a handler that blocks until the lift and acts itself. The lift
// branch must not act a second time.
void pressConsume() {
  pressState = 2;
  if (animLit) tft.watch(animR[0], animR[1], animR[2], animR[3]);
}

// After the action ran, from either path. If it repainted its own control (a toggle
// flipped, a screen opened) that change is the feedback and the layer goes at once:
// a tint fading over a different screen would be a ghost. Otherwise, the release flash.
void pressAfterDispatch() {
  const bool redrawn = tft.watchHit();
  tft.unwatch();
  if (!animLit) return;
  if (redrawn) { animClear(); return; }
  animTween(0, PRESS_OUT_MS);
}

// A blocking list decided DRAG, or PRESSTEST off: drop the layer now, before
// anything moves under it.
void pressCancel() {
  pressState = 0;
  tft.unwatch();
  if (animLit) { animClear(); tft.flush(); }
}

// ---------- PRESSTEST ----------
// Lights the press layer at a point and HOLDS it, so a SCREENSHOT can confirm the
// rect sits on the control (readRect applies the layer). Never dispatches: pressState
// stays 0, so a real lift cannot act on it, and the next real press clears it.
void pressTestCommand(String arg) {
  arg.trim();
  if (arg == "off") {
    if (!animLit) { Serial.println("PRESSTEST off: nothing is lit, so there is nothing to release"); return; }
    pressCancel();
    Serial.println("PRESSTEST off: released WITHOUT acting - nothing was dispatched");
    return;
  }
  const char* onPress = isAsleep        ? "the screen is asleep - a tap there only wakes it"
                      : octoActive      ? "the octopus is up - any tap dismisses it, on the press"
                      : emojiTestActive ? "the icon grid is up - any tap dismisses it, on the press"
                      : composeOnKeys() ? "the keyboard is up - its key band arms on the press and commits on its own lift"
                      : nullptr;
  if (onPress) { Serial.printf("PRESSTEST refused: %s, so there is no held state to light\n", onPress); return; }
  const int sp = arg.indexOf(' ');
  bool numeric = sp > 0 && sp < (int) arg.length() - 1;
  for (unsigned int i = 0; numeric && i < arg.length(); i++)
    if ((int) i != sp && (arg[i] < '0' || arg[i] > '9')) numeric = false;
  if (!numeric) {
    Serial.printf("PRESSTEST refused: \"%s\" is not \"<x> <y>\" (x 0..%d, y 0..%d) or \"off\"\n",
                  arg.c_str(), tft.width() - 1, tft.height() - 1);
    return;
  }
  const int x = arg.substring(0, sp).toInt(), y = arg.substring(sp + 1).toInt();
  if (x >= tft.width() || y >= tft.height()) {
    Serial.printf("PRESSTEST refused: %d,%d is off the panel (x 0..%d, y 0..%d)\n",
                  x, y, tft.width() - 1, tft.height() - 1);
    return;
  }
  int r[6];
  if (!pressRectAt(x, y, r)) {
    Serial.printf("PRESSTEST refused: nothing lights at %d,%d - no covered control is there "
                  "(docs/reference/animation.md lists what piece 1 covers)\n", x, y);
    return;
  }
  // The host delivers every command over BOTH transports. Lighting is idempotent,
  // but say so rather than re-flushing, so the log shows the second copy arrived.
  if (animLit && !animRunning && animAlpha == PRESS_ALPHA && memcmp(r, animR, sizeof(animR)) == 0) {
    Serial.printf("PRESSTEST: already lit at %d,%d %dx%d - the second copy of a double-delivered command, nothing to do\n",
                  r[0], r[1], r[2], r[3]);
    return;
  }
  pressCancel();
  animLight(r);
  animSetAlpha(PRESS_ALPHA);
  tft.flush();
  Serial.printf("PRESSTEST: lit %d,%d %dx%d r=%d at alpha %d for the point %d,%d - SCREENSHOT shows it; PRESSTEST off releases without acting\n",
                r[0], r[1], r[2], r[3], r[4], PRESS_ALPHA, x, y);
}
```

`tapBlocksUntilLift` calls `scrollTapBlocks`. Add it to `scrollback.ino` (a board-2-only file), directly after `handleScrollTouch()`'s closing brace:

```cpp
#if BOARD_HAS_ANIM
// Does a press here go to scrollDragLoop()? handleScrollTouch()'s own test for its
// drag branch: the body, no fetch in flight, and not the dead end (whose tap is a
// retry, not a drag, and so waits for the lift like any other tap).
bool scrollTapBlocks(int sy) {
  return sy >= SCROLL_TOP && sy < SCROLL_BOT && !scrollPending && !scrollDeadEnd();
}
#endif
```

Then open `handleScrollTouch()` and confirm its drag branch is exactly `if (sy >= SCROLL_TOP && sy < SCROLL_BOT && !scrollPending)` with `scrollDeadEnd()` handled first inside it. If it differs, mirror what is actually there.

- [ ] **Step 5: Wire `PRESSTEST` into the command chain and the refusal table**

In `deckhand_display.ino`, directly before `#if BOARD_SESSIONS_SCROLL` / `} else if (buf.startsWith("SESSIONSCROLL")) {` (~line 7697), insert:

```cpp
#if BOARD_HAS_ANIM
  } else if (buf.startsWith("PRESSTEST")) {
    // Lights the press layer at a point so a capture can check the rect against
    // the control. Never dispatches. See pressTestCommand() in anim.ino.
    pressTestCommand(buf.length() > 9 ? buf.substring(9) : String(""));
    buf = "";   // see DETAIL's note: a handler that returns without this repeats forever
    return;
#endif
```

In `UNAVAILABLE_COMMANDS[]`, directly after the `#if !BOARD_SESSIONS_SCROLL` ... `#endif` entry for `SESSIONSCROLL`, insert:

```cpp
#if !BOARD_HAS_ANIM
  { "PRESSTEST",
    "it lights the press highlight board 2 composites at flush time (PanelShim::setOverlay) "
    "and holds it, so a SCREENSHOT can check the lit rect against the control. This board "
    "is BOARD_HAS_ANIM 0: it draws straight to the glass through TFT_eSPI with no flush to "
    "composite a layer into, and its taps still act on the press, so there is no held "
    "state to light." },
#endif
```

Then complete the `PERF anim` line Task 2 added: it now has slide-offs and drops to report. In the `PERF` handler, replace the `Serial.printf("PERF anim ...` statement with:

```cpp
    Serial.printf("PERF anim    n=%lu flush avg %luus worst %luus tweens=%u slides=%u drops=%u\n",
                  (unsigned long) animFrames,
                  (unsigned long) (animFrames ? animFlushTotalUs / animFrames : 0),
                  (unsigned long) animFlushWorstUs, (unsigned) animTweens,
                  (unsigned) pressSlides, (unsigned) pressDrops);
```

`pressSlides` and `pressDrops` are defined in `anim.ino`, which is concatenated AFTER `deckhand_display.ino`. Add `extern uint16_t pressSlides, pressDrops;` to the `#if BOARD_HAS_ANIM` extern block Task 2 created.

- [ ] **Step 6: Run every checker**

```bash
node firmware/deckhand_display/anim-check.mjs && node firmware/deckhand_display/anim-check.mjs --selftest
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs
```

Expected: all pass, with `source faults: 12/12 caught`. `commands-check` must list `PRESSTEST` as handled on board 2 and refused on board 1. If its section (9) objects to a diagnostic's first token (`PRESSTEST`, `PRESS:`), rename the diagnostic's first word to one the host does not dispatch on and re-run.

- [ ] **Step 7: Compile board 1 and measure the refusal's cost**

Compile board 1, then `--check 1`. Expected: `CHANGED`, with the delta roughly the cause string (~330 bytes, rounded by alignment). Then confirm the CODE did not move:

```bash
SIZE=$(find ~/Library/Arduino15/packages/esp32/tools -name 'xtensa-esp32-elf-size' | head -1)
"$SIZE" -A /tmp/b1/deckhand_display.ino.elf | grep -E '^\.flash\.(text|rodata)'
git stash && arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1-before firmware/deckhand_display; git stash pop
"$SIZE" -A /tmp/b1-before/deckhand_display.ino.elf | grep -E '^\.flash\.(text|rodata)'
```

Expected: `.flash.text` is identical between the two, and `.flash.rodata` grew. If `.flash.text` moved, the `UI_ACT_GAP` lift is the only other board-1-visible change. Find out why before continuing. Then `--update 1`.

- [ ] **Step 8: Compile board 2, flash it, and verify the rects on the glass**

Compile board 2, then `--update 2`, then `--doc-check`. Flash with `./flash.sh --board 2 --no-compile` (safe: the last compile was board 2). If board 2 is not cabled, record every check below as UNVERIFIED in Task 5's doc and continue.

For each line, send the commands through the trigger file, read the reply in the host log, take a `SCREENSHOT`, and open the PNG with the Read tool. Confirm the tint sits exactly on the control, with rounded corners matching. Do this in `THEME dark` and `THEME light`:

| setup | PRESSTEST | expect lit |
|---|---|---|
| `TAB 1` (SESSIONS) | `PRESSTEST 160 25` | the SESSIONS tab cell |
| `TAB 1`, with sessions | `PRESSTEST 160 <a y inside row 0>` | session row 0, rounded `R_MD` |
| `TAB 3`, `PAGE 0` | `PRESSTEST 160 <settingsHomeRowY(0)+10>` | HOME's first row |
| `DETAIL <n>` on an ask | `PRESSTEST 160 <an option's y>` | that option row, radius 8 |
| `COMPOSE` | `PRESSTEST <x of SEND> <y of action band>` | the drawn SEND button, not its column |
| `TAB 2` (PROJECTS) | `PRESSTEST 160 <first row y>` | project row 0 |
| any | `PRESSTEST 160 25` twice in a row | the second reply says `already lit` |
| `KBTEST` | `PRESSTEST 160 300` | refused, naming the keyboard |
| any | `PRESSTEST 999 5` / `PRESSTEST abc` | refused, quoting the range |
| any | `PRESSTEST off` | the tint gone in the next SCREENSHOT, `released WITHOUT acting` |

The `<y>` values come from `SESSION_ROW_Y0`, `settingsHomeRowY`, `askOptionsTop` and `KB_ACT_Y` as evaluated in `board_es3c35p.h`. Read them there and write the numbers you used into the commit message.

- [ ] **Step 9: Commit**

```bash
git add -A firmware/deckhand_display firmware/board-baseline.json CLAUDE.md
git commit -m "Press layer: per-surface rects beside their hit tests, PRESSTEST

Lights tab cells, session/project/psess rows, HOME rows, the confirm dialog,
answerable ask options and the reply panel's action buttons. Taps still act
on the press - Task 4 moves them to the lift. Verified on board 2 with
PRESSTEST + SCREENSHOT at: <points used>, dark and light.

Board 1 MOVED, on purpose: +<N> bytes, all of it PRESSTEST's refusal string in
.flash.rodata; .flash.text identical (measured with xtensa-esp32-elf-size).
Re-baselined with --update 1. Board 2 re-baselined: +<N> bytes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Taps act on lift: `handleTouch()` split, `dispatchTap()`, drag-loop hooks

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`handleTouch()` ~lines 4527-4836)
- Modify: `firmware/deckhand_display/sessions.ino` (`sessionDragLoop` ~line 2087)
- Modify: `firmware/deckhand_display/projects.ino` (the drag loops in `handleProjectsTouch` and `handlePSessTouch`)
- Modify: `firmware/deckhand_display/sessions-geom-check.mjs:4924-4929`
- Modify: `firmware/deckhand_display/anim-check.mjs`

**Interfaces:**
- Consumes: everything Task 3 produces.
- Produces: `static void dispatchTap(int sx, int sy)`, the tap chain moved verbatim out of `handleTouch()`.

- [ ] **Step 1: Extend the checker (failing)**

Append to `FAULTS`:

```js
  ["press path dispatches unconditionally", "deckhand_display.ino",
   (t) => t.replace(/\n\s*if \(!tapBlocksUntilLift\(sx, sy\)\) return;[^\n]*/, ""),
   "the press path reaches dispatchTap only when"],
  ["lift dispatches without pressLift", "deckhand_display.ino",
   (t) => t.replace(/if \(pressLift\(\)\) \{/, "if (true) {"),
   "the lift path dispatches the ORIGINAL press point"],
  ["drag never clears the press", "sessions.ino",
   (t) => t.replace(/if \(dragged\) pressCancel\(\);/, ""),
   "sessionDragLoop's OWN BODY clears the press"],
```

Add before `faultChildEpilogue();`:

```js
// ---- (5) tap timing, (7) the bound keyboard lines, the drag loops' hooks ----
{
  const MAIN = strip(readSource("deckhand_display.ino"));
  const htB = fnBody(MAIN, "void handleTouch()", "deckhand_display.ino");
  const calls = (htB.match(/\bdispatchTap\(/g) || []).length;
  chk(calls === 2,
      `handleTouch()'s OWN BODY calls dispatchTap exactly twice - once on the lift, once for a handler that blocks until the lift (found ${calls})`);
  chk(/if \(pressLift\(\)\) \{[\s\S]{0,240}?dispatchTap\(pressX, pressY\)/.test(htB),
      "the lift path dispatches the ORIGINAL press point, and only behind pressLift()");
  chk(/#if BOARD_HAS_ANIM\s*\n\s*pressBegin\(sx, sy\);\s*\n\s*if \(!tapBlocksUntilLift\(sx, sy\)\) return;[\s\S]{0,400}?#endif\s*\n\s*dispatchTap\(sx, sy\);/.test(htB),
      "the press path reaches dispatchTap only when tapBlocksUntilLift() says the handler waits for the lift itself");
  for (const [re, what] of [[/if \(composeOnKeys\(\) && kbRelease\(\)\)/, "the keystroke commit on the lift"],
                            [/if \(!kbArm\(sx, sy\)\) kbTouch\(sx, sy\);/, "kbArm first, kbTouch for what it declines"],
                            [/if \(composeOnKeys\(\)\) kbSlide\(sx, sy\);/, "the held path's kbSlide"]])
    chk(re.test(htB), `handleTouch()'s OWN BODY still holds ${what} - settings-geom-check binds it there`);
  const dtB = fnBody(MAIN, "static void dispatchTap(int sx, int sy)", "deckhand_display.ino");
  chk(/if \(showingDetail\) \{/.test(dtB) && /handleSettingsTouch\(sx, sy\)/.test(dtB),
      "dispatchTap()'s OWN BODY is the tap chain, detail card through SETTINGS");
  for (const [file, sig] of [["sessions.ino", "bool sessionDragLoop("],
                             ["projects.ino", "void handleProjectsTouch("],
                             ["projects.ino", "void handlePSessTouch("]]) {
    const b = fnBody(strip(readSource(file)), sig, file);
    const name = sig.replace(/^\w+ /, "").replace("(", "");
    chk(/if \(dragged\) pressCancel\(\);/.test(b) && /animTick\(\);/.test(b),
        `${name}'s OWN BODY clears the press once it is a drag, and keeps the fade-in ticking while it blocks`);
  }
}
```

Run: `node firmware/deckhand_display/anim-check.mjs`
Expected: FAIL on the dispatch-count, the lift-path and the drag-loop assertions.

- [ ] **Step 2: Hook the three drag loops**

In `sessionDragLoop` (`sessions.ino`), directly after `    if (moved > SESSION_DRAG_TAP_PX) dragged = true;`, insert:

```cpp
    // The press layer goes BEFORE the first frame that moves the list - a tint
    // over rows sliding under it would light whatever passes beneath the finger.
    if (dragged) pressCancel();
    animTick();   // the fade-in still runs while this loop owns the CPU
```

In `handleProjectsTouch` (`projects.ino`), directly after `      if (moved > PROJ_DRAG_TAP_PX) dragged = true;`, insert:

```cpp
      if (dragged) pressCancel();   // sessionDragLoop()'s own rule
      animTick();
```

In `handlePSessTouch`, directly after `      if (moved > PSESS_DRAG_TAP_PX) dragged = true;`, insert the same two lines.

The rail press in `sessionDragLoop` starts with `dragged = onRail`. `pressCancel()` on the first poll is then a cheap no-op, because nothing lights on the rail.

- [ ] **Step 3: Split `handleTouch()`**

First, add `extern int pressX, pressY;` to the `#if BOARD_HAS_ANIM` extern block Task 2 created. `handleTouch()` reads both, and they are defined in `anim.ino`, which is concatenated later.

Then make these four edits to `handleTouch()` in `deckhand_display.ino`.

3a. The held branch. Replace:

```cpp
  if (touching && wasTouching) {
    if (composeOnKeys()) kbSlide(sx, sy);
    return;
  }
```

with:

```cpp
  if (touching && wasTouching) {
    if (composeOnKeys()) kbSlide(sx, sy);
#if BOARD_HAS_ANIM
    else pressMove(sx, sy);   // off the control cancels - the lift will act on nothing
#endif
    return;
  }
```

3b. The release branch. Directly after the unchanged line `    if (composeOnKeys() && kbRelease()) { lastActivityMillis = millis(); return; }`, insert:

```cpp
#if BOARD_HAS_ANIM
    // THE TAP ACTS HERE, ON THE LIFT, at the point the finger went DOWN - so the
    // handlers below see exactly the coordinates they always did. pressLift()
    // refuses a tap whose surface or control changed while it was held. The reply
    // panel's composeTouch() is outside dispatchTap() (it is the compose branch's),
    // so it is routed here by the same question every other seam asks.
    if (pressLift()) {
      if (composeOnPanel()) composeTouch(pressX, pressY);
      else dispatchTap(pressX, pressY);
      pressAfterDispatch();
      lastActivityMillis = millis();
    }
#endif
```

3c. The compose branch on the press. Replace:

```cpp
    if (composeScreen == COMPOSE_SCREEN_PANEL) composeTouch(sx, sy);
    else if (!kbArm(sx, sy)) kbTouch(sx, sy);
```

with the following. It is ONE read of `composeScreen`, which `settings-geom-check` requires. The `#if` arms open no braces of their own:

```cpp
    if (composeScreen == COMPOSE_SCREEN_PANEL) {
#if BOARD_HAS_ANIM
      pressBegin(sx, sy);       // the reply panel acts on the LIFT - see the release branch
#else
      composeTouch(sx, sy);
#endif
    }
    else if (!kbArm(sx, sy)) kbTouch(sx, sy);
```

3d. The tail. Cut everything in `handleTouch()` from the line `#if BOARD_HAS_WIRELESS_PAIR` (the pairing-panel block directly after the compose branch's closing `}`) through `  if (currentTab == TAB_SETTINGS) handleSettingsTouch(sx, sy);`, without its comments' meaning changing. In its place put:

```cpp
#if BOARD_HAS_ANIM
  pressBegin(sx, sy);
  if (!tapBlocksUntilLift(sx, sy)) return;   // acts on the lift, in the release branch above
  pressConsume();                             // the handler below blocks until the lift and acts itself
#endif
  dispatchTap(sx, sy);
#if BOARD_HAS_ANIM
  pressAfterDispatch();
#endif
}

// THE TAP CHAIN, everything below the compose surface, moved VERBATIM out of
// handleTouch(): on board 2 it runs on the LIFT (at the press point), on board 1
// on the press, exactly as before. Static and called once on board 1 so the
// compiler can fold it back into handleTouch() there - --check 1 says whether it did.
static void dispatchTap(int sx, int sy) {
```

followed by the cut text, unchanged, and then the original closing `}` of `handleTouch()`, which now closes `dispatchTap()`.

- [ ] **Step 4: Re-anchor `sessions-geom-check`'s detail-block binding**

The `if (showingDetail) {` block moved, verbatim, into `dispatchTap()`. In `sessions-geom-check.mjs` (lines 4924-4929), change:

```js
  const fi = src.indexOf("void handleTouch() {");
  chk(fi >= 0, "handleTouch() is found in deckhand_display.ino");
```
to
```js
  const fi = src.indexOf("static void dispatchTap(int sx, int sy) {");
  chk(fi >= 0, "dispatchTap() - the tap chain, moved out of handleTouch() - is found in deckhand_display.ino");
```

and `"handleTouch() still has an \`if (showingDetail)\` block to bind to"` to `"dispatchTap() still has an \`if (showingDetail)\` block to bind to"`. Update the comment above the block to say why: the chain moved so board 2 can run it on the lift.

- [ ] **Step 5: Run every checker and the sweep**

```bash
node firmware/deckhand_display/anim-check.mjs && node firmware/deckhand_display/anim-check.mjs --selftest
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/geom-sweep.mjs     # ~110s
```

Expected: all pass, with `source faults: 15/15 caught`. If `settings-geom-check` reports `composeScreen` read more than once in `handleTouch()`, 3c was not applied as a single `if`.

- [ ] **Step 6: Compile board 1 (must match Task 3's baseline), then board 2**

`--check 1`. Expected: `UNCHANGED` against the baseline Task 3 recorded. On board 1, `dispatchTap` is static and called once, and the compose `if` gained only braces. If it reports `CHANGED`, compare `.flash.text` as in Task 3 Step 7. A small move from the extraction not being inlined is acceptable ONLY if it is measured and explained in the commit message (contract: never a surprise). Then `--update 1`. Otherwise do not update.
Board 2: compile, then `--update 2`, then `--doc-check`.

- [ ] **Step 7: Flash board 2 and check behaviour on the glass**

`./flash.sh --board 2 --no-compile`. Ask the user to do these by finger, and record each result:

1. Tap a tab: it lights while held, switches on lift, and leaves no tint on the new screen.
2. Press a tab, slide the finger 2cm away, lift: it fades and nothing switches.
3. With more than six sessions (`MULTITEST 8` if needed), press a row and drag: the tint vanishes before the list moves.
4. Tap a session row: the detail card opens on lift.
5. On the reply panel (`COMPOSE`), tap CLOSE: it lights, then closes on lift.
6. Keyboard (`KBTEST`): typing still works key by key, and no key commits twice.
7. `PERF`: read the `PERF anim` line. A worst flush under 16000us is the target. Record the numbers.
8. **Re-rank under a held finger (Review Focus 1):** with `MULTITEST 8` up, have the user hold a finger on session row 0. From the Mac, send `MULTITEST 3` so the list changes under the finger. Confirm in the log that the session list actually changed; if it did not, this step proves nothing and must be redone with something that does change it. Then have them lift. Expected: no detail card opens, and the host log shows `PRESS: dropped the tap ... the screen changed` or `... the control under it changed`.
9. **Panel closed mid-press (Review Focus 2):** with `COMPOSE` up, have the user hold a finger on CLOSE. From the Mac, send `COMPOSE off`, then have them lift. Expected: nothing acts on the screen underneath, and the log shows `PRESS: dropped`.

Also run `PRESSTEST 160 25` and `SCREENSHOT` once more to confirm Task 3's path still works.

- [ ] **Step 8: Commit**

```bash
git add -A firmware/deckhand_display firmware/board-baseline.json CLAUDE.md
git commit -m "Board 2 taps act on the lift; sliding off cancels; stale taps are dropped

handleTouch() keeps the press-time surfaces (wake, octopus, emoji grid, the
keyboard's arm-then-commit, the blocking drag lists) and defers the rest - the
chain moved verbatim into dispatchTap() - to the lift, at the press point.
pressLift() drops a tap whose screen or control changed while held. The drag
loops clear the press layer before the first scroll frame.
sessions-geom-check's detail-block binding re-anchored to dispatchTap().
On glass: <results of Step 7>. PERF anim: <numbers>.
Board 1: <UNCHANGED | moved +N in .flash.text because ..., re-baselined>.
Board 2 re-baselined: +<N> bytes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reference doc, `CLAUDE.md`, final figures

**Files:**
- Create: `docs/reference/animation.md`
- Modify: `CLAUDE.md` (the "Read this before touching that" table, the firmware file map, the command table, and board 2's RAM figure in the board table, with its narrative entry)

- [ ] **Step 1: Write `docs/reference/animation.md`**

```markdown
# Animation core and the press layer (board 2)

Spec: `docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md`.
Piece 1 of 3; transitions (piece 2) and list fling/bounce (piece 3) are not built yet.

## The rule everything rests on: the tint is never in the framebuffer

`PanelShim::setOverlay()` stores ONE rounded rect, tint and alpha. `flush()` blends
it into the pixels it gathers for the panel; `readRect()` blends it into what
SCREENSHOT reads. The framebuffer underneath keeps true content, so a redraw under
a lit control (the 1s tick, a payload) is correct the moment it is flushed, and
clearing the layer can never paint a stale image back. The first design drew the
tint into the framebuffer over a snapshot and cancelled on a foreign draw - which
cannot be made right when a draw covers PART of the rect (spec, Revision 1).

`anim-check.mjs` fails by name if `anim.ino` calls a drawing primitive.

## Timings and curves

| | value | where |
|---|---|---|
| frame | 16ms, only while a tween runs | `ANIM_FRAME_MS`, `anim.ino` |
| press in | 0 -> 51 (20% toward `COLOR_ACCENT`) over 40ms, ease-out cubic | `PRESS_IN_MS`, `PRESS_ALPHA` |
| release / slide-off / drop | -> 0 over 120ms | `PRESS_OUT_MS` |
| slop | 12px outside the lit rect | `PRESS_SLOP_PX` |

Easing tables (33 entries, 0..1024), generated by:

    node -e 'const back=(t,c)=>1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2);
    for(let i=0;i<=32;i++){const t=i/32;console.log(Math.round(1024*(1-Math.pow(1-t,3))),
    Math.round(1024*back(t,1.5)))}'

`c = 1.5` is the value that makes the back curve peak at exactly 1.08 (table 1106).
Piece 1 uses only the cubic; the back curve is for arrivals in pieces 2 and 3.

## When a tap acts

Board 2 acts on the LIFT, at the press point. Still on the press: wake, undim, the
octopus, the emoji grid, the compose processing bar, the keyboard's key band (its
own arm-then-commit), and the three blocking drag lists (`tapBlocksUntilLift()`).
`pressLift()` DROPS a tap - logging `PRESS: dropped` - if the surface signature or
the control under the press point (rect AND identity key) changed while it was
held. Board 1 still acts on the press.

## What lights (piece 1)

Tab cells; session rows; PROJECTS rows on both levels (not the honesty row);
SETTINGS HOME rows and the confirm dialog's YES/NO; answerable ask options; the
reply panel's action buttons.

NOT lit yet, and the tap still acts on the lift: settings steppers, toggles and
segments, the settings back band, the detail header chips, the ask SPEAK/REPLY
row, compose reply bands and chips, the scrollback header, USAGE cards.

## Instruments

- `PRESSTEST <x> <y>` / `PRESSTEST off` - see CLAUDE.md's command table.
- `PERF anim` - frames, flush avg/worst, tweens. A frame IS a flush of the lit rect.

## Measured / unverified ledger

| claim | status | evidence |
|---|---|---|
| lit rects line up with their controls | <MEASURED date / UNVERIFIED> | <PRESSTEST + SCREENSHOT files, points> |
| worst frame < 16ms on a session row | <...> | <PERF anim line> |
| press/release feel, both themes | <...> | <who looked, when> |
| tap-on-lift behaviours 1-6 (Task 4 Step 7) | <...> | <results> |
| board 1 code unchanged | <...> | <.flash.text before/after> |
```

Fill every `<...>` in the ledger from what Tasks 3 and 4 actually recorded. Any that were not observed say `UNVERIFIED` and why. Do not leave a `<...>` in the committed file.

- [ ] **Step 2: Update `CLAUDE.md`**

- "Read this before touching that": add `| animation, the press layer, tap-on-lift (board 2) | [docs/reference/animation.md](docs/reference/animation.md) |`.
- Firmware file map: add `| anim.ino | BOARD 2 ONLY, one #if: easing, the press layer's tween, tap-on-lift, PRESSTEST |`.
- Command table: add a row for `PRESSTEST <x> <y>` / `PRESSTEST off`. It is board 2 only. It lights the press layer at a point and holds it, so `SCREENSHOT` (which applies the layer) can check the rect. It never dispatches. It refuses BY NAME on no control there, on a press-time surface (naming it) and on a bad argument (quoting the range). A double-delivered copy says `already lit`. Board 1 refuses it from `UNAVAILABLE_COMMANDS[]`.
- Board table: update board 2's RAM from the final board-2 compile's "Global variables use N bytes", and board 1's RAM if it moved. Append a dated entry to the RAM narrative paragraph saying what the bytes are: the overlay and watch fields on `tft`, `anim.ino`'s tween and press globals, and `PRESSTEST`'s refusal on board 1.

- [ ] **Step 3: Final verification sweep**

```bash
node firmware/board-baseline.mjs --doc-check
node firmware/deckhand_display/anim-check.mjs --selftest
for c in commands settings-geom sessions-geom usage-geom projects-geom; do
  node firmware/deckhand_display/$c-check.mjs || echo "FAILED: $c"; done
```

Expected: every one passes, and no `FAILED:` line appears.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/animation.md CLAUDE.md
git commit -m "docs: the press layer and tap-on-lift (board 2), with its measured ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
