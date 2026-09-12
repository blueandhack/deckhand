# SETTINGS redesign: five groups, one surface, both boards

Status: **design approved, not implemented.** Nothing in this document has been on the
glass or through a compiler. Every number below is either parsed from a board header
today or derived here and marked as *to be asserted* by `settings-geom-check.mjs`.

Supersedes the structure described in [`docs/reference/settings-tab.md`](../../reference/settings-tab.md),
which stays as the record of how the tab got here. Correct that file in place when this
lands; do not delete what it says about the seven-group version.

---

## Why

SETTINGS grew by accretion. HOME opened as **five** cards at a `70/12` pitch, MESSAGES took
it to **six** at `58/10`, and About took it to **seven** at `50/8`. Each new group was paid
for out of the row height of the other six, entirely out of their internal pads. That is a
ratchet with no stop on it, and the next group has nowhere left to come from.

The group set is the reason the list is long, and two facts make the case without appeal to
taste:

| group | controls | verbs | read-only rows |
|---|---|---|---|
| Status | - | - | conn, power, host, 4 diagnostics |
| Display | brightness, sleep, theme, flip | - | - |
| Sound | sound toggle, volume | TEST BEEP, MIC TEST | - |
| Pairing | "any may answer" | forget Mac, pair | Mac list |
| Messages | now/next/later | - | - |
| About | - | - | build, time, commit, board, MAC |
| Actions | - | CALIBRATE, RESET PAIRING, POWER OFF | - |

**Two of the seven groups hold no setting at all** (Status, About), and **Actions is a bag of
verbs that each belong to another group** - which this repo already half-conceded when MIC
TEST left Actions for Sound on the grounds that "a mic test is a sound test". Applying that
precedent consistently dissolves Actions.

**And board 1 cannot follow.** Its content area is `CONTENT_Y(34)..contentBottom(302)` = 268px
against `TAP_MIN = 40`. Seven rows at zero gap and zero bottom pad is 38px each - under the
fingertip floor before a single pixel of gap. So "bring board 1 into line" and "the group set
shrinks" are one requirement, not two.

## What changes

**Five groups, one surface, both boards:**

    Device | Display | Sound | Macs | Messages

`BOARD_SETTINGS_HOME` is **deleted**, not flipped - all 28 sites in `settings.ino` and
`deckhand_display.ino` go, and the `#if`/`#else` page-body pairs collapse to one
implementation each. Per-board geometry stays in the two headers, where CLAUDE.md requires it.

---

## 1. HOME

### Board 2: back to the pitch it was designed at

The five-row identity `HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT == contentBottom()`
closes at `54 + 5*70 + 4*12 + 8 == 460`. That is the **original** five-row pitch, before
MESSAGES and About eroded it. `HOME_ROW_H` 50 -> 70, `HOME_GAP` 8 -> 12, `HOME_Y0_BOT` 8
unchanged; `HOME_NAME_DY` and `HOME_SUB_DY` revert to the 70px stack.

### Board 1: derived, with margin

HOME has **no band above it** - the tab bar already says SETTINGS - so the area is
`CONTENT_Y(34)..contentBottom(302)` = 268px, not the 222px a *page* gets. With `HOME_Y0 = 42`
(the same 8px pad board 2 uses):

    HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT == contentBottom()
    42      + 5*46         + 4*6        + 6           == 302

46 is `TAP_MIN + 6`. Inside a 46px row, mirroring board 2's proportions:

    +0..+1    border
    +6..+23   name    (T_HEAD, Terminus 10x18)
    +24..+27  gap 4
    +28..+40  summary (T_BODY, Cozette 6x13)
    +41..+43  pad
    +44..+45  border                             = 46

Four things to assert, the same four board 2's stack asserts: the name clears the top border
(6 >= 2), the summary clears the bottom border (40 <= 43), the two lines share no pixel row
(23 < 28), and the pitch identity above.

`HOME_SUB_CHARS` on board 1 is **derived from the lane**, not copied from board 2's 30: from
`CARD_X + PAD` to the chevron's left edge, divided by Cozette's 6px advance, less the air the
board-2 derivation leaves. A transcribed character cap is the defect class this tab has paid
for with `P3_X_W`.

### Nothing in board 1's page bodies moves vertically

`PAGE_TOP` is `CONTENT_Y + PAGER_H + 4` = 80, and the **back band takes the pager's height
exactly**, as it does on board 2. That is the property that made board 2's version affordable
and it does the same favour here: the four existing page bodies drop in under the new band
unchanged.

### Order, and the rule it breaks

`Device` first because it is what you glance at; `Messages` last of the informational groups.
**This reverses a written rule.** `board_es3c35p.h` says Actions stays last because "a
destructive group in the middle of a menu is the one thing this list's order actually has to
protect." Dissolving Actions puts POWER OFF inside Device (row 1) and RESET PAIRING inside
Macs (row 4).

