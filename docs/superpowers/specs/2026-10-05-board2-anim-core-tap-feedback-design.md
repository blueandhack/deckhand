# Board 2: animation core + tap feedback (piece 1 of 3)

Date: 2026-10-05. Status: approved 2026-10-05; **revised during planning, same day** (see
"Revision 1" at the end, which says what changed and why).

## Why

The user asked for board 2's UI to feel smoother: fades, a little bounce. Asked where it
feels least smooth, they named all four of tab switching, overlays popping in, lists that
stop dead, and taps that give no feedback. That is three independent pieces of work, done in
this order (chosen by the user):

1. **This spec:** a small animation core, plus press feedback with taps acting on lift.
2. Overlay and tab transitions (fade/slide, the bounce-on-arrival). Separate spec. Needs a
   second full-screen PSRAM framebuffer.
3. List fling and rubber-band bounce. Separate spec. The transcript first; sessions and
   projects need pixel-granular scrolling, which means region clipping in `PanelShim`.

**Motion character (chosen by the user): crisp with a little bounce.** Fast ease-out
(120-220ms) by default, and a small overshoot-and-settle (~8%) only on things that *arrive*.
Nothing should make the user wait on it.

## What exists today (read, not assumed)

- Board 2 composes into a 320x480 PSRAM shadow framebuffer. The panel sees only `flush()`,
  which gathers the dirty union rect row by row into DMA strips (byte-swapping as it goes)
  and pushes them. Full screen ~30ms, a 32x32 rect ~1ms (`docs/reference/boards.md`).
- `readRect()` has exactly ONE caller: `SCREENSHOT`.
- Existing motion: the 300ms session-band crossfade (~30fps, one-shot), the shimmer (rides
  the spinner's existing flush), the agent-mark spinner, and the attention pulse (shipped
  DISABLED for power). All in `deckhand_display.ino` around `SESSION_XFADE_MS` and
  `tickSessionAnim()`. Board 1 has none of them, by name.
- `handleTouch()` commits on the LEADING edge (press). A held finger returns early; the lift
  commits only keyboard keys (`kbRelease()`). Only the keyboard has a pressed state.
