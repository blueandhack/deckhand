# Board 2 Native Type Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give board 2 a type scale with no scaled fonts anywhere (Spleen 8x16 / 12x24 / 32x64), and spend the screen height on content instead of emptiness.

**Architecture:** `UI_FONTS[]` becomes per-board so board 2 maps the same five font ids onto Spleen faces at size 1, which removes every `setTextSize` above 1 on that board. Each surface's constants are then re-derived for a 16px line and an 8px advance, one tab per task, each with its geometry checker extended in the same commit. Two layout features follow: SESSIONS expands its most urgent session, and SETTINGS gains a diagnostics card.

**Tech Stack:** Arduino ESP32 core 3.3.11, ESP32-S3, ESP32_Display_Panel 1.0.4, Spleen bitmap fonts (BSD-2-Clause) via `bdf2gfx.py`, Node ES modules for the geometry checkers.

**Spec:** `docs/superpowers/specs/2026-08-23-board2-type-scale-design.md`

## Global Constraints

- **Board 1 must stay byte-identical: flash 1382802, RAM 69236.** Verify on every task with `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`. This has held for every commit of the port and is not being spent here.
- **NEVER compile both boards concurrently.** `arduino-cli` keys its build directory on the sketch path, so two FQBNs share one cache and corrupt each other; the board-2 link then fails on undefined `TFT_eSprite`/Bluedroid symbols and looks exactly like a wrong header selection. Run them one after the other. If you see that, `rm -rf ~/Library/Caches/arduino/sketches/<hash>` before believing anything else.
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`. All four options matter: without `PSRAM=opi` the framebuffer allocation fails; without `CDCOnBoot=cdc` every `Serial.print` is silently swallowed.
- **Confirm the string `Sketch uses` appears in compile output before believing a build succeeded.** Compiles take ~3 min and must be backgrounded and polled, never run in a silent foreground call.
- Flash with `./flash.sh --board 2` from the repo root. Add `--no-compile` only when you have JUST compiled. Never a bare `arduino-cli upload` — the supervised host re-grabs the port within ~1s.
- Device commands go **only** through `echo "CMD" > ~/.claude/deckhand-device-command`. Opening a second serial connection reboots the board before anything arrives.
- **Never run `node host/index.mjs`** — macOS TCC SIGABRTs a bare node process touching CoreBluetooth. Use `./host/deckhand-service.sh stop|start`.
- Arduino concatenates every `.ino` into ONE translation unit and inserts generated prototypes above the first function definition, so **no function signature may name** `SessionInfo`, `Usage`, `HostLink`, `HostPairing`, `Theme`, or `ConfirmAction`.
- **`board_es3c35p.h` is not self-contained** — it derives constants from the art headers (`CRAB_H` and friends), so it can only be included from the sketch's own include chain, never from `panel_shim.cpp`.
- **Lanes are MEASURED, never counted.** `textWidth` is verified pixel-exact against TFT_eSPI, including its rule that the LAST character is charged `xOffset + width` rather than `xAdvance`. Use `tft.textWidth()`; do not multiply a character count by an advance except where a constant's derivation comment says the face is monospace and shows the arithmetic.
- **A change-only cache shorter than its padded string silently stops noticing changes past that point.** This repo's oldest bug. Character counts SHRINK as lanes narrow here, so existing sizes are likely adequate — but check each, do not assume.
- **`drawIfChanged` clears `fx-1, fy-1, tw+2, th+2`**, so a field's CLEAR BOX, not its glyphs, is what damages a border. Check clear boxes.
- **The usage column must NOT end flush on `contentBottom()`.** A documented board-1 lesson: it once did, and the Codex row read as joined to the footer.
- All three geometry checkers (`usage-`, `sessions-`, `settings-geom-check.mjs`) and their `--selftest` runs must exit 0 at the end of every task, from the repo root. `BASELINE_FAILURES` in `usage-geom-check.mjs` must stay 0 — raising it is never the way to make the suite green.
- **`SCREENSHOT` reads the shadow framebuffer, not the panel.** A capture is correct by construction even when the glass is wrong, so it proves geometry and never proves colour or legibility. Those need a person; say so rather than implying a screenshot settled them.

---

### Task 1: Vendor the Spleen faces

**Files:**
- Create: `firmware/deckhand_display/Spleen8x16.h`, `Spleen12x24.h`, `Spleen32x64.h`
- Create: `licenses/Spleen-BSD-2-Clause.txt`
- Modify: `CLAUDE.md` (the font section's regeneration note)

**Interfaces:**
- Produces: `extern const GFXfont Spleen8x16;`, `Spleen12x24`, `Spleen32x64` — Adafruit-GFX bitmap fonts, ASCII 0x20..0x7E, monospace advances 8, 12 and 32 px, cell heights 16, 24 and 64.

- [ ] **Step 1: Fetch the BDFs into the scratchpad, not the repo**

The BDFs are deliberately NOT committed — the repo already does this for Cozette (667KB) and Terminus (235KB), keeping only the generated headers.

```bash
cd /tmp
for s in 8x16 12x24 32x64; do
  curl -sSL -o spleen-$s.bdf "https://raw.githubusercontent.com/fcambus/spleen/master/spleen-$s.bdf"
