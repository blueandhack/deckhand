// anim.ino - board 2's animation core: easing, one tween, its frame clock, and the
// press highlight that drives it (further down). ONE #if, the same shape as
// scrollback.ino: board 1 draws straight to the glass and has no flush to composite
// a layer into. See docs/reference/animation.md and
// docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md.
//
// NOTHING IN THIS FILE DRAWS INTO THE FRAMEBUFFER. The press layer is
// PanelShim::setOverlay(), blended on the way out by flush(); anim-check.mjs fails
// by name if a drawing primitive appears here.
#if BOARD_HAS_ANIM

// ---------- EASING ----------
// 33 entries over t = 0..32, output 0..1024, interpolated linearly between entries.
// Generated once (docs/reference/animation.md has the snippet):
//   cubic: 1 - (1-t)^3
//   back:  1 + (c+1)(t-1)^3 + c(t-1)^2, c = 1.5 - the c that peaks at exactly 1.08
// anim-check.mjs validates their SHAPE, not equality to a formula.
static const int16_t EASE_OUT_CUBIC[33] = {
  0, 93, 180, 262, 338, 409, 475, 536, 592, 644, 691, 735, 774, 810, 842, 870, 896,
  919, 938, 955, 970, 982, 993, 1001, 1008, 1013, 1017, 1020, 1022, 1023, 1024, 1024, 1024 };
static const int16_t EASE_OUT_BACK[33] = {
  0, 138, 265, 380, 485, 580, 665, 741, 808, 867, 918, 962, 999, 1030, 1054, 1074, 1088,
  1098, 1104, 1106, 1105, 1102, 1096, 1089, 1080, 1071, 1061, 1052, 1043, 1035, 1029, 1025, 1024 };
#define ANIM_EASE_CUBIC 0
#define ANIM_EASE_BACK  1

int animEase(uint8_t curve, unsigned long elapsed, unsigned long dur) {
  const int16_t* tab = curve == ANIM_EASE_BACK ? EASE_OUT_BACK : EASE_OUT_CUBIC;
  if (dur == 0 || elapsed >= dur) return tab[32];
  const unsigned long fx = elapsed * 32UL * 256UL / dur;   // 8.8 fixed position in the table
  const int i = (int) (fx >> 8), f = (int) (fx & 255);
  return tab[i] + ((tab[i + 1] - tab[i]) * f) / 256;
}

// ---------- THE TWEEN ----------
// ONE tween: the press layer's alpha. Piece 1 never needs two at once; piece 2
// designs its own machinery around the second framebuffer.
const unsigned long ANIM_FRAME_MS = 16;
int animR[6] = {0, 0, 0, 0, 0, 0};   // the lit rect: x, y, w, h, radius, identity key
bool animLit = false;
uint8_t animAlpha = 0;
bool animRunning = false;
uint8_t animFrom = 0, animTo = 0;
unsigned long animT0 = 0, animDur = 0, lastAnimFrameMs = 0;
// PERF anim. n=0 means nothing has animated since boot, which is a different
// statement from "it costs nothing" - the same rule PERF xfade follows.
uint32_t animFrames = 0, animFlushTotalUs = 0, animFlushWorstUs = 0;
uint16_t animTweens = 0;

void animLight(const int* r) {
  memcpy(animR, r, sizeof(animR));
  animLit = true;
}

void animSetAlpha(uint8_t a) {
  animAlpha = a;
  if (!animLit || a == 0) { tft.clearOverlay(); return; }
  tft.setOverlay(animR[0], animR[1], animR[2], animR[3], animR[4], COLOR_ACCENT, a);
}

void animTween(uint8_t to, unsigned long dur) {
  animFrom = animAlpha;
  animTo = to;
  animT0 = millis();
  animDur = dur;
  animRunning = true;
  lastAnimFrameMs = 0;       // the first frame goes out on the very next tick
  animTweens++;
}

// Drops the layer at once, no fade. The next flush pushes the rect without it.
void animClear() {
  animRunning = false;
  animLit = false;
  animAlpha = 0;
  tft.clearOverlay();
}

