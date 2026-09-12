// Touch: raw reads, the 5-point affine calibration, and screen orientation.
// Split out of deckhand_display.ino. The Arduino build concatenates every .ino
// in this folder into ONE translation unit - main file first (it matches the
// folder name), then the rest alphabetically - so these still share every global
// and there are no headers. Verified before splitting: no function signature in
// this sketch names a type declared after the first function definition, which
// is what would break the auto-generated prototypes.
//
// Everything below the shared flip/rotation helpers is BOARD 1 ONLY, and it is
// board-1-only by definition rather than by convenience: board 2's touch
// controller is integrated into the ST77922 display IC and is factory-aligned,
// so there is no raw ADC pair to map and no fit to solve. Board 2 keeps only
// loadOrRunCalibration(), which opens the NVS namespace every other loader in
// setup() reads from and validates nothing, because there is nothing to validate.
// It used to keep a runCalibration() stub as well; that is deleted, and RECAL -
// documented as the escape hatch for misaligned touch - is refused BY NAME on that
// board instead, so the honest answer reaches the Mac rather than only the glass.
// The one entry point both boards share, getTouchPoint(), moved to touch_hal.ino
// alongside touchPressed() and touchBegin().

void loadScreenFlip() { screenFlipped = prefs.getBool("flip", false); }
void saveScreenFlip() { prefs.putBool("flip", screenFlipped); }
void applyScreenRotation() { tft.setRotation(screenFlipped ? 2 : SCREEN_ROTATION); }

