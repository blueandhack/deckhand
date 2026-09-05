# Compose Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on-screen keyboard as the entry point for answering an ask with a reply panel that answers most prompts in one tap, keeping a sharpened QWERTY behind it, on both boards.

**Architecture:** Two surfaces over one draft. Tasks 1-7 fix the existing keyboard in place, each independently shippable and each closing one numbered defect from the spec — the key treatment, the action row, the second symbol page, word wrap and the caret, the prompt strip, and release-commit. Tasks 8-12 add the reply panel: host-side token extraction first (no firmware), then the wire field, then the panel itself, then the `kbActive` widening that makes the two screens one compose surface. Task 13 closes the verification and re-takes both baselines.

**Tech Stack:** Arduino ESP32 core, ESP32 + ILI9341 via TFT_eSPI (board 1), ESP32-S3 + ST77922 via `PanelShim` (board 2), Cozette/Terminus (board 1) and Spleen (board 2) bitmap fonts, Node ES modules for host and checkers.

**Spec:** `docs/superpowers/specs/2026-09-04-compose-surface-design.md`

## Global Constraints

- **Both baselines move in this plan, and only in Task 13.** Until then board 1 must stay `8f64b7f78c14b39eb53bb0206b7724f5d9e1df0eb22b08fbfdbb362d16e668e4` / 1387024 and board 2 `3f16e551ee3007fdf6a64f503baa38b85eb77df4c0221f5db945820d8ce2096d` / 1034064. Any task that moves them before Task 13 has changed something it was not asked to. Check with `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1`.
- **The baseline has a one-day shelf life and it is not maskable.** The first build after midnight reports `CHANGED (+16) on BOTH boards with no source change`, because the core's `__DATE__` and the sketch's stop being the same literal and the linker stops pooling them. Every line the script prints says `core stamp pooled` or `not pooled`; a `CHANGED` whose pooling flipped explains itself. Do not chase it and do not re-baseline for it.
- **NEVER COMPILE BOTH BOARDS CONCURRENTLY.** `arduino-cli` derives its build directory from the sketch PATH, so two FQBNs share one cache and overwrite each other's objects. The second symptom is dishonest: the board-2 link fails on undefined `TFT_eSprite` and Bluedroid symbols, which reads exactly like `board.h` choosing the wrong header. It has not; the cache has. Compile one, check it, then the other. If you see those symbols, `rm -rf ~/Library/Caches/arduino/sketches/<hash>` before believing anything else.
- Board 1 FQBN: `esp32:esp32:esp32:PartitionScheme=huge_app`. Board 2: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`. **Two of board 2's options fail SILENTLY:** without `PSRAM=opi` the 307,200-byte framebuffer allocation fails and the shim halts; without `CDCOnBoot=cdc` every `Serial.print()` from the sketch is swallowed while ROM boot text still arrives, so the board looks half-alive with nothing saying why.
- **A compile takes about 3 minutes — longer than a default command timeout.** Background it and poll. **Confirm the string `Sketch uses` appears before believing a build succeeded.**
- Flash with `./flash.sh` from the repo root (`--board 2` for board 2). `--no-compile` flashes whatever is in the shared cache, which is whichever board compiled LAST — **only safe when the last compile was for the same board.**
- **Never open a second serial connection.** On board 1 it pulses the CH340's reset line and reboots the ESP32 before anything arrives. Device commands go only through `echo "CMD" > ~/.claude/deckhand-device-command`. **The host delivers each command over BOTH transports, so a cabled device receives it twice** — every new handler must tolerate that.
- **Never run `node host/index.mjs`.** macOS TCC SIGABRTs a bare node process touching CoreBluetooth — an immediate crash, not a prompt. Use `./host/deckhand-service.sh stop|start`.
- **The `.ino` files are ONE translation unit**, concatenated with `deckhand_display.ino` first then the rest alphabetically. No function signature may name `SessionInfo`, `Theme`, `Usage`, `HostPairing` or `ConfirmAction`, because Arduino's generated prototypes are inserted above the first definition. A global defined in a later file needs an `extern` in `deckhand_display.ino`.
- **THE FONTS ARE ASCII `0x20..0x7E` AND NOTHING ELSE.** An out-of-range codepoint draws nothing AND advances nothing — invisible, not a fallback glyph. Every new string in this plan is ASCII, and truncation uses **three ASCII dots**, never U+2026.
- **`#if` on a C++ `const int` is silently false**, with no `-Wall` warning. Any new board flag is a `#define`.
- **No shared `.ino` may hardcode a panel dimension.** Every constant here is derived from `BOARD_W`/`BOARD_H`, `TAP_MIN`, `KB_LINE_PITCH` or `KB_PITCH`, and lives in the two board headers.
- **`KB_MAX_BYTES` stays 150**, and so does the host's `ANSWER_TEXT_MAX_BYTES` in `host/voice-answer.mjs`. `settings-geom-check.mjs:1881` already asserts they are equal.
- **A change-only cache shorter than its padded string silently stops noticing changes past that point**, and a field whose CHROME is repainted must have its cache reset or the value is left BLANK. A colour-only change reaches no text-comparing cache at all and must bust it explicitly.
- **`#if`/`#else` arms that both open a brace break every brace-counting checker here.** Put only the fragment that differs behind the guard.
- **On board 2 `SCREENSHOT` cannot see the glass.** It reads the shadow framebuffer — the same buffer the renderer just wrote — so a capture is correct by construction even when the panel is wrong. Every board-2 capture vouches for GEOMETRY and nothing else. `COLORTEST` is the instrument for colour and a person is the authority. Say so explicitly in every report rather than implying a screenshot settled it.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it**, must be bound to a FUNCTION BODY rather than to a file, and must FAIL BY NAME when the constant is reverted. `--selftest` exits 0 only when the injected fault IS caught.
- At the end of every task, all of these exit 0 from the repo root, with and without `--selftest`: `node firmware/deckhand_display/{usage,sessions,settings}-geom-check.mjs`, `node firmware/deckhand_display/{sessions-rank,scrollback,palette}-check.mjs`, `node host/{wire-bytes,ask-optdescs,pair-crypto,pair-exchange,voice-answer,host-tag,mac-emoji,run-ledger,watchdog,ccusage}-check.mjs`, `node claude-hooks/answer-status-check.mjs`, `node docs/design/*/check.mjs`.
- **`claude-hooks/deckhand-session-hook.mjs` is NOT modified by this plan.** The installed copy lives at `~/.claude/deckhand-session-hook.mjs`, outside this repo, and changing it needs `install-hooks.mjs` plus a reinstall. All token extraction happens in `host/`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `docs/design/compose/{compose.html,compose.js,check.mjs,README.md}` | the committed mock, bound to BOTH headers | 1 |
| `firmware/deckhand_display/board_e32r28t.h` | board 1's `KB_*`, `KB_KEY_R`, `KB_ACT_*`, `COMPOSE_*` | 2,3,6,10 |
| `firmware/deckhand_display/board_es3c35p.h` | board 2's same set | 2,3,6,10 |
| `firmware/deckhand_display/keyboard.ino` | the keyboard surface only: keys, card, caret, bubble | 2-7 |
| `firmware/deckhand_display/compose.ino` | NEW. the reply panel only: prompt card, replies, chips, recents, draft | 10,12 |
| `firmware/deckhand_display/deckhand_display.ino` | `uiKeyCap()`, `uiActionRow()`, `composeActive` state, `KBPROBE` | 2,3,7,11 |
| `host/ask-chips.mjs` | NEW. token extraction, pure and testable | 8 |
| `host/ask-chips-check.mjs` | NEW. its checker, bound to the firmware's buffer | 8 |
| `host/index.mjs` | calls extraction where the ask is forwarded | 9 |
| `firmware/deckhand_display/settings-geom-check.mjs` | every geometry assertion for both surfaces | 2-7,10 |
| `host/wire-bytes-check.mjs` | the `chips` field and its byte cap | 9 |
| `docs/reference/sessions-and-asks.md` | the surface's documented behaviour | 13 |

**Why `compose.ino` is a new file rather than more of `keyboard.ino`:** `keyboard.ino` is already 590 lines and owns one screen. The reply panel is a second screen with its own hit test, its own controls and no key grid. Alphabetical concatenation puts `compose.ino` before `keyboard.ino`, so anything `compose.ino` calls from `keyboard.ino` needs a forward declaration in `deckhand_display.ino` — Task 10 Step 2 handles exactly that.

---

### Task 1: The committed mock, bound to both headers

Nothing else in this plan can be trusted without this. The spec's tables are the authority only until the mock parses the headers; after this task the mock is.

**Files:**
- Create: `docs/design/compose/compose.html`, `docs/design/compose/compose.js`, `docs/design/compose/check.mjs`, `docs/design/compose/README.md`

**Interfaces:**
- Produces: `globalThis.__X = { SCREENS, K, ADV, CELL, BAD_CHARS }` from `compose.js`, where `K` is a **per-board** map of every constant the mock shares with a header. `check.mjs` binds `K[1]` to `board_e32r28t.h` and `K[2]` to `board_es3c35p.h` through `consts()`.

- [ ] **Step 1: Read the two mocks this one is modelled on**

`docs/design/settings-redesign/` is the shape to copy: an HTML shell, a JS module that draws every screen into an op list, and a `check.mjs` that binds the mock's `K` to the header name-for-name via `consts()` from `firmware/deckhand_display/geom-common.mjs`. `docs/design/usage-redesign/` adds `gfx-extract.mjs`. **Neither covers two boards** — every existing `check.mjs` calls `consts("board_es3c35p.h")` once. `K` here is `{1:{...},2:{...}}` and every assertion loops both boards.

- [ ] **Step 2: Write `check.mjs` FIRST, against the spec's numbers, and watch it fail**

Bind both boards and assert the four vertical budgets from the spec close exactly on `BOARD_H`:

```js
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";
const H = { 1: consts("board_e32r28t.h"), 2: consts("board_es3c35p.h") };
```

Run: `node docs/design/compose/check.mjs`
Expected: FAIL — `compose.js` does not exist yet.

- [ ] **Step 3: Write `compose.js` with the spec's geometry, and no header constants yet**

