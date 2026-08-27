// Power: backlight, battery, beeper, volume, sleep and deep sleep.
// Split out of deckhand_display.ino. The Arduino build concatenates every .ino
// in this folder into ONE translation unit - main file first (it matches the
// folder name), then the rest alphabetically - so these still share every global
// and there are no headers. Verified before splitting: no function signature in
// this sketch names a type declared after the first function definition, which
// is what would break the auto-generated prototypes.

// What the two farewell screens tell you to do to bring the device back. One
// constant because the two screens must never disagree, and because whether a
// touch can wake this chip at all is a board fact (BOARD_HAS_TOUCH_SLEEP_WAKE).
#if BOARD_HAS_TOUCH_SLEEP_WAKE
#define WAKE_HINT "touch screen to wake"
#else
#define WAKE_HINT "press RESET to wake"
#endif

void setBacklight(int pct) {
  brightnessPct = constrain(pct, BRIGHTNESS_MIN, 100);
  ledcWrite(TFT_BL_PIN, brightnessPct * 255 / 100);
}
void loadBrightness() {
  brightnessPct = prefs.getInt("bright", 100);
  setBacklight(brightnessPct);
}
void saveBrightness() {
  prefs.putInt("bright", brightnessPct);
}
void applySleepPreset() {
  sleepTimeoutMs = SLEEP_PRESETS_MS[sleepPresetIdx];
}
void loadSleepTimeout() {
  sleepPresetIdx = prefs.getInt("sleepIdx", 1);
  if (sleepPresetIdx < 0 || sleepPresetIdx >= SLEEP_PRESETS_COUNT) sleepPresetIdx = 1;
  applySleepPreset();
}
void saveSleepTimeout() {
  prefs.putInt("sleepIdx", sleepPresetIdx);
}
void formatSleepValue(char* buf, size_t n) {
  if (sleepTimeoutMs == 0) {
    snprintf(buf, n, "OFF");
  } else if (sleepTimeoutMs < 60000) {
    snprintf(buf, n, "%lus", sleepTimeoutMs / 1000);
  } else {
    snprintf(buf, n, "%lum", sleepTimeoutMs / 60000);
  }
}
#if !BOARD_USES_TFT_ESPI
// THE THREE BLANKED-STATE SAVINGS, EACH A RUNTIME TOGGLE THAT DEFAULTS OFF.
//
// Measured first, which is why they exist at all: board 2 draws ~142 mV/h awake
// at 90% brightness and ~60 mV/h with the backlight at its 10% floor, so the
// backlight is ~56% of it and roughly 50 mV/h SURVIVES with the screen dark.
// That 50 is what these three compete for - the panel controller still fully
// active, the S3 at 240MHz, and a 30ms BLE connection interval.
//
// THEY ARE TOGGLES RATHER THAN PLAIN BEHAVIOUR FOR THE SAME REASON SWAP/INV
// ARE: measuring one needs the cable out and ~10 minutes on battery, so three
// separate build-and-measure cycles costs a reflash per guess where one build
// plus POWERPROBE settles all of them in a single session. Nothing is
// persisted, deliberately - the answer belongs in this board's header once
// someone has SEEN it, not in NVS where it would quietly disagree with the
// header the next reader trusts.
//
// Board 1 is excluded on purpose. It has a different SoC, a different panel
// driver, and auto-deep-sleep as a backstop - and no way for me to measure any
// of it, so shipping it an untested behaviour change would be asserting a
// saving nobody has weighed.
// The three flags and CPU_MHZ_* live in deckhand_display.ino, not here: that
// file is concatenated FIRST and its command dispatch needs them in scope.
// Connection interval is negotiated in 1.25ms units. macOS settles on 30ms;
// asking for ~180-210ms while blanked cuts the radio's duty cycle roughly
// proportionally. The peer may REFUSE, which is why nothing downstream assumes
// it took effect - the measurement is what says whether it did.
void bleSetSlowInterval(bool slow) {
  uint16_t minItvl = slow ? 144 : 12;   // 180ms vs 15ms
  uint16_t maxItvl = slow ? 168 : 24;   // 210ms vs 30ms
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!bleLinks[i].used || bleLinks[i].releasePending) continue;
    struct ble_gap_upd_params p = {};
    p.itvl_min = minItvl;
    p.itvl_max = maxItvl;
    p.latency = 0;
    p.supervision_timeout = 400;        // 4s, comfortably over the slow interval
    ble_gap_update_params(bleLinks[i].connId, &p);
  }
}
#endif

