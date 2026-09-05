# The compose surface: a reply panel over a sharpened keyboard

**Date:** 2026-09-04
**Boards:** both. Board 1 (`E32R28T`, 240x320) and board 2 (`ES3C35P`, 320x480).
**Board 1's binary MOVES**, deliberately and with a stated reason — see *What board 1 pays*.
**Mock:** published as an interactive artifact, not yet committed to `docs/design/`.

**The mock is NOT yet bound to either board header, and that is a known gap that task 1 closes.**
This repo's rule is that a committed mock parses every constant it shares with the header,
because a spec whose numbers can drift while it still reports "all passed" is the same class of
defect as an assertion that cannot fail. Adding `docs/design/compose/` with a `check.mjs` bound
to *both* headers is the first task's responsibility. **No existing committed mock covers two
boards**, so that binding is new work rather than a copy of `settings-redesign/check.mjs`.
Until it lands, the tables below are the authority.

## Goal

Replace the on-screen keyboard as the *entry point* for answering an ask with a **reply panel**
that answers most prompts in one tap, and keep a **sharpened QWERTY** behind it for the rest.
One shared draft, two surfaces.

## Why this is worth doing

### 1. Every key on both boards misses this repo's own fingertip floor, in width

`TAP_MIN` is the same physical floor on both boards — 7.1 mm — derived from each panel's
measured density. The keyboard is the only surface that never clears it.

| | board 1 | board 2 |
|---|---|---|
| density | 5.624 px/mm | 6.489 px/mm |
| `TAP_MIN` | 40 px = 7.11 mm | 46 px = 7.09 mm |
| `KB_PITCH` — the band `kbTouch()` tests | 24 px = **4.27 mm** | 32 px = **4.93 mm** |
| short by | **40%** | **31%** |
| `KB_ROW_H` — tested height | 44 px = 7.82 mm, clears | 58 px = 8.94 mm, clears |

Height is comfortable on both. Width is the entire problem, and it is not fixable inside
QWERTY: `floor(BOARD_W / TAP_MIN)` is 6 on board 1 (240/40) and 6 on board 2 (320/46 = 6.95).
**A row of keys that clears the floor holds six. QWERTY needs ten.** So a design either accepts
sub-floor keys and makes them *hit* better, or stops asking you to type.

### 2. Most answers are not prose

The device exists to answer a Claude Code prompt from across the room. Those answers are
`yes`, `no`, `go ahead`, `use the other one`, or a path or a flag **that was already printed in
the question**. Almost none of it needs a keyboard, and the hardest part of what remains — a
path with slashes and mixed case — is the worst thing to type here, because `/` costs a page
switch and a capital costs a shift.

**This is a belief, not a measurement, and it is the load-bearing one.** See *What this design
cannot verify*.

### 3. Ten defects on the current surface, independent of layout

Each is fixed here, and each is fixed for its own sake rather than as a side effect.

