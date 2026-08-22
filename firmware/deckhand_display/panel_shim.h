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

// ---------------------------------------------------------------------------
// GFX free-font types (Task 3).
//
// Cozette6x13.h and Terminus10x18b.h declare their tables as GFXglyph/GFXfont
// but include only <Arduino.h> - on board 1 those two structs arrive from
// TFT_eSPI's Fonts/GFXFF/gfxfont.h, and board 2 has neither TFT_eSPI nor
// Adafruit_GFX installed, so they have to be defined here. This is why
// deckhand_display.ino's include order matters: panel_shim.h must come before
// the font headers, which it already does.
//
// The field layout is byte-for-byte TFT_eSPI's, because the generated headers
// emit their initialisers positionally - a reordered member would compile
// cleanly and mis-read every glyph. The guard NAME is deliberately the same
// (_GFXFONT_H_) that TFT_eSPI and Adafruit_GFX both use, so if either ever
// reaches this translation unit the two definitions can't collide.
// ---------------------------------------------------------------------------
#ifndef _GFXFONT_H_
#define _GFXFONT_H_
typedef struct {                 // per glyph
  uint32_t bitmapOffset;         // index into GFXfont->bitmap
  uint8_t  width, height;        // bitmap dimensions, pixels
  uint8_t  xAdvance;             // cursor advance (x)
  int8_t   xOffset, yOffset;     // cursor to upper-left corner
} GFXglyph;
typedef struct {                 // per font
  uint8_t  *bitmap;              // glyph bitmaps, concatenated
  GFXglyph *glyph;               // glyph array
  uint16_t  first, last;         // ASCII extents
  uint8_t   yAdvance;            // newline distance (y)
} GFXfont;
#endif

// Text datums, with TFT_eSPI's exact numeric values - the UI passes these
// around as plain uint8_t (drawIfChanged takes a `datum` parameter and
// switches on it), so the numbers, not just the names, are part of the
// interface. Only the six the UI actually uses are named here; anything else
// reaching setTextDatum is reported once and rendered top-left rather than
// silently mis-placed (see panel_text.cpp).
#define TL_DATUM 0   // top left (default)
#define TC_DATUM 1   // top centre
#define TR_DATUM 2   // top right
#define ML_DATUM 3   // middle left
#define MC_DATUM 4   // middle centre
#define MR_DATUM 5   // middle right

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

  // ---- Text (Task 3) ----
  // GFX free fonts only, which is all this UI uses: setUIFont() installs one
  // of three faces (Cozette 6x13, Terminus 10x18 bold, Cozette at size 2) and
  // nothing calls a legacy numbered font. textWidth() is the linchpin of the
  // whole port - every lane width, every drawIfChanged clear box and every
  // rung of drawSessionRow's fitText ladder is derived from it, so it walks
  // the SAME advance table drawString does and reproduces TFT_eSPI's
  // measurement rules (including the last-character one) exactly rather than
  // approximately. See panel_text.cpp for each rule and why it matters.
  void setFreeFont(const GFXfont* f);
  void setTextFont(uint8_t f);              // legacy numbered fonts: unsupported, reported
  void setTextSize(uint8_t s);
  void setTextColor(uint16_t fg, uint16_t bg);
  void setTextDatum(uint8_t d);
  void drawString(const char* s, int x, int y);
  void drawString(const String& s, int x, int y);
  int  textWidth(const char* s);
  int  textWidth(const String& s);

  // Public because drawIfChanged reads it directly to derive a field's erase
  // height - the one site, and the reason this is a member rather than an
  // accessor. Same name and same public-ness as TFT_eSPI's.
  uint8_t textsize = 1;

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
  // Draws one glyph with its baseline at (x, y) and returns the cursor
  // advance, mirroring TFT_eSPI's drawChar(uniCode, x, y, font) contract: an
  // out-of-range codepoint draws nothing AND advances nothing.
  int  drawGlyph(uint16_t uniCode, int x, int y);

  uint16_t* _fb = nullptr;          // PANEL_PHYS_W x PANEL_PHYS_H, native order
  uint16_t* _stripBuf = nullptr;    // scratch for a cropped <=32-line strip
  uint8_t   _rotation = 0;
  bool      _swapBytes = false;

  // Text state. Names mirror TFT_eSPI's own members so the port reads against
  // its source side by side - with one deliberate omission: there is no
  // `_textfont`, because this surface has a single rendering path and nothing
  // would ever read it (see setTextFont). _glyphAb/_glyphBb are the font's
  // largest ascent and descent, recomputed by setFreeFont - they set the
  // baseline offset the free-font path adds to y, and the height of the
  // opaque background box drawString paints.
  const GFXfont* _gfxFont = nullptr;
  uint16_t  _textcolor = 0xFFFF;
  uint16_t  _textbgcolor = 0x0000;
  uint8_t   _textdatum = TL_DATUM;
  uint8_t   _glyphAb = 0;
  uint8_t   _glyphBb = 0;

  // Dirty rect in PHYSICAL coordinates. dirtyX1 < dirtyX0 means "nothing
  // dirty" - checked instead of a separate bool so there's one source of
  // truth for the rectangle's own emptiness.
  int _dirtyX0 = 0, _dirtyY0 = 0, _dirtyX1 = -1, _dirtyY1 = -1;

  esp_panel::board::Board*      _board = nullptr;
  esp_panel::drivers::LCD*      _lcd = nullptr;
  esp_panel::drivers::Backlight* _backlight = nullptr;
};

extern PanelShim tft;
