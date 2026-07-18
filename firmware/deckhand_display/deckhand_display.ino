// Deckhand: ELEGOO 2.8" ESP32-32E touchscreen display for Claude Code.
// Tab 1 (USAGE): plan usage (5h session / 7d weekly), same as before.
// Tab 2 (SESSIONS): which Claude Code projects are currently running, and
// whether each is working or waiting on you, from ../host/index.mjs.
//
// Board: ELEGOO E32R28T/E32N28T, ILI9341 240x320. TFT is on TFT_eSPI's
// default VSPI bus (configured in the library's User_Setup.h). The
// resistive touch controller (XPT2046) is wired to DIFFERENT pins on a
// separate SPI bus (see LCDWIKI pin table), so it needs its own SPIClass
// instance and the standalone XPT2046_Touchscreen library rather than
// TFT_eSPI's built-in touch support.
//
// Rendering strategy: every field is only redrawn when its value actually
// changes, to avoid the flicker that comes from clearing-then-redrawing
// large areas every tick.

#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <XPT2046_Touchscreen.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_sleep.h>
#include <mbedtls/md.h>
#include <driver/gpio.h>

// Nordic UART Service - a de facto standard GATT service for serial-like
// data over BLE. Classic Bluetooth SPP (BluetoothSerial) was tried first and
// replaced: macOS's classic-BT stack turned out to silently accept writes
// into a dead connection with no real over-the-air session (confirmed via a
// heartbeat that never arrived), and that state recurred even after a full
// unpair/restart/re-pair. BLE is far more actively maintained on macOS since
// it's what nearly all modern accessories use, unlike the legacy SPP profile.
#define BLE_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHAR_RX_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHAR_TX_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// If the layout renders sideways/upside down on your unit, try 0/1/2/3 here.
#define SCREEN_ROTATION 0
// Flip this (and re-run calibration, see runCalibration) if touches feel
// transposed - e.g. moving your finger left/right moves the cursor up/down.
#define TOUCH_SWAP_XY true

#define TFT_BL_PIN 21

// BAT+ -> 100K/100K divider -> IO34 ("Battery level detection circuit" in
// the LCDWIKI E32R28T user manual), so VBAT = 2x the pin voltage. IO34 is
// ADC1, which stays usable while WiFi/BT is active (ADC2 does not).
#define BAT_ADC_PIN 34

// Onboard FM8002E 1W amplifier -> JP1 speaker terminals. IO26 is the
// amplifier's audio input (AUDIO_IN net); IO4 is its shutdown pin
// (AUDIO_EN net, 10K pulled high = amp muted; drive LOW to enable). Keeping
// the amp disabled except while actually beeping avoids idle hiss.
#define AUDIO_OUT_PIN 26
#define AUDIO_EN_PIN 4

// The BOOT key (10K pulled high, pressed = low). Only a strapping pin at
// reset; at runtime it's an ordinary button. Held for POWER_OFF_HOLD_MS it
// powers the device down (deep sleep - see powerOff()).
#define BOOT_BTN_PIN 0

// Touch controller pins, from the LCDWIKI E32R28T/E32N28T pin table -
// these are independent of the TFT's SPI pins.
#define TOUCH_SCK  25
#define TOUCH_MOSI 32
#define TOUCH_MISO 39
#define TOUCH_CS   33
#define TOUCH_IRQ  36

TFT_eSPI tft = TFT_eSPI();
SPIClass touchSPI(HSPI);
XPT2046_Touchscreen ts(TOUCH_CS, TOUCH_IRQ);
Preferences prefs;

// Either USB serial or this BLE link can drive the display - whichever the
// host script actually has open. Unlike the USB path (a plain polled
// Stream), BLE writes arrive via the onWrite() callback below, not loop().
BLEServer* bleServer = nullptr;
BLECharacteristic* bleTxChar = nullptr;
bool bleConnected = false;
String serialBufBLE;
unsigned long lastRxBLEMillis = 0;
// Hand-off from the Bluetooth stack's task to loopTask. The BLE onWrite
// callback runs on BTC_TASK, and processing lines there (TFT drawing, LEDC
// beeps) crashed the scheduler: "assert failed: xTaskPriorityDisinherit"
// (a mutex locked on loopTask released from BTC_TASK) plus task_wdt IDLE0
// timeouts when rendering hogged the Bluetooth task. onWrite now only
// copies bytes into this stream buffer (single producer / single consumer,
// safe by design); loop() drains it and does all the real work.
StreamBufferHandle_t bleRxStream = nullptr;

// Declared early: the Arduino build system auto-generates function
// prototypes and inserts them before these types would otherwise be defined,
// which breaks compilation for any function taking/returning them. (Keep
// these enums above the first function definition in the file.)
enum Tab { TAB_USAGE = 0, TAB_SESSIONS = 1, TAB_SETTINGS = 2 };
Tab currentTab = TAB_USAGE;
enum BattState { BATT_NONE = 0, BATT_DISCHARGING = 1, BATT_CHARGING = 2, BATT_FULL = 3 };

// ---------- Remote-answer authentication ----------
// Only the paired Mac may approve prompts from the device. The host and
// device share a secret, PROVISIONed once over the trusted USB link (never
// over BLE), stored in NVS here. Every ANSWER carries an HMAC over a
// host-issued per-prompt nonce, so an impersonator advertising the same name
// but lacking the secret cannot forge an approval, and answers can't be
// replayed. The BLE link itself stays unencrypted - this protects the
// decision, not the confidentiality of the display data.
String pairingSecret = "";           // hex string, "" = not yet provisioned
bool deviceNameReported = false;     // sent our BLE name to the host over USB yet?
// Advertised name is unique per board (Deckhand-XXXX from the MAC) so many
// units in one room don't collide; set in setupBLE from the real MAC.
char deviceName[20] = "Deckhand";
String btMacAddress; // set once in setupBLE(), shown on the STATUS page

// HMAC-SHA256(secret, msg), first 16 hex chars. Matches the host's
// crypto.createHmac('sha256', secret).update(msg).digest('hex').slice(0,16).
String authHmac(const String& msg) {
  if (pairingSecret.length() == 0) return String("");
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1); // 1 = HMAC mode
  mbedtls_md_hmac_starts(&ctx, (const uint8_t*) pairingSecret.c_str(), pairingSecret.length());
  mbedtls_md_hmac_update(&ctx, (const uint8_t*) msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", out[i]);
  return String(hex);
}

// ---------- Layout constants ----------
const int TAB_BAR_H = 34;
const int CONTENT_Y = TAB_BAR_H;
// Persistent footer (clock + last-updated), visible under both tabs. Content
// clearing/redraw on either tab must stop above this band, not paint over it.
const int FOOTER_H = 18;
int contentBottom() { return tft.height() - FOOTER_H; }

const uint16_t COLOR_BG = TFT_BLACK;
const uint16_t COLOR_CARD = 0x18C4;     // dark slate card fill, lifts off pure black
const uint16_t COLOR_LABEL = 0x8410;    // mid grey
const uint16_t COLOR_VALUE = TFT_WHITE;
const uint16_t COLOR_ACCENT = 0xFD20;   // Claude orange
// Colorblind-safe trio (Okabe-Ito palette: blue / orange / reddish-purple).
// A green/yellow/red traffic-light scheme is the single worst choice here -
// it collapses under red-green color vision deficiency, the most common
// type. Blue vs. orange vs. purple stays distinguishable under protanopia,
// deuteranopia, and tritanopia alike.
const uint16_t COLOR_GOOD = 0x0396;     // blue, <70% / waiting for input
const uint16_t COLOR_WARN = 0xE4E0;     // orange, 70-89% / working
const uint16_t COLOR_BAD = 0xCBD4;      // reddish-purple, >=90%
const uint16_t COLOR_UNKNOWN = 0x7BEF;  // grey, no data yet / stale

// ---------- Calibration ----------
// Two-point calibration: touch a crosshair at each of these screen
// coordinates once, and every future touch is linearly mapped from the raw
// ADC reading to screen pixels between those two points.
const int CAL_PT1_X = 30, CAL_PT1_Y = 60;
const int CAL_PT2_X = 210, CAL_PT2_Y = 270;
// A real array, not four separate globals - separate globals aren't
// guaranteed contiguous in memory, which previously corrupted this data
// when saved/loaded as a raw byte blob via Preferences.
int16_t calData[4]; // [0]=rawX1 [1]=rawY1 [2]=rawX2 [3]=rawY2
#define calRawX1 calData[0]
#define calRawY1 calData[1]
#define calRawX2 calData[2]
#define calRawY2 calData[3]
bool calValid = false;

// ---------- Backlight ----------
// PWM (LEDC), not a plain digitalWrite, so brightness is adjustable rather
// than just on/off. Stored in the "core" Preferences (NVS) namespace -
// deliberately NOT renamed with the project: it is invisible internal
// flash state, and changing it would wipe saved calibration/settings.
// touch calibration and persists across reboots.
const int BRIGHTNESS_MIN = 10; // below this the screen reads as "broken", not dim
const int BRIGHTNESS_STEP = 10;
int brightnessPct = 100;

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

// ---------- Sleep ----------
// After sleepTimeoutMs with no touch, backlight goes fully off (not just
// dim - the backlight is the dominant power draw, see the battery-life note
// in README.md) to save power. Any touch wakes it back to brightnessPct.
// This is a temporary override on top of brightnessPct, not a change to it -
// the user's chosen brightness is restored exactly on wake.
// Stepped through via the -/+ buttons on the SETUP tab's SLEEP card (clamped
// at the ends, no wrap-around); the last entry (0) means "never sleep".
// Index persists across reboots.
const unsigned long SLEEP_PRESETS_MS[] = {15000, 30000, 60000, 120000, 300000, 0};
const int SLEEP_PRESETS_COUNT = 6;
int sleepPresetIdx = 1; // default 30s
unsigned long sleepTimeoutMs = 30000;
unsigned long lastActivityMillis = 0;
bool isAsleep = false;

// Automatic full deep-sleep (not just backlight-off) to protect the battery:
// when running on battery with no fresh active session for this long, the
// device powers down (touch to wake). Never triggers while on USB power, and
// touch or any active session resets the timer. This is separate from, and
// stronger than, the SETUP "SLEEP AFTER" backlight dimming above.
const unsigned long AUTO_SLEEP_IDLE_MS = 20UL * 60 * 1000; // 20 minutes
unsigned long lastNonIdleMillis = 0;

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

void readRawTouch(int16_t& rx, int16_t& ry) {
  TS_Point p = ts.getPoint();
  if (TOUCH_SWAP_XY) {
    rx = p.y;
    ry = p.x;
  } else {
    rx = p.x;
    ry = p.y;
  }
}

// Blocks until a touch is held steady for ~200ms, then averages a few
// samples. Only used during first-boot calibration.
void waitForStableTouch(int16_t& outX, int16_t& outY) {
  while (!ts.touched()) delay(20);
  delay(150);
  long sumX = 0, sumY = 0;
  int samples = 8;
  for (int i = 0; i < samples; i++) {
    int16_t rx, ry;
    readRawTouch(rx, ry);
    sumX += rx;
    sumY += ry;
    Serial.printf("  cal sample %d: raw=(%d,%d)\n", i, rx, ry);
    delay(15);
  }
  outX = sumX / samples;
  outY = sumY / samples;
  Serial.printf("  cal point averaged: raw=(%d,%d)\n", outX, outY);
  while (ts.touched()) delay(20); // wait for release
  delay(200);
}

void drawCrosshair(int x, int y) {
  tft.drawFastHLine(x - 10, y, 21, TFT_WHITE);
  tft.drawFastVLine(x, y - 10, 21, TFT_WHITE);
}

void runCalibration() {
  tft.fillScreen(COLOR_BG);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("One-time touch calibration", 12, 16);
  tft.drawString("Touch each crosshair firmly", 12, 34);
  drawCrosshair(CAL_PT1_X, CAL_PT1_Y);
  waitForStableTouch(calRawX1, calRawY1);

  tft.fillScreen(COLOR_BG);
  tft.drawString("One more...", 12, 16);
  drawCrosshair(CAL_PT2_X, CAL_PT2_Y);
  waitForStableTouch(calRawX2, calRawY2);

  prefs.putBytes("cal3", calData, sizeof(calData));
  prefs.putBool("calValid3", true);
  calValid = true;
}

void loadOrRunCalibration() {
  prefs.begin("core", false);
  // "3" suffix: v1 stored corrupted data (see calData comment above), v2
  // was valid but used the wrong touch axis mapping, so this deliberately
  // ignores anything saved under either old name and forces a fresh run.
  calValid = prefs.getBool("calValid3", false);
  if (calValid) {
    prefs.getBytes("cal3", calData, sizeof(calData));
  } else {
    runCalibration();
  }
}

int16_t lastRawX = 0, lastRawY = 0; // for debugging via Serial

bool getTouchPoint(int& sx, int& sy) {
  if (!ts.touched()) return false;
  int16_t rx, ry;
  readRawTouch(rx, ry);
  lastRawX = rx;
  lastRawY = ry;
  sx = constrain(map(rx, calRawX1, calRawX2, CAL_PT1_X, CAL_PT2_X), 0, tft.width() - 1);
  sy = constrain(map(ry, calRawY1, calRawY2, CAL_PT1_Y, CAL_PT2_Y), 0, tft.height() - 1);
  return true;
}

// ---------- Usage state (tab 1) ----------
struct Usage {
  int fiveHourPct = -1;
  long fiveHourResetInMin = -1;
  unsigned long sessionTokens = 0;
  int sevenDayPct = -1;
  long sevenDayResetInMin = -1;
  unsigned long weekAllTokens = 0;
  unsigned long weekFableTokens = 0;
  int weekFablePct = -1; // Fable's own weekly cap, from the OAuth usage endpoint
  long quotaAgeSec = -1; // how old the quota %s really are (host-computed)
} usage;

