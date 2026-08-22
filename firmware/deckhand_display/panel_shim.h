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

  // Not part of the TFT_eSPI-compatible surface; used by the SHIMBENCH
  // command and the temporary Step-5 test pattern so they can tell whether
  // bring-up actually succeeded before drawing anything.
  bool ready() const { return _fb != nullptr; }

private:
  void mapPoint(int lx, int ly, int& px, int& py) const;
  void markDirty(int px0, int py0, int px1, int py1);
  void clipLogicalRect(int& x, int& y, int& w, int& h) const;

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
