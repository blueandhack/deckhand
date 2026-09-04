# USAGE: NOW / WEEK / CODEX and the adaptive column

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

#### USAGE on board 2: NOW / WEEK / CODEX, and a trend ring that serves two masters

Board 1 is unchanged: two structurally identical 104px cards plus a 44px Codex row. Board 2's
USAGE tab is now a **NOW** card (182px, the 5-hour window, a 64px hero), a **WEEK** card (144px,
7 days, a `T_HEAD` number rather than a hero — that size contrast **is** the hierarchy) and a
56px **CODEX** row. The guard is `BOARD_USAGE_V2`, 1 in `board_es3c35p.h` and 0 in
`board_e32r28t.h`. The normative geometric spec is the committed mock,
`docs/design/usage-redesign/` (`node check.mjs`, 582 checks, every constant it shares with the
board header parsed out of it rather than transcribed; `--selftest` perturbs a bound `K` value in memory and requires that bind to fail, run through the real comparison function rather than a second reimplementation of it — it used to silently accept the flag and report the normal clean pass instead).

**THE COLUMN IS 414 ROWS, NOT 416, AND THE HEADER'S OWN COMMENT SAID 416 FOR AS LONG AS THE
DRIFT EXISTED.** `8 + 182 + 8 + 144 + 8 + 56 + 8 = 414`. The old derivation
(`8+164+8+164+8+56+8 = 416`, "with 8px of air") was written before `FOOTER_H` moved 18 → 20, so
`contentBottom()` had become 460 and the truth was 414 with 6px. **Nothing could catch it**: the
assertion guarding the column was `air > 0`, which is satisfied at 8, at 6 and at 1 — the same
class as the settings branch's `PS_SOUND_Y - PS_ALERTS_Y === SET_CAP_STEP`, a bound that cannot
fail. It is an exact sum-to-414 now, with the DRAWN terms checked against the DECLARED ones.
Recorded because it is the second time a stale comment in this header has outlived the code it
describes, and both times a `> 0` assertion was standing next to it.

**`CARD_HERO_W` IS THE WHOLE DENSITY WIN, AND IT NAMES 132px THAT WERE BEING *ERASED*.**
`drawBigNumber()` clears the box it is HANDED, and v1 handed it the full `CARD_W - 2*PAD` = 260px
lane while `"100%"` at Spleen32x64 inks 4 × 32 = **128**. So 132px beside every hero was not
merely unused — it was repainted `COLOR_CARD` on every value change, which is why nothing had
ever been put there. `CARD_HERO_W` (132, the glyph plus 4px of slack) bounds the clear, and the
reclaimed lane now carries the two facts a bare percentage only implies: the burn verdict and the
reset countdown, right-aligned in a `SIDE_CHARS`-wide lane **derived** from
`(CARD_X + CARD_W - PAD - SIDE_X0) / TEXT_ADV` rather than stated. A revert to the full lane
fails by name.

**ONE RING, TWO PURPOSES, AND IT IS SAMPLED AT THE OAUTH POLL CADENCE RATHER THAN ONCE A MINUTE
— which is what makes it worth drawing at all.** `usageRingPct[31]` feeds both the NOW card's
sparkline and the short-window burn slope. The quota only MOVES every `OAUTH_POLL_INTERVAL_MS`
(5 min, in `host/index.mjs`), so a 1-per-minute ring would hold five identical samples then a
step — about six distinct values in half an hour, drawn as a staircase that is an artifact of the
sampler rather than of the account. At the poll cadence the same 31 slots span **150 minutes**.
- **31 slots, not 30, and the reason is the CAPTION.** The span is `(n-1) * step`, so 30 slots
  span 145 minutes and a card captioned `LAST 2.5H` over a 145-minute ring overstates it by five.
- **THE DECLARED SPEC DEVIATION IS RESOLVED: the caption is now COMPUTED, and it had to be, because
  the literal was overpromising at partial fill.** This bullet used to record that `renderNowCard()`
  wrote the bare string `"LAST 2.5H"` regardless of how much of the ring had actually filled, gated
  only by a pair of assertions (`SPAN == 150` and `"LAST 2.5H" in INO`) that could catch a ring-size
  change but not a caption lying about a ring that had barely started. That gap was not
  hypothetical: **observed on the glass**, two samples five minutes apart captioned `LAST 2.5H` —
  the span of a FULL ring — in a repo whose whole discipline is not claiming more than you measured.
  Fixed with `usageRingSpanMin()` (mirrors `battTrendSpanMin()` in `power.ino` exactly, including
  the `count < 2` → 0 guard) and `usageSpanCaption()`, which formats `"no history"` below two
  samples, `"LAST %dM"` below an hour and `"LAST %d.%dH"` at or above it — computed from
  `USAGE_RING_SLOTS`/`USAGE_RING_STEP_MIN` at last, so a ring-constant change moves the caption with
  it rather than leaving a literal to drift. `usage-trend-check.py` now mirrors the formatter itself
  (`span_caption()`) and binds it to the real source structurally: `renderNowCard()` must call
  `usageSpanCaption(...)`/`usageRingSpanMin()` and must NOT contain a bare `"LAST 2.5H"` literal
  anywhere in its own body, and `usageRingSpanMin()` must return 0 below two samples. Widest output
  is still `"no history"` (10 chars) — `padLeftTo(buf, sizeof(buf), 10)` into `resetAt1Cache[14]`
  needed no change, verified by the existing parsed-cache-width assertion rather than assumed.
