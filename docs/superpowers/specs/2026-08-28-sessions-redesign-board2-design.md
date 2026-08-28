# Sessions redesign — board 2

Date: 2026-08-28
Scope: board 2 (`ES3C35P`) only, except one deliberate shared-code change (§8).

## 1. Why

The complaint was **wasted and awkward space**, and the measurement backs it. Over
**9,452 ticks** across both host log generations:

| sessions | ticks | share | list area wasted (of 410px) |
|---|---|---|---|
| 0 | 1,132 | 12.0% | the whole tab — one line of grey text |
| **1** | **6,527** | **69.1%** | **198px — 48%** |
| 2 | 1,223 | 12.9% | 95px — 23% |
| 3 | 365 | 3.9% | 0 |
| 4 | 205 | 2.2% | 1px |
| 5–6 | **0** | **0%** | — |

Two conclusions, both load-bearing for everything below:

- **The ladder is tuned for a case that has never occurred.** Five and six sessions
  are 0 of 9,452 ticks, so the `79`/`65` rungs are dead in practice. The dominant
  case (one session, 69%) is the one that looks worst.
- **The card cannot simply grow into the gap.** `SESSION_EXP_MAX_H` is 212 because
  `prompt[104]` holds 100 characters = 4 lines at a 32-column lane, and that is
  everything the host sends about a session. Above 212 there is nothing left to put
  in it.

So the decision taken was: **design the card for 410px using today's data** — the
height comes from type size and leading, not from new fields. No protocol change,
no new `SessionInfo` bytes, no RAM cost.

## 2. The cost model that constrains every visual choice

Derived from the two flush figures already measured on this panel (32×32 dirty rect
= 939µs; full screen = 30ms, gather 8.3 + transfer 21.8):

```
flush ≈ 740µs + 0.196µs × pixels
```

**This is a two-point fit, not a characterisation.** It is used only to rank
options, and any figure below should be re-measured with `PERF` before being
quoted as fact.

| region | pixels | flush | budget at 30fps |
|---|---|---|---|
| spine 6×404 | 2,424 | 1.2ms | 4% |
| band 296×44 | 13,024 | 3.3ms | 10% |
| one row 296×100 | 29,600 | 6.5ms | 20% |
| full screen | 153,600 | 30ms | **100% — impossible** |

**The rule this produces: animate regions, never the screen.** It is the same
conclusion the change-only redraw discipline already reached for the flicker
reason, arriving from the power/latency side.

## 3. The card — status band (option C)

The card head becomes a **filled band in the status colour**, 44px, holding the
status word (`T_HEAD`, Spleen 12×24), the duration, and the agent mark. The body
below stays calm: name, agent/model/branch, title, a rule, `LAST PROMPT` + prompt,
a rule, path.

Why a band rather than the alternatives that were mocked:

- It colour-codes the whole card from across the room without spending 64px of
  height on a single word (rejected option A).
- It gives the duration and the agent mark a home, which a corner pill cannot.
- The body keeps `T_BODY` throughout, so the card gains presence without the
  title competing with the name (rejected option B).

**Filled bands are new vocabulary for this UI** and that is accepted, not
overlooked — nothing else on the device fills a region with a status colour. The
band is the reason it reads at a distance.

## 4. The multi-session rule

A 44px band cannot ride every row: at four sessions each row is 100px, so a band
would spend 44% of a row on one word. The band therefore has a **compact form —
a 6px status-coloured spine down the row's left edge**. Same vocabulary, ~1.2ms,
scales to any row height.

The arithmetic is today's expanded-row formula with the existing floor, so this
is **not a new mechanism**:

```
leftover = 410 − (n−1) × (sessionRowH + SESSION_ROW_GAP)
band card = leftover < SESSION_EXP_MIN_H ? none : min(leftover, cap)
```

| n | leftover | top row | rest |
|---|---|---|---|
| 1 | 410 | band card | — |
| 2 | 307 | band card | 1 × spine row |
| 3 | 204 | band card | 2 × spine rows |
| 4 | 101 | **no band** | 4 × spine rows |
| 5–6 | 82 / 70 | no band | spine rows |

Below the floor a band card would leave 57px of body — worse than a plain row —
so it stops being one, exactly as `SESSION_EXP_MIN_H` already does today.

**`SESSION_EXP_MAX_H` rises from 212**, because the band card's larger head and
leading now have somewhere to put the surplus. The new cap is **derived, not
chosen** — it is the sum of the blocks that can actually carry ink, in the
board header, the way the current 212 is:

```
band 44 + name 34 + sub 32 + title 2×20 + rule 18
       + LAST PROMPT 28 + prompt 4×24 + rule 18 + path 20 + pad 6
```

