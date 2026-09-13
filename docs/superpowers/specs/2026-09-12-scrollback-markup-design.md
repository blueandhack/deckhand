# SCROLLBACK MARKUP: code, lists and links that read on the glass

Board 2's scrolling transcript renders code, lists and links as flat prose in a 34-column
lane. This is the design for **Option B** of five treatments mocked and compared at true
320x480; A is folded in as its prerequisite, C and D are explicitly out and say why.

Surface: `scrollback.ino`, board 2 only, behind `BOARD_HISTORY_SCROLL`. Reference:
[`docs/reference/scrollback.md`](../../reference/scrollback.md). Predecessor spec:
[`2026-09-03-scrollback-transcript-design.md`](2026-09-03-scrollback-transcript-design.md).

---

## THE SIX FINDINGS, EACH WITH THE LINE THAT CAUSES IT

Nothing below is a matter of taste. Each is a place where the pipeline **discards information
it had**, or draws a row that **misstates the source**.

1. **The fence language is thrown away on the Mac.** `histBlockText` normalises every fence to
   a bare ``````````` (````out.push("```")````), so the device could not label a block if it wanted to.
2. **Inline code is erased.** Spans are protected during emphasis stripping and then restored
   **without** their backticks, so `SCROLL_COLS` arrives indistinguishable from prose. There is
   no bold face on this board, so nothing replaces the marker.
3. **Code loses its indentation the moment it wraps.** `scrollWalk` takes `n = cols` for
   `inCode` and the continuation restarts at column 0. Indentation is most of how code is read,
   and at 34 columns most real code wraps.
4. **A block has no edges.** The treatment is a per-row `COLOR_CARD` fill, so a one-line block
   is indistinguishable from a highlighted prose line and a block straddling the viewport has
   no top or bottom.
5. **Link markdown reaches the glass whole.** `[text](path)` spends two of 27 rows on brackets
   and a path. A bare URL has no spaces, so the word-wrap's "give up past half a lane" fallback
   drops through to a hard cut at 34 and chops it mid-token.
6. **A wrapped bullet has no hanging indent.** Its second line begins at the same column as the
   `*`, so a two-item list and a four-line item look alike.

## THE CONSTRAINT THAT GOVERNS EVERY CHOICE HERE

Spleen declares `0x20..0x7E`. The board carries **no bold face and no smaller size**. Weight,
italics and a tighter grid are all unavailable, so the only materials are **colour**,
**ground**, **position** and **1px rules**. Every treatment below is built from those four, and
an option that needed a fifth was not considered.

## TWO COMMITS, BECAUSE THEY CARRY DIFFERENT RISK

The split is not tidiness. Commit 1 **cannot move either binary** and can ship and be watched on
its own; commit 2 is firmware and re-takes board 2's baseline. Separating them keeps the
baseline story one sentence long at each step.

---

## COMMIT 1 - THE MAC STOPS DISCARDING IT (`histBlockText`)

Three changes, all inside `host/index.mjs`, none reaching a `.ino` file.

1. **Keep the fence info string.** ````out.push("```" + lang)```` on OPEN, bare ``````````` on CLOSE.
   **This is backward compatible and needs no version bump**: `scrollWalk`'s fence test is
   ````srcLen >= 3 && t[pos] == '`' && t[pos+1] == '`' && t[pos+2] == '`'````, which still toggles and
   still draws nothing, so a board running today's firmware ignores the language rather than
   printing it. Board 1's reader never sees `block` at all - it reads `t`/`full`, which
   `histFlatten` produces - so it is untouched by construction.
2. **Restore inline spans WITH their backticks.** The span-protection machinery already exists
   so that stripping `**` cannot eat asterisks inside a span; only the restore drops the
   markers. The backtick is ASCII, it is inside Spleen's range, and **it is the only marker that
   carries meaning here without a bold face**.
3. **Collapse links, outside fences only.** `[text](url)` becomes `text~`; a bare URL becomes
   `host/.../tail~` when it exceeds 28 characters. Backticks are already protected at this point
   in the function, and the transform sits inside the existing `if (!inFence)` arm, so a URL
   *in* code is left exactly as written.

**THE `~` IS DOING WORK, NOT DECORATION.** Collapsing a link otherwise destroys the fact that a
target existed, silently, and silence and "there was never a link here" are indistinguishable
from the Mac - the class this repo's refusal messages exist for. It says "there was a URL here".
It cannot be followed; that is Option D.

## COMMIT 2 - THE RENDERER LEARNS SHAPE (`scrollWalk` + BOTH DRAW PATHS)

`scrollWalk` gains one out-param, `uint8_t* indent`, and one flag, `SCROLL_F_HEADEND` (0x8).

| change | mechanism | row cost |
|---|---|---|
| code keeps its indent on wrap | continuation hang = the source line's `lead + 1`, capped | may add |
| bullets hang | `* ` / `- ` / `N. ` sets hang to the marker's width | may add |
| block edge bar | 2px at x=20, `COLOR_LABEL`, on every `SCROLL_F_CODE` row | 0 |
| heading rule | 1px `COLOR_LABEL` under the row carrying `SCROLL_F_HEADEND` | 0 |
| language label row | dim, on the card ground, only when the fence names one | **1 per block** |
| break at `/ . - _` | a second fallback in the word-wrap branch | may save |

### Decisions, each with the reason it went that way

- **THE EDGE BAR IS `COLOR_LABEL`, NOT `COLOR_ACCENT`.** Its job is structural - "these rows are
  one block" - not to attract the eye. Accent already carries five jobs on this surface
  (heading text, the rail knob, the `-- N new below --` badge, the back key border, the filter
  chip fill) and a sixth dilutes all of them. The reader's eye should land on the code, not on
  its margin. It is one constant away from accent if that turns out wrong on the glass.
