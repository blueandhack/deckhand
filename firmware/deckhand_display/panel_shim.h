// PanelShim: TFT_eSPI-compatible drawing surface for board 2 (ES3C35P,
// ST77922 320x480 over QSPI), built on top of ESP32_Display_Panel.
//
// TFT_eSPI cannot drive a QSPI panel at all, so board 2 needed a different
// surface underneath the same ~6,000 lines of UI code. This is the non-text
// half of it (Task 3 adds text methods, Task 4 adds anti-aliased primitives
// and PanelSprite) - see esp_panel_board_custom_conf.h for why a *specific*
// vendor init sequence, not the library default, is what makes the panel
// actually show anything.
//
// Every draw call is a write into a 320x480 RGB565 shadow framebuffer in
// PSRAM; nothing reaches the physical panel until flush() pushes the
// accumulated dirty rectangle. QSPI has no readback at all, so this shadow
// buffer is also the ONLY reason readRect() (and therefore SCREENSHOT) can
// work on this board.
#pragma once

#include <Arduino.h>
#include <esp_display_panel.hpp>

// Physical panel geometry - fixed by the wiring/init sequence (CASET 0..319,
// RASET 0..479), independent of setRotation(). Named here rather than reusing
// BOARD_W/BOARD_H from board_es3c35p.h so this file has no dependency on the
// per-board headers (Task 6-8's job, not this one's).
#define PANEL_PHYS_W 320
#define PANEL_PHYS_H 480

class PanelShim {
public:
  void init();                       // panel bring-up + framebuffer alloc
  int  width()  const;               // rotation-aware (320 at rotation 0)
  int  height() const;               // rotation-aware (480 at rotation 0)
  void setRotation(uint8_t r);
  void fillScreen(uint16_t c);
  void fillRect(int x, int y, int w, int h, uint16_t c);
  void drawRect(int x, int y, int w, int h, uint16_t c);
  void drawFastHLine(int x, int y, int w, uint16_t c);
  void drawFastVLine(int x, int y, int h, uint16_t c);
  void drawPixel(int x, int y, uint16_t c);
  void pushImage(int x, int y, int w, int h, const uint16_t* data);
  void readRect(int x, int y, int w, int h, uint16_t* out);
  void setSwapBytes(bool s);
  bool getSwapBytes() const;
  void writecommand(uint8_t c);      // no-op on this panel; see the .cpp note
  void flush();                      // push the dirty rect(s) to the panel

  // ---- Anti-aliased primitives (Task 4) ----
  // Coverage-based AA: for every pixel in the shape's bounding box, compute a
  // continuous distance to the shape's edge and blend the destination pixel
  // toward the requested colour by that coverage. This is only easy because
  // the destination is a readable shadow buffer - TFT_eSPI can't read the
  // panel back on board 1's wiring, which is why ITS versions of these take a
  // `bg`/`behind` colour to blend against instead of reading the real pixel.
  // These accept the same `bg`/`behind` parameter, for interface parity with
  // every existing call site (uiCard, uiButton, drawStatusDot, ...), but do
  // not need it for correctness: blending against the actual destination
  // pixel is a strict superset of "bg matches what's really there" - it's
  // right even if a caller ever got that argument wrong. See panel_shim.cpp
  // for exactly how "the inner radius is inclusive" (r - ir + 1 px thick, the
  // convention uiStrokeRound/uiRing already compensate for with their own
  // `+1`) is reproduced with continuous coverage instead of TFT_eSPI's
  // integer radius-squared scan.
  void fillSmoothCircle(int x, int y, int r, uint16_t color, uint16_t bg);
  void drawSmoothCircle(int x, int y, int r, uint16_t fgColor, uint16_t bg);
  void drawSmoothArc(int x, int y, int r, int ir, int startAngle, int endAngle,
                      uint16_t fgColor, uint16_t bg, bool roundEnds = false);
  void fillSmoothRoundRect(int x, int y, int w, int h, int r, uint16_t color, uint16_t bg);
  void drawSmoothRoundRect(int x, int y, int r, int ir, int w, int h,
                            uint16_t fgColor, uint16_t bg, uint8_t quadrants = 0xF);
  void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t color);

  // Not part of the TFT_eSPI-compatible surface; used by the SHIMBENCH
  // command and the temporary Step-5 test pattern so they can tell whether
  // bring-up actually succeeded before drawing anything.
  bool ready() const { return _fb != nullptr; }

private:
  void mapPoint(int lx, int ly, int& px, int& py) const;
  void markDirty(int px0, int py0, int px1, int py1);
  void clipLogicalRect(int& x, int& y, int& w, int& h) const;
  // Shared by every "smooth" primitive: blends `fg` into the real pixel at
  // logical (x,y) by `coverage` (0..1), reading the destination back from
  // the shadow buffer rather than trusting a caller-supplied `bg`.
  void blendPixel(int x, int y, uint16_t fg, float coverage);

  uint16_t* _fb = nullptr;          // PANEL_PHYS_W x PANEL_PHYS_H, native order
  uint16_t* _stripBuf = nullptr;    // scratch for a cropped <=32-line strip
  uint8_t   _rotation = 0;
  bool      _swapBytes = false;

  // Dirty rect in PHYSICAL coordinates. dirtyX1 < dirtyX0 means "nothing
  // dirty" - checked instead of a separate bool so there's one source of
  // truth for the rectangle's own emptiness.
  int _dirtyX0 = 0, _dirtyY0 = 0, _dirtyX1 = -1, _dirtyY1 = -1;

  esp_panel::board::Board*      _board = nullptr;
  esp_panel::drivers::LCD*      _lcd = nullptr;
  esp_panel::drivers::Backlight* _backlight = nullptr;
};

extern PanelShim tft;
