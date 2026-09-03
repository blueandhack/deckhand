# Scrollback Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace board 2's paged history reader with one continuous Claude Code-style transcript — full message text inline, newest at the bottom, drag to scroll, ASCII gutter markers, no buttons.

**Architecture:** A `BOARD_HISTORY_SCROLL`-guarded surface that fetches the whole filtered history into PSRAM in a run of size-bounded JSON chunks, precomputes a wrapped-line index once so scrolling is a binary search rather than a re-wrap, and renders the visible lines per frame. Board 1 keeps its pager and its exact binary.

**Tech Stack:** Arduino ESP32-S3 (`.ino` concatenated translation unit), `PanelShim` over a PSRAM framebuffer, ArduinoJson v7, node for the host and every checker.

**Spec:** `docs/superpowers/specs/2026-09-03-scrollback-transcript-design.md`

## Global Constraints

- **Board 1's binary must report `UNCHANGED` at every commit.** `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display` then `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1`. A `CHANGED` at `+0 bytes` is a real finding, not noise.
- **NEVER compile both boards concurrently.** One sketch build directory, keyed on the sketch PATH. Compile one, check, then the other.
- **`BOARD_HISTORY_SCROLL` is a `#define`, never a `const int`.** `#if` on a C++ `const int` is silently false with no warning; that has shipped here twice.
- **Every marker and every on-screen string is ASCII `0x20..0x7E`.** Spleen declares only that range; anything else draws nothing and advances nothing.
- **A checker must PARSE the constant it certifies, never transcribe it.** A literal on the checker's side means a revert does not fail.
- **The test for a new assertion is not "does it pass" but "does reverting the constant make it FAIL, and by name".**
- **`SCROLL_COLS` is 34; `SCROLL_LINES` is 26.** Both derived in the spec; use the parsed constants, never the numbers.
- Per-entry text stays capped at the host's existing `HIST_FULL_CAP` (4000).
- `feedChar`'s line guard is **16000 BYTES** and it CLEARS THE BUFFER mid-line rather than dropping it.
- Board 2 flash/RAM today: **1026062 / 74116**. Record deltas per task.

## File Structure

| File | Responsibility |
|---|---|
| `firmware/deckhand_display/board_es3c35p.h` | every `SCROLL_*` constant, `BOARD_HISTORY_SCROLL 1` |
| `firmware/deckhand_display/board_e32r28t.h` | `BOARD_HISTORY_SCROLL 0` and nothing else |
| `firmware/deckhand_display/scrollback.ino` | **new**: the store, the wrap, the line index, the renderer, the drag loop, `SCROLLPERF`. All of it inside one `#if BOARD_HISTORY_SCROLL` block. |
| `firmware/deckhand_display/reader.ino` | board-2 arms delegating to `scrollback.ino`; the pager becomes board 1's `#else` |
| `firmware/deckhand_display/deckhand_display.ino` | the `hist` parser's chunk arm; globals |
| `firmware/deckhand_display/scrollback-check.mjs` | **new**: the line-index mirror + structural assertions over the firmware |
| `firmware/deckhand_display/settings-geom-check.mjs` | the geometry assertions (it already owns the reader) |
| `docs/design/scrollback/check.mjs` | **new**: binds the committed mock to the board header |
| `host/index.mjs` | `sendScrollback()` and the `tail:` request form |

A **new `.ino`** rather than growing `reader.ino` (593 lines): the whole feature is one `#if` block, so a file boundary makes board 1's exclusion visible at a glance. Arduino concatenates every `.ino` in the folder, so it shares every global and needs no `extern`. **The one rule:** Arduino inserts its generated prototypes above the first function definition, so no function in this file may name `SessionInfo`, `Usage`, `Theme`, `HostPairing` or `ConfirmAction` in its signature. None does — they take `int` indices.

---

### Task 1: Constants, the flag, and both binds

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/board_e32r28t.h`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`
- Create: `docs/design/scrollback/check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `BOARD_HISTORY_SCROLL`; `SCROLL_GUT_X`, `SCROLL_TXT_X`, `SCROLL_COLS`, `SCROLL_RAIL_AIR`, `SCROLL_RAIL_X`, `SCROLL_RAIL_W`, `SCROLL_RIGHT_AIR`, `SCROLL_RAIL_TAP_X`, `SCROLL_TAP_SLOP_PX`, `SCROLL_TOP`, `SCROLL_LINES`, `SCROLL_BOT`, `SCROLL_BOT_AIR`, `SCROLL_BACK_X`, `SCROLL_BACK_W`, `SCROLL_NAME_X`, `SCROLL_NAME_COLS`, `SCROLL_TEXT_BYTES`, `SCROLL_MAX_ENTRIES`, `SCROLL_TAIL_BYTES_USB`, `SCROLL_TAIL_BYTES_BLE`, `SCROLL_WIRE_CHUNK_BYTES`, `SCROLL_FETCH_TIMEOUT_MS`, `SCROLL_FETCH_TIMEOUT_BLE_MS`.

- [ ] **Step 1: Add the flag to board 1's header, next to the other capability flags**

In `board_e32r28t.h`, beside `#define BOARD_SETTINGS_HOME 0`:

```c
// The scrolling transcript is board 2's. This board keeps its paged reader: the
// panel is RESISTIVE, where this repo has already measured that drag-scroll
// misfires and settled on discrete pages, and its binary is held byte-identical.
// A #define, NOT a const int - the preprocessor cannot see a C++ const int, so
// `#if` on one is silently false with no warning. That has shipped here twice.
#define BOARD_HISTORY_SCROLL 0
```

- [ ] **Step 2: Add the constants to board 2's header**

In `board_es3c35p.h`, after the `READER_*` block (near line 2537):

```c
#define BOARD_HISTORY_SCROLL 1

// ---------- Scrollback: the transcript surface ----------
// THE HORIZONTAL LANE CLOSES EXACTLY ON BOARD_W, and SCROLL_RIGHT_AIR is the
// closing term - the HOME_Y0_BOT / PAIR_AIR_LEFT shape. SCROLL_TXT_X and
// SCROLL_RAIL_X are DERIVED, so the literals a sweep can perturb are GUT_X,
// COLS, RAIL_AIR, RAIL_W and RIGHT_AIR, and the identity catches every one.
//
//   12  gutter x       marker, one glyph in a two-column cell
//   28  text x         = SCROLL_GUT_X + 2 * TEXT_ADV
//       34 columns     272px, ends at 299
//    6  gap
//  306  rail x         4px, ends at 309
//   10  right margin
//  ---
//  320  = BOARD_W
//
// 34 against the pager's 37: the gutter costs THREE COLUMNS, 8%. That is what
// buys a transcript that reads as a conversation rather than a list of labelled
// rows, and it is the whole trade this surface makes.
const int SCROLL_GUT_X     = 12;
const int SCROLL_TXT_X     = SCROLL_GUT_X + 2 * TEXT_ADV;
const int SCROLL_COLS      = 34;
const int SCROLL_RAIL_AIR  = 6;
const int SCROLL_RAIL_X    = SCROLL_TXT_X + SCROLL_COLS * TEXT_ADV + SCROLL_RAIL_AIR;
const int SCROLL_RAIL_W    = 4;
const int SCROLL_RIGHT_AIR = 10;

// The rail is a TAP target (jump to that fraction), not a drag target, so it
// cannot be ambiguous against a body drag: a tap has moved less than
// SCROLL_TAP_SLOP_PX, a scroll has moved more. 20px is 3.1mm - UNDER the 7.1mm
// TAP_MIN floor - and that is accepted here for two stated reasons: it starts at
// or after the text lane's end so it never eats a column, and missing it costs a
// body scroll rather than anything destructive. If it proves hard to hit on the
// glass, drop SCROLL_COLS to 33 and this gains 8px.
const int SCROLL_RAIL_TAP_X = 300;

// A TAP IS A DRAG THAT MOVED LESS THAN THIS. Without a named threshold "tap the
// rail" and "drag anywhere" are not separable, because every tap moves a pixel
// or two on a capacitive panel. 6 is under half a line, so a scroll small enough
// to read as a tap has moved no text.
const int SCROLL_TAP_SLOP_PX = 6;

// THE VERTICAL COLUMN CLOSES EXACTLY ON BOARD_H, with SCROLL_BOT_AIR closing it.
// SCROLL_TOP is HIST_TOP - the same "6 below the rule" fact, one source, not a
// second literal. 26 lines against the pager's (360-60)/16 = 18 is +44%, and all
// of it comes from deleting the 46px scrubber band and the 50px button row.
const int SCROLL_TOP     = HIST_TOP;
const int SCROLL_LINES   = 26;
const int SCROLL_BOT     = SCROLL_TOP + SCROLL_LINES * CODE_LINE_H;
const int SCROLL_BOT_AIR = 4;

// The header keeps HIST_RULE_Y's 54px. Two facts here are DERIVATIONS, not
// choices: the back key is exactly TAP_MIN because it carries the CLOSE the
// deleted button row used to provide, and the name lane is exactly the 22
// characters the host already caps a session name to (host/index.mjs's
// `deviceText(await projectName(...), 22)`), which settings-geom-check.mjs
// asserts against the host's own number rather than against this one.
const int SCROLL_BACK_X    = 12;
const int SCROLL_BACK_W    = TAP_MIN;
const int SCROLL_NAME_X    = SCROLL_BACK_X + SCROLL_BACK_W + 8;
const int SCROLL_NAME_COLS = 22;

// ---------- Scrollback: the store and the wire ----------
// PSRAM, not DRAM. Board 1 holds ONE screen in a 2400-byte arena because it has
// ~26KB of free heap; this board has 8,388,608 bytes of PSRAM against a MEASURED
// 122KB conversation, so the constraint that produced the paged design does not
// exist here. 262144 covers that conversation 2.1x; the ALL filter on a very long
// session will not fit 584KB and drops the oldest, with the count stated on the
// glass. Total with the index: 304KB, 3.7% of PSRAM, and zero DRAM.
const int SCROLL_TEXT_BYTES  = 262144;
const int SCROLL_MAX_ENTRIES = 4096;      // 12 bytes each = 49152

// The fetch budget is chosen by TRANSPORT because BLE genuinely cannot have the
// whole thing: 122KB at ~666 B/s is over three minutes. USB is native CDC at
// ~384 KB/s measured, so the typical fetch is ~0.3s. 8192 over BLE is ~12s, which
// is a long pause and is why the pending state has to name the transport.
const int SCROLL_TAIL_BYTES_USB = 262144;
const int SCROLL_TAIL_BYTES_BLE = 8192;

// THE REPLY IS A SEQUENCE OF LINES, NOT ONE LINE, and this is the number that
// makes that safe. feedChar's guard is 16000 BYTES and it does not drop an
// over-long line - it CLEARS THE BUFFER mid-line, so the remainder accumulates
// into an emptied buffer, the parse fails, and every tick carrying it is lost
// while both links look healthy. 12000 is the WHOLE SERIALISED LINE, measured on
// the JSON rather than on the sum of text lengths: escaping is not a rounding
// term, since a newline becomes \n and DOUBLES. Worst case for one entry is
// 4000 chars of pure newlines = 8000 escaped plus ~200 of envelope, so a single
// entry always fits alone.
const int SCROLL_WIRE_CHUNK_BYTES = 12000;

