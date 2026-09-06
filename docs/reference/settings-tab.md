# SETTINGS: board 2's HOME screen and six groups

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

#### SETTINGS on board 2: a HOME screen and five groups, where board 1 keeps its chevron pager

Board 1 keeps its prev/next pager (**five** pages now — see the MESSAGES note at the foot). Board 2 opens SETTINGS on **HOME** —
five cards, one per group (Status, Display, Sound, Pairing, Actions), each carrying the group's
name, a **live summary of what is inside it**, and a plain ASCII `>` (Spleen declares
`0x20..0x7E`, so a real chevron glyph would draw as nothing at all — the trap this repo has now
paid for four times). Tapping a row opens that group and the pager band becomes a **back band**.
The guard is `BOARD_SETTINGS_HOME`, 1 in `board_es3c35p.h` and 0 in `board_e32r28t.h`.

**THE BAND KEEPS THE PAGER'S HEIGHT, AND THAT IS WHY THIS WAS AFFORDABLE AT ALL.** `PAGE_TOP` is
`CONTENT_Y + PAGER_H + 4` = **104 on both boards and did not move**, so every group body starts
exactly where a page body already started and **not one existing derivation had to be re-done** —
the four page bodies drop in under the new band unchanged, and the group work that followed was
about what those pages CONTAIN rather than about where they begin. The back key is the pager's own
`PAGER_BTN_W`, so the two boards' chrome stays one size; unlike the pager there is nothing else in
the band, so the WHOLE band is the back target and there is no 45/55 split to leave a dead zone in.
HOME itself has no band — the tab bar already says SETTINGS and a second title would be chrome
repeating itself — so its five rows own the whole content area, pitched to land exactly on
`contentBottom()`: `HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT` = 54 + 350 + 48 + 8 = 460.
The checker asserts that IDENTITY rather than the number, which is what makes a row-height change
fail here instead of silently eating the bottom row.

**`settingsPage` CARRIES HOME RATHER THAN A SECOND STATE VARIABLE.** `SET_HOME` is 0 and the five
groups are 1..5, so one integer says which screen is up. Two variables tracking one screen is how a
UI comes to draw one page while hit-testing another — and this tab already has the ingredients for
that failure, since `handleSettingsTouch` dispatches on the same value `drawSettingsStatic` draws
from. It also makes the six ids an ordinal RANGE rather than a set of names, which three places
depend on and all three fail SILENTLY: `drawSettingsHomeStatic()` and the HOME hit test both walk
`SET_STATUS + i` for `i < SET_GROUP_COUNT`; `openSettingsGroup()` clamps with
`constrain(g, SET_STATUS, SET_ACTIONS)`; and **`int settingsPage = 0;` is SHARED with board 1**, so
the device boots into whichever id happens to be zero. `settingsGroupTitle()` names four cases and
returns `"Actions"` from its `default`, so an id that drifts out of the run does not error — it
draws a row labelled Actions that opens something else.

