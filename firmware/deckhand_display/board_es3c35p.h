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
// INFORMATIONAL ONLY - these two gate nothing and are read nowhere in the
// sketch. They record hardware this board has and the firmware does not use, so
// that a future feature has a name to hang off rather than rediscovering the
// peripheral. Said explicitly because this repo has already deleted one
// declared-but-unwired global (macEmojiId) whose comments implied it was live,
// and an unread flag that does NOT say so is the same trap: the next reader
// cannot tell "gates nothing yet" from "gates something I have not found".
#define BOARD_HAS_SD         1   // microSD slot on the SDMMC bus; no SD code exists
#define BOARD_HAS_RGBLED     1   // WS2812 on GPIO40; nothing drives it
#define BOARD_TOUCH_NEEDS_CAL 0  // capacitive, factory-aligned
// NO TOUCH WAKE FROM DEEP SLEEP, and this is a silicon fact rather than a gap
// in the port. Both ext0 and ext1 wake ONLY from an RTC GPIO, and on the S3 the
// RTC set is GPIO0..21 - read out of the installed headers rather than assumed:
// soc_caps.h gives SOC_RTCIO_PIN_COUNT 22 and rtc_io_channel.h maps exactly
// RTCIO_CHANNEL_0..21 onto GPIO0..21. PIN_TOUCH_INT is 47, so neither ext0 nor
// ext1 can take it (esp_sleep_enable_ext*_wakeup returns ESP_ERR_INVALID_ARG
// for a non-RTC pin), and the C3/C6-style esp_deep_sleep_enable_gpio_wakeup()
// escape hatch does not exist here either - SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
// is not defined in the S3's soc_caps.h at all.
// The one RTC-capable pin a person can press is PIN_BOOT_BTN (0), and that is
// refused for the SAME reason board 1 refuses it: GPIO0 is the boot strap, so a
// wake with it held low lands the chip in the serial bootloader and the device
// looks bricked. So on this board deep sleep is exited by RESET, and every
// farewell screen says exactly that instead of promising a touch.
//
// READ THE NAME PRECISELY: this says nothing about LIGHT sleep, and the
// distinction is a real one that the first version of this comment blurred.
// esp_sleep_enable_gpio_wakeup() (esp_sleep.h) is NOT behind
// SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP and accepts ANY IO, GPIO47 included - so a
// light-sleep idle WOULD wake on touch here. That matters more than it sounds:
// the backlight is ~93% of this device's draw and light sleep removes it too, so
// most of what auto-sleep was for is reachable without deep sleep at all.
// Auto-sleep is currently gated off this flag (see the loop() call site), which
// is therefore MORE conservative than the silicon requires - a deliberate
// stopping point for this port rather than a limit. Restoring an idle sleep on
// this board means light sleep plus gpio_wakeup_enable(PIN_TOUCH_INT,
// GPIO_INTR_LOW_LEVEL), and it needs its own pass: light sleep interacts with
// the USB CDC link the host talks over, with NimBLE's connection timing, and
// with the millis() the whole UI schedules on, none of which this port measured.
#define BOARD_HAS_TOUCH_SLEEP_WAKE 0

// The ST77922 takes RGB565 HIGH BYTE FIRST, while the shadow framebuffer holds
// native little-endian uint16 - so the strip copy in PanelShim::flush() swaps
// every pixel on the way out. Getting this wrong is not subtle once you know the
// signature but is very easy to miss: a byte-swapped blue (0x001F) arrives as
// 0x1F00, which is a dark GREEN, so the whole UI reads as wrong-but-plausible
// rather than as obviously broken. It also cannot be caught by SCREENSHOT, and
// that is the trap - readRect reads the FRAMEBUFFER, not the panel, so a capture
// looks perfectly correct while the glass does not. Use COLORTEST for this
// question; it is the only instrument that answers it.
// The demo project this port is based on pushes its buffer the same way and its
// notes say only that "bars/ramp/grid render" - a rendering claim, not a colour
// one - so the demo very likely had this too and nobody looked.
// The swap costs a per-pixel loop instead of a memcpy on the flush path only.
// Board 1 writes its panel directly through TFT_eSPI and never sees this.
#define BOARD_PANEL_SWAP_BYTES 1

// This panel is NATIVELY INVERTED: it needs display-inversion ON to look normal,
// proved by turning it off - every colour came back as its exact complement
// (WHITE black, GREEN purple, BLUE yellow) and turning it back on fixed it.
//
// It is applied in PanelShim::begin() and NOT left to the init table, because the
// table cannot deliver it. The recovered vendor sequence sends 0x21 (INVON)
// BEFORE 0x11 (SLPOUT), and sleep-out resets the inversion state - so the setting
// is wiped microseconds after being made. That is why the table entry looked
// correct for the whole port and never did anything, and why a runtime
// `INV 1` was the only thing that ever fixed the screen. An init table recovered
// from a binary preserves the vendor's ORDER as faithfully as its values, and the
// order can be the bug.
#define BOARD_PANEL_INVERT 1

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

// ---- Names the SHARED sketch code uses, mapped onto the pins above ---------
// Aliases, not new pins: these are the identifiers board 1's header established
// and the shared .ino files spell, pointed at this board's numbers. Deliberately
// only the ones that HAVE an equivalent here - AUDIO_OUT_PIN, AUDIO_EN_PIN and
// MIC_ADC_PIN are absent on purpose, because BOARD_HAS_BEEPER and BOARD_HAS_MIC
// are 0 and an alias for a peripheral this board does not have is exactly the
// "looks right and is wrong" failure this header's opening comment refuses.
// (PIN_AMP_EN exists, but it gates an I2S codec: an LEDC square wave into it
// makes no sound, so pointing AUDIO_OUT_PIN at an I2S data line would compile
// and lie.)
#define TFT_BL_PIN    PIN_BACKLIGHT
#define BAT_ADC_PIN   PIN_BAT_ADC
#define BOOT_BTN_PIN  PIN_BOOT_BTN
// Portrait native: the panel is physically 320x480 and PanelShim's framebuffer
// is fixed at that orientation (PANEL_PHYS_W/H), so rotation 0 is the identity
// map. The FLIP setting's rotation 2 is the only other value either board uses,
// and PanelShim::mapPoint implements all four.
#define SCREEN_ROTATION 0
// CONFIRMED BY MEASUREMENT, and this comment used to say UNVERIFIED. It started
// as a guess: the LCDWIKI table for this board says only "battery voltage
// divider" with no ratio, and the ES3C35P self-test this header's pins came from
// assumes x2 as well - assumes, not measures. x2 is the ordinary 100K/100K
// arrangement and matches board 1, so it was the right guess, but a wrong ratio
// makes every percentage AND the whole time-remaining estimator wrong while
// looking perfectly plausible, which is why it was not left as one.
// The measurement, on a real cell: the device reported mv=3910..3929,
// pct=63..66. A single-cell Li-ion at 3.92V really does sit around 60-70%, and
// the two wrong answers are not close - a x1 ratio would have read ~1.96V and a
// x4 one ~7.8V, both obviously absurd for a 1S cell. So the ratio is settled by
// the reading it produces rather than by a meter across the divider.
// BE PRECISE ABOUT WHAT THAT ARGUMENT CAN SETTLE, because it is weaker than it
// first looks: plausibility rules out x1 and x4, and it CANNOT distinguish x2
// from x1.8 or x2.2. At 2.2x a real 3.55V cell reads 3.91V, which this curve
// shows as ~63% when the truth is nearer 30% - a wrong reading that looks
// entirely reasonable, and the whole battMinutesLeft() estimator sits on top of
// it. So this is an instrument certifying itself: the only thing that closes it
// is a meter across the divider, or a cell at a known voltage.
// If board 2's battery percentage ever reads wrong anyway, this is still the
// first number to check before pctFromMv()'s curve.
#define BOARD_BAT_MV_SCALE 2

// ============================================================================
// LAYOUT - DERIVED FOR 320x480, NOT SCALED FROM BOARD 1
// ============================================================================
// Board 2 has 2x board 1's pixels (80 more columns, 160 more rows) but is only
// ~16% wider and ~30% taller in MILLIMETRES. Measured: board 1 is a 2.8"
// 240x320 panel, so sqrt(240^2+320^2) = 400px over 71.12mm = 5.62 px/mm; this
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
// The hero percentage no longer needs an exception here, now that board 2 has
// its own native font registry (see UI_FONTS in deckhand_display.ino): T_HERO
// is Spleen32x64 at size 1, so there is no scale factor left for this file to
// argue about - CARD_HERO_SIZE is gone. At 64px that is 9.86mm, bigger than
// board 1's 6.9mm hero (Cozette 6x13 pushed to size 3 - one step past its own
// T_HERO registry entry, itself already size 2) rather than merely matching
// it: Spleen's only rung above 12x24 is 32x64, and there is nothing between
// them to land closer.