- **`USAGE_RING_DROP_PCT` (3) is DERIVED, not picked.** A large fall means the window turned over
  and a slope across that discontinuity is meaningless — but `mergeUsage()` can swap the source
  Mac at any tick, and the two Macs' readings differ only in AGE, bounded by one poll interval, in
  which the shortest window this ring serves moves `100 * 5 / 300` = **1.67 points**. So a 1- or
  2-point fall is explicable by a source switch and must NOT clear 2.5 hours of history; 3 is not.
- **A staleness EDGE clears the ring, never the level.** The clock keeps running while the number
  does not, so samples either side of the gap are not one series — but testing the LEVEL would
  clear the ring on every one of the 5s ticks it spends stale, which is the ring it is trying to
  fill.
- **The sparkline is scaled 0..100, never to the series' own min and max.** Auto-scaling reads
  better and lies by omission: a quota sitting still with integer-percent noise would draw a
  dramatic mountain. It agrees with the pace bar directly above it because it shares that bar's
  scale.

**TWO BURN ESTIMATORS, CHOSEN BY WINDOW LENGTH, AND THE MEASUREMENT THAT FORCES IT IS 50.00
AGAINST 1.49.** Movement across the ring is `100 * span / window`, so over the ring's 150 minutes
the **5-hour window moves 50.00 points and the 7-day window 1.49** — and the percentage is an
INTEGER, so the week's whole movement across 2.5 hours is inside the rounding. A single estimator
cannot serve both: the ring slope sees a burst in the last ten minutes that an average over the
window cannot, and is blind on the week. So `windowMin <= BURN_RING_MAX_WIN` (2880, two days)
takes the ring slope and above it the average takes over, which is accurate there precisely
because elapsed is huge (0.8% error at 61% with 2400 minutes elapsed). `BURN_RING_MAX_WIN` is
itself derived: ring movement falls to `BURN_RING_MIN_RISE` at `100 * 150 / 3` = 5000 min
= 3.47 days, and 2880 sits inside that with margin.

**THE GATE IS ONE ERROR BUDGET WITH EVERY TERM DERIVED FROM IT.** `T = elapsed * (100 - pct) /
pct`, so half a point of quantization on an integer percentage costs a RELATIVE error of
`50 / (pct * (100 - pct))` — **independent of elapsed**, which is the non-obvious part and is what
lets one budget pick the admissible range. At `BURN_ERR_BUDGET_PCT` 20: pct 3 costs 17.2% and pct
2 costs 25.5%, so `BURN_MIN_PCT` is 3 and `BURN_MAX_PCT` 97 (above which the answer is
"empty now" rather than a number).

**`BURN_MIN_ELAPSED` PROVABLY NEVER FIRES, AND SAYING SO IS BETTER THAN LEAVING IT LOOKING LIKE A
MAGIC NUMBER.** It is one poll interval, and it is a data-VALIDITY bound rather than a taste call:
below one interval the percentage the device holds may have been read before the window boundary
and belong to the previous window. But the average estimator only runs above `BURN_RING_MAX_WIN`,
where reaching `BURN_MIN_PCT` already takes `0.03 * 2880` = 86 minutes — and **302 minutes on the
real 7-day window**, so the week's burn appears about five hours after a reset, gated by the
percent floor every single time. It is kept because a guard that has been deleted cannot catch the
change that would make it necessary — the same reason the charge estimator keeps its provably
unreachable 99h clamp.

**`BURN_NOT_YET` USED TO CONFLATE TWO REFUSALS THAT LOOK IDENTICAL ON THE GLASS, AND A USER CANNOT
TELL "WAIT" FROM "NOTHING TO SAY".** The ring-slope branch returned `BURN_NOT_YET` both while the
ring was still filling (`usageRingCount < 2`, or a real ring that has not yet SPANNED
`BURN_RING_MIN_SPAN`) and when the trend is flat or falling and may never resolve — both rendered
`burn --`. Measured consequence: after every 5-hour window reset the card reads `burn --` for at
least `BURN_RING_MIN_SPAN` (30) minutes, longer at light usage, with nothing distinguishing "ask
again shortly" from "there may never be an answer". A third named code, `BURN_WARMING` (-3, the
same convention as the charge estimator's `BATT_CHG_NOT_YET`/`BATT_CHG_TOPPING`), now covers the
two still-filling cases and renders `"measuring"`; a fully-spanned-but-flat ring still returns
`BURN_NOT_YET` and keeps `"burn --"` — the pairing that proves the split is real rather than a
rename is in `usage-trend-check.py`'s mirror 9d (still filling → WARMING) beside mirror 9e (spanned
but flat → NOT_YET). `usageBurnUrgent()` and the average-window path are untouched: the average
path's `BURN_MIN_ELAPSED` gate above is a data-validity floor, not a "still filling" state, and
conflating the two would misname a refusal that genuinely may never resolve.

**THE THREE CACHE HAZARDS, and all three are the change-only redraw discipline failing in the one
way it always fails: a field whose PIXELS are wrong while its VALUE has not changed.** Each is
asserted over the firmware's own source with the cache list **parsed out of the two renderers**,
never hand-kept — a hand-kept list goes stale the first time someone adds a field, silently.
1. **Every cache either renderer writes must be cleared in `resetUsageCaches()`.**
   `drawUsageStatic()` repaints the chrome these fields sit ON, so a cache it misses leaves the
   value BLANK — "hasn't changed" per `drawIfChanged`, even though its pixels were just erased.
   This shipped once already, as "USAGE shows no numbers after recording".
