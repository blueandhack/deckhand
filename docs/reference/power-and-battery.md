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
>
> **NARROWED 2026-10-09, still without a meter.** The x1.8-vs-x2-vs-x2.2 ambiguity above came from
> reasoning about a MID-RANGE reading, where a cell's voltage is free to be anything. The
> FULL-CHARGE reading is not free: a 1S charger pins the cell near 4.1-4.2 V. At x1.8 the observed
> 4165 mV would be a true full of **3748 mV**, at x2.2 **4582 mV** - both impossible for a 1S
> charger - so the ratio is **2.00 +/- ~1%** (2.017 if the charger ends at 4.20 V, 1.993 if 4.15 V).
> That favours the second explanation above - the charger genuinely terminates near 4.16 V - over a
> divider error, but it rests on the assumption of a standard charger rather than on a meter, and
> `BOARD_BATT_FULL_MV` is still 4180. **Consequence, user-visible and unchanged: board 2 can never
> show 100% or report FULL**; its ceiling is 96-97% (`pctFromMv(4165)`). A suspected error in the
> SHAPE of `pctFromMv()` was raised the same day and **withdrawn** - it rested on reading "I found it
> dead after a week" as "it lasted eight days", which the owner corrected. Nothing has measured the
> curve's shape; one instrumented discharge would.

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

#### CPU FREQUENCY: the die runs 3.5C cooler at 80MHz, and the BATTERY effect could not be measured

`CPUMODE` scales the core between `CPU_MHZ_BASE` (80) and `CPU_MHZ_BOOST` (240) while awake,
boosting on touch and on `forceFullRepaint()` and dropping back 1.5s later. `dyn` or a fixed
240/160/80; **default `dyn` since 2026-09-16** (it was 240), on a DECISION rather than a finished
measurement - see the correction immediately below and the unmeasured battery effect further down.

**CORRECTED 2026-09-16: `dyn` NEVER LEFT 240MHz, SO EVERY `dyn` FIGURE IN THIS FILE IS A 240
FIGURE.** The paragraph above described the intent; the code did not do it. `cpuBoost()` was the
FIRST statement of `handleTouch()`, and `loop()` calls that every iteration - so the 1500ms boost
deadline was re-armed thousands of times a second and `cpuTick()` never once saw it expire. The
mode reported itself as `dyn` throughout. **Measured:** five `CPUMODE` samples twelve seconds
apart on an idle device, all `now 240 MHz`; after gating the boost on an actual finger
(`if (touching) cpuBoost();`, placed after `getTouchPoint()` so the test can exist), five more,
all `now 80 MHz`. Die temperature followed, 42.6C -> 40.6C in the same charging state. Three
assertions in `batt-trend-check.py`, bound to `handleTouch()`'s brace-matched body because the
other `cpuBoost()` in `forceFullRepaint()` satisfies a file-wide match, now fail by name if the
call is ungated, unguarded, or moved back ahead of `getTouchPoint()`.

This is why an instrument pointed at the label rather than the glass is worse than none: `CPUMODE`
answered `dyn` correctly - that WAS the mode - while the clock it was describing had never moved.
Only `now <n> MHz` in the same reply told the truth, and only when read on an idle device.