| # | Defect | Where it is fixed |
|---|---|---|
| 1 | The caret lives at `kbLen` and nowhere else; a typo 40 places back costs 40 re-taps | Drag in the text card places the caret |
| 2 | `CANCEL` discards up to 150 characters, same width as `SEND`, 8 px away | Proportional action row; `DISCARD` at half `SEND`'s width; and under the pairing the keyboard's left key is `BACK`, not a destructive control at all |
| 3 | 14 of the 95 printable ASCII characters cannot be typed: `$ % * < > [ \ ] ^ ` { \| } ~` (81 of 95 reachable) | A second symbol page; `?123` becomes a 3-state pager |
| 4 | ~~The answer hard-wraps mid-word~~ **WITHDRAWN — not a defect, a constraint.** See below | Nothing. The hard wrap stays. |
| 5 | Re-reading the prompt covers the keyboard, and then every tap is a pager tap | A persistent one-line prompt strip; the peek stays for the full detail |
| 6 | A character commits on **press**, so a mis-hit is already in the buffer | Release-commit with a magnified bubble |
| 7 | Hold-to-repeat on `DEL` is undiscoverable; clearing 150 bytes is 18 s of holding (`KB_REPEAT_EVERY_MS` 120) | `CLR` on the draft line |
| 8 | Board 1 has 12 spare pixels in 320 (4 margin + 4 + 4 + 0) against board 2's 70 | Named explicitly in every budget below |
| 9 | `KB_ACT_H` is *defined* as equal to `KB_ROW_H`, so the least-pressed control is the tallest, and it has no drawn/tested split | Band `TAP_MIN`, button `2 * KB_LINE_PITCH` |
| 10 | Keys are drawn with `R_MD`, the **card** radius: 10 px on a 22 px key is 45.5% of its width against 4.6% on the 216 px card, and it rounds 85.8 px² off the corners — **10.5%** of the drawn 22x37 key board 1 ends up with, and 7.6% (123.6 px²) of board 2's 30x54 — where a mis-aim lands | `KB_KEY_R`, derived from the key |

### Defect 4 is withdrawn, and the measurement that withdraws it

**Word wrap does not fit, and the evidence was already in this repo before I wrote the defect.**
`settings-geom-check.mjs:378` records that the voice-answer panel's worst case over the same 150
bytes is **exactly 8 lines** on board 1, at 17-character words, in a `CARD_W - 8` = 208 px lane.
The keyboard's lane is `CARD_W - 12` = **204 px** — narrower, so it can only be worse. Measured
directly with that same `worstWrappedLines()` search: **8 lines on board 1** (16-character words,
line lengths `[17x7, 31]`) and **8 on board 2** (17-character words, `[18x7, 24]`).

The card budgets **5**. That is a three-line gap on both boards, not a near miss.

So the hard wrap is **load-bearing, not an oversight**: slicing at exactly `KB_COLS` is what makes
`KB_TEXT_LINES = ceil(KB_MAX_BYTES / KB_COLS)` an arithmetic guarantee, and that guarantee is the
only thing stopping `SEND` signing text that scrolled off the card. Every escape was checked with
numbers and none exists: 8 lines end at y=129 on board 1 where the card ends at 91 and the keys
start at 96; narrowing `KB_COLS` is strictly worse; and the largest byte cap that fits 5
word-wrapped lines is 101, against a `KB_MAX_BYTES` pinned to the host's 150.

**The caret (defect 1) is independent and stays in scope.** Under the hard slice its position is
the `off / KB_COLS` division `drawKbText` already performs, and tap-to-place is the exact inverse
— which is *simpler* than it would have been under word wrap, not harder.

## Scope, and what is explicitly NOT in it

**In:** the reply panel, the sharpened keyboard, the shared draft, the key treatment, the
host-side token extraction and its wire field, and the checkers for all of it. Both boards.

**Out, each for a stated reason:**

- **Two-step group keys (6 columns, 2 taps per character).** It is the only direction that
  clears the floor by *geometry* on both boards, and it is the fallback if release-commit does
  not measurably cut the error rate. It is not spent first because it asks every user to
  relearn the alphabet on a device they use while distracted.
- **Rotating the panel.** Ten columns across board 2's long edge is a 48 px pitch — 7.40 mm,
  the only full QWERTY here that clears the floor. But board 1 gets 32 px (5.69 mm) and is
  still 20% short, nothing in this firmware rotates (`PanelShim`'s stride is `BOARD_W`, board
  1's touch is a 5-point affine solved in portrait), and a device propped on a desk does not
  turn.
- **Persisting recents.** They live in RAM and die with the session. Writing sent text to NVS
  would give the device a plaintext log of replies and a flash-wear budget, for a one-tap
  convenience. Reversible later; not the default.
- **Word wrap.** Withdrawn above on measurement, not preference. Revisit only if `KB_MAX_BYTES`
  ever drops below ~101 or the card gains three lines, and re-run `worstWrappedLines()` first.
- **Predictive text or autocorrect.** No dictionary, no RAM for one on board 1, and a wrong
  correction on an answer to Claude is worse than a wrong character.
- **Raising `KB_MAX_BYTES`.** It is 150 on the host too (`ANSWER_TEXT_MAX_BYTES` in
  `host/voice-answer.mjs`, re-exported as `TYPED_TEXT_MAX_BYTES`). One limit, two sides.

## The two screens

`kbActive` currently means "the keyboard is up". It now means **"compose is up"**, on one of two
surfaces, and `closeKeyboard()`'s repaint contract has to learn the difference. That is the
single largest structural change here and the one most likely to produce the class of bug
`closeKeyboard()`'s own comment already documents — a screen that no longer matches the touch
router.

### Interaction model

| On | Gesture | Result |
|---|---|---|
| Reply panel | tap a reply button | **Sends.** One tap. The draft line becomes a `SENT:` receipt and the action row collapses to `DONE`. |
| Reply panel | tap a token chip | Inserts the token at the caret. The chip's **label** may be truncated; its **value** never is. |
| Reply panel | tap the token pager | Advances the token row. |
| Reply panel | tap a recent | Replaces the draft. |
| Reply panel | `CLR` on the draft line | Empties the draft. |
| Reply panel | `TYPE...` | Opens the keyboard **with the draft in it**. |
| Reply panel | `CLOSE` / `DISCARD` | Leaves compose. Relabels and turns `COLOR_WARN` when there is a draft to lose. |
| Keyboard | press, slide, release on a key | Commits the key **under the finger at release**. |
| Keyboard | press `DEL` | Deletes on press, repeats on hold (unchanged). |
| Keyboard | drag in the text card | Places the caret. |
| Keyboard | tap the prompt strip | Opens the full paged peek (unchanged). |
| Keyboard | `BACK` | Returns to the reply panel, draft intact. |
| Either | `SEND` | Sends the draft. |

**Four control kinds, distinguished by FORM and never by colour**, because CLAUDE.md rules that
out and because the three rows on the reply panel do three different things:

| Kind | Form | Reasoning |
|---|---|---|
| send | filled `COLOR_GOOD`, label centred | the colour `SEND` already owns |
| insert | `COLOR_CARD` fill, **no stroke**, `FONT_CODE`, left-aligned, prefixed `+ ` | a flag is literal text; the verb belongs in the control, not the legend |
| reuse | `COLOR_CARD` fill, `COLOR_LABEL` stroke, left-aligned | a recall is not an action |
| navigate | `COLOR_CARD` fill, `COLOR_ACCENT` stroke, centred | the shape `?123` already has |

Form, alignment and typeface all differ, so the panel survives a monochrome theme.

## Geometry

### The drawn/tested split, applied to every control

The keys already have it — `KB_KEY_W` is `KB_PITCH - 2` and the drawn height is `KB_ROW_H - 4`,
with the firmware putting all of that gap on the **right** and the **bottom**. The action row
never did, and neither did anything on the reply panel. Both get it:

- **Tested band: `TAP_MIN`.** These are the taps that answer Claude.
- **Drawn button: `2 * KB_LINE_PITCH`** — one cell for the glyph, one for the air. 26 px on
  board 1, 32 on board 2, which is 4.62 and 4.93 mm. Both boards centre it in the band with the
  same 7 px above and below, which fell out rather than being arranged.

Two consequences beyond the lighter look:

1. **Adjacent bands become contiguous.** The visual gap now comes from the inset rather than
   from a spacer, so the 4 px strip between two reply buttons where a tap did nothing is gone.
2. **Columns follow the firmware's own convention** — the cell is `lane/3` and the gap belongs
   to the button on its **left**, exactly as `KB_PITCH` relates to `KB_KEY_W`. The remainder
   lands on the last column so the row closes on the lane exactly (72+72+72 = 216;
   98+98+100 = 296).

### The key treatment: `KB_KEY_R`, and one stroke removed

`R_MD` is a card radius. Its replacement is derived **from the key itself**: `KB_KEY_R =
KB_KEY_W / 10` under C truncation, which gives 22/10 = 2 and 30/10 = 3 exactly. An earlier draft
claimed 2 "scaled by x1.154" to reach 3, which does not compute — 2 x 1.154 is 2.31, and that
truncates to 2 on both boards. The width-derived form is the one that holds:

| | board 1 | board 2 |
|---|---|---|
| `R_MD` today | 10 px = 45.5% of key width | 12 px = 40.0% |
| `KB_KEY_R` | **2 px** = 9.1% = 0.36 mm | **3 px** = 10.0% = 0.46 mm |
| corner area rounded away | 85.8 -> **3.4 px²** | 123.6 -> **7.7 px²** |
| as a share of the drawn key | 10.5% -> 0.4% | 7.6% -> 0.5% |

The two shares differ because `R_MD` scales x1.2 between the boards while the key scales x1.36,
so a single threshold describes neither. A checker asserting "about 9%" would pass on board 1 and
fail on board 2 while claiming to cover both.

And the key becomes a **filled tile**: `uiButton` already fills an unpressed control with
`COLOR_CARD` before stroking it, so the tile is that fill with `uiStrokeRound` dropped and the
label moved from `COLOR_ACCENT` to `COLOR_VALUE`. **This costs no new palette entry** — an
earlier draft of this design claimed it did, wrongly.

The reason to prefer it is not decoration: a 1 px outline on `COLOR_BG` leaves the key's
interior reading as background, so the target you aim at is smaller than the target that is
tested. Painted share of the tested cell, drawn area less the four corners:

| | board 1 (24x41 cell) | board 2 (32x58 cell) |
|---|---|---|
| today, `R_MD`, outlined | 75.2% | 80.6% |
| `KB_KEY_R`, filled tile | **82.4%** | **86.9%** |

**Whether `COLOR_CARD` lifts off `COLOR_BG` enough without the outline is a question for the
glass and cannot be settled here.** Two fallbacks, in order: a new per-theme keycap surface one
step above `COLOR_CARD` (the only change in this design that edits every theme), or keeping the
stroke and taking only the radius. On board 2 `SCREENSHOT` cannot answer this either — it reads
the shadow framebuffer. `COLORTEST` and a person are the instruments.

### Board 1's vertical budget, which closes exactly on 320

**Keyboard:**

```
  4  top margin
 17  prompt strip     KB_LINE_PITCH + 4
  3  gap
 88  text card        KB_TEXT_H, unchanged: 34 cols x 5 lines
  3  gap
