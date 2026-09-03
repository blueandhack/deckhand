# Scrollback: board 2's session history as a scrolling transcript

**Date:** 2026-09-03
**Board:** 2 only (`ES3C35P`, ESP32-S3, 320x480). Board 1 is untouched and stays byte-identical.
**Mock:** `docs/design/scrollback/`, committed with this spec.

**The mock is NOT yet bound to the board header, and that is a known, temporary gap.** This
repo's rule is that a committed mock parses every constant it shares with `board_es3c35p.h`,
because a spec whose numbers can drift while it still reports "all passed" is the same class of
defect as an assertion that cannot fail — and it is a class this repo has paid for three times.
The bind cannot be written before the `SCROLL_*` constants exist, so **adding
`docs/design/scrollback/check.mjs` is the first task's responsibility**, not a later
nice-to-have. Until it lands, the mock is a picture and the tables below are the authority.

## Goal

Replace board 2's paged, preview-based history reader with one continuous transcript in the
style of Claude Code's own scrollback: full message text inline, newest at the bottom, drag up
for older, ASCII gutter markers per role, and no buttons.

## Why this is worth doing

Three independent reasons, in descending order of how measurable they are.

1. **It returns eight lines of text to the screen.** The pager spends its bottom 120px on a
   46px scrubber band and a 50px button row. Scrolling makes both unnecessary, taking the
   reading area from `(360 - 60) / 16 = 18` lines to `(476 - 60) / 16 = 26` — **+44%**.
2. **The constraint that produced the paged design does not exist on this board.** Board 1
   holds ONE screen in a 2400-byte arena because it has ~26KB of free heap. Board 2 has
   8,388,608 bytes of PSRAM, of which the framebuffer takes 307,200. A real transcript's whole
   conversation is **122KB** (measured: 2515 entries / 584KB total). So board 2 can hold the
   entire history and scroll it locally, at zero round trips per screen.
3. **It deletes a whole screen.** Full text inline makes the second-level full-entry pager
   redundant. That screen exists only because a message taller than one page was otherwise
   unreachable.

## Scope, and what is explicitly NOT in it

**In:** the transcript surface, its fetch, its scroll, and the deletion of the pager chrome
from board 2's build.

**Out, and each for a stated reason:**

- **Live tailing.** A working session keeps producing entries, and "newest at the bottom"
  invites the transcript to grow while you watch. That is a second feature with its own
  refresh cadence and its own "you have scrolled away" affordance. The transcript is a
  **snapshot taken when the screen opens**, as today.
- **Momentum / inertial fling.** Every decay frame costs another flush (see *Frame budget*),
  so a long decay is expensive here in a way it is not on a phone. Fast travel is served by
  the rail tap instead, which costs exactly one frame. Momentum may be added later on
  measured evidence; it is not required for the design to work.
- **Board 1.** Resistive panel, where this repo has already measured that drag-scroll
  misfires, and a binary held byte-identical. It keeps its pager unchanged.
- **Search / jump-to-role.** Not asked for.

## Interaction model

| Gesture | Result |
|---|---|
| Drag anywhere in the body | Scrolls the transcript, tracking the finger |
| Tap the right 20px (`SCROLL_RAIL_TAP_X`..319) | Jumps proportionally to that fraction of the history |
| Tap elsewhere in the body | **Nothing** |
| Tap the header's `<` key | Closes, back to the session detail screen |
| Tap the header's filter chip | Toggles CHAT / ALL and re-fetches |

**The body has no tap action, so there is no tap-versus-drag ambiguity to resolve.** This is a
direct consequence of full text being inline: there are no rows to open. It is worth stating
because the current reader's body tap opens a row, and every gesture design that keeps such a
tap has to separate it from a drag by distance and time.

The screen **opens scrolled to the newest entry.**

## Geometry

All constants go in `board_es3c35p.h`. They are **independent literals, not a `prev + cell +
air` chain** — `geom-sweep.mjs` injects at parse time, so a chain of relative identities lets a
perturbation propagate into every offset below it and leaves every identity still holding. That
is the failure the wireless-pairing panel shipped with and the USAGE `_SOLO` offsets avoided.

### The horizontal lane, which closes exactly on `BOARD_W`