**SAFE ON THE S3 IN A WAY IT IS NOT ON BOARD 1's CHIP.** The S3 holds APB at 80MHz whatever the
core is set to (arduino-esp32 #7086: `getApbFrequency()` still reports 80MHz with the CPU at 10),
so QSPI, I2C, LEDC and I2S do not move. Below 80 both chips clock APB off the XTAL and everything
downstream shifts, which is why the command REFUSES anything but the three PLL frequencies rather
than clamping - a silently adjusted clock would make every later measurement one of something else.
This also **retracts an earlier guess in this file's history** that `CPUSLOW` might have caused a
spurious touch by disturbing I2C timing. On this silicon it cannot.

**THE RENDER COST, measured over USB so no cell is involved and no drift can reach it:**

| clock | tab switch (3 tabs) | vs 240 |
|---|---|---|
| 240 MHz | 65 / 75 / 76 ms | - |
| 160 MHz | 85 / 85 / 99 ms | +25% |
| 80 MHz | 144 / 148 / 171 ms | +114% |

A 3x slower clock costs only 2.1x the time. Fitting `T = C/f + K` gives **~41ms of CPU work at
240MHz plus ~31ms of fixed QSPI transfer** (predicts 92ms at 160, measured 90). That is why 80MHz
hurts less than feared - and why boosting helps less than hoped, since a third of the work is
bus-bound and no clock touches it.

**THE DIE TEMPERATURE, A-B-A, AND THIS ONE HELD:**

```
240 MHz  die 46.6C  |  80 MHz  die 42.6C  |  240 MHz  die 45.6C   (charging throughout)
```

**3.5C cooler at 80MHz against 1.0C of bracket drift** - the effect is 3.5x the noise. The FIRST
power measurement on this board where the bracket closed and the effect cleared it.

**BUT THE DIE IS NOT THE CASE**, which is the same trap `SCREENSHOT` sets one layer down: the
sensor is inside the S3 package and cannot see the charger IC or the cell. Warmth in the hand
while charging is the charger burning `(5V - Vbat) x Icharge` - about half a watt - plus the
backlight. Scaling the clock cools the CORE 3.5C and does little for the case.

**THE BATTERY EFFECT IS NOT ESTABLISHED, AND FOUR ATTEMPTS FAILED IN INSTRUCTIVE WAYS.** The
first three share one fatal defect discovered on 2026-09-16 and recorded above: **`dyn` was 240**,
so every leg below that compares `dyn` against `240` compares 240 against itself, and the flat
result is not evidence of "no difference" - it is the arithmetic of measuring one state twice.
That is the real reason the effect "resisted two attempts". A fourth attempt, an hourly-alternating
rig, was erased before it closed its gate when a macOS upgrade cleared `/tmp`; its one usable pair
also gave `dyn` the flat upper part of the discharge curve (4068-3962 mV) and `240` the steeper
part below it (3961-3903), confounding order with setting exactly as the first sweep did.
**Nothing here has yet compared a real 80MHz idle against a real 240MHz idle.**

A straight sweep 240/160/80/dyn/240 reported an apparent **45% saving at 80MHz** - and its closing
bracket read **-52.7 mV/h against the opening leg's -126.1 for the SAME setting**. The run began
7 minutes after unplugging, where this file already says the fit is "still walking at 11 minutes":
the opening leg ate the relaxation tail. **The sweep also confounded order with setting** - 240 ran
first and 80 third, so drift and effect had the same shape, which no amount of settling fixes.
Re-run INTERLEAVED as 240/80/240/80 with a 3-minute settle after each mode change (a mode change is
a load step, and the first attempt let every probe eat one), the two pairs disagreed outright:

```
pair 1: 240 - 80 =  -2.4 +/- 6.4 mV/h      pair 2: 240 - 80 = -36.9 +/- 6.1 mV/h
```

Two estimates of one quantity, six error bars apart. Notably the two **80MHz legs were identical**
(-64.3, -64.3) while the two 240MHz legs differed by 35 mV/h - so it is not simple drift, which
would move both. **The awake state carries ~35 mV/h of unexplained instability, half its own total
drain**, and no 10-minute probe can resolve a smaller effect through it. An alternating long-run
comparison (`cpuflip.sh`, 2h per mode, aggregated by `cpuverdict.py` over discharging segments
only) is running instead; hours of ordinary use average over noise a short window cannot.

#### AUTO POWER-OFF: the saving existed and was simply never REACHED

Power-off measures at **-3.6 mV/h** and light sleep at **-6.9**, and the everyday pattern - unplug
and walk away - lands on the WORSE one. A 13-hour absence was measured doing exactly that: no
`PWROFF` record, so it had light-slept the whole time. **The fix was in a path the device rarely
entered.** `AUTO_POWEROFF_MS` (2h, board 2) now routes it there on its own.

> **THE PREMISE DID NOT SURVIVE A LONGER MEASUREMENT (2026-10-09).** The -3.6 was an 8.9-hour leg
> on a reconstructed clock; the 69-hour, receipt-bracketed run below measured power-off at
> **-7.41 mV/h**, which is light idle's -6.9 to within leg-length noise. On that figure the saving
> this section is named for is about zero, and what auto power-off still buys is only a firm floor
> for a device whose owner has not turned light idle on. `AUTO_POWEROFF_MS` is left at two hours
> rather than shortened: shortening it would save almost nothing and cost touch-to-wake. See
> "LIGHT IDLE ALREADY COSTS ABOUT WHAT POWER-OFF DOES" below.

**THIS REOPENS A DECISION THAT WAS CLOSED, AND THE OLD REASONING IS KEPT IN PLACE rather than
deleted.** `BOARD_HAS_TOUCH_SLEEP_WAKE`'s note refuses auto-sleep here because this board cannot
wake itself on a touch, so it would become *"a status display that has silently become a brick
until someone walks over"*. That was written before `LIGHTIDLE`, and it is much weaker now: with
light sleep on, a blanked device on battery is ALREADY off the air - radio down, unreachable, and
showing stale data until a finger arrives. Auto power-off costs no reachability light sleep had not
already taken; it costs TOUCH-to-wake, replaced by RESET. **Two hours**, not board 1's twenty
minutes: the objection is being met by a dead screen after stepping away, and at two hours you have
not stepped away, you have left.

**LIGHT SLEEP WOULD HAVE MADE THE DEADLINE UNREACHABLE, SILENTLY.** `esp_light_sleep_start()` stops
`loop()` dead, so the check that fires `autoPowerOff()` never runs - the two features cancelling
each other with no symptom but the drain. `enterLightIdle()` therefore arms a TIMER for the
remaining time as well as the touch GPIO: one wake AT the deadline, with `loop()` re-evaluating its
own gates on the way past so nothing is duplicated. Asserted, because nothing else would have
noticed.

**`autoPowerOff()` draws NO farewell**, unlike board 1's `autoDeepSleep()` which lights the panel to
show one. That is right at twenty minutes, when somebody may still be in the room; at two hours,
lighting a 320x480 panel to say goodbye to an empty room spends the very thing it is saving.

#### Two hygiene steps that are NOT claimed as savings

`PWROFF_LED_LOW` and `PWROFF_RTC_OFF`, in the default as `0x37`. **The -3.6 mV/h above was measured
at 0x7, BEFORE both**, and neither is expected to be visible.

- **The RGB LED.** `PIN_RGB_LED` is a WS2812-style part the firmware NEVER drives, which is why
  nothing is lit. Dark is not off - its controller draws roughly 1mA (datasheet-typical, not
  measured here) whenever powered, and only losing that supply stops it. This holds its data line
  LOW through sleep as INSURANCE: a floating WS2812 data line can latch noise as a colour, which
  would cost far more than the quiescent it cannot avoid. GPIO40 is outside the RTC set, so it takes
  `gpio_hold_en`, not `rtc_gpio_isolate`.
- **RTC_PERIPH, and only that one - the SILICON, not a choice.** `RTC_SLOW_MEM` and `RTC_FAST_MEM`
  were tried and WOULD NOT COMPILE: every entry of `esp_sleep_pd_domain_t` sits behind a
  `SOC_PM_SUPPORT_*_PD` capability and `esp32s3/soc_caps.h` defines only
  `SOC_PM_SUPPORT_RTC_PERIPH_PD`. The S3 cannot gate the other two at all.

**A LITERAL NVS FALLBACK SILENTLY DISCARDED THE COMPILED DEFAULT, and only the device said so.**
`loadPwrOffMode()` read `prefs.getUInt("pwroffMode", 0)`, so a fresh NVS loaded 0 regardless of what
the source said - changing the C++ default changed nothing. Found by asking the device after a
flash: it answered `0x7` against a source that said `0x37`. The fallback is now the compiled default
and that is asserted. **Every bit is in the report line too**, for the same reason `SAVINGS` gained
a read-only form: a bit you cannot see is a setting you cannot verify.

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

> **SUPERSEDED IN SIZE 2026-09-24 - read "A 69-HOUR POWER-OFF" below.** A receipt-bracketed run
> 7.8x longer than the `0x7` leg, on `0x37` (this default plus two hygiene bits), measured
> **1.08 %/h**, against the **0.43 %/h** in this table: 2.5x worse. The table is kept as measured;
> the longer run is the better figure, and caveats 1 and 2 below are the likely reason they differ.

**THREE CAVEATS, ALL LOAD-BEARING.**
1. **The elapsed time is RECONSTRUCTED, not measured**: 8.94 h from 1761 host ticks (2.45 h) plus
   23,364 s of logged "machine was asleep" (6.49 h). The host log carries NO TIMESTAMPS, which is
   the real gap here; any error in that reconstruction scales the rate directly.
2. **One unbracketed run.** Nothing repeated it, and nothing bracketed it.
3. **Attribution is unknown.** All three steps ran together. Which one did the work was not
   narrowed, deliberately: all three are free during a power-off (nothing can wake this board by
   touch), so the combination is what ships.

**IT HALVED RATHER THAN COLLAPSED**, which is consistent with a board-level floor no firmware can
reach. The FLOOR is measured; what makes it up is NOT, and an earlier version of this paragraph
blurred those together.

> **CORRECTED - the "power LED" here was never on this board.** This said the remainder was "an
> AMS1117-class LDO at ~5mA and a power LED 2-3mA". Both figures came from generic ESP32 dev-board
> literature and NEITHER was checked against the ES3C35P. Caught by the owner simply looking at the
> hardware and asking why no LED was lit. There is **no power LED documented on this board** - the
> only one in the header is `PIN_RGB_LED 40`, an addressable WS2812-style RGB that the firmware
> **never drives**, which is exactly why nothing is visible. That part is still not free: a WS2812's
> controller draws roughly 1mA (datasheet-typical, NOT measured here) whenever it has power, showing
> black or not, and only losing its supply stops it. The regulator part number is likewise unknown -
> the vendor page omits it and there is no schematic in this repo.
>
> So: the remaining ~10%/day is real and measured. Attributing it to named parts is guesswork until
> somebody puts a meter in series with the cell, and it should not be written as though it were not.

Reaching the rest means an inline switch on the JP1 battery lead - which cuts everything regardless
of which part is responsible, and is why the advice does not depend on the attribution being right.
`README.md` has said as much all along: *"'Off' is deep sleep, a few mA, not a hard power cut ...
For true zero draw, unplug the battery."*

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

#### A 69-HOUR POWER-OFF: -7.41 mV/h, about FOUR DAYS from full

The best power-off figure this board has, and the reason the table above is superseded in size:

| | |
|---|---|
| mode | `0x37` |
| off / awake | **4158 -> 3645 mV**, from the device's own `PWROFF record` (12 settling samples before it compares) |
| elapsed | **69.2 h** (last collector contact 2026-09-22 02:02 to wake 2026-09-24 23:17) |
| rate | **-7.41 mV/h**, **1.08 %/h** (96% -> 21%) |
| full charge lasts | **~3.9 days** (4.3 if the start is taken as the ~4100 mV a cell rests at after unplugging) |

A 40-minute `PWROFF record` three days earlier (4157 -> 4152, -5 mV) gave **-7.4 mV/h** - a spot
reading at the top of the curve and a three-day average across most of it, agreeing to ~2%.
"I found it dead after a week" (2026-10-01) is consistent with this, not a contradiction: it went
flat around day four and sat there. An earlier estimate of 5.4 days, built on an ASSUMED split
between blanked and powered-off time, was ~30% optimistic and is not repeated here.

Converted at the unverified 3000 mAh, 1.08 %/h is **~25-30 mA** - roughly a thousand times the
S3's own deep-sleep current. So almost all of it is OTHER chips on rails no pin switches. If the
cell is smaller than claimed the current is proportionally smaller; only a meter settles it.

#### THE POWER-OFF RECEIPT NOW FINISHES ITSELF

Three of the first power-off measurements were lost to the same missing number - elapsed time -
which the device cannot hold (deep sleep here ends in a RESET, which clears RTC memory, and
`hostNowSec()` carries no date). Two changes close it:

- **The receipt is delivered off the cable.** It used to be sent from `setup()`, before any
  central had subscribed, so with the cable out it went nowhere. It is now armed at boot and sent
  from `loop()` once a host is LISTENING - `usbLinkActive()` or `bleHostHeard()`, both "the host has
  sent us a payload within 10 s". `bleConnected` was tried first and lost a receipt on 2026-10-09:
  it flips at the radio-link level, seconds before the Mac subscribes.
- **The Mac supplies elapsed.** `host/index.mjs` persists last contact per device to
  `~/.claude/deckhand-power-state.json` and turns every receipt into one line:
  `POWEROFF MEASURED: 4158 -> 3645 mV, 513 mV over 69.20 h = 7.41 mV/h (mode 0x37)`.

**Its limits, stated:** elapsed runs from LAST CONTACT to when the receipt is PROCESSED, so it is an
upper bound twice over - the device may have left range before powering off, and a receipt pulled
later with `PWROFFMODE` (which re-emits it from RAM) counts the awake time since the wake. Under
~3 minutes of elapsed it prints NOTHING rather than a refusal - a known silent path, not yet fixed.
And it cannot see relaxation: legs of 22 and 29 minutes came straight off the charger and read
**189** and **130 mV/h** - 18-25x the real rate - because the whole leg sat inside the post-charge
relaxation this file measures above. **Short legs measure the plumbing, never the drain.**

#### THE AMP ENABLE DOES GATE THE AMP - ON BATTERY (2026-10-05)

`board_es3c35p.h` recorded "PIN_AMP_EN GATES NOTHING" - true, and measured ON USB, where U6 sits on
a real 5 V that a 3.3 V high cannot reach. With the cable OUT, `TONETEST 85` over BLE played trial A
(pin LOW, 1000 Hz) and was **silent on trial B (pin HIGH, 400 Hz)**, heard and confirmed twice by
the owner, the second time asked for pitch. On battery U6's supply is lower and 3.3 V reaches it:
**LOW = amp on, HIGH = amp off**, board 1's own scheme. (The cabled positive control at volume 30
was inaudible - the device warns that level is quiet - so the battery runs were at 85.)

