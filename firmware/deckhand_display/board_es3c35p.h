// Board 2: LCDwiki 3.5" ESP32-S3 Display (ES3C35P / ES3C35P-NS), ST77922
// panel over QSPI, 320x480. Pins copied verbatim from
// /Users/yujia/projects/demo/ES3C35P_Selftest/board_pins.h (LCDWIKI pin
// allocation table for this exact board).
//
// LAYOUT CONSTANTS ARE DELIBERATELY ABSENT. A later task derives them from
// the real panel geometry; a set of guessed numbers sitting in this header
// would look finished, whereas the resulting compile error does not - and a
// compile error is the correct, honest state for this board right now.
#pragma once

#define BOARD_NAME "ES3C35P"
#define BOARD_W 320
#define BOARD_H 480

#define BOARD_USES_TFT_ESPI  0
#define BOARD_BLE_NIMBLE     1
#define BOARD_HAS_MIC        0   // I2S codec exists; the mic PATH is a later spec
#define BOARD_HAS_BEEPER     0   // same - LEDC square wave does not port to I2S
#define BOARD_HAS_SD         1
#define BOARD_HAS_RGBLED     1
#define BOARD_TOUCH_NEEDS_CAL 0  // capacitive, factory-aligned

// ---- LCD: ST77922, 320x480, QSPI. Panel reset is tied to chip EN (no GPIO). --
#define PIN_LCD_CS        10
#define PIN_LCD_SCK       12
#define PIN_LCD_D0        11
#define PIN_LCD_D1        13
#define PIN_LCD_D2        14
#define PIN_LCD_D3         9
#define PIN_LCD_RST       -1
#define PIN_BACKLIGHT     41    // high = backlight on

// ---- Touch: integrated into the ST77922, I2C addr 0x55, shared I2C bus ------
#define PIN_I2C_SDA       38
#define PIN_I2C_SCL       39
#define PIN_TOUCH_RST     48    // active low
#define PIN_TOUCH_INT     47    // active low on touch event

// ---- microSD, SDMMC 4-bit ---------------------------------------------------
#define PIN_SD_CLK         5
#define PIN_SD_CMD         4
#define PIN_SD_D0          6
#define PIN_SD_D1          7
#define PIN_SD_D2          2
#define PIN_SD_D3          3

// ---- Audio: I2S codec + amplifier ------------------------------------------
#define PIN_AMP_EN         1
#define PIN_I2S_MCLK      17
#define PIN_I2S_BCLK      18
#define PIN_I2S_DOUT      15
#define PIN_I2S_LRCK      21
#define PIN_I2S_DIN       16

// ---- Misc ------------------------------------------------------------------
#define PIN_RGB_LED       40    // addressable (WS2812-style) RGB LED
#define PIN_BOOT_BTN       0    // active low
#define PIN_BAT_ADC        8    // battery voltage divider
#define PIN_EXP_IO_A      45
#define PIN_EXP_IO_B      46

// ============================================================================
// LAYOUT - DERIVED FOR 320x480, NOT SCALED FROM BOARD 1
// ============================================================================
// Board 2 has 2x board 1's pixels (80 more columns, 160 more rows) but is only
// ~16% wider and ~30% taller in MILLIMETRES. Measured: board 1 is a 2.8"
// 240x320 panel, so sqrt(240^2+320^2) = 400px over 71.12mm = 5.63 px/mm; this
// is a 3.5" 320x480, so sqrt(320^2+480^2) = 576.9px over 88.9mm = 6.49 px/mm.
// The panel is 49.3 x 74.0mm against board 1's 42.6 x 56.9mm.
//
// THAT RATIO IS WHY NOTHING IS SCALED. A 1.33x scale of board 1's numbers
// would make every element PHYSICALLY LARGER than it is on the smaller board -
// Cozette 6x13 is 2.31mm tall on board 1 and 2.00mm here, and scaling it to
// 8x17 (a size Cozette does not have; see the UI_FONTS note - it ships 6x13 and
// a mechanical 12x26 and nothing between) would make it 2.67mm, spending the
// resolution on making text bigger than it needs to be. So the faces stay put
// and the extra pixels become AIR and ROWS.
//
// The ONE exception is the hero percentage, and it is an exception because it
// has a rung available: it is already Cozette drawn at an integer scale, so
// going from x3 to x4 is exact rather than resampled. At x3 it would be 39px =
// 6.0mm here against 6.9mm on board 1 - the tab's biggest number would be
// PHYSICALLY SMALLER on the bigger screen. At x4 it is 52px = 8.0mm. See
// CARD_HERO_SIZE.