// ---------- Chrome frame ----------
// TOUCH FLOOR FIRST, because the tab bar's height is decided by it. Board 1's
// TAP_MIN is 40px = 7.1mm at 5.62 px/mm; the same physical floor here is
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
// 20, up from 18, because T_BODY is now a 16px line and drawIfChanged clears
// th + 2 = 18 rows - which fits an 18px band EXACTLY, with no room for the 1px
// margin every other band in this file has. THIS DOES NOT GIVE THE BAND 2PX OF
// SLACK, and an earlier version of this comment claimed it did: renderFooter()
// draws at y = contentBottom() + 4, and drawIfChanged erases from y - 1, so the
// clear reaches row contentBottom() + 4 - 1 + 18 - 1 = contentBottom() + 20 =
// 480 - one row past the last valid pixel on this panel, silently clamped by
// PanelShim::clipLogicalRect. The real margin is 0, i.e. FLUSH, exactly the old
// 13px-line-in-an-18px-band case - this value is re-derived for the taller
// line, not actually more generous than the one it replaces. Costs 2px of
// content area (416 -> 414), which the usage column absorbs: it ends at 454
// against a contentBottom() that moves 462 -> 460, so its clearance goes
// 8px -> 6px and it still does not end flush.
const int FOOTER_H = 20;

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
// RE-DERIVED FOR A NATIVE 64PX HERO. drawBigNumber() no longer scales its font
// (the tft.setTextSize(CARD_HERO_SIZE) call in deckhand_display.ino is now
// guarded to board 1 only): T_HERO on this board is Spleen32x64 at its own
// native size 1, so the glyph is simply 64px tall with nothing to multiply.
// T_BODY/T_META also grew under this same font swap - Spleen8x16 (uiLineH()
// 16) against Cozette's 13 - so the label and stats/foot rows below are each
// 3 rows taller than the derivation this replaces.
//
// THE TWO INVARIANTS, RE-DERIVED FOR CARD_H 164:
//   1. The 2px border owns +162..+163, so NOTHING ON THIS CARD MAY END PAST
//      +161. The last thing on it is CARD_FOOT_Y's clear box, ending +156 -
//      5 rows clear. (Board 1: border +102..+103, ceiling +101, last clear
//      ending exactly +101 with nothing to spare.)
//   2. The label row is +6..+21 (Spleen8x16, 16px) and the hero box starts at
//      +24 (CARD_HERO_Y) - 2 rows clear between them, so the label never
//      touches the hero it sits above.
//
// The interior is +2..+161 = 160 rows. Exclusive content is 1 (the blank row at
// +2) + 3 (pin bar) + 16 (label) + 65 (hero box) + 20 (bar clear) + 18 (stats
// clear) + 18 (foot clear) = 141, leaving 19 rows of gap - the hero box alone
// ate 11 of the 39 rows of gap the old, smaller hero left spare:
//
//   +0..+1    border
//   +2        blank
//   +3..+5    pin bar        (CARD_PIN_BAR_Y, 3 rows)
//   +6..+21   label / icon   (CARD_LABEL_Y, Spleen8x16 = 16, icon 13x13 inside it)
//   +22..+23  gap 2
//   +24..+88  hero box       (CARD_HERO_Y, CARD_HERO_H 65; the glyph is 64)
//   +89..+90  gap 2
//   +91..+110 pace bar clear (CARD_BAR_Y +95, BAR_H 12: bar +95..+106,
//                             clear +91..+110 for the tick overhang)
//   +111..+116 gap 6
//   +117..+134 stats clear   (CARD_STATS_Y +118, 16px + the drawIfChanged margin)
//   +135..+138 gap 4
//   +139..+156 foot clear    (CARD_FOOT_Y +140, Fable left / reset-time right)
//   +157..+161 gap 5
//   +162..+163 border
//
// One board-1 defect is deliberately NOT inherited here. There, the stats row
// at +74 clears +73..+87 while the pace bar's clear runs +58..+75, so the two
// OVERLAP by 3 rows and a token count changing erases the bottom of the tick
// until the bar next repaints. Every band above is disjoint - tighter than the
// old derivation's uniform 8px gaps, but never negative - so that cannot happen.
const int CARD_PIN_BAR_Y = 3;
const int CARD_LABEL_Y   = 6;
const int CARD_HERO_Y    = 24;
// 65, for a 64px native glyph plus 1px of slack - the same convention board 1
// uses (40 for a 39px glyph, also plus 1). CARD_HERO_SIZE is gone from this
// board, so unlike the constant this replaces, no size multiplier is baked
// into this height: 64 is simply what Spleen32x64 draws.
const int CARD_HERO_H    = 65;
const int CARD_BAR_Y     = 95;
const int CARD_STATS_Y   = 118;
const int CARD_FOOT_Y    = 140;

// ---------- USAGE tab: inside the Codex row ----------
// Same clear-box arithmetic, for CODEX_H 56, RE-DERIVED for the 16px text row
// (Spleen8x16, against Cozette's 13 - the same font swap the cards above went
// through). The 2px border owns +54..+55, so nothing may end past +53; the
// last thing is the pace bar's clear, ending +52.
//
//   +0..+1    border
//   +2..+6    gap 5           (unchanged - a leading gap doesn't care how tall
//                              the content after it is)
//   +7..+24   text clear      (CODEX_TEXT_Y +8, Spleen8x16 = 16 -> an 18-row
//                              drawIfChanged clear; the Mac icon is drawn at
//                              the same +8, its 13 rows inside these 18)
//   +25..+32  gap 8
//   +33..+52  pace bar clear  (CODEX_BAR_Y +37, BAR_H 12: bar +37..+48)
//   +53       gap 1
//   +54..+55  border
//
// 2 + 5 + 18 + 8 + 20 + 1 + 2 = 56.
const int CODEX_TEXT_Y = 8;
const int CODEX_BAR_Y  = 37;

