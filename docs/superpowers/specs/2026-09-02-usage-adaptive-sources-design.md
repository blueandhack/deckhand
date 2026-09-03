# USAGE tab: hide a source that has gone quiet for a window

Board 2 only (`BOARD_USAGE_V2`). Board 1 keeps its pager layout untouched.

## The complaint, and the measurement behind it

The CODEX row occupies 64 of the tab's 414 rows and reads `--`. On this machine
that is not a transient:

| reading | value | meaning |
|---|---|---|
| `cxPct` | `-1` | **never measured** - `codex=?` appears 6,124 times in the host log and nothing else, ever |
| `cxAgeSec` | 602,897 | **6.97 days** since anything Codex-shaped was touched |
| `quotaAgeSec` | 121 | Claude is live |

So a fifth of the column is a labelled empty box for a tool this machine has
never once reported. The row is correct - `--` is the honest rendering of "never
measured", and this repo already refuses to draw `0%` there - but drawing it at
all is chrome for a source that does not exist.

## Scope

Hide a source's cards when its reading has not refreshed for **one full window**.
Reclaim the space by growing what remains, so the column still fills the tab.

Explicitly out of scope: the menu bar's own Codex row, board 1, and any change to
what a *shown* row displays.

## 1. One predicate, read everywhere

```c
// board 2 only, usage.ino, inside #if BOARD_USAGE_V2
bool usageCodexShown() {
  if (usage.cxPct < 0) return false;            // never measured
  if (usage.cxAgeSec < 0) return false;         // ditto, by the age's own sentinel
  long win = usage.cxWindowMin > 0 ? usage.cxWindowMin : CODEX_HIDE_FALLBACK_MIN;
  return usage.cxAgeSec <= win * 60;
}
```

ONE function, the way `pairConfirmable()` is one function. It is read by the
layout selector, by `renderUsageTab`, by `drawUsageStatic`, and by the cache
bust. **A second spelling of this condition is the defect class this repo keeps
paying for** - a control drawn under one condition and hit-tested under another -
so `usage-geom-check.mjs` must forbid a second spelling inside any of those
functions rather than merely avoiding one.

There is no hit test to worry about: the USAGE tab has none, verified (one
reference to the card constants in the main `.ino`, no touch handler). That
removes this feature's largest hazard class outright, and is worth stating
because the same change on SESSIONS or SETTINGS would not be so cheap.

## 2. The threshold is derived, not picked

**A reading is dead once a full window has elapsed with no refresh.** Codex's
window rides the wire already as `cxWin` and is stored as `usage.cxWindowMin`
(verified: declared at `deckhand_display.ino:597`, parsed at 3917, published by
the host at `index.mjs:1290`). It is 10,080 minutes here, so the threshold is
**7 days** - and it is *data-driven*, not a constant: a plan with a different
window moves the threshold with it.

Why a whole window rather than something shorter:

- **Below one window the number is merely STALE, and that state already exists.**
  `QUOTA_STALE_SEC` (900) dims the row at 15 minutes and the menu bar appends
  `stale 3h`. Hiding is a different claim - not "we cannot vouch for this
  number" but "nobody is running this tool" - and one full window of silence is
  what earns it: the host polled roughly 120,000 times and learned nothing new.
- **It cannot flap.** Age grows monotonically until a refresh arrives, so the
  edge fires once. A refresh brings the row straight back, which is a reflow the
  user caused by starting Codex.

`CODEX_HIDE_FALLBACK_MIN` (10080) covers the case where a percentage arrives with
no window beside it - the host sends `cxWin: primary?.windowMin ?? null`, so the
two really can arrive apart. Trusting an absent window would mean `win = 0` and a
row that hides the instant it is measured.

## 3. Claude never hides - the asymmetry is the design

**Codex absent is a configuration. Claude absent is a fault.**

Claude's quota is *account-level*: the host polls the OAuth usage endpoint
regardless of whether Claude Code is used, so a fresh reading arrives even at 0%.
For `quotaAgeSec` to reach days, the OAuth **refresh token** must have expired
(the documented "sign in again" state) *and* the statusLine cache must have gone
cold. That is reachable - and it is broken auth, with a fix.

