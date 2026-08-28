# Sessions Band Card — Board 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give board 2's sessions tab a status **band** on the expanded card, a 6px status **spine** on every compact row, the agent **mark** at all statuses, and the two adopted **animations** — so a session's state reads across a room without spending a card on one word.

**Architecture:** This is not a new mechanism. `sessionExpandedH()` already gives the top row the height the ladder leaves over, and it already returns 0 on board 1 under `#if BOARD_USES_TFT_ESPI`. The band card is that same expanded row with a new head; the spine is a 6px fill on the rows that are not it. `SESSION_EXP_MAX_H` rises 212 → **336**, derived from the blocks that can carry ink rather than chosen. Every constant lands in `board_es3c35p.h` and is asserted by `sessions-geom-check.mjs`.

**Tech Stack:** Arduino C++ (ESP32-S3), `PanelShim` (no TFT_eSPI on this board), Node ESM checkers, `arduino-cli`.

**Spec:** [`docs/superpowers/specs/2026-08-28-sessions-redesign-board2-design.md`](../specs/2026-08-28-sessions-redesign-board2-design.md) — this plan implements **§3, §4, §5 and §6** (piece 3 of 4). Recommended order in §12 is 1 → 3 → 4 → 2; **piece 1 is merged** (`3a5360f`).

**Mockup:** `scratchpad/mock/` — served with `python3 -m http.server 8777`. It renders the real palette, the real geometry and the real decoded sprites, and it is what produced FINDINGS 1–3 below.

## Global Constraints

- **BOARD 1'S BINARY MUST NOT MOVE. This is the opposite of piece 1.** Spec §12 marks piece 3 "touches board 1? no". Everything here sits behind `#if !BOARD_USES_TFT_ESPI` or inside constants only `board_es3c35p.h` declares. Verify with `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1` — it must report **UNCHANGED** at the end of every task. A `CHANGED` here is a bug, not a re-baseline.
- **Never compile both boards concurrently.** `arduino-cli` derives its build directory from the sketch path, so two FQBNs share one cache and overwrite each other's objects. Compile one after the other.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** A literal on the checker's side is what let `PILL_H` drift once already.
- **The test of a new assertion is not "does it pass" but "does reverting the change make it fail, and by name".**
- **Animate regions, never the screen** (§2). A full flush is 30ms — the entire budget at 30fps before composing. Band is 3.3ms, spine 1.2ms.
- **An animation must never touch `lastNonIdleMillis`**, or it reads as activity to the sleep timer, and every tick must be gated on the sessions list actually being visible — as `tickWorkingSpinner` already is.
- **Colour is never the only carrier.** Every spine row keeps its text pill; the band keeps its status word.
- Board 1 FQBN: `esp32:esp32:esp32:PartitionScheme=huge_app`
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Decisions already taken, so nobody re-opens them mid-task

- **The label CROSSFADES; it does not swap at the midpoint.** Asked and answered: §6 as written. At t=0.5 both words are half strength and briefly illegible — that is accepted, not overlooked. Do not "fix" it.
- **FINDING 1 and FINDING 3 are §7, which is piece 4, and are NOT in scope here.** Recorded so they are not rediscovered: §7's detail band cannot hold "status word, duration and wall-clock" — with `4m · 09:34` the label has 150px, but `NEEDS YOUR INPUT` is 192px and `WAITING FOR YOU` is 180px, colliding by **42px and 30px**. Moving the wall-clock to §7's meta line does not fix it either: that lane is 268px and the line becomes 344px, **over by 76**. §3's sessions band — the one this plan builds — is fine: 214px of room against a 192px longest word, clearing by 22.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `firmware/deckhand_display/board_es3c35p.h` | the band/spine constants and the re-derived `SESSION_EXP_MAX_H` | modify |
| `firmware/deckhand_display/board_e32r28t.h` | **untouched** — board 1 has no band; `sessionExpandedH()` already returns 0 there | none |
| `firmware/deckhand_display/sessions.ino` | `drawSessionBand()`, `drawSessionSpine()`, band-card body, row draw | modify |
| `firmware/deckhand_display/deckhand_display.ino` | `drawStatusDot()` — mark at every status; `tickBandAnim()` from `loop()` | modify |
| `firmware/deckhand_display/sessions-geom-check.mjs` | parse and assert every new constant, the block sum, the ladder | modify |