// THE LABEL LANE, RE-DERIVED - AND RE-DERIVED AGAIN, because the first pass
// through this file (23) carried Cozette's 6px advance over into a formula
// this board no longer uses. renderCodexRow() draws both fields with font id
// 2 (T_BODY), which on this board is Spleen8x16 - EVERY glyph declares
// xAdvance 8 with xOffset 0 (verified: Spleen is genuinely monospace, unlike
// Cozette, whose ink widths vary but whose xAdvance is uniformly 6 - the fact
// the original /6 relied on). At the wrong 23 characters x 8px = 184px, the
// label overlapped the right field's own reserved 20 x 8 = 160px lane by
// ~84px - and not as a rare worst case: the right field pads to its FULL
// width on every tick specifically to keep its clear box stable (see
// renderCodexRow()'s comment on padTo/padLeftTo), so it erased the tail of
// the label continuously, every ~5s tick, for as long as this board has had
// its own font registry. Nothing truncates the label - the device draws
// every character it is given - so the lane is bounded by its neighbour:
//
//   right field draws at CARD_X + CARD_W - PAD = 12 + 296 - 18 = 290, TR_DATUM,
//   padded to CODEX_RIGHT_CHARS (20) = 160px in Spleen8x16's 8px advance
//     -> it spans x 130..290, and drawIfChanged clears from fx-1 = 129
//   label starts at CARD_X + PAD = 30
//     -> (129 - 30) / 8 = 12.375 -> 12 characters
//
// Board 1 is untouched by any of this - it is still Cozette at 6px, so its
// own (93 - 26) / 6 = 11.17 -> 11 in board_e32r28t.h is unaffected and stays
// literal there rather than risking board 1's byte-identical binary on an
// equivalent-but-different-looking expression. Consequence worth knowing: at
// 12, the tag-versus-window trade in renderCodexRow() IS load-bearing here
// too now, the same way it already is on board 1 ("CODEX  7d studio" is 16,
// over the 12-character ceiling; "CX studio" is 9, comfortably under it) -
// the roomier-lane assumption in the comment this replaces no longer holds.
const int CODEX_LANE_CHARS  = 12;
const int CODEX_RIGHT_CHARS = 20;
// The buffer AND the change-only cache that hold a CODEX_LANE_CHARS-wide
// padded string. Sized to the RIGHT field's worst case, not the label's -
// CODEX_LANE_CACHE is shared by both drawIfChanged() calls in
// renderCodexRow(), and the right field's content ("100%  23h 59m left
// 23:59", 25 chars) is longer than the label ever is. 32, not 26: a cache
// exactly as long as its string is this file's oldest silent bug. The
// declaration and the cacheSize passed at the call site MUST be this same
// constant - see the long note on cxPctCache/cxRightCache in
// deckhand_display.ino for what happens when they disagree in either
// direction.
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
// THE ROW COUNT IS DELIBERATELY UNCHANGED AT 6, on the half of board 1's argument
// that actually transfers. MAX_SESSIONS is a HOST-side cap too - host/index.mjs
// urgency-sorts and truncates to it before sending, and sessionsTotal/hiddenAsking
// describe what it cut - so raising it is a PROTOCOL-WIDE change, touching
// host/index.mjs and growing every 5s payload on a BLE link already measured as
// the bottleneck (~666 B/s at 20-byte chunks and the 30ms interval macOS
// negotiates). That reason is panel-independent and is the load-bearing one here.
// Board 1's OTHER reason does NOT transfer and must not be repeated as if it did:
// ~2.2KB of DRAM per SessionInfo against ~26KB of free heap is an ESP32-with-no-
// PSRAM figure, and this board has PSRAM (PSRAM=opi in the FQBN) plus an S3's
// larger internal SRAM, so the memory half of that argument would have to be
// re-measured rather than assumed. It is not measured here, because the protocol
// reason settles the question on its own. So the extra rows this panel could hold
// are spent on TALLER rows, and a bigger row count stays a separate decision with
// its own host-side work rather than a side effect of a bigger screen.
//
// Content area = 480 - TAB_BAR_H(46) - FOOTER_H(20) = 414, against board 1's 268.
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
// 3, UNCHANGED from board 1, and it is a JUDGEMENT rather than a derivation -
// the previous version of this comment claimed otherwise and the arithmetic was
// simply wrong. It said that at 4 the five-session row comes out at
// (412 - 16)/5 = 79, "ONE PIXEL under the 79 a title-less tall row needs". 79 is
// not under 79, and the gate is `rowH >= SESSION_SUB_MIN_H` (sessions.ino), so at
// gap 4 the sub-line still draws. Re-derived properly: at gap 4 the ladder is
// 106/106/106/100/79/65 against gap 3's 106/106/106/100/80/66, and every rung
// still clears its own threshold (100 >= TITLE 100, 79 >= SUB 79, 65 >= LARGE
// 62). Nothing is lost at 4.
// So the reason to keep 3 is not that 4 breaks something - it is that 3 is board
// 1's value, the gap's job is unchanged (separating two 2px borders on a 10px
// radius, and both the border and the radius are the same here), and SESSION_AIR
// already spends this board's surplus on the rows themselves where it is visible.
// A future change to 4 costs the five- and six-session rungs one pixel each and
// nothing else. NOTE the contrast with SESSION_AIR = 3, which IS genuinely forced
// as an upper bound - do not read this comment as covering that one.
const int SESSION_ROW_GAP = 3;
// THE TWO INK HEIGHTS THE ROW STACK IS BUILT FROM. Board 1 declares 26/13 (see
// its own header); these are this board's native Spleen scale, and they are what
// make every threshold below differ from board 1's by more than SESSION_AIR.
//
// SESSION_LINE_H is uiLineH(T_BODY) = 16, three pixels taller than Cozette's 13,
// and a title row carries TWO of those lines - so the stack grew 6px before any
// air was added.
//
// SESSION_NAME_H IS 24, THE HEAD RUNG, NOT THE 64px HERO - and this is the one
// judgement in the section, so here is the arithmetic that forced it. The name is
// drawn into a MEASURED lane (drawSessionRow computes it from the real CLAUDE/mac
// tag beside it), and that lane is 134px with two Macs connected, 190px with one.
// At Spleen 32x64's 32px advance that is FOUR characters, or five - so a 64px band
// would spend 40 more pixels of every row on a face that virtually every real
// project name shrinks straight out of, and "deck..." at 64px is worse than
// `deckhand` whole at 24px. It also costs whole LINES: at a 64px band the packed
// title stack is 129 (AIR 0) and the ladder's four-session rung is 100, so four
// sessions lose their title, five lose the model/branch line, and rows five and
// six fall to the compact layout. Priced and rejected.
// WHAT IT COSTS, stated plainly: 24px here is 3.70mm against board 1's 26px at
// 4.62mm, so the project name is physically SMALLER on the bigger panel - the one
// place in this port where that is true. The compensation is real but is not size:
// Spleen 12x24 is a hand-drawn face at its native size, where board 1's 12x26 is a
// mechanical 2x upscale of a 6x13 one, so the ink is genuinely sharper. If a future
// panel wants the hero rung here, it needs a WIDER name lane before a taller row.
const int SESSION_NAME_H = 24;   // uiLineH(T_HEAD), Spleen 12x24
const int SESSION_LINE_H = 16;   // uiLineH(T_BODY), Spleen 8x16
// Where drawSessionRow's name ladder starts, as an index into its NAME_RUNGS[]
// { T_HERO, T_HEAD, T_BODY }: 1, i.e. T_HEAD, because T_HERO's 64px cell does not
// fit the 24px band above. This is the height half of the ladder's test - the
// width half is measured at the call site - and it is a constant rather than a
// runtime `uiLineH(rung) > SESSION_NAME_H` check because board 1's binary is held
// byte-identical and a runtime test costs it flash. sessions-geom-check.mjs
// asserts the invariant instead (the top rung's cell fits the band AND is the
// tallest that does), against the parsed UI_FONTS[] table, so the constant cannot
// drift from the fonts without a checker failure.
const int SESSION_NAME_TOP_RUNG = 1;
// 1px of air at EVERY gap and pad inside a row (the derived offsets are in
// deckhand_display.ino, shared by both boards and collapsing to board 1's
// literals at SESSION_AIR 0).
//
// 1, NOT the 3 this board carried while its rows were laid out on 13px lines, and
// the DERIVATION RULE changed rather than just the number. It used to be "the
// largest air at which four sessions keep their title", which now gives 2 (a
// packed stack of 99 against the four-session rung's 100). Air is now picked by
// the tighter of the TWO gates the ladder lands near, because the 16px line moved
// the second one into range: at AIR 2 the five-session rung (79) clears
// SESSION_SUB_MIN_H (77) with a ONE-PIXEL sub-line-to-pill gap, which is the exact
// hazard the old version of this comment was written to warn about. At AIR 1 that
// gap is 4px and four sessions still keep their title with 6px of margin instead
// of 1. The 5px of row height it gives up at the ceiling is not lost: the pill is
// bottom-anchored, so a row taller than the packed stack spends the surplus in the
// sub-line-to-pill gap anyway.
const int SESSION_AIR = 1;
// THE PACKED TITLE-ROW STACK, re-derived from board 1's band table with every gap
// and pad grown by SESSION_AIR and the ink from the two heights above:
//   +0..+1  border
//   +2..+4  pad 3                 (2 + AIR)
//   +5..+28 name        T_HEAD 24 (SESSION_NAME_Y_T = 4 + AIR)
//   +29..+31 gap 3                (2 + AIR)
//   +32..+47 title      16        (SESSION_TITLE_Y)
//   +48..+50 gap 3                (2 + AIR)
//   +51..+66 sub-line   16        (SESSION_SUB_Y)
//   +67..+70 gap 4                (3 + AIR)
//   +71..+88 pill       18        (top = rowH - SESSION_PILL_UP_T, 23)
//   +89..+91 pad 3
//   +92..+93 border               = 94
// i.e. 33 + SESSION_NAME_H + 2*SESSION_LINE_H + 5*AIR, where the 33 is the two
// borders plus the pill and the five gaps/pads board 1 packs at 2/2/2/3/2 (top
// pad, name->title, title->sub, sub->pill, bottom pad). THE FIVE GAPS, NAMED,
// because the identity is only a derivation if each one is real: they are 3/3/3/4/3
// here, each board 1's own value plus AIR, and nothing else in the stack is a gap.
// Against board 1's 85 the difference is +5 of air, +6 of line (two lines, 13->16)
// and -2 of name band (26->24) = 94.
// The four-session rung is 100, so this clears its gate by 6px - where board 1's
// three-session rung (86) clears its own by 1.
const int SESSION_TITLE_MIN_H = 94;
// The title-less tall row: the height at which the pill's first row lands exactly
// ON the sub-line's last ink row, which is the boundary this gate admits.
// Sub-line at +34..+49 (SESSION_SUB2_Y = 6 + AIR + 24 + 2 + AIR), pill top at
// rowH - SESSION_PILL_UP (25), so 25 + 49 = 74.
//
// AIR 1 is a MARGIN CHOICE, not something this gate (or the TITLE_MIN_H one
// above) forces - written out, AIR 2 clears both of them too: the title gate
// stays 89 + 5*2 = 99 <= 100, and this gate's own five-session sub-line-to-pill
// gap is 7 - 3*2 = 1, still `>= 0`. What AIR 1 buys over AIR 2 is margin, not
// passing where AIR 2 would fail: the ladder gives five sessions 79, so the
// sub-line inks to +49 and the pill starts at 79 - 25 = +54 - a 4px gap, where
// AIR 2 would leave 1 - and `avail` would have to lose 23px before that reaches
// zero. The previous geometry sat on a 0px edge and a 1px change to FOOTER_H was
// enough to make the pill draw over the text - which is exactly what happened
// when FOOTER_H moved 18 -> 20, and sessions-geom-check.mjs reported it as
// `FAIL 5x79 (sub): sub-line -> pill gap -1` rather than leaving it to the glass.
// That near-miss is why the extra margin was worth 5px of row height. The gate
// itself is still a `>=`, i.e. it still admits the touching case; AIR 1 just
// keeps the ladder's rungs further from that edge than AIR 2 would.
const int SESSION_SUB_MIN_H = 74;
// Tall vs compact. 2 (border) + 5 (pad, 4 + AIR) + 24 (name) + 18 (pill) + 5
// (pad) + 2 (border) = 56, which is board 1's number exactly - a coincidence worth
// naming so nobody reads it as a copied literal: this board's band is 2px shorter
// and its pads 1px taller, and -2 + 2*1 = 0. Board 1's 56..69 band (a tall row
// with room for its big name but not its sub-line) is inherited rather than closed:
// it is a deliberate trade there, and six sessions (65) land in this board's
// version of it, which now runs 56..73.
// CONSEQUENCE WORTH KNOWING: the COMPACT layout is UNREACHABLE on this board.
// Six sessions come out at 65 and the strip case at 62, both above 56, so every
// row here is a tall row. The compact path still has to be correct - MAX_SESSIONS
// or the content area could change - but nothing on this panel renders it today.
const int SESSION_LARGE_MIN_H = 56;
// Floor and ceiling.
//
// 47, NOT board 1's 38, and this is the one number in the section that is a fix
// rather than a re-derivation. The floor is the guard for a content area that
// shrinks, so it has to be the smallest height the COMPACT layout can legally
// draw: that layout's sub-line inks SESSION_SUBC_Y..+15 (+29..+44 here) and the
// 2px border owns rowH-2..rowH-1, so a legal row needs
// rowH >= SESSION_SUBC_Y + SESSION_LINE_H + 2 = 47. Board 1's 38 is 2 SHORT of its
// own equivalent (25 + 13 + 2 = 40), which is not hypothetical: seven or more
// sessions there put six rows at exactly 38 and the model/branch line is drawn over
// the row's own outline. That defect is documented in board_e32r28t.h and in
// sessions-geom-check.mjs and deliberately not fixed (board 1's binary is held
// byte-identical across this port) - but inheriting the magic number into a new
// board would be inheriting the bug, so this one is derived. Note the "+ 15" that
// used to be written here was itself 13 + 2, i.e. a line height with a literal
// baked in; at a 16px line it is +18.
// It never binds today either way: six sessions are 65, 62 with the strip.
//
// The ceiling is SESSION_TITLE_MIN_H (94) plus 6 of slack, which the layout spends
// between the sub-line and the bottom-anchored pill - board 1's own relationship
// (85 + 5), with the 5 scaled by the panel ratio: 5 * 6.489/5.624 = 5.77 -> 6.
//
// THE LADDER THIS PRODUCES, avail = contentBottom(460) - SESSION_ROW_Y0(50) = 410:
//   1 session  410 -> 100  title     (307px of the list left empty)
//   2 sessions 203 -> 100  title     (207 empty)
//   3 sessions 134 -> 100  title     (104 empty)
//   4 sessions 100 -> 100  title     (1 empty - the list fills)
//   5 sessions  79 ->  79  sub-line  (clears its gate by 5)
//   6 sessions  65 ->  65  big name, no sub-line (clears its gate by 9)
// Board 1's ladder for comparison: 90/90/86 title, 63 big name, 50/41 compact.
// So this panel still gives a FOURTH session its title line and a fifth its
// model/branch line - the whole return on the extra height - at a 16px line
// rather than a 13px one, which is what this re-derivation had to preserve.
// With the "+N more" strip (avail 391) the rungs are 100/100/100/95/75/62, and
// only the SIX-row case is reachable: the host caps its list at MAX_SESSIONS, so
// hiddenCount > 0 implies sessionCount == 6. The others are checked anyway.
const int SESSION_ROW_H_MIN = 47;
const int SESSION_ROW_H_MAX = 100;
// Centre of the status indicator, and the +23 is NOT scaled - it is the same
// constraint board 1 documents, against the same art. The working spinner is a
// 32x32 BLIT that paints its own background, so its rect (x 19..50 here) has to
// clear the row's 10px corner and the 2px border that follows it. Re-derived at
// this board's dot row: SESSION_DOT_DY is now SESSION_NAME_Y + SESSION_NAME_H / 2
// = 19 (it was 22 while the band was 26 and AIR 3), so the blit's top row is y+3
// and the border's inner edge there sits at x0 + 10 - sqrt(8^2 - 7^2) = x0 + 6.13
// against a blit left edge of x0 + 7 - clear by 0.87px, which is board 1's own
// figure at the same dot row rather than the 3.9px a lower dot used to buy. Tight,
// asserted, and the same clearance board 1 has shipped with all along.
const int SESSION_DOT_CX = SESSION_ROW_X + 23;
// 40, unchanged, and for the same reason: it is set by the 32x32 art, not by the
// panel. The blit owns x SESSION_ROW_X+7..+38 and the name starts 2px clear.
const int SESSION_NAME_DX = 40;
// The sub-line's lane, DERIVED here rather than carried forward: it is the row's
// own text lane, SESSION_ROW_X + SESSION_ROW_W - 12 - (SESSION_ROW_X +
// SESSION_NAME_DX) = 12 + 296 - 12 - 52 = 244. At Spleen 8x16's 8px advance that
// is 30 characters, and buildSessionSubline can emit 35 - so a sub-line CAN be
// trimmed here, and the previous version of this note ("40 characters ... never
// truncated at all") was arithmetic done at Cozette's 6px advance before this
// board had its own faces. 30 is the same count board 1 gets from its narrower
// lane, so the worst case is unchanged rather than newly introduced: fitText trims
// with "..." at the measured lane, which is what the whole "lanes are measured,
// never counted" rule exists for.
const int SESSION_SUB_LANE_W = 244;
// The "+N more" strip's reserved band. Derived from the TEXT, like FOOTER_H, so a
// bigger panel does not move it - but it moves with the FACE: one SESSION_LINE_H
// line plus 3px, which is 19 here against board 1's 16. Left at 16 the strip's own
// 16px line plus drawIfChanged's 1px margins would have cleared into the footer's
// first drawn row; sessions.ino now places the strip at
// contentBottom() - SESSION_OVERFLOW_H + 4, board 1's own relationship, so both
// boards keep the same 1-row overhang into the footer's padding and no more.
const int SESSION_OVERFLOW_H = 19;

