// loaders.ino - board 2's loading states: the SKELETON (placeholder rows in the
// real layout, with a light that sweeps across them) for waits that have no
// progress to report - the PROJECTS lists and a session's FOCUS detail - and the
// tick that also drives the conversation's progress bar (scrollback.ino owns that
// bar, beside the fetch it measures). See docs/reference/animation.md.
//
// EVERY WAIT IS SILENT FOR ITS FIRST LOADER_DELAY_MS: most of these replies land
// in ~200ms, and a skeleton that flashes up for one frame is noise, not feedback.
// CHANGE-ONLY like every other field on this device: a bar is repainted only when
// its light level changes, never cleared and redrawn.
#if BOARD_HAS_ANIM

#define SKEL_NONE   0
#define SKEL_PROJ0  1    // PROJECTS level 0: the project list
#define SKEL_PROJ1  2    // PROJECTS level 1: one project's sessions
#define SKEL_DETAIL 3    // a SESSIONS detail card waiting on FOCUS

const int SKEL_MAX = 16;
struct SkelBar { int16_t x, y, w, h; uint16_t bg; int8_t lv; };
SkelBar skelBars[SKEL_MAX];
int skelN = 0;
uint8_t skelOwner = SKEL_NONE;
bool skelPainted = false;
unsigned long skelArmMs = 0, lastSkelMs = 0;

// The surface the skeleton belongs to is up and has not been covered. Asked on
// EVERY tick before anything is painted, so a reply that replaced the skeleton in
// the same loop iteration can never be painted over.
static bool skelSurfaceFree() {
  return !composeActive && !histActive && !readerActive && !pairPanelActive &&
         !emojiTestActive && !octoActive && !isAsleep && !voiceCardActive && !micProcessing;
}
static bool skelValid() {
  if (!skelSurfaceFree()) return false;
  switch (skelOwner) {
    case SKEL_PROJ0:  return projSkelValid(0);
    case SKEL_PROJ1:  return projSkelValid(1);
    case SKEL_DETAIL: return detailSkelValid();
    default:          return false;
  }
}

// A wait began: forget any old bars. `paintNow` is for a caller that lays the
// bars out itself as part of a larger draw (the detail card); otherwise the
// owner's layout runs from the tick once LOADER_DELAY_MS has passed.
void skelArm(uint8_t owner, bool paintNow) {
  skelOwner = owner;
  skelN = 0;
  skelArmMs = millis();
  skelPainted = paintNow;
}

void skelAdd(int x, int y, int w, int h, uint16_t bg) {
  if (skelN >= SKEL_MAX || w <= 0 || h <= 0) return;
  skelBars[skelN].x = x; skelBars[skelN].y = y; skelBars[skelN].w = w; skelBars[skelN].h = h;
  skelBars[skelN].bg = bg; skelBars[skelN].lv = -1;
  skelN++;
}

// The light's level (0..7) over bar `i` at `now`: a soft band travelling
// diagonally - left to right, a little later the further down - once per
// LOADER_WAVE_MS. A bar is one flat colour, so the band reads as bars lighting
// in sequence; that keeps a frame to a handful of small fills.
static int skelLevel(int i, unsigned long now) {
  const SkelBar& b = skelBars[i];
  const long span = tft.width() + tft.height() / 2;
  const long pos = b.x + b.w / 2 + b.y / 2;
  const long ph = (long) (now % LOADER_WAVE_MS);
  const long c = -span * 4 / 10 + span * 18 / 10 * ph / (long) LOADER_WAVE_MS;
  const long half = span * 3 / 10;
  const long d = pos > c ? pos - c : c - pos;
  return d >= half ? 0 : (int) (7 - d * 7 / half);
}

static void skelPaintBar(int i, int lv) {
  SkelBar& b = skelBars[i];
  const uint16_t lo = blend565(b.bg, COLOR_LABEL, 55), hi = blend565(b.bg, COLOR_LABEL, 140);
  uiFillRound(b.x, b.y, b.w, b.h, b.h / 2, blend565(lo, hi, (uint8_t) (lv * 255 / 7)), b.bg);
  b.lv = (int8_t) lv;
}

// Every registered bar at the light's current position - the detail card's own
// draw calls this after laying its bars out.
void skelPaintNow() {
  const unsigned long now = millis();
  for (int i = 0; i < skelN; i++) skelPaintBar(i, skelLevel(i, now));
}

void tickLoaders() {
#if BOARD_HISTORY_SCROLL
  scrollLoaderTick();
#endif
  if (skelOwner == SKEL_NONE) return;
  if (!skelValid()) { skelOwner = SKEL_NONE; skelN = 0; return; }
  const unsigned long now = millis();
  if (!skelPainted) {
    if (now - skelArmMs < LOADER_DELAY_MS) return;
    skelN = 0;
    if (skelOwner == SKEL_PROJ0 || skelOwner == SKEL_PROJ1) projSkelLayout(skelOwner == SKEL_PROJ1 ? 1 : 0);
    skelPainted = true;
    lastSkelMs = 0;
  }
  if (lastSkelMs != 0 && now - lastSkelMs < LOADER_FRAME_MS) return;
  lastSkelMs = now;
  for (int i = 0; i < skelN; i++) {
    const int lv = skelLevel(i, now);
    if (lv != skelBars[i].lv) skelPaintBar(i, lv);
  }
}

#endif  // BOARD_HAS_ANIM
