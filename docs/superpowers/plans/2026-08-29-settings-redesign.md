# Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace board 2's four-page chevron pager with a HOME screen plus five drill-down groups, and rebalance each group's content, without moving board 1's binary by a single byte.

**Architecture:** Board 2 extends `settingsPage`'s range to `SET_HOME`(0) plus five group ids, gated on a new `BOARD_SETTINGS_HOME` flag. The pager band (`CONTENT_Y`..`PAGE_TOP`) becomes a back band of exactly the same height, so every group keeps `PAGE_TOP` 104 and the existing page bodies drop in under it. Board 1 keeps its four pages, its pager, and its literal source text — every change to shared code is a preprocessor directive around an unchanged board-1 arm, which emits no code.

**Tech Stack:** Arduino ESP32-S3, `PanelShim` over a PSRAM framebuffer, Spleen 8x16/12x24, node ESM checkers.

**Spec:** `docs/design/settings-redesign/` — the pixel-accurate mock IS the geometric spec. `settings.js`'s functions `homeScreen`, `backBand`, `bStatus`, `bDisplay`, `bSound`, `bPairing`, `bActions` carry the exact coordinates every task below must reproduce. Run `node docs/design/settings-redesign/check.mjs` (50 assertions) to see them validated.

## Global Constraints

- **BOARD 1'S BINARY MUST NOT MOVE.** After every task: compile board 1 and run
  `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1`. It must say `UNCHANGED`.
  A task that moves it is not done. Board 1's header gains exactly one line (`#define BOARD_SETTINGS_HOME 0`);
  every other shared-code change is an `#if` around text that is byte-for-byte what is there today.
- **NEVER compile both boards concurrently.** One sketch build directory is shared and they overwrite each
  other's objects. Compile board 2, check it, then board 1, check it.
- **Every string drawn on the panel must be ASCII `0x20..0x7E`.** Spleen declares nothing else and an
  out-of-range byte draws nothing and advances nothing. No `·`, no `›`, no `…`, no arrows.
- **Every layout constant lives in a board header.** No panel dimension, offset or height may be a literal
  in a `.ino`. This is the rule three separate bugs in the board-2 port came from breaking.
- **A checker must PARSE the constant it certifies, never transcribe it.** Adding an assertion whose
  expected value is typed into the checker is worse than no assertion. The test for a new assertion is not
  "does it pass" but **"does perturbing the constant make it fail, and by name"**.
- **Change-only redraw discipline.** Any new cached field must be reset in `resetSettingsCaches()`, and any
  new cache array must be at least as long as the longest string it can hold plus its NUL. A cache shorter
  than its string silently stops noticing changes.
- Board 2 flash/RAM today: **992122 / 65604**. Report the delta each task.

---

### Task 1: Board headers, the `#if` split, and the stale comment

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h`
- Modify: `firmware/deckhand_display/board_e32r28t.h` (ONE line)
- Modify: `firmware/deckhand_display/deckhand_display.ino:2837-2880` (wrap, do not edit, board 1's derivations)
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Produces: `BOARD_SETTINGS_HOME`; `SET_HOME`/`SET_STATUS`/`SET_DISPLAY`/`SET_SOUND`/`SET_PAIRING`/`SET_ACTIONS`;
  `SET_GROUP_COUNT`; `HOME_Y0`/`HOME_ROW_H`/`HOME_GAP`/`HOME_NAME_DY`/`HOME_SUB_DY`/`HOME_CHEV_DX`;
  `BACK_BTN_W`/`BACK_TITLE_DX`. Board 2's own `P1_*`/`P2_*`/`P3_*` page constants.
- Consumes: nothing.

- [ ] **Step 1: add the flag to both headers**

`board_e32r28t.h`, beside the other capability flags — this is the ONLY change to board 1's header,
and a `#define` of 0 emits no code:

```c
#define BOARD_SETTINGS_HOME  0   // four pages behind a chevron pager; see settings.ino
```

`board_es3c35p.h`, beside its capability flags:

```c
#define BOARD_SETTINGS_HOME  1   // a HOME screen plus five drill-down groups
```

- [ ] **Step 2: add board 2's settings page ids and HOME geometry**

Append to `board_es3c35p.h`, in the SETTINGS region. **Copy the comment text as well** — it records
why each number is what it is, which is what stops the next reader re-deriving it:

```c
// ---------- SETTINGS: HOME and the five groups ----------
// settingsPage carries HOME plus five group ids rather than a second state
// variable, because two variables tracking one screen is how a UI ends up
// drawing one page while hit-testing another.
const int SET_HOME = 0, SET_STATUS = 1, SET_DISPLAY = 2, SET_SOUND = 3,
          SET_PAIRING = 4, SET_ACTIONS = 5;
const int SET_GROUP_COUNT = 5;   // SET_STATUS..SET_ACTIONS, contiguous by design

// HOME owns the WHOLE content area - there is no band above it, because the tab
// bar already says SETTINGS and a second title would be chrome repeating itself.
// The pitch is derived to land exactly on contentBottom():
//   HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT = 54 + 350 + 48 + 8 = 460
// so a row height change must be paid for out of the gap or the pads, and
// settings-geom-check.mjs asserts the identity rather than the value.
const int HOME_Y0     = 54;
const int HOME_ROW_H  = 70;
const int HOME_GAP    = 12;
const int HOME_Y0_BOT = 8;
// Inside a row: name at T_HEAD, summary at T_BODY under it, chevron right.
//   +0..+1    border
//   +14..+37  name    (T_HEAD 24)
//   +38..+43  gap 6
//   +44..+59  summary (T_BODY 16)
//   +60..+67  pad
//   +68..+69  border                                   = 70
const int HOME_NAME_DY = 14;
const int HOME_SUB_DY  = 44;

// The back band replaces the pager band at the SAME height, which is the whole
// reason the group bodies need no new arithmetic: PAGE_TOP is unchanged at 104.
// The key is the pager's own PAGER_BTN_W so the two boards' chrome stays one
// size, and the WHOLE band is the back target - there is nothing else in it, so
// the 45/55 split the pager needs to separate two keys is not needed here.
const int BACK_BTN_W    = PAGER_BTN_W;
const int BACK_TITLE_DX = 16;
```

- [ ] **Step 3: move board 2's page derivations into its own header**

Board 2's group pages are laid out from scratch, so their constants belong in the header rather than
being derived in shared code. Append to `board_es3c35p.h`:

```c
// ---------- SETTINGS group: Status ----------
// Three cards instead of eleven flat rows. The two facts you actually came for -
// is the host talking to me, and how is the battery - lead as T_HEAD lines with
// their detail dimmed under them; the eight diagnostics collapse into one
// two-column card. The per-Mac rows MOVED to the Pairing group, where the Macs
// already are; carrying them on both pages was the duplication that made this
// page the only one with no slack.
//   116..227  CONNECTION   240..351  POWER   364..455  HOST
const int ST_CONN_Y = 116, ST_CONN_H = 112;
const int ST_PWR_Y  = 240, ST_PWR_H  = 112;
const int ST_HOST_Y = 364, ST_HOST_H = 92;
const int ST_CAP_DY = 8, ST_BIG_DY = 34, ST_L1_DY = 66, ST_L2_DY = 86;
const int ST_HOST_R1_DY = 34, ST_HOST_R2_DY = 56;

// ---------- SETTINGS group: Display ----------
// VOLUME left for the Sound group, which freed 92px. That is NOT spent on air:
// THEME stops being a cramped third-width CYCLE button - which shows one state
// and hides the other two - and becomes a 3-segment selector showing all three.
// It was never a uiToggle anyway, having three states.
const int P1_BRIGHT_Y = PAGE_TOP + 12;                      // 116..195
const int P1_SLEEP_Y  = P1_BRIGHT_Y + STEPPER_CARD_H + 12;  // 208..287
const int P1_THEME_CAP_Y = 298;
const int P1_THEME_Y     = 318;                             // 318..363
const int P1_THEME_GAP   = 4;
const int P1_THEME_SEG_W = (CARD_W - 2 * P1_THEME_GAP) / 3; // 96, clears TAP_MIN twice over
// AUTO is a CLOCK, not a sensor: every ADC1 channel here is spoken for (touch,
// battery, mic) and ADC2 is unusable while BT is up, so there is no light to
// measure and never will be. A bare "AUTO" implies hardware that does not exist,
// which is the rule that stops the farewell screen promising a touch wake.
const int P1_AUTO_HINT_Y = 377;
const int P1_FLIP_Y      = 396;                             // 396..441

// ---------- SETTINGS group: Sound ----------
// Output AND input, because a mic test IS a sound test - and it is the one action
// run repeatedly, since MIC_GAIN is settled by watching MICMON while speaking
// rather than computed. Moving MIC TEST here is what takes the Actions group down
// to three, so Actions becomes purely things that change or end state.
const int PS_ALERT_CAP_Y = 116;
const int PS_SOUND_Y     = 140;                             // 140..185, H_ROW
const int PS_WHAT_HINT_Y = 197;
const int PS_VOL_Y       = 218;                             // 218..297
const int PS_TEST_Y      = 310;                             // 310..359
const int PS_MIC_CAP_Y   = 374;
const int PS_MIC_Y       = 398;                             // 398..447
const int PS_BTN_H       = 50;
// No bar under VOLUME, deliberately - see STEP_BAR_Y: only BRIGHTNESS gets one,
// being the single continuous 0-100 setting. Three named presets with a bar under
// them would be decoration.

// ---------- SETTINGS group: Pairing ----------
// The live Mac rows land here. A row is two lines - name, then whether that Mac
// is connected RIGHT NOW - which is the one thing the pairing list never had.
const int P3_ANY_CAP_Y  = 116;
const int P3_ANY_Y      = 138;                              // 138..183, H_ROW
const int P3_LIST_CAP_Y = 196;
const int P3_LIST_Y     = 218;
const int P3_ROW_H      = 52;
const int P3_ROW_STEP   = 60;                               // 4 Macs -> 218..449
const int P3_ROW_NAME_DY = 10, P3_ROW_SUB_DY = 30;
const int P3_X_W        = 40;   // "forget" hit zone at the right edge

// ---------- SETTINGS group: Actions ----------
// THREE buttons, because MIC TEST moved to Sound - so these are drawn at 56
// rather than H_BTN's 50 and given room to separate.
// SEVERITY IS NOT CARRIED BY OUTLINE HUE ALONE, which is what shipped: all four
// of the old buttons were identically shaped outlined slabs differing only in
// stroke colour, against this repo's own rule that status is never colour alone.
// The two destructive ones are captioned and carry a solid spine - the same
// visual language the session rows already use - so severity survives greyscale.
const int P2_SETUP_CAP_Y = 120;
const int P2_CAL_Y       = 146;                             // 146..201
const int P2_DANGER_CAP_Y = 228;
const int P2_PAIR_Y      = 254;                             // 254..309
const int P2_PWR_Y       = 322;                             // 322..377
const int P2_BTN_H       = 56;
const int P2_HINT_Y      = 402;
const int P2_SPINE_W     = 4;
```

- [ ] **Step 4: wrap board 1's shared derivations, do not edit them**

In `deckhand_display.ino`, the block currently at ~2837-2880 defines `P1_BRIGHT_Y` … `P3_X_W`.
Board 2 now defines its own, so wrap that whole block. **The text inside the `#else` must be
character-for-character what is there today** — an `#if` emits no code, so board 1 cannot move:

```c
#if BOARD_SETTINGS_HOME
// Board 2 derives every settings page constant in board_es3c35p.h, because its
// pages are laid out from scratch rather than shared. See the SETTINGS regions there.
#else
... the existing block, UNCHANGED ...
#endif
```