**Why no new file:** the sketch is a concatenated translation unit and the drawing code for this tab already lives in `sessions.ino`. A new `.ino` would join the same unit and buy nothing; a new `.cpp` would leave the sketch's globals unreachable.

---

### Task 1: The constants and the checker that binds them (fails first)

The band card's height budget is the whole foundation — get it wrong and every later task lays out against a lie. It lands first, with the checker that proves the sum.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/sessions-geom-check.mjs`

**Interfaces:**
- Produces: `SESSION_BAND_H`, `SESSION_SPINE_W`, `SESSION_BAND_PAD`, `SESSION_BAND_MARK_GAP`, `SESSION_BAND_NAME_H`, `SESSION_BAND_SUB_H`, `SESSION_BAND_TITLE_STEP`, `SESSION_BAND_RULE_H`, `SESSION_BAND_LABEL_H`, `SESSION_BAND_PROMPT_STEP`, `SESSION_BAND_PATH_H`, `SESSION_BAND_BOTTOM_PAD`, and a re-derived `SESSION_EXP_MAX_H` — all consumed by Tasks 2–5.

- [ ] **Step 1: Add the failing assertions to `sessions-geom-check.mjs`**

Add near the other board-2 assertions. `nums` is the header parser already in that file (via `geom-common.mjs`); use the same accessor the surrounding assertions use rather than inventing one.

```js
// ---- §3/§4 band card: the cap is DERIVED, so assert it against its own blocks ----
// The spec's rule: "the sum of the blocks that can actually carry ink". A future
// field that adds a line must move this sum, not slip past it.
if (board === 2) {
  const B = (n) => num(`SESSION_BAND_${n}`);
  const blocks = [
    ['band',        num('SESSION_BAND_H')],
    ['name',        B('NAME_H')],
    ['sub',         B('SUB_H')],
    ['title',       B('TITLE_STEP') * num('SESSION_EXP_TITLE_LINES')],
    ['rule',        B('RULE_H')],
    ['lastprompt',  B('LABEL_H')],
    ['prompt',      B('PROMPT_STEP') * num('SESSION_EXP_PROMPT_MAX')],
    ['rule2',       B('RULE_H')],
    ['path',        B('PATH_H')],
    ['pad',         B('BOTTOM_PAD')],
  ];
  const sum = blocks.reduce((a, [, v]) => a + v, 0);
  eq('SESSION_EXP_MAX_H is the sum of the band card blocks, not a chosen number',
     num('SESSION_EXP_MAX_H'), sum);

  // The two byte caps that bound the line counts. These are the reason the sum is
  // what it is: a 5th prompt line and a 3rd title line can never carry ink.
  const lane = Math.floor((num('SESSION_ROW_W') - 2 * B('PAD')) / num('TEXT_ADV'));
  ok(`a 5th prompt line is unreachable: prompt[104] holds 100 chars, ${num('SESSION_EXP_PROMPT_MAX')} lines x ${lane} cols = ${lane * num('SESSION_EXP_PROMPT_MAX')}`,
     lane * num('SESSION_EXP_PROMPT_MAX') >= 100);
  ok(`a 3rd title line is unreachable: title[44] holds 43 chars, ${num('SESSION_EXP_TITLE_LINES')} lines x ${lane} cols = ${lane * num('SESSION_EXP_TITLE_LINES')}`,
     lane * num('SESSION_EXP_TITLE_LINES') >= 43);
  // ... and that one FEWER line would NOT hold the data, which is what makes the
  // counts derived rather than generous.
  ok('4 prompt lines is the MINIMUM that holds prompt[104]',
     lane * (num('SESSION_EXP_PROMPT_MAX') - 1) < 100);
  ok('2 title lines is the MINIMUM that holds title[44]',
     lane * (num('SESSION_EXP_TITLE_LINES') - 1) < 43);

  // The card must fit the column it is drawn in.
  ok(`the band card cap (${num('SESSION_EXP_MAX_H')}) fits the 1-session list area`,
     num('SESSION_EXP_MAX_H') <= 410);
  // The band's own contents must fit ACROSS. This is the arithmetic that fails on
  // the detail screen (FINDING 1) and passes here - assert it so the two stay apart.
  const bandRoom = num('SESSION_ROW_W') - 4 - B('PAD') - 32 - B('MARK_GAP')
                   - B('PAD') - 2 * num('TEXT_ADV');   // 32 = mark, "4m" = 2 chars
  const longestWord = 'NEEDS YOUR INPUT'.length * 12;  // T_HEAD Spleen 12x24
  ok(`the band's longest status word (${longestWord}px) clears the duration (room ${bandRoom}px)`,
     longestWord <= bandRoom);

  ok('the spine is narrower than the card border radius allows to be lost',
     num('SESSION_SPINE_W') >= 4 && num('SESSION_SPINE_W') <= 8);
}
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
node firmware/deckhand_display/sessions-geom-check.mjs
```

Expected: **exit 1**, failing because `SESSION_BAND_H` and its siblings do not parse (the constants do not exist yet). If it fails on something else, the accessor name is wrong — match the surrounding assertions before continuing.

- [ ] **Step 3: Add the constants to `board_es3c35p.h`**

Place beside `SESSION_EXP_MAX_H`, keeping that file's habit of deriving in a comment.

```c
// ---------- §3 THE STATUS BAND ----------
// The card head becomes a FILLED BAND in the status colour. Filled bands are new
// vocabulary for this UI - nothing else here fills a region with a status colour -
// and that is accepted rather than overlooked: the band is the reason the card
// reads at a distance without spending 64px of height on a single word.
//
// 44 is TAP_MIN(46) minus the card's own 2px border: the band is the full width of
// the card's interior, so it is not a tap target itself, but sizing it to the same
// rung keeps it from reading as a thin stripe against a 46px tab bar.
const int SESSION_BAND_H = 44;
const int SESSION_BAND_PAD = 14;        // side pad, band and body share it
const int SESSION_BAND_MARK_GAP = 8;    // agent mark -> status word
//
// THE BAND'S CONTENTS FIT ACROSS, and this is the arithmetic the detail screen
// FAILS (see the spec's §7 and this plan's FINDING 1). Inner width is
// SESSION_ROW_W - 4 = 292. The word starts at PAD(14) + mark(32) + GAP(8) = 54;
// a bare duration "4m" is 2 * TEXT_ADV = 16 and sits PAD from the right, so the
// word has 292 - 54 - 14 - 16 = 208px. The longest label is "NEEDS YOUR INPUT",
// 16 chars at T_HEAD's 12px advance = 192. Clears by 16.
// Add a wall-clock here and it does NOT clear - that is why §7 is a separate piece.