done
ls -la spleen-*.bdf
```
Expected: three files, roughly 154KB, 217KB and 682KB.

- [ ] **Step 2: Generate the three headers**

```bash
cd firmware/deckhand_display
python3 bdf2gfx.py /tmp/spleen-8x16.bdf  Spleen8x16  16 > Spleen8x16.h
python3 bdf2gfx.py /tmp/spleen-12x24.bdf Spleen12x24 24 > Spleen12x24.h
python3 bdf2gfx.py /tmp/spleen-32x64.bdf Spleen32x64 64 > Spleen32x64.h
```

- [ ] **Step 3: Verify each header against its source, glyph for glyph**

This is the generator's own check and it has caught a real packing bug before (Terminus declares a uniform full-cell `BBX` that exercised paths Cozette never did).

```bash
python3 bdf2gfx.py --verify /tmp/spleen-8x16.bdf  Spleen8x16.h
python3 bdf2gfx.py --verify /tmp/spleen-12x24.bdf Spleen12x24.h
python3 bdf2gfx.py --verify /tmp/spleen-32x64.bdf Spleen32x64.h
```
Expected: each reports a match with no differing glyphs. If any fails, STOP and report — do not hand-edit a generated header.

- [ ] **Step 4: Confirm the advances are what the plan assumes**

Every later task's lane arithmetic rests on these being monospace at 8, 12 and 32.

```bash
python3 - <<'EOF'
import re
for name, adv in (("Spleen8x16", 8), ("Spleen12x24", 12), ("Spleen32x64", 32)):
    src = open(f"{name}.h").read()
    advances = set(int(m) for m in re.findall(r"\{\s*\d+,\s*\d+,\s*\d+,\s*(\d+),", src))
    print(name, "advances:", sorted(advances), "expected", adv)
    assert advances == {adv}, f"{name} is not monospace at {adv}"
EOF
```
Expected: each prints a single advance equal to the expected value.

- [ ] **Step 5: Add the licence**

```bash
curl -sSL -o ../../licenses/Spleen-BSD-2-Clause.txt \
  "https://raw.githubusercontent.com/fcambus/spleen/master/LICENSE"
head -3 ../../licenses/Spleen-BSD-2-Clause.txt
```
Expected: a BSD 2-Clause notice naming Frederic Cambus.

- [ ] **Step 6: Verify board 1 is untouched**

The headers are not referenced by anything yet, so this must be exact.

Run (backgrounded and polled): `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: `Sketch uses 1382802 bytes`, `Global variables use 69236 bytes`.

- [ ] **Step 7: Document the regeneration recipe**

In `CLAUDE.md`, find the paragraph beginning `Regenerate with` in the type-scale section and add Spleen alongside Cozette and Terminus, naming the three sizes, the `--verify` step, and that the BDFs are not committed (Spleen 8x16 154KB, 12x24 217KB, 32x64 682KB).

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/Spleen*.h licenses/Spleen-BSD-2-Clause.txt CLAUDE.md
git commit -m "Vendor Spleen 8x16, 12x24 and 32x64

Three hand-designed faces so board 2 can stop scaling bitmap fonts. Verified
glyph-for-glyph against their BDFs with bdf2gfx.py --verify, and asserted
monospace at 8, 12 and 32 because every lane derivation that follows rests on
those advances.

BDFs deliberately not committed, matching what this repo already does for
Cozette and Terminus. Board 1 byte-identical: nothing references these yet."
```

---

### Task 2: Per-board font registry, and the shared chrome

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (the `UI_FONTS[]` table around line 235, and `#include`s)
- Modify: `firmware/deckhand_display/board_es3c35p.h` (`FOOTER_H`, and a new `BOARD_FONT_*` block)

**Interfaces:**
- Consumes: `Spleen8x16`, `Spleen12x24`, `Spleen32x64` from Task 1.
- Produces: on board 2, `uiLineH(T_BODY) == 16`, `uiLineH(T_HEAD) == 24`, `uiLineH(T_HERO) == 64`, and `uiTextSize()` returns 1 for every id. Board 1's registry is unchanged.

- [ ] **Step 1: Read how the registry is reached before changing it**