- The three scrolling lists (`sessionDragLoop`, projects' two levels, `scrollDragLoop`) are
  blocking loops that already tell a tap from a drag and act on lift.

## Scope

**Board 2 only.** Gated by `#define BOARD_HAS_ANIM`: `1` in `board_es3c35p.h`, `0` in
`board_e32r28t.h`. It is a `#define`, never a `const int` (`#if` on a `const int` is silently
false). Board 1 draws straight to the glass with no flush to composite into. It keeps acting
on the press and gets no animation.

**Board 1's CODE is expected to be unchanged.** Its binary still moves by exactly one thing:
`PRESSTEST`'s refusal entry in `UNAVAILABLE_COMMANDS[]`, a cause string in `.flash.rodata`.
That has precedent: `SDPROBE`'s refusal cost board 1 +704 bytes with `.flash.text`
byte-identical. Both the move and the unchanged `.flash.text` are measured, not reasoned
about, and the re-baseline says why.

Out of scope here: the second framebuffer, region clipping, scaling, transitions, fling.

## Section 1 — the animation core

### The press layer is composited at FLUSH time, never drawn into the framebuffer

`PanelShim` gains one overlay: a logical rect, a corner radius, a tint colour and an alpha
(0..255).

- `setOverlay(x, y, w, h, r, tint, alpha)` stores it and marks its rect for the next flush.
  `clearOverlay()` marks the rect and disables the overlay.
- `flush()`'s gather loop blends the tint into each gathered pixel that lies inside the
  overlay's rounded rect. It works on the native-order source pixel, then applies the same
  byte swap every other pixel gets.
- `readRect()` applies the same blend, so `SCREENSHOT` shows what was pushed to the glass,
  highlight included.

**The framebuffer never holds a tint.** This is the property the whole design rests on.
Anything that redraws under a lit control (the 1s tick, a payload repainting a row, the
action itself) writes true content. The next flush shows it with the tint over it, and
clearing the overlay shows it without. With no snapshot to restore, a stale image can't be
painted back over fresh content, and the redraw-only-on-change caches stay truthful.

Marking the overlay's rect dirty goes through a path that does NOT trip the watch (below),
because the overlay is not content.

### The watch

`PanelShim` also gains `watch(x, y, w, h)`, `unwatch()` and `watchHit()`. Every primitive
that marks a dirty rect tests it against the watched rect and sets the flag on intersection.
Its ONE use in piece 1 is to answer "did the action redraw the control it was fired from?",
which decides whether the release flash runs (Section 2).

### Easing

Two fixed-point lookup tables, 33 entries each. The input `t` runs 0..32 and the output
0..1024, with linear interpolation between entries:

- `EASE_OUT_CUBIC[]`: `1 - (1-t)^3`. The default for everything.
- `EASE_OUT_BACK[]`: `1 + (c+1)(t-1)^3 + c(t-1)^2` with `c = 1.5`, the value that peaks at
  exactly 1.08. Its table peaks at 1106 before settling at 1024. Pieces 2 and 3 use it for
  arrivals; piece 1 declares it so the checker binds it now.

The values are generated once, with the formula and `c` quoted in
`docs/reference/animation.md`, and written into `anim.ino` as literals. The checker validates
their SHAPE, not their equality to a formula, so there is no transcribed copy to drift.
`animEase(curve, elapsedMs, durationMs)` returns the eased value and clamps to the table's
last entry once `elapsed >= duration`.

### Frame clock and the tween

`anim.ino` (one `#if BOARD_HAS_ANIM`) holds ONE tween: the overlay's alpha, from a start
value to an end value over a duration, on `EASE_OUT_CUBIC`.

- `animTick()` is called from `loop()` beside the existing ticks, under `#if BOARD_HAS_ANIM`.
  It runs at most one frame per `ANIM_FRAME_MS = 16`, and only while the tween runs. At rest
  it is one comparison, the same contract as the session crossfade.
- A frame is `setOverlay` with the new alpha plus `tft.flush()`, so it costs one flush of the
  control's rect and no compose at all.
- The two blocking drag loops that can hold a lit row (sessions and the two PROJECTS levels)
  call `animTick()` each poll, so the fade-in runs while those loops own the CPU.

Piece 1 needs one tween, so there is no slot table. Piece 2 designs its own machinery around
the second framebuffer, and that is where multiple concurrent animations get designed, if
they are needed.

## Section 2 — taps act on lift, with a press highlight

### What changes in `handleTouch()` (only under `BOARD_HAS_ANIM`)

**Still on press:**
- wake from sleep and undim
- dismiss the octopus and the emoji grid ("any tap dismisses" surfaces)
- the compose surface's processing-bar dismissal
- the keyboard's key band (`kbArm`/`kbSlide`/`kbRelease`, already arm-then-commit)
- the blocking drag loops on the three scrolling lists. They start on the press and decide
  tap versus drag themselves. Their surfaces are named by `tapBlocksUntilLift()`, whose
  per-surface halves live beside each handler (`sessionsTapBlocks`, `projTapBlocks`,
  `scrollTapBlocks`) and mirror that handler's own entry condition.

**On lift:** everything else, which means the reply panel and the whole chain after the
compose branch.
- The chain moves verbatim into `dispatchTap(sx, sy)`.
- On press, `handleTouch` records the press point, the lit rect and the **surface signature**
  (a packed word of the flags that decide which handler a tap reaches).
- On lift, the tap fires only if the finger is still within the rect plus 12px of slop, AND
  the surface signature and the rect under the press point are unchanged. If either moved
  (the list re-ranked, a payload closed the panel), the tap is DROPPED with a log line naming
  which. Acting on a control the user never pressed is the one failure tap-on-lift must not
  introduce.
- The handlers do not change; only when they are called does. The reply panel's
  `composeTouch()` takes the same lift path.

### Cancel by sliding off

If the finger leaves the press rect by more than `PRESS_SLOP_PX = 12` while held, the
highlight fades out over 120ms and the lift dispatches nothing. Without a lit rect, a
movement of more than 12px from the press point cancels the same way.

### The press rect: `pressRectAt(sx, sy, r)`

`r` is an `int[5]` of `{x, y, w, h, radius}`. Signatures carry no custom types, because the
`.ino` files are one translation unit with generated prototypes. It walks the surfaces in
`dispatchTap`'s order and delegates to resolvers that live BESIDE each surface's own hit test
and reuse its geometry:

| resolver | file | lights |
|---|---|---|
| `tabPressRect` | `anim.ino` | the tab-bar cell (`tabsW() / TAB_COUNT`), radius 0 |
| `sessionsPressRect` | `sessions.ino` | `sessionRowAtY()`'s row at `sessionRowYAt`/`sessionRowHAt`, `R_MD`; never on the scroll rail |
| `askPressRect` | `sessions.ino` | an answerable ask option row (`CARD_X`, `optTop + k*(ASK_OPT_H+ASK_OPT_GAP)`, `CARD_W`, `ASK_OPT_H`), radius 8 |
| `projPressRect` | `projects.ino` | a level-0 project row or a level-1 session row (not the honesty row), `R_MD` |
| `settingsPressRect` | `settings.ino` | HOME rows (`CARD_X`, `settingsHomeRowY(i)`, `CARD_W`, `HOME_ROW_H`, `R_MD`) and the confirm dialog's YES/NO |
| `composePressRect` | `compose.ino` | the reply panel's action-band buttons (drawn rect: `composeActX[i]`, `KB_ACT_Y + KB_ACT_DY`, `composeActW[i]` less `uiActionRow`'s gap unless it is the last column, `KB_ACT_DRAWN`, `R_MD`). That gap is lifted from a local `8` into `const int UI_ACT_GAP = 8` so the two cannot drift |

