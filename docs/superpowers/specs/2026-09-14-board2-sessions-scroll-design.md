# Board 2's sessions tab scrolls, and the list stops ending at six

Date: 2026-09-14
Status: approved, implementing on `sessions-scroll`

## The problem, stated correctly

"Board 2 can scroll, so add scroll to its sessions tab" reads like a firmware layout
change. It is not. The sessions tab is not limited by the panel - it is limited by a
**protocol-wide cap**:

- `host/index.mjs` urgency-sorts every known session and `records.slice(0, 6)` -
  truncating *before the payload is built*, then reporting what it cut as
  `sessionsTotal` / `hiddenAsking`.
- `deckhand_display.ino` `#define MAX_SESSIONS 6` sizes every session array.
- `board_es3c35p.h` already anticipates this request and says the row count was held
  at 6 deliberately: raising it "is a PROTOCOL-WIDE change, touching host/index.mjs
  and growing every 5s payload on a BLE link already measured as the bottleneck".

So scroll on the glass alone shows nothing new - the device only *has* six sessions.
The work is host + wire + device storage + a scrolling list, and it lands in
`sessions.ino`, which **both boards share**.

## Decisions taken (with the user, before implementation)

1. **20 sessions**, not 12 and not unbounded. The first 6 carry the full payload; 7..20
   ship lean.
2. **Ladder <=6, fixed 79px above.** One to six sessions render *pixel-identical to
   today* - same ladder, same expanded lone card, no rail, no scroll. Seven or more
   switches to a uniform 79px row (which clears `SESSION_SUB_MIN_H` 74, so the
   model/branch sub-line survives), five visible, scrolling.
3. **Promote on demand.** Tapping a lean row fetches its detail rather than refusing
   the tap or opening a stunted card.

## What does NOT change

`MAX_SESSIONS` **stays 6**. It is re-read as *"how many sessions carry a full ask
payload on the wire"* rather than *"how many sessions exist"*. This is deliberate and
load-bearing: `host/wire-bytes-check.mjs`, `host/ask-optdescs-check.mjs` and the DRAM
derivations in both board headers are all built on it, and changing the number would
silently re-point every one of them.

Board 1 keeps six rows, its ladder, and its behaviour. Every new constant is board
scoped and its board-1 value is the current one.

## Architecture

### 1. The device's storage - one array, not two

The first draft of this design had a parallel `SessionRow[]` lean struct plus a
dedicated focus slot, because 20 x 2.2KB of `SessionInfo` is 44KB and DRAM here is
~26KB free after the BLE stack.

**That parallel path is unnecessary on this board.** Board 2 has 8MB of PSRAM, and
`heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` is already this repo's established idiom
(`audio.ino`, `scrollback.ino`, `panel_shim.cpp`). 44KB of 8MB is 0.5%.

```
SESSION_SLOTS   board 2: 20   board 1: 6      // array sizing
MAX_SESSIONS    both:     6                   // full-ask-payload wire cap, unchanged
```

`sessions[]` becomes `SESSION_SLOTS` entries, allocated from PSRAM on board 2 and left
as today's static array on board 1. A lean session is simply a `SessionInfo` whose ask
fields arrived empty - so **`drawSessionRow`, `sessionAt`, `resolveDetailIndex`,
`buildSessionSubline`, `sendAnswerToHost` and the whole detail/ask path work unchanged.**
That is the single most valuable property of this design and the reason to prefer it.

`rowSigCache`, `rowDurCache`, `sessionOrder` and `prevSessions` size to `SESSION_SLOTS`
with it. `prevSessions` is ~92 bytes/session (1.8KB at 20) and stays in DRAM; it is the
per-tick diff and is touched every 5s.

### 2. The wire

`host/index.mjs`: sort as today, take **20**. Entries 0..5 are built as they are now.
Entries 6..19 are lean - only the fields the *row* draws, which are exactly
`{id, name, status, agent, hostSlot, title, model, branch, since}` (verified against
every field `drawSessionRow` and `buildSessionSubline` read). ~120 bytes each, so the
tail costs ~1.7KB per 5s tick.

`hiddenAsking` moves from `records.slice(6)` to `records.slice(20)`. `sessionsTotal`
is unchanged, so the `+N more` strip now means "beyond twenty".

`host/wire-fit.mjs` gets a **new tier ahead of tier 1**: shed lean rows off the tail
first. They are the cheapest bytes on the line and the least urgent by construction, so
a 16KB-pressured payload loses overview rows before it loses an answerable
`ask.detail`. Tier 3 (whole sessions off the tail) still backstops it, and a shed
`asking` row is still counted into `hiddenAsking`.