Also wrap `P1_SOUND_H`, `P1_THIRD_W`, `P1_FLIP_X`, `P1_THEME_X` into the `#else` — board 2's Display
group has no three-across toggle row.

- [ ] **Step 5: fix the stale comment, which describes a page that does not compile**

`board_es3c35p.h` around line 1689 opens *"THREE buttons, not four: BOARD_HAS_MIC is 0 here"*. Line 18
of that same header is `#define BOARD_HAS_MIC 1`, set when the ES8311 capture path landed — so the
ACTIONS page really has four buttons today and the comment's whole arithmetic chain is wrong with it
(it puts the hint at 302 with 148px clear; the real values are 364 and 86). Replace that paragraph
with the Actions block from Step 3, which describes what this task actually builds, and add one
sentence recording that the flag flipped under the comment and no checker caught it because prose is
not parsed.

- [ ] **Step 6: assert the derivations that can be asserted now**

In `settings-geom-check.mjs`, inside the `for (const b of [1, 2])` loop, guarded to board 2. Every
expected value must be COMPUTED from the parsed constants, never typed:

```js
if (b === 2) {
  // HOME's pitch is derived to land exactly on contentBottom(). Asserting the
  // IDENTITY rather than the number is what makes a row-height change fail here
  // instead of silently eating the bottom row.
  const homeEnd = c.HOME_Y0 + 5 * c.HOME_ROW_H + 4 * c.HOME_GAP + c.HOME_Y0_BOT;
  chk(homeEnd === contentBottom,
      `HOME's five rows land exactly on contentBottom: ${homeEnd} == ${contentBottom}`);
  chk(c.HOME_ROW_H >= c.TAP_MIN,
      `a HOME row is a touch target: ${c.HOME_ROW_H} >= TAP_MIN ${c.TAP_MIN}`);
  // The row's own stack must clear its 2px card border at both ends.
  const subEnd = c.HOME_SUB_DY + lineHB(b, T_BODY) - 1;
  chk(c.HOME_NAME_DY >= c.BORDER_CARD,
      `HOME's name clears the card's top border: ${c.HOME_NAME_DY} >= ${c.BORDER_CARD}`);
  chk(subEnd <= c.HOME_ROW_H - c.BORDER_CARD - 1,
      `HOME's summary clears the bottom border: ${subEnd} <= ${c.HOME_ROW_H - c.BORDER_CARD - 1}`);
  const nameEnd = c.HOME_NAME_DY + lineHB(b, T_HEAD) - 1;
  chk(nameEnd < c.HOME_SUB_DY,
      `HOME's name and summary share no pixel row: ${nameEnd} < ${c.HOME_SUB_DY}`);
  // The back band must be the pager band's height, or every group body moves.
  chk(c.BACK_BTN_W === c.PAGER_BTN_W,
      `the back key is the pager key's width: ${c.BACK_BTN_W} == ${c.PAGER_BTN_W}`);
}
```

- [ ] **Step 7: verify**

```bash
node firmware/deckhand_display/settings-geom-check.mjs          # must pass, new assertions listed
node firmware/deckhand_display/settings-geom-check.mjs --selftest
# board 2 first, then board 1 - NEVER concurrently
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1   # MUST be UNCHANGED
```

Prove the assertions have teeth: temporarily set `HOME_ROW_H` to 71 and confirm the pitch identity
FAILS BY NAME, then revert.

- [ ] **Step 8: commit**

```bash
git add firmware/deckhand_display/
git commit -m "Settings: board-2 page constants, and the comment that described a dead page"
```

---

### Task 2: HOME, the back band, navigation, and the Display/Sound split

**Files:**
- Modify: `firmware/deckhand_display/settings.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `drawSettingsHomeStatic()`, `drawBackBand(const char*)`, `openSettingsGroup(int)`,
  `settingsBack()`, `drawDisplayPageStatic()`, `renderDisplayPage()`, `drawSoundPageStatic()`,
  `renderSoundPage()`, `settingsGroupTitle(int)`.

- [ ] **Step 1: the back band and HOME, both board-2 only**