**This is most of why board 1 "loses almost nothing" and board 2 does not.** Board 1's FM8002E sits
behind a 10 K pull-up that holds it MUTED, so in deep sleep its floating GPIO keeps it off for free.
Board 2's wiring intends the same (R26 is a 10 K pull-up) and on battery gets it - the floating pin
already sits at the OFF level. While AWAKE, though, the firmware deliberately holds the pin at
`AMP_EN_ENABLE_LEVEL` (LOW) the whole time, so on battery the amp is powered every second the
device runs. Muting between sounds is NOT done: coming out of shutdown is the hundreds-of-ms C41
ramp, so every beep would pay it. That trade is open.

#### MORE POWER-OFF STEPS, AND WHAT EACH MEASURED

All are bits of `PWROFFMODE`, all DEFAULT 0, all readable in its reply and in the receipt's `mode=`.

| bit | step | result |
|---|---|---|
| `0x40` usbIso | float the USB-Serial-JTAG pads (GPIO19/20; the core ships FLASH and PSRAM sleep-leakage workarounds and none for USB) | **15.29 mV/h**, 2.29 %/h, 30.3 h, 4126 -> 3663 - worse than the control, see the confound below |
| `0x80` sdIso | float the SDMMC bus (GPIO2..7; a 16 GB card is present and never deselected) | not measured. Cannot cut the card's VDD, so its ceiling may be zero |
| `0x100` ampLow | drive the amp enable LOW and hold it | **MEASURED WRONG.** Reasoned from the USB-only note; on battery LOW turns the amp ON, so it held it on: **12.01 mV/h**, 1.33 %/h, 21.6 h (elapsed overcounted ~1 h). Kept so that result stays readable |
| `0x200` ampHigh | drive the amp enable HIGH (the heard OFF level) and hold it | not measured. Expected to match the control, since the floating pin already sits HIGH - it makes that deliberate |
| `0x400` codecSusp | Espressif's own `es8311_suspend()`, all 15 writes. `CODEC_DOWN` only ever did the last one, leaving `0x0D` = 0x01 (analog ON) and `0x01` = 0x3F (all clocks ON) through every power-off | **Verified to take** - the receipt read back `codec=0D:FC/01:00`; the post-wake register dump was byte-identical to the one before; MICTEST captured live audio after. Current saving NOT measured |