### 3. Promote on demand

Tapping a lean row sends `FOCUS <id>`. The host replies with **one `SESSIONDETAIL {...}`
line** carrying that session's full record - one-shot, ~1.5KB, *not* added to the 5s
tick. `handleDeviceLine` already has `HISTORY` and `SCROLLACK` as precedents for exactly
this request/response shape.

The reply fills the **existing slot** for that id in place. Three consequences, all good:

- The list never reorders. Wire order is sort order regardless of which entries are
  full, so the row the user tapped does not jump.
- No host-side pin set to maintain or age out.
- **The ask stays answerable.** `sendAnswerToHost(idx, optIdx)` takes an index, and the
  focused session already has one - so a lean session that is asking can be answered
  with no change to the answer path or the HMAC.

The card shows `...` in fields it does not have yet, and the request is idempotent -
the host delivers each device command over both transports, so `FOCUS` will arrive
twice and must tolerate it (CLAUDE.md's double-delivery rule).

### 4. Geometry - and why the scroll snaps to rows

```
avail = contentBottom(460) - SESSION_ROW_Y0(50)        = 410
row 79 + gap 3                                          = 82 per step
rows that fit: 5*79 + 4*3 = 407                         (3px spare)
20 rows: 82*20 - 3 = 1637 -> 15 steps of 82 = 1230
20 rows + strip: 1659 -> 16 steps = 1312
```

**The scroll offset is always a multiple of 82.** This is not an aesthetic choice.
Board 2 has **no region clip**: `PanelShim::clipLogicalRect` clips to the *screen*, and
`drawString` likewise. `scrollback.ino` documents paying for that twice (text painted
over the header, and an afterimage accumulating in the bottom air) and its fix is "draw
only elements wholly inside the body". For a 16px text line, skipping a partial one
costs a 16px sliver; for a 79px card it would cost a 79px hole.

Because both rows and offsets are multiples of 82, **every row is either wholly inside
the window or wholly outside it, at every scroll position** - verified exhaustively for
N=7, N=20 and N=20-with-strip. The partial-draw defect class is unreachable by
construction, and `drawSessionRow` is reused untouched.

The cost is that the list steps rather than glides. The alternative - rendering all 20
rows into a ~970KB PSRAM sprite and blitting a 410px window - is genuinely available on
this board and is the right upgrade if the stepping reads badly on the glass. It is a
new mechanism and is deliberately deferred, not dismissed.

The `+N more` strip becomes the list's last scrolling element at content y `82*N`,
which is why the strip case needs one extra step.

Rail: 6px wide at x 310..315, in the margin that already exists to the right of the
card (card ends at 308, panel is 320). **No lane widths change** - `SESSION_ROW_W` and
`SESSION_SUB_LANE_W` are untouched.

### 5. Touch

`scrollDragLoop()`'s structure ports directly: a blocking loop while the finger is down,
a named tap threshold separating "tap a row" from "drag the list", and an absolute scrub
when the drag starts on the rail. The rail scrub is what keeps 20 rows from costing 15
drags to traverse.

`sessionRowYAt()` / `sessionRowAtY()` / `sessionRowHAt()` are already the three
chokepoints every draw, hit-test and animation tick funnels through - the scroll offset
goes *inside them*, so tap targets cannot drift from the layout.

## The two traps this must respect

- **Change-only redraw.** A scroll step changes which session each screen slot shows.
  A position change reaches no text-comparing cache, so `rowSigCache[]` must be busted
  wholesale on every scroll step - the same treatment `rowCountCache` and `expHCache`
  already get. Five rows repainting per step is well within the deferred flush.
- **`#if` on a `const int` is silently false.** `BOARD_SESSIONS_SCROLL` and
  `SESSION_SLOTS` must be `#define`, not `const int`.

## Verification

- `sessions-geom-check.mjs` extended: the fixed-79 rung, the 5-visible fit, the step
  identity, the no-partial-row property swept across every scroll position, rail
  clearance, and that board 1's ladder is untouched.
- New `host/session-lean-check.mjs`: the lean record's field set, the new shed tier,
  and `hiddenAsking` at the 20 boundary. Structural half reads the real source.
- `commands-check.mjs`: `FOCUS` handled or refused by name on both boards.
- Both baselines checked. Board 1 expected `UNCHANGED`; board 2 expected to move, with
  the reason in the commit message.
- **And the glass**: `MULTITEST 20` puts twenty synthetic sessions up, then
  `SCREENSHOT` at several scroll positions. A checker cannot see the panel.

## Not doing

Free pixel scrolling (§4), lean rows in the compose/recents surfaces, and any change to
board 1's row count.
