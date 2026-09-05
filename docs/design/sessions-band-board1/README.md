# The status band card - board 1 beside board 2

```
open docs/design/sessions-band-board1/band.html
node docs/design/sessions-band-board1/check.mjs             # 0 failures
node docs/design/sessions-band-board1/check.mjs --selftest  # exits 0 iff the fault is caught
```

## What this is for

Board 1 (240x320) drew a 90px row and then **174px of empty tab** at one session -
66% of its list area, a bigger share than the 48% that motivated this card on board
2 (410px area, 212px card). The `#if !BOARD_USES_TFT_ESPI` guards that kept the card
off board 1 have been widened; this page is what that looks like at both scales, side
by side, with each block labelled with the constant that spends it.

Unlike `compose/`, this mock is **behind** the firmware rather than ahead of it: the
card shipped in the same change, so `check.mjs` is expected to report **0 failures**.
A failure here means the mock and a header have drifted apart, which is the whole
reason it binds.

## What it asserts

1. **`K` IS the firmware's.** Every constant this mock draws from is compared
   name-for-name against `board_e32r28t.h` / `board_es3c35p.h` through the geometry
   checkers' own `consts()` parser. A name the mock owns and no header defines is
   printed rather than skipped: an assertion satisfiable by ABSENCE is one that
   cannot fail.
2. **The blocks sum to the card.** The body is a running cursor over the
   `SESSION_BAND_*` blocks and `SESSION_EXP_MAX_H` is their SUM, so the labelled
   column beside each card has to add up to the card it is drawn next to - and the
   bottom-anchored rule+path group has to start exactly where the body cursor ended.
   That identity is what makes this one layout rather than two that can drift.
3. **The band's contents fit ACROSS, per board, at the word each board draws.**
   Board 1's word lane is 141px against board 2's 199, and `labelForStatus`'s
   "NEEDS YOUR INPUT" inks 160 at its T_HEAD advance - so `bandStatusWord()` measures
   and falls back to `shortLabelForStatus()`. The mock re-derives which form each
   board lands on from the two PARSED vocabularies and this board's own room, and
   fails if the table it draws from disagrees.
4. The four things every mock in this directory asserts: ASCII 0x20..0x7E only
   (an out-of-range codepoint draws nothing AND advances nothing), nothing off the
   panel, no block overlapping the next, and the list ending inside its own area.

The type scale and `SPARK_SIZE` are **parsed** (`UI_FONTS[]`, `ClaudeSpark.h`)
rather than trusted: a font swap or a regenerated mark must fail here and not on the
glass. The mark's 32x32 is the reason board 1's band is 34 tall and its status word
had to give ground, so a mark that changed size moves both.

## What is exact and what is not

- **Geometry is exact.** Every rectangle, block boundary and text origin is the
  number the firmware uses.
- **Glyph rendering is approximate.** The panel draws 1-bit Cozette 6x13 (board 1)
  and Spleen 8x16 (board 2); this page steps a browser monospace face at each
  board's real advance and cell. The metrics are the panel's; the ink inside each
  cell is not. Board 1 has no committed glyph dump in this repo
  (`settings-redesign/spleenfonts.js` is Spleen, i.e. board 2 only) and inventing one
  would flatter the design - the mistake that mock already paid for.
- **The agent mark is drawn as its 32x32 box**, not the art. What matters here is
  that it OWNS 32x32 of the band.
- **No animation.** Board 2's crossfade, shimmer and attention pulse are not in
  these pictures, and board 1 does not have them at all: it draws straight to the
  glass, where each is a per-frame repaint with no deferred flush to ride.

## The two things a reader should take from the pictures

- **The card is the same design at two densities**, not a shrunk copy. Board 1's
  leadings are board 2's scaled by 85/122 - the ratio of the leading each board can
  afford after its own ink - because its name stays at the 26px hero rung while
  everything around it gets smaller.
- **The band card is a ONE-session behaviour on board 1** where it is one-to-two on
  board 2. The three-session picture is what every multi-session list looks like
  there: the status colour carried by a 5px spine down each row's left edge, with the
  row's own text pill still beside it. Colour is never the only carrier.
