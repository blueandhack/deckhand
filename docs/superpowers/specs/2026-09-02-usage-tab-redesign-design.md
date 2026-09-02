# USAGE tab redesign — design spec

**Status:** design agreed, not built. Board 2 only; board 1 stays byte-identical through the
redesign itself and is moved deliberately, in its own commits, by the two shared-code bug fixes at
the end.

**The mock is the geometric spec.** Every number below came out of it and it re-runs:
<https://claude.ai/code/artifact/5bb496ce-2107-4af5-9252-08f768917b6e>. Committing it into
`docs/design/usage-redesign/` — with a `check.mjs` that binds its constants to
`board_es3c35p.h` the way the settings mock's does — is task 1 of the plan, for the reason
`docs/design/settings-redesign/README.md` already gives: it is the only place the redesign's
numbers exist in a form anyone can re-run.

## The problem

The tab spends **328 of its 414 content rows** on two structurally identical 164px cards carrying
one percentage each, then gives Codex a 56px line. Four complaints, all of which the user
confirmed:

- **Density.** Two cards, same six fields twice, for two numbers.
- **Hierarchy.** Three boxes of equal visual weight, read top to bottom. A repeated template, not
  a composed screen.
- **Glanceability.** Both heroes are the same 64px in the same place at the same weight, so
  nothing says which one to look at.
- **Known defects.** Fable — the *scarcer* cap — is an 8px crumb in a shared foot row with no
  bar; the Codex label lane is bounded at 12 characters and loses text; the pin bar drew the
  literal question *"why is there a red underline?"* from a user.

And the space is not merely unused. **`drawBigNumber` clears the box it is handed, and it is
handed the whole 260px lane** while `"100%"` inks 128. The 132px beside every hero is *erased on
every repaint*.

## What ships: NOW / WEEK / CODEX

A **semantic** hierarchy rather than a repeated template. The 5-hour window is the one that
actually stops you working; the 7-day window is slow background. So the 5-hour card alone keeps
the 64px hero and gains a trend sparkline, and the week collapses to a 24px number — carrying
Fable as a real second bar **in the same card**, because Fable *is* the same 7-day window rather
than a separate thing.

Guarded by **`BOARD_USAGE_V2`**: 1 in `board_es3c35p.h`, 0 in `board_e32r28t.h`, where it is one
line that emits no code — exactly the shape `BOARD_HAS_WIRELESS_PAIR` already has.

### The column

```
8 + 182 + 8 + 144 + 8 + 56 + 8 = 414
```

`CONTENT_Y`(46) → NOW 54..235 → WEEK 244..387 → CODEX 396..451, with 8px of air to
`contentBottom()` 460. Uniform 8px gaps, and the column never ends flush on the footer.

**414, not 416.** The current header derives the column as `8+164+8+164+8+56+8 = 416` with 8px of
air. `FOOTER_H` moved 18 → 20, so `contentBottom()` is 460 and the truth is **414 with 6px**. See
*Findings* below.

### NOW — 5 HOUR WINDOW, h = 182

Bands are **cleared extents**, not glyph ink — `drawIfChanged` clears `(fx-1, fy-1, tw+2, th+2)`
and `drawPaceBar` clears `(x-1, y-4, w+2, h+8)` for its tick overhang. The 2px border owns
`+180..+181`, so nothing may end past **+179**.

```
  +0..+1     border
  +3..+5     pin bar         CARD_PIN_BAR_Y 3
  +6..+21    label + icon    CARD_LABEL_Y 6, T_META (Spleen8x16)
  +26..+90   hero box        NOW_HERO_Y 26, CARD_HERO_H 65, CARD_HERO_W 132
  +39..+56   side fact 1     T_META, TR at LANE_X1 — the burn verdict
  +61..+78   side fact 2     T_META, TR at LANE_X1 — the reset countdown
  +95..+114  pace bar clear  NOW_BAR_Y 99, BAR_H 12
  +119..+152 spark clear     NOW_SPARK_Y 120, NOW_SPARK_H 32
  +157..+174 meta clear      NOW_META_Y 158 — tokens left, "LAST 2.5H" right
  +180..+181 border          ceiling +179, last clear +174, 5 rows clear
```

