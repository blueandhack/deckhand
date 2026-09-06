# Board 1: known defects, surfaced by the second-board port

Re-deriving board 1's layout from first principles in order to derive board 2's turned out to be an
**audit of the original**, and defects fell out of it. None was introduced by the port.

> **RECONCILED 2026-09-05 against `060f458` (`compose-surface`). BOTH OF THIS FILE'S REASONS FOR
> LEAVING EVERYTHING ALONE ARE SPENT, AND FOUR OF THE ELEVEN ARE FIXED.**
>
> The file used to open with two arguments. The first was byte-identity: *"every fix would move
> board 1's binary inside a diff whose entire claim is byte-identity (1382802 flash / 69236 RAM)"*.
> That constraint was **lifted deliberately** on this branch, because the user asked for board 1 to
> be brought into line with board 2 — see `CLAUDE.md`. The check is `firmware/board-baseline.mjs`,
> which expects deliberate movement and asks only that it be re-baselined with a stated reason.
> Board 1's binary is **1414288** today, from 1382802.
>
> The second was that board 1 was physically disconnected, so *"none of these has been seen on a
> screen"* and *"connect board 1 first"*. **Board 1 has been connected all session** — flashed
> roughly a dozen times, driven from the Mac through `~/.claude/deckhand-device-command`, and
> captured on its **real panel** (board 1's `SCREENSHOT` reads the glass, not a shadow
> framebuffer) into `~/Deckhand-shots/*-Deckhand-0528.png`. The precondition is met.
>
> What is left is neither of those. Six entries below are still live, and for each the honest
> statement is now specific rather than blanket: **what state nobody produced, and why.** Where a
> capture answers an entry it is named. Where the cost of the fix is the reason it stands, the
> arithmetic is given rather than an excuse.

**This file exists so these are not lost:** the ledger they were found in is gitignored, and a
defect that lives only in a scratch file is a defect nobody will ever fix. They no longer need a
branch of their own — four were fixed on `compose-surface` alongside the work that lifted the
constraint holding them.

**Everything here is arithmetic against the constants in `firmware/deckhand_display/board_e32r28t.h`
and the call sites named.** Re-derive before fixing; do not trust this file over the code.

## The count, because it moved during the port and someone will re-count it

