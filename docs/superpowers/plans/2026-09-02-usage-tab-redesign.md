# USAGE Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace board 2's USAGE tab — two structurally identical 164px cards plus a Codex line — with a semantic hierarchy: a 5-hour NOW card keeping the 64px hero and gaining a trend sparkline, a 144px WEEK card carrying Fable as a real second bar, and the Codex row unchanged in shape.

**Architecture:** Everything new sits behind `BOARD_USAGE_V2` (1 on board 2, 0 on board 1 where it emits no code). One trend ring serves both the sparkline and the burn rate. Two burn estimators are chosen by window length, because the ring can measure a 5-hour window and provably cannot measure a 7-day one. The two shared-code bug fixes land FIRST, each moving board 1 deliberately in its own commit; every task after that holds board 1 byte-identical.

**Tech Stack:** Arduino ESP32-S3 (`esp32:esp32:esp32s3`), `PanelShim` over a PSRAM framebuffer, Spleen 8x16 / 12x24 / 32x64 bitmap fonts. Verification is checker scripts (`*.mjs`, `*.py`) plus `board-baseline.mjs`; there is no test framework in this repo.

**Spec:** `docs/superpowers/specs/2026-09-02-usage-tab-redesign-design.md`

## Global Constraints

- **There is no test suite.** The test-first cycle in this repo is: add the assertion to a checker, run it, **watch it fail**, implement, run again. A checker assertion that has never been seen to fail is not a test.
- **A checker must PARSE the constant it certifies, never transcribe it.** This has bitten three times (`BODY_H`, `PILL_H`, `READER_CODE_LINE_H`).
- **Board 1 is byte-identical from Task 3 onward.** `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1` must print `UNCHANGED` at every commit of Tasks 3–10. Tasks 1 and 2 move it on purpose and re-baseline.
- **NEVER compile both boards concurrently.** `arduino-cli` keys its build cache on the sketch PATH, so two FQBNs of one sketch overwrite each other's objects. Compile board 2, `--check 2`, then board 1, `--check 1`.
- **Every string reaching the panel must be inside `0x20..0x7E`.** Both fonts declare only that range; anything else draws as nothing and advances nothing. This trap has been paid for four times.
- **Nothing on a card may end past `CARD_H - 3`.** Check the CLEAR box, not the glyph: `drawIfChanged` clears `(fx-1, fy-1, tw+2, th+2)` and `drawPaceBar` clears `(x-1, y-4, w+2, h+8)`.
- **Change-only redraw.** Every new field needs its own cache, every cache must be reset inside `resetUsageCaches()`, and a change that moves no text must bust its cache explicitly.
- **`~` means about; `>=` means at least.** The burn figure is an estimate and takes `~`. `>=` is reserved for the charge estimator's deliberate floor.
- **Costs are measured, never estimated.** Report flash and RAM per board from a real build.

### Build and check commands (used verbatim throughout)

```bash
# board 2
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2

# board 1 — AFTER board 2 finishes, never at the same time
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

---

## File Structure

| file | responsibility | task |
|---|---|---|
| `firmware/deckhand_display/usage.ino` | the trend ring, both burn estimators, the sparkline, `renderNowCard`, `renderWeekCard`, the Codex fix | 1, 5–9 |
| `firmware/deckhand_display/deckhand_display.ino` | the stats-field alignment fix; wrapping `renderCard` in `#if !BOARD_USAGE_V2` | 2, 9 |
| `firmware/deckhand_display/board_es3c35p.h` | board 2's flag and every new layout/gate constant | 3 |
| `firmware/deckhand_display/board_e32r28t.h` | `BOARD_USAGE_V2 0`, and its own re-derived `CODEX_LANE_CHARS` | 1, 3 |
| `firmware/deckhand_display/usage-geom-check.mjs` | the exact-column assertion, the band table, the ink-collision rule | 1, 2, 3, 7, 8 |
| `firmware/deckhand_display/usage-trend-check.py` | **new** — the ring and burn arithmetic, thresholds parsed out of `usage.ino` | 5, 6 |
| `docs/design/usage-redesign/` | **new** — the mock, committed as the normative geometric spec | 4 |
| `CLAUDE.md` | the redesign's own section, measured costs | 10 |

**Why the card renderers go in `usage.ino` and not `deckhand_display.ino`:** the USAGE tab lives there, and the main file is already the biggest in the sketch. The Arduino build concatenates every `.ino` into one translation unit and generates prototypes for all functions, so call order across files is free. The one rule: a moved function whose **signature** names `HostPairing`, `Theme`, `Usage`, `SessionInfo` or `ConfirmAction` will not compile, because those are declared after the generated prototypes are inserted. Every signature below takes only ints, longs, pointers and `uint16_t`.

---

### Task 1: Fix the Codex label lane

The Codex label loses text because its lane is derived from a bound that is not enforced. `CODEX_LANE_CHARS` comes from the right field being `CODEX_RIGHT_CHARS` (20) wide, but `padLeftTo` returns early when the string is already longer — `if (len >= width || width + 1 > bufSize) return;` — so it never truncates. Ordinary content is 22 characters and the header's own cache comment names a 25-character worst case.

**This moves BOTH boards and re-baselines both.** It is worse on board 1: at 25 characters its lane is **6**, and `"CODEX  7d"` needs 9.

**Files:**
- Modify: `firmware/deckhand_display/usage.ino` — `renderCodexRow()`, the right-field branches
- Modify: `firmware/deckhand_display/board_es3c35p.h` — `CODEX_LANE_CHARS` and its derivation comment
- Modify: `firmware/deckhand_display/board_e32r28t.h` — same
- Modify: `firmware/deckhand_display/usage-geom-check.mjs` — the lane assertion

**Interfaces:**
- Consumes: nothing.
- Produces: `CODEX_LANE_CHARS` = 17 (board 2) / 13 (board 1), each derived from the right field's real worst case. Task 9's Codex row relies on these.

- [ ] **Step 1: Write the failing assertion**

In `usage-geom-check.mjs`, inside the per-board section. It derives the lane from where the right field's clear box actually lands for its **worst-case content**, not from `CODEX_RIGHT_CHARS`:

```js
  // THE LANE IS BOUNDED BY ITS NEIGHBOUR'S CLEAR BOX, AND THAT BOX MOVES WITH
  // CONTENT. padLeftTo() only ever GROWS a short string - it returns early when
  // the string is already longer than the pad width - so CODEX_RIGHT_CHARS is a
  // floor on that field, never a ceiling, and a lane derived from it is wrong
  // whenever the content exceeds it. Derive from the real worst case instead.
  {
    const adv = c.TEXT_ADV;
    // The widest the right field can be. Both boards format it identically.
    const worst = "100%  23h 59m left".length;          // no wall-clock suffix
    const rightX = c.CARD_X + c.CARD_W - c.PAD - worst * adv;
    const lane = Math.floor((rightX - 1 - (c.CARD_X + c.PAD)) / adv);
    chk(c.CODEX_LANE_CHARS === lane,
        `CODEX_LANE_CHARS ${c.CODEX_LANE_CHARS} == ${lane}, derived from the right `
      + `field's worst case (${worst} chars) rather than from CODEX_RIGHT_CHARS`);
    // and the longest label the row can actually emit must fit in it
    const longest = "CODEX  7d".length;
    chk(longest <= lane,
        `the widest Codex label (${longest} chars) fits the ${lane}-char lane`);
  }
```

- [ ] **Step 2: Run it and watch BOTH assertions fail**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: FAIL on both boards. Board 2 reports `CODEX_LANE_CHARS 12 == 14`; board 1 reports `11 == 13`. **If they pass, the assertion is wrong** — it is still deriving from `CODEX_RIGHT_CHARS` somewhere.

- [ ] **Step 3: Drop the wall-clock suffix from the right field**

In `usage.ino`, `renderCodexRow()`. Replace the three-fact branch with the two-fact one, deleting the `showCxTag`-conditional clock entirely:

```cpp
  // THE WALL-CLOCK SUFFIX IS GONE, and the countdown beside it already says the
  // same thing in relative terms. That is not a cosmetic trim: this field's clear
  // box is what bounds the LABEL's lane, and padLeftTo() cannot cap it (it returns
  // early on an over-long string), so the field's own worst case IS the bound.
  // 25 chars -> 18 takes the lane from 6 to 13 on board 1 and 10 to 17 on board 2.
  if (!have) {
    snprintf(buf, sizeof(buf), "--");
  } else if (usage.cxResetInMin >= 0) {
    snprintf(buf, sizeof(buf), "%d%%  %s", usage.cxPct,
             formatResetIn(usage.cxResetInMin).c_str());
  } else {
    snprintf(buf, sizeof(buf), "%d%%", usage.cxPct);
  }
```

The `long nowSec = hostNowSec();` line above it becomes unused in this function — delete it, or the compiler warns.

- [ ] **Step 4: Re-derive `CODEX_LANE_CHARS` in both headers**

`board_es3c35p.h` — replace the value and the tail of its derivation comment:

```cpp
// Right field's WORST CASE is now 18 characters ("100%  23h 59m left") at
// Spleen8x16's 8px advance = 144px, right-aligned at CARD_X + CARD_W - PAD (290),
// so it spans 146..290 and drawIfChanged clears from 145. Label starts at 30:
//   (145 - 30) / 8 = 14.375 -> 14
// DERIVED FROM THE FIELD'S CONTENT, NOT FROM CODEX_RIGHT_CHARS. padLeftTo() only
// pads a SHORT string up; it returns early on a long one, so that constant is a
// floor and never a ceiling. Deriving from it is what put this at 12 while the
// ordinary content was already 22 characters (lane 10) and the worst case 25
// (lane 7) - at which point the right field's clear box ate the label's window
// text, the same defect this file documents for board 1's tag.
const int CODEX_LANE_CHARS  = 14;
```

`board_e32r28t.h` — the same derivation at Cozette's 6px advance and board 1's `CARD_W` 216 / `PAD` 14:

```cpp
// 18 chars x 6px = 108px, right-aligned at 214 -> spans 106..214, clears from
// 105; label at 26: (105 - 26) / 6 = 13.17 -> 13. Was 11, derived from
// CODEX_RIGHT_CHARS, which this field's content routinely exceeds - at its 25-char
// worst case board 1's lane was 6 against a 9-character label.
const int CODEX_LANE_CHARS  = 13;
```

- [ ] **Step 5: Run the assertion again**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: PASS, both boards. Board 2's lane is 14 and board 1's is 13.

Note the checker's number (14) is the **worst case**; the nominal case is 17 on board 2. Both exceed the 9-character label, which is what matters.

- [ ] **Step 6: Compile both boards and re-baseline, board 2 first**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: `CHANGED` on both — that is the point of this commit. Record both byte deltas, then:

```bash
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
```

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/usage.ino firmware/deckhand_display/board_es3c35p.h \
        firmware/deckhand_display/board_e32r28t.h firmware/deckhand_display/usage-geom-check.mjs \
        firmware/board-baseline.json
git commit -m "Fix the Codex label lane: derive it from content, not from a pad width

CODEX_LANE_CHARS was derived from CODEX_RIGHT_CHARS = 20, but padLeftTo()
returns early when the string is already longer and never truncates - so that
constant is a FLOOR on the right field and never a ceiling. The field's
ordinary content is 22 characters and the header's own cache comment names a
25-character worst case, which put the real lane at 10 and 7 on board 2 and at
6 on board 1, against a 9-character label. The right field's clear box then ate
the label's window text: the same defect this repo already documents for board
1's tag, arriving on the window.

Dropping the wall-clock suffix - the countdown beside it says the same thing in
relative terms - takes the right field's worst case from 25 characters to 18,
and the lane to 14 on board 2 and 13 on board 1. Derived in both headers from
the field's content, and asserted that way in usage-geom-check.mjs, so a future
change to either number fails rather than silently truncating.

BOTH BOARD BASELINES MOVE DELIBERATELY. This is a shared-code bug fix, not the
redesign - every commit after this one holds board 1 UNCHANGED."
```

---

### Task 2: Fix the stats field's alignment

`renderCard` pads its right-hand stats field with `padTo` (pad **right**) and draws it `TR_DATUM`, so the trailing spaces sit between the glyphs and the anchor: the text is inset by `(16 - len) * 8` px and its apparent position **moves with its content** — 40px for `"2h 14m left"`, 24px for `"starts on use"`. Every other `TR_DATUM` field on this tab uses `padLeftTo`.

**This moves BOTH boards and re-baselines both.**

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `renderCard()`
- Modify: `firmware/deckhand_display/usage-geom-check.mjs` — a source assertion

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks call. Board 2's `renderCard` is retired in Task 9; this fix exists for board 1's sake and for the shared code's correctness in between.

