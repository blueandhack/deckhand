// Touch, behind one entry point, over two panels that have nothing physical in
// common. Board 1 is a resistive XPT2046 on its own SPI bus, read as a raw ADC
// pair and mapped through a 5-point affine fit that a person has to tap in.
// Board 2's controller is integrated into the ST77922 display IC: capacitive,
// on I2C, and factory-aligned, so it hands over panel coordinates directly and
// there is nothing to calibrate.
//
// The UI calls the three functions below and nothing else, so no screen,
// handler or gesture knows which panel it is running on. getTouchPoint() keeps
// its ORIGINAL name and signature for exactly that reason - it moved here from
// touch_cal.ino unchanged rather than being rewritten, so board 1's ~40 call
// sites are untouched by this split.
//
// The three surfaces, and why there are three rather than the one the plan
// named:
//   getTouchPoint(sx, sy) - a mapped press, or false. The UI's only reader.
//   touchPressed()        - "is a finger down right now", the primitive behind
//                           the recording stop debounce (audio.ino, three
//                           sites), micWaitRelease(), and setup()'s
//                           WAKE_HOLD_MS held-touch qualification. On board 1
//                           this was `ts.touched()` written out at each site,
//                           and `ts` does not exist on board 2 at all.
//   touchBegin()          - bring the controller up. Two buses, two libraries,
//                           one call.
// Board 1's calibration code (touch_cal.ino) still calls ts.touched()/
// ts.getPoint() directly, deliberately: that whole path is board-1-only by
// definition - there is no calibration to run on a factory-aligned panel - so
// routing it through the HAL would add indirection that only ever resolves one
// way.

#if !BOARD_TOUCH_NEEDS_CAL
#include "st77922_touch.h"
// One instance, brought up by touchBegin(). Not a pointer: the driver holds
// only its TouchInfo and the INT pin number, so there is nothing to allocate
// and nothing to fail before the bus is even probed.
ST77922Touch g_touch;
#endif