Replacing those two cards with a tidy Codex-only tab would **conceal the only
evidence of it**. This is the rule the run-ledger already earned the hard way: a
measurement that cannot say "I don't know" answers with the wrong thing. So a
stale Claude card keeps its digits, keeps its dimming, and keeps saying so.

Consequence, stated rather than discovered: a user who is signed out of Claude
and uses only Codex keeps two dimmed Claude cards. That is the intended
behaviour, not an oversight.

## 4. Two layouts, and the rhythm constraint that shapes them

The column identity must hold in both. Content area is `480 - FOOTER_H(20) -
CONTENT_Y(46)` = **414**.

```
duo    8 + 182 + 8 + 144 + 8 + 56 + 8 = 414      (today)
solo   8 + 214 + 8 + 176 + 8          = 414      (Codex hidden)
```

**The binding constraint is each card's uniform RHYTHM**, which the fault-injection
sweep forced into existence and which is the only two-sided bound on these
offsets. Measured from the shipped tables:

| card | rhythm gaps | gap | trailing |
|---|---|---|---|
| NOW | 4 | **4 rows** | 5 |
| WEEK | 5 | **3 rows** | 3 |

`rhythm()` asserts every gap equals the first and that trailing >= that gap. Its
only exemption is the pin bar sitting directly on the label row; `extra` gaps are
*added to* the uniformity check, not excused from it. **So 32 rows of air at a
single boundary would fail it.** Any growth must therefore either enlarge a BAND
or raise the uniform gap.

### NOW: 182 -> 214, all of it into the sparkline

`NOW_SPARK_H` 32 -> **64**, `NOW_META_Y` 158 -> **190**.

```
band        duo              solo
label       +6..+21          +6..+21
hero        +26..+90         +26..+90
bar clear   +95..+114        +95..+114
spark       +119..+152       +119..+184     <- 32 -> 64
meta        +157..+174       +189..+206
last / ceil 174 / 179        206 / 211
trailing    5                5              rhythm 4 in both
```

The rhythm and the trailing clearance are **identical** in both layouts; only the
spark band's height and the offset below it move. Three constants.

**This is the one change that answers an open question rather than filling
space.** `drawUsageSpark` takes its height as a parameter and scales with it
(`cy = y + h - 3 - ((h - 5) * v) / 100`, verified in source), so the fixed 0..100
scale gains real vertical resolution: **3.7 percentage points per pixel at 32,
1.7 at 64**. CLAUDE.md lists "the sparkline has never been read by a human at
320x480 - whether 31 caps in a 260x32 box read as a trend or as texture" as
unverified, and doubling its height is the cheapest move against that.

### WEEK: 144 -> 176, by re-pitching the rhythm 3 -> 8

WEEK has no band that should grow. **It must not get a sparkline**: the ring spans
150 minutes and a 7-day window moves 1.49 points across it - inside integer
rounding - so a WEEK spark would be a flat line pretending to be a trend. That is
measured in the redesign spec and is the reason the two estimators are split at
all.

So the 32 rows go into the uniform gap. With 5 gaps and band heights fixed, the
card's height is `126 + 6k` at minimum for gap `k`; at `k = 8` the minimum is 174
and the column needs 176, leaving trailing 10.

```
band        duo              solo (k=8)      constant
numrow      +25..+50         +30..+55        WEEK_NUM_Y   26 -> 31
                                             WEEK_BURN_Y  30 -> 35
allbar      +54..+73         +64..+83        WEEK_BAR_Y   58 -> 68
meta        +77..+94         +92..+109       WEEK_META_Y  78 -> 93
fable       +98..+115        +118..+135      WEEK_FABLE_Y 99 -> 119
fbar        +119..+138       +144..+163      WEEK_FABLE_BAR_Y 123 -> 148
last / ceil 138 / 141        163 / 173
trailing    3                10              rhythm 3 -> 8
```

`WEEK_BURN_Y - WEEK_NUM_Y` stays **4** = `(head - meta) / 2`, so the burn line
remains optically centred on the number and that existing assertion carries over
unchanged.

## 5. The transition must repaint the chrome

`codexShownCache` joins the existing `static int srcCache/cxSrcCache/pinCache/
linksCache/emojiCache` block in `renderUsageTab`, which already calls
`drawUsageStatic()` (and `resetUsageCaches()` inside it) on any change.