// ---------- Chrome frame ----------
// TOUCH FLOOR FIRST, because the tab bar's height is decided by it. Board 1's
// TAP_MIN is 40px = 7.1mm at 5.63 px/mm; the same physical floor here is
// 7.1 * 6.49 = 46.1 -> 46px. This is a case where the pixel number MUST change
// to keep the physical target the same, the mirror image of the font argument
// above.
const int TAP_MIN = 46;   // 7.1mm, the same fingertip floor board 1 targets

// 46, not board 1's 34, and this is the one thing board 1 explicitly could not
// afford: its own comment records that the bar's four targets are 34 tall,
// "under TAP_MIN (40) - unavoidable". With 160 more rows it IS affordable here,
// so the bar is exactly TAP_MIN and every tab plus the record slot clears the
// floor. It costs no code: drawTabBar() centres its labels at TAB_BAR_H / 2,
// underlines at TAB_BAR_H - 3, and drawFab() sits at recCY() = TAB_BAR_H / 2 -
// every offset in the bar is already derived from this constant.
const int TAB_BAR_H = 46;
const int CONTENT_Y = TAB_BAR_H;
// 18 UNCHANGED, and deliberately so: this number is derived from the TEXT, not
// from the panel. The footer holds one Cozette 6x13 line drawn at
// contentBottom() + 4, so 4 (gap) + 13 (cell) + 1 = 18 and a wider panel does
// not change any of the three. What DID have to move is where the battery pill
// sits across that band - see FOOTER_BATT_X.
const int FOOTER_H = 18;

// Unchanged at 40. The slot's width is set by what it holds - the dot + "REC"
// group is 6 + 3 + 18 = 27px in Cozette 6x13 - not by the panel, and the
// constraint board 1 flagged here was HEIGHT, which TAB_BAR_H above now fixes:
// the target is 40x46 rather than 40x34. The three tabs get
// (320 - 40) / 3 = 93px each against a longest label of 48px ("SESSIONS" at
// Cozette's 6px advance), so they have room to spare either way.
const int TAB_REC_W = 40;

// ---------- USAGE tab: the card column ----------
// Side margin unchanged at 12: a margin's job is keeping the card off the bezel
// and the bezel is the same physical bezel, so this is one of the few numbers
// that genuinely does not scale. CARD_W is then forced: 320 - 2*12 = 296.
const int CARD_X = 12, CARD_W = 296;
// 18, from 14. This one IS proportional - it is the text lane's inset from the
// card edge, and the card grew 216 -> 296 - so holding board 1's ratio
// (14/216 = 6.5%) gives 19.2, taken to 18 to stay on the even grid the 2px
// border and the pin bar sit on. Physically 2.78mm against board 1's 2.49mm.
// The rounded corner is no constraint on it: at the label row (y0+6) a
// RADIUS-10 corner's border reaches only x0+1.7, so 18 is clear by 16px.
const int PAD = 18;
// 12, from 10. Physically 1.85mm against board 1's 1.78mm - i.e. the bar keeps
// its thickness while getting 40% longer (260px of usable lane against 188),
// which is what keeps the pace tick readable rather than hairline.
const int BAR_H = 12;
// 10, UNCHANGED, and it must stay equal to R_MD in deckhand_display.ino. Only
// drawCardBorder() uses RADIUS; the card's FILL underneath it comes from
// uiCard(), which uses R_MD - so a RADIUS that disagrees with R_MD draws a
// stroke on a differently-curved fill and the corners fringe. The design
// system's own note ("two radii only - anything bigger reads as a blob at this
// size") is about absolute visual weight, not a proportion of the card, so
// there is nothing here to re-derive.
const int RADIUS = 10;

