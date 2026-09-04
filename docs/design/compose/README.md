# The compose surface — the design artifact, bound to BOTH board headers

`compose.html` + `compose.js` are a **pixel-accurate mock of the reply panel and
the sharpened keyboard, on both boards**, and they are the geometric spec the
firmware is built from. Serve this directory and open `compose.html`.

The design it draws is
[`docs/superpowers/specs/2026-09-04-compose-surface-design.md`](../../superpowers/specs/2026-09-04-compose-surface-design.md).
Fourteen pictures: two screens x two boards x their states (a draft, an empty
draft, a sent receipt; the keyboard's three pages and its shift state).

```
node docs/design/compose/check.mjs             # binds K to both headers
node docs/design/compose/check.mjs --selftest  # proves the bind has teeth
```

## THIS CHECKER FAILS TODAY, BY NAME, AND THAT IS THE POINT

`node docs/design/compose/check.mjs` **exits 1**. Every failure is one of two
kinds — a name no header defines yet, or a name still at its pre-compose value —
and each is a constant a later task of the compose plan adds or moves. **Each
failure goes green when its task does, and until then the checker prints the
name.** That is the binding working, not a broken checker.

**How many there are, and which, is not written down here.** It was, and it went
stale the moment a task landed one — twice, costing a review finding each time.
`PENDING` in `check.mjs` is the record, and the checker's closing summary counts
and names both kinds live from it. **Run it and read its last few lines: that is
the single authority.** The number that must be zero is the UNEXPECTED count,
which the same summary prints.

There is deliberately **no "not yet defined" escape hatch**. An assertion a
constant's *absence* can satisfy is an assertion that cannot fail, which is the
defect this whole family of files exists to prevent. What the closing summary
does instead is *sort* the failures — "waiting on a later task" against
"UNEXPECTED" — and **the number that must be zero is the UNEXPECTED count**.

### The excuse names the VALUE, not just the name

`PENDING` in `check.mjs` is keyed on `board:name` and pins **both** values:
`[ what this mock targets, what the header holds today ]`, with `null` meaning
"the header does not define the name at all". A bind failure is excused only if
**both** halves still match.

It began as two lists of bare names, and that was an excuse that could not fail.
Matching on the name alone excused any value, with two consequences:

- setting `K[1].KB_ROW_H` 41 → 40 with a compensating gap in `D` produced
  **byte-identical** output, `0 UNEXPECTED` included;
- worse, a later task landing `KB_ROW_H = 42` in the header would have read
  exactly like that task **not having run** — which defeats the binding for
  precisely the constants Tasks 2, 3, 6 and 10 exist to add.

Three `[pending]` assertions now guard the table itself, and none of them is ever
excused: an **orphan** entry naming a constant the mock does not have; a **mock
target** that has moved away from the value the excuse was written for; and a
**header value** that is no longer the pre-compose one. That last message reads
differently depending on which happened — "the task landed it RIGHT, so delete
this line" versus "the task landed it WRONG, which is NOT the same as it not
having run" — because those need different actions. The table cannot rot: once a
constant lands correctly its bind failure disappears and its `PENDING` line
starts failing, so deleting the line is part of the diff that landed it.

The first column duplicates `K`, deliberately, and it is the same shape as `WAS`
in `settings-redesign/check.mjs`: a second independent record is what makes the
excuse exact, where deriving it from `K` would excuse whatever `K` happens to
say.

## What is exact and what is not

- **Geometry is exact.** Every rectangle, band, column and text *origin* is the
  number the firmware will use.
- **Glyph rendering is approximate.** `compose.html` paints with a browser
  monospace face stepped at each board's real advance and cell, so a string
  occupies exactly the pixels the panel advances through — but the ink inside
  each cell is not the panel's. Board 1 draws Cozette 6x13 and **this repo has no
  JS dump of it** (`settings-redesign/spleenfonts.js` is Spleen, i.e. board 2
  only); inventing one would be the "flattered by a Mac font" mistake that mock
  already paid for. `check.mjs` re-derives `ADV` and `CELL` from the firmware's
  own glyph tables via `geom-common`'s `advanceB()`/`lineHB()`, so the *metrics*
  are bound even though the bitmaps are absent.
- **Text is placed by its cell box, top-left.** The device's `MC_DATUM` centres
  on the ASCENT and so sits biased low by half the descent
  (`geom-common.mjs`'s `mcBox()`). That is a property of `drawString`, not of
  this layout, and it is task 6's business.
- **Colour is not settled here.** Whether the filled keycap lifts off
  `COLOR_BG` without its stroke needs `COLORTEST`, both themes, both panels and
  **a person**. On board 2 `SCREENSHOT` reads the shadow framebuffer and vouches
  for geometry alone.

## The two-board bind — what a later task needs to know

Every other `check.mjs` in `docs/design/` calls `consts("board_es3c35p.h")` once
and describes board 2 alone. This one does:

```js
const H = { 1: consts("board_e32r28t.h"), 2: consts("board_es3c35p.h") };
```

and loops both in every assertion. Three things make that work, and a later
two-board checker will need all three:

1. **`geom-common`'s `BOARD_OF` maps a header FILENAME to a board number**, which
   is what lets one process hold two boards' constant tables at once.
2. **Parse the header immediately before any `.ino` seeded with it.** `consts()`
   tracks the current board from the last header parsed, so `consts(header)` then
   `consts("keyboard.ino", H[b])` is the order — the compiler's order, and the
   one `geom-sweep.mjs`'s injection accounting depends on.
3. **`KB_MAX_BYTES` is in `keyboard.ino`, not a header.** It is parsed (150 on
   both boards) rather than restated, so `KB_TEXT_LINES == ceil(KB_MAX_BYTES /
   KB_COLS)` is a real assertion on both panels.

`K` is per board and holds only names a header does or will define. The mock's
own terms — margins, gaps, the single residual, band counts, the prompt card's
line count — live in `D`, deliberately outside the bind, because a name in `K`
the header does not define has to **fail** rather than be skipped. `D` is not
free either: the checker asserts each column closes exactly on `BOARD_H` and
that every anchored band's cumulative offset equals the `K` constant naming it,
so a gap that drifts moves an anchor and fails.

## What the checker asserts, beyond the bind

- **The four vertical budgets close exactly on `BOARD_H`** — 320 twice and 480
  twice — and the anchored bands land on `KB_STRIP_Y`, `KB_TEXT_Y`, `KB_ROWS_Y`
  and `KB_ACT_Y`. The action band lands at the **same** `KB_ACT_Y` on both
  screens of a board, which is derived rather than arranged.
- **The derivations**, each comparing two independent literals: `KB_STRIP_H ==
  KB_LINE_PITCH + 4`, `COMPOSE_LEGEND_H == KB_LINE_PITCH + 3`,
  `COMPOSE_DRAFT_H == KB_LINE_PITCH + 8`, `COMPOSE_PROMPT_H == 5 +
  KB_LINE_PITCH + 4 + n lines + 4`, `KB_ACT_H == TAP_MIN`, `KB_ACT_DRAWN == 2 *
  KB_LINE_PITCH`, `2 * KB_ACT_DY + KB_ACT_DRAWN == KB_ACT_H`, `KB_PITCH -
  KB_KEY_W == 2`, `KB_KEY_R == KB_KEY_W / 10`, `KB_COLS == (CARD_W - 12) /
  TEXT_ADV`, `KB_TEXT_LINES == ceil(KB_MAX_BYTES / KB_COLS)`.
- **The three columns sum to the lane** — 72+72+72 and 98+98+100 — checked
  against the **header's** `CARD_W`, with the remainder on the last column.
- **The fingertip floor, as arithmetic.** `KB_PITCH < TAP_MIN` and
  `floor(BOARD_W / TAP_MIN) < 10` are *asserted*, because they are the premise of
  the whole design: if either stops holding, the case for a reply panel has to be
  re-argued rather than assumed. `KB_ROW_H >= TAP_MIN` is asserted too — height
  was the one dimension that cleared, and this design must not spend it (board 1
  clears by exactly 1 px at `KB_ROW_H` 41).
- **All 95 printable ASCII characters are reachable**, enumerated from the three
  key pages **and from row 3's own definition** rather than restated. Defect 3 of
  the spec is 14 unreachable characters; the second symbol page exists for exactly
  those, and this assertion names any that go missing. It used to end
  `reach.add(" "); reach.add(".")` — a hand transcription of 2 of the 95, because
  row 3 was three inline draw calls and not in `PAGES` at all, so the sweep
  credited the row with characters it had never read. Row 3 is now the `KB_ROW3`
  table the renderer walks, and a character cell there carries **only** `emits`,
  with its label *derived* from that (as `keyLabel()` derives a letter key's).
  There is therefore no label to change independently of the character. This
  matters beyond the mock: **Task 4's whole deliverable is codepoint
  reachability**, and this is its gate.
- **Sub-floor controls are named, in a list that is exact in both directions.** A
  control tested under `TAP_MIN` that no `EXCEPTIONS` entry covers **fails**, and
  an entry that no longer matches anything sub-floor **also fails**, so the list
  cannot rot into a blanket permission. There are three: the key band's width
  (the design's premise), the keyboard's prompt strip height, and the draft
  line's height, which carries `CLR` **alone**. The repo has the precedent —
  `HIST_CHIP_H` ships at 17 drawn / 24 tested and says so.
- **The drawn/tested split exists per control.** A control drawn at exactly its
  tested size fails; the surfaces that *are* their own target (the peek cards,
  the caret lane) are exempt by name, not by accident.
- **No two controls in one band have overlapping tested rects.** An ambiguous
  tap is worse than a dead one: the wrong thing happens rather than nothing.
- **The action row is `uiActionRow()`'s arithmetic, not the three-column model.**
  Two column systems live on the reply panel and they are not the same: the
  reply/token/recent bands are `lane/3` cells with the 2 px gap on the left
  button's right (72+72+72 and 98+98+100), while the **action band** is
  proportional — `gap = 8`, `avail = lane - gap*(n-1)`, `w[i] = avail *
  fracs[i] / total` under C truncation, the remainder on the last, and each
  tested zone **swallowing the gap to its right**. The checker asserts the reply
  panel's row carries **three** controls (`CLOSE`/`DISCARD`, `TYPE...`, `SEND`)
  at fracs `{1,1,2}`, that `SEND`'s drawn width is **exactly twice** the left
  control's (board 1: 50 / 50 / 100; board 2: 70 / 70 / 140), that consecutive
  drawn buttons sit exactly `ACT_GAP` apart, that the row closes on the lane, and
  that `BOARD_W - 2*CARD_X` equals the **header's** `CARD_W` — since
  `uiActionRow` derives its lane from `tft.width()` while the panel derives its
  from `CARD_W`. (The keyboard's two-control row is 69/139 rather than 69/138
  because the last column takes the remainder; only the three-control row is
  exact, and only that one is asserted as such.)
- **`ACT_GAP` is bound as of Task 3.** `uiActionRow()` now exists, so `const int
  gap = 8` is **parsed out of its body** — brace-matched from the definition,
  with two parse gates asserted before the comparison — the way
  `settings-geom-check.mjs` parses the severity spine's `uiFillRound()`
  arguments. Changing the firmware's gap to 6 fails here by name (verified), on
  top of the older assertion that the band arithmetic must not drift from the
  draw arithmetic.
- **On the reply panel, `CLR` is the only control allowed under `TAP_MIN`, and
  only in height.** Asserted directly as a set equality, so it fails both if
  something else goes sub-floor and if `CLR` stops being sub-floor. Its
  `EXCEPTIONS` entry names the **label**, not just the band, so a control parked
  on the draft line cannot inherit `CLR`'s reason: that reason is about a
  recoverable clear of a draft you can still see, and it is false of `TYPE...`,
  which is the only bridge from this panel to free text.
- **The lane-wide bands tile the lane exactly**, read off the *drawn* control
  rects rather than off `colWidths()`. A gap between two tested rects is a strip
  where a tap does nothing, and removing one such strip is why this design makes
  adjacent bands contiguous.
- **Controls sit only in bands the column declares tappable**, and **every
  tappable band carries a control on at least one state of its screen.** A
  control in a legend or the residual fails; so does a dead tappable band, which
  is how the residual — whose whole job is to have no job — would quietly
  acquire one. The union across states is what is checked, because the draft
  line legitimately holds no control once the reply is sent.
- **No string leaves `0x20..0x7E`.** An out-of-range codepoint draws nothing AND
  advances nothing, so truncation is **three ASCII dots** and a chip label that
  used U+2026 fails by name. `BAD_CHARS` is scanned after every screen.
- **A chip's label may be truncated; its value never is.** Every drawn insert
  label must be `"+ " + value` or a three-dot truncation of it, and every value
  must be ASCII and within the host's 32-byte cap, four chips at most.

Six assertions were written and then **removed or rewritten because they could
not fail** — a derivation compared against its own term always holds. They are
recorded in comments where they used to be, so the next reader does not put them
back: `colX(b,0) == K[b].CARD_X` (bound to the header instead), "the first two
columns are equal" and "the remainder landed on the last" (properties of
`colWidths()`'s own arithmetic, now *printed*), "the bands are contiguous"
(`stack()` assigns `y` cumulatively), the drawn band count against the column's
term count (one band per term by construction), and `hardWrap()`'s output length
against its own cap (now: does the draft *need* more lines than the card has).
Every remaining assertion was fault-injected one at a time and confirmed to fail
by name.

`--selftest` pushes `COMPOSE_DRAFT_H` up by 8 on both boards, in memory, through
the *same* `run()` the normal path uses. Because this checker has expected
failures today, "did anything fail" cannot be the test; the test is whether the
failure set **grew**, and whether the growth includes the assertion the verdict
names.

**It names the assertion, not its tag.** Every assertion may carry a stable `id`,
and the verdict requires `column-closes:1:reply` and `column-closes:2:reply` to
newly fail. Gating on the `[budget]` **tag** was not enough — four assertions
share it, so replacing `chk(S.total === k.BOARD_H)` with `chk(true)` left the
`KB_ACT_Y` anchor assertions firing, the tag still present, and the verdict still
printing "the column no longer closes on BOARD_H" while being blind to the very
assertion it named. Group-level teeth behind an assertion-level claim is the same
defect as an assertion that cannot fail.

## One place the mock departs from the spec, and one where it was wrong

Kept and marked rather than deleted, which is this repo's rule: a described
decision that turned out wrong costs the next reader either the time to disprove
it or a no-op "fix".

### 1. Board 2's token row is ONE band, residual 64 — and the spec now agrees

The spec's board-2 reply budget block used to say "2 x 46 band" and "18
residual" while three prose passages said one band and 64. One band is the
considered choice: the two panels stay structurally identical and paging already
reaches every token. `9d21d8c` fixed the stale block, so this is no longer a
departure at all. Flipping it, if the pager ever proves annoying on board 2, is
`RP_TOKEN_BANDS` 1→2 and `RP_RESIDUAL` 64→18 in `compose.js` — one line each,
and the checker will hold the new column to 480 just as tightly.

**The reasoning this README gave for the choice was itself shaky and is corrected
here:** it argued that six `lane/3` cells could never fill from a 4-chip cap. But
the token row is variable-width chips, not fixed cells, so a 4-chip cap would in
fact fill two bands *better* than one. The answer is right; the argument for it
is the spec's, not that one.

### 2. ~~`TYPE...` and `CLR` both live on the draft line~~ — WRONG, and fixed

**This was a defect in the mock's first version.** The reading was that the lane
is three `lane/3` cells, so an action row satisfying defect 2 (`DISCARD` at
**half** `SEND`) had to be `DISCARD`(1 cell) + `SEND`(2 cells) with no third cell
for `TYPE...` — which pushed `TYPE...` onto the draft line, the one sub-floor
band on the screen.

**`uiActionRow` takes proportions, not cells.** It sums the fracs and divides the
lane by the total, so `{1,1,2}` puts `SEND` at half the lane and the other two at
a quarter each: `SEND` is exactly twice `DISCARD` *with* a third control on the
row. Board 1: 50 / 50 / 100 in a 216 px lane with two 8 px gaps. Board 2:
70 / 70 / 140 in 296. `"DISCARD"` is 42 px of Cozette in 50 and 56 px of Spleen
in 70, so both fit.

The cells were the mistake, not the third control — and the consequence was worse
than cosmetic. `TYPE...` is the only bridge from the reply panel to free text, so
making it the hardest control on the screen to hit inverted the design's own
priority: the 20% case that stops the panel being a dead end would have been the
worst-served thing on it. `CLR` keeps the draft line and keeps its exception,
which now names `CLR` **by label** so nothing else can inherit its reason.

And one number in the spec that is right for the wrong board: defect 10's "it
rounds 85.8 px² — **9.8%** of the drawn key" is board 1's alone, computed against
`KB_ROW_H` 44. At the new 41 the drawn key is 22x37 and the figure is **10.5%**;
board 2's has always been **7.6%** (123.6 px² of a 30x54 key), because `R_MD`
scales x1.2 between the boards while the key scales x1.36. The checker therefore
asserts the threshold that holds on both panels (>5%, and an order of magnitude
more than `KB_KEY_R` rounds) and **prints the real numbers** rather than
transcribing one board's.

## What this does NOT prove

Nothing here has been on the glass. It is arithmetic and rectangles, which is the
right instrument for layout and the wrong one for colour, for whether a filled
tile reads as a key, and for whether release-commit actually cuts mis-hits — that
last one is `KBPROBE`'s job and it is a claim until then.