The two side facts share the hero's vertical band and sit **beside** it: the hero box is
`LANE_X0..LANE_X0+131` = 30..161 and the side lane is `SIDE_X0`(170)..`LANE_X1`(290) = **120px =
15 characters**. That is the reclaimed space, and it exists only because the hero's clear box
stopped being the full lane.

**`CARD_HERO_W` is a new named constant and it is load-bearing.** `"100%"` at Spleen32x64 inks
128px, so 132 is the glyph plus 4px of slack — the same plus-slack convention `CARD_HERO_H` (65
for a 64px glyph) already uses. Without it the hero erases both side facts on every value change.

### WEEK — 7 DAY, ALL MODELS, h = 144

Secondary, so a `T_HEAD` (12x24) number rather than a 64px hero. That contrast **is** the
hierarchy. Border owns `+142..+143`; ceiling **+141**.

```
  +0..+1     border
  +3..+5     pin bar
  +6..+21    label + icon
  +25..+50   number clear    WEEK_NUM_Y 26, T_HEAD (Spleen12x24)
  +29..+46   burn line       T_META, TR at LANE_X1
  +54..+73   ALL bar clear   WEEK_BAR_Y 58
  +77..+94   meta clear      WEEK_META_Y 78 — tokens left, reset countdown right
  +98..+115  Fable line      WEEK_FABLE_Y 99 — "FABLE  61%" left, tokens right
  +119..+138 Fable bar clear WEEK_FABLE_BAR_Y 123
  +142..+143 border          ceiling +141, last clear +138, 3 rows clear
```

Fable gets a labelled bar of its own, in the card whose window it shares. Its tick is the 7-day
tick, because it is the same window.

### CODEX — 7 DAY WINDOW, h = 56

Structure unchanged from today. The only change is the **right field's content**, and it is what
fixes the label lane:

```
  +0..+1     border
  +7..+24    text clear      CODEX_TEXT_Y 8 — label left, number right, both T_BODY
  +33..+52   bar clear       CODEX_BAR_Y 37
  +54..+55   border          ceiling +53
```

Dropping the wall-clock suffix — the countdown beside it already says the same thing in relative
terms — takes the right field's worst case from **25 characters to 18**. The label lane is bounded
by that field's clear box, so the ceiling rises with no change to the label at all:

| | today | after |
|---|---|---|
| right field, ordinary | 22 chars → lane **10** | 15 chars → lane **17** |
| right field, worst case | 25 chars → lane **7** | 18 chars → lane **14** |

`"CODEX  7d"` needs 9. It fits after; it does **not** fit in the worst case today.

## New constants

All in `board_es3c35p.h` except the ring's own, which belong beside the ring in `usage.ino` the
way `BATT_TREND_*` sit beside theirs in `power.ino`. Every one must be caught by
`geom-sweep.mjs` at ±1, except the three that measure time or a rate rather than pixels — the
same exemption the `PAIR_*_MS` durations already carry, and for the same reason.

| constant | value | what it is |
|---|---|---|
| `BOARD_USAGE_V2` | 1 / **0** | the guard; one line on board 1, emits no code |
| `CARD_HERO_W` | 132 | the hero's clear box — 128px of `"100%"` plus 4 slack |
| `NOW_HERO_Y` / `NOW_BAR_Y` | 26 / 99 | NOW card bands |
| `NOW_SPARK_Y` / `NOW_SPARK_H` | 120 / 32 | the sparkline's box |
| `NOW_META_Y` | 158 | tokens + spark caption |
| `WEEK_NUM_Y` / `WEEK_BAR_Y` | 26 / 58 | WEEK card bands |
| `WEEK_META_Y` | 78 | tokens + reset countdown |
| `WEEK_FABLE_Y` / `WEEK_FABLE_BAR_Y` | 99 / 123 | Fable's line and its bar |
| `SIDE_X0` | 170 | `LANE_X0 + CARD_HERO_W + 8`; derived, not transcribed |
| `USAGE_RING_SLOTS` | 31 | ring depth — 31, so the span is exactly 150 min |
| `USAGE_RING_STEP_MIN` | 5 | sample cadence — the OAuth poll interval, not 1/min |
| `BURN_MIN_PCT` / `BURN_MAX_PCT` | 3 / 97 | **derived** from a 20% quantization budget |
| `BURN_MIN_ELAPSED` | 30 min | **judgement**, stated as one |
| `BURN_RING_MIN_SPAN` | 30 min | ring must span this before it speaks |
| `BURN_RING_MIN_RISE` | 3 points | and must have moved this far |
| `BURN_RING_MAX_WIN` | 2880 min | above this the ring is blind; use the average |

