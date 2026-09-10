# Battery, charging and SoC temperature

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

#### Board 2's battery divider is CONFIRMED by measurement - BUT ONLY TO THE NEAREST GROSS FACTOR

> **CORRECTED 2026-09-09, and the heading is left standing because it is what a reader will
> search for.** The paragraph below is sound about the RATIO and overstated as evidence of
> ACCURACY. `board_es3c35p.h` has always been the careful version and says so at the constant
> itself: plausibility "rules out x1 and x4, and it CANNOT distinguish x2 from x1.8 or x2.2 ...
> the only thing that closes it is a meter across the divider". Read the header, not this
> summary. What the argument below establishes is that the ratio is 2 rather than 1 or 4. It
> does NOT establish the ~1% that `BATT_FULL_MV` and `pctFromMv()`'s 4200-for-100% depend on.
>
> **The gap is now observable rather than theoretical.** Board 2 tops out at **4162..4170 mV**
> and has reported `BATT_FULL` (state=3) **zero times in all logged data**, while board 1 sits at
> **4221..4226** and reports it routinely - through nominally identical x2 dividers. Not a
> too-short charge: a **137-minute** uninterrupted charge ran 4060 -> 4162 mV and was flat over
> its last ten minutes. So on board 2 the "full" pill can never appear and the charge estimator
> stays permanently in `topping up`. Note board 1's 4226 is ABOVE the 4.20V a standard CC/CV
> charger terminates at, which suggests the two dividers STRADDLE the truth - board 1 reading
> slightly high, board 2 slightly low - rather than either cell behaving differently.
> **`BATT_FULL_MV` is now per-board** (`BOARD_BATT_FULL_MV` in each header, both still 4180, a
> deliberately behaviour-neutral split: both binaries compiled byte-identical across it). The
> value is left alone until a meter says which fix is right - a calibration trim on the reading,
> or a genuinely lower threshold here - because the two answers are incompatible and guessing
> would bake one in.

#### Board 2's battery divider is CONFIRMED by measurement

`BOARD_BAT_MV_SCALE 2`. The LCDWIKI table for this board gives no ratio and the vendor self-test
assumes x2 as well, so this was a documented guess — and a wrong ratio makes every percentage and
the whole time-remaining estimator wrong while looking perfectly plausible. **Settled by
measurement, not argument:** the device reported `mv=3910..3929`, `pct=63..66`. A single-cell
Li-ion at 3.92V really does sit around 60-70%, and a wrong ratio would have read ~1.96V or ~7.8V —
both obviously absurd. `left=-1 span=0` alongside it is correct behaviour, not a fault: the trend
estimator needs a 20-minute window before it states anything.

#### SoC die temperature and time-to-full: BOTH are board 2 only, and each measures LESS than its name suggests

Two readings were added to board 2's **SETTINGS › STATUS** card, plus a `TEMP` command. The
arithmetic is covered by `batt-trend-check.py` (16 new assertions) and the layout by
`settings-geom-check.mjs`; **board 1's binary is byte-identical throughout**, verified with
`board-baseline.mjs --check 1`, which is the only reason the scoping below is what it is.

**THE DIE SENSOR CANNOT SEE WHAT YOUR HAND FEELS, AND THAT IS THE WHOLE CAVEAT.** The S3's sensor
is inside the package, so it reports how hot the SoC is. It cannot see the charger IC or the cell —
which are exactly what warms the case while charging. So a comfortable number here is **not**
evidence the device is cool, only that the S3 is. This is the same shape as the `SCREENSHOT`
verification trap one layer down: an instrument that measures the thing it can reach, not the thing
you asked about. The row is labelled **`SoC temp`**, never `Temp`, and the `TEMP` line says `die=`,
because the label is the only place a reader learns which temperature this is.
Measured on hardware: **46.6°C while charging with the backlight blanked**, mv=4037.

**The driver is REAL here, and checking that first is the lesson `esp_pm` already taught.**
`temperature_sensor_install` is **522 bytes** in the archive board 2 actually links (`_get_celsius`
322, `_enable` 119), against `esp_pm_configure`'s three-instruction stub. A function that links,
compiles and does nothing reads as the idea being wrong rather than absent. Board 1 is excluded
because the capability is: the plain ESP32 has no usable internal sensor, so the whole path sits
behind the `BOARD_USES_TFT_ESPI` seam and board 1 never links it.