**Eleven numbered slots. FOUR ARE NOW RESOLVED (#2, #3, #7, #10), ONE IS STRUCK (#4 — reported and
not real), and SIX ARE STILL LIVE (#1, #5, #6, #8, #9, #11).** Slot #12 was resolved earlier and
is at the bottom of this file, where it has been since it was fixed.

The slots keep their original numbers rather than being renumbered, because they were cited by
number in task reports and reviews and silently shifting them is how a fix gets applied to the
wrong defect. A resolved entry is **corrected in place and marked, never deleted** — a described
defect that no longer exists costs the next reader either the time to disprove it or a no-op
"fix". Slot #6 is the residue of #4's investigation, so the false report was not worthless.

**Not one of the six live entries has been SEEN on board 1's glass**, and that is not because
nobody looked. Each names the state it needs and why the session did not reach it. Three of the
six (#8, #9, #11) live on the history reader, which on this board is reached only by a finger on
the detail screen's `< Back up top  -  tap here for history` footer or on the chip in an ask
header — **`READTEST` is not compiled on board 1** (guard `!BOARD_USES_TFT_ESPI`, and its own
refusal now says so), and there is no other trigger-file command that puts that screen up. Board
1's reader was never exercised on the glass this session.

## Severity order

By *what a user loses*, not by how hard the fix is:

1. ~~**#3** — a message about where an action must happen is silently erased.~~ **FIXED, and seen.**
2. **#1** — visible corruption under ordinary use. **The worst one still live.**
3. ~~**#7**~~, **#8**, ~~**#9**~~, ~~**#10**~~, **#11** — geometry that misses its own stated rule;
   cosmetic to sub-`TAP_MIN`. #7 and #10 are fixed; #9 stands; #11's premise is now doubtful (see
   the entry).
4. ~~**#2** — needs 7 or more simultaneous sessions.~~ **FIXED, and still unseen for that reason.**
5. **#5**, **#6** — unreachable today / draws nothing at all.

## The defects

### 1. `usage.ino` — the stats row's clear box eats the pace bar's tick overhang — STILL LIVE

The stats row's clear box (`+73..+87`) overlaps the pace bar's clear box (`+58..+75`). So a token
count that changes while the percentage does **not** erases rows `+73..+75` — the tick's lower
overhang — and nothing repaints it, because `drawPaceBar` caches on `(pct, tick)` alone and neither
moved.

**Re-verified at `060f458`, unchanged:** `CARD_BAR_Y` 62 (`// bar +62..+71, clear +58..+75`),
`CARD_STATS_Y` 74 (`// clear +73..+87`), `BAR_H` 10, `CARD_H` 104, and `drawPaceBar`'s cache is
still one integer, `code = clamped * 102 + tick`. The stats row is drawn **after** the bar
(`deckhand_display.ino`: `drawPaceBar` at the bar, then `drawIfChanged(leftCache, …, statY)`), so
the stats clear is the one that eats. `usage-geom-check.mjs` measures it live and reports it as
`KNOWN_OVERLAPS[1]["pace bar clear -> stats clear"] = -3`, which is exactly those three rows.

The other two overlaps on that card are genuinely benign and should not be "fixed" along with it:
hero→bar cannot bite because `pct` drives both caches so the bar always repaints after the hero,
and stats→foot touches only a clear-box margin below the glyph band.

**Why it is still unseen:** the corruption is transient and needs a token count to move while the
percentage holds. Board 1's USAGE tab was captured repeatedly this session, but a still frame taken
at an arbitrary tick cannot show a stripe that appears between two ticks and survives only until
the next percentage change. Seeing it needs a capture timed to a token-only update, which nothing
here can trigger on demand.

**Why it was not fixed:** stated as cost, not as caution. The three overlaps are −2 / −3 / −1, six
pixels of deficit and nine once the bands are properly separated, against a `CARD_H` of 104 on a
268px content area already carrying two of these cards plus the Codex row. The only band big enough
to pay is the 39px hero number.

*Found by Task 6's review, among the three failures `usage-geom-check.mjs` tolerates.*

### 2. `sessions.ino` — at 7+ sessions the compact sub-line is drawn over the row's own border — **RESOLVED in `7e06ff0`**

Was: with 7 or more sessions the strip's available height is 248, `(248 - 15) / 6 = 38` =
`SESSION_ROW_H_MIN`, and a compact row's model/branch line inked `+25..+37` over a border owning
`+36..+37`. The defect arrived a second time from the other direction, which is what made it worth
believing: turning `SESSION_ROW_H_MIN`'s inherited literal into a derivation (`SESSION_SUBC_Y + 15`)
gives **40** on board 1, so the shipped **38** was 2px under its own floor.

**Fixed in the draw, not in the constant, and the reason is arithmetic rather than caution:** six
rows at 40 plus five 3px gaps is 255 against an avail of 248, so raising `SESSION_ROW_H_MIN` to 40
would draw the sixth row 7px through the footer. Two rows of sub-line on an outline is a smaller
defect than seven rows of row on the footer, and dropping the list to five visible rows is a product
decision, not a geometry fix. `sessionSubcYAt(rowH)` (`sessions.ino:194`) clamps the sub-line to
`rowH - BORDER_CARD - SESSION_LINE_H`, and **both draw sites go through it** — the sub-line
(`sessions.ino:1520`) and the live duration (`:1682`), which are drawn at the same y on purpose, so
a clamp applied to one and not the other would reintroduce the collision at the floor and nowhere
else. `sessions-geom-check.mjs` mirrors the clamp in its band walk, binds the firmware's own
expression and counts both call sites, and carries a source-fault (`the compact sub-line is drawn
9px lower, back onto the card's own border`) that must fail by name. Board 2's equivalent floor is
derived (47) and never binds, which the checker asserts rather than assumes.

**STILL UNSEEN, and this is the one place where the file's old "arithmetic rather than an
observation" line still applies to a FIX.** Reaching six 38px compact rows needs **seven concurrent
Claude Code sessions** and this Mac had one all session, so the clamp is **checker-verified only**.
The two `KNOWN[1]` entries that recorded the defect (`strip 6x38 (compact): sub-line -> border
bottom gap -2` and `ladder floor 38 >= SESSION_SUBC_Y + line + 2 = 40`) — one defect stated twice,
as the row it produced and as the constant that produced it — are **removed with a note in their
place**, because an allowlist entry matching no message the checker can emit is the same defect as
an assertion that cannot fail, on the allowlist side of it.

*Found by Task 7, confirmed independently by Task 7's fix round.*

### 3. The session detail screen's "answer this one on your Mac" notice is painted out — **RESOLVED in `924cecc`, AND SEEN**

Was: `sessions.ino` drew **two** footer strings at the same y with the same `MC_DATUM` —
`cardY + DETAIL_CARD_H + 8` = 60 + 224 + 8 = 292 and `contentBottom() - 10` = 292. The history hint
was drawn **second**, and `drawString` paints an opaque background box, so the notice telling you
the prompt must be answered on your Mac **never reached the glass at all**. Not a cosmetic overlap:
a message about where an action has to happen, silently erased, in a repo whose read-only-ask path
exists specifically so the device never misleads you about what it can do. Board 1's card was 13px
over the ceiling its own footer sets — 224 against 211.

**Fixed as a side effect of bringing board 1 to board 2's §7 detail card.** The two label+value
column pairs (four labels, four values) became one meta line, which paid for both the status band
and the 14px the card had to give back: `DETAIL_CARD_H` is **210**, so the notice is drawn at
60 + 210 + 8 = 278 and the hint at 292, 14px apart.

**SEEN ON THE REAL PANEL** — `~/Deckhand-shots/shot-2026-09-05T14-31-57-Deckhand-0528.png`, on an
injected `asking` session: the orange `answer this one on your Mac` sits on its own row above
`< Back up top  -  tap here for history`, both legible, neither touching the other. This is the one
entry in this file that has been converted from arithmetic into an observation. The two `KNOWN[1]`
entries that recorded it (`"answer on your Mac" ends 299 above the history hint at 287` and
`DETAIL_CARD_H 224 is within the 211px ceiling the history hint sets` — again one defect stated
twice) are removed with a note in their place.

*Found by Task 7, arithmetic confirmed at `ba45ba3`, fixed at `924cecc`.*

### 4. `drawColValue` ignoring its `w` argument — **NOT REAL. This is the correction.**

This was reported as a defect (a 19-character model name overrunning `drawColValue`'s column into
GIT BRANCH) and **it did not exist**. `drawColValue` used `w` in both `tft.textWidth(buf) > w` and
`w - dots`, and ellipsised inside its column. Measured: 90px / 15 characters whole / 13 + ".." on
board 1, 126px / 21 / 19 on board 2, the two columns clearing each other by 6px and the right
column 2px inside the card lane. The full-lane clipping the original report described belonged to
**`drawDetailValue`**, a different and **parameterless** helper sitting directly below it, whose
`CARD_W - 2*PAD` is *correct* for a full-width value.

**CORRECTED 2026-09-05: `drawColValue` NO LONGER EXISTS.** `924cecc` deleted it together with
`pillLabel()` and the card that called them — board 1's detail screen no longer draws a status pill
or two label+value column pairs (see #3). `sessions.ino:2639` carries a comment saying so where
they used to be. So this slot is archaeology now, and it is kept for two reasons rather than one:
the original rule (a false defect costs a future maintainer either the time to disprove it or a
no-op "fix" — and the suggested fix, `int maxW = w;`, would have been exactly that), and because
its residue, **#6, is still live and is now the only survivor of the pair**. Three separate readers
checked this before it was struck.

### 5. `drawIfChanged`'s clear box is one pixel short of a descender under `T_HEAD` + `MC_DATUM` — STILL LIVE, STILL UNREACHABLE

`drawIfChanged` computes its erase height from the font's **cell height**, while `drawString`'s
datum positioning uses the **ascent**. So a `T_HEAD` string drawn `MC_DATUM` can put a descender 1px
below the box it was cleared in, leaving a stripe.

**Re-verified at `060f458`.** The expression is no longer the literal `th = cellH` this entry was
written against — `deckhand_display.ino:1863` now reads
`int th = (uiLineH(font) / uiTextSize(font)) * tft.textsize;`, which is the same cell height with
the `size` override re-applied (that change fixed a different bug: a taller face clearing only part
of its own box). The relationship to the ascent is unchanged, so the entry stands.

**Unreachable today, re-counted:** the only `MC_DATUM` + `T_HEAD` sites are the four stepper values
— `settings.ino:569` (brightness, `"%d%%"`), `:583` (sleep, `formatSleepValue()`'s `OFF` / `15s` /
`30s` / `1m` / `2m` / `5m`), and `:590` and `:715` (volume, `VOL_LABELS[] = {"LOW", "MED", "HIGH"}`
— the same control drawn on two pages). Digits, `s`, `m` and four upper-case words: **no
descenders**, and `padTo(buf, …, 5)` pads with spaces, which have none either. Present identically on board 2 — this is shared code, so a fix helps both
boards. **Unseen because it cannot be seen**: no live string reaches the failing case.

*Found by Task 3's review.*

### 6. `drawDetailValue` is DEAD CODE whose comment reference made it look live — STILL LIVE

**Re-verified at `060f458`: still zero call sites.** `drawDetailValue` is defined at
`sessions.ino:2666` and called from nowhere in any `.ino`, `.h` or `.cpp`. It is not eliminated at
link time either — `_Z15drawDetailValueiPKch` appears in `.text` in **both** boards' link maps, so
it costs flash on each. Same shape as the `macEmojiId` global this repo already deleted for claiming
a wiring that did not exist.

**Its stated cause has changed, and the entry is worth re-reading because of it.** The reason given
here was "its mention inside `drawColValue`'s comment is exactly what made two live helpers appear
to exist and produced defect #4". `drawColValue` is gone (see #4), so that particular trap is gone
with it — but `drawDetailValue` survived the deletion of the card that was its only plausible
caller, and it now sits between `formatClock()` and `drawSessionDetail()` looking like part of the
detail screen it is not part of. It is arguably **more** misleading than when this entry was
written, not less.

Lowest severity of the eleven — it draws nothing wrong because it draws nothing at all — and the one
item where **deletion is the whole fix**. Left alone here on this file's own standing instruction:
prefer recording accurately over fixing opportunistically, and there is nothing on the glass that
could show the result either way.

### 7. `reader.ino` — the same control bar splits its touch x differently depending on which screen drew it — **RESOLVED in `7e06ff0`**

Was: the three reader control bars split their x range at **78/156** in the history list and the
full-entry pager, but at **82/158** in the ask reader. Neither split was *wrong* on its own — both
merely handed the 8px gap between two keys to a different neighbour — but the same bar behaved
differently on different screens and nothing on screen said so, which is the kind of inconsistency
that makes a mis-hit look random.

**Fixed by deriving one pair and aliasing the other to it**, so they cannot drift apart again
(`board_e32r28t.h:1243`):

```
const int READER_TAP_1 = (READER_BTN_L_X + READER_BTN_L_W + READER_BTN_M_X) / 2;   // 82
const int READER_TAP_2 = (READER_BTN_M_X + READER_BTN_M_W + READER_BTN_R_X) / 2;   // 158
const int HIST_TAP_1   = READER_TAP_1,  HIST_TAP_2 = READER_TAP_2;
```

82/158 are the midpoints of the two gaps, which is the only pair giving each key its own half.
All six call sites in `reader.ino` (`:328`, `:329`, `:365`, `:366`, `:602`, `:607`) now read one of
those four names. The `KNOWN[1]` entry `reader tap splits agree across the three control bars
(78/156 vs 82/158)` is removed from `settings-geom-check.mjs` with a note in its place.

*Found by `settings-geom-check.mjs` in Task 8.*

### 8. `reader.ino` — the history chip's tap band claims 2px of the first list row — STILL LIVE, DEFERRED WITH THE COST

The chip's tap band is `sy <= HIST_CHIP_TAP_H` with `HIST_CHIP_TAP_H` = 24, i.e. rows 0..24, while
the rule it is drawn to is `HIST_RULE_Y` = 22. So the band reaches 2px past the chip and into the
first list row's territory. Verified unchanged at `060f458` (`reader.ino:320`).

**It stands, and the arithmetic is why — not a freeze.** The only way to end the band at the rule is
to *shrink* it to 22, and the band is already 25 rows tall against this board's own `TAP_MIN` of 40.
Taking a tap target that is already 15px under the fingertip floor down by another 3 to tidy it
would trade a real miss for a cosmetic one. Growing it instead runs it further past the rule, which
is this entry. The overlap costs nothing today: the first list row starts at `HIST_TOP` 28, still
3px clear, so no row is ever stolen.

**Why it is still unseen:** it is a touch band, not ink — there is nothing for a capture to show,
and board 1's history reader was never reached on the glass this session (see the count section).

*Tolerated as `chip tap band ends 24 above the rule, or it would claim the first list row`.*

### 9. `reader.ino` — "Asking the Mac..." sits at a literal 130 instead of its region's 147 midpoint — STILL LIVE

`HIST_EMPTY_CY` is a hardcoded **130** (`board_e32r28t.h:1186`, unchanged at `060f458`), which is not
the midpoint of the region it sits in (22..272 → **147**). It predates the control bar that shrank
that region, so it is 17px high in a screen whose every other offset is derived. Note that its two
header neighbours **were** derived in `7e06ff0` (`HIST_CHIP_CY`, see #10, and `HIST_HDR_TEXT_Y`,
which was 2px low for the same reason) — this one was not, because unlike those it is not one pixel
of alignment but a 17px move of a whole message, and moving it is a visible change to a screen
nobody has looked at on this board.

**Why it is still unseen:** the empty state needs board 1's history reader open *and* a page not yet
landed ("Asking the Mac...") or an empty result ("Nothing here"), and that screen was never reached
on this board's glass this session.

*Tolerated as `history empty-state y 130 is the midpoint of 22..272 (147)`.*

### 10. `reader.ino` — the filter chip's label is 1px above its own centre — **RESOLVED in `7e06ff0`**

Was: `HIST_CHIP_CY` a literal **13** where the chip runs `HIST_CHIP_Y`..`+HIST_CHIP_H` = 4..20, whose
centre is `4 + 17/2` = **12**. Now the expression itself (`board_e32r28t.h:1171`):
`const int HIST_CHIP_CY = HIST_CHIP_Y + HIST_CHIP_H / 2;` — the same derivation
`settings-geom-check.mjs` was already comparing the literal against, and the one board 2 has always
used. `HIST_HDR_TEXT_Y` is derived from it in turn (`HIST_CHIP_CY - CODE_LINE_H / 2` = 6, where it
had been a literal 8), which fixed the header name and position fields sitting 2px low in the same
pass. The two `KNOWN[1]` entries are removed with a note in their place.

Invisible at this size, then and now — this is a fix nobody will ever see, which is why it was worth
doing only once the constraint that made it expensive was gone.

### 11. `reader.ino` — the filter chip is under `TAP_MIN` in WIDTH, in only one of its two states — STILL LIVE AS AN ASSERTION, BUT ITS PREMISE IS DOUBTFUL

`HIST_CHIP_W_CHAT` is 40 and `HIST_CHIP_W_ALL` is **32**, against a `TAP_MIN` of 40, and
`settings-geom-check.mjs:4309` still asserts `chip widths 40/32 both clear TAP_MIN 40` with the
failure allowlisted. All three constants are unchanged at `060f458`.

**CORRECTED 2026-09-05, and this is the part to read before fixing anything:** those two constants
are the **DRAWN** pill, not the tap target. `reader.ino:320` tests
`sx < HIST_CHIP_TAP_W`, and `HIST_CHIP_TAP_W` is **76 in both states** — the header's own comment
says the split is deliberate ("the chip's TAP band is deliberately larger than the chip: 24 tall
against 17 drawn, 76 wide against 40"). So **no tap target narrows when the label reads `ALL`**;
what varies is 8px of pill. The claim that the chip "falls 8px short the moment it reads ALL" is
measuring a drawn pill against a fingertip floor.

That is precisely the class of assertion this checker **deleted at the site** one entry over: the
comment above `KNOWN[1]` records that `history filter chip 17px drawn >= TAP_MIN 40` was struck
because it "excused the DRAWN chip against the fingertip floor, which was never the rule — the
TESTED band is". By that reasoning the width assertion beside it is the same shape, and the chip's
real touch shortfall is the 25px band already recorded separately (`history chip tap band 25px >=
TAP_MIN 40`, and #8 above). **Recorded rather than acted on**, deliberately: deleting a live
assertion and its allowlist entry is a checker change, this file's job is the record, and the drawn
width is at least a true measurement of a real thing even if it is compared against the wrong floor.
Whoever picks this up should decide between correcting the comparison and deleting the assertion —
not simply widen the pill.

The chip is separately under the floor in *height* at 17px drawn, but that one is a deliberate,
commented compromise: the list above and the control bar below own every other row.

*Found by the assertion added in Task 8's fix round, not by reading — which is the argument for
having written the assertion.*

## The defects that WERE fixed, and why none of that was inconsistent

**The farewell screens (board 2 only, fixed during the port).** The `delay(1200)`/`delay(1500)` ran
**before** the flush, so on board 2 the dwell displayed the *previous* screen and the goodbye
message existed in memory for zero frames. Fixed there, unlike everything above, for one reason: it
is board-2-only, so the byte-identity argument did not apply — and the behaviour existed only
because the port introduced the deferred-flush model, which makes it the port's own bug rather than
a pre-existing one.

**#2, #3, #7 and #10, fixed on `compose-surface`** (`924cecc` and `7e06ff0`), because the argument
that had been holding them was retired rather than worked around. Two shared-code defects had
already moved board 1's binary on purpose before that — the history list going blank after reading
one entry, and the PAIRED MACS row's invisible live marker plus two same-named Macs rendering
identically — and neither was in the eleven. Board 1's binary has moved from 1382802 to **1414288**
across this branch, every step re-baselined with a stated reason. That was always the point:
**a change to board 1 must not be a SURPRISE, not that board 1 must never change.**

**One byte-identity justification that is fixed, and one class that is not.** Every `KNOWN`
allowlist entry that cited "board 1's binary is held byte-identical" now carries a reason that is
true today, and `docs/reference/commands-and-checks.md` states the rule that nothing may still cite
it as the reason a board-1 defect stands. **That rule is not yet met in the firmware's own
comments** — `deckhand_display.ino:6444` still gives "board 1's binary is held byte-identical" in
the present tense as `READTEST`'s reason for being board-2-only, and roughly a dozen other comments
across `sessions.ino`, `reader.ino`, `power.ino` and `deckhand_display.ino` do the same. None
changes behaviour and none is on this list; they are recorded here because a comment is not parsed,
so nothing can catch prose that has stopped being true. (`READTEST`'s user-facing *refusal string*
is already correct: it says the guard is all that stops it and puts the freeze in the past tense.)

## What the geometry checkers do with these

`usage-geom-check.mjs`, `sessions-geom-check.mjs` and `settings-geom-check.mjs` each carry a `KNOWN`
list of board-1 shortfalls they tolerate, so they can pass on board 1 while still asserting the rule
for board 2. That list is honest rather than a silencer: **`KNOWN[2]` is empty in all three**, so
board 2 passes on its own merits and a tolerance can never hide a board-2 defect.

Live at `060f458` — run the checkers for the authoritative count, this is what they print:

| checker | `KNOWN[1]` | tolerated at run time | `KNOWN[2]` |
|---|---|---|---|
| `usage-geom-check.mjs` | 3 (`KNOWN_OVERLAPS`) | 3 of 359 | empty |
| `sessions-geom-check.mjs` | 8 | 9 of 2104 | empty |
| `settings-geom-check.mjs` | 11 | 11 of 1177 | empty |

`sessions` tolerates 9 against 8 entries because one entry is reached at two assertion sites; that
checker's `chk(cond, msg, allow)` takes the allowance as an argument (`isKnown(b, …)`) while the
message it prints is a template, so the printed count is *tolerations*, not entries. `settings`
matches its messages exactly and the two numbers agree.

**Ten `KNOWN[1]` entries were removed on this branch and none was added** — `sessions` went 13 → 8
and `settings` 16 → 11 — and every one was removed *with a note in its place saying what happened*, because an
allowlist entry matching no message the checker can emit is the same defect as an assertion that
cannot fail, on the allowlist side of it. Two of those removals were **stale rather than fixed**
(`action button 38px tall >= TAP_MIN 40`, `history filter chip 17px drawn >= TAP_MIN 40`), found by
the converse check `settings-geom-check.mjs` now runs over its own allowlist — the mechanism worth
keeping, since it caught one the day it was added.

**Not every `KNOWN` entry is a defect from this list, and the distinction is in the comments beside
them.** Some are deliberate, previously-argued compromises — the pager key at 34px tall, the history
chip's 25px tap band, the 16px scrubber band, the two counted-lane last-character overruns, the
stepper's −1 label-to-value gap, `DROW_BATT_VAL_DY` — where the entry's own comment already explains
the trade. Only #1, #8, #9 and #11 of the entries above are still on an allowlist.

Fixing an item here means **deleting its `KNOWN` entry in the same commit**. Otherwise the checker
keeps tolerating something that is no longer there, and will not notice it coming back.

## 12. RESOLVED — `CODEX_RIGHT_CHARS` could be exceeded by its own content, on BOTH boards

Was: `renderCodexRow()` padded its right-hand field to `CODEX_RIGHT_CHARS` (20), but the string it
formatted — `"%d%%  %s  %02ld:%02ld"` with `formatResetIn()`'s multi-day branch, e.g.
`"0%  6d 23h left  22:55"` — ran to about 23-24 characters. `padLeftTo()` refuses an oversized
width rather than truncating (deliberately, and documented), so the real string simply drew wider
than the lane arithmetic assumed, and the right field's clear box — drawn AFTER the label on every
tick — could reach far enough left to erase the tail of the `CODEX …` label beside it.

This entry used to say "not fixed because the fix moves board 1's frozen constant" — true when
written, and no longer true: board 1's byte-identity requirement was retired for `board-baseline.mjs`
(see the top of this file), which expects deliberate movement re-baselined with a stated reason.
Fixed by dropping the right field's wall-clock suffix (the countdown beside it already says the
same thing in relative terms), which takes its real worst case from ~24 characters down to 18, and
by shrinking `CODEX_RIGHT_CHARS` to 18 alongside it so the pad width is a genuine ceiling on that
worst case again rather than a floor mistaken for one. `CODEX_LANE_CHARS` moved 11→13 (board 1) and
12→14 (board 2), and `usage-geom-check.mjs` now asserts `CODEX_RIGHT_CHARS <= worst` directly, so a
regression fails by name rather than waiting to be found again. Both baselines re-derived.
**Still true at `060f458`:** `CODEX_RIGHT_CHARS` is 18 on both boards, `CODEX_LANE_CHARS` 13 and 14.
