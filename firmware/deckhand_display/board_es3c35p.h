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

// ---------- Sessions tab: the row list ----------
// THE ROW COUNT IS DELIBERATELY UNCHANGED AT 6. MAX_SESSIONS is a HOST-side cap
// too - host/index.mjs urgency-sorts and truncates to it before sending, and
// sessionsTotal/hiddenAsking describe what it cut - so raising it is a
// protocol-wide change that grows every 5s payload on a BLE link already
// measured as the bottleneck (~666 B/s at 20-byte chunks and the 30ms interval
// macOS negotiates), plus ~2.2KB of DRAM per SessionInfo against ~26KB of free
// heap the audio path also comes out of. So the extra rows this panel could hold
// are spent on TALLER rows instead, and a bigger row count stays a separate
// decision rather than a side effect of a bigger screen.
//
// Content area = 480 - TAB_BAR_H(46) - FOOTER_H(18) = 416, against board 1's 268.
const int SESSION_ROW_X = 12;
// 12/296 rather than board 1's 8/224, so the list and the USAGE column share ONE
// side margin (CARD_X/CARD_W). Board 1's two different margins for the same edge
// are not a distinction worth reproducing, and the argument for 12 is the one
// Task 6 already made for CARD_X: a margin keeps content off the bezel, and it is
// the same physical bezel.
const int SESSION_ROW_W = 296;
// 4 above the first row, EQUAL to SESSION_ROW_GAP below, so the list reads as an
// evenly-spaced stack. Board 1 has 4 above and 3 between, which is not a rhythm,
// just two numbers.
const int SESSION_ROW_Y0 = CONTENT_Y + 4;
// 3, UNCHANGED, and the ladder below DEPENDS on it rather than merely tolerating
// it. At 4 the five-session row comes out at (412-16)/5 = 79 - ONE PIXEL under
// the 79 a title-less tall row needs for its model/branch line - so five
// sessions would silently drop that line to buy a 1px cosmetic gap. The gap's own
// job (separating two 2px borders on a 10px-radius corner) is unchanged from
// board 1 because the border and the radius are.
const int SESSION_ROW_GAP = 3;
// 3px of air at EVERY gap and pad inside a row, which is where this panel's
// surplus height actually goes (the derived offsets are in deckhand_display.ino,
// shared by both boards and collapsing to board 1's literals at SESSION_AIR 0).
// Not a font change: Cozette has 6x13 and a mechanical 12x26 and nothing between,
// so a row's INK is the same height on both boards and only its spacing can grow.
// 3 is chosen by the LADDER, not by taste - see SESSION_TITLE_MIN_H.
const int SESSION_AIR = 3;
// THE PACKED TITLE-ROW STACK, re-derived from board 1's band table with every gap
// and pad grown by SESSION_AIR:
//   +0..+1  border
//   +2..+6  pad 5                 (2 + AIR)
//   +7..+32 name        T_HERO 26 (SESSION_NAME_Y_T = 4 + AIR)
//   +33..+37 gap 5                (2 + AIR)
//   +38..+50 title      13        (SESSION_TITLE_Y)
//   +51..+55 gap 5                (2 + AIR)
//   +56..+68 sub-line   13        (SESSION_SUB_Y)
//   +69..+74 gap 6                (3 + AIR)
//   +75..+92 pill       18        (top = rowH - SESSION_PILL_UP_T, 25)
//   +93..+97 pad 5
//   +98..+99 border               = 100
// i.e. 85 + 5*AIR, the same five gaps/pads board 1 packs at 2/2/2/3/2. 100 is
// what picks AIR = 3, because the ladder's four-session row is exactly 100: at
// AIR 4 the minimum would be 105 against a four-session row that cannot exceed
// 101 on this panel, and four sessions would lose their title line.
const int SESSION_TITLE_MIN_H = 100;
// The title-less tall row: the height at which the pill's first row lands exactly
// ON the sub-line's last ink row, which is the boundary this gate admits.
// Sub-line at +40..+52 (SESSION_SUB2_Y = 6 + AIR + 26 + 2 + AIR), pill top at
// rowH - SESSION_PILL_UP (27), so 27 + 52 = 79 - board 1's 70 + 3*AIR.
const int SESSION_SUB_MIN_H = 79;
// Tall vs compact. 2 (border) + 7 (pad, 4 + AIR) + 26 (name) + 18 (pill) + 7
// (pad) + 2 (border) = 62 - board 1's 56 + 2*AIR. Board 1's 56..69 band (a tall
// row with room for its big name but not its sub-line) is inherited rather than
// closed: it is a deliberate trade there, and six sessions (66) land in this
// board's version of it.
// CONSEQUENCE WORTH KNOWING: the COMPACT layout is UNREACHABLE on this board.
// Six sessions come out at 66 and the strip case at 63, both above 62, so every
// row here is a tall row. The compact path still has to be correct - MAX_SESSIONS
// or the content area could change - but nothing on this panel renders it today.
const int SESSION_LARGE_MIN_H = 62;
// Floor and ceiling. 38 never binds (six sessions are 66); it is the guard for a
// content area that shrinks. The ceiling is SESSION_TITLE_MIN_H (100) plus 6 of
// slack, which the layout spends between the sub-line and the bottom-anchored
// pill - board 1's own relationship (85 + 5), with the 5 scaled by the panel
// ratio: 5 * 6.489/5.624 = 5.77 -> 6.
//
// THE LADDER THIS PRODUCES, avail = 462 - SESSION_ROW_Y0(50) = 412:
//   1 session  412        -> 106  title   (306px of the list left empty)
//   2 sessions 204        -> 106  title   (196 empty)
//   3 sessions 135        -> 106  title   (88 empty)
//   4 sessions 100        -> 100  title   (3 empty - the list fills)
//   5 sessions 80         ->  80  sub-line
//   6 sessions 66         ->  66  big name, no sub-line
// Board 1's ladder for comparison: 90/90/86 title, 63 big name, 50/41 compact.
// So this panel gives a FOURTH session its title line and a fifth its
// model/branch line, which is the whole return on the extra height.
const int SESSION_ROW_H_MIN = 38;
const int SESSION_ROW_H_MAX = 106;
// Centre of the status indicator, and the +23 is NOT scaled - it is the same
// constraint board 1 documents, against the same art. The working spinner is a
// 32x32 BLIT that paints its own background, so its rect (x 19..50 here) has to
// clear the row's 10px corner and the 2px border that follows it. Re-derived at
// this board's dot row (SESSION_DOT_DY 22, so the blit's top row is y+6): the
// border's inner edge on that row sits at x0 + 10 - sqrt(8^2 - 4^2) = x0 + 3.07,
// and the blit's left edge is x0 + 7 - clear by 3.9px, where board 1 has 2.1.
const int SESSION_DOT_CX = SESSION_ROW_X + 23;
// 40, unchanged, and for the same reason: it is set by the 32x32 art, not by the
// panel. The blit owns x SESSION_ROW_X+7..+38 and the name starts 2px clear.
const int SESSION_NAME_DX = 40;
// The sub-line's lane, DERIVED here rather than carried forward: it is the row's
// own text lane, SESSION_ROW_X + SESSION_ROW_W - 12 - (SESSION_ROW_X +
// SESSION_NAME_DX) = 12 + 296 - 12 - 52 = 244. At Cozette's 6px advance that is
// 40 characters against board 1's 30, and buildSessionSubline can only ever emit
// 35 - so on this board a sub-line is never truncated at all.
const int SESSION_SUB_LANE_W = 244;
// 16, UNCHANGED: one Cozette 6x13 line plus 3px. Derived from the text, like
// FOOTER_H, so a bigger panel does not move it.
const int SESSION_OVERFLOW_H = 16;