164  key rows         4 x KB_ROW_H 41
  1  gap
 40  action band      TAP_MIN; 26 drawn, inset 7
---
320  == BOARD_H
```

**Reply panel:**

```
  4  top margin
 52  prompt card      5 + KB_LINE_PITCH + 4 + 2 lines + 4
  4  gap
 16  legend           KB_LINE_PITCH + 3
 80  reply            2 x 40 band, 26 drawn
 16  legend
 40  tokens           1 band
 21  draft line       KB_LINE_PITCH + 8
 16  legend           "recents: no vertical budget on board 1"
 31  residual
 40  action band
---
320  == BOARD_H
```

### Board 2's vertical budget, which closes exactly on 480

**Keyboard** — `KB_ROWS_Y`, `KB_ROW_H` and `KB_PITCH` are all **unchanged**; the prompt strip
comes out of the 38 px break the header already calls a residual with no job of its own:

```
  6  top margin
 20  prompt strip     KB_LINE_PITCH + 4
  8  gap
120  text card        KB_TEXT_H, unchanged: 35 cols x 5 lines
 16  gap
232  key rows         4 x KB_ROW_H 58, UNCHANGED
 24  gap
 46  action band      TAP_MIN; 32 drawn, inset 7
  8  bottom margin
---
480  == BOARD_H
```

**Reply panel** — same stack as board 1, one row taller because recents fit:

```
 12  top margin
 77  prompt card      5 + KB_LINE_PITCH + 4 + 3 lines + 4
  8  gap
 19  legend           KB_LINE_PITCH + 3
 92  reply            2 x 46 band, 32 drawn
 19  legend
 92  tokens           2 x 46 band
 24  draft line       KB_LINE_PITCH + 8
 19  legend
 46  recents          1 band
 18  residual
 46  action band
  8  bottom margin