const int CARD_X = 12, CARD_W = 216, CARD_H = 122;
const int CARD1_Y = 44, CARD2_Y = 176;
const int PAD = 14, BAR_H = 10, RADIUS = 10;

char pct1Cache[8] = "", left1Cache[24] = "", right1Cache[20] = "", fable1Cache[24] = "";
char resetAt1Cache[14] = "";
int bar1Cache = -2, border1Cache = -1;
char pct2Cache[8] = "", left2Cache[24] = "", right2Cache[20] = "", fable2Cache[24] = "";
char resetAt2Cache[14] = "";
int bar2Cache = -2, border2Cache = -1;

// Footer (persistent across both tabs).
char clockCache[12] = "";
char updatedCache[24] = "";
int battGlyphCache = -1;
char battTextCache[8] = "";

// Clock is synced from the host's local wall-clock time on every poll tick
// (see handleLine) and ticks forward locally via millis() in between, so it
// stays live-feeling without the ESP32 needing to know the timezone.
long hostSecBase = -1;
unsigned long hostSecBaseMillis = 0;

// Seconds since midnight (host's timezone), or -1 before the first sync.
long hostNowSec() {
  if (hostSecBase < 0) return -1;
  return (hostSecBase + (long)((millis() - hostSecBaseMillis) / 1000)) % 86400;
}

// ---------- Sessions state (tab 2) ----------
#define MAX_SESSIONS 6
struct SessionInfo {
  char id[16]; // first 12 chars of the session uuid - the ONLY reliable
               // cross-poll match key: two sessions on the same project
               // share a name, and matching by name once made an asking
               // session look "newly asking" every poll (endless beeping)
  char name[24];
  char status[10]; // "working" or "waiting"
  char path[52];
  char model[24];
  char branch[24];
  // When this session entered its current status (device-side millis).
  // Tracked here because the host doesn't send timestamps: carried over
  // across polls by matching the previous list by id in handleLine().
  unsigned long statusSinceMillis;
  // Needs-input alert budget: 3 beeps total per asking-event (one on the
  // transition + up to two reminders), then silence even if it stays
  // asking. Cleared the moment the session leaves "asking".
  uint8_t beepsLeft;
  unsigned long nextBeepMillis;
  // Pending question published by the session hook (permission prompt,
  // AskUserQuestion, or plan approval). Tapping an option on the detail
  // screen answers the real prompt back through host + hook.
  char askPid[12];
  char askKind[10]; // "perm" | "question" | "plan" - styles the detail text
  char askNonce[20]; // host-issued, single-use; HMAC'd into the answer
  char askTitle[28];
  char askDetail[608];
  char askOpts[4][26];
  uint8_t askOptCount;
};
SessionInfo sessions[MAX_SESSIONS];
int sessionCount = 0;
// The host sends at most MAX_SESSIONS (urgency-sorted: asking > waiting >
// working, then recency); these say what it had to leave out.
int sessionsTotal = 0;
int hiddenAskingCount = 0;

// Per-row render caches: a row only redraws when its own signature changes,
// so one session flipping status doesn't flash the whole list. The duration
// field ticks on its own cache, independent of the rest of the row.
char rowSigCache[MAX_SESSIONS][96];
char rowDurCache[MAX_SESSIONS][8];
char overflowCache[32] = "";
int rowCountCache = -1; // layout code: sessionCount*2 + overflow-strip flag

// Session detail screen (tap a row in the SESSIONS list to open it).
// Anchored by session id, not array index: the host re-sorts the list every
// tick (asking > waiting > working, then recency), so an index would start
// pointing at a different session when the order shifts. detailIndex is
// re-resolved from detailId each render.
bool showingDetail = false;
int detailIndex = -1;
char detailId[16] = "";
char detailSigCache[208] = "";
char detailDurCache[16] = "";
// Ask-screen state: which prompt (if any) was already answered from this
// device (keeps the chosen button highlighted, prevents double-sends), plus
// the full-screen reader for long detail text.
char answeredPid[12] = "";
int answeredIdx = -1;
bool askOverflow = false; // preview didn't fit; READ FULL TEXT button shown
bool readerActive = false;
int readerPage = 0;

// ---------- Shared state ----------
unsigned long lastRxMillis = 0;
bool everReceived = false;
String serialBufUSB;

// Which transport most recently delivered a line, and when - shown on the
// SETTINGS tab. bleConnected is the ESP32's own view of whether a BLE
// central is connected, which is more trustworthy than macOS's Bluetooth
// settings UI (that showed "not connected" for a supposedly-live SPP link,
// back when this used classic Bluetooth).
unsigned long lastRxUSBMillis = 0;

// No direct "is connected" signal exists for the CH340 USB link (it's a
// plain UART bridge, always electrically present) - infer it from whether a
// line has actually arrived over it recently.
bool usbLinkActive() {
  return lastRxUSBMillis > 0 && (millis() - lastRxUSBMillis) < 10000;
}

// ---------- Battery ----------
// Charging and battery/USB power switching are pure hardware on this board
// (TP4054 charger + Q3 power-path FET): USB-C present = battery charging and
// cut off from the load; USB-C absent = battery powers the module. Software
// only *observes*, via the BAT_ADC divider on IO34.
//
// There is no VBUS-sense pin, so "on USB power" is inferred from USB serial
// activity. A charger with power but no data (wall brick) therefore shows as
// "on battery" even though the hardware is happily charging - acceptable for
// this device, which lives plugged into a Mac.
int batteryMv = -1; // EMA-smoothed battery voltage; -1 until first sample

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

// ---------- Beeper ----------
// Double-beep when a session transitions into "asking" (Claude is blocked on
// the user). Triggered from handleLine on the transition only - a session
// that stays "asking" doesn't keep beeping. Non-blocking: loop() advances
// the pattern via updateBeep(), no delay() anywhere.
const int BEEP_FREQ = 2093; // C7 - small cavity speakers are loudest ~2kHz
// Square-wave duty out of 255 - the volume knob (128 = max, painful on a 1W
// amp at desk distance; single digits = soft). Set from the VOLUME stepper
// on the SETTINGS tab; presets chosen for an audible LOW..HIGH spread.
const int VOL_PRESETS[] = {6, 18, 45};
const char* VOL_LABELS[] = {"LOW", "MED", "HIGH"};
const int VOL_PRESETS_COUNT = 3;
int volPresetIdx = 1;     // default MED
int beepDuty = 18;        // = VOL_PRESETS[volPresetIdx]
// on, gap, on (milliseconds)
const unsigned long BEEP_PATTERN_MS[] = {120, 90, 120};
const int BEEP_STEPS = 3;
int beepStep = -1; // -1 = idle
unsigned long beepStepStart = 0;
bool beepEnabled = true; // SOUND toggle on the SETTINGS tab, persisted
// Gap between the reminder beeps while a session stays "asking" (3 beeps
// total per event - see SessionInfo.beepsLeft).
const unsigned long REBEEP_INTERVAL_MS = 30000;

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
  ledcWrite(AUDIO_OUT_PIN, beepDuty);
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

// ---------- Power off ----------
// "Off" is ESP32 deep sleep: CPU/radio halted, panel in sleep-in, backlight
// held low. Real power-off isn't possible without a physical switch, but
// this drops the board from ~100mA+ to a few mA. Wake is the touchscreen:
// the XPT2046's PENIRQ (IO36, RTC-capable) goes low on any touch even while
// the ESP32 sleeps, since the 3.3V rail stays up. Deliberately NOT the BOOT
// key - GPIO0 held low across the wake reset would strap the chip into the
// serial bootloader and the device would look dead until a manual reset.
const unsigned long POWER_OFF_HOLD_MS = 1000;

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

  esp_sleep_enable_ext0_wakeup(GPIO_NUM_36, 0); // PENIRQ: low = touched
  esp_deep_sleep_start();
}