The mock draws both screens for both boards into an op list. Take every number from the spec's four budget blocks. `K` names them exactly as the headers will: `KB_TEXT_Y`, `KB_TEXT_H`, `KB_ROWS_Y`, `KB_ROW_H`, `KB_PITCH`, `KB_KEY_W`, `KB_KEY_R`, `KB_ACT_Y`, `KB_ACT_H`, `KB_ACT_DRAWN`, `KB_STRIP_H`, `COMPOSE_PROMPT_H`, `COMPOSE_LEGEND_H`, `COMPOSE_DRAFT_H`.

- [ ] **Step 4: Add the three assertions every mock here carries**

1. No string leaves `0x20..0x7E` — collect every text op and check each codepoint.
2. Nothing lands off the panel — every op's rect inside `0..BOARD_W` and `0..BOARD_H`.
3. Every tested band `>= TAP_MIN`, and every drawn control strictly inside its band.

Plus the binding: for each board, every name in `K[b]` must exist in `H[b]` and be equal, and a name in `K[b]` that the header does not define must FAIL rather than be skipped — that is what makes a misnamed constant an error instead of a silent pass.

- [ ] **Step 5: Add `--selftest`**

Inject one fault — push `COMPOSE_DRAFT_H` up by 8 so the reply panel's column overruns `BOARD_H` — and exit 0 **only when that fault is caught**, printing which assertion caught it.

Run: `node docs/design/compose/check.mjs --selftest`
Expected: exit 0, with a line naming the budget assertion as the catcher.

- [ ] **Step 6: Write `README.md`**

State plainly: what the mock is, that its glyph rendering is approximate and its geometry is not, that `K` is bound to both headers by `check.mjs`, and that the constants do not exist in the headers yet — Tasks 2, 3, 6 and 10 add them, and until each lands `check.mjs` fails **by name** on the ones missing. That failure is the plan working, not a broken checker.

- [ ] **Step 7: Commit**

```bash
git add docs/design/compose/
git commit -m "Add the compose mock, bound to both board headers

check.mjs fails by name on every KB_*/COMPOSE_* constant the headers do not
define yet. Tasks 2, 3, 6 and 10 add them; the failures are the binding
working, not a broken checker."
```

---

### Task 2: `KB_KEY_R` and the filled tile

Closes spec defect 10. `R_MD` is a card radius: 10 px on a 22 px key is 45.5% of its width against 4.6% on the 216 px card, and it rounds 85.8 px² — 9.8% of the drawn key — off the four corners, where a mis-aim lands.

