// PanelShim's text renderer: GFX free fonts, drawn into the shadow
// framebuffer, measured EXACTLY the way TFT_eSPI measures them.
//
// This file is the equivalence gate for the whole port. Every lane width,
// every drawIfChanged clear box (`fillRect(fx-1, fy-1, tw+2, th+2)`) and
// every rung of drawSessionRow's 12x26 -> 10x18 -> 6x13 fitText ladder is
// computed from textWidth(). One pixel small leaves a column of stale pixels
// behind an updated field; one pixel large eats the card border the field
// sits inside. So this is not a re-implementation of text rendering that
// looks about right - it is a transcription of TFT_eSPI.cpp's own free-font
// path, and the five rules below are the ones that are easy to get wrong
// while still producing text that looks fine on the glass.
//
// RULE 1 - THE LAST CHARACTER IS MEASURED DIFFERENTLY FROM THE REST.
// textWidth() charges every character `xAdvance` EXCEPT the final one, which
// is charged `xOffset + width` instead ("the ink can be wider than the
// advance"). In Cozette those two disagree for 20 of 95 glyphs: a trailing
// `4`, `q` or SPACE measures one pixel MORE than its advance, and a trailing
// one of `!"'(),.:;>I[]`jl|` measures one or two LESS. So textWidth is NOT
// the sum of the advances, and the widely-relied-on "every Cozette glyph
// advances 6px" arithmetic (the keyboard's 34-column budget, for one) is a
// statement about xAdvance, not about textWidth. text_probe.h's second block
// exists purely to exercise this, because none of the real UI strings in its
// first block happen to end on one of those glyphs.
//
// RULE 2 - drawString AND textWidth MUST WALK THE SAME TABLE. drawString
// advances the pen by `xAdvance * textsize` per glyph and takes its datum
// offsets from textWidth()'s result. A divergence between what is drawn and
// what is measured reproduces exactly the 8px overlap the measured-lane code
// in drawSessionRow exists to prevent - which is why drawGlyph() returns the
// advance rather than the caller re-deriving it.
//
// RULE 3 - A FREE FONT'S y IS THE TOP OF THE ASCENT, NOT THE BASELINE.
// TFT_eSPI adds `glyph_ab * textsize` to y before drawing, so with TL_DATUM
// the text TOP lands on the given y. Miss this and every string on board 2
// sits ten pixels above where board 1 puts it. The datum's own vertical
// arithmetic then uses that same ascent as the "cell height" - notably NOT
// the font's yAdvance, and notably an integer `/2` for the middle datums.
//
// RULE 4 - drawString PAINTS AN OPAQUE BACKGROUND BOX. Whenever the fg and bg
// colours passed to setTextColor differ, a rect `cwidth` x
// `(ascent+descent)*textsize` is filled with bg first. The UI depends on this
// in both directions: it is why a too-wide string "rubs out the card border it
// crosses" (the confirm-dialog note in CLAUDE.md), and why the keyboard's meta
// row and text lines are laid out to share no pixel row.
//
// RULE 5 - AN OUT-OF-RANGE BYTE DRAWS NOTHING AND ADVANCES NOTHING. Verified
// by reading TFT_eSPI.cpp, not assumed: the 6-argument drawChar filters
// `c >= first && c <= last` before rendering, drawChar(uniCode,...) returns 0
// for anything outside it, and textWidth's loop adds nothing. Both fonts here
// cover 0x20..0x7E only, and the ASCII-only rule is enforced elsewhere by
// convention rather than validation - so this is the behaviour a stray byte
// actually gets, on both boards.
//
// Guarded exactly the way panel_shim.cpp is, and for the same reasons: see
// that file's header for why the switch is CONFIG_IDF_TARGET_ESP32S3 out of
// "sdkconfig.h" rather than BOARD_USES_TFT_ESPI out of "board.h", and why the
// guard wraps the whole file rather than just its definitions.
#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
// Board 1 (plain ESP32): nothing in this file applies - it uses TFT_eSPI's
// own text path, which is the reference this file is measured against.
#else
#include "panel_shim.h"

