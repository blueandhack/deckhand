# Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the device a DARK and a LIGHT theme, switchable on the SETTINGS page and remembered across reboots, with both palettes validated for contrast and colourblind separability.

**Architecture:** The nine `COLOR_*` tokens stop being `const` and become mutable globals fed from a `THEMES[2]` table by `applyTheme()`. Because the names are unchanged, none of their 385 usage sites are touched. A theme switch calls the existing `forceFullRepaint()`.

**Tech Stack:** Arduino C++ for ESP32 (TFT_eSPI, Preferences/NVS), plus one Node ESM script for palette validation. `arduino-cli` is installed and configured for this board.

**Spec:** `docs/superpowers/specs/2026-08-14-theme-system-design.md`

## Global Constraints

- **RGB565 everywhere.** Colours are 16-bit `uint16_t`. The exact values are in the spec's palette table and in Task 1's validator; use those, do not re-derive them.
- **A theme switch MUST call `forceFullRepaint()`.** Every change-only cache in this sketch keys on *content* — `drawIfChanged` on the text, `drawPaceBar` on `(pct, tick)` — so a colour-only change is otherwise skipped entirely and the screen keeps the old palette.
- **Status must never be carried by colour alone.** Shape encoding (filled circle / filled square / hollow ring; solid / outlined / boxless pill) is existing behaviour and must not be weakened. Do not remove or simplify it while changing colours.
- **DARK is exactly today's palette.** Its values are restated as table data, not adjusted. That includes its one sub-AA pair (`good` on `card`, 3.38) — leave it.
- **No new SETTINGS page and no geometry growth.** The toggle joins the existing bottom row of the DISPLAY & SOUND page.
- **Compile with:** `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
- **Flash with:** `arduino-cli upload -p "$(ls /dev/cu.usbserial-* | head -1)" --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" firmware/deckhand_display` — the `FlashMode=dio,FlashFreq=80,UploadSpeed=115200` options are required for this exact board.

---

### Task 1: Palette validator

The authoritative palette values live here, checked rather than asserted. This task comes first because Task 2 copies its numbers into the firmware.

**Files:**
- Create: `firmware/deckhand_display/palette-check.mjs`

**Interfaces:**
- Produces: the validated RGB565 values Task 2 hard-codes into `THEMES[2]`. Run `node firmware/deckhand_display/palette-check.mjs` to print them.

- [ ] **Step 1: Write the validator with a self-test that must fail**

The `--selftest` flag is the point of this step: it feeds a deliberately bad palette through the same checks and expects rejection. Without it the checker could pass everything and nobody would know — a checker that cannot fail is not a check.

Create `firmware/deckhand_display/palette-check.mjs`:

```javascript
#!/usr/bin/env node
// Validates the device's colour palettes. Run with no arguments to check the shipped
// themes; run with --selftest to prove the checks can actually fail.
//
// Two properties matter, and contrast alone is not enough. The first LIGHT candidate for
// this feature had BETTER contrast than DARK and still failed, because its three status
// colours sat at nearly one lightness - in greyscale they were indistinguishable. So this
// checks separability too, under a deuteranope approximation and by luminance.
//
// The device also encodes status by SHAPE, independently of colour. That is what makes a
// palette merely bad rather than unusable if it regresses - but the colour half should
// still work for people who can see it.

const to888 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
const from888 = (r, g, b) =>
  ((Math.round(r / 255 * 31) << 11) | (Math.round(g / 255 * 63) << 5) | Math.round(b / 255 * 31)) >>> 0;
const hex = (c) => "0x" + c.toString(16).toUpperCase().padStart(4, "0");
const css = (c) => "#" + to888(c).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => { const [r, g, b] = to888(c); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Brettel-style deuteranope approximation - coarse, but enough to catch collisions.
const deuter = (c) => {
  const [r, g, b] = to888(c);
  return from888(Math.min(255, 0.625 * r + 0.375 * g), Math.min(255, 0.700 * g + 0.300 * r),
                 Math.min(255, 0.300 * g + 0.700 * b));
};
const dist = (a, b) => {
  const [A, B] = [to888(a), to888(b)];
  return Math.round(Math.sqrt(A.reduce((s, v, i) => s + (v - B[i]) ** 2, 0)));
};

// THESE ARE THE SHIPPED VALUES. firmware/deckhand_display/deckhand_display.ino's THEMES[]
// table must match them exactly.
export const THEMES = [
  { name: "DARK",
    bg: 0x0000, card: 0x18C4, label: 0x8410, value: 0xFFFF, accent: 0xFD20,
    good: 0x0396, warn: 0xE4E0, bad: 0xCBD4, unknown: 0x7BEF },
  { name: "LIGHT",
    bg: 0xEF5C, card: 0xFFFF, label: 0x62CA, value: 0x18C3, accent: 0xB240,
    good: 0x12F4, warn: 0xB3A0, bad: 0x6887, unknown: 0x8C30 },
];

// Thresholds. TEXT_MIN is 3.0 not 4.5 on purpose: DARK ships at 3.38 for good-on-card and
// LIGHT at 3.80 for warn-on-card, both of which are pill fills and bar segments rather
// than body text. Raising this to 4.5 would fail the palette we deliberately chose.
const TEXT_MIN = 3.0;
const DEUTER_MIN = 40;   // below this two status colours look alike to a deuteranope
const LUM_MIN = 6;       // percent; below this they merge in greyscale

const PAIRS = [["value", "bg"], ["value", "card"], ["label", "bg"], ["label", "card"],
               ["accent", "bg"], ["accent", "card"], ["good", "card"], ["warn", "card"],
               ["bad", "card"]];

function check(theme, quiet = false) {
  const fails = [];
  if (!quiet) {
    console.log(`\n=== ${theme.name} ===`);
    for (const k of ["bg", "card", "label", "value", "accent", "good", "warn", "bad", "unknown"])
      console.log(`  ${k.padEnd(8)} ${hex(theme[k])}  ${css(theme[k])}`);
  }
  for (const [fg, bg] of PAIRS) {
    const r = contrast(theme[fg], theme[bg]);
    if (!quiet) console.log(`  contrast ${fg}/${bg}: ${r.toFixed(2)}${r < TEXT_MIN ? "  FAIL" : ""}`);
    if (r < TEXT_MIN) fails.push(`${theme.name}: ${fg} on ${bg} contrast ${r.toFixed(2)} < ${TEXT_MIN}`);
  }
  for (const [a, b] of [["good", "warn"], ["good", "bad"], ["warn", "bad"]]) {
    const d = dist(deuter(theme[a]), deuter(theme[b]));
    const l = Math.round(Math.abs(lum(theme[a]) - lum(theme[b])) * 100);
    if (!quiet) console.log(`  status ${a}/${b}: deuteranope ${d}, luminance gap ${l}%` +
                            `${d < DEUTER_MIN && l < LUM_MIN ? "  FAIL" : ""}`);
    // Either separator is enough: distinct hue for those who see it, distinct lightness
    // for those who do not.
    if (d < DEUTER_MIN && l < LUM_MIN)
      fails.push(`${theme.name}: ${a}/${b} indistinguishable (deuteranope ${d}, luminance ${l}%)`);
  }
  return fails;
}

if (process.argv.includes("--selftest")) {
  // A palette that must be rejected: grey text on grey, and three status colours that are
  // the same hue at the same lightness.
  const bad = { name: "SELFTEST-BAD", bg: 0x8410, card: 0x8410, label: 0x8410, value: 0x8410,
                accent: 0x8410, good: 0x07E0, warn: 0x07E0, bad: 0x07E0, unknown: 0x8410 };
  const fails = check(bad, true);
  if (fails.length === 0) {
    console.error("SELFTEST FAILED: the checker accepted a deliberately broken palette.");
    process.exit(1);
  }
  console.log(`selftest ok - rejected the bad palette with ${fails.length} finding(s)`);
  process.exit(0);
}

let all = [];
for (const t of THEMES) all = all.concat(check(t));
console.log("");
if (all.length) {
  for (const f of all) console.error("  FAIL " + f);
  process.exit(1);
}
console.log(`Both palettes pass (${THEMES.length} themes, ${PAIRS.length} contrast pairs, 3 status pairs each).`);
```

- [ ] **Step 2: Prove the checker can fail**

Run: `node firmware/deckhand_display/palette-check.mjs --selftest`
Expected: `selftest ok - rejected the bad palette with N finding(s)`, exit 0. If it instead prints `SELFTEST FAILED`, the thresholds are wrong and the checker is vacuous — fix it before continuing.

- [ ] **Step 3: Check the shipped palettes**

Run: `node firmware/deckhand_display/palette-check.mjs`
Expected: exit 0, ending `Both palettes pass (2 themes, 9 contrast pairs, 3 status pairs each).` Every printed contrast is ≥ 3.00; DARK's lowest is `good/card 3.38` and LIGHT's is `warn/card 3.80`.

- [ ] **Step 4: Commit**