**The protection moves from menu order to page position**: each destructive control is last on
its page, under a `CANNOT BE UNDONE` caption, keeping its `P2_SPINE_W` severity spine and its
confirm dialog. The argument for the move is that adjacency to the control beats a property of
a list you have already left. It is a knowing reversal and the reference doc must say so.

### Two stale comments, fixed on the way

Both are the "a comment is not parsed" class this tab has already paid for with
`BOARD_HAS_MIC`:

- `board_es3c35p.h:1830` carries the **six-row** derivation under today's constant names
  (`6*HOME_ROW_H + 5*HOME_GAP ... = 54 + 348 + 50 + 8 = 460`). 348 and 50 are the old `58/10`
  pitch. It sums to 460, so it reads as correct.
- `board_es3c35p.h:1856-1862` draws the **58px** row stack (`= 58`, "against the 70px row")
  above a `HOME_ROW_H` of 50.

## 2. The five pages

Board 2's group body is `PAGE_TOP(104) + 12 .. contentBottom(460)` = **344px**. Board 1's is
`PAGE_TOP(80) + 12 .. contentBottom(302)` = **210px**.

### Device

Absorbs Status, About and POWER OFF. Costed naively it wants 438px into board 2's 344 and
299px into board 1's 210, so two compressions are load-bearing:

**(a) Nine facts you read almost never become four dense lines.** The four HOST diagnostics
(payload bytes, flush ms, uptime, live Macs) live in a 92px card as two two-column rows; the
five About facts are five `uiListRow`s at 46px apiece under their own caption and hint, ~324px
of page. They collapse together under one `DIAGNOSTICS` caption into four monospace lines in
two columns - both faces are monospace, so column alignment does the work the row chrome was
doing. **~416px becomes ~92**, and both figures are estimates to be replaced by the derivation.

**(b) The two live cards slim to one line each**, 112 -> ~70:

- CONNECTION keeps its verdict hero and its transport/age line. It **sheds**
  `deviceName, N paired` - the name half is a fixed fact that belongs in DIAGNOSTICS and the
  count half belongs on Macs.
- POWER keeps its percentage hero and its charging/time line. It **sheds** the SoC temp line
  into DIAGNOSTICS.

Then: CONNECTION (~70) + POWER (~70) + DIAGNOSTICS (~92) + POWER OFF block (~86) + gaps.
Board 2 lands **~10px over 344**, to be closed inside the pads during implementation.

**If it will not close, come back rather than shrink a face.** `board_es3c35p.h`'s own rule:
"shrinking a face to fit one more row is how a menu becomes unreadable one row at a time."

**Board 1 carries less on this page, and the reason is written down.** The HOST diagnostics
"earn their place on this board specifically because there is no serial console in normal
operation here" (board 2). Board 1 has a CH340 console, so its Device page is CONNECTION +
POWER + POWER OFF, with the firmware facts reachable over serial and via `WHOAMI`. This is a
deliberate per-board content difference, not an oversight, and the reference doc must say so.

### Display

Brightness stepper, sleep stepper, THEME segments, SCREEN FLIPPED toggle. On **board 1 only**,
`CALIBRATE TOUCH` under a `SETUP` caption.

Board 2 drops CALIBRATE TOUCH, guarded on `BOARD_TOUCH_NEEDS_CAL`. `settings.ino:1531-1535`
recorded this as an open question - `runCalibration()` there is a stub that prints and returns,
because the touch controller is factory-aligned inside the display IC - and left the call to
the user. The call is: drop it, per this repo's own "never offer a control that cannot work"
rule, the same rule that stopped the farewell screen promising a touch wake this board lacks.

**The button and its hit test must disappear together.** A constant a draw site no longer uses
but a hit test still does is how a page comes to claim taps for a button it does not draw -
`P2_MIC_Y`'s absence is asserted for exactly this reason, and `P2_CAL_Y` now needs the same
treatment on board 2.

### Sound

Unchanged from board 2's today: SOUND ON toggle, VOLUME stepper, TEST BEEP, MIC TEST. Board 1
gains it as a page of its own, splitting today's combined `DISPLAY & SOUND`.

### Macs

Today's Pairing page - pair panel, ANY MAC row, the Mac list with its forget zones - plus
`RESET PAIRING` last, under `CANNOT BE UNDONE` with the severity spine.

The page ends at 450 of 460 today, so the ~86px the button block needs is paid for by
re-cutting the list: `P3_ROW_STEP` 60 -> 52 and `P3_ROW_H` 52 -> 46, saving 32px across four
slots, plus tightening the two caption gaps. **46 is `TAP_MIN` exactly** - still a legal
target, with no margin, which the assertion must state rather than imply.