// ---------- §4 THE SPINE ----------
// The band's compact form: a 6px status-coloured spine down the row's left edge.
// Same vocabulary, ~1.2ms against the band's 3.3ms, and it scales to any row
// height - which a 44px band cannot, since at four sessions a row is 100px and a
// band would spend 44% of it on one word.
// THE SPINE NEVER CARRIES STATUS ALONE: every spine row keeps its text pill, the
// same rule that makes the status pill a filled/outlined/boxless SHAPE, not a hue.
const int SESSION_SPINE_W = 6;

// ---------- The band card's block stack ----------
// SESSION_EXP_MAX_H is the SUM of these, not a chosen number - the same way the
// 212 it replaces was derived. sessions-geom-check.mjs asserts the sum, so a future
// field cannot silently push a line past what its data can fill.
const int SESSION_BAND_NAME_H = 34;      // T_HEAD 24 + 10 leading
const int SESSION_BAND_SUB_H = 32;       // T_BODY 16 + 16, the agent/model/branch line
const int SESSION_BAND_TITLE_STEP = 20;  // T_BODY 16 + 4
const int SESSION_BAND_RULE_H = 18;      // 1px rule + air either side
const int SESSION_BAND_LABEL_H = 28;     // the "LAST PROMPT" caption
const int SESSION_BAND_PROMPT_STEP = 24; // T_BODY 16 + 8; prompt gets the most air
const int SESSION_BAND_PATH_H = 20;
const int SESSION_BAND_BOTTOM_PAD = 6;
//
// TWO HARD CAPS ON THE LINE COUNTS, both inherited from the existing derivation and
// both asserted: the lane is (296 - 2*14) / 8 = 33 columns, so prompt[104]'s 100
// characters need 4 lines (3 x 33 = 99 is one short) and a 5th is permanently
// blank; title[44]'s 43 characters need 2 (1 x 33 = 33 is short) and a 3rd is
// permanently blank. SESSION_EXP_PROMPT_MAX and SESSION_EXP_TITLE_LINES are those
// counts and must not be raised without new byte caps to justify them.
//
//   band 44 + name 34 + sub 32 + title 2x20 + rule 18
//        + LAST PROMPT 28 + prompt 4x24 + rule 18 + path 20 + pad 6 = 336
```

Then change the existing line:

```c
const int SESSION_EXP_MAX_H = 336;
```

- [ ] **Step 4: Run the checker — it passes**

```bash
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs --selftest
```

Expected: both exit 0.

- [ ] **Step 5: Prove the new assertions have teeth**

Mutation, one at a time, reverting after each. Every one must fail **by name**:

```bash
# a) the sum no longer matches its blocks
sed -i '' 's/SESSION_EXP_MAX_H = 336/SESSION_EXP_MAX_H = 340/' firmware/deckhand_display/board_es3c35p.h
node firmware/deckhand_display/sessions-geom-check.mjs   # must FAIL naming the sum
sed -i '' 's/SESSION_EXP_MAX_H = 340/SESSION_EXP_MAX_H = 336/' firmware/deckhand_display/board_es3c35p.h