// ---------------------------------------------------------------------------
// A quiet fallback is the failure mode this file most needs to avoid: a datum
// that silently renders top-left is a layout bug that reads as a design
// mistake, and a legacy numbered font that silently draws nothing reads as a
// missing feature. Both are reported over serial - once per distinct offender,
// because these would otherwise fire on every one of the ~113 drawString
// calls a single render pass makes and drown the log they are meant to stand
// out in.
// ---------------------------------------------------------------------------
static uint16_t warnedDatums = 0;    // bit N = datum N already reported
static bool warnedNumberedFont = false;
static bool warnedNoFont = false;

static void warnDatumOnce(uint8_t d) {
  uint16_t bit = (d < 16) ? (uint16_t) (1u << d) : 0x8000u;
  if (warnedDatums & bit) return;
  warnedDatums |= bit;
  Serial.printf("PANEL TEXT: datum %u is not implemented - drawing top-left. "
                "Layout at this call site is WRONG.\n", d);
}

// UTF-8 decode, transcribed from TFT_eSPI's buffer-form decodeUTF8 (the one
// its drawString uses). Its textWidth uses the STREAM form instead, which is
// a different function - but the two agree on every input that matters here:
// they are identical for 7-bit ASCII and for well-formed multi-byte
// sequences, and for a malformed one they return either the lead byte or 0,
// both of which are outside 0x20..0x7E and therefore contribute nothing
// either way (Rule 5). So one decoder can serve both sides here without the
// measured and drawn widths being able to disagree.
static uint16_t decodeUtf8(const uint8_t* buf, uint16_t* index, uint16_t remaining) {
  uint16_t c = buf[(*index)++];
  if ((c & 0x80) == 0x00) return c;                                  // 7-bit
  if (((c & 0xE0) == 0xC0) && (remaining > 1))                       // 11-bit
    return (uint16_t) (((c & 0x1F) << 6) | (buf[(*index)++] & 0x3F));
  if (((c & 0xF0) == 0xE0) && (remaining > 2)) {                     // 16-bit
    c = (uint16_t) (((c & 0x0F) << 12) | ((buf[(*index)++] & 0x3F) << 6));
    return (uint16_t) (c | (buf[(*index)++] & 0x3F));
  }
  return c;                                                          // extended ASCII
}

// ---------------------------------------------------------------------------
// Font selection
// ---------------------------------------------------------------------------

// The ascent/descent scan reproduces TFT_eSPI's setFreeFont verbatim,
// including the part that looks like a bug: `numChars = last - first`, with no
// +1, so the font's FINAL glyph is excluded from the scan. That is upstream's
// arithmetic, it is what board 1's baseline offset is computed from, and
// "fixing" it here would move every string on board 2 by however much that
// last glyph would have changed the maximum. (For the two fonts in this
// sketch it changes nothing - both end on `~`, whose extents are interior -
// but a future face is exactly where a silent one-pixel divergence would
// enter, so the quirk is kept rather than relied upon.)
//
// Measured for the record: Cozette 6x13 -> ascent 10, descent 3 (13 = its
// registry cellH); Terminus 10x18 bold -> 15 and 3 (18 = its cellH).
void PanelShim::setFreeFont(const GFXfont* f) {
  if (!f) { setTextFont(1); return; }        // upstream's null guard, same fallback

  _textfont = 1;
  _gfxFont = f;
  _glyphAb = 0;
  _glyphBb = 0;

  uint16_t numChars = (uint16_t) (f->last - f->first);
  for (uint16_t c = 0; c < numChars; c++) {
    const GFXglyph* g = &f->glyph[c];
    int8_t ab = (int8_t) (-g->yOffset);
    if (ab > (int8_t) _glyphAb) _glyphAb = (uint8_t) ab;
    int8_t bb = (int8_t) (g->height - ab);
    if (bb > (int8_t) _glyphBb) _glyphBb = (uint8_t) bb;
  }
}

