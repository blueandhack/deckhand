// Touch: raw reads, the 5-point affine calibration, and screen orientation.
// Split out of deckhand_display.ino. The Arduino build concatenates every .ino
// in this folder into ONE translation unit - main file first (it matches the
// folder name), then the rest alphabetically - so these still share every global
// and there are no headers. Verified before splitting: no function signature in
// this sketch names a type declared after the first function definition, which
// is what would break the auto-generated prototypes.

void loadScreenFlip() { screenFlipped = prefs.getBool("flip", false); }
void saveScreenFlip() { prefs.putBool("flip", screenFlipped); }
void applyScreenRotation() { tft.setRotation(screenFlipped ? 2 : SCREEN_ROTATION); }
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
bool getTouchPoint(int& sx, int& sy) {
  if (!ts.touched()) return false;
  int16_t rx, ry;
  readRawTouch(rx, ry);
  lastRawX = rx;
  lastRawY = ry;
  sx = constrain((int) lroundf(calAff[0] * rx + calAff[1] * ry + calAff[2]), 0, tft.width() - 1);
  sy = constrain((int) lroundf(calAff[3] * rx + calAff[4] * ry + calAff[5]), 0, tft.height() - 1);
  // The touch panel is glued to the glass and does NOT rotate with the image, so
  // when the display is flipped the same physical press lands at the mirrored
  // screen coordinate. Mirroring here keeps ONE calibration valid for both
  // orientations - flipping never asks the user to recalibrate.
  if (screenFlipped) {
    sx = tft.width() - 1 - sx;
    sy = tft.height() - 1 - sy;
  }
  return true;
}