**The confound that blocks every comparison in this table:** the control was measured BEFORE the
cell ran completely flat (see below), every new leg AFTER, and a cell that lost capacity drains
faster at the same current. A fresh `0x37` leg on today's cell is the prerequisite, not optional.
A `0x237` leg (2026-10-06..09) is VOID: it was powered off at 14% and ran through the bottom of the
curve to 2769 mV. `qspiIsolate` (`0x8`) remains measured-against, as recorded above.

#### LIGHT IDLE ALREADY COSTS ABOUT WHAT POWER-OFF DOES

Blanked with light idle **-6.9 mV/h** (this file, above) against power-off **-7.4** (the 69-hour
run). Different-length legs, so "about equal" rather than a tie - but it means that on a device with
light idle on, shortening `AUTO_POWEROFF_MS` saves almost nothing, at the price of needing RESET to
wake. Both states sit on the same board-level floor; the S3's own sleep current is a rounding error
in either. `saveLightIdle` still defaults to `false`; the owner's device has it on.

#### RUNNING-STATE SAVINGS: built, the battery effect UNMEASURED

- **Dynamic CPU never worked until 0b66072** (`cpuBoost()` re-armed every loop) - see the CPU
  section above.
- **The awake loop yields** `AWAKE_LOOP_IDLE_MS` (4 ms, under the 15 ms touch poll) when no finger
  is down, so the idle task reaches WAITI.