// Legacy numbered fonts (TFT_eSPI's built-in GLCD/font2/RLE faces) have no
// glyph data on this board at all - the sketch reaches every face through
// setUIFont(), which always installs a free font, and nothing calls this. It
// is here for interface parity, and it REPORTS rather than quietly leaving a
// surface blank: text vanishing with no explanation is the one outcome worse
// than text in the wrong face.
void PanelShim::setTextFont(uint8_t f) {
  _textfont = (f > 0 && f <= 8) ? f : 1;
  _gfxFont = nullptr;
  if (!warnedNumberedFont) {
    warnedNumberedFont = true;
    Serial.printf("PANEL TEXT: legacy numbered font %u requested - this board has no "
                  "glyph data for it, so nothing will be drawn until a free font is set.\n", f);
  }
}

void PanelShim::setTextSize(uint8_t s) {
  if (s > 7) s = 7;                 // upstream's cap, so byte maths stays valid
  textsize = (s > 0) ? s : 1;       // font size 0 is not allowed
}

void PanelShim::setTextColor(uint16_t fg, uint16_t bg) {
  _textcolor = fg;
  _textbgcolor = bg;
}

void PanelShim::setTextDatum(uint8_t d) {
  _textdatum = d;
}

// ---------------------------------------------------------------------------
// Measurement (Rule 1)
// ---------------------------------------------------------------------------
int PanelShim::textWidth(const char* string) {
  if (!string || !_gfxFont) {
    if (!_gfxFont && !warnedNoFont) {
      warnedNoFont = true;
      Serial.println("PANEL TEXT: textWidth/drawString with no free font set - returning 0.");
    }
    return 0;
  }

  int32_t str_width = 0;
  uint16_t len = (uint16_t) strlen(string);
  uint16_t n = 0;
  uint16_t first = _gfxFont->first, last = _gfxFont->last;

  while (n < len) {
    uint16_t uniCode = decodeUtf8((const uint8_t*) string, &n, (uint16_t) (len - n));
    if (uniCode >= first && uniCode <= last) {
      const GFXglyph* g = &_gfxFont->glyph[uniCode - first];
      // `n < len` is upstream's `*string` test after the increment: "is there
      // another character after this one". Not "is this the last IN-RANGE
      // character" - a string ending in an out-of-range byte charges its last
      // real glyph the advance, which is what upstream does too.
      if (n < len) str_width += g->xAdvance;
      else         str_width += (int32_t) g->xOffset + g->width;
    }
  }
  return (int) (str_width * textsize);
}

int PanelShim::textWidth(const String& s) { return textWidth(s.c_str()); }

// ---------------------------------------------------------------------------
// Glyph rendering
// ---------------------------------------------------------------------------

// (x, y) is the pen position with y on the BASELINE. The run-length inner
// loop is transcribed from TFT_eSPI's 6-argument drawChar so pixel placement
// matches bit for bit, including the two arithmetic forms it uses for size==1
// and size>1 (which are algebraically the same thing, kept apart here only to
// keep the transcription honest) and the end-of-row flush that runs with
// xx == width. Background is NOT painted per glyph - drawString paints one box
// for the whole string first (Rule 4), which is what upstream does and is why
// a per-glyph bg fill here would double-draw and flicker.
int PanelShim::drawGlyph(uint16_t uniCode, int x, int y) {
  if (!uniCode || !_gfxFont) return 0;
  uint16_t first = _gfxFont->first, last = _gfxFont->last;
  if (uniCode < first || uniCode > last) return 0;      // Rule 5

  const GFXglyph* glyph = &_gfxFont->glyph[uniCode - first];
  const uint8_t* bitmap = _gfxFont->bitmap;

  uint32_t bo = glyph->bitmapOffset;
  uint8_t  w  = glyph->width;
  uint8_t  h  = glyph->height;
  int8_t   xo = glyph->xOffset;
  int8_t   yo = glyph->yOffset;
  uint8_t  size = textsize;

  uint8_t bits = 0, bit = 0, xx = 0, yy = 0;
  uint16_t hpc = 0;                            // horizontal foreground pixel count
  for (yy = 0; yy < h; yy++) {
    for (xx = 0; xx < w; xx++) {
      if (bit == 0) { bits = bitmap[bo++]; bit = 0x80; }
      if (bits & bit) hpc++;
      else if (hpc) {
        if (size == 1) drawFastHLine(x + xo + xx - hpc, y + yo + yy, hpc, _textcolor);
        else fillRect(x + (xo + xx - hpc) * size, y + (yo + yy) * size, size * hpc, size, _textcolor);
        hpc = 0;
      }
      bit >>= 1;
    }
    // Flush the run that reached the end of this row (xx == w here).
    if (hpc) {
      if (size == 1) drawFastHLine(x + xo + xx - hpc, y + yo + yy, hpc, _textcolor);
      else fillRect(x + (xo + xx - hpc) * size, y + (yo + yy) * size, size * hpc, size, _textcolor);
      hpc = 0;
    }
  }
  return glyph->xAdvance * size;               // Rule 2
}

