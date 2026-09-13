# Scrollback markup mock

The chosen rendering (Option B) from
[`2026-09-12-scrollback-markup-design.md`](../../superpowers/specs/2026-09-12-scrollback-markup-design.md),
committed as it shipped. Open `markup.html` in a browser; the device panel is draggable,
at real 320x480 pixels, one Spleen 8x16 cell per character.

**This is not the five-treatment comparison the spec walked through.** That mock lived at a
Claude-hosted artifact (`https://claude.ai/code/artifact/c21839f7-...`) and compared options
A-E; once B shipped, comparing against options that were never built stopped being useful.
This page renders only what board 2 actually draws now, and its wrap arithmetic is the same
`scrollWalk` mirror `scrollback-check.mjs` proves against the firmware's own text - not a
second, independent guess at the algorithm.

**The transcript on the panel is synthetic.** None of it is a real session - a real one would
belong in `~/.claude/projects/`, not in a committed design artifact, and this repo does not
put customer session content in the repository. The synthetic turn was built to exercise all
seven things listed below in one screen, the way the coordinator's own capture
(`shot-2026-09-13T09-25-22-Deckhand-C114.png`, read directly, not reported secondhand) showed
five of them landing together on real hardware.

**What is on the glass, and which finding each one closes** (`docs/reference/scrollback.md`
carries the full account):
1. a heading rule under the last row of a wrapped heading only
2. a wrapped bullet hanging to its own text column, not back to its marker
3. a code block's own edge - 2px, `COLOR_LABEL`, every row, breaking on its own between blocks
4. a dim language row above a labelled fence, costing one row - and nothing when the fence
   names no language
5. a wrapped code row keeping its source indent, `+` in the gutter, capped at
   `SCROLL_HANG_MAX`
6. a collapsed link (`text~`) and a shortened bare URL (`host/.../tail~`), the long spaceless
   result breaking after a separator rather than mid-word
7. a tool row (`$`/`|`) immediately after a code block carrying **no** edge bar and **no**
   card ground - the pre-existing flag-inheritance defect this branch closed in passing
   (Task 7), not a new feature of this design

**Bound to the header:** `node check.mjs` parses this page's own `var` geometry block and
`board_es3c35p.h` independently and asserts each pair equal, the way
[`docs/design/scrollback/check.mjs`](../scrollback/check.mjs) already binds its predecessor.
Three of the bound constants (`SCROLL_HANG_MAX`, `SCROLL_CODE_EDGE_X`, `SCROLL_CODE_EDGE_W`)
are the ones this task's design introduced, and `geom-sweep.mjs` reports all three
"unguarded, read by no checker" because its `CHECKERS` map has never included
`scrollback-check.mjs` - a real, pre-existing gap, recorded in `docs/reference/scrollback.md`,
that this bind narrows but does not close.

**No claim here covers colour.** The palette is an approximation for a computer screen, the
same one `docs/design/scrollback/scrollback.html` already used. `COLORTEST` and a person are
the instrument for colour, on the real device, not this page.