void powerOff() {
  Serial.println("POWER: shutting down (deep sleep, touch to wake)");

  tft.fillScreen(COLOR_BG);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("Powering off", tft.width() / 2, tft.height() / 2 - 12);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("touch screen to wake", tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);

  if (beepEnabled) { // single short blip as tactile confirmation
    digitalWrite(AUDIO_EN_PIN, LOW);
    ledcWrite(AUDIO_OUT_PIN, beepDuty);
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
  tft.setTextFont(2);
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
  if (digitalRead(BOOT_BTN_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    else if (millis() - pressStart >= POWER_OFF_HOLD_MS) powerOff();
  } else {
    pressStart = 0;
  }
}

void copyField(char* dest, size_t destSize, const char* src) {
  strncpy(dest, src, destSize - 1);
  dest[destSize - 1] = '\0';
}

void padTo(char* buf, size_t bufSize, size_t width) {
  size_t len = strlen(buf);
  while (len < width && len + 1 < bufSize) buf[len++] = ' ';
  buf[len] = '\0';
}

// Left-pad instead: for right-aligned (TR_DATUM) fields, where trailing
// spaces would land past the right edge instead of blanking the leftover
// pixels of a previously-longer value. Only reliable with the fixed-width
// font 1 - proportional-font spaces are narrower than most glyphs.
void padLeftTo(char* buf, size_t bufSize, size_t width) {
  size_t len = strlen(buf);
  if (len >= width || width + 1 > bufSize) return;
  size_t shift = width - len;
  memmove(buf + shift, buf, len + 1);
  memset(buf, ' ', shift);
}

bool drawIfChanged(char* cache, size_t cacheSize, const char* text, int x, int y,
                    uint8_t font, uint8_t size, uint16_t fg, uint16_t bg,
                    uint8_t datum = TL_DATUM) {
  if (strncmp(cache, text, cacheSize) == 0) return false;
  strncpy(cache, text, cacheSize - 1);
  cache[cacheSize - 1] = '\0';
  tft.setTextFont(font);
  tft.setTextSize(size);
  tft.setTextColor(fg, bg);
  tft.setTextDatum(datum);
  tft.drawString(text, x, y);
  tft.setTextDatum(TL_DATUM);
  tft.setTextSize(1);
  return true;
}

uint16_t colorForPct(int pct) {
  if (pct < 0) return COLOR_UNKNOWN;
  if (pct >= 90) return COLOR_BAD;
  if (pct >= 70) return COLOR_WARN;
  return COLOR_GOOD;
}

// Three states a session can be in, from ~/.claude/deckhand-session-hook.mjs:
//   "working" - actively processing a turn
//   "asking"  - paused for your input (permission prompt, AskUserQuestion,
//               ExitPlanMode) or an idle nudge
//   anything else ("waiting") - turn finished, waiting for your next message
uint16_t colorForStatus(const char* status) {
  if (strcmp(status, "working") == 0) return COLOR_WARN;
  if (strcmp(status, "asking") == 0) return COLOR_BAD;
  return COLOR_GOOD;
}

const char* labelForStatus(const char* status) {
  if (strcmp(status, "working") == 0) return "working";
  if (strcmp(status, "asking") == 0) return "needs your input";
  return "waiting for you";
}

// Shape is a second, color-independent cue, since color alone should never
// be the only way a state is conveyed: solid dot = working, filled square =
// asking, hollow ring = waiting.
void drawStatusDot(int cx, int cy, int r, const char* status, uint16_t bg = COLOR_BG) {
  uint16_t color = colorForStatus(status);
  tft.fillRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2, bg);
  if (strcmp(status, "working") == 0) {
    tft.fillCircle(cx, cy, r, color);
  } else if (strcmp(status, "asking") == 0) {
    tft.fillRect(cx - r, cy - r, r * 2, r * 2, color);
  } else {
    tft.drawCircle(cx, cy, r, color);
    tft.drawCircle(cx, cy, r - 1, color);
  }
}

void drawBar(int* cache, int x, int y, int w, int h, int pct, uint16_t fg) {
  int clamped = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
  if (clamped == *cache) return;
  *cache = clamped;
  tft.fillRoundRect(x, y, w, h, h / 2, COLOR_BG);
  int filled = w * clamped / 100;
  if (filled >= h) {
    tft.fillRoundRect(x, y, filled, h, h / 2, fg);
  } else if (filled > 0) {
    tft.fillCircle(x + h / 2, y + h / 2, h / 2, fg);
  }
}

// Usage bar with a "pace" tick: a small vertical marker at the fraction of
// the quota window that has already elapsed. Fill ahead of the tick means
// quota is being used faster than time is passing; behind means under pace.
// Position carries the meaning (not color), so it stays colorblind-safe.
void drawPaceBar(int* cache, int x, int y, int w, int h, int pct, int tickPct, uint16_t fg) {
  int clamped = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
  int tick = tickPct < 0 ? -1 : (tickPct > 100 ? 100 : tickPct);
  int code = clamped * 102 + tick;
  if (code == *cache) return;
  *cache = code;
  tft.fillRect(x - 1, y - 4, w + 2, h + 8, COLOR_CARD); // covers the tick overhang
  tft.fillRoundRect(x, y, w, h, h / 2, COLOR_BG);
  int filled = w * clamped / 100;
  if (filled >= h) {
    tft.fillRoundRect(x, y, filled, h, h / 2, fg);
  } else if (filled > 0) {
    tft.fillCircle(x + h / 2, y + h / 2, h / 2, fg);
  }
  if (tick >= 0) {
    int tx = x + (w - 3) * tick / 100;
    tft.fillRect(tx, y - 4, 3, h + 8, COLOR_VALUE);
  }
}

void drawCardBorder(int* cache, int x, int y, int w, int h, uint16_t color) {
  if ((int) color == *cache) return;
  *cache = (int) color;
  tft.drawRoundRect(x, y, w, h, RADIUS, color);
  tft.drawRoundRect(x + 1, y + 1, w - 2, h - 2, RADIUS - 1, color);
}

String formatTokens(unsigned long tokens) {
  char buf[24];
  if (tokens >= 1000000UL) {
    snprintf(buf, sizeof(buf), "%.2fM tok", tokens / 1000000.0);
  } else if (tokens >= 1000UL) {
    snprintf(buf, sizeof(buf), "%.1fK tok", tokens / 1000.0);
  } else {
    snprintf(buf, sizeof(buf), "%lu tok", tokens);
  }
  return String(buf);
}

String formatResetIn(long minutes) {
  if (minutes < 0) return String("no data yet");
  unsigned long m = (unsigned long) minutes;
  if (m >= 1440) {
    return String((int)(m / 1440)) + "d " + String((int)((m / 60) % 24)) + "h left";
  } else if (m >= 60) {
    return String((int)(m / 60)) + "h " + String((int)(m % 60)) + "m left";
  }
  return String((int)m) + "m left";
}

void drawSparkle(int cx, int cy, int r, uint16_t color) {
  int a = r / 3;
  tft.fillTriangle(cx, cy - r, cx - a, cy, cx + a, cy, color);
  tft.fillTriangle(cx, cy + r, cx - a, cy, cx + a, cy, color);
  tft.fillTriangle(cx - r, cy, cx, cy - a, cx, cy + a, color);
  tft.fillTriangle(cx + r, cy, cx, cy - a, cx, cy + a, color);
}

const int TAB_COUNT = 3;

void drawTabBar() {
  tft.fillRect(0, 0, tft.width(), TAB_BAR_H, COLOR_CARD);
  const char* labels[TAB_COUNT] = {"USAGE", "SESSIONS", "SETTINGS"};
  int tabW = tft.width() / TAB_COUNT;
  for (int i = 0; i < TAB_COUNT; i++) {
    bool active = (i == (int) currentTab);
    tft.setTextFont(1);
    tft.setTextColor(active ? COLOR_VALUE : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(labels[i], i * tabW + tabW / 2, TAB_BAR_H / 2);
    if (active) {
      tft.fillRect(i * tabW + 8, TAB_BAR_H - 3, tabW - 16, 3, COLOR_ACCENT);
    }
  }
  tft.setTextDatum(TL_DATUM);
}

void resetUsageCaches() {
  pct1Cache[0] = '\0'; left1Cache[0] = '\0'; right1Cache[0] = '\0'; fable1Cache[0] = '\0';
  resetAt1Cache[0] = '\0'; bar1Cache = -2; border1Cache = -1;
  pct2Cache[0] = '\0'; left2Cache[0] = '\0'; right2Cache[0] = '\0'; fable2Cache[0] = '\0';
  resetAt2Cache[0] = '\0'; bar2Cache = -2; border2Cache = -1;
}

void drawCardChrome(int y0, const char* label) {
  tft.fillRoundRect(CARD_X, y0, CARD_W, CARD_H, RADIUS, COLOR_CARD);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + 6);
}

// The big percentage can't use the usual padded-fixed-width diffing trick -
// at this size a padded field would be wider than the card. Instead it
// clears its own bounding box (only when the value actually changes).
bool drawBigNumber(char* cache, size_t cacheSize, const char* text, int x, int y, int w, int h,
                    uint16_t fg, uint16_t bg) {
  if (strncmp(cache, text, cacheSize) == 0) return false;
  strncpy(cache, text, cacheSize - 1);
  cache[cacheSize - 1] = '\0';
  tft.fillRect(x, y, w, h, bg);
  tft.setTextFont(4);
  tft.setTextSize(2);
  tft.setTextColor(fg, bg);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(text, x, y);
  tft.setTextSize(1);
  return true;
}

void renderCard(int y0, int pct, unsigned long tokens, long resetInMin, long windowMin,
                char* pctCache, char* leftCache, char* rightCache, char* fableCache,
                char* resetAtCache, int* barCache, int* borderCache,
                unsigned long fableTokens = 0, int fablePct = -1) {
  char buf[24];
  uint16_t color = colorForPct(pct);
  drawCardBorder(borderCache, CARD_X, y0, CARD_W, CARD_H, color);

  if (pct >= 0) snprintf(buf, sizeof(buf), "%d%%", pct);
  else snprintf(buf, sizeof(buf), "--");
  drawBigNumber(pctCache, 8, buf, CARD_X + PAD, y0 + 20, CARD_W - 2 * PAD, 54, COLOR_VALUE, COLOR_CARD);

  // Tick = how far through the quota window we are, time-wise.
  int tickPct = resetInMin >= 0 ? (int)(100 - resetInMin * 100 / windowMin) : -1;
  drawPaceBar(barCache, CARD_X + PAD, y0 + 80, CARD_W - 2 * PAD, BAR_H, pct, tickPct, color);

  // Two columns instead of one long piped string: each half gets a legible
  // font instead of both being squeezed into the smallest font to fit.
  int statY = y0 + 96;
  snprintf(buf, sizeof(buf), "%s", formatTokens(tokens).c_str());
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(leftCache, 24, buf, CARD_X + PAD, statY, 2, 1, COLOR_LABEL, COLOR_CARD);

  // "resets_at null + a real pct" isn't missing data - it means no window
  // is currently active (nothing used since the last reset), so say that.
  if (resetInMin < 0 && pct >= 0) {
    snprintf(buf, sizeof(buf), "starts on use");
  } else {
    snprintf(buf, sizeof(buf), "%s", formatResetIn(resetInMin).c_str());
  }
  padTo(buf, sizeof(buf), 16);
  drawIfChanged(rightCache, 20, buf, CARD_X + CARD_W - PAD, statY, 2, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);

  // The countdown is relative; the wall-clock reset time is what you can
  // actually plan around, so show both. But if the quota numbers themselves
  // are stale (host fell back to an old cache), say THAT instead - the
  // footer's "5s ago" only vouches for the transport, not the data.
  // This bottom row is shared: Fable line on the left (<=18 chars, ends at
  // x~134), reset-time/staleness on the right (10 chars left-padded, starts
  // at x~170). The paddings are the lane widths - a longer string in either
  // field would blank or overwrite its neighbor, which happened once when
  // the right lane grew for the staleness text without shrinking this one.
  long nowSec = hostNowSec();
  bool quotaStale = usage.quotaAgeSec > 900;
  if (quotaStale) {
    long m = usage.quotaAgeSec / 60;
    if (m < 60) snprintf(buf, sizeof(buf), "stale %ldm", m);
    else snprintf(buf, sizeof(buf), "stale %ldh", m / 60);
  } else if (resetInMin >= 0 && nowSec >= 0) {
    long atSec = (nowSec + resetInMin * 60) % 86400;
    snprintf(buf, sizeof(buf), "at %02ld:%02ld", atSec / 3600, (atSec / 60) % 60);
  } else {
    buf[0] = '\0';
  }
  padLeftTo(buf, sizeof(buf), 10);
  drawIfChanged(resetAtCache, 14, buf, CARD_X + CARD_W - PAD, y0 + 114, 1, 1,
                quotaStale ? COLOR_BAD : COLOR_LABEL, COLOR_CARD, TR_DATUM);

  // Fable has its own (scarcer) weekly cap: show its real % when the host
  // has it from the OAuth endpoint, with a compact token count as detail.
  if (fablePct >= 0 && fableTokens >= 1000000UL) {
    snprintf(buf, sizeof(buf), "Fable: %d%% %.1fM", fablePct, fableTokens / 1000000.0);
  } else if (fablePct >= 0 && fableTokens > 0) {
    snprintf(buf, sizeof(buf), "Fable: %d%% %luK", fablePct, fableTokens / 1000UL);
  } else if (fablePct >= 0) {
    snprintf(buf, sizeof(buf), "Fable: %d%%", fablePct);
  } else if (fableTokens > 0) {
    snprintf(buf, sizeof(buf), "Fable: %s", formatTokens(fableTokens).c_str());
  } else {
    buf[0] = '\0';
  }
  if (buf[0]) {
    padTo(buf, sizeof(buf), 18);
    drawIfChanged(fableCache, 24, buf, CARD_X + PAD, y0 + 114, 1, 1, COLOR_ACCENT, COLOR_CARD);
  }
}

void drawFooterChrome() {
  tft.drawFastHLine(0, contentBottom(), tft.width(), COLOR_LABEL);
  // Every full-screen rebuild goes through here, so stale footer caches
  // (which would otherwise skip redrawing an erased field) reset with it.
  clockCache[0] = '\0';
  updatedCache[0] = '\0';
  battTextCache[0] = '\0';
  battGlyphCache = -1;
}

// Battery runs the pct scale the opposite way from quota: low = bad.
uint16_t colorForBattery(int pct) {
  if (pct <= 10) return COLOR_BAD;
  if (pct <= 30) return COLOR_WARN;
  return COLOR_GOOD;
}

// 20x9 battery outline with proportional fill. Fill level (not just color)
// carries the state, so it stays readable without relying on colour.
void drawBatteryGlyph(int x, int y, int pct, int state) {
  tft.fillRect(x, y, 21, 9, COLOR_BG);
  if (state == (int) BATT_NONE) return;
  uint16_t c = colorForBattery(pct);
  tft.drawRect(x, y, 18, 9, c);
  tft.fillRect(x + 18, y + 2, 2, 5, c);
  int fill = 14 * pct / 100;
  if (fill > 0) tft.fillRect(x + 2, y + 2, fill, 5, c);
}

// Footer layout, all font 1 (6px/char monospace), 240px wide:
//   clock 10..58 | battery glyph 88..109 + text 113..137 | freshness ..230
// Each zone is fixed-width padded so none can grow into its neighbor.
void renderFooter() {
  char buf[24];
  int y = contentBottom() + 4;

  long nowSec = hostNowSec();
  if (nowSec >= 0) {
    snprintf(buf, sizeof(buf), "%02ld:%02ld:%02ld", nowSec / 3600, (nowSec / 60) % 60, nowSec % 60);
  } else {
    snprintf(buf, sizeof(buf), "--:--:--");
  }
  padTo(buf, sizeof(buf), 8);
  drawIfChanged(clockCache, sizeof(clockCache), buf, 10, y, 1, 1, COLOR_LABEL, COLOR_BG);

  // Battery pill, centered. The glyph redraws on 5%-bucket or state changes
  // only, so EMA jitter in the ADC reading doesn't make it shimmer.
  BattState bst = batteryState();
  int pct = batteryPresent() ? batteryPct() : -1;
  int glyphCode = (pct < 0 ? 0 : pct / 5) * 10 + (int) bst;
  if (glyphCode != battGlyphCache) {
    battGlyphCache = glyphCode;
    drawBatteryGlyph(88, y, pct, (int) bst);
  }
  if (bst == BATT_NONE) buf[0] = '\0';
  else if (bst == BATT_CHARGING) snprintf(buf, sizeof(buf), "chg");
  else if (bst == BATT_FULL) snprintf(buf, sizeof(buf), "full");
  else snprintf(buf, sizeof(buf), "%d%%", pct);
  padTo(buf, sizeof(buf), 4);
  drawIfChanged(battTextCache, sizeof(battTextCache), buf, 113, y, 1, 1,
                COLOR_LABEL, COLOR_BG);

  // Freshness, right-aligned and compact ("12s ago", not "updated 12s ago",
  // so it can't reach the battery zone even at its widest). Left-padded:
  // trailing spaces would land past the right edge, leading spaces are what
  // blank a previously-longer value.
  bool fresh = everReceived && (millis() - lastRxMillis) < 30000;
  unsigned long agoSec = everReceived ? (millis() - lastRxMillis) / 1000 : 0;
  if (!everReceived) {
    snprintf(buf, sizeof(buf), "no data");
  } else if (fresh) {
    snprintf(buf, sizeof(buf), "%lus ago", agoSec);
  } else if (agoSec < 600) {
    snprintf(buf, sizeof(buf), "stale %lus", agoSec);
  } else {
    snprintf(buf, sizeof(buf), "stale %lum", agoSec / 60);
  }
  padLeftTo(buf, sizeof(buf), 11);
  drawIfChanged(updatedCache, sizeof(updatedCache), buf, tft.width() - 10, y, 1, 1,
                fresh ? COLOR_LABEL : COLOR_BAD, COLOR_BG, TR_DATUM);
}

void renderUsageTab() {
  if (!everReceived) return;
  renderCard(CARD1_Y, usage.fiveHourPct, usage.sessionTokens, usage.fiveHourResetInMin,
             5 * 60, pct1Cache, left1Cache, right1Cache, fable1Cache, resetAt1Cache,
             &bar1Cache, &border1Cache);
  renderCard(CARD2_Y, usage.sevenDayPct, usage.weekAllTokens, usage.sevenDayResetInMin,
             7 * 24 * 60, pct2Cache, left2Cache, right2Cache, fable2Cache, resetAt2Cache,
             &bar2Cache, &border2Cache, usage.weekFableTokens, usage.weekFablePct);
}

void drawUsageStatic() {
  drawCardChrome(CARD1_Y, "SESSION - 5 HOUR WINDOW");
  drawCardChrome(CARD2_Y, "WEEK - 7 DAY, ALL MODELS");
}

// ---------- Sessions tab ----------
const int SESSION_ROW_Y0 = CONTENT_Y + 4;
const int SESSION_ROW_GAP = 3;
const int SESSION_ROW_X = 8;
const int SESSION_ROW_W = 224;
// Rows stretch to fill the screen: this tab is a desk monitor for a few
// projects, so with 1-3 sessions each row gets tall (big name, roomy status
// pill) and only compresses when the list actually fills up. Recomputed in
// renderSessionsList whenever the session count changes.
int sessionRowH = 40;
bool sessionRowsLarge() { return sessionRowH >= 56; }

void drawChevron(int rightX, int cy, uint16_t color = COLOR_LABEL) {
  tft.fillTriangle(rightX - 8, cy - 5, rightX - 8, cy + 5, rightX - 2, cy, color);
}

// How long a session has been in its current status. Minutes granularity
// past the first minute keeps the field from churning; seconds early on
// make a fresh status change visibly "new".
void formatDuration(unsigned long sinceMillis, char* buf, size_t n) {
  unsigned long sec = (millis() - sinceMillis) / 1000;
  if (sec < 60) snprintf(buf, n, "%lus", sec);
  else if (sec < 3600) snprintf(buf, n, "%lum", sec / 60);
  else snprintf(buf, n, "%luh%02lum", sec / 3600, (sec / 60) % 60);
}

// "sonnet-5 (main)" - model with the redundant "claude-" prefix stripped,
// branch in parens. Either half may be missing. Takes an index rather than
// a SessionInfo& because Arduino's auto-generated prototypes land before
// the struct definition (same reason enum Tab is declared so early).
void buildSessionSubline(int i, char* out, size_t n) {
  const SessionInfo& s = sessions[i];
  const char* model = s.model;
  if (strncmp(model, "claude-", 7) == 0) model += 7;
  if (model[0] && s.branch[0]) snprintf(out, n, "%s (%s)", model, s.branch);
  else if (model[0]) snprintf(out, n, "%s", model);
  else if (s.branch[0]) snprintf(out, n, "(%s)", s.branch);
  else out[0] = '\0';
}

// Status pill: visual weight matches urgency. "asking" = solid filled pill
// (the loudest element on the tab - Claude is blocked on you), "waiting" =
// outlined pill (turn done, ready when you are), "working" = plain dim text
// with no box - a healthy busy session shouldn't compete for attention.
// Fill/outline/none is a luminance-and-shape code, readable under any color
// vision; hue is reinforcement only.
void drawStatusPill(int xEdge, int y, const char* label, const char* status, bool rightAlign) {
  bool working = strcmp(status, "working") == 0;
  bool asking = strcmp(status, "asking") == 0;
  uint16_t color = colorForStatus(status);
  tft.setTextFont(2);
  int w = tft.textWidth(label) + 12;
  int x = rightAlign ? xEdge - w : xEdge;
  if (asking) {
    tft.fillRoundRect(x, y, w, 18, 9, color);
    tft.setTextColor(COLOR_BG, color);
  } else if (working) {
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  } else {
    tft.drawRoundRect(x, y, w, 18, 9, color);
    tft.setTextColor(color, COLOR_CARD);
  }
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, x + w / 2, y + 9);
  tft.setTextDatum(TL_DATUM);
}