2. **The STALE flip must bust the caches `drawIfChanged`'s own text comparison cannot see.**
   `drawPaceBar` keys on `(pct, tick)` alone and `drawUsageSpark` on the ring's hash — so a
   colour-only change reaches neither, and a bright bar sits beside a dimmed hero indefinitely.
   The population is **parsed as "every cache `drawPaceBar` or `drawUsageSpark` writes"** rather
   than generalised to all 17 (`right1Cache`'s text already carries `stale Xh` and self-heals, so
   busting it too would be noise) — so a seventh bar added later is covered without anyone
   remembering a list.
3. **ONE SPELLING OF ONE THRESHOLD.** The v2 fields dim on `QUOTA_STALE_SEC`; the bust in
   `renderUsageTab` must compute staleness from that SAME named constant. Two spellings and a
   header retune leaves the bust firing at the old value while the colour flips at the new one —
   and in the window between them every colour-blind cache above holds a WRONG HUE indefinitely.
   The assertion is bounded to each function's `#if BOARD_USAGE_V2` arm, because an unbounded
   match finds whichever `quotaAgeSec >` comes first in the raw text. **Board 1 deliberately keeps
   its inline literal `900`** — naming it there would risk that board's binary for nothing — and
   that too is asserted, so the scoping cannot rot into board 1 referencing a constant its header
   does not declare.

**THE TWO SHARED FIXES CAME FIRST, AND THEY ARE WHY BOARD 1'S BASELINE MOVED TWICE ON A BRANCH
WHOSE WHOLE CLAIM IS THAT IT DOES NOT.** Bugs before features, and the redesign's Codex row
depends on the first one's wider lane, so doing them last would have left board 2 briefly
inconsistent with the committed mock.
- **The Codex label lane was derived from a PAD WIDTH, which is a FLOOR and not a ceiling.**
  `padLeftTo()` only ever GROWS a short string — handed one already longer than the pad width it
  returns early rather than truncating — so `CODEX_RIGHT_CHARS` was never a cap on that field.
  With a wall-clock suffix its real content ran to ~24 characters against a pad width of 20, so
  the right field's clear box (which draws AFTER the label on every tick) **ate the label's own
  tail**. Fixed by dropping the wall clock (the countdown beside it already says the same thing in
  relative terms), which takes the worst case to 18, and by deriving both boards' lanes from the
  field's own worst-case CONTENT. Board 1 went 11 → 13 characters, board 2 → 14.
- **The USAGE stats field was never right-aligned at all; it FLOATED with its content.**
  `renderCard` padded it with `padTo` (pad RIGHT) and drew it `TR_DATUM`, so the trailing spaces
  sat between the glyphs and the anchor and inset the text by `(16 - len) * advance` — 40px for
  `2h 14m left`, 24px for `starts on use`. Asserted over the SOURCE rather than over a constant,
  because nothing numeric was wrong: the wrong HELPER was. It also promoted
  `stripComments`/`fnBody`/`splitArgs` into `geom-common.mjs`, following `evalInt`'s precedent, so
  the three checkers that now read the firmware's own draw calls share one copy.

**`#if` ON A `const int` IS SILENTLY FALSE, AND THE FEATURE FLAG WAS BRIEFLY DECLARED THAT WAY.**
`const int BOARD_USAGE_V2 = 1` on board 2 against `#define BOARD_USAGE_V2 0` on board 1: the
preprocessor cannot see a C++ `const int`, so `#if BOARD_USAGE_V2` evaluates an undefined
identifier as **0**, with no `-Wall` warning — every guarded arm would have taken board 1's
branch on board 2, i.e. the whole redesign compiling perfectly cleanly and never reaching the
glass. And **`consts()` reported green throughout**, because it parses both forms and cannot tell
them apart: the checker was structurally unable to see it. There is now an assertion that reads
the header's RAW TEXT and fails if any `BOARD_*` flag is a `const int`, on both boards. Same
family as `panel_shim.cpp`'s `#if BOARD_PANEL_INVERT` on a macro that translation unit cannot
see — twice now, in the same direction.

**A DEFAULT ARGUMENT ON A SHARED FUNCTION MOVED BOARD 1 AT +0 BYTES, AND THIS IS THE SINGLE BEST
ARGUMENT ON THE BRANCH FOR WHY THE OLD SIZE COMPARISON HAD TO GO.** A naive 4-argument default on
`drawCardChrome` changed board 1's codegen with **no size change whatsoever** — invisible to
"compare those two numbers", caught by `board-baseline.mjs`'s masked hash, fixed by `#if`-ing the
signature so board 1 never sees the extra parameter.

**AND BOARD 2'S MASKED HASH CAN MOVE AT +0 BYTES WITH NOTHING EMITTED AT ALL.** Task 6's commit
added the two estimators behind renderers that had no callers yet, `--gc-sections` stripped every
byte of them, and the size did not move — but the hash did, over a **~4500-byte internal
relocation**. Established rather than assumed: `nm` on both ELFs, a string search of both images,
and a `size -A` section diff **all three agreed no new content survived**. The relocation is
attributable to link-order churn from the extra discarded input sections — that mechanism is
**reasoned, not proven**. It looks alarming, `board-baseline.mjs` is right to report it, and it is
not evidence of anything being emitted.

