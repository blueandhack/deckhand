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
void enterSleep() {
  isAsleep = true;
  ledcWrite(TFT_BL_PIN, 0);
}
void wakeUp() {
  isAsleep = false;
  lastActivityMillis = millis();
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

// "~5h" / "~95m", or empty when unknown - compact because it shares a row with
// the percentage and the voltage.
void battLeftLabel(char* out, size_t n, int mins) {
  if (mins < 0) { out[0] = '\0'; return; }
  if (mins < 120) snprintf(out, n, "~%dm", mins);
  else snprintf(out, n, "~%dh", (mins + 30) / 60);
}

void loadBeepEnabled() { beepEnabled = prefs.getBool("beepOn", true); }
void saveBeepEnabled() { prefs.putBool("beepOn", beepEnabled); }
void applyVolume() { beepDuty = VOL_PRESETS[volPresetIdx]; }
void loadVolume() {
  volPresetIdx = constrain(prefs.getInt("vol", 1), 0, VOL_PRESETS_COUNT - 1);
  applyVolume();
}
void saveVolume() { prefs.putInt("vol", volPresetIdx); }
// The needs-input double-beep. BOARD_HAS_BEEPER 0 makes both of these no-ops
// rather than deleting their callers: the SOUND toggle, the volume stepper and
// the asking-transition diff all stay exactly where they are, so nothing about
// the UI or the diff logic has to learn that a board is mute. A stub here is
// also the honest shape of the gap - board 2 HAS a speaker, but it is behind an
// I2S codec, and an LEDC square wave is not a thing you can send one. Giving
// AUDIO_OUT_PIN an alias pointing at an I2S data line would compile and lie.
#if BOARD_HAS_BEEPER
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
  // The point of no return: esp_deep_sleep_start() never returns, so the
  // end-of-loop() flush that would normally push whatever powerOff() or
  // autoDeepSleep() just drew (the farewell message) NEVER RUNS. Without
  // this, the caller's fillScreen()+drawString() sit in the shadow
  // framebuffer forever and the panel goes dark showing whatever was on
  // screen before - not the farewell it just spent a delay() showing "for".
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

#if BOARD_HAS_BEEPER
  if (beepEnabled) { // single short blip as tactile confirmation
    digitalWrite(AUDIO_EN_PIN, LOW);
    ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
    delay(90);
    ledcWrite(AUDIO_OUT_PIN, 0);
    digitalWrite(AUDIO_EN_PIN, HIGH);
  }
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