---
480  == BOARD_H
```

**Board 2's 64 px residual is the first place to spend anything.** A **second token band** costs
46 of it and would show 3 of 4 chips without paging, where board 1 shows 2. It is deliberately
NOT in this design: one band on both boards keeps the two panels structurally identical, and
paging already reaches every token. If the pager proves annoying on board 2, this is the change
to make, and the residual is already there for it.

**Every per-board term above is one of six expressions** — `TAP_MIN`, `KB_LINE_PITCH + k`,
`2 * KB_LINE_PITCH`, `KB_TEXT_H`, `n x KB_ROW_H`, or a residual with no job of its own. There is
no term whose value was chosen rather than derived, which is the property that lets a checker
assert the column instead of transcribing it.

### What board 1 pays

**The action row moves on BOTH boards** — `KB_ACT_H` 44 -> 40 and `KB_ACT_Y` 276 -> 280 on board
1, 58 -> 46 and 414 -> 426 on board 2 — because `KB_ACT_H == TAP_MIN` is a per-board derivation,
not a board-1 concession. An earlier draft of this section said "only on board 1" and was wrong.

**What board 1 alone pays is `KB_ROW_H` 44 -> 41.** Both it and the shorter action row still clear
`TAP_MIN` (40). With 12 spare pixels there was no room for a prompt strip, and those two together
are what buy it — which is why defect 9 is in scope rather than deferred.

**`KB_MAX_BYTES`, `KB_COLS` and `KB_TEXT_LINES` do not move on either board.** The card keeps
its 5 provable lines, so `SEND` still cannot sign text that is off the card.

**Recents do not fit on board 1.** The two boards' reply panels differ by one row, and the
board-1 panel says so on the glass rather than leaving a gap.

## The token chips: host, wire, firmware

**Extraction belongs on the Mac.** The host already parses the ask into its title and detail and
already transliterates to ASCII, so it can ship a short token list and the firmware only draws
buttons.

**Rules, in order, applied AFTER `toAscii()` so the byte cap is exact:**

1. backticked spans
2. tokens beginning `--`, or `-` followed by a letter (flags)
3. whitespace-free tokens containing `/` (paths)
4. quoted spans

Then dedupe, preserve first-appearance order, drop anything over **48 bytes**, cap at 4.

**The cap was 32 and that was wrong.** 32 matched `askOpts[4][34]`'s label cap, which was a tidy
symmetry and nothing more — and it drops exactly the tokens this feature exists to make typeable.
`/Users/yujia/projects/deckhand/build` is 36 bytes; `firmware/deckhand_display/keyboard.ino`, a
path this plan edits constantly, is 38. A cap that silently discards those defeats the case the
spec itself names as the hardest thing to type on this device. 48 covers every path above except
a 59-byte docs path, at a stated cost of **384 more bytes of DRAM**.

**Wire:** a `chips` array on the existing ask JSON, beside `detail` and `opts`. **The ask line's
headroom must be measured in task 1, not assumed** — `askDetail[1424]` already dominates that
line and 4 x 32 bytes plus JSON overhead is roughly 160 more.

**Firmware:** `char askChips[4][50]` on `SessionInfo` — 48 bytes plus a NUL, deliberately NOT
matching `askOpts[4][34]`. **DRAM cost, stated the way the option-descriptions cap was:**
`4 x 50 x MAX_SESSIONS(6)` = **1,200 bytes**, against board 1's ~26 KB of free heap — 4.5% of it,
up from 3.1% at the 32-byte cap. The 384-byte difference buys the absolute paths the reply panel
exists to spare you typing.

**Recents:** a global ring of 4 x 150 bytes = 600 bytes, RAM only, not per session.

## The touch model change

`handleTouch` dispatches on press and ignores a held finger. **On the key band only**, that
inverts:

- press arms a candidate and draws the bubble
- each tick re-samples `getTouchPoint()` and re-targets — `tickKbRepeat()` already proves the
  firmware can do exactly this, and already re-qualifies against a key's own rectangle
- release (`getTouchPoint()` returning false, the same signal `tickKbRepeat` uses) commits

**Everything else keeps press-commit** — row 3, the action row, the text card, the peek, and the
whole reply panel — because every target there clears the floor. **`DEL` is the one exception
inside the key band:** it commits on press so a tap still deletes immediately, and repeats on
hold, unchanged.

**The bubble is clamped inside the key grid and never touches the text card.** For row 0 it is
drawn *below* the finger instead of above. That removes the interaction with the card's
change-only cache entirely, which is the trap this repo has paid for twice (a repainted chrome
whose cache was not reset leaves the value blank). Restore is bounded: redraw the at most six
keys the bubble's rectangle overlapped, each through `drawKbKey`.

## What must not change

- **`KB_MAX_BYTES` = 150**, and the host's `ANSWER_TEXT_MAX_BYTES` with it.
- **The fonts are ASCII `0x20..0x7E`.** Every new string — `DISCARD`, `CLOSE`, `BACK`, `+`,
  the pager's `N>`, `SENT:`, `CLR` — is ASCII. Truncation uses **three ASCII dots**, never
  U+2026. Chips are ASCII because the host transliterates before capping.
- **Every field redraws only when its value changes.** New caches must be at least as long as
  the padded strings they hold; the draft line and the `SENT:` receipt both change per keystroke
  and are repainted wholesale, like `drawKbText()` already is, rather than cached.
- **`#if` on a `const int` is silently false.** Any new board flag is a `#define`.
- **No panel dimension is hardcoded.** Every number above is derived from `BOARD_W`/`BOARD_H`,
  `TAP_MIN`, `KB_LINE_PITCH` or `KB_PITCH`.