- **THE HEADING RULE IS `COLOR_LABEL` TOO, UNDER ACCENT TEXT.** A rule is structure, not
  emphasis, and the heading already spends accent on its text. Grey under orange separates
  the two jobs; orange under orange would read as one thicker heading.
- **THE EDGE BAR NEEDS NO TOP/BOTTOM FLAGS.** A block is always separated from what surrounds it
  by a blank or a prose row, so the bar breaks naturally. Two flags and their two selftest
  faults were designed and then deleted; this is recorded so the next reader does not re-add
  them believing they were overlooked.
- **THE `+` CONTINUATION MARK STAYS ALONGSIDE THE INDENT.** They state different facts: `+` says
  *this row wrapped*, the indent says *this is where it sat*. Dropping `+` once the indent
  exists would let a wrapped continuation pass as a real nested line - which is the exact defect
  the `+` was added for.
- **`SCROLL_HANG_MAX` IS 12.** Past that the ~22 remaining columns make the wrap itself the
  unreadable thing, so deeply indented code keeps 12 columns of shape and loses the rest. A
  named constant, parsed by the checker, never transcribed.
- **THE LANGUAGE LABEL COSTS A ROW AND IS KEPT.** A `bash` block and a `cpp` block are read
  differently. Blocks whose fence names nothing cost nothing. **This is the most droppable item
  in the design** - it can be removed later without touching anything else - and it is written
  down as such rather than defended.

### THE RISK, WHICH IS ONE RISK

**`scrollDrawBody` AND `scrollDrawBand` MUST STAY PIXEL-FOR-PIXEL EQUAL.** A checksum harness
proved that over 30 steps in both directions, and **fixing only `scrollDrawBody` has already
broken it once on this exact surface** - the top-edge clipping defect. Every change in the table
above lands in both loops, and the harness runs before the commit rather than after it.

Second-order, and the reason `scrollWrapLines` and the renderer share one function: **any change
to the wrap changes line counts**, counts feed `lineFirst`, and `lineFirst` feeds the binary
search that maps a pixel offset to an entry. A counting path that disagreed with the drawing
path by one row would not fail loudly - it would drift.

## OUT OF SCOPE, EACH FOR A STATED REASON

- **Option C, the full-width code surface** (tap a block, 38 columns, horizontal drag). A good
  idea and cleanly additive to B - it reuses the store and the drag loop that already exist -
  but it is a second full-screen surface, which means an entry in ~ten guard lists and a new
  `SCROLLCODE` verb with its refusals. It is not required for B to be worth having.
- **Option D, typed blocks on the wire** (`{r,k,i,t}` per block; inline code on the card ground,
  links blue and underlined and tappable, blockquotes, tables). **THE LINE BETWEEN B AND D IS
  KNOWING WHERE A SPAN STARTS.** Colouring a link, or giving inline code its own ground, needs
  its first and last character. The Mac knows; the device would have to guess from punctuation,
  and a guess that is wrong once per screen is worse than the plain text it replaced. So B stops
  at a `~` and backticks rather than half-doing it, and D remains the honest way to get the
  rest - at the cost of a wire version bump and board 1's `page`/`item` arms having to stay
  exactly as they are.

## VERIFICATION

```
node firmware/deckhand_display/scrollback-check.mjs         # mirror + structural, --selftest
node firmware/deckhand_display/geom-sweep.mjs               # ~110s
node firmware/deckhand_display/commands-check.mjs
node host/{wire-bytes,session-lookup}-check.mjs
node docs/design/scrollback/check.mjs
node firmware/board-baseline.mjs --check 1                  # UNCHANGED at both commits
node firmware/board-baseline.mjs --check 2                  # moves at commit 2, explained
```

`scrollback-check.mjs`'s `walk()` mirror moves in lockstep with `scrollWalk`. **A MIRROR PROVES
THE ALGORITHM AND BINDS NOTHING**, so each new behaviour also gets a structural assertion read
from the firmware's own text, bound to the FUNCTION BODY rather than the file, and each gets a
selftest fault that is proven to fail by injection. `SCROLL_HANG_MAX` and the edge bar's x are
PARSED from `board_es3c35p.h`, never transcribed.

**And the glass.** `SCROLLOPEN` on a session with a real code block, then `SCREENSHOT`, at the
top of the block and again with the block straddling the bottom edge. Four defects on this
surface were found by reading a capture while all eight checkers were green.

## WHAT IS NOT VERIFIED, STATED PLAINLY

- **NO CLAIM HERE COVERS COLOUR.** `SCREENSHOT` reads the shadow framebuffer on board 2, so
  every capture vouches for the geometry the renderer composed and nothing about the panel.
  Whether `COLOR_LABEL` grey reads against `COLOR_CARD` on the real glass is a `COLORTEST`
  question and **a person is the authority**.
- **THE ROW COST IS REAL AND IT IS THE TRADE.** Backticks, the language row and hanging indents
  all spend rows out of 27. The mock prints each option's cost for the same turn; the numbers
  after implementation will differ and should be re-measured, not copied.
- **NO FINGER HAS TOUCHED ANY OF IT.** Consistent with the rest of this surface, every path here
  will be structurally verified only until someone drags the transcript past a code block.

## THE MOCK

Five treatments, same Claude turn, true 320x480, scroll-synced, each printing its row cost:
`https://claude.ai/code/artifact/c21839f7-27ec-4df1-94d5-8c3ecaf41e20`. Once B lands, the chosen
rendering is committed to `docs/design/scrollback-markup/` with a `check.mjs` bound to
`board_es3c35p.h`, the way `docs/design/scrollback/` already is - **a committed design artifact
whose numbers can drift while it still reports "all passed" is the same class of defect as an
assertion that cannot fail.**
