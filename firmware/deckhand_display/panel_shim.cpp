// See panel_shim.h for the why. This file is the how.
//
// Arduino compiles every .cpp in the sketch folder as its own translation
// unit REGARDLESS of what any .ino includes - so without this guard, board
// 1's build also compiles this file and links a second `tft` global
// alongside board_e32r28t's `TFT_eSPI tft` in deckhand_display.ino, which is
// a link-time "multiple definition of `tft`" error, not a compile error, so
// it wasn't caught until the byte-identical check actually tried to link
// board 1. Guarding the whole file (not just the `tft` definition) means
// board 1's build never even sees esp_display_panel.hpp, keeping the
// byte-identical promise exact rather than "identical modulo dead code."
//
// Deliberately CONFIG_IDF_TARGET_ESP32S3 (the same compiler-defined macro
// board.h itself switches on), NOT BOARD_USES_TFT_ESPI via "board.h" - this
// is its own translation unit with no prior include, and board_e32r28t.h
// requires CRAB_H (from ClawdCrab.h, included ahead of board.h only inside
// deckhand_display.ino) to already be defined before it will compile. Taking
// on that same ordering dependency here just to read one macro is exactly
// the kind of cross-file coupling this file should not need.
//
// CONFIG_IDF_TARGET_ESP32S3 is defined in "sdkconfig.h", not passed as a
// bare compiler -D - it reads as a plain compiler-defined macro everywhere
// else in this sketch only because something upstream (Arduino.h, pulled in
// transitively before board.h) already included it. This file has no such
// upstream include, so without pulling it in directly, the #if below
// silently took the board-1 branch on BOTH boards (verified: an empty
// object file even when compiling for esp32s3).
#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
// Board 1 (plain ESP32): nothing in this file applies. See panel_shim.h.
#else
#include "panel_shim.h"
#include <esp_heap_caps.h>

using namespace esp_panel::board;
using namespace esp_panel::drivers;

PanelShim tft;

// A null framebuffer must never degrade into a quiet no-op: every primitive
// below would then silently do nothing and the panel would stay black in a
// way that is INDISTINGUISHABLE from the documented wrong-init-sequence
// failure (every call succeeds, screen stays black - see the FINDINGS.md
// note this file was built against). So a failed allocation halts loudly and
// repeatedly over serial instead of letting setup() continue.
static void fatalHalt(const char* what) {
  while (true) {
    Serial.printf("PANEL FATAL: %s - halted, nothing will be drawn.\n", what);
    delay(1000);
  }
}

static inline uint16_t swap16(uint16_t v) {
  return (uint16_t) ((v >> 8) | (v << 8));
}

void PanelShim::init() {
  Serial.printf("PSRAM: size=%u bytes\n", (unsigned) ESP.getPsramSize());

  size_t fbBytes = (size_t) PANEL_PHYS_W * PANEL_PHYS_H * 2;
  _fb = (uint16_t*) heap_caps_malloc(fbBytes, MALLOC_CAP_SPIRAM);
  Serial.printf("PANEL: framebuffer alloc %u bytes in PSRAM: %s\n",
                (unsigned) fbBytes, _fb ? "OK" : "FAILED");
  if (!_fb) fatalHalt("framebuffer allocation failed");

  // Scratch strip buffer for a CROPPED dirty-rect flush (see flush()) - worst
  // case is a full-width, 32-line strip. PSRAM is fine as the *source* of a
  // QSPI write; only a single ~300KB transfer is the problem (see the
  // bounce-buffer note in flush()), not PSRAM as such.
  _stripBuf = (uint16_t*) heap_caps_malloc((size_t) PANEL_PHYS_W * 32 * 2, MALLOC_CAP_SPIRAM);
  if (!_stripBuf) fatalHalt("strip scratch buffer allocation failed");

  _board = new Board();
  if (!_board->init()) fatalHalt("Board::init() failed");
  if (!_board->begin()) fatalHalt("Board::begin() failed");

  _lcd = _board->getLCD();
  if (!_lcd) fatalHalt("getLCD() returned null");
  _backlight = _board->getBacklight();

  Serial.printf("PANEL: LCD up, frame %dx%d\n", _lcd->getFrameWidth(), _lcd->getFrameHeight());

  // Full brightness now, unconditionally - Task 9 is where the UI's own
  // brightness setting (power.ino, LEDC on board 1) gets a board-2 home.
  // Without this the panel would be correctly driven and still look dead,
  // which is exactly the ambiguous failure this whole file exists to avoid.
  if (_backlight) {
    _backlight->setBrightness(100);
    Serial.println("PANEL: backlight on (100%)");
  } else {
    Serial.println("PANEL: no backlight object from board - screen may stay dark");
  }
}

int PanelShim::width() const {
  return (_rotation & 1) ? PANEL_PHYS_H : PANEL_PHYS_W;
}

