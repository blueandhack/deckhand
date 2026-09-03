# Adaptive USAGE Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On board 2, hide the CODEX row once Codex has been silent for a full window, and grow both Claude cards so the column still fills the tab.

**Architecture:** One predicate (`usageCodexShown()`) decides the layout; eleven accessor functions in `usage.ino` pick between the shipped constants and new `*_SOLO` siblings in `board_es3c35p.h`; the layout state joins the existing chrome-bust block so the card borders repaint when it flips. Every line sits behind `#if BOARD_USAGE_V2`, so board 1 is untouched.

**Tech Stack:** Arduino C++ (ESP32-S3), `arduino-cli`, Node checkers (`usage-geom-check.mjs`, `geom-sweep.mjs`, `board-baseline.mjs`), a Python checker (`usage-trend-check.py`), a browser mock under `docs/design/`.

**Spec:** `docs/superpowers/specs/2026-09-02-usage-adaptive-sources-design.md`

## Global Constraints

- **Board 2 only.** Every change sits behind `#if BOARD_USAGE_V2`. Board 1 must report `board 1 UNCHANGED  8f64b7f78c14b39e...  size=1387024` from `node firmware/board-baseline.mjs <bin> --check 1` at **every** commit.
- **NEVER compile both boards concurrently** — `arduino-cli` keys its build cache on the sketch PATH, so two FQBNs of one sketch overwrite each other's objects. Compile board 2, check, then board 1, check.
- **`./flash.sh --board 2 --no-compile` is only safe when the LAST compile was board 2.** Otherwise drop `--no-compile`.
- **A checker must PARSE the constant it certifies, never transcribe it.** A literal on the checker's side means reverting the constant does not fail.
- **Board flags are `#define`, values are `const int`.** `#if` on a `const int` is silently false with no warning.
- **Constants are independent literals in the header, never `prev + cell + AIR`.** A chain of relative identities blinds `geom-sweep.mjs`, which injects at parse time.
- **One predicate, one spelling.** No second expression of "is Codex shown" anywhere.
- **The column gap is the literal `8`** in both the header and `usage.ino`, because `SP_2` is not visible in a board header (it is declared in `deckhand_display.ino`, after `board.h` is included).

---

### Task 1: The predicate and its threshold

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (add one constant near `CODEX_H`, line ~503)
- Modify: `firmware/deckhand_display/usage.ino` (add one function above `renderNowCard()`, line ~620)
- Modify: `firmware/deckhand_display/usage-trend-check.py`

**Interfaces:**
- Consumes: the `usage` global (`Usage usage;`, `deckhand_display.ino:620`) and its fields `cxPct` (int, `-1` = never measured), `cxAgeSec` (long, `-1` = never measured), `cxWindowMin` (long, `-1` = absent).
- Produces: `bool usageCodexShown()` — no arguments, so the Arduino prototype generator cannot trip over a type declared later. Tasks 2–3 call it.

- [ ] **Step 1: Add the fallback threshold to the board header**

In `board_es3c35p.h`, immediately after `const int CODEX_H = 56;`:

```c
// A Codex reading is DEAD once a full window has passed with no refresh: the
// host polled ~120,000 times and learned nothing, so nobody is running it.
// The window itself rides the wire as cxWin and is stored as usage.cxWindowMin,
// so the real threshold is DATA-DRIVEN and moves with the plan. This is only
// the fallback for a percentage that arrives with no window beside it - the
// host sends `cxWin: primary?.windowMin ?? null`, so the two really can arrive
// apart, and trusting an absent window would mean win = 0 and a row that hides
// the instant it is measured.
const int CODEX_HIDE_FALLBACK_MIN = 10080;   // 7 days, the observed Codex window
```

- [ ] **Step 2: Add the assertions to `usage-trend-check.py` FIRST, and watch them fail**

Append to `usage-trend-check.py`, before its final tally:

```python
# ---------------------------------------------------------------------------
# usageCodexShown() - the ONE predicate deciding the tab's layout.
# ---------------------------------------------------------------------------
CODEX_HIDE_FALLBACK_MIN = const_int("CODEX_HIDE_FALLBACK_MIN")

def codex_shown(cx_pct, cx_age_sec, cx_window_min):
    """Mirrors usage.ino's usageCodexShown() exactly."""
    if cx_pct < 0:
        return False
    if cx_age_sec < 0:
        return False
    win = cx_window_min if cx_window_min > 0 else CODEX_HIDE_FALLBACK_MIN
    return cx_age_sec <= win * 60

chk(CODEX_HIDE_FALLBACK_MIN == 10080,
    "the fallback window is 7 days (10080 min), the window Codex actually reports")
chk(codex_shown(-1, 40, 10080) is False,
    "never measured (cxPct < 0) hides, however fresh the age looks")
chk(codex_shown(44, -1, 10080) is False,
    "a negative age is the 'never measured' sentinel and hides too")
chk(codex_shown(44, 40, 10080) is True,
    "a fresh reading inside its window is shown")
chk(codex_shown(44, 10080 * 60, 10080) is True,
    "exactly one window of silence is still shown - the bound is inclusive")
chk(codex_shown(44, 10080 * 60 + 1, 10080) is False,
    "one second past a full window hides: the reading describes a dead window")
chk(codex_shown(44, 602897, 10080) is True,
    "this machine's 6.97 days would still be SHOWN on age alone - it hides on cxPct")
chk(codex_shown(44, 40, -1) is True,
    "an absent window falls back to CODEX_HIDE_FALLBACK_MIN rather than 0")
chk(codex_shown(44, CODEX_HIDE_FALLBACK_MIN * 60 + 1, -1) is False,
    "the fallback really is applied as a bound, not merely defaulted")
# STRUCTURAL: the predicate must exist exactly once and take no arguments, so
# the Arduino prototype generator cannot meet a type declared after it.
chk(len(re.findall(r"bool usageCodexShown\(\)", INO)) == 1,
    "usageCodexShown() is defined exactly once and takes no arguments")
chk("QUOTA_STALE_SEC" not in fn_body(INO, "usageCodexShown"),
    "the predicate does NOT reuse the 900s stale threshold - hiding is a different claim")
```

If `fn_body` is not already defined in this checker, add it beside `const_int`:

```python
def fn_body(src, name):
    """The braces-balanced body of a C function, comments stripped."""
    i = src.index(name + "(")
    i = src.index("{", i)
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{": depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0: break
        j += 1
    body = src[i:j + 1]
    return re.sub(r"//.*?$", "", body, flags=re.M)
```

Run: `python3 firmware/deckhand_display/usage-trend-check.py`
Expected: FAIL — `const_int("CODEX_HIDE_FALLBACK_MIN")` cannot find the constant until Step 1 landed, and the two structural assertions fail because the function does not exist yet.

- [ ] **Step 3: Add the predicate to `usage.ino`**

Immediately above `void renderNowCard() {`:

```c
#if BOARD_USAGE_V2
// ONE PREDICATE, READ EVERYWHERE - the layout accessors, renderUsageTab and
// drawUsageStatic all ask this and nothing re-derives it. A control drawn under
// one condition and hit-tested under another is this codebase's classic defect;
// there is no hit test on this tab, but a second spelling would still let the
// chrome and the fields disagree about which column they are in.
//
// Deliberately NOT keyed on QUOTA_STALE_SEC. That threshold (900s) means "we
// cannot vouch for this number" and already dims the row. This is the stronger
// claim that nobody is RUNNING the tool, and a full window of silence is what
// earns it.
bool usageCodexShown() {
  if (usage.cxPct < 0) return false;       // never measured
  if (usage.cxAgeSec < 0) return false;    // ditto, by the age's own sentinel
  long win = usage.cxWindowMin > 0 ? usage.cxWindowMin : CODEX_HIDE_FALLBACK_MIN;
  return usage.cxAgeSec <= win * 60;
}
#endif
```

- [ ] **Step 4: Run the checker**

Run: `python3 firmware/deckhand_display/usage-trend-check.py`
Expected: PASS, with the printed count 11 higher than before.

- [ ] **Step 5: Prove the new assertions can fail**

Temporarily change the predicate's first line to `if (usage.cxPct < -99) return false;` and re-run.
Expected: FAIL on "never measured (cxPct < 0) hides". Revert with `git checkout -p` or by re-editing — do **not** `git checkout` the whole file, which would discard Steps 1 and 3.

- [ ] **Step 6: Compile both boards and check baselines**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/t1b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/t1b2/deckhand_display.ino.bin --check 2
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/t1b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/t1b1/deckhand_display.ino.bin --check 1
```

Expected: board 1 `UNCHANGED`. Board 2 may report `CHANGED` at **+0 bytes** — the predicate has no callers yet, so `--gc-sections` strips it and only the link order moves. That is the documented case; re-baseline with `--update 2`.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage.ino \
        firmware/deckhand_display/usage-trend-check.py firmware/board-baseline.json
git commit -m "The predicate for a Codex row that has gone quiet for a window

One function, no callers yet. The threshold is DERIVED - a full window of
silence, taken from usage.cxWindowMin, which already crosses the wire as cxWin -
so it moves with the plan rather than being a constant. CODEX_HIDE_FALLBACK_MIN
covers a percentage that arrives with no window beside it, where trusting the
absence would mean win = 0 and a row that hides the instant it is measured.

11 assertions in usage-trend-check.py, including that the predicate does NOT
reuse QUOTA_STALE_SEC: 900s means 'cannot vouch for this number' and already
dims the row, where this is the stronger claim that nobody is running the tool.

Board 1 UNCHANGED. Board 2 re-baselined at +0 bytes - the function has no
callers, so --gc-sections strips it and only the link order moved."
```