**THE TAP COST: up to three chevron presses became exactly one, and ZERO for the questions HOME's
summaries already answer.** Reaching PAIRED MACS from STATUS was three `>` presses with no way to
skip; every group is now one tap from HOME. The summaries are composed each tick from the same
globals the group's own page draws from — nothing is stored, so they cannot disagree with the page
you open — and they carry the things people actually come to SETTINGS to check: `Both links up
84% 46 C`, `90% sleep 30s AUTO`, `ON volume MED mic`, `2 Macs any may answer`. Status's summary
is the one that changes colour, and **the phrase says which state it is on its own** ("Both links
up" / "One link up" / "No link"), so the colour supports the words rather than carrying them.
**The honest cost is the adjacent case:** moving between two groups is back-then-in, two taps,
where the pager moved to a neighbouring page in one. That is the trade — a flat list of four pages
you page THROUGH, against a menu you address DIRECTLY — and it was taken knowingly.

**Two things MOVED between groups, and both were DUPLICATION rather than taste.** The per-Mac rows
left Status for Pairing, where the Macs already were: `DROW_MAC0`/`DROW_MAC1` were spending 48 of
the old DEVICE card's 200 rows re-stating, in a different format, a list the Pairing page draws in
full — and that duplication is what made Status the one settings page with no slack.
`renderMacLinkRows()` is board 1's alone now. And **MIC TEST left Actions for Sound**, because a
mic test is a sound test and it is the one action you run repeatedly rather than once; that is what
took Actions to three buttons and left room for its two captions and the air between them. So
`P2_MIC_Y` does not exist on board 2 at all — the checker asserts its ABSENCE rather than merely
not reading it, because a constant a draw site no longer uses but a hit test still does is exactly
how a page comes to claim taps for a button it does not draw.

**THE SEVERITY SPINE ON ACTIONS, and it exists because that page was breaking this file's own
rule.** All four action buttons were `uiButton(..., filled = false)` — identically shaped outlined
slabs differing only in STROKE HUE — on a device where session status gets a filled square, a
hollow ring and a distinct mark, and where `palette-check.mjs` tests the palette for greyscale and
colour-blind separability precisely so that meaning is never carried by colour alone. The action
buttons, which are the only controls on the device that destroy state, had never had that
treatment. A solid `P2_SPINE_W` (4px) bar down the left edge of each destructive button carries
severity as **ink mass**; the two captions ("SETUP", "CANNOT BE UNDONE") and the wider
`P2_SECTION_GAP` between the sections carry it as **position**; colour is then the third cue rather
than the only one. What keeps the bar off the button's corner arcs is its Y-INSET, not its width —
it runs from `R_MD` to `P2_BTN_H - R_MD`, so no width could reach an arc. **The greyscale claim is
ARGUED, not measured:** `palette-check.mjs` can test a colour pair and there is no instrument in
this repo that tests a SHAPE, and nothing in this branch has been on the glass.

**A COMMENT IS NOT PARSED, so a flag that flips under it leaves prose describing a page that no
longer compiles.** `board_es3c35p.h:1689` opened "THREE buttons, not four: `BOARD_HAS_MIC` is 0
here, so there is no MIC TEST and no slot reserved for one", and **line 18 of the same header
says `#define BOARD_HAS_MIC 1`**. The whole arithmetic chain went with the premise: `3 * 50 +
2 * 12 = 174`, the hint at 302, 148px clear below it — against a real four-button page whose hint
sat at 364 with 86px clear. Nothing could have caught it: every checker in this repo parses
`const int` declarations and macros, and a comment is neither. It is worse than a wrong number,
because it is the paragraph a reader consults BEFORE the constants, and its arithmetic was
internally consistent — the sort of wrong that survives review. The sharpest part is that an
earlier revision of that same paragraph had ALREADY been corrected once, for copying board 1's
four-button chain onto a three-button page; the flag then flipped and drifted it back, in the
opposite direction. Fixed in the first commit of this branch — and then made moot by the redesign,
which took the page to three buttons for a different reason entirely.

**Five findings from the four reviews, kept because each names a CLASS rather than an instance:**

- **THE SPINE'S ASSERTIONS CONSTRAINED CONSTANTS WHILE THEIR COMMENT CLAIMED THEY CONSTRAINED THE
  DRAW CALL.** `settings.ino` said "settings-geom-check.mjs asserts both bounds"; the reviewer did
  not argue it, they rewrote the draw site to `uiFillRound(CARD_X, y, P2_SPINE_W, P2_BTN_H, ...)` —
  spine flush to the card edge, full height, crossing both corner arcs and painting over the very
  stroke it exists to reinforce — and the checker reported **ZERO failures**. The exact defect the
  assertion was written to prevent, surviving it. Same family as "a text-matching test cannot watch
  the preprocessor delete the line it just found" (`panel_shim.cpp`'s `invertColor` re-apply). Fixed
  by PARSING `drawSeverityAction()`'s own `uiFillRound(...)` arguments out of `settings.ino`,
  brace-balanced with comments stripped, and resolving each token through an `evalInt` now EXPORTED
  from `geom-common.mjs` rather than copied — the precedent `sessions-geom-check.mjs` already set
  for the TYPE chip's hit test. The mutation now fails three assertions by name.
- **TWO VACUOUS ASSERTIONS, both the same shape: a derivation asserted against its own term.**
  `PS_SOUND_Y - PS_ALERTS_Y === SET_CAP_STEP` compared a value DERIVED as `... + SET_CAP_STEP`
  against `SET_CAP_STEP`, so it held by construction — `SET_CAP_STEP` 24 → 26 produced zero
  failures. And `floor(w/2)*2 <= w` is true for every non-negative integer. **The test is not "does
  the assertion pass" but "can it FAIL"**, and a derivation compared with its own term never can.
  Both were replaced with the constraint they were standing in for (a caption's own text box must
  clear the control it heads; a rounded end radius must fit the DRAWN bar).
- **A TRANSCRIBED CONSTANT CERTIFIED A DESTRUCTIVE CONTROL AGAINST THE OTHER BOARD'S FINGERTIP
  FLOOR.** `P3_X_W` — the "forget this Mac" hit zone — was asserted `>= 40` inside an `if (b === 2)`
  block, on the line directly after one that correctly used `c.TAP_MIN`. 40 is **board 1's**
  `TAP_MIN`; board 2's is 46, so the zone was 6px under this board's own floor while its header
  comment claimed ">= a fingertip". The number being small was not the defect — transcribing was;
  a parsed assertion would have been right on both boards without anyone noticing the difference.
- **BOARD-1 SAFETY WAS PROVEN BY DIFFING BOARD 1'S VIEW, which is stronger than the hash.** Two
  revisions of both shared `.ino` files were preprocessed at board 1's real macro values and
  diffed: byte-identical once `//` comments are stripped, at every task. That says WHY nothing
  moved rather than only that nothing did, and it would catch a re-indent of board 1's arm that
  happened to compile to the same bytes today. Two traps in doing it: **`unifdef` SILENTLY NO-OPS
  with multiple `-D` flags** (exit 0 means "output identical to input", so it reports success having
  done nothing), and **resolving `BOARD_SETTINGS_HOME` alone is not enough** — the
  `#if !BOARD_USES_TFT_ESPI` arms survive and produce a FALSE 138-line diff. All eight macros
  appearing in conditionals in those files have to be resolved. The sanity check that a resolver is
  not vacuous is that it DELETES code: `settings.ino` goes 1500 → 710 lines.
- **`geom-common.mjs`'s `consts()` regex is LINE-ORIENTED, so a `const int` split across two lines
  parses as nothing** and every constant in it comes back `undefined`. An assertion on an undefined
  constant does not fail loudly — it computes `NaN` and passes or fails meaninglessly. The task
  brief's own code was formatted that way, so six page ids would have been unparsed; caught by the
  implementer, re-verified by the reviewer across both board headers and `deckhand_display.ino`
  (no other multi-line declarations exist, so this is not a pre-existing hole). The parser is
  line-oriented and nothing announces when it silently skips a declaration.

**GUARDS, and the one gap this branch created for itself.** `settings-geom-check.mjs` went 990 →
1700-odd lines and now **PRINTS ITS OWN ASSERTION COUNT**, as do the other two geometry checkers —
this paragraph used to transcribe "548 assertions" from a checker that printed no total at all, so
the figure was a hand count of `ok` lines plus the known-shortfall lines, against this file's own
rule that a checker states its count rather than having it copied into prose (the same rule
`--pace-check` already follows). Run it for today's number. `--selftest` injects **two** faults
and exits 0 only when EACH is caught by the assertion that exists for it, matched by message rather
than counted — with two faults in flight a bare total cannot tell "both caught" from "one caught
twice". The second injection is `HOME_ROW_H + 1`, the smallest change there is: HOME's rows are
pitched to land exactly on `contentBottom()`, so one extra row of card height puts the fifth row 5px
under the footer while every individual row is still inside its own card and still a touch target —
nothing measuring ONE row can see it, which is the point of asserting the identity.
Two gaps the sweep found and this task closed, both in constants the branch itself had added or
moved. **`P2_HINT_Y` lost its ±16 guard as a CONSEQUENCE of levelling**: it is the last thing on the
Actions page, so unlike every other block it is pinned from one side only, and taking `P2_TOP`
16 → 12 gave the page 8 more rows of trailing air and widened its `above < below` slack from 32 to
40. It is pinned now by the STEP a `T_META` label takes from the control it is bound to —
`SET_CAP_STEP`, which is that step everywhere else in this redesign — and asserted against
`SET_CAP_STEP` rather than against `P2_HINT_GAP`, which is how `P2_HINT_Y` is derived one file over:
routing through the other constant is what makes it able to fail, and it guards `P2_HINT_GAP` for
free. (The datums differ, so it is a step-for-step equality and NOT an equal air gap — the caption's
ink stops 8 rows above the button it heads, the hint's starts 18 rows below the one it explains.
Stated at the assertion, because a reader who wants the INK equal has to move `P2_HINT_GAP` and
re-derive.) And **the six page ids plus `SET_GROUP_COUNT` were read by no checker at all** — not
geometry, which is exactly why they were missed, but load-bearing in the three silent ways above.
All nine now fail by name at ±1 in both directions.

**A SIXTH FINDING, FROM THE WHOLE-BRANCH REVIEW, AND IT IS THE ONE CORRECTNESS BUG: A LIVE FIELD
DREW A CONTROL INTO CHROME THAT DID NOT EXIST.** `renderHostsPage()` walks `i < hostCount` every
tick and `drawHostsPageStatic()` draws the card, the name and the `x` — but `upsertHost()` repaints
nothing, so a Mac pairing **while the Pairing group is open** raised `hostCount` between the two.
The next tick painted a live dot and a state line onto bare page background at
`p3RowY(hostCount - 1)`, and `handleSettingsTouch` walks the same `hostCount`, so the right end of
that invisible band raised `CFM_FORGET_HOST`: **a row you cannot see that forgets a Mac when
tapped.** The count is a cache like every other field on the page now, and a change repaints the
chrome first. **The class is "a change-only field whose CHROME is count-dependent needs the count
in its cache"** — the change-only discipline this file is built on assumes the chrome is static,
and every previous instance of it was. The other two live groups were audited against the same
rule and are safe by construction: Status draws exactly three cards and HOME exactly
`SET_GROUP_COUNT` rows, neither derived from anything that can move at runtime.

**AND THE MOCK IS BOUND TO THE HEADER NOW.** `docs/design/settings-redesign/check.mjs` checked the
PICTURE — ASCII-ness, panel bounds, footer clearance — against a hand-transcribed `K` table nobody
compared to `board_es3c35p.h`. A committed spec whose numbers can drift while it still reports
"50/50 passed" is the same class as an assertion that cannot fail, and it is the class this branch
has now paid for three times. It parses the header through the geometry checkers' own `consts()`
and asserts all **87** shared constants by name; the four before-picture screens keep the replaced
page's geometry in a separate `WAS` table that is deliberately unbound, with a rule that every
entry there must actually DIFFER from what ships, so a live constant cannot be parked in it to
escape the bind. Proven by injection: `SET_CAP_STEP` 24 → 25 in the header fails 15 assertions by
name, all the way down the derivation chain.

**COST, MEASURED.** Board 2 **+1,696 bytes of flash and +296 RAM** across the whole branch
(992,122 / 65,604 → 993,814 / 65,900) — the final fix round gave 160 bytes back, mostly by routing
all seven group captions through one `drawGroupCaption()` instead of six inline copies of the same
four lines. **Board 1 is `UNCHANGED` at every commit** —
`0cc2e77b66fb6947...`, size 1,387,200 — which is the only reason the scoping is what it is: every
shared-code change is an `#if BOARD_SETTINGS_HOME` around text board 1 never sees.

**WHAT IS NOT VERIFIED, stated plainly. NOTHING IN THIS BRANCH HAS BEEN ON THE GLASS** — no device
was attached for any of the five tasks. The evidence is the three geometry checkers, the sweep, the
committed pixel-accurate mock (`docs/design/settings-redesign/`, `node check.mjs`, which now also
binds every constant it shares with the board header), and
board 1's baseline; all of it is arithmetic and bitmaps, which is the right instrument for layout
and the wrong one for colour. **`SCREENSHOT` could not settle colour here even with a device
attached**, because on board 2 it reads the shadow framebuffer (see the verification trap under Two
boards); `COLORTEST` is the instrument, and the severity spine's greyscale claim needs a person
rather than either. Also unverified by execution: every touch path on HOME and in the five groups,
since the device deliberately has no remote tap.


---

## MESSAGES: the first device setting that reaches the Mac, added 2026-09-06

**Theme, brightness, sleep and sound all change what this panel does; this one changes what the
MAC does with what the panel sends** — so it is the first setting on the device that needed a
channel off it at all. It chooses the `priority` on the session-inbox frame
(`now` | `next` | `later`, default `next`), travels as `MSGPRI <word>`, and is stored in NVS
under `msgpri` alongside `theme`.

**It is a WHOLE PAGE on both boards, and that is arithmetic rather than taste.** Board 1's page
region is `PAGE_TOP(80)..contentBottom(302)` = 222px and not one of the four existing pages has
40 spare rows: page 1 is over-subscribed by its own comment's admission (208 of 222, 14px for
five gaps), page 2 is four buttons and a hint, page 3 is four Mac rows ending at 298. So board 1
gained a fifth page, which costs one `titles[]` entry and one pager dot and moves nothing.
Board 2 had the same problem — Display ends 446, Sound 448, Pairing 450, Status 456 — so it
gained a **sixth HOME group**, and **the sixth row was paid for out of the other five**:
`6*HOME_ROW_H + 5*HOME_GAP + HOME_Y0_BOT = 406` lands exactly at 58/10/8, against the old
70/12/8 for five. The 12px per row comes out of the two pads inside it, never out of the two
type sizes — the name is still T_HEAD 24 and the summary still T_BODY 16 — and 58 is still 12
over `TAP_MIN`, so the row got shorter, not harder to hit. Measured on both boards' glass.