int PanelShim::height() const {
  return (_rotation & 1) ? PANEL_PHYS_W : PANEL_PHYS_H;
}

void PanelShim::setRotation(uint8_t r) {
  _rotation = r & 3;
}

// Maps a LOGICAL point (in the rotated width()/height() space) to a PHYSICAL
// point in the fixed 320x480 buffer that matches the panel's wiring (CASET
// 0..319, RASET 0..479). Rects are mapped by mapping two opposite corners and
// taking the bounding box (clipLogicalRect below), which stays correct for
// every 90-degree case without hand-deriving a width/height swap per case.
void PanelShim::mapPoint(int lx, int ly, int& px, int& py) const {
  switch (_rotation) {
    default:
    case 0: px = lx;                        py = ly;                        break;
    case 1: px = PANEL_PHYS_W - 1 - ly;      py = lx;                        break;
    case 2: px = PANEL_PHYS_W - 1 - lx;      py = PANEL_PHYS_H - 1 - ly;     break;
    case 3: px = ly;                         py = PANEL_PHYS_H - 1 - lx;     break;
  }
}

// Clips a logical rect to the logical screen bounds, in place. w/h come out
// <=0 when the rect is fully offscreen, which every caller below checks for.
void PanelShim::clipLogicalRect(int& x, int& y, int& w, int& h) const {
  int lw = width(), lh = height();
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > lw) w = lw - x;
  if (y + h > lh) h = lh - y;
}

void PanelShim::markDirty(int px0, int py0, int px1, int py1) {
  if (_dirtyX1 < _dirtyX0) {           // was empty
    _dirtyX0 = px0; _dirtyY0 = py0; _dirtyX1 = px1; _dirtyY1 = py1;
  } else {
    if (px0 < _dirtyX0) _dirtyX0 = px0;
    if (py0 < _dirtyY0) _dirtyY0 = py0;
    if (px1 > _dirtyX1) _dirtyX1 = px1;
    if (py1 > _dirtyY1) _dirtyY1 = py1;
  }
}

void PanelShim::fillRect(int x, int y, int w, int h, uint16_t c) {
  if (!_fb) return;
  clipLogicalRect(x, y, w, h);
  if (w <= 0 || h <= 0) return;

  if (_rotation == 0) {
    // Fast path: logical == physical, so each row is a contiguous run.
    for (int row = 0; row < h; row++) {
      uint16_t* p = _fb + (size_t) (y + row) * PANEL_PHYS_W + x;
      for (int col = 0; col < w; col++) p[col] = c;
    }
    markDirty(x, y, x + w - 1, y + h - 1);
    return;
  }

  int px0, py0, px1, py1;
  mapPoint(x, y, px0, py0);
  mapPoint(x + w - 1, y + h - 1, px1, py1);
  if (px0 > px1) { int t = px0; px0 = px1; px1 = t; }
  if (py0 > py1) { int t = py0; py0 = py1; py1 = t; }
  for (int ly = y; ly < y + h; ly++) {
    for (int lx = x; lx < x + w; lx++) {
      int px, py;
      mapPoint(lx, ly, px, py);
      _fb[(size_t) py * PANEL_PHYS_W + px] = c;
    }
  }
  markDirty(px0, py0, px1, py1);
}

void PanelShim::fillScreen(uint16_t c) {
  fillRect(0, 0, width(), height(), c);
}

void PanelShim::drawFastHLine(int x, int y, int w, uint16_t c) {
  fillRect(x, y, w, 1, c);
}

void PanelShim::drawFastVLine(int x, int y, int h, uint16_t c) {
  fillRect(x, y, 1, h, c);
}

void PanelShim::drawRect(int x, int y, int w, int h, uint16_t c) {
  if (w <= 0 || h <= 0) return;
  drawFastHLine(x, y, w, c);
  drawFastHLine(x, y + h - 1, w, c);
  drawFastVLine(x, y, h, c);
  drawFastVLine(x + w - 1, y, h, c);
}

void PanelShim::drawPixel(int x, int y, uint16_t c) {
  if (!_fb) return;
  if (x < 0 || y < 0 || x >= width() || y >= height()) return;
  int px, py;
  mapPoint(x, y, px, py);
  _fb[(size_t) py * PANEL_PHYS_W + px] = c;
  markDirty(px, py, px, py);
}