const int SCROLL_FETCH_TIMEOUT_MS     = 20000;
const int SCROLL_FETCH_TIMEOUT_BLE_MS = 40000;
```

- [ ] **Step 3: Add the failing geometry assertions**

In `settings-geom-check.mjs`, inside the per-board block, guarded to board 2 (follow the file's existing `if (b === 2)` style). `c` is the parsed constants object.

```js
  if (b === 2) {
    // THE TWO CLOSING IDENTITIES. Each is the only two-sided bound on its axis:
    // a per-term check passes for any redistribution that preserves the sum, and
    // a sum-only check passes for any single term that moves if another absorbs
    // it. Asserting the identity is what makes a one-constant change fail here.
    chk(c.SCROLL_RAIL_X + c.SCROLL_RAIL_W + c.SCROLL_RIGHT_AIR === PANEL[b][0],
      "scrollback: the horizontal lane closes exactly on BOARD_W");
    chk(c.SCROLL_TOP + c.SCROLL_LINES * c.CODE_LINE_H + c.SCROLL_BOT_AIR === PANEL[b][1],
      "scrollback: the vertical column closes exactly on BOARD_H");
    chk(c.SCROLL_LINES === Math.floor((PANEL[b][1] - c.SCROLL_BOT_AIR - c.SCROLL_TOP) / c.CODE_LINE_H),
      "scrollback: SCROLL_LINES is the column's own height in whole cells");
    chk(c.SCROLL_BOT === c.SCROLL_TOP + c.SCROLL_LINES * c.CODE_LINE_H,
      "scrollback: SCROLL_BOT is derived from TOP and LINES, not a second literal");

    // The back key carries the CLOSE the deleted button row used to provide, so it
    // is the one control here that must not shrink below the fingertip floor.
    chk(c.SCROLL_BACK_W >= c.TAP_MIN, "scrollback: the back key is at least TAP_MIN wide");
    chk(c.HIST_CHIP_H >= c.TAP_MIN, "scrollback: the filter chip is at least TAP_MIN tall");

    // THE NAME LANE IS ASSERTED AGAINST THE HOST'S OWN CAP, parsed rather than
    // transcribed - the rule that governs every other cross-file cap here. If the
    // host ever sends longer names, this fails instead of the panel clipping them.
    const HOST = fs.readFileSync(path.join(DIR, "../../host/index.mjs"), "utf8");
    const nm = HOST.match(/name:\s*deviceText\(await projectName\([^)]*\),\s*(\d+)\)/);
    chk(nm != null, "scrollback: the host's session-name cap is still findable");
    chk(nm != null && c.SCROLL_NAME_COLS === +nm[1],
      "scrollback: the name lane is exactly the host's session-name cap in columns");
    const chipX = PANEL[b][0] - 12 - c.HIST_CHIP_W_CHAT;
    chk(c.SCROLL_NAME_X + c.SCROLL_NAME_COLS * c.TEXT_ADV <= chipX - 4,
      "scrollback: the name lane's ink clears the widest filter chip");

    // The two header lines are 16px boxes that must not share a row (drawString
    // paints an OPAQUE box, so a shared row erases its neighbour's tail - the
    // defect the keyboard's meta row hit twice) and must stay above the rule.
    const nameBox = tlBox(b, 2, 12), posBox = tlBox(b, 1, 30);
    chk(nameBox[1] < posBox[0], "scrollback: the header's name and counter rows are disjoint");
    chk(posBox[1] < c.HIST_RULE_Y, "scrollback: the header's counter clears the rule");

    // The rail must not eat a text column, and the tap zone must not either.
    const textEnd = c.SCROLL_TXT_X + c.SCROLL_COLS * c.TEXT_ADV;
    chk(c.SCROLL_RAIL_X >= textEnd, "scrollback: the rail clears the text lane");
    chk(c.SCROLL_RAIL_TAP_X >= textEnd, "scrollback: the rail's tap zone clears the text lane");
    chk(c.SCROLL_TAP_SLOP_PX < c.CODE_LINE_H / 2,
      "scrollback: the tap slop is under half a line, so a tap has moved no text");

    // The lane is EXACTLY the column count because every Spleen glyph has
    // xOffset + width == xAdvance, which this header already asserts. That is why
    // a column count that divides exactly is exact for ANY string on this board.
    chk(advanceB(b, 1) === c.TEXT_ADV,
      "scrollback: the body face's advance is TEXT_ADV, so the lane is exact");
  }
```

- [ ] **Step 4: Run the checker and watch it FAIL**

Run: `node firmware/deckhand_display/settings-geom-check.mjs`
Expected: FAIL on every new assertion — the constants do not exist yet, so `c.SCROLL_*` is `undefined` and the comparisons are false. **If any new assertion PASSES here, it cannot fail and must be rewritten** — that is the point of running it before Step 2's constants land. (If Step 2 was applied first, revert it, run this, then re-apply.)

- [ ] **Step 5: Run the checker and watch it pass**

Run: `node firmware/deckhand_display/settings-geom-check.mjs`
Expected: PASS, with the new assertions in the `ok` list and the printed total up by 14.

- [ ] **Step 6: Prove each assertion can fail, one constant at a time**

For each of `SCROLL_COLS`, `SCROLL_RIGHT_AIR`, `SCROLL_LINES`, `SCROLL_BOT_AIR`, `SCROLL_NAME_COLS`, `SCROLL_RAIL_TAP_X`, `SCROLL_TAP_SLOP_PX`: change it by `+1` in `board_es3c35p.h`, run the checker, confirm it FAILS **by name**, revert.

```bash
cd firmware/deckhand_display
for k in SCROLL_COLS SCROLL_RIGHT_AIR SCROLL_LINES SCROLL_BOT_AIR SCROLL_NAME_COLS; do
  cp board_es3c35p.h /tmp/h.bak
  perl -pi -e "s/^(const int $k\s*=\s*)(\d+)/\${1}.(\$2+1)/e" board_es3c35p.h
  # the file MUST have changed, or a non-matching pattern reads as a clean pass
  if cmp -s board_es3c35p.h /tmp/h.bak; then echo "INJECTION MISSED for $k"; fi
  echo "--- $k +1 ---"; node settings-geom-check.mjs | grep FAIL | head -3
  cp /tmp/h.bak board_es3c35p.h
done
```

- [ ] **Step 7: Bind the committed mock to the header**

Create `docs/design/scrollback/check.mjs`, following `docs/design/usage-redesign/check.mjs`'s shape:

```js
// Binds the mock to board_es3c35p.h. A committed design artifact whose numbers can
// drift while it still reports "all passed" is the same class of defect as an
// assertion that cannot fail, and it is a class this repo has paid for three times.
import { consts, DIR as GEOM_DIR } from "../../../firmware/deckhand_display/geom-common.mjs";
import fs from "node:fs";
import path from "node:path";

const HDR = path.join(GEOM_DIR, "board_es3c35p.h");
const c = consts(HDR);
const page = fs.readFileSync(new URL("./scrollback.html", import.meta.url), "utf8");

// The mock's own geometry block, parsed out of its JS rather than transcribed.
const g = {};
for (const m of page.matchAll(/^var ([A-Z_]+[A-Z0-9_]*)\s*=\s*(-?\d+)/gm)) g[m[1]] = +m[2];

let total = 0, fail = 0;
const chk = (cond, msg) => { total++; console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`); if (!cond) fail++; };

// Shared with the header and therefore BOUND. Keys are the mock's names; values
// are the header's, so a rename on either side fails rather than passing silently.
const BOUND = {
  W: "BOARD_W", H: "BOARD_H", ADV: "TEXT_ADV", LH: "CODE_LINE_H",
  GUT_X: "SCROLL_GUT_X", TXT_X: "SCROLL_TXT_X", COLS: "SCROLL_COLS",
  SB_W: "SCROLL_RAIL_W", CHIP_W: "HIST_CHIP_W_CHAT", CHIP_Y: "HIST_CHIP_Y",
  CHIP_H: "HIST_CHIP_H", BACK_X: "SCROLL_BACK_X", BACK_W: "SCROLL_BACK_W",
  NAME_X: "SCROLL_NAME_X", RULE_Y: "HIST_RULE_Y", HDR_H: "HIST_RULE_Y",
};
for (const [mockName, hdrName] of Object.entries(BOUND)) {
  chk(g[mockName] !== undefined, `the mock still declares ${mockName}`);
  chk(c[hdrName] !== undefined, `the header still declares ${hdrName}`);
  chk(g[mockName] === c[hdrName],
    `${mockName} (${g[mockName]}) == ${hdrName} (${c[hdrName]})`);
}

// DELIBERATELY UNBOUND, each with its reason. The rule that keeps this honest:
// an entry here must actually DIFFER from what ships, so a live constant cannot be
// parked here to escape the bind.
const WAS = {
  LIST_BOT: [472, "SCROLL_BOT", "the mock left a 12px bottom margin; the spec tightens it to 4"],
  VIS: [25, "SCROLL_LINES", "and so renders one line fewer"],
};
for (const [k, [want, hdrName, why]] of Object.entries(WAS)) {
  chk(g[k] === want, `the mock's ${k} is still ${want} (${why})`);
  chk(g[k] !== c[hdrName], `${k} genuinely differs from ${hdrName} - not a bind in disguise`);
}

console.log(`\n${total} bindings, ${fail} failures`);
if (fail) process.exit(1);
console.log("the scrollback mock agrees with board_es3c35p.h");
```

- [ ] **Step 8: Run the mock bind, and prove it has teeth**

```bash
node docs/design/scrollback/check.mjs
cp firmware/deckhand_display/board_es3c35p.h /tmp/h.bak
perl -pi -e 's/^(const int SCROLL_COLS\s*=\s*)34/${1}35/' firmware/deckhand_display/board_es3c35p.h
cmp -s firmware/deckhand_display/board_es3c35p.h /tmp/h.bak && echo "INJECTION MISSED"
node docs/design/scrollback/check.mjs; echo "exit=$? (expect 1)"
cp /tmp/h.bak firmware/deckhand_display/board_es3c35p.h
```
Expected: clean pass, then `COLS (34) == SCROLL_COLS (35)` FAILing and `exit=1`.

- [ ] **Step 9: Update the mock's README to record that the bind now exists**

Replace the README's last paragraph (the one beginning "**This mock is NOT yet bound") with:

```markdown
**Bound to the header:** `node check.mjs` asserts every constant this page shares with
`board_es3c35p.h`, parsed from both sides. The two deliberate differences above live in a
separate `WAS` table which is asserted to genuinely differ from what ships, so a live
constant cannot be parked there to escape the bind.
```

- [ ] **Step 10: Verify both boards and the sweep**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
node firmware/deckhand_display/geom-sweep.mjs 2>&1 | tail -25
```
Expected: board 2 `UNCHANGED` (`const int`s nothing reads are discarded by `--gc-sections`); **board 1 `UNCHANGED`** — its header gains one `#define` that emits no code. The sweep will report the new non-geometric constants as unguarded (they measure bytes and time); every geometric one must be caught at `|1|`.

- [ ] **Step 11: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/board_e32r28t.h \
        firmware/deckhand_display/settings-geom-check.mjs docs/design/scrollback/
git commit -F - <<'EOF'
Declare the scrollback geometry, and bind the mock to it

Both closing identities (horizontal on BOARD_W, vertical on BOARD_H) are
asserted rather than the individual terms: a per-term check passes for any
sum-preserving redistribution, and a sum-only check passes for any single term
another absorbs.

The name lane is asserted against the HOST's own 22-character session-name cap,
parsed out of host/index.mjs rather than transcribed - so if the host ever sends
longer names this fails instead of the panel clipping them.

The mock is bound in the same commit. It had shipped with the spec unbound
because the constants did not exist yet; that was recorded as this task's job
rather than left as a silent gap, and an unbound mock that still reports a clean
pass is the class this repo has paid for three times.