# b) a line count that no longer holds its data
sed -i '' 's/SESSION_EXP_PROMPT_MAX = 4/SESSION_EXP_PROMPT_MAX = 3/' firmware/deckhand_display/board_es3c35p.h
node firmware/deckhand_display/sessions-geom-check.mjs   # must FAIL naming prompt[104]
sed -i '' 's/SESSION_EXP_PROMPT_MAX = 3/SESSION_EXP_PROMPT_MAX = 4/' firmware/deckhand_display/board_es3c35p.h
```

Expected: each mutation fails and names the constant. If (a) passes, the checker is transcribing 336 instead of summing the blocks — fix that before continuing, it is the exact defect this repo has already paid for twice.

- [ ] **Step 6: Compile both boards, one after the other**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: both compile; **board 1 UNCHANGED**. A `CHANGED` means a constant leaked out of `board_es3c35p.h` — find it rather than re-baselining.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/sessions-geom-check.mjs
git commit -m "Band card geometry: derive SESSION_EXP_MAX_H from its blocks

212 -> 336, summed from the blocks that can carry ink rather than chosen,
the same way the 212 was. The checker asserts the SUM against the parsed
blocks and asserts both line counts against the byte caps that force them
(prompt[104] needs 4 lines of a 33-column lane, title[44] needs 2), so a
future field cannot silently push a line past what its data can fill.

Also asserts the band's contents fit ACROSS: the status word has 208px
against a 192px longest label. That same arithmetic FAILS on the detail
screen once a wall-clock joins the duration, which is why §7 is a
separate piece.

Board 1 unchanged - sessionExpandedH() already returns 0 there.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The band (§3)

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino`

**Interfaces:**
- Consumes: every `SESSION_BAND_*` constant from Task 1; `colorForStatus()`, `labelForStatus()` (`deckhand_display.ino:1524`); the existing `drawAgentSpinner()` body.
- Produces: **`void drawAgentMark(int x, int y, bool codex, uint16_t fg, uint16_t bg, bool animate)`** — extracted here because the band is its first caller; Task 4 makes `drawStatusDot` a second one. Also `void drawSessionBand(int x, int y, int w, const SessionInfo& s, uint16_t col)`, consumed by Task 5's crossfade.

**Extract `drawAgentMark` FIRST, in this task.** `drawAgentSpinner` today hard-codes the working colour and a centre-based origin; the band needs an arbitrary tint and a **top-left** origin — the same top-left convention `drawEmoji` uses and deliberately unlike `blit2bpp`'s centre, so no call site carries a centring term. Keep `drawAgentSpinner` as a thin wrapper so board 1's call site is untouched and its binary cannot move.

- [ ] **Step 1: Write `drawSessionBand()`**

Add to `sessions.ino`, inside the existing `#if !BOARD_USES_TFT_ESPI` region that holds the other expanded-card helpers.