Two hard constraints on that sum, both inherited from today's derivation:
the prompt cannot exceed **4 lines** (`prompt[104]` holds 100 characters against a
32-column lane, so a 5th line is permanently blank), and the title cannot exceed
**2** (`title[44]` holds 43). If the derived total lands below 410, the remainder
stays **outside** the card as list area, as it does today, rather than becoming a
card of air. The checker must assert the total against the parsed blocks, so a
future field cannot silently push a line past what its data can fill.

**The spine never carries status alone.** Every spine row keeps its text pill.
Colour is never the only carrier here — the same rule that makes the status pill
a filled/outlined/boxless *shape* rather than a hue.

## 5. Agent distinction — shape, never hue (option C)

**Colour is unavailable: status owns it.** Band fill, spine and pill are all
`colorForStatus`. Giving the agent a hue means two channels fighting over one
card, against this repo's existing rule — *"Mixing the two on screen: text, never
colour or an icon… colour is never the only carrier of meaning here, and a tag
also has to survive a model rename."*

Three carriers, none of them hue:

1. **The mark at every status.** `drawStatusDot` currently calls `drawAgentSpinner`
   **only** when `status == "working"` (`deckhand_display.ino:1804`); `asking` and
   `waiting` fall through to a plain square or ring with no agent distinction at
   all. The Claude spark and Codex mark become the row indicator at all statuses —
   animating while working, at rest otherwise.
2. **Spine texture.** Claude solid, Codex segmented. A fill pattern: no blits, no
   new art, reads in greyscale.
3. **The existing `CC`/`CX` text tag**, unchanged.

Redundant on purpose, the same way a tall row already names its Mac twice.

Two costs, stated rather than discovered:

- **Neither mark has a resting pose.** Both are 8 *motion* frames from
  `spark2c.py` / `codex2c.py` with no idle frame; frame 0 may not read as
  deliberate. A rest pose is **new art**, and the Codex one requires re-running a
  generator that needs headless Chrome (this toolchain has no SVG rasteriser).
  If a convincing rest pose cannot be produced, the fallback is the mark drawn at
  `COLOR_LABEL` strength without animation.
- **A mark on every row is up to 4 blits per repaint** instead of one, ~940µs each
  ≈ 3.8ms. Affordable beside a 30ms full flush; not free.

## 6. Animation

Adopted now:

- **State crossfade** — the band fades between status colours and labels on a
  change, ~300ms, one-shot. A state change is currently a silent instant swap;
  motion is what makes you notice it happened. 3.3ms/frame, band only.
- **Spine shimmer** — a light travels the spine while working. 1.2ms/frame, the
  cheapest thing considered.

Adopted **only after measurement**:

- **Attention pulse** — the band breathes while a prompt waits. It is the only
  candidate visible across a room, which is the whole job of a status display,
  and the only one that runs continuously on a battery device where the backlight
  already costs ~80 of ~142 mV/h. **Gate: a `POWERPROBE` A/B in one session** —
  probe the idle state, enable the pulse, probe again. Ship it if the delta is
  small; drop it if it is not. Not an argument.

  **STATUS: BUILT, SHIPPED DISABLED, AND STILL UNMEASURED.** The pulse exists
  behind the runtime toggle `PULSE 0|1`, defaulting **off**. The A/B has **not**
  been run, and no mV/h figure for it exists — `POWERPROBE` refuses on USB by
  design (a probe that "worked" on the charger would be measuring the charger), so
  the measurement needs a person to unplug the cable and give it 7–15 minutes a
  leg on battery. The exact procedure is committed beside `sessionPulse` in
  `deckhand_display.ino`; run it, then either delete the toggle and make the pulse
  ordinary behaviour, or delete the pulse — **and record the number either way**,
  because an unrecorded negative result gets re-proposed within the month.
  What the implementation already settles, so the A/B measures the cheapest
  honest version rather than a strawman: the band is repainted only when the
  **colour** its ramp produces changes, not once per sample. Computed from the
  shipped palette, the asking colour's ramp holds 16 distinct RGB565 colours on
  DARK and 6 on LIGHT, so a 2.4s breath costs **30 band repaints at worst and 10
  at best** against its 72 samples. `PERF` reports that count — as a *rate*, from
  two reads and a division, since `n` is cumulative since boot.

  **Seen on the glass, and the arithmetic exercised, on 2026-08-28** (LIGHT, one
  asking session holding the band card): the band's fill moved between the flat
  status colour and a blend towards `COLOR_VALUE` — captured at two phases, pixel
  values `(107,16,57)` and `(82,16,49)`, both exactly on the computed ramp, whose
  six distinct rendered colours match the checker's computed six. Two `PERF` reads
  35 s apart gave **8.9 repaints a breath** against 10 predicted and 72 samples.
  `compose` 3.2–3.5 ms, `flush` 3.6–4.1 ms (a ceiling — a working row was present).
  Clearing the toggle froze the counter permanently. **Still unmeasured: the
  drain.** And a still capture cannot judge *motion*, which is the thing the pulse
  is actually for.