// One frame per ANIM_FRAME_MS, ONLY while the tween runs - at rest this is one
// comparison, the session crossfade's own contract. A frame is setOverlay plus a
// flush of the lit rect: no compose, the framebuffer is untouched.
// ---------- SCREEN TRANSITIONS ----------
// The OUTGOING screen is snapshotted into PanelShim's second buffer BEFORE the new
// one is drawn (transBegin, called at the hook), flushing is HELD while it draws,
// and the next animTick() - the first thing after the handler returns - releases
// the hold and runs the motion: flush() composites old and new by progress. The
// framebuffer always holds the true new screen, so anything that redraws during
// the motion is simply part of what slides in. See docs/reference/animation.md.
// Durations are TR_TAB_MS / TR_REVEAL_MS / TR_SHEET_MS in board_es3c35p.h: the hooks
// that pass them live in deckhand_display.ino, which is concatenated BEFORE this file.
uint8_t trKind = TR_NONE;
bool trPending = false, trRunning = false;
int trY0 = 0, trY1 = 0, trLastP = -1;
int trFrom[4] = {0, 0, 0, 0}, trTo[4] = {0, 0, 0, 0};   // reveal rects, logical x,y,w,h
unsigned long trElapsed = 0, trDur = 0, lastTrFrameMs = 0;
// PROGRESS IS FRAME TIME, CAPPED, NOT WALL-CLOCK. Opening a transcript wraps
// thousands of lines and absorbs the catch-up reply right after the first frame,
// stalling the loop past the whole 280ms - and wall-clock progress then jumped
// straight to the end: MEASURED, the sheet showed 1 frame of 8. A stall now slows
// the motion instead of deleting it.
const unsigned long TR_MAX_STEP_MS = 48;
int trFreezePct = -1;                                   // ANIMFREEZE: hold at this %, -1 = run
uint32_t trFrames = 0, trFlushTotalUs = 0, trFlushWorstUs = 0;
uint16_t trCount = 0, trSkipped = 0;

// Jumps any pending or running transition to its end: the glass shows the new
// screen alone. A press, a new transition and ANIMFREEZE off all land here, so
// nothing ever waits on motion.
void transFinish() {
  if (trPending) { trPending = false; tft.holdFlush(false); }
  if (!trRunning) { trKind = TR_NONE; return; }
  trRunning = false;
  trKind = TR_NONE;
  trLastP = -1;
  tft.clearTransition();
  tft.flush();
}

// AT THE HOOK, BEFORE the new screen is drawn. from/to are reveal rects (logical
// x,y,w,h) - ignored by the slides and sheets. A refused snapshot (no buffer, or
// the framebuffer is not what is on the glass) just lets the change land at once.
void transBegin(uint8_t kind, int y0, int y1, const int* from, const int* to, unsigned long dur) {
  // ALREADY PENDING: a second hook in the same loop iteration - the host's double
  // delivery of DETAIL, or one surface handing to the next. Nothing has reached the
  // glass since the snapshot (the flush is held), so the snapshot is still the
  // screen being left: keep it and retarget. Finishing it instead would release the
  // hold over a half-drawn frame and refuse the new snapshot - measured on the glass
  // as a DETAIL that never animated (PERF trans skipped=1).
  if (trPending) {
    trKind = kind; trY0 = y0; trY1 = y1; trDur = dur;
    if (from) memcpy(trFrom, from, sizeof(trFrom));
    if (to) memcpy(trTo, to, sizeof(trTo));
    return;
  }
  transFinish();
  // A SKIP NAMES ITS CAUSE: from the Mac, "it skipped" and "it ran" look identical
  // otherwise, and that ambiguity cost a debugging pass on the glass already.
  if (isAsleep) { trSkipped++; Serial.printf("TRANS skipped kind=%u: the screen is asleep\n", kind); return; }
  if (!tft.snapshotOld()) {
    trSkipped++;
    Serial.printf("TRANS skipped kind=%u: no snapshot - the framebuffer holds unflushed drawing, "
                  "so it is not what is on the glass\n", kind);
    return;
  }
  // AT FULL CLOCK. The board idles at 80 MHz and a finger boosts it to 240 for
  // 1.5s - but a transition can start with no finger at all (a TAB or DETAIL from
  // the Mac, a payload), and at 80 MHz a content-area frame MEASURED 57ms against
  // ~26: half the frames, visibly choppier. The boost outlives the motion.
  cpuBoost();
  tft.holdFlush(true);
  trKind = kind; trY0 = y0; trY1 = y1; trDur = dur;
  if (from) memcpy(trFrom, from, sizeof(trFrom));
  if (to) memcpy(trTo, to, sizeof(trTo));
  trPending = true;
}