```c
// §3. The band: a filled rect in the status colour carrying the agent mark, the
// status WORD and the duration. Drawn as ONE unit and repainted as one - Task 5's
// crossfade redraws exactly this rectangle and nothing else, which is what keeps a
// state change at 3.3ms instead of a 30ms full flush.
//
// The word is T_HEAD (Spleen 12x24) because presence is the band's whole job; the
// duration stays T_BODY so it reads as a subordinate fact. Both are drawn in
// COLOR_CARD ON the status colour, which is why the mark is tinted the same way -
// see drawEmoji's bg argument for the same idea.
void drawSessionBand(int x, int y, int w, const SessionInfo& s, uint16_t col) {
  tft.fillRect(x, y, w, SESSION_BAND_H - 2, col);
  // the agent mark, tinted CARD-on-status rather than status-on-card
  drawAgentMark(x + SESSION_BAND_PAD, y + (SESSION_BAND_H - 2 - 32) / 2,
                s.agentIsCodex(), COLOR_CARD, col, /*animate=*/false);
  setUIFont(T_HEAD);
  tft.setTextColor(COLOR_CARD, col);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(labelForStatus(s.status),
                 x + SESSION_BAND_PAD + 32 + SESSION_BAND_MARK_GAP,
                 y + (SESSION_BAND_H - 2 - uiLineH(T_HEAD)) / 2);
  setUIFont(T_BODY);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(s.durText, x + w - SESSION_BAND_PAD,
                 y + (SESSION_BAND_H - 2 - uiLineH(T_BODY)) / 2);
  tft.setTextDatum(TL_DATUM);
}
```

**Note on `labelForStatus`:** it returns lower-case (`"needs your input"`). The band draws it as-is unless the surrounding code already upper-cases status text — check `drawStatusPill` and match it, rather than introducing a second convention.

**Note on `s.durText` and `s.agentIsCodex()`:** use whatever the existing row draw already uses for the duration string and the Codex test — `drawSessionRow` computes both today. Do not add new fields to `SessionInfo`; it is 2.2KB a row and the reason `prevSessions` was slimmed.

- [ ] **Step 2: Call it from the expanded card and shift the body down**

In `drawSessionRow`, in the `expanded` branch, draw the band first and start the body cursor at `y + SESSION_BAND_H`. Remove the status pill from the expanded card only — the band replaces it there. **Compact rows keep their pill** (Task 3 depends on that).

- [ ] **Step 3: Compile board 2 and flash**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
./flash.sh --board 2 --no-compile
```

- [ ] **Step 4: Verify on the glass**

```bash
echo "TAB 1" > ~/.claude/deckhand-device-command; sleep 6
echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 12
ls -t ~/Deckhand-shots | head -1
```

Expected: the top card is headed by a filled band in the status colour, carrying mark, word and duration, with **no overlap** between word and duration. Compare against the mockup's 1-session panel.

- [ ] **Step 5: Board 1 must be unchanged**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: **UNCHANGED**.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/sessions.ino
git commit -m "The band: the expanded card gets a filled status head

Mark, status word (T_HEAD) and duration in one filled rect. Drawn as one
unit so the crossfade can repaint exactly it - 3.3ms against a 30ms full
flush. The expanded card drops its pill, which the band replaces; compact
rows keep theirs, because colour is never the only carrier.

Board 1 unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The spine (§4)

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino`

**Interfaces:**
- Consumes: `SESSION_SPINE_W` (Task 1), `colorForStatus()`.
- Produces: `void drawSessionSpine(int x, int y, int h, const char* status, bool codex)` — consumed by Task 5's shimmer.

- [ ] **Step 1: Write `drawSessionSpine()`**

```c
// §4. The band's compact form. 6px of status colour down the row's left edge,
// inside the card's 2px border so it cannot bite the rounded corner - the same
// hazard SESSION_DOT_CX was moved for when the spinner's blit notched the border.
//
// CLAUDE SOLID, CODEX SEGMENTED (§5's second carrier). A fill pattern, not art:
// no blits, no new tables, and it survives greyscale - which is the whole point of
// giving the agent a texture rather than a hue, since status already owns colour.
void drawSessionSpine(int x, int y, int h, const char* status, bool codex) {
  uint16_t col = colorForStatus(status);
  if (!codex) { tft.fillRect(x, y, SESSION_SPINE_W, h, col); return; }
  const int ON = 7, OFF = 4;
  for (int yy = 0; yy < h; ) {
    int run = (yy + ON > h) ? h - yy : ON;
    tft.fillRect(x, y + yy, SESSION_SPINE_W, run, col);
    yy += ON + OFF;
  }
}
```