Add to `settings.ino`, guarded `#if BOARD_SETTINGS_HOME`. Geometry is
`docs/design/settings-redesign/settings.js` functions `backBand` and `homeScreen` — reproduce it
exactly. The five HOME summaries are composed from existing globals into a local buffer; store
nothing.

The chevron is an ASCII `>` at `T_HEAD`, `MR_DATUM`, at `CARD_X + CARD_W - PAD`. It is the affordance
that says a row opens; without it a HOME row reads as a status line.

The Status row's summary takes `COLOR_GOOD` when both links are up and `COLOR_WARN` otherwise —
colour supporting words that already say it, never carrying the meaning alone.

- [ ] **Step 2: navigation**

```c
#if BOARD_SETTINGS_HOME
void openSettingsGroup(int g) {
  settingsPage = constrain(g, SET_STATUS, SET_ACTIONS);
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
void settingsBack() { openSettingsGroup(SET_HOME - 1 + 1), settingsPage = SET_HOME; ... }
#endif
```

Write `settingsBack()` properly rather than as above — it sets `settingsPage = SET_HOME` and then does
the same clear/reset/redraw. Both must clear from `CONTENT_Y`, not `PAGE_TOP`: HOME occupies the band's
rows, so a clear that starts at `PAGE_TOP` leaves the previous group's back band on screen.

- [ ] **Step 3: dispatch**

`drawSettingsStatic()` gains a board-2 arm. Board 1's arm — the `fillRect(0, PAGE_TOP, ...)`,
`drawPager()` and the four-way `if` chain — must stay character-identical inside the `#else`:

```c
void drawSettingsStatic() {
  pendingConfirm = CFM_NONE;
  resetSettingsCaches();
#if BOARD_SETTINGS_HOME
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  if (settingsPage == SET_HOME) { drawSettingsHomeStatic(); return; }
  drawBackBand(settingsGroupTitle(settingsPage));
  if      (settingsPage == SET_STATUS)  drawStatusPageStatic();
  else if (settingsPage == SET_DISPLAY) drawDisplayPageStatic();
  else if (settingsPage == SET_SOUND)   drawSoundPageStatic();
  else if (settingsPage == SET_PAIRING) drawHostsPageStatic();
  else                                  drawActionsPageStatic();
#else
  ... existing board-1 body, UNCHANGED ...
#endif
}
```

`renderSettingsTab()` and `drawSettingsTab()` get the same treatment; board 2 enters at `SET_HOME`.

Also guard `drawPager()`'s DEFINITION with `#if !BOARD_SETTINGS_HOME` — board 2 never calls it, and
leaving it linked costs flash for a function that cannot run. Board 1's copy is untouched text.

- [ ] **Step 4: touch routing**

In `handleSettingsTouch`, after the modal branch, a board-2 arm:

```c
#if BOARD_SETTINGS_HOME
  if (settingsPage == SET_HOME) {
    for (int i = 0; i < SET_GROUP_COUNT; i++) {
      int y = HOME_Y0 + i * (HOME_ROW_H + HOME_GAP);
      if (sy >= y && sy < y + HOME_ROW_H) { openSettingsGroup(SET_STATUS + i); return; }
    }
    return;
  }
  if (sy < PAGE_TOP) { settingsBack(); return; }   // the whole band is the target
#else
  ... the existing pager-band branch, UNCHANGED ...
#endif
```

Then the per-group branches replace the `settingsPage == 1/2/3` chain on board 2 only. **The Display
group's touch handler must not test `P1_VOL_Y` or `P1_THIRD_W`** — those no longer exist on this board.

- [ ] **Step 5: split Display and Sound**

`drawDisplayPageStatic()` / `renderDisplayPage()`: brightness stepper, sleep stepper, the THEME
3-segment selector, the AUTO hint, the flip toggle. The selected segment is filled accent; the other
two outlined in `COLOR_LABEL`. Geometry: `settings.js` `bDisplay`.