Rejected:

- **Row enter/leave.** Rows move only when the ladder re-flows, and a re-flow
  repaints the whole list anyway — a full-screen animation wearing a row's clothes.
- **Tab transitions.** 30ms/frame is the entire budget at 30fps before composing.

Two inherited rules: an animation must **never touch `lastNonIdleMillis`** (it
must not read as activity to the sleep timer), and every tick must be gated on the
sessions list actually being visible, as `tickWorkingSpinner` already is.

## 7. The detail screen

**This is the one surface not visually reviewed before this spec was written** —
the mockup round was interrupted by the animation question and never resumed. It
is designed here from the same vocabulary and should be mocked before implementing
if the description below does not read clearly.

Today: header row 50px, card `CONTENT_Y + 50` height 326 (96..422), then the
history hint, ~38px of trailing area. Status is a pill with `for 12m - 14:31`
beside it; `MODEL`/`GIT BRANCH` and `STARTED`/`AGENT` sit as paired label/value
columns.

Proposed:

- **The same 44px band** heads the card: status word, duration and wall-clock,
  agent mark. This removes the pill, the duration line, and the `AGENT` column
  from the body — three fields absorbed by the head.
- Body cursor: name (`T_HEAD`) → title (2 lines, `T_BODY`) → rule →
  `LAST PROMPT` + 4 lines → rule → path (2 lines) → a single dim meta line
  carrying `model · branch · started`, replacing the remaining column pairs.
- The card grows into the trailing area (326 → ~350) with the history hint kept
  below it, since the band consumes 44px that the body previously used.

**The detail card repaints wholesale rather than per-field**, so no clear box can
reach its border — the hazard that applies to the usage cards does not apply here.
`detailSigCache` (384, against a derived 358 worst case) must be re-derived if any
field is added; removing fields only loosens it.

## 8. Ranking: longest-waiting asking first (shared code)

The band card goes to display position 0, so **what lands there is now a visual
decision, not only a sorting one.** Today `reorderSessions()`
(`deckhand_display.ino:3195`) sorts by `(urgencyRank, −actSec)` — most *recent*
first — so a prompt unanswered for 20 minutes loses the band card to one that
started asking 5 seconds ago.

New key:

```
key(s) = ( urgencyRank(s.status),
           rank == 0 ? −elapsed(s.statusSinceMillis)   // asking: longest wait first
                     : −s.actSec )                     // else: most recent first
```

Only rank 0 changes. `waiting` and `working` keep recency, deliberately: for a
working row "most recent" means *live*, and the oldest is the stale one.

Two implementation requirements:

- **Compare elapsed, not raw timestamps.** `millis()` wraps at ~49.7 days;
  `now − since` is wrap-safe under unsigned arithmetic and `a.since > b.since` is
  not. Same idiom `formatDuration` already uses.
- **Sample `now` once** at the top of `reorderSessions()`. A clock advancing
  mid-sort makes the comparator inconsistent with itself.

The comparison moves into a pure `sessionSortsBefore(b, a, now)` taking `now` as
an argument — no clock inside — for the same reason `run-ledger.mjs` and `capUtf8`
are their own units.

**Known limitation:** `statusSinceMillis` is device-side, so it restarts on reboot
and when a stale Mac's rows are dropped and return. A prompt asking for an hour
would then read as new. This is the existing limitation of the `for 12m` field, and
the sort agreeing with the number already on the row is worth more here than
absolute truth.

**This is the one change that moves board 1's binary, and it does so on purpose.**
Re-baseline with `node firmware/board-baseline.mjs <bin> --update 1` and say in the
commit message why. Everything else in this spec is board-2-only and board 1 must
stay byte-identical.

## 9. Ask options — three real defects

All three are latent today only because nothing has yet sent a long option label.

**a. The description never crosses the wire.**
`claude-hooks/deckhand-session-hook.mjs:256`:

```js
const opts = (q.options ?? []).slice(0, 4).map((o) => clean(o?.label ?? o, 32));
```

`o.description` is never read, so the device cannot show an option's explanation
no matter what the screen looks like. Fix host-side: send `{label, description}`
with the description capped at **96 bytes**, and grow the device buffer to match.