- [ ] **Step 2: Call it for every non-expanded row**

In `drawSessionRow`, for rows where `!expanded`, draw the spine at `x = SESSION_ROW_X + 2`, `y = rowY + 2`, `h = rowH - 4` — inside the border. **Leave the status pill exactly where it is.** Confirm the name lane still starts clear of the spine; if `SESSION_NAME_DX` (40) now collides, widen it in the board header rather than nudging the draw site.

- [ ] **Step 3: Compile, flash, and verify with a MIXED list**

```bash
./flash.sh --board 2
echo "TAB 1" > ~/.claude/deckhand-device-command; sleep 6
echo "MULTITEST 2" > ~/.claude/deckhand-device-command; sleep 8
echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 12
```

Expected: a band card on top and spine rows below it; a Codex row's spine is visibly segmented against a Claude row's solid one; every spine row still shows its pill. `MULTITEST` is what makes a mixed list reachable from one Mac.

- [ ] **Step 4: Board 1 unchanged, then commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
git add firmware/deckhand_display/sessions.ino
git commit -m "The spine: the band's compact form for every other row

6px of status colour down the left edge, inside the 2px border so it
cannot notch the rounded corner. Claude solid, Codex segmented - a fill
pattern rather than art, so it costs no blits and survives greyscale,
which is what lets the agent have a texture while status keeps colour.

Every spine row keeps its pill. Colour is never the only carrier.

Board 1 unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The agent mark at every status (§5)

Today `drawStatusDot` calls `drawAgentSpinner` **only** when `status == "working"` (`deckhand_display.ino:1808`); `asking` and `waiting` fall through to a plain square or ring with no agent distinction at all.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino:1805-1815`

**Interfaces:**
- Consumes: `drawAgentMark(x, y, codex, fg, bg, animate)` — **already extracted in Task 2**, whose band is its first caller. This task adds the second caller and decides the resting pose.

- [ ] **Step 1: Decide the resting pose**

**§5 states the cost plainly and it must not be discovered again:** neither mark has a resting pose. Both are 8 *motion* frames from `spark2c.py` / `codex2c.py` with no idle frame, and frame 0 may not read as deliberate. **New art is out of scope for this plan.** So take the spec's own stated fallback: at rest, draw **frame 0 at `COLOR_LABEL` strength, unanimated**; while working, animate at full status colour as today.

```c
// §5. The mark is the row indicator at EVERY status, not only while working -
// animating while working, at rest otherwise. Colour is unavailable to the agent
// (status owns it: band, spine and pill are all colorForStatus), so the agent is
// carried by SHAPE, by the spine's texture, and by the existing CC/CX tag. Three
// carriers, none of them hue, redundant on purpose.
//
// AT REST THE MARK IS FRAME 0 AT LABEL STRENGTH. Neither table has an idle frame -
// both are 8 MOTION frames - and a motion frame held still can read as accidental.
// Dimming it is the spec's own stated fallback and needs no new art; a real rest
// pose is a separate change requiring a generator run (Codex's needs headless
// Chrome, which this toolchain has no substitute for).
void drawAgentMark(int x, int y, bool codex, uint16_t fg, uint16_t bg, bool animate);
```

- [ ] **Step 2: Rewrite `drawStatusDot` to call it at every status**

```c
void drawStatusDot(int cx, int cy, int r, const char* status, uint16_t bg = COLOR_BG,
                   bool codex = false) {
#if BOARD_USES_TFT_ESPI
  // board 1 keeps the shape vocabulary exactly as it is - see the plan's global
  // constraint: this piece must not move that binary.
  uint16_t color = colorForStatus(status);
  if (strcmp(status, "working") == 0) { drawAgentSpinner(cx, cy, bg, codex); return; }
  tft.fillRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2, bg);
  if (strcmp(status, "asking") == 0) tft.fillRect(cx - r, cy - r, r * 2, r * 2, color);
  else                               uiRing(cx, cy, r, 2, color, bg);
#else
  const bool working = strcmp(status, "working") == 0;
  drawAgentMark(cx - 16, cy - 16, codex,
                working ? colorForStatus(status) : COLOR_LABEL, bg, working);