// ---------- THE EXPANDED FIRST ROW ----------
// WHY THIS EXISTS AT ALL, in one number: with ONE session the ladder above draws a
// 100px row and then 307px of nothing - 75% of the list area - because every rung
// is capped at SESSION_ROW_H_MAX and there is nothing else on the tab. Board 1 has
// no such surplus (its one-session rung is 90 of a 264px area, and its cap exists
// for the same reason), so it never expands: sessionExpandedH() returns 0 there
// unconditionally and none of the constants below exist on that board.
//
// THE RULE, and it is arithmetic on the ladder rather than a second layout:
//   leftover = avail - (count - 1) * (sessionRowH + SESSION_ROW_GAP)
//   expanded = leftover < SESSION_EXP_MIN_H ? 0 : min(leftover, SESSION_EXP_MAX_H)
// i.e. the TOP row of the urgency-sorted list absorbs exactly what the ladder
// would have left empty, every other row keeps the height the ladder already gave
// it, and the whole thing collapses to today's uniform list the moment the ladder
// fills the column. The leftover is derived from the GLOBAL sessionRowH - the
// ladder's own output - and not from a second copy of the ladder formula, so the
// two cannot drift.
//
// THE SIX HEIGHTS, avail 410 (see the ladder above):
//   1 session  leftover 410 -> 212 (cap)   prompt 4 lines   198px spare
//   2 sessions leftover 307 -> 212 (cap)   prompt 4 lines    95px spare, below
//   3 sessions leftover 204 -> 204         prompt 3 lines     0px - the list fills
//   4 sessions leftover 101 ->   0         the ladder already fills the column
//   5 sessions leftover  82 ->   0
//   6 sessions leftover  70 ->   0
// With the "+N more" strip (avail 391) only the six-row case is reachable, and it
// is 66 -> 0. So expansion is a ONE-to-THREE session behaviour by arithmetic, not
// by a special case at either end.
//
// AND A LONE CARD IS CENTRED IN THE LIST AREA (sessionRowYAt), which is the other
// half of the one-session case: 212 of 410 leaves 198px, and all of it sitting
// BELOW the card reads as "a card, then nothing" no matter how much the card
// carries. Centred it is 99px above and 99 below. ONLY when the card is alone - in
// a mixed layout the stack's top alignment is the rhythm, and dropping the first
// card would open a gap above a list that still ends flush at the bottom.
//
// SESSION_EXP_MIN_H IS THE PACKED STACK, exactly the way SESSION_TITLE_MIN_H is,
// and below it the card cannot draw its content at all - which is why the rule
// returns 0 rather than a short card:
//   +0..+1    border
//   +5..+28   name         SESSION_NAME_Y_T, T_HEAD 24
//   +32..+63  title        SESSION_TITLE_Y, 2 x SESSION_LINE_H (wrapped)
//   +67..+82  agent/model/branch                (+3 SESSION_LINE_GAP)
//   +86..+101 "LAST PROMPT" label               (+3)
//   +102..+133 prompt      2 x SESSION_LINE_H   (no gap: a label and the value it
//                                                names read as one block)
//   +137..+152 path        fitText, one line    (+3)
//   +157..+174 pill        top = H - SESSION_PILL_UP_T, gap 4 above it (3 + AIR)
//   +175..+177 pad 3
//   +178..+179 border                            = 180
// = path end (152) + 5 + SESSION_PILL_UP_T (23). The checker re-derives it from
// the offsets rather than trusting this table.
const int SESSION_EXP_MIN_H = 180;
// THE CAP IS THE TALLEST CARD THAT IS ALL CONTENT, derived from the prompt's own
// byte cap and the row's MEASURED lane - not a taste judgement about how much air
// looks right. prompt[104] carries at most 100 characters (the host's cap) and the
// row's text lane is SESSION_SUB_LANE_W (244px) = 30 characters at Spleen 8x16's
// 8px advance, so 4 lines hold 120 and are the most that can ever carry ink; a
// fifth would be permanently blank. Every 16px above SESSION_EXP_MIN_H therefore
// buys exactly one more prompt line, and above MIN + 2*LINE there is nothing left
// to put in the card - so the surplus stays OUTSIDE it, as empty list area, rather
// than becoming a card of air. That is the honest cost of one session on this
// panel and it is stated in the table above rather than hidden.
const int SESSION_EXP_MAX_H = 212;
// The title is ALWAYS two lines when present: title[44] carries 43 characters =
// 344px against a 244px lane, so a real title genuinely wraps, and 2 lines hold
// 60. Absent (Codex rows carry no title), the block is skipped by the cursor
// rather than left as a hole.
const int SESSION_EXP_TITLE_LINES = 2;
// The prompt's floor and ceiling, both derived above. The DRAW picks its count
// from the row's own height (sessionExpPromptLines()), so the card cannot ask for
// a line the helper did not budget.
const int SESSION_EXP_PROMPT_MIN = 2;
const int SESSION_EXP_PROMPT_MAX = 4;
// The row signature's buffer, per board because it is 6 copies of RAM and board
// 1's is held byte-identical. 176 there (a 125-byte worst case: name 23 + status 9
// + sub 35 + title 43 + tag 6 + icon 3 + 5 separators + NUL). The expanded row
// also draws the last prompt and the path, so both join the signature for that ONE
// row - prompt 103 + path 67 + 2 separators = 172 more, i.e. 297 - hence 304.
// Appending them for every row instead would repaint a COMPACT row whenever its
// prompt changed, which is a wholesale clear-and-redraw of pixels that did not
// change: exactly the flicker the change-only discipline exists to prevent.
const int SESSION_ROW_SIG_LEN = 304;

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
// 326, and the arithmetic is the running cursor in drawSessionDetail() with every
// step DERIVED (see DETAIL_NAME_H / DETAIL_LINE_H / DETAIL_TEXT_LINE_H below) from
// this board's own faces rather than from Cozette's:
//   +10 pad | name 24 ink +10..+33 | step 28
//   +38 title 16 | step 22
//   +60 pill 18 | step 28
//   +88 rule | step 11
//   +99 PROMPT label 16 | step 16
//   +115 prompt 4 lines (16 each, last inks +163..+178) | step 70
//   +185 rule | step 11
//   +196 PATH label 16 | step 16
//   +212 path 2 lines (last inks +228..+243) | step 38
//   +250 col labels 16 | step 15
//   +265 col values 16 | step 25
//   +290 col labels 16 | step 15
//   +305 col values, inking +305..+320
// so the content ends at +320 and 3 clear rows sit above the 2px border at
// +324..+325 (board 1: 8 above its own).
//
// THE CEILING IS 331, NOT the 328 this comment used to claim, and the difference
// is that the "answer this one on your Mac" line's opaque BOX was being measured
// at its baseline. Both that line and the "tap here for history" hint are MC_DATUM
// T_META, and drawString centres on the ASCENT (12) while painting a box
// ascent+descent (16) tall - so a string drawn at y inks rows y-6..y+9. The answer
// line sits at cardY + H + 8 = H + 104, i.e. rows H+98..H+113; the hint sits at
// contentBottom() - 10 = 450, i.e. rows 444..459. They collide when
// H + 113 >= 444, i.e. AT H = 331 - so 330 is the largest legal card and 326
// leaves 4px between the two lines (answer box 424..439). The checker measures it
// as a BOX now and PRINTS that largest-legal number for both boards, so the next
// person to spend this headroom reads it rather than re-deriving it. (Board 1's own
// figure prints as 211 against its 224: that card is 13px over its ceiling, which
// is the long-documented case of both footer strings landing on one y.)
const int DETAIL_CARD_H = 326;
// TYPE. 46 tall = TAP_MIN, where board 1's 22 was half its own floor. 88 wide is
// board 1's 76 held PHYSICALLY (76 / 5.624 = 13.5mm; 13.5 * 6.489 = 87.7), which
// is the right rule for a control rather than for text. The hit zone's extra 24px
// of slop to the left is unchanged in sessions.ino - it is slop on a chip that
// now clears the floor in both dimensions, not part of the target.
const int MSG_BTN_W = 88, MSG_BTN_H = 46;
// THE LINE CAPS ARE DERIVED FROM THE FIELD'S OWN BYTE CAP AND THE MEASURED LANE,
// which is what makes them big enough here to truncate NOTHING - board 1's 2/2
// truncate both fields.
//
// 4, NOT 3, and the 3 was arithmetic done at the WRONG ADVANCE: it read "260px =
// 43 characters at Cozette's 6px advance", but this board draws Spleen 8x16, so
// the lane is 260 / 8 = 32 characters. prompt[104] carries at most 100 (the host's
// cap), and 3 x 32 = 96 - four characters SHORT, i.e. the field the card exists to
// show was being silently cut. 4 x 32 = 128 clears it. That fourth line, at the
// DERIVED 16px step, is 64px of the card rather than the 44 the old 11px step
// pretended - which is most of what took DETAIL_CARD_H to 326 and DETAIL_AIR to 4. The same re-derivation leaves the path at 2
// (2 x 32 = 64 = path[68]'s 64 exactly, and 64 is also the host's own cap), and
// the ".."-clipped two-column values below are unchanged: drawColValue clips to
// the width it is GIVEN, measured, so they were never counted.
const int DETAIL_PROMPT_LINES = 4;
const int DETAIL_PATH_LINES = 2;
// 4px of air at every block boundary inside the card, NOT the 8 this board carried
// while its cursor was stepped in Cozette's numbers. That 8 was affordable only
// because the steps under it were 3px too short per line: with every step derived
// from this board's real faces the packed stack is 320 against a 330px ceiling, and
// 8px of air would need ~360. So the direction Task 6 argued for (given surplus,
// spend it around the content) is intact - there simply is no surplus left on this
// card once its own type scale is paid for, which is the honest reading of a 16px
// line in a card that has to hold twelve blocks.
const int DETAIL_AIR = 4;
// THE DETAIL CARD'S INK HEIGHTS - the two numbers its whole cursor is derived from,
// exactly as SESSION_NAME_H / SESSION_LINE_H do for a row.
//
// DETAIL_NAME_H IS 24, THE HEAD RUNG, AND T_HERO WAS MUTILATING THIS CARD. The
// name was drawn with setUIFont(4), which on this board is Spleen 32x64: its opaque
// box spanned +14..+77 while the title's own 16-row box landed at +48..+63 and the
// pill filled +71..+88 - so the headline field of the most-opened secondary screen
// had the title punched straight through its middle, the letters' bottom two rows
// re-emerging at +64..+65, and g/p/y tails hanging out beside the status pill.
// Decoded off the fonts, not eyeballed. T_HEAD also fixes the width: at 32px per
// character the 260px lane held EIGHT of a 22-character project name, against 21
// at 12px. Same judgement, same arithmetic, as the session row's name band.
const int DETAIL_NAME_H = 24;   // uiLineH(T_HEAD), Spleen 12x24
const int DETAIL_LINE_H = 16;   // uiLineH(T_BODY) == uiLineH(T_META), Spleen 8x16
// The WRAPPED-text line step (LAST PROMPT and PATH). 16, the full cell, where board
// 1 uses 11: that 11 clears Cozette's 10px ascent, and Spleen's is 12 - so an
// 11px step here cost every line but the last its bottom ink row and every
// descender it had. Which is what a fourth prompt line at an 11px step made
// marginally worse before this was derived.
const int DETAIL_TEXT_LINE_H = 16;
// Which rung the project name is drawn at: 3 = T_HEAD, whose cell IS
// DETAIL_NAME_H. 4 (T_HERO) is what the mutilation above was. A number rather than
// the name because the T_* ids are declared after this header is included;
// sessions-geom-check.mjs asserts uiLineH(DETAIL_NAME_FONT) == DETAIL_NAME_H
// against the parsed font registry rather than trusting the pair.
const int DETAIL_NAME_FONT = 3;

