# SCROLLBACK: board 2's scrolling transcript

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

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

**THE TRANSCRIPT IS LIVE, AND IT FOLLOWS ONLY AT THE BOTTOM.** `HISTORY <id> <chat|all>
since:<n>` is the fourth request form: while the surface is open the device asks for anything
newer than it holds every `SCROLL_TAIL_POLL_MS` (**5000**, matching the host's own tick so the
two do not beat against each other), and the usual reply while nothing is happening is an empty
array. **It is its own parser arm, not a reuse of the chunked fetch** - that arm RESETS the
store on `seq 0` and owns `scrollNextSeq`, so routing an append through it would wipe the
transcript the reader is looking at. The tail carries no `seq`/`of` at all: the host sends what
fits one reply and the next poll collects the rest, which is self-correcting and keeps a burst
of activity from becoming a multi-chunk handshake on a 5-second cadence.
- **AT-BOTTOM IS DECIDED BEFORE THE APPEND, and that ordering is the whole policy.** The append
  grows `scrollMaxY()`, so asking afterwards always answers "no" and the tail would follow
  exactly once and then stop. For the same reason it needs a TOLERANCE rather than equality -
  `SCROLL_AT_BOTTOM_PX` is one line, the smallest span that cannot be an accident.
- **Held away from the bottom the view does not move by a pixel** and a `-- N new below --`
  badge appears over the bottom row instead; reaching the bottom clears it. Moving the page
  under someone reading history is the one behaviour this surface has already been asked twice
  to stop doing. `scrollAtBottom()` is ONE spelling read by both the follow rule and the badge -
  a rule and an indicator that disagreed about the bottom would show "3 new below" while sitting
  on them.
- **The double delivery duplicates entries here, and an insert is not idempotent.** The device
  transmits on every live transport, so a cabled board asks twice and two replies to the same
  `since:` would append the SAME entries twice - every new message doubled. Deduped at the host
  on the identical request within 1500ms, the same guard the `tail:` path already had.
- **MEASURED:** host `Scrollback: tail +1 of 1 new`, device `SCROLL tail +1 entries
  (following)`, each appending once. Watched again on 2026-09-12 against a running session:
  `HISTORY <id> chat since:2` every ~5s through the host log, with the append landing when the
  turn completed. **The granularity is the TRANSCRIPT ENTRY, not the token** - an assistant
  message reaches the glass when Claude Code writes it to the JSONL, and the host's
  `histItems` cache is keyed on that file's mtime so a poll never serves a stale parse.
- **BOARD 1 HAS NO EQUIVALENT.** Its paged reader is a snapshot per request: `requestHistory`
  runs on open, page turn, filter toggle and scrubber jump, and nothing polls. A page already on
  the glass does not grow.

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
form. **Board 1 was `UNCHANGED` at every commit of this section** - `8f64b7f7...`, 1387024,
measured 2026-09-03 when this section was first written. **That value is dated, not current**:
board 1's binary has moved since, for reasons unrelated to this feature (shared-code work under
`compose-surface`). The current figure is `365406b8ad175a01...`, 1419776 - see BINARY COST
below, which re-verifies it for the markup section, and CLAUDE.md's own quoted figure. Kept
here rather than silently overwritten, per this repo's rule against deleting a measurement that
turned out superseded; a reader auditing board 1 today should check against the current figure,
not this one.

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
- **Momentum is deliberately out**, for a stated reason in the spec. **Live tailing was out
  there too and is now IN** - the spec's "the transcript is a snapshot taken when the screen
  opens" was superseded by `d7f994d`; see the live tail section above. The spec is left as
  written, being a dated record of what was decided then.
- **THE HELD BRANCH OF THE LIVE TAIL HAS NEVER EXECUTED.** Every append observed was the
  following case, because new chat entries only appear when a turn completes. Eight
  assertions in `scrollback-check.mjs` stand in for it and two were proven to fail by
  injection, but no person has watched the badge appear.

---

#### SCROLLBACK MARKUP: code, lists and links that read on the glass

