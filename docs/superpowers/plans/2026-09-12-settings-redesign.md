# SETTINGS redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take SETTINGS from seven groups on board 2 plus a five-page chevron pager on board 1 to one surface of five groups on both boards.

**Architecture:** Board 2's group set shrinks first (Device absorbs Status + About + POWER OFF; Macs absorbs RESET PAIRING; Actions dissolves), paying for each removed row by restoring HOME's pitch to the value it was originally derived at. Only then does board 1 join, by flipping `BOARD_SETTINGS_HOME` to 1 — after which the `#else` arms are already dead code, so deleting them and the guard is a no-op that the binaries themselves prove.

**Tech Stack:** Arduino C++ (ESP32 / ESP32-S3), `arduino-cli`, offline Node checkers (`settings-geom-check.mjs`, `commands-check.mjs`, `geom-sweep.mjs`, `board-baseline.mjs`).

**Spec:** [`docs/superpowers/specs/2026-09-12-settings-redesign-design.md`](../specs/2026-09-12-settings-redesign-design.md)

## Global Constraints

- **There is no test suite.** The test cycle here is: add the assertion to a checker, run it and watch it **FAIL BY NAME**, make the change, run it and watch it pass. An assertion that cannot fail is a defect.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** A literal on the checker's side means reverting the constant does not fail.
- **Bind assertions to a FUNCTION BODY, not to a file.** Use `fnBody()` from `geom-common.mjs`. A rule a neighbouring line can satisfy is not a rule.
- **Fonts are ASCII `0x20..0x7E` only.** An out-of-range codepoint draws nothing and advances nothing. Three ASCII dots, never `U+2026`.
- **Every field redraws only when its value changes** (`drawIfChanged`, `drawBar`, `drawCardBorder`). A cache shorter than its string silently stops noticing changes; a field whose chrome is repainted must have its cache reset; a colour-only change must bust the cache explicitly.
- **`#if` on a C++ `const int` is silently false.** Board flags must be `#define`.
- **Never compile both boards concurrently.** `arduino-cli` derives its build directory from the sketch path. Compile one, check it, then the other. `--no-compile` flashes whichever board was compiled LAST.
- **A compile takes about 3 minutes.** Budget for it; it is not a hang.
- **Put only the fragment that differs behind an `#if`.** Arms that duplicate a whole statement break every brace-counting checker here.
- **Board baselines:** `node firmware/board-baseline.mjs --doc-check` must pass at every commit. Every binary movement is expected, measured and explained in the commit message.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

**Parsed values this plan derives from** (re-parse; do not trust these if the headers have moved):

| | board 1 (`board_e32r28t.h`) | board 2 (`board_es3c35p.h`) |
|---|---|---|
| `CONTENT_Y` / `contentBottom()` | 34 / 302 | 46 / 460 |
| `PAGE_TOP` | 80 | 104 |
| `TAP_MIN` | 40 | 46 |
| `CARD_X` / `CARD_W` / `PAD` | 12 / 216 / 14 | 12 / 296 / 18 |
| `BORDER_CARD` | 2 | 2 |
| `H_ROW` / `H_BTN` | 40 / 44 | 46 / 50 |
| `T_HEAD` / `T_BODY` = `T_META` cell | 18 / 13 | 24 / 16 |
| `T_HEAD` / `T_META` advance | 10 / 6 | 12 / 8 |

---

### Task 1: Device — board 2 absorbs About and POWER OFF, and HOME returns to 58/10

Groups go 7 → 6. `SET_STATUS` becomes `SET_DEVICE`, `SET_ABOUT` is deleted, and `POWER OFF` leaves Actions for the foot of Device. HOME's pitch pays for the removed row by returning to the six-row `58/10` it held before About.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` — the `SET_*` ids, the HOME pitch block, the `ST_*` block, new `DEV_*` constants
- Modify: `firmware/deckhand_display/settings.ino` — `settingsGroupTitle()`, `settingsHomeSummary()`, `drawStatusPageStatic()`, `renderStatusPage()`, `drawAboutPageStatic()` (deleted), `drawActionsPageStatic()`, `handleSettingsTouch()`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `homeSubCache[]`, the `P5_*` About constants (deleted), the `P2_*` Actions constants
- Test: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SET_DEVICE = 1`, `SET_GROUP_COUNT = 6`, `HOME_ROW_H = 58`, `HOME_GAP = 10`, `HOME_NAME_DY = 8`, `HOME_SUB_DY = 36`; `void drawDeviceDiagnostics(int y)` in `settings.ino`; `DEV_DIAG_Y`, `DEV_DIAG_STEP`, `DEV_DIAG_LINES`, `DEV_PWR_CAP_Y`, `DEV_PWR_BTN_Y`, `DEV_AIR_BOT` in `board_es3c35p.h`.

- [ ] **Step 1: Write the failing assertions**

In `settings-geom-check.mjs`, inside the `if (b === 2)` HOME block, replace the `ids` array with the five-group-era names and add the Device page's stack identity. Add near the existing pitch assertion:

```js
    // DEVICE's stack closes on contentBottom with a NAMED surplus, the same shape
    // HOME_Y0_BOT and PAIR_AIR_LEFT have. Without a closing term the sweep reports
    // every gap on this page as unguarded at +-16.
    {
      const diagEnd = c.DEV_DIAG_Y + c.DEV_DIAG_LINES * c.DEV_DIAG_STEP - 1;
      chk(c.ST_PWR_Y + c.ST_PWR_H <= c.DEV_DIAG_Y,
          `DEVICE: the POWER card ends (${c.ST_PWR_Y + c.ST_PWR_H}) above the DIAGNOSTICS block (${c.DEV_DIAG_Y})`);
      chk(diagEnd < c.DEV_PWR_CAP_Y,
          `DEVICE: DIAGNOSTICS ink ends ${diagEnd} above the CANNOT BE UNDONE caption at ${c.DEV_PWR_CAP_Y}`);
      chk(c.DEV_PWR_BTN_Y - c.DEV_PWR_CAP_Y === c.SET_CAP_STEP,
          `DEVICE: the caption takes SET_CAP_STEP (${c.SET_CAP_STEP}) from its button, as every caption on this tab does`);
      const stackEnd = c.DEV_PWR_BTN_Y + c.P2_BTN_H;
      chk(stackEnd + c.DEV_AIR_BOT === contentBottom,
          `DEVICE: stack ends ${stackEnd} + named surplus ${c.DEV_AIR_BOT} == contentBottom ${contentBottom}`);
      chk(c.P2_BTN_H >= c.TAP_MIN,
          `DEVICE: POWER OFF is a touch target: ${c.P2_BTN_H} >= TAP_MIN ${c.TAP_MIN}`);
    }
```

Update the two title/summary tables at the top of the checker (around lines 695 and 704):

```js
const GROUP_TITLES = ["Device", "Display", "Sound", "Pairing", "Messages", "Actions"];
const HOME_SUMMARIES = ["Both links up   100%   -10 C", "100%   sleep OFF   LIGHT",
                        "ON   volume MED   mic", "4 Macs   any may answer",
                        "send LATER", "calibrate, pairing, power"];