// The content area (between the tab bar and the footer), and a small rect at its
// centre - where a reveal starts or ends when the row it belongs to is not on screen.
void transContentRect(int* r) {
  r[0] = 0; r[1] = TAB_BAR_H; r[2] = tft.width(); r[3] = contentBottom() - TAB_BAR_H;
}
void transCentreRect(int* r) {
  const int w = tft.width() / 4, h = (contentBottom() - TAB_BAR_H) / 8;
  r[0] = (tft.width() - w) / 2; r[1] = TAB_BAR_H + (contentBottom() - TAB_BAR_H - h) / 2;
  r[2] = w; r[3] = h;
}

static void transFrame(unsigned long now) {
  (void) now;
  int p = trFreezePct >= 0 ? trFreezePct * 1024 / 100 : animEase(ANIM_EASE_CUBIC, trElapsed, trDur);
  if (p < 0) p = 0;
  if (p > 1024) p = 1024;
  if (p == trLastP) return;          // a frozen frame is pushed once, not every tick
  trLastP = p;
  int off = 0, r[4] = {0, 0, 0, 0};
  if (trKind == TR_SLIDE_FROM_RIGHT || trKind == TR_SLIDE_FROM_LEFT) off = tft.width() * p / 1024;
  else if (trKind == TR_SHEET_UP || trKind == TR_SHEET_DOWN) off = (trY1 - trY0) * p / 1024;
  else for (int i = 0; i < 4; i++) r[i] = trFrom[i] + (trTo[i] - trFrom[i]) * p / 1024;
  tft.setTransition(trKind, trY0, trY1, off, r);
  tft.markRegion(trY0, trY1);
  const uint32_t t0 = micros();
  tft.flush();
  const uint32_t us = micros() - t0;
  trFrames++;
  trFlushTotalUs += us;
  if (us > trFlushWorstUs) trFlushWorstUs = us;
}

static void transGo() {
  trPending = false;
  tft.holdFlush(false);
  // NOTHING NEW WAS DRAWN: the hook's handler returned early (a same-tab tap, a
  // refusal). Running anyway would slide the screen into a copy of itself.
  if (!tft.drawnSinceSnapshot()) {
    Serial.printf("TRANS skipped kind=%u: nothing new was drawn after the hook\n", trKind);
    trKind = TR_NONE; trSkipped++; return;
  }
  trRunning = true;
  // ONE FRAME IN ALREADY: progress 0 is the old screen exactly, so pushing it
  // would spend a whole frame (a content-area flush) on no motion at all.
  trElapsed = ANIM_FRAME_MS;
  lastTrFrameMs = millis();
  trLastP = -1;
  trCount++;
  transFrame(lastTrFrameMs);
  if (trFreezePct >= 0) return;      // ANIMFREEZE: the loop's transTick() holds it
  // THE MOTION RUNS HERE, IN ONE SHORT LOOP (<= the transition's duration), the way
  // the drag lists already block - and that is measured, not a preference. Left to
  // loop(), a transcript's sheet competed with its own fetch: pumpStream drains a
  // whole chunk (JSON, re-wrap, full redraw) per pass, the loop got a turn every
  // ~200ms, and the 280ms sheet crawled up over a second in a few jumps.
  // A FINGER ENDS IT AT ONCE - the tap is then handled as usual on the next pass,
  // so nothing is lost - and BLE is reaped every frame, as the drag loops do.
  while (trRunning) {
    int tx, ty;
    if (getTouchPoint(tx, ty)) { transFinish(); return; }
    reapBleLinks(true);
    const unsigned long now = millis();
    const unsigned long dt = now - lastTrFrameMs;
    lastTrFrameMs = now;
    trElapsed += dt < TR_MAX_STEP_MS ? dt : TR_MAX_STEP_MS;
    if (trElapsed >= trDur) { transFinish(); return; }
    transFrame(now);
  }
}

static void transTick() {
  if (trPending) { transGo(); return; }
  if (!trRunning) return;
  const unsigned long now = millis();
  const unsigned long dt = now - lastTrFrameMs;
  if (dt < ANIM_FRAME_MS) return;
  lastTrFrameMs = now;
  trElapsed += dt < TR_MAX_STEP_MS ? dt : TR_MAX_STEP_MS;
  if (trFreezePct < 0 && trElapsed >= trDur) { transFinish(); return; }
  transFrame(now);
}

