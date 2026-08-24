# Board 1: known defects, surfaced by the second-board port

Re-deriving board 1's layout from first principles in order to derive board 2's turned out to be an
**audit of the original**, and defects fell out of it. None was introduced by the port, and **none
of the eleven below is fixed**, for one reason:

> Every fix would move board 1's binary inside a diff whose entire claim is byte-identity
> (1382802 flash / 69236 RAM, held through all nine tasks of the port). Hiding a board-1 behaviour
> change inside a board-2 diff is exactly the class of mistake the byte-identity check exists to
> catch, so four otherwise-good changes were declined mid-port for the same reason.

> **THAT REASON HAS EXPIRED, AND THIS FILE'S PREMISE WITH IT.** Byte-identity was retired when two
> shared-code bugs were fixed deliberately — the history list going blank after reading one entry,
> and the PAIRED MACS row (an invisible live marker, plus two same-named Macs rendering identically).
> Neither was in the eleven below; both were found later and both affected board 1. Board 1's binary
> moved twice on purpose, 1382802 → 1382770 → 1382938.
>
> So the argument for leaving these eleven alone is no longer "it would break byte-identity" — that
> check is now `firmware/board-baseline.mjs`, which expects deliberate movement and asks only that it
> be re-baselined with a stated reason. What remains is the weaker and more honest argument: **none
> of these has been seen on a screen**, because board 1 was physically disconnected throughout, and
> every one is arithmetic rather than an observation. Fixing them unverified would trade a defect
> nobody has hit for a change nobody has looked at. **Connect board 1 first**; then they are ordinary
> work, and the baseline tool is how you show the diff did what you meant.

They belong on their own branch off `main`, with their own screenshots. This file exists so they are
not lost: the ledger they were found in is gitignored, and a defect that lives only in a scratch
file is a defect nobody will ever fix.

**Everything here is arithmetic against the constants in `firmware/deckhand_display/board_e32r28t.h`
and the call sites named.** Re-derive before fixing; do not trust this file over the code.

## The count, because it moved during the port and someone will re-count it

**Ten live items across eleven numbered slots. Slot #4 is STRUCK — it was reported and is not
real.** The slots keep their original numbers rather than being renumbered, because they were cited
by number in task reports and reviews and silently shifting them is how a fix gets applied to the
wrong defect. Slot #6 is the residue of #4's investigation, so the false report was not worthless.

## Severity order

By *what a user loses*, not by how hard the fix is:

1. **#3** — a message about where an action must happen is silently erased.
2. **#1** — visible corruption under ordinary use.
3. **#7**, **#8**, **#9**, **#10**, **#11** — geometry that misses its own stated rule; cosmetic to
   sub-`TAP_MIN`.
4. **#2** — needs 7 or more simultaneous sessions.
5. **#5**, **#6** — unreachable today / draws nothing at all.

## The defects

### 1. `usage.ino` — the stats row's clear box eats the pace bar's tick overhang

The stats row's clear box (`+73..+87`) overlaps the pace bar's clear box (`+58..+75`). So a token
count that changes while the percentage does **not** erases rows `+73..+75` — the tick's lower
overhang — and nothing repaints it, because `drawPaceBar` caches on `(pct, tick)` alone and neither
moved.

Verified against `8cb9c2e`'s literals (20/62/74/88, `BAR_H` 10, `CARD_H` 104). The other two clear-box
overlaps on that card are genuinely benign and should not be "fixed" along with it: hero→bar cannot
bite because `pct` drives both caches so the bar always repaints after the hero, and stats→foot
touches only a clear-box margin below the glyph band.

*Found by Task 6's review, among the three failures `usage-geom-check.mjs` tolerates.*

### 2. `sessions.ino` — at 7+ sessions the compact sub-line is drawn over the row's own border

With 7 or more sessions the strip's available height is 248, `(248 - 15) / 6 = 38` = `SESSION_ROW_H_MIN`,
and a compact row's model/branch line inks `+25..+37` over a border owning `+36..+37`.