```
  12  gutter x           SCROLL_GUT_X       marker, 1 glyph in a 2-column cell
  28  text x             SCROLL_TXT_X       = SCROLL_GUT_X + 2 * TEXT_ADV
      34 columns         SCROLL_COLS        = 272px, ends at 299
   6  gap                SCROLL_RAIL_AIR
 306  rail x             SCROLL_RAIL_X      4px wide (SCROLL_RAIL_W), ends at 309
  10  right margin       SCROLL_RIGHT_AIR
 ---
 320  = BOARD_W          verified: 12+16+272+6+4+10
```

Two more, which are hit-test rather than ink:

- **`SCROLL_RAIL_TAP_X` = 300**, so the rail's tap zone is `300..319` — 20px wide over the
  body's full 416px height. 20px is 3.1mm, **under the 7.1mm `TAP_MIN` floor**, and that is
  acceptable here for two stated reasons: it is asserted to start at or after the text lane's
  end (`>= SCROLL_TXT_X + SCROLL_COLS * TEXT_ADV` = 300) so it never eats a column, and missing
  it costs a body-scroll rather than anything destructive. If it proves hard to hit on the
  glass, the fix is dropping `SCROLL_COLS` to 33, which frees 8px.
- **`SCROLL_TAP_SLOP_PX` = 6.** A tap IS a drag that moved less than this before release; at or
  beyond it the contact is a scroll and no tap fires. Without a named threshold "tap the rail"
  and "drag anywhere" are not separable, since every tap moves a pixel or two on a capacitive
  panel. 6px is under half a line, so a scroll small enough to read as a tap has moved no text.

The closing identity to assert, in the `HOME_Y0_BOT` / `PAIR_AIR_LEFT` shape:

```
SCROLL_GUT_X + 2*TEXT_ADV + SCROLL_COLS*TEXT_ADV + SCROLL_RAIL_AIR
             + SCROLL_RAIL_W + SCROLL_RIGHT_AIR == BOARD_W
```

**34 columns against the pager's 37 — the gutter costs three columns, 8%.** That is what buys a
transcript that reads as a conversation instead of a list of labelled rows.

### The vertical column, which closes exactly on `BOARD_H`

```
   0  header                                54px, unchanged (HIST_RULE_Y)
  54  rule                                  1px
  60  first line          SCROLL_TOP        = HIST_TOP, unchanged
      26 lines            SCROLL_LINES      = 416px at CODE_LINE_H 16, ends at 475
 476  one past the last   SCROLL_BOT        = SCROLL_TOP + SCROLL_LINES * CODE_LINE_H
 476  bottom air          SCROLL_BOT_AIR    4px
 ---
 480  = BOARD_H
```

```
SCROLL_TOP + SCROLL_LINES * CODE_LINE_H + SCROLL_BOT_AIR == BOARD_H
```

**Note this is 26 lines, where the mock rendered 25.** The mock left a 12px bottom margin; this
tightens it to the 4px the USAGE column already uses, which buys one more line. The headline is
therefore **18 -> 26**, not 18 -> 25. If a person looks at the glass and wants more air at the
panel edge, `SCROLL_BOT_AIR` is the one constant to change and the closing identity follows it.

### The header

```
  12  back key   SCROLL_BACK_X, W=46 (== TAP_MIN), H=46, y=4      12..57
  66  name       SCROLL_NAME_X = SCROLL_BACK_X + 46 + 8           SCROLL_NAME_COLS 22, ends 241
 248  chip       BOARD_W - 12 - HIST_CHIP_W_CHAT                  60 wide, 46 tall
```

Two facts here are derivations rather than choices, and both get asserted:

- **The back key is exactly `TAP_MIN` (46 = 7.1mm).** It carries the `CLOSE` the deleted button
  row used to provide, so it is the one control that must not shrink.
- **The name lane is 22 columns, which is exactly the cap the host already applies**
  (`deviceText(await projectName(...), 22)`, `host/index.mjs:1601`). Parsed from the host, not
  transcribed — the same rule that governs every other cross-file cap here.

The header carries **two stacked 16px lines**: the session name in `COLOR_VALUE` at y=12, and
the position counter (`412/628`) in `COLOR_LABEL` at y=30. Spleen's smallest rung is 8x16, so
these are the same size and are separated by **colour and position, never by size** — the rule
the rest of this device already follows.