- [ ] **Step 1: Promote the source-parsing helpers into `geom-common.mjs`**

Tasks 2, 7, 8 and 9 all read the firmware's SOURCE, and the helpers for that do not
exist in a shared place yet — **verified against the tree:** `usage-geom-check.mjs`
imports only `{ consts, DIR, lineH, PANEL, preflight, textWidth }`, `fnBody` is a
local lambda inside one `chk` block of `sessions-geom-check.mjs:2102`, and
`splitArgs` does not exist at all. `evalInt` **is** already exported.

Follow the precedent `evalInt` set — CLAUDE.md records it as "now EXPORTED from
`geom-common.mjs` rather than copied". Add to `geom-common.mjs`:

```js
// Source-text helpers, shared because three checkers now read the firmware's own
// draw calls rather than only its constants. Same reason evalInt lives here: a
// second copy is a second thing to drift.
export function stripComments(file) {
  return fs.readFileSync(`${DIR}/${file}`, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
}
// The body of one function, from its signature to the first column-0 close brace.
// THROWS rather than returning "" - an assertion run over an empty string passes
// vacuously, which is the failure mode this whole family of checks exists to avoid.
export function fnBody(src, sig, where) {
  const a = src.indexOf(sig);
  if (a < 0) throw new Error(`fnBody: ${sig} not found in ${where}`);
  const z = src.indexOf("\n}\n", a);
  if (z < 0) throw new Error(`fnBody: no close brace after ${sig} in ${where}`);
  return src.slice(a, z);
}
// One call's arguments, split on top-level commas only, so a nested call or a
// parenthesised expression is not torn in half.
export function splitArgs(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
```

Then replace `sessions-geom-check.mjs`'s local lambda with the import, so there is
one copy rather than two, and widen `usage-geom-check.mjs`'s import line:

```js
import { consts, DIR, evalInt, fnBody, lineH, PANEL, preflight, splitArgs,
         stripComments, textWidth } from "./geom-common.mjs";
```

Run `node firmware/deckhand_display/sessions-geom-check.mjs` and confirm it still
passes with the shared `fnBody` — that is the check on the promotion itself.

- [ ] **Step 2: Write the failing assertion**

This one reads the SOURCE, because the defect is a wrong helper rather than a wrong number. Add to `usage-geom-check.mjs`, once (not per board):

```js
// ---- padding helper vs datum, read out of the source -----------------------
// padTo() pads on the RIGHT and padLeftTo() on the left, so a TR_DATUM field
// padded with padTo puts its spaces between the glyphs and the anchor and is
// inset by (width - len) * advance - i.e. it is not right-aligned at all, and
// its apparent position moves with its content. Asserted over the source rather
// than over a constant, since no constant is wrong here.
{
  const body = fnBody(stripComments("deckhand_display.ino"), "void renderCard(",
                      "deckhand_display.ino");
  // every drawIfChanged in renderCard that passes TR_DATUM, with the pad call
  // that immediately precedes it
  const calls = [...body.matchAll(/pad(Left)?To\([^;]*;\s*drawIfChanged\([^;]*TR_DATUM[^;]*;/g)];
  chk(calls.length >= 2,
      `renderCard has ${calls.length} padded TR_DATUM fields to check (expected >= 2)`);
  const wrong = calls.filter(m => !m[1]);        // matched padTo, not padLeftTo
  chk(wrong.length === 0,
      wrong.length ? `${wrong.length} TR_DATUM field(s) in renderCard are padded with `
                   + `padTo (pad RIGHT), so they are inset by the padding and float `
                   + `with their content: ${wrong[0][0].slice(0, 60).replace(/\s+/g, " ")}`
                   : `every padded TR_DATUM field in renderCard uses padLeftTo`);
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: FAIL — `1 TR_DATUM field(s) in renderCard are padded with padTo`.

- [ ] **Step 4: Make the field left-padded**

In `deckhand_display.ino`, `renderCard()`, the stats-right field:

```cpp
  // padLeftTo, not padTo: this field is TR_DATUM, so RIGHT padding would sit
  // between the glyphs and the anchor and inset the text by (16 - len) * advance -
  // 40px for "2h 14m left", 24px for "starts on use". It was not right-aligned at
  // all; it floated with its content. Every other TR_DATUM field on this tab
  // already left-pads, and padLeftTo's own comment says why.
  padLeftTo(buf, sizeof(buf), 16);
```

- [ ] **Step 5: Run it again**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: PASS.

- [ ] **Step 6: Compile both boards, board 2 first, and re-baseline**

Same four commands as Task 1 Step 6. Expected `CHANGED` on both; record the deltas; `--update 2` then `--update 1`.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/usage-geom-check.mjs \
        firmware/deckhand_display/geom-common.mjs firmware/deckhand_display/sessions-geom-check.mjs \
        firmware/board-baseline.json
git commit -m "The USAGE stats field was never right-aligned; it floated with its content

renderCard padded its right-hand stats field with padTo (pad RIGHT) and drew it
TR_DATUM, so the trailing spaces sat between the glyphs and the anchor and the
text was inset by (16 - len) * advance: 40px for \"2h 14m left\", 24px for
\"starts on use\". The field's apparent position therefore moved every time its
content changed length. Every other TR_DATUM field on this tab already uses
padLeftTo, whose own comment states the rule.

Asserted over the SOURCE rather than over a constant, because nothing numeric
was wrong - the wrong helper was. The assertion pairs each padded TR_DATUM
drawIfChanged in renderCard with the pad call before it and fails on padTo.

BOTH BOARD BASELINES MOVE DELIBERATELY. Second and last shared-code fix; every
commit after this holds board 1 UNCHANGED."
```

---

### Task 3: The flag, the constants, and the exact column

Board 2 gains `BOARD_USAGE_V2` and every new constant. Board 1 gains one line that emits no code. `usage-geom-check.mjs` loses `air > 0` — which passed at 8 and passes at 6 and can never catch the drift it exists for — and gains an exact sum.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/board_e32r28t.h`
- Modify: `firmware/deckhand_display/usage-geom-check.mjs`

**Interfaces:**
- Consumes: `CODEX_LANE_CHARS` from Task 1.
- Produces: every constant Tasks 5–9 read. Exact names and values are in the table below; later tasks refer to them by these names.

- [ ] **Step 1: Write the failing column assertion**

Replace the existing `air > 0` block (around `usage-geom-check.mjs:221-228`) with this. Note it asserts the DECLARED column sums exactly AND that the drawn positions match it term for term — a sum computed from the drawn positions alone is an **identity** that cannot fail, which is the trap the mock fell into first:

```js
  const contentBottom = H - c.FOOTER_H;
  const content = contentBottom - c.CONTENT_Y;
  console.log(`content area ${c.CONTENT_Y}..${contentBottom} = ${content}px`);

  // THE COLUMN SUMS EXACTLY, and the drawn positions match the declared terms.
  // `air > 0` was the old assertion and it could never fail usefully: it passed
  // when FOOTER_H moved 18 -> 20 and the real air went 8 -> 6, which is exactly
  // the drift it existed to catch. Deriving the sum FROM the drawn positions is
  // no better - top + heights + gaps + air is then an identity. So the terms are
  // declared here and both halves are checked against them.
  const col = b === 2
    ? [c.SP_2, c.NOW_CARD_H, c.SP_2, c.WEEK_CARD_H, c.SP_2, c.CODEX_H, c.SP_2]
    : [4, c.CARD_H, 4, c.CARD_H, 4, c.CODEX_H, 4];
  chk(col.reduce((a, x) => a + x, 0) === content,
      `column ${col.join(" + ")} = ${col.reduce((a, x) => a + x, 0)}, must be exactly ${content}`);

  const y1 = c.CONTENT_Y + col[0];
  const cards = b === 2
    ? [["NOW", y1, c.NOW_CARD_H], ["WEEK", y1 + c.NOW_CARD_H + c.SP_2, c.WEEK_CARD_H],
       ["CODEX", y1 + c.NOW_CARD_H + c.SP_2 + c.WEEK_CARD_H + c.SP_2, c.CODEX_H]]
    : [["5h", c.CARD1_Y, c.CARD_H], ["7d", c.CARD2_Y, c.CARD_H], ["CODEX", c.CODEX_Y, c.CODEX_H]];
  if (b === 2) {
    chk(cards[0][1] === c.CARD1_Y, `NOW_CARD_Y ${cards[0][1]} == CARD1_Y ${c.CARD1_Y}`);
    chk(cards[1][1] === c.CARD2_Y, `WEEK card at ${cards[1][1]} == CARD2_Y ${c.CARD2_Y}`);
    chk(cards[2][1] === c.CODEX_Y,  `CODEX row at ${cards[2][1]} == CODEX_Y ${c.CODEX_Y}`);
  }
  const colEnd = cards[2][1] + cards[2][2];
  const air = contentBottom - colEnd;
  chk(air === col[col.length - 1],
      `column ends at ${colEnd}, ${air}px of air, which must equal the declared ${col[col.length - 1]}`);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: FAIL — `NOW_CARD_H`, `WEEK_CARD_H` etc. come back `undefined` from `consts()`, so the sum is `NaN`. That is the failure mode to expect; it is also why `geom-common.mjs`'s line-oriented parser must never see a declaration split across two lines.

- [ ] **Step 3: Add the constants to `board_es3c35p.h`**

Insert after the existing `CODEX_H` declaration, replacing the stale column comment above it. **The old comment says `8 + 164 + 8 + 164 + 8 + 56 + 8 = 416` with 8px of air; `FOOTER_H` moved 18 → 20, so the truth is 414 with 6px.** Both the old and new columns are stated so the change is legible:

```cpp
// ---------- USAGE tab v2: NOW / WEEK / CODEX (board 2 only) ----------
// THE COLUMN. Content area = BOARD_H - TAB_BAR_H - FOOTER_H = 480 - 46 - 20 =
// 414. (This file previously derived 416 with 8px of air below the column; that
// was written when FOOTER_H was 18, and contentBottom() has been 460 since it
// became 20. The shipping v1 column really ended at 454 with SIX rows of air,
// and usage-geom-check.mjs asserted only `air > 0`, so it never said so.)
//
//   8 + 182 + 8 + 144 + 8 + 56 + 8 = 414
//
// Uniform 8px gaps (SP_2), and the column must not end flush on contentBottom() -
// board 1 shipped that once and its Codex row read as one block with the footer.
const int BOARD_USAGE_V2  = 1;      // see board.h; 0 on board 1, where it emits nothing
const int NOW_CARD_H      = 182;
const int WEEK_CARD_H     = 144;

// ---------- Inside the NOW card ----------
// Bands are CLEARED extents, not glyph ink. The 2px border owns +180..+181, so
// nothing may end past +179; the last clear ends +174, 5 rows clear.
//
//   +0..+1     border
//   +3..+5     pin bar          CARD_PIN_BAR_Y 3
//   +6..+21    label / icon     CARD_LABEL_Y 6, T_META 16px
//   +26..+90   hero box         NOW_HERO_Y 26, CARD_HERO_H 65, CARD_HERO_W 132
//   +39..+56   side fact 1      T_META, TR at LANE_X1 - the burn verdict
//   +61..+78   side fact 2      T_META, TR at LANE_X1 - the reset countdown
//   +95..+114  pace bar clear   NOW_BAR_Y 99, BAR_H 12
//   +119..+152 spark clear      NOW_SPARK_Y 120, NOW_SPARK_H 32
//   +157..+174 meta clear       NOW_META_Y 158
//   +180..+181 border
const int NOW_HERO_Y   = 26;
const int NOW_BAR_Y    = 99;
const int NOW_SPARK_Y  = 120;
const int NOW_SPARK_H  = 32;
const int NOW_META_Y   = 158;
// The two side facts, stacked and right-aligned beside the hero.
const int NOW_SIDE_Y    = 40;
const int NOW_SIDE_STEP = 22;

// THE HERO'S OWN CLEAR BOX, and it is the whole density win. drawBigNumber()
// clears the box it is HANDED, and v1 handed it the full CARD_W - 2*PAD = 260px
// lane while "100%" at Spleen32x64 inks only 4 * 32 = 128 - so 132px beside every
// hero was not merely unused, it was ERASED on every repaint. 132 is the glyph
// plus 4px of slack, the same plus-slack convention CARD_HERO_H (65 for a 64px
// glyph) already uses.
const int CARD_HERO_W = 132;
// LANE_X0 + CARD_HERO_W + 8 = 30 + 132 + 8 = 170, so the side lane is
// 170..290 = 120px = 15 characters at TEXT_ADV 8. DERIVED, never transcribed.
const int SIDE_X0     = CARD_X + PAD + CARD_HERO_W + SP_1 + SP_1;

// ---------- Inside the WEEK card ----------
// Secondary, so a T_HEAD (12x24) number rather than a 64px hero. That contrast IS
// the hierarchy. Border owns +142..+143; ceiling +141, last clear +138.
//
//   +0..+1     border
//   +3..+5     pin bar
//   +6..+21    label / icon
//   +25..+50   number clear     WEEK_NUM_Y 26, T_HEAD 24px
//   +29..+46   burn line        WEEK_BURN_Y 30, T_META, TR at LANE_X1
//   +54..+73   ALL bar clear    WEEK_BAR_Y 58
//   +77..+94   meta clear       WEEK_META_Y 78
//   +98..+115  Fable line       WEEK_FABLE_Y 99
//   +119..+138 Fable bar clear  WEEK_FABLE_BAR_Y 123
//   +142..+143 border
const int WEEK_NUM_Y       = 26;
const int WEEK_BURN_Y      = 30;
const int WEEK_BAR_Y       = 58;
const int WEEK_META_Y      = 78;
const int WEEK_FABLE_Y     = 99;
const int WEEK_FABLE_BAR_Y = 123;
```