The same defect arrived a second time from the other direction, which is what makes it worth
believing: turning `SESSION_ROW_H_MIN`'s inherited literal into a derivation (`SESSION_SUBC_Y + 15`)
gives **40** on board 1, so the shipped **38** is 2px under its own floor. Board 2's equivalent is 43
and never binds — the minimum raw rung across n=1..6 there is 63.

*Found by Task 7, confirmed independently by Task 7's fix round.*

### 3. The session detail screen's "answer this one on your Mac" notice is painted out — WORST ONE

`sessions.ino` draws **two** footer strings at the same y with the same `MC_DATUM`:
`cardY + DETAIL_CARD_H + 8` = 292 and `contentBottom() - 10` = 292. The history hint is drawn
**second**, and `drawString` paints an opaque background box, so the notice telling you the prompt
must be answered on your Mac **never reaches the glass at all**.

This is not a cosmetic overlap. It is a message about where an action has to happen, silently
erased, in a repo whose read-only-ask path exists specifically so the device never misleads you
about what it can do.

*Found by Task 7, arithmetic confirmed at `ba45ba3`.*

### 4. `drawColValue` ignoring its `w` argument — **NOT REAL. This is the correction.**

This was reported as a defect (a 19-character model name overrunning `drawColValue`'s column into
GIT BRANCH) and **it does not exist**. `drawColValue` (`sessions.ino:996`) uses `w` in both
`tft.textWidth(buf) > w` and `w - dots`, and ellipsises inside its column. Measured: 90px / 15
characters whole / 13 + ".." on board 1, 126px / 21 / 19 on board 2, the two columns clearing each
other by 6px and the right column 2px inside the card lane.

The full-lane clipping the original report described belongs to **`drawDetailValue`** (`:1021`), a
different and **parameterless** helper sitting directly below it, whose `CARD_W - 2*PAD` is *correct*
for a full-width value. The suggested fix (`int maxW = w;`) would have been a no-op that broke
byte-identity for nothing.

**The correction is kept rather than deleted, deliberately.** A false defect costs a future
maintainer either the time to disprove it or a no-op "fix", and the observation had a real residue
underneath it — see #6. Three separate readers checked this before it was struck.

### 5. `drawIfChanged`'s clear box is one pixel short of a descender under `T_HEAD` + `MC_DATUM`

`drawIfChanged` computes its erase height as `th = cellH`, while `drawString`'s datum positioning
uses the **ascent**. So a `T_HEAD` string drawn `MC_DATUM` can put a descender 1px below the box it
was cleared in, leaving a stripe.

Unreachable today: the only three `MC_DATUM` + `T_HEAD` sites are the steppers, whose strings
(digits, `%smh`, `OFF`/`LOW`/`MED`/`HIGH`) contain no descenders. Present identically on board 2 —
this is shared code, so a fix helps both boards.

*Found by Task 3's review.*

### 6. `drawDetailValue` is DEAD CODE whose comment reference makes it look live

Zero call sites (confirmed by grep, twice). Its mention inside `drawColValue`'s comment is exactly
what made two live helpers appear to exist and produced defect #4. Same shape as the `macEmojiId`
global this repo already deleted for claiming a wiring that did not exist.

Lowest severity of the eleven — it draws nothing wrong because it draws nothing at all — and the one
item where **deletion is the whole fix**.

### 7. `reader.ino` — the same control bar splits its touch x differently depending on which screen drew it

The three reader control bars split their x range at **78/156** in the history list and the
full-entry pager, but at **82/158** in the ask reader. Neither split is *wrong* on its own — both
merely hand the 8px gap between two keys to a different neighbour — but the same bar behaves
differently on different screens and nothing on screen says so, which is the kind of inconsistency
that makes a mis-hit look random.

*Found by `settings-geom-check.mjs` in Task 8. Tolerated there as
`reader tap splits agree across the three control bars (78/156 vs 82/158)`.*

### 8. `reader.ino` — the history chip's tap band claims 2px of the first list row

The chip's tap band is `sy <= 24`, i.e. rows 0..24, while the rule it is drawn to is 22. So the band
reaches 2px past the chip and into the first list row's territory. Harmless in practice — the first
row starts at `HIST_TOP` 28 — but it is the chip claiming rows that are not the chip.