// ---------- Session detail card and the ask screen ----------
// THE HEADER ROW IS A TOUCH BAND, and this is the one place on this screen where
// the pixel number MUST change to hold the physical target: board 1's 28px band
// carries a 22px chip, both under its own TAP_MIN of 40 and flagged as
// unavoidable there. With 160 more rows it is affordable, so the band is
// TAP_MIN(46) + 4 and the chips inside it are exactly TAP_MIN.
const int DETAIL_HEAD_H = 50;
// "< Back" centred in the band beside a 46px chip that spans +1..+46: the chip's
// centre is +23.5 and a 13px line centred there starts at +17.
const int DETAIL_BACK_Y = 17;
// The card starts exactly where the touch band ends - no overlap, where board 1's
// card border sits 2px inside its own band.
const int DETAIL_CARD_DY = 50;
// 308, and the arithmetic is the running cursor in drawSessionDetail() with
// DETAIL_AIR at every block boundary and this board's line caps:
//   cardY +14 pad | name +34 | title +23 | pill +32 | rule +15 | label +13
//   | prompt 3 lines +43 | rule +15 | label +13 | path 2 lines +32
//   | col label +12 | col values +26 | col label +12  -> cy = +284
// the last values row inks +284..+296, so 9 rows of slack sit above the 2px
// border at +306..+307 (board 1: 8 above +222..+223).
// It must ALSO leave room below itself, which is what caps it: the "answer this
// one on your Mac" line draws at cardY + DETAIL_CARD_H + 8 (+412..+424 here) and
// the "tap here for history" hint inks 446..458 against a contentBottom() of 462.
// 21px between them. Anything past H = 328 collides.
const int DETAIL_CARD_H = 308;
// TYPE. 46 tall = TAP_MIN, where board 1's 22 was half its own floor. 88 wide is
// board 1's 76 held PHYSICALLY (76 / 5.624 = 13.5mm; 13.5 * 6.489 = 87.7), which
// is the right rule for a control rather than for text. The hit zone's extra 24px
// of slop to the left is unchanged in sessions.ino - it is slop on a chip that
// now clears the floor in both dimensions, not part of the target.
const int MSG_BTN_W = 88, MSG_BTN_H = 46;
// THE LINE CAPS ARE DERIVED FROM THE FIELD'S OWN BYTE CAP AND THE MEASURED LANE,
// which is what makes them big enough here to truncate NOTHING - board 1's 2/2
// truncate both fields. The lane is CARD_W - 2*PAD = 260px = 43 characters at
// Cozette's 6px advance; prompt[104] carries at most 100 characters (host cap) =
// 3 lines, and path[68] carries 64 = 2 lines. So 3 and 2, not "more because
// there is room": a fourth prompt line could never hold anything.
const int DETAIL_PROMPT_LINES = 3;
const int DETAIL_PATH_LINES = 2;
// 8px of air at every block boundary inside the card - the same rhythm the USAGE
// tab settled on, and the same direction Task 6 argued for: given surplus, it
// goes around the content rather than into the gaps between cards.
const int DETAIL_AIR = 8;