Every new geometric constant is caught at +/-1 in both directions. Board 1 gains
one #define that emits no code: UNCHANGED.
EOF
```

---

### Task 2: The PSRAM store, the wrap, and the line index

**Files:**
- Create: `firmware/deckhand_display/scrollback.ino`
- Create: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: Task 1's constants.
- Produces: `bool scrollBegin()`, `void scrollEnd()`, `void scrollReset()`, `bool scrollAppend(uint8_t role, const char* t)`, `int scrollWrapLines(const char* t, int cols)`, `bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize)`, `int scrollEntryAtLine(uint32_t line)`, and the globals `scrollCount`, `scrollTotalLines`, `scrollTotal`, `scrollDropped`, `scrollTextUsed`, `struct ScrollEntry {uint32_t off; uint32_t lineFirst; uint16_t lines; uint8_t role; uint8_t spacer;}`.

- [ ] **Step 1: Write the failing checker**

Create `firmware/deckhand_display/scrollback-check.mjs`. It has two halves reported separately, the `sessions-rank-check.mjs` convention — **a mirror proves the algorithm and would keep passing with the real code deleted, so only the structural half binds the sketch.**

```js
// Two halves, reported separately and deliberately:
//   MIRROR     - a JS re-implementation of the wrap and the line index. Proves the
//                ALGORITHM, including cases unreachable on hardware. It would keep
//                passing with scrollback.ino deleted, so it binds nothing.
//   STRUCTURAL - reads scrollback.ino as TEXT, comments stripped, each assertion
//                bound to a FUNCTION BODY rather than to the file. A rule that a
//                neighbouring line can satisfy is not a rule (the pairWindowOpen
//                hole: replacing that body with `return true` passed 70 assertions).
import fs from "node:fs";
import path from "node:path";
import { consts, stripComments, fnBody, DIR } from "./geom-common.mjs";

const SELFTEST = process.argv.includes("--selftest");
let mirror = 0, structural = 0, fail = 0;
const FAILED = [];
function chk(cond, msg, kind) {
  if (kind === "m") mirror++; else structural++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) { fail++; FAILED.push(msg); }
}
const m = (cond, msg) => chk(cond, msg, "m");
const s = (cond, msg) => chk(cond, msg, "s");

const c = consts(path.join(DIR, "board_es3c35p.h"));
let INO = stripComments(fs.readFileSync(path.join(DIR, "scrollback.ino"), "utf8"));
const SKETCH = stripComments(fs.readFileSync(path.join(DIR, "deckhand_display.ino"), "utf8"));

if (SELFTEST) {
  const fault = process.env.SB_FAULT || "wrap-cap";
  if (fault === "wrap-cap") INO = INO.replace(/while \(t\[pos\]\)/, "while (t[pos] && lines < 80)");
  if (fault === "no-reap") INO = INO.replace(/reapBleLinks\(true\);/g, "");
  if (fault === "no-activity") INO = INO.replace(/lastActivityMillis = millis\(\);/g, "");
  if (fault === "seq-append") INO = INO.replace(/scrollReset\(\);\s*scrollFetchFailed = true;/, "");
  if (fault === "wide-marker") INO = INO.replace(/"\$"/, '"\\u00b7"');
}

// ---------------- MIRROR: the wrap rule and the line index ----------------
// Mirrors scrollLineLen: monospace, so wrapping is exact integer arithmetic and
// needs no width call at all. Same rule as the shared wrapLineLen - hard '\n',
// word-friendly break at the last space in the lane's second half, never stall.
function lineLen(t, pos, cols) {
  let i = 0;
  while (i < cols && pos + i < t.length && t[pos + i] !== "\n") i++;
  if (t[pos + i] === "\n") return [i, true];
  if (pos + i >= t.length) return [i, false];
  for (let b = i; b > Math.floor(cols / 2); b--)
    if (t[pos + b - 1] === " ") return [b, false];
  return [i, false];
}
function wrapLines(t, cols) {
  if (!t.length) return 1;
  let pos = 0, lines = 0;
  while (pos < t.length) {
    const [n, hard] = lineLen(t, pos, cols);
    pos += n;
    if (hard && t[pos] === "\n") pos++;
    lines++;
    if (n === 0 && !hard) break;
  }
  return lines || 1;
}
const COLS = c.SCROLL_COLS;
m(wrapLines("", COLS) === 1, "mirror: an empty entry still occupies one line");
m(wrapLines("hi", COLS) === 1, "mirror: a short entry is one line");
m(wrapLines("x".repeat(COLS), COLS) === 1, "mirror: exactly COLS characters is one line");
m(wrapLines("x".repeat(COLS + 1), COLS) === 2, "mirror: COLS+1 is two lines");
m(wrapLines("a\nb", COLS) === 2, "mirror: a hard break makes two lines");
m(wrapLines("a\n\nb", COLS) === 3, "mirror: a blank line counts as a line");
// THE 80-LINE CAP IS THE WHOLE REASON THIS DOES NOT REUSE countWrappedLines:
// that helper stops at 80 and its wrapLineLen carries a char buf[64] capped at
// 60 characters, so a 4000-byte entry cannot pass through it at all.
const big = "word ".repeat(800).trim();               // 4000 chars
m(wrapLines(big, COLS) > 80, `mirror: a 4000-char entry wraps past 80 lines (${wrapLines(big, COLS)})`);
m(wrapLines("aaaa bb", 6)[0] !== undefined, "mirror: the wrap returns a number, not a tuple");
// A word longer than the lane must still advance, or the fetch spins forever.
m(wrapLines("x".repeat(200), 10) === 20, "mirror: an unbreakable word breaks at the lane and never stalls");

// The index: lineFirst accumulates lines PLUS the spacer, and a result tucks
// against its own call with no spacer - the pair reads as one unit.
function buildIndex(entries, cols) {
  const idx = [];
  for (let i = 0; i < entries.length; i++) {
    const e = { role: entries[i].r, lines: wrapLines(entries[i].t, cols), spacer: 0 };
    if (i === 0) e.lineFirst = 0;
    else {
      const p = idx[i - 1];
      p.spacer = (p.role === 2 && e.role === 3) ? 0 : 1;
      e.lineFirst = p.lineFirst + p.lines + p.spacer;
    }
    idx.push(e);
  }
  return idx;
}
function entryAtLine(idx, line) {
  let lo = 0, hi = idx.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid].lineFirst <= line) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
const EV = [{ r: 0, t: "one" }, { r: 2, t: "ran" }, { r: 3, t: "out" }, { r: 1, t: "two" }];
const IX = buildIndex(EV, COLS);
m(IX[0].spacer === 1, "mirror: an ordinary entry is followed by a blank line");
m(IX[1].spacer === 0, "mirror: a result tucks against its own call with no spacer");
m(IX[2].spacer === 1, "mirror: the entry after a result gets its blank back");
m(IX[3].spacer === 0, "mirror: the last entry has no trailing blank");
m(IX.map(e => e.lineFirst).join(",") === "0,2,3,5", "mirror: lineFirst accumulates lines plus spacers");
// EXHAUSTIVE over every reachable line, because the binary search is the one
// thing a frame calls every time and an off-by-one there shows as text jumping.
const totalLines = IX[IX.length - 1].lineFirst + IX[IX.length - 1].lines;
let bad = null;
for (let L = 0; L < totalLines; L++) {
  const i = entryAtLine(IX, L);
  const inRange = L >= IX[i].lineFirst && L < IX[i].lineFirst + IX[i].lines + IX[i].spacer;
  if (!inRange && bad === null) bad = L;
}
m(bad === null, `mirror: the binary search lands in range for every line${bad === null ? "" : ` (first bad: ${bad})`}`);

// ---------------- STRUCTURAL: bound to scrollback.ino's own function bodies ----------------
const wrapBody = fnBody(INO, "int scrollWrapLines(const char* t, int cols)", "scrollback.ino");
s(wrapBody !== null && !/\b80\b/.test(wrapBody),
  "structural: scrollWrapLines carries NO line cap - a 4000-byte entry is 118 lines");
s(wrapBody !== null && !/countWrappedLines|wrapLineLen/.test(wrapBody),
  "structural: scrollWrapLines does not reuse the 80-line-capped shared helpers");
s(wrapBody !== null && !/textWidth/.test(wrapBody),
  "structural: the wrap is integer arithmetic, not a per-character width call");

const appendBody = fnBody(INO, "bool scrollAppend(uint8_t role, const char* t)", "scrollback.ino");
s(appendBody !== null && /SCROLL_TEXT_BYTES/.test(appendBody),
  "structural: scrollAppend bounds itself against SCROLL_TEXT_BYTES");
s(appendBody !== null && /SCROLL_MAX_ENTRIES/.test(appendBody),
  "structural: scrollAppend bounds itself against SCROLL_MAX_ENTRIES");
s(appendBody !== null && /p\.role == 2 && role == 3/.test(appendBody),
  "structural: the result-after-ran spacer rule is in scrollAppend, by operand");

