# Board 2: a native type scale, and a layout that uses the screen

**Status:** design, approved in outline (font direction, crisp hero, expanded session card).

## Goal

Make board 2's UI look like it belongs on a 320x480 3.5in panel instead of a 240x320 one
with more margins. Two changes, and they are one piece of work because each needs the other:
a type scale with **no scaled fonts anywhere**, and layouts that spend the extra height on
content rather than emptiness.

## The problem, measured

**Board 2's body text is physically SMALLER than board 1's.** That is the finding that
started this, and it is counter-intuitive enough to write down: board 2 has twice the pixels
but only 15% more density (6.489 px/mm against 5.624), so identical pixel sizes shrink in the
hand on the bigger screen.

| | board 1 | board 2 today |
|---|---|---|
| body 6x13 | 1.07 x 2.31 mm | 1.07 x **2.00** mm |
| hero | 18x39 = 3.20 x 6.94 mm | 24x52 = 3.70 x **8.01** mm, scaled 4x |

And the hero is Cozette 6x13 at `setTextSize(4)`. A 4x-scaled bitmap font stair-steps badly
and its `%` degenerates into a checkerboard - the single most visible artifact on the device.

**The dead space, from screenshots rather than arithmetic:** with one session the SESSIONS tab
draws a 106px row and then 306px of nothing - 64% of the content area. SETTINGS page 1 wastes
~145px below its only card.

## Decision 1: Spleen, four native rungs, zero scaling

Spleen (BSD-2-Clause, `github.com/fcambus/spleen`) ships hand-designed **8x16, 12x24, 16x32
and 32x64**. Note on reading the table below: `T_HERO`'s registry entry is Cozette 6x13 at
size 2, but the usage card OVERRIDES it with `setTextSize(CARD_HERO_SIZE)` - 3 on board 1 and
4 on board 2 - so the effective hero today is 18x39 and 24x52 respectively, not 12x26. The
override is what a native 32x64 rung removes. `bdf2gfx.py` converts all four unmodified - verified before this spec was
written. Board 2's `UI_FONTS` becomes one family with no `setTextSize` above 1 anywhere:

| rung | board 1 (unchanged) | board 2 | board 2 physical |
|---|---|---|---|
| `T_META`, `T_BODY` | Cozette 6x13 | **Spleen 8x16** | 1.23 x 2.47 mm |
| `T_HEAD` | Terminus 10x18b | **Spleen 12x24** | 1.85 x 3.70 mm |
| `T_HERO` | Cozette 6x13 @3x = 18x39 | **Spleen 32x64** | 4.93 x 9.86 mm |

**Why 8x16 and not 12x24 for body.** 8x16 lands at 2.47mm, just above board 1's 2.31mm, and
leaves a **32-character lane** in the 260px card interior against board 1's 34 - so every
existing character-budget argument has a direct analogue rather than needing a fresh one.
12x24 would give 21 characters and start truncating session titles and ask details that fit
today. The goal is parity-plus, not maximalism.

**The hero gets bigger AND crisper**, which is the one place the extra pixels genuinely pay:
9.86mm native against 8.01mm scaled, with real glyph shapes. `"100%"` is 128px in a 260px
lane.

**Cost:** ~32KB flash (2.2 + 5.2 + 25KB for the three faces actually used - 16x32 is listed
above as available but no rung needs it), guarded so **board 1 stays byte-identical at
1382802 / 69236** - the invariant that has held for every commit of this port and is not
being spent here.

## Decision 2: what has to be re-derived

This is the honest scope. A 13->16px line and a 6->8px advance moves every lane on the board:

- **Session rows:** the ladder's `SESSION_TITLE_MIN_H` / `SUB_MIN_H` / `LARGE_MIN_H` identities
  are all built on 13px lines; the name-fitting ladder (12x26 -> 10x18 -> 6x13) becomes
  Spleen 32x64 -> 12x24 -> 8x16 and every measured lane changes.
- **Usage cards:** DERIVED AFTER WRITING THIS, and the answer is better than the estimate it
  replaces: a 64px hero and three 16px rows **fit inside the existing `CARD_H` 164** with 5px
  spare. Interior, against a ceiling of +161: pin bar +2..+6, label +5..+22, hero +23..+88,
  pace bar +94..+113, stats +117..+134, foot +139..+156. So the cards do NOT grow and the
  column does not have to be re-budgeted - which matters, because the column has only **8px
  of clearance today** (`46+8 + 164 + 8 + 164 + 8 + 56 = 454` against `contentBottom()` 462),
  not the 28px an earlier draft of this spec claimed. The Codex row's own text also goes to
  16px and must be re-derived inside `CODEX_H` 56.
- **The keyboard:** `KB_COLS` goes from 47 to ~32, so `ceil(150/32) = 5` lines rather than 4 -
  and the 150-byte/8-line confirm pairing must be re-derived, not assumed.
- **The history reader:** ~49 columns -> ~32, and the device already reports its budget to the
  host, so `HIST_LINE_CHARS`/`HIST_PAGE_LINES` follow automatically.
- **The footer:** `FOOTER_H` is 18 and a 16px line clears `th+2 = 18` EXACTLY. This is the one
  place that may have to grow (18 -> 20), costing 2px of content area.
- **Every cache:** character counts SHRINK as lanes narrow, so existing sizes stay adequate -
  but each must be checked rather than assumed, per this repo's oldest bug class.

**The three geometry checkers are the safety net and must be extended, not merely kept
passing.** They parse the real font headers, so a new face flows through; `geom-sweep.mjs`
then reports which of the new constants no assertion reads.

## Decision 3: SESSIONS expands its most urgent session

The top row of the urgency-sorted list becomes a tall card - wrapped title (2 lines), agent /
model / branch, `LAST PROMPT` (2 lines), path, status and duration - while the rest stay
compact rows. It scales from 1 to 6 sessions without a special case at either end, and it
puts detail where the eye already is instead of behind a tap.

The existing detail screen keeps its purpose: history, TYPE, and answering an ask.

## Decision 4: SETTINGS page 1 gains a LINK card

A second card carrying what the device knows and currently cannot show: host ticking or not,
last payload size, flush milliseconds (`PERF` already measures it), uptime. This is diagnostic
information the port repeatedly wanted and had to read from a Mac log.

## Out of scope

- Board 1. Untouched, and byte-identity is the check that proves it.
- The ES8311 mic path. Separate spec.
- `renderUsageTab`'s remaining ~59ms of text rendering. A bigger native font will change that
  number; measure with `PERF` afterwards rather than predicting it now.

## Verification

1. Board 1 compiles byte-identical - the gate on every commit.
2. All three geometry checkers plus their selftests, and `geom-sweep.mjs` to find constants
   nothing guards.
3. `SCREENSHOT` on all three tabs plus the four settings pages, decoded and viewed - with the
   standing caveat that a capture reads the shadow framebuffer, so **colour and legibility
   still need a person**.
4. `PERF` before and after: a 32x64 hero draws more pixels than a 24x52 one and the AA
   decomposition work is fresh enough that a regression here would be easy to miss.

## Risk

The type scale is load-bearing for every surface at once, so a wrong lane shows up as
truncated text rather than as a crash. The mitigation is that lanes are MEASURED not counted
(`textWidth` is verified pixel-exact against TFT_eSPI) and that the checkers assert them - but
the review burden is real, and this is why it runs as a planned pass rather than freehand.