#endif
}
```

- [ ] **Step 3: Confirm the shape rule still holds**

**This is the assertion that matters, and it is a judgement, not a regex:** with the mark at every status, `asking` and `waiting` no longer differ by *shape* at the indicator — only by the pill and the band. Verify on the glass that a waiting row and an asking row are still tellable apart **in greyscale**, using the pill's filled-vs-outlined form. If they are not, the mark must not replace the square/ring at those statuses and this task should stop and report rather than proceed.

- [ ] **Step 4: Compile both, verify, commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1   # UNCHANGED
./flash.sh --board 2 --no-compile
echo "TAB 1" > ~/.claude/deckhand-device-command; sleep 6
echo "MULTITEST 2" > ~/.claude/deckhand-device-command; sleep 8
echo "SCREENSHOT" > ~/.claude/deckhand-device-command; sleep 12
```

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "The agent mark at every status, not only while working

drawStatusDot called drawAgentSpinner only for 'working'; asking and
waiting fell through to a plain square or ring with no agent distinction
at all. The mark is now the indicator at every status - animated while
working, frame 0 at COLOR_LABEL strength otherwise.

The dim rest pose is the spec's own stated fallback: neither table has an
idle frame, both are 8 motion frames, and real rest art needs a generator
run rather than a decision.

Board 1 keeps the square/ring vocabulary untouched and its binary
unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The two adopted animations (§6)

Adopted: **state crossfade** (band, ~300ms, one-shot) and **spine shimmer** (while working). The **attention pulse is NOT in this task** — §6 gates it on a `POWERPROBE` A/B, which is Task 6.

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino`, `firmware/deckhand_display/deckhand_display.ino` (tick from `loop()`)

**Interfaces:**
- Consumes: `drawSessionBand()` (Task 2), `drawSessionSpine()` (Task 3).
- Produces: `void tickSessionAnim()` — called from `loop()` beside `tickWorkingSpinner()`.

- [ ] **Step 1: Add the crossfade state and the tick**

```c
// §6. THE LABEL CROSSFADES TOO - both words are half strength at t=0.5 and briefly
// illegible. That is the spec as written and it was asked and answered; do not
// "fix" it to a midpoint swap.
//
// One-shot, ~300ms, BAND ONLY. The band is 296x44 = 13,024px ~ 3.3ms against a
// 30ms full flush, which is the entire budget at 30fps - so this repaints
// drawSessionBand's rectangle and nothing else. Same conclusion the change-only
// redraw discipline already reached for flicker, arriving from the power side.
const unsigned long SESSION_XFADE_MS = 300;
int      xfadeRow = -1;              // display position, -1 = idle
char     xfadeFrom[16] = "";         // the status we are leaving
unsigned long xfadeStart = 0;

void tickSessionAnim() {
  // Gated exactly as tickWorkingSpinner is, and for the same reasons.
  if (isAsleep || octoActive || showingDetail || readerActive || histActive
      || kbActive || currentTab != TAB_SESSIONS) { xfadeRow = -1; return; }
  // NOTE: never touch lastNonIdleMillis here - an animation must not read as
  // activity to the sleep timer.
  ...
}
```

The blend itself: `lerp565(from, to, t)` over the two status colours, redrawing the band with both labels at their partial strengths. Board 2 draws through `PanelShim` into a readable framebuffer, so alpha blending against the destination is available — that is the same property the AA primitives rely on.

- [ ] **Step 2: Trigger it on a status change**

The row signature already changes when status does. Detect the transition where `prevSessions` is diffed — the same place the beep fires on a newly-`asking` session — and set `xfadeRow`/`xfadeFrom`/`xfadeStart`. **Match by session id, never by name** — two sessions on one project share a name, which is the bug the beep budget already documents.

- [ ] **Step 3: Add the spine shimmer**

A light travelling the spine while working, 1.2ms/frame — the cheapest thing considered. Advance it in the same tick; repaint only the spine's 6px column.

- [ ] **Step 4: Call the tick from `loop()`**

Beside `tickWorkingSpinner()`. Verify the sessions list is the only surface it can paint on.

- [ ] **Step 5: Measure it, do not assume it**

```bash
./flash.sh --board 2
echo "PERF" > ~/.claude/deckhand-device-command
```

Expected: the band repaint is in the low single-digit milliseconds. §2's model is a **two-point fit the spec itself calls "not a characterisation"** — so this step replaces its 3.3ms estimate with a measurement. Record the real number in the commit message.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/sessions.ino firmware/deckhand_display/deckhand_display.ino
git commit -m "State crossfade and spine shimmer

A state change was a silent instant swap; the band now fades colour and
label over ~300ms, one-shot. The label crossfades too - both words are
half strength at the midpoint - which is §6 as written and a deliberate
choice, not an oversight.

Band only: <N>ms measured with PERF against a 30ms full flush, which is
the whole budget at 30fps. The shimmer repaints 6px of spine.

Neither tick touches lastNonIdleMillis, and both are gated on the
sessions list being visible, as tickWorkingSpinner already is.

Board 1 unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The attention pulse — measure, then decide

§6: *"Ship it if the delta is small; drop it if it is not. Not an argument."*

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino` (only if the measurement says ship)