// Reconciles the three APPLIED states against what is wanted right now, which
// is `isAsleep && <flag>`. One function for every transition - entering sleep,
// waking, and a toggle flipped at any moment - because the bug this replaces
// came from apply and restore being two separate conditions that could disagree.
//
// Idempotent by construction: each branch checks the applied state, so calling
// it twice does nothing the second time and a toggle flipped mid-blank takes
// effect immediately instead of waiting for a tap.
//
// ORDER IS LOAD-BEARING IN BOTH DIRECTIONS. Restores run first and lead with the
// CPU, so the panel's two 120ms sleep-out delays and the repaint after them do
// not also run at a third speed - that is the path a person is waiting on.
// Applies run in the reverse order and leave the CPU for last, since everything
// ahead of it talks to peripherals and the saving is the time spent afterwards.
void savingsSync() {
#if !BOARD_USES_TFT_ESPI
  const bool wantPanel = isAsleep && savePanelSleep;
  const bool wantBle   = isAsleep && saveBleSlow;
  const bool wantCpu   = isAsleep && saveCpuSlow;

  if (cpuSlowApplied && !wantCpu)   { setCpuFrequencyMhz(CPU_MHZ_AWAKE); cpuSlowApplied = false; }
  if (bleSlowApplied && !wantBle)   { bleSetSlowInterval(false); bleSlowApplied = false; }
  if (panelSleptApplied && !wantPanel) {
    tft.sleepPanel(false);
    // The panel's own RAM survives SLPIN, but the shim's dirty rect describes
    // nothing after a sleep cycle, so without this nothing repaints a screen
    // that may have lost content.
    forceFullRepaint();
    panelSleptApplied = false;
  }

  if (wantPanel && !panelSleptApplied) { tft.sleepPanel(true); panelSleptApplied = true; }
  if (wantBle && !bleSlowApplied)      { bleSetSlowInterval(true); bleSlowApplied = true; }
  if (wantCpu && !cpuSlowApplied)      { setCpuFrequencyMhz(CPU_MHZ_BLANKED); cpuSlowApplied = true; }
#endif
}

// Percent of the SET brightness the dim stage uses. Relative, not absolute, and
// that is forced: brightness can be as low as BRIGHTNESS_MIN (10), where a fixed
// "dim to 15%" would be BRIGHTER than lit. Floored at BRIGHTNESS_MIN because
// that constant exists precisely because below it the screen reads as broken -
// so at brightness 10 the dim stage is a deliberate no-op rather than a black
// screen pretending to be dim.
const int SCREEN_DIM_PCT = 30;
// A reading older than this does not count as activity. Without it a vanished
// host would pin the screen lit forever on sessions that may have finished hours
// ago - the same distinction lastNonIdleMillis already makes for deep sleep.
const unsigned long SCREEN_ATTENTION_STALE_MS = 30000;

int screenDimDutyPct() {
  int p = brightnessPct * SCREEN_DIM_PCT / 100;
  if (p < BRIGHTNESS_MIN) p = BRIGHTNESS_MIN;
  if (p > brightnessPct) p = brightnessPct;   // never dim UP
  return p;
}

// Does anything actually want the user right now? sessionCount == 0 is false, so
// an empty list lets the ladder run - which is the "no session active" half of
// the requirement.
bool attentionNeeded() {
  if (!everReceived || (millis() - lastRxMillis) >= SCREEN_ATTENTION_STALE_MS) return false;
  for (int i = 0; i < sessionCount; i++) {
    if (strcmp(sessions[i].status, "working") == 0) return true;
    if (strcmp(sessions[i].status, "asking") == 0) return true;
  }
  return false;
}

// 0 = lit, 1 = dim, 2 = blank. Pure arithmetic so batt-trend-check.py can mirror
// it: the boundaries are exactly where a hand-rolled inequality gets them wrong.
int screenIdleStage(unsigned long idleMs, unsigned long dimMs) {
  if (dimMs == 0) return 0;              // the OFF preset: never dim, never blank
  if (idleMs >= dimMs * 2) return 2;
  if (idleMs >= dimMs) return 1;
  return 0;
}

// Drives the ladder from loop(). Only a TOUCH leaves the blank stage (verified:
// wakeUp has exactly one call site), so this never un-blanks.
void tickScreenIdle() {
  if (attentionNeeded()) lastAttentionMillis = millis();
  unsigned long base = lastActivityMillis > lastAttentionMillis
                       ? lastActivityMillis : lastAttentionMillis;
  int stage = screenIdleStage(millis() - base, sleepTimeoutMs);
  if (stage == 2) {
    if (!isAsleep) { isDimmed = false; enterSleep(); }
    return;
  }
  if (isAsleep) return;
  bool wantDim = (stage == 1);
  if (wantDim != isDimmed) {
    isDimmed = wantDim;
    // Un-dimming without a touch is reachable and wanted: a session going
    // `working` moves the clock forward, so the screen brightens by itself when
    // something starts needing you. (Un-BLANKING never happens that way - only
    // a touch leaves the blank stage.)
    ledcWrite(TFT_BL_PIN, (wantDim ? screenDimDutyPct() : brightnessPct) * 255 / 100);
  }
}