```

- [ ] **Step 2: Run the checker and verify it FAILS by name**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
```

Expected: FAIL lines naming `DEV_DIAG_Y`, `DEV_PWR_CAP_Y`, `DEV_PWR_BTN_Y`, `DEV_AIR_BOT` (all `undefined`, so the identities compute `NaN`) and `SET_DEVICE`. **If any of these PASS, the assertion is vacuous — fix it before going on.** A `NaN` comparison is `false`, so these fail loudly rather than silently; confirm the message names the constant.

- [ ] **Step 3: Rename the id and shrink the group count**

In `board_es3c35p.h`, replace the id line and its count. It must stay **one line** — `geom-common.mjs` parses `const int` with `/^const int (...);/m` and a wrapped declaration is invisible to every checker:

```c
const int SET_HOME = 0, SET_DEVICE = 1, SET_DISPLAY = 2, SET_SOUND = 3, SET_PAIRING = 4, SET_MESSAGES = 5, SET_ACTIONS = 6;
const int SET_GROUP_COUNT = 6;   // SET_DEVICE..SET_ACTIONS, contiguous by design
```

Delete the `ABOUT SITS BEFORE ACTIONS` paragraph above it — About no longer exists as a group, so a note explaining its position is prose describing a page that is gone.

- [ ] **Step 4: Restore the six-row pitch**

In `board_es3c35p.h`, set `HOME_ROW_H = 58`, `HOME_GAP = 10`, `HOME_NAME_DY = 8`, `HOME_SUB_DY = 36`. `HOME_Y0` (54) and `HOME_Y0_BOT` (8) do not move. The identity closes: `54 + 6*58 + 5*10 + 8 == 460`.

**Fix the stale comment at the same time.** The block above `HOME_Y0` currently reads `6*HOME_ROW_H + 5*HOME_GAP + HOME_Y0_BOT = 54 + 348 + 50 + 8 = 460` — which is the arithmetic this step makes true again, so it stops being stale by accident. Rewrite it to say so explicitly rather than leaving a comment that is only right by coincidence:

```c
// HOME owns the WHOLE content area - there is no band above it, because the tab
// bar already says SETTINGS and a second title would be chrome repeating itself.
// The pitch is derived to land exactly on contentBottom():
//   HOME_Y0 + 6*HOME_ROW_H + 5*HOME_GAP + HOME_Y0_BOT = 54 + 348 + 50 + 8 = 460
// This is the SIX-row pitch RESTORED. It held before About took the list to seven
// at 50/8; About is gone (its facts are four lines on DEVICE now), so the row
// height it cost the other six comes back. settings-geom-check.mjs asserts the
// IDENTITY rather than the value, which is what makes a row-height change fail
// here instead of silently eating the bottom row.
```

Also rewrite the row-stack comment below `HOME_ROW_H` — it currently draws the 58px stack above a `HOME_ROW_H` of 50, and this step makes 58 correct again. State the stack as `+8..+31` name, `+32..+35` gap, `+36..+51` summary, `+52..+55` pad, `+56..+57` border = 58.

- [ ] **Step 5: Add the Device page's constants**

In `board_es3c35p.h`'s `ST_*` block, slim the two live cards and add the new terms. Every value is derived, and the derivation is the comment:

```c
// THE TWO LIVE CARDS CARRY ONE LINE EACH, not two. CONNECTION shed
// `deviceName, N paired`: the name half is a fixed fact and belongs in
// DIAGNOSTICS below, the count half belongs on the Pairing group with the Macs.
// POWER shed its SoC temp line the same way. That is 84px, and it is what makes
// About's facts and POWER OFF fit on one page at all.
//   +0..+1    border
//   +8..+23   caption  (T_META 16)
//   +30..+53  hero     (T_HEAD 24)
//   +58..+73  line     (T_BODY 16)
//   +74..+77  pad
//   +78..+79  border                       = 80
const int ST_CONN_Y = 116, ST_CONN_H = 80;
const int ST_PWR_Y  = 208, ST_PWR_H  = 80;   // 12px gap under CONNECTION
const int ST_CAP_DY = 8, ST_BIG_DY = 30, ST_L1_DY = 58;
// DIAGNOSTICS: nine facts you read almost never, as four monospace lines in two
// columns under one caption. Both faces are monospace, so column alignment does
// the work uiListRow's 46px of chrome was doing - ~416px becomes ~92.
const int DEV_DIAG_CAP_Y = 300;
const int DEV_DIAG_Y     = 324;   // DEV_DIAG_CAP_Y + SET_CAP_STEP
const int DEV_DIAG_STEP  = 20;    // T_META cell 16 + 4
const int DEV_DIAG_LINES = 4;
// POWER OFF, last on the page under its own caption. Actions is dissolved, so the
// "destructive group last" rule this list used to lean on is gone; the protection
// is now POSITION plus the severity spine plus the confirm dialog, all adjacent to
// the control instead of being a property of a list you have already left.
const int DEV_PWR_CAP_Y = 386;    // DEV_DIAG_Y + DEV_DIAG_LINES*DEV_DIAG_STEP + 6
const int DEV_PWR_BTN_Y = 410;    // DEV_PWR_CAP_Y + SET_CAP_STEP
// The named surplus that closes the stack. Without it the sweep reports every gap
// on this page as unguarded at +-16 - a page with enough air in it is a page whose
// constants are constrained by nothing.
const int DEV_AIR_BOT   = 0;      // 410 + 50 == 460
```