**THE PER-TASK COST DELTAS SUM IN BYTES AND DO NOT ATTRIBUTE, WHICH IS A DIFFERENT AND MORE
MISLEADING FAILURE THAN NOT SUMMING.** Everything Tasks 6, 7 and 8 added was UNREACHABLE when
those tasks were measured — both card renderers had no callers, so the estimators, both cards, the
sparkline and their caches were stripped — so their recorded `.bin` size did not move across any
of the three (one contemporaneous per-task record says +4 for Task 8; the baseline file says +0 —
**the cause is now known rather than left as a curiosity**: board 2's `.bin` was byte-size
**identical, 1023328, across all four consecutive commits**, since Tasks 6–8's code was genuinely
uncalled and `--gc-sections` stripped every byte of it, so those four images differ only by the
internal link-order relocation the paragraph above already establishes. The "+4" was never a
`.bin` measurement at all — it was a `Sketch uses` figure, and a `.bin`-vs-`Sketch uses` offset
spread of **266–270 bytes** measured across the same commits is a ±4-byte window on its own,
which is exactly the "+4" — so the two records were never actually in conflict, only reading two
different quantities as if they were one. This also explains why `fc0f8d1`'s recorded masked hash
equals `d1ad605`'s: a RETURN to a previously-seen link order, not a stale unreached record — their
`updated` timestamps differ, so each was genuinely re-measured rather than copied forward) and
Task 9, which wires the renderers in, absorbs the lot at once (+2256). Tasks 1 and 2 are the
exception and DO stand alone: shared-code fixes in already-reachable code. **So the only
meaningful figure is branch-point-to-HEAD**, and a reader who takes the intermediate numbers as a
breakdown of where the cost lives will conclude that a sparkline and two estimators are free.

**COSTS, MEASURED BY BUILDING THE MERGE-BASE IN A WORKTREE, BOTH ENDS IN ONE SESSION.**
`arduino-cli` keys its build cache on the sketch PATH, so rebuilding the old commit in place would
have evicted the objects the current baseline was taken from. Figures are `Sketch uses` /
`Global variables`:

| | branch point `67c71a2` | HEAD | delta |
|---|---|---|---|
| board 2 | 1022962 / 66228 | 1025318 / 66436 | **+2356 flash, +208 RAM** |
| board 1 | 1386950 / 69804 | 1386758 / 69804 | **-192 flash, 0 RAM** |

**Board 1 got 192 bytes SMALLER**, all of it Task 1's — dropping the wall-clock suffix from the
Codex row's right field. Task 2 moved it at **+0 bytes with the hash differing**, the case above.

**BUILDING BOTH ENDS IN ONE SESSION IS NOT A CONVENIENCE, AND THIS BRANCH MEASURED EXACTLY WHY.**
The branch point's recorded baselines are `pooled: true` and every baseline from Task 1 onward is
`pooled: false`, so the *recorded* arithmetic spans a pooling flip and is wrong by 16 bytes on
both boards: recorded board 2 would read +2368 against the true +2352, and board 1 -176 against
the true -192. Same-session builds share one pooling state and need no correction at all. It also
**confirms the 16-byte figure to the byte**: the branch point is recorded at 1387200 pooled, and
today's un-pooled build of that same commit is **1387216**. Once corrected, the per-commit
recorded sizes sum exactly to the measured total (`-208 +0 +304 +0 +0 +0 +2256 +0 = +2352` on
board 2) — which validates the measurement and still does not fix the attribution above.

**BOARD 1 IS `UNCHANGED` AT EVERY COMMIT FROM TASK 2 ONWARD** — `8f64b7f7...`, `.bin` size
1387024 — verified with `board-baseline.mjs --check 1`. Eight consecutive tasks carried that one
baseline untouched, which is the only reason the scoping is what it is: every shared-code change
after Task 2 is an `#if BOARD_USAGE_V2` around text board 1 never sees.

**THE SWEEP: `SLICES` 4 → 8, AND IT FAILED IN EXACTLY THE WAY ITS OWN HEADER PREDICTS.** At 4,
three of the four `sessions`/board-2 children OOM'd on a REGEXP CODE OBJECT at ~1070MB;
`geom-sweep.mjs` printed `3 checker sweep(s) hit an INTERNAL ERROR` and exited 1 — **loud about
the failure and quiet about the cost**, which was that the one surviving slice's 94 constants were
all that reached the union, so every `SESSION_*`/`DETAIL_*`/`ASK_*` constant appeared under "read
by no checker". That is the documented shape, one branch later, and it is why the exit code is not
the thing to read: **the UNGUARDED list is.** Board 2 parses 376 constants against board 1's 237,
so a quarter-slice there is ~94 constants and an unguarded one costs all six magnitudes; 8 puts it
back to ~47. Raising `SLICES` recovered **67 constants of coverage** (board 2 went 116/376
unguarded to 49/376). **Raise `SLICES`, never the heap** — the limit is V8's CODE space and
`--max-old-space-size` provably does nothing. Timed today, nothing else running:
**2:18.99 broken (exit 1), then 1:58.41 and 1:57.74 fixed** — so the extra children cost nothing
and in fact SAVE time, because the four that were dying spent most of that run climbing to 1GB
before they did. The ~110s figure this file already records is right; a wildly different number is
a question about the machine before it is a question about the sweep.