// TAP_MIN, where board 1's 32 is under its own floor of 40. Affordable for the
// same reason TAB_BAR_H is: the worst case is 4 options plus the SPEAK/TYPE row =
// 5 * (46 + 8) = 270 of the 416px content area, i.e. 65% - the IDENTICAL
// proportion board 1 spends on 5 * (32 + 4) = 180 of 268. So the bigger targets
// cost the detail text nothing in relative terms.
const int ASK_OPT_H = 46;
// 8 is DERIVED FROM THE 65% PROPORTION, not from any touch measurement, and it is
// worth being exact about which - see ASK_OPT_H. The stack is sized to spend the
// same share of the content area board 1 spends, and 5 * (46 + 8) = 270 of 416 is
// what lands on it; the gap is the free variable that 65% closes. Board 1's 4 is
// not a different judgement, it is the most its packed content area could give:
// at 8 its worst-case stack would be 5 * 40 = 200 of 268.
// What the extra 4px BUYS is a separate claim, and a real one, but it is a
// consequence rather than the derivation: the two things this gap separates are
// Allow and Deny, so unlike every other gap on the device a mis-hit here runs a
// command that was meant to be denied. Worth having, not what set the number -
// and if the 65% rule is ever revisited, this gap is not protected by an
// ergonomics argument that was never made.
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