**TIME-TO-FULL IS A FLOOR, NOT AN ESTIMATE, BECAUSE OF THE CV KNEE.** A Li-ion cell charges CC then
CV: below the knee the charger holds CURRENT and the voltage climbs steadily, and above it the
charger holds VOLTAGE and tapers the current instead. **This board has no current sense**, so in
the CV phase the one quantity still moving is the one thing that cannot be measured — and no window
length fixes that. Measured, from 76 minutes of a real charge: **3893 → 4018 mV at +90 mV/h, RMS
residual 3.5 mV, max 8.5** — dead straight, so a least-squares fit is sound *in the CC phase*.

So there are **two distinct refusals**, and collapsing them would invite waiting for a number that
is never coming:

| code | wire | meaning |
|---|---|---|
| `BATT_CHG_NOT_YET` | `chg=-1` | window too short or too flat — keep watching |
| `BATT_CHG_TOPPING` | `chg=-2` | above `BATT_CHG_KNEE_MV` — structurally unmeasurable, says `topping up` |

The knee is tested **before** the data gates, deliberately: above it the refusal is structural, so
reporting "not yet" would promise that a longer window eventually produces an answer.

**THE FIRST FIT LIES ON THE CHARGING SIDE TOO, AND IT BROKE THE `>=` CONTRACT.** Found by
cross-checking the on-glass number against an independent fit of the same `BATT` series — the
device said `>=54m` and the truth was ~65. Plugging in makes the cell voltage snap up **+64 mV in
SECONDS** (measured: 3925 → 3989), because what the divider sees is the charger's terminal voltage
arriving, not charge going into the cell. One such sample in the ring inflated the fitted slope
**143 → 183 mV/h**.

That is a **violated contract, not a rounding error**: `>=` promises *at least* that long, so an
optimistic estimate breaks the one guarantee the notation exists to make — and it fails in the
direction a reader cannot detect. **No rate or SNR gate can catch it**, because a rebound is smooth
and fits a line perfectly well; that is exactly the property the discharge side already documents
for relaxation (`-21 mV` after unplugging, "expect the first fit to lie"). This transient is
**three times larger** and arrives on the side nothing was guarding.
Only TIME distinguishes it, so `BATT_CHG_SETTLE_MS` (3 min, measured from entering CHARGING rather
than from the first sample) admits nothing to the ring until it has passed, and the 40mV fall guard
**re-settles** rather than resuming mid-transient. `batt-trend-check.py` carries the real
25-sample series as a regression: contaminated **53 min**, settled **69** — and asserts the guard
can only ever move the estimate in the SAFE direction, longer and never shorter.
**The on-glass number looked entirely plausible throughout**, which is the transferable part: this
was caught by a second independent computation, not by looking.

Four more things are load-bearing:

- **It fits mV, not percent.** The target is a VOLTAGE, and routing the slope through
  `pctFromMv()`'s curve would attribute that model's shape to the charger — the same reason
  `POWERPROBE` reports mV/h.
- **`BATT_CHG_TARGET_MV` is 4200 because that is where `pctFromMv()` actually returns 100**, not a
  guess at "full". It sits ABOVE `BATT_FULL_MV` (4180) on purpose, so `batteryState()` flips to
  `BATT_FULL` and the label disappears before the estimate could ever count down to zero. Note
  4180 is **98%** on that curve, so the pill reads "full" a couple of points early; that predates
  this and is left alone.
- **Below the knee the fit still extrapolates THROUGH the knee**, so the answer is rendered
  **`>=2h`, never `~2h`**. The discharge row's `~` means "about"; `>=` means "at least". A reader
  who cannot tell those apart has been told the charge will finish sooner than it will.
- **The 99h clamp is provably unreachable and is kept anyway.** The gate admits no slope under
  `BATT_CHG_MIN_RISE_MV` over the longest window the ring holds (29 min) = **51.7 mV/h**, and the
  largest gap to the target is 900 mV, so the worst reachable estimate is **17.4h — 5.7x inside the
  clamp**. The first version of the check tried to TRIGGER the clamp and failed; it now asserts
  unreachability as a sweep, and separately asserts the clamp is still present, because a guard
  that has been deleted cannot catch the change that would make it necessary.

