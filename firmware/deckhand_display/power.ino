// Power: backlight, battery, beeper, volume, sleep and deep sleep.
// Split out of deckhand_display.ino. The Arduino build concatenates every .ino
// in this folder into ONE translation unit - main file first (it matches the
// folder name), then the rest alphabetically - so these still share every global
// and there are no headers. Verified before splitting: no function signature in
// this sketch names a type declared after the first function definition, which
// is what would break the auto-generated prototypes.

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
  int mv = (int)(sum / 4) * 2; // 100K/100K divider halves VBAT
  batteryMv = batteryMv < 0 ? mv : (batteryMv * 7 + mv) / 8;
}
// Below this there's clearly no cell attached (R3 pulls the pin to ground).
bool batteryPresent() { return batteryMv > 2500; }
// Resting-voltage discharge curve for a 1S LiPo. Coarse on purpose: without
// a coulomb counter this is an estimate, and load sag makes it read a few
// percent low while the backlight is bright - fine for a desk gadget.
int batteryPct() {
  static const int mvT[] = {3300, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200};
  static const int pcT[] = {0, 8, 15, 28, 45, 62, 78, 90, 100};
  const int n = 9;
  if (batteryMv <= mvT[0]) return 0;
  if (batteryMv >= mvT[n - 1]) return 100;
  for (int i = 1; i < n; i++) {
    if (batteryMv < mvT[i]) {
      return pcT[i - 1] + (pcT[i] - pcT[i - 1]) * (batteryMv - mvT[i - 1]) / (mvT[i] - mvT[i - 1]);
    }
  }
  return 100;
}
BattState batteryState() {
  if (!batteryPresent()) return BATT_NONE;
  // While the TP4054 is charging, BAT_ADC reads the charge voltage, which
  // settles at ~4.2V as the cell fills.
  if (usbLinkActive()) return batteryMv >= 4180 ? BATT_FULL : BATT_CHARGING;
  return BATT_DISCHARGING;
}
void loadBeepEnabled() { beepEnabled = prefs.getBool("beepOn", true); }
void saveBeepEnabled() { prefs.putBool("beepOn", beepEnabled); }
void applyVolume() { beepDuty = VOL_PRESETS[volPresetIdx]; }
void loadVolume() {
  volPresetIdx = constrain(prefs.getInt("vol", 1), 0, VOL_PRESETS_COUNT - 1);
  applyVolume();
}
void saveVolume() { prefs.putInt("vol", volPresetIdx); }
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
  rtcSleepUs = esp_timer_get_time();

  esp_sleep_enable_ext0_wakeup(GPIO_NUM_36, 0); // PENIRQ: low = touched
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
  tft.drawString("touch screen to wake", tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);

  if (beepEnabled) { // single short blip as tactile confirmation
    digitalWrite(AUDIO_EN_PIN, LOW);
    ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
    delay(90);
    ledcWrite(AUDIO_OUT_PIN, 0);
    digitalWrite(AUDIO_EN_PIN, HIGH);
  }
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
  tft.drawString("touch screen to wake", tft.width() / 2, tft.height() / 2 + 12);
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