## The gutter vocabulary

**Claude Code's own markers cannot be drawn on this device.** Spleen declares `0x20..0x7E`, so
U+23FA and U+257C render as nothing at all and advance nothing. This repo has paid for that trap
repeatedly — `fitText`'s ellipsis, the `CLAUDE/air` tag separator, the PAIRED MACS middle dot,
the SETTINGS HOME chevron, and `histFlatten`'s own truncation marker, which was invisible for
months. So the gutter is ASCII, one column, and the label is never carried by colour alone.

| Mark | Role (wire `r`) | Colour | Treatment |
|---|---|---|---|
| `>` | 0, you | `COLOR_ACCENT` | Full text, wrapped to `SCROLL_COLS` |
| `*` | 1, claude | `COLOR_GOOD` | Full text, wrapped |
| `$` | 2, ran | `COLOR_LABEL` | One line, clipped with three ASCII dots |
| `\|` | 3, result | `COLOR_LABEL` | One line, clipped |
| `!` | 4, denied/error | `COLOR_BAD` | One line, clipped |

Two layout rules:

- **One blank line between entries**, except that a `result` immediately following a `ran`
  gets none — the pair reads as one unit, which is what Claude Code's own indent conveys.
- **The marker is drawn on the entry's FIRST line only**; continuations align to
  `SCROLL_TXT_X`.

`histRoleLabel()`'s five words (`YOU` / `CLAUDE` / `RAN` / `RESULT` / `DENIED / ERROR`) stop
being drawn on board 2. **This is the one place the design gives something up:** a marker is
terser than a word, and colour is doing more work than it was. It is defensible because the
five marks are visually distinct shapes rather than five hues, and because the alternative — a
label row per entry — is what costs the 18-line reading area in the first place. Stated here
rather than discovered later.

## Data model

Three PSRAM allocations, all `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`, the same call the
framebuffer and the mic ring already use. Allocated on open, freed on close.

```c
char*     scrollText;    // SCROLL_TEXT_BYTES  262144  the entries' text, NUL-separated
ScrollEntry* scrollIdx;  // SCROLL_MAX_ENTRIES  4096 * 12 = 49152
```

```c
struct ScrollEntry {
  uint32_t off;        // byte offset into scrollText
  uint32_t lineFirst;  // cumulative line index of this entry's first line
  uint16_t lines;      // wrapped line count, computed ONCE at fetch
  uint8_t  role;
};                     // 12 bytes with padding
```

**`lineFirst` is the whole reason scrolling is cheap.** Wrapping is deterministic, so each
entry's line count is computed once when it arrives and accumulated. Mapping a pixel offset to
a first visible entry is then a binary search over `lineFirst` — O(log n), negligible per frame.
Without it, every frame would re-wrap from the top of the transcript.

**Sizing:** 262144 bytes covers the measured 122KB conversation 2.1x. For the ALL filter on a
very long session it will not cover 584KB, and the oldest entries are dropped with the count
stated on screen (below). Total PSRAM for this feature is **304KB, 3.7% of the 8MB**, on top of
the framebuffer's 307,200.

## Wire protocol

### The request

```
HISTORY <id12> <chat|all> tail:<maxBytes>
```

`tail:` is a **new, third form** alongside the existing `<page|last>` and `item:<n>`. The host
branches on the form, so board 1 keeps its exact current behaviour and no version bump is
needed — the same backward-compatible shape as the optional `<cols>x<lines>` budget token and
the trailing `to=<hostId>` address.

The `<cols>x<lines>` token is **not sent** on this form: the device now holds full text and
wraps locally, so the host has no layout decision left to make.

`maxBytes` is chosen by transport:

| Transport | Constant | Bytes | Wall clock |
|---|---|---|---|
| USB (native CDC, ~384 KB/s measured) | `SCROLL_TAIL_BYTES_USB` | 262144 | ~0.3s typical, 0.7s at full budget |
| BLE (~666 B/s) | `SCROLL_TAIL_BYTES_BLE` | 8192 | **~12s** |

**BLE genuinely cannot have the whole thing** — 122KB at 666 B/s is over three minutes — so it gets a
bounded tail and the wait is stated on screen rather than hidden. 12s is a long pause, and the
pending state must therefore name the transport and say what it is doing.

