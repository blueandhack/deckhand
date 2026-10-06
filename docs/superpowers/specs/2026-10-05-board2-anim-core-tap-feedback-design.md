# Board 2: animation core + tap feedback (piece 1 of 3)

Date: 2026-10-05. Status: design approved in conversation, awaiting spec review.

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

- Board 2 composes into a 320x480 PSRAM shadow framebuffer; the panel sees only `flush()`,
  which pushes the dirty union rect in <=32-line DMA strips. Full screen ~30ms, a 32x32 rect
  ~1ms (`docs/reference/boards.md`).
- Existing motion: the 300ms session-band crossfade (~30fps, one-shot), the shimmer (rides
  the spinner's existing flush), the agent-mark spinner, and the attention pulse (shipped
  DISABLED for power). All in `deckhand_display.ino` around `SESSION_XFADE_MS` and
  `tickSessionAnim()`. Board 1 has none of them, by name.
- `handleTouch()` commits on the LEADING edge (press). A held finger returns early; the lift
  commits only keyboard keys (`kbRelease()`). Only the keyboard has a pressed state.
- The three scrolling lists (`sessionDragLoop`, projects' two levels, `scrollDragLoop`) are
  blocking loops that already tell a tap from a drag (8px) and act on lift.
- `PanelShim` has `readRect`, `pushImage` (any pointer, PSRAM fine), `scrollRect`,
  `blend565`, and one framebuffer with no accessor.

## Scope

**Board 2 only.** Gated by `#define BOARD_HAS_ANIM` — `1` in `board_es3c35p.h`, `0` in
`board_e32r28t.h`. A `#define`, never a `const int` (`#if` on a `const int` is silently
false). Board 1 draws straight to the glass with no framebuffer to snapshot or blend
against, so it keeps press-commit and gets no animation. **Board 1's binary is expected to be
byte-identical**, and that is verified with `--check 1`, not reasoned about.

Out of scope here: the second framebuffer, region clipping, scaling, transitions, fling.

## Section 1 — the animation core (`anim.ino`, one `#if BOARD_HAS_ANIM`)

### Easing

Two fixed-point lookup tables, 33 entries each, input `t` in 0..32, output 0..1024, linear
interpolation between entries:

- `EASE_OUT_CUBIC[]` — `1 - (1-t)^3`. The default for everything.
- `EASE_OUT_BACK[]` — overshoot form, tuned to peak at ~1106 (~8%) before settling at 1024.
  Used by later pieces for arrivals; piece 1 declares it so the checker binds it now.

Values are generated once by a one-off Node snippet whose formula and overshoot constant
are quoted in `docs/reference/animation.md`, and are written into `anim.ino` as literals. The
checker validates their SHAPE (Section 3), not their equality to a formula, so no transcribed
copy exists to drift. `animEase(curve, elapsedMs, durationMs)` returns 0..1024
(or up to the overshoot), clamped to the end value once `elapsed >= duration`.

### Frame clock

`animTick()` is called from `loop()` beside the existing ticks. At most one frame per
`ANIM_FRAME_MS = 16`, and only while at least one slot is active; at rest it is one
comparison, the same contract as the session crossfade. Each frame composes every active
slot into the framebuffer and calls `tft.flush()` once, so its cost is the union of the
active rects.

A blocking drag loop stalls `animTick()` for the gesture's length. Accepted: nothing in
piece 1 animates during a drag (the press highlight is removed before the first scroll
frame — see Section 2).

### Slots

`AnimSlot animSlots[ANIM_SLOTS]` with `ANIM_SLOTS = 4`. Each slot holds: rect, start ms,
duration ms, curve, tint colour, from-alpha and to-alpha (0..255), a snapshot pointer, and an
`active` flag. Piece 1 uses one slot at a time (the press); the table is sized for pieces 2
and 3 so they do not reshape it.

### Snapshots

One PSRAM arena of `BOARD_W * BOARD_H` pixels (`uint16_t`, ~300KB of the 8MB), allocated
at boot with `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`. **Sized from the board header,
never a literal.** A slot that needs a base image bump-allocates its rect's pixels from the
arena and copies them with `readRect`; the arena resets when every slot is idle. If the
allocation fails at boot, or the arena is exhausted, the animation is SKIPPED and the
state change happens instantly. The skip is logged once by name, never silently.

**Every frame blends from the snapshot, never from the framebuffer's current contents**,
so a frame can never compound on its own previous output.

### Cancellation: `PanelShim::watch`

New on `PanelShim`: `watch(x, y, w, h)`, `unwatch()`, `watchHit()`. Every primitive that
already marks a dirty rect also tests that rect against the watched one and sets a flag on
intersection. The animation tick's own writes run with the watch suspended.

**This rule is what makes the core safe.** If anything else (the 1s tick redrawing a field,
a payload repainting a row) draws inside a running animation's rect, the animation cancels
instead of blending its stale snapshot back over fresh content. Without it, the
redraw-only-on-change caches would believe the new value is on the glass while the old
pixels sit there indefinitely.

Piece 1 watches one rect at a time. Multiple watches are piece 2's problem, if it has one.

## Section 2 — taps act on lift, with a press highlight

### What changes in `handleTouch()` (only under `BOARD_HAS_ANIM`)

**Still on press:**
- wake from sleep and undim
- dismiss the octopus and the emoji grid ("any tap dismisses" surfaces)
- the keyboard's key band (`kbArm`/`kbSlide`/`kbRelease`, already arm-then-commit)
- the drag loops' start on the three scrolling lists (they already decide tap vs drag
  themselves)