`drawSoundPageStatic()` / `renderSoundPage()`: the ALERTS caption, the full-width SOUND toggle, the
"beeps when a session needs input" hint, the VOLUME stepper (no bar), TEST BEEP, the MICROPHONE
caption, MIC TEST. Geometry: `settings.js` `bSound`.

TEST BEEP calls `startBeep()` unconditionally — it is a test, so it must sound even with the SOUND
toggle off, the same reasoning that makes `MIC_CUE_DUTY` independent of the SOUND setting. MIC TEST
keeps its existing no-confirm behaviour and its `if (!everReceived) forceFullRepaint();` follow-up.

- [ ] **Step 6: caches**

Any new cached field goes in `resetSettingsCaches()` under `#if BOARD_SETTINGS_HOME`. The theme
segments and the flip toggle need their existing caches busted when the group is entered — which
`drawSettingsStatic()`'s unconditional `resetSettingsCaches()` already does.

- [ ] **Step 7: assertions**

Add to `settings-geom-check.mjs`, board 2 only, all values computed:

```js
// The Display group: the three theme segments fit the card with their gaps, and
// each is still a touch target.
const segTotal = 3 * c.P1_THEME_SEG_W + 2 * c.P1_THEME_GAP;
chk(segTotal <= c.CARD_W, `three theme segments fit the card: ${segTotal} <= ${c.CARD_W}`);
chk(c.P1_THEME_SEG_W >= c.TAP_MIN, `a theme segment is tappable: ${c.P1_THEME_SEG_W} >= ${c.TAP_MIN}`);
// Every hint is centred on the PANEL, so its lane is the panel, not the card.
for (const [s, y] of [["AUTO = light 07:00 to 19:00", c.P1_AUTO_HINT_Y],
                      ["beeps when a session needs input", c.PS_WHAT_HINT_Y]]) {
  const w = widthB(b, T_BODY, s);
  chk(w <= W, `hint "${s}" fits the panel: ${w} <= ${W}`);
}
// The Sound group's last control must clear the footer.
const soundEnd = c.PS_MIC_Y + c.PS_BTN_H - 1;
chk(soundEnd < contentBottom, `Sound's last button clears the footer: ${soundEnd} < ${contentBottom}`);
// The Display group's last control likewise.
const dispEnd = c.P1_FLIP_Y + c.H_ROW - 1;
chk(dispEnd < contentBottom, `Display's flip toggle clears the footer: ${dispEnd} < ${contentBottom}`);
// No two blocks on either page may share a pixel row.
```

Add the disjointness assertions for both pages by laying the blocks out in an array and checking each
against the next, the way the checker already does for the keyboard's meta row.

- [ ] **Step 8: verify and commit**

Run both compiles (board 2 then board 1, never concurrently), both baseline checks, every checker.
Board 1 must read `UNCHANGED`. Prove teeth: set `P1_THEME_SEG_W` one pixel over a third of the card
and confirm the fit assertion fails by name.

```bash
git commit -m "Settings: a HOME screen and five groups, replacing the chevron pager on board 2"
```

---

### Task 3: The Status and Pairing groups

**Files:**
- Modify: `firmware/deckhand_display/settings.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: Task 1's `ST_*` and `P3_*` constants, Task 2's dispatch.
- Produces: board-2 arms of `drawStatusPageStatic()`/`renderStatusPage()` and
  `drawHostsPageStatic()`/`renderMacLinkRows()`.

- [ ] **Step 1: Status, three cards**

Board-2 arm only; board 1's existing body stays in the `#else`, unchanged. Geometry: `settings.js`
`bStatus`.

- CONNECTION card: caption, a `T_HEAD` verdict line (`Both links up` / `Bluetooth only` / `USB only` /
  `No host`) in `COLOR_GOOD` or `COLOR_WARN`, then two dim `T_BODY` lines — which transports and how
  long ago, then the device name and pairing count.
- POWER card: caption, `T_HEAD` `78%  4.05V`, then the runtime estimate and the SoC temp. The
  estimate keeps its existing `battLeftLabel`/`battChargeLabel` semantics exactly — `~` means about,
  `>=` means at least, and neither may be rendered as the other.
