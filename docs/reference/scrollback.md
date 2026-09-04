# SCROLLBACK: board 2's scrolling transcript

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

#### SCROLLBACK: board 2's session history is one scrolling transcript

Board 1 is unchanged: previews, paged by entry, PREV/CLOSE/NEXT and a scrubber, with a second
screen for reading one entry whole. Board 2 draws **one continuous Claude Code-style
transcript** - full message text inline, newest at the bottom, drag to scroll, ASCII gutter
markers per role, no buttons. The guard is `BOARD_HISTORY_SCROLL`, 1 in `board_es3c35p.h` and 0
in `board_e32r28t.h`, and the whole feature is ONE `#if` block in `scrollback.ino`. Spec:
`docs/superpowers/specs/2026-09-03-scrollback-transcript-design.md`; mock (bound to the header)
`docs/design/scrollback/`.

**IT RETURNS EIGHT LINES OF TEXT TO THE SCREEN.** The pager spends its bottom 120px on a 46px
scrubber band and a 50px button row; scrolling makes both unnecessary, taking the reading area
from `(360-60)/16 = 18` lines to `(476-60)/16 = 26` - **+44%**. Both closing identities are
asserted exactly: `SCROLL_RAIL_X + SCROLL_RAIL_W + SCROLL_RIGHT_AIR == BOARD_W` and
`SCROLL_TOP + SCROLL_LINES*CODE_LINE_H + SCROLL_BOT_AIR == BOARD_H`.

**THE CONSTRAINT THAT PRODUCED THE PAGED DESIGN DOES NOT EXIST HERE.** Board 1 holds ONE screen
in a 2400-byte arena because it has ~26KB of free heap. Board 2 has 8MB of PSRAM against a
measured 122KB conversation, so it holds the whole thing: `SCROLL_TEXT_BYTES` 262144 plus a
4096-entry index, **304KB, 3.7% of PSRAM, and zero DRAM**. Each entry's wrapped line count is
computed ONCE at append and accumulated into `lineFirst`, so mapping a pixel offset to a first
visible entry is a binary search - without it every frame would re-wrap from the top.

**THE WRAP DELIBERATELY DOES NOT REUSE `countWrappedLines`.** That helper stops at **80 lines**
and its `wrapLineLen` carries a `char buf[64]` capped at 60 characters, so a 4000-byte entry -
**118 lines at 34 columns** - cannot pass through it at all, and raising either would move board
1's binary. `scrollWrapLines` is exact integer arithmetic instead, which is available because
every Spleen glyph has `xOffset + width == xAdvance`; that also makes the JS mirror exact rather
than approximate.

**CLAUDE CODE'S OWN GUTTER MARKERS CANNOT BE DRAWN ON THIS DEVICE.** Spleen declares
`0x20..0x7E`, so U+23FA and U+257C render as nothing and advance nothing - the trap this repo has
paid for repeatedly. The vocabulary is ASCII and the marks are distinct SHAPES so meaning does
not rest on hue: `>` you (accent), `*` claude (good), `$` ran (label), `|` result (label), `!`
denied/error (bad). A `result` immediately after a `ran` gets no blank line between them - the
pair reads as one unit. **`scrollback-check.mjs` fails if any marker literal leaves ASCII**, and
that assertion has a selftest fault.
**The five role WORDS stop being drawn on board 2, and that is the one thing this design gives
up.** A mark is terser than a word, so colour does more work than it did. Defensible because the
marks are distinct shapes and a label row per entry is what costs the 18-line reading area, but
it is a legibility-for-space trade and only a person can settle whether it reads as well.

**THE WIRE: A SEQUENCE OF BOUNDED LINES, AND THERE ARE TWO CEILINGS ON THE CHUNK, NOT ONE.**
`HISTORY <id12> <chat|all> tail:<maxBytes>` is a third request form beside `<page|last>` and
`item:<n>`, so board 1 keeps its exact behaviour with no version bump. The reply is chunked
because `feedChar`'s guard is **16000 BYTES** and it does not DROP an over-long line - it
**CLEARS THE BUFFER mid-line**, so the parse fails and every tick carrying it is lost while both
links look healthy.
- **The budget is measured on the SERIALISED line, never on raw text length.** JSON escaping is
  not a rounding term: a newline becomes `\n` and DOUBLES.