**On lift:** everything else. The existing dispatch chain below the keyboard branch moves
verbatim into `dispatchTap(sx, sy)`. On press, `handleTouch` records `(pressX, pressY)`,
resolves the press rect and starts the highlight. On lift, if the finger is still inside
the rect plus 12px of slop, it calls `dispatchTap(pressX, pressY)`, with the ORIGINAL
press point. **The handlers do not change; only when they are called does.**

### Cancel by sliding off

If the finger leaves the press rect by more than `PRESS_SLOP_PX = 12` while held, the
highlight fades out over 120ms and the lift dispatches nothing. Without a resolved rect, a
movement of more than 12px from the press point cancels too, so a finger that was really
scrolling or resting does not fire.

### The press rect: `pressRectAt(sx, sy, &r)`

It walks the surfaces in the same order as `dispatchTap` and REUSES the hit tests the
dispatch uses (`sessionRowAtY()`/`sessionRowYAt()`, the tab-bar cell division, the settings
row geometry, the ask and compose chip rects, the project and psess row geometry), so the
lit rect and the tap's destination cannot disagree. Coverage in piece 1: the tab bar,
session/project/psess/settings rows, compose and ask chips, and the buttons on those
surfaces. **No match means no highlight, and the tap still fires on lift.** A missed control
is a missing highlight, never a wrong action.

### The highlight

- **Press:** snapshot the rect, then blend the snapshot toward `COLOR_ACCENT` from alpha 0
  to `PRESS_ALPHA` (~20%, 51/255) over `PRESS_IN_MS = 40` on `EASE_OUT_CUBIC`. Hold there
  while the finger stays. Pixels are tinted in place and nothing is drawn on top, so text
  stays legible in both themes, and the theme's own accent carries it.
- **Lift inside the rect:** restore the snapshot, call `dispatchTap`, and let both reach
  the glass in one flush. Then:
  - **The watch was not hit** (the action left the rect alone): take a fresh snapshot and
    fade the tint `PRESS_ALPHA -> 0` over `PRESS_OUT_MS = 120`. This is the release flash.
  - **The watch was hit** (a toggle flipped, a new screen opened): skip the fade. The
    change itself is the feedback.
- **Lift after sliding off:** fade `current -> 0` over 120ms, and dispatch nothing.

### Scrolling lists

On press, the row highlights as above. If the drag loop classifies the gesture as a DRAG,
the snapshot is restored, the slot freed and the watch dropped BEFORE its first scroll
frame, so the tint never scrolls with the list. If it classifies a TAP, the normal lift
path runs.

### Invariants this must not break

- The `composeOnKeys() && kbRelease()` line stays exactly where it is:
  `settings-geom-check` binds the keystroke commit to it.
- Keyboard screens return before `dispatchTap` is reached, so a key lift cannot fire twice.
- `processCompletedLine` handlers and the double-delivery rules are untouched; this is
  touch-only.

### User-visible cost

Actions arrive at lift rather than touch, which is ~60-120ms later on a quick tap, in
exchange for a press you can see on every control and a cancel.

## Section 3 — verification

### Offline: `firmware/deckhand_display/anim-check.mjs`

It parses the firmware's own text; nothing is transcribed. `--selftest` injects each fault
below and exits 0 only if every one is caught BY NAME.

1. **Easing tables:** both arrays parsed out of `anim.ino`. Cubic: starts at 0, ends at
   1024, never decreases. Back: ends at 1024, peak in `[1070, 1130]`. Fault: one entry
   flipped.
2. **Tap timing:** within `handleTouch()`'s BODY (not the file), `dispatchTap(` appears
   only on the lift branch and only inside `#if BOARD_HAS_ANIM`. Fault: a press-path call.
3. **Flag form:** `BOARD_HAS_ANIM` is `#define`d in both headers, never `const int`.
   Fault: a `const int` declaration.
4. **Arena sizing:** the snapshot allocation's size expression names `BOARD_W` and
   `BOARD_H`. Fault: a literal.
5. **Watch on the draw path:** `PanelShim`'s dirty-marking function contains the watch
   test. Fault: the test removed.

Existing checkers must stay green: `commands-check`, `settings-geom-check`,
`sessions-geom-check`, `geom-sweep`, and `board-baseline --doc-check`.

### On the device

- **`PRESSTEST <x> <y>`** paints the press highlight at that point and holds it, so
  `SCREENSHOT` can confirm the rect lines up with the control in both themes (`THEME
  dark|light`). **`PRESSTEST off`** releases WITHOUT dispatching. It refuses BY NAME on: no
  control under the point (quoting the point), a surface that keeps press-commit (naming
  it), a non-numeric or off-panel argument (quoting the range). Board 1 refuses it from
  `UNAVAILABLE_COMMANDS[]`, guarded by the exact negation of the handler's guard. The host's
  double delivery is safe: the same point resolves the same rect, and a second identical
  `PRESSTEST` is a no-op that says so.
- **`PERF`** gains an `ANIM` line: frames, compose avg/worst µs, flush avg/worst µs, starts,
  cancels (watch hits), skips (arena). Target: worst frame < 16ms on a full-width session
  row.
- **A screenshot vouches for geometry only.** Motion, colour and feel are judged by the user
  on the glass, in both themes. Until then they are recorded as UNVERIFIED.

### Binaries

- Compile board 1 first: `--check 1` must be `UNCHANGED` (core stamp pooling noted).
- Then board 2, alone, never concurrently. `--check 2` will be `CHANGED`; its flash and RAM
  movement are measured, explained, re-baselined with `--update 2`, and written into
  `CLAUDE.md`'s figures with the cause.

### Docs

- New `docs/reference/animation.md`: timings, the snapshot and cancellation rules, and the
  measured/unverified ledger.
- `CLAUDE.md`: a row in "Read this before touching that", the `PRESSTEST` row in the
  command table, and the RAM/flash entry.