---

### Task 2: The solo constants and their geometry bindings

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (after the v2 block, line ~560)
- Modify: `firmware/deckhand_display/usage-geom-check.mjs`

**Interfaces:**
- Consumes: `usageCodexShown()` from Task 1 (not called here — this task adds constants and assertions only).
- Produces: `NOW_CARD_H_SOLO`, `NOW_SPARK_H_SOLO`, `NOW_META_Y_SOLO`, `WEEK_CARD_H_SOLO`, `WEEK_NUM_Y_SOLO`, `WEEK_BURN_Y_SOLO`, `WEEK_BAR_Y_SOLO`, `WEEK_META_Y_SOLO`, `WEEK_FABLE_Y_SOLO`, `WEEK_FABLE_BAR_Y_SOLO` — all `const int`, all read by Task 3's accessors.

- [ ] **Step 1: Add the ten solo constants**

In `board_es3c35p.h`, after the existing `WEEK_FABLE_BAR_Y` declaration:

```c
// ---- THE SOLO COLUMN: what this tab becomes when Codex is hidden ----------
// 8 + 214 + 8 + 176 + 8 = 414, the same content area the duo column fills.
//
// INDEPENDENT LITERALS, NOT `prev + cell + AIR`. geom-sweep.mjs injects at
// PARSE time, so a chain of relative identities lets a perturbation propagate
// into every offset below it and every identity still holds - the exact failure
// the wireless-pairing panel's five air constants shipped with. The rhythm
// assertion in usage-geom-check.mjs is what binds these instead.
//
// NOW takes its whole share in the SPARKLINE band, so its rhythm (4) and its
// trailing clearance (5) are IDENTICAL in both layouts and only two offsets
// move. drawUsageSpark scales with its height, so 32 -> 64 takes the fixed
// 0..100 scale from 3.70 to 1.69 percentage points per pixel.
const int NOW_CARD_H_SOLO  = 214;
const int NOW_SPARK_H_SOLO = 64;
const int NOW_META_Y_SOLO  = 190;   // spark clear ends +184, +4 rhythm, +1

// WEEK has no band that should grow - a WEEK sparkline would be a flat line
// pretending to be a trend, the ring moving 1.49 points across a 7-day window -
// so its 32 rows go into the uniform gap, 3 -> 8. Its height is 126 + 6k at
// minimum for gap k, which is 174 at k = 8; the column needs 176, so trailing
// clearance is 10 against the 8-row rhythm.
const int WEEK_CARD_H_SOLO      = 176;
const int WEEK_NUM_Y_SOLO       = 31;
const int WEEK_BURN_Y_SOLO      = 35;   // NUM + (T_HEAD cell - T_META cell) / 2
const int WEEK_BAR_Y_SOLO       = 68;
const int WEEK_META_Y_SOLO      = 93;
const int WEEK_FABLE_Y_SOLO     = 119;
const int WEEK_FABLE_BAR_Y_SOLO = 148;
```

- [ ] **Step 2: Bind both columns and both rhythms in `usage-geom-check.mjs`**

Inside the existing `if (b === 2)` v2 block, after the current `rhythm("WEEK", wb, c.WEEK_CARD_H);` call:

```js
    // ---- THE SOLO COLUMN --------------------------------------------------
    // Asserted from the DECLARED heights and gaps, never from drawn positions:
    // a sum of drawn offsets telescopes to contentBottom - CONTENT_Y for ANY
    // values, which is how this file's predecessor shipped a vacuous column
    // identity twice.
    const GAP = 8;   // the literal the header's own CARD2_Y/CODEX_Y use
    chk(GAP + c.NOW_CARD_H + GAP + c.WEEK_CARD_H + GAP + c.CODEX_H + GAP
          === c.CONTENT_ROWS,
        `duo column: 8+${c.NOW_CARD_H}+8+${c.WEEK_CARD_H}+8+${c.CODEX_H}+8 `
      + `= ${c.CONTENT_ROWS} content rows`);
    chk(GAP + c.NOW_CARD_H_SOLO + GAP + c.WEEK_CARD_H_SOLO + GAP === c.CONTENT_ROWS,
        `solo column: 8+${c.NOW_CARD_H_SOLO}+8+${c.WEEK_CARD_H_SOLO}+8 `
      + `= ${c.CONTENT_ROWS} content rows, the SAME area the duo column fills`);
    // The reclaimed rows are exactly the Codex row plus its gap - nothing is
    // invented and nothing is left over.
    chk((c.NOW_CARD_H_SOLO - c.NOW_CARD_H) + (c.WEEK_CARD_H_SOLO - c.WEEK_CARD_H)
          === c.CODEX_H + GAP,
        `the two cards grow by exactly the ${c.CODEX_H + GAP} rows the Codex row `
      + `and its gap release (${c.NOW_CARD_H_SOLO - c.NOW_CARD_H} + `
      + `${c.WEEK_CARD_H_SOLO - c.WEEK_CARD_H})`);

    // Both cards keep a uniform rhythm in the solo layout too. NOW's is the
    // SAME 4 rows with the SAME trailing 5, which is what makes its growth two
    // constants rather than five; WEEK's is re-pitched to 8.
    const soloNow = [
      ["pin",   c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label", c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      ["hero",  c.NOW_HERO_Y,     c.NOW_HERO_Y + c.CARD_HERO_H - 1],
      ["bar",   c.NOW_BAR_Y - 4,  c.NOW_BAR_Y + c.BAR_H + 3],
      ["spark", c.NOW_SPARK_Y - 1, c.NOW_SPARK_Y + c.NOW_SPARK_H_SOLO],
      ["meta",  c.NOW_META_Y_SOLO - 1, c.NOW_META_Y_SOLO + meta],
    ];
    const soloNowAir = rhythm("NOW solo", soloNow, c.NOW_CARD_H_SOLO, [
      ["side1->side2",
       (c.NOW_SIDE_Y + c.NOW_SIDE_STEP - 1) - (c.NOW_SIDE_Y + meta) - 1],
    ]);
    chk(soloNowAir === 4,
        `NOW solo keeps the duo card's 4-row rhythm (got ${soloNowAir}) - its whole `
      + `share went into the spark band, so no gap moved`);

    const soloWeek = [
      ["pin",    c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label",  c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      ["numrow", Math.min(c.WEEK_NUM_Y_SOLO - 1, c.WEEK_BURN_Y_SOLO - 1),
                 Math.max(c.WEEK_NUM_Y_SOLO + head, c.WEEK_BURN_Y_SOLO + meta)],
      ["allbar", c.WEEK_BAR_Y_SOLO - 4,   c.WEEK_BAR_Y_SOLO + c.BAR_H + 3],
      ["meta",   c.WEEK_META_Y_SOLO - 1,  c.WEEK_META_Y_SOLO + meta],
      ["fable",  c.WEEK_FABLE_Y_SOLO - 1, c.WEEK_FABLE_Y_SOLO + meta],
      ["fbar",   c.WEEK_FABLE_BAR_Y_SOLO - 4, c.WEEK_FABLE_BAR_Y_SOLO + c.BAR_H + 3],
    ];
    const soloWeekAir = rhythm("WEEK solo", soloWeek, c.WEEK_CARD_H_SOLO);
    chk(soloWeekAir === 8,
        `WEEK solo is re-pitched to an 8-row rhythm (got ${soloWeekAir}) - the 32 `
      + `rows went into the gaps, because no band on this card should grow`);
    // The burn line stays optically centred on the number it captions, the same
    // relation the duo card has, so re-pitching cannot silently break it.
    chk(c.WEEK_BURN_Y_SOLO - c.WEEK_NUM_Y_SOLO === (head - meta) / 2,
        `WEEK solo burn line is centred on the number: `
      + `${c.WEEK_BURN_Y_SOLO} - ${c.WEEK_NUM_Y_SOLO} = (${head} - ${meta}) / 2`);
    chk(c.WEEK_BURN_Y_SOLO - c.WEEK_NUM_Y_SOLO === c.WEEK_BURN_Y - c.WEEK_NUM_Y,
        `...the SAME relation the duo card uses (${c.WEEK_BURN_Y - c.WEEK_NUM_Y})`);
```

- [ ] **Step 3: Run the checker**

Run: `node firmware/deckhand_display/usage-geom-check.mjs`
Expected: PASS on both boards, with the printed assertion count 10 higher.

- [ ] **Step 4: Prove each new bound can fail**

For each of `NOW_META_Y_SOLO`, `WEEK_BAR_Y_SOLO` and `WEEK_CARD_H_SOLO`, change the header value by `+1`, re-run, confirm a failure naming that card's rhythm or column, then restore.
Expected: three separate named failures.

- [ ] **Step 5: Compile both boards and check baselines**

Same two commands as Task 1 Step 6.
Expected: board 1 `UNCHANGED`. Board 2 unchanged in size — these are `const int`s with no readers, so they occupy no space; if the hash moves it is link order again.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/usage-geom-check.mjs
git commit -m "The solo column's ten constants, bound by both cards' rhythms

Independent literals, never prev + cell + AIR: geom-sweep.mjs injects at parse
time, so a chain of relative identities lets one perturbation propagate and
every identity still holds - the failure the pairing panel's five air constants
shipped with.

Both column identities are asserted from DECLARED heights and gaps rather than
drawn positions, which telescope to the content area for any values. Plus: the
two cards grow by exactly the rows the Codex row and its gap release; NOW keeps
the duo card's 4-row rhythm and trailing 5 because its whole share went into the
spark band; WEEK is re-pitched to 8 because no band on it should grow.

Board 1 UNCHANGED."
```