void drawSessionRow(int i) {
  int rowH = sessionRowH;
  bool large = sessionRowsLarge();
  int y = SESSION_ROW_Y0 + i * (rowH + SESSION_ROW_GAP);
  const SessionInfo& s = sessions[i];
  bool working = strcmp(s.status, "working") == 0;
  uint16_t color = colorForStatus(s.status);

  tft.fillRoundRect(SESSION_ROW_X, y, SESSION_ROW_W, rowH, 8, COLOR_CARD);
  // Working rows get a quiet grey border; colored borders are reserved for
  // the two states that want the user's eyes.
  uint16_t border = working ? COLOR_LABEL : color;
  tft.drawRoundRect(SESSION_ROW_X, y, SESSION_ROW_W, rowH, 8, border);
  tft.drawRoundRect(SESSION_ROW_X + 1, y + 1, SESSION_ROW_W - 2, rowH - 2, 7, border);

  int dotCy = large ? y + 19 : y + rowH / 2;
  drawStatusDot(SESSION_ROW_X + 20, dotCy, large ? 9 : 7, s.status, COLOR_CARD);

  // Clip the name to its lane (large rows give the name its own line).
  char nameBuf[14];
  size_t maxLen = large ? 12 : 11;
  snprintf(nameBuf, sizeof(nameBuf), "%s", s.name);
  if (strlen(s.name) > maxLen) {
    nameBuf[maxLen - 1] = '.';
    nameBuf[maxLen] = '\0';
  }
  tft.setTextFont(large ? 4 : 2);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(nameBuf, SESSION_ROW_X + 40, y + 6);

  char sub[22];
  buildSessionSubline(i, sub, sizeof(sub));
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);

  if (large) {
    // Tall row: name line, optional model/branch line, then a status line
    // with the pill on the left and the live duration on the right.
    if (rowH >= 70 && sub[0]) tft.drawString(sub, SESSION_ROW_X + 40, y + 34);
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "NEEDS INPUT" : "READY");
    drawStatusPill(SESSION_ROW_X + 40, y + rowH - 24, label, s.status, false);
  } else {
    if (sub[0]) tft.drawString(sub, SESSION_ROW_X + 40, y + 25);
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "INPUT" : "READY");
    drawStatusPill(SESSION_ROW_X + SESSION_ROW_W - 16, y + 4, label, s.status, true);
  }

  // Accent chevron on asking rows: the tap doesn't just show detail there,
  // it opens the answer screen.
  drawChevron(SESSION_ROW_X + SESSION_ROW_W, y + rowH / 2,
              strcmp(s.status, "asking") == 0 ? COLOR_ACCENT : COLOR_LABEL);
}

void renderSessionsList() {
  int hiddenCount = sessionsTotal - sessionCount;
  if (hiddenCount < 0) hiddenCount = 0;
  int layoutCode = sessionCount * 2 + (hiddenCount > 0 ? 1 : 0);
  if (layoutCode != rowCountCache) {
    rowCountCache = layoutCode;
    if (sessionCount > 0) {
      // The overflow strip ("+N more") takes the bottom 16px when present.
      int avail = contentBottom() - SESSION_ROW_Y0 - (hiddenCount > 0 ? 16 : 0);
      sessionRowH = constrain(
          (avail - SESSION_ROW_GAP * (sessionCount - 1)) / sessionCount, 38, 72);
    }
    tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
    for (int i = 0; i < MAX_SESSIONS; i++) rowSigCache[i][0] = '\0';
    overflowCache[0] = '\0';
    if (sessionCount == 0) {
      int cy = (CONTENT_Y + contentBottom()) / 2 - 20;
      drawSparkle(tft.width() / 2, cy, 10, COLOR_LABEL);
      tft.setTextFont(2);
      tft.setTextColor(COLOR_LABEL, COLOR_BG);
      tft.setTextDatum(MC_DATUM);
      tft.drawString("No active Claude Code sessions", tft.width() / 2, cy + 30);
      tft.setTextDatum(TL_DATUM);
    }
  }
  for (int i = 0; i < sessionCount; i++) {
    char sub[22];
    buildSessionSubline(i, sub, sizeof(sub));
    char sig[96];
    snprintf(sig, sizeof(sig), "%s|%s|%s", sessions[i].name, sessions[i].status, sub);
    if (strncmp(sig, rowSigCache[i], sizeof(rowSigCache[i])) != 0) {
      strncpy(rowSigCache[i], sig, sizeof(rowSigCache[i]) - 1);
      rowSigCache[i][sizeof(rowSigCache[i]) - 1] = '\0';
      drawSessionRow(i);
      rowDurCache[i][0] = '\0'; // row was repainted, duration must redraw too
    }
    char dur[8];
    formatDuration(sessions[i].statusSinceMillis, dur, sizeof(dur));
    padLeftTo(dur, sizeof(dur), 7);
    int y = SESSION_ROW_Y0 + i * (sessionRowH + SESSION_ROW_GAP);
    int durY = sessionRowsLarge() ? y + sessionRowH - 19 : y + 25;
    drawIfChanged(rowDurCache[i], sizeof(rowDurCache[i]), dur,
                  SESSION_ROW_X + SESSION_ROW_W - 16, durY, 1, 1,
                  COLOR_LABEL, COLOR_CARD, TR_DATUM);
  }

  // Truncation must never be silent: say how many sessions didn't fit, and
  // shout if any of them needs input (only possible with 7+ asking at once,
  // since the host sorts asking sessions to the top).
  if (hiddenCount > 0) {
    char buf[32];
    if (hiddenAskingCount > 0) {
      snprintf(buf, sizeof(buf), "+%d more, %d NEED INPUT", hiddenCount, hiddenAskingCount);
    } else {
      snprintf(buf, sizeof(buf), "+%d more session%s", hiddenCount, hiddenCount == 1 ? "" : "s");
    }
    padTo(buf, sizeof(buf), 26);
    drawIfChanged(overflowCache, sizeof(overflowCache), buf, SESSION_ROW_X + 2,
                  contentBottom() - 12, 1, 1,
                  hiddenAskingCount > 0 ? COLOR_BAD : COLOR_LABEL, COLOR_BG);
  }
}

// Kept as the "force a full repaint" entry point (tab switch, closing the
// detail screen): invalidating the count cache makes renderSessionsList
// clear the area and rebuild every row.
void drawSessionsAll() {
  rowCountCache = -1;
  renderSessionsList();
}

// Current array index of the session under the detail view, found by its
// stable id, or -1 if it's no longer in the list.
int resolveDetailIndex() {
  if (!detailId[0]) return -1;
  for (int i = 0; i < sessionCount; i++)
    if (strcmp(sessions[i].id, detailId) == 0) return i;
  return -1;
}

void renderSessionsTab() {
  if (showingDetail) {
    detailIndex = resolveDetailIndex(); // re-anchor after any reorder
    if (detailIndex >= 0 && detailIndex < sessionCount) {
      // A remote answer was accepted (the ask vanished from the feed):
      // the job here is done, return to the list automatically.
      if (answeredPid[0] && !sessions[detailIndex].askPid[0]) {
        answeredPid[0] = '\0';
        answeredIdx = -1;
        closeSessionDetail();
        return;
      }
      char sig[208];
      buildDetailSignature(detailIndex, sig, sizeof(sig));
      if (strncmp(sig, detailSigCache, sizeof(detailSigCache)) != 0) {
        strncpy(detailSigCache, sig, sizeof(detailSigCache) - 1);
        detailSigCache[sizeof(detailSigCache) - 1] = '\0';
        drawSessionDetail(detailIndex);
      }
      renderDetailDuration();
    } else {
      // The session under the detail view ended - fall back to the list
      // instead of leaving a stale snapshot on screen.
      closeSessionDetail();
    }
    return;
  }
  renderSessionsList();
}

// ---------- Session detail screen ----------
void buildDetailSignature(int idx, char* out, size_t outSize) {
  snprintf(out, outSize, "%s|%s|%s|%s|%s|%s|%d", sessions[idx].name, sessions[idx].status,
           sessions[idx].path, sessions[idx].model, sessions[idx].branch,
           sessions[idx].askPid, answeredPid[0] ? answeredIdx : -1);
}

void drawDetailRow(int y, const char* label, const char* value) {
  tft.setTextFont(2);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  const char* v = value[0] ? value : "-";
  int maxW = CARD_W - 2 * PAD;
  if (tft.textWidth(v) > maxW) {
    // Too long to fit (paths, mostly): keep the tail - the deepest path
    // segments are the informative part - and mark the cut with "..".
    int dotsW = tft.textWidth("..");
    while (*v && tft.textWidth(v) > maxW - dotsW) v++;
    tft.drawString("..", CARD_X + PAD, y + 18);
    tft.drawString(v, CARD_X + PAD + dotsW, y + 18);
  } else {
    tft.drawString(v, CARD_X + PAD, y + 18);
  }
}

const int DETAIL_CARD_Y = CONTENT_Y + 26;

// How many characters of text (from pos) fit in maxW pixels with the
// CURRENT font, measured, not assumed - proportional fonts make per-char
// column counts wrong, which once let lines run past the right margin.
// Prefers breaking after a space when one exists in the back half.
int wrapLineLen(const char* text, int pos, int maxW) {
  char buf[64];
  int len = strlen(text + pos);
  int n = 0;
  while (n < len && n < 60) {
    buf[n] = text[pos + n];
    buf[n + 1] = '\0';
    if (tft.textWidth(buf) > maxW) break;
    n++;
  }
  if (n >= len) return n; // the rest fits on this line
  if (n == 0) return 1;   // never stall, even on a pathological glyph
  for (int b = n; b > n / 2; b--) {
    if (text[pos + b - 1] == ' ') return b; // word-friendly break
  }
  return n;
}

int countWrappedLines(const char* text, uint8_t font, int maxW) {
  tft.setTextFont(font);
  int len = strlen(text);
  int pos = 0, lines = 0;
  while (pos < len && lines < 50) {
    pos += wrapLineLen(text, pos, maxW);
    lines++;
  }
  return lines;
}

// Measured, word-wrapped text block. Returns the y below the last drawn
// line. skipLines/maxLines implement paging; bg matters when the text sits
// on a panel rather than the screen background.
int drawWrappedText(const char* text, int x, int y, uint8_t font, int lineH, int maxW,
                    int skipLines, int maxLines, uint16_t color, uint16_t bg) {
  tft.setTextFont(font);
  tft.setTextColor(color, bg);
  tft.setTextDatum(TL_DATUM);
  int len = strlen(text);
  int pos = 0, line = 0, drawn = 0;
  while (pos < len && drawn < maxLines && line < 50) {
    int n = wrapLineLen(text, pos, maxW);
    if (line >= skipLines) {
      char buf[64];
      int c = n > 63 ? 63 : n;
      memcpy(buf, text + pos, c);
      buf[c] = '\0';
      tft.drawString(buf, x, y);
      y += lineH;
      drawn++;
    }
    pos += n;
    line++;
  }
  return y;
}

const int ASK_OPT_H = 32;
const int ASK_OPT_GAP = 4;
// READ ALL sits in the header row, top-right: maximum distance from the
// decision buttons at the bottom, so reading can't be fat-fingered into an
// Allow/Deny.
const int ASK_READ_BTN_X = 150;
const int ASK_READ_BTN_W = 78;