### The reply is a SEQUENCE of bounded lines, not one line

**This is the protocol's load-bearing detail.** `feedChar`'s guard is **16,000 BYTES**, and it
does not drop an over-long line — it **clears the buffer mid-line**, so the remainder
accumulates into an emptied buffer, the parse fails, and every tick carrying it is lost while
both links look healthy. A 262144-byte reply would hit that on the first chunk.

So the host emits a run of lines, each well under the guard:

```json
{"hist":{"id":"...","f":"chat","seq":0,"of":22,"total":628,"dropped":412,"items":[{"r":0,"t":"..."}]}}
```

- **`SCROLL_WIRE_CHUNK_BYTES` = 12000**, and it is measured on the **serialised line**, never
  on the sum of the entries' text lengths. JSON escaping is not a rounding term: a newline
  becomes `\\n` and doubles, so 12000 bytes of newline-heavy transcript would serialise to
  24000 and blow the 16000-byte guard while every raw-length check passed. The host adds
  entries while `JSON.stringify(line).length` stays under the budget, which also leaves room
  for the envelope and for a single entry sitting near `HIST_FULL_CAP` (4000).
- `seq` is 0-based and contiguous; `of` is the total count. The device appends each chunk to
  the arena and treats **`seq != expected` as a failed fetch** — it clears and reports, rather
  than assembling a transcript with a hole in it.
- `total` is entries in the whole filtered history; **`dropped`** is how many were withheld at
  the head to fit `maxBytes`.
- The final chunk completes the fetch. `SCROLL_FETCH_TIMEOUT_MS` (20000 USB, 40000 BLE) aborts
  a stalled fetch with the cause named.

Per-entry text keeps the existing `HIST_FULL_CAP` (4000) — that is already the cap
`sendHistoryItem` uses, so a single enormous message stays bounded.

### Pending and edge states, all drawn as one dim centred line

| Condition | Line |
|---|---|
| Fetching | `-- fetching 8/22 --`, or `-- fetching over Bluetooth --` on BLE |
| Fetch failed or timed out | `-- could not reach the Mac --` |
| Nothing in this filter | `-- nothing here --` |
| Scrolled to the top, all present | `-- start of history --` |
| Scrolled to the top, `dropped > 0` | `-- 412 older need USB --` |

The last of these is the rule `POWERPROBE`'s `not on battery (unplug USB; state=2 mv=3866)`
exists for: from the outside, "there is no more history" and "I cannot fetch the rest here" look
identical, so the limit is stated with its remedy.

## The scroll mechanism, and the measurement that decides it

**`pushImage` already clips a negative `y` correctly** — it computes `offY = cy - y` and offsets
the source row pointer (`panel_shim.cpp:251-254`) — so a line composed into a `SCROLL_COLS *
TEXT_ADV` by `CODE_LINE_H` buffer and pushed at a negative `y` renders its lower rows only.
**Pixel-smooth scrolling therefore needs no new shim surface**, and the bottom edge is clipped
at the call site by passing `h = min(CODE_LINE_H, SCROLL_BOT - y)`.

What is NOT settled is whether the frame is affordable, and the honest position is that
**nobody has measured it**:

- **Flush:** a full-screen flush is **30ms measured** (gather 8.3 + transfer 21.8). The scrolled
  region is 416 of 480 rows, so ~**23ms derived by proportion** — derived, not measured.
- **Compose:** 26 lines of up to 34 glyphs is ~884 glyph blits of 8x16 into PSRAM.
  **Unmeasured.** This repo's own history says the instinct here is unreliable: switching to the
  USAGE tab was assumed to be flush-bound and was actually 86x-too-expensive AA primitives.

**So the first task is a measurement, not an implementation.** Build the transcript static,
scroll it with a synthetic offset, and report with `PERF` and a `switchTab`-style duration log.
The result picks the render path:

| Measured frame | Path |
|---|---|
| under ~40ms (>= 25fps) | **Redraw all visible lines every frame.** Simple, no new shim surface, no rotation hazard. |
| over ~40ms | Add `PanelShim::scrollRect(x, y, w, h, dy)` doing a framebuffer `memmove` and drawing only the newly exposed band. |