```bash
git add firmware/deckhand_display/palette-check.mjs
git commit -m "Add a palette validator with a self-test that proves it can fail"
```

---

### Task 2: Theme table, mutable tokens, and the crosshair fix

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (the `COLOR_*` block at lines 218-231; `drawCrosshair()` around line 378)

**Interfaces:**
- Consumes: the RGB565 values from Task 1's `THEMES` export.
- Produces: `void applyTheme(uint8_t idx)`, `uint8_t themeIndex`, and `const int THEME_COUNT`. Task 3 calls `applyTheme()` and persists `themeIndex`.

- [ ] **Step 1: Replace the token block with a table plus mutable globals**

In `firmware/deckhand_display/deckhand_display.ino`, replace the whole block from `const uint16_t COLOR_BG = TFT_BLACK;` through `const uint16_t COLOR_UNKNOWN = 0x7BEF;` with this. **Keep the existing Okabe-Ito comment** — it is the reason the status trio is blue/orange/purple and must not be lost:

```cpp
// ---------- Colour tokens ----------
// NOT const: these are the live palette, rewritten by applyTheme() from the THEMES table
// below. They stay plain globals with their original names deliberately - the nine names
// are referenced 385 times across this sketch, and keeping them means a whole theme system
// costs zero changes at those call sites.
uint16_t COLOR_BG = TFT_BLACK;
uint16_t COLOR_CARD = 0x18C4;     // dark slate card fill, lifts off pure black
uint16_t COLOR_LABEL = 0x8410;    // mid grey
uint16_t COLOR_VALUE = TFT_WHITE;
uint16_t COLOR_ACCENT = 0xFD20;   // Claude orange
// Colorblind-safe trio (Okabe-Ito palette: blue / orange / reddish-purple).
// A green/yellow/red traffic-light scheme is the single worst choice here -
// it collapses under red-green color vision deficiency, the most common
// type. Blue vs. orange vs. purple stays distinguishable under protanopia,
// deuteranopia, and tritanopia alike.
uint16_t COLOR_GOOD = 0x0396;     // blue, <70% / waiting for input
uint16_t COLOR_WARN = 0xE4E0;     // orange, 70-89% / working
uint16_t COLOR_BAD = 0xCBD4;      // reddish-purple, >=90%
uint16_t COLOR_UNKNOWN = 0x7BEF;  // grey, no data yet / stale

// The palettes, as data. Values are validated by palette-check.mjs, which must be kept in
// step with this table - it checks text contrast AND that the status trio stays separable
// both for a deuteranope and in greyscale. LIGHT inverts the figure/ground relationship
// (grey page, white cards) and darkens the hues, because the DARK values were chosen
// against black and lose contrast on white.
struct Theme {
  const char* name;
  uint16_t bg, card, label, value, accent, good, warn, bad, unknown;
};
const Theme THEMES[] = {
  { "DARK",  0x0000, 0x18C4, 0x8410, 0xFFFF, 0xFD20, 0x0396, 0xE4E0, 0xCBD4, 0x7BEF },
  { "LIGHT", 0xEF5C, 0xFFFF, 0x62CA, 0x18C3, 0xB240, 0x12F4, 0xB3A0, 0x6887, 0x8C30 },
};
const int THEME_COUNT = sizeof(THEMES) / sizeof(THEMES[0]);
uint8_t themeIndex = 0;
```

- [ ] **Step 2: Add `applyTheme()`**

Put this immediately after the block above. It only assigns — the repaint is the caller's job, because `setup()` needs the values set *before* the first draw, while a live switch needs a repaint after.

```cpp
// Copies one palette into the live tokens. Does NOT repaint: setup() needs the values in
// place before its first draw, whereas a runtime switch must repaint afterwards. A caller
// that forgets forceFullRepaint() leaves the screen showing the previous palette, because
// every change-only cache here keys on content rather than colour.
void applyTheme(uint8_t idx) {
  if (idx >= THEME_COUNT) idx = 0;
  themeIndex = idx;
  const Theme& t = THEMES[idx];
  COLOR_BG = t.bg;
  COLOR_CARD = t.card;
  COLOR_LABEL = t.label;
  COLOR_VALUE = t.value;
  COLOR_ACCENT = t.accent;
  COLOR_GOOD = t.good;
  COLOR_WARN = t.warn;
  COLOR_BAD = t.bad;
  COLOR_UNKNOWN = t.unknown;
}
```

- [ ] **Step 3: Fix the invisible crosshair**

`drawCrosshair()` draws in literal `TFT_WHITE`. Under LIGHT that is white on near-white — invisible, so touch calibration becomes impossible to complete. Replace both lines:

```cpp
  tft.drawFastHLine(x - 10, y, 21, TFT_WHITE);
  tft.drawFastVLine(x, y - 10, 21, TFT_WHITE);
```

with:

```cpp
  // COLOR_VALUE, not TFT_WHITE: calibration clears to COLOR_BG first, so a literal white
  // crosshair is invisible under the LIGHT theme and the user cannot finish a calibration
  // they cannot see. The token is near-black on LIGHT and white on DARK - correct in both.
  tft.drawFastHLine(x - 10, y, 21, COLOR_VALUE);
  tft.drawFastVLine(x, y - 10, 21, COLOR_VALUE);
```

- [ ] **Step 4: Confirm no other literal colour sits on a draw path**

Run: `grep -n 'TFT_BLACK\|TFT_WHITE' firmware/deckhand_display/deckhand_display.ino`
Expected: exactly two hits, both inside the token declarations (`COLOR_BG = TFT_BLACK`, `COLOR_VALUE = TFT_WHITE`). Any other hit is a colour that will not follow the theme — report it rather than fixing it silently.

- [ ] **Step 5: Confirm the table matches the validator**

Run: `node firmware/deckhand_display/palette-check.mjs | grep -E '0x'`
Then compare against the `THEMES[]` rows you just wrote. Every one of the 18 values must match. A mismatch means the firmware ships a palette nothing has validated.

- [ ] **Step 6: Compile**

Run: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: success. Record the flash and RAM figures — the previous build was **1297486 bytes flash, 76532 RAM**, and this task should move flash by well under a kilobyte and RAM by roughly the size of the table (~40 bytes) plus 18 bytes of now-mutable tokens.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Make the colour tokens a runtime palette, and fix the invisible crosshair"
```

---

### Task 3: The toggle, persistence, and docs

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (bottom-row geometry near line 4032; `renderControlsPage()`; `handleSettingsTouch()`; `setup()`)
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (regenerate — never hand-edit)
- Modify: `README.md`

**Interfaces:**
- Consumes: `applyTheme(uint8_t)`, `themeIndex`, `THEME_COUNT`, `THEMES[].name` from Task 2.

- [ ] **Step 1: Make the bottom row three toggles wide**

The row currently holds two half-width toggles. Replace the two geometry constants:

```cpp
const int P1_HALF_W  = (CARD_W - 8) / 2;      // two toggles share the bottom row
const int P1_FLIP_X  = CARD_X + P1_HALF_W + 8;
```

with thirds. `(216 - 16) / 3 = 66px` each, and the longest label (`FLIPPED`, 7 chars at Cozette's 6px advance) is 42px, so it fits:

```cpp
// Three toggles share the bottom row: SOUND | FLIPPED | theme. (216-16)/3 = 66px each
// against a longest label of 42px (FLIPPED at Cozette's 6px advance), so no new page and
// no geometry growth were needed to add the theme switch.
const int P1_THIRD_W = (CARD_W - 16) / 3;
const int P1_FLIP_X  = CARD_X + P1_THIRD_W + 8;
const int P1_THEME_X = CARD_X + 2 * (P1_THIRD_W + 8);
```

- [ ] **Step 2: Draw the third toggle**

In `renderControlsPage()`, the two `uiToggle` calls currently use `P1_HALF_W`. Change both to `P1_THIRD_W` and add the theme toggle after them:

```cpp
    uiToggle(CARD_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, "SOUND", "MUTED", beepEnabled);
```
```cpp
    uiToggle(P1_FLIP_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, "FLIPPED", "NORMAL", screenFlipped);
    // Labelled by what tapping GIVES you, matching its neighbours: the pill reads LIGHT
    // when light is active, the same way FLIPPED reads when flipped is active.
    uiToggle(P1_THEME_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, "LIGHT", "DARK", themeIndex == 1);