Board 2's transcript above rendered code, lists and links as flat prose in the 34-column lane -
`SCROLL_COLS`. Spec: `docs/superpowers/specs/2026-09-12-scrollback-markup-design.md`. Mock:
`docs/design/scrollback-markup/` (the earlier five-treatment comparison mock is superseded; this
one renders only what shipped, bound to `board_es3c35p.h` the same way its predecessor is).

**THE SIX FINDINGS AND THE COMMIT THAT CLOSED EACH.** Written as history, not as open defects:

1. **Fence language discarded on the Mac.** `histBlockText` normalised every fence to a bare
   ` ``` `, so the device could not label a block even if it wanted to. Closed by `c2e8077`,
   "Keep the fence language the Mac was throwing away."
2. **Inline code erased.** Spans were protected during emphasis stripping and then restored
   without their backticks, so `SCROLL_COLS` reached the glass indistinguishable from prose.
   Closed by `7acb726`, "Give inline code its backticks back - nothing else marks it here."
3. **Code lost its indentation on wrap.** A continuation restarted at column 0, and
   indentation is most of how code is read. Closed by `705f3be`, "A wrapped code row restarts
   under its own indent" - `SCROLL_HANG_MAX` is 12: past that the ~22 remaining columns make
   the wrap itself the unreadable thing, so deeply indented code keeps 12 columns of shape and
   loses the rest.
4. **A block had no edges.** A per-row `COLOR_CARD` fill made a one-line block indistinguishable
   from a highlighted prose line, and a block straddling the viewport had no top or bottom.
   Closed by `2524300`, "Give a code block edges a per-row fill cannot draw" -
   `SCROLL_CODE_EDGE_X` 20, `SCROLL_CODE_EDGE_W` 2, `COLOR_LABEL`.
5. **Link markdown reached the glass whole, and a spaceless URL hard-cut mid-token.** Closed
   across two commits: `4693723`/`7640bf4`/`29cf364` (collapsing links and eliding bare URLs,
   fixing two regressions the first attempt introduced along the way - a doubled mark and a
   tilde-path breakage) and `0203f9f`, "Break a spaceless path at a seam instead of mid-word."
6. **A wrapped bullet had no hanging indent.** Its continuation began at the same column as its
   `*`, so a two-item list and a four-line item looked alike. Closed by `73db7ea`, "A wrapped
   list item hangs to its text, so two items stop looking like one."

Between findings 4 and 6, two more commits changed the wire and the renderer without closing a
numbered finding on their own: `f3d02bf` threaded the row's start column through `scrollWalk`
(drawing nothing new yet - the foundation `705f3be` and `73db7ea` both build on), and
`b97e6f2` bound `scrollDrawBody` and `scrollDrawBand` to each other with an equivalence
assertion before any of the row-shape changes landed, because this surface had already broken
that equivalence once by fixing only one of the two paths. `bc85e75` added the heading rule
(`SCROLL_F_HEADEND`, under the LAST row of a wrapped heading only - a rule between a wrapped
heading's two rows would read as two headings). `a4f54d3` followed it, giving the rule's two
structural assertions their own selftest faults, a gap the plan itself had left open for this
one task - checker-only, touching `scrollback-check.mjs` alone, so it moved NEITHER binary. It
is absent from the byte-cost table below by design, not by omission: that table lists the eight
commits that touched `scrollback.ino`, and `a4f54d3` never did. `8d7ee25` added the language
label row (`SCROLL_F_LANG`) as the final commit.

**TWO HOST CHANGES, NO WIRE VERSION BUMP.** `histBlockText`'s fence-language and link/URL
changes are both read by a firmware function whose own toggle test is unaffected by them:
`scrollWalk`'s fence test reads the first three backticks of a line and ignores the rest, so a
board running firmware from before this work simply drops the language rather than printing
it. Nothing about the wire's shape changed; a board on either side of this branch's sixteen
commits reads the same bytes and disagrees only on how much of them it draws.

**THE MAC AND THE DEVICE DO NOT ALWAYS AGREE ON WHAT COUNTS AS A FENCE, AND THIS BRANCH WIDENED
THAT GAP.** The Mac's fence test is `/^\s*```(\S*)/` - a line starting with `**` or another
emphasis marker is not a fence to it. But the Mac then strips the emphasis markers, leaving
three backticks at column 0, and the device's test (`t[pos]=='`' && t[pos+1]=='`' &&
t[pos+2]=='`'`) DOES fire on that. The device enters code mode where the host never did, and
everything up to the next fence in that entry is painted on the card ground - now with Task
10's edge bar running beside it. **This class is PRE-EXISTING**, not introduced by this branch:
Task 2's backtick restore widened it rather than creating it. An exhaustive search over short
strings found exactly 27 minimal new-only forms, all requiring an emphasis marker at column 0
immediately abutting three backticks - `**```x`, `__```x`, `` *```x* `` and 24 siblings. A fix
is one character wide: anchor the host's fence test on the line AFTER emphasis is stripped, or
have the host test for three backticks anywhere the device would, not just at column 0.