- **The awake BLE link carries slave latency** `BLE_AWAKE_LATENCY` (4), pushed on CONNECT - before,
  parameters were only ever pushed on a sleep/wake transition, so a link that connected awake kept
  macOS's 15-30 ms with no latency for its life.
- **Advertising slows to 1000-1200 ms** once a link is up and no pairing is underway (stock was
  20-40 ms, continuously, while connected). Slowed, never stopped: a second Mac attaches through it.

Die temperature across those steps, same charging state: **42.6 -> 40.6 -> 36.6 C**, part of the last
step being charge-current taper. No battery figure exists for any of them.

#### CHARGING: about 6.5-7 %/h awake on the cable - roughly 15 hours from empty

Measured 2026-10-09 from the collector, the device awake and on the Mac's cable throughout:

| window | gained | rate |
|---|---|---|
| 13:30 -> 14:30 | 3% -> 9% | ~6 %/h |
| 14:30 -> 17:58 | 9% -> 32% | ~6.6 %/h |
| 17:58 -> 18:26 | 32% -> 37% | ~7 %/h |

Consistent with 2026-09-25 (~8 %/h, 22% -> 38% in ~2 h), so it is how this board charges, not a
fault. Compare in %/h: mV/h falls through the flat middle of the curve at a constant current.