```

- [ ] **Step 3: Split the row's hit-testing three ways**

In `handleSettingsTouch()`, the row is currently split in two on `sx < P1_FLIP_X`. The sound branch keeps that bound; the flip branch must gain an upper bound, and a third branch is added. Replace the two existing conditions:

```cpp
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx < P1_FLIP_X) {
```
stays as-is, and:
```cpp
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx >= P1_FLIP_X) {
```
becomes:
```cpp
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx < P1_THEME_X) {
```

Then, immediately after that branch's closing brace and before the next `else if`, add the theme branch:

```cpp
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx >= P1_THEME_X) {
      applyTheme((themeIndex + 1) % THEME_COUNT);
      prefs.putUChar("theme", themeIndex);
      // Mandatory, not cosmetic: every change-only cache in this sketch keys on content,
      // so without a full repaint the screen keeps the old palette until something else
      // happens to change a value.
      forceFullRepaint();
```

- [ ] **Step 4: Load the stored theme at boot**

In `setup()`, `loadOrRunCalibration()` is where `prefs.begin()` happens, and `loadScreenFlip()` sits just after it. Add the theme load on the line immediately after `loadScreenFlip();`:

```cpp
  // After prefs.begin() (inside loadOrRunCalibration) and BEFORE the first draw, so the
  // opening screen is already in the right palette rather than flashing the default.
  // Wake from deep sleep re-runs setup(), so this restores the theme then too.
  applyTheme(prefs.getUChar("theme", 0));
```

- [ ] **Step 5: Compile**

Run: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: success.

- [ ] **Step 6: Flash and check both themes on the hardware**

```bash
pkill -f 'DeckhandBLE.app/Contents/MacOS/Deckhand' || true
sleep 2
arduino-cli upload -p "$(ls /dev/cu.usbserial-* | head -1)" \
  --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" \
  firmware/deckhand_display
open host/DeckhandBLE.app --args "$(pwd)/host/index.mjs"
```

Then on the device: SETTINGS → `›` to DISPLAY & SOUND → tap the third toggle. Check each of these and report what you see, with specifics rather than "looks fine":

1. All three tabs in LIGHT — USAGE (cards, bars, the CODEX row), SESSIONS (rows, pills, the spinner), SETTINGS (all four pages).
2. **Switch themes while the SESSIONS list has rows in it.** This is the specific check for the cache trap: a stale-coloured field anywhere means `forceFullRepaint()` is not reaching it.
3. The footer and tab bar, which are drawn by `forceFullRepaint()` separately from the content.
4. Reboot (RESET) and confirm the theme persisted.
5. The FAB's ring, which relies on 1px `COLOR_BG` haloes to stay visible over content.

- [ ] **Step 7: Document it**

In `CLAUDE.md`, add a bullet to the rendering/UI notes covering: the tokens are no longer `const` and are fed from `THEMES[]` by `applyTheme()`; the 385-call-site reason that shape was chosen; that a switch MUST call `forceFullRepaint()` because the caches key on content; that `palette-check.mjs` validates contrast plus deuteranope and greyscale separability and has a `--selftest` proving it can fail; that the first LIGHT candidate passed contrast but failed separability at 4/1/5% luminance gaps; that DARK keeps its own sub-AA `good`-on-`card` pair deliberately; that `drawCrosshair` uses `COLOR_VALUE` because literal white is invisible under LIGHT; and that the crab stays dark because its alpha is composited against `COLOR_BG` at build time.

In `README.md`, add the toggle to the SETTINGS bullet's DISPLAY & SOUND description (it now lists three toggles sharing the bottom row) and mention that both palettes are validated for colourblind separability, consistent with the existing colour-never-alone note.

- [ ] **Step 8: Regenerate AGENTS.md**

AGENTS.md is a verbatim copy of CLAUDE.md below an 11-line header. Never hand-edit it:

```bash
{ head -n 11 AGENTS.md; tail -n +4 CLAUDE.md; } > AGENTS.md.new && mv AGENTS.md.new AGENTS.md
diff <(tail -n +4 CLAUDE.md) <(tail -n +12 AGENTS.md) && echo IDENTICAL
```
Expected: `IDENTICAL`

- [ ] **Step 9: Full verification**

```bash
node firmware/deckhand_display/palette-check.mjs
node firmware/deckhand_display/palette-check.mjs --selftest
./claude-hooks/test-install-cycle.sh
node claude-hooks/test-codex-hook.mjs
node claude-hooks/test-codex-install.mjs
node host/test-sessions-merge.mjs
```
Expected: palettes pass, selftest passes, and 36 / 12 / 10 / 8. Nothing in this plan touches the host or hooks, so those four are a regression check only.

- [ ] **Step 10: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino CLAUDE.md AGENTS.md README.md
git commit -m "Add a DARK/LIGHT theme toggle, persisted in NVS"
```

---

## Notes for the executor

- **Do not adjust DARK's values.** It is today's look restated as data. If a contrast number looks poor, that is recorded and deliberate.
- **Do not touch the 385 `COLOR_*` call sites.** If you find yourself editing draw calls, the approach has been misunderstood — the whole point is that those stay untouched.
- **The crab is not in scope.** `ClawdCrab.h` bakes `COLOR_BG` into its palette at build time and deliberately stays dark.