#if BOARD_TOUCH_NEEDS_CAL
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
  // Unbounded: runCalibration() waits here for a person to notice and tap the
  // crosshair, which can run well past a moment. See reapBleLinks()'s own
  // comment; safe here for the same reason it's safe in every other blocking
  // loop it's called from - this runs on loopTask throughout.
  while (!ts.touched()) {
    reapBleLinks(true);
#if !BOARD_USES_TFT_ESPI
    // UNREACHABLE as things stand, and kept deliberately: this whole function
    // now sits inside #if BOARD_TOUCH_NEEDS_CAL, and the only board that needs
    // calibration is also the only one that uses TFT_eSPI, so the two guards
    // currently exclude each other. It stays because it is the CORRECT thing
    // for a resistive panel on a shimmed surface - a board 3 with that pairing
    // would need it - and because deleting it would put the reasoning below
    // back into someone's head instead of into the file.
    // The crosshair/prompt drawn by the caller (runCalibration) never reaches
    // the glass otherwise: this loop can block for as long as it takes a
    // person to notice and tap, and loop()'s own end-of-iteration flush never
    // runs while we're in here.
    tft.flush();
#endif
    delay(20);
  }  // true: blocking path
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
  while (ts.touched()) { reapBleLinks(true); delay(20); } // wait for release; true: blocking path
  delay(200);
}
void drawCrosshair(int x, int y) {
  // COLOR_VALUE, not TFT_WHITE: calibration clears to COLOR_BG first, so a literal white
  // crosshair is invisible under the LIGHT theme and the user cannot finish a calibration
  // they cannot see. The token is near-black on LIGHT and white on DARK - correct in both.
  tft.drawFastHLine(x - 10, y, 21, COLOR_VALUE);
  tft.drawFastVLine(x, y - 10, 21, COLOR_VALUE);
}
// Least-squares affine fit over the CAL_N samples. Both axes share the same
// 3x3 normal-equation matrix (only the right-hand side differs), so this
// inverts it once. Returns false if the matrix is singular - which means the
// taps were collinear or wildly wrong, and the old mapping should be kept.
bool fitAffine(const int16_t* rx, const int16_t* ry, float* out) {
  double Sxx=0, Sxy=0, Sx=0, Syy=0, Sy=0, n = CAL_N;
  double Bx[3] = {0,0,0}, By[3] = {0,0,0};
  for (int i = 0; i < CAL_N; i++) {
    double X = rx[i], Y = ry[i];
    Sxx += X*X; Sxy += X*Y; Sx += X; Syy += Y*Y; Sy += Y;
    Bx[0] += X*CAL_PX[i]; Bx[1] += Y*CAL_PX[i]; Bx[2] += CAL_PX[i];
    By[0] += X*CAL_PY[i]; By[1] += Y*CAL_PY[i]; By[2] += CAL_PY[i];
  }
  double M[3][3] = {{Sxx,Sxy,Sx},{Sxy,Syy,Sy},{Sx,Sy,n}};
  double c00 = M[1][1]*M[2][2]-M[1][2]*M[2][1];
  double c01 = M[1][2]*M[2][0]-M[1][0]*M[2][2];
  double c02 = M[1][0]*M[2][1]-M[1][1]*M[2][0];
  double det = M[0][0]*c00 + M[0][1]*c01 + M[0][2]*c02;
  if (fabs(det) < 1e-6) return false;
  double inv[3][3] = {
    { c00/det, (M[0][2]*M[2][1]-M[0][1]*M[2][2])/det, (M[0][1]*M[1][2]-M[0][2]*M[1][1])/det },
    { c01/det, (M[0][0]*M[2][2]-M[0][2]*M[2][0])/det, (M[0][2]*M[1][0]-M[0][0]*M[1][2])/det },
    { c02/det, (M[0][1]*M[2][0]-M[0][0]*M[2][1])/det, (M[0][0]*M[1][1]-M[0][1]*M[1][0])/det }};
  for (int r = 0; r < 3; r++) {
    out[r]     = (float)(inv[r][0]*Bx[0] + inv[r][1]*Bx[1] + inv[r][2]*Bx[2]);
    out[r + 3] = (float)(inv[r][0]*By[0] + inv[r][1]*By[1] + inv[r][2]*By[2]);
  }
  return true;
}
void runCalibration() {
  // Always calibrate in the UNFLIPPED frame. calData maps raw touch -> screen
  // coords, and getTouchPoint() mirrors that result when the screen is flipped;
  // if we calibrated while flipped, the crosshairs would be drawn mirrored and
  // the saved mapping would come out inverted. Restored at the end.
  tft.setRotation(SCREEN_ROTATION);
  tft.fillScreen(COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  int16_t rx[CAL_N], ry[CAL_N];
  for (int i = 0; i < CAL_N; i++) {
    tft.fillScreen(COLOR_BG);
    tft.drawString("Touch calibration", 12, 16);
    char msg[32];
    snprintf(msg, sizeof(msg), "Touch the crosshair  %d/%d", i + 1, CAL_N);
    tft.drawString(msg, 12, 34);
    drawCrosshair(CAL_PX[i], CAL_PY[i]);
    waitForStableTouch(rx[i], ry[i]);
    delay(250);   // let the finger lift, so the next target isn't taken instantly
  }

  float fit[6];
  if (!fitAffine(rx, ry, fit)) {
    // Collinear or nonsense taps: keep whatever mapping we had rather than
    // installing one that would make the screen unusable.
    Serial.println("CAL: fit failed (singular) - keeping the previous calibration");
    tft.fillScreen(COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(COLOR_BAD, COLOR_BG);
    tft.drawString("Calibration failed - try again", tft.width() / 2, tft.height() / 2);
    tft.setTextDatum(TL_DATUM);
    delay(1500);
    return;
  }
  // Residual at the targets: a good run lands within a couple of pixels. This
  // is the honest check that the taps were actually good - a 2-point fit could
  // never report this, because it passes exactly through both points by
  // construction no matter how badly they were tapped.
  float worst = 0;
  for (int i = 0; i < CAL_N; i++) {
    float ex = fit[0]*rx[i] + fit[1]*ry[i] + fit[2] - CAL_PX[i];
    float ey = fit[3]*rx[i] + fit[4]*ry[i] + fit[5] - CAL_PY[i];
    float e = sqrtf(ex*ex + ey*ey);
    if (e > worst) worst = e;
  }
  memcpy(calAff, fit, sizeof(calAff));
  prefs.putBytes("cal5", calAff, sizeof(calAff));
  prefs.putBool("calValid5", true);
  calValid = true;
  Serial.printf("CAL: %d-point affine fit, worst residual %.1f px\n", CAL_N, worst);

  tft.fillScreen(COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(worst <= 6.0f ? COLOR_GOOD : COLOR_WARN, COLOR_BG);
  char done[40];
  snprintf(done, sizeof(done), worst <= 6.0f ? "Calibrated  (%.1f px)" : "Calibrated, but loose (%.1f px)", worst);
  tft.drawString(done, tft.width() / 2, tft.height() / 2);
  tft.setTextDatum(TL_DATUM);
  delay(1200);
}
void loadOrRunCalibration() {
  prefs.begin("core", false);
  // "5" suffix: v1 stored corrupted data, v2 used the wrong touch axis mapping,
  // and v3 held a 2-point LINEAR fit whose bytes mean nothing to the affine
  // model. Bumping the key deliberately ignores all of them and forces one
  // fresh run rather than silently misreading old data as coefficients.
  calValid = prefs.getBool("calValid5", false);
  if (calValid) {
    prefs.getBytes("cal5", calAff, sizeof(calAff));
  } else {
    runCalibration();
  }
}
#else   // !BOARD_TOUCH_NEEDS_CAL - board 2's capacitive, factory-aligned panel

// THERE IS NO runCalibration() ON THIS BOARD, and its absence is the point rather
// than an omission. It used to be a stub here: it printed a line and drew "Touch is
// factory-aligned / nothing to calibrate" for 1200ms, because RECAL is the
// documented escape hatch for touch that lands in the wrong place and someone
// reaching for it was owed an answer.
//
// THAT ANSWER WENT TO THE GLASS AND NOT TO THE MAC, which is the half that
// mattered. RECAL is driven from ~/.claude/deckhand-device-command far more often
// than by someone standing at the device, and over the wire a stub that printed and
// returned was indistinguishable from a calibration that had run - the exact shape
// CLAUDE.md's "every refusal must NAME ITS CAUSE" exists to stop. So the verb is now
// refused by name from UNAVAILABLE_COMMANDS[] under `#if !BOARD_TOUCH_NEEDS_CAL`,
// which reaches the Mac over whichever transport asked, and with CALIBRATE TOUCH
// absent from this board's Device group and its CFM_RECAL arms behind the same flag
// there is no caller left. A function nothing can reach is not a gentler answer than
// a refusal; it is a second place for the truth to drift from.
//
// prefs.begin() still has to happen here, and ONLY here: every loader called
// after this in setup() (theme, brightness, sleep timeout, beep, volume, screen
// flip) reads that same namespace, and this is where board 1 opens it. Dropping
// the call along with the calibration would leave all of them reading defaults
// on board 2 - a whole page of settings that silently forgets itself.
void loadOrRunCalibration() {
  prefs.begin("core", false);
  calValid = true;   // there is nothing to validate, and the affine map is not
                     // consulted at all on this board (see getTouchPoint) -
                     // leaving it false would read as "touch is unusable until
                     // calibrated", which is the opposite of the truth here.
}
#endif  // BOARD_TOUCH_NEEDS_CAL