**THREE `uiListRow`s, NOT the THEME control's three segments**, and the departure is deliberate.
THEME's segments share one row because their labels are one word each and the choice is about
the screen you are looking at. These three need a PHRASE each — "after this turn" IS the content
of the setting — and a 96px segment cannot hold one. `uiListRow` is the component this device
already uses for a mutually-exclusive choice that needs a line of its own, on the Pairing group's
ANY MAC row. It also makes the hit boxes unmistakable: three full-width rows with a positive gap
between them, where three abutting segments would put NOW and LATER on either side of a 4px seam.
The gaps are INERT, and the tested band is exactly `H_ROW` (which is `TAP_MIN` on both boards) —
never `P4_ROW_STEP`, which would hand a tap that landed on nothing to the row above it.

**The hint is the PRECEDENCE RULE and it earns its line.** `DECKHAND_INBOX_PRIORITY` on the Mac
overrides whatever is chosen here, and without "the Mac can override this" on the glass the
failure is the worst kind available on a device with no error channel: you tap LATER, the Mac
keeps sending NEXT, and nothing in the room says why. The host says so too, at the moment the tap
arrives rather than on some later delivery nobody is watching —
`Inbox: Deckhand-0528 asks for "later" (but DECKHAND_INBOX_PRIORITY=next overrides it, so its
messages still land at "next").` Both surfaces exist because only one of them is in the room.