**The RAM cost must be stated before it is spent, because `SessionInfo` is the
binding constraint on this device, not flash.** Today `askOpts[4][34]` is 136
bytes per session = 816 across `MAX_SESSIONS`. Adding a 96-byte description per
option is `4 × 98 = 392` per session = **+2,352 bytes** — and `PrevSession` does
not carry these, so that figure is the whole cost. For comparison, slimming
`prevSessions` once reclaimed 12,792 bytes and bought the audio path a full extra
second of capture. If the plan finds this too expensive, the fallback is a
**shorter description cap (48 bytes, +1,176)** rather than dropping the feature.

**b. A long label is silently truncated at 32 characters** by the same line, and
any option past the **4th** is dropped, as is a second question (`questions[0]`).
Raising the label cap requires growing `askOpts[4][34]` in lockstep — and
`SessionInfo` is already 2.2KB × 6, so the budget must be stated in the plan, not
discovered.

**c. A long label overflows its own chip on the device.**
`sessions.ino:1011-1012` draws the label centred with `drawString` and **no width
bound**, and `drawString` paints an opaque box:

| | label + `" - sent"` | drawn span | card | result |
|---|---|---|---|---|
| board 2 | 39 × 8px = 312 | x 4..316 | 12..308 | overflows 8px each side |
| board 1 | 39 × 6px = 234 | x 3..237 | 12..228 | overflows 9px each side |

So a chosen 32-character option rubs out its own chip border — the
`drawString`-opaque-box class this repo has already paid for twice. **Fix on both
boards** via `fitText` against the chip's lane; the board-1 half is a genuine bug
fix and is expected to move that binary, so it rides the same re-baseline as §8 or
goes on its own branch.

Chips grow to hold a wrapped label plus a dim description line; `ASK_OPT_H` is
re-derived from that content rather than kept at 46.

## 10. Empty state

12% of ticks draw a sparkle and `"No active Claude Code sessions"` centred in
414px (`sessions.ino:506-514`). Out of scope for the first implementation pass,
but it is the second-most-common state on this tab and should not stay a single
line of grey text once the card work lands. Recorded here so it is a known gap
rather than an oversight.

## 11. Verification

There is no test suite; verification is the checkers plus the glass.

- **`sessions-geom-check.mjs` must be extended, not merely kept passing.** Every
  new constant — band height, spine width, the raised `SESSION_EXP_MAX_H`, the new
  detail cursor, `ASK_OPT_H` — must be **parsed from `board_es3c35p.h`, never
  transcribed.** A literal on the checker's side is what let `PILL_H` drift once
  already. The test of a new assertion is not "does it pass" but **"does reverting
  the constant make it fail, and by name"**.
- **`geom-sweep.mjs`** should be re-run: a constant this work *adds* that comes
  back UNGUARDED is a gap, not noise.
- **`board-baseline.mjs --check 1`** after every step, to prove board 1 has not
  moved except at §8 and §9c.
- **`PERF`** on the glass for the real flush costs; the §2 model is a ranking tool
  only.
- **`POWERPROBE`** A/B before the attention pulse ships.
- **`SCREENSHOT` cannot judge colour on this board** — it reads the shadow
  framebuffer. It *is* valid for layout, which is what most of this work is, but
  the band's fill colours must be checked with `COLORTEST`/on the glass.

## 12. This is four pieces, not one

The self-review flagged it and it is worth stating plainly: **this spec is too
large for a single implementation plan.** It decomposes cleanly, and the pieces
are genuinely independent — each is shippable and verifiable on its own:

| # | piece | sections | touches board 1? |
|---|---|---|---|
| 1 | Ranking: longest-waiting asking first | §8 | **yes, deliberately** |
| 2 | Ask-option defects | §9 | yes (§9c only) |
| 3 | The card: band, spine, agent marks, animation | §3–6 | no |
| 4 | Detail screen | §7 | no |

Recommended order: **1 → 3 → 4 → 2.**

- **1 first** because it is small, self-contained, and it decides *who gets the
  band card* — building the card before the ranking means the most visible slot is
  filled by the wrong session while it is being judged.
- **3 before 4** so the band and spine vocabulary is settled on the surface you
  look at most, before the detail screen inherits it.
- **2 last** because it is the only piece with an unresolved RAM budget, and
  because §9c fixes a latent bug rather than a visible one.

Piece 3 is itself large enough that its plan should stage the band card, the
multi-session rule, the agent marks and the animation as separate verifiable steps
rather than one change.

## 13. Out of scope

- Raising `MAX_SESSIONS` — a coordinated host+device protocol change with a RAM
  budget, not a screen change.
- Board 1's layout. The eleven known board-1 defects stay on their own branch.
- The empty state (§10), beyond recording it.