// THE COLUMN. Content area = BOARD_H - TAB_BAR_H - FOOTER_H = 480 - 46 - 18 =
// 416, against board 1's 320 - 34 - 18 = 268. Board 1 spends its 268 as
// 4 + 104 + 4 + 104 + 4 + 44 = 264 with 4px of air below, every gap squeezed to
// 4 because the cards could not give any more (its own comment: shrinking them
// to 98 would clip the reset line).
//
// Here the budget is spent with a uniform 8px gap - twice board 1's, which is a
// real separation rather than a hairline - and the surplus goes INSIDE the
// cards as air around the figures you actually read. That direction is the
// inverse of board 1's squeeze and deliberately so: there, gaps were the
// compressible part and the cards were protected; given surplus, the cards are
// where it belongs, because the content is what the tab is for and there is no
// more of it to add.
//
//   8 + 164 + 8 + 164 + 8 + 56 + 8 = 416  (the last 8 is the air below)
//
// so the column runs CONTENT_Y(46)..454 against a contentBottom() of 462.
// THE COLUMN MUST NOT END FLUSH ON contentBottom() - board 1 shipped that once
// (6+104+4+104+4+46 spent all 268) and the Codex row sat against the footer
// reading as one joined block. 8px of air below, matching the gaps above it.
const int CARD_H = 164;
const int CARD1_Y = CONTENT_Y + 8;                 // 54
const int CARD2_Y = CARD1_Y + CARD_H + 8;          // 226
const int CODEX_Y = CARD2_Y + CARD_H + 8;          // 398
const int CODEX_H = 56;                            // ends at 454, 8px clear

// ---------- USAGE tab: inside a Claude card ----------
// CHECK CLEAR BOXES, NOT GLYPHS. drawIfChanged() clears
// fillRect(fx-1, fy-1, tw+2, th+2) before drawing, and drawPaceBar() clears
// fillRect(x-1, y-4, w+2, h+8) to cover its tick's overhang - so every row
// below is the CLEARED extent, which is what can rub out a border, not the
// text's ink. Board 1 learned this at +89: a 13px line there cleared +88..+102
// and the 2px border owns +102..+103, which read as a gap in the card outline
// under exactly those two strings.
//
// THE TWO INVARIANTS, RE-DERIVED FOR CARD_H 164:
//   1. The 2px border owns +162..+163, so NOTHING ON THIS CARD MAY END PAST
//      +161. The last thing on it is CARD_FOOT_Y's clear box, ending +154 -
//      7 rows clear. (Board 1: border +102..+103, ceiling +101, last clear
//      ending exactly +101 with nothing to spare.)
//   2. The label row is +6..+18 because the hero number's box starts at
//      CARD_HERO_Y (+27) and clears from there across the full interior. The
//      13px Cozette label and the 13px Mac icon both live in +6..+18, so the
//      label row has 8 rows of clear air below it here where board 1 had 1.
//
// The interior is +2..+161 = 160 rows. Exclusive content is 1 (the blank row at
// +2) + 3 (pin bar) + 13 (label) + 54 (hero box) + 20 (bar clear) + 15 (stats
// clear) + 15 (foot clear) = 121, leaving 39 rows of gap. Spent as a uniform 8
// between all five bands with the 7 left over going under the last one, where
// it doubles as the border's clearance:
//
//   +0..+1    border
//   +2        blank
//   +3..+5    pin bar        (CARD_PIN_BAR_Y, 3 rows)
//   +6..+18   label / icon   (CARD_LABEL_Y, Cozette 6x13 = 13, icon 13x13)
//   +19..+26  gap 8
//   +27..+80  hero box       (CARD_HERO_Y, CARD_HERO_H 54; the glyph is 52)
//   +81..+88  gap 8
//   +89..+108 pace bar clear (CARD_BAR_Y +93, BAR_H 12: bar +93..+104,
//                             clear +89..+108 for the tick overhang)
//   +109..+116 gap 8
//   +117..+131 stats clear   (CARD_STATS_Y +118, 13px + the 1px clear margin)
//   +132..+139 gap 8
//   +140..+154 foot clear    (CARD_FOOT_Y +141, Fable left / reset-time right)
//   +155..+161 gap 7
//   +162..+163 border
//
// One board-1 defect is deliberately NOT inherited here. There, the stats row
// at +74 clears +73..+87 while the pace bar's clear runs +58..+75, so the two
// OVERLAP by 3 rows and a token count changing erases the bottom of the tick
// until the bar next repaints. Every band above is disjoint, with 8 rows to
// spare, so that cannot happen.
const int CARD_PIN_BAR_Y = 3;
const int CARD_LABEL_Y   = 6;
const int CARD_HERO_Y    = 27;
// 54, for a 52px glyph plus 2px of slack (board 1: 40 for 39px plus 1).
const int CARD_HERO_H    = 54;
// x4, from board 1's x3. THE ONLY THING ON THIS BOARD THAT GETS BIGGER, and it
// is exact rather than resampled: Cozette 6x13 at setTextSize(4) is a whole-
// number 24x52 cell, the same mechanical doubling UI_FONTS already uses for
// T_HERO (6x13 at size 2 = 12x26). At x3 the hero would be 39px = 6.0mm here
// against 6.9mm on board 1 - the tab's headline number physically SHRINKING on
// the larger panel. At x4 it is 8.0mm. Width is no constraint: "100%" is
// 4 x 24 = 96px inside a CARD_W - 2*PAD = 260px lane.
const int CARD_HERO_SIZE = 4;
const int CARD_BAR_Y     = 93;
const int CARD_STATS_Y   = 118;
const int CARD_FOOT_Y    = 141;