`scrollRect` is deliberately deferred rather than designed in: it must respect `_rotation`
(a logical downward scroll is a physical upward one at rotation 2, which the screen-flip
feature can select), and adding rotation-dependent shim surface to save time nobody has shown
is needed is the wrong order. Board 2 ships `SCREEN_ROTATION 0` today, which is the identity.

**Quantise-to-16px is NOT the fallback for a slow frame** — it saves nothing on its own, because
a quantised scroll still redraws every visible line unless there is a `memmove` behind it. It is
an independent question about feel (16px is 2.5mm at 6.49 px/mm, which is visibly notchy on a
slow drag) and the default is **smooth**.

## Touch: a blocking drag loop, in the reader

The drag lives in a blocking loop inside the reader's own touch handler, polling
`getTouchPoint()` until release. This is chosen over extending `handleTouch()` for two reasons:

1. **`handleTouch()` is shared code** and returns immediately on `touching && wasTouching` —
   "a finger still down has nothing left to do" (`deckhand_display.ino:3468`). Adding
   drag state there risks board 1's binary for a board-2 feature.
2. **The pattern is already established three times** — `micMonitor`, `micStream` and
   `runCalibration` all block and poll touch.

The loop therefore inherits that pattern's obligations, and they are not optional:

- **`reapBleLinks(true)` every iteration.** `drainBleRx()` only runs from `loop()`, so for the
  whole drag nothing else would reap a pending BLE slot — leaving the device un-advertised with
  no log line saying why. Every existing blocking loop does this and says so.
- **Poll at 15ms**, matching `handleTouch()`'s own rate. `getTouchPoint()` costs 1125us, so
  that is 7.5% of the interval.
- **`lastActivityMillis` refreshed every iteration**, or the 30s backlight blank fires
  mid-drag. The keyboard already needed exactly this.
- **A release ends the loop.** No two-consecutive-reads debounce: that rule exists for a
  spurious touch ENDING something expensive (a 120s recording), where here a spurious release
  merely ends a drag the finger can resume.

## What board 2's build stops compiling

Everything below is guarded by a new `BOARD_HISTORY_SCROLL` (1 in `board_es3c35p.h`, 0 in
`board_e32r28t.h`) — a `#define`, **never a `const int`**, because the preprocessor cannot see a
C++ `const int` and `#if` on one is silently false with no warning. That has bitten twice here
already (`panel_shim.cpp`'s `BOARD_PANEL_INVERT`, and `BOARD_USAGE_V2` during the USAGE
redesign), so the checker assertion that no `BOARD_*` flag is a `const int` covers this one too.

| Dropped from board 2 | Kept for board 1 |
|---|---|
| `drawHistFull()`, `handleHistFullTouch()`, `histFullActive`, `histFull*` | yes |
| The `item:<n>` request and the host's `sendHistoryItem()` | yes — the host serves both boards |
| The scrubber, `PREV`/`CLOSE`/`NEXT`, `histGoto()` | yes |
| `histPage`, `histPages`, `histFrom`, `histRowY` | yes |
| The role-label rows | yes |

**Nothing is deleted from the repository** — it is deleted from board 2's build. The host keeps
both reply paths and branches on the request form.

## Rendering discipline

**The change-only redraw discipline does not apply to the scrolling body, and that is a
deliberate exception rather than an oversight.** Every field on this surface moves when any of
them moves, so a per-field cache would be busted on every frame and would only add work. The
body is repainted wholesale per frame, which is the same reasoning that already lets session
rows and the detail card repaint wholesale rather than per field.

Two things around it keep their caches:

- **The header** is static between fetches except the position counter, which is a
  change-only field keyed on its own padded string.
- **The rail** is change-only keyed on `(knobY, knobH)`, so a scroll that does not move the
  knob a whole pixel does not repaint it.

The reader must keep **absorbing the ~5s host tick** the way it does today (parse everything,
`renderFooter()`, return) — without that, the periodic repaint paints the session list straight
over it. And `SCROLL_*` state must be reset in whatever repaints the surface's chrome, for the
reason `drawSettingsStatic()` documents: a cache that survives a chrome repaint leaves its field
BLANK, because the value "has not changed".

## Verification

