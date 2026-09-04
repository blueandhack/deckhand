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

`node docs/design/compose/check.mjs` **exits 1** as committed, with 26 failures
across both boards. Every one of them is a constant a later task of the compose
plan adds or moves:

| | board 1 | board 2 |
|---|---|---|
| **names no header defines yet** (9 each) | `KB_KEY_R` `KB_STRIP_Y` `KB_STRIP_H` `KB_ACT_DRAWN` `KB_ACT_DY` `COMPOSE_PROMPT_H` `COMPOSE_LEGEND_H` `COMPOSE_DRAFT_H` `COMPOSE_GAP` | the same nine |
| **names still at their pre-compose value** | `KB_TEXT_Y` 4→24, `KB_ROWS_Y` 96→115, `KB_ROW_H` 44→41, `KB_ACT_Y` 276→280, `KB_ACT_H` 44→40 | `KB_TEXT_Y` 12→34, `KB_ACT_Y` 414→426, `KB_ACT_H` 58→46 |

Tasks 2, 3, 6 and 10 land them. **Each failure goes green when its task does, and
until then the checker prints the name.** That is the binding working, not a
broken checker.

There is deliberately **no "not yet defined" escape hatch**. An assertion a
constant's *absence* can satisfy is an assertion that cannot fail, which is the
defect this whole family of files exists to prevent. What the closing summary
does instead is *sort* the failures — "waiting on a later task" against
"UNEXPECTED" — by mechanism only: a `[bind]` message naming one of the fourteen
constants above. **The number that must be zero is the UNEXPECTED count.** A bind
failure on any other name, or a failure from any other assertion group, lands
there and is a real defect.

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
  key pages rather than restated. Defect 3 of the spec is 14 unreachable
  characters; the second symbol page exists for exactly those, and this
  assertion names any that go missing.
- **Sub-floor controls are named, in a list that is exact in both directions.** A
  control tested under `TAP_MIN` that no `EXCEPTIONS` entry covers **fails**, and
  an entry that no longer matches anything sub-floor **also fails**, so the list
  cannot rot into a blanket permission. There are three: the key band's width
  (the design's premise), the keyboard's prompt strip height, and the draft
  line's height, which carries `CLR` and `TYPE...`. The repo has the precedent —
  `HIST_CHIP_H` ships at 17 drawn / 24 tested and says so.
- **The drawn/tested split exists per control.** A control drawn at exactly its
  tested size fails; the surfaces that *are* their own target (the peek cards,
  the caret lane) are exempt by name, not by accident.
- **No two controls in one band have overlapping tested rects.** An ambiguous
  tap is worse than a dead one: the wrong thing happens rather than nothing.
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
the *same* `run()` the normal path uses, and exits 0 only when the **budget**
assertion is among the catchers — it names all 13 new failures, 6 of them
`[budget]`. Because this checker has expected failures today, "did anything
fail" cannot be the test; the test is whether the failure set **grew**, and
whether the growth came from the assertion that claims the column closes.

## Two places where the mock departs from the spec, on purpose

Both are recorded here rather than silently absorbed, because after this task the
mock is the authority and the spec's tables are not.

1. **Board 2's token row is ONE band, and its residual is 64 — not the budget
   block's "2 x 46 band" and "18 residual".** The spec contradicts itself: three
   prose claims in the same document say one band ("one band on both boards keeps
   the two panels structurally identical"; "a second token band costs 46 of [the]
   64 px residual … It is deliberately NOT in this design"; "same stack as board
   1, one row taller because recents fit"), and the chip arithmetic settles it —
   the host caps chips at 4, a token band is 3 columns (2 chips + the pager), so
   one band shows 2, which is what the spec says board 1 shows, and a second band
   would re-lay out at 2 wider columns to show "3 of 4 chips", also exactly what
   the spec says. Six 3-column cells could never fill from a 4-chip cap. **Both
   columns close on 480 either way**, so flipping it is `RP_TOKEN_BANDS` 1→2 and
   `RP_RESIDUAL` 64→18 in `compose.js`, one line each, and the checker will hold
   the new column to 480 just as tightly.
2. **`TYPE...` and `CLR` both live on the draft line, not in the action band.**
   The lane is three columns and the spec requires `DISCARD` at **half** `SEND`'s
   width, so the action row has to be `DISCARD`(1 cell) + `SEND`(2 cells) — there
   is no third cell for `TYPE...`. Both draft-line controls operate on the draft,
   which is what the line already holds. `CLR` is `TAP_MIN` *wide* even though it
   is three characters, because there is no reason to be short in both axes when
   the lane has the pixels.

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
