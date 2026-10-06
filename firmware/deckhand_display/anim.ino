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
void animTick() {
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

#else
// Board 1: no layer to light. Stubs so the board-2 drag loops carry no #if of
// their own if a future board ever has a scrolling list without this flag.
static inline void animTick() {}
static inline void pressCancel() {}
#endif  // BOARD_HAS_ANIM