- **THE SECOND CEILING IS THE RX RING, AND IT IS LOWER.** Chunks over ~4KB produced ZERO
  device-side output - a silent JSON parse failure, reproduced twice - because
  `Serial.setRxBufferSize()` sets a **4096-byte** ring for board 1's audio flow control and an
  overflowing ring **DISCARDS**. Shrinking the chunk cannot fix it: one entry at
  `HIST_FULL_CAP` is ~8400 bytes escaped, so a single entry would not fit a single chunk. The
  ring is **16384 on board 2 only**, behind `BOARD_HISTORY_SCROLL`, leaving board 1's call
  character-identical. `scrollback-check.mjs` asserts the budget against the parsed board-2 arm.
- **`SCROLLACK` per chunk**, because back-to-back writes overflowed that ring. The same
  flow-control lesson board 1's audio path already learned.
- **THE DUPLICATE COMMAND RAN TWO FETCHES.** The trigger file is delivered over both transports
  AND `sendLineToHost` sends the device's own request on both, so two fetches interleaved through
  one `scrollNextSeq` and the second chunk 0 failed the continuity check (`SCROLL: seq 0,
  expected 1`). Deduped at the device (in flight) and at the host (identical request within
  1500ms), with ack waiters keyed by GENERATION so a superseded fetch loses rather than
  corrupting the winner.
- **A repeat request for a transcript already held is answered from PSRAM.** Better than
  re-downloading 108KB, and it fixes a real artefact: the duplicate's second copy re-requested
  after the first completed, the host's dedup swallowed it, and the device sat `pending` for the
  full 20s then reported "could not reach the Mac" over a transcript it already had.
- **BLE gets a bounded tail** (`SCROLL_TAIL_BYTES_BLE` 8192, ~12s at ~666 B/s; the full 122KB
  would be over three minutes), and the top of the scroll states what is missing.

**MEASURED, ON HARDWARE, AND THE FLUSH IS NOW THE FRAME.** One fetch: **225 entries, 3817
wrapped lines, 108318 bytes, 11 chunks, 0 dropped**, repeatable.

| path | compose | flush | frame | fps |
|---|---|---|---|---|
| `scrollDrawBody` (full recompose) | 33.5ms | 40.3ms | 73.7ms | 13 |
| `scrollRect` + `scrollDrawBand` | 20.8ms | 39.1ms | **59.9ms** | **16** |