**`chg=` rides the `BATT` line, and on this board that is not merely provenance.** The STATUS row is
the only other place the number appears, the backlight blanks on idle, and **only a touch can wake
board 2** — so without a field on the wire the charge estimate is unobservable from the Mac on an
unattended device, which also makes it unverifiable. It is appended rather than inserted, the same
backward-compatible shape as the trailing `to=<hostId>`.

**THREE SHARED-CODE LEAKS WERE CAUGHT BY `board-baseline.mjs`, AND TWO WERE INVISIBLE TO A SIZE
CHECK.** All three were "board-2-only" changes that were not:

1. The charge estimator itself, left unguarded in `power.ino`: **+288 bytes** of a board-2-only
   estimator compiled into board 1.
2. `char left[8]` → `left[12]` in `settings.ino`, for the longer `topping up` label: board 1
   reported **CHANGED at +0 bytes** — a pure content change a size comparison cannot see. Fixed
   with a per-board `BATT_LEFT_BYTES` (8 / 12).
3. `battRowTextCache[20]` → `[24]`, needed because **`"90% 4.10V topping up"` is exactly 20
   characters** and 20 bytes truncated it by one — the silent-cache failure this repo has paid for
   repeatedly. Fixed with a per-board `BATT_ROW_CACHE` (20 / 24). The bound is DERIVED in the
   checker, not transcribed: `topping up` only appears at or above the knee and `BATT_CHARGING`
   only holds below `BATT_FULL_MV`, so the percentage in that band is 90..97.

**Both new sizes are per-board CONSTANTS in the board headers rather than `#if`s at the
declaration**, and that was forced by the checker rather than chosen: with the size behind an
`#if`, `cacheSizes()` parsed one branch and reported **24 for both boards**, so board 1 carried a
false reading — exactly the "a checker must PARSE the constant it certifies, never TRANSCRIBE it"
rule, arriving from a new direction. All three mutations (`BATT_ROW_CACHE` → 20, `DEV_CARD_H` → 176,
`DROW_TEMP` removed) fail by name.

#### THE POWER-OFF DRAIN IS HALVED, MEASURED - and the first two attempts at it did nothing

**`PWROFFMODE 0x7` (panel SLPIN + hold the ST77922 in reset + power down the ES8311) is now the
default**, on this evidence:

| teardown | drain | %/h | span | note |
|---|---|---|---|---|
| original (nothing extra) | **-5.6 mV/h** | 0.71 | 23.0 h | 4106 -> 3977 mV |
| panel sleep + QSPI isolate | **-6.9 mV/h** | 0.86 | 19.4 h | 4113 -> 3979 mV, shipped blind, NO HELP |
| **0x7** | **-3.6 mV/h** | **0.43** | 8.9 h | 4077 -> 4045 mV, `sleepPanel=ok` |

About HALF - roughly 10%/day where it was 17-21%/day. **The comparison errs against the result:**
this run sat entirely in 4045..4077 where `pctFromMv()`'s curve is STEEPER (8.3 mV per point) than
the band the references spanned, so equal current would have read a LARGER mV/h here, not smaller.
Converting all three to %/h - which normalises that away - gives the same 1.7-2x.

**THREE CAVEATS, ALL LOAD-BEARING.**
1. **The elapsed time is RECONSTRUCTED, not measured**: 8.94 h from 1761 host ticks (2.45 h) plus
   23,364 s of logged "machine was asleep" (6.49 h). The host log carries NO TIMESTAMPS, which is
   the real gap here; any error in that reconstruction scales the rate directly.
2. **One unbracketed run.** Nothing repeated it, and nothing bracketed it.
3. **Attribution is unknown.** All three steps ran together. Which one did the work was not
   narrowed, deliberately: all three are free during a power-off (nothing can wake this board by
   touch), so the combination is what ships.

**IT HALVED RATHER THAN COLLAPSED**, which is consistent with a board-level floor no firmware can
reach - an AMS1117-class LDO is ~5mA and a power LED 2-3mA, against an S3 deep sleep of tens of uA.
Reaching the rest means an inline switch on the JP1 battery lead or an LED/LDO rework. `README.md`
has said as much all along: *"'Off' is deep sleep, a few mA, not a hard power cut ... For true zero
draw, unplug the battery."*