**31 slots, not 30, and the reason is the caption.** The span is `(n - 1) * step`, so 30 slots
span 145 minutes — and a card captioned `LAST 2.5H` over a 145-minute ring overstates it by five
minutes. 31 slots span exactly 150. Every figure below is derived from
`(USAGE_RING_SLOTS - 1) * USAGE_RING_STEP_MIN`; the code must compute it rather than carry a
literal 150, so changing either constant moves the crossover and the caption with it.

## The trend ring

One ring, modelled on `battTrend*` in `power.ino` (30 slots, `int mv[]` + `unsigned long at[]`,
count/head/last, with reset rules and a span gate) — and covered by the same kind of arithmetic
test `batt-trend-check.py` already is.

**It samples at the OAuth *poll* cadence, not once a minute, and that is the whole reason the
sparkline is worth having.** The quota only *moves* every `OAUTH_POLL_INTERVAL_MS` (5 min), so a
1-per-minute ring holds five identical samples then a step — about six distinct values in half an
hour. At the poll cadence the same 30 slots span **150 minutes**, so the spark shows 2.5 hours of
real movement and its caption reads `LAST 2.5H`.

**Only one ring is needed**, for the 5-hour series. The week's burn uses no history (see below)
and the spark is on the NOW card only. Cost is therefore about **165 bytes of DRAM**
(`uint8_t pct[31]` + `unsigned long at[31]` + count/head/last), against the ~26KB the audio path
competes for — small, and to be measured rather than trusted.

**Scale is 0–100**, so the spark agrees with the pace bar directly above it. Auto-scaling to the
series' own min and max was rejected: it reads better and lies by omission, because a quota
sitting still with integer-percent noise would draw a dramatic mountain.

## Burn rate: two estimators, chosen by window length

`"61%, empty in ~1d 1h"` answers the question a percentage only implies. Which estimator can
answer it is decided by arithmetic, not preference.

**Movement across the ring, at a linear burn:**

| window | span | movement |
|---|---|---|
| 5h session, 300 min | 150 min | **50.00 points** |
| 7d week, 10080 min | 150 min | **1.49 points** |

The percentage is an **integer**, so the week's movement is inside the rounding. **The ring cannot
measure the weekly window.** So:

- **Short window → ring slope.** Least squares over the ring, the shape `battMinutesLeft` already
  has. It sees a burst in the last ten minutes, which an average cannot. Usable while
  `100 * span / window >= BURN_RING_MIN_RISE`, i.e. `window <= 5000 min = 3.47 days`;
  **`BURN_RING_MAX_WIN` is 2880 (2 days)** for margin.
- **Long window → window average**, `pct / elapsed`. Accurate *because* elapsed is huge: at 61%
  with 2400 minutes elapsed, quantization costs 0.8%.

Least squares over the whole ring, never endpoint-to-endpoint — the same reason `battMinutesLeft`
gives.

### The gate: one number derived, one admitted as judgement

`T = elapsed * (100 - pct) / pct`, so `dT/dpct = -100 * elapsed / pct²` and half a point of
quantization costs a **relative** error of `50 / (pct * (100 - pct))` — **independent of
elapsed**. A 20% error budget therefore admits `pct` in **3..97** and refuses below 3:

| pct | 1 | 2 | **3** | 5 | 10 | 50 | 90 | **97** |
|---|---|---|---|---|---|---|---|---|
| error | 50.5% | 25.5% | **17.2%** | 10.5% | 5.6% | 2.0% | 5.6% | **17.2%** |

So `BURN_MIN_PCT` 3 and `BURN_MAX_PCT` 97 are derived. Above 97 the answer is `empty now`.

**`BURN_MIN_ELAPSED` (30 min) is NOT derived and must not be presented as though it were.** It
guards the constant-rate assumption right after a window resets, when one burst dominates the
average, and no single sample can bound that error. It is a judgement, stated as one — the same
honesty `SESSION_PULSE_MS` is recorded with.