**EVERY GEOMETRIC CONSTANT THE BRANCH ADDED IS NOW CAUGHT AT ±1 IN BOTH DIRECTIONS, AND THE
MECHANISM THAT GOT THEM THERE IS THE OPPOSITE OF THE PAIRING PANEL'S.** Sixteen of them started
short of that standard — five caught only at ±4, six only at ±16, and five in ONE DIRECTION
ONLY at any magnitude — for a structural reason rather than an oversight: the
disjointness loop asks `gap >= 0` and every real gap on these cards is 4 rows (NOW) or 3 (WEEK),
so a single offset can move up to four rows either way and stay disjoint. **And no CUMULATIVE
assertion can see it either** — moving one band down a row enlarges the gap above it and shrinks
the gap below it, leaving the total, the last band's end and the ceiling clearance all unchanged.
A per-gap bound is the only instrument that can, and a per-gap bound needs an expected value.
- **The expected value is the card's own RHYTHM.** Both cards were laid out on a uniform gap — the
  band tables in the spec and in the board header each print it — so a rhythm broken at exactly
  one boundary IS the signature of an offset that moved. It is a bound on the CARD rather than on
  any one constant, which is what makes it able to fail.
- **DELIBERATELY NOT SOLVED BY NAMING THE AIR IN THE HEADER, which is the shape the
  wireless-pairing panel used.** Deriving each offset as `prev + cell + AIR` makes them a CHAIN OF
  RELATIVE IDENTITIES, and the sweep injects at PARSE time: perturb one term and every offset
  below follows, so every identity still holds and the sweep goes blind — the exact failure this
  file records for the pairing panel's five air constants, all of which were unguarded at ±16
  under assertions written for them. **Independent literals in the header plus a rhythm assertion
  in the checker is strictly better**, because the perturbation cannot propagate into the
  checker's own expectation. The cost, stated rather than discovered later: a future change to
  either card's spacing has to change it at EVERY boundary, or say at the assertion why one
  boundary differs.
- **Two constants are invisible to any band assertion and needed their own bind, each for its own
  reason.** `NOW_SIDE_Y` positions the two-fact block inside the hero band, where the
  inside-the-band test has 12–13 rows of slack at each end — pinned by asserting the block is
  centred, with the odd surplus's extra row going ABOVE (which is what the shipped 13/12 split
  is). And `WEEK_BURN_Y` shares ONE band with the number beside it, by construction: at meta 16
  inside head 24 its clear box is strictly inside the number's, so `min()` and `max()` both come
  from `WEEK_NUM_Y` and the burn line can move several rows without changing the band at all. It
  is pinned by what it is FOR — a caption optically centred on the number, `(head - meta) / 2`,
  with both cells PARSED from `UI_FONTS[]`.
- **The side lane had NO assertion that it holds its own worst-case content**, which is the Task-1
  Codex bug arriving on the other card: `padLeftTo()` pads UP to `SIDE_CHARS` and never truncates,
  so if the worst case exceeds it, `drawIfChanged` clears for the NEW string's width and a long
  value followed by a short one leaves the long one's left tail on the card forever. The worst
  case is **derived from the clamp** — `usageBurnMinutes()` caps at `BURN_MAX_LEFT_MIN` (143940 =
  99d 23h) precisely so one string is the ceiling, so the widest label is that cap rendered
  through the same branch: `"empty ~99d 23h"`, 14 characters against `SIDE_CHARS` 15.
- **`CODEX_RIGHT_CHARS` was `<=` its worst case and the sweep said so** — caught at `|1|` in the +
  direction and NOT AT ALL in the −. Both sides are real and they are different bugs: too large
  and `padLeftTo()` pads past what the lane assumes (the Task-1 bug returning through the pad
  width); too small and it **stops blanking this field's own widest value**, which is padding's
  only job. The two bounds meet, so the pad width IS the worst case, and it is one equality now.
- **`CARD_HERO_W` and `SIDE_X0` remain `|16|`, in both directions, and that is their real
  headroom rather than a gap.** The side lane is DERIVED from the hero's width, so the two move
  together and no perturbation can make them collide — a wider hero simply narrows the lane, and
  the only thing that eventually breaks is the character budget (at +16, `SIDE_CHARS` falls to 13
  against a 14-character worst case). Below, the hero box has 4px of genuine slack over `"100%"`'s
  128px ink. Manufacturing a ±1 catch here would mean inventing a constraint, which is the thing
  this file's "a bound taken from the geometry rather than fitted to today's 26" rule forbids.
- **The remaining three are NOT geometric and are bound elsewhere.** `USAGE_RING_SLOTS`,
  `USAGE_RING_STEP_MIN` and `QUOTA_STALE_SEC` are read by `usage-geom-check.mjs` and reported
  unguarded, correctly: the sparkline derives its column width as `w / USAGE_RING_SLOTS`, so ANY
  slot count fits the lane and there is no geometric bound to violate (the one real bound,
  `w / SLOTS >= 2`, does not trip until 130); the other two measure TIME. `USAGE_RING_DROP_PCT`
  and the seven `BURN_*` constants are read by no layout checker at all, also correctly.
  **`usage-trend-check.py` binds all of them** — 55 assertions, 47 mirror + 8 structural, and `--selftest` re-runs mirror 4's scenario through the permanent `level_bug` variant, exiting 0 only when the checker's own `reset_calls == 1` assertion fails under it (it used to silently accept the flag and report the normal clean pass instead).