// Index-based (not SessionInfo&) for the same Arduino auto-prototype reason
// as buildSessionSubline.
int askOptionsTop(int idx) {
  return contentBottom() - sessions[idx].askOptCount * (ASK_OPT_H + ASK_OPT_GAP);
}

// The answer screen: question title, paged detail text, and one big button
// per option. Tapping an option sends the answer to the host, which hands
// it to the (waiting) session hook to decide the real prompt.
void drawAskDetail(int idx) {
  SessionInfo& s = sessions[idx];
  bool answered = answeredPid[0] && strncmp(answeredPid, s.askPid, sizeof(answeredPid)) == 0;
  bool isPerm = strcmp(s.askKind, "perm") == 0;
  bool isPlan = strcmp(s.askKind, "plan") == 0;

  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("< Back", CARD_X, CONTENT_Y + 4);
  // (READ ALL button lands top-right of this row, drawn below once the
  // overflow question is settled - far away from the decision buttons.)

  // What kind of decision this is, at a glance; session name on the right.
  const char* badge = isPerm ? "PERMISSION REQUEST" : (isPlan ? "PLAN APPROVAL" : "QUESTION");
  tft.setTextFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.drawString(badge, CARD_X, CONTENT_Y + 27);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(s.name, tft.width() - CARD_X, CONTENT_Y + 27);
  tft.setTextDatum(TL_DATUM);

  // Symmetric text margins: CARD_X on both sides.
  int maxW = tft.width() - 2 * CARD_X;

  // Title (up to 2 lines, font 2, measured wrap).
  int y = drawWrappedText(s.askTitle, CARD_X, CONTENT_Y + 39, 2, 17, maxW, 0, 2,
                          COLOR_VALUE, COLOR_BG);

  // Detail text, styled by kind: commands read as a code block (monospace
  // on a card panel), questions and plans read as prose (bigger font, roomy
  // line height). When it doesn't fit, the READ ALL button (top-right, well
  // clear of the decision buttons) opens the full-screen reader.
  int optTop = askOptionsTop(idx);
  int textTop = y + 4;

  uint8_t dFont = isPerm ? 1 : 2;
  int dLineH = isPerm ? 11 : 17;
  int pad = isPerm ? 7 : 0;
  int textW = maxW - 2 * pad;
  uint16_t textBg = isPerm ? COLOR_CARD : COLOR_BG;

  int visLines = (optTop - 8 - textTop - 2 * pad) / dLineH;
  if (visLines < 1) visLines = 1;
  int totalLines = countWrappedLines(s.askDetail, dFont, textW);
  askOverflow = totalLines > visLines;
  int shown = askOverflow ? visLines : totalLines;
  if (shown < 1) shown = 1;

  if (isPerm) {
    tft.fillRoundRect(CARD_X - 4, textTop, maxW + 8, shown * dLineH + 2 * pad, 6, COLOR_CARD);
  }
  drawWrappedText(s.askDetail, CARD_X + pad, textTop + pad, dFont, dLineH, textW,
                  0, visLines, COLOR_VALUE, textBg);

  if (askOverflow) {
    // Cut marker at the preview's edge...
    tft.setTextFont(1);
    tft.setTextColor(COLOR_LABEL, textBg);
    tft.setTextDatum(TR_DATUM);
    tft.drawString("...", tft.width() - CARD_X - pad, textTop + pad + (shown - 1) * dLineH);
    tft.setTextDatum(TL_DATUM);
    // ...and the READ ALL button up in the header row.
    tft.fillRoundRect(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, 24, 6, COLOR_CARD);
    tft.drawRoundRect(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, 24, 6, COLOR_ACCENT);
    tft.setTextFont(2);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("READ ALL", ASK_READ_BTN_X + ASK_READ_BTN_W / 2, CONTENT_Y + 13);
    tft.setTextDatum(TL_DATUM);
  }

  // Option buttons, colored by meaning (labels carry it too - color is
  // reinforcement, per the colorblind-safe rule): Allow/Approve blue,
  // Deny in the alert color, neutral question options in accent.
  for (int k = 0; k < s.askOptCount; k++) {
    int by = optTop + k * (ASK_OPT_H + ASK_OPT_GAP);
    bool chosen = answered && k == answeredIdx;
    uint16_t oc = COLOR_ACCENT;
    if ((isPerm || isPlan) && k == 0) oc = COLOR_GOOD;
    else if (isPerm && k == 1) oc = COLOR_BAD;
    uint16_t fill = chosen ? oc : COLOR_CARD;
    tft.fillRoundRect(CARD_X, by, CARD_W, ASK_OPT_H, 8, fill);
    tft.drawRoundRect(CARD_X, by, CARD_W, ASK_OPT_H, 8,
                      answered && !chosen ? COLOR_LABEL : oc);
    tft.setTextFont(2);
    tft.setTextColor(chosen ? COLOR_BG : (answered ? COLOR_LABEL : oc), fill);
    tft.setTextDatum(MC_DATUM);
    char label[32];
    snprintf(label, sizeof(label), chosen ? "%s - sent" : "%s", s.askOpts[k]);
    tft.drawString(label, tft.width() / 2, by + ASK_OPT_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
}

// ---------- Full-screen reader ----------
// Ebook-style view of the ask's full detail text: the whole screen (tab bar
// and footer suppressed) plus a chunky control bar - PREV / CLOSE / NEXT.
const int READER_CTRL_Y = 272;

void drawReader() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  SessionInfo& s = sessions[detailIndex];
  bool isPerm = strcmp(s.askKind, "perm") == 0;
  bool isPlan = strcmp(s.askKind, "plan") == 0;

  uint8_t dFont = isPerm ? 1 : 2;
  int lineH = isPerm ? 12 : 18;
  int maxW = tft.width() - 24;
  int textTop = 30;
  int visLines = (READER_CTRL_Y - 8 - textTop) / lineH;
  tft.setTextFont(dFont);
  int totalLines = countWrappedLines(s.askDetail, dFont, maxW);
  int pages = (totalLines + visLines - 1) / visLines;
  if (pages < 1) pages = 1;
  if (readerPage >= pages) readerPage = pages - 1;
  if (readerPage < 0) readerPage = 0;

  tft.fillScreen(COLOR_BG);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  char hdr[44];
  snprintf(hdr, sizeof(hdr), "%s - %s", s.name, isPerm ? "COMMAND" : (isPlan ? "PLAN" : "QUESTION"));
  tft.drawString(hdr, 12, 8);
  char pg[10];
  snprintf(pg, sizeof(pg), "%d/%d", readerPage + 1, pages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, 8);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, 22, tft.width(), COLOR_LABEL);

  drawWrappedText(s.askDetail, 12, textTop, dFont, lineH, maxW,
                  readerPage * visLines, visLines, COLOR_VALUE, COLOR_BG);

  // Control bar: disabled ends grey out (same affordance as the steppers).
  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {8, 70, "< PREV", readerPage > 0},
    {86, 68, "CLOSE", true},
    {162, 70, "NEXT >", readerPage < pages - 1},
  };
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    tft.fillRoundRect(btns[i].x, READER_CTRL_Y, btns[i].w, 42, 8, COLOR_CARD);
    tft.drawRoundRect(btns[i].x, READER_CTRL_Y, btns[i].w, 42, 8, c);
    tft.setTextFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + 21);
    tft.setTextDatum(TL_DATUM);
  }
}

// Back to the ask screen (reader covered the tab bar and footer too).
void exitReader() {
  readerActive = false;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (showingDetail && detailIndex >= 0 && detailIndex < sessionCount) {
    drawSessionDetail(detailIndex);
    buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
  }
  renderFooter();
}

// The ask vanished (answered elsewhere / timed out) while reading: land on
// the sessions list rather than a dead ask screen.
void exitReaderToList() {
  readerActive = false;
  showingDetail = false;
  detailIndex = -1;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  drawSessionsAll();
  renderFooter();
}

void handleReaderTouch(int sx, int sy) {
  if (sy >= READER_CTRL_Y) {
    if (sx < 82) {
      if (readerPage > 0) {
        readerPage--;
        drawReader();
      }
    } else if (sx < 158) {
      exitReader();
    } else {
      readerPage++;
      drawReader(); // clamps at the last page
    }
    return;
  }
  // Tapping the text itself advances too - the natural ebook gesture - but
  // the buttons remain the visible, discoverable path.
  readerPage++;
  drawReader();
}

// Device -> host, over whichever transports are up. The host maps the short
// id back to the full session and writes the answer file for the hook.
void sendAnswerToHost(int idx, int optIdx) {
  SessionInfo& s = sessions[idx];
  // HMAC over "nonce:pid:idx" proves this answer came from the paired device
  // and pins it to this one prompt (the nonce is single-use host-side). "0"
  // when unprovisioned - the host rejects that in secure mode.
  char msg[40];
  snprintf(msg, sizeof(msg), "%s:%s:%d", s.askNonce, s.askPid, optIdx);
  String mac = authHmac(String(msg));
  if (mac.length() == 0) mac = "0";
  char line[80];
  snprintf(line, sizeof(line), "ANSWER %s %s %d %s", s.id, s.askPid, optIdx, mac.c_str());
  Serial.println(line);
  if (bleConnected && bleTxChar) {
    char out[84];
    snprintf(out, sizeof(out), "%s\n", line);
    size_t len = strlen(out);
    for (size_t i = 0; i < len; i += 20) {
      size_t n = len - i > 20 ? 20 : len - i;
      bleTxChar->setValue((uint8_t*) (out + i), n);
      bleTxChar->notify();
      delay(12); // give the stack breathing room between notifies
    }
  }
}

// Touch on the detail screen when an ask is showing. Returns true if the
// tap was consumed (option chosen or page flipped); false = treat as back.
bool handleAskTouch(int sx, int sy) {
  if (detailIndex < 0 || detailIndex >= sessionCount) return false;
  SessionInfo& s = sessions[detailIndex];
  if (!s.askPid[0]) return false; // plain detail screen: any tap closes

  int optTop = askOptionsTop(detailIndex);
  if (sy >= optTop) {
    int k = (sy - optTop) / (ASK_OPT_H + ASK_OPT_GAP);
    if (k >= 0 && k < s.askOptCount) {
      bool already = answeredPid[0] && strncmp(answeredPid, s.askPid, sizeof(answeredPid)) == 0;
      if (!already) {
        copyField(answeredPid, sizeof(answeredPid), s.askPid);
        answeredIdx = k;
        sendAnswerToHost(detailIndex, k);
        drawSessionDetail(detailIndex);
        buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
      }
    }
    return true;
  }
  // Header row: READ ALL on the right (when overflowing), back on the left.
  if (sy < CONTENT_Y + 28) {
    if (askOverflow && sx >= ASK_READ_BTN_X - 6) {
      readerActive = true;
      readerPage = 0;
      drawReader();
      return true;
    }
    return false; // "< Back" side of the header
  }
  // Everything between header and options (badge, title, text preview) is
  // deliberately inert - no hidden actions near the decision buttons.
  return true;
}

void drawSessionDetail(int idx) {
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  if (idx < 0 || idx >= sessionCount) return;
  if (sessions[idx].askPid[0]) {
    drawAskDetail(idx);
    return;
  }

  SessionInfo& s = sessions[idx];
  const char* status = s.status;
  uint16_t color = colorForStatus(status);

  tft.setTextFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("< Back to sessions", CARD_X, CONTENT_Y + 4);

  const int cardY = DETAIL_CARD_Y;
  const int cardH = contentBottom() - cardY - 24; // leaves room for the hint below
  tft.fillRoundRect(CARD_X, cardY, CARD_W, cardH, RADIUS, COLOR_CARD);
  tft.drawRoundRect(CARD_X, cardY, CARD_W, cardH, RADIUS, color);
  tft.drawRoundRect(CARD_X + 1, cardY + 1, CARD_W - 2, cardH - 2, RADIUS - 1, color);

  tft.setTextFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.drawString(s.name, CARD_X + PAD, cardY + 10);

  drawStatusDot(CARD_X + PAD + 6, cardY + 40, 6, status, COLOR_CARD);
  tft.setTextColor(color, COLOR_CARD);
  tft.drawString(labelForStatus(status), CARD_X + PAD + 20, cardY + 33);
  detailDurCache[0] = '\0'; // full repaint - the duration line must redraw

  // Asking, but no answerable prompt attached: it either wasn't published
  // (host wasn't connected when it fired) or the remote window has closed.
  // Say so, so "needs input" with no buttons isn't confusing.
  if (strcmp(status, "asking") == 0) {
    tft.setTextFont(1);
    tft.setTextColor(COLOR_WARN, COLOR_CARD);
    tft.drawString("Answer this one on your Mac", CARD_X + PAD, cardY + 56);
  }

  tft.drawFastHLine(CARD_X + PAD, cardY + 72, CARD_W - 2 * PAD, COLOR_LABEL);
  drawDetailRow(cardY + 82, "PATH", s.path);
  tft.drawFastHLine(CARD_X + PAD, cardY + 124, CARD_W - 2 * PAD, COLOR_LABEL);
  drawDetailRow(cardY + 134, "MODEL", s.model);
  tft.drawFastHLine(CARD_X + PAD, cardY + 176, CARD_W - 2 * PAD, COLOR_LABEL);
  drawDetailRow(cardY + 186, "GIT BRANCH", s.branch);

  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("tap anywhere to go back", tft.width() / 2, contentBottom() - 10);
  tft.setTextDatum(TL_DATUM);
}

// The "in this state for Xm" line ticks on its own cache so it can update
// every second without repainting the whole detail card.
void renderDetailDuration() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  if (sessions[detailIndex].askPid[0]) return; // ask screen has its own layout
  char dur[10], buf[16];
  formatDuration(sessions[detailIndex].statusSinceMillis, dur, sizeof(dur));
  snprintf(buf, sizeof(buf), "for %s", dur);
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(detailDurCache, sizeof(detailDurCache), buf, CARD_X + PAD + 20,
                DETAIL_CARD_Y + 52, 1, 1, COLOR_LABEL, COLOR_CARD);
}