**A stale reading drives no estimate.** Past `quotaAgeSec > 900` the clock has kept running while
the number has not, so any slope through it measures the gap rather than the burn. The figure
reads `burn --` and the spark dims with the rest of the card.

**Notation matters and it is already established here.** `~` means *about*; `>=` means *at least*.
The burn figure is an estimate of a measured rate, so it takes `~`. It must never be written `>=`,
which is reserved for the charge estimator's deliberate floor.

## Change-only redraw: what must be busted

The discipline this file is built on assumes a field's pixels are stale only when its own value
changed. Three new things break that assumption if left alone:

- **The spark needs a content key**, or it repaints a 260x32 region every 5s — which on this board
  is not "some SPI writes" but a real slice of a 30ms flush. Key it on an **FNV-1a 32-bit hash of
  the ring's samples**, the same device `buildDetailSignature` already uses for `optDescs`, and
  for the same reason: it is compared against the ONE previous value rather than a population, so
  the risk is 2⁻³² per event and not a birthday problem.
- **The stale flip must bust the new fields too** — the two burn texts, the spark and the Fable
  bar — exactly as `renderUsageTab` already busts `pct1Cache`/`pct2Cache`. `drawPaceBar` caches on
  `(pct, tick)` alone, so the Fable bar's dim-only change would never repaint.
- **`resetUsageCaches()` gains every new cache**, because `drawUsageStatic()` repaints the chrome
  those fields are drawn *on*. A caller that forgot left the values blank once already — the
  "USAGE shows no numbers after recording" bug.

**`renderCard` is duplicated behind the flag rather than parameterised.** Board 1 keeps its
`renderCard` text untouched; board 2 gets `renderNowCard` and `renderWeekCard` under
`#if BOARD_USAGE_V2`. Parameterising the shared function would risk board 1's binary for no
benefit, and duplication-behind-`#if` guarded by a checker assertion is the pattern this repo
already settled on for the ask screen's READ chip.

**`renderCard` must also be wrapped in `#if !BOARD_USAGE_V2`, not merely left uncalled.** Board 2
stops calling it, and an uncalled function is dead weight the linker may or may not drop — which
would silently spend flash on a renderer that can never run. Wrapping it also means
**`CARD_HERO_W` is entirely board-2 scoped**: board 1's hero call site keeps the expression it has
today, and the constant exists only in board 2's header.

## Board-1 safety

`board-baseline.mjs --check 1` must report `UNCHANGED` at **every commit of the redesign**. Every
change is either inside `#if BOARD_USAGE_V2` or a board-2-only header constant. Compile board 2
and `--check 2` first, then board 1 and `--check 1` — **never concurrently**, one sketch build
directory.

The two shared-code bug fixes then move board 1 **deliberately, in their own commits**, each
re-baselining with the reason in the message. That ordering is the point: the diff whose claim is
"board 1 unchanged" stays clean, and the diff that moves board 1 says exactly why.

## The five findings

| # | finding | where | handling |
|---|---|---|---|
| 1 | Column derived as 416 with 8px air; really **414 with 6px** | `board_es3c35p.h` comment | fixed with the redesign — comment only, board 1 unaffected |
| 2 | `air > 0` cannot catch that drift | `usage-geom-check.mjs:228` | replaced by an **exact** sum-to-414 assertion plus a drawn-vs-declared term check |
| 3 | `drawBigNumber` clears the full lane; 132px erased per repaint | `deckhand_display.ino` | `CARD_HERO_W`, board 2 only; board 1's call site keeps its own expression |
| 4 | Codex label lane derived from a bound `padLeftTo` does not enforce | `usage.ino` | **own commit, re-baselines board 1** |
| 5 | Stats field is `padTo` (pad right) + `TR_DATUM`, so it floats with content | `deckhand_display.ino` | **own commit, re-baselines board 1** |

Finding 4 in full: `CODEX_LANE_CHARS` is 12, derived in the header from the right field being
`CODEX_RIGHT_CHARS` = 20 wide. But **`padLeftTo` returns early when the string is already longer**
— `if (len >= width || width + 1 > bufSize) return;` — so it never truncates and that field is not
bounded by 20 at all. Its ordinary content is **22** characters and the header's own cache comment
names a **25**-character worst case. At 22 the two clear boxes overlap by 15px and a label repaint
erases the percentage's leading digits until the countdown next ticks; at 25 it reverses and the
label loses its window text. Same bug the header already documents for board 1's *tag*, arriving
on board 2's *window*. **Affects both boards.**