- **A comment can create a phantom gap.** The sweep decides whether a checker READS a constant
  with a regex over that checker's own text, so naming a constant in a COMMENT reports it as
  read-but-unguarded. Measured: the first draft of the rhythm note above named the pairing panel's
  air constants and put one into the sweep's findings.

**Assertion counts, so nobody transcribes them: run the checkers.** For the record of how they
grew, `usage-geom-check.mjs` went **119 → 140 → 149 → 178 → 210 → 217 → 226** across the ten
tasks, and `usage-trend-check.py` **4 → 52 → 50 → 51 → 55**. The 52 → 50 drop is not lost
coverage: the old regex ran over the comment-INCLUDED body and matched the quoted fragments `"~"`
and `"<"` out of a comment as if they were code literals. Untouched neighbours today:
`sessions-geom-check.mjs` 1449, `settings-geom-check.mjs` 617, the mock 582.

**WHAT IS NOT VERIFIED, STATED PLAINLY.**
- **NOTHING IN THIS BRANCH HAS BEEN ON THE GLASS.** No device was attached for any of the ten
  tasks. The evidence is the four checkers, the sweep, the committed mock and both board
  baselines — all of it arithmetic and bitmaps, which is the right instrument for layout and the
  wrong one for everything else.
- **NO CLAIM HERE COVERS COLOUR, and `SCREENSHOT` could not settle it even with a device
  attached**, because on board 2 it reads the shadow framebuffer (see the verification trap under
  Two boards). `COLORTEST` is the instrument and a person is the authority. That matters more than
  usual on this tab: the hero, both bars and the sparkline all take a `colorForPct` band and a
  stale-dim, and the three cache hazards above exist entirely to keep those hues correct.
- **THE SPARKLINE HAS NEVER BEEN READ BY A HUMAN AT 320x480.** Whether 31 caps-plus-connectors in
  a 260x32 box read as a trend or as texture is a judgement no assertion makes. Two cosmetics are
  known and unfixed: the last cap overdraws the baseline at v=0, and a full ring inks 246 of the
  260px lane while the baseline spans all 260, so 13px of rule trails past the final cap.
- **THE RING'S BEHAVIOUR ACROSS A REAL WINDOW RESET IS UNTESTED, because observing it once costs
  five hours of wall clock.** `USAGE_RING_DROP_PCT`'s derivation and the staleness-edge rule are
  argued and unit-checked, not watched. The same applies to the WEEK card's burn line, which by
  its own arithmetic first appears about five hours after a 7-day reset.
- **EVERY TOUCH PATH ON THE TAB IS UNEXERCISED**, since the device deliberately has no remote tap.
- **`spark1Cache = 0` is both its initializer and its bust sentinel**, so a ring signature that
  hashes to 0 skips exactly one repaint (p ≈ 2⁻³² per ring state) and self-heals at the next ring
  step. Known, measured in probability rather than observed, and not worth changing.

**DEFERRED MINORS, NAMED RATHER THAN FIXED**, so the next reader can trust the list to be
outstanding — the standard the board-2 outstanding-items list already sets. (1)
`usage-geom-check.mjs`'s `labelPaddedW` comment is BACKWARDS on board 1: it says a space string
measures under the naive count, but Cozette charges a trailing space `xOffset + width` = 7, so 13
spaces is 79px not 78 — and **board 1 passes that assertion at exactly zero margin**, on the side
the comment calls conservative. Pre-existing, and it needs its own look precisely because it sits
beside a zero-margin assertion. (2) `sessions-geom-check.mjs` still carries a local `strip` lambda
behaviourally identical to the `stripComments` it now imports — the second-copy-is-a-second-thing
-to-drift pattern the promotion existed to close. (3) `MAC_EMOJI_SIZE` is read by a bespoke regex
rather than through `geom-common`'s `ART_HEADERS` list. (4) The NOW/WEEK band assertions do not
parse the meta field's FONT ID: both cells are 16 on board 2 so the numbers are right today, but
change that field to `T_HEAD` (24) and the clear would run through the border with the band
assertion still green. (5) The disjoint-bands loop's first disjunct is a vacuous escape hatch —
it passes unconditionally for a degenerate `start > end` band. (6) `right1Cache` now holds the
meta LEFT field and `resetAt1Cache` the meta RIGHT — inherited v1 names whose meaning is inverted
in v2; board 1 shares the declarations, so renaming is not free. (7) The two sparkline cosmetics
above. (8) The mock's BEFORE panel binds five now-dead board-2 constants (`CARD_H`,
`CARD_HERO_Y`, `CARD_BAR_Y`, `CARD_STATS_Y`, `CARD_FOOT_Y`, no live board-2 readers); the bind
**cannot** be removed while the header declares them, because the mock's rule requires
`WAS.X !== K.X` while `K.X` must equal the header — the bind is the SAFE direction, and a comment
on `K` naming which entries are v1-only is the honest record. (9) `spark1Cache`'s sentinel, above.
(10) `cxStale = usage.cxAgeSec > 900` still uses a bare literal at two sites. **Do NOT "fix" that
by reusing `QUOTA_STALE_SEC`** — Codex's staleness is semantically independent, and this file
already records that hanging the Codex row's dimming off the Claude quota's age was wrong in both
directions. The correct fix is a separate `CX_STALE_SEC`, which is pre-existing scope rather than
this branch's.