- HOST card: caption and four values in two columns, `T_BODY` throughout.

**The per-Mac rows are REMOVED from this page** — they move to Pairing in Step 2. `renderMacLinkRows()`
becomes board-1-only.

Every value keeps its change-only cache and its colour-cache companion. `battRowColorCache` and
`tempRowColorCache` exist because a colour can flip while the digits stay identical; the new verdict
line needs the same guard, since `Both links up` is one string across a `COLOR_GOOD`→`COLOR_WARN` flip.

- [ ] **Step 2: Pairing, with live state**

Board-2 arm of `drawHostsPageStatic()`. Geometry: `settings.js` `bPairing`. Each remembered Mac gets a
52px card carrying its name, a live/idle dot, and a second line that is either `connected, Ns ago` or
`last seen ...`. Liveness comes from matching the row's `hosts[i].id` against `hostLinks[]` — the same
`hostLinks` lookup `renderMacLinkRows()` uses today, so no new state and nothing new on the wire.

The `x` forget zone keeps `P3_X_W` and its confirm dialog. The `ONLY` tag keeps its `rightInset` so it
cannot overlap the `x`.

- [ ] **Step 3: assertions**

```js
// Status: the three cards must not overlap and the last must clear the footer.
const cards = [[c.ST_CONN_Y, c.ST_CONN_H], [c.ST_PWR_Y, c.ST_PWR_H], [c.ST_HOST_Y, c.ST_HOST_H]];
for (let i = 1; i < cards.length; i++)
  chk(cards[i][0] >= cards[i-1][0] + cards[i-1][1],
      `Status card ${i} clears card ${i-1}: ${cards[i][0]} >= ${cards[i-1][0] + cards[i-1][1]}`);
chk(cards[2][0] + cards[2][1] - 1 < contentBottom, `Status's last card clears the footer`);
// A card's own stack must clear its border at both ends - the clear-box rule.
const l2End = c.ST_L2_DY + lineHB(b, T_BODY) - 1;
chk(l2End <= c.ST_CONN_H - c.BORDER_CARD - 1, `the CONNECTION card's last line clears its border`);
// Pairing: four Macs must fit.
const pairEnd = c.P3_LIST_Y + 3 * c.P3_ROW_STEP + c.P3_ROW_H - 1;
chk(pairEnd < contentBottom, `four paired Macs fit above the footer: ${pairEnd} < ${contentBottom}`);
chk(c.P3_ROW_STEP >= c.P3_ROW_H, `pairing rows do not overlap`);
```

Also assert each new cache array is at least as long as the longest string it can hold — derive the
worst case from the format, the way the checker already derives the battery row's.

- [ ] **Step 4: verify and commit** — both compiles, both baselines, all checkers, teeth proven.

---

### Task 4: The Actions group and the severity spine

**Files:**
- Modify: `firmware/deckhand_display/settings.ino`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs`

- [ ] **Step 1: three buttons, two captions, one spine**

Board-2 arm of `drawActionsPageStatic()`. Geometry: `settings.js` `bActions`.

`SETUP` caption then CALIBRATE TOUCH; `CANNOT BE UNDONE` caption then RESET PAIRING and POWER OFF,
each drawn by `uiButton` and then given a solid `P2_SPINE_W` bar in its own severity colour, inset
`BORDER_CTRL` inside the button's left edge and running from `R_MD` to `h - R_MD` so it cannot cross
the rounded corner.

MIC TEST is gone from this page — it lives on Sound. Its touch branch must go with it, or the page
claims taps for a button it no longer draws.

- [ ] **Step 2: touch**

The board-2 chain opens on CALIBRATE at the new `P2_CAL_Y`. All three keep their confirm dialogs.

- [ ] **Step 3: assertions**