// ---------- Settings tab ----------

// SETTINGS is paginated (3 pages), not scrollable - drag-scroll misfires on
// this resistive panel, so discrete pages with a prev/next pager are used
// (same reasoning as the ask-detail reader). Pages:
//   0 STATUS   - device connections, battery, pairing (read-only)
//   1 CONTROLS - brightness, sleep-after, volume steppers + sound toggle
//   2 ACTIONS  - calibrate touch, power off
const int SETTINGS_PAGES = 3;
int settingsPage = 0;

const int PAGER_H = 26;                       // pager band under the tab bar
const int PAGE_TOP = CONTENT_Y + PAGER_H + 4; // top of each page's content

const int STEPPER_CARD_H = 48;
const int STEP_BTN_SIZE = 30;
int stepBtnY(int cardY) { return cardY + STEPPER_CARD_H - STEP_BTN_SIZE - 4; }

// Page 0 - DEVICE card
const int DEV_CARD_Y = PAGE_TOP + 4;
const int DEV_CARD_H = 120;
const int DROW_BT = 24, DROW_USB = 52, DROW_BATT = 80, DROW_ID = 100;

// Page 1 - three steppers + full-width sound toggle
const int P1_BRIGHT_Y = PAGE_TOP + 4;
const int P1_SLEEP_Y = P1_BRIGHT_Y + STEPPER_CARD_H + 8;
const int P1_VOL_Y = P1_SLEEP_Y + STEPPER_CARD_H + 8;
const int P1_SOUND_Y = P1_VOL_Y + STEPPER_CARD_H + 8;
const int P1_SOUND_H = 34;

// Page 2 - two large action buttons
const int P2_CAL_Y = PAGE_TOP + 24;
const int P2_BTN_H = 52;
const int P2_PWR_Y = P2_CAL_Y + P2_BTN_H + 16;

int btDotCache = -1, usbDotCache = -1, battRowCache = -1;
char battRowTextCache[16] = "";
int soundBtnCache = -1;
int stepGlyphCache[6] = {-1, -1, -1, -1, -1, -1}; // bright-/+, sleep-/+, vol-/+
char brightPctCache[8] = "";
int brightBarCache = -1;
char sleepValCache[8] = "";
char volValCache[8] = "";

// Filled dot when connected, hollow ring when not.
void drawConnDot(int cx, int cy, int r, bool connected, uint16_t bg) {
  tft.fillRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2, bg);
  if (connected) {
    tft.fillCircle(cx, cy, r, COLOR_GOOD);
  } else {
    tft.drawCircle(cx, cy, r, COLOR_UNKNOWN);
    tft.drawCircle(cx, cy, r - 1, COLOR_UNKNOWN);
  }
}

void drawStepperCard(int y0, const char* label) {
  tft.fillRoundRect(CARD_X, y0, CARD_W, STEPPER_CARD_H, RADIUS, COLOR_CARD);
  tft.drawRoundRect(CARD_X, y0, CARD_W, STEPPER_CARD_H, RADIUS, COLOR_LABEL);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + 6);
  int btnY = stepBtnY(y0);
  int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  tft.fillRoundRect(CARD_X + PAD, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, 6, COLOR_BG);
  tft.fillRoundRect(rightBtnX, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, 6, COLOR_BG);
  // Borders + -/+ glyphs drawn by drawStepGlyph (they grey out at range ends).
}