// ---------- Component heights ----------
// The design system's own note on these two is "derived from TAP_MIN, not chosen
// per page", which makes them per-board by definition. Board 1: H_BTN = TAP_MIN +
// 4 = 44, H_ROW = TAP_MIN = 40. The same two relationships against TAP_MIN 46:
const int H_BTN = 50;     // buttons and toggles
const int H_ROW = 46;     // list rows - exactly the fingertip floor
// Consequence outside SETTINGS, and a wanted one: the voice-answer confirm screen
// (sessions.ino, askVoiceSendY()/askVoiceRedoY()) sizes SEND / RE-RECORD / CANCEL
// from H_BTN, so those three go 44 -> 50 and clear TAP_MIN, where on board 1 they
// sit 4px under it.

// ============================================================================
// SETTINGS - THE FOUR PAGES
// ============================================================================
// THE PAGER BAND SETS EVERYTHING BELOW IT, so it is derived first.
//
// drawPager() draws its prev/next keys at CONTENT_Y + 4 with height PAGER_H - 8,
// so the DRAWN key is PAGER_H - 8. Board 1's PAGER_H 42 gives a 34px key - 6.0mm,
// under its own TAP_MIN of 40, and its own comment records that at 26 these were
// "the most missed control on the device". With 160 more rows the floor is
// affordable here, so the key is exactly TAP_MIN and PAGER_H = 46 + 8 = 54. The
// TAP band is wider than the key in both dimensions on both boards
// (handleSettingsTouch claims everything above PAGE_TOP, split 45%/45% with a 10%
// dead band around the title) - that split is panel-relative and needs nothing.
const int PAGER_H = 54;
// 60, board 1's 52 held PHYSICALLY (52 / 5.624 * 6.489 = 60.0) - the rule Task 7
// used for MSG_BTN_W and ASK_READ_BTN_W, and the right one for a control rather
// than for text. Clearance: the two keys span x 8..67 and 252..311, leaving a
// 184px title lane for a longest title ("DISPLAY & SOUND") of 90px at Cozette's
// 6px advance, centred at 160 so it runs 115..205.
const int PAGER_BTN_W  = 60;
// 8, and the arithmetic first: board 1's 6 held physically is 6 / 5.624 * 6.489 =
// 6.9, taken up to 8 to sit on the 4px spacing scale (SP_2). That it does not match
// CARD_X (12), so the pager keys sit slightly outside the card lane on both boards,
// is a CONSEQUENCE of that arithmetic rather than the reason for it - and the claim
// that this is what makes the band read as chrome above the page rather than as the
// page's first row is a JUDGEMENT, unmeasured, and not what set the number.
const int PAGER_BTN_X0 = 8;
const int PAGE_TOP = CONTENT_Y + PAGER_H + 4;   // 104

// THE PAGE REGION IS PAGE_TOP(104)..contentBottom(462) = 358px, against board 1's
// 222. THE RHYTHM IS SP_3 (12) ON EVERY PAGE, and the cost is stated rather than
// hidden: every page is TOP-ALIGNED under the pager and leaves real trailing air
// (147px on STATUS, 66 on DISPLAY & SOUND, 92 on ACTIONS, 110 on PAIRED MACS with
// four Macs). The alternative - growing the gaps until the last row lands 8px
// above the footer, the way the USAGE column does - was rejected on arithmetic,
// not on taste: it needs a 29px gap inside the STATUS card, whose connection rows
// are 16 rows tall, and a gap wider than the rows it separates stops reading as
// one list. 12 is under the shortest row on every page (16 on STATUS), so the
// same number works on all four and no page invents its own.
// Why 12 and not the 8 the USAGE column and the detail card use: at 8 the four
// pages are a small block against the top of a 480px panel with a quarter of it
// blank below, and 8 is the rhythm INSIDE a card rather than between rows of one.

// ---------- SETTINGS page 0: the DEVICE card ----------
// SIZED BY ITS CONTENTS, like the stepper card and unlike the USAGE column - it
// carries six rows and no more, so it is 200 tall in a 358px region.
//
// CHECK CLEAR BOXES, NOT GLYPHS, the same discipline the USAGE card is built on.
// The extents below are what each row actually paints:
//   - a connection row is drawConnRow(): fillRect(xRight-100, y, 100, 16), i.e.
//     y..y+15, plus a 13px dot centred at y+8 (y+1..y+15)
//   - the battery row is that dot plus drawIfChanged at y+4 (TR_DATUM, 13px),
//     clearing y+3..y+17
//   - ID and the two Mac rows are 13px lines clearing y-1..y+13
//
//   +0..+1     border
//   +2..+5     pad
//   +6..+18    "DEVICE" label (13px, drawn at +6)
//   +19..+30   gap 12
//   +31..+46   Bluetooth      (DROW_BT)
//   +47..+58   gap 12
//   +59..+74   USB            (DROW_USB)
//   +75..+86   gap 12
//   +87..+104  Battery        (DROW_BATT: dot +88..+102, reading clear +90..+104)
//   +105..+116 gap 12
//   +117..+131 device id      (DROW_ID +118, clear from +117)
//   +132..+143 gap 12
//   +144..+158 Mac link row 0 (DROW_MAC0 +145)
//   +159..+170 gap 12
//   +171..+185 Mac link row 1 (DROW_MAC1 +172)
//   +186..+197 gap 12
//   +198..+199 border                                              = 200
// The 2px border owns +198..+199 so nothing may end past +197; the last clear
// ends +185, 12 rows clear. Board 1's equivalent card is 160 with 6px of slack.
const int DEV_CARD_Y = PAGE_TOP + 12;   // 116
const int DEV_CARD_H = 200;
const int DROW_BT = 31, DROW_USB = 59, DROW_BATT = 87, DROW_ID = 118;
// Two fixed row SLOTS, not one per hostLinks[] index - renderMacLinkRows()
// compacts to however many links are used, so one remaining Mac always draws in
// slot 0 rather than leaving a hole where the other one was.
const int DROW_MAC0 = 145, DROW_MAC1 = 172;
// 28, UNCHANGED, and this is one of the few numbers that is genuinely NOT
// panel-derived: it is the width of the DATA. "Mac  feedfeed  999s ago" - a bare
// 11-character hostId with no tag, plus a generously wide age - is 23 characters,
// and every row is padded to this same fixed width whether used or not, which is
// what makes a row that goes away actually get ERASED rather than merely stop
// updating (the erase box is sized to the padded text). macRowCache is shared at
// [40]: worst case 28 (text) + 1 (\x01 sentinel) + 2 (icon id) + 1 (NUL) = 32.
// Lane check: the row starts at CARD_X + PAD = 30 and its erase box is
// 28*6 + 4 + 13 + 2 = 187 wide, ending at 216 inside a card that runs to 308.
const int MAC_ROW_W = 28;