### Geometry, in `settings-geom-check.mjs` (which already covers the history reader)

Every assertion **parses** the constant it certifies. Required:

1. The horizontal closing identity sums to `BOARD_W` exactly.
2. The vertical closing identity sums to `BOARD_H` exactly.
3. `SCROLL_LINES == (BOARD_H - SCROLL_BOT_AIR - SCROLL_TOP) / CODE_LINE_H`.
4. The back key and the filter chip are each `>= TAP_MIN` in both dimensions.
5. `SCROLL_NAME_COLS == 22`, asserted against the cap **parsed out of `host/index.mjs`**.
6. The name lane's right edge clears the widest filter chip (`HIST_CHIP_W_CHAT`).
7. The two header lines' 16px boxes are disjoint and both inside `HIST_RULE_Y`.
8. The text lane's right edge clears `SCROLL_RAIL_X`.
9. The rail's tap zone does not overlap the back key or the chip (different y bands — assert it
   rather than assume it).
10. `SCROLL_COLS * TEXT_ADV` is the lane exactly, since every Spleen glyph has
    `xOffset + width == xAdvance` (the monospace property this repo already asserts).

### Arithmetic, in a new `scrollback-check.mjs`

A JS mirror of the line index plus **structural assertions over the firmware source**, split
and reported separately the way `sessions-rank-check.mjs` does — because a mirror proves the
algorithm and would keep passing with the real code deleted.

Mirror: `lineFirst` accumulation; the binary search landing on the right entry for every pixel
offset across a synthetic transcript; the wrap agreeing with `wrapLineLen`'s rule; the
`result`-after-`ran` spacer suppression; `dropped` arithmetic.

Structural, each bound to a **function body** rather than to the file (the `pairWindowOpen()`
lesson: a rule satisfiable by a neighbouring line is not a rule):

- The chunk budget is `<=` `feedChar`'s guard **with the guard parsed from
  `deckhand_display.ino`**, not transcribed.
- The drag loop contains `reapBleLinks` and refreshes `lastActivityMillis`.
- `seq` discontinuity clears the arena rather than appending.
- `BOARD_HISTORY_SCROLL` is a `#define`, not a `const int`, in both headers.
- The gutter marks are ASCII: every marker literal is within `0x20..0x7E`.

`--selftest` must inject a fault per claim and exit 0 only when **that** assertion catches it,
matched by message. At minimum: the chunk budget raised above the guard; the closing identity
broken by 1 in each direction; `reapBleLinks` deleted; a marker replaced with a multi-byte
character.

### The sweep

`geom-sweep.mjs` must catch **every new geometric constant at +/-1 in both directions**. That is
the standard this repo sets for constants it has just added, and both recent branches met it.
`SCROLL_TAIL_BYTES_*`, `SCROLL_WIRE_CHUNK_BYTES` and `SCROLL_FETCH_TIMEOUT_MS` are expected to
report unguarded — they measure bytes and time, not pixels — and are bound by
`scrollback-check.mjs` instead.

### Board 1

`node firmware/board-baseline.mjs <bin> --check 1` must report `UNCHANGED` at every commit.
Compile the two boards **one after the other, never concurrently** — one sketch build directory.

## Costs

Unknown until built. Expected shape: board 2 gains the fetch, the index, the renderer and the
drag loop, and loses the full-entry pager from its build; the PSRAM cost is 304KB and does not
touch DRAM. Board 1: zero.

## What this design cannot verify, stated plainly

- **Nothing has been on the glass.** The mock is a browser rendering at the device's arithmetic,
  so it vouches for geometry and interaction and for nothing else.
- **No claim here covers colour**, and `SCREENSHOT` cannot settle it on this board — it reads
  the shadow framebuffer rather than the panel. `COLORTEST` is the instrument and a person is
  the authority. That matters more than usual because the gutter leans on five palette roles.
- **The frame cost is unmeasured**, which is why the first task measures it rather than
  assuming it. The 23ms flush figure is derived by proportion from a measured 30ms, not
  measured directly.
- **Whether marks read as well as words** is a judgement no assertion makes. It is the one thing
  in this design that trades legibility for space, and only a person looking at the device can
  settle it.
- **The BLE path's 12s fetch has never been timed**, only derived from the ~666 B/s ceiling.