**AND THE TWO ATTEMPTS BEFORE THIS ONE DID NOTHING, WHICH IS THE TRANSFERABLE PART.** Both were
shipped on reasoning, unmeasured, and the second one measured slightly WORSE than doing nothing.
What broke the deadlock was not a better theory but an INSTRUMENT: a runtime bitmask so one build
tests every combination, plus an NVS receipt written before the teardown and reported on the next
boot - which also ended the ambiguity that wasted two days, because a power-off now leaves a record
and a light sleep does not. `sleepPanel=ok` in that receipt is what finally ruled out the "the call
silently never ran" explanation, which had been indistinguishable from "it ran and did nothing"
because the first version discarded the return value.

#### "POWER OFF" LEAKED ~17%/DAY ON BOARD 2, AND THE CAUSE IS A NO-OP

**Measured by accident, which is the only reason it was found.** The device was shut down and
left for a day; a `BATT` collector still running on the Mac caught both ends:

```
2026-09-08 01:01:35   4106 mV  90%  state=1   last contact, on battery
2026-09-09 00:00:20   3977 mV  74%  state=2   plugged back in
                      -129 mV over 22.98 h = -5.6 mV/h, ~0.70 %/h
```

**~17% a day, flat in about six days, from a device the user believed was OFF.** Board 1 in the
same state loses almost nothing, and that contrast is the whole diagnosis.

**`enterDeepSleep()`'s two panel-sleep lines DO NOTHING ON BOARD 2.** `tft.writecommand(0x28)`
and `(0x10)` reach TFT_eSPI on board 1 and put the ILI9341 into DISPOFF/SLPIN, where it draws
microamps. On board 2 the identical calls land in `PanelShim::writecommand()`, which **ignores
its argument** - so the ST77922 has run its oscillator, charge pumps and drivers off GRAM
through every power-off this board has ever performed, with only the backlight latched dark.
Everything else in that state is negligible by comparison, which is what makes the panel the
answer rather than a suspect: the S3's own deep sleep is tens of uA (this core already sets
`CONFIG_ESP_SLEEP_PSRAM_LEAKAGE_WORKAROUND`, `..._FLASH_LEAKAGE_WORKAROUND` and
`..._MSPI_NEED_ALL_IO_PU`), and the SC8002B amp is **0.6uA** shut down and milliamps at worst.
Working back from six-days-to-flat gives roughly **10 mA average** - three orders of magnitude
above the SoC.

The fix is two steps and **the order is load-bearing, because the sleep command travels over the
pins the second step disconnects**:

1. `tft.sleepPanel(true)` - the shim method that actually emits DISPOFF+SLPIN.
2. `rtc_gpio_isolate()` on all six QSPI pins (CS 10, SCK 12, D0 11, D1 13, D2 14, D3 9). All are
   inside the S3's RTC set (`SOC_RTCIO_PIN_COUNT` 22, so 0..21), which is what makes this
   reachable; the backlight on **41 is not**, and keeps its `gpio_hold_en` latch instead.

**STEP 2 IS ALSO THE BEST EXPLANATION FOR THE PANELSLEEP RESULT ABOVE, AND IT IS A HYPOTHESIS,
NOT A MEASUREMENT.** SLPIN collapses the panel's internal rails; six QSPI pins still driven by an
awake SoC then inject current through its input clamp diodes. That would make SLPIN a COST while
awake (as measured) and a SAVING once nothing is driving (deep sleep, where the pins are
isolated) - reconciling two results that otherwise contradict each other. `rtc_gpio_isolate()`
disconnects output, input **and** the pulls, which is why it beats driving a pin to a level: a
driven level is precisely what injects. **It is safe to act on unmeasured here only because deep
sleep ends in a RESET**, so there is no state to restore and nothing to get wrong on the way out.
The same change is deliberately NOT made in the light-sleep path, where the pins keep their
driven state and would hit exactly the injection this describes.

**An explicit `esp_sleep_pd_config(ESP_PD_DOMAIN_VDDSDIO, OFF)` was tried and REMOVED**, recorded
because it looked obviously right: `esp_deep_sleep_start()` powers the flash down regardless of
configuration and the two leakage workarounds are already on, so it was redundant at best and at
worst fought the pull-ups `MSPI_NEED_ALL_IO_PU` installs.