```bash
grep -n "UI_FONTS\|uiFontIdx\|uiTextSize\|uiLineH\|setUIFont\|applyContentFont\|FONT_CODE" firmware/deckhand_display/deckhand_display.ino | head -20
```
The five ids (`T_META` 1, `T_BODY` 2, `T_HEAD` 3, `T_HERO` 4) are the legacy TFT_eSPI font numbers ~72 call sites already pass, which is why a new face costs zero changes at those sites. `FONT_CODE` (200) is a sentinel, not a real font number.

- [ ] **Step 2: Make the table board-conditional**

Replace the single `UI_FONTS[]` definition with two, guarded. Board 1's entries must be character-for-character what they are today.

```cpp
#if BOARD_USES_TFT_ESPI
static const UiFont UI_FONTS[] = {
  { &Cozette6x13,    1, 13 },  // 0 unused - aliases body so a bad id degrades to text
  { &Cozette6x13,    1, 13 },  // 1 T_META
  { &Cozette6x13,    1, 13 },  // 2 T_BODY (and T_TITLE, pending migration)
  { &Terminus10x18b, 1, 18 },  // 3 T_HEAD
  { &Cozette6x13,    2, 26 },  // 4 T_HERO
};
#else
// BOARD 2: one family, every rung NATIVE, no entry above size 1. Board 2 is only
// 15% denser than board 1 (6.489 vs 5.624 px/mm) but has twice the pixels, so
// identical pixel sizes are physically SMALLER here - 6x13 is 2.00mm against
// board 1's 2.31mm. Spleen 8x16 restores parity at 2.47mm while leaving a
// 32-character card lane against board 1's 34, so the existing character-budget
// arguments carry over instead of needing re-invention. 12x24 would have given 21.
static const UiFont UI_FONTS[] = {
  { &Spleen8x16,  1, 16 },     // 0 unused - aliases body
  { &Spleen8x16,  1, 16 },     // 1 T_META
  { &Spleen8x16,  1, 16 },     // 2 T_BODY
  { &Spleen12x24, 1, 24 },     // 3 T_HEAD
  { &Spleen32x64, 1, 64 },     // 4 T_HERO
};
#endif
```

Add the includes beside the existing font includes, guarded so board 1 never sees the ~34KB of glyph data:

```cpp
#if !BOARD_USES_TFT_ESPI
#include "Spleen8x16.h"
#include "Spleen12x24.h"
#include "Spleen32x64.h"
#endif
```

- [ ] **Step 3: Grow the footer band, which is the one measurement with zero slack**

`FOOTER_H` is 18 and `drawIfChanged` clears `th + 2`, so a 16px line clears exactly 18 rows — no margin at all. In `board_es3c35p.h`, change `FOOTER_H` to 20 and replace its comment with the derivation:

```cpp
// 20, up from 18, because T_BODY is now a 16px line and drawIfChanged clears
// th + 2 = 18 rows - which fits an 18px band EXACTLY, with no room for the 1px
// margin every other band in this file has. 20 gives the same 2px of slack the
// 13px line had in 18. Costs 2px of content area (416 -> 414), which the usage
// column absorbs: it ends at 454 against a contentBottom() that moves 462 -> 460,
// so its clearance goes 8px -> 6px and it still does not end flush.
const int FOOTER_H = 20;
```

- [ ] **Step 4: Compile board 2 and expect errors only from static_asserts**

Run (backgrounded, polled): board 2 FQBN compile.
Expected: it may fail on `reader.ino`'s board-2 `static_assert` (the reader's column count is derived from the font and has now changed). That assert firing is the plan working — Task 7 fixes the reader. If it blocks this task's commit, note the exact message in the report and leave it; do NOT relax the assert.

- [ ] **Step 5: Verify board 1 byte-identical**

Run board 1's compile.
Expected: `1382802` / `69236`. If it moved, the guard is wrong — the most likely cause is an unguarded `#include` pulling glyph data into board 1's flash.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/board_es3c35p.h
git commit -m "Give board 2 its own font registry, all rungs native

Board 2 maps the same five font ids onto Spleen at size 1, so no surface on that
board scales a bitmap font any more. Board 1's table is unchanged and its binary
is byte-identical.