// -/+ glyph plus button border, greyed out at the range end.
void drawStepGlyph(int cacheIdx, int x, int btnY, const char* glyph, bool enabled) {
  if (stepGlyphCache[cacheIdx] == (int) enabled) return;
  stepGlyphCache[cacheIdx] = (int) enabled;
  uint16_t c = enabled ? COLOR_ACCENT : COLOR_LABEL;
  tft.drawRoundRect(x, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, 6, c);
  tft.setTextFont(2);
  tft.setTextColor(c, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(glyph, x + STEP_BTN_SIZE / 2, btnY + STEP_BTN_SIZE / 2);
  tft.setTextDatum(TL_DATUM);
}

// The pager band: < chevron, page title + dots, > chevron.
void drawPager() {
  tft.fillRect(0, CONTENT_Y, tft.width(), PAGER_H + 4, COLOR_BG);
  const char* titles[SETTINGS_PAGES] = {"STATUS", "DISPLAY & SOUND", "ACTIONS"};
  int cy = CONTENT_Y + PAGER_H / 2;
  tft.setTextFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(ML_DATUM);
  tft.drawString("<", CARD_X, cy);
  tft.setTextDatum(MR_DATUM);
  tft.drawString(">", tft.width() - CARD_X, cy);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(titles[settingsPage], tft.width() / 2, cy - 5);
  int spacing = 12, startX = tft.width() / 2 - (SETTINGS_PAGES - 1) * spacing / 2;
  for (int i = 0; i < SETTINGS_PAGES; i++) {
    if (i == settingsPage) tft.fillCircle(startX + i * spacing, cy + 8, 3, COLOR_ACCENT);
    else tft.drawCircle(startX + i * spacing, cy + 8, 3, COLOR_LABEL);
  }
  tft.setTextDatum(TL_DATUM);
}

// ----- Page 0: STATUS -----
void drawStatusPageStatic() {
  char buf[36];
  tft.fillRoundRect(CARD_X, DEV_CARD_Y, CARD_W, DEV_CARD_H, RADIUS, COLOR_CARD);
  tft.drawRoundRect(CARD_X, DEV_CARD_Y, CARD_W, DEV_CARD_H, RADIUS, COLOR_LABEL);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("DEVICE", CARD_X + PAD, DEV_CARD_Y + 6);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.drawString("Bluetooth", CARD_X + PAD + 20, DEV_CARD_Y + DROW_BT);
  tft.drawString("USB", CARD_X + PAD + 20, DEV_CARD_Y + DROW_USB);
  tft.drawString("Battery", CARD_X + PAD + 20, DEV_CARD_Y + DROW_BATT);
  snprintf(buf, sizeof(buf), "%s  %s", deviceName, pairingSecret.length() ? "paired" : "unpaired");
  tft.setTextFont(1);
  tft.setTextColor(pairingSecret.length() ? COLOR_GOOD : COLOR_WARN, COLOR_CARD);
  tft.drawString(buf, CARD_X + PAD, DEV_CARD_Y + DROW_ID);
}

// One connection row: dot left, right-aligned status text.
void drawConnRow(int rowOff, bool connected) {
  int y = DEV_CARD_Y + rowOff;
  drawConnDot(CARD_X + PAD + 6, y + 8, 6, connected, COLOR_CARD);
  int xRight = CARD_X + CARD_W - PAD;
  tft.fillRect(xRight - 100, y, 100, 16, COLOR_CARD);
  tft.setTextFont(2);
  tft.setTextColor(connected ? COLOR_GOOD : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(connected ? "Connected" : "Not connected", xRight, y);
  tft.setTextDatum(TL_DATUM);
}

void renderStatusPage() {
  char buf[36];
  bool btConnected = bleConnected;
  if ((btConnected ? 1 : 0) != btDotCache) { btDotCache = btConnected ? 1 : 0; drawConnRow(DROW_BT, btConnected); }
  bool usbConnected = usbLinkActive();
  if ((usbConnected ? 1 : 0) != usbDotCache) { usbDotCache = usbConnected ? 1 : 0; drawConnRow(DROW_USB, usbConnected); }
  BattState bst = batteryState();
  int pct = batteryPresent() ? batteryPct() : -1;
  int battHealthy = (bst == BATT_CHARGING || bst == BATT_FULL || pct > 20) ? 1 : 0;
  if (battHealthy != battRowCache) {
    battRowCache = battHealthy;
    drawConnDot(CARD_X + PAD + 6, DEV_CARD_Y + DROW_BATT + 8, 6, battHealthy, COLOR_CARD);
  }
  if (bst == BATT_NONE) snprintf(buf, sizeof(buf), "not found");
  else snprintf(buf, sizeof(buf), "%d%% %d.%02dV", pct, batteryMv / 1000, (batteryMv % 1000) / 10);
  padLeftTo(buf, sizeof(buf), 12);
  drawIfChanged(battRowTextCache, sizeof(battRowTextCache), buf, CARD_X + CARD_W - PAD,
                DEV_CARD_Y + DROW_BATT + 4, 1, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);
}

// ----- Page 1: CONTROLS -----
void drawControlsPageStatic() {
  drawStepperCard(P1_BRIGHT_Y, "BRIGHTNESS");
  drawStepperCard(P1_SLEEP_Y, "SLEEP AFTER");
  drawStepperCard(P1_VOL_Y, "VOLUME");
  // SOUND toggle drawn by renderControlsPage (look changes with state).
}

void renderControlsPage() {
  char buf[16];
  int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  int btnY = stepBtnY(P1_BRIGHT_Y);
  int barX = CARD_X + PAD + STEP_BTN_SIZE + 10;
  int barW = CARD_W - 2 * (PAD + STEP_BTN_SIZE + 10);
  snprintf(buf, sizeof(buf), "%d%%", brightnessPct);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(brightPctCache, sizeof(brightPctCache), buf, tft.width() / 2, btnY + 8, 2, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawBar(&brightBarCache, barX, btnY + 20, barW, 6, brightnessPct, COLOR_ACCENT);
  drawStepGlyph(0, CARD_X + PAD, btnY, "-", brightnessPct > BRIGHTNESS_MIN);
  drawStepGlyph(1, rightBtnX, btnY, "+", brightnessPct < 100);

  btnY = stepBtnY(P1_SLEEP_Y);
  formatSleepValue(buf, sizeof(buf));
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(sleepValCache, sizeof(sleepValCache), buf, tft.width() / 2, btnY + STEP_BTN_SIZE / 2, 2, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawStepGlyph(2, CARD_X + PAD, btnY, "-", sleepPresetIdx > 0);
  drawStepGlyph(3, rightBtnX, btnY, "+", sleepPresetIdx < SLEEP_PRESETS_COUNT - 1);

  btnY = stepBtnY(P1_VOL_Y);
  snprintf(buf, sizeof(buf), "%s", VOL_LABELS[volPresetIdx]);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(volValCache, sizeof(volValCache), buf, tft.width() / 2, btnY + STEP_BTN_SIZE / 2, 2, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawStepGlyph(4, CARD_X + PAD, btnY, "-", volPresetIdx > 0);
  drawStepGlyph(5, rightBtnX, btnY, "+", volPresetIdx < VOL_PRESETS_COUNT - 1);

  if ((int) beepEnabled != soundBtnCache) {
    soundBtnCache = (int) beepEnabled;
    uint16_t fill = beepEnabled ? COLOR_ACCENT : COLOR_CARD;
    tft.fillRoundRect(CARD_X, P1_SOUND_Y, CARD_W, P1_SOUND_H, RADIUS, fill);
    tft.drawRoundRect(CARD_X, P1_SOUND_Y, CARD_W, P1_SOUND_H, RADIUS, beepEnabled ? COLOR_ACCENT : COLOR_LABEL);
    tft.setTextFont(2);
    tft.setTextColor(beepEnabled ? COLOR_BG : COLOR_LABEL, fill);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(beepEnabled ? "SOUND ON" : "SOUND OFF", tft.width() / 2, P1_SOUND_Y + P1_SOUND_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
}

// ----- Page 2: ACTIONS -----
void drawActionsPageStatic() {
  tft.setTextFont(2);
  tft.setTextDatum(MC_DATUM);
  tft.fillRoundRect(CARD_X, P2_CAL_Y, CARD_W, P2_BTN_H, RADIUS, COLOR_CARD);
  tft.drawRoundRect(CARD_X, P2_CAL_Y, CARD_W, P2_BTN_H, RADIUS, COLOR_ACCENT);
  tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
  tft.drawString("CALIBRATE TOUCH", tft.width() / 2, P2_CAL_Y + P2_BTN_H / 2);
  tft.fillRoundRect(CARD_X, P2_PWR_Y, CARD_W, P2_BTN_H, RADIUS, COLOR_CARD);
  tft.drawRoundRect(CARD_X, P2_PWR_Y, CARD_W, P2_BTN_H, RADIUS, COLOR_BAD);
  tft.setTextColor(COLOR_BAD, COLOR_CARD);
  tft.drawString("POWER OFF", tft.width() / 2, P2_PWR_Y + P2_BTN_H / 2);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("deep sleep - touch screen to wake", tft.width() / 2, P2_PWR_Y + P2_BTN_H + 14);
  tft.setTextDatum(TL_DATUM);
}

// ----- Dispatch -----
void drawSettingsStatic() {
  drawPager();
  if (settingsPage == 0) drawStatusPageStatic();
  else if (settingsPage == 1) drawControlsPageStatic();
  else drawActionsPageStatic();
}

void renderSettingsTab() {
  if (settingsPage == 0) renderStatusPage();
  else if (settingsPage == 1) renderControlsPage();
  // page 2 is static
}

void resetSettingsCaches() {
  btDotCache = -1; usbDotCache = -1; battRowCache = -1; battRowTextCache[0] = '\0';
  soundBtnCache = -1; brightBarCache = -1;
  brightPctCache[0] = '\0'; sleepValCache[0] = '\0'; volValCache[0] = '\0';
  for (int i = 0; i < 6; i++) stepGlyphCache[i] = -1;
}

void gotoSettingsPage(int p) {
  settingsPage = (p + SETTINGS_PAGES) % SETTINGS_PAGES;
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}

// Left/right third of a stepper card counts as -/+ (resistive touch is
// imprecise; nothing else on the card to mis-trigger).
bool stepperHit(int sx, int sy, int cardY, int* dir) {
  if (sy < cardY || sy >= cardY + STEPPER_CARD_H) return false;
  if (sx < CARD_X + CARD_W / 3) { *dir = -1; return true; }
  if (sx >= CARD_X + CARD_W * 2 / 3) { *dir = +1; return true; }
  return false;
}

void handleSettingsTouch(int sx, int sy) {
  // Pager band: left third = previous page, right third = next page.
  if (sy < PAGE_TOP) {
    if (sx < tft.width() / 3) gotoSettingsPage(settingsPage - 1);
    else if (sx >= tft.width() * 2 / 3) gotoSettingsPage(settingsPage + 1);
    return;
  }
  if (settingsPage == 1) {
    int dir;
    if (stepperHit(sx, sy, P1_BRIGHT_Y, &dir)) {
      setBacklight(brightnessPct + dir * BRIGHTNESS_STEP);
      saveBrightness();
      renderControlsPage();
    } else if (stepperHit(sx, sy, P1_SLEEP_Y, &dir)) {
      int idx = constrain(sleepPresetIdx + dir, 0, SLEEP_PRESETS_COUNT - 1);
      if (idx != sleepPresetIdx) { sleepPresetIdx = idx; applySleepPreset(); saveSleepTimeout(); renderControlsPage(); }
    } else if (stepperHit(sx, sy, P1_VOL_Y, &dir)) {
      int idx = constrain(volPresetIdx + dir, 0, VOL_PRESETS_COUNT - 1);
      if (idx != volPresetIdx) {
        volPresetIdx = idx; applyVolume(); saveVolume(); renderControlsPage();
        if (beepEnabled) startBeep(); // test the new level
      }
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H) {
      beepEnabled = !beepEnabled;
      saveBeepEnabled();
      if (beepEnabled) startBeep(); // confirmation doubles as a speaker test
      renderControlsPage();
    }
  } else if (settingsPage == 2) {
    if (sy >= P2_CAL_Y && sy < P2_CAL_Y + P2_BTN_H) {
      runCalibration();
      everReceived = false;
      tft.fillScreen(COLOR_BG);
      drawTabBar();
      drawFooterChrome();
      resetSettingsCaches();
      drawSettingsStatic();
      renderSettingsTab();
    } else if (sy >= P2_PWR_Y && sy < P2_PWR_Y + P2_BTN_H) {
      powerOff();
    }
  }
  // page 0 is read-only
}

void drawSettingsTab() {
  settingsPage = 0; // always enter on the STATUS page
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}

// ---------- Easter egg: the octopus ----------
// Tap the footer 5 times within 4 seconds. A Claude-orange octopus swims
// around until the next tap (or 30s). Frames render into a sprite and push
// whole, keeping the animation flicker-free; if the sprite allocation fails
// next to the BLE stack's heap use, it degrades to slower direct drawing.
TFT_eSprite octoSprite = TFT_eSprite(&tft);
bool octoActive = false;
bool octoSpriteOk = false;
unsigned long octoStartMillis = 0;
unsigned long octoLastFrameMillis = 0;
const int OCTO_W = 184;
const int OCTO_H = 150;
const int OCTO_X = (240 - OCTO_W) / 2;
const int OCTO_Y = 70;

// Clawd - Claude Code's pixel mascot - decoded verbatim from the CLI's
// welcome-screen art ( ▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝ ), each half-block
// character expanded to its 2x2 pixel quadrants. '#' = body, 'E' = eye
// (a gap in the original, so the background shows through). The wider
// middle row's side nubs are the claws-or-tentacles of community debate.
const char* CLAWD_ROWS[5] = {
  "   ############  ",
  "   ##E######E##  ",
  " ################",
  "   ############  ",
  "    # #    # #   ",
};
const int CLAWD_COLS = 17;
const int CLAWD_SCALE = 10;

// Draws one frame at time t. `g` is either the sprite (ox/oy = 0) or the
// real screen in the no-RAM fallback (ox/oy = screen offset) - TFT_eSprite
// inherits from TFT_eSPI, so both take the same calls. All motion is in
// whole pixels, keeping the original's chunky aesthetic intact.
void drawClawd(TFT_eSPI& g, int ox, int oy, float t) {
  // Bubbles drift up behind Clawd.
  for (int b = 0; b < 3; b++) {
    float by = OCTO_H - fmodf(t * (12 + b * 6) + b * 50, (float) OCTO_H);
    int bx = ox + 24 + b * 66 + (int) (sinf(t + b * 2) * 5.0f);
    g.drawCircle(bx, oy + (int) by, 3 + b, COLOR_GOOD);
  }

  int bob = (int) (sinf(t * 1.8f) * 5.0f);
  int x0 = ox + (OCTO_W - CLAWD_COLS * CLAWD_SCALE) / 2;
  int y0 = oy + 55 + bob;
  bool blink = fmodf(t, 3.5f) < 0.2f;

  for (int r = 0; r < 5; r++) {
    for (int c = 0; c < CLAWD_COLS; c++) {
      char p = CLAWD_ROWS[r][c];
      if (p == ' ') continue;
      if (p == 'E' && !blink) continue; // open eye = gap; blink fills it
      int px = x0 + c * CLAWD_SCALE;
      int py = y0 + r * CLAWD_SCALE;
      // The side nubs sway like they're treading water...
      if (r == 2 && (c <= 2 || c >= 15)) {
        px += (int) (sinf(t * 2.6f + (c < 8 ? 0.0f : 3.1f)) * 3.0f);
      }
      // ...and the four feet paddle.
      if (r == 4) py += (int) (sinf(t * 5.0f + c) * 2.5f);
      g.fillRect(px, py, CLAWD_SCALE, CLAWD_SCALE, COLOR_ACCENT);
    }
  }
}

void renderOctoFrame() {
  float t = millis() / 1000.0f;
  lastActivityMillis = millis(); // the show counts as activity: no dozing off mid-swim
  if (octoSpriteOk) {
    octoSprite.fillSprite(COLOR_BG);
    drawClawd(octoSprite, 0, 0, t);
    octoSprite.pushSprite(OCTO_X, OCTO_Y);
  } else {
    tft.fillRect(OCTO_X, OCTO_Y, OCTO_W, OCTO_H, COLOR_BG);
    drawClawd(tft, OCTO_X, OCTO_Y, t);
  }
}

void startOctopus() {
  octoActive = true;
  octoStartMillis = millis();
  octoLastFrameMillis = 0;
  octoSpriteOk = octoSprite.createSprite(OCTO_W, OCTO_H) != nullptr;
  Serial.printf("OCTO: surfacing (sprite=%d)\n", (int) octoSpriteOk);
  tft.fillScreen(COLOR_BG);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("you found Clawd", tft.width() / 2, 28);
  tft.setTextFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("tap anywhere to send it home", tft.width() / 2, tft.height() - 12);
  tft.setTextDatum(TL_DATUM);
}

void stopOctopus() {
  octoActive = false;
  octoSprite.deleteSprite(); // hand the ~54KB back before normal rendering resumes
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (currentTab == TAB_USAGE) {
    resetUsageCaches();
    drawUsageStatic();
    renderUsageTab();
  } else if (currentTab == TAB_SESSIONS) {
    drawSessionsAll();
  } else {
    drawSettingsTab();
  }
  renderFooter();
}

// ---------- Tab switching ----------
void switchTab(Tab newTab) {
  if (newTab == currentTab) return;
  currentTab = newTab;
  showingDetail = false;
  drawTabBar();
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);

  if (currentTab == TAB_USAGE) {
    resetUsageCaches();
    drawUsageStatic();
    renderUsageTab();
  } else if (currentTab == TAB_SESSIONS) {
    drawSessionsAll();
  } else {
    drawSettingsTab();
  }
}

void openSessionDetail(int idx) {
  showingDetail = true;
  detailIndex = idx;
  copyField(detailId, sizeof(detailId), sessions[idx].id); // anchor by id, not index
  readerActive = false;
  readerPage = 0;
  drawSessionDetail(idx);
  buildDetailSignature(idx, detailSigCache, sizeof(detailSigCache));
}

void closeSessionDetail() {
  showingDetail = false;
  detailIndex = -1;
  detailId[0] = '\0';
  drawSessionsAll();
}

void handleTouch() {
  static bool wasTouching = false;
  static unsigned long lastPoll = 0;
  if (millis() - lastPoll < 40) return;
  lastPoll = millis();

  int sx, sy;
  bool touching = getTouchPoint(sx, sy);
  if (!touching || wasTouching) {
    wasTouching = touching;
    return;
  }
  wasTouching = true;
  lastActivityMillis = millis();
  lastNonIdleMillis = millis(); // interacting = not idle, postpone auto deep-sleep

  // First tap after sleep only wakes the screen - it doesn't also register
  // as a tab switch or button press on whatever happens to be underneath.
  if (isAsleep) {
    wakeUp();
    return;
  }

  if (octoActive) {
    stopOctopus();
    return;
  }

  if (readerActive) {
    handleReaderTouch(sx, sy);
    return;
  }

  Serial.printf("TOUCH raw=(%d,%d) sx=%d sy=%d showingDetail=%d currentTab=%d cal=(%d,%d,%d,%d)\n",
                lastRawX, lastRawY, sx, sy, showingDetail, (int) currentTab,
                calRawX1, calRawY1, calRawX2, calRawY2);

  if (showingDetail) {
    detailIndex = resolveDetailIndex(); // ensure the tap acts on the right session
    if (detailIndex < 0) { closeSessionDetail(); return; }
    if (!handleAskTouch(sx, sy)) closeSessionDetail();
    return;
  }

  if (sy < TAB_BAR_H) {
    int tabW = tft.width() / TAB_COUNT;
    Tab tapped = (Tab) constrain(sx / tabW, 0, TAB_COUNT - 1);
    switchTab(tapped);
    return;
  }

  // The footer has no controls - which makes it the perfect door for the
  // octopus: five quick taps within four seconds.
  if (sy >= contentBottom()) {
    static int footerTaps = 0;
    static unsigned long firstTapMillis = 0;
    if (millis() - firstTapMillis > 4000) footerTaps = 0;
    if (footerTaps == 0) firstTapMillis = millis();
    footerTaps++;
    if (footerTaps >= 5) {
      footerTaps = 0;
      startOctopus();
    }
    return;
  }

  if (currentTab == TAB_SESSIONS && sessionCount > 0 && sy >= SESSION_ROW_Y0) {
    int slot = sessionRowH + SESSION_ROW_GAP;
    int row = (sy - SESSION_ROW_Y0) / slot;
    int offsetInSlot = (sy - SESSION_ROW_Y0) % slot;
    if (row >= 0 && row < sessionCount && offsetInSlot < sessionRowH) openSessionDetail(row);
  }

  if (currentTab == TAB_SETTINGS) handleSettingsTouch(sx, sy);
}

// ---------- Serial protocol ----------
void handleLine(const String& line) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) return;

  usage.fiveHourPct = doc["fiveHourPct"].isNull() ? -1 : (int) round((double) doc["fiveHourPct"]);
  usage.fiveHourResetInMin = doc["fiveHourResetInMin"].isNull() ? -1 : (long) doc["fiveHourResetInMin"];
  usage.sessionTokens = doc["sessionTokens"] | 0UL;
  usage.sevenDayPct = doc["sevenDayPct"].isNull() ? -1 : (int) round((double) doc["sevenDayPct"]);
  usage.sevenDayResetInMin = doc["sevenDayResetInMin"].isNull() ? -1 : (long) doc["sevenDayResetInMin"];
  usage.weekAllTokens = doc["weekAllTokens"] | 0UL;
  usage.weekFableTokens = doc["weekFableTokens"] | 0UL;
  usage.weekFablePct = doc["weekFablePct"].isNull() ? -1 : (int) round((double) doc["weekFablePct"]);
  usage.quotaAgeSec = doc["quotaAgeSec"].isNull() ? -1 : (long) doc["quotaAgeSec"];

  if (!doc["hostSecondsSinceMidnight"].isNull()) {
    hostSecBase = (long) doc["hostSecondsSinceMidnight"];
    hostSecBaseMillis = millis();
  }

  // Snapshot the previous list so statusSinceMillis survives across polls
  // for sessions whose status didn't change (matched by name).
  static SessionInfo prevSessions[MAX_SESSIONS];
  memcpy(prevSessions, sessions, sizeof(prevSessions));
  int prevCount = sessionCount;

  sessionCount = 0;
  bool newlyAsking = false;
  JsonArray arr = doc["sessions"].as<JsonArray>();
  if (!arr.isNull()) {
    for (JsonObject s : arr) {
      if (sessionCount >= MAX_SESSIONS) break;
      SessionInfo& info = sessions[sessionCount];
      copyField(info.id, sizeof(info.id), s["id"] | "");
      copyField(info.name, sizeof(info.name), s["name"] | "?");
      copyField(info.status, sizeof(info.status), s["status"] | "waiting");
      copyField(info.path, sizeof(info.path), s["path"] | "");
      copyField(info.model, sizeof(info.model), s["model"] | "");
      copyField(info.branch, sizeof(info.branch), s["branch"] | "");
      info.askPid[0] = '\0';
      info.askKind[0] = '\0';
      info.askNonce[0] = '\0';
      info.askTitle[0] = '\0';
      info.askDetail[0] = '\0';
      info.askOptCount = 0;
      JsonObject ask = s["ask"];
      if (!ask.isNull()) {
        copyField(info.askPid, sizeof(info.askPid), ask["pid"] | "");
        copyField(info.askKind, sizeof(info.askKind), ask["kind"] | "");
        copyField(info.askNonce, sizeof(info.askNonce), ask["nonce"] | "");
        copyField(info.askTitle, sizeof(info.askTitle), ask["title"] | "");
        copyField(info.askDetail, sizeof(info.askDetail), ask["detail"] | "");
        // Defense in depth: the host already flattens control bytes, but any
        // that slip through render as garbage glyphs on this font, so blank
        // them to spaces here too.
        for (char* p = info.askTitle; *p; p++) if ((uint8_t) *p < 0x20) *p = ' ';
        for (char* p = info.askDetail; *p; p++) if ((uint8_t) *p < 0x20) *p = ' ';
        JsonArray opts = ask["options"].as<JsonArray>();
        if (!opts.isNull()) {
          for (JsonVariant o : opts) {
            if (info.askOptCount >= 4) break;
            copyField(info.askOpts[info.askOptCount], sizeof(info.askOpts[0]), o | "");
            info.askOptCount++;
          }
        }
      }
      info.statusSinceMillis = millis();
      info.beepsLeft = 0;
      info.nextBeepMillis = 0;
      bool wasAskingBefore = false;
      for (int j = 0; j < prevCount; j++) {
        // Match by id; name is only a fallback for a host that predates ids.
        bool match = info.id[0] ? strcmp(prevSessions[j].id, info.id) == 0
                                : strcmp(prevSessions[j].name, info.name) == 0;
        if (match) {
          wasAskingBefore = strcmp(prevSessions[j].status, "asking") == 0;
          if (strcmp(prevSessions[j].status, info.status) == 0) {
            info.statusSinceMillis = prevSessions[j].statusSinceMillis;
            info.beepsLeft = prevSessions[j].beepsLeft;
            info.nextBeepMillis = prevSessions[j].nextBeepMillis;
          }
          break;
        }
      }
      if (strcmp(info.status, "asking") == 0 && !wasAskingBefore) {
        newlyAsking = true;
        info.beepsLeft = 2; // reminders after the immediate beep below
        info.nextBeepMillis = millis() + REBEEP_INTERVAL_MS;
      }
      sessionCount++;
    }
  }
  sessionsTotal = doc["sessionsTotal"] | sessionCount;
  hiddenAskingCount = doc["hiddenAsking"] | 0;
  if (newlyAsking) {
    Serial.println("BEEP: session newly asking");
    startBeep();
  }

  lastRxMillis = millis();
  bool firstEver = !everReceived;
  everReceived = true;

  if (octoActive) return; // data absorbed; the octopus keeps the screen
  if (readerActive) {
    // Keep the reader up while its ask still exists; if the prompt was
    // answered elsewhere or timed out, land back on the sessions list.
    // Re-resolve by id so a reorder while reading doesn't point us at the
    // wrong session.
    detailIndex = resolveDetailIndex();
    bool askAlive = showingDetail && detailIndex >= 0 && sessions[detailIndex].askPid[0];
    if (askAlive) return;
    exitReaderToList();
    return;
  }

  if (firstEver) {
    drawTabBar();
    drawFooterChrome();
    if (currentTab == TAB_USAGE) drawUsageStatic();
    else if (currentTab == TAB_SESSIONS) drawSessionsAll();
    else drawSettingsStatic();
  }
  if (currentTab == TAB_USAGE) renderUsageTab();
  else if (currentTab == TAB_SESSIONS) renderSessionsTab();
  else renderSettingsTab();
  renderFooter();
}

class BLEServerCallbacksImpl : public BLEServerCallbacks {
  void onConnect(BLEServer* server) {
    bleConnected = true;
  }
  void onDisconnect(BLEServer* server) {
    bleConnected = false;
    BLEDevice::startAdvertising(); // resume advertising so the host can reconnect
  }
};

class BLERxCallbacks : public BLECharacteristicCallbacks {
  // Runs on BTC_TASK - must not render, beep, or touch any driver that
  // loopTask also uses (see bleRxStream comment). Buffer the bytes and get
  // out; zero timeout means a full buffer drops data rather than stalling
  // the Bluetooth stack (the host resends a full snapshot every 5s anyway).
  void onWrite(BLECharacteristic* characteristic) {
    String value = characteristic->getValue();
    if (bleRxStream && value.length() > 0) {
      xStreamBufferSend(bleRxStream, value.c_str(), value.length(), 0);
    }
  }
};

void setupBLE() {
  bleRxStream = xStreamBufferCreate(8192, 1); // several full JSON lines of headroom
  // Unique per board (from the factory eFuse MAC) so several units in one
  // room advertise different names and hosts don't cross-connect. The host
  // learns this exact name over USB (HELLO) and pins BLE to it.
  snprintf(deviceName, sizeof(deviceName), "Deckhand-%04X", (uint16_t)(ESP.getEfuseMac() & 0xFFFF));
  BLEDevice::init(deviceName);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new BLEServerCallbacksImpl());

  BLEService* service = bleServer->createService(BLE_SERVICE_UUID);

  bleTxChar = service->createCharacteristic(BLE_CHAR_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  bleTxChar->addDescriptor(new BLE2902());

  BLECharacteristic* rxChar = service->createCharacteristic(
      BLE_CHAR_RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxChar->setCallbacks(new BLERxCallbacks());

  service->start();
  // Deliberately do NOT advertise the 128-bit service UUID: it's 16 bytes,
  // and together with the now-longer unique name ("Deckhand-XXXX", 13 bytes)
  // it overflows the 31-byte advertisement, which drops the name - and the
  // host matches by name, not UUID. Leaving the UUID out keeps the full name
  // in the packet. (The service is still discoverable after connecting.)
  BLEDevice::startAdvertising();

  btMacAddress = BLEDevice::getAddress().toString();
  Serial.printf("BLE: advertising as \"%s\" at %s\n", deviceName, btMacAddress.c_str());
}

void setup() {
  Serial.begin(115200);
  setupBLE();

  tft.init();
  tft.setRotation(SCREEN_ROTATION);
  tft.fillScreen(COLOR_BG);

  // Attached *after* tft.init(), not before: TFT_eSPI's own init does a
  // plain pinMode()/digitalWrite(HIGH) on this pin (TFT_BL is defined in
  // User_Setup.h), which would silently strip the LEDC PWM attachment and
  // undo any dimming if this ran first.
  gpio_hold_dis((gpio_num_t) TFT_BL_PIN); // release powerOff()'s latch after a wake
  ledcAttach(TFT_BL_PIN, 5000, 8); // 5kHz, 8-bit duty (0-255)
  setBacklight(100); // full brightness until loadBrightness() runs, after prefs.begin()

  pinMode(AUDIO_EN_PIN, OUTPUT);
  digitalWrite(AUDIO_EN_PIN, HIGH); // amp muted until a beep plays
  ledcAttach(AUDIO_OUT_PIN, BEEP_FREQ, 8);
  ledcWrite(AUDIO_OUT_PIN, 0);

  pinMode(BOOT_BTN_PIN, INPUT_PULLUP); // board has its own 10K pull-up too

  touchSPI.begin(TOUCH_SCK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  ts.begin(touchSPI);

  loadOrRunCalibration();
  loadBrightness();
  loadSleepTimeout();
  loadBeepEnabled();
  loadVolume();
  pairingSecret = prefs.getString("blesecret", ""); // remote-answer auth key
  lastActivityMillis = millis(); // don't start the sleep countdown from millis()==0
  lastNonIdleMillis = millis();  // 20-min battery auto-sleep timer starts now

  // Announce our unique BLE name to the host over USB so it pins BLE to this
  // exact device. Opening the USB port resets the ESP32, so this boot-time
  // line reliably reaches a host that connects at any time.
  Serial.printf("HELLO %s\n", deviceName);

  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  tft.setTextFont(2);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("Waiting for host script...", 12, CONTENT_Y + 26);
  tft.drawString("Run host/index.mjs on your Mac", 12, CONTENT_Y + 48);
}

// Shared between the USB (polled Stream) and BLE (onWrite callback)
// transports, so whichever one the host actually has open drives the
// display identically.
void processCompletedLine(String& buf, unsigned long* lastRxTimestamp, bool fromUsb) {
  if (buf == "RECAL") {
    runCalibration();
    everReceived = false;
    tft.fillScreen(COLOR_BG);
    drawTabBar();
    drawFooterChrome();
    tft.setTextFont(2);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("Waiting for host script...", 12, CONTENT_Y + 26);
  } else if (buf.startsWith("PROVISION ")) {
    // Set the shared secret - ONLY over USB. A BLE peer must never be able to
    // provision its own key (that would defeat the whole scheme), so this is
    // ignored on the BLE path.
    if (fromUsb) {
      String sec = buf.substring(10);
      sec.trim();
      if (sec.length() >= 8 && sec != pairingSecret) {
        pairingSecret = sec;
        prefs.putString("blesecret", pairingSecret);
        Serial.println("PROVISION: pairing secret stored");
      }
      deviceNameReported = false; // re-announce our name after (re)provisioning
    }
  } else {
    *lastRxTimestamp = millis();
    handleLine(buf);
  }
  buf = "";
}

void feedChar(char c, String& buf, unsigned long* lastRxTimestamp, bool fromUsb) {
  if (c == '\n') {
    processCompletedLine(buf, lastRxTimestamp, fromUsb);
  } else if (c != '\r') {
    buf += c;
    if (buf.length() > 8000) buf = ""; // guard against garbage (ask payloads make lines longer)
  }
}

void pumpStream(Stream& s, String& buf, unsigned long* lastRxTimestamp) {
  while (s.available()) {
    feedChar((char) s.read(), buf, lastRxTimestamp, true); // Serial == USB
  }
}

void loop() {
  pumpStream(Serial, serialBufUSB, &lastRxUSBMillis);
  // BLE bytes were buffered by onWrite() on the Bluetooth task; parse and
  // render them here so every draw/beep happens on loopTask only.
  if (bleRxStream) {
    char chunk[64];
    size_t n;
    while ((n = xStreamBufferReceive(bleRxStream, chunk, sizeof(chunk), 0)) > 0) {
      for (size_t i = 0; i < n; i++) feedChar(chunk[i], serialBufBLE, &lastRxBLEMillis, false); // BLE, untrusted for PROVISION
    }
  }

  handleTouch();
  updateBeep();
  checkPowerButton();

  if (sleepTimeoutMs > 0 && !isAsleep && millis() - lastActivityMillis > sleepTimeoutMs) enterSleep();

  // A fresh, active session means the device is doing its job - not idle.
  // Stale data (host gone) does NOT count, so a disconnected device on
  // battery still powers down. Checked here (cheap) every loop.
  if (sessionCount > 0 && everReceived && (millis() - lastRxMillis) < 30000) {
    lastNonIdleMillis = millis();
  }
  // Auto deep-sleep only when genuinely on battery: no USB data for a full
  // minute (immune to the occasional slow host tick, unlike the 10s
  // usbLinkActive threshold) AND a battery is actually present. On USB power
  // the device stays up indefinitely regardless of idle time, as requested.
  bool onUsbPower = lastRxUSBMillis > 0 && (millis() - lastRxUSBMillis) < 60000;
  if (!onUsbPower && batteryPresent() && millis() - lastNonIdleMillis > AUTO_SLEEP_IDLE_MS) {
    autoDeepSleep();
  }

  // Sample even while asleep so the reading is already settled on wake, and
  // so a dead battery is visible in the serial log. Rendering stays gated
  // on !isAsleep below.
  static unsigned long lastBattSample = 0;
  if (millis() - lastBattSample > 1000) {
    lastBattSample = millis();
    sampleBattery();
    static unsigned long lastBattLog = 0;
    if (millis() - lastBattLog > 60000) {
      lastBattLog = millis();
      Serial.printf("BATT mv=%d pct=%d state=%d\n", batteryMv, batteryPct(), (int) batteryState());
    }

    // Reminder beeps for sessions STILL waiting on input, capped by the
    // per-session budget so it can never beep forever. Deliberately outside
    // the !isAsleep gate: the reminder matters most when the screen is dark.
    for (int i = 0; i < sessionCount; i++) {
      SessionInfo& s = sessions[i];
      if (s.beepsLeft > 0 && strcmp(s.status, "asking") == 0 &&
          millis() >= s.nextBeepMillis) {
        s.beepsLeft--;
        s.nextBeepMillis = millis() + REBEEP_INTERVAL_MS;
        Serial.printf("BEEP: reminder (%d left) - session still asking\n", s.beepsLeft);
        startBeep();
      }
    }
  }

  if (octoActive) {
    // Sprite mode animates smoothly at 25fps; the direct-draw fallback
    // repaints its whole region, so it runs slower to stay watchable.
    unsigned long frameInterval = octoSpriteOk ? 40 : 150;
    if (millis() - octoLastFrameMillis >= frameInterval) {
      octoLastFrameMillis = millis();
      renderOctoFrame();
    }
    if (millis() - octoStartMillis > 30000) stopOctopus(); // swims home on its own
  }

  // The reader is a static full-screen page: keep the display awake while
  // it's open, and keep the footer/tab renderers off its pixels.
  if (readerActive) lastActivityMillis = millis();

  if (!isAsleep && !octoActive && !readerActive) {
    static unsigned long lastFooterTick = 0;
    if (millis() - lastFooterTick > 1000) {
      lastFooterTick = millis();
      renderFooter();
      if (everReceived && currentTab == TAB_SETTINGS) renderSettingsTab();
      // Cheap when nothing changed (per-row/per-field caches); keeps the
      // "in this state for Xm" durations ticking between host polls.
      if (everReceived && currentTab == TAB_SESSIONS) renderSessionsTab();
    }
  }

  // Safety net: some ESP32 BLE library versions can leave advertising
  // stopped after a failed/incomplete connection attempt, with no event to
  // hook. Cheaply re-assert it periodically whenever nobody's connected.
  static unsigned long lastAdvCheck = 0;
  if (!bleConnected && millis() - lastAdvCheck > 5000) {
    lastAdvCheck = millis();
    BLEDevice::startAdvertising();
  }
}