**None of this is measured yet.** The next shutdown of a day or more is the test, and the
comparison is against the -5.6 mV/h above - taken on the same cell, in the same state, which is
the one comparison this file's own rule permits.

#### THE BLANKED STATE, MEASURED: the baseline is -42 mV/h and PANELSLEEP is a COST

One session on C114, 2026-09-07, cell 4093 -> 4064 mV (~95% falling), screen blanked
(`asleep=1` confirmed on every leg), USB out, reported over BLE. Each leg is TWO independent
views: `POWERPROBE`'s own raw-ADC fit, and a least-squares fit of the device's one-a-minute
`BATT mv=` line computed on the Mac. They are not the same computation over the same samples -
`BATT` is an EMA of 8 - so agreement is evidence about the RUN, not about the arithmetic.

| leg | savings in force | `POWERPROBE` | raw `BATT` |
|---|---|---|---|
| `base1` | none | **-41 +/- 2 mV/h** | -42.0 +/- 3.2 |
| `panel` | PANELSLEEP | **-66 +/- 3 mV/h** | -57.2 +/- 2.9 |
| `base1b` | none again | **-42 +/- 2 mV/h** | -44.6 +/- 3.8 |

**PANELSLEEP MAKES IT WORSE - roughly +13 to +24 mV/h, about a 50% heavier blanked drain -
and the A-B-A is why that is a result rather than drift.** The baseline returned to -42 after
35 minutes, so the cell was not running away underneath the comparison. Both plausible drift
mechanisms point the other way as well: relaxation is decaying (which flatters LATER legs) and
falling SoC moves off the steep top of the curve toward the flatter middle (also flattering
later legs), so a later leg draining FASTER cannot be drift and the true penalty may be larger.
**The mechanism is NOT understood.** `sleepPanel(true)` sends DISPOFF then SLPIN, rendering is
already gated on `!isAsleep` so neither leg flushes anything, and no wasted-work explanation
survives that. Recorded as measured-and-unexplained rather than guessed at; **it should not
ship, and it should not be re-proposed without a new measurement.**

**THE DOCUMENTED 3-MINUTE SETTLE IS TOO SHORT, AND THE INSTRUMENT CANNOT SEE IT.** Unplugging
dropped the cell **-50 mV in one minute** (4164 -> 4114), against the -21 mV this file recorded
before, and the relaxation was still bending the fit ELEVEN minutes later: the first leg walked
-123 -> -121 -> -113 -> -106 -> -98 -> -90 without converging, while the independent raw fit put
the first five minutes at **-104.6 mV/h** and the following eight at **-50.6**. A leg started at
three minutes reads roughly double the truth - an error larger than any saving being hunted.
`POWERPROBE` reported SNR well past its gate throughout, because the standard error it publishes
is that of a STRAIGHT-LINE fit and a relaxation curve fits a straight line beautifully: **the gate
certifies precision, never accuracy.** What caught it was the monotonic walk across successive
ticks plus the second computation - not the number. Wait for the fit to stop walking, and treat a
monotonic sequence of tick reports as "still settling" no matter what its SNR says.

**A LEG IS VOID IF THE DEVICE WAKES, AND `asleep=` IS THE ONLY THING THAT SAYS SO.** One leg here
was lost to a touch: the raw series shows the backlight as a **-23 mV STEP in one minute**, and
the fitter read that step as a slope of **-473 mV/h** - a plausible-looking number for a state the
device was never in. Check `asleep=1` on every leg; a step is not a rate.

**Layout cost: the DEVICE card grew 176 → 200** for the new row, which came out of page 0's
TRAILING AIR rather than out of another row. `LINK_CARD_Y` is derived from `DEV_CARD_H`, so the LINK
card slid 304 → 328 on its own and the page's air went **28px → 4px** — the same margin the USAGE
tab settled on, and the checker asserts it stays above zero. **There is no room left on page 0**: a
further row has to come from somewhere else. Total cost **+4140 bytes of flash, +288 RAM** (the two
30-slot rings are 240 of that), measured against a worktree build of HEAD rather than against this
file's previous figures, which were stale.