FOOTER_H goes 18 -> 20 because a 16px line clears th+2 = 18 rows, which fits an
18px band exactly and leaves none of the 1px margin every other band here has."
```

---

### Task 3: Re-derive the USAGE tab

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the card interior offsets and the Codex row)
- Modify: `firmware/deckhand_display/usage-geom-check.mjs`

**Interfaces:**
- Consumes: `uiLineH(T_BODY) == 16`, `uiLineH(T_HERO) == 64` from Task 2.
- Produces: card interior offsets that hold a 64px hero and three 16px rows inside `CARD_H` 164.

- [ ] **Step 1: Confirm the cards do not need to grow**

The 64px hero fits the existing 164-tall card. Derivation, against a ceiling of +161 (the 2px border owns +162..+163):

| row | y | clear box |
|---|---|---|
| pin bar | +3 | +2..+6 |
| label (16px) | +6 | +5..+22 |
| hero (64px) | +24 | +23..+88 |
| pace bar | +95 | +94..+113 (`drawPaceBar` clears from `y-4`) |
| stats (16px) | +118 | +117..+134 |
| foot (16px) | +140 | +139..+156 |

5px spare. This matters because the column has only 8px of clearance (now 6px after Task 2's `FOOTER_H`): `46+8 + 164 + 8 + 164 + 8 + 56 = 454` against `contentBottom()` 460.

- [ ] **Step 2: Set the offsets**

In `board_es3c35p.h` replace the six card-interior constants with the values above and a band table naming each field's cleared extent, matching the commenting density of the block already there. Delete `CARD_HERO_SIZE` and every use of it — the hero no longer scales.

```cpp
const int CARD_PIN_BAR_Y = 3;
const int CARD_LABEL_Y   = 6;
const int CARD_HERO_Y    = 24;
const int CARD_BAR_Y     = 95;
const int CARD_STATS_Y   = 118;
const int CARD_FOOT_Y    = 140;
```

- [ ] **Step 3: Remove the hero's size override**

```bash
grep -rn "CARD_HERO_SIZE" firmware/deckhand_display/
```
Every hit must go. The call site currently does `setUIFont(T_HERO); tft.setTextSize(CARD_HERO_SIZE);` — the `setTextSize` line is what made the hero a 4x-scaled 13px face, and the registry now carries a native 64px one. Board 1 keeps its own `CARD_HERO_SIZE`, so guard rather than delete outright where the code is shared.

- [ ] **Step 4: Re-derive the Codex row**

`CODEX_H` is 56. Its text goes to 16px and its pace bar clears from `y-4`. Derive text and bar offsets that share no pixel row and end by +53 (the 2px border owns +54..+55), and write the arithmetic into the comment.

- [ ] **Step 5: Extend the checker before trusting any of it**

In `usage-geom-check.mjs`, add assertions for: every card field's clear box ending at or before +161; the hero's 64px box not overlapping the label's clear box or the pace bar's; the Codex row's text and bar sharing no row and ending by +53; the column not ending flush on `contentBottom()`; and `"100%"` measured (not counted) fitting the card's text lane.

Run: `node firmware/deckhand_display/usage-geom-check.mjs` and `--selftest`
Expected: both exit 0, and the selftest still reports catching its injected fault.

- [ ] **Step 6: Compile board 1, then board 2 — one after the other, never together**

Expected: board 1 `1382802` / `69236`; board 2 builds (or fails only on the reader's `static_assert`, which is Task 7's).

- [ ] **Step 7: Flash and look**

```bash
./flash.sh --board 2
echo "TAB 0" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```
Decode the PNG from `~/Deckhand-shots/` and view it. Confirm the hero digits are crisp with a real `%` glyph, both cards' borders are unbroken, and nothing overlaps. **Say explicitly in your report that a screenshot cannot judge colour or on-glass legibility** — it reads the framebuffer.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage-geom-check.mjs
git commit -m "Re-derive the USAGE cards for a native 64px hero

The hero stops being a 4x-scaled 13px face and becomes Spleen 32x64 at size 1.
It fits the existing 164-tall card with 5px spare, so the cards do not grow and
the column - which has only 6px of clearance - does not need re-budgeting.

CARD_HERO_SIZE is gone on this board: there is nothing left to scale."
```

---

### Task 4: Re-derive the SESSIONS ladder

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the `SESSION_*` block)
- Modify: `firmware/deckhand_display/sessions.ino` (the name-fitting ladder)
- Modify: `firmware/deckhand_display/sessions-geom-check.mjs`

**Interfaces:**
- Consumes: `uiLineH()` values from Task 2.
- Produces: a row-height ladder whose every rung clears its own minimum at a 16px line, and a name ladder of Spleen 32x64 -> 12x24 -> 8x16.

- [ ] **Step 1: Re-derive the three minimum-height identities**

Today's are built on 13px lines: `SESSION_TITLE_MIN_H` 100, `SUB_MIN_H` 79, `LARGE_MIN_H` 62, with `SESSION_AIR` 3 adding a gap at five, three and two places respectively. Recompute each with a 16px line. State which of the five gaps behind `TITLE_MIN_H` grew, exactly as the existing comment does — if you cannot name five real gaps the identity is curve-fitting and must be replaced with the sum it actually is.

- [ ] **Step 2: Re-derive the ladder and say which counts keep what**