void enterSleep() {
  isAsleep = true;
  // Backlight FIRST. It is the dominant load and it is instant, so the screen
  // goes dark at once rather than blanking in stages - and the slower panel
  // teardown then happens behind a dark screen where none of it is visible.
  ledcWrite(TFT_BL_PIN, 0);
  savingsSync();
}
void wakeUp() {
  isAsleep = false;
  isDimmed = false;          // a wake is always full brightness
  lastActivityMillis = millis();
  savingsSync();
  // Backlight LAST, over a panel that has finished waking - otherwise the first
  // thing lit is whatever the panel held mid-sequence.
  ledcWrite(TFT_BL_PIN, brightnessPct * 255 / 100);
}
void sampleBattery() {
  long sum = 0;
  for (int i = 0; i < 4; i++) sum += analogReadMilliVolts(BAT_ADC_PIN);
  // BOARD_BAT_MV_SCALE, not a literal: the divider ratio is the board's, not this
  // function's. 2 on both boards today (board 1's 100K/100K halves VBAT; board 2's
  // ratio is documented as UNVERIFIED in its header, which is where a measurement
  // lands rather than here). No attenuation call is needed on either: Arduino's
  // default for an ADC1 pin is already the widest range (~0-3.1V), and a 1S cell
  // through a x2 divider peaks at ~2.1V inside it.
  int mv = (int)(sum / 4) * BOARD_BAT_MV_SCALE;
  batteryMv = batteryMv < 0 ? mv : (batteryMv * 7 + mv) / 8;
}
// Below this there's clearly no cell attached (R3 pulls the pin to ground).
bool batteryPresent() { return batteryMv > 2500; }
// Resting-voltage discharge curve for a 1S LiPo. Coarse on purpose: without
// a coulomb counter this is an estimate, and load sag makes it read a few
// percent low while the backlight is bright - fine for a desk gadget.
// Split out from batteryPct() so a STORED sample can be mapped through the same
// curve. The trend below needs that: the non-linearity lives in this table, so a
// slope taken in millivolts is not a slope in charge.
int pctFromMv(int mv) {
  static const int mvT[] = {3300, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200};
  static const int pcT[] = {0, 8, 15, 28, 45, 62, 78, 90, 100};
  const int n = 9;
  if (mv <= mvT[0]) return 0;
  if (mv >= mvT[n - 1]) return 100;
  for (int i = 1; i < n; i++) {
    if (mv < mvT[i]) {
      return pcT[i - 1] + (pcT[i] - pcT[i - 1]) * (mv - mvT[i - 1]) / (mvT[i] - mvT[i - 1]);
    }
  }
  return 100;
}
int batteryPct() { return pctFromMv(batteryMv); }
// ----- Time remaining on battery -----
//
// There is no coulomb counter on this board, so runtime left can only come from
// watching the voltage fall - which makes the NOISE FLOOR the whole design
// problem, not the arithmetic. The sleep report already records what happens
// when a small delta is extrapolated: a 7mV drift over 3 minutes became
// "-133.7 mV/h", a flat cell in four hours, from noise multiplied by 20. So
// nothing is reported until the window is both long enough and has moved far
// enough for the movement to outweigh the noise.
const int BATT_TREND_SLOTS = 30;                       // one sample a minute
const unsigned long BATT_TREND_INTERVAL_MS = 60000UL;  // -> a 30 minute window
const unsigned long BATT_TREND_MIN_SPAN_MS = 1200000UL;  // 20 min before reporting
const int BATT_TREND_MIN_DROP_MV = 25;                 // clear of the ADC's own noise
const int BATT_TREND_MIN_PCT_PER_H_X10 = 2;            // 0.2%/h; flatter reads as unknown

int battTrendMv[BATT_TREND_SLOTS];
unsigned long battTrendAt[BATT_TREND_SLOTS];
int battTrendCount = 0;   // slots filled
int battTrendHead = 0;    // next slot to write
unsigned long battTrendLast = 0;

void battTrendReset() {
  battTrendCount = 0;
  battTrendHead = 0;
  battTrendLast = 0;
}

BattState batteryState() {
  if (!batteryPresent()) return BATT_NONE;
  // While the TP4054 is charging, BAT_ADC reads the charge voltage, which
  // settles at ~4.2V as the cell fills.
  if (usbLinkActive()) return batteryMv >= 4180 ? BATT_FULL : BATT_CHARGING;
  return BATT_DISCHARGING;
}
// Called from the 1s battery tick. Only accumulates while actually on battery:
// a window that spanned a charge would average the wrong sign.
void battTrendSample() {
  if (batteryState() != BATT_DISCHARGING) { battTrendReset(); return; }
  unsigned long now = millis();
  if (battTrendLast != 0 && now - battTrendLast < BATT_TREND_INTERVAL_MS) return;
  if (battTrendCount > 0) {
    int prev = battTrendMv[(battTrendHead + BATT_TREND_SLOTS - 1) % BATT_TREND_SLOTS];
    // A real rise means the cell gained charge (a data-less wall charger reads as
    // DISCHARGING here - there is no VBUS-sense pin), and averaging across that
    // would understate the drain. 40mV is well past sag and noise.
    if (batteryMv > prev + 40) battTrendReset();
  }
  battTrendLast = now;
  battTrendMv[battTrendHead] = batteryMv;
  battTrendAt[battTrendHead] = now;
  battTrendHead = (battTrendHead + 1) % BATT_TREND_SLOTS;
  if (battTrendCount < BATT_TREND_SLOTS) battTrendCount++;
}