Why, as INFERENCE: the charger is small for the cell - this file's heat estimate (`(5V - Vbat) x
Icharge` ~ half a watt) puts it near **0.4 A**, 7-8 h for 3000 mAh with nothing running - and the
observed rate implies only **~0.2 A** reaching the cell, consistent with the awake device consuming
the rest. On the cable it never light-sleeps (light idle is inert while `usbLinkActive()`).
**NOT ESTABLISHED:** board 2's power path. The `TP4054 + Q3 power-path` note in
`deckhand_display.ino` describes BOARD 1 (its `BAT_ADC` is IO34); board 2's is undocumented, and the
3000 mAh and the charge current are both unverified. **Charging continues while powered off** - the
charger is hardware off USB 5 V - so charging powered off should be faster; one hour each way,
compared through the receipt's off/awake voltages, would test that directly.

#### THE CELL HAS BEEN RUN FLAT TWICE, AND NOTHING IN FIRMWARE STOPS IT

1. **~2026-09-25 .. 10-01:** powered off and found flat after about a week; read 3277-3309 mV, 0%,
   on reconnecting, and recovered on charge.
2. **2026-10-06 .. 10-09:** powered off at **3586 mV (14%)** - the Mac's last reading, 3749 mV, was a
   CHARGING voltage - and found at **2769-2853 mV**, well below the 3300 mV the curve calls 0%, then
   left AWAKE on battery until plugged in. It accepted charge (2853 -> 2990 within minutes).

Power-off still draws milliamps and nothing wakes the board to look, so a device powered off low
simply drains through zero. **Not built, proposed:** a warning at power-off below ~25% ("flat in ~N
hours, charge first"), an immediate power-off below ~3.45 V while awake, and a Mac notification on a
low reading. After two deep discharges, a loss of capacity would show as a faster %/h drain on the
next control leg - which is one more reason that leg comes first.