#### USAGE on board 2: the column adapts to whether Codex is even here

**THE PREDICATE, AND ITS THRESHOLD IS DATA-DRIVEN RATHER THAN A LITERAL.** `usageCodexShown()`
(`usage.ino`) is the one thing every layout accessor, `renderUsageTab()` and `drawUsageStatic()`
ask — never re-derived, for the same reason the pairing panel's `pairConfirmable()` is one
predicate read by both the draw site and the hit test: two spellings of "is Codex here" is how a
tab comes to paint one column while its chrome believes it is the other.
```
if (usage.cxPct < 0) return false;       // never measured
if (usage.cxAgeSec < 0) return false;    // ditto, by the age's own sentinel
long win = usage.cxWindowMin > 0 ? usage.cxWindowMin : CODEX_HIDE_FALLBACK_MIN;
return usage.cxAgeSec <= win * 60;
```
The window rides the wire as `cxWin` (`host/index.mjs` sends `primary?.windowMin ?? null`) and is
stored as `usage.cxWindowMin`, so the real threshold is **one full quota window of silence** and
moves with whatever plan the paired account is on — the host polled roughly 120,000 times over
that window and learned nothing, which is a stronger claim than "old". `CODEX_HIDE_FALLBACK_MIN`
(10,080 minutes = 7 days, the observed Codex window) is only the fallback for a percentage that
arrives with no window beside it, because a percentage and its window can arrive apart and
trusting an absent window as `0` would hide the row the instant it was first measured.
**Deliberately NOT keyed on `QUOTA_STALE_SEC` (900s).** That threshold already dims a Claude card
in place — its claim is "we cannot vouch for this number right now". A full window of silence is a
different and stronger claim — "nobody is running the tool at all" — and it earns removing the row
rather than dimming it.

**THE ASYMMETRY: CLAUDE NEVER HIDES, BECAUSE ITS QUOTA IS ACCOUNT-LEVEL AND ARRIVES EVEN AT 0%.**
There is no Claude-side predicate and none is planned — the OAuth usage endpoint is polled every
five minutes regardless of whether anyone is typing, so a reading always arrives, all the way down
to a legitimately exhausted `0%`. Days of silence there is not "nobody is using Claude"; it is an
**expired OAuth refresh token or a poller stuck in back-off** — a fault this file already spends a
long section on (`getFreshAccessToken()`, the 429/401 guards) — and a card that quietly disappeared
would bury exactly the failure this repo's stale-dimming exists to surface. So a stale Claude
reading stays on screen, dimmed and labelled `stale`, while a stale-past-a-window Codex reading is
removed outright: the two sources fail differently, so they are handled differently on purpose,
not by oversight.

**THE RHYTHM CONSTRAINT, AND WHY THE TWO CARDS SPENT THEIR RECLAIMED ROWS DIFFERENTLY.** Hiding
the Codex row frees 64 rows (`CODEX_H(56) + SP_2(8)` — the row plus the one gap that closes with
it; `8 + 56 + 8` is 72 and was never the figure, a slip this file is correcting in itself), and the
two cards split them 32/32 — but
*where* each 32 landed follows from what each card actually has to grow.
- **NOW put its whole share into the SPARKLINE BAND.** `NOW_SPARK_H` 32 → `NOW_SPARK_H_SOLO` 64,
  and nothing else in that card's rhythm moves: the gap between blocks (4) and the trailing
  clearance under the last one (5) are the same **identical** numbers in both layouts, so only two
  offsets — the spark's height and everything below it — actually shift. `drawUsageSpark` scales
  its plot to whatever height it is handed, so doubling the band takes the fixed 0..100 scale from
  3.70 to 1.69 percentage points per pixel — a genuinely more legible trend, not merely a bigger box.
- **WEEK re-pitched its uniform GAP instead, because it has no band that should grow.** A WEEK
  sparkline would be a flat line pretending to be a trend — the ring moves **1.49 points** across
  the whole 7-day window, inside integer rounding — so there is nothing on that card worth spending
  pixels to enlarge. Its 32 rows went into the one number that already touches every block on the
  card: the uniform gap between them, 3 → 8. (`WEEK_CARD_H_SOLO`'s minimum for a gap `k` is
  `126 + 6k`, which is 174 at `k = 8`; the column needs 176, so the card is one row wider than the
  minimum and the trailing clearance below the last block comes out at 10 against the 8-row rhythm
  everywhere else on the card.)
  All ten `_SOLO` offsets are **independent literals in the board header, not `prev + cell + AIR`
  chains** — deliberately, because `geom-sweep.mjs` injects at parse time and a chain of relative
  identities lets a perturbation propagate into every offset below it, leaving every identity still
  holding (the exact failure the wireless-pairing panel's five air constants shipped with, and
  fixed here before it shipped rather than after). `usage-geom-check.mjs`'s rhythm assertion is
  what actually binds them, and this task's own sweep confirms it: all ten are caught at `|1|` in
  both directions.

