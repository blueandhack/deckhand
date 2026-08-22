// PanelSprite: a small off-screen RGB565 buffer, for board 2, matching just
// the slice of TFT_eSprite's surface this sketch actually uses -
// createSprite/deleteSprite/fillSprite/pushSprite, plus fillRect/drawPixel
// so the existing templated drawCrab() (deckhand_display.ino) works against
// it unchanged, the same way it already works against TFT_eSprite on board 1
// and against PanelShim directly when a sprite can't be allocated.
//
// Deliberately does NOT replicate TFT_eSPI's internal byte-swapped sprite
// storage. drawCrab is templated and calls g.fillRect(...) with an ordinary
// 0xF800-style colour precisely so it never has to know or care which
// surface it's drawing into - see that function's own comment on why
// pushImage (byte-order-dependent) was the wrong tool and fillRect (not)
// is the right one. Keeping this buffer in plain native order, matching
// PanelShim's own shadow framebuffer, is what keeps that promise true here.
//
// Only meaningful on board 2 (ESP32-S3 + PanelShim); see panel_shim.cpp for
// why this whole file has to be guarded the same way rather than reading
// board.h's BOARD_USES_TFT_ESPI directly.
#pragma once

#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
// Board 1: nothing here applies - it uses TFT_eSprite instead.
#else

#include <Arduino.h>
#include <esp_heap_caps.h>
#include "panel_shim.h"

class PanelSprite {
public:
  explicit PanelSprite(PanelShim* parent) : _parent(parent) {}
  ~PanelSprite() { deleteSprite(); }

  // Allocates w*h*2 bytes from PSRAM (the crab's 240x108 surface is ~51KB -
  // too big to ask of the BLE-stack-shrunk internal heap). Returns the
  // buffer pointer on success, nullptr on failure - the exact non-null/null
  // contract startOctopus() already tests via
  // `octoSprite.createSprite(...) != nullptr` to decide whether to fall back
  // to direct drawing, matching what TFT_eSprite::createSprite itself
  // returns (void*, not a bool).
  void* createSprite(int w, int h) {
    deleteSprite();
    if (w <= 0 || h <= 0) return nullptr;
    _buf = (uint16_t*) heap_caps_malloc((size_t) w * h * 2, MALLOC_CAP_SPIRAM);
    if (!_buf) return nullptr;
    _w = w;
    _h = h;
    return (void*) _buf;
  }

  void deleteSprite() {
    if (_buf) { heap_caps_free(_buf); _buf = nullptr; }
    _w = _h = 0;
  }

  void fillSprite(uint16_t color) { fillRect(0, 0, _w, _h, color); }

  // Ordinary colour in, ordinary colour stored - no byte-order juggling.
  // This is the method drawCrab() actually calls through `g.fillRect(...)`.
  void fillRect(int x, int y, int w, int h, uint16_t color) {
    if (!_buf) return;
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int x1 = (x + w) > _w ? _w : (x + w);
    int y1 = (y + h) > _h ? _h : (y + h);
    for (int yy = y0; yy < y1; yy++) {
      uint16_t* row = _buf + (size_t) yy * _w;
      for (int xx = x0; xx < x1; xx++) row[xx] = color;
    }
  }

  void drawPixel(int x, int y, uint16_t color) {
    if (!_buf || x < 0 || y < 0 || x >= _w || y >= _h) return;
    _buf[(size_t) y * _w + x] = color;
  }

  // Blits into the parent PanelShim's shadow framebuffer and marks the
  // matching rect dirty. Implemented on top of PanelShim's own public
  // pushImage() rather than reaching into its private framebuffer, so this
  // gets rotation-mapping, clipping and dirty-tracking for free instead of a
  // second copy of that logic. pushImage's `swapBytes` flag governs whether
  // *its* source needs swapping into the shim's native order; this buffer is
  // already in that native order (see the file header), so this forces
  // swapBytes=true ("source is already native, copy as-is" - see
  // panel_shim.cpp's own comment on that convention) for the one call and
  // restores whatever the caller had set, since that flag is shared state on
  // `tft` and not this sprite's to leave altered.
  void pushSprite(int x, int y) {
    if (!_buf || !_parent) return;
    bool prevSwap = _parent->getSwapBytes();
    _parent->setSwapBytes(true);
    _parent->pushImage(x, y, _w, _h, _buf);
    _parent->setSwapBytes(prevSwap);
  }

  int width() const { return _w; }
  int height() const { return _h; }

private:
  PanelShim* _parent;
  uint16_t*  _buf = nullptr;
  int _w = 0, _h = 0;
};

#endif  // CONFIG_IDF_TARGET_ESP32S3