int battTrendSpanMin() {
  if (battTrendCount < 2) return 0;
  int oldest = (battTrendHead + BATT_TREND_SLOTS - battTrendCount) % BATT_TREND_SLOTS;
  int newest = (battTrendHead + BATT_TREND_SLOTS - 1) % BATT_TREND_SLOTS;
  return (int) ((battTrendAt[newest] - battTrendAt[oldest]) / 60000UL);
}

// Discharge rate in %/h x10, or -1 while it cannot honestly be stated.
//
// A NON-NEGATIVE SLOPE IS NOT "BATTERY FOREVER", IT IS UNKNOWN. When the
// backlight blanks after 30s idle the load drops and the cell voltage REBOUNDS,
// so a rising reading is the normal consequence of the screen going off, not
// evidence of charging. For the same reason the window deliberately does NOT
// reset when the backlight changes: spanning both blanked and lit periods is
// what makes the average reflect how the device is actually being used.
int battPctPerHourX10() {
  if (battTrendCount < 3) return -1;
  int oldest = (battTrendHead + BATT_TREND_SLOTS - battTrendCount) % BATT_TREND_SLOTS;
  int newest = (battTrendHead + BATT_TREND_SLOTS - 1) % BATT_TREND_SLOTS;
  if (battTrendAt[newest] - battTrendAt[oldest] < BATT_TREND_MIN_SPAN_MS) return -1;
  if (battTrendMv[oldest] - battTrendMv[newest] < BATT_TREND_MIN_DROP_MV) return -1;
  // Least squares over the whole window, not endpoint-to-endpoint: one sample
  // taken while the backlight was on sits several mV below its neighbours, which
  // is more movement than the trend itself makes over 20 minutes.
  double n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (int i = 0; i < battTrendCount; i++) {
    int idx = (oldest + i) % BATT_TREND_SLOTS;
    double x = (double) (battTrendAt[idx] - battTrendAt[oldest]) / 3600000.0;  // hours
    double y = (double) pctFromMv(battTrendMv[idx]);
    n++; sx += x; sy += y; sxy += x * y; sxx += x * x;
  }
  double denom = n * sxx - sx * sx;
  if (denom <= 0) return -1;
  double slope = (n * sxy - sx * sy) / denom;   // %/h, negative while draining
  int rate = (int) (-slope * 10 + 0.5);
  return rate < BATT_TREND_MIN_PCT_PER_H_X10 ? -1 : rate;
}

// Minutes of runtime left at the recent rate, or -1 when not yet measurable.
int battMinutesLeft() {
  int rate = battPctPerHourX10();
  if (rate < 0) return -1;
  int pct = batteryPct();
  if (pct <= 0) return 0;
  long mins = (long) pct * 600L / rate;
  // Clamped because this is a display, not a claim: at the 0.2%/h floor the
  // arithmetic reaches hundreds of hours, which would read as broken.
  if (mins > 99L * 60L) mins = 99L * 60L;
  return (int) mins;
}

// ---------------------------------------------------------------------------
// POWERPROBE: a passive, labelled discharge measurement in mV/h.
//
// It exists so a proposed battery saving can be RANKED rather than argued
// about. It measures whatever state the device is already in and reports a
// rate against a label you supply, so an A/B is "set it up, probe, change one
// thing, probe again" - and it composes with changes that do not exist yet,
// including a different build.
//
// THREE THINGS ARE DELIBERATE AND NONE IS A STYLE CHOICE:
//
//  - IT TAKES ITS OWN RAW ADC READS instead of reusing the trend ring above.
//    That ring stores one snapshot a minute of batteryMv, which is an EMA of 8
//    - and averaging a signal that has ALREADY been low-passed does not buy the
//    sqrt(N) that averaging independent samples does, because consecutive
//    values are correlated. Reading the ADC directly is what makes the noise
//    fall with the sample count. It also keeps the probe from reshaping the
//    estimator that draws the "~5h" label, which would be an instrument
//    perturbing the thing it measures.
//
//  - IT REPORTS mV/h, NOT %/h. Millivolts per hour is the raw datum; percent
//    routes through pctFromMv's curve, which is a MODEL of a cell we did not
//    characterise. Comparing two builds in %/h would attribute that curve's
//    shape to the hardware. (Same reason the sleep report prints mV/h.)
//
//  - IT STATES ITS OWN CONFIDENCE rather than inheriting the estimator's fixed
//    20-minute / 25mV gate. It fits a line and computes the STANDARD ERROR of
//    the slope, and says nothing until |slope|/SE clears POWERPROBE_MIN_SNR_X10.
//    That self-shortens when the drain is large - which is exactly the case
//    worth measuring - and stays silent when the fall really is noise. A fixed
//    span cannot do both.
//
// It can only run ON BATTERY: batteryState() reads DISCHARGING only while
// usbLinkActive() is false, so the cable must be out and the report goes back
// over BLE. That is a property of the measurement, not a limitation to work
// around - a probe that "worked" on USB would be measuring the charger.
const unsigned long POWERPROBE_BUCKET_MS = 60000UL;  // one bucket a minute
const int POWERPROBE_MAX_BUCKETS = 60;               // ring: one hour
const int POWERPROBE_MIN_BUCKETS = 5;                // n-2 dof needs elbow room
const int POWERPROBE_MIN_SNR_X10 = 100;              // report at |slope|/SE >= 10
const int POWERPROBE_RISE_ABORT_MV = 40;             // as the trend ring: a gain is a charge
const int POWERPROBE_READS = 16;                     // raw ADC reads per second