**THE LAYOUT-FLIP CONTENT-AREA CLEAR, AND WHY A CHROME REPAINT ALONE IS NOT ENOUGH.** Every other
chrome bust in this tab repaints the boxes and lets the change-only fields redraw inside them — but
flipping `usageCodexShown()` moves the card BORDERS themselves. NOW grows past where WEEK used to
start (the duo layout's `CARD2_Y` is 244; the solo layout's WEEK card starts at 276), so a bare
`drawUsageStatic()` would leave rows in the old WEEK card's former top strip carrying the old
card's pixels while every field draws at its new offset inside a box that is no longer there —
the settings redesign's "a live field drew a control into chrome that did not exist" arriving
through geometry instead of a session count. `renderUsageTab()`'s bust block therefore does a full
`fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG)` on the one tick the
flag actually flips (`codexShownCache != codexShownNow && codexShownCache != -1`, so the very first
draw of the tab does not pay for a clear nothing needs), and only then calls `drawUsageStatic()`.

**COSTS, MEASURED IN ONE SESSION AGAINST THE BRANCH POINT — and that claim was FALSE the first
time this table was written, which the final whole-plan review caught.** The first version cited
`arduino-cli`'s sketch-path cache keying as if it meant "this compares real builds", when the
figures actually came from `board-baseline.json` at three different commits (807a080, 0ee4eaf,
db44586), captured across separate task dispatches on different days — recorded figures from
different sessions, the exact thing this file elsewhere warns cannot be safely diffed
("BUILDING BOTH ENDS IN ONE SESSION IS NOT A CONVENIENCE"). Only HEAD had been freshly built. The
method is now real: the branch point (`807a080`) was checked out into a **`git worktree` at a
scratch path** — never in place, since `arduino-cli` keys its build cache on the sketch PATH and an
in-place rebuild would have evicted the objects the current baseline was just taken from — and
compiled back-to-back with HEAD in one sitting, both reporting `core stamp not pooled`:

| | branch point (`807a080`, worktree build) | HEAD (Task 5) | delta |
|---|---|---|---|
| board 2 `.bin` | 1,025,888 (`2b0409ed...`) | 1,026,320 (`3b1afb17...`) | **+432 bytes**, RAM unchanged (74,116 throughout) |
| board 2 `Sketch uses` | 1,025,626 | 1,026,062 | +436 (the few-byte `.bin`-vs-`Sketch-uses` spread this file already documents) |
| board 1 | 1,387,024 (`8f64b7f7...`) | 1,387,024 (`8f64b7f7...`) | **UNCHANGED** |

**The real, same-session build reproduces the original figures exactly** — +432 `.bin`, +436
`Sketch uses`, RAM unchanged — so the numbers were never wrong, only the method claimed to have
produced them. The branch-point rebuild's hash (`2b0409ed...`) is also byte-for-byte the hash
`807a080`'s own baseline entry recorded at the time, which is further evidence today's rebuild
lands in the same place the original session did.

Almost all of it is Task 3 wiring the predicate into reachable code (**+448** measured there, the
first task on this branch whose diff was not stripped by `--gc-sections`); Task 1's predicate
function alone moved the recorded `.bin` by **-16** while unreachable.
**That -16 is a stale cross-session baseline, not emitted code caused by the change at all — and
it is NOT the same class as USAGE v2's own Tasks 6-8, which this table previously (and wrongly)
called it.** Tasks 6-8 were a real ~4,500-byte internal RELOCATION *caused by* code those tasks
added, later confirmed unreachable and stripped. Task 1's predicate is the opposite: commit
0ee4eaf's own message records that two independent board-2 compiles — one **with** the new
predicate, one **without** it — produced the identical -16/-12 delta and the identical masked hash
against the then-current baseline. A delta that reproduces on the UNCHANGED tree cannot have been
caused by the change; it is the recorded baseline itself sitting one build-session's worth of
core-cache/link-order drift away from a fresh compile, the same phenomenon this file's pooling
notes describe at a different timescale. Tasks 2 and 4 added no board-2 firmware bytes at all (a
committed mock plus checker-only changes). Board 1 is `UNCHANGED` at every commit on this branch:
the whole feature sits behind `#if BOARD_USAGE_V2` and `usageCodexShown()`'s own call sites, none
of which board 1 compiles.

**WHAT IS NOT VERIFIED, STATED PLAINLY.**
- **The DUO layout is now unreachable on THIS machine, so the two layouts are verified at
  different times by different means rather than both by one run.** `usage.cxPct` has been `-1`
  here since before this branch existed — Codex has never reported to this host, every line of the
  log reads `codex=?` — so the device enters the solo column the instant it boots and stays there.
  The solo column is the one this task put on the glass (`SCREENSHOT`, both card borders measured
  off the PNG at exactly the predicted rows). The duo column is verified only by the geometry
  checkers and the fault-injection sweep, never by a device that has actually shown it since this
  branch began.
- **The threshold's own EDGE takes seven days of wall clock to observe, and is unit-checked and
  argued rather than watched.** Nothing here has run a Codex reading forward from fresh to exactly
  one window stale and watched the row disappear on the glass; `usage-geom-check.mjs`'s bind on
  `usageCodexShown()`'s own body is a structural proof that the right comparison is being made, not
  a timed observation of it firing.
- **No claim in this section covers colour.** Step 5's confirmation that the WEEK card's top border
  sits at `y = 276` and its bottom at `y = 451` is **framebuffer evidence** — board 2's
  `SCREENSHOT` reads the shadow framebuffer the renderer just composed, not the panel (see the
  verification trap under Two boards) — so it vouches for the GEOMETRY this task built and says
  nothing about how any of it actually looks on the glass.