// ---------------------------------------------------------------------------
void touchBegin() {
#if BOARD_TOUCH_NEEDS_CAL
  // Its own HSPI bus, independent of the TFT's - see the pin table in
  // board_e32r28t.h. Costs nothing to bring up, which is what lets setup()
  // qualify a deep-sleep wake before touching the radio or the panel.
  touchSPI.begin(TOUCH_SCK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  ts.begin(touchSPI);
#else
  if (!g_touch.begin(PIN_I2C_SDA, PIN_I2C_SCL, PIN_TOUCH_RST, PIN_TOUCH_INT)) {
    // Loud, because every touch from here on silently returns false and the
    // device looks like it has a dead screen rather than a dead bus.
    Serial.printf("TOUCH: ST77922 init FAILED (%s) - sda=%d scl=%d rst=%d int=%d\n",
                  g_touch.lastError(), PIN_I2C_SDA, PIN_I2C_SCL,
                  PIN_TOUCH_RST, PIN_TOUCH_INT);
    return;
  }
  const TouchInfo& ti = g_touch.info();
  Serial.printf("TOUCH: ST77922 chip_id=0x%02X fw=0x%02X rev=%02X%02X%02X%02X "
                "res=%ux%u max_points=%u checksum=%d\n",
                ti.chip_id, ti.fw_version, ti.fw_rev[0], ti.fw_rev[1],
                ti.fw_rev[2], ti.fw_rev[3], ti.x_res, ti.y_res,
                ti.max_points, (int) ti.checksum);
  // THE MISMATCH THAT WOULD BE INVISIBLE. The controller reports the
  // coordinate space it is scaling into, and we then use those numbers as
  // screen pixels with no transform at all. If it ever reports something else
  // - a 640x960 firmware, or a 0x0 read that got through - every tap lands at
  // half or twice the right place and the ONLY symptom is a UI that responds
  // in the wrong spot. That is far more expensive to debug than it is to
  // print, so it is printed. Deliberately not fatal and deliberately not
  // "corrected" by scaling: a guessed scale factor is a second thing to be
  // wrong about, and the panel is factory-aligned precisely so that no such
  // factor should exist.
  if (ti.x_res != BOARD_W || ti.y_res != BOARD_H) {
    Serial.printf("TOUCH: WARNING - controller reports %ux%u but this board is "
                  "%dx%d. Coordinates will be wrong by that ratio.\n",
                  ti.x_res, ti.y_res, BOARD_W, BOARD_H);
  }
  // Identity registers are the cheapest real evidence that the bus works at
  // all, so say so plainly when they are not what this part should answer.
  if (ti.chip_id != 0x83 && ti.chip_id != 0x84) {
    Serial.printf("TOUCH: WARNING - unexpected chip_id 0x%02X (expected 0x83 "
                  "or 0x84)\n", ti.chip_id);
  }
#endif
}

// ---------------------------------------------------------------------------
// "Is a finger down right now." Three callers poll this every ~10ms and
// require TWO CONSECUTIVE true reads before acting (the recording-stop
// debounce), so it has to stay asserted for the whole contact, not just for
// the leading edge - a normal tap is 80-150ms, and a primitive that only
// reports the edge would make stopping a recording fail intermittently in
// exactly the way the previously-fixed 120ms poll gate did.
//
// WHICH PRIMITIVE, on board 2: a full read(), NOT the INT line - and that was
// MEASURED on the panel, not reasoned about, because the two candidates differ
// by 1000x in cost and the cheap one fails silently.
//
// intAsserted() is a single GPIO read against read()'s measured 1125 us I2C
// transaction (200 idle calls, 400kHz, 42 bytes on the wire: a 2-byte register
// address plus a 4-byte header, 5 point slots of 7 bytes and a checksum). So
// the INT line is 1000x cheaper and would be the obvious choice if it held for
// the contact. IT DOES NOT. Sampled at the same 10ms cadence these callers use,
// across four real finger taps: read() reported a valid point in 8-11 polls of
// ~92 per second (i.e. ~100ms of contact each, which is a normal tap), while the
// INT line was low in 2, 0, 0 and 0 of those same polls. It PULSES per report
// rather than holding, so a two-consecutive-true debounce built on it would drop
// most taps - exactly the way the previously-fixed 120ms poll gate did, and
// exactly as silently.
//
// read() >= 1 means a finger is down because a valid point is being reported,
// which is true whatever the INT line does. The idle case is clean: 30 seconds
// with nothing on the glass produced zero reports, so this does not need a
// strength threshold or any other filter on top. Cost at the 10ms cadence is
// ~11% of one core, and it is spent only on the blocking paths (recording,
// wait-for-release, the wake guard) where nothing else is competing for it.
// If that ever needs cutting, the lever is the LENGTH of the read - 1 point
// slot instead of 5 is 12 bytes instead of 42 - not the INT line.
bool touchPressed() {
#if BOARD_TOUCH_NEEDS_CAL
  return ts.touched();
#else
  ST77922Point p[1];
  return g_touch.read(p, 1) >= 1;
#endif
}

// ---------------------------------------------------------------------------
bool getTouchPoint(int& sx, int& sy) {
#if BOARD_TOUCH_NEEDS_CAL
  if (!ts.touched()) return false;
  int16_t rx, ry;
  readRawTouch(rx, ry);
  lastRawX = rx;
  lastRawY = ry;
  sx = constrain((int) lroundf(calAff[0] * rx + calAff[1] * ry + calAff[2]), 0, tft.width() - 1);
  sy = constrain((int) lroundf(calAff[3] * rx + calAff[4] * ry + calAff[5]), 0, tft.height() - 1);
#else
  ST77922Point p[1];
  // A negative return is an I2C or checksum error, zero is "no finger" - both
  // are "no press", and neither is worth logging from a function polled every
  // few milliseconds.
  if (g_touch.read(p, 1) < 1) return false;
  // Already panel coordinates: the controller is factory-aligned, which is
  // the whole reason board 2 has no calibration. lastRawX/Y still carry the
  // pre-clamp values, so the TOUCH debug line means the same thing on both
  // boards - "what the controller said" next to "where we decided that was".
  lastRawX = (int16_t) p[0].x;
  lastRawY = (int16_t) p[0].y;
  sx = constrain((int) p[0].x, 0, tft.width() - 1);
  sy = constrain((int) p[0].y, 0, tft.height() - 1);
#endif
  // The touch panel is glued to the glass and does NOT rotate with the image, so
  // when the display is flipped the same physical press lands at the mirrored
  // screen coordinate. Mirroring here keeps ONE calibration valid for both
  // orientations - flipping never asks the user to recalibrate. It applies to
  // board 2 for the same physical reason even though there is no calibration
  // to preserve: the sensor is in the display IC, but its coordinate frame is
  // the panel's, not the rotated image's.
  if (screenFlipped) {
    sx = tft.width() - 1 - sx;
    sy = tft.height() - 1 - sy;
  }
  return true;
}