---

### Task 3: Select the layout, suppress the row, repaint the chrome

**Files:**
- Modify: `firmware/deckhand_display/usage.ino` (accessors above `renderNowCard()`; the reads inside `renderNowCard`/`renderWeekCard`/`renderCodexRow`; `renderUsageTab`'s bust ~line 990; `drawUsageStatic` ~line 1053)
- Modify: `firmware/deckhand_display/usage-geom-check.mjs` (structural assertions)

**Interfaces:**
- Consumes: `usageCodexShown()` (Task 1); the ten `*_SOLO` constants (Task 2).
- Produces: `int nowCardH()`, `int nowSparkH()`, `int nowMetaY()`, `int weekCardY()`, `int weekCardH()`, `int weekNumY()`, `int weekBurnY()`, `int weekBarY()`, `int weekMetaY()`, `int weekFableY()`, `int weekFableBarY()`, `int codexRowY()` — all no-argument `int` accessors.

- [ ] **Step 1: Add the accessors**

In `usage.ino`, directly below `usageCodexShown()`:

```c
// THE LAYOUT, DERIVED FROM THE ONE PREDICATE at every read. No cached copy:
// two variables tracking one layout is how a UI comes to draw one column while
// its chrome is in the other, and this tab already has the ingredients (the
// fields and the chrome are painted by different functions on different ticks).
// The cost is a handful of comparisons per render, against a 41ms full flush.
int nowCardH()      { return usageCodexShown() ? NOW_CARD_H      : NOW_CARD_H_SOLO; }
int nowSparkH()     { return usageCodexShown() ? NOW_SPARK_H     : NOW_SPARK_H_SOLO; }
int nowMetaY()      { return usageCodexShown() ? NOW_META_Y      : NOW_META_Y_SOLO; }
int weekCardH()     { return usageCodexShown() ? WEEK_CARD_H     : WEEK_CARD_H_SOLO; }
int weekNumY()      { return usageCodexShown() ? WEEK_NUM_Y      : WEEK_NUM_Y_SOLO; }
int weekBurnY()     { return usageCodexShown() ? WEEK_BURN_Y     : WEEK_BURN_Y_SOLO; }
int weekBarY()      { return usageCodexShown() ? WEEK_BAR_Y      : WEEK_BAR_Y_SOLO; }
int weekMetaY()     { return usageCodexShown() ? WEEK_META_Y     : WEEK_META_Y_SOLO; }
int weekFableY()    { return usageCodexShown() ? WEEK_FABLE_Y    : WEEK_FABLE_Y_SOLO; }
int weekFableBarY() { return usageCodexShown() ? WEEK_FABLE_BAR_Y: WEEK_FABLE_BAR_Y_SOLO; }
// The literal 8 is the gap the header's own CARD2_Y/CODEX_Y use - SP_2 is not
// visible in a board header, so the column's gap has exactly one value spelled
// two places, and usage-geom-check.mjs asserts they agree.
int weekCardY()     { return CARD1_Y + nowCardH() + 8; }
int codexRowY()     { return weekCardY() + weekCardH() + 8; }
```

- [ ] **Step 2: Replace the fixed reads**

In `renderNowCard()`: `NOW_CARD_H` → `nowCardH()`, `NOW_SPARK_H` → `nowSparkH()`, and both `NOW_META_Y` → `nowMetaY()`.
In `renderWeekCard()`: `CARD2_Y` → `weekCardY()`, `WEEK_CARD_H` → `weekCardH()`, and each `WEEK_*_Y` → its accessor.
In `renderCodexRow()`: every `CODEX_Y` → `codexRowY()`.
In `drawUsageStatic()`, replace the v2 arm and the Codex card:

```c
  drawCardChrome(CARD1_Y, "NOW - 5 HOUR WINDOW", linkTag(usageSourceLink), nowCardH());
  drawCardChrome(weekCardY(), "WEEK - 7 DAY, ALL MODELS", linkTag(usageSourceLink), weekCardH());
#else
  drawCardChrome(CARD1_Y, "SESSION - 5 HOUR WINDOW", linkTag(usageSourceLink));
  drawCardChrome(CARD2_Y, "WEEK - 7 DAY, ALL MODELS", linkTag(usageSourceLink));
#endif
#if BOARD_USAGE_V2
  if (usageCodexShown()) uiCard(CARD_X, codexRowY(), CARD_W, CODEX_H, COLOR_CARD);
#else
  uiCard(CARD_X, CODEX_Y, CARD_W, CODEX_H, COLOR_CARD);
#endif
```

- [ ] **Step 3: Skip the row's fields when it is hidden**

At the top of `renderCodexRow()`:

```c
#if BOARD_USAGE_V2
  // Nothing to draw, and nothing to CLEAR either: the layout flip repaints the
  // whole content area (see renderUsageTab's bust), so the row's old pixels are
  // gone before this returns.
  if (!usageCodexShown()) return;
#endif
```

- [ ] **Step 4: Put the layout into the chrome bust**

In `renderUsageTab`, extend the existing `static int srcCache ... emojiCache` block:

```c
    static int srcCache = -2, cxSrcCache = -2, pinCache = -1, linksCache = -1,
               emojiCache = -3, codexShownCache = -1;
    int pinNow = usagePinHostId[0] ? 1 : 0;
    int linksNow = usedLinkCount();
    int emojiNow = emojiIdForLink(usageSourceLink);
#if BOARD_USAGE_V2
    int codexShownNow = usageCodexShown() ? 1 : 0;
#else
    int codexShownNow = 1;
#endif
    if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink ||
        pinCache != pinNow || linksCache != linksNow ||
        emojiCache != emojiNow || codexShownCache != codexShownNow) {
      // THE LAYOUT MOVES THE CARD BORDERS, so this is the one bust term that
      // needs more than a chrome repaint. Without the clear, NOW growing past
      // where WEEK used to start leaves a band of the old card behind, and the
      // fields then draw at the new offsets inside the old boxes - the settings
      // branch's "a live field drew a control into chrome that did not exist",
      // arriving through geometry instead of a count.
#if BOARD_USAGE_V2
      if (codexShownCache != codexShownNow && codexShownCache != -1)
        tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
#endif
      srcCache = usageSourceLink;
      cxSrcCache = cxSourceLink;
      pinCache = pinNow;
      linksCache = linksNow;
      emojiCache = emojiNow;
      codexShownCache = codexShownNow;
      drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
```

- [ ] **Step 5: Add the structural assertions**

In `usage-geom-check.mjs`'s `b === 2` block:

```js
    // ONE SPELLING. Every layout-dependent read goes through an accessor, and
    // each accessor is the ONLY place its constant pair appears outside the
    // header - so a draw site cannot quietly pin itself to one column.
    const uino = stripComments(fs.readFileSync(`${DIR}/usage.ino`, "utf8"));
    for (const n of ["NOW_CARD_H", "NOW_SPARK_H", "NOW_META_Y", "WEEK_CARD_H",
                     "WEEK_NUM_Y", "WEEK_BURN_Y", "WEEK_BAR_Y", "WEEK_META_Y",
                     "WEEK_FABLE_Y", "WEEK_FABLE_BAR_Y"]) {
      const hits = (uino.match(new RegExp(`\\b${n}\\b(?!_SOLO)`, "g")) || []).length;
      chk(hits === 1,
          `${n} is read in exactly ONE place in usage.ino - its accessor (got ${hits})`);
    }
    chk((uino.match(/\bCONTENT_ROWS_UNUSED\b/g) || []).length === 0,
        "sanity: the regex above is not matching a name that does not exist");
    // The row's fields and its chrome must be gated by the SAME predicate.
    chk(/if \(!usageCodexShown\(\)\) return;/.test(fnBody(uino, "renderCodexRow")),
        "renderCodexRow returns early on the predicate, so no field draws into a row that is not there");
    chk(/if \(usageCodexShown\(\)\) uiCard\(/.test(fnBody(uino, "drawUsageStatic")),
        "the Codex card's CHROME is gated by the same predicate as its fields");
    // The layout flip must clear the content area, or the old borders survive.
    chk(/codexShownCache != codexShownNow[\s\S]{0,200}fillRect\(0, CONTENT_Y/
          .test(fnBody(uino, "renderUsageTab")),
        "a layout flip clears the content area before repainting the chrome");
    chk(/codexShownCache != codexShownNow/.test(fnBody(uino, "renderUsageTab")),
        "the layout state is a bust term, so the card borders repaint when it flips");
```

- [ ] **Step 6: Run every checker**

```bash
node firmware/deckhand_display/usage-geom-check.mjs
python3 firmware/deckhand_display/usage-trend-check.py
node firmware/deckhand_display/sessions-geom-check.mjs
node firmware/deckhand_display/settings-geom-check.mjs
```
Expected: all pass.

- [ ] **Step 7: Prove the bust assertion can fail**

Delete `|| codexShownCache != codexShownNow` from the `if`, re-run `usage-geom-check.mjs`.
Expected: FAIL naming the bust term. Restore it.

- [ ] **Step 8: Compile both boards and check baselines**

Same two commands as Task 1 Step 6.
Expected: board 1 `UNCHANGED`. Board 2 grows — this is the first task with reachable code. Re-baseline with `--update 2`.

- [ ] **Step 9: Commit**

```bash
git add firmware/deckhand_display/usage.ino firmware/deckhand_display/usage-geom-check.mjs firmware/board-baseline.json
git commit -m "Select the column from the predicate, and repaint when it flips

Eleven no-argument accessors pick between the shipped constants and their _SOLO
siblings, each asserted to be the ONLY place its pair is read outside the header
so a draw site cannot quietly pin itself to one column. No cached layout: two
variables tracking one layout is how a UI draws one column while its chrome is
in the other, and this tab paints its fields and its chrome from different
functions on different ticks.

The layout state joins the chrome bust, and the flip ALSO clears the content
area - without that, NOW growing past where WEEK used to start leaves a band of
the old card behind and the fields draw at new offsets inside old boxes. That is
the settings branch's 'a live field drew a control into chrome that did not
exist', arriving through geometry instead of a count.

Board 1 UNCHANGED. Board 2 re-baselined - first task with reachable code."
```

---

### Task 4: Bind the mock to the solo column

**Files:**
- Create: `docs/design/adaptive-sources/README.md`, `docs/design/adaptive-sources/adaptive.html`, `docs/design/adaptive-sources/check.mjs`
- Reuse: `docs/design/usage-redesign/spleenfonts.js` and `usage.js` (imported by path, not copied)

**Interfaces:**
- Consumes: the ten `*_SOLO` constants (Task 2), read out of `board_es3c35p.h` by `geom-common.mjs`'s `consts()`.
- Produces: nothing the firmware reads. This is a verification artifact.

- [ ] **Step 1: Write `check.mjs` so it fails first**

```js
#!/usr/bin/env node
// Binds this mock's solo geometry to board_es3c35p.h. A committed mock whose
// numbers can drift while it still reports "passed" is the same class as an
// assertion that cannot fail - and this repo has paid for it three times.
import fs from "node:fs";
import path from "node:path";
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";

const FW = path.join(import.meta.dirname, "../../../firmware/deckhand_display");
const c = consts("deckhand_display.ino", consts("board_es3c35p.h"));
const src = fs.readFileSync(path.join(import.meta.dirname, "adaptive.html"), "utf8");

let pass = 0; const fails = [];
const ok = (cond, what) => cond ? pass++ : fails.push(what);

// every constant the mock names must equal the header's
const SOLO = ["NOW_CARD_H_SOLO","NOW_SPARK_H_SOLO","NOW_META_Y_SOLO","WEEK_CARD_H_SOLO",
  "WEEK_NUM_Y_SOLO","WEEK_BURN_Y_SOLO","WEEK_BAR_Y_SOLO","WEEK_META_Y_SOLO",
  "WEEK_FABLE_Y_SOLO","WEEK_FABLE_BAR_Y_SOLO"];
for (const n of SOLO) {
  const m = src.match(new RegExp(`${n.replace(/_SOLO$/,"")}\\s*:\\s*(\\d+)`));
  ok(m && +m[1] === c[n], `${n}: mock says ${m ? m[1] : "MISSING"}, header says ${c[n]}`);
}
ok(8 + c.NOW_CARD_H_SOLO + 8 + c.WEEK_CARD_H_SOLO + 8 === c.CONTENT_ROWS,
   "the solo column the mock draws sums to the content area");

for (const f of fails) console.log("FAIL  " + f);
console.log(fails.length ? `\n${fails.length} failed, ${pass} passed`
                         : `ok  ${pass} bindings pass`);
process.exit(fails.length ? 1 : 0);
```

Run: `node docs/design/adaptive-sources/check.mjs`
Expected: FAIL — `adaptive.html` does not exist yet.

- [ ] **Step 2: Create the mock page**

Generate `adaptive.html` by inlining `../usage-redesign/spleenfonts.js` and `../usage-redesign/usage.js` (everything before its `const hit =` line), then a driver that patches `K` with the solo values and calls the shipped painters. **Rename the driver's own layout array — `usage.js` already declares `LAYOUTS`, and a redeclaration is a `SyntaxError` that kills the page silently.** The driver's `SOLO_BOTH` object must use the header's values, keyed by their non-`_SOLO` names, so Step 1's regex binds them.

- [ ] **Step 3: Run the checker**

Run: `node docs/design/adaptive-sources/check.mjs`
Expected: `ok  11 bindings pass`.

- [ ] **Step 4: Prove the bind can fail**

Change `NOW_SPARK_H_SOLO` to 65 in the header, re-run.
Expected: FAIL naming that constant. Restore.

- [ ] **Step 5: Open the page and confirm it draws**

Open `docs/design/adaptive-sources/adaptive.html` in a browser. Expected: three panels, all three canvases drawing glyphs, no blank canvas (a blank one means a JS error — check the console for a redeclaration).

- [ ] **Step 6: Write the README and commit**

`README.md` states what the mock vouches for (geometry, via real Spleen bitmaps and header-bound constants) and what it cannot (colour on the panel — that needs `COLORTEST` and a person).

```bash
git add docs/design/adaptive-sources
git commit -m "Mock the solo column, with its constants bound to the header

Every glyph is the real Spleen bitmap and the page calls the shipped painters
with K patched per layout, so it restates no offset the header owns. check.mjs
parses board_es3c35p.h through the geometry checkers' own consts() and asserts
all ten solo constants by name, because a committed mock whose numbers can drift
while it still reports 'passed' is the same class as an assertion that cannot
fail."
```

---

### Task 5: The sweep, the glass, and the record

**Files:**
- Modify: `CLAUDE.md`
- Verify only: `firmware/deckhand_display/geom-sweep.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing code-facing.

- [ ] **Step 1: Run the fault-injection sweep and time it**

Run: `time node firmware/deckhand_display/geom-sweep.mjs`
Expected: exit 0 in roughly two minutes. **Read the UNGUARDED list, not the exit code** — it exits 0 even with unguarded constants. Every one of the ten new `*_SOLO` constants must be caught at `|1|` in both directions. `CODEX_HIDE_FALLBACK_MIN` will be reported unguarded and that is correct: it measures TIME, so no perturbation has a geometric consequence, exactly like `PAIR_WINDOW_MS`.

- [ ] **Step 2: If any solo constant is unguarded, close it before flashing**

An unguarded constant this branch just added is a gap, not noise. The likely cause is a one-sided bound; add the missing side in `usage-geom-check.mjs` and re-run.

- [ ] **Step 3: Flash board 2**

```bash
./flash.sh --board 2          # no --no-compile: board 1 was compiled last
```

- [ ] **Step 4: Capture the solo layout off the glass**

```bash
echo "TAB 0" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
ls -t ~/Deckhand-shots/*.png | head -1
```

Expected: two cards, no CODEX row, the sparkline visibly taller, the column ending 8px above the footer. This machine has `cxPct = -1`, so the device enters the solo layout immediately.

- [ ] **Step 5: Verify the geometry off the PNG, not by eye alone**

Confirm the WEEK card's top border is at `y = 54 + 214 + 8 = 276` and its bottom at `276 + 176 - 1 = 451`. Note in the commit that this is **framebuffer** evidence — board 2's `SCREENSHOT` reads the shadow buffer, so it vouches for the composed geometry and says nothing about the panel's colour.

- [ ] **Step 6: Update CLAUDE.md**

Add to the USAGE-tab section: the predicate and its derived threshold; the asymmetry (Claude never hides, because staleness there is expired auth worth surfacing); the rhythm constraint and why NOW's share went into the spark while WEEK's re-pitched its gap; the layout-flip clear; the costs; and — under "WHAT IS NOT VERIFIED" — that the **duo** layout is now unreachable on this machine, that the threshold's edge takes seven days of wall clock to observe, and that no claim here covers colour.

- [ ] **Step 7: Final baselines and commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/t5b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/t5b1/deckhand_display.ino.bin --check 1
git add CLAUDE.md && git commit -m "Record the adaptive column, and what it does not verify"
```

---

## Self-Review

**Spec coverage.** §1 predicate → Task 1. §2 threshold → Task 1. §3 asymmetry → no code (Claude has no hide path by construction); recorded in Task 5 Step 6. §4 two layouts and the rhythm constraint → Tasks 2–3. §5 repaint → Task 3 Steps 3–4. §6 what binds it → Tasks 2, 3, 4 and Task 5 Step 1. §7 verification → Task 5 Steps 3–5. §8 rejected options → no code. §9 the settled allocation → the values in Task 2.

**Placeholders.** None: every code step carries the actual text, and Task 4 Step 2 names the one hazard (the `LAYOUTS` redeclaration) rather than saying "generate the page".

**Type consistency.** The accessors are named identically in Task 3's Interfaces block, its Step 1 code, and Step 5's assertion list. The predicate is `usageCodexShown()` with no arguments in all four tasks that mention it. `fn_body` (Python) and `fnBody` (JS) are deliberately different names in different languages, matching each checker's existing convention.

**One known soft spot, stated rather than hidden.** Task 3 Step 5's one-read-per-constant assertion uses a negative lookahead so `NOW_CARD_H` does not match `NOW_CARD_H_SOLO`. If a future reader adds a second legitimate read, that assertion fails and must be re-derived rather than loosened — the count is the point.