bool probeActive = false;
char probeLabel[24] = {0};
float probeBucketMv[POWERPROBE_MAX_BUCKETS];
unsigned long probeBucketAt[POWERPROBE_MAX_BUCKETS];
int probeBucketCount = 0;
unsigned long probeBucketStart = 0;
double probeSum = 0;          // raw mV accumulated in the open bucket
long probeSamples = 0;
int probeFirstMv = 0;

// Fit the closed buckets. Returns false while there is nothing honest to say;
// on true, slope is mV/h (negative while draining) and se is its standard error.
bool powerProbeFit(double* slopeOut, double* seOut) {
  int n = probeBucketCount;
  if (n < POWERPROBE_MIN_BUCKETS || n < 3) return false;
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (int i = 0; i < n; i++) {
    double x = (double) (probeBucketAt[i] - probeBucketAt[0]) / 3600000.0;  // hours
    double y = (double) probeBucketMv[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  double den = (double) n * sxx - sx * sx;
  if (den <= 0) return false;
  double slope = ((double) n * sxy - sx * sy) / den;
  double icept = (sy - slope * sx) / n;
  double sse = 0;
  for (int i = 0; i < n; i++) {
    double x = (double) (probeBucketAt[i] - probeBucketAt[0]) / 3600000.0;
    double r = (double) probeBucketMv[i] - (icept + slope * x);
    sse += r * r;
  }
  double cxx = sxx - sx * sx / n;   // centred Sxx
  if (cxx <= 0) return false;
  *slopeOut = slope;
  *seOut = sqrt(sse / (n - 2) / cxx);
  return true;
}

// One line per closed bucket, so a run is watchable rather than a silent wait -
// and so a probe abandoned early still leaves its partial evidence in the log.
void powerProbeReport(const char* why) {
  char line[160];
  double slope = 0, se = 0;
  int spanMin = probeBucketCount < 2 ? 0
      : (int) ((probeBucketAt[probeBucketCount - 1] - probeBucketAt[0]) / 60000UL);
  if (!powerProbeFit(&slope, &se)) {
    snprintf(line, sizeof(line), "POWERPROBE %s %s: measuring (span %dm, n=%d)",
             probeLabel, why, spanMin, probeBucketCount);
  } else if (slope >= 0) {
    snprintf(line, sizeof(line),
             "POWERPROBE %s %s: NOT DRAINING (+%.1f mV/h, span %dm, n=%d)",
             probeLabel, why, slope, spanMin, probeBucketCount);
  } else if (se > 0 && (-slope / se) < POWERPROBE_MIN_SNR_X10 / 10.0) {
    // Named rather than hidden: "not yet significant" is a RESULT, and the
    // numbers behind it are what tell you whether to keep waiting.
    snprintf(line, sizeof(line),
             "POWERPROBE %s %s: not yet significant (%.1f +/- %.1f mV/h, "
             "SNR %.1f, span %dm, n=%d)",
             probeLabel, why, slope, se, se > 0 ? -slope / se : 0.0,
             spanMin, probeBucketCount);
  } else {
    snprintf(line, sizeof(line),
             "POWERPROBE %s %s: %.1f +/- %.1f mV/h (span %dm, n=%d)",
             probeLabel, why, slope, se, spanMin, probeBucketCount);
  }
  sendLineToHost(line);
}

void powerProbeStop(const char* why) {
  if (!probeActive) return;
  powerProbeReport(why);
  probeActive = false;
}

void powerProbeStart(const char* label) {
  char line[128];
  if (batteryState() != BATT_DISCHARGING) {
    // Naming the cause, because "no output" and "impossible here" look identical
    // from the Mac - and on USB this is impossible by construction.
    snprintf(line, sizeof(line),
             "POWERPROBE refused: not on battery (unplug USB; state=%d mv=%d)",
             (int) batteryState(), batteryMv);
    sendLineToHost(line);
    return;
  }
  const char* want = label && *label ? label : "unlabelled";
  if (probeActive && strcmp(probeLabel, want) == 0) {
    // RE-ISSUING THE SAME LABEL REPORTS PROGRESS, IT DOES NOT RESTART. Checking
    // on a running probe by re-sending the command is the obvious thing to do,
    // and a restart would silently discard the minutes already collected -
    // leaving a measurement that reads as merely slow rather than as thrown
    // away. It also makes the probe immune to the host delivering one command
    // over BOTH transports, which is what every other command already gets.
    powerProbeReport("progress");
    return;
  }
  if (probeActive) powerProbeStop("superseded");
  snprintf(probeLabel, sizeof(probeLabel), "%s", want);
  probeBucketCount = 0;
  probeBucketStart = millis();
  probeSum = 0;
  probeSamples = 0;
  probeFirstMv = batteryMv;
  probeActive = true;
  snprintf(line, sizeof(line),
           "POWERPROBE %s: started at %dmV, one bucket per %lus, reporting from %d buckets",
           probeLabel, batteryMv, POWERPROBE_BUCKET_MS / 1000UL, POWERPROBE_MIN_BUCKETS);
  sendLineToHost(line);
}

// Called from the same 1s battery tick that drives sampleBattery(). Reads the
// ADC itself - see the note above on why it does not reuse batteryMv.
void powerProbeTick() {
  if (!probeActive) return;
  if (batteryState() != BATT_DISCHARGING) { powerProbeStop("aborted: charger attached"); return; }
  if (probeFirstMv > 0 && batteryMv > probeFirstMv + POWERPROBE_RISE_ABORT_MV) {
    powerProbeStop("aborted: cell gained charge");
    return;
  }
  for (int i = 0; i < POWERPROBE_READS; i++)
    probeSum += (double) analogReadMilliVolts(BAT_ADC_PIN) * BOARD_BAT_MV_SCALE;
  probeSamples += POWERPROBE_READS;

  unsigned long now = millis();
  if (now - probeBucketStart < POWERPROBE_BUCKET_MS) return;
  if (probeSamples <= 0) return;
  if (probeBucketCount == POWERPROBE_MAX_BUCKETS) {
    // Slide: the newest hour is the interesting one, and a probe left running
    // must not start reporting a rate averaged over a state that has ended.
    for (int i = 1; i < POWERPROBE_MAX_BUCKETS; i++) {
      probeBucketMv[i - 1] = probeBucketMv[i];
      probeBucketAt[i - 1] = probeBucketAt[i];
    }
    probeBucketCount--;
  }
  probeBucketMv[probeBucketCount] = (float) (probeSum / (double) probeSamples);
  probeBucketAt[probeBucketCount] = now;
  probeBucketCount++;
  probeBucketStart = now;
  probeSum = 0;
  probeSamples = 0;
  powerProbeReport("tick");
}

// "~5h" / "~95m", or empty when unknown - compact because it shares a row with
// the percentage and the voltage.
void battLeftLabel(char* out, size_t n, int mins) {
  if (mins < 0) { out[0] = '\0'; return; }
  if (mins < 120) snprintf(out, n, "~%dm", mins);
  else snprintf(out, n, "~%dh", (mins + 30) / 60);
}

void loadBeepEnabled() { beepEnabled = prefs.getBool("beepOn", true); }
void saveBeepEnabled() { prefs.putBool("beepOn", beepEnabled); }
// beepDuty holds the chosen preset on both boards; what it MEANS differs. On
// board 1 it is an LEDC duty consumed at each tone step, so storing it is the
// whole job. On board 2 it is an ES8311 volume that has to be written to the
// codec, because the sample buffer's amplitude is fixed - loudness lives in the
// codec, not in the samples. Pushed here rather than at each beep so the VOLUME
// stepper's own confirmation beep is already at the new level.
void applyVolume() {
  beepDuty = VOL_PRESETS[volPresetIdx];
#if BOARD_HAS_BEEPER && !BOARD_USES_TFT_ESPI
  if (audioOutReady) es8311_voice_volume_set(audioCodec, beepDuty, NULL);
#endif
}
void loadVolume() {
  volPresetIdx = constrain(prefs.getInt("vol", 1), 0, VOL_PRESETS_COUNT - 1);
  applyVolume();
}
void saveVolume() { prefs.putInt("vol", volPresetIdx); }
// The needs-input double-beep, in THREE variants behind one signature: board 1's
// LEDC square wave, board 2's I2S samples, and a no-op stub for a board with
// BOARD_HAS_BEEPER 0. Every caller - the SOUND toggle, the volume stepper, the
// asking-transition diff - is identical on all three, so nothing in the UI or the
// diff logic has to learn whether a board can make a sound.
//
// The split is on BOARD_USES_TFT_ESPI rather than a beeper-kind flag because it
// is the same question: board 1 has AUDIO_OUT_PIN and an analogue amp, board 2
// has an ES8311, and an LEDC square wave is not a thing you can send a codec.
// Giving AUDIO_OUT_PIN an alias pointing at an I2S data line would compile and
// lie, which is why board 2's header still declares no such pin.
#if BOARD_HAS_BEEPER && BOARD_USES_TFT_ESPI
void startBeep() {
  if (!beepEnabled) return;
  if (beepStep >= 0) return; // pattern already playing
  beepStep = 0;
  beepStepStart = millis();
  digitalWrite(AUDIO_EN_PIN, LOW); // amp on
  ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
}
void updateBeep() {
  if (beepStep < 0) return;
  if (millis() - beepStepStart < BEEP_PATTERN_MS[beepStep]) return;
  beepStep++;
  beepStepStart = millis();
  if (beepStep >= BEEP_STEPS) {
    beepStep = -1;
    ledcWrite(AUDIO_OUT_PIN, 0);
    digitalWrite(AUDIO_EN_PIN, HIGH); // amp back off
    return;
  }
  ledcWrite(AUDIO_OUT_PIN, beepStep % 2 == 1 ? 0 : beepDuty);
}
#elif BOARD_HAS_BEEPER
// BOARD 2. Same pattern, same state variables, same non-blocking contract - but
// a beep here is SAMPLES pushed into an I2S DMA rather than a duty written to a
// hardware square-wave generator, and that changes what "keep the tone going"
// costs. LEDC needs one write per step and then runs by itself; this has to be
// fed.
//
// THE OCCUPANCY MODEL IS THE WHOLE TRICK. I2SClass::write() blocks once the DMA
// is full and the class exposes no availableForWrite(), so feeding blindly would
// stall loop() for up to the buffer depth - 90ms - which is exactly the kind of
// pause this codebase's redraw discipline exists to avoid. Instead the queue
// depth is TRACKED: beepFedUntil is the millis() timestamp audio has been queued
// up to, and a chunk is only written while that is less than BEEP_QUEUE_MAX_MS
// ahead of now. Every write therefore lands in free space and returns at once.
//
// The gap step needs no writes at all: ESP_I2S configures the channel with
// auto_clear = true, so an underrun emits silence rather than repeating the last
// buffer. That is why the pattern's {120, 90, 120} works with tone steps fed and
// the gap simply not fed.
static unsigned long beepFedUntil = 0;

// Even steps are tone, odd are silence - the same convention board 1's
// `beepStep % 2` uses, kept identical so the shared BEEP_PATTERN_MS means the
// same thing on both boards.
static inline bool beepStepIsTone(int step) { return step % 2 == 0; }

void startBeep() {
  if (!beepEnabled) return;
  if (beepStep >= 0) return; // pattern already playing
  if (!audioOutReady) return; // codec never came up; stay silent, never crash
  beepStep = 0;
  beepStepStart = millis();
  beepFedUntil = beepStepStart;
  // Unmuting is the "amp on" of this board. The amp itself cannot be gated.
  es8311_voice_mute(audioCodec, false);
  updateBeep();               // prime the DMA now rather than a loop() later
}

void updateBeep() {
  if (beepStep < 0) return;
  const unsigned long now = millis();

  // Advance the pattern first, so a step boundary is never fed with the previous
  // step's material.
  if (now - beepStepStart >= BEEP_PATTERN_MS[beepStep]) {
    beepStep++;
    beepStepStart = now;
    if (beepStep >= BEEP_STEPS) {
      beepStep = -1;
      es8311_voice_mute(audioCodec, true);
      // Deliberately NOT waiting for the DMA to drain: what is still queued is
      // at most BEEP_QUEUE_MAX_MS of tone, and the mute lands on the codec's
      // analogue side, so it silences that tail rather than letting it play out
      // after the pattern is over.
      return;
    }
  }

  if (!beepStepIsTone(beepStep)) return;   // auto_clear gives the gap for free
  // Catch up to the queue ceiling. A loop() iteration that ran long can leave
  // more than one chunk owed, and writing only one per call would let the tone
  // underrun into a gap it never asked for.
  while ((long) (beepFedUntil - now) < (long) BEEP_QUEUE_MAX_MS) {
    audioFeedBeepChunk();
    beepFedUntil += BEEP_TONE_FRAMES * 1000UL / TONE_SAMPLE_HZ;
  }
}
#else
void startBeep() {}
void updateBeep() {}
#endif
// The actual teardown into deep sleep, shared by the manual power-off (BOOT
// hold) and the automatic battery-idle sleep. Assumes a farewell has already
// been drawn (or not) by the caller.
void enterDeepSleep() {
  tft.writecommand(0x28); // DISPOFF
  tft.writecommand(0x10); // SLPIN
  delay(120);             // ILI9341 datasheet minimum after SLPIN

  // GPIOs float in deep sleep; latch the backlight pin low so the panel
  // doesn't glow dimly off a floating gate.
  ledcDetach(TFT_BL_PIN);
  pinMode(TFT_BL_PIN, OUTPUT);
  digitalWrite(TFT_BL_PIN, LOW);
  gpio_hold_en((gpio_num_t) TFT_BL_PIN);
  gpio_deep_sleep_hold_en();

  // Record what we are sleeping AT, so the next real wake can report the drain.
  // RTC memory survives deep sleep and esp_timer keeps counting through it.
  sampleBattery();
  rtcSleepMv = batteryMv;
  timeval tv; gettimeofday(&tv, nullptr);
  rtcSleepUs = (int64_t) tv.tv_sec * 1000000 + tv.tv_usec;

#if BOARD_HAS_TOUCH_SLEEP_WAKE
  esp_sleep_enable_ext0_wakeup((gpio_num_t) BOARD_SLEEP_WAKE_GPIO, 0); // PENIRQ: low = touched
#else
  // NO WAKE SOURCE IS ARMED, and that is deliberate rather than unfinished - see
  // BOARD_HAS_TOUCH_SLEEP_WAKE in this board's header for the header-verified
  // reason (ext0/ext1 wake only from an RTC GPIO, this chip's RTC set is
  // GPIO0..21, and the touch INT is on 47). Arming ext0/ext1 on it anyway would
  // return ESP_ERR_INVALID_ARG into a value nobody reads and leave the device
  // asleep with a farewell screen that had promised a touch would work.
  // Everything ABOVE this point still runs, with one board-2 caveat worth
  // knowing: the backlight pad really does stay latched low - which is ~93% of
  // the draw - but the two writecommand() calls above are no-ops on that panel,
  // so its controller is NOT put into DISPOFF/SLPIN. See PanelShim::writecommand
  // in panel_shim.cpp for what the driver does and does not expose.
  Serial.println("POWER: no touch wake on this board - press RESET to wake");
#endif

#if !BOARD_USES_TFT_ESPI
  // BELT AND BRACES, and no longer the thing it was written for. Both callers
  // now flush BEFORE their dwell - they have to, or the delay displays the
  // previous screen - so by the time control reaches here the dirty rect is
  // already empty and flush() early-returns. It is also downstream of
  // digitalWrite(TFT_BL_PIN, LOW) and gpio_hold_en, so it could never have
  // delivered a farewell to a panel that is already dark.
  // Kept anyway because esp_deep_sleep_start() genuinely never returns, so this
  // is the last opportunity for ANY future draw added between a caller's flush
  // and this line - and the cost of an empty flush is one comparison.
  tft.flush();
#endif
  esp_deep_sleep_start();
}
void powerOff() {
  Serial.println("POWER: shutting down (deep sleep, touch to wake)");

  tft.fillScreen(COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("Powering off", tft.width() / 2, tft.height() / 2 - 12);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  // The instruction has to match what the chip can actually do. A board that
  // cannot wake on touch must not say "touch screen to wake": that reads as
  // broken firmware, where "press RESET to wake" reads as a device that told you
  // the truth. Same rule the standalone screen follows about never claiming USB.
  tft.drawString(WAKE_HINT, tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);

#if BOARD_HAS_BEEPER && BOARD_USES_TFT_ESPI
  if (beepEnabled) { // single short blip as tactile confirmation
    digitalWrite(AUDIO_EN_PIN, LOW);
    ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
    delay(90);
    ledcWrite(AUDIO_OUT_PIN, 0);
    digitalWrite(AUDIO_EN_PIN, HIGH);
  }
#elif BOARD_HAS_BEEPER
  // The same farewell blip, and this one is allowed to BLOCK where updateBeep()
  // may not: the device is on its way into deep sleep, so there is no loop() left
  // to be responsive for. Feeding the DMA and then waiting is therefore simpler
  // and more honest than driving the state machine for one 90ms tone - and the
  // wait has to be slightly longer than the audio, because write() returns when
  // the DMA has ACCEPTED the bytes, not when the codec has clocked them out.
  // Muting before they finish playing would cut the blip off mid-note.
  if (beepEnabled && audioOutReady) {
    es8311_voice_mute(audioCodec, false);
    const int chunks = 90 / (BEEP_TONE_FRAMES * 1000 / TONE_SAMPLE_HZ);
    for (int i = 0; i < chunks; i++) audioFeedBeepChunk();
    delay(90 + 40);
    es8311_voice_mute(audioCodec, true);
  }
#endif
#if !BOARD_USES_TFT_ESPI
  // FLUSH BEFORE THE DWELL, not after. Board 2 draws into a shadow buffer, so
  // without this the 1200ms "let the message be read" is spent displaying the
  // PREVIOUS screen and the farewell appears for zero frames - the message
  // exists in memory and is never seen. Board 1 writes the panel directly and
  // needs nothing here.
  tft.flush();
#endif
  delay(1200); // let the message be read; we're leaving, blocking is fine
  enterDeepSleep();
}
// Auto-sleep to save the battery when the device has been idle. No beep (the
// user isn't there), and the backlight is forced back on just long enough to
// show why - in case someone glances over as it goes dark.
void autoDeepSleep() {
  Serial.println("POWER: auto deep sleep (on battery, idle 20 min)");
  isAsleep = false;
  ledcWrite(TFT_BL_PIN, brightnessPct * 255 / 100);
  tft.fillScreen(COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("Sleeping to save battery", tft.width() / 2, tft.height() / 2 - 12);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString(WAKE_HINT, tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);
#if !BOARD_USES_TFT_ESPI
  tft.flush();   // same reason as powerOff()'s: the dwell must show THIS screen
#endif
  delay(1500);
  enterDeepSleep();
}
void checkPowerButton() {
  static unsigned long pressStart = 0;
  static bool seenHigh = false;

  if (millis() < BOOT_BTN_ARM_MS) { // still in the strap's settling window
    pressStart = 0;
    return;
  }
  const bool down = digitalRead(BOOT_BTN_PIN) == LOW;
  if (!down) seenHigh = true;
  if (!seenHigh) return; // never released since boot - not a real press

  if (down) {
    if (pressStart == 0) pressStart = millis();
    else if (millis() - pressStart >= POWER_OFF_HOLD_MS) powerOff();
  } else {
    pressStart = 0;
  }
}