**THE `~` LINK MARK EXISTS BECAUSE COLLAPSING A LINK OTHERWISE DESTROYS THE FACT THAT A TARGET
EXISTED, SILENTLY** - and from the Mac, silence and "there was never a link here" are
indistinguishable, the exact class this repo's refusal messages exist for. One ASCII character,
inside Spleen's range, is the whole cost of saying "there was a URL here" instead. It cannot be
followed from the device; that is Option D, out of scope.

**THE LINK/URL TRANSFORM IS ONE REGEX ALTERNATION, NOT TWO PASSES.** Two sequential
`String.replace` calls cannot work here: the second re-scans what the first just wrote, and
every guard against that has an input that defeats it - the first attempt's own guard was
defeated by a tilde, which is legal in a URL path (`https://example.com/~alice/page` broke
under it). An alternation matches each construct once, left to right, and `replace()` never
re-scans its own output, so the class of bug cannot recur by construction.

**THE EDGE BAR AND THE HEADING RULE ARE `COLOR_LABEL`, NOT `COLOR_ACCENT`, AND THAT WAS A
DELIBERATE CHOICE, NOT A DEFAULT.** Accent already carries five jobs on this surface (heading
text, the rail knob, the `-- N new below --` badge, the back key border, the filter chip fill),
and a sixth would dilute all of them - the reader's eye should land on the code, not on its
margin. The bar sits at x 20..22 (`SCROLL_CODE_EDGE_X` 20, `SCROLL_CODE_EDGE_W` 2), in the
otherwise-unused SECOND gutter cell (20..28), touching neither the glyph cell (12..20, where
the role mark and the `+` continuation live) nor the text column (28, `SCROLL_TXT_X`).

**THE EDGE BAR NEEDS NO TOP/BOTTOM FLAGS, AND THAT WAS DESIGNED AND THEN DELETED - RECORDED
HERE SO THE NEXT READER DOES NOT RE-ADD THEM BELIEVING THEY WERE OVERLOOKED.** A block is
always separated from what surrounds it by a blank or a prose row, so the bar breaks by itself;
two flags and their two selftest faults were designed for this and then deliberately removed
because nothing ever needed them. Confirmed on glass: the bar runs continuously down a block
and breaks between two blocks (a `SCROLLTO 1060` capture showing block, then a prose heading
with no bar, then the bar resuming).

**THE `+` CONTINUATION MARK STAYS ALONGSIDE THE NEW INDENT, DELIBERATELY.** They state
different facts: `+` says THIS ROW WRAPPED, the indent says WHERE IT SAT. Dropping `+` once the
indent existed would let a wrapped continuation pass as a real nested line - the exact
misreading a hanging indent alone would invite, and the reason the two are kept together rather
than the indent replacing the mark.

**THE LANGUAGE LABEL ROW COSTS ONE ROW OUT OF 27 PER BLOCK, AND IT IS THE MOST DROPPABLE ITEM IN
THIS DESIGN - said plainly rather than defended.** A `bash` block and a `cpp` block are read
differently, and that is the entire argument for it; a block whose fence names nothing costs
nothing (`opening && ln > 0` gates it). It can be removed later without touching anything else
in this design.