- **No function signature may name** `SessionInfo`, `Theme`, `Usage`, `HostPairing` or
  `ConfirmAction`, because of the generated prototypes.

## Verification

Four rules govern every checker here, each learned by paying for it: **parse the constant, never
transcribe it**; **an assertion that cannot fail is a defect** — the test is whether reverting
the constant makes it fail *by name*; **bind to a function body, not to a file**; and **a mirror
proves the algorithm and binds nothing**, so structural and mirror halves report separately.

- **`settings-geom-check.mjs`** (which already covers the keyboard and asserts the caret's
  furthest reachable position per board) gains: both screens closing exactly on `BOARD_H`; every
  tested band `>= TAP_MIN`; every drawn button strictly inside its band; the reply panel's
  columns summing to the lane; `KB_KEY_R` against `KB_PITCH`; and `KB_TEXT_LINES ==
  ceil(KB_MAX_BYTES / KB_COLS)` still holding on both boards.
- **`host/ask-chips-check.mjs`**, new, with `--selftest`. It must **parse `askChips`'s
  dimensions out of the firmware** the way `ask-optdescs-check.mjs` parses `askDetail`'s, and
  assert the host's cap fits the firmware's buffer — not restate 32 on both sides.
- **`host/wire-bytes-check.mjs`** gains the `chips` field and the extraction-after-`toAscii`
  ordering, which it already checks for the voice path and can check the same way.