Then update the existing `CARD1_Y` / `CARD2_Y` / `CODEX_Y` so board 2's column is the v2 one:

```cpp
const int CARD_H  = 164;                            // v1; board 1 only now
const int CARD1_Y = CONTENT_Y + SP_2;               // 54
const int CARD2_Y = CARD1_Y + NOW_CARD_H + SP_2;    // 244
const int CODEX_Y = CARD2_Y + WEEK_CARD_H + SP_2;   // 396
const int CODEX_H = 56;                             // ends at 452, 8px clear
```

- [ ] **Step 4: Add the flag to `board_e32r28t.h`**

One line, next to the other capability flags. It emits no code, which is why board 1's binary cannot move:

```cpp
// The USAGE tab's NOW / WEEK / CODEX layout is board 2 only: it needs a trend
// ring (~165 bytes of DRAM against board 1's ~26KB of free heap, which the audio
// path already competes for) and a 64px native hero this board does not have.
#define BOARD_USAGE_V2 0
```

- [ ] **Step 5: Run the assertion again**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: PASS. The board-2 line reads `column 8 + 182 + 8 + 144 + 8 + 56 + 8 = 414, must be exactly 414`.

- [ ] **Step 6: Verify both binaries are unmoved**

Unused `const int` declarations fold away and `#define BOARD_USAGE_V2 0` emits nothing, so **both** boards should be `UNCHANGED` at this commit — nothing reads the new constants yet.

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: `UNCHANGED` twice. **If board 2 reports CHANGED, stop and find out why** — an unused constant that moves a binary means something is reading it, or `CARD1_Y`/`CARD2_Y`/`CODEX_Y` changed values while v1 code is still drawing from them. That last one is expected to move board 2 once Step 3's `CARD2_Y` edit lands; if so, record the delta and `--update 2`, and note in the commit that board 2 moved because its column moved while `renderCard` still draws it. Board 1 must be `UNCHANGED` regardless.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/board_e32r28t.h \
        firmware/deckhand_display/usage-geom-check.mjs firmware/board-baseline.json
git commit -m "USAGE v2: the flag, the constants, and a column assertion that can fail

BOARD_USAGE_V2 is 1 on board 2 and 0 on board 1, where it is one line that emits
no code. Every band of the NOW and WEEK cards is declared with its cleared
extent, not its glyph ink.

Two corrections come with it:

- The header derived the column as 8+164+8+164+8+56+8 = 416 with 8px of air.
  FOOTER_H moved 18 -> 20, so contentBottom() has been 460 and the shipping v1
  column really ended at 454 with SIX rows of air. Comment only.

- usage-geom-check.mjs asserted air > 0, which passed at 8, passes at 6 and
  would pass at 1 - it could never report the drift it existed for. It now
  asserts the DECLARED column sums to exactly the content area AND that the
  drawn card positions match those terms one for one. Deriving the sum from the
  drawn positions instead would be an identity that cannot fail; that shape was
  tried in the mock and proven blind by injection.

CARD_HERO_W (132) is new and load-bearing: drawBigNumber clears the box it is
handed, v1 hands it the whole 260px lane, and \"100%\" inks 128 - so 132px beside
every hero was erased on every repaint rather than merely unused.

Board 1: UNCHANGED."
```

---

### Task 4: Commit the mock as the normative geometric spec

Every number in Task 3 came out of a mock that currently exists only as a published artifact. Commit it, bound to the header, for the reason `docs/design/settings-redesign/README.md` already gives: it is the only place the redesign's numbers exist in a form anyone can re-run.

**Files:**
- Create: `docs/design/usage-redesign/README.md`
- Create: `docs/design/usage-redesign/usage.html`
- Create: `docs/design/usage-redesign/usage.js`
- Create: `docs/design/usage-redesign/spleenfonts.js`
- Create: `docs/design/usage-redesign/check.mjs`

**Interfaces:**
- Consumes: every constant from Task 3, by the header's own name.
- Produces: `node docs/design/usage-redesign/check.mjs`, a headless gate later tasks re-run.

- [ ] **Step 1: Split the artifact into the repo's three-file shape**

The published artifact is one self-contained HTML. `docs/design/settings-redesign/` is `settings.html` + `settings.js` + `spleenfonts.js` + `check.mjs`, and `check.mjs` runs the mock with a stubbed `document` and no canvas. So the painter must build an **op list** rather than drawing straight to a context.

Change `class P` so `_f()` pushes instead of painting, and add a replay used only by the browser:

```js
  _f(x,y,w,h,col){ if(w<=0||h<=0) return; this.ops.push(["r",x,y,w,h,col]); }
  // The browser replays; check.mjs never does, which is what lets it run with no
  // canvas at all - the same seam settings.js already has.
  paint(ctx){ for(const o of this.ops){ if(o[0]==="r"){ ctx.fillStyle=o[5]; ctx.fillRect(o[1],o[2],o[3],o[4]); } } }
```

`spleenfonts.js` is the extracted font payload. It must carry Spleen32x64's digits, `%`, `-` and space in addition to the full 8x16 and 12x24 sets — the settings mock's copy has only the first two faces.

- [ ] **Step 2: Write `check.mjs`, binding K to the header**

Follow `docs/design/settings-redesign/check.mjs` exactly: stub `document`, `new Function()` the two source files, then bind every entry of `K` to `consts("board_es3c35p.h")` by name. Add the four picture assertions:

```js
// The mock's own claims, re-run headlessly. These are the SAME assertions the
// in-browser checker makes; they live here too so the gate does not need a
// browser, and so a header change that the mock does not follow fails by name.
for (const [id, layout] of Object.entries(LAYOUTS)) {
  const p = new P("DARK");
  chrome(p, STATES.nominal); layout.draw(p, STATES.nominal);
  // 1. every string inside Spleen's 0x20..0x7E
  // 2. the declared column sums to K.CONTENT_ROWS and the drawn terms match
  // 3. no clear box erases another field's ink, per glyph, undirected
  // 4. nothing crosses the tab bar or the footer divider
}
```

- [ ] **Step 3: Run it and watch it pass, then prove it has teeth**

```bash
node docs/design/usage-redesign/check.mjs
```

Expected: PASS, printing its own assertion count. Then perturb one header constant and confirm the mock's binding catches it:

```bash
sed -i '' 's/^const int WEEK_NUM_Y       = 26;/const int WEEK_NUM_Y       = 27;/' firmware/deckhand_display/board_es3c35p.h
node docs/design/usage-redesign/check.mjs   # must FAIL, naming WEEK_NUM_Y and both numbers
git checkout firmware/deckhand_display/board_es3c35p.h
```

**If it passes with the constant perturbed, `K` is not bound** and the whole file is a picture nobody compares to anything.

- [ ] **Step 4: Write the README**

State what it is, what makes it trustworthy, and what it does not prove. Three properties to record, all of them measured rather than asserted: the fonts were extracted from the firmware's own headers and verified **190/190 identical** against the copy already committed under `settings-redesign/` (for 8x16 and 12x24 — no known-good copy of 32x64 exists, so that face rests on the same reader having been proven on the other two); every constant in `K` is bound to `board_es3c35p.h`; and it checks itself. What it does not prove: nothing has been on the glass, and board 2's `SCREENSHOT` reads the shadow framebuffer, so no claim here covers colour.

- [ ] **Step 5: Commit**

```bash
git add docs/design/usage-redesign/
git commit -m "Commit the USAGE v2 mock as the normative geometric spec

Every number in board_es3c35p.h's v2 section came out of this, and until now it
existed only as a published artifact. Same argument as the settings mock: it is
the only place the redesign's numbers exist in a form anyone can re-run.

Three properties make it worth trusting. The type is the real thing - the
glyphs are extracted from Spleen8x16.h, Spleen12x24.h and Spleen32x64.h, and
the 8x16 and 12x24 halves were verified 190/190 identical against the copy
already committed under settings-redesign/ (no known-good copy of 32x64 exists,
so that face rests on the same reader having been proven on the other two). The
geometry is PARSED - K is bound name-for-name to the header through the geometry
checkers' own consts(), so a header change the mock does not follow fails here
by name with both numbers printed. And it checks itself: node check.mjs asserts
the column sums exactly, that no clear box erases another field's ink per glyph,
that nothing leaves the panel, and that every string is inside 0x20..0x7E.

What it does not prove: nothing here has been on the glass, and board 2's
SCREENSHOT reads the shadow framebuffer anyway - this is arithmetic and bitmaps,
the right instrument for layout and the wrong one for colour."
```

---

### Task 5: The trend ring

One ring, 31 slots at the OAuth poll cadence, modelled on `battTrend*` in `power.ino`. It samples the 5-hour percentage only; the week needs no history.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` — the ring's constants
- Modify: `firmware/deckhand_display/usage.ino` — the ring itself
- Modify: `firmware/deckhand_display/deckhand_display.ino` — one call in `loop()`
- Create: `firmware/deckhand_display/usage-trend-check.py`

**Interfaces:**
- Consumes: `usage.fiveHourPct`, `usage.quotaAgeSec` (existing globals).
- Produces, all inside `#if BOARD_USAGE_V2`:
  - `void usageRingReset()`
  - `void usageRingSample()` — call from `loop()`
  - `bool usageRingSlope(float* slopeOut, int* riseOut, long* spanMinOut)` — false when it cannot speak
  - `uint32_t usageRingHash()` — the sparkline's content key
  - `int usageRingCount`, `int usageRingHead`, `uint8_t usageRingPct[USAGE_RING_SLOTS]`

- [ ] **Step 1: Write the failing checker**

Create `firmware/deckhand_display/usage-trend-check.py`. It **parses its thresholds out of `usage.ino` and `board_es3c35p.h`** rather than transcribing them — the same rule (and the same reason) as `batt-trend-check.py`, which fails loudly when its mirror drifts from the firmware:

```python
#!/usr/bin/env python3
"""Exercise the USAGE trend ring's and burn estimators' arithmetic without a device.

Thresholds are PARSED out of the firmware, never transcribed: a mirror that
drifts from the source must fail loudly rather than pass while the device is
wrong. Same convention as batt-trend-check.py, which this follows.
"""
import re, sys, pathlib

D = pathlib.Path(__file__).parent
HDR = (D / "board_es3c35p.h").read_text()
INO = (D / "usage.ino").read_text()

def const(name, src=HDR):
    m = re.search(r"const\s+(?:int|long|unsigned long|float)\s+" + name + r"\s*=\s*([^;]+);", src)
    if not m:
        sys.exit(f"FAIL: could not parse {name} out of the firmware - "
                 f"the checker's parse is broken, or the constant was renamed")
    return m.group(1).strip()

def const_int(name, src=HDR):
    v = const(name, src)
    m = re.fullmatch(r"-?\d+", v)
    if not m:
        sys.exit(f"FAIL: {name} is `{v}`, which this checker cannot evaluate as an int")
    return int(v)

SLOTS    = const_int("USAGE_RING_SLOTS")
STEP_MIN = const_int("USAGE_RING_STEP_MIN")
DROP     = const_int("USAGE_RING_DROP_PCT")
SPAN     = (SLOTS - 1) * STEP_MIN

n = fails = 0
def chk(cond, msg):
    global n, fails
    n += 1
    if not cond:
        fails += 1
        print("  FAIL " + msg)

# ---- the span is exactly 150 min, and the caption depends on it -------------
# 30 slots span 145, and a card captioned LAST 2.5H over a 145-minute ring
# overstates it by five minutes. 31 slots span exactly 150.
chk(SPAN == 150, f"ring span (SLOTS-1)*STEP_MIN = {SPAN} min, must be exactly 150")
chk("LAST 2.5H" in INO, "the spark's caption says LAST 2.5H, matching the 150-min span")

# ---- the ring must be able to measure the window it is used for ------------
for name, win, want in [("5h session", 300, True), ("7d week", 10080, False)]:
    rise = 100.0 * SPAN / win
    chk((rise >= DROP) == want,
        f"{name}: {rise:.2f} points of movement across the ring, "
        f"{'usable' if want else 'INSIDE the integer-percent rounding'}")

# ---- the drop threshold is derived, not picked ------------------------------
# Two Macs' readings differ only in AGE, bounded by one poll interval, and in one
# interval the SHORTEST window moves 100*STEP/300 points. So a drop that small is
# explicable by a mergeUsage source switch and must NOT reset the ring; anything
# larger is a window turnover.
switch_max = 100.0 * STEP_MIN / 300
chk(DROP > switch_max,
    f"USAGE_RING_DROP_PCT {DROP} > {switch_max:.2f}, the most a source-Mac switch "
    f"can move the shortest window in one poll interval")

print(f"{n - fails}/{n} assertions pass" if not fails else f"{fails} of {n} FAILED")
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Run it and watch it fail**

```bash
python3 firmware/deckhand_display/usage-trend-check.py
```

Expected: exits 1 at `could not parse USAGE_RING_SLOTS` — the constants do not exist yet. That is the failure to expect.

- [ ] **Step 3: Add the ring's constants to `board_es3c35p.h`**

```cpp
// ---------- USAGE trend ring (board 2 only) ----------
// 31 SLOTS, NOT 30, AND THE REASON IS THE CAPTION. The span is (n-1)*step, so 30
// slots span 145 minutes - and a card captioned LAST 2.5H over a 145-minute ring
// overstates it by five. 31 spans exactly 150.
const int USAGE_RING_SLOTS = 31;
// THE OAUTH POLL CADENCE, NOT ONCE A MINUTE, and this is what makes the sparkline
// worth drawing. The quota only MOVES every OAUTH_POLL_INTERVAL_MS (5 min, in
// host/index.mjs), so a 1-per-minute ring holds five identical samples then a
// step - about six distinct values in half an hour. At the poll cadence the same
// 31 slots span 150 minutes.
const int USAGE_RING_STEP_MIN = 5;
const unsigned long USAGE_RING_STEP_MS = (unsigned long) USAGE_RING_STEP_MIN * 60000UL;
// A DROP this large means the window turned over, and a slope taken across that
// discontinuity is meaningless. DERIVED rather than picked: mergeUsage() can swap
// the source Mac at any tick, the two Macs' readings differ only in AGE, that
// difference is bounded by one poll interval, and in one interval the shortest
// window this ring serves moves 100 * 5 / 300 = 1.67 points. So a 1- or 2-point
// fall is explicable by a source switch and must NOT clear the ring; 3 is not.
const int USAGE_RING_DROP_PCT = 3;
// The staleness threshold this ring and the burn gate key off. Board 2 only, so
// board 1's own inline 900s in renderUsageTab is deliberately left alone rather
// than replaced - naming it there would risk that board's binary for nothing.
const int QUOTA_STALE_SEC = 900;
```

- [ ] **Step 4: Run the checker again**

```bash
python3 firmware/deckhand_display/usage-trend-check.py
```

Expected: the parse assertions pass; the `LAST 2.5H` assertion still FAILS, because nothing draws the spark yet. That is correct — it is Task 7's.

Comment that one assertion out with a `# Task 7` marker, or leave it failing and let Task 7 turn it green. **Leaving it failing is preferred** — a red assertion naming the work still to do is better than a commented-out one nobody re-enables.

- [ ] **Step 5: Implement the ring in `usage.ino`**

Place it above `renderCodexRow`. The three reset conditions are the spec's, and the staleness one is an **edge**:

```cpp
#if BOARD_USAGE_V2
// ---------- The USAGE trend ring ----------
// Modelled on battTrend* in power.ino: a fixed ring of one-per-interval samples,
// least-squares fitted, refusing to speak until it has earned a number. ONE ring
// serves both the sparkline and the burn rate, which is what makes it worth its
// DRAM - and it samples the 5-hour percentage only, because the week's burn uses
// no history at all (see usageBurnMinutes).
uint8_t       usageRingPct[USAGE_RING_SLOTS];
unsigned long usageRingAt[USAGE_RING_SLOTS];
int           usageRingCount = 0;
int           usageRingHead  = 0;
unsigned long usageRingLast  = 0;
bool          usageRingWasStale = false;

void usageRingReset() {
  usageRingCount = 0;
  usageRingHead  = 0;
  usageRingLast  = 0;
}

void usageRingSample() {
  bool stale = usage.quotaAgeSec > QUOTA_STALE_SEC;
  // A staleness EDGE clears, never the level. The clock keeps running while the
  // number does not, so samples either side of the gap are not one series - but
  // testing the level would clear the ring on every one of the 5s ticks it spends
  // stale, which is the ring it is trying to fill.
  if (stale != usageRingWasStale) {
    usageRingWasStale = stale;
    if (stale) usageRingReset();
  }
  if (stale || usage.fiveHourPct < 0) return;

  unsigned long now = millis();
  if (usageRingLast != 0 && now - usageRingLast < USAGE_RING_STEP_MS) return;

  // A DROP means the window turned over. Note this deliberately does NOT reset on
  // a mergeUsage source-Mac switch: both Macs poll the same account, so their
  // readings are the same measurement at different ages, and clearing 2.5 hours
  // of history because a link aged out would throw away good data. The threshold
  // is what separates the two - see USAGE_RING_DROP_PCT's derivation.
  if (usageRingCount > 0) {
    int prev = (int) usageRingPct[(usageRingHead + USAGE_RING_SLOTS - 1) % USAGE_RING_SLOTS];
    if (usage.fiveHourPct <= prev - USAGE_RING_DROP_PCT) usageRingReset();
  }

  usageRingLast = now;
  usageRingPct[usageRingHead] = (uint8_t) usage.fiveHourPct;
  usageRingAt[usageRingHead]  = now;
  usageRingHead = (usageRingHead + 1) % USAGE_RING_SLOTS;
  if (usageRingCount < USAGE_RING_SLOTS) usageRingCount++;
}

// Least squares over the whole ring, never endpoint-to-endpoint - the same reason
// battMinutesLeft gives: one sample taken at an odd moment sits well off the
// trend, and two endpoints give it full weight. x comes from the stored
// timestamps rather than the slot index, because a missed poll leaves a real gap.
bool usageRingSlope(float* slopeOut, int* riseOut, long* spanMinOut) {
  if (usageRingCount < 2) return false;
  int oldest = (usageRingHead + USAGE_RING_SLOTS - usageRingCount) % USAGE_RING_SLOTS;
  int newest = (usageRingHead + USAGE_RING_SLOTS - 1) % USAGE_RING_SLOTS;
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (int i = 0; i < usageRingCount; i++) {
    int idx = (oldest + i) % USAGE_RING_SLOTS;
    double x = (double) ((usageRingAt[idx] - usageRingAt[oldest]) / 60000UL);
    double y = (double) usageRingPct[idx];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  double den = (double) usageRingCount * sxx - sx * sx;
  if (den == 0) return false;
  *slopeOut   = (float) (((double) usageRingCount * sxy - sx * sy) / den);
  *riseOut    = (int) usageRingPct[newest] - (int) usageRingPct[oldest];
  *spanMinOut = (long) ((usageRingAt[newest] - usageRingAt[oldest]) / 60000UL);
  return true;
}

// FNV-1a 32-bit over the samples, for the sparkline's change-only cache. It is
// compared against the ONE previous value and never against a population, so a
// missed repaint needs a collision with that single value - 2^-32 per event, not
// a birthday problem. Same hash and same argument buildDetailSignature already
// uses for optDescs.
uint32_t usageRingHash() {
  uint32_t h = 2166136261UL;
  h = (h ^ (uint32_t) usageRingCount) * 16777619UL;
  for (int i = 0; i < usageRingCount; i++) {
    int idx = (usageRingHead + USAGE_RING_SLOTS - usageRingCount + i) % USAGE_RING_SLOTS;
    h = (h ^ usageRingPct[idx]) * 16777619UL;
  }
  return h;
}
#endif  // BOARD_USAGE_V2
```

- [ ] **Step 6: Call it from `loop()`**

In `deckhand_display.ino`, beside the other periodic samplers:

```cpp
#if BOARD_USAGE_V2
  usageRingSample();     // self-rate-limits to USAGE_RING_STEP_MS
#endif
```