**No match means no highlight, and the tap still fires on lift.** A missed control is a
missing highlight, never a wrong action. Not covered in piece 1, and listed in the reference
doc as such: settings steppers, toggles and segments, the settings back band, the detail
header chips, the ask SPEAK/REPLY row, the compose reply bands and chips, the scrollback
header, and the USAGE cards (whose whole area pages accounts).

### The highlight

- **Press:** light the rect with `COLOR_ACCENT` from alpha 0 to `PRESS_ALPHA = 51` (20%) over
  `PRESS_IN_MS = 40`, then hold while the finger stays. Nothing is drawn over the control, so
  its text stays legible in both themes.
- **Lift, tap fires:** watch the rect, dispatch, then:
  - **The watch was not hit** (the action left the control alone): fade 51 -> 0 over
    `PRESS_OUT_MS = 120`. This is the release flash.
  - **The watch was hit** (a toggle flipped, a new screen opened): clear the overlay at once.
    The change is the feedback, and a tint fading over a different screen would be a ghost.
- **Lift after sliding off, or a dropped tap:** fade from the current alpha to 0 over 120ms.
- **A blocking list decides DRAG:** clear the overlay before the first scroll frame
  (`pressCancel()`), so the tint never sits over rows that are moving.

### Invariants this must not break

- The `composeOnKeys() && kbRelease()` line, `if (!kbArm(sx, sy)) kbTouch(sx, sy);` and
  `if (composeOnKeys()) kbSlide(sx, sy);` all stay inside `handleTouch()`'s own body.
  `settings-geom-check` binds all three there.
- Keyboard presses never enter the press machine, so a key lift cannot fire twice.
- `processCompletedLine` handlers and the double-delivery rules are untouched. This is
  touch-only, plus one new command.

### User-visible cost

A quick tap acts ~60-120ms later than now, at lift instead of touch. In exchange, every
covered control shows the press, and sliding off cancels.

## Section 3 — verification

### Offline: `firmware/deckhand_display/anim-check.mjs`

It parses the firmware's own text and transcribes nothing. `--selftest` injects each source
fault through `geom-common.mjs`'s `sweepSourceFaults` and exits 0 only if every one is caught
by the assertion it exists for.

1. **Easing tables:** both arrays are parsed out of `anim.ino`. Cubic starts at 0, ends at
   1024 and never decreases. Back ends at 1024 and peaks in `[1070, 1130]`.