- **`docs/design/compose/check.mjs`**, new, binding the mock to **both** headers.
- **`geom-sweep.mjs`** fault injection over the new constants.
- **A new device command, `KBPROBE`**, logging per keystroke the key pressed, the key released,
  and the pixel delta between them. **A's entire case is that release-commit cuts mis-hits, and
  that is a claim, not a fact.** This is what turns it into a number, before and after.
- **Both baselines are re-taken deliberately**, with the reason in the commit message. Board 1's
  current baseline is `8f64b7f7...` / 1387024, taken 2026-09-02; it has been re-taken before and
  the mechanism exists for exactly this. The rule is that a change to board 1 must never be a
  *surprise*, which is not the same as never happening.

## Costs

- **Board 1's binary and RAM both move.** 1,200 bytes of chips plus 600 of recents plus the new
  screen, on a board with ~26 KB free.
- **A second surface, and a state that did not exist.** The `kbActive` widening is where the
  risk is.
- **Host, wire and firmware in one feature.** Three checkers touched or added.
- **The two boards' reply panels differ by a row.**
- **Bad chips are worse than none.** If extraction picks wrong, the panel fills with noise you
  read past to reach `TYPE...`.
- **A one-tap send has no undo.** The ask screen already answers immediately, so the precedent
  is real — but it is being inherited deliberately, not by accident.

## What this design cannot verify

- **That most answers are short.** Everything about the reply panel rests on it. The host has
  the history; measuring it is cheap and has not been done. If typed answers turn out to be
  sentences, the reply panel's value drops and the two-step keyboard's cost falls with it.
- **That release-commit reduces the error rate.** Hence `KBPROBE`. If it does not, the fallback
  is six columns and two taps per character, and this design has spent its budget without
  fixing the measurement.
- **That the filled tile reads as a key.** Needs `COLORTEST`, both themes, both panels, and a
  person. A board-2 screenshot vouches for geometry and nothing else.
- **That the chip labels are the right tokens.** Four heuristics against real prompts is an
  empirical question, and the honest first version is a checker over a corpus of real asks
  rather than a claim here.