- [ ] **Step 7: Compile board 2, then board 1**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: board 2 `CHANGED` (record the flash and RAM deltas — the ring's DRAM should be about 165 bytes), then `--update 2`. Board 1 **`UNCHANGED`**. If board 1 moved, the `#if` scoping is wrong or the `loop()` call is not guarded.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/usage.ino firmware/deckhand_display/deckhand_display.ino \
        firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage-trend-check.py \
        firmware/board-baseline.json
git commit -m "USAGE v2: the trend ring, sampled at the OAuth poll cadence

31 slots modelled on battTrend* in power.ino. ONE ring serves both the sparkline
and the burn rate, which is what makes it worth its DRAM.

It samples at the OAuth POLL cadence rather than once a minute, and that is the
whole reason the sparkline is worth drawing: the quota only MOVES every 5 min,
so a 1/min ring holds five identical samples then a step - about six distinct
values in half an hour. At the poll cadence the same slots span 150 minutes.

31 slots and not 30 because the span is (n-1)*step: 30 spans 145 minutes, and a
card captioned LAST 2.5H over a 145-minute ring overstates it by five.

It resets on a percentage DROP and on a staleness EDGE, and on nothing else. A
drop means the window turned over. An edge - not the level - because testing the
level would clear the ring on every 5s tick it spends stale. A mergeUsage
source-Mac switch deliberately does NOT reset: both Macs poll the same account,
so their readings are one measurement at two ages, and clearing 2.5h of history
because a link aged out would throw away good data. USAGE_RING_DROP_PCT (3) is
what separates the two cases, derived from the most a one-poll-interval age
difference can move the shortest window (1.67 points).

usage-trend-check.py PARSES its thresholds out of the firmware rather than
transcribing them, the same rule and reason as batt-trend-check.py. Its
LAST 2.5H assertion is deliberately left FAILING until the spark lands in the
card task - a red assertion naming outstanding work beats a commented-out one.

Board 1: UNCHANGED."
```

---

### Task 6: The two burn estimators

Which estimator can answer the question is decided by arithmetic. The ring gives 50.00 points of movement across a 5-hour window and 1.49 across a 7-day one — and the percentage is an integer, so the week's movement is inside the rounding.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` — the gate constants
- Modify: `firmware/deckhand_display/usage.ino` — the estimators
- Modify: `firmware/deckhand_display/usage-trend-check.py` — their assertions

**Interfaces:**
- Consumes: `usageRingSlope()` from Task 5.
- Produces:
  - `long usageBurnMinutes(int pct, long resetMin, long windowMin, bool stale)` — minutes to empty, or `BURN_NOT_YET` (-1) / `BURN_EMPTY_NOW` (-2)
  - `void usageBurnLabel(char* out, size_t n, long mins, long resetMin)` — fills a `char[BURN_LABEL_BYTES]`
  - `bool usageBurnUrgent(long mins, long resetMin)` — true when the cap is hit before the window resets, which is what colours the line

- [ ] **Step 1: Write the failing assertions**

Append to `usage-trend-check.py`:

```python
# ---- ONE error budget derives every term of the gate -----------------------
BUDGET   = const_int("BURN_ERR_BUDGET_PCT")
MIN_PCT  = const_int("BURN_MIN_PCT")
MAX_PCT  = const_int("BURN_MAX_PCT")
MIN_ELAP = const_int("BURN_MIN_ELAPSED")
RING_MAX = const_int("BURN_RING_MAX_WIN")
RING_RISE = const_int("BURN_RING_MIN_RISE")

# T = elapsed*(100-pct)/pct, so half a point of quantization costs a RELATIVE
# error of 50/(pct*(100-pct)) - independent of elapsed. The budget picks the range.
inside = [p for p in range(1, 100) if 50.0 / (p * (100 - p)) * 100 <= BUDGET]
chk(MIN_PCT == inside[0],
    f"BURN_MIN_PCT {MIN_PCT} == {inside[0]}, the smallest integer pct whose "
    f"quantization error is inside the {BUDGET}% budget")
chk(MAX_PCT == inside[-1],
    f"BURN_MAX_PCT {MAX_PCT} == {inside[-1]}, the largest")
chk(50.0 / ((MIN_PCT - 1) * (100 - MIN_PCT + 1)) * 100 > BUDGET,
    f"pct {MIN_PCT - 1} is OUTSIDE the budget, so the floor is not one point too low")

# The elapsed floor is one poll interval: below that the percentage the device
# holds may have been read BEFORE the window boundary.
chk(MIN_ELAP == STEP_MIN,
    f"BURN_MIN_ELAPSED {MIN_ELAP} == one poll interval ({STEP_MIN} min)")
# ... and it provably never binds, because the average only runs above RING_MAX
chk(MIN_PCT / 100.0 * RING_MAX > MIN_ELAP,
    f"the percent floor always fires first: reaching {MIN_PCT}% at the smallest "
    f"window the average serves ({RING_MAX} min) takes "
    f"{MIN_PCT / 100.0 * RING_MAX:.1f} min > {MIN_ELAP}")

# The crossover: the ring is usable only while its movement clears the rounding.
chk(RING_MAX <= 100 * SPAN / RING_RISE,
    f"BURN_RING_MAX_WIN {RING_MAX} <= {100 * SPAN / RING_RISE:.0f} min, the window "
    f"at which ring movement falls to BURN_RING_MIN_RISE")
chk(300 <= RING_MAX < 10080,
    "the 5-hour window uses the ring and the 7-day window uses the average")

# ---- notation: an estimate takes ~, never >= -------------------------------
# ">=" is reserved for the charge estimator's deliberate floor; the two make
# different promises, and a reader who cannot tell them apart has been told the
# cap will be reached later than it will.
label = INO[INO.index("void usageBurnLabel"):]
label = label[:label.index("\n}")]
chk("~" in label, "usageBurnLabel writes ~ for an estimate")
chk(">=" not in label, "usageBurnLabel never writes >=, which is the charge floor's notation")
chk("empty now" in label and "resets first" in label and "burn --" in label,
    "all three refusal/verdict strings are present")
import re as _re
for lit in _re.findall(r'"([^"]*)"', label):
    chk(all(0x20 <= ord(ch) <= 0x7E for ch in lit),
        f"every character of {lit!r} is inside Spleen's 0x20..0x7E")

# ---- the label fits the lane it is drawn in --------------------------------
SIDE_CHARS = 15   # (LANE_X1 - SIDE_X0) / TEXT_ADV, asserted in usage-geom-check.mjs
worst = "empty ~99d 23h"
chk(len(worst) <= SIDE_CHARS,
    f"the widest burn label ({worst!r}, {len(worst)}) fits the {SIDE_CHARS}-char side lane")
chk(const_int("BURN_LABEL_BYTES") > len(worst),
    "BURN_LABEL_BYTES has room for the widest label plus its NUL")
```

- [ ] **Step 2: Run it and watch it fail**

```bash
python3 firmware/deckhand_display/usage-trend-check.py
```

Expected: exits 1 at `could not parse BURN_ERR_BUDGET_PCT`.

- [ ] **Step 3: Add the gate constants**

To `board_es3c35p.h`:

```cpp
// ---------- The burn gate: ONE budget, every term derived from it ----------
// T = elapsed * (100 - pct) / pct, so half a point of quantization on an integer
// percentage costs a RELATIVE error of 50 / (pct * (100 - pct)) - independent of
// elapsed. This budget is what picks the admissible range.
const int BURN_ERR_BUDGET_PCT = 20;
// The smallest and largest integer pct inside that budget: 3 costs 17.2% and 2
// costs 25.5%. Above BURN_MAX_PCT the answer is "empty now" rather than a number.
const int BURN_MIN_PCT = 3;
const int BURN_MAX_PCT = 97;
// ONE OAUTH POLL INTERVAL, and it is a data-VALIDITY bound rather than a taste
// call: below one interval the percentage the device holds may have been read
// before the window boundary, so it can belong to the previous window.
// Quantization on elapsed itself (resetInMin is integer minutes) asks only for
// 0.5 / e <= 20%, i.e. 2.5 min, so the poll interval is the binding half.
//
// IT PROVABLY NEVER FIRES, and saying so is better than leaving it open to the
// charge of being a magic number: the average estimator only runs above
// BURN_RING_MAX_WIN, where reaching BURN_MIN_PCT already takes 0.03 * 2880 = 86
// min - and 302 min on the real 7-day window, so the week's burn appears about 5
// hours after a reset, gated by the percent floor every time.
const int BURN_MIN_ELAPSED = USAGE_RING_STEP_MIN;
// The ring must have run this long and moved this far before it speaks.
const int BURN_RING_MIN_SPAN = 30;
const int BURN_RING_MIN_RISE = 3;
// ABOVE THIS THE RING IS BLIND AND THE AVERAGE TAKES OVER. Movement across the
// ring is 100 * span / window, so it falls to BURN_RING_MIN_RISE at
// 100 * 150 / 3 = 5000 min = 3.47 days; 2880 (2 days) sits inside that with
// margin. Measured: the 5-hour window moves 50.00 points across the ring and the
// 7-day window 1.49 - and the percentage is an INTEGER, so the week's movement is
// inside the rounding. The average is accurate there precisely because elapsed is
// huge (0.8% at 61% with 2400 min elapsed).
const int BURN_RING_MAX_WIN = 2880;
// "empty ~99d 23h" is 14 characters; 16 leaves room for it and its NUL. A buffer
// exactly as long as its string is this repo's oldest silent bug.
const int BURN_LABEL_BYTES = 16;
```

- [ ] **Step 4: Implement the estimators in `usage.ino`**

Inside the same `#if BOARD_USAGE_V2` block, after `usageRingHash()`:

```cpp
// Negative returns are NAMED, the same convention the charge estimator's
// BATT_CHG_NOT_YET / BATT_CHG_TOPPING use: a bare -1 at a call site says nothing
// about which of two very different refusals happened.
const long BURN_NOT_YET   = -1;   // cannot state a number yet - keep watching
const long BURN_EMPTY_NOW = -2;   // the cap is already reached

long usageBurnMinutes(int pct, long resetMin, long windowMin, bool stale) {
  // A STALE READING DRIVES NO ESTIMATE. The clock has kept running while the
  // number has not, so any slope through it measures the gap rather than the burn.
  if (stale || pct < 0 || resetMin < 0 || windowMin <= 0) return BURN_NOT_YET;
  if (pct > BURN_MAX_PCT) return BURN_EMPTY_NOW;
  if (pct < BURN_MIN_PCT) return BURN_NOT_YET;

  if (windowMin <= BURN_RING_MAX_WIN) {
    // SHORT WINDOW: the ring slope. It sees a burst in the last ten minutes,
    // which an average over the whole window cannot.
    float slope; int rise; long span;
    if (!usageRingSlope(&slope, &rise, &span)) return BURN_NOT_YET;
    if (span < BURN_RING_MIN_SPAN || rise < BURN_RING_MIN_RISE || slope <= 0.0f)
      return BURN_NOT_YET;
    long left = (long) (((float) (100 - pct)) / slope + 0.5f);
    return left < 1 ? BURN_EMPTY_NOW : left;
  }

  // LONG WINDOW: the average. The ring is blind here - a 7-day window moves 1.49
  // points across a 150-minute span, inside the integer-percent rounding.
  long elapsed = windowMin - resetMin;
  if (elapsed < BURN_MIN_ELAPSED) return BURN_NOT_YET;
  long left = (long) ((((double) (100 - pct)) * (double) elapsed) / (double) pct + 0.5);
  return left < 1 ? BURN_EMPTY_NOW : left;
}

// True when the cap is reached BEFORE the window resets - which is the only case
// worth colouring, because it is the only one that costs the user anything.
bool usageBurnUrgent(long mins, long resetMin) {
  return mins > 0 && resetMin >= 0 && mins < resetMin;
}

void usageBurnLabel(char* out, size_t n, long mins, long resetMin) {
  if (mins == BURN_EMPTY_NOW) { snprintf(out, n, "empty now"); return; }
  if (mins < 0)               { snprintf(out, n, "burn --");   return; }
  if (!usageBurnUrgent(mins, resetMin)) { snprintf(out, n, "resets first"); return; }
  // "~" MEANS ABOUT. Never ">=", which is reserved for the charge estimator's
  // deliberate floor - the two notations make different promises, and a reader
  // who cannot tell them apart has been told the cap arrives later than it will.
  if (mins >= 1440)     snprintf(out, n, "empty ~%ldd %ldh", mins / 1440, (mins / 60) % 24);
  else if (mins >= 60)  snprintf(out, n, "empty ~%ldh %ldm", mins / 60, mins % 60);
  else                  snprintf(out, n, "empty ~%ldm", mins);
}
```

- [ ] **Step 5: Run the checker again**

```bash
python3 firmware/deckhand_display/usage-trend-check.py
```

Expected: every burn assertion passes. The `LAST 2.5H` assertion from Task 5 is still red.

- [ ] **Step 6: Prove the derived floors have teeth**

```bash
sed -i '' 's/^const int BURN_MIN_PCT = 3;/const int BURN_MIN_PCT = 2;/' firmware/deckhand_display/board_es3c35p.h
python3 firmware/deckhand_display/usage-trend-check.py   # must FAIL naming BURN_MIN_PCT
sed -i '' 's/^const int BURN_RING_MAX_WIN = 2880;/const int BURN_RING_MAX_WIN = 6000;/' firmware/deckhand_display/board_es3c35p.h
python3 firmware/deckhand_display/usage-trend-check.py   # must FAIL naming the crossover
git checkout firmware/deckhand_display/board_es3c35p.h
```

- [ ] **Step 7: Compile board 2, then board 1; commit**

Board 2 `CHANGED` (record deltas, `--update 2`); board 1 **`UNCHANGED`**.

```bash
git add firmware/deckhand_display/usage.ino firmware/deckhand_display/board_es3c35p.h \
        firmware/deckhand_display/usage-trend-check.py firmware/board-baseline.json
git commit -m "USAGE v2: two burn estimators, chosen by window length

Which estimator can answer the question is decided by arithmetic. Movement
across the ring is 100 * span / window: 50.00 points for the 5-hour window and
1.49 for the 7-day one - and the percentage is an INTEGER, so the week's
movement is inside the rounding. The ring cannot measure it.

So the short window uses the ring SLOPE, which sees a burst in the last ten
minutes that an average over the whole window cannot; and the long window uses
pct/elapsed, which is accurate there precisely because elapsed is huge (0.8% at
61% with 2400 min elapsed). The crossover is 3.47 days; BURN_RING_MAX_WIN sits
at 2 for margin.

ONE constant, BURN_ERR_BUDGET_PCT = 20, derives every term of the gate. Half a
point of quantization costs 50/(pct*(100-pct)) relative error, independent of
elapsed, so the budget admits pct 3..97 and refuses below 3. BURN_MIN_ELAPSED is
one OAuth poll interval on a data-validity argument - below that the percentage
the device holds may have been read before the window boundary - and it provably
never fires, because the average only runs above a 2-day window where reaching
3% already takes 86 minutes. No judgement constant remains in the gate.

A stale reading drives no estimate: the clock has kept running while the number
has not, so a slope through it measures the gap.

Negative returns are NAMED (BURN_NOT_YET, BURN_EMPTY_NOW), the convention the
charge estimator already uses - a bare -1 says nothing about which of two very
different refusals happened. And the label writes \"~\" and never \">=\", which is
reserved for the charge floor; the two make different promises.

Board 1: UNCHANGED."
```

---

### Task 7: `renderNowCard`

The 5-hour card: 64px hero in a 132px box, two fact lines in the 132px that used to be erased beside it, pace bar, sparkline, meta row.

**Files:**
- Modify: `firmware/deckhand_display/usage.ino`
- Modify: `firmware/deckhand_display/usage-geom-check.mjs`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — the new caches

**Interfaces:**
- Consumes: `usageBurnMinutes`, `usageBurnLabel`, `usageBurnUrgent`, `usageRingHash`, `usageRingCount`, `usageRingPct`, `usageRingHead`.
- Produces: `void renderNowCard()`, and `drawUsageSpark(uint32_t* cache, int x, int y, int w, int h, uint16_t fg, uint16_t bg)`.

- [ ] **Step 1: Write the failing geometry assertions**

Add to `usage-geom-check.mjs`'s board-2 section. The first is the one that guards `CARD_HERO_W`:

```js
  if (b === 2) {
    const laneX0 = c.CARD_X + c.PAD, laneX1 = c.CARD_X + c.CARD_W - c.PAD;
    // THE HERO'S CLEAR BOX MUST NOT REACH THE SIDE LANE. drawBigNumber clears the
    // box it is handed; hand it the full lane again and it erases both fact lines
    // on every value change, which is the defect CARD_HERO_W exists to prevent.
    chk(laneX0 + c.CARD_HERO_W < c.SIDE_X0,
        `hero box ends at ${laneX0 + c.CARD_HERO_W - 1}, side lane starts at ${c.SIDE_X0}`);
    // ...and it must still hold the widest number the card can draw. heroTextWidth()
    // is this checker's own measurer over the parsed Spleen32x64 glyph table - do
    // not multiply a transcribed advance.
    const heroInk = heroTextWidth(b, "100%");
    chk(heroInk <= c.CARD_HERO_W,
        `"100%" inks ${heroInk}px inside CARD_HERO_W ${c.CARD_HERO_W}`);
    // The side lane's character budget, DERIVED, which the burn label is capped to.
    const sideChars = Math.floor((laneX1 - c.SIDE_X0) / c.TEXT_ADV);
    chk(sideChars === 15, `side lane is ${sideChars} characters`);

    // The NOW card's bands, as CLEARED extents, disjoint and inside the ceiling.
    // META_H/HEAD_H come from the PARSED UI_FONTS[] table, beside the BODY_H and
    // HERO_H_NATIVE this checker already derives that way. Add them there:
    //   const META_H = { 1: UI_FONTS[1][1].cellH, 2: UI_FONTS[2][1].cellH };  // T_META
    //   const HEAD_H = { 1: UI_FONTS[1][3].cellH, 2: UI_FONTS[2][3].cellH };  // T_HEAD
    // Verified indices: T_META 1, T_BODY 2, T_HEAD 3, T_HERO 4; board 2 cellH
    // 16 / 16 / 24 / 64.
    const meta = META_H[b];
    const bands = [
      ["pin",   c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label", c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      ["hero",  c.NOW_HERO_Y,     c.NOW_HERO_Y + c.CARD_HERO_H - 1],
      ["bar",   c.NOW_BAR_Y - 4,  c.NOW_BAR_Y + c.BAR_H + 3],
      ["spark", c.NOW_SPARK_Y - 1, c.NOW_SPARK_Y + c.NOW_SPARK_H],
      ["meta",  c.NOW_META_Y - 1, c.NOW_META_Y + meta],
    ];
    for (let i = 1; i < bands.length; i++)
      chk(bands[i][1] >= bands[i][2] || bands[i][1] > bands[i - 1][2],
          `NOW band ${bands[i - 1][0]} -> ${bands[i][0]}: gap ${bands[i][1] - bands[i - 1][2] - 1}`);
    const last = bands[bands.length - 1][2];
    chk(last <= c.NOW_CARD_H - 3,
        `NOW last clear ends +${last}, ceiling +${c.NOW_CARD_H - 3} `
      + `(${c.NOW_CARD_H - 3 - last} rows clear of the 2px border)`);

    // The two side facts sit inside the hero's vertical band and beside it.
    for (const [n, y] of [[1, c.NOW_SIDE_Y], [2, c.NOW_SIDE_Y + c.NOW_SIDE_STEP]]) {
      chk(y - 1 >= c.NOW_HERO_Y && y + meta <= c.NOW_HERO_Y + c.CARD_HERO_H - 1,
          `NOW side fact ${n} clear +${y - 1}..+${y + meta} inside the hero band`);
    }
  }
```

`heroTextWidth(b, s)`, `BODY_H[b]` and `HERO_H_NATIVE[b]` already exist in this checker; `META_H` and `HEAD_H` are the two lines shown above, added beside them. All of them read the **parsed** `UI_FONTS[]` table — do not transcribe 16, 24, 32 or 64.

- [ ] **Step 2: Run and watch it fail**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
```

Expected: FAIL — `SIDE_X0`, `NOW_SIDE_Y` and `NOW_SIDE_STEP` were added in Task 3, so these should actually PASS on the constants alone. **If they pass, that is correct**: the geometry is already declared, and this step's real failure comes next, when the checker starts reading the draw site. Add that now:

```js
    // The draw site's own arguments, PARSED - not a restatement of the constants.
    // A comment claiming the hero is handed CARD_HERO_W is not a constraint; the
    // settings branch learned that when a reviewer rewrote a draw call and every
    // checker still passed. evalInt resolves each token through the board's table.
    const body = fnBody(stripComments("usage.ino"), "void renderNowCard(", "usage.ino");
    const hero = body.match(/drawBigNumber\(([^;]*)\)\s*;/);
    chk(!!hero, "renderNowCard calls drawBigNumber");
    if (hero) {
      const args = splitArgs(hero[1]);
      chk(evalInt(args[5], c) === c.CARD_HERO_W,
          `drawBigNumber is handed CARD_HERO_W (${c.CARD_HERO_W}), not the full lane `
        + `- got ${evalInt(args[5], c)}`);
    }
```

Now it fails: `renderNowCard` does not exist.

- [ ] **Step 3: Implement the spark and the card**

In `usage.ino`, inside the `#if BOARD_USAGE_V2` block:

```cpp
// The sparkline. CAPS PLUS CONNECTORS, not columns: a bar chart sitting directly
// under the pace bar reads as a second pace bar, and caps alone read as a dashed
// rule. One cap and one connector per sample is two fillRects a column.
//
// SCALE IS 0..100, so it agrees with the bar above it. Auto-scaling to the
// series' own min and max reads better and lies by omission - a quota sitting
// still with integer-percent noise would draw a dramatic mountain.
void drawUsageSpark(uint32_t* cache, int x, int y, int w, int h, uint16_t fg, uint16_t bg) {
  uint32_t sig = usageRingHash();
  if (sig == *cache) return;          // or this repaints 260x32 every 5s tick
  *cache = sig;
  tft.fillRect(x - 1, y - 1, w + 2, h + 2, bg);
  tft.drawFastHLine(x, y + h - 1, w, COLOR_LABEL);
  if (usageRingCount < 2) return;     // baseline only; the caption says "no history"
  int cw = w / USAGE_RING_SLOTS;
  int oldest = (usageRingHead + USAGE_RING_SLOTS - usageRingCount) % USAGE_RING_SLOTS;
  int prevCy = -1;
  for (int i = 0; i < usageRingCount; i++) {
    int v  = (int) usageRingPct[(oldest + i) % USAGE_RING_SLOTS];
    int cy = y + h - 3 - ((h - 5) * v) / 100;
    bool last = (i == usageRingCount - 1);
    if (prevCy >= 0 && prevCy != cy) {
      int a0 = prevCy < cy ? prevCy : cy;
      int a1 = prevCy < cy ? cy : prevCy;
      tft.fillRect(x + i * cw - 1, a0, 2, a1 - a0 + 2, fg);
    }
    tft.fillRect(x + i * cw, cy, cw - 1, last ? 4 : 2, last ? COLOR_VALUE : fg);
    prevCy = cy;
  }
}

void renderNowCard() {
  char buf[BURN_LABEL_BYTES + 8];
  const int y0 = CARD1_Y;
  bool stale = usage.quotaAgeSec > QUOTA_STALE_SEC;
  uint16_t color = colorForPct(usage.fiveHourPct);
  drawCardBorder(&border1Cache, CARD_X, y0, CARD_W, NOW_CARD_H, color);

  if (usage.fiveHourPct >= 0) snprintf(buf, sizeof(buf), "%d%%", usage.fiveHourPct);
  else snprintf(buf, sizeof(buf), "--");
  // CARD_HERO_W, NOT THE FULL LANE. drawBigNumber clears the box it is given, and
  // the two fact lines below live in what the full lane would erase.
  drawBigNumber(pct1Cache, 8, buf, CARD_X + PAD, y0 + NOW_HERO_Y,
                CARD_HERO_W, CARD_HERO_H,
                stale ? COLOR_LABEL : COLOR_VALUE, COLOR_CARD);

  long mins = usageBurnMinutes(usage.fiveHourPct, usage.fiveHourResetInMin, 5 * 60, stale);
  usageBurnLabel(buf, BURN_LABEL_BYTES, mins, usage.fiveHourResetInMin);
  padLeftTo(buf, sizeof(buf), NOW_SIDE_CHARS);
  drawIfChanged(burn1Cache, sizeof(burn1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + NOW_SIDE_Y, 1, 1,
                usageBurnUrgent(mins, usage.fiveHourResetInMin)
                  ? (usage.fiveHourPct >= 90 ? COLOR_BAD : COLOR_WARN) : COLOR_LABEL,
                COLOR_CARD, TR_DATUM);

  snprintf(buf, sizeof(buf), "%s", usage.fiveHourResetInMin >= 0
             ? formatResetIn(usage.fiveHourResetInMin).c_str() : "no data yet");
  padLeftTo(buf, sizeof(buf), NOW_SIDE_CHARS);
  drawIfChanged(left1Cache, sizeof(left1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + NOW_SIDE_Y + NOW_SIDE_STEP, 1, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);

  int tickPct = usage.fiveHourResetInMin >= 0
                  ? (int) (100 - usage.fiveHourResetInMin * 100 / (5 * 60)) : -1;
  drawPaceBar(&bar1Cache, CARD_X + PAD, y0 + NOW_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              usage.fiveHourPct, tickPct, color);

  drawUsageSpark(&spark1Cache, CARD_X + PAD, y0 + NOW_SPARK_Y, CARD_W - 2 * PAD,
                 NOW_SPARK_H, stale ? COLOR_LABEL : color, COLOR_CARD);

  snprintf(buf, sizeof(buf), "%s",
           usage.sessionTokens > 0 ? formatTokens(usage.sessionTokens).c_str() : "");
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(right1Cache, sizeof(right1Cache), buf, CARD_X + PAD, y0 + NOW_META_Y,
                2, 1, COLOR_LABEL, COLOR_CARD);

  if (stale) {
    long m = usage.quotaAgeSec / 60;
    if (m < 60) snprintf(buf, sizeof(buf), "stale %ldm", m);
    else        snprintf(buf, sizeof(buf), "stale %ldh", m / 60);
  } else {
    snprintf(buf, sizeof(buf), "%s", usageRingCount >= 2 ? "LAST 2.5H" : "no history");
  }
  padLeftTo(buf, sizeof(buf), 13);
  drawIfChanged(resetAt1Cache, sizeof(resetAt1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + NOW_META_Y, 1, 1, stale ? COLOR_BAD : COLOR_LABEL, COLOR_CARD, TR_DATUM);
}
```

Add `NOW_SIDE_CHARS = 15` to `board_es3c35p.h` beside `SIDE_X0`, derived as `(CARD_W - PAD - (PAD + CARD_HERO_W + 2 * SP_1)) / TEXT_ADV`, and have the checker assert that identity rather than the literal.

Declare the two new caches beside the existing usage caches in `deckhand_display.ino`, sized against their padded strings:

```cpp
#if BOARD_USAGE_V2
char burn1Cache[NOW_SIDE_CHARS + 4];   // "  empty ~99d 23h" padded to 15, plus NUL and slack
uint32_t spark1Cache = 0;
#endif
```

- [ ] **Step 4: Run the assertions**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
python3 firmware/deckhand_display/usage-trend-check.py
```

Expected: both PASS. The `LAST 2.5H` assertion from Task 5 is now green.

- [ ] **Step 5: Prove the `CARD_HERO_W` assertion has teeth**

Rewrite the draw call to hand `drawBigNumber` the full lane, exactly as v1 did, and confirm the checker rejects it:

```bash
perl -0pi -e 's/CARD_HERO_W, CARD_HERO_H,/CARD_W - 2 * PAD, CARD_HERO_H,/' firmware/deckhand_display/usage.ino
node firmware/deckhand_display/usage-geom-check.mjs   # must FAIL, naming drawBigNumber
git checkout firmware/deckhand_display/usage.ino
```

**If it passes, the assertion is reading the comment rather than the call** — which is the exact failure the settings branch's severity-spine assertion had.

- [ ] **Step 6: Compile board 2, then board 1; commit**

Board 2 `CHANGED`, `--update 2`. Board 1 **`UNCHANGED`**.

```bash
git add firmware/deckhand_display/usage.ino firmware/deckhand_display/deckhand_display.ino \
        firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage-geom-check.mjs \
        firmware/board-baseline.json
git commit -m "USAGE v2: renderNowCard, with the erased 132px put to work

The 5-hour card keeps the 64px hero and gains the two facts a percentage only
implies - the burn verdict and the reset countdown - in the space beside it. That
space is not merely reclaimed: drawBigNumber clears the box it is HANDED, v1
handed it the whole 260px lane, and \"100%\" inks 128, so those 132px were being
erased on every repaint. The hero now gets CARD_HERO_W and the checker PARSES
that argument out of the draw call rather than trusting a comment - a reviewer
rewriting the call is how the settings branch found its own spine assertion was
reading prose.

The sparkline is caps plus connectors, not columns: a bar chart directly under
the pace bar reads as a second pace bar, and caps alone read as a dashed rule.
Scale is 0..100 so it agrees with the bar above it - auto-scaling to the series'
own range reads better and lies by omission, since a quota sitting still with
integer-percent noise would draw a dramatic mountain. It is keyed on an FNV-1a
hash of the ring, or it would repaint 260x32 on every 5s tick.

Board 1: UNCHANGED."
```

---

### Task 8: `renderWeekCard`

Secondary, so a 24px number rather than a 64px hero — that contrast **is** the hierarchy. Fable becomes a labelled bar in the card whose window it shares.

**Files:**
- Modify: `firmware/deckhand_display/usage.ino`
- Modify: `firmware/deckhand_display/usage-geom-check.mjs`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — the Fable caches

**Interfaces:**
- Consumes: `usageBurnMinutes`, `usageBurnLabel`, `usageBurnUrgent`.
- Produces: `void renderWeekCard()`.

- [ ] **Step 1: Write the failing band assertions**

Mirror Task 7's band block for the WEEK card, with the two-font row handled as a union:

```js
    const head = HEAD_H[b];        // parsed T_HEAD cellH: 18 on board 1, 24 on board 2
    const wb = [
      ["pin",    c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label",  c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      // the number and the burn line share one row: union of the two clear boxes
      ["numrow", Math.min(c.WEEK_NUM_Y - 1, c.WEEK_BURN_Y - 1),
                 Math.max(c.WEEK_NUM_Y + head, c.WEEK_BURN_Y + meta)],
      ["allbar", c.WEEK_BAR_Y - 4,   c.WEEK_BAR_Y + c.BAR_H + 3],
      ["meta",   c.WEEK_META_Y - 1,  c.WEEK_META_Y + meta],
      ["fable",  c.WEEK_FABLE_Y - 1, c.WEEK_FABLE_Y + meta],
      ["fbar",   c.WEEK_FABLE_BAR_Y - 4, c.WEEK_FABLE_BAR_Y + c.BAR_H + 3],
    ];
    for (let i = 1; i < wb.length; i++)
      chk(wb[i][1] > wb[i - 1][2],
          `WEEK band ${wb[i - 1][0]} -> ${wb[i][0]}: gap ${wb[i][1] - wb[i - 1][2] - 1} (must be >= 0)`);
    const wlast = wb[wb.length - 1][2];
    chk(wlast <= c.WEEK_CARD_H - 3,
        `WEEK last clear ends +${wlast}, ceiling +${c.WEEK_CARD_H - 3} `
      + `(${c.WEEK_CARD_H - 3 - wlast} rows clear)`);

    // THE SECONDARY NUMBER MUST BE SMALLER THAN THE PRIMARY'S. That contrast is
    // the hierarchy this redesign exists for, so it is asserted rather than left
    // to whoever next edits a font id.
    chk(HEAD_H[b] < c.CARD_HERO_H,
        `WEEK's number (${HEAD_H[b]}px) is smaller than NOW's hero `
      + `(${c.CARD_HERO_H}px), which is what carries the hierarchy`);
```

- [ ] **Step 2: Run and watch it fail** — `WEEK_*` bands exist from Task 3, so these pass on constants; add the draw-site parse for `renderWeekCard` (as in Task 7 Step 2) and it fails on the missing function.

- [ ] **Step 3: Implement `renderWeekCard`**

```cpp
void renderWeekCard() {
  char buf[BURN_LABEL_BYTES + 8];
  const int y0 = CARD2_Y;
  const long WIN = 7L * 24 * 60;
  bool stale = usage.quotaAgeSec > QUOTA_STALE_SEC;
  uint16_t color = colorForPct(usage.sevenDayPct);
  drawCardBorder(&border2Cache, CARD_X, y0, CARD_W, WEEK_CARD_H, color);

  // T_HEAD, not T_HERO. The week is background rather than the thing that stops
  // you working, and the size contrast against NOW's 64px IS the hierarchy.
  if (usage.sevenDayPct >= 0) snprintf(buf, sizeof(buf), "%d%%", usage.sevenDayPct);
  else snprintf(buf, sizeof(buf), "--");
  padTo(buf, sizeof(buf), 4);
  drawIfChanged(pct2Cache, sizeof(pct2Cache), buf, CARD_X + PAD, y0 + WEEK_NUM_Y,
                3, 1, stale ? COLOR_LABEL : COLOR_VALUE, COLOR_CARD);

  // THE AVERAGE, NOT THE RING: at a 7-day window the ring moves 1.49 points
  // across its span, inside the integer-percent rounding. usageBurnMinutes picks
  // it on windowMin, so passing WIN here is what selects the estimator.
  long mins = usageBurnMinutes(usage.sevenDayPct, usage.sevenDayResetInMin, WIN, stale);
  usageBurnLabel(buf, BURN_LABEL_BYTES, mins, usage.sevenDayResetInMin);
  padLeftTo(buf, sizeof(buf), NOW_SIDE_CHARS);
  drawIfChanged(burn2Cache, sizeof(burn2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + WEEK_BURN_Y, 1, 1,
                usageBurnUrgent(mins, usage.sevenDayResetInMin)
                  ? (usage.sevenDayPct >= 90 ? COLOR_BAD : COLOR_WARN) : COLOR_LABEL,
                COLOR_CARD, TR_DATUM);

  int tickPct = usage.sevenDayResetInMin >= 0
                  ? (int) (100 - usage.sevenDayResetInMin * 100 / WIN) : -1;
  drawPaceBar(&bar2Cache, CARD_X + PAD, y0 + WEEK_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              usage.sevenDayPct, tickPct, color);

  snprintf(buf, sizeof(buf), "%s",
           usage.weekAllTokens > 0 ? formatTokens(usage.weekAllTokens).c_str() : "");
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(left2Cache, sizeof(left2Cache), buf, CARD_X + PAD, y0 + WEEK_META_Y,
                2, 1, COLOR_LABEL, COLOR_CARD);

  if (stale) {
    long m = usage.quotaAgeSec / 60;
    if (m < 60) snprintf(buf, sizeof(buf), "stale %ldm", m);
    else        snprintf(buf, sizeof(buf), "stale %ldh", m / 60);
  } else {
    snprintf(buf, sizeof(buf), "%s", usage.sevenDayResetInMin >= 0
               ? formatResetIn(usage.sevenDayResetInMin).c_str() : "no data yet");
  }
  padLeftTo(buf, sizeof(buf), 12);
  drawIfChanged(right2Cache, sizeof(right2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + WEEK_META_Y, 2, 1, stale ? COLOR_BAD : COLOR_LABEL, COLOR_CARD, TR_DATUM);

  // FABLE, IN THIS CARD, because Fable IS the same 7-day window rather than a
  // separate thing - and it is the SCARCER cap, which v1 rendered as an 8px crumb
  // in a shared foot row with no bar at all. Its tick is the 7-day tick.
  if (usage.weekFablePct >= 0) snprintf(buf, sizeof(buf), "FABLE  %d%%", usage.weekFablePct);
  else snprintf(buf, sizeof(buf), "FABLE  --");
  padTo(buf, sizeof(buf), 10);
  drawIfChanged(fable1Cache, sizeof(fable1Cache), buf, CARD_X + PAD, y0 + WEEK_FABLE_Y,
                2, 1, COLOR_LABEL, COLOR_CARD);

  snprintf(buf, sizeof(buf), "%s",
           usage.weekFableTokens > 0 ? formatTokens(usage.weekFableTokens).c_str() : "");
  padLeftTo(buf, sizeof(buf), 12);
  drawIfChanged(fable2Cache, sizeof(fable2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + WEEK_FABLE_Y, 2, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);

  drawPaceBar(&fableBarCache, CARD_X + PAD, y0 + WEEK_FABLE_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              usage.weekFablePct < 0 ? 0 : usage.weekFablePct, tickPct,
              usage.weekFablePct < 0 ? COLOR_UNKNOWN
                                     : (stale ? COLOR_LABEL : colorForPct(usage.weekFablePct)));
}
```

New caches in `deckhand_display.ino`, inside `#if BOARD_USAGE_V2`: `burn2Cache[NOW_SIDE_CHARS + 4]`, `fable2Cache[16]`, `int fableBarCache = -2;`.

- [ ] **Step 4: Run both checkers** — expected PASS.

- [ ] **Step 5: Compile board 2, then board 1; commit**

Board 2 `CHANGED`, `--update 2`; board 1 **`UNCHANGED`**.

```bash
git commit -m "USAGE v2: renderWeekCard, with Fable as a real bar in its own window's card

The week drops to a T_HEAD (24px) number rather than a 64px hero, and that size
contrast against NOW is what carries the hierarchy - asserted, not left to
whoever next edits a font id.

Fable moves INTO this card and gains a labelled bar. It belongs here because
Fable IS the same 7-day window rather than a separate thing, and it is the
SCARCER cap - which v1 rendered as an 8px crumb in a shared foot row with no bar
and no colour. Its tick is the 7-day tick, because it is the same window.

Its burn comes from the window AVERAGE and not the ring, and passing the 7-day
window to usageBurnMinutes is what selects that: the ring moves 1.49 points
across its span here, inside the integer-percent rounding.

Board 1: UNCHANGED."
```

---

### Task 9: Wire the tab, the cache busts, and retire `renderCard` on board 2

**Files:**
- Modify: `firmware/deckhand_display/usage.ino` — `renderUsageTab`, `drawUsageStatic`, `resetUsageCaches`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — wrap `renderCard`
- Modify: `firmware/deckhand_display/usage-geom-check.mjs` — the cache assertions

**Interfaces:**
- Consumes: `renderNowCard`, `renderWeekCard`.
- Produces: the finished tab.

- [ ] **Step 1: Write the failing cache assertions**

The change-only discipline assumes a field's pixels are stale only when its own value changed. Three new things break that, so assert all three over the source:

```js
{
  const src = stripComments("usage.ino");
  // 1. EVERY new cache is reset in resetUsageCaches(). drawUsageStatic repaints
  //    the chrome these fields are drawn ON, so a cache it does not reset leaves
  //    the value BLANK - "hasn't changed" per drawIfChanged, though its pixels
  //    were just erased. That shipped once as "USAGE shows no numbers after
  //    recording".
  const reset = fnBody(src, "void resetUsageCaches(", "usage.ino");
  for (const cache of ["burn1Cache", "burn2Cache", "fable2Cache", "spark1Cache", "fableBarCache"])
    chk(reset.includes(cache), `resetUsageCaches() clears ${cache}`);
  // 2. The STALE flip busts them. drawPaceBar caches on (pct, tick) alone, so the
  //    Fable bar's dim-only change would never repaint.
  const tab = fnBody(src, "void renderUsageTab(", "usage.ino");
  const staleBlock = tab.slice(tab.indexOf("stale != quotaStaleCache"));
  for (const cache of ["burn1Cache", "burn2Cache", "spark1Cache", "fableBarCache"])
    chk(staleBlock.includes(cache), `the stale flip busts ${cache}`);
  // 3. The spark is keyed on the ring's CONTENT, not drawn unconditionally, or it
  //    repaints 260x32 on every 5s tick - and on this board that is a real slice
  //    of a 30ms flush rather than "some SPI writes".
  chk(/drawUsageSpark\(\s*&spark1Cache/.test(src),
      "drawUsageSpark is passed a cache rather than drawing unconditionally");
  chk(fnBody(src, "void drawUsageSpark(", "usage.ino").includes("usageRingHash"),
      "drawUsageSpark keys its cache on usageRingHash()");
}
```

- [ ] **Step 2: Run and watch it fail** — every one of the five reset assertions fails.

- [ ] **Step 3: Branch `renderUsageTab` and extend the busts**

```cpp
void renderUsageTab() {
  if (!everReceived) return;
  int stale = usage.quotaAgeSec > QUOTA_STALE_SEC ? 1 : 0;
  if (stale != quotaStaleCache) {
    quotaStaleCache = stale;
    pct1Cache[0] = '\0';
    pct2Cache[0] = '\0';
#if BOARD_USAGE_V2
    // The new fields dim with the rest of the card, and two of them would never
    // repaint on their own: drawPaceBar caches on (pct, tick) alone, and the
    // spark's hash does not change when only its colour does.
    burn1Cache[0] = '\0';
    burn2Cache[0] = '\0';
    spark1Cache = 0;
    fableBarCache = -2;
#endif
  }
  /* ... the existing cxStale and source/pin/link/emoji busts, unchanged ... */
#if BOARD_USAGE_V2
  renderNowCard();
  renderWeekCard();
#else
  renderCard(CARD1_Y, usage.fiveHourPct, usage.sessionTokens, usage.fiveHourResetInMin,
             5 * 60, pct1Cache, left1Cache, right1Cache, fable1Cache, resetAt1Cache,
             &bar1Cache, &border1Cache);
  renderCard(CARD2_Y, usage.sevenDayPct, usage.weekAllTokens, usage.sevenDayResetInMin,
             7 * 24 * 60, pct2Cache, left2Cache, right2Cache, fable2Cache, resetAt2Cache,
             &bar2Cache, &border2Cache, usage.weekFableTokens, usage.weekFablePct);
#endif
  renderCodexRow();
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
```

`drawUsageStatic()` gets the v2 labels and heights under the same `#if`; `resetUsageCaches()` gets the five new caches.

- [ ] **Step 4: Wrap `renderCard` in `#if !BOARD_USAGE_V2`**

In `deckhand_display.ino`. **Wrapping matters rather than merely leaving it uncalled:** an uncalled function is dead weight the linker may or may not drop, which would silently spend flash on a renderer that can never run.

```cpp
#if !BOARD_USAGE_V2
// v1's card renderer. Board 2 draws renderNowCard/renderWeekCard instead, and
// this is WRAPPED rather than just left uncalled: an uncalled function is dead
// weight the linker may or may not drop. It is duplicated behind the flag rather
// than parameterised because parameterising a shared function would risk board
// 1's binary for no benefit - the same trade the ask screen's READ chip made.
void renderCard(int y0, int pct, unsigned long tokens, long resetInMin, long windowMin,
                /* ... */) {
  /* unchanged */
}
#endif
```

- [ ] **Step 5: Run every checker**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
python3 firmware/deckhand_display/usage-trend-check.py
node docs/design/usage-redesign/check.mjs
node firmware/deckhand_display/palette-check.mjs
```

Expected: all PASS.

- [ ] **Step 6: Compile board 2, then board 1; commit**

Board 2 `CHANGED`, `--update 2`; board 1 **`UNCHANGED`**. The flash delta here should be **negative or near zero** — `renderCard` leaves board 2's link.

```bash
git commit -m "USAGE v2: wire the tab, bust the new caches, retire renderCard on board 2

renderUsageTab branches on BOARD_USAGE_V2 and renderCard is WRAPPED in
#if !BOARD_USAGE_V2 rather than merely left uncalled - an uncalled function is
dead weight the linker may or may not drop, which would silently spend flash on
a renderer that can never run. Duplicated behind the flag rather than
parameterised, because parameterising a shared function would risk board 1's
binary for no benefit.

Three change-only hazards the new fields introduce, all asserted over the
source:

- Every new cache is cleared in resetUsageCaches(). drawUsageStatic repaints the
  chrome these fields are drawn ON, so a cache it misses leaves the value BLANK -
  unchanged per drawIfChanged though its pixels were just erased. That shipped
  once as \"USAGE shows no numbers after recording\".
- The stale flip busts them. drawPaceBar caches on (pct, tick) alone, so the
  Fable bar's dim-only change would never repaint, and the spark's hash does not
  move when only its colour does.
- The spark is keyed on the ring's CONTENT rather than drawn every tick. On this
  board a needless 260x32 repaint is a real slice of a 30ms flush, not \"some SPI
  writes\".

Board 1: UNCHANGED."
```

---

### Task 10: Sweep, measure, document

**Files:**
- Modify: `CLAUDE.md`
- Run: `firmware/deckhand_display/geom-sweep.mjs`

- [ ] **Step 1: Run the fault-injection sweep and time it**

```bash
time node firmware/deckhand_display/geom-sweep.mjs
```

Expected: ~110s, exit 0. **Time it and treat a wildly different number as a question about the machine before it is a question about the sweep** — a 33-minute run was once reported and does not reproduce.

- [ ] **Step 2: Close every unguarded new constant**

Read the sweep's UNGUARDED list. **Every constant this branch added must be caught at ±1 in both directions**, except those measuring time or a format rather than pixels — `USAGE_RING_STEP_MIN`, `USAGE_RING_DROP_PCT`, `BURN_*` and `QUOTA_STALE_SEC` have no geometric consequence a layout checker could see, and `usage-trend-check.py` binds those instead. That is the standard this repo sets for constants it has just added; the wireless-pairing branch met it for 22 of its 25.

For each geometric constant reported unguarded, add the assertion that binds it and re-run. Do not raise the sweep's heap: the limit it hits is V8's CODE space and `--max-old-space-size` provably does nothing. If a checker has grown, raise `SLICES`.

- [ ] **Step 3: Measure the real costs**

Build the branch point into a separate output directory so the current baseline's objects are not evicted — `arduino-cli` keys its cache on the sketch PATH, so rebuilding an old commit in place would destroy them:

```bash
git worktree add /tmp/usage-base $(git merge-base HEAD main)
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/base2 /tmp/usage-base/firmware/deckhand_display
```

Record flash and RAM for board 2 before and after, and the per-task deltas collected along the way. Reconcile them: **the four task deltas must sum to the measured total.** If two contemporaneous records disagree, rebuild the intermediate commit rather than picking one — the wireless-pairing branch had exactly that and it was settled by a rebuild.

- [ ] **Step 4: Write the CLAUDE.md section**

Under **Two boards**, a `#### USAGE on board 2: NOW / WEEK / CODEX` subsection covering: the column and why 414 not 416; `CARD_HERO_W` and the erased 132px; the one ring serving two purposes and its poll cadence; the two estimators and the 50.00-vs-1.49 measurement that forces them; the derived gate and the fact that `BURN_MIN_ELAPSED` cannot fire; the three cache hazards; the two shared fixes and why board 1's baseline moved twice; measured costs; and **what is not verified**.

That last part is not optional. State plainly: nothing has been on the glass; board 2's `SCREENSHOT` reads the shadow framebuffer so no claim here covers colour; the sparkline has never been read by a human at this size; and the ring's behaviour across a real window reset is untested because observing it once costs five hours of wall clock.

- [ ] **Step 5: Final gate — every checker, both baselines**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs
python3 firmware/deckhand_display/usage-trend-check.py
python3 firmware/deckhand_display/batt-trend-check.py
node firmware/deckhand_display/palette-check.mjs
node docs/design/usage-redesign/check.mjs
node firmware/deckhand_display/usage-geom-check.mjs --selftest
```

Then compile board 2, `--check 2`, compile board 1, `--check 1` — board 1 **`UNCHANGED`**.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md firmware/deckhand_display/usage-geom-check.mjs
git commit -m "USAGE v2: close the sweep's gaps, measure the cost, document it

Every geometric constant this branch added is now caught by geom-sweep.mjs at
+/-1 in both directions. The exceptions are the ones that measure TIME or a
RATE rather than pixels - USAGE_RING_STEP_MIN, USAGE_RING_DROP_PCT, the BURN_*
gate and QUOTA_STALE_SEC - which no layout assertion could see and which
usage-trend-check.py binds instead.

Costs measured per board against a worktree build of the branch point, with the
per-task deltas reconciled to sum to the total.

What is NOT verified, stated in CLAUDE.md rather than left implied: nothing has
been on the glass; board 2's SCREENSHOT reads the shadow framebuffer, so no
claim here covers colour and COLORTEST is the instrument; the sparkline has
never been read by a human at 320x480; and the ring's behaviour across a real
window reset is untested, because observing it once costs five hours of wall
clock."
```

---

## Self-Review

**Spec coverage.** Walked every section of the spec against the tasks: the column → 3; NOW card → 7; WEEK card → 8; CODEX row → 1; the trend ring → 5; two estimators and the derived gate → 6; change-only busts → 9; board-1 safety → the global constraint plus every task's compile step; the five findings → 1 (finding 4), 2 (finding 5), 3 (findings 1 and 2), 7 (finding 3); checker changes → 1, 2, 3, 7, 8, 9, 10; costs → 10; what is not verified → 10; the resolved questions → 5 (ring reset) and 6 (the derived floor). The pin bar is explicitly out of scope and has no task, matching the spec.

**Ordering deviation from the spec, deliberate.** The spec says the two shared fixes land *after* the redesign; this plan lands them *first*, as Tasks 1 and 2. Two reasons: they are bugs, and bugs before features; and the redesign's Codex row depends on Task 1's wider lane, so doing it last would leave board 2 briefly inconsistent with the committed mock. The spec's actual requirement — each fix in its own commit, re-baselining board 1 with the reason in the message — is met either way, and Tasks 3–10 then share one invariant against one stable baseline.

**Placeholder scan.** No TBD/TODO. The one deliberate red state is Task 5's `LAST 2.5H` assertion, which is documented as intentionally failing until Task 7 and named in Task 5's commit message. Task 10 Steps 2–4 direct work at outputs that cannot be known until the sweep and the builds run; each states the exact command, the standard to meet, and what to do with the result.

**Type consistency.** Checked the names across tasks: `usageRingSlope(float*, int*, long*)`, `usageRingHash() -> uint32_t`, `usageBurnMinutes(int, long, long, bool) -> long`, `usageBurnLabel(char*, size_t, long, long)`, `usageBurnUrgent(long, long) -> bool`, `drawUsageSpark(uint32_t*, int, int, int, int, uint16_t, uint16_t)`. Caches: `burn1Cache`, `burn2Cache`, `fable2Cache`, `spark1Cache` (uint32_t), `fableBarCache` (int) — the same five names in Tasks 7, 8 and 9's assertions. Constants: `NOW_CARD_H`, `WEEK_CARD_H`, `NOW_HERO_Y`, `NOW_BAR_Y`, `NOW_SPARK_Y`, `NOW_SPARK_H`, `NOW_META_Y`, `NOW_SIDE_Y`, `NOW_SIDE_STEP`, `NOW_SIDE_CHARS`, `CARD_HERO_W`, `SIDE_X0`, `WEEK_NUM_Y`, `WEEK_BURN_Y`, `WEEK_BAR_Y`, `WEEK_META_Y`, `WEEK_FABLE_Y`, `WEEK_FABLE_BAR_Y` — consistent between Task 3's declarations and Tasks 7–9's uses.

**Two gaps found and closed inline.** `NOW_SIDE_CHARS` was used by Tasks 7 and 8 but only declared in passing; Task 7 Step 3 now states where it goes and that the checker asserts its derivation rather than the literal 15.

And the assertion code referenced **four helpers that do not exist**, which would have cost the implementer real time. Checked against the tree rather than assumed:

- `usage-geom-check.mjs` imports only `{ consts, DIR, lineH, PANEL, preflight, textWidth }` — not `evalInt`, which *is* exported from `geom-common.mjs` but was never pulled in here.
- `fnBody` is a **local lambda** inside one `chk` block of `sessions-geom-check.mjs:2102`, not a shared export. `splitArgs` and `read` do not exist at all.
- There is no `uiAdv`/`uiLineH`. The real accessors are this checker's own `heroTextWidth(b, s)`, `BODY_H[b]` and `HERO_H_NATIVE[b]`, derived from a **parsed** `UI_FONTS[]`; `META_H` and `HEAD_H` are new and Task 7 says where they go. Font indices verified by running the parser: `T_META` 1, `T_BODY` 2, `T_HEAD` 3, `T_HERO` 4, with board 2's cell heights 16 / 16 / 24 / 64.
- `SP_1..SP_4` and `TEXT_ADV` **are** available on `c`, but `SP_*` live in `deckhand_display.ino:676` rather than a board header — which is fine only because `usage-geom-check.mjs:147` seeds its table as `consts("deckhand_display.ino", consts(HDR[b]))`. Confirmed `c.SP_2 === 8` and `c.TEXT_ADV === 8` on board 2, 6 on board 1.

Task 2 now opens by promoting `stripComments`, `fnBody` and `splitArgs` into `geom-common.mjs` and widening the import, following the precedent CLAUDE.md records for `evalInt` ("now EXPORTED ... rather than copied"), with `sessions-geom-check.mjs`'s local copy replaced by the import and re-run as the check on the promotion itself.