2. **Flag form:** `BOARD_HAS_ANIM` is `#define`d in both headers and never `const int`.
3. **The framebuffer never holds a tint:** `anim.ino` calls no framebuffer-writing primitive
   (`fillRect`, `pushImage`, `drawPixel`, `drawString`, `fill*`, `ui*`). The overlay is
   applied inside `flush()`'s body and inside `readRect()`'s body. `setOverlay`/
   `clearOverlay` mark dirty through the non-watching path.
4. **The watch is on the draw path:** `markDirty()`'s body contains the watch test.
5. **Tap timing:** in `handleTouch()`'s body, `dispatchTap(` appears exactly twice. One call
   is on the lift branch behind `pressLift()`. The other is on the press path, immediately
   preceded, inside `#if BOARD_HAS_ANIM`, by `if (!tapBlocksUntilLift(sx, sy)) return;`.
6. **No stale taps:** `pressLift()`'s body compares `pressSurfaceSig()` and re-resolves
   `pressRectAt()`.
7. **Bound lines intact:** the three keyboard lines named above are still in `handleTouch()`.

Existing checkers must stay green: `commands-check`, `settings-geom-check`,
`sessions-geom-check`, `geom-sweep`, and `board-baseline --doc-check`.

### On the device

- **`PRESSTEST <x> <y>`** lights the press highlight at that point and holds it. Because
  `readRect` applies the overlay, `SCREENSHOT` can confirm that the rect lines up with the
  control in both themes (`THEME dark|light`). **`PRESSTEST off`** releases it WITHOUT
  dispatching.
  - It refuses BY NAME on:
    - no control under the point (quoting the point)
    - a surface that keeps acting on the press (naming it)
    - a non-numeric or off-panel argument (quoting the range)
  - Board 1 refuses it from `UNAVAILABLE_COMMANDS[]`, under `#if !BOARD_HAS_ANIM`.
  - A second identical `PRESSTEST` (the host's double delivery) is a no-op that says so.
- **`PERF`** gains a `PERF anim` line: frames, flush avg/worst µs, tweens, slide-offs, drops.
  The target is a worst frame under 16ms on a full-width session row.
- **A screenshot vouches for geometry only.** Motion, colour and feel are judged by the user
  on the glass, in both themes. Until then they are recorded as UNVERIFIED.

### Binaries

- Board 1 is compiled first. Before `PRESSTEST`'s refusal lands, `--check 1` must be
  `UNCHANGED`. After it lands, flash grows by the string, `.flash.text` is identical (checked
  with `xtensa-esp32-elf-size -A`), and the move is re-baselined with `--update 1` and
  explained.
- Then board 2, alone, never concurrently. Its flash and RAM movement are measured, explained,
  re-baselined with `--update 2`, and written into `CLAUDE.md`'s figures with the cause.

### Docs

- New `docs/reference/animation.md`: timings, the flush-time overlay rule, the coverage list
  and what is not covered, and the measured/unverified ledger.
- `CLAUDE.md`:
  - a row in "Read this before touching that"
  - `anim.ino` in the file map
  - the `PRESSTEST` row in the command table
  - the RAM/flash entry

## Revision 1 (2026-10-05, during planning)

The approved spec drew the tint INTO the framebuffer over a PSRAM snapshot of the control.
It cancelled the animation when the watch saw a foreign draw. Writing the code showed that
cancellation cannot be made correct. A foreign draw that covers PART of the rect (the 1s
tick's duration field inside a held session row) leaves the rest of the rect tinted. Nothing
can tell which pixels are which, and the change-only caches would never repaint them, so the
tint would stay. Compositing at flush time removes the problem rather than handling it, and
it also deletes the snapshot arena, the slot table and cancellation. The watch survives with
one job.

Two further corrections came out of reading the code:

- **Board 1 cannot be byte-identical.** The spec required both a by-name refusal of
  `PRESSTEST` on board 1 and an unchanged board-1 binary, and the refusal's cause string
  makes those incompatible. The claim is now "code unchanged, flash grows by the refusal
  string, measured".
- **Stale taps.** Acting on lift opens a window the press-commit model never had: the
  surface can change under a held finger. The lift re-checks the surface signature and the
  rect and drops the tap if either moved.