The ladder is `constrain((avail - GAP*(n-1)) / n, SESSION_ROW_H_MIN, SESSION_ROW_H_MAX)` where `avail = contentBottom() - SESSION_ROW_Y0`. `FOOTER_H` moved to 20, so `avail` is now `460 - 50 = 410`. Report the six rungs and, for each, whether it draws a title, a sub-line, or neither. The headline result to preserve if the arithmetic allows: **four sessions keep their titles and the fifth keeps its model/branch line**, which board 1 loses at four and five.

- [ ] **Step 3: Re-derive `SESSION_ROW_H_MIN`**

It is `SESSION_SUBC_Y + 15`, and `SESSION_SUBC_Y` is `25 + SESSION_AIR` at a 13px line. With 16px lines recompute it, and note whether the floor now binds at any reachable session count (today it binds at none — the minimum raw rung is 63).

- [ ] **Step 4: Walk the name ladder up to the new faces**

`drawSessionRow` walks 12x26 -> 10x18 -> 6x13 taking the first whose MEASURED width fits. On board 2 that becomes Spleen 32x64 -> 12x24 -> 8x16. A 32x64 name is 64px tall, which will not fit a row band sized for a 26px one — derive the band from `uiLineH()` rather than a literal, and re-centre the shrunk name in it (the existing `+6` is exactly `(26 - 13) / 2`, so the offset is derived, not magic).

```bash
grep -n "uiTextSize\|12x26\|10x18\|fitText\|SESSION_NAME" firmware/deckhand_display/sessions.ino | head -20
```

- [ ] **Step 5: Check every session cache against its new worst case**

`rowSigCache` is 176 against a 124-byte worst case and `detailSigCache` 384 against 357. A signature holds fixed-size struct field values, so panel width lengthens nothing — but the row's *drawn* strings narrow, so confirm rather than assume, and name the worst case you derived.

- [ ] **Step 6: Extend the checker**

Add assertions for: each ladder rung clearing its own gate at the new line height; the sub-line to pill gap being `>= 0` at every rung (strict — a 1px overlap draws the pill over text); the name band holding a 64px face; and the tall row's `CLAUDE`/`CODEX` tag not colliding with a 32x64 name at its widest measured form.

Run all three checkers and their selftests. Expected: all exit 0.

- [ ] **Step 7: Compile both boards sequentially, flash, screenshot SESSIONS**

Expected: board 1 `1382802` / `69236`. View the capture: the project name should be large and crisp, the sub-lines legible, the status pill clear of the text.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/sessions.ino firmware/deckhand_display/sessions-geom-check.mjs
git commit -m "Re-derive the session ladder for a 16px line

Every rung, minimum and gap in the ladder was built on a 13px line. Recomputed
for 16px, with the five gaps behind TITLE_MIN_H named individually so the
identity stays a derivation rather than a fit.

The name ladder walks Spleen 32x64 -> 12x24 -> 8x16 now, and its band is derived
from uiLineH() rather than a literal, because a 64px face does not fit a band
sized for 26px."
```

---

### Task 5: SESSIONS expands its most urgent session

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino`
- Modify: `firmware/deckhand_display/board_es3c35p.h` (expanded-card offsets)
- Modify: `firmware/deckhand_display/sessions-geom-check.mjs`

**Interfaces:**
- Consumes: the ladder from Task 4.
- Produces: `int sessionExpandedH(int count)` — the height of the expanded first row for a given session count, or 0 when no row is expanded. Board 1 returns 0 unconditionally.

- [ ] **Step 1: Decide the rule and write it down before coding it**

With one session the tab draws a 106px row and 306px of nothing — 64% of the content area. The top row of the urgency-sorted list becomes a tall card; the rest stay compact. Derive the expanded height as `avail - (compact rows + gaps)` so it absorbs exactly the leftover, and cap it so a single session does not produce a card of mostly air. State the six heights (one per session count).

- [ ] **Step 2: Add the height helper**

Signature is `int sessionExpandedH(int count)` — plain ints only, so it is safe anywhere in the sketch under this plan's prototype rule.

```cpp
// The most urgent session absorbs the height the ladder would otherwise leave
// empty. Board 1 has no spare height to give, so it never expands.
int sessionExpandedH(int count) {
#if BOARD_USES_TFT_ESPI
  (void) count; return 0;
#else
  // ... derived per Step 1; return 0 when count is large enough that the
  // ordinary ladder already fills the column.
#endif
}
```

- [ ] **Step 3: Draw the expanded card**

Content, in order: the agent spinner and project name, the Mac tag and icon, the title WRAPPED to two lines (`drawWrappedText`, bounded to the measured row lane), `agent  model  (branch)`, a `LAST PROMPT` label with two wrapped lines, the path through `fitText`, and the status pill with its duration. Reuse the detail screen's field helpers rather than writing new ones, and keep the row repainting WHOLESALE — do not introduce a per-field `drawIfChanged` on a row, because no clear box currently reaches a row border and that is why rows have no border damage.