- [ ] **Step 1: Implement the pulse behind a runtime toggle**

A runtime toggle, not a build flag — the same reason `SWAP`/`INV`/`PANELSLEEP` are: one measurement needs the cable out and ~10 minutes on battery, so a build per leg costs a reflash per guess. Nothing is persisted; the answer belongs in the source once it has been SEEN.

- [ ] **Step 2: Run the A/B in ONE session, on battery**

```bash
# cable OUT - POWERPROBE refuses on USB, because a probe that "worked" on
# the charger would be measuring the charger
echo "POWERPROBE pulse-off" > ~/.claude/deckhand-device-command
# ... wait for the report over BLE, then enable the pulse and:
echo "POWERPROBE pulse-on" > ~/.claude/deckhand-device-command
```

**Do NOT compare against any mV/h figure recorded on another day.** This repo has already published a wrong claim that way: an −88 mV/h "baseline" turned out to be a different state entirely. Both legs, one session, minutes apart, and discard anything reported inside the first few minutes — the cell relaxes, and a relaxation curve fits a straight line perfectly well.

- [ ] **Step 3: Decide, and record the number either way**

Ship it or delete it. **If it is dropped, commit the measurement in the spec or this plan anyway** — an unrecorded negative result gets re-proposed within the month.

- [ ] **Step 4: Final board-1 check and the geometry sweep**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1   # UNCHANGED
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs --selftest
node firmware/deckhand_display/geom-sweep.mjs      # ~30s
```

The sweep reports constants no assertion notices. **Every `SESSION_BAND_*` constant this plan ADDED that comes back UNGUARDED is a gap, not noise** — the sweep's own guidance is to treat a just-added unguarded constant as a gap.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Attention pulse: <shipped|dropped> on a measured <N> mV/h delta

Both legs in one session on battery, minutes apart, cross-checked against
the raw per-minute BATT deltas. Cross-session mV/h is not comparable -
this repo has published a wrong claim that way once.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** §3 band → Task 2 (constants Task 1). §4 multi-session rule and spine → Task 3; the ladder arithmetic is unchanged and `SESSION_EXP_MAX_H`'s rise is Task 1. §5 all three carriers → Task 4 (mark), Task 3 (spine texture), and the existing `CC`/`CX` tag which is untouched. §6 crossfade and shimmer → Task 5; attention pulse → Task 6 behind its stated gate. §7 detail screen is **piece 4 and deliberately out of scope** — FINDINGS 1 and 3 are recorded above so it starts from them.

**Placeholder scan.** Two intentional `<N>` remain, both in commit messages that Task 5 Step 5 and Task 6 Step 3 say to fill from a measurement that cannot be known in advance, and one `<shipped|dropped>` for the same reason.

**Type consistency.** Checked and one real forward dependency was found and fixed: `drawAgentMark` was declared in Task 4 but called by Task 2's band, which lands first. The extraction now belongs to **Task 2**, which is its first caller, and Task 4 adds the second caller plus the rest pose. `drawSessionBand(x, y, w, s, col)` and `drawSessionSpine(x, y, h, status, codex)` keep their signatures into Task 5. `SESSION_EXP_PROMPT_MAX` and `SESSION_EXP_TITLE_LINES` are pre-existing names, reused rather than renamed.

**One weakness, stated rather than hidden.** Tasks 2–5 are verified by screenshot, and a board-2 `SCREENSHOT` reads the **shadow framebuffer**, not the panel — so it proves the renderer self-consistent, not correct. The band's *colours* are the one thing a capture cannot vouch for; if they look wrong on the glass, reach for `COLORTEST`/`SWAP`/`INV` before believing the capture.