**Files:**
- Modify: `firmware/deckhand_display/board_e32r28t.h`, `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/deckhand_display.ino` (add `uiKeyCap()` beside `uiButton()` at :783)
- Modify: `firmware/deckhand_display/keyboard.ino` (`drawKbKey`, `drawKbRow3`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Produces: `void uiKeyCap(int x, int y, int w, int h, const char* label, bool pressed, uint16_t behind)` — a key cell. No parameter names a struct type, so the generated prototypes are safe. Consumed by Tasks 4, 6, 7 and by `compose.ino` never (the reply panel has no key grid).

- [ ] **Step 1: Add `KB_KEY_R` to both headers with its derivation in the comment**

```cpp
// board_e32r28t.h
// THE KEY'S OWN RADIUS, not the card's. R_MD is 10, which is 4.6% of the 216px
// card it was sized for and 45.5% of a 22px key - a pill. Worse than the look:
// at r=10 the four corners lose 4*r^2*(1 - pi/4) = 85.8px2, 9.8% of the drawn
// 22x40 key, and they lose it FURTHEST FROM CENTRE, which is exactly where a
// mis-aim lands on a key already 40% under TAP_MIN. 2px is 9.1% of the width
// and 0.36mm, and costs 3.4px2.
const int KB_KEY_R = 2;
```

```cpp
// board_es3c35p.h
// KB_KEY_W / 10 under C truncation: 30/10 = 3 here, 22/10 = 2 there. That form
// gives both boards their value exactly, where the x1.154 scaling this header
// uses for R_MD and the borders does NOT - 2 * 1.154 is 2.31, which truncates
// back to 2. 3px is 10.0% of a 30px key and 0.46mm; it costs 7.7px2 of corner
// against R_MD's 123.6, which is 7.6% of this board's drawn key.
const int KB_KEY_R = 3;
```

- [ ] **Step 2: Add `uiKeyCap()` next to `uiButton()`**

It is `uiButton` with three differences, each with a reason on the line: radius `KB_KEY_R` not `R_MD`; **no `uiStrokeRound` when unpressed**; label `COLOR_VALUE` not `COLOR_ACCENT`. The fill is unchanged — `uiButton` already fills an unpressed control with `COLOR_CARD` and *then* strokes it, so the tile is that fill with the stroke dropped. **This adds no palette entry.**

```cpp
// A KEY, not a button. uiButton's R_MD is a card radius (see KB_KEY_R) and its
// 1px outline on COLOR_BG leaves the interior reading as background, so the
// target you aim at is smaller than the band kbTouch() tests. Inking the whole
// cap costs nothing: the COLOR_CARD fill is already there.
void uiKeyCap(int x, int y, int w, int h, const char* label,
              bool pressed = false, uint16_t behind = COLOR_BG) {
  uint16_t bg = pressed ? COLOR_ACCENT : COLOR_CARD;
  uiFillRound(x, y, w, h, KB_KEY_R, bg, behind);
  setUIFont(T_TITLE);
  tft.setTextColor(pressed ? COLOR_BG : COLOR_VALUE, bg);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, x + w / 2, y + h / 2);
  tft.setTextDatum(TL_DATUM);
}
```

- [ ] **Step 3: Point `drawKbKey` and `drawKbRow3` at it**

Both currently call `uiButton(..., COLOR_ACCENT, pressed, COLOR_BG)`. Replace with `uiKeyCap(..., pressed, COLOR_BG)`. **`drawKbKey`'s existing "CAP draws filled whenever shift is live" line stays** — it is what stops a full-board repaint losing shift state, and losing it is a regression this file already documents.

- [ ] **Step 4: Extend the checker, and make sure reverting fails by name**

In `settings-geom-check.mjs`'s keyboard block (around :1912-1922, which already asserts the drawn/tested split and the aspect cap) add, per board:

```js
chk(c.KB_KEY_R * 2 < c.KB_KEY_W,
    `KB_KEY_R ${c.KB_KEY_R} leaves a flat edge on a ${c.KB_KEY_W}px key`);
const loss = 4 * c.KB_KEY_R ** 2 * (1 - Math.PI / 4);
const drawn = c.KB_KEY_W * (c.KB_ROW_H - 4);
chk(loss / drawn < 0.02,
    `KB_KEY_R rounds ${loss.toFixed(1)}px2 off the corners, ` +
    `${(loss / drawn * 100).toFixed(1)}% of the ${drawn}px2 drawn key (R_MD ${c.R_MD} would be ` +
    `${(4 * c.R_MD ** 2 * (1 - Math.PI / 4) / drawn * 100).toFixed(1)}%)`);
```

The second assertion is the load-bearing one: it FAILS if `KB_KEY_R` is set back to `R_MD`, and its message prints both numbers. Verify that by hand — set `KB_KEY_R = R_MD` in one header, run the checker, confirm it fails naming `KB_KEY_R`, then revert.

- [ ] **Step 5: Bind the stroke's absence to the function body, not the file**

A grep for `uiStrokeRound` over `deckhand_display.ino` passes while `uiKeyCap` strokes freely, because `uiButton` next door calls it. Bind to the body:

```js
const keyCapSrc = fnSrc(SRC_MAIN, "uiKeyCap");
chk(!/uiStrokeRound/.test(keyCapSrc),
    "uiKeyCap's OWN BODY does not stroke - an outline on COLOR_BG is what makes the drawn key read smaller than its band");
chk(/KB_KEY_R/.test(keyCapSrc),
    "uiKeyCap's OWN BODY uses KB_KEY_R, not R_MD");
```

`fnSrc(src, name)` already exists at `settings-geom-check.mjs:130`. **`!/re/.test("")` is true**, so also assert `keyCapSrc.length > 0` — a negative assertion over a function that failed to parse passes vacuously.

- [ ] **Step 6: Update the mock and its binding**

Add `KB_KEY_R` to `K[1]` and `K[2]` in `docs/design/compose/compose.js` with the values from Step 1. `check.mjs` now binds it.

Run: `node docs/design/compose/check.mjs` and `--selftest`
Expected: both exit 0. `KB_KEY_R` is no longer among the missing names.

- [ ] **Step 7: Compile board 1, confirm the baseline is UNCHANGED, then board 2**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: **CHANGED.** This is the first task that moves board 1, and the change is `KB_KEY_R` plus `uiKeyCap`. Record the new hash and size in the task report but **do not** run `--update 1` — Task 13 does that once, with all of this plan's reasons in one message. Then compile board 2 separately.

- [ ] **Step 8: Flash both boards and LOOK at the keys**

```bash
./flash.sh
echo "KBTEST" > ~/.claude/deckhand-device-command
```

Then board 2, and on board 2 also:
```bash
echo "COLORTEST" > ~/.claude/deckhand-device-command
```

**This is the step the spec says cannot be settled anywhere else.** Confirm with your eyes, on the glass, in BOTH themes (`SETTINGS` -> theme), that an unpressed key reads as a key without its outline — that `COLOR_CARD` lifts off `COLOR_BG` enough. If it does not, stop and report: the fallbacks in order are a new per-theme keycap surface one step above `COLOR_CARD`, or keeping the stroke and taking only the radius. **Do not decide this from a screenshot.** On board 2 `SCREENSHOT` reads the shadow framebuffer and is correct by construction even when the panel is wrong.

- [ ] **Step 9: Commit**

```bash
git add firmware/deckhand_display/ docs/design/compose/
git commit -m "Give the key its own radius, and stop outlining it

R_MD is a card radius: 10px on a 22px key is 45.5% of its width against 4.6%
on the 216px card, and it rounds 85.8px2 - 9.8% of the drawn key - off the
corners, which is where a mis-aim lands on a key already 40% under TAP_MIN.
KB_KEY_R is 2/3, costing 3.4/7.7px2.

The tile costs no new colour: uiButton already fills an unpressed control with
COLOR_CARD and then strokes it, so this is that fill with the stroke dropped.
Confirmed on the glass in both themes on both boards - a screenshot cannot
judge this on board 2.

Board 1's binary moves. Baselines are re-taken once, in the last commit of
this plan."
```

---

### Task 3: The action row — drawn/tested split and proportional columns

Closes spec defects 9 and 2. `KB_ACT_H` is *defined* as equal to `KB_ROW_H` (44 and 58, or 7.82 and 8.94 mm), so the least-pressed control on the screen is the tallest, and unlike the keys it has no drawn/tested split at all. And `CANCEL` discards up to 150 characters at the same width as `SEND`, 8 px away.

**Files:**
- Modify: both board headers
- Modify: `firmware/deckhand_display/deckhand_display.ino` (add `uiActionRow()`)
- Modify: `firmware/deckhand_display/keyboard.ino` (`drawKbActions`, `kbTouch`'s `KB_ACT_Y` branch)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Produces: `int uiActionRow(int y, int band, int drawn, int dy, const char* const* labels, const uint16_t* tints, const uint8_t* fills, const uint8_t* fracs, int n, int* outX, int* outW)` — draws `n` proportional buttons and writes each one's **band** x and width into `outX`/`outW` for the hit test. Consumed by Tasks 10 and 11.

- [ ] **Step 1: Replace `KB_ACT_H` with a band and a drawn height in both headers**

```cpp
// board_e32r28t.h
// THE ACTION ROW, drawn and tested separately - the split the keys already have
// (KB_KEY_W in KB_PITCH, KB_ROW_H - 4 in KB_ROW_H) and this row never did.
// TESTED stays TAP_MIN: CANCEL and SEND are the two taps that must not miss.
// DRAWN is TEXT-DERIVED at 2 * KB_LINE_PITCH - one cell for the glyph, one for
// the air - which is 26px = 4.62mm, against the 44px = 7.82mm this row painted
// while a letter key, pressed up to 150 times, gets 4.27mm of width.
// The 4px freed is what pays for KB_STRIP_H in Task 6; board 1 has 12 spare
// pixels in 320 and this is where the twelfth comes from.
const int KB_ACT_H     = TAP_MIN;                 // 40, the tested band
const int KB_ACT_DRAWN = 2 * KB_LINE_PITCH;       // 26
const int KB_ACT_DY    = (KB_ACT_H - KB_ACT_DRAWN) / 2;   // 7
const int KB_ACT_Y     = BOARD_H - KB_ACT_H;      // 280, was 276
```

Board 2's is the same four expressions: 46, 32, 7, and `KB_ACT_Y = 426` (was 414), which leaves the 8 px bottom margin that header already keeps. **Write `TAP_MIN` and `2 * KB_LINE_PITCH`, not 40 and 26** — a checker asserting a derivation against its own term always holds, and a literal here is what lets the two drift.

- [ ] **Step 2: Add `uiActionRow()`**

The gap is 8. Each zone **swallows the gap to its right** so no strip between two buttons is dead — the same rule `kbTouch()` applies to `KB_PITCH`. The last column takes the remainder so the row closes on the lane exactly.

```cpp
// Proportional columns, which is how the destructive control stops being the
// same size as SEND: fracs {1,2} makes SEND twice DISCARD's width. The band
// (outX/outW) is wider than the button and is what the caller hit-tests.
int uiActionRow(int y, int band, int drawn, int dy, const char* const* labels,
                const uint16_t* tints, const uint8_t* fills, const uint8_t* fracs,
                int n, int* outX, int* outW) {
  const int gap = 8, lane = tft.width() - CARD_X * 2;
  int total = 0;
  for (int i = 0; i < n; i++) total += fracs[i];
  const int avail = lane - gap * (n - 1);
  int x = CARD_X;
  for (int i = 0; i < n; i++) {
    const bool last = (i == n - 1);
    const int w = last ? (CARD_X + lane - x) : (avail * fracs[i] / total);
    uiButton(x, y + dy, w, drawn, labels[i], tints[i], fills[i], COLOR_BG);
    outX[i] = x;
    outW[i] = w + (last ? 0 : gap);
    x += w + gap;
  }
  return n;
}
```

- [ ] **Step 3: Rewrite `drawKbActions` to use it, and relabel the destructive key**

Two columns, `fracs {1, 2}`. The left label is `CANCEL` when `kbLen == 0` and `DISCARD` in `COLOR_WARN` when there is text to lose — **label AND colour, never colour alone**, which is the rule `kbKeyLabel`'s `CAPS`/`CAP` comment already states. The `kbWindowClosed` branch keeps its measured `countWrappedLines` wrap, but its lane is now the SEND column's `outW[1]`, not `halfW` — recompute it from the returned width rather than re-deriving.

- [ ] **Step 4: Rewrite `kbTouch`'s action branch against the returned bands**

It currently splits on `halfW` computed inline, twice, in two functions. Store the bands in file-scope arrays written by `drawKbActions` and read by `kbTouch`, so the drawn row and the tested row cannot disagree — this is the same class of bug the file's own `kbRowX0()` comment describes ("the hit test and the draw must both derive x from the same place or a tap lands one key off").

- [ ] **Step 5: Assert it, per board**

```js
chk(c.KB_ACT_H === c.TAP_MIN, `KB_ACT_H ${c.KB_ACT_H} == TAP_MIN ${c.TAP_MIN}`);
chk(c.KB_ACT_DRAWN === 2 * c.KB_LINE_PITCH,
    `KB_ACT_DRAWN ${c.KB_ACT_DRAWN} == 2 * KB_LINE_PITCH ${2 * c.KB_LINE_PITCH}`);
chk(c.KB_ACT_DRAWN < c.KB_ACT_H,
    `the drawn button ${c.KB_ACT_DRAWN} is strictly inside its ${c.KB_ACT_H}px band`);
chk(c.KB_ACT_DY * 2 + c.KB_ACT_DRAWN === c.KB_ACT_H,
    `the button is centred: ${c.KB_ACT_DY} + ${c.KB_ACT_DRAWN} + ${c.KB_ACT_DY} == ${c.KB_ACT_H}`);
chk(c.KB_ACT_Y + c.KB_ACT_H <= c.BOARD_H,
    `the action band ends ${c.KB_ACT_Y + c.KB_ACT_H} inside BOARD_H ${c.BOARD_H}`);
```

And bind the proportion to the body, because a frac pair living next door satisfies a file-level grep:

```js
const actSrc = fnSrc(KB_SRC, "drawKbActions");
chk(actSrc.length > 0, "drawKbActions parsed");
chk(/DISCARD/.test(actSrc) && /COLOR_WARN/.test(actSrc),
    "drawKbActions' OWN BODY relabels to DISCARD and tints it - colour is never the only carrier");
chk(/\{\s*1\s*,\s*2\s*\}/.test(actSrc),
    "drawKbActions' OWN BODY gives SEND twice the destructive control's width");
```

- [ ] **Step 6: Update the mock's `K` and rerun both checkers**

Add `KB_ACT_H`, `KB_ACT_DRAWN`, `KB_ACT_DY`, `KB_ACT_Y`.

Run: `node docs/design/compose/check.mjs`, `--selftest`, `node firmware/deckhand_display/settings-geom-check.mjs`, `--selftest`
Expected: all exit 0.

- [ ] **Step 7: Compile both boards one after the other, then flash and look**

```bash
./flash.sh
echo "KBTEST" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

Confirm: the button is visibly shorter than the row it sits in, `SEND` is twice `CANCEL`'s width, and a tap anywhere in the 8 px between them still lands on one of the two. **Test the gap deliberately** — it is the thing this task claims to have removed.

- [ ] **Step 8: Commit**

```bash
git add firmware/ docs/design/compose/
git commit -m "Split the action row's drawn button from its tested band

KB_ACT_H was DEFINED as equal to KB_ROW_H, so the least-pressed control on the
screen was the tallest - 7.82mm and 8.94mm - while a letter key pressed 150
times gets 4.27mm of width. The band stays TAP_MIN because these are the two
taps that must not miss; the button is 2 * KB_LINE_PITCH, one cell for the
glyph and one for the air.

SEND now carries twice the destructive control's width and that control
relabels to DISCARD in COLOR_WARN when there is a draft to lose. Each zone
swallows the 8px gap to its right, so the dead strip between the two buttons
is gone.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 4: The second symbol page

Closes spec defect 3. 14 of the 95 printable ASCII characters cannot be typed at all: `$ % * < > [ \ ] ^ ` { | } ~`. 81 of 95 are reachable. On a device whose job is answering prompts about shell commands and file paths, five of those fourteen are not exotic.

**Files:**
- Modify: `firmware/deckhand_display/keyboard.ino` (`KB_SYM`, `kbRow`, `kbRowLen`, `drawKbRow3`, `kbTouch`'s row-3 branch, `kbSymbols`)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`kbSymbols` becomes `kbPage`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `uiKeyCap` from Task 2.
- Produces: `uint8_t kbPage` — 0 letters, 1 symbols, 2 the remaining symbols. Replaces `bool kbSymbols`. Consumed by Task 7's `hit()`.

- [ ] **Step 1: Add the second page and turn the toggle into a pager**

```cpp
// THE 14 CHARACTERS NO PAGE COULD REACH. 81 of the 95 printable ASCII
// codepoints were typeable; these are the rest, and five of them ($ * [ ] `)
// are ordinary in a shell command or a path, which is what this device answers
// questions about. The row lengths are 10 / 4 / 1, so rows 1 and 2 are CENTRED
// by kbRowX0() exactly as the 9-cell alpha rows already are.
const char* KB_SYM2[3] = { "[]{}<>\\|~^", "$%*`", "\x02" };
```

`kbSymbols` becomes `uint8_t kbPage` in `deckhand_display.ino`. `kbRow(r)` selects `KB_ALPHA` / `KB_SYM` / `KB_SYM2`. Row 3's page key cycles `(kbPage + 1) % 3` and labels `?123` / `2/2` / `ABC` — **three ASCII dots would be wrong here, these are real labels**; keep them at 4 characters, which `settings-geom-check.mjs` already measures against the 2-cell key.

- [ ] **Step 2: Assert every printable ASCII codepoint is now reachable, from the SOURCE**

This is the assertion that makes the task provable, and it must parse the three row tables out of `keyboard.ino` rather than restate them:

```js
const rows = [...KB_SRC.matchAll(/const char\* KB_(?:ALPHA|SYM|SYM2)\[3\] = \{([^}]*)\}/g)];
chk(rows.length === 3, `three key pages parsed out of keyboard.ino, found ${rows.length}`);
const reach = new Set([" ", "."]);              // SPACE and the dedicated dot on row 3
for (const m of rows)
  for (const lit of m[1].match(/"(?:[^"\\]|\\.)*"/g))
    for (const ch of JSON.parse(lit)) {
      if (ch === "\x01" || ch === "\x02") continue;   // CAP and DEL stand-ins
      reach.add(ch);
      if (ch >= "a" && ch <= "z") reach.add(ch.toUpperCase());
    }
const missing = [];
for (let cp = 0x20; cp <= 0x7e; cp++)
  if (!reach.has(String.fromCharCode(cp))) missing.push(String.fromCharCode(cp));
chk(missing.length === 0,
    `every printable ASCII codepoint is reachable; missing ${missing.length}: ${missing.join(" ")}`);
```

Verify it has teeth: delete `"$%*`"` from `KB_SYM2`, run the checker, confirm it fails naming the four characters, revert.

- [ ] **Step 3: Fix `KB_ROW_CELLS`, which is a transcription**

`settings-geom-check.mjs:292` hardcodes `[10, 9, 9, 10, 10, 9]`. With a third page that becomes wrong AND stays passing, which is the exact defect class this repo's checker rules name. Derive it from the same parse as Step 2:

```js
const KB_ROW_CELLS = rows.flatMap(m =>
  m[1].match(/"(?:[^"\\]|\\.)*"/g).map(lit => JSON.parse(lit).length));
```

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/settings-geom-check.mjs` and `--selftest`
Expected: exit 0. The row-width assertions now cover 9 rows, not 6.

- [ ] **Step 5: Compile both boards separately, flash, and type one of each**

```bash
./flash.sh
```
Open an ask, tap `TYPE`/the keyboard, and type `${*}` and a backtick. Confirm each appears — **an out-of-range codepoint draws nothing AND advances nothing**, so a character that silently fails looks like a dropped keypress rather than a missing glyph. Both new rows are centred; tap the leftmost and rightmost cell of each and confirm neither lands one key off (`kbRowX0`'s left-margin rejection is what makes this work).

- [ ] **Step 6: Commit**

```bash
git add firmware/
git commit -m "Add the second symbol page, and reach all 95 printable characters

14 of the 95 printable ASCII codepoints could not be typed at all: \$ % * < >
[ \\ ] ^ \` { | } ~. Five are ordinary in the shell commands and paths this
device answers questions about. ?123 becomes a three-state pager.

The checker now PARSES the three row tables instead of transcribing them, so
KB_ROW_CELLS cannot go stale, and asserts codepoint reachability over
0x20..0x7E rather than counting keys.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 5: A placeable caret

Closes spec defects 4 and 1. The answer hard-wraps mid-word, and the caret lives at `kbLen` and nowhere else — a wrong character forty places back costs five seconds of held `DEL` and forty re-taps on a sub-floor key.

**Files:**
- Modify: `firmware/deckhand_display/keyboard.ino` (`drawKbHardWrapped` -> `drawKbWrapped`, `drawKbText`, `kbInsert`, `kbBackspace`, `kbTouch`'s card branch)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`kbCaret`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Produces: `int kbCaret` — a byte offset into `kbText`, `-1` meaning "pinned to the end". `kbInsert`/`kbBackspace` act at it. Consumed by Tasks 7, 10 and 11.

- [ ] **Step 1: Understand why the hard wrap exists before replacing it**

`drawKbHardWrapped`'s comment is explicit: slicing at exactly `KB_COLS` makes the line budget **arithmetic** (`KB_TEXT_LINES = ceil(KB_MAX_BYTES / KB_COLS)`), and that is what stops `SEND` signing text that scrolled off the card. Word wrap makes the budget **measured**, so it needs the worst case measured rather than divided — and `settings-geom-check.mjs` already does exactly that search for the voice panel at each board's own adversarial word length (:329, board 1 lands on 8 at 17-character words, board 2 on 7 at 18). Reuse that search; do not invent a second one.

- [ ] **Step 2: Assert the measured budget FIRST, and watch it pass or fail honestly**

Add to the keyboard block, per board: search word lengths 1..`KB_COLS` for the maximum line count `wrapLineLen` produces over `KB_MAX_BYTES` bytes, and assert it is `<= KB_TEXT_LINES`. **If it fails on either board, stop and report** — word wrap then needs a line more than the card has, and the honest options are a taller card (board 1 has no room) or keeping the hard wrap. Do not raise `KB_TEXT_LINES` to make it pass; that is the "raising `BASELINE_FAILURES` to make the suite green" move this repo names.

- [ ] **Step 3: Replace the slicer with `drawWrappedText`'s wrap**

`drawKbWrapped` uses the same `wrapLineLen` the rest of the UI uses, drawing at most `KB_TEXT_LINES` lines. Keep the `KB_COLS`-sized stack buffer — it is still the widest a line can be.

- [ ] **Step 4: Map the caret through the same wrap, not a second one**

The caret's `(line, column)` comes from walking the *same* wrap the draw used, accumulating each line's length plus one for the space the wrap consumed. Its x step and box size stay `TEXT_ADV` and `KB_LINE_PITCH` — the file's comment already records why 6/11 literals were wrong (a caret 6 px wide stepping 6 px under an 8 px face lands under the wrong character).

- [ ] **Step 5: Make a drag in the card place it**

`kbTouch`'s `sy < KB_ROWS_Y` branch currently opens the peek. It now: places the caret when `kbLen > 0`, and opens the peek when `kbLen == 0` (which is when the card shows the question and the "tap here to read it" hint). **The hint's text must change with the behaviour** — after Task 6 the strip carries the peek and this branch is caret-only.

- [ ] **Step 6: Keep the "furthest reachable caret" assertion, re-derived**

`settings-geom-check.mjs:1896` asserts the caret's furthest position from `KB_MAX_BYTES / KB_COLS`. Under word wrap that division is no longer the bound; the bound is the measured worst case from Step 2. Rewrite the assertion against the measured value and **print both numbers**, so a future change to `KB_COLS` fails here rather than silently.

- [ ] **Step 7: Run every checker, compile both boards separately, flash, and edit mid-sentence**

Type a sentence that wraps, drag into the middle of line 2, and type. Confirm the character lands where the caret is, the wrap reflows, and `DEL` deletes to the left of the caret rather than at the end.

- [ ] **Step 8: Commit**

```bash
git add firmware/
git commit -m "Word-wrap the answer, and let the caret be placed

The hard wrap made the line budget arithmetic, which is what stopped SEND
signing text off the card. Word wrap makes it MEASURED, so the checker now
searches each board's own adversarial word length - the same search it already
runs for the voice panel - and asserts the worst case fits KB_TEXT_LINES.
Board 1 and board 2 both hold.

The caret was pinned to kbLen, so a typo forty places back cost forty re-taps
on a key already 40% under TAP_MIN. A drag in the card places it, mapped
through the same wrap the draw uses rather than a second one.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 6: The persistent prompt strip, and board 1's re-derived budget

Closes spec defects 5 and 8. Re-reading the question covers the keyboard, and while it is covered `kbTouch()` routes every tap to the pager — so you cannot read and type at once, and the only way out is to tap past the last page.

**Files:**
- Modify: both board headers (`KB_STRIP_H`, `KB_STRIP_Y`, `KB_TEXT_Y`, `KB_ROWS_Y`, `KB_ROW_H` on board 1)
- Modify: `firmware/deckhand_display/keyboard.ino` (`drawKbStrip`, `drawKeyboard`, `kbTouch`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `KB_ACT_H`/`KB_ACT_Y` from Task 3 — the 4 px that task freed on board 1 is what makes this fit.
- Produces: `KB_STRIP_H`, `KB_STRIP_Y`, and on board 1 a changed `KB_ROW_H` (44 -> 41) and `KB_ROWS_Y`.

- [ ] **Step 1: Write board 1's whole column, because it is the one with no slack**

Board 1 has 12 spare pixels in 320. The strip costs 17 and Task 3 freed 4, so `KB_ROW_H` gives up 3:

```cpp
// board_e32r28t.h
// THE STRIP: one line of the ask that never leaves. Its cost is stated because
// this board has 12 spare pixels in 320 and the strip needs 17.
//   4 (margin) + 17 (strip) + 3 + 88 (card) + 3 + 164 (4 x 41) + 1 + 40 = 320
// KB_ROW_H 44 -> 41 and KB_ACT_H 44 -> 40 (Task 3) are where the 17 comes from.
// BOTH still clear TAP_MIN 40, and the drawn key's aspect 37/22 = 1.68 is LESS
// elongated than the 40/22 = 1.82 the checker already caps against, so the
// aspect assertion holds without being touched.
const int KB_STRIP_H = KB_LINE_PITCH + 4;   // 17
const int KB_STRIP_Y = 4;
const int KB_TEXT_Y  = 24;                  // was 4
const int KB_ROWS_Y  = 115;                 // was 96
const int KB_ROW_H   = 41;                  // was 44
```

**`KB_TEXT_H` stays 88 and `KB_TEXT_LINES` stays 5.** The card keeps its provable lines; nothing about what `SEND` can sign changes.

- [ ] **Step 2: Board 2 pays nothing — the strip comes out of the break**

That header calls its 38 px break "a RESIDUAL, not a chosen number... the term with no job of its own". The strip takes 20 of it and `KB_ROWS_Y`, `KB_ROW_H` and `KB_PITCH` are **unchanged**:

```cpp
// board_es3c35p.h
//   6 + 20 (strip) + 8 + 120 (card) + 16 + 232 (4 x 58) + 24 + 46 + 8 = 480
const int KB_STRIP_H = KB_LINE_PITCH + 4;   // 20
const int KB_STRIP_Y = 6;
const int KB_TEXT_Y  = 34;                  // was 12
```

- [ ] **Step 3: Assert both columns close exactly on `BOARD_H`, per board**

**Do NOT write a sum-of-differences.** Summing every band with each gap written as a difference
telescopes to `BOARD_H` identically — proved numerically: 10,000 sets of ARBITRARY constants give
zero failures, so `sum === BOARD_H` cannot fail. Walk the column and assert each gap is
non-negative instead, which rejects 98.96% of the same garbage:

```js
const edges = [
  ["top margin",   0,                             c.KB_STRIP_Y],
  ["strip->card",  c.KB_STRIP_Y + c.KB_STRIP_H,   c.KB_TEXT_Y],
  ["card->keys",   c.KB_TEXT_Y  + c.KB_TEXT_H,    c.KB_ROWS_Y],
  ["keys->action", c.KB_ROWS_Y  + 4 * c.KB_ROW_H, c.KB_ACT_Y],
  ["action->end",  c.KB_ACT_Y   + c.KB_ACT_H,     c.BOARD_H],
];
for (const [name, end, start] of edges)
  chk(start >= end, `${name}: ${start} >= ${end} - no overlap`);
// THE TESTED BAND clears TAP_MIN, never the drawn control. settings-geom-check
// asserted the DRAWN key against it, which passed only while KB_ROW_H was 44
// (drawn 40, exactly TAP_MIN) and fails at 41 (drawn 37) - the wrong rule,
// getting away with it on a coincidence.
for (const [n, v] of [["KB_ROW_H", c.KB_ROW_H], ["KB_ACT_H", c.KB_ACT_H]])
  chk(v >= c.TAP_MIN, `${n} ${v} >= TAP_MIN ${c.TAP_MIN} (TESTED band, not the drawn control)`);
chk(c.KB_ROWS_Y > c.KB_TEXT_Y + c.KB_TEXT_H,
    `the key grid starts ${c.KB_ROWS_Y} below the card's last row ${c.KB_TEXT_Y + c.KB_TEXT_H - 1}`);
chk(c.KB_STRIP_Y + c.KB_STRIP_H < c.KB_TEXT_Y,
    `the strip ends ${c.KB_STRIP_Y + c.KB_STRIP_H - 1} above the card's top ${c.KB_TEXT_Y}`);
```

The gap terms are written as differences rather than as constants on purpose: every one is a residual, and a residual asserted against itself always holds.

- [ ] **Step 4: Draw the strip, and give it the peek**

`drawKbStrip()` draws one `fitText`-truncated line of `askDetail` with a right-aligned `MORE` when there is more. **`fitText` uses three ASCII dots** — this repo has paid for U+2026 there once already. A tap on the strip opens the paged peek; the card's tap is now the caret (Task 5). `kbHasDetail()` still gates both, so no control is advertised that would do nothing.

- [ ] **Step 5: Bust the caches the moved chrome invalidates**

`drawKeyboard()` `fillScreen`s, so nothing survives it — but `drawKbText()` is called on its own from `kbInsert`/`kbBackspace` and the strip is *outside* the card it repaints. Confirm by reading the code that no change-only cache spans the strip and the card. **A field whose chrome is repainted without its cache reset is left BLANK**, which is this repo's oldest bug and is documented in `drawSettingsStatic()` and `micRestoreUi()`.

- [ ] **Step 6: Update the mock's `K`, run every checker, compile both boards separately**

Add `KB_STRIP_H`, `KB_STRIP_Y`, and the changed `KB_TEXT_Y`/`KB_ROWS_Y`/`KB_ROW_H`.

- [ ] **Step 7: Flash both and confirm the question is readable while typing**

Type a character and confirm the strip still shows the prompt — that was the whole defect. Then tap the strip, page the peek, and confirm it closes past the last page. On board 1 specifically, confirm the 41 px rows still feel like keys and the action row has not slid off the bottom: `KB_ACT_Y + KB_ACT_H` is exactly `BOARD_H`.

- [ ] **Step 8: Commit**

```bash
git add firmware/ docs/design/compose/
git commit -m "Keep the question on screen while you answer it

Re-reading the prompt covered the keyboard, and while it was covered every tap
was a pager tap - so you could not read and type at once. One line of the ask
now sits above the card permanently, with the paged peek behind a tap on it.

Board 1 pays for it: KB_ROW_H 44 -> 41 on top of Task 3's KB_ACT_H 44 -> 40,
because that board has 12 spare pixels in 320. Both still clear TAP_MIN, and
the drawn key's aspect improves to 1.68 from 1.82. KB_TEXT_H, KB_COLS and
KB_TEXT_LINES do not move, so what SEND can sign is unchanged. Board 2 pays
nothing - the strip comes out of the 38px break its header already calls a
residual with no job of its own.

Both columns are now asserted to close exactly on BOARD_H, with every gap
written as a difference so no residual is asserted against itself."
```

---

### Task 7: Release-commit, the bubble, and `KBPROBE`

Closes spec defect 6, and instruments the claim. A character commits on **press**: the first pixel your finger lands on is the character you get, and the only feedback is a flash of a key your fingertip is covering. **This task's own justification is a claim, not a fact**, which is why `KBPROBE` ships with it.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`handleTouch` at :3489, `KBPROBE` in the command dispatch near :5961)
- Modify: `firmware/deckhand_display/keyboard.ino` (`kbTouch`, `tickKbRepeat`, `drawKbBubble`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`
- Modify: `docs/reference/commands-and-checks.md`, `CLAUDE.md` (the command table)

**Interfaces:**
- Consumes: `kbPage` (Task 4), `kbCaret` (Task 5).
- Produces: `bool kbArm(int sx, int sy)`, `void kbSlide(int sx, int sy)`, `bool kbRelease()` — the three phases. `handleTouch` calls them; nothing else does.

- [ ] **Step 1: Note that `handleTouch` already has a release path**

`handleTouch` (:3489) polls at 15 ms, returns early on `touching && wasTouching`, and **already acts on release for the record FAB** (`if (!touching && wasTouching)`). So this is an extension of a path that exists, not a new touch model. `tickKbRepeat()` separately proves the firmware can re-sample `getTouchPoint()` every tick and re-qualify against a key's own rectangle.

- [ ] **Step 2: Arm on press, re-target on the held path, commit on release — key band ONLY**

Everything else keeps press-commit, because every target there clears the floor: row 3, the action row, the card, the strip, the peek. **`DEL` is the one exception inside the key band** — it commits on press so a tap still deletes immediately, and `tickKbRepeat` keeps its hold-to-repeat unchanged.

The `touching && wasTouching` early return must now call `kbSlide()` before returning when a key is armed. Guard it on `kbActive` and on the armed state so no other screen pays for the poll.

- [ ] **Step 3: Clamp the bubble inside the key grid, which removes the cache problem entirely**

The bubble is the first element in this firmware that paints over live chrome. **Clamp it to `KB_ROWS_Y .. KB_ACT_Y` and draw it BELOW the finger for row 0**, so it never touches the card. That is what keeps it away from `drawKbText`'s repaint and away from the "chrome repainted without resetting its cache leaves the value blank" trap.

Restore is bounded and deterministic: the bubble's rect can overlap at most 6 key cells (2 rows x 3 columns at 2.3x pitch), and release redraws exactly those through `drawKbKey`. **Do not restore by calling `drawKeyboard()`** — it `fillScreen`s and would repaint the whole board per keystroke, which is the flicker the change-only discipline exists to prevent.

- [ ] **Step 4: Assert the bubble cannot reach the card, and bind it to the body**

```js
const bubSrc = fnSrc(KB_SRC, "drawKbBubble");
chk(bubSrc.length > 0, "drawKbBubble parsed");
chk(/KB_ROWS_Y/.test(bubSrc),
    "drawKbBubble's OWN BODY clamps to KB_ROWS_Y - a bubble that reaches the card has to bust the card's cache, which is this repo's oldest bug");
chk(!/fillScreen/.test(bubSrc) && !/drawKeyboard/.test(bubSrc),
    "drawKbBubble's OWN BODY does not repaint the screen or the whole board");
```

Then, per board, assert the geometry: the bubble's height at its widest placement plus its 6 px offset still starts at or below `KB_ROWS_Y`, for every row index 0..2.

- [ ] **Step 5: Add `KBPROBE`, which is what makes this task's claim measurable**

One line per keystroke on release: the armed key's row and column, the released key's row and column, and the pixel delta between the landing point and the release point. **Every refusal must NAME ITS CAUSE** — from the Mac, silence and "impossible here" look identical — so `KBPROBE` off the keyboard prints why. And **the host delivers each command over BOTH transports, so a cabled device receives it twice**: make the handler idempotent (a second `KBPROBE` while probing is a no-op that says so, not a second probe). `POWERPROBE` produced four refusal lines by getting this wrong.

- [ ] **Step 6: Document it in all three places a command lives**

`CLAUDE.md`'s command table, `docs/reference/commands-and-checks.md`, and the handler's own comment. State what it measures and what it does not: it measures where fingers land versus where they lift, and it says nothing about whether the resulting text was correct.

- [ ] **Step 7: Run every checker, compile both boards separately, flash BOTH, and take the measurement**

```bash
./flash.sh
echo "KBPROBE" > ~/.claude/deckhand-device-command
```

Type the same 40-character sentence twice on each board — once as a deliberate careful pass, once at speed — and record the slide-correction rate from the log. **Put the numbers in the task report.** This is the first evidence for or against the whole direction. If the correction rate is near zero, say so plainly: it would mean release-commit is buying nothing measurable and the spec's fallback (six columns, two taps per character) is what the next task should be, not this one.

- [ ] **Step 8: Commit**

```bash
git add firmware/ docs/reference/ CLAUDE.md
git commit -m "Commit a keystroke on release, and measure whether that helps

A character committed on PRESS, so the first pixel a finger landed on was the
character you got, on a key 31-40% under TAP_MIN, with the only feedback a
flash under the fingertip covering it. Press now arms and draws a magnified
bubble, the held path re-targets, and release commits - extending the release
path handleTouch already has for the record FAB, and re-sampling touch the way
tickKbRepeat already proves works.

The bubble is CLAMPED inside the key grid and drawn below the finger on row 0,
so it never touches the text card and never has to bust its change-only cache.
Restore redraws the at most six cells it covered, not the board.

KBPROBE ships with it because 'release-commit cuts mis-hits' is a claim. It
logs armed key, released key and the pixel delta per keystroke. Measured on
both boards; numbers in the task report.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 8: `host/ask-chips.mjs` — token extraction, host only

No firmware in this task. It is pure, testable, and shippable on its own: the host can extract and log chips before anything draws them.

**Files:**
- Create: `host/ask-chips.mjs`, `host/ask-chips-check.mjs`

**Interfaces:**
- Produces: `export function askChips(detail, opts)` returning `string[]` of at most `CHIP_MAX` entries, each at most `CHIP_BYTES` bytes, ASCII only. `export const CHIP_MAX = 4`, `export const CHIP_BYTES = 32`. Consumed by Task 9.

- [ ] **Step 1: Write the checker first, with the cases the spec names**

Four rules in order — backticked spans; tokens beginning `--`, or `-` followed by a letter; whitespace-free tokens containing `/`; quoted spans — then dedupe preserving first appearance, drop anything over `CHIP_BYTES`, cap at `CHIP_MAX`.

```js
const cases = [
  ["arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/deckhand_display",
   ["--fqbn", "firmware/deckhand_display"]],
  ["Run `npm test -- --watch` in packages/core?",
   ["npm test -- --watch", "--watch", "packages/core"]],
  ["Delete /Users/yujia/projects/deckhand/build and retry?",
   ["/Users/yujia/projects/deckhand/build"]],
  ["Use -f or --force?", ["-f", "--force"]],
  ["No tokens here at all", []],
];
```

Run: `node host/ask-chips-check.mjs`
Expected: FAIL — the module does not exist.

- [ ] **Step 2: Assert extraction runs AFTER `toAscii`, so the byte cap is exact**

```js
import { toAscii } from "./to-ascii.mjs";
const chips = askChips(toAscii("Run `café --wîde` now"), []);
for (const c of chips)
  ok(Buffer.byteLength(c, "utf8") === c.length,
     `chip ${JSON.stringify(c)} is ASCII, so its byte cap is its character cap`);
```

The ordering matters and is the same rule `host/wire-bytes-check.mjs` already enforces for the voice path at :100-103, by asserting the `toAscii` call appears *before* the cap in the source. Copy that shape.

- [ ] **Step 3: PARSE the firmware's buffer, do not restate 32**

Task 9 adds `char askChips[4][34]` to `SessionInfo`. Until then this assertion fails by name, which is correct. Follow `host/ask-optdescs-check.mjs:88` exactly:

```js
const fwSrc = fs.readFileSync("firmware/deckhand_display/deckhand_display.ino", "utf8");
const dims = fwSrc.match(/char askChips\[(\d+)\]\[(\d+)\];/);
ok(dims, "SessionInfo declares askChips[N][M] - Task 9 adds it");
ok(+dims[1] >= CHIP_MAX, `askChips holds ${dims[1]} chips, the host caps at ${CHIP_MAX}`);
ok(+dims[2] >= CHIP_BYTES + 1, `askChips[][${dims[2]}] holds ${CHIP_BYTES} bytes plus a NUL`);
```

- [ ] **Step 4: Add `--selftest`**

Inject a fault into the module under test — raise `CHIP_MAX` to 9 — and exit 0 only when the cap assertion catches it, naming `CHIP_MAX`.

- [ ] **Step 5: Write `host/ask-chips.mjs`**

Pure, no I/O, no imports beyond `to-ascii.mjs` if it needs one. Document at the top **why extraction is on the Mac and not the device** (the host already parses and transliterates; the ESP32 only draws buttons) and **why it is not in the hook** (`claude-hooks/deckhand-session-hook.mjs` installs to `~/.claude`, outside this repo, and changing it needs a reinstall).

- [ ] **Step 6: Run it, and run it against real asks**

Run: `node host/ask-chips-check.mjs` and `--selftest`
Expected: the case table and the ASCII assertions pass; the three firmware-buffer assertions FAIL by name until Task 9.

Then sample real data — `~/.claude/deckhand-sessions/*.json` has real ask details. Extract chips from every ask you can find and **read the output**. The spec's own "cannot verify" section says four heuristics against real prompts is an empirical question. Report what fraction produced useful tokens and what the false positives looked like.

- [ ] **Step 7: Commit**

```bash
git add host/ask-chips.mjs host/ask-chips-check.mjs
git commit -m "Extract tappable tokens from an ask, on the Mac

Four rules in order - backticked spans, flags, whitespace-free paths, quoted
spans - then dedupe, drop over 32 bytes, cap at 4. Runs AFTER toAscii so the
byte cap is exact, which wire-bytes-check already enforces the same way for
the voice path.

The checker PARSES askChips's dimensions out of the firmware rather than
restating 32 on both sides. Those three assertions fail by name until Task 9
declares the buffer, which is the binding working.

Sampled against real asks from ~/.claude/deckhand-sessions; results in the
task report."
```

---

### Task 9: The wire field and `SessionInfo.askChips`

**Files:**
- Modify: `host/index.mjs` (where the ask object is forwarded to the device)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`SessionInfo` at :966, the ask parse at :4180)
- Modify: `host/wire-bytes-check.mjs`

**Interfaces:**
- Consumes: `askChips`, `CHIP_MAX`, `CHIP_BYTES` from Task 8.
- Produces: `char askChips[4][34]` and `uint8_t askChipCount` on `SessionInfo`; `ask["chips"]` on the wire. Consumed by Tasks 10 and 12.

- [ ] **Step 1: MEASURE the ask line's headroom before adding to it**

The spec says this must be measured, not assumed. `askDetail` is capped at 1400 characters by the hook and `SessionInfo.askDetail` is `[1424]`. Find the line buffer the ask payload is parsed into, print the longest ask line the host currently emits, and add `CHIP_MAX * (CHIP_BYTES + 4)` plus JSON overhead — about 160 bytes. **If the headroom is not there, stop and report**: the options are a separate `CHIPS` line (the shape `SCROLLFETCH` already uses for a bounded sequence) or a smaller cap, and both are design changes rather than implementation details.

- [ ] **Step 2: Declare the buffer, with the DRAM arithmetic in the comment**

```cpp
// Tokens lifted out of the ask by the HOST (host/ask-chips.mjs), so this board
// only draws buttons. [34] matches askOpts[4][34]'s 32-char cap so the two need
// no separate rule. DRAM, stated the way the option-descriptions cap is:
// 4 x 34 x MAX_SESSIONS(6) = 816 bytes, against this board's ~26KB of free heap.
char askChips[4][34];
uint8_t askChipCount;
```

- [ ] **Step 3: Parse it beside `askOpts`**

At :4180 `askDetail` is copied with `copyField`, and `askOpts` is filled from `ask["opts"]` just below. `ask["chips"]` gets the same treatment, with `askChipCount` clamped to 4 and `askChips[0][0] = '\0'` on the no-ask path at :4160 — the same reset `askDetail` already gets there, and forgetting it is how a chip survives into a session that has no ask.

- [ ] **Step 4: Add it to `buildDetailSignature`'s change detection if it is part of the drawn state**

Read `buildDetailSignature` before deciding. `closeKeyboard()`'s comment records that a signature which never changes is how a stale screen persists permanently rather than for 5 s. Chips are drawn on the reply panel (Task 10), so the panel's signature must include them.

- [ ] **Step 5: Extend `host/wire-bytes-check.mjs`**

It already has the shape for this: the `chips` field appearing in the emitted ask, the `toAscii`-before-cap ordering, and the byte cap agreeing with the firmware's buffer. Follow its existing `grab()` + source-ordering assertions rather than adding a new style.

- [ ] **Step 6: Run every checker — Task 8's three firmware assertions must now PASS**

Run: `node host/ask-chips-check.mjs`, `--selftest`, `node host/wire-bytes-check.mjs`, `--selftest`
Expected: all exit 0, and `ask-chips-check` no longer reports the missing buffer.

- [ ] **Step 7: Restart the host, compile both boards separately, and confirm the chips arrive**

```bash
./host/deckhand-service.sh stop && ./host/deckhand-service.sh start
```
**Never `node host/index.mjs`** — TCC SIGABRTs it the instant it touches CoreBluetooth. Trigger a real ask and confirm the chips reach the device in the host log. Nothing draws them yet; that is Task 10.

- [ ] **Step 8: Commit**

```bash
git add host/ firmware/
git commit -m "Ship the ask's tokens to the device

ask['chips'] beside ask['opts'], into char askChips[4][34] - the same 32-char
cap askOpts uses, so the two need no separate rule. 4 x 34 x MAX_SESSIONS(6) =
816 bytes of DRAM against board 1's ~26KB of free heap.

The ask line's headroom was MEASURED before adding to it, not assumed; numbers
in the task report. Nothing draws them yet.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 10: `compose.ino` — the reply panel

**Files:**
- Create: `firmware/deckhand_display/compose.ino`
- Modify: both board headers (`COMPOSE_*`)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (forward declarations, `extern`s)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `uiActionRow` (Task 3), `kbCaret` (Task 5), `askChips`/`askChipCount` (Task 9).
- Produces: `void drawCompose()`, `bool composeTouch(int sx, int sy)`, `int composeChipPage`. Consumed by Task 11.

- [ ] **Step 1: Add the four `COMPOSE_*` constants to both headers, with the column that closes on `BOARD_H`**

Board 1 (from the spec, and every term is one of six expressions):

```cpp
// board_e32r28t.h
//   4 (margin) + 52 (prompt) + 4 + 16 (legend) + 80 (reply, 2 x TAP_MIN)
// + 16 (legend) + 40 (tokens) + 21 (draft) + 16 (legend, "recents do not fit")
// + 31 (residual) + 40 (action band) = 320
// Every term is TAP_MIN, KB_LINE_PITCH + k, KB_TEXT_H, n x TAP_MIN, or a
// residual with no job of its own. There is no chosen number here, which is
// what lets the checker assert the column instead of transcribing it.
const int COMPOSE_PROMPT_H = 5 + KB_LINE_PITCH + 4 + 2 * KB_LINE_PITCH + 4;  // 52
const int COMPOSE_LEGEND_H = KB_LINE_PITCH + 3;                              // 16
const int COMPOSE_DRAFT_H  = KB_LINE_PITCH + 8;                              // 21
const int COMPOSE_GAP      = 4;
```

Board 2 is the same four expressions: 77 (3 prompt lines), 19, 24, 8. **Board 2's reply panel has ONE token band, not two** — the spec is explicit that its 64 px residual is deliberately unspent so the two panels stay structurally identical, and names a second band as the first thing to spend it on if paging proves annoying.

- [ ] **Step 2: Add the forward declarations, in the right file, at the top**

Alphabetical concatenation puts `compose.ino` **before** `keyboard.ino`, so anything `compose.ino` calls from `keyboard.ino` (`openKeyboard`, `kbInsert`) needs a prototype, and any global `compose.ino` defines that `deckhand_display.ino` reads needs an `extern` there. **No prototype may name `SessionInfo`, `Theme`, `Usage`, `HostPairing` or `ConfirmAction`** — pass `int idx` and look the session up inside.

- [ ] **Step 3: Draw the four control kinds, distinguished by FORM and never by colour**

| Kind | Form |
|---|---|
| send | filled `COLOR_GOOD`, label centred |
| insert | `COLOR_CARD` fill, **no stroke**, `FONT_CODE`, left-aligned, prefixed `+ ` |
| reuse | `COLOR_CARD` fill, `COLOR_LABEL` stroke, left-aligned |
| navigate | `COLOR_CARD` fill, `COLOR_ACCENT` stroke, centred |

Form, alignment and typeface all differ, so the panel survives a monochrome theme. Every control's **band is `TAP_MIN`** and its **button is `KB_ACT_DRAWN`**, centred by `KB_ACT_DY` — the same three numbers Task 3 derived, reused rather than re-derived. Adjacent bands are **contiguous**: the gap comes from the inset, so there is no dead strip.

- [ ] **Step 4: Truncate a chip's LABEL and never its VALUE**

The label cap is half the lane, so two chips always share a row. `firmware/deckhand_display` is 25 characters against a 13-character cap on board 1, so the button reads `firmware/d...` — **three ASCII dots** — and inserts all 25. Truncating the inserted token would quietly send Claude a path that does not exist. **Assert this**, because it is the kind of thing a later refactor collapses:

```js
const chipSrc = fnSrc(COMPOSE_SRC, "drawComposeChip");
chk(chipSrc.length > 0, "drawComposeChip parsed");
chk(/fitText/.test(chipSrc), "drawComposeChip's OWN BODY truncates only for drawing");
const insSrc = fnSrc(COMPOSE_SRC, "composeInsertChip");
chk(insSrc.length > 0, "composeInsertChip parsed");
chk(!/fitText/.test(insSrc),
    "composeInsertChip's OWN BODY inserts the WHOLE token - a truncated path is a path that does not exist");
```

- [ ] **Step 5: Make the token pager real, not a count**

The row fits two tokens on both boards, so a `N>` label that only counts leaves the rest unreachable. It pages, and **its lane is reserved before the chips are laid out** so a wide chip can never run underneath it.

- [ ] **Step 6: Say on the glass that recents do not fit on board 1**

Not a gap, a line: `recents: no vertical budget on board 1`, in `COLOR_LABEL`. **Every refusal must name its cause** — this repo's rule for device commands, and it applies just as well to a row that is absent.

- [ ] **Step 7: Assert the column, per board**

Same shape as Task 6 Step 3 **as corrected there** — a contiguity walk asserting every gap is non-negative, NOT a sum of differences, which telescopes and cannot fail. Then assert every band `>= TAP_MIN`, assert every drawn button strictly inside its band, and assert the three reply columns sum to the lane exactly (72+72+72 = 216 on board 1, 98+98+100 = 296 on board 2, remainder on the last).

- [ ] **Step 8: Update the mock, run every checker, compile both boards separately**

Add all four `COMPOSE_*` names to `K[1]` and `K[2]`. `docs/design/compose/check.mjs` should now report **no missing names on either board** — that is the milestone this task hits.

- [ ] **Step 9: Flash both and look at all four control kinds**

Nothing routes to this screen yet (Task 11), so drive it with the existing `PAGE`/`KBTEST` pattern or a temporary command. Confirm each kind is distinguishable **with the theme set to LIGHT and to DARK**, and confirm a tap in the space between two reply buttons still lands on one of them.

- [ ] **Step 10: Commit**

```bash
git add firmware/ docs/design/compose/
git commit -m "Add the reply panel

Four control kinds distinguished by FORM, not colour: a filled button sends, a
quiet unstroked mono chip prefixed + inserts, an outlined row reuses, an
accent-outlined key pages. Form, alignment and typeface all differ, so the
panel reads with the palette flattened - an earlier draft separated them by
stroke tint alone, which CLAUDE.md rules out in as many words.

Every band is TAP_MIN and every button KB_ACT_DRAWN, reusing Task 3's three
numbers rather than deriving new ones, and adjacent bands are contiguous so
no strip between two controls is dead.

A chip's LABEL truncates with three ASCII dots; its VALUE never does, and the
checker binds that to composeInsertChip's own body. The pager is real, because
the row fits two tokens and a count would leave the rest unreachable.

The compose mock now binds every constant on both boards with none missing.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 11: One compose surface, one draft

The spec calls this the single largest structural change and the one most likely to produce the bug `closeKeyboard()`'s own comment documents — a screen that no longer matches the touch router.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`kbActive` -> `composeActive` + `composeScreen`, `handleTouch`'s dispatch)
- Modify: `firmware/deckhand_display/keyboard.ino` (`openKeyboard`, `closeKeyboard`, `drawKbActions`, `kbTouch`)
- Modify: `firmware/deckhand_display/compose.ino` (`TYPE...`, `CLOSE`/`DISCARD`)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: everything from Tasks 3, 5, 10.
- Produces: `uint8_t composeScreen` (0 reply panel, 1 keyboard), `void openCompose(int idx)`, `void closeCompose()`.

- [ ] **Step 1: Read `closeKeyboard()` in full before touching anything**

Its comment is the longest in the file and it is a bug report: leaving `showingDetail` true while the glass showed the list made `handleTouch` route every tap into `handleAskTouch` against a screen that no longer matched — so a tap on a session row **silently answered Claude with whatever option sat at that y**, and a tap low down started an unwanted mic capture. Nothing repainted that away, so it was permanent. **Widening `kbActive` is exactly the change that can reintroduce this.**

- [ ] **Step 2: Widen the state, and keep the repaint contract in ONE place**

`kbActive` becomes `composeActive`, with `composeScreen` saying which surface is up. `openCompose(idx)` does every reset (the way `openKeyboard` already centralises them, which is why `openKeyboardForMessage` goes through it). `closeCompose()` keeps `closeKeyboard()`'s full sequence verbatim — `fillScreen`, `drawTabBar()`, `drawFooterChrome()`, content, `renderFooter()` **last** — because that order is what stops `drawIfChanged` seeing an "unchanged" string against pixels `drawFooterChrome()` just erased.

- [ ] **Step 3: Move between screens without resetting the draft**

`TYPE...` sets `composeScreen = 1` and repaints; `BACK` sets it to 0. **Neither touches `kbText`, `kbLen` or `kbCaret`.** That shared field is the whole reason the two screens compose rather than coexist, and it is the one thing to assert:

```js
const typeSrc = fnSrc(COMPOSE_SRC, "composeOpenKeyboard");
chk(typeSrc.length > 0, "composeOpenKeyboard parsed");
chk(!/kbLen\s*=\s*0/.test(typeSrc) && !/kbText\[0\]\s*=/.test(typeSrc),
    "composeOpenKeyboard's OWN BODY does not clear the draft - a chip tapped on the panel must survive into the keyboard");
```

- [ ] **Step 4: Make the keyboard's left key `BACK`, not a destructive control**

Standalone it was `CANCEL`/`DISCARD` (Task 3). Under the pairing, leaving compose is the reply panel's job and the keyboard returns to it. That removes the worst form of spec defect 2: the destructive control is no longer adjacent to `SEND` on the keyboard screen at all. The reply panel grows `CLOSE`, relabelling to `DISCARD` in `COLOR_WARN` when there is a draft — three columns, `fracs {1, 1, 2}`, so `SEND` is twice `DISCARD`.

- [ ] **Step 5: Route touch through exactly one branch**

`handleTouch` dispatches on `composeActive` and then on `composeScreen`. Assert there is exactly one such dispatch, bound to the body:

```js
const htSrc = fnSrc(SRC_MAIN, "handleTouch");
chk(htSrc.length > 0, "handleTouch parsed");
chk((htSrc.match(/composeActive/g) || []).length >= 1,
    "handleTouch's OWN BODY gates on composeActive");
chk(!/kbActive/.test(SRC_MAIN + KB_SRC + COMPOSE_SRC),
    "kbActive is fully retired - two names for one state is how a screen and its touch router disagree");
```

- [ ] **Step 6: Walk every exit path by hand, on hardware, on both boards**

The bug this task risks is not caught by any checker. Flash and walk all eight: reply panel -> `CLOSE`; reply panel -> `DISCARD` with a draft; reply panel -> a one-tap send; reply panel -> `SEND` with a chip-built draft; `TYPE...` -> `BACK`; `TYPE...` -> `SEND`; both screens with the ask expiring underneath (`kbWindowClosed`); and both screens with the session going away. **After each, tap a session row and confirm it does what it should** — that is the specific symptom `closeKeyboard()` documents, and it is silent.

- [ ] **Step 7: Run every checker, compile both boards separately**

- [ ] **Step 8: Commit**

```bash
git add firmware/
git commit -m "Make the two screens one compose surface, over one draft

kbActive meant 'the keyboard is up'; it now means 'compose is up', on one of
two surfaces. The reply panel is the root and the keyboard is the sheet behind
TYPE, so the draft is a single field: a chip tapped on the panel is editable
on the keyboard, and text typed there comes back to the panel's draft line.

The keyboard's left key is BACK, not CANCEL - leaving compose is the panel's
job now, so the destructive control is not adjacent to SEND on the keyboard
screen at all. The panel's CLOSE relabels to DISCARD in COLOR_WARN with a
draft to lose, at half SEND's width.

closeCompose keeps closeKeyboard's repaint sequence verbatim, including
renderFooter() last, and every exit path was walked on hardware on both
boards - the bug that comment documents is silent and no checker catches it."
```

---

### Task 12: The recents ring

**Files:**
- Modify: `firmware/deckhand_display/compose.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `drawCompose`, `composeTouch` (Task 10).
- Produces: `char composeRecent[4][151]`, `uint8_t composeRecentCount`, `void composeRemember(const char* text)`.

- [ ] **Step 1: RAM only, and say why in the code**

```cpp
// SENT TEXT, remembered for the session and no longer. 4 x 151 = 604 bytes of
// DRAM, global rather than per session. Deliberately NOT in NVS: persisting it
// would give a BLE-paired device a plaintext log of everything you have replied,
// plus a flash-wear budget, in exchange for a one-tap convenience. Reversible
// later if asked; not the default.
char composeRecent[4][151];
uint8_t composeRecentCount;
```

`151` is `KB_MAX_BYTES + 1`. **Write it as `KB_MAX_BYTES + 1`**, not 151 — a literal is how the two drift when the cap moves.

- [ ] **Step 2: Record on every send path, in one place**

`sendTypedAnswerToHost`, `sendPromptToHost`, and the reply panel's one-tap send all call `composeRemember()`. Put the call where the text is known to have gone out, not where the button was pressed — a send that returns early on `kbLen == 0` or an unprovisioned MAC must not enter the ring.

- [ ] **Step 3: Dedupe, newest first**

An identical string moves to the front rather than adding a second entry. Four slots is small enough that a duplicate wastes a quarter of it.

- [ ] **Step 4: Board 1 shows the line, not the row**

Task 10 already draws `recents: no vertical budget on board 1`. Confirm the ring still fills on board 1 — it costs the same 604 bytes there and would be needed the moment the budget changed — and that nothing tries to draw a row that does not exist.

- [ ] **Step 5: Assert the ring against the cap and the buffer**

```js
const ring = COMPOSE_SRC.match(/char composeRecent\[(\d+)\]\[([^\]]+)\];/);
chk(ring, "composeRecent[N][M] declared");
chk(/KB_MAX_BYTES\s*\+\s*1/.test(ring[2]),
    `composeRecent's row is KB_MAX_BYTES + 1, not the literal ${ring[2]} - a literal is how the two drift`);
const remSrc = fnSrc(COMPOSE_SRC, "composeRemember");
chk(remSrc.length > 0, "composeRemember parsed");
chk(/strcmp|strncmp/.test(remSrc),
    "composeRemember's OWN BODY dedupes - four slots are too few to spend one on a duplicate");
```

- [ ] **Step 6: Run every checker, compile both boards separately, flash board 2 and use it**

Send three different replies, then send the first again, and confirm it moves to the front rather than appearing twice. Confirm the ring is empty after a reboot — that is the design, not a bug, and the task report should say so.

- [ ] **Step 7: Commit**

```bash
git add firmware/
git commit -m "Remember what you sent, for the session and no longer

A ring of 4 x (KB_MAX_BYTES + 1) = 604 bytes of DRAM, global, newest first,
deduped. Board 1 fills it too and says on the glass that it has no room to
draw it.

Deliberately not persisted: NVS would give a BLE-paired device a plaintext log
of every reply and a flash-wear budget, for a one-tap convenience. Empty after
a reboot by design.

Board 1's binary moves; baselines are re-taken in the last commit."
```

---

### Task 13: Close the verification, re-take both baselines, write it down

**Files:**
- Modify: `firmware/deckhand_display/geom-sweep.mjs`
- Modify: `docs/reference/sessions-and-asks.md`, `docs/reference/board-1-known-state.md`, `CLAUDE.md`
- Modify: `firmware/board-baseline.json` (via `--update`)

- [ ] **Step 1: Put the new constants into the fault-injection sweep**

`geom-sweep.mjs` injects a fault per constant and requires a named failure. Add every `KB_KEY_R`, `KB_ACT_*`, `KB_STRIP_*` and `COMPOSE_*` name. **Any constant the sweep can perturb without a named failure has an assertion that cannot fail**, and finding those is the whole point.

Run: `node firmware/deckhand_display/geom-sweep.mjs`
Expected: exit 0, ~110 s. Every new constant appears in its output with a catcher named.

- [ ] **Step 2: Run the whole suite, both `--selftest` and not**

```bash
node firmware/deckhand_display/{usage,sessions,settings}-geom-check.mjs
node firmware/deckhand_display/{sessions-rank,scrollback,palette}-check.mjs
python3 firmware/deckhand_display/{usage-trend,batt-trend}-check.py
node host/{wire-bytes,ask-optdescs,pair-crypto,pair-exchange,voice-answer}-check.mjs
node host/{ask-chips,host-tag,mac-emoji,run-ledger,watchdog,ccusage}-check.mjs
node claude-hooks/answer-status-check.mjs
node docs/design/*/check.mjs
```
Every one exits 0, with and without `--selftest`. `BASELINE_FAILURES` in `usage-geom-check.mjs` must still be 0 — **raising it is never the way to make the suite green.**

- [ ] **Step 3: Compile each board separately and re-take both baselines, with the reasons**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
# then, separately:
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2
```

Check the `core stamp pooled` line on both. **Board 2's baseline was once allowed to fall 4,112 bytes stale across 42 commits**, so `--check 2` reported `CHANGED` through an entire task for reasons unrelated to it — a `CHANGED` you have learned to expect is a `CHANGED` you stop reading. Both are updated here, in one commit, with every reason from this plan named.

- [ ] **Step 4: Update `CLAUDE.md`**

Three places: the baseline hash and size in the *BOARD 1'S BINARY IS A CONTRACT* section, `KBPROBE` in the device-command table, and `compose.ino` in the firmware file map. Keep the existing density — that file is the rules, not narrative.

- [ ] **Step 5: Rewrite the keyboard part of `docs/reference/sessions-and-asks.md`**

Document the compose surface as it now is: the two screens, the shared draft, the four control kinds and why form rather than colour, the chip label/value distinction, the drawn/tested split, and release-commit. **Every claim carries its evidence, and "not verified" is written down rather than left implied.** In particular record, as measurements with numbers: `KBPROBE`'s slide-correction rate from Task 7, and the real-ask chip sample from Task 8.

- [ ] **Step 6: Record what is still NOT verified**

In the same file, plainly:

- **That most answers are short.** The whole reply panel rests on it. The host has the history and it has still not been measured.
- **That release-commit reduces the error rate**, beyond the one sitting measured in Task 7's report.
- **That the filled tile reads as a key** in every theme on every panel — Task 2 Step 8 checked it with a person, and that is the only kind of evidence available.
- **That the four extraction heuristics pick the right tokens** in general.

Add board 1's changed `KB_ROW_H`/`KB_ACT_H` to `docs/reference/board-1-known-state.md`, since that file is where this repo records what moved on that board and why.

- [ ] **Step 7: Correct in place rather than deleting**

If anything in `docs/reference/` described the old keyboard's behaviour and is now wrong, **mark it as superseded rather than removing it**. A described defect that no longer exists costs the next reader either the time to disprove it or a no-op "fix" — which is why this repo keeps and marks entries instead of deleting them.

- [ ] **Step 8: Commit**

```bash
git add firmware/ docs/ CLAUDE.md host/
git commit -m "Close the compose surface: sweep, baselines, and what is written down

geom-sweep now perturbs every KB_KEY_R, KB_ACT_*, KB_STRIP_* and COMPOSE_*
constant and requires a named failure for each - a constant it can move
without one has an assertion that cannot fail.

BOTH baselines re-taken deliberately. Board 1 moved for six stated reasons
across this plan: KB_KEY_R and uiKeyCap, the action row's drawn/tested split,
the second symbol page, word wrap and the caret, KB_ROW_H 44 -> 41 for the
prompt strip, and the reply panel. Board 2 moved for the same set minus the
row height. A change to board 1 must never be a surprise, which is not the
same as never happening.

sessions-and-asks.md now records the surface with its evidence, including
KBPROBE's measured slide-correction rate and the real-ask chip sample - and
the four things this design still cannot verify, written down rather than
implied."
```

---

## Self-Review

**Spec coverage.** Every numbered defect maps to a task: 1 and 4 -> Task 5; 2 -> Tasks 3 and 11; 3 -> Task 4; 5 and 8 -> Task 6; 6 -> Task 7; 7 -> Task 10 (`CLR` on the draft line); 9 -> Task 3; 10 -> Task 2. Every spec section maps too: the four control kinds -> Task 10 Step 3; the drawn/tested split -> Task 3 Steps 1-2 and reused in Task 10 Step 3; the key treatment -> Task 2; the four budgets -> Tasks 6 and 10, each asserted with gaps as differences; the chips (host, wire, firmware) -> Tasks 8, 9, 10; recents -> Task 12; the touch model -> Task 7; `KBPROBE` -> Task 7 Step 5; the mock binding -> Task 1; both baselines -> Task 13.

**One gap found and closed:** the spec's `CLR` control (defect 7) had no task; it is now Task 10 Step 3's draft line, drawn as part of the panel.

**Naming, checked across tasks.** `uiKeyCap` (Task 2) is called by Tasks 4, 6, 7. `uiActionRow` (Task 3) is called by Tasks 10, 11. `kbCaret` (Task 5) is read by Tasks 7, 10, 11. `kbPage` (Task 4) replaces `kbSymbols` everywhere and is read by Task 7's `hit()`. `askChips`/`CHIP_MAX`/`CHIP_BYTES` (Task 8) are consumed by Task 9 under those exact names, and `SessionInfo.askChips[4][34]` is what Task 8's checker parses. `composeActive`/`composeScreen` (Task 11) retire `kbActive`, and Task 11 Step 5 asserts the old name is gone from all three sources so two names for one state cannot survive.

**Ordering.** Task 1 fails by name until Tasks 2, 3, 6 and 10 land, which is stated in its own README and is the binding working. Task 8's three firmware assertions fail until Task 9, also stated. Nothing else depends on a name that does not yet exist.