- [ ] **Step 4: Keep touch in sync with layout**

`handleTouch`'s row hit-test reads the same `sessionRowH` globals the layout writes. An expanded first row breaks the uniform-height assumption, so the hit test must consult the same helper. Verify `fabHit()` still runs BEFORE the `showingDetail` branch.

```bash
grep -n "sessionRowH\|SESSION_ROW_GAP\|fabHit" firmware/deckhand_display/deckhand_display.ino | head
```

- [ ] **Step 5: Put the title and prompt in the row's repaint signature**

A row repaints only when its signature changes. The expanded card draws the title and the last prompt, so both must be in the signature or a stale one persists forever — the exact failure the title already caused once. Widen `rowSigCache` if the derived worst case exceeds 176, and state the number.

- [ ] **Step 6: Extend the checker**

Assert: the expanded height plus the compact rows plus the gaps never exceeds `avail`; the expanded card's own fields share no pixel row; and every session count from 1 to 6 produces a layout that fits.

Run all three checkers and their selftests. Expected: all exit 0.

- [ ] **Step 7: Compile sequentially, flash, and screenshot with more than one session**

Board 2 has `MULTITEST <n>` for injecting a synthetic second Mac, but for session COUNT the honest route is real sessions. Screenshot with whatever count exists and say in the report which counts were seen on the glass and which are checker-only.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/sessions.ino firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/sessions-geom-check.mjs
git commit -m "Expand the most urgent session into the height board 2 was wasting

With one session the tab drew a 106px row and 306px of nothing. The top row of
the urgency-sorted list now absorbs that space with a wrapped title, the last
prompt, the path and the times, while the rest stay compact - so it scales from
one session to six with no special case at either end.

Board 1 has no spare height and never expands."
```

---

### Task 6: Re-derive SETTINGS, the steppers and the confirm dialog

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the `P1_*`, `P2_*`, `MAC_ROW_*`, `CFM_*` blocks)
- Modify: `firmware/deckhand_display/settings.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `uiLineH()` from Task 2.
- Produces: four settings pages whose rows hold a 16px line, and a confirm dialog sized for its worst wrapped block at the new face.

- [ ] **Step 1: Re-derive page 1's row chain and the three toggles**

Rows are sized for a 13px line today. Recompute each row's height and the chain of `P1_*` offsets, and check the three half-width toggles at the bottom still fit the width with their labels MEASURED at 8x16.

- [ ] **Step 2: Re-derive the steppers**

The label sits in the middle column specifically so the keys can exceed `TAP_MIN`; the touch zones are the left and right THIRDS of the card; and the centred label must span a range clear of both so a tap on it cannot step the value. Re-check all three at the new label width, and keep the value in `T_HEAD` (now 12x24) as the type scale's middle rung.

- [ ] **Step 3: Re-derive the confirm dialog**

Every string is measured or wrapped against the card's text lane — `drawString` paints an opaque box, so an overflowing string rubs out the card border it crosses. The lane is `CARD_W - 2*SP_3` = 260px, which at an 8px advance is 32 characters against 43 today. Re-derive `countWrappedLines()` for the four shipping notes and confirm `CFM_H` still holds the WORST block: title (`T_HEAD`, 24) + gap + emphasis (16) + gap + two note lines (32).

- [ ] **Step 4: Re-derive page 3's paired-Mac rows**

`H_ROW` is `TAP_MIN` and the page holds ANY MAC plus four Macs. Confirm it still fits at a 16px line, and that `uiListRow`'s `rightInset` keeps the `ONLY` tag clear of the `x`.

- [ ] **Step 5: Check every settings cache**

`battRowTextCache` is 20 against a 15-char string plus NUL — exactly the size that once had to grow from 16. Re-derive each cache's worst case and name any that changed.

- [ ] **Step 6: Extend the checker, then run all three**

Add assertions for the new row chain, the stepper label clearing both touch thirds, and the confirm block fitting `CFM_H`.

Expected: all three checkers and all three selftests exit 0.

- [ ] **Step 7: Compile sequentially, flash, screenshot all four pages**

```bash
for p in 0 1 2 3; do echo "PAGE $p" > ~/.claude/deckhand-device-command; sleep 4; echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 6; done
```
View all four. Confirm no border damage and no text running past a card edge.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/settings.ino firmware/deckhand_display/settings-geom-check.mjs
git commit -m "Re-derive the settings pages, steppers and confirm dialog for 16px