Delete the `P5_*` block (About's geometry) from `board_es3c35p.h`.

- [ ] **Step 6: Run the checker and verify it PASSES**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
```

Expected: `0 failure(s)`. If `DEV_AIR_BOT` will not reach 0 without a negative value, the page is over-subscribed — **come back and say so rather than shrinking a face.** `board_es3c35p.h`'s own rule: "shrinking a face to fit one more row is how a menu becomes unreadable one row at a time."

- [ ] **Step 7: Prove the new assertions have teeth**

Temporarily set `DEV_DIAG_STEP` to 21 in the header and re-run. Expected: the stack identity FAILS by name. Revert. Then add a permanent injection to the checker's `SELFTEST` block, beside the existing `B[2].HOME_ROW_H += 1`:

```js
  // +1 on DEVICE's diagnostics step, the smallest change there is: four lines at
  // one extra pixel of pitch puts POWER OFF 4px past contentBottom while every
  // individual line is still inside the page. Only the closing identity sees it.
  B[2].DEV_DIAG_STEP += 1;
  console.log("--selftest: board 2's DEVICE diagnostics step widened by 1; the stack's closing identity MUST fail");
```

```bash
node firmware/deckhand_display/settings-geom-check.mjs --selftest
```

Expected: exit 0, with a `selftest: ... was caught by -` line naming the closing-identity assertion.

- [ ] **Step 8: Write the Device page**

In `settings.ino`, rename `settingsGroupTitle()`'s `case SET_STATUS:` to `case SET_DEVICE: return "Device";` and delete `case SET_ABOUT:`. In `settingsHomeSummary()`, delete the `SET_ABOUT` arm and rename `SET_STATUS` to `SET_DEVICE` (its composed summary is unchanged — links, battery, temp).

Delete `drawAboutPageStatic()` entirely and add the diagnostics block, which absorbs what it drew:

```c
// The nine facts that used to be the HOST card's four diagnostics and About's five
// rows. STATIC IN FULL for the firmware half and change-only for the live half is
// not a split worth making here: all four lines are composed each tick from globals
// and go through drawIfChanged, because "up 4h 12m" moves and a value on the static
// side is a value that goes stale silently.
void drawDeviceDiagnostics(int y) {
  drawGroupCaption("DIAGNOSTICS", DEV_DIAG_CAP_Y);
}
```

Draw the four lines from `renderStatusPage()` (rename it `renderDevicePage()`), each through `drawIfChanged` against its own cache, padded to a fixed width:

- line 0: `<payload> B per tick` left, `up %luh %02lum` right
- line 1: `flush %lu.%lu ms` left, `%d Mac%s` right
- line 2: `%s  %s` — `deviceName` and `BOARD_NAME`
- line 3: `%s %s  %s` — `__DATE__`, commit (`fwCommit[0] ? fwCommit : "unknown"`), or `BT <mac>` if the line budget allows

Keep `uiHint("unknown = flashed outside flash.sh", ...)` only if `DEV_AIR_BOT` can pay for it; if it cannot, drop the hint and say so in the commit message — the word `unknown` is self-explanatory beside a build date in a block captioned DIAGNOSTICS.

Remove the `ST_HOST_*` card and its four `drawIfChanged` calls, and remove the CONNECTION card's second line and the POWER card's temp line, moving `deviceName` and the SoC temp into the diagnostics lines above. **Delete their caches from `deckhand_display.ino`** — `stPayloadCache`, `stFlushCache`, `stUptimeCache`, `stMacsCache` are replaced by the new per-line caches; a cache left behind is dead RAM that reads as live state.

- [ ] **Step 9: Move POWER OFF and shrink `homeSubCache`**

In `drawActionsPageStatic()`, remove the `POWER OFF` button and re-derive the remaining two against `P2_*`. Draw it on Device instead, through the existing `drawSeverityAction()` so it keeps its `P2_SPINE_W` bar:

```c
  drawGroupCaption("CANNOT BE UNDONE", DEV_PWR_CAP_Y);
  drawSeverityAction(DEV_PWR_BTN_Y, "POWER OFF", COLOR_BAD);
```

In `handleSettingsTouch()`, move the `CFM_POWER_OFF` arm from the Actions page's hit test to Device's, keyed on `DEV_PWR_BTN_Y .. DEV_PWR_BTN_Y + P2_BTN_H`. **The button and its hit test move together** — a constant a draw site no longer uses but a hit test still does is exactly how a page claims taps for a button it does not draw.

In `deckhand_display.ino`, `homeSubCache` goes to six initialisers:

```c
char homeSubCache[SET_GROUP_COUNT][HOME_SUB_BYTES] = {"", "", "", "", "", ""};
```

- [ ] **Step 10: Run every offline checker**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs --selftest
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/palette-check.mjs
node firmware/deckhand_display/geom-sweep.mjs
```

Expected: all pass. `geom-sweep.mjs` takes ~110s. Any constant it reports as *unguarded though this checker reads it* must gain an assertion now, not later.

- [ ] **Step 11: Compile board 2 and re-baseline**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```

Expected: `CHANGED`, with a size drop (About's page and the HOST card are gone). Record the delta, then:

```bash
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2
```

- [ ] **Step 12: Verify board 1 did not move**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: `UNCHANGED`. Everything in this task is inside `#if BOARD_SETTINGS_HOME`. **If it reports `CHANGED (+16)` and the line says the core stamp's pooling flipped, that is the midnight `__DATE__` effect and not this task** — re-read the pooling line before concluding anything.

- [ ] **Step 13: Commit**

```bash
git add firmware/deckhand_display/
git commit -m "$(cat <<'EOF'
SETTINGS: Device absorbs About and POWER OFF, and HOME's rows grow back

About held five facts you read once, in five 46px uiListRows, and Status's HOST
card held four more in a card of its own. Together that was ~416px for nine facts
nobody watches. They are four monospace lines under one DIAGNOSTICS caption now -
both faces are monospace, so column alignment does what the row chrome was doing.

That, plus CONNECTION and POWER shedding one line each (deviceName belongs in
DIAGNOSTICS and the paired count belongs with the Macs; the SoC temp belongs with
the other diagnostics), is what lets one page hold Status, About and POWER OFF.

The group list goes seven to six and HOME's pitch returns to the 58/10 it held
before About - the row height About cost the other six comes back. The comment
above HOME_Y0 has described this exact arithmetic all along while HOME_ROW_H was
50; it is true again, and now says why rather than being right by coincidence.

Actions is down to two buttons. POWER OFF keeps its severity spine and its confirm
dialog at the foot of Device.

Board 2: <record the delta>. Board 1 UNCHANGED - all of it is inside
BOARD_SETTINGS_HOME.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Macs — RESET PAIRING joins the Macs, Actions dissolves, HOME returns to 70/12

Groups go 6 → 5. `SET_PAIRING` becomes `SET_MACS`, `SET_ACTIONS` is deleted, `RESET PAIRING` moves to the foot of Macs and `CALIBRATE TOUCH` is dropped from board 2 entirely. HOME returns to the five-row `70/12` it was designed at.

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` — the `SET_*` ids, the HOME pitch, the `P3_*` block, new `MAC_*` constants; delete the `P2_*` Actions block
- Modify: `firmware/deckhand_display/settings.ino` — `settingsGroupTitle()`, `settingsHomeSummary()`, `drawHostsPageStatic()`, `renderHostsPage()`, `drawActionsPageStatic()` (deleted), `handleSettingsTouch()`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `homeSubCache[]`, a new `p3CountCache`
- Test: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: `SET_DEVICE`, `SET_GROUP_COUNT`, `DEV_AIR_BOT` from Task 1.
- Produces: `SET_MACS = 4`, `SET_GROUP_COUNT = 5`, `HOME_ROW_H = 70`, `HOME_GAP = 12`, `HOME_NAME_DY = 14`, `HOME_SUB_DY = 44`; `P3_ROW_STEP = 52`, `P3_ROW_H = 46`, `MAC_RESET_CAP_Y`, `MAC_RESET_BTN_Y`, `MAC_AIR_BOT`; `int p3CountCache` in `deckhand_display.ino`.

- [ ] **Step 1: Write the failing assertions**

In `settings-geom-check.mjs`, add to the Pairing block:

```js
    // RESET PAIRING sits BELOW a variable-length list, so its position depends on
    // MAX_HOSTS. Walk the worst case rather than the typical one.
    {
      const lastRowEnd = c.P3_LIST_Y + (MAX_HOSTS - 1) * c.P3_ROW_STEP + c.P3_ROW_H - 1;
      chk(lastRowEnd < c.MAC_RESET_CAP_Y,
          `MACS: the ${MAX_HOSTS}th Mac row ends ${lastRowEnd} above the CANNOT BE UNDONE caption at ${c.MAC_RESET_CAP_Y}`);
      chk(c.MAC_RESET_BTN_Y - c.MAC_RESET_CAP_Y === c.SET_CAP_STEP,
          `MACS: the caption takes SET_CAP_STEP (${c.SET_CAP_STEP}) from its button`);
      const stackEnd = c.MAC_RESET_BTN_Y + c.P2_BTN_H;
      chk(stackEnd + c.MAC_AIR_BOT === contentBottom,
          `MACS: stack ends ${stackEnd} + named surplus ${c.MAC_AIR_BOT} == contentBottom ${contentBottom}`);
      chk(c.P3_ROW_H >= c.TAP_MIN,
          `MACS: a Mac row is a touch target: ${c.P3_ROW_H} >= TAP_MIN ${c.TAP_MIN} (EXACTLY the floor, no margin)`);
    }
```

`MAX_HOSTS` is a `#define` in `deckhand_display.ino`; parse it rather than writing 4:

```js
const MAX_HOSTS = +(readSource("deckhand_display.ino").match(/^#define MAX_HOSTS\s+(\d+)/m) || [])[1];
if (!MAX_HOSTS) throw new Error("MAX_HOSTS not found in deckhand_display.ino");
```

Add the count-cache assertion, bound to the function body rather than the file:

```js
    // FINDING #6 FROM THE LAST REDESIGN, and it is the one correctness bug that
    // review found: a Mac pairing while this group is open raised hostCount between
    // drawHostsPageStatic() and renderHostsPage(), painting a live dot onto bare
    // background at a row that was never drawn - and the hit test walked the same
    // count, so the right end of that invisible band forgot a Mac when tapped.
    // RESET PAIRING now sits BELOW that list, so its chrome moves with the count
    // too. The class is "a change-only field whose chrome is count-dependent needs
    // the count in its cache".
    {
      const body = fnBody(SRC_SET, "void renderHostsPage()", "settings.ino");
      chk(/p3CountCache/.test(body),
          `renderHostsPage() reads p3CountCache - the count is in the cache, so a Mac pairing while MACS is open repaints the chrome`);
      chk(/drawHostsPageStatic\(\)/.test(body),
          `renderHostsPage() repaints the chrome itself when the count changes, rather than leaving it to the next full redraw`);
    }
```

- [ ] **Step 2: Run the checker and verify it FAILS by name**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
```

Expected: FAIL naming `MAC_RESET_CAP_Y`, `MAC_RESET_BTN_Y`, `MAC_AIR_BOT` and both `p3CountCache` assertions. Confirm the `renderHostsPage()` assertions fail — `fnBody` returning the real body and the regex missing is the failure you want; a `fnBody` that threw would be a checker bug, not a test.

- [ ] **Step 3: Shrink the id set and restore the five-row pitch**

In `board_es3c35p.h`, one line as always:

```c
const int SET_HOME = 0, SET_DEVICE = 1, SET_DISPLAY = 2, SET_SOUND = 3, SET_MACS = 4, SET_MESSAGES = 5;
const int SET_GROUP_COUNT = 5;   // SET_DEVICE..SET_MESSAGES, contiguous by design
```

Set `HOME_ROW_H = 70`, `HOME_GAP = 12`, `HOME_NAME_DY = 14`, `HOME_SUB_DY = 44`. The identity closes: `54 + 5*70 + 4*12 + 8 == 460`. Rewrite the pitch comment for five rows and the row stack for 70px:

```
//   +0..+1    border
//   +14..+37  name    (T_HEAD 24)
//   +38..+43  gap 6
//   +44..+59  summary (T_BODY 16)
//   +60..+67  pad
//   +68..+69  border                                   = 70
```

**Rewrite the `ABOUT SITS BEFORE ACTIONS` / `Actions stays LAST` reasoning**, which no longer describes anything. Replace it with the reversal the spec records:

```c
// ACTIONS IS DISSOLVED, AND WITH IT THE ONE ORDERING RULE THIS LIST PROTECTED.
// The rule was "a destructive group in the middle of a menu is the one thing this
// list's order actually has to protect", and it was right while the destructive
// controls lived together. They do not any more: POWER OFF is at the foot of
// DEVICE (row 0) and RESET PAIRING at the foot of MACS (row 3), because a reset is
// a pairing thing and a power-off is a device thing - the same rule that took MIC
// TEST out of Actions and into Sound.
// THE PROTECTION MOVED RATHER THAN BEING DROPPED. Each destructive control is last
// on its page, under a CANNOT BE UNDONE caption, keeping its P2_SPINE_W severity
// bar and its confirm dialog. That is adjacency to the control instead of a
// property of a list you have already left, which is the stronger of the two - but
// it IS a knowing reversal of what this header used to say, so it says so.
```

- [ ] **Step 4: Re-cut the Mac list and add RESET PAIRING**

In `board_es3c35p.h`:

```c
const int P3_ROW_H      = 46;   // EXACTLY TAP_MIN, no margin - see the assertion
const int P3_ROW_STEP   = 52;   // 60 -> 52; four slots give back 32px, which is
                                // most of what RESET PAIRING's block costs
const int MAC_RESET_CAP_Y = 398;
const int MAC_RESET_BTN_Y = 422;   // MAC_RESET_CAP_Y + SET_CAP_STEP
const int MAC_AIR_BOT     = 0;     // 422 + 50 == 460
```

Re-derive `P3_ROW_NAME_DY` / `P3_ROW_SUB_DY` against the 46px row and assert both ends clear the border, exactly as HOME's stack does. If the numbers will not close with `MAC_AIR_BOT >= 0`, **stop and report** — the spec's named fallback is a sixth group holding both destructive verbs, not a 44px row.

- [ ] **Step 5: Put the count in the cache**

In `deckhand_display.ino`, beside the other pairing caches:

```c
// The count is a cache like every other field on this page, because the page's
// CHROME depends on it: the Mac rows AND the RESET PAIRING block below them move
// when a Mac pairs while MACS is open. -1 so the first tick always repaints.
int p3CountCache = -1;
```

In `renderHostsPage()`, first thing:

```c
  if (hostCount != p3CountCache) { p3CountCache = hostCount; drawHostsPageStatic(); }
```

- [ ] **Step 6: Move RESET PAIRING and delete Actions**

Delete `drawActionsPageStatic()` (both arms), the `P2_MIC_Y` / `P2_CAL_Y` / `P2_PAIR_Y` / `P2_PWR_Y` / `P2_SETUP_CAP_Y` / `P2_DANGER_CAP_Y` constants that only Actions used, and the Actions arm of `handleSettingsTouch()`. Keep `P2_BTN_H`, `P2_SPINE_W` and `drawSeverityAction()` — Device and Macs both use them.

On the Macs page:

```c
  drawGroupCaption("CANNOT BE UNDONE", MAC_RESET_CAP_Y);
  drawSeverityAction(MAC_RESET_BTN_Y, "RESET PAIRING", COLOR_WARN);
```

and move the `CFM_RESET_PAIRING` arm of `handleSettingsTouch()` onto `MAC_RESET_BTN_Y .. MAC_RESET_BTN_Y + P2_BTN_H`.

**`CALIBRATE TOUCH` is dropped on board 2 and does not move anywhere.** Its `CFM_RECAL` confirm arm stays for now (board 1 still reaches it through the pager); Task 5 makes `RECAL` refuse by name here.

In `deckhand_display.ino`, `homeSubCache` goes to five initialisers. Update `settingsGroupTitle()` (`case SET_MACS: return "Macs";`, `default:` returns `"Messages"`) and `settingsHomeSummary()`.

- [ ] **Step 7: Update the checker's tables and prove teeth**

```js
const GROUP_TITLES = ["Device", "Display", "Sound", "Macs", "Messages"];
```

Confirm every entry in `HOME_SUMMARIES` is still `<= HOME_SUB_CHARS` at the new group set, then add a permanent selftest injection:

```js
  // +1 on the Mac row step. With MAX_HOSTS slots that is 3px, which pushes RESET
  // PAIRING's caption onto the last Mac row's bottom border - both are drawn with
  // an opaque box, so the caption would rub out the row's outline. Nothing
  // measuring one row can see it.
  B[2].P3_ROW_STEP += 1;
  console.log("--selftest: board 2's Mac row step widened by 1; the RESET PAIRING clearance MUST fail");
```

Remove the now-stale `B[2].P3_ROW_STEP += 6` injection if it no longer names a live assertion — a selftest fault whose anchor moved is a selftest reporting teeth it no longer has.

- [ ] **Step 8: Run every offline checker**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs --selftest
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/geom-sweep.mjs
```

Expected: all pass; `--selftest` exits 0 with every injected fault caught **by name**.

- [ ] **Step 9: Compile both boards separately, re-baseline board 2, confirm board 1**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2

arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: board 2 `CHANGED` (record it), board 1 `UNCHANGED`.

- [ ] **Step 10: Commit**

```bash
git add firmware/deckhand_display/
git commit -m "$(cat <<'EOF'
SETTINGS: Actions dissolves, and HOME goes back to the pitch it was drawn at

RESET PAIRING is a pairing thing, so it goes to the foot of the Macs group where
the Macs already are - the same rule that took MIC TEST out of Actions and into
Sound, applied to what was left. CALIBRATE TOUCH is dropped on board 2 outright:
runCalibration() there is a stub that prints and returns, and settings.ino has been
carrying an open question about whether the button should exist at all.

With POWER OFF already on Device, Actions has nothing left, so the group list is
five and HOME's rows are 70/12 again - the pitch the five-card design was derived
at before MESSAGES and About ate 20px a row out of it.

This REVERSES a rule this header used to state: Actions stayed last because a
destructive group in the middle of a menu was the one thing the list's order
protected. The protection moves rather than going away - each destructive control
is now last on its own page, under CANNOT BE UNDONE, with its severity spine and
its confirm dialog. The header says so instead of leaving the old reasoning to rot.

The Mac list pays for RESET PAIRING at P3_ROW_STEP 60 -> 52, P3_ROW_H 52 -> 46.
46 is EXACTLY this board's TAP_MIN, with no margin, and the assertion says so.

hostCount is in a cache now: RESET PAIRING sits below a variable-length list, so a
Mac pairing while MACS is open moves its chrome. That is the class of last
redesign's finding #6 - the invisible row that forgot a Mac when tapped.

Board 2: <record the delta>. Board 1 UNCHANGED.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Board 1 joins — flip `BOARD_SETTINGS_HOME` to 1

Board 1 gets HOME and the five shared group pages. The guard stays in place for this task; only its **value** changes, so every `#else` arm becomes dead code without being touched. That is what makes Task 4 a provable no-op.

**Files:**
- Modify: `firmware/deckhand_display/board_e32r28t.h` — `BOARD_SETTINGS_HOME`, the `SET_*` ids, a HOME block, an `ST_*`/`DEV_*` block, `MAC_*`, `SET_CAP_STEP`
- Modify: `firmware/deckhand_display/settings.ino` — `#if BOARD_TOUCH_NEEDS_CAL` around CALIBRATE TOUCH on Display and its hit test
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `SETTINGS_PAGE_MESSAGES` alias
- Test: `firmware/deckhand_display/settings-geom-check.mjs`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: board 1's `HOME_Y0 = 42`, `HOME_ROW_H = 46`, `HOME_GAP = 6`, `HOME_Y0_BOT = 6`, `HOME_NAME_DY = 6`, `HOME_SUB_DY = 28`, `HOME_SUB_CHARS = 29`; board 1's `ST_CONN_H = 60`, `ST_PWR_H = 60`, `DEV_*`, `MAC_*`, `SET_CAP_STEP = 21`.

- [ ] **Step 1: Make the HOME assertions run on both boards**

This is the failing test. In `settings-geom-check.mjs`, change the HOME block's gate from `if (b === 2)` to run unconditionally, and change its heading comment from `(board 2 only)` to name both boards. Do the same for the group-id block, the back-band block and the Device/Macs blocks added in Tasks 1 and 2.

- [ ] **Step 2: Run the checker and verify it FAILS by name, for board 1 only**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
```

Expected: board 2 still passes; board 1 FAILS naming `HOME_Y0`, `HOME_ROW_H`, `HOME_GAP`, `SET_DEVICE`, `SET_GROUP_COUNT` and the rest as `undefined`. **This is the whole point of the task** — the checker now states what board 1 must satisfy before board 1 satisfies it.

- [ ] **Step 3: Derive board 1's HOME**

In `board_e32r28t.h`:

```c
#define BOARD_SETTINGS_HOME 1

const int SET_HOME = 0, SET_DEVICE = 1, SET_DISPLAY = 2, SET_SOUND = 3, SET_MACS = 4, SET_MESSAGES = 5;
const int SET_GROUP_COUNT = 5;

// HOME OWNS THE WHOLE CONTENT AREA and there is NO BAND ABOVE IT, so the region is
// CONTENT_Y(34)..contentBottom(302) = 268px - NOT the 222px a group PAGE gets under
// the band. That difference is the whole reason five rows fit on a 240x320 panel.
//   HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT = 42 + 230 + 24 + 6 = 302
// SEVEN ROWS WERE NEVER POSSIBLE HERE: 268px over seven rows is 38px each at zero
// gap and zero bottom pad, under this board's own TAP_MIN of 40 before a single
// pixel of gap. So "board 1 gets the menu" and "the group set shrinks to five" were
// one requirement, not two.
const int HOME_Y0     = 42;   // CONTENT_Y + 8, the pad board 2 uses
const int HOME_ROW_H  = 46;   // TAP_MIN + 6
const int HOME_GAP    = 6;
const int HOME_Y0_BOT = 6;
// Inside a 46px row, mirroring board 2's stack at this board's type scale:
//   +0..+1    border
//   +6..+23   name    (T_HEAD, Terminus 10x18)
//   +24..+27  gap 4
//   +28..+40  summary (T_BODY, Cozette 6x13)
//   +41..+43  pad
//   +44..+45  border                                   = 46
const int HOME_NAME_DY = 6;
const int HOME_SUB_DY  = 28;
// DERIVED FROM THE LANE, NOT COPIED FROM BOARD 2's 30. The row's text column runs
// from CARD_X + PAD (26) to the chevron's left edge, which is one T_HEAD advance
// left of CARD_X + CARD_W - PAD: (12+216-14-10) - (12+14) = 178px. At Cozette's 6px
// advance that is 29 characters with 4px of air. A transcribed character cap is the
// defect class this tab paid for with P3_X_W, asserted against the WRONG board's
// fingertip floor.
const int HOME_SUB_CHARS = 29;
const int HOME_SUB_BYTES = HOME_SUB_CHARS + 1;
// The step a T_META caption takes from the control it heads. Board 2's is 24 = its
// T_META cell (16) + 8; this board's cell is 13, so 21.
const int SET_CAP_STEP = 21;
```

- [ ] **Step 4: Derive board 1's Device page**

Board 1's group body is `PAGE_TOP(80) + 12 .. contentBottom(302)` = 210px, against board 2's 344. It carries **less**, and the reason is written down:

```c
// BOARD 1's DEVICE PAGE HAS NO DIAGNOSTICS BLOCK, and that is a measured decision
// rather than an omission. The four host diagnostics earn their place on board 2
// "specifically because there is no serial console in normal operation here"; this
// board has a CH340 console, so payload size, flush time, uptime and the firmware
// stamp are a `screen /dev/cu.usbserial-*` away, and WHOAMI re-emits the HELLO line
// on demand. 210px of page cannot hold them AND the two live cards AND POWER OFF,
// and the two live cards are the half you cannot get any other way.
//   +0..+1    border
//   +6..+18   caption  (T_META, Cozette 13)
//   +22..+39  hero     (T_HEAD, Terminus 18)
//   +43..+55  line     (T_BODY, Cozette 13)
//   +56..+57  pad
//   +58..+59  border                                   = 60
const int ST_CONN_Y = 92,  ST_CONN_H = 60;
const int ST_PWR_Y  = 164, ST_PWR_H  = 60;   // 12px gap
const int ST_CAP_DY = 6, ST_BIG_DY = 22, ST_L1_DY = 43;
const int DEV_PWR_CAP_Y = 236;
const int DEV_PWR_BTN_Y = 257;   // + SET_CAP_STEP (21)
const int DEV_AIR_BOT   = 1;     // 257 + H_BTN(44) == 301, contentBottom 302
```

Guard the diagnostics block in `settings.ino` so the constants and the draw site disappear together:

```c
#if BOARD_DEVICE_DIAGNOSTICS
  drawDeviceDiagnostics(DEV_DIAG_Y);
#endif
```

with `#define BOARD_DEVICE_DIAGNOSTICS 1` in `board_es3c35p.h` and `0` in `board_e32r28t.h`. **A `#define`, never a `const int`** — `#if` on a `const int` is silently false with no `-Wall` warning, and this repo has shipped that twice.

- [ ] **Step 5: Derive board 1's Macs page and `P2_*`**

Add board 1's `P3_*` re-cut, `MAC_RESET_CAP_Y`, `MAC_RESET_BTN_Y`, `MAC_AIR_BOT`, and keep `P2_BTN_H`/`P2_SPINE_W` (board 1 already has them). Board 1's `P3_ROW_H` must clear **its own** `TAP_MIN` of 40 — do not reuse board 2's 46, and do not transcribe either.

- [ ] **Step 6: Guard CALIBRATE TOUCH onto the Display group**

In `settings.ino`'s `drawDisplayPageStatic()`, put only the fragment that differs behind the guard — an `#if`/`#else` opening a brace in both arms leaves every brace-counting checker here seeing one more `{` than `}`:

```c
#if BOARD_TOUCH_NEEDS_CAL
  drawGroupCaption("SETUP", P1_CAL_CAP_Y);
  uiButton(CARD_X, P1_CAL_Y, CARD_W, P2_BTN_H, "CALIBRATE TOUCH", COLOR_ACCENT);
#endif
```

and the matching hit test in `handleSettingsTouch()` under the same guard. Assert the absence on board 2, the way `P2_MIC_Y`'s absence is already asserted:

```js
    if (b === 1) chk(c.P1_CAL_Y !== undefined, `board 1 keeps CALIBRATE TOUCH: P1_CAL_Y is declared`);
    else chk(c.P1_CAL_Y === undefined,
        `board 2 has no CALIBRATE TOUCH slot at all: P1_CAL_Y is ABSENT, not merely unread - a constant a draw site no longer uses but a hit test still does is how a page claims taps for a button it does not draw`);
```

- [ ] **Step 7: Run the checker and verify BOTH boards pass**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs --selftest
```

Expected: `0 failure(s)` on both boards. If board 1's Device page will not close with `DEV_AIR_BOT >= 0`, **stop and report** rather than shrinking a face or dropping below `TAP_MIN`.

- [ ] **Step 8: Add a board-1 selftest injection**

The existing injections are all `B[2]`, so a board-1-only regression would pass `--selftest` today:

```js
  // A BOARD-1 FAULT, because every injection above is B[2] and a selftest that only
  // perturbs board 2 says nothing about the board this task added. +1 on the row
  // height: five rows pitched to land exactly on contentBottom put the fifth row 5px
  // under the footer, while every individual row is still a touch target inside its
  // own card - invisible to anything measuring one row.
  B[1].HOME_ROW_H += 1;
  console.log("--selftest: board 1's HOME row height raised by 1; the pitch identity MUST fail");
```

```bash
node firmware/deckhand_display/settings-geom-check.mjs --selftest
```

Expected: exit 0, with a named catch for the board-1 fault.

- [ ] **Step 9: Run the rest of the offline set**

```bash
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/usage-geom-check.mjs
node firmware/deckhand_display/geom-sweep.mjs
node firmware/deckhand_display/palette-check.mjs
```

- [ ] **Step 10: Compile both boards separately and re-baseline BOTH**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1

arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```

Expected: **board 1 `CHANGED`, substantially** — this is the task that rebuilds it, and that movement is the deliverable rather than a surprise. Board 2 should be `UNCHANGED` or near it; anything large there means a shared-code change leaked out of the guards, so investigate before updating.

Record `arduino-cli`'s "Global variables use N bytes" for both boards — the two RAM figures in CLAUDE.md are hand-maintained and are not bound by `--doc-check`.

- [ ] **Step 11: Commit**

```bash
git add firmware/deckhand_display/
git commit -m "$(cat <<'EOF'
Board 1 gets the SETTINGS menu, and the chevron pager stops being its navigation

BOARD_SETTINGS_HOME flips to 1 here. Board 1 opens SETTINGS on HOME - five rows,
each with a live summary - instead of paging through five screens with no way to
skip. Every group is one tap away and the summaries answer most of the questions
without a tap at all.

The geometry is DERIVED, not scaled from board 2. HOME has no band above it, so the
region is CONTENT_Y(34)..contentBottom(302) = 268px rather than the 222px a group
page gets, and 42 + 5*46 + 4*6 + 6 == 302 closes it with rows 6px over TAP_MIN.
Seven rows were never possible here - 38px each before a single pixel of gap.

Nothing in the four existing page bodies moves vertically: PAGE_TOP is
CONTENT_Y + PAGER_H + 4 and the back band takes the pager's height exactly, which
is the same property that made board 2's version affordable.

Board 1's DEVICE page carries no DIAGNOSTICS block, and the header says why: those
four facts earn their place on board 2 because it has no serial console in normal
operation. This board has a CH340. 210px of page cannot hold them and the two live
cards and POWER OFF, and the live cards are the half a console cannot give you.

CALIBRATE TOUCH is now behind BOARD_TOUCH_NEEDS_CAL on the Display group, so it
exists on board 1 and is absent - constant and hit test both - on board 2.

settings-geom-check.mjs runs its HOME assertions on BOTH boards now, and gains a
board-1 selftest injection: every fault it carried was B[2], so a board-1 regression
would have passed a green selftest.

Board 1 CHANGED deliberately, <record the delta> - this is the commit that rebuilds
it. Board 2 <record>.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Delete the guard and the dead arms — and prove it changed nothing

After Task 3 both boards take the `BOARD_SETTINGS_HOME 1` branch, so every `#else` arm is already excluded by the preprocessor. Deleting them cannot move either binary, and **that is the test**.

**Files:**
- Modify: `firmware/deckhand_display/settings.ino` — delete 15 guard sites and every `!BOARD_SETTINGS_HOME` arm
- Modify: `firmware/deckhand_display/deckhand_display.ino` — delete 13 guard sites, `SETTINGS_PAGES`, the `SETTINGS_PAGE_MESSAGES` `#if`
- Modify: both board headers — delete `#define BOARD_SETTINGS_HOME`

**Interfaces:**
- Consumes: Task 3's flipped guard.
- Produces: no new symbols. Removes `drawPager()`, `SETTINGS_PAGES`, `gotoSettingsPage()`, `renderMacLinkRows()`, `drawConnRow()`.

- [ ] **Step 1: Record the pre-deletion hashes**

```bash
node firmware/board-baseline.mjs --doc-check
sha256sum /tmp/b1/deckhand_display.ino.bin /tmp/b2/deckhand_display.ino.bin
```

Write both hashes down. They are the expected result of Step 4.

- [ ] **Step 2: Delete the dead arms**

In `settings.ino` and `deckhand_display.ino`, remove every `#if !BOARD_SETTINGS_HOME` block and its contents, unwrap every `#if BOARD_SETTINGS_HOME` block (keeping the contents), and delete the `#else` arms. That removes `drawPager()`, `gotoSettingsPage()`, the 45/55 band split in `handleSettingsTouch()`, board 1's `drawStatusPageStatic()`/`renderStatusPage()`/`drawConnRow()`/`renderMacLinkRows()`/`drawControlsPageStatic()`/`renderControlsPage()`, the `titles[]` array, and `const int SETTINGS_PAGES = 5;`.

`SETTINGS_PAGE_MESSAGES` loses its `#if` and becomes `const int SETTINGS_PAGE_MESSAGES = SET_MESSAGES;`.

Delete `#define BOARD_SETTINGS_HOME` from both headers.

- [ ] **Step 3: Verify no dead guards remain**

```bash
grep -rn 'BOARD_SETTINGS_HOME\|SETTINGS_PAGES\|drawPager\|gotoSettingsPage\|renderMacLinkRows' firmware/deckhand_display/
```

Expected: no matches outside comments describing the history. `geom-common.mjs` exports `deadGuards()` for exactly this; `settings-geom-check.mjs` should assert the absence so the deletion cannot be half-reverted later.

- [ ] **Step 4: Compile both boards separately and prove the binaries did not move**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1b firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1b/deckhand_display.ino.bin --check 1

arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2b firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2b/deckhand_display.ino.bin --check 2
```

Expected: **`UNCHANGED` on both boards.** Deleting code the preprocessor was already excluding cannot change a byte.

**If either reports `CHANGED`, do not update the baseline.** Either something live was deleted, or the pooling line says the core `__DATE__` stamp's pooling flipped — read that line before concluding anything, because the first build after midnight reports `CHANGED (+16)` on both boards with no source change at all. If the pooling is unchanged and the binary moved, the deletion took something real with it; find it.

- [ ] **Step 5: Run the full offline set**

```bash
node firmware/deckhand_display/settings-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs --selftest
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/geom-sweep.mjs
```

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/
git commit -m "$(cat <<'EOF'
Delete BOARD_SETTINGS_HOME and the pager, and let the binaries prove it was a no-op

Both boards took the HOME branch as of the previous commit, so every #else arm was
already excluded by the preprocessor. Removing them, the 28 guard sites, drawPager,
SETTINGS_PAGES, gotoSettingsPage, the 45/55 band split and renderMacLinkRows cannot
move a byte - and BOTH BASELINES REPORT UNCHANGED, which is the evidence rather
than the argument.

This also retires a verification burden the settings reference records: proving
board-1 safety meant preprocessing both shared files at board 1's real macro values
and diffing them at every task, which is only necessary while there are two arms.
There is one now. It serves CLAUDE.md's rule about #if arms that duplicate a whole
statement being hostile to every brace-counting checker here, for the same reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `RECAL` refuses by name on board 2, and `PAGE` becomes one range

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `UNAVAILABLE_COMMANDS[]`, the `PAGE` handler
- Modify: `firmware/deckhand_display/touch_cal.ino` — guard `runCalibration()`'s stub
- Test: `firmware/deckhand_display/commands-check.mjs`

**Interfaces:**
- Consumes: `BOARD_TOUCH_NEEDS_CAL`, `SET_GROUP_COUNT` from earlier tasks.
- Produces: no new symbols.

- [ ] **Step 1: Write the failing assertion**

`commands-check.mjs` already fails by verb name when a verb is neither handled nor refused. Add an assertion that `RECAL` is refused on board 2 specifically, and that the refusal's guard is the **exact negation** of the handler's:

```js
  chk(refusedOn(2, "RECAL"),
      `RECAL is refused BY NAME on board 2 - from the Mac, silence and "impossible here" look identical`);
  chk(!handledOn(2, "RECAL"),
      `RECAL has no handler on board 2: the refusal's guard is the exact negation of the handler's, so the two cannot both be live or both be absent`);
```

- [ ] **Step 2: Run and verify it FAILS by name**

```bash
node firmware/deckhand_display/commands-check.mjs
```

Expected: FAIL naming `RECAL`.

- [ ] **Step 3: Guard the handler and add the refusal**

Put `runCalibration()`'s call site behind `#if BOARD_TOUCH_NEEDS_CAL`, and add to `UNAVAILABLE_COMMANDS[]` under `#if !BOARD_TOUCH_NEEDS_CAL`. The cause names what is absent, per the table's own rule that "PERF is board 2 only" tells a reader nothing they cannot see:

```c
  { "RECAL",
    "it runs the 5-tap affine calibration in touch_cal.ino and writes the mapping to NVS. "
    "This board is BOARD_TOUCH_NEEDS_CAL 0 - its touch controller lives inside the ST77922 "
    "and is factory-aligned, so there is no mapping of ours to fit and runCalibration() was "
    "a stub that printed and returned. CALIBRATE TOUCH is gone from the Display group here "
    "for the same reason." },
```

Delete the `CFM_RECAL` confirm arm's `#else` branch (the "factory-aligned; there is nothing to do" dialog) — with the button and the verb both gone on board 2, a dialog explaining that the control does nothing is describing a control that no longer exists.

- [ ] **Step 4: Collapse `PAGE`'s two ranges into one**

`PAGE 0..4` (board 1) and `PAGE 0..7` (board 2) become `PAGE 0..SET_GROUP_COUNT`. In `deckhand_display.ino` around the `TAB_SETTINGS` arm, delete the board-1 modulo wrap and keep:

```c
    if (currentTab == TAB_SETTINGS) { if (pg <= SET_HOME) settingsBack(); else openSettingsGroup(pg); }
```

The refusal for an out-of-range `n` must name the range it checked against, not just say "out of range".

- [ ] **Step 5: Run the checkers**

```bash
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/commands-check.mjs --selftest
node firmware/deckhand_display/settings-geom-check.mjs
```

Expected: all pass.

- [ ] **Step 6: Compile both boards separately, re-baseline both, commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2
git add firmware/deckhand_display/ && git commit -m "RECAL refuses by name on board 2, and PAGE becomes one range on both

..."
```

---

### Task 6: The mock, the docs, and the numbers that bind them

**Files:**
- Modify: `docs/design/settings-redesign/{settings.html,settings.js,check.mjs,README.md}`
- Modify: `docs/reference/settings-tab.md`
- Modify: `CLAUDE.md` — the `PAGE` row of the command table, the two flash figures, the two RAM figures
- Test: `docs/design/settings-redesign/check.mjs`, `node firmware/board-baseline.mjs --doc-check`

**Interfaces:**
- Consumes: every constant from Tasks 1-5.
- Produces: documentation only.

- [ ] **Step 1: Re-draw the mock for the five pages**

`check.mjs` parses `board_es3c35p.h` through the geometry checkers' own `consts()` and asserts every shared constant by name, so it fails as soon as Task 1 lands. Update `settings.js` to draw HOME's five rows at `70/12`, the Device page, the Macs page with RESET PAIRING, and move today's seven-group geometry into the `WAS` table.

**The `WAS` table stays deliberately unbound, and every entry in it must actually DIFFER from what ships** — a live constant parked there escapes the bind, which is the class this mock was fixed for once already.

- [ ] **Step 2: Verify the mock is bound, by injection**

```bash
node docs/design/settings-redesign/check.mjs
```

Expected: pass. Then change `HOME_ROW_H` in `board_es3c35p.h` from 70 to 71, re-run, and confirm it **fails by name down the derivation chain** rather than reporting "50/50 passed". Revert.

- [ ] **Step 3: Rewrite `docs/reference/settings-tab.md`**

Correct in place; **do not delete what it says about the seven-group version.** A described defect that no longer exists costs the next reader either the time to disprove it or a no-op "fix", so entries that turned out to be wrong are kept and marked. Specifically keep, and mark as superseded: the HOME-replaces-the-pager reasoning, the five review findings (each names a class, not an instance), and finding #6.

Add: the five-group set and why Actions dissolved; the pitch walking back `50/8 → 58/10 → 70/12`; board 1's derivation and the 268-vs-222 distinction; the destructive-order reversal; board 1's Device page carrying no diagnostics and why; the two stale comments that were fixed and what class they were.

- [ ] **Step 4: Update `CLAUDE.md`**

- The `TAB 0..2` / `PAGE 0..4` / `PAGE 0..7` row becomes one range, `PAGE 0..5`, on both boards.
- Add `RECAL` to the list of verbs refused on board 2.
- Update the two **flash** figures in the two-board table and the two hashes under *BOARD 1'S BINARY IS A CONTRACT*.
- Update the two **RAM** figures by hand from `arduino-cli`'s "Global variables use N bytes" — they are NOT bound by `--doc-check` and will silently rot otherwise.

- [ ] **Step 5: Prove the doc figures are bound**

```bash
node firmware/board-baseline.mjs --doc-check
```

Expected: pass. Then change one flash figure in `CLAUDE.md` by a digit, re-run, confirm it FAILS, revert. Four of the six numbers are bound; the two RAM figures are not, which is why Step 4 does them by hand.

- [ ] **Step 6: On the glass**

The offline set proves geometry and arithmetic and nothing about colour or touch. **The previous SETTINGS redesign shipped with nothing on the glass across five tasks.** Flash both boards and walk it:

```bash
./flash.sh              # board 1
./flash.sh --board 2    # board 2
```

Then, for each board, via `~/.claude/deckhand-device-command`:

- `PAGE 0` then `PAGE 1..5` — every group on the glass
- `SCREENSHOT` at each — geometry only. **On board 2 this reads the shadow framebuffer and vouches for what the renderer composed, not for what the panel shows.**
- `THEME dark`, `THEME light` at each — both palettes
- Tap every control by hand; the device has no remote tap, so no checker can do this
- Confirm POWER OFF and RESET PAIRING each raise their confirm dialog from their new positions, and that no tap in the gaps raises one
- Pair a second Mac **while the Macs group is open** and confirm the list and RESET PAIRING both repaint — this is finding #6's exact scenario

A person, not a screenshot, settles the severity spine's greyscale claim: `palette-check.mjs` can test a colour pair and nothing in this repo tests a SHAPE.

**If a board is not available, write that down as unverified in `docs/reference/settings-tab.md` rather than leaving it implied.**

- [ ] **Step 7: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: the settings reference, the mock and CLAUDE.md catch up with five groups

..."
```

---

## Self-review notes

- **Spec coverage.** HOME both boards → Tasks 1, 2, 3. Device → 1 (b2), 3 (b1). Display/Sound split → 3 (a consequence of one code path). Macs → 2, 3. Messages → unchanged, correct. Guard deletion → 4. `RECAL`/`PAGE` → 5. Checkers/mock/docs/baselines → 6. Every open question in the spec has a stop-and-report step attached rather than a guess.
- **The three open numbers** (`DEV_AIR_BOT` on board 2, board 1's Device derivation, `P3_ROW_H 46`) each appear as an explicit "stop and report" in the task that would discover them, with the spec's named fallback rather than an invitation to shrink a font.
- **Naming is consistent across tasks:** `SET_DEVICE` / `SET_MACS` / `SET_GROUP_COUNT` / `DEV_*` / `MAC_*` / `drawDeviceDiagnostics()` / `p3CountCache` / `BOARD_DEVICE_DIAGNOSTICS` are used with the same spelling everywhere they appear.