// ---------- SETTINGS page 1: the stepper cards ----------
// THE CARD IS SIZED BY THE KEY, which is the property board 1's rework existed to
// get: the label moved into the MIDDLE column - above the value it names, clear of
// both key columns - precisely so the keys own the whole interior height.
// STEP_BTN_SIZE is TAP_MIN + 4 = 50, the same "4px OVER, not merely at it"
// relationship board 1 has at 40 + 4 = 44, and 6px of air above and below it
// (board 1: 4) gives 2 + 6 + 50 + 6 + 2 = 66.
//
//   +0..+1    border
//   +2..+7    air 6
//   +8..+57   the two +/- keys (STEP_BTN_TOP 8, STEP_BTN_SIZE 50)
//   +58..+63  air 6
//   +64..+65  border                                                = 66
//
// The MIDDLE COLUMN's own stack, centred in the interior (+2..+63, 62 rows) and
// horizontally clear of both keys, so it is checked against the card and not
// against the key band:
//   +9..+21   label   (STEP_LABEL_CY 15, MC_DATUM, 13px cell)
//   +22..+24  gap 3
//   +25..+44  value   (STEP_VALUE_CY 35, MC_DATUM, T_HEAD; drawIfChanged clears
//                      cy-10..cy+9, i.e. 20 rows for an 18px cell)
//   +45..+48  gap 4
//   +49..+56  BRIGHTNESS bar only (STEP_BAR_Y 49, STEP_BAR_H 8)
// 7 rows of air above the label and 7 below the bar. Every band is disjoint - the
// value's fat clear box is what makes that worth stating.
const int STEPPER_CARD_H = 66;
const int STEP_LABEL_CY  = 15;
const int STEP_VALUE_CY  = 35;
const int STEP_BAR_Y     = 49;
const int STEP_BTN_TOP   = 8;
const int STEP_BTN_SIZE  = 50;
// 8, from board 1's 6: physically 1.23mm against 1.07mm, i.e. the bar keeps its
// thickness while getting 75% longer (140px of lane against 80), the same trade
// BAR_H makes on the USAGE cards.
const int STEP_BAR_H     = 8;
// 10, UNCHANGED. It is the clearance between a key's edge and the bar, and the
// keys grew by 6 while the card grew by 80 - so this inset is not the constraint
// on either side. Lane: CARD_X + PAD + 50 + 10 = 90 to 229, against keys at
// 30..79 and 240..289.
const int STEP_BAR_GAP   = 10;
// The page: 3 * 66 + H_ROW(46) = 244 of 358, laid out top-aligned on the 12px
// rhythm - cards at 116 / 194 / 272 and the toggle row at 350..395, 66px clear of
// the footer. Board 1 has 14px for the same five gaps and its own comment says
// neither its cards nor its toggles could give another pixel.
const int P1_TOP = 12;
const int P1_GAP = 12;
// ---------- SETTINGS page 2: the action buttons ----------
// H_BTN, where board 1 had to drop to 38 because four buttons plus a hint would
// not fit at 44 - so these are the one control on this page that was UNDER the
// floor on board 1 and is over it here. 4 * 50 + 3 * 12 = 236, from 116 to 352,
// with the hint at 364 (inking 358..370, MC_DATUM) and 92px clear below it.
const int P2_TOP   = 12;
const int P2_BTN_H = 50;
const int P2_GAP   = 12;
// ---------- SETTINGS: the confirm dialog ----------
// 28, board 1's 24 held physically (24 / 5.624 * 6.489 = 27.7). Top-anchored to
// PAGE_TOP exactly as board 1 is, deliberately not centred in the page region:
// the dialog is modal and must land in the same place regardless of which page it
// was raised from, and three of the four pages have different lengths.
//
// CFM_H 160, sized by the block it holds rather than scaled. drawConfirm() lays
// its three text elements out as ONE BLOCK centred in the space above the button
// row, so what the height has to hold is the WORST block: title (T_HEAD, 18) +
// SP_2-2 + emph (T_BODY, 13) + SP_2 + 2 note lines (26) = 71, above
// H_BTN(50) + SP_3(12).  2 + 71 + 50 + 12 + 2 = 137, and 160 leaves the block 25
// rows to be centred in (board 1: 150 against a 71px block leaves 21).
// WORTH KNOWING: no shipping note actually needs two lines on this board. The
// lane is CARD_W - 2*SP_3 = 272px = 45 characters, and the longest of the four
// ("its key is deleted; re-pairs over USB", 37 characters = 222px) fits on one -
// where on board 1's 192px lane three of the four wrapped. The height is still
// derived for two, because countWrappedLines() decides that at runtime and a
// future note is not bound by today's strings.
const int CFM_TOP = 28;
const int CFM_H   = 160;

// ============================================================================
// THE ON-SCREEN KEYBOARD
// ============================================================================
// TWO THINGS ARE DERIVED HERE AND THE SECOND FOLLOWS FROM THE FIRST: the column
// count comes from the text card's lane, and the LINE BUDGET comes from the column
// count. That chain is what stops SEND signing text that scrolled off the bottom,
// so it is re-derived rather than adjusted.
//
//   KB_COLS      = (CARD_W - 12) / 6 = (296 - 12) / 6 = 47.33 -> 47
//   KB_TEXT_LINES = ceil(KB_MAX_BYTES / KB_COLS) = ceil(150 / 47) = 3.19 -> 4
//
// So a wider card costs the card a LINE: board 1 is 34 columns and 5 lines, this
// board is 47 columns and 4. The caret's furthest reachable position moves with
// it and is still provable rather than clamped: at kbLen = KB_MAX_BYTES the caret
// is at line 150 / 47 = 3, column 150 % 47 = 9 - inside the 4 lines the card
// budgets, at x = CARD_X + 6 + 9*6 = 72.
//
// KB_MAX_BYTES IS NOT TOUCHED. It is 150 on the HOST too (ANSWER_TEXT_MAX_BYTES
// in host/voice-answer.mjs, re-exported for the typed form), so only the columns
// and the resulting line count move.
//
// THE OTHER PAIRING THIS COULD HAVE BROKEN, checked explicitly: the voice-answer
// confirm screen caps its transcript panel at 8 WORD-wrapped lines
// (askVoiceTooLong() in sessions.ino, measured against CARD_W - 8), and CLAUDE.md
// records that cap and the 150-byte one as consistent by arithmetic. A wider lane
// can only make that cap looser: CARD_W - 8 = 288px = 48 columns here against
// board 1's 34, so 150 bytes cannot exceed 4 word-wrapped lines even at word
// wrap's worst case, against a cap of 8. The pairing holds with more headroom,
// not less, and the shared constant 8 is therefore left alone.
const int KB_COLS = 47;
const int KB_TEXT_LINES = 4;
// THE KEY GRID. 10 columns across 320 gives a 32px pitch, 2px of which is the gap
// (board 1: 24 and 2) - so the key is 30 wide against board 1's 22, which is the
// one dimension this panel simply hands over.
const int KB_PITCH = 32;
const int KB_KEY_W = 30;
// KB_ROW_H 58, and the DRAWN key is KB_ROW_H - 4 = 54 while the TESTED band is
// KB_PITCH x KB_ROW_H = 32x58 = 1856px2 against board 1's 24x44 = 1056 - the
// drawn/tested split kept rather than collapsed, in BOTH dimensions. The tested
// WIDTH is the pitch, not KB_KEY_W: kbTouch() divides by KB_PITCH, so the 2px gap
// belongs to the key on its left and no column on the board is dead.
//
// 54 IS CAPPED BY ASPECT, NOT BY THE PANEL, and this is the one place on this
// board where a control is deliberately NOT grown to the space available. The
// keyboard's width is fixed by its 10 columns, so every spare row makes the keys
// taller and thinner; board 1's drawn key is 22x40 = 1:1.818, and 30 * 1.818 =
// 54.5 -> 54 is therefore the tallest key no more elongated than the one this
// device already ships. That anchor is measured FROM THIS REPO, which is the only
// reason it is the one used: spending the remaining rows on height instead would
// reach KB_ROW_H 70 (a 30x66 key, 1:2.2), and "1:2.2 is strips rather than keys"
// is a judgement with no measurement behind it, whereas "no worse than the keyboard
// already shipping" is a fact this file can check. (An earlier draft of this
// comment cited iOS portrait keys at about 1:1.3 as a scale reference. Nothing here
// measured that, so it is removed rather than left looking like evidence.)
const int KB_ROW_H = 58;
// THE TEXT CARD, and the RESERVED META ROW inside it. drawString paints an OPAQUE
// box the full height of a text line, so a counter sharing a row with wrapped
// text silently erases that line's tail - board 1 found this twice before landing
// on a reserved row, and the invariant is preserved here by construction:
//   card    +0..+89   (KB_TEXT_Y 12 .. 101, KB_TEXT_H 90)
//   meta    +8..+20   (KB_META_DY 8  -> y 20..32: byte counter left, countdown right)
//   gap     +21..+28  (8 rows - board 1 has 3)
//   line 0  +29..+41  (KB_LINE0_DY 29 -> y 41)
//   line 1            y 54
//   line 2            y 67
//   line 3            y 80..92
//   pad     +81..+89  (9 rows below the last line, inside the card)
// The meta row occupies y 20..32 and the first text line starts at y 41, so they
// share no pixel row with 8 to spare.
const int KB_TEXT_Y  = 12;
const int KB_TEXT_H  = 90;
const int KB_META_DY = 8;
const int KB_LINE0_DY = 29;
const int KB_LINE_PITCH = 13;                  // Cozette's cell - text-derived
// THE VERTICAL BUDGET, and where this board's surplus actually goes. The content
// is a fixed grid plus a provably 4-line card, so there is nothing here to add:
//
//   12 (top margin) + 90 (card) + 68 (break) + 232 (4 rows * 58)
//   + 12 (gap) + 58 (action row) + 8 (bottom margin) = 480
//
// The 68px BREAK is a RESIDUAL, not a chosen number: it is what is left once every
// other term is fixed by something else (the card by its 4 lines, the rows by the
// aspect cap on KB_ROW_H, the action row by KB_ROW_H, the margins by the 4px
// scale). What it does NOT do is disappear - the surplus has to land somewhere,
// and the two places it could go instead are both worse by arithmetic: a taller
// card carries lines the 150-byte cap can never reach (the 5th line would need
// 5*47 = 235 bytes), and moving it to the bottom margin pushes the action row off
// the most reachable part of a handheld panel. Calling this break "the one
// boundary on the screen that means something" is a judgement about what it looks
// like once it is there, not a reason for its size.
const int KB_ROWS_Y = 170;                     // 4 rows * 58 = 232, ending 401
const int KB_ACT_Y  = 414;                     // 414..471, 8px above the panel edge
const int KB_ACT_H  = 58;                      // == KB_ROW_H, as on board 1
// The peek overlay covers the keys and the action row but NEVER the text card, so
// its height is BOARD_H - KB_ROWS_Y - 4 = 306; its text starts +40 inside it and
// stops 8 short of the bottom, so (306 - 48) / 13 = 19.8 -> 19 lines against board
// 1's 13.
const int KB_PEEK_LINES = 19;