The confirm dialog's lane holds 32 characters at an 8px advance where it held 43,
so every note's wrapped line count was re-derived rather than assumed - an
overflowing drawString does not merely spill, it rubs out the card border it
crosses."
```

---

### Task 7: Re-derive the keyboard and the history reader

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (the `KB_*` and `HIST_*` blocks)
- Modify: `firmware/deckhand_display/keyboard.ino`, `reader.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `uiLineH()` from Task 2.
- Produces: `KB_COLS` and `KB_TEXT_LINES` re-derived for an 8px advance, and a reader column/line budget the device reports to the host.

- [ ] **Step 1: Re-derive `KB_COLS` from the real lane, at the real advance**

The lane is `CARD_W - 12` (NOT `- 8`; both give 34 at board 1's width, which is why the wrong one survived in CLAUDE.md for a whole port). At 8px that is `284 / 8 = 35` columns, against 47 today. **Then check the last-character rule**: `textWidth` charges the final glyph `xOffset + width` rather than `xAdvance`, so verify a 35-column line of worst-case glyphs actually fits 284px rather than assuming, and record whether 35 is the exact maximum.

- [ ] **Step 2: Re-derive `KB_TEXT_LINES` and re-check the 150-byte pairing**

`KB_MAX_BYTES` is 150, so lines are `ceil(150 / KB_COLS)`. Report the number. Then re-derive the confirm screen's own budget: it uses a DIFFERENT lane (`CARD_W - 8`, in `sessions.ino`), and the repo's rule is that `ANSWER_TEXT_MAX_BYTES` 150 and the 8-line cap are consistent BY ARITHMETIC — so recompute the true worst case with a per-board adversarial word length rather than reusing board 1's string, and say whether the shared 8 still holds.

- [ ] **Step 3: Keep the meta row from sharing a pixel row with the text**

`drawString` paints an opaque box the full height of a text line, and a counter sharing a row with wrapped text silently erases that line's tail — found twice before landing on a reserved row. Re-derive the meta row's y and the text lines' y values at 16px and prove they share no row, stating both sets.

- [ ] **Step 4: Re-derive the caret's furthest reachable position**

At `KB_MAX_BYTES / KB_COLS` lines and `KB_MAX_BYTES % KB_COLS` columns, confirm it lands inside `KB_TEXT_LINES`. If it does not, the card overflows with no indicator — the exact defect a 6-line cap once shipped.

- [ ] **Step 5: Re-derive the reader, and let the host follow**

The reader's columns come from `(BOARD_W - 24) / advance` and its lines from `(HIST_JUMP_Y - 4 - HIST_TOP) / HIST_LINE_H`. Board 2 already reports its budget to the host on the `HISTORY` request, so the host needs no change — but the board-2 `static_assert` in `reader.ino` tying the page to `HIST_ARENA` must be re-derived, and `HIST_LINE_H` must become the new line height.

- [ ] **Step 6: Extend the checker and run all three**

Assert the new `KB_COLS` against the measured lane, the meta/text non-overlap, the caret bound, and the reader page fitting `HIST_ARENA`.

Expected: all three checkers and all three selftests exit 0.

- [ ] **Step 7: Compile sequentially, flash, and drive the keyboard from a command**

```bash
echo "KBTEST" > ~/.claude/deckhand-device-command          # opens against a pending ask
echo "KBTEST type Hello from a wider face" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```
`KBTEST` cannot invent a prompt — with nothing pending it does nothing, so report whether a real ask was available. It also cannot SEND, deliberately.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/keyboard.ino firmware/deckhand_display/reader.ino firmware/deckhand_display/settings-geom-check.mjs
git commit -m "Re-derive the keyboard and reader budgets for an 8px advance

KB_COLS goes 47 -> the measured maximum for a 284px lane, checked against
textWidth's last-character rule rather than by dividing. The confirm screen uses
a different lane (CARD_W - 8, not the keyboard's - 12), so its worst case was
re-derived per board with its own adversarial word length instead of reusing
board 1's string."
```

---

### Task 8: SETTINGS gains a LINK diagnostics card

**Files:**
- Modify: `firmware/deckhand_display/settings.ino`
- Modify: `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: the page-1 row chain from Task 6.
- Produces: a second card on SETTINGS page 1 showing host liveness, last payload size, flush milliseconds and uptime.

- [ ] **Step 1: Find what the device already knows**

Nothing new should be plumbed for this — it is a card over facts already in memory.

```bash
grep -n "lastRxMillis\|lastRxUSBMillis\|everReceived\|millis() / 1000" firmware/deckhand_display/deckhand_display.ino | head
grep -n "perfReport\|_dirtyX1\|flush()" firmware/deckhand_display/panel_shim.cpp | head -5
```
Host liveness is `lastRxMillis` freshness. Payload size is the length of the last completed line in `processCompletedLine`. Flush milliseconds needs a stored last-flush duration — add one `uint32_t` in the shim with an accessor, guarded to board 2. Uptime is `millis()`.

- [ ] **Step 2: Add the flush-duration accessor**

```cpp
// Last flush in microseconds, for the SETTINGS LINK card. Stored rather than
// measured on demand because a flush cannot be triggered without drawing.
uint32_t lastFlushUs() const { return _lastFlushUs; }
```
Set it at the end of `flush()`. Do not add it to the dirty-rect early-return path — an empty flush is not a flush.

- [ ] **Step 3: Draw the card**

Four rows, label left and value right, in the same style as the DEVICE card above it. Values through `drawIfChanged` with caches sized to their padded worst case — state each. Uptime formats as `4h 12m`, so its padded width is `"99h 59m"` plus NUL.

- [ ] **Step 4: Verify page 1 still fits**

The DEVICE card, the new LINK card and the three toggles must fit `PAGE_TOP` to `contentBottom()`. Show the arithmetic and assert it in the checker.

- [ ] **Step 5: Run all three checkers and their selftests**

Expected: all exit 0.

- [ ] **Step 6: Compile sequentially, flash, screenshot page 1**

Confirm both cards render, the values populate (not blank — `drawSettingsStatic()` resets the settings caches for exactly this reason, so a caller that forgot leaves values empty), and nothing overflows.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/settings.ino firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/panel_shim.h firmware/deckhand_display/panel_shim.cpp firmware/deckhand_display/settings-geom-check.mjs
git commit -m "Add a LINK card to SETTINGS page 1

Host liveness, last payload size, flush milliseconds and uptime - all facts the
device already had and could only be read from a Mac log. Fills the ~145px page 1
was wasting with something worth looking at."
```

---

### Task 9: Sweep, measure, document

**Files:**
- Modify: `firmware/deckhand_display/geom-sweep.mjs` (if the new constants need adding to its parse set)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the fault-injection sweep and act on it**

```bash
node firmware/deckhand_display/geom-sweep.mjs
```
It perturbs every constant each checker parses at +-1/+-4/+-16 and reports the ones where nothing fails. Every constant this plan ADDED or CHANGED should be guarded; for each that is not, either add the assertion or state why it legitimately has no geometric constraint. It found a real defect on a screen nothing had ever measured last time, so treat an unguarded new constant as a gap rather than noise.

- [ ] **Step 2: Measure the draw cost, before and after in the same report**

```bash
echo "PERF" > ~/.claude/deckhand-device-command
for t in 1 0 2; do echo "TAB $t" > ~/.claude/deckhand-device-command; sleep 4; done
grep -a "PERF" /tmp/deckhand-$(id -u)/host.log | tail -8
```
The pre-existing figures to beat or explain: full-screen flush 30ms, `switchTab` to USAGE 85ms, SESSIONS 68ms, SETTINGS 77ms, `renderUsageTab` 59ms. A 32x64 hero draws more pixels than a 24x52 one, so a regression here is expected — report the number and whether it is acceptable rather than hiding it.

- [ ] **Step 3: Update `CLAUDE.md`**

Add the per-board type scale to the font section: the three Spleen faces, the physical-size table that justifies 8x16 over 12x24, that `CARD_HERO_SIZE` no longer exists on board 2, and the corrected keyboard lane arithmetic per board. Update the board comparison table's size figures. Add the `PERF` numbers.

- [ ] **Step 4: Final verification, everything, from the repo root**

```bash
for c in usage sessions settings; do
  node firmware/deckhand_display/$c-geom-check.mjs && node firmware/deckhand_display/$c-geom-check.mjs --selftest
done
node firmware/deckhand_display/palette-check.mjs && node firmware/deckhand_display/palette-check.mjs --selftest
python3 firmware/deckhand_display/batt-trend-check.py
for m in host-tag line-address voice-answer mac-emoji codex-refresh; do node host/$m-check.mjs; done
node --check host/index.mjs
```
Then board 1 and board 2 compiles, sequentially. Expected: every check exits 0; board 1 `1382802` / `69236`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Document board 2's type scale, and what the sweep found

Records the physical-size arithmetic that chose 8x16 over 12x24, since the
counter-intuitive part - board 2's text being physically smaller than board 1's
despite twice the pixels - is what the whole change turns on."
```

---

## Notes for the executor

**Every task ends with board 1 byte-identical.** If it moves, stop and find out why before continuing; the most likely cause is an unguarded include or a shared constant edited without a board guard.

**The checkers are the safety net for exactly this kind of change**, because a wrong lane shows up as quietly truncated text rather than a crash. Extend them in the same commit as the constants they check — a task that changes geometry and leaves the checker alone has not finished.

**Two things a screenshot cannot tell you**, and both need to be said plainly in a report rather than glossed: it reads the shadow framebuffer, so it never proves colour; and it cannot judge whether 2.47mm text is comfortable to read at arm's length. Those are the user's call.