Finding 5 in full: `renderCard` pads the right-hand stats field with `padTo` (pad **right**) and
draws it `TR_DATUM`, so the trailing spaces sit between the glyphs and the anchor and the text is
inset by `(16 - len) * 8` px — 40px for `"2h 14m left"`, 24px for `"starts on use"`. Every other
`TR_DATUM` field on the tab uses `padLeftTo`. Cosmetic, both boards, and visible in the mock's
baseline panel.

## Checker changes

`usage-geom-check.mjs` must gain, and each must **fail when the thing it guards is reverted**:

1. **The column sums to exactly 414**, and the drawn terms match the declared ones. Replaces
   `air > 0`, which is satisfied at 8, at 6 and at 1. *The mock's first version of this assertion
   was vacuous* — it derived `air` from the drawn positions, making `top + Σh + Σgaps + air` an
   identity that could not fail. Proven blind by injection. Do not reintroduce that shape.
2. **No field's clear box may erase another field's ink, per glyph, undirected.** Undirected
   because every field owns its own cache and can repaint alone, so draw order buys nothing; per
   glyph because `renderCodexRow` deliberately draws its Mac icon into a run of reserved **spaces**
   inside the label, which an extent-based model reports as a collision. The one exemption belongs
   to the **victim**: a field the firmware redraws unconditionally every tick cannot be left
   erased, whoever cleared over it.
3. **The Codex label lane is derived from where the right field's clear box actually starts**, not
   from `CODEX_RIGHT_CHARS` — that is finding 4 expressed as an assertion.
4. **`CARD_HERO_W` clears the side-fact lane**, so a revert to the full lane fails by name.
5. Every new constant caught by `geom-sweep.mjs` at **±1 in both directions**. That is the standard
   this repo sets for constants it has just added; the wireless-pairing branch met it for 22 of 25.

`palette-check.mjs` needs nothing: the redesign adds no colour token.

## Costs

Flash and RAM are **unmeasured** and must be reported from a real build, per board, against a
worktree build of the parent commit — not estimated here. Expected shape: RAM up by roughly the
ring (~160 bytes); flash up by the second card renderer, the spark, the least-squares fit and the
ring; board 1 by **zero** until the two fix commits.

## What is NOT verified

- **Nothing has been on the glass.** The evidence is arithmetic and bitmaps — the right instrument
  for layout, the wrong one for colour.
- **No screenshot here could settle colour anyway.** Board 2's `SCREENSHOT` reads the shadow
  framebuffer, so it proves the renderer self-consistent and nothing about the panel.
  `COLORTEST` is the instrument; a person is the authority.
- **The 190/190 font check covers Spleen8x16 and Spleen12x24 only.** Spleen32x64 was extracted by
  the same reader, which is strong evidence and not the same thing as a diff against a
  known-good copy — none exists for that face.
- **The sparkline has never been read by a human at 320x480.** The mock says it moves; whether 32
  rows of 2.5-hour trend tells anyone anything is a judgement only the glass can settle, and it is
  the first thing to look at once this is flashed.
- **The ring's behaviour across a real window reset is untested**, because it needs 5 hours of
  wall clock to observe once.

## Open questions

1. **When does the ring reset?** The battery ring clears when the state leaves `DISCHARGING` or
   the charge rises >40mV. Three candidate events here: the **window resetting** (the percentage
   drops, and a slope across that discontinuity is meaningless), the reading **going stale**, and
   `mergeUsage` **switching source Mac**. Inclination: clear on a drop and on a staleness edge, and
   ignore a source switch since both Macs poll the same account — but that last one should be
   looked at rather than assumed.
2. **`BURN_MIN_ELAPSED`** is the one number in the gate with nothing behind it. Either accept it as
   a judgement and say so at the constant, or derive a floor from something measurable.
3. **Does the pin bar survive?** It drew the "why is there a red underline?" complaint and this
   redesign does not address it. Out of scope as chosen, recorded so it is not mistaken for
   settled.