// ANIMFREEZE <0..100> holds every transition at that progress until ANIMFREEZE
// off, so a SCREENSHOT (readRect composites it) can record a mid-motion frame.
void animFreezeCommand(String arg) {
  arg.trim();
  if (arg == "off") {
    trFreezePct = -1;
    const bool was = trRunning;
    transFinish();
    Serial.printf("ANIMFREEZE off: transitions run again%s\n", was ? " - the held one jumped to its end" : "");
    return;
  }
  bool numeric = arg.length() > 0 && arg.length() <= 3;
  for (unsigned int i = 0; numeric && i < arg.length(); i++) if (arg[i] < '0' || arg[i] > '9') numeric = false;
  const int pct = numeric ? arg.toInt() : -1;
  if (pct < 0 || pct > 100) {
    Serial.printf("ANIMFREEZE refused: \"%s\" is not a progress percentage (0..100) or \"off\"\n", arg.c_str());
    return;
  }
  trFreezePct = pct;
  trLastP = -1;
  Serial.printf("ANIMFREEZE: transitions now hold at %d%% - %s\n", pct,
                trRunning ? "the running one is held there now" : "the next one (TAB, a row tap, a transcript) will stop there");
}

void animTick() {
  transTick();
  if (!animRunning) return;
  const unsigned long now = millis();
  if (lastAnimFrameMs != 0 && now - lastAnimFrameMs < ANIM_FRAME_MS) return;
  lastAnimFrameMs = now;
  const int e = animEase(ANIM_EASE_CUBIC, now - animT0, animDur);
  int a = (int) animFrom + ((int) animTo - (int) animFrom) * e / 1024;
  if (a < 0) a = 0;
  if (a > 255) a = 255;
  animSetAlpha((uint8_t) a);
  const uint32_t t0 = micros();
  tft.flush();
  const uint32_t us = micros() - t0;
  animFrames++;
  animFlushTotalUs += us;
  if (us > animFlushWorstUs) animFlushWorstUs = us;
  if (now - animT0 >= animDur) {
    animRunning = false;
    if (animTo == 0) animLit = false;   // faded out: the layer is gone
  }
}

// ---------- THE PRESS ----------
const uint8_t PRESS_ALPHA = 51;              // 20% toward COLOR_ACCENT
const unsigned long PRESS_IN_MS = 40, PRESS_OUT_MS = 120;
const int PRESS_SLOP_PX = 12;

// 0 = idle; 1 = HELD (a finger is down and the tap waits for its lift);
// 2 = CONSUMED (a blocking handler took the press and acts on its own).
uint8_t pressState = 0;
int pressX = 0, pressY = 0;
uint32_t pressSig = 0;
uint16_t pressSlides = 0, pressDrops = 0;

// Which handler a tap at this instant would reach, packed. Any change between
// press and lift means the lift would land somewhere the press did not.
// composeOnPanel(), not composeScreen: handleTouch() is the only router allowed
// to read the screen directly (settings-geom-check binds that).
uint32_t pressSurfaceSig() {
  uint32_t s = 0;
  s |= (uint32_t) composeActive;
  s |= (uint32_t) composeOnPanel() << 1;
  s |= (uint32_t) pairPanelActive << 2;
  s |= (uint32_t) micProcessing << 3;
  s |= (uint32_t) voiceCardActive << 4;
  s |= (uint32_t) readerActive << 5;
  s |= (uint32_t) histActive << 6;
  s |= (uint32_t) showingDetail << 7;
  s |= (uint32_t) ((int) currentTab & 7) << 8;
  s |= (uint32_t) (settingsPage & 15) << 11;
  s |= (uint32_t) ((int) pendingConfirm & 15) << 15;
#if BOARD_HAS_PROJECTS
  s |= (uint32_t) (projLevel & 3) << 19;
#endif
  // NOT detailIndex: renderSessionsTab() re-resolves it every tick, so a re-rank
  // during a hold changed it while the SAME card stayed up and dropped the tap.
  // A lit ask option carries the ask's own identity in askPressRect's r[5].
  return s;
}

bool tabPressRect(int sx, int* r) {
  const int tabW = tabsW() / TAB_COUNT;
  const int i = constrain(sx / tabW, 0, TAB_COUNT - 1);
  r[0] = i * tabW; r[1] = 0; r[2] = tabW; r[3] = TAB_BAR_H; r[4] = 0; r[5] = i;
  return true;
}