**The trailing air is NAMED, and geom-sweep is why.** Board 2's page carries 80 rows of slack
under the hint, and with only "the hint clears the last row" and "the hint clears the footer" as
rules, `P4_HINT_Y`, `P4_ROW_GAP` and `P4_HINT_GAP` could each move by 16 in either direction with
nothing noticing — the sweep reported all three as *unguarded though this checker reads it*. A
page with enough air in it is a page whose constants are constrained by nothing. `P4_AIR_BOT`
names the surplus and `settings-geom-check.mjs` asserts the SUM (`hint ink bottom + 1 +
P4_AIR_BOT == contentBottom()`), the same thing `HOME_Y0_BOT` does for HOME's pitch. Board 1: 29
rows. Board 2: 80.

**REACHING THE HOST NEEDED TWO MECHANISMS, NOT ONE, AND THE SECOND WAS MEASURED RATHER THAN
REASONED.** The device announces `MSGPRI` at boot and on `WHOAMI` — `WHOAMI` because it exists
for exactly this hole, `HELLO` being a boot-only 15s burst that a host attaching later never
hears. It is deliberately NOT in the burst itself: that would be eight extra lines per boot on an
11.5KB/s link to repeat something that has not changed. **But the host only ASKS `WHOAMI` while a
link is still ANONYMOUS**, so a host that attaches *during* the burst is named by `HELLO`, never
asks, and misses the one `setup()`-time announce. That is not hypothetical: on board 2's first
flashed boot, board 1 reported on two host restarts and **board 2 reported on none**, and a bare
`MSGPRI` answered instantly. So the host's `HELLO` arm now asks — `sendToLink(helloLink,
"MSGPRI\n")` — guarded on not already having one, because that arm runs for every `HELLO` in the
burst. Re-measured after the fix: both boards report on every attach.

**Per device, keyed and pruned exactly like `battByDevice`.** Two boards can disagree and the
priority applies to messages *from that board*; a global would let whichever spoke last decide for
both, which is the defect a single `lastBatt` had. `forgetMsgPriorityFor()` drops it when the last
link feeding it closes — unless the same device is still reachable on another link, the ordinary
cabled-and-BLE case — and `boundMsgPriorityStore()` caps it, because an unnamed link keys on its
port path and ports renumber.

**The host arm's GUARD IS THE ACCEPTANCE TEST**, not a `"MSGPRI "` prefix with the test nested
inside it, and `commands-check.mjs` is what caught the first draft. Every verb can emit
`<VERB> refused on <board>: <cause>`, `"MSGPRI refused on ..."` starts with `"MSGPRI "`, and a
prefix arm that returns would eat it — the BLEMTU defect exactly. Written the other way the
refusal falls through to the general `[device/...]` log in the device's own words. Measured:
`[device/usb:Deckhand-0528] MSGPRI refused: "zzz" is not one of now|next|later - unchanged at
later`. A cabled board prints it twice (USB and BLE both received the bad command); that is
tolerated rather than deduped, because each transport did receive it and the line is short and
says the same true thing.