*Tolerated as `chip tap band ends 24 above the rule, or it would claim the first list row`.*

### 9. `reader.ino` — "Asking the Mac…" sits at a literal 130 instead of its region's 147 midpoint

`HIST_EMPTY_CY` is a hardcoded **130**, which is not the midpoint of the region it sits in (22..272 →
**147**). It predates the control bar that shrank that region, so it is 17px high in a screen whose
every other offset is derived.

*Tolerated as `history empty-state y 130 is the midpoint of 22..272 (147)`.*

### 10. `reader.ino` — the filter chip's label is 1px above its own centre

`HIST_CHIP_CY` is a literal **13** where the chip runs `HIST_CHIP_Y`..`+HIST_CHIP_H` = 4..20, whose
centre is `4 + 17/2` = **12**. Invisible at this size, and the constant's own comment now says so.

*Tolerated as `chip label centre 13 == the chip's own centre 12`.*

### 11. `reader.ino` — the filter chip is under `TAP_MIN` in WIDTH, in only one of its two states

`HIST_CHIP_W_CHAT` is 40 and `HIST_CHIP_W_ALL` is **32**, against a `TAP_MIN` of 40. So the chip
clears the fingertip floor while it reads `CHAT` and falls 8px short the moment it reads `ALL` —
which is exactly why nothing caught it before: any check that measured one state alone would pass.
(The chip is separately under the floor in *height* at 17px drawn, but that one is a deliberate,
commented compromise: the list above and the control bar below own every other row.)

*Found by the assertion added in Task 8's fix round, not by reading — which is the argument for
having written the assertion. Tolerated as
`chip widths 40/32 both clear TAP_MIN 40`.*

## One defect that WAS fixed, and why that was not inconsistent

The farewell screens' `delay(1200)`/`delay(1500)` ran **before** the flush, so on board 2 the dwell
displayed the *previous* screen and the goodbye message existed in memory for zero frames. Fixed in
the port, unlike everything above, for one reason: it is **board-2-only**, so the byte-identity
argument does not apply — and the behaviour exists only because the port introduced the
deferred-flush model, which makes it the port's own bug rather than a pre-existing one.

## What the geometry checkers do with these

`usage-geom-check.mjs`, `sessions-geom-check.mjs` and `settings-geom-check.mjs` each carry a `KNOWN`
list of board-1 shortfalls they tolerate, so they can pass on board 1 while still asserting the rule
for board 2. That list is honest rather than a silencer: **`KNOWN[2]` is empty in all three**, so
board 2 passes on its own merits and a tolerance can never hide a board-2 defect.

**Not every `KNOWN` entry is a defect from this list, and the distinction is in the comments beside
them.** Some are deliberate, previously-argued compromises — the pager key at 34px tall, the action
button at 38, the history chip at 17px drawn — where the header's own comment already explains the
trade. The rest are the items above. Each entry says which it is.

Fixing an item here means **deleting its `KNOWN` entry in the same commit**. Otherwise the checker
keeps tolerating something that is no longer there, and will not notice it coming back.

## 12. `CODEX_RIGHT_CHARS` can be exceeded by its own content — BOTH boards

`renderCodexRow()` pads its right-hand field to `CODEX_RIGHT_CHARS` (20), but the string it
formats — `"%d%%  %s  %02ld:%02ld"` with `formatResetIn()`'s multi-day branch, e.g.
`"0%  6d 23h left  22:55"` — runs to about 23-24 characters. `padLeftTo()` refuses an oversized
width rather than truncating (deliberately, and documented), so the real string simply draws
wider than the lane arithmetic assumes.

**Consequence:** when a multi-day Codex reset countdown lands on a two-digit hour — recurring
roughly an hour a day — and no Mac tag is being shown, the right field's clear box extends left
of its assumed `clearFrom` and can erase the tail of the `CODEX …` label beside it.

Found while re-deriving board 2's lane for an 8px advance, but it is **not** a consequence of
that change: the overflow is in the character count against its own content and is present on
board 1 identically. Not fixed because the fix moves board 1's frozen constant, which the type-
scale branch holds byte-identical. Severity: cosmetic and intermittent, but it is real corruption
of a label rather than a margin being tight.