**`hostCount` goes into RESET PAIRING's cache.** The button now sits below a variable-length
list, and finding #6 in the settings doc is precisely this: a change-only field whose chrome is
count-dependent needs the count in its cache, or a row nobody can see forgets a Mac when
tapped.

### Messages

Unchanged. It is already one implementation for both boards.

## 3. Code

**Deleted:** `BOARD_SETTINGS_HOME` (28 sites), `drawPager()`, `SETTINGS_PAGES`,
`gotoSettingsPage()`, the 45/55 band split, `renderMacLinkRows()` (board 1's alone today),
board 1's `titles[]`.

**This retires a documented verification burden.** The settings doc records preprocessing both
shared files at board 1's real macro values and diffing them at every task. That is only
necessary while there are two arms. It also serves CLAUDE.md's rule that `#if` arms duplicating
a whole statement are hostile to every brace-counting checker here.

**Four consequences that bite if unplanned:**

- `homeSubCache[SET_GROUP_COUNT]` goes 7 -> 5. Every cache whose chrome is repainted must be
  reset in `resetSettingsCaches()`, or the value is left blank because it "hasn't changed".
- The Macs list's count-dependent chrome, above.
- **`RECAL` needs a refusal on board 2.** Removing the control leaves the verb handled but the
  button gone. `commands-check.mjs` requires every verb handled or refused **by name** on both
  boards, so `RECAL` joins `UNAVAILABLE_COMMANDS[]` guarded on the exact negation of
  `BOARD_TOUCH_NEEDS_CAL`, naming its cause.
- `PAGE 0..4` (board 1) and `PAGE 0..7` (board 2) become one range, **`PAGE 0..5`**, in the
  dispatch and in CLAUDE.md's command table.

## 4. Checkers and baselines

- `settings-geom-check.mjs` asserts HOME's pitch identity for board 2 only today. It gains
  board 1's, and `--selftest` gains a board-1 injection so a board-1-only regression fails by
  name. Every new constant must be **parsed**, never transcribed, and every assertion must be
  shown to fail when the constant is reverted.
- `docs/design/settings-redesign/check.mjs` is bound to board 2's header and breaks by design.
  It is re-drawn for the five new pages, with its `WAS` table carrying today's seven-group
  geometry - and the existing rule holds that every `WAS` entry must actually differ from what
  ships, so a live constant cannot be parked there to escape the bind.
- `geom-sweep.mjs` (~110s) for constants this work leaves unguarded.
- `commands-check.mjs` for `RECAL` and `PAGE`.
- **Both baselines move, deliberately.** Board 1 is the board being rebuilt, so its binary
  moves a lot. `--update 1` and `--update 2` are explicit steps and the commit message says why.
  `--doc-check` then re-binds the four quoted figures in CLAUDE.md. The two RAM figures are
  hand-maintained and must be re-checked after the compile that moves `.bss`.
- **Compile the two boards separately.** `arduino-cli` derives its build directory from the
  sketch path, so concurrent FQBNs overwrite each other's objects and the second failure reads
  like `board.h` picking the wrong header.

## 5. Verification

The offline set - three geometry checkers, the sweep, the mock, `commands-check` - proves
geometry and arithmetic. It proves nothing about colour or touch.

**The previous SETTINGS redesign shipped with nothing on the glass**: five tasks, no device
attached, stated plainly in the reference doc. This plan ends with both boards flashed and
attached:

- `PAGE 0..5` to put each surface up, on both boards
- `SCREENSHOT` for geometry
- `THEME dark` / `THEME light` for both palettes
- a person for the severity spine's greyscale claim - on board 2 `SCREENSHOT` reads the shadow
  framebuffer and cannot settle colour, and `COLORTEST` tests a colour pair, not a shape
- every touch path walked by hand; the device has no remote tap

If no device is available for a task, that is **written down as unverified**, not implied.

## 6. Tasks

1. Unify the code path. Delete `BOARD_SETTINGS_HOME` and the pager; give board 1 HOME with the
   geometry derived above; the group set becomes five with today's page content behind it
   (Device = Status for now). Board 1's baseline moves; say why.
2. The Device page: the DIAGNOSTICS compression, the slimmed live cards, POWER OFF last.
3. The Macs page: RESET PAIRING, the list re-cut, `hostCount` in the cache.
4. Board 1's Display/Sound split; the `BOARD_TOUCH_NEEDS_CAL` guard on CALIBRATE TOUCH and its
   hit test; the `RECAL` refusal; `PAGE 0..5`.
5. Checkers, the mock, `docs/reference/settings-tab.md`, CLAUDE.md's command table, and both
   baselines.

## Open, and to be settled by measurement

- Board 2's Device page is **~10px over** on the estimates here. Close it in the pads or come
  back; do not shrink a face.
- Board 1's Device page needs its own derivation at Cozette/Terminus metrics. The estimate says
  it fits once the firmware facts stay off it, but that has not been derived constant by
  constant.
- Macs at `P3_ROW_H 46` has **zero margin over `TAP_MIN`**. If the re-cut will not close
  honestly, the fallback is option (b) from the design discussion - a sixth group holding both
  destructive verbs - not a 44px row.

---

# AMENDMENT, 2026-09-12: the group set is SIX, not five

**Everything above stands as the reasoning; this section overrides its conclusion.** Kept in
place rather than rewritten, per this repo's rule that a description which turned out to be wrong
is marked rather than deleted — the five-group argument is still the right argument, and it is
board 1's arithmetic rather than the argument that defeated it.

## What was measured

The five-group set required `RESET PAIRING` to live at the foot of the Macs group. **It cannot, on
board 1.** From `deckhand_display.ino:3532-3534` and `board_e32r28t.h`:

    P3_ANY_Y  = PAGE_TOP + SP_1/2            = 82
    P3_LIST_Y = P3_ANY_Y + H_ROW + SP_1      = 126
    four Mac rows at step 44                 -> 126 + 3*44 + 40 = 298
    page region                                 PAGE_TOP(80)..contentBottom(302) = 222px

That is **216 of 222px already spent**. `RESET PAIRING` needs `cap(13) + SET_CAP_STEP(21) +
P2_BTN_H(38)` = **72px that do not exist**, and there is nowhere honest to take them from:

| source | saves | verdict |
|---|---|---|
| abut the Mac rows (step 44 -> 40) | 12 | still 60 short |
| delete the ANY MAC row | 44 | still 28 short, and deletes a real setting |
| both together | 56 | still 14 short |
| cap the list at 3 slots | 44 | breaks the 4-Mac case, the only case the geometry must survive |

The section-caption trick that closed board 2's page has no equivalent here: board 1's Macs page
has no section captions to spend.

## The set

    Device | Display | Sound | Macs | Messages | Danger

`Danger` is the old Actions group, renamed and reduced to exactly what destroys state:
`RESET PAIRING` and `POWER OFF`. It is no longer a bag of verbs — MIC TEST left for Sound before
this branch, and CALIBRATE TOUCH leaves for board 1's Display. The name says so, and it matches
the `CANNOT BE UNDONE` caption already inside it.

## Three things this changes, and they are not consolation

1. **The destructive-order reversal is CANCELLED.** The body of this spec records a knowing
   reversal of `board_es3c35p.h`'s rule that "a destructive group in the middle of a menu is the
   one thing this list's order actually has to protect". With Danger surviving and staying last,
   that rule is **preserved intact**. The one place this design deliberately contradicted a
   written rule no longer does.
2. **Board 2's HOME does not move.** It stays at the six-row `58/10` pitch, which is where the
   first task already left it. The `50/8 -> 58/10 -> 70/12` walk-back stops one step early.
3. **The Device page gets ~80px back**, because POWER OFF is not on it. That is spent on the
   thing the first task's review flagged as a real loss: the SoC temp regains its own line and
   its warm/hot colour band. `colorForDieTemp()` was left uncalled on **both** boards, meaning no
   warm/hot signal existed anywhere on the device.

## Board 1's HOME, re-derived for six rows

    HOME_Y0 + 6*HOME_ROW_H + 5*HOME_GAP + HOME_Y0_BOT == contentBottom()
    38      + 6*42         + 5*2        + 2           == 302

42 is `TAP_MIN + 2`. This is the cost the body of this spec predicted for the fallback and
accepted in advance: board 1's rows sit near the fingertip floor rather than the roomy 46/6/6 the
five-row set would have given. **Search the (row height, gap) space rather than nudging** — the
seven-row derivation on board 2 returned exactly one integer solution, and that is the standard
here. Row internals at 42, mirroring board 2's stack at this board's type scale:

    +0..+1    border
    +4..+21   name    (T_HEAD, Terminus 10x18)
    +22..+23  gap 2
    +24..+36  summary (T_BODY, Cozette 6x13)
    +37..+39  pad
    +40..+41  border                                   = 42

## What did NOT change

Everything else in the body of this spec: the DIAGNOSTICS compression, the slimmed live cards,
board 1 carrying no diagnostics block, dropping CALIBRATE TOUCH on board 2, the `RECAL` refusal,
`BOARD_SETTINGS_HOME`'s deletion and the self-proving no-op that follows it, and the verification
discipline. The Macs page is now simply **untouched** on both boards.