// The whole feature must be inside ONE #if, so board 1 never sees the TEXT of it.
s(/^\s*#if BOARD_HISTORY_SCROLL/m.test(INO), "structural: scrollback.ino opens with #if BOARD_HISTORY_SCROLL");
const guards = (INO.match(/#if BOARD_HISTORY_SCROLL/g) || []).length;
s(guards === 1, `structural: exactly ONE guard opens the file, not per-function (${guards})`);

// A #define, never a const int: #if on a C++ const int is silently false.
for (const h of ["board_es3c35p.h", "board_e32r28t.h"]) {
  const raw = fs.readFileSync(path.join(DIR, h), "utf8");
  s(/#define BOARD_HISTORY_SCROLL [01]/.test(raw),
    `structural: ${h} declares BOARD_HISTORY_SCROLL as a #define`);
  s(!/const int BOARD_HISTORY_SCROLL/.test(raw),
    `structural: ${h} does NOT declare it as a const int`);
}

// Every gutter marker is ASCII. Spleen declares 0x20..0x7E; anything else draws
// nothing AND advances nothing, the trap this repo has paid for repeatedly.
const markBody = fnBody(INO, "const char* scrollMark(uint8_t r)", "scrollback.ino");
s(markBody !== null, "structural: scrollMark is findable");
if (markBody) {
  const lits = [...markBody.matchAll(/"([^"]*)"/g)].map(x => x[1]);
  s(lits.length >= 5, `structural: scrollMark returns at least five markers (${lits.length})`);
  const wide = lits.filter(l => [...l].some(ch => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) > 0x7e));
  s(wide.length === 0,
    `structural: every gutter marker is ASCII 0x20..0x7E${wide.length ? ` - offending: ${JSON.stringify(wide)}` : ""}`);
  s(new Set(lits).size === lits.length, "structural: the markers are distinct shapes, one per role");
}

console.log(`\n${mirror} mirror + ${structural} structural assertions, ${fail} failures`);
if (SELFTEST) {
  const WANT = {
    "wrap-cap":    /scrollWrapLines carries NO line cap/,
    "no-reap":     /reapBleLinks/,
    "no-activity": /lastActivityMillis/,
    "seq-append":  /clears the arena/,
    "wide-marker": /every gutter marker is ASCII/,
  }[process.env.SB_FAULT || "wrap-cap"];
  const hit = FAILED.find(x => WANT.test(x));
  if (!hit) { console.log(`SELFTEST FAILED: fault ${process.env.SB_FAULT || "wrap-cap"} was not caught`); process.exit(1); }
  console.log(`selftest ok - caught by: ${hit}`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all scrollback store assertions pass");
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL — `scrollback.ino` does not exist, so the read throws. That is the correct failure; the next step creates it.

- [ ] **Step 3: Create `scrollback.ino` with the store, the wrap and the index**

```c
// ---------- Scrollback: board 2's scrolling transcript ----------
// ONE #if wraps the whole file, so board 1 never sees the TEXT of any of this -
// the same reason `#if !BOARD_USES_TFT_ESPI` wraps every tft.flush() site rather
// than a runtime no-op existing. A runtime guard would move board 1's binary.
#if BOARD_HISTORY_SCROLL

struct ScrollEntry {
  uint32_t off;        // byte offset into scrollText
  uint32_t lineFirst;  // cumulative line index of this entry's first line
  uint16_t lines;      // wrapped lines, NOT counting the spacer
  uint8_t  role;       // 0 you, 1 claude, 2 ran, 3 result, 4 denied/error
  uint8_t  spacer;     // 1 if a blank line follows this entry
};                     // 12 bytes

char*        scrollText = nullptr;     // PSRAM
ScrollEntry* scrollIdx  = nullptr;     // PSRAM
int      scrollCount = 0;              // entries held
uint32_t scrollTextUsed = 0;
uint32_t scrollTotalLines = 0;
int      scrollTotal = 0;              // entries in the whole filtered history
int      scrollDropped = 0;            // withheld at the head to fit the budget

const char* scrollMark(uint8_t r) {
  // ASCII ONLY. Claude Code's own markers are U+23FA and U+257C, and Spleen
  // declares 0x20..0x7E - an out-of-range codepoint draws NOTHING and advances
  // NOTHING, which is the trap this repo has paid for repeatedly (fitText's
  // ellipsis, the CLAUDE/air separator, the PAIRED MACS dot, the SETTINGS HOME
  // chevron, histFlatten's own truncation marker). Distinct SHAPES, so the
  // meaning does not rest on hue.
  switch (r) {
    case 0:  return ">";   // you
    case 1:  return "*";   // claude
    case 2:  return "$";   // ran a tool
    case 3:  return "|";   // its result
    default: return "!";   // denied / error
  }
}

uint16_t scrollMarkColor(uint8_t r) {
  switch (r) {
    case 0:  return COLOR_ACCENT;
    case 1:  return COLOR_GOOD;
    case 4:  return COLOR_BAD;
    default: return COLOR_LABEL;
  }
}
uint16_t scrollTextColor(uint8_t r) {
  return (r == 0 || r == 1) ? COLOR_VALUE : (r == 4 ? COLOR_BAD : COLOR_LABEL);
}

// Length of the line starting at `pos`, and whether it ended on a '\n'.
// MONOSPACE, so this is exact integer arithmetic with no width call at all -
// which matters twice: it runs once per entry over the whole transcript at fetch
// time, and it is what lets a JS mirror agree with it exactly. Every Spleen glyph
// in 0x20..0x7E has xOffset 0, width 8 and xAdvance 8, asserted in the header.
static int scrollLineLen(const char* t, int pos, int cols, bool* hardBreak) {
  *hardBreak = false;
  int i = 0;
  while (i < cols && t[pos + i] && t[pos + i] != '\n') i++;
  if (t[pos + i] == '\n') { *hardBreak = true; return i; }
  if (!t[pos + i]) return i;                 // the rest fits on this line
  // Word-friendly break: the last space in the lane's second half, the same rule
  // the shared wrapLineLen uses.
  for (int b = i; b > cols / 2; b--)
    if (t[pos + b - 1] == ' ') return b;
  return i;                                  // unbreakable word: never stall
}

// DELIBERATELY NOT countWrappedLines(). That helper stops at 80 lines and its
// wrapLineLen carries a `char buf[64]` capped at 60 characters, so a 4000-byte
// entry - 118 lines at 34 columns - cannot pass through it at all. Raising either
// would move board 1's binary for a board-2 feature.
int scrollWrapLines(const char* t, int cols) {
  if (!t[0]) return 1;                       // an empty entry still owns a line
  int pos = 0, lines = 0;
  while (t[pos]) {
    bool hard;
    int n = scrollLineLen(t, pos, cols, &hard);
    pos += n;
    if (hard && t[pos] == '\n') pos++;
    lines++;
    if (n == 0 && !hard) break;              // cannot happen; must not spin
  }
  return lines ? lines : 1;
}

// The `want`-th wrapped line of `t`, into `out`. O(lines) per call, so drawing
// the last line of a 118-line entry walks it - 26 lines x 118 is a few thousand
// iterations of a trivial loop per frame, which is nothing beside one flush.
bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize) {
  int pos = 0, line = 0;
  while (t[pos]) {
    bool hard;
    int n = scrollLineLen(t, pos, cols, &hard);
    if (line == want) {
      int cap = n < outSize - 1 ? n : outSize - 1;
      memcpy(out, t + pos, cap);
      out[cap] = '\0';
      return true;
    }
    pos += n;
    if (hard && t[pos] == '\n') pos++;
    line++;
    if (n == 0 && !hard) break;
  }
  out[0] = '\0';
  return false;
}

void scrollReset() {
  scrollCount = 0;
  scrollTextUsed = 0;
  scrollTotalLines = 0;
  scrollTotal = 0;
  scrollDropped = 0;
}

bool scrollBegin() {
  if (scrollText && scrollIdx) { scrollReset(); return true; }
  scrollText = (char*) heap_caps_malloc(SCROLL_TEXT_BYTES, MALLOC_CAP_SPIRAM);
  scrollIdx  = (ScrollEntry*) heap_caps_malloc(
      (size_t) SCROLL_MAX_ENTRIES * sizeof(ScrollEntry), MALLOC_CAP_SPIRAM);
  if (!scrollText || !scrollIdx) {
    // Report the cause. From the Mac a failed allocation and a failed fetch look
    // identical, which is the class POWERPROBE's `not on battery` refusal exists for.
    Serial.printf("SCROLL: PSRAM alloc failed (text=%p idx=%p)\n", scrollText, scrollIdx);
    scrollEnd();
    return false;
  }
  scrollReset();
  return true;
}

void scrollEnd() {
  if (scrollText) { heap_caps_free(scrollText); scrollText = nullptr; }
  if (scrollIdx)  { heap_caps_free(scrollIdx);  scrollIdx  = nullptr; }
  scrollReset();
}

const char* scrollTextAt(int i) { return scrollText + scrollIdx[i].off; }

bool scrollAppend(uint8_t role, const char* t) {
  if (!scrollText || !scrollIdx) return false;
  if (scrollCount >= SCROLL_MAX_ENTRIES) return false;
  int len = strlen(t);
  if (scrollTextUsed + (uint32_t) len + 1 > (uint32_t) SCROLL_TEXT_BYTES) return false;

  ScrollEntry& e = scrollIdx[scrollCount];
  e.off = scrollTextUsed;
  char* dst = scrollText + scrollTextUsed;
  // Blank every control byte EXCEPT '\n', the same sanitiser the ask detail uses,
  // so a code block keeps its structure if the host ever stops flattening.
  for (int k = 0; k < len; k++)
    dst[k] = ((uint8_t) t[k] < 0x20 && t[k] != '\n') ? ' ' : t[k];
  dst[len] = '\0';
  scrollTextUsed += (uint32_t) len + 1;

  e.role = role;
  e.lines = (uint16_t) scrollWrapLines(dst, SCROLL_COLS);
  e.spacer = 0;                              // the last entry has no trailing blank
  if (scrollCount == 0) {
    e.lineFirst = 0;
  } else {
    ScrollEntry& p = scrollIdx[scrollCount - 1];
    // The PREVIOUS entry's spacer is decided here, before this entry's lineFirst
    // is computed from it - which is what makes a streaming append correct.
    p.spacer = (p.role == 2 && role == 3) ? 0 : 1;
    e.lineFirst = p.lineFirst + p.lines + p.spacer;
  }
  scrollCount++;
  scrollTotalLines = e.lineFirst + e.lines;
  return true;
}

// The entry whose line range contains `line`. O(log n), so a frame never
// re-wraps from the top of the transcript.
int scrollEntryAtLine(uint32_t line) {
  int lo = 0, hi = scrollCount - 1, best = 0;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (scrollIdx[mid].lineFirst <= line) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

#endif  // BOARD_HISTORY_SCROLL
```

- [ ] **Step 4: Run the checker and watch it pass**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS, printing `N mirror + M structural assertions, 0 failures`. The `no-reap`, `no-activity` and `seq-append` structural assertions are added in Tasks 3 and 5; only the ones written above are present now, so remove those three from `WANT` until their tasks land, or leave them and accept that those selftest faults are not yet exercisable.

- [ ] **Step 5: Prove the checker has teeth on the two faults reachable now**

```bash
cd firmware/deckhand_display
SB_FAULT=wrap-cap    node scrollback-check.mjs --selftest; echo "exit=$? (expect 0)"
SB_FAULT=wide-marker node scrollback-check.mjs --selftest; echo "exit=$? (expect 0)"
```
Expected: each prints `selftest ok - caught by: ...` and exits 0. **An exit of 1 means the checker is blind to that fault**, which is the whole point of the flag.

- [ ] **Step 6: Compile both boards and check the baselines**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```
Expected: board 2 `UNCHANGED` or near it — nothing calls any of this yet, so `--gc-sections` strips it; a hash change at +0 bytes is the documented link-order relocation and is not evidence of anything being emitted. **Board 1 `UNCHANGED`** — the whole file is inside a false `#if`. Re-baseline board 2 with `--update 2` and say why in the commit message.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -F - <<'EOF'
Add the scrollback store, the wrap and the line index

The wrap deliberately does NOT reuse countWrappedLines(): that helper stops at
80 lines and its wrapLineLen carries a char buf[64] capped at 60 characters, so
a 4000-byte entry - 118 lines at 34 columns - cannot pass through it at all.
Raising either would move board 1's binary for a board-2 feature. The
replacement is exact integer arithmetic, which is available because every Spleen
glyph has xOffset + width == xAdvance; that also makes the JS mirror exact
rather than approximate.

lineFirst is what makes scrolling cheap: each entry's wrapped line count is
computed ONCE at append and accumulated, so mapping a pixel offset to a first
visible entry is a binary search. Without it every frame would re-wrap from the
top of the transcript.

The previous entry's spacer is decided when the next one arrives, before that
entry's lineFirst is computed from it - which is what makes a streaming append
correct rather than needing a second pass.

The checker reports its mirror and structural halves separately, because a
mirror proves the algorithm and would keep passing with scrollback.ino deleted.
Every structural assertion is bound to a function BODY, not to the file.
EOF
```

---

### Task 3: The wire — a chunked fetch that cannot blow the line guard

**Files:**
- Modify: `host/index.mjs` (add `sendScrollback`, extend the `HISTORY` dispatch near line 2573)
- Modify: `firmware/deckhand_display/scrollback.ino` (add `requestScrollback`)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (the `hist` parser's chunk arm, near line 3865)
- Modify: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `scrollBegin()`, `scrollReset()`, `scrollAppend()`, `scrollEnd()` from Task 2.
- Produces: `void requestScrollback(int idx)`; the globals `bool scrollPending`, `bool scrollFetchFailed`, `int scrollNextSeq`, `int scrollChunksOf`, `unsigned long scrollFetchStart`; host `async function sendScrollback(id, filter, maxBytes)`.

- [ ] **Step 1: Add the failing wire assertions to the checker**

Append to the structural half of `scrollback-check.mjs`:

```js
// THE CHUNK BUDGET IS ASSERTED AGAINST feedChar's GUARD, PARSED - not transcribed.
// That guard does not DROP an over-long line, it CLEARS THE BUFFER mid-line, so
// the remainder accumulates into an emptied buffer, the parse fails, and every
// tick carrying it is lost while both links look healthy.
const gm = SKETCH.match(/buf\.length\(\)\s*>=?\s*(\d+)/) || SKETCH.match(/(\d{5})\s*\)?\s*\{?\s*\/\/[^\n]*line guard/i);
s(gm != null, "structural: feedChar's line guard is still findable in the sketch");
if (gm) {
  s(c.SCROLL_WIRE_CHUNK_BYTES < +gm[1],
    `structural: the chunk budget (${c.SCROLL_WIRE_CHUNK_BYTES}) is under feedChar's guard (${gm[1]})`);
  // One entry must always fit ALONE: 4000 chars of pure newlines escape to 8000.
  const worst = 2 * 4000 + 400;
  s(worst <= c.SCROLL_WIRE_CHUNK_BYTES,
    `structural: a worst-case single entry (${worst}B fully escaped) fits one chunk`);
}

// The HOST measures the budget on the SERIALISED line, never on raw text length.
const HOSTSRC = stripComments(fs.readFileSync(path.join(DIR, "../../host/index.mjs"), "utf8"));
const sbBody = fnBody(HOSTSRC, "async function sendScrollback(id, filter, maxBytes)", "host/index.mjs");
s(sbBody !== null, "structural: sendScrollback is findable in the host");
s(sbBody !== null && /JSON\.stringify/.test(sbBody) && /byteLength/.test(sbBody),
  "structural: the host measures the chunk on the SERIALISED line, in BYTES");
s(sbBody !== null && /SCROLL_WIRE_CHUNK_BYTES|CHUNK_BYTES/.test(sbBody),
  "structural: the host bounds each chunk by the named budget");

// A seq discontinuity CLEARS rather than assembling a transcript with a hole.
const parseArm = SKETCH.match(/if \(!hist\["seq"\]\.isNull\(\)\)[\s\S]{0,1400}?\n    \}/);
s(parseArm != null, "structural: the chunk arm of the hist parser is findable");
s(parseArm != null && /scrollReset\(\)/.test(parseArm[0]) && /scrollFetchFailed/.test(parseArm[0]),
  "structural: a seq discontinuity clears the arena rather than appending into a hole");
s(parseArm != null && /seq != scrollNextSeq/.test(parseArm[0]),
  "structural: the discontinuity is tested on seq against the expected next, by operand");

// The request picks its budget by TRANSPORT - BLE cannot have the whole thing.
const reqBody = fnBody(INO, "void requestScrollback(int idx)", "scrollback.ino");
s(reqBody !== null && /usbLinkActive\(\)/.test(reqBody),
  "structural: the fetch budget is chosen by transport, not fixed");
s(reqBody !== null && /SCROLL_TAIL_BYTES_USB/.test(reqBody) && /SCROLL_TAIL_BYTES_BLE/.test(reqBody),
  "structural: both transport budgets are named constants");
```

- [ ] **Step 2: Run it and watch the new assertions fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL on `sendScrollback is findable`, the chunk-arm assertions and `requestScrollback` — none exists yet.

- [ ] **Step 3: Add the host's chunked sender**

In `host/index.mjs`, after `sendHistory` (near line 1540):

```js
// `HISTORY <id> <chat|all> tail:<maxBytes>` - the WHOLE filtered history, in a run of
// size-bounded lines. A third request form beside `<page|last>` and `item:<n>`, so board 1
// keeps its exact behaviour and no version bump is needed: the same backward-compatible
// shape as the optional `<cols>x<lines>` token and the trailing `to=<hostId>` address.
const SCROLL_WIRE_CHUNK_BYTES = 12000;   // mirrors board_es3c35p.h; asserted by scrollback-check.mjs

async function sendScrollback(id, filter, maxBytes) {
  const all = await histItems(id);
  const chatOnly = filter !== "all";
  const items = chatOnly ? all.filter((x) => x.r === "you" || x.r === "claude") : all;

  // Keep the NEWEST tail that fits. Walk backwards, because the entries a person is
  // most likely to want are the recent ones; `dropped` says how many did not make it,
  // and the device states that on the glass rather than letting the scroll end quietly.
  let used = 0, from = items.length;
  while (from > 0) {
    const n = Buffer.byteLength(items[from - 1].full, "utf8") + 1;
    if (used + n > maxBytes) break;
    used += n; from--;
  }
  const kept = items.slice(from);
  const dropped = from;

  const envelope = (arr, seq, of) =>
    JSON.stringify({
      hist: { id, f: chatOnly ? "chat" : "all", seq, of,
              total: items.length, dropped,
              items: arr.map((x) => ({ r: x.r, t: x.full })) },
    });

  // CHUNKED ON THE SERIALISED LENGTH, never on the sum of text lengths. JSON escaping
  // is not a rounding term: a newline becomes \n and DOUBLES, so a raw-length check
  // would let a newline-heavy transcript blow feedChar's 16000-BYTE guard - which does
  // not drop the line, it CLEARS THE BUFFER mid-line, losing every tick that carries it
  // while both links look perfectly healthy.
  const groups = [];
  let cur = [];
  for (const it of kept) {
    if (cur.length &&
        Buffer.byteLength(envelope(cur.concat([it]), 0, 9999), "utf8") > SCROLL_WIRE_CHUNK_BYTES) {
      groups.push(cur); cur = [it];
    } else {
      cur.push(it);
    }
  }
  if (cur.length || !groups.length) groups.push(cur);

  for (let i = 0; i < groups.length; i++) {
    const line = envelope(groups[i], i, groups.length) + "\n";
    // Belt and braces: a single entry can be big enough that even alone it approaches
    // the budget, so the built line is checked rather than assumed.
    if (Buffer.byteLength(line, "utf8") > SCROLL_WIRE_CHUNK_BYTES + 200)
      console.log(`Scrollback: WARNING chunk ${i} is ${Buffer.byteLength(line, "utf8")} bytes`);
    if (usbPort) usbPort.write(line);
    else if (bleCharacteristic) await sendOverBle(line);
  }
  console.log(
    `Scrollback: ${id} ${chatOnly ? "chat" : "all"} ${kept.length} of ${items.length} entries ` +
      `(${dropped} dropped, ${groups.length} chunks, ${used} bytes) via ${usbPort ? "usb" : "ble"}`
  );
}
```

- [ ] **Step 4: Route the new request form**

In `host/index.mjs`, replace the two dispatch lines near 2580:

```js
    if (want.startsWith("tail:"))
      await sendScrollback(id, filter, Number.parseInt(want.slice(5), 10) || 65536);
    else if (want.startsWith("item:"))
      await sendHistoryItem(id, filter, Number.parseInt(want.slice(5), 10) || 0);
    else await sendHistory(id, filter, want, histBudget(budgetTok));
```

- [ ] **Step 5: Add the device's request and its fetch state**

In `scrollback.ino`, inside the `#if`, after the store:

```c
bool scrollActive = false;        // the transcript owns the screen
bool scrollPending = false;       // a fetch is in flight
bool scrollFetchFailed = false;
int  scrollNextSeq = 0;
int  scrollChunksOf = 1;
int  scrollChunksIn = 0;
unsigned long scrollFetchStart = 0;
uint32_t scrollY = 0;             // pixel scroll offset from the top of the transcript

void requestScrollback(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  if (!scrollBegin()) { scrollFetchFailed = true; return; }
  // BLE genuinely cannot have the whole thing: 122KB at ~666 B/s is over three
  // minutes. It gets a bounded tail and the wait is STATED, not hidden.
  const long budget = usbLinkActive() ? SCROLL_TAIL_BYTES_USB : SCROLL_TAIL_BYTES_BLE;
  scrollPending = true;
  scrollFetchFailed = false;
  scrollNextSeq = 0;
  scrollChunksIn = 0;
  scrollChunksOf = 1;
  scrollFetchStart = millis();
  char line[72];
  snprintf(line, sizeof(line), "HISTORY %s %s tail:%ld", sessions[idx].id,
           histChatOnly ? "chat" : "all", budget);
  // Addressed to the session's own Mac - only it holds that transcript.
  sendLineToHost(line, sessions[idx].hostSlot);
}

// Called from loop(). A stalled fetch must say so rather than leaving
// "fetching" on the glass forever.
void tickScrollFetch() {
  if (!scrollPending) return;
  const unsigned long cap = usbLinkActive() ? SCROLL_FETCH_TIMEOUT_MS : SCROLL_FETCH_TIMEOUT_BLE_MS;
  if (millis() - scrollFetchStart < cap) return;
  Serial.printf("SCROLL: fetch timed out after %lums (%d/%d chunks)\n",
                millis() - scrollFetchStart, scrollChunksIn, scrollChunksOf);
  scrollPending = false;
  scrollFetchFailed = true;
  if (scrollActive) drawScrollback();
}
```

- [ ] **Step 6: Add the chunk arm to the `hist` parser**

In `deckhand_display.ino`, immediately after the `histId` copy and **before** the `full` block (near line 3848), so the chunk reply is handled before any page state is touched — the same ordering the `full` reply already needs, and for the same reason:

```c
#if BOARD_HISTORY_SCROLL
    // THE CHUNKED SCROLLBACK FETCH, identified by `seq`. Handled before the page
    // state for the same reason the `full` reply is: a parser that mutates shared
    // state before it has identified the message is the bug class this file
    // already paid for once, when clearing histCount up here blanked the list.
    if (!hist["seq"].isNull()) {
      int seq = hist["seq"] | 0;
      int of  = hist["of"]  | 1;
      if (seq == 0) scrollReset();
      if (seq != scrollNextSeq) {
        // A HOLE. Clear rather than assemble a transcript with a gap in it: a
        // gap would read as the conversation having jumped, which is worse than
        // a named failure.
        Serial.printf("SCROLL: seq %d, expected %d - fetch abandoned\n", seq, scrollNextSeq);
        scrollReset();
        scrollPending = false;
        scrollFetchFailed = true;
        if (scrollActive) drawScrollback();
        return;
      }
      JsonArray sitems = hist["items"].as<JsonArray>();
      if (!sitems.isNull()) {
        for (JsonObject it : sitems) {
          const char* t = it["t"] | "";
          const char* r = it["r"] | "out";
          uint8_t role = strcmp(r, "you") == 0      ? 0
                         : strcmp(r, "claude") == 0 ? 1
                         : strcmp(r, "ran") == 0    ? 2
                         : strcmp(r, "no") == 0     ? 4
                                                    : 3;
          if (!scrollAppend(role, t)) break;   // arena or index full: keep what fits
        }
      }
      scrollNextSeq = seq + 1;
      scrollChunksIn = seq + 1;
      scrollChunksOf = of;
      scrollTotal   = hist["total"]   | 0;
      scrollDropped = hist["dropped"] | 0;
      if (seq + 1 >= of) {
        scrollPending = false;
        scrollY = scrollMaxY();              // opens at the NEWEST
        Serial.printf("SCROLL: %d entries, %lu lines, %d dropped\n",
                      scrollCount, (unsigned long) scrollTotalLines, scrollDropped);
      }
      if (scrollActive) drawScrollback();
      return;
    }
#endif
```

- [ ] **Step 7: Add `tickScrollFetch()` to `loop()`**

In `deckhand_display.ino`'s `loop()`, beside the other tick calls:

```c
#if BOARD_HISTORY_SCROLL
  tickScrollFetch();
#endif
```

- [ ] **Step 8: Run the checker and watch it pass**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS. `drawScrollback()` and `scrollMaxY()` do not exist yet, so **the sketch will not compile until Task 4** — add temporary forward stubs at the top of `scrollback.ino`'s `#if` block for this task only:

```c
void drawScrollback();      // Task 4
uint32_t scrollMaxY();      // Task 4
```

and implement them in Task 4. Note them in the commit message so the next reviewer knows they are deliberate.

- [ ] **Step 9: Add the two stubs' bodies so this task compiles standalone**

```c
// TEMPORARY, replaced in Task 4. A task must compile and be reviewable on its own.
uint32_t scrollMaxY() {
  uint32_t total = scrollTotalLines * CODE_LINE_H;
  uint32_t view = (uint32_t) SCROLL_LINES * CODE_LINE_H;
  return total > view ? total - view : 0;
}
void drawScrollback() { }
```

- [ ] **Step 10: Verify on hardware that a transcript lands**

```bash
./flash.sh --board 2
# open a session's history from the detail screen, then read the log
tail -40 /tmp/deckhand-$(id -u)/host.log | grep -E 'Scrollback|SCROLL:'
```
Expected: a host line naming the entry count, the dropped count and the chunk count, and a device line `SCROLL: N entries, M lines, D dropped` with `M` far larger than 26. **The screen still draws the old pager** — `drawScrollback()` is empty — which is correct for this task.

- [ ] **Step 11: Check both baselines and commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/deckhand_display.ino \
        firmware/deckhand_display/scrollback-check.mjs host/index.mjs firmware/board-baseline.json
git commit -F - <<'EOF'
Fetch the whole transcript into PSRAM in bounded chunks

A 262144-byte fetch cannot be one JSON line. feedChar's guard is 16000 BYTES and
it does not DROP an over-long line - it CLEARS THE BUFFER mid-line, so the
remainder accumulates into an emptied buffer, the parse fails, and every tick
carrying it is lost while both links look healthy. So the reply is a sequence.

The chunk budget is measured on the SERIALISED line, never on the sum of the
entries' text lengths: escaping is not a rounding term, since a newline becomes
\n and DOUBLES. A raw-length check would pass while the line blew the guard.

A seq discontinuity CLEARS the arena rather than appending into a hole - a gap
reads as the conversation having jumped, which is worse than a named failure.

`tail:` is a third request form beside <page|last> and item:<n>, so board 1
keeps its exact behaviour with no version bump - the same backward-compatible
shape as the optional <cols>x<lines> token.

drawScrollback() and scrollMaxY() are deliberate temporary stubs so this task
compiles and reviews standalone; Task 4 replaces them. Board 1 UNCHANGED.
EOF
```

---

### Task 4: The renderer, and the measurement that decides the scroll path

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino`
- Modify: `firmware/deckhand_display/reader.ino` (board-2 arm of `drawHistory`)
- Modify: `firmware/deckhand_display/deckhand_display.ino` (the `SCROLLPERF` command)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: `void drawScrollback()`, `uint32_t scrollMaxY()`, `void scrollDrawBody()`, and the `SCROLLPERF` command.

**This task refines the spec's ordering, deliberately.** The spec says the first task is a measurement. Measuring the REAL renderer is strictly better than measuring a synthetic one, and the simple render path is what gets built either way — the measurement only decides whether to ADD the `memmove` optimisation. So the renderer is built on the simple path and measured as this task's last step, before Task 5's drag loop commits to it.

- [ ] **Step 1: Replace the stubs with the real renderer**

In `scrollback.ino`:

```c
uint32_t scrollMaxY() {
  uint32_t total = scrollTotalLines * CODE_LINE_H;
  uint32_t view  = (uint32_t) SCROLL_LINES * CODE_LINE_H;
  return total > view ? total - view : 0;
}

// One dim centred line, for every state that is not a transcript. Each names its
// own cause: from the Mac "there is no more history" and "I cannot fetch the rest
// here" look identical, which is the class POWERPROBE's refusal exists for.
static void scrollNote(const char* s, int y) {
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(s, tft.width() / 2, y + CODE_LINE_H / 2);
  tft.setTextDatum(TL_DATUM);
}

// The body only. Kept separate from the chrome so a scroll frame repaints just
// this - the chrome is static between fetches.
void scrollDrawBody() {
  tft.fillRect(0, SCROLL_TOP, tft.width(), SCROLL_BOT - SCROLL_TOP, COLOR_BG);

  if (scrollPending) {
    char b[40];
    if (usbLinkActive()) snprintf(b, sizeof(b), "-- fetching %d/%d --", scrollChunksIn, scrollChunksOf);
    else snprintf(b, sizeof(b), "-- fetching over Bluetooth --");
    scrollNote(b, (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }
  if (scrollFetchFailed) {
    scrollNote("-- could not reach the Mac --", (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }
  if (scrollCount == 0) {
    scrollNote("-- nothing here --", (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }

  const uint32_t y0 = scrollY;
  const int firstLine = (int) (y0 / CODE_LINE_H);
  const int subPx = (int) (y0 % CODE_LINE_H);

  // The head note sits ABOVE line 0, so it is only drawn when the transcript is
  // scrolled to its very top.
  if (y0 == 0) {
    if (scrollDropped > 0) {
      char b[40];
      snprintf(b, sizeof(b), "-- %d older need USB --", scrollDropped);
      scrollNote(b, SCROLL_TOP);
    } else {
      scrollNote("-- start of history --", SCROLL_TOP);
    }
  }

  char buf[SCROLL_COLS + 2];
  int ei = scrollEntryAtLine((uint32_t) firstLine);
  for (int row = 0; row <= SCROLL_LINES; row++) {
    const int line = firstLine + row;
    if (line < 0 || (uint32_t) line >= scrollTotalLines) break;
    // Advance to the entry owning this line. The index makes this a walk of at
    // most one entry per row rather than a search per row.
    while (ei + 1 < scrollCount && scrollIdx[ei + 1].lineFirst <= (uint32_t) line) ei++;
    const ScrollEntry& e = scrollIdx[ei];
    const int k = line - (int) e.lineFirst;
    if (k >= e.lines) continue;                      // the spacer: draw nothing

    const int y = SCROLL_TOP + row * CODE_LINE_H - subPx;
    // The bottom edge is clipped at the CALL SITE. pushImage clips a negative y
    // correctly by offsetting its source pointer, but drawString clips only to
    // the SCREEN, so without this a line at the edge spills into the bottom air.
    if (y + CODE_LINE_H <= SCROLL_TOP) continue;
    if (y >= SCROLL_BOT) break;

    // Roles 2/3/4 are one line, clipped with THREE ASCII DOTS - never U+2026,
    // which is outside Spleen's range and would give a truncated line no visible
    // sign that anything was missing.
    if (e.role >= 2) {
      if (k > 0) continue;
      const char* t = scrollTextAt(ei);
      int n = strlen(t);
      if (n > SCROLL_COLS) {
        memcpy(buf, t, SCROLL_COLS - 3);
        buf[SCROLL_COLS - 3] = '\0';
        strcat(buf, "...");
      } else {
        strncpy(buf, t, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
      }
    } else {
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf));
    }

    setUIFont(1);
    if (k == 0) {
      tft.setTextColor(scrollMarkColor(e.role), COLOR_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(scrollMark(e.role), SCROLL_GUT_X, y);
    }
    tft.setTextColor(scrollTextColor(e.role), COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(buf, SCROLL_TXT_X, y);
  }

  // THE RAIL, drawn only when there is more than a screenful - so a three-message
  // session shows none. It replaces a 46px scrubber band with 4px of ink, and it
  // is the only thing that answers "how much is above me" continuously.
  const uint32_t maxY = scrollMaxY();
  if (maxY > 0) {
    const int h = SCROLL_BOT - SCROLL_TOP;
    tft.fillRect(SCROLL_RAIL_X, SCROLL_TOP, SCROLL_RAIL_W, h, COLOR_CARD);
    int kh = (int) ((long) h * h / (long) (scrollTotalLines * CODE_LINE_H));
    if (kh < 24) kh = 24;
    int ky = SCROLL_TOP + (int) ((long) (h - kh) * y0 / maxY);
    tft.fillRect(SCROLL_RAIL_X, ky, SCROLL_RAIL_W, kh, COLOR_ACCENT);
  }
}

void drawScrollback() {
  tft.fillScreen(COLOR_BG);

  // The back key carries the CLOSE the deleted button row used to provide.
  uiStrokeRound(SCROLL_BACK_X, HIST_CHIP_Y, SCROLL_BACK_W, HIST_CHIP_H, 3,
                BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("<", SCROLL_BACK_X + SCROLL_BACK_W / 2, HIST_CHIP_Y + HIST_CHIP_H / 2);
  tft.setTextDatum(TL_DATUM);

  // Name and counter are the same 16px cell - Spleen's smallest rung - so they are
  // separated by COLOUR and POSITION, never by size, the rule the rest of the
  // device follows.
  if (detailIndex >= 0 && detailIndex < sessionCount) {
    char nm[SCROLL_NAME_COLS + 1];
    strncpy(nm, sessions[detailIndex].name, SCROLL_NAME_COLS);
    nm[SCROLL_NAME_COLS] = '\0';
    setUIFont(2);
    tft.setTextColor(COLOR_VALUE, COLOR_BG);
    tft.drawString(nm, SCROLL_NAME_X, 12);
  }
  char pos[24];
  if (scrollPending) snprintf(pos, sizeof(pos), "...");
  else if (scrollCount > 0) {
    // Which entry the top visible line belongs to, out of the whole filtered
    // history - the same claim the pager's "412/628" makes.
    int ei = scrollEntryAtLine(scrollY / CODE_LINE_H);
    snprintf(pos, sizeof(pos), "%d/%d", scrollDropped + ei + 1, scrollTotal);
  } else snprintf(pos, sizeof(pos), "0/0");
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString(pos, SCROLL_NAME_X, 30);

  const char* chip = histChatOnly ? "CHAT" : "ALL";
  int chipW = histChatOnly ? HIST_CHIP_W_CHAT : HIST_CHIP_W_ALL;
  int chipX = tft.width() - 12 - chipW;
  uiFillRound(chipX, HIST_CHIP_Y, chipW, HIST_CHIP_H, 3, COLOR_ACCENT, COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_BG, COLOR_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(chip, chipX + chipW / 2, HIST_CHIP_CY);
  tft.setTextDatum(TL_DATUM);

  tft.drawFastHLine(0, HIST_RULE_Y, tft.width(), COLOR_LABEL);
  scrollDrawBody();
  tft.flush();
}
```

- [ ] **Step 2: Make `drawHistory()` delegate on board 2**

In `reader.ino`, wrap the whole existing `drawHistory()` body so board 2 never sees the pager's text:

```c
void drawHistory() {
#if BOARD_HISTORY_SCROLL
  drawScrollback();
  return;
#else
  ... the entire existing body, unchanged ...
#endif
}
```

- [ ] **Step 3: Add `SCROLLPERF`, which measures the frame AND is the headless trigger**

In `deckhand_display.ino`'s command dispatch, beside `READTEST`:

```c
#if BOARD_HISTORY_SCROLL
  // SCROLLPERF exists for the reason PERF, TEXTPROBE and READTEST do: this screen
  // is otherwise unverifiable without a finger, and SCREENSHOT can only record
  // what is already on the glass. It opens the transcript on the first session
  // that has one, then times N frames of scrolling - compose and flush SEPARATELY,
  // because this repo's own history says the instinct about which dominates is
  // unreliable (the USAGE tab's 888ms was assumed to be flush-bound and was AA
  // primitives). Both refusals print their cause.
  if (line.startsWith("SCROLLPERF")) {
    if (sessionCount == 0) { Serial.println("SCROLLPERF: no sessions"); return; }
    if (kbActive || readerActive || voiceCardActive || octoActive || emojiTestActive) {
      Serial.println("SCROLLPERF: another full-screen surface is up"); return;
    }
    switchTab(TAB_SESSIONS);
    openSessionDetail(0);
    openScrollback(0);
    unsigned long t0 = millis();
    while (scrollPending && millis() - t0 < 20000) { pumpStream(); delay(10); }
    if (scrollPending) { Serial.println("SCROLLPERF: fetch did not complete"); return; }
    const int FRAMES = 20;
    unsigned long compose = 0, flushT = 0;
    for (int i = 0; i < FRAMES; i++) {
      scrollY = (uint32_t) ((long) scrollMaxY() * i / (FRAMES - 1));
      unsigned long a = micros(); scrollDrawBody();  unsigned long b = micros();
      tft.flush();                                   unsigned long c = micros();
      compose += b - a; flushT += c - b;
    }
    Serial.printf("SCROLLPERF: %d frames  compose %luus  flush %luus  frame %luus (%lu fps)\n",
                  FRAMES, compose / FRAMES, flushT / FRAMES,
                  (compose + flushT) / FRAMES, 1000000UL / ((compose + flushT) / FRAMES));
    return;
  }
#endif
```

- [ ] **Step 4: Compile board 2 and flash**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
./flash.sh --board 2
```
Expected: compiles. `openScrollback` does not exist until Task 5 — add it now as the minimal opener, since `SCROLLPERF` needs it:

```c
void openScrollback(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  scrollActive = true;
  scrollY = 0;
  requestScrollback(idx);
  drawScrollback();
}
```

- [ ] **Step 5: MEASURE, and record the number**

```bash
echo "SCROLLPERF" > ~/.claude/deckhand-device-command
sleep 30 && grep SCROLLPERF /tmp/deckhand-$(id -u)/host.log | tail -3
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 5 && ls -t ~/Deckhand-shots/*.png | head -1
```
Record the `compose` / `flush` / `frame` figures **in the commit message and in the ledger.** They decide Task 7:

| Measured frame | Decision |
|---|---|
| under 40000us (25fps or better) | Task 7 is NOT needed. Say so explicitly. |
| 40000us or more | Task 7 runs: add `PanelShim::scrollRect` and draw only the exposed band. |

- [ ] **Step 6: Check board 1 and commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
git add firmware/deckhand_display/
git commit -F - <<'EOF'
Render the transcript, and measure the frame it costs

MEASURED with SCROLLPERF on hardware: compose <N>us, flush <N>us, frame <N>us
(<N> fps). Compose and flush are timed SEPARATELY because this repo's own
history says the instinct about which dominates is unreliable - the USAGE tab's
888ms was assumed to be flush-bound and turned out to be AA primitives.

<Say here whether the memmove optimisation is needed, and why.>

SCROLLPERF earns its place twice: it is the measurement, and it is the headless
trigger this screen otherwise lacks, since SCREENSHOT can only record what is
already on the glass and there is deliberately no remote tap.

The bottom edge is clipped at the CALL SITE. pushImage clips a negative y
correctly by offsetting its source row pointer, but drawString clips only to the
screen, so without it a line at the edge spills into the bottom air.

drawHistory() delegates on board 2 with the pager in the #else, so board 1 never
sees the text of any of this: UNCHANGED.
EOF
```

---

### Task 5: Touch — the drag loop, the rail tap, and open/close

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino`
- Modify: `firmware/deckhand_display/reader.ino` (board-2 arm of `handleHistoryTouch`)
- Modify: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `drawScrollback()`, `scrollDrawBody()`, `scrollMaxY()`, `scrollY`, `requestScrollback()`.
- Produces: `void openScrollback(int idx)`, `void exitScrollback()`, `bool handleScrollTouch(int sx, int sy)`, `void scrollDragLoop(int sy0)`.

- [ ] **Step 1: Add the failing touch assertions**

Append to `scrollback-check.mjs`'s structural half:

```js
// THE DRAG LOOP'S OBLIGATIONS. It blocks loop(), the pattern micMonitor,
// micStream and runCalibration already use - so it inherits their duties, and
// each has a named failure if it is missing.
const dragBody = fnBody(INO, "void scrollDragLoop(int sy0)", "scrollback.ino");
s(dragBody !== null, "structural: scrollDragLoop is findable");
s(dragBody !== null && /reapBleLinks\(true\)/.test(dragBody),
  "structural: the drag loop reaps BLE links - drainBleRx only runs from loop()");
s(dragBody !== null && /lastActivityMillis = millis\(\)/.test(dragBody),
  "structural: the drag loop refreshes lastActivityMillis, or the backlight blanks mid-drag");
s(dragBody !== null && /getTouchPoint/.test(dragBody),
  "structural: the drag loop polls getTouchPoint rather than touchPressed alone");

// ONE predicate for "is this a tap", read by the loop and by the hit test - the
// classic defect here is a control drawn under one condition and hit-tested under
// another, so a second spelling is forbidden rather than merely avoided.
const touchBody = fnBody(INO, "bool handleScrollTouch(int sx, int sy)", "scrollback.ino");
s(touchBody !== null, "structural: handleScrollTouch is findable");
s(touchBody !== null && /SCROLL_TAP_SLOP_PX/.test(dragBody || ""),
  "structural: the tap/drag threshold is the named constant, in the loop that measures it");
s(touchBody !== null && /SCROLL_RAIL_TAP_X/.test(touchBody),
  "structural: the rail's tap zone is the named constant");

// Closing must restore the surface underneath, and clear the PSRAM.
const exitBody = fnBody(INO, "void exitScrollback()", "scrollback.ino");
s(exitBody !== null && /scrollEnd\(\)/.test(exitBody),
  "structural: exiting frees the PSRAM store rather than holding 304KB forever");
s(exitBody !== null && /scrollActive = false/.test(exitBody),
  "structural: exiting clears scrollActive");
```

- [ ] **Step 2: Run it and watch the new assertions fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL on all six — none of those functions exists yet.

- [ ] **Step 3: Write the drag loop and the hit test**

In `scrollback.ino`:

```c
// A BLOCKING loop, the pattern micMonitor, micStream and runCalibration already
// use - chosen over extending handleTouch() for two reasons. handleTouch() is
// SHARED CODE and returns immediately on `touching && wasTouching` ("a finger
// still down has nothing left to do"), so putting drag state there risks board
// 1's binary for a board-2 feature. And the precedent already exists three times.
void scrollDragLoop(int sy0) {
  int lastY = sy0;
  int moved = 0;
  const uint32_t maxY = scrollMaxY();
  while (true) {
    // drainBleRx() only runs from loop(), so for the whole drag nothing else
    // would reap a pending BLE slot - leaving the device un-advertised with no
    // log line saying why. Every existing blocking loop does this.
    reapBleLinks(true);
    // The 30s backlight blank sits well inside a drag's life, and the waking tap
    // would be swallowed rather than scrolling. The keyboard needed exactly this.
    lastActivityMillis = millis();

    int sx, sy;
    if (!getTouchPoint(sx, sy)) break;         // released: the drag is over
    int dy = lastY - sy;                       // finger up scrolls content up
    if (dy != 0) {
      moved += dy < 0 ? -dy : dy;
      long ny = (long) scrollY + dy;
      if (ny < 0) ny = 0;
      if (ny > (long) maxY) ny = maxY;
      if ((uint32_t) ny != scrollY) {
        scrollY = (uint32_t) ny;
        scrollDrawBody();
        tft.flush();
      }
      lastY = sy;
    }
    // 15ms, matching handleTouch()'s own rate. getTouchPoint costs 1125us, so
    // that is 7.5% of the interval, on a bus the TFT does not share.
    delay(15);
  }
  // A TAP IS A DRAG THAT MOVED LESS THAN THIS. Without a named threshold "tap the
  // rail" and "drag anywhere" are not separable, because every tap moves a pixel
  // or two on a capacitive panel.
  if (moved < SCROLL_TAP_SLOP_PX && sy0 >= SCROLL_TOP && sy0 < SCROLL_BOT) {
    // Only the rail's zone does anything on a tap; the body deliberately has no
    // tap action at all, which is why there is no tap/drag ambiguity to resolve.
    int sx, sy;
    (void) getTouchPoint(sx, sy);
    if (scrollTapX >= SCROLL_RAIL_TAP_X && maxY > 0) {
      long f = (long) (sy0 - SCROLL_TOP) * (long) maxY / (SCROLL_BOT - SCROLL_TOP - 1);
      scrollY = (uint32_t) (f < 0 ? 0 : (f > (long) maxY ? (long) maxY : f));
      scrollDrawBody();
      tft.flush();
    }
  }
}

bool handleScrollTouch(int sx, int sy) {
  if (sy <= HIST_CHIP_TAP_H) {
    if (sx < SCROLL_BACK_X + SCROLL_BACK_W + 8) { exitScrollback(); return true; }
    if (sx >= tft.width() - 12 - HIST_CHIP_W_CHAT - 8) {
      histChatOnly = !histChatOnly;
      scrollY = 0;
      requestScrollback(detailIndex);   // entry counts differ per filter
      drawScrollback();
      return true;
    }
    return true;
  }
  if (sy >= SCROLL_TOP && sy < SCROLL_BOT && !scrollPending) {
    scrollTapX = sx;
    scrollDragLoop(sy);
    return true;
  }
  return true;
}

void exitScrollback() {
  scrollActive = false;
  scrollEnd();                    // 304KB of PSRAM back; only one session is ever open
  histActive = false;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (showingDetail && detailIndex >= 0 && detailIndex < sessionCount) {
    drawSessionDetail(detailIndex);
    buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
  } else {
    drawSessionsAll();
  }
  renderFooter();
  tft.flush();
}
```

Add `int scrollTapX = 0;` to the globals block.

- [ ] **Step 4: Delegate the touch handler and the opener on board 2**

In `reader.ino`, wrap `handleHistoryTouch`:

```c
bool handleHistoryTouch(int sx, int sy) {
#if BOARD_HISTORY_SCROLL
  return handleScrollTouch(sx, sy);
#else
  ... the entire existing body, unchanged ...
#endif
}
```

and `openHistory` / `exitHistory`:

```c
void openHistory(int idx) {
#if BOARD_HISTORY_SCROLL
  histActive = true;                       // handleTouch dispatches on this
  strncpy(histId, sessions[idx].id, sizeof(histId) - 1);
  histId[sizeof(histId) - 1] = '\0';
  openScrollback(idx);
  return;
#else
  ... existing body ...
#endif
}
void exitHistory() {
#if BOARD_HISTORY_SCROLL
  exitScrollback();
  return;
#else
  ... existing body ...
#endif
}
```

- [ ] **Step 5: Run the checker and watch it pass**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS.

- [ ] **Step 6: Prove the three drag-loop faults are caught**

```bash
cd firmware/deckhand_display
for f in no-reap no-activity seq-append; do
  echo "--- $f ---"; SB_FAULT=$f node scrollback-check.mjs --selftest; echo "exit=$?"
done
```
Expected: each exits 0 with `selftest ok - caught by: ...`.

- [ ] **Step 7: Verify on the glass**

```bash
./flash.sh --board 2
echo "SCROLLPERF" > ~/.claude/deckhand-device-command   # opens it headlessly
sleep 30; echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 5; ls -t ~/Deckhand-shots/*.png | head -1
```
Then **by hand on the device**: drag the body up and down, tap the rail's right edge, tap the filter chip, tap `<`. Confirm the transcript scrolls, the rail tracks, the filter re-fetches, and the back key returns to the detail screen. **This is the part no assertion covers** — record what was actually done.

- [ ] **Step 8: Check board 1 and commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
git add firmware/deckhand_display/
git commit -F - <<'EOF'
Scroll it with a finger

The drag is a BLOCKING loop inside the reader, not an extension of
handleTouch(). handleTouch() is shared code and returns immediately on
`touching && wasTouching` - "a finger still down has nothing left to do" - so
drag state there would risk board 1's binary for a board-2 feature. The blocking
pattern already exists three times (micMonitor, micStream, runCalibration), and
this loop inherits its obligations: reapBleLinks(true) every iteration, because
drainBleRx only runs from loop() and a pending slot would otherwise leave the
device un-advertised with nothing logged; and lastActivityMillis, or the 30s
blank fires mid-drag and the waking tap is swallowed instead of scrolling.

A TAP IS A DRAG THAT MOVED LESS THAN SCROLL_TAP_SLOP_PX. Naming that threshold
is what makes "tap the rail" and "drag anywhere" separable at all, since every
tap moves a pixel or two on a capacitive panel. The body has no tap action, so
there is no further ambiguity to resolve.

Exiting frees the 304KB store: only one session's history is ever open.

Verified BY HAND on the glass - drag, rail tap, filter toggle and back key - as
well as headlessly through SCROLLPERF. Board 1 UNCHANGED.
EOF
```

---

### Task 6: Drop the full-entry pager from board 2's build

**Files:**
- Modify: `firmware/deckhand_display/reader.ino`
- Modify: `firmware/deckhand_display/deckhand_display.ino`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task only narrows what board 2 compiles.

- [ ] **Step 1: Guard the full-entry pager**

In `reader.ino`, wrap `drawHistFull()` and `handleHistFullTouch()` entirely:

```c
#if !BOARD_HISTORY_SCROLL
void drawHistFull() { ... unchanged ... }
bool handleHistFullTouch(int sx, int sy) { ... unchanged ... }
#endif
```

In `deckhand_display.ino`, guard the `full` arm of the `hist` parser and the `histFullActive` dispatch:

```c
#if !BOARD_HISTORY_SCROLL
    JsonObject full = hist["full"];
    if (!full.isNull()) { ... unchanged ... }
#endif
```

```c
  if (histActive) {
#if BOARD_HISTORY_SCROLL
    handleScrollTouch(sx, sy);
#else
    if (histFullActive) handleHistFullTouch(sx, sy);
    else handleHistoryTouch(sx, sy);
#endif
```

- [ ] **Step 2: Guard the board-2 half of the reader's static_asserts**

In `reader.ino`, the `#else` arm's `static_assert` constrains a page the device no longer draws. Replace it:

```c
#elif !BOARD_HISTORY_SCROLL
  ... the existing board-2 page-fits-the-arena assert, unchanged ...
#else
// Board 2 no longer draws a PAGE at all: the transcript lives in PSRAM and the
// arena is board 1's. So the bound that matters here is the RENDER buffer, not a
// page - one wrapped line plus its NUL.
static_assert(SCROLL_COLS + 2 <= 64,
              "the scrollback line buffer must hold one wrapped line plus its NUL");
#endif
```

- [ ] **Step 3: Guard the now-unused globals**

In `deckhand_display.ino`, wrap the board-1-only history globals so board 2 stops carrying them:

```c
#if !BOARD_HISTORY_SCROLL
char histFull[HIST_FULL_MAX];
uint8_t histFullRole = 0;
int histFullPage = 0;
bool histFullActive = false;
int histRowY[HIST_MAX + 1];
#endif
```

**Check each one's call sites first.** `histPage`, `histPages`, `histFrom` and `histTotal` are read by `drawHistory`'s board-1 arm and written by the parser's page arm; if any is still referenced from shared code, leave it and say so in the commit rather than guarding it and adding an `#if` at the use site.

- [ ] **Step 4: Compile board 2 and record the saving**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display 2>&1 | grep -E 'Sketch uses|Global variables'
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```
Expected: flash and RAM both DOWN — `histFull[4000]` alone is 4000 bytes of DRAM. Record the delta.

- [ ] **Step 5: Check board 1 is untouched**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```
Expected: `UNCHANGED`. Everything here is `#if !BOARD_HISTORY_SCROLL`, i.e. board 1 compiles exactly the arm it always had. **A `CHANGED` at `+0 bytes` here means a guard changed board 1's codegen without changing its size** — the case the retired size check could not see. Find it before proceeding.

- [ ] **Step 6: Verify on the glass that nothing regressed**

```bash
./flash.sh --board 2
echo "SCROLLPERF" > ~/.claude/deckhand-device-command
sleep 30; grep -E 'SCROLLPERF|SCROLL:' /tmp/deckhand-$(id -u)/host.log | tail -3
```
Then by hand: open a session's history, scroll, toggle the filter, close. Confirm the frame figure has not moved and no screen is missing.

- [ ] **Step 7: Run every checker**

```bash
cd firmware/deckhand_display
for f in usage-geom-check sessions-geom-check settings-geom-check sessions-rank-check scrollback-check; do
  echo "--- $f ---"; node $f.mjs >/dev/null && echo ok || echo FAIL
done
python3 usage-trend-check.py >/dev/null && echo "usage-trend ok"
python3 batt-trend-check.py >/dev/null && echo "batt-trend ok"
node ../../docs/design/scrollback/check.mjs >/dev/null && echo "mock bind ok"
node geom-sweep.mjs 2>&1 | tail -20
```

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/ firmware/board-baseline.json
git commit -F - <<'EOF'
Drop the full-entry pager from board 2's build

Full text is inline now, so the second-level pager is redundant: it existed only
because a message taller than one page was otherwise unreachable. Board 2 stops
compiling drawHistFull, handleHistFullTouch, the `full` arm of the hist parser
and histFull[4000] - which is 4000 bytes of DRAM on its own.

NOTHING IS DELETED FROM THE REPOSITORY. Board 1 keeps every line of it, and the
host keeps sendHistoryItem and the item:<n> verb, because the host serves both
boards and branches on the request form.

Board 2: <delta> flash, <delta> RAM. Board 1 UNCHANGED - every guard here is
#if !BOARD_HISTORY_SCROLL, so it compiles exactly the arm it always had.
EOF
```

---

### Task 7 (CONDITIONAL — only if Task 4 measured 40000us or more per frame)

**Run this task only if `SCROLLPERF` reported a frame at or above 40000us.** If it measured faster, do not do this: it adds rotation-dependent shim surface to save time nobody has shown is needed, and the ledger entry should say so explicitly.

**Files:**
- Modify: `firmware/deckhand_display/panel_shim.h`
- Modify: `firmware/deckhand_display/panel_shim.cpp`
- Modify: `firmware/deckhand_display/scrollback.ino`

**Interfaces:**
- Produces: `void PanelShim::scrollRect(int x, int y, int w, int h, int dy)`.

- [ ] **Step 1: Add `scrollRect` to the shim**

`panel_shim.h`, beside `pushImage`:

```c
  // Shift a logical rect vertically inside the framebuffer and mark it dirty.
  // Board 2 only, and it exists for one caller: a scroll frame that would
  // otherwise recompose every visible line. dy > 0 moves content DOWN.
  void scrollRect(int x, int y, int w, int h, int dy);
```

`panel_shim.cpp`:

```c
void PanelShim::scrollRect(int x, int y, int w, int h, int dy) {
  if (!_fb || dy == 0) return;
  clipLogicalRect(x, y, w, h);
  if (w <= 0 || h <= 0) return;
  int n = dy < 0 ? -dy : dy;
  if (n >= h) return;                     // nothing survives the shift
  // ROTATION-AWARE. A framebuffer row memmove equals a LOGICAL vertical scroll
  // only at rotation 0; the screen-flip feature can select rotation 2, where a
  // logical downward scroll is a physical upward one. mapPoint owns that
  // mapping, so the row order is derived from it rather than assumed.
  int pxA, pyA, pxB, pyB;
  mapPoint(x, y, pxA, pyA);
  mapPoint(x, y + 1, pxB, pyB);
  const int rowStep = pyB - pyA;          // +1 at rotation 0, -1 at rotation 2
  const int rows = h - n;
  for (int i = 0; i < rows; i++) {
    // Copy in the direction that cannot overwrite a source row before it is read.
    int srcL = (dy > 0) ? (h - n - 1 - i) : (n + i);
    int dstL = srcL + dy;
    int sx0, sy0, dx0, dy0;
    mapPoint(x, y + srcL, sx0, sy0);
    mapPoint(x, y + dstL, dx0, dy0);
    memmove(&_fb[(size_t) dy0 * PANEL_PHYS_W + dx0],
            &_fb[(size_t) sy0 * PANEL_PHYS_W + sx0],
            (size_t) w * sizeof(uint16_t));
  }
  (void) rowStep;
  int mx0, my0, mx1, my1;
  mapPoint(x, y, mx0, my0);
  mapPoint(x + w - 1, y + h - 1, mx1, my1);
  if (mx0 > mx1) { int t = mx0; mx0 = mx1; mx1 = t; }
  if (my0 > my1) { int t = my0; my0 = my1; my1 = t; }
  markDirty(mx0, my0, mx1, my1);
}
```

- [ ] **Step 2: Use it in the drag loop**

Replace the drag loop's `scrollDrawBody(); tft.flush();` with a shift-plus-band redraw:

```c
      const int shift = (int) ((long) scrollY - (long) prevY);
      if (shift != 0 && shift > -(SCROLL_BOT - SCROLL_TOP) && shift < (SCROLL_BOT - SCROLL_TOP)) {
        tft.scrollRect(0, SCROLL_TOP, tft.width(), SCROLL_BOT - SCROLL_TOP, -shift);
        scrollDrawBand(shift);      // only the newly exposed rows
      } else {
        scrollDrawBody();
      }
      tft.flush();
      prevY = scrollY;
```

with `scrollDrawBand(int shift)` drawing only the exposed band — the same loop as `scrollDrawBody` bounded to `shift > 0 ? [SCROLL_BOT - shift, SCROLL_BOT) : [SCROLL_TOP, SCROLL_TOP - shift)`, plus the rail, which must be repainted whole because the shift moved it.

- [ ] **Step 3: Measure again**

```bash
./flash.sh --board 2
echo "SCROLLPERF" > ~/.claude/deckhand-device-command
sleep 30; grep SCROLLPERF /tmp/deckhand-$(id -u)/host.log | tail -1
```
Expected: `compose` down sharply, `flush` roughly unchanged — the flush ships the dirty rect regardless of what composed it. **If the frame did not improve, revert this task**: it added shim surface for nothing, and that is a worse outcome than a slightly notchy scroll.

- [ ] **Step 4: Verify the flip case, which is the one this can silently break**

On the device: SETTINGS > Display, set FLIPPED, then open a transcript and drag.
Expected: it scrolls in the same direction relative to the finger. **A framebuffer memmove that ignores rotation scrolls BACKWARDS here**, and nothing else in this plan would catch it.

- [ ] **Step 5: Check board 1 and commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```
Expected: `UNCHANGED` — `panel_shim.cpp` is board 2's translation unit and board 1 does not link it.

```bash
git add firmware/deckhand_display/
git commit -F - <<'EOF'
Scroll by memmove, because the measurement asked for it

SCROLLPERF measured <N>us per frame before this and <N>us after. The flush is
roughly unchanged, as expected - it ships the dirty rect regardless of what
composed it - so the whole saving is in not recomposing 26 lines that had not
changed.

scrollRect is ROTATION-AWARE rather than a bare row memmove: a framebuffer row
shift equals a logical vertical scroll only at rotation 0, and the screen-flip
feature can select rotation 2, where a logical downward scroll is a physical
upward one. Verified by hand with FLIPPED set, which is the one case nothing
else in this plan would catch.
EOF
```

---

## Self-review

**1. Spec coverage.** Every spec section maps to a task: geometry and both closing identities → Task 1; the gutter vocabulary → Task 2 (`scrollMark`, ASCII-asserted) and Task 4 (drawn); the data model → Task 2; the wire protocol including the chunk-budget-on-serialised-length rule and the seq-discontinuity policy → Task 3; the pending/edge states table → Task 4 (`scrollDrawBody`'s five notes); the scroll mechanism and its deciding measurement → Task 4; the blocking drag loop and all four of its obligations → Task 5; "what board 2's build stops compiling" → Task 6; the conditional `scrollRect` → Task 7; verification → the checker steps in every task plus Task 6 Step 7.

**Two gaps found and closed.** The spec's "rendering discipline" section asks for the header's counter and the rail to stay change-only caches; Tasks 4 and 5 repaint both wholesale per frame instead. That is **a deliberate deviation, recorded here rather than silently dropped**: `scrollDrawBody` already repaints the whole body every frame, so a cache on the rail inside it would be busted on every frame and would only add work. The header IS static between fetches and is only repainted by `drawScrollback()`, which is correct. If a future frame becomes cheap enough that the rail's repaint matters, that is the moment to cache it. And the spec's `SCROLL_FETCH_TIMEOUT_BLE_MS` had no consumer until `tickScrollFetch` was added in Task 3 Step 5.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the actual code. Three intentional `<N>` markers remain, all inside commit-message templates for numbers that can only exist once measured — Task 4's frame figures and Task 6's size deltas.

**3. Type consistency.** `ScrollEntry`'s five fields are used identically in Tasks 2, 4 and 5. `scrollWrapLines(const char*, int)`, `scrollLineAt(const char*, int, int, char*, int)`, `scrollEntryAtLine(uint32_t)`, `scrollMaxY()` and `scrollDrawBody()` keep one signature throughout. `scrollY` is `uint32_t` everywhere, and every arithmetic site that could go negative casts to `long` first. `histChatOnly` is reused rather than a second filter flag. The one name that appears before its definition is `openScrollback`, needed by `SCROLLPERF` in Task 4 Step 3 and defined in Step 4 of the same task — flagged in that step rather than left to be discovered.