```js
// The spine must sit INSIDE the button's border and clear both rounded corners,
// or it paints over the stroke it is meant to reinforce.
chk(c.P2_SPINE_W + c.BORDER_CTRL <= c.R_MD,
    `the severity spine clears the button's corner radius: ${c.P2_SPINE_W + c.BORDER_CTRL} <= ${c.R_MD}`);
const btns = [c.P2_CAL_Y, c.P2_PAIR_Y, c.P2_PWR_Y];
for (let i = 1; i < btns.length; i++)
  chk(btns[i] >= btns[i-1] + c.P2_BTN_H, `Actions button ${i} clears button ${i-1}`);
chk(c.P2_BTN_H >= c.TAP_MIN, `an action button is a touch target: ${c.P2_BTN_H} >= ${c.TAP_MIN}`);
// The captions must not collide with the buttons they head.
chk(c.P2_SETUP_CAP_Y + lineHB(b, T_BODY) - 1 < c.P2_CAL_Y, `the SETUP caption clears its button`);
chk(c.P2_DANGER_CAP_Y + lineHB(b, T_BODY) - 1 < c.P2_PAIR_Y, `the danger caption clears its button`);
// The hint fits the panel and clears the last button.
const hintW = widthB(b, T_BODY, "power off = deep sleep, RESET to wake");
chk(hintW <= W, `the power-off hint fits the panel: ${hintW} <= ${W}`);
```

- [ ] **Step 4: verify and commit** — both compiles, both baselines, all checkers, teeth proven.

---

### Task 5: Verification, the sweep, and the documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `firmware/deckhand_display/settings-geom-check.mjs` (`--selftest`)
- Modify: `firmware/board-baseline.json` only if board 2 legitimately moved

- [ ] **Step 1: the selftest must catch a real fault**

`settings-geom-check.mjs --selftest` currently injects a keyboard fault. Add a second injection for
this work: push `HOME_ROW_H` up by 1 so the pitch identity breaks, and assert the checker FAILS. Exit 0
only when the injected fault IS caught, which is this repo's teeth-proving convention.

- [ ] **Step 2: the fault-injection sweep**

```bash
node firmware/deckhand_display/geom-sweep.mjs
```

Every constant this plan ADDED must come back guarded, at the smallest perturbation that is caught.
A newly added constant reported UNGUARDED is a gap, not noise — that is this repo's stated standard for
constants it just added. Fix the gap by adding the missing assertion, not by suppressing the report.

- [ ] **Step 3: full verification**

```bash
for f in firmware/deckhand_display/*-check.mjs firmware/deckhand_display/palette-check.mjs; do node "$f" || echo "FAIL $f"; done
for f in host/*-check.mjs; do node "$f" || echo "FAIL $f"; done
python3 firmware/deckhand_display/batt-trend-check.py
node docs/design/settings-redesign/check.mjs
# board 2 then board 1, never concurrently
```

Report board 2's flash/RAM delta against 992122 / 65604. Board 1 must be `UNCHANGED`; if it is not,
the task that moved it is not finished and must be found before anything is committed.

- [ ] **Step 4: CLAUDE.md**

Three edits, each stating what was measured rather than what was intended:

1. A new subsection under the board-2 notes describing HOME + five groups: why the band height is
   preserved (so group bodies need no new arithmetic), why `settingsPage` carries HOME rather than a
   second variable, the tap-cost change, and the fact that HOME's summary lines answer the common
   question with no tap at all.
2. **Correct the stale MIC TEST paragraph.** It currently calls the button "an open inconsistency"
   that "reaches `micMonitor()`'s stub" and paints nothing. That was true before the ES8311 capture
   path landed; the same file now documents that path as measured and working. Say plainly that the
   note was stale, not that the bug was fixed — the button was always fine once the flag flipped.
3. Record the `board_es3c35p.h:1689` comment defect as found-and-fixed, with the transferable part:
   **a comment is not parsed, so a flag that flips under it leaves prose describing a page that no
   longer compiles**, and the checker could not have caught it.

- [ ] **Step 5: commit**

```bash
git commit -m "Settings redesign: verification, sweep coverage, and the docs"
```