// ---------- USAGE tab: inside the Codex row ----------
// Same clear-box arithmetic, for CODEX_H 56. The 2px border owns +54..+55, so
// nothing may end past +53; the last thing is the pace bar's clear, ending +49.
//
//   +0..+1    border
//   +2..+6    gap 5           (board 1 uses the same 5 here, hence the same +8)
//   +7..+21   text clear      (CODEX_TEXT_Y +8, Cozette 6x13; the Mac icon is
//                              drawn at the same +8, its 13 rows inside these 15)
//   +22..+29  gap 8
//   +30..+49  pace bar clear  (CODEX_BAR_Y +34, BAR_H 12: bar +34..+45)
//   +50..+53  gap 4
//   +54..+55  border
//
// 2 + 5 + 15 + 8 + 20 + 4 + 2 = 56.
const int CODEX_TEXT_Y = 8;
const int CODEX_BAR_Y  = 34;

// THE LABEL LANE, RE-DERIVED. Board 1's ceiling is 11 characters and every one
// of the four numbers behind it moves on a wider card, so it is recomputed
// rather than carried forward. Nothing truncates the label - the device draws
// every character it is given - the RIGHT-HAND field's clear box simply erases
// whatever the label left under it, on every tick, a moment later. So the lane
// is bounded by its neighbour:
//
//   right field draws at CARD_X + CARD_W - PAD = 12 + 296 - 18 = 290, TR_DATUM,
//   padded to CODEX_RIGHT_CHARS (20) = 120px in Cozette's 6px advance
//     -> it spans x 170..290, and drawIfChanged clears from fx-1 = 169
//   label starts at CARD_X + PAD = 30
//     -> (169 - 30) / 6 = 23.17 -> 23 characters
//
// Board 1's four numbers for comparison: 214, 93, 26, 11. NONE of them survive.
// Consequence worth knowing: at 23 the tag-versus-window trade in
// renderCodexRow() is no longer load-bearing here the way it is on board 1
// ("CODEX  7d studio" is 16), it is only a margin. The logic is kept identical
// across both boards anyway - a lane that is merely roomier is not a reason for
// the two panels to render different text.
const int CODEX_LANE_CHARS  = 23;
const int CODEX_RIGHT_CHARS = 20;
// The buffer AND the change-only cache that hold a CODEX_LANE_CHARS-wide padded
// string. 32, not 24: a cache exactly as long as its string is this file's
// oldest silent bug, and 23 + 1 NUL is exactly 24. The declaration and the
// cacheSize passed at the call site MUST be this same constant - see the long
// note on cxPctCache/cxRightCache in deckhand_display.ino for what happens when
// they disagree in either direction.
const int CODEX_LANE_CACHE = 32;

// ---------- Footer ----------
// The clock (x=10) and the freshness field (right-aligned at width - 10) need
// nothing: both are pinned to an edge and follow tft.width() already. The
// battery pill is the one zone that is CENTRED, so it has to move.
//
// The group is the 21px glyph + a 4px gap + a 4-character reading (24px) = 49px.
// Centred on a 320px panel: (320 - 49) / 2 = 135.5 -> 135, so the text sits at
// 135 + 25 = 160. Board 1's 88/113 put its group at 88..137 on 240px, centre
// 112.5 against a panel centre of 120 - i.e. it was never exactly centred and
// this is not reproducing that offset.
// Clearances: the clock's 8-character field ends at 58, and the freshness
// field's 11 characters right-aligned at 310 start at 244 - so the battery
// group's 135..184 has 77px of air on its left and 60 on its right.
const int FOOTER_BATT_X      = 135;
const int FOOTER_BATT_TEXT_X = 160;