**A PRE-EXISTING DEFECT WAS CLOSED IN PASSING, AND IT PREDATES THIS WORK.** `uint8_t lf` and
`int li` are declared OUTSIDE the per-row loop in both draw paths, and the one-line tool-row arm
never reset them. So a `$` or `|` row drawn immediately after a code row INHERITED
`SCROLL_F_CODE` and was painted on the card ground - reachable whenever a message ends in a code
block and the next entry is the call it describes. Closed by `7a41767`, "A tool row was
inheriting the code row above it, and the edge bar would have shown it" - named for Task 10's
edge bar (`2524300`, landing after this fix), which did not exist yet but would have painted a
grey bar beside exactly such a tool row had this been left unfixed.

**MEASURED ROW COST, ON A REAL TRANSCRIPT FROM THIS PROJECT'S OWN HISTORY.** `histBlockText`
cannot be imported directly - requiring `host/index.mjs` starts the host - so both the
pre-branch (`3fa4831`) and HEAD (`8d7ee25`) versions of `histBlockText` and `histShortUrl` were
extracted from their source text and run in an isolated `vm` context against the same input,
and the resulting wire text was wrapped with each side's own `scrollWalk` mirror at
`SCROLL_COLS` 34 - the same two mirrors `scrollback-check.mjs` already carries (the pre-branch
one restored from `git show 3fa4831:firmware/deckhand_display/scrollback-check.mjs`, since
HEAD's mirror no longer models the old behaviour). Two real assistant turns from this
project's own session history (`~/.claude/projects/-Users-yujia-projects-deckhand/`) were
measured, neither reproduced here since a design doc is not where session content belongs:
- A 2246-byte turn (two headings, a three-item bulleted list, one `json`-labelled fence, bold
  text, several inline-code spans, no link): **84 rows before, 90 after, +6** - one row is the
  language label, the rest is backticks and hanging indents pushing a handful of lines past
  their wrap boundary.
- A 3818-byte turn (one `js`-labelled fence, a bulleted list, a table, bold text, several
  inline-code spans, **two markdown links**, no bare heading): **143 rows before, 144 after,
  +1**. The language row and the restored backticks still cost rows, but collapsing both
  `[text](url)` links to `text~` SAVES more than that costs - `[host/index.mjs:4120](host/index.mjs#L4120)`
  alone drops from 43 characters to 20. Finding 5's fix is not a pure cost the way findings 2-4
  are; it can net negative.
- **THE WORST CASE RUNS THE OPPOSITE DIRECTION: SHORT AND FENCE-HEAVY**, where the language row
  has nothing to amortise against. Measured with an independent port of `scrollWalk`: five
  one-line labelled shell fences in one turn go from **5 rows to 10** - the fenced lines double
  outright - which is roughly **+50%** of a short reply built mostly of such fences. Worst case,
  not typical, and like the two turns above this is an offline measurement, not an on-glass
  count.

The direction is consistent (fence language and inline code always cost a little, hanging
indents cost only where a line was already near the wrap boundary) but the SIZE of the net
change depends entirely on how much of the turn was links versus code - +1 row in 143 for one
turn, +6 in 84 for another. **This is an offline measurement, not an on-glass count**: no
transcript was loaded onto the physical device and counted by eye for this step; see WHAT IS
NOT VERIFIED below.

**BINARY COST.** Board 1 is `UNCHANGED` at every one of the sixteen commits from `3fa4831`
through `8d7ee25` - `365406b8ad175a01...`, 1419776 - and re-verified at the commit this section
belongs to, which touches no firmware. Board 2 moved at every one of the eight commits that
touched `scrollback.ino`, each measured and explained in its own commit message:

| commit | change | board 2 delta | board 2 size | board 2 hash |
|---|---|---|---|---|
| `f3d02bf` | thread the start column through `scrollWalk` | +64 | 1065280 | `873053cf...` |
| `705f3be` | code keeps its indent on wrap | +48 | 1065328 | `fc347531...` |
| `7a41767` | tool-row flag reset (the pre-existing defect) | +16 | 1065344 | `a8898052...` |
| `73db7ea` | bullets hang | +112 | 1065456 | `86bff6a6...` |
| `0203f9f` | break a spaceless path at a seam | +96 | 1065552 | `d2bcb710...` |
| `2524300` | the block's edge bar | +48 | 1065600 | `25eeca37...` |
| `bc85e75` | the heading rule | +48 | 1065648 | `4dcbca24...` |
| `8d7ee25` | the language label row | +96 | 1065744 | `2bd7ac34...` |

ending at `2bd7ac344932a800...`, 1065744 - **528 bytes over the eight commits** (64+48+16+112+
96+48+48+96), none of it a surprise: each row in this table is the commit message that explains
its own delta.

**GLASS.** Read directly by the coordinator, not reported secondhand: capture
`shot-2026-09-13T09-25-22-Deckhand-C114.png` shows five treatments in one frame - a dim
`markdown` language row above a block on the card ground with the edge bar running through it;
heading rules under two separate headings; wrapped bullets hanging to their text column;
wrapped code rows carrying `+` in the gutter and hanging to indent; the card ground behind the
block. Emphasis markers were correctly NOT stripped inside the fence. **Geometry only** - the
capture reads the shadow framebuffer, so it vouches for composition and nothing about colour.
Separately, a `SCROLLTO 1060` capture confirmed the edge bar breaking between two blocks (block,
then a prose heading with no bar, then the bar resuming).

**WHAT IS NOT VERIFIED, STATED PLAINLY.**
- **NO CLAIM HERE COVERS COLOUR.** `SCREENSHOT` reads the shadow framebuffer on board 2, so
  every capture (this section's included) vouches for the geometry the renderer composed and
  nothing about the panel. Whether `COLOR_LABEL` grey reads against `COLOR_CARD` on the real
  glass is a `COLORTEST` question and **a person is the authority**, not any checker in this
  repo.
- **THE ABSENCE OF AN EDGE BAR BESIDE A `$`/`|` TOOL ROW HAS NEVER BEEN SEEN, ONLY GUARANTEED
  STRUCTURALLY.** The CHAT filter excludes tool rows at the FETCH level, and switching to ALL
  needs a physical tap - there is no device command for it. Task 7's `lf = 0; li = 0;` reset
  runs before `isCode` is computed in both draw paths, and a count-2 assertion binds that in
  both, so the guarantee is real; no one has looked at the actual pixels.
- **THE TOOL-ROW ARM'S OWN TRUNCATION IS COMPARED BY NOTHING.** `drawRegion()` in
  `scrollback-check.mjs` starts at `const bool isCode`, below the `e.role >= 2` arm, and the
  separate tool-arm binding (Task 7's `lf = 0; li = 0;` fix, above) matches only that far. The
  REST of that arm - the `SCROLL_COLS - 3` truncation - differs textually between the two draw
  paths (`int n` in `scrollDrawBody`, `int tn` in `scrollDrawBand`, to dodge the outer `const int
  n`), so no equivalence assertion reads either copy. A one-path change to that truncation is the
  one row-drawing edit both guards would miss.
- **THE HEADING RULE PAINTS OVER ITS OWN HEADING'S DESCENDERS, AND NOBODY HAS LOOKED.** It draws
  at `y + CODE_LINE_H - 2`, AFTER `drawString`, so on a heading whose last row contains a `g`,
  `y` or `p` the rule overwrites whatever that descender put on that scanline. Geometry-correct
  and correctly clipped - the rule is exactly where `SCROLL_F_HEADEND`'s row math says it should
  land - but no heading with a descender on its last row has been captured since this shipped, so
  whether the clipped descender still reads or simply vanishes into the rule is unverified.
- **A BARE, LANGUAGE-LESS FENCE COSTING NO ROW HAS NEVER BEEN PHOTOGRAPHED.** It rests on the
  mirror assertion and the `opening && ln > 0` guard, both green, neither a picture.
- **NO FINGER HAS TOUCHED ANY OF IT** - consistent with the rest of this surface. The drag,
  the rail tap and the filter toggle over this new content are exercised only by the mirror,
  the structural assertions and `SCROLLPERF`'s synthetic offsets.
- **THE ROW-COST MEASUREMENT ABOVE IS OFFLINE**, run against extracted source in an isolated
  `vm` context, not a live transcript loaded onto the physical device and counted by eye. The
  arithmetic is the firmware's own (`scrollWalk`, mirrored, not re-derived), but no screen was
  read for it.
- **NO SCROLLBACK CONSTANT HAS EVER BEEN FAULT-SWEPT, INCLUDING THE ONES ADDED HERE.**
  `geom-sweep.mjs`'s `CHECKERS` map holds only usage/sessions/settings and has never included
  `scrollback-check.mjs`, so every scrollback constant - `SCROLL_HANG_MAX`,
  `SCROLL_CODE_EDGE_X`, `SCROLL_CODE_EDGE_W` included - reports "unguarded, read by no
  checker" when the sweep runs. Partly mitigated: `scrollback-check.mjs` carries its own
  closing identities and selftest faults for these constants specifically. But the sweep's own
  value is proving an assertion CAN fail under perturbation, and this surface has never had
  that. Expect `geom-sweep.mjs` to keep reporting these three unguarded; that is this
  pre-existing gap, not a new defect.
- **`scrollFindCode()` NOW LANDS ON THE LANGUAGE ROW** rather than the first line of code text,
  because the label row also carries `SCROLL_F_CODE`. Diagnostic-only (`SCROLLPERF code`'s
  parking position), no assertion binds it either way.

---

#### SCROLLBACK OPENED BY ID: a dead session, and RESUME (2026-09-21)

`scrollOpenById(const char* id12, const char* title)` is this surface's SECOND entry point,
beside `openScrollback(int idx)` - the same renderer, wrap, index, drag and CHAT/ALL filter, now
addressable by an id that need not be (and, for `docs/superpowers/specs/2026-09-20-sessions-
manager-design.md`'s whole point, very often is not) in `sessions[]` at all. `projects.ino`'s
`handlePSessTouch()` is the tap route (a level-2 row); `PSESSOPEN <n>` and `RESUME <text>`
(both `deckhand_display.ino`) are the Mac-drivable ones. `scrollFetch()` is the busy-guard/
already-held/wire-line core both `requestScrollback()` and `scrollOpenById()` now build one
call to; the latter's is BROADCAST (no `hostSlot` on file for an id that may not be live),
`requestProjects()`'s own reasoning applied one level deeper.

**RESUME IS WIRE-COMPLETE AND NOT YET A TAP.** `RESUME <text>` sends a headless `claude -p
--resume <scrollLoadedId> <text>` for whichever transcript is open, refusing by name with no
transcript open, on a LIVE one (`scrollFromProjects`/`scrollProjLive`, defaulting to the SAFE
"live" reading so a caller that forgets to set the latter gets a refusal rather than a silent
turn on a session someone may be driving interactively), or on empty text. There is deliberately
no chip or button reaching it yet - see the Task 7 report for why (no way to verify new hit-test
geometry against real panel pixels without flashing and looking, and the header has no free
room without a fresh geometry pass this task did not do). `PSESSOPEN <n>` is the same shape one
level up: the operator's own route into level 3, PROJOPEN's own reasoning.

**NOT VERIFIED, STATED PLAINLY:**
- **No dead session's transcript has been read on the glass through this path yet.** The wire
  side (`transcriptPathFor`'s project-directory fallback) was confirmed once, separately, before
  this task; this is the first firmware capable of exercising it from a tap or `PSESSOPEN`.
- **`exitScrollback()`'s PROJECTS-return arm (`projLevelPainted = -1;` forcing a repaint) has
  not been watched repaint on real hardware** - only reasoned from `renderProjectsTab()`'s own
  existing level-transition bust, which it deliberately reuses rather than duplicating.
- **The SCROLLACK addressing for a broadcast-opened (PROJECTS) fetch is unresolved for a
  genuine two-Mac pairing.** `scrollHostSlot` is set to 0 (no real slot) when `scrollOpenById()`
  broadcasts; a single paired Mac is unaffected (there is nothing to misaddress to), but two
  Macs paired at once could see a per-chunk ack's `to=` suffix name the wrong one. Out of scope
  for this task; flagged rather than fixed.