// The control under (sx, sy), in dispatchTap()'s own surface order. false = no
// covered control: the tap still acts on the lift, it just does not light.
bool pressRectAt(int sx, int sy, int* r) {
  bool lit;
  if (composeActive) lit = composeOnPanel() && !micProcessing && composePressRect(sx, sy, r);
  else if (pairPanelActive || micProcessing || voiceCardActive || readerActive || histActive) lit = false;
  else if (sy < TAB_BAR_H) return tabPressRect(sx, r);
  else if (showingDetail) lit = askPressRect(sx, sy, r);
  else if (sy >= contentBottom()) lit = false;
  else if (currentTab == TAB_SESSIONS) lit = sessionsPressRect(sx, sy, r);
#if BOARD_HAS_PROJECTS
  else if (currentTab == TAB_PROJECTS) lit = projPressRect(sx, sy, r);
#endif
  else if (currentTab == TAB_SETTINGS) lit = settingsPressRect(sx, sy, r);
  else lit = false;                // USAGE: the whole card area pages accounts
  if (!lit) return false;
  // A content rect never tints the chrome: clamp to the content area.
  if (r[1] < TAB_BAR_H) { r[3] -= TAB_BAR_H - r[1]; r[1] = TAB_BAR_H; }
  if (r[1] + r[3] > contentBottom()) r[3] = contentBottom() - r[1];
  return r[3] > 0;
}

// Does the press go to a handler that BLOCKS until the lift (a drag loop) and so
// must be dispatched on the press? Each half lives beside its handler and mirrors
// that handler's own entry condition.
bool tapBlocksUntilLift(int sx, int sy) {
  (void) sx;
  if (composeActive || pairPanelActive || micProcessing || voiceCardActive ||
      readerActive) return false;
  // histActive BEFORE showingDetail, in dispatchTap()'s own order: a transcript
  // opened from a SESSIONS detail card leaves showingDetail SET (exitScrollback()
  // returns to the card by it), and asking the card first made every drag on that
  // transcript wait for the lift - where the drag loop finds no finger at all.
#if BOARD_HISTORY_SCROLL
  if (histActive) return scrollTapBlocks(sy);
#endif
  if (histActive || showingDetail) return false;
  if (sy < TAB_BAR_H || sy >= contentBottom()) return false;
  if (currentTab == TAB_SESSIONS) return sessionsTapBlocks(sy);
#if BOARD_HAS_PROJECTS
  if (currentTab == TAB_PROJECTS) return projTapBlocks(sy);
#endif
  return false;
}

// The finger landed: remember where, and light the control if one is there.
void pressBegin(int sx, int sy) {
  transFinish();                     // a tap never waits on motion
  if (animLit) animClear();          // the last tap's release flash, still running
  pressX = sx; pressY = sy;
  pressState = 1;
  pressSig = pressSurfaceSig();
  int r[6];
  if (!pressRectAt(sx, sy, r)) return;
  animLight(r);
  animTween(PRESS_ALPHA, PRESS_IN_MS);
}

static bool pressInside(int sx, int sy) {
  if (!animLit) {
    const int dx = sx - pressX, dy = sy - pressY;
    return dx * dx + dy * dy <= PRESS_SLOP_PX * PRESS_SLOP_PX;
  }
  return sx >= animR[0] - PRESS_SLOP_PX && sx < animR[0] + animR[2] + PRESS_SLOP_PX &&
         sy >= animR[1] - PRESS_SLOP_PX && sy < animR[1] + animR[3] + PRESS_SLOP_PX;
}

// A held finger moved. Off the control (plus slop) cancels: the light fades and
// the lift will act on nothing.
void pressMove(int sx, int sy) {
  if (pressState != 1 || pressInside(sx, sy)) return;
  pressState = 0;
  pressSlides++;
  if (animLit) animTween(0, PRESS_OUT_MS);
}

// The finger lifted. true = act on (pressX, pressY) now. Re-checks that the same
// handler and the same control are still under the press point: acting on the lift
// opened a window the press-commit model never had, and a list that re-ranked or a
// panel that closed in it must DROP the tap, never redirect it.
bool pressLift() {
  if (pressState != 1) { pressState = 0; return false; }
  pressState = 0;
  int r[6];
  const bool lit = pressRectAt(pressX, pressY, r);
  const bool sameRect = lit == animLit && (!lit || memcmp(r, animR, sizeof(animR)) == 0);
  const bool surfaceMoved = pressSurfaceSig() != pressSig;
  if (surfaceMoved || !sameRect) {
    pressDrops++;
    Serial.printf("PRESS: dropped the tap at %d,%d - %s changed while the finger was down, "
                  "so the lift would have landed on a control nobody pressed\n",
                  pressX, pressY, surfaceMoved ? "the screen" : "the control under it");
    if (animLit) animTween(0, PRESS_OUT_MS);
    return false;
  }
  if (animLit) tft.watch(animR[0], animR[1], animR[2], animR[3]);
  return true;
}