// ============================================================================
// HISTORY READER / FULL-SCREEN READER
// ============================================================================
// THE HEADER. The filter chip is a real control and board 1's is 17px tall with a
// 24px tap band - 2.6mm and 3.7mm, both far under its own TAP_MIN. Here the chip
// is drawn at TAP_MIN (46) and its tap band is TAP_MIN + 6, so the drawn/tested
// split is kept and BOTH sides clear the floor:
//   chip drawn   y 4..49,  x 12..71 (CHAT) / 12..63 (ALL)
//   chip tapped  y 0..52,  x 0..101 (the test is `sy <= H`, an inclusive bound)
//   rule         y 54
// What is DERIVED about the two widths is only the floor: the chip is now a
// TAP_MIN-tall control, so it has to clear TAP_MIN (46) in width too, and "CHAT"
// is 24px of ink and "ALL" 18px at Cozette's 6px advance - so anything from 46 up
// is legal for both. 60 and 52 sit 14 and 6 above that floor, keeping the same
// 8px difference between the two states that board 1's 40/32 has; THAT much is a
// judgement about how a filled pill should look beside 46px of height, not an
// arithmetic result. HIST_CHIP_CY is the label's centre, 4 + 46/2 = 27 - exactly
// centred, unlike board 1's, which is 1px low.
const int HIST_CHIP_X      = 12;
const int HIST_CHIP_Y      = 4;
const int HIST_CHIP_H      = 46;
const int HIST_CHIP_CY     = 27;
const int HIST_CHIP_W_CHAT = 60;
const int HIST_CHIP_W_ALL  = 52;
// 102, DERIVED FROM THE DRAWN CHIP rather than picked: the CHAT chip ends at
// HIST_CHIP_X + HIST_CHIP_W_CHAT = 72, and board 1's band carries 76 - 50 = 26px
// of slop past its own chip, which held physically is 26 / 5.624 * 6.489 = 30.
// 72 + 30 = 102.
// CONSEQUENCE INHERITED DELIBERATELY: the band therefore reaches past the session
// name, which starts at HIST_CHIP_X + HIST_CHIP_W_CHAT + 8 = 80 - so a tap on the
// name's first 22px toggles the filter. Board 1 does exactly the same (band 76
// against a name starting at 58, 18px), the name is inert text, and a generous
// target for the only filter control on the screen is worth more than 22px of
// nothing. Stated because a band that overlaps its neighbour is normally a bug.
const int HIST_CHIP_TAP_W  = 102;
const int HIST_CHIP_TAP_H  = 52;
// The session name (left of centre) and the position-in-history (right) sit on one
// row centred against the chip: a 13px line centred on the chip's own centre (27)
// starts at 21.
const int HIST_HDR_TEXT_Y  = 21;
const int HIST_RULE_Y      = 54;
const int HIST_TOP         = 60;   // first entry row, 6 below the rule
// Centred between the rule and the control bar: (54 + 422) / 2 = 238. Board 1's
// 130 is NOT that midpoint (147) - a literal that predates the control bar - so
// this is derived rather than carried across.
const int HIST_EMPTY_CY    = 238;
const int HIST_LINE_H      = 13;   // Cozette - text-derived, unchanged
// THE SCRUBBER, and this is where the extra rows buy the most. Board 1's track is
// 16 tall and its tap band is the same 16 - 2.8mm for the primary navigation of a
// history that pages to 399 screens - because the list above and the control bar
// below own every other row. Here the band is TAP_MIN (46) while the TRACK stays
// 20, drawn centred in the band at HIST_JUMP_Y + (46 - 20) / 2 = 377..396: a
// full-width 46px filled track would read as a box rather than as a slider, and a
// 16px one is not a target. On board 1 the two constants are equal and the
// centring term is zero, so its drawing is unchanged.
//   band    364..409   (HIST_JUMP_Y, HIST_JUMP_TAP_H)
//   track   377..396   (HIST_JUMP_H 20)
// The list stops 4px above the band (HIST_JUMP_Y - 4 = 360), so it runs 60..360 =
// 23 lines of 13 against board 1's 16.
// The TRACK is board 1's 16 held physically: 16 / 5.624 * 6.489 = 18.46, which
// rounds to 18. It is 20, and that last 2px is a JUDGEMENT, not arithmetic -
// "the even grid" does not choose between them, since 18 is equally even and
// both centre EXACTLY in a 46px band ((46-18)/2 = 14, (46-20)/2 = 13, no
// remainder either way). Nothing downstream reads this constant except the track
// and knob rects, so neither value costs another row.
// The judgement: board 1's own comment calls this track "the tightest control in
// the reader" at 2.8mm, and it is the one thing here you have to AIM at. Given a
// board with rows to spare, biasing the drawn track 1.5px up rather than 0.5px
// down makes the target slightly easier to see while HIST_JUMP_TAP_H does the
// real work of catching the tap. If that trade is ever revisited, 18 is the
// arithmetic answer and this is the reason to have gone past it.
// HIST_JUMP_TAP_H is TAP_MIN.
const int HIST_JUMP_Y      = 364;
const int HIST_JUMP_H      = 20;
const int HIST_JUMP_TAP_H  = 46;
// The control bar: H_BTN tall, 8px above the panel edge (422 + 50 = 472).
const int READER_CTRL_Y  = 422;
const int READER_BTN_H   = 50;
const int READER_TEXT_TOP = 60;    // = HIST_RULE_Y + 6, same 6 HIST_TOP uses
// Three keys, symmetric on a 12px margin and a 12px gap, the middle one 1px
// narrower so the arithmetic closes: 12 + 91 + 12 + 90 + 12 + 91 + 12 = 320.
const int READER_BTN_L_X = 12,  READER_BTN_L_W = 91;
const int READER_BTN_M_X = 115, READER_BTN_M_W = 90;
const int READER_BTN_R_X = 217, READER_BTN_R_W = 91;
// ONE pair of split boundaries, unlike board 1's two, and derived from the keys
// above rather than picked: the midpoints of the two 12px gaps between them,
// (102 + 115) / 2 = 108 and (204 + 217) / 2 = 210.
const int HIST_TAP_1   = 108, HIST_TAP_2   = 210;
const int READER_TAP_1 = 108, READER_TAP_2 = 210;

// ---------- Easter-egg crab-walk surface ----------
// The art does not scale, so only its position is derived: OCTO_H is CRAB_H * 3
// (== CRAB_DRAW_H) on both boards, and the band is centred vertically - board 1's
// 110 puts its 108px band at 110..217 on a 320px panel, centre 164 against a
// panel centre of 160, so "centred" is what that number was reaching for. Here
// (480 - 108) / 2 = 186.
const int OCTO_W = 320;                  // full width: the crab walks across it
const int OCTO_H = CRAB_H * 3;           // == CRAB_DRAW_H
const int OCTO_X = 0;
const int OCTO_Y = 186;