This is not optional bookkeeping. The change-only redraw discipline assumes the
chrome is static; here **the card borders themselves move**, so without the bust
the old borders stay painted and every field draws at the new offsets inside the
old boxes. It is the same class as the settings branch's one correctness bug - a
live field drawing into chrome that did not exist - and the general rule from it
applies directly: *a change-only field whose CHROME depends on a value needs that
value in its cache.*

## 6. What binds it

- **`usage-geom-check.mjs`**: both column sums as **declared-terms** identities,
  never derived from drawn positions - the vacuous-identity trap this spec's
  predecessor hit twice. Both layouts through `rhythm()`. Every solo constant
  asserted. A forbidden second spelling of the predicate.
- **`geom-sweep.mjs`**: every one of the ~11 new constants caught at **+-1 in
  both directions**. That is the standard for constants this repo just added, and
  the pairing panel's five unguarded air constants are the counter-example.
- **`usage-trend-check.py`**: the predicate's three branches (never measured,
  within a window, past a window) and the fallback.
- **`docs/design/usage-redesign/check.mjs`**: the mock gains the solo column, with
  `K` bound to the header as it already is.
- **`board-baseline.mjs --check 1`**: board 1 `UNCHANGED` at every commit.

## 7. Verification, including one irony

**The solo layout is the one this machine can verify.** `cxPct` is -1, so the
device enters solo immediately on flash and can be photographed.

**The duo layout then becomes unverifiable here** - it cannot be reached without
Codex reporting, which has never happened on this machine. It is already verified
on the glass (the capture in this branch's history), so the honest statement is
that the two layouts are verified at different times by different means, not that
both are covered by one run.

Not verified by either: **colour**, since board 2's `SCREENSHOT` reads the shadow
framebuffer. `COLORTEST` is the instrument and a person is the authority.

Also unverified: the threshold's own edge. Watching a source cross one full
window takes seven days of wall clock, so the predicate is unit-checked and
argued, never observed.

## 8. Considered and rejected

- **Symmetric hiding**, as first requested. Rejected in section 3: it conceals
  broken Claude auth, and the Codex-only layout would be untestable here without
  a force command.
- **Trailing air instead of growth.** Cheapest by far - no constant moves - but
  64 rows of blank bottom is the "a card, then nothing" look the sessions tab was
  already corrected for.
- **A WEEK sparkline.** Arithmetically dishonest, section 4.
- **Naming the air in the header as `prev + cell + AIR`.** This is the shape the
  wireless-pairing panel used and it **blinds the sweep**: relative identities all
  still hold when one term is perturbed. Independent literals plus the rhythm
  assertion is strictly better.

## 9. The allocation decision, RESOLVED against the rendered pixels

Deriving the approved "grow both" allocation against the real band tables turned up
a cost that was not visible when it was chosen:

| allocation | new constants | WEEK | answers the open spark question |
|---|---|---|---|
| **grow both** (this spec) | ~11 | rhythm re-pitched 3 -> 8 | partly (spark 32 -> 64) |
| all 64 to NOW | ~4 | untouched | fully (spark 32 -> 96, ~1.1 pt/px) |

**Both were then MOCKED at 1:1 with the real Spleen bitmaps and compared side by
side, and "grow both" was chosen again with that cost visible.** The mock calls the
shipped painters (`leadCard`, `capRow`, `heroSide`, `codexRow`) with `K` patched per
layout, so it restates no offset the header owns; it made the trade legible in the
one way a table cannot - the re-pitched WEEK card reads as a visibly looser card,
which is what the 32 rows actually buy.

So the decision is settled and this section is the record of it rather than an open
question. **The rejected allocation's arithmetic is kept above on purpose**: it is
the cheaper option by a factor of nearly three in constants, so a future reader who
finds the ~11 solo constants expensive should know that alternative was measured,
mocked, seen and declined - not overlooked.

The one thing "grow both" leaves on the table, stated so it is not rediscovered as
a finding: the sparkline reaches 1.69 points per pixel rather than 1.10, so the
"never read by a human at 320x480" question is improved but not fully closed.