// The press went to a handler that blocks until the lift and acts itself. The lift
// branch must not act a second time.
void pressConsume() {
  pressState = 2;
  if (animLit) tft.watch(animR[0], animR[1], animR[2], animR[3]);
}

// After the action ran, from either path. If it repainted its own control (a toggle
// flipped, a screen opened) that change is the feedback and the layer goes at once:
// a tint fading over a different screen would be a ghost. Otherwise, the release flash.
void pressAfterDispatch() {
  const bool redrawn = tft.watchHit();
  tft.unwatch();
  if (!animLit) return;
  if (redrawn) { animClear(); return; }
  animTween(0, PRESS_OUT_MS);
}

// A blocking list decided DRAG, or PRESSTEST off: drop the layer now, before
// anything moves under it.
void pressCancel() {
  pressState = 0;
  tft.unwatch();
  if (animLit) { animClear(); tft.flush(); }
}

// ---------- PRESSTEST ----------
// Lights the press layer at a point and HOLDS it, so a SCREENSHOT can confirm the
// rect sits on the control (readRect applies the layer). Never dispatches: pressState
// stays 0, so a real lift cannot act on it, and the next real press clears it.
void pressTestCommand(String arg) {
  arg.trim();
  if (arg == "off") {
    if (!animLit) { Serial.println("PRESSTEST off: nothing is lit, so there is nothing to release"); return; }
    pressCancel();
    Serial.println("PRESSTEST off: released WITHOUT acting - nothing was dispatched");
    return;
  }
  const char* onPress = isAsleep        ? "the screen is asleep - a tap there only wakes it"
                      : octoActive      ? "the octopus is up - any tap dismisses it, on the press"
                      : emojiTestActive ? "the icon grid is up - any tap dismisses it, on the press"
                      : composeOnKeys() ? "the keyboard is up - its key band arms on the press and commits on its own lift"
                      : nullptr;
  if (onPress) { Serial.printf("PRESSTEST refused: %s, so there is no held state to light\n", onPress); return; }
  const int sp = arg.indexOf(' ');
  bool numeric = sp > 0 && sp < (int) arg.length() - 1;
  for (unsigned int i = 0; numeric && i < arg.length(); i++)
    if ((int) i != sp && (arg[i] < '0' || arg[i] > '9')) numeric = false;
  if (!numeric) {
    Serial.printf("PRESSTEST refused: \"%s\" is not \"<x> <y>\" (x 0..%d, y 0..%d) or \"off\"\n",
                  arg.c_str(), tft.width() - 1, tft.height() - 1);
    return;
  }
  const int x = arg.substring(0, sp).toInt(), y = arg.substring(sp + 1).toInt();
  if (x >= tft.width() || y >= tft.height()) {
    Serial.printf("PRESSTEST refused: %d,%d is off the panel (x 0..%d, y 0..%d)\n",
                  x, y, tft.width() - 1, tft.height() - 1);
    return;
  }
  int r[6];
  if (!pressRectAt(x, y, r)) {
    Serial.printf("PRESSTEST refused: nothing lights at %d,%d - no covered control is there "
                  "(docs/reference/animation.md lists what piece 1 covers)\n", x, y);
    return;
  }
  // The host delivers every command over BOTH transports. Lighting is idempotent,
  // but say so rather than re-flushing, so the log shows the second copy arrived.
  if (animLit && !animRunning && animAlpha == PRESS_ALPHA && memcmp(r, animR, sizeof(animR)) == 0) {
    Serial.printf("PRESSTEST: already lit at %d,%d %dx%d - the second copy of a double-delivered command, nothing to do\n",
                  r[0], r[1], r[2], r[3]);
    return;
  }
  pressCancel();
  animLight(r);
  animSetAlpha(PRESS_ALPHA);
  tft.flush();
  Serial.printf("PRESSTEST: lit %d,%d %dx%d r=%d at alpha %d for the point %d,%d - SCREENSHOT shows it; PRESSTEST off releases without acting\n",
                r[0], r[1], r[2], r[3], r[4], PRESS_ALPHA, x, y);
}

#else
// Board 1: no layer to light. Stubs so the board-2 drag loops carry no #if of
// their own if a future board ever has a scrolling list without this flag.
static inline void animTick() {}
static inline void pressCancel() {}
#endif  // BOARD_HAS_ANIM