// pushImage must honour swapBytes exactly as TFT_eSPI does: the art
// (ClawdCrab.h, DeckhandLogo.h, the emoji/spinner sprites) is drawn on board
// 1 with setSwapBytes(true) around a source buffer the comments describe as
// "ordinary RGB565" - i.e. a ordinary native-order uint16_t array, which on a
// little-endian CPU needs byte-swapping before it matches TFT_eSPI's
// big-endian wire format. This shim's shadow buffer, by contrast, is proven
// (by the demo firmware, byte for byte the same call) to want NATIVE order
// with NO swap for drawBitmap() to render correct colours. So the two
// conventions are mirror images of each other, and honouring "swapBytes"
// means: swapBytes==true -> source is already in *our* native format, copy
// as-is; swapBytes==false -> source is in TFT_eSPI's wire format (the
// opposite of native), so swap it going in. Either way, a given (data,
// swapBytes) pair renders the same colours it would on board 1.
void PanelShim::pushImage(int x, int y, int w, int h, const uint16_t* data) {
  if (!_fb || !data) return;
  int cx = x, cy = y, cw = w, ch = h;
  clipLogicalRect(cx, cy, cw, ch);
  if (cw <= 0 || ch <= 0) return;
  int offX = cx - x, offY = cy - y;   // how much was clipped off the left/top

  for (int row = 0; row < ch; row++) {
    const uint16_t* srcRow = data + (size_t) (offY + row) * w + offX;
    for (int col = 0; col < cw; col++) {
      uint16_t v = srcRow[col];
      if (!_swapBytes) v = swap16(v);
      int px, py;
      mapPoint(cx + col, cy + row, px, py);
      _fb[(size_t) py * PANEL_PHYS_W + px] = v;
    }
  }
  int px0, py0, px1, py1;
  mapPoint(cx, cy, px0, py0);
  mapPoint(cx + cw - 1, cy + ch - 1, px1, py1);
  if (px0 > px1) { int t = px0; px0 = px1; px1 = t; }
  if (py0 > py1) { int t = py0; py0 = py1; py1 = t; }
  markDirty(px0, py0, px1, py1);
}

// readRect is a straight framebuffer read - the only reason SCREENSHOT can
// work on this board at all, since QSPI has no readback. Board 1's readRect
// returns pixels BYTE-SWAPPED relative to a plain read (readPixel does not
// swap), and the firmware's screenshot path un-swaps before encoding - so
// this always swaps on the way out, regardless of setSwapBytes (which only
// governs pushImage), to match that fixed convention.
void PanelShim::readRect(int x, int y, int w, int h, uint16_t* out) {
  if (!out) return;
  if (!_fb) { memset(out, 0, (size_t) w * h * 2); return; }
  for (int row = 0; row < h; row++) {
    for (int col = 0; col < w; col++) {
      int lx = x + col, ly = y + row;
      uint16_t v = 0;
      if (lx >= 0 && ly >= 0 && lx < width() && ly < height()) {
        int px, py;
        mapPoint(lx, ly, px, py);
        v = _fb[(size_t) py * PANEL_PHYS_W + px];
      }
      out[(size_t) row * w + col] = swap16(v);
    }
  }
}

void PanelShim::setSwapBytes(bool s) { _swapBytes = s; }
bool PanelShim::getSwapBytes() const { return _swapBytes; }

// writecommand has two call sites on board 1: panel sleep-in/out (going
// straight to TFT_eSPI's own command interface). On this panel that goes
// through the ESP32_Display_Panel LCD driver's own sleep API instead
// (Task 9), so there is nothing for a raw command byte to do here.
void PanelShim::writecommand(uint8_t /*c*/) {
  // no-op, deliberately - see the note above.
}

// Pushes only the dirty rectangle, in <=32-line strips, each copied into a
// small contiguous scratch buffer first. Both halves are load-bearing
// findings from the demo bring-up: a single ~300KB full-frame transfer fails
// to allocate an internal SPI bounce buffer, and drawBitmap's default
// timeout_ms=0 is NON-BLOCKING, so without timeout_ms=-1 (blocking) the next
// strip's memcpy could race the DMA engine still reading the previous one.
#define FLUSH_STRIP_LINES 32

void PanelShim::flush() {
  if (!_fb || !_lcd || !_stripBuf) return;
  if (_dirtyX1 < _dirtyX0) return;   // nothing dirty

  int x0 = _dirtyX0, y0 = _dirtyY0, x1 = _dirtyX1, y1 = _dirtyY1;
  int w = x1 - x0 + 1;

  for (int y = y0; y <= y1; y += FLUSH_STRIP_LINES) {
    int lines = min(FLUSH_STRIP_LINES, y1 - y + 1);
    for (int r = 0; r < lines; r++) {
      memcpy(_stripBuf + (size_t) r * w,
             _fb + (size_t) (y + r) * PANEL_PHYS_W + x0,
             (size_t) w * 2);
    }
    if (!_lcd->drawBitmap(x0, y, w, lines, (const uint8_t*) _stripBuf, -1)) {
      Serial.printf("PANEL: drawBitmap failed at y=%d\n", y);
      break;
    }
  }
  _dirtyX1 = -1;   // mark clean; _dirtyX0 unchanged, harmless since X1<X0 is the only test
}

#endif  // CONFIG_IDF_TARGET_ESP32S3