// TAP_MIN, where board 1's 32 is under its own floor of 40. Affordable for the
// same reason TAB_BAR_H is: the worst case is 4 options plus the SPEAK/TYPE row =
// 5 * (46 + 8) = 270 of the 416px content area, i.e. 65% - the IDENTICAL
// proportion board 1 spends on 5 * (32 + 4) = 180 of 268. So the bigger targets
// cost the detail text nothing in relative terms.
const int ASK_OPT_H = 46;
const int ASK_OPT_GAP = 8;
// READ ALL, right-aligned to the card's own margin exactly as board 1 is
// (150 + 78 = 228 = 240 - CARD_X): 320 - 12 - 90 = 218. 90 is board 1's 78 held
// physically (78 / 5.624 * 6.489 = 90.0), the same rule MSG_BTN_W uses; the
// height is TAP_MIN, and its label's y is derived from the height at the call
// site rather than hardcoded, or a taller chip would draw its text near the top.
const int ASK_READ_BTN_X = 218;
const int ASK_READ_BTN_W = 90;
const int ASK_READ_BTN_H = 46;
// The ask screen's header stack, below a 46px READ ALL chip ending at +46:
// the badge row at +54 (8px of air, the DETAIL_AIR rhythm) inking +54..+66, and
// the title at +75 (another 8) taking up to 2 lines of 17 to +108. Board 1's
// badge at +27 actually starts 1px INSIDE its own 28px touch band; this one
// clears the band at +50 by 4px.
const int ASK_BADGE_Y = 54;
const int ASK_TITLE_Y = 75;