// ---------------------------------------------------------------------------
// drawString (Rules 2, 3, 4)
// ---------------------------------------------------------------------------
void PanelShim::drawString(const char* string, int poX, int poY) {
  if (!string || !*string) return;
  if (!_gfxFont) {
    if (!warnedNoFont) {
      warnedNoFont = true;
      Serial.println("PANEL TEXT: textWidth/drawString with no free font set - drawing nothing.");
    }
    return;
  }

  int cwidth  = textWidth(string);              // measured ONCE, and reused below
  int cheight = _glyphAb * textsize;            // Rule 3: the "cell" is the ASCENT
  poY += cheight;                               // y was the text top; now it is the baseline

  // Datum arithmetic, upstream's exactly - integer `/2`, and against the
  // ascent rather than the full line height. The BL/BC/BR family would extend
  // cheight by the descent first; they are unreachable here (the UI uses only
  // the six datums declared in panel_shim.h) and an unrecognised datum is
  // reported rather than quietly treated as TL.
  switch (_textdatum) {
    case TL_DATUM: break;
    case TC_DATUM: poX -= cwidth / 2; break;
    case TR_DATUM: poX -= cwidth; break;
    case ML_DATUM:                    poY -= cheight / 2; break;
    case MC_DATUM: poX -= cwidth / 2; poY -= cheight / 2; break;
    case MR_DATUM: poX -= cwidth;     poY -= cheight / 2; break;
    default: warnDatumOnce(_textdatum); break;
  }

  // Rule 4: one opaque box for the whole string, before any glyph.
  if (_textcolor != _textbgcolor) {
    int boxH = (_glyphAb + _glyphBb) * textsize;
    int boxW = cwidth;
    // Upstream widens the box by the FIRST glyph's negative xOffset, so ink
    // that starts left of the pen is still covered; a non-negative offset is
    // clamped to zero and changes nothing. Every glyph in both fonts here has
    // xOffset >= 0 (Cozette 1..6, Terminus 0), so `xo` is always 0 in
    // practice - the branch is kept because a future face is where it would
    // start mattering, and because omitting it would make this diverge from
    // the reference for a reason nobody would think to look for.
    int xo = 0;
    uint16_t len = (uint16_t) strlen(string), n = 0, c2 = 0;
    while (n < len && c2 == 0) c2 = decodeUtf8((const uint8_t*) string, &n, (uint16_t) (len - n));
    uint16_t first = _gfxFont->first, last = _gfxFont->last;
    if (c2 >= first && c2 <= last) {
      xo = _gfxFont->glyph[c2 - first].xOffset * textsize;
      if (xo > 0) xo = 0;
      else boxW -= xo;
      fillRect(poX + xo, poY - _glyphAb * textsize, boxW, boxH, _textbgcolor);
    }
  }

  int sumX = 0;
  uint16_t len = (uint16_t) strlen(string), n = 0;
  while (n < len) {
    uint16_t uniCode = decodeUtf8((const uint8_t*) string, &n, (uint16_t) (len - n));
    sumX += drawGlyph(uniCode, poX + sumX, poY);
  }
}

void PanelShim::drawString(const String& s, int x, int y) { drawString(s.c_str(), x, y); }

#endif  // CONFIG_IDF_TARGET_ESP32S3