`PanelShim::scrollRect` memmoves the framebuffer and only the newly exposed band is drawn.
**The prediction that compose would fall to "a few ms" was WRONG and the measurement won**: at a
realistic 32px frame delta the memmove still moves 384 of 416 rows, which is 245KB of PSRAM
read+write, and PSRAM is the slow bus this whole port keeps paying for. The saving is almost
entirely `scrollDrawBand` skipping ~24 of 27 `drawString` calls. It is **rotation-aware** rather
than a bare row memmove, because the screen-flip feature selects rotation 2 where a logical
downward scroll is a physical upward one.
- **OPEN AND UNEXPLAINED, recorded with its numbers:** `PERF` measures a FULL-SCREEN flush at
  **30.1ms** (gather 8.35 + transfer 21.8, matching this file's own older figure exactly), but
  `SCROLLPERF` measures the scroll's flush at **39-40ms for a SMALLER area** (416 of 480 rows).
  That is backwards. Ruled out: the strip buffer falling back to PSRAM (`PERF` confirms
  `stripBuf in INTERNAL RAM`). **The flush is 65% of the frame, so this is where the next real
  win is**, ahead of any further compose work.
- **Two levers not taken.** A single BULK memmove for the full-width rotation-0 case (one 245KB
  move instead of 384 per-row moves each with two `mapPoint` calls). And the **ST77922's HARDWARE
  vertical scroll** (VSCRDEF/VSCSAD), which would make a scroll nearly free - but the shim's
  `writecommand` is a documented no-op, so it needs raw-command passthrough and is entirely
  unmeasured. Do not attempt it without a spike.

**THE DRAG IS A BLOCKING LOOP IN THE READER, NOT AN EXTENSION OF `handleTouch()`.** That function
is shared and returns immediately on `touching && wasTouching` - "a finger still down has nothing
left to do" - so drag state there would risk board 1's binary. The blocking pattern already
exists three times (`micMonitor`, `micStream`, `runCalibration`) and this loop inherits its
obligations, each with a named failure: **`reapBleLinks(true)` every iteration** (`drainBleRx`
only runs from `loop()`, so a pending slot would leave the device un-advertised with nothing
logged) and **`lastActivityMillis` every iteration** (or the 30s blank fires mid-drag and the
waking tap is swallowed instead of scrolling). Both are asserted and both have selftest faults.
**A TAP IS A DRAG THAT MOVED LESS THAN `SCROLL_TAP_SLOP_PX`** - naming that threshold is what
makes "tap the rail to jump" separable from "drag to scroll" at all, since every tap moves a
pixel or two on a capacitive panel. The body has no tap action, so there is no further ambiguity.

**FOUR DEFECTS HERE WERE FOUND BY READING A SCREENSHOT, NOT BY ANY ASSERTION.** That is the whole
argument for taking the captures rather than trusting green checkers:
1. **The head note was painted and immediately overwritten** - drawn on top at `SCROLL_TOP`,
   exactly where the transcript's first line lands at `scrollY` 0. It is **line 0 of the scroll
   space** now, so it scrolls away under the finger, which is what Claude Code's own marker does.
2. **The detail card's 32x32 agent mark blitted over the transcript.** `detailBandVisible()`
   refuses on `histActive`, but `openScrollback` set only `scrollActive`, so the flags diverged.
   `openScrollback` sets **both**, which joins this surface to ~TEN existing guard lists at once
   instead of an `#if` per site - and is semantically right, since this IS the history surface.
3. **The head note named the wrong CAUSE** - "102 older need USB" with the cable plugged in.
   Entries are dropped on USB too, by the store budget. It says "not kept" there now.
4. **The TOP edge was never clipped** while the bottom one carried a comment claiming clipping
   was handled. A partial first line starts at `SCROLL_TOP - subPx`, up to 15 rows ABOVE the
   list, and `drawString` clips only to the SCREEN - so it painted over the header and the rule.
   **Fixing only `scrollDrawBody` silently broke its pixel-for-pixel equivalence with
   `scrollDrawBand`**, which a checksum harness had just proved over 30 steps in both directions;
   both paths now carry the identical header test, kept SEPARATE from the band-relevance test
   because a line straddling the band boundary when scrolling down must still be drawn.

**Commands.** `SCROLLFETCH [n]` loads a transcript and **draws nothing**, so silence after it is
a WIRE fault and can never be blamed on the renderer - the `AUDIOPROBE`/`TONETEST` ladder, and it
earned its place in its first run. `SCROLLPERF [top]` opens the transcript, times both render
paths and prints compose/flush/frame for each; `top` parks the view at line 0, because the head
note is only drawn there and `SCREENSHOT` can only record what is on the glass. **`SCROLLPERF`'s
argument is captured BEFORE the reentrancy guard clears `buf`** - read afterwards it was always
empty, so the flag looked supported and did nothing.

**COST.** Board 2 **1030298 flash / 70140 RAM** (`.bin` 1030560). Task 6's removal of the
full-entry pager from board 2's build gave back **1088 flash and 4008 RAM**, almost all of it
`histFull[4000]`. Nothing is deleted from the repository: board 1 keeps every line and the host
keeps `sendHistoryItem` and `item:<n>`, because it serves both boards and branches on the request
form. **Board 1 is `UNCHANGED` at every commit** - `8f64b7f7...`, 1387024.

**WHAT IS NOT VERIFIED, STATED PLAINLY.**
- **EVERY FINGER-TOUCH PATH IS STRUCTURALLY VERIFIED ONLY.** This codebase deliberately has no
  remote tap, so the drag, the rail tap, the filter toggle and the back key have never been
  executed - only the geometry, the assertions, and `SCROLLPERF`'s synthetic offsets. **The first
  thing to do with a finger on the glass is drag both directions and tap all three controls.**
- **The FLIPPED (rotation 2) case is unexercised.** `scrollRect`'s rotation handling was verified
  by reading `mapPoint`, not by a tap. A framebuffer memmove that ignores rotation scrolls
  BACKWARDS there, and nothing else would catch it.
- **No claim here covers COLOUR.** `SCREENSHOT` reads the shadow framebuffer on this board, so
  every capture vouches for the geometry the renderer composed and nothing about the panel.
  `COLORTEST` is the instrument and a person is the authority - which matters more than usual
  because the gutter leans on five palette roles.
- **The BLE path has never been exercised at all** - no fetch has run with the cable out, so the
  8192-byte tail, the ~12s wait and the "need USB" note are argued rather than watched.
- **Live tailing and momentum are deliberately out**, each for a stated reason in the spec.
