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
#define BOARD_HAS_MIC        1   // via the ES8311's ADC; see the capture note below

// The capsule is MIC1, an LMA2718B381-OA7 ANALOG mic: OUT -> MIC_OUT, VDD from
// AU_VCC3V3 through L3, two GNDs, and NO CLOCK LINE ANYWHERE. Its output reaches
// the codec's analog MIC1P/MIC1N pins (U5 18 and 17) through coupling caps. That
// absence of a clock is what rules out PDM - a digital mic needs one, and MIC1P
// doubles as DMIC_SDA for exactly that case - so es8311_microphone_config() must
// be passed digital_mic = FALSE. Read off vendor/schematic.pdf, not guessed. The
// board pin table names no mic pin because the mic never touches the ESP32: it is
// entirely on the codec's side of the I2S boundary.
//
// Gain: the driver offers 0..42dB in 6dB steps (es8311_mic_gain_t). This is a
// STARTING POINT, not a measurement - the value to keep is the highest one whose
// silence floor stays low, which only the on-device meter can find, exactly as
// board 1's trimmer had to be set by watching MICMON rather than by calculation.
#define MIC_GAIN  ES8311_MIC_GAIN_30DB
#define BOARD_HAS_BEEPER     1   // via the ES8311; see the beeper note below
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

// ---- Radii and border weights ----------------------------------------------
// THE RADII ARE RE-DERIVED, THE WEIGHTS ARE NOT, and both halves of that are
// arithmetic rather than taste.
// Radii, by physical parity - the same rule that chose Spleen 8x16 over 6x13:
//   R_SM  6 * 6.489/5.624 = 6.92 -> 7   (1.08mm here against board 1's 1.07mm)
//   R_MD 10 * 6.489/5.624 = 11.5 -> 12  (1.85mm here against board 1's 1.78mm)
// Weights, by the same rule, do NOT move:
//   BORDER_CARD 2 * 1.154 = 2.31 -> 2
//   BORDER_CTRL 1 * 1.154 = 1.15 -> 1
// Why this was missed until someone looked at the glass: these four lived as
// SHARED globals in deckhand_display.ino rather than in a board header, so the
// nine-task conversion that re-derived every vertical rhythm never saw them. The
// outline was never geometrically wrong - the arc tracks a true circle within a
// pixel and the AA runs to ten levels - it was simply a board-1 corner on a
// board-2 card, and roundness is judged relative to the thing being rounded.
// A card-PROPORTIONAL rule would ask for 10 * 296/216 = 13.7 instead. Physical
// parity wins because it is the rule the rest of this header already follows, and
// because a corner's job is to look soft at a viewing distance, not to stay a
// fixed fraction of a card that changed width for unrelated reasons.
const int R_SM = 7;
const int R_MD = 12;
const int BORDER_CARD = 2;
const int BORDER_CTRL = 1;

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
// Read off vendor/schematic.pdf's audio block, not copied on trust from the demo
// project - and the one assignment that looks wrong is right. The schematic's
// net names are from the CODEC's point of view, so they read backwards from the
// MCU's: I2S_DI is U5 pin 9 DSDIN (the codec's INPUT, which the ESP32 must
// drive, i.e. our DOUT) on GPIO15, and I2S_DO is U5 pin 7 ASDOUT (the codec's
// mic OUTPUT, i.e. our DIN) on GPIO16. Anyone "fixing" DOUT/DIN to match the net
// names will silently send playback to a pin the codec never reads.
#define PIN_AMP_EN         1
#define PIN_I2S_MCLK      17
#define PIN_I2S_BCLK      18
#define PIN_I2S_DOUT      15
#define PIN_I2S_LRCK      21
#define PIN_I2S_DIN       16

// THE SPEAKER IS NOT ON A GPIO, and looking for one is how an afternoon goes
// missing. The chain is U5 (ES8311, I2C 0x18) -> OUTP/OUTN -> R21/R22 4.7K ->
// U6 (SC8002B class-D BTL amp, VDD from +5) -> VO2/VO1 = SP+/SP- -> JP3, a
// 2-pin header (pin 2 = SP+, pin 1 = SP-). Board 1's wiring has no counterpart
// here: its amp input IO26 is this module's SPICS1 (flash/PSRAM bus) and its
// shutdown IO4 is this board's SD_CMD. JP1 is the BATTERY header, also 2-pin -
// the two are easy to confuse and only one of them makes a sound.
//
// PIN_AMP_EN GATES NOTHING, and that is MEASURED, not inferred. It reaches U6's
// SHUTDOWN pin (with R26, a 10K pull-up to VCC3V3), so both the demo project's
// comment ("digitalWrite(PIN_AMP_EN, HIGH); // enable the amplifier") and the
// opposite LM4871 reading predict that one level is silent. TONETEST played a
// 2s tone at each level and BOTH were audible. The likely reason is a rail
// mismatch rather than a wiring fault: U6's VDD is +5, so its shutdown
// threshold sits near that rail, and a 3.3V GPIO high cannot reach it. The amp
// is therefore permanently enabled.
//
// Two consequences, both load-bearing for anything that plays audio here:
//   - SILENCE MUST COME FROM THE CODEC, never from this pin. es8311_voice_mute()
//     is the only working mute. Anything written to gate sound with PIN_AMP_EN
//     will appear to work while the amp stays live underneath it.
//   - The amp draws its idle current continuously and its own noise floor is
//     always present, which board 1's FM8002E avoids by being genuinely muted
//     between beeps. Watch for idle hiss here; it cannot be switched off.
// The pin is still DRIVEN rather than left floating - see AMP_EN_ENABLE_LEVEL.
//
// Independently of the enable, U6's BYPASS pin carries C41 = 1uF, so coming out
// of shutdown is a HUNDREDS-of-milliseconds ramp. That is not moot just because
// the pin gates nothing today: it is why the first TONETEST run was silent at
// BOTH levels, since a 30ms settle followed by 200ms beeps can land entirely
// inside the ramp. Any future short burst has to clear it.

// The level that MEANS enabled, under the most likely datasheet reading
// (SHUTDOWN active high). It changes nothing on this board revision - the pin
// gates nothing - and is driven anyway so that a revision which fixes the
// threshold, or a unit whose R26 is a different value, plays sound instead of
// silence. Costs one digitalWrite; the alternative is a board that regresses to
// this same afternoon's bug with no code change to blame.
#define AMP_EN_ENABLE_LEVEL  LOW

// ---- Beeper, through the codec rather than a GPIO ---------------------------
// Volume presets are ES8311 volume 0..100, NOT a duty. The scale is linear in dB
// (register 0x32 is 0.5dB/LSB with 0xBF = 0dB, and the driver maps 0..100 across
// 0..255), so these are ~13dB apart rather than evenly spaced in the numbers:
// 55 is about -25dB, 70 about -6dB, 85 about +13dB. All three sit inside the
// range measured audible on this hardware - anything below ~40 is inaudible, so
// a "LOW" of single digits like board 1's would be a silent setting.
#define VOL_PRESET_LIST {55, 70, 85}

// 2100 Hz, where board 1 uses 2093 (C7). The 7 Hz is not a taste change: the
// beep is a LOOPED sample buffer of BEEP_TONE_FRAMES frames, so the frequency
// must fit a whole number of cycles in it or every loop boundary is a click -
// a 50 Hz buzz on top of the beep. One buffer is 20ms at 16 kHz, so any multiple
// of 50 Hz works and 2100 is the nearest to board 1's pitch (42 cycles exactly,
// ~6 cents sharp, which nobody can hear). Board 1 needs no such constraint
// because LEDC generates its square wave in hardware with nothing to loop.
#define BEEP_TONE_HZ      2100
// 320 frames = 20ms at 16 kHz, and 20ms is the feed granularity the beep state
// machine works in. It is also exactly TONE_FRAMES, so the diagnostic and the
// beeper agree on a buffer size by construction rather than by coincidence.
#define BEEP_TONE_FRAMES   320
// The DMA holds 6 * 240 frames = 90ms (ESP_I2S's own dma_desc_num/dma_frame_num),
// and I2SClass::write() BLOCKS when it is full - there is no availableForWrite()
// on that class. So the beep never queues past this, keeping every write into
// free space and updateBeep() non-blocking. 60 leaves a 30ms cushion against a
// loop() iteration that runs long.
#define BEEP_QUEUE_MAX_MS   60

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

// ---------- Text metrics ----------
// THE BODY/CODE FACE'S X-ADVANCE. Spleen 8x16 is genuinely monospace - every glyph
// in 0x20..0x7E has xOffset 0, width 8 and xAdvance 8 - and T_META, T_BODY and
// FONT_CODE all resolve to it (see UI_FONTS in deckhand_display.ino), so any lane's
// column count is exactly lane / TEXT_ADV and the LAST-CHARACTER RULE costs nothing
// here. That last part is the difference from board 1 and it is worth stating:
// drawString charges the final glyph xOffset + width rather than xAdvance, which on
// Cozette can be 7 rather than 6 (space, '4', 'q'), so board 1's own 34-column lane
// is 1px hot for those three characters. On Spleen xOffset + width == xAdvance for
// every glyph, so a column count that divides exactly is exact for ANY string.
//
// It exists as a constant because the literal 6 it replaces was Cozette's, and two
// surfaces went on dividing by it after this board's face changed: the keyboard
// claimed 47 columns of a 35-column lane, and the reader REPORTED a 49x23 page
// budget to the Mac against a real capacity of 37x18 - which silently under-fills
// every page the host sends, with nothing on either side erroring.
const int TEXT_ADV = 8;
// THE BODY/CODE FACE'S CELL HEIGHT - the other half of TEXT_ADV, and named for the
// same reason: a literal 13 describes Cozette, and the voice-answer confirm panel
// went on stepping by it after this board's face became Spleen 8x16, which would
// have drawn each line's opaque box over the previous line's bottom 3 rows.
// == uiLineH(FONT_CODE), which FONT_CODE aliasing T_BODY makes uiLineH(T_BODY) too;
// the checkers assert that against the parsed UI_FONTS[] table, since uiLineH() is
// not a constant expression and so cannot be used in a static_assert.
const int CODE_LINE_H = 16;
// AND THE HERO CELL, for the same reason and one specific caller: the waiting
// screen's wordmark is T_HERO with no size override on either board, and the five
// offsets below it are derived from it. It was a literal 32 gap, which is Cozette's
// 26 plus 6 - so on this board the 64px wordmark's own opaque box swallowed the
// device name and the first message line. == uiLineH(T_HERO). (Spleen 8x16 / Spleen 32x64, both size 1.)
const int HERO_LINE_H = 64;
// THE VOICE CARD'S LABEL STEP, and this is CODE_LINE_H rather than board 1's
// CODE_LINE_H - 1. Board 1's step is 1px short of its cell, which its blank glyph
// bottom row absorbs; the same encroachment against Spleen 8x16's 12-row ascent plus
// 4-row descent would have the transcript panel's fill start at +12 and rub out rows
// 12..15 of the label above it - four rows of a label that is only 16 tall. So the
// full cell, and the card is 4px taller for it.
const int VOICE_LBL_STEP = 16;

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
// RADIUS-12 corner's border reaches only x0+1.6 (dx = sqrt(144-36) = 10.39, so
// x0 + 12 - 10.39), so 18 is clear by 16px. It was x0+2.0 at RADIUS 10, i.e. the
// bigger radius pulls the corner further OUT of the text lane, not into it.
const int PAD = 18;
// 12, from 10. Physically 1.85mm against board 1's 1.78mm - i.e. the bar keeps
// its thickness while getting 40% longer (260px of usable lane against 188),
// which is what keeps the pace tick readable rather than hairline.
const int BAR_H = 12;
// DEFINED FROM R_MD, so the two can no longer disagree. This used to be a
// separate literal 10 with a comment saying it "must stay equal to R_MD" - and
// the moment R_MD was re-derived to 12, it wasn't. Only drawCardBorder(), the
// detail card and the pager buttons use RADIUS while the card FILL under them
// comes from uiCard()'s R_MD, so a mismatch strokes a 10px curve onto a 12px
// fill and the corners fringe. An invariant stated in a comment is an invariant
// waiting to break; one expressed in code cannot.
//
// The old comment also argued there was "nothing here to re-derive", because the
// design system's note about radii is "about absolute visual weight, not a
// proportion of the card". That reasoning was right and its unit was wrong:
// absolute visual weight is PHYSICAL, and 10px is 1.54mm here against board 1's
// 1.78mm. Holding the weight is exactly what asks for 12. It is the same
// pixels-versus-millimetres slip the body text made - board 2 has twice the
// pixels but only 15% more density, so a carried-over pixel count always shrinks
// in the hand. Reported from the glass as a card border that "does not look
// smooth", which is what a board-1 corner on a 37%-wider card looks like.
const int RADIUS = R_MD;

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
//   +6..+21   label / icon   (CARD_LABEL_Y, Spleen8x16 = 16, and the Mac icon is
//                              16x16 here - MAC_EMOJI_SIZE is the body cell height,
//                              so the icon fills this row exactly rather than
//                              leaving board 1's 13px sitting 3px high in it)
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
// 32x32 BLIT that paints its own background, so its rect (x 20..51 here) has to
// clear the row's 10px corner and the 2px border that follows it. Re-derived at
// this board's dot row: SESSION_DOT_DY is now SESSION_NAME_Y + SESSION_NAME_H / 2
// = 19 (it was 22 while the band was 26 and AIR 3), so the blit's top row is y+3
// and the border's inner edge there sits further right than it used to, because
// RADIUS went 10 -> 12: at x0 + 7.64 rather than x0 + 6.13. So the blit moved with
// it, +23 -> +24, putting its left edge at x0 + 8 and clear by 0.36px.
// THE ASSERTION IS WHY THIS IS RIGHT RATHER THAN LUCKY. Raising the radius made
// the spinner clip the corner by 0.64px, and the checker said so by name the first
// time it ran - "spinner blit left x=19 clears the corner border's inner edge
// x=19.64 ... by -0.64px". It matters because the spinner is a BLIT: it paints
// background pixels across its whole 32x32 rectangle, so overlapping the corner
// bites a notch out of the border rather than drawing over it harmlessly. Board 1
// shipped exactly that once - a white nick in a rounded corner under the LIGHT
// theme - which is the reason SESSION_DOT_CX exists as a named constant at all.
// 0.36px of clearance is tighter than board 1's 0.87px and is genuinely all there
// is: +25 would push the 32px blit into the name lane at x0+48.
const int SESSION_DOT_CX = SESSION_ROW_X + 24;
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

// ---------- §3 THE STATUS BAND ----------
// The card head becomes a FILLED BAND in the status colour. Filled bands are new
// vocabulary for this UI - nothing else here fills a region with a status colour -
// and that is accepted rather than overlooked: the band is the reason the card
// reads at a distance without spending 64px of height on a single word.
//
// 44 is TAP_MIN(46) minus the card's own 2px border: the band is the full width of
// the card's interior, so it is not a tap target itself, but sizing it to the same
// rung keeps it from reading as a thin stripe against a 46px tab bar.
const int SESSION_BAND_H = 44;
const int SESSION_BAND_PAD = 14;        // side pad, band and body share it
const int SESSION_BAND_MARK_GAP = 8;    // agent mark -> status word
// THE DURATION'S LANE IS FIXED, AND 3 IS WHAT THE WORD LEAVES IT. The duration is
// a change-only field like every other on this device, so its clear box has to be
// a CONSTANT width - a box measured from the current value is a box that grows
// into the status word beside it, which is the defect the compact row's duration
// already caused once. The width is then not a preference: the band's inner 292px
// carries PAD(14) + mark(32) + GAP(8) + the longest word (192, see below) + PAD(14),
// which leaves 32px, i.e. 4 characters at TEXT_ADV - and one of those is spent on
// drawIfChanged's 1px margin plus the clearance the word needs from the box. So 3.
//
// It is also all the format needs. bandDurText() drops to one unit (s / m /
// h / d) for this field, and `statusSinceMillis` is a millis() value, which WRAPS at
// 49.7 days - so "49d" is the widest string reachable and 3 characters is a bound,
// not a hope. The rows below the card keep the full "12h34m" form: they have a whole
// line for it, and this one has 24 pixels.
const int SESSION_BAND_DUR_CHARS = 3;
//
// THE BAND'S CONTENTS FIT ACROSS, and this is the arithmetic the detail screen
// FAILS (see the spec's §7 and this plan's FINDING 1). Inner width is
// SESSION_ROW_W - 4 = 292. The word starts at PAD(14) + mark(32) + GAP(8) = 54;
// a bare duration "4m" is 2 * TEXT_ADV = 16 and sits PAD from the right, so the
// word has 292 - 54 - 14 - 16 = 208px. The longest label is "NEEDS YOUR INPUT",
// 16 chars at T_HEAD's 12px advance = 192. Clears by 16.
// Add a wall-clock here and it does NOT clear - that is why §7 is a separate piece.

// ---------- §4 THE SPINE ----------
// The band's compact form: a 6px status-coloured spine down the row's left edge.
// Same vocabulary, ~1.2ms against the band's 3.3ms, and it scales to any row
// height - which a 44px band cannot, since at four sessions a row is 100px and a
// band would spend 44% of it on one word.
// THE SPINE NEVER CARRIES STATUS ALONE: every spine row keeps its text pill, the
// same rule that makes the status pill a filled/outlined/boxless SHAPE, not a hue.
const int SESSION_SPINE_W = 6;
//
// ITS LEFT EDGE IS CURVED AND ITS RIGHT EDGE IS NOT, AND BOTH HALVES OF THAT WERE
// PAID FOR. The spine runs the row's whole left edge, so it meets BOTH rounded
// corners - and on the interior's top row the card's own fill has not reached
// x + BORDER_CARD at all: the corner arc is still R_MD - BORDER_CARD to the right
// of it. A plain fillRect there paints status-coloured nubs OUTSIDE the card's
// outline, which is exactly why drawSessionBand's fill is top-rounded. So the fill
// is a capsule at the card's INTERIOR radius, whose left edge IS that arc - no
// literal radius anywhere, R_MD - BORDER_CARD, the same expression the band uses.
//
// THE RIGHT EDGE IS CARVED STRAIGHT, AND IT WAS A SECOND CAPSULE FIRST. Carving
// with a mirrored capsule gives a band of constant width that follows the corner,
// which looks like the tidier answer and is not: the band then MOVES RIGHT with
// the arc, reaching x=26 near the top of the row, and the working spinner's 32x32
// blit paints its own COLOR_CARD background over everything from x=20 for rows
// +3..+34. Measured against the shim's own SDF: 17 status-coloured pixels erased,
// on every working row, four times a second. No border bite and nothing outside
// the outline - purely cosmetic - but a spine whose top simply stops. Carving with
// a RECT instead bounds the ink at x = spine + SESSION_SPINE_W - 1 by construction,
// which is also the shape "6px down the left edge" actually describes: a straight
// bar whose ends are rounded by the card's own corner.
//
// CLAUDE SOLID, CODEX SEGMENTED (§5's second carrier), as a FILL PATTERN rather
// than art: no blits, no new tables, and it survives greyscale - which is the
// whole point of giving the agent a texture, since status already owns the colour.
// Neither number is a taste call:
//   OFF 4 is 2/3 of the spine's width, so a gap reads as a gap rather than as the
//     anti-aliased seam between two runs.
//   ON 7 is one more than SESSION_SPINE_W, so a run reads as a SEGMENT of a band
//     rather than as a square dot - a dotted line would be a third status
//     vocabulary beside the pill's shapes and the band's fill.
//   Their SUM is the bound that actually constrains them, and it comes from the
//     LOOP rather than from a rule of thumb. The pattern is knocked out of the
//     spine's STRAIGHT section only - the arcs at each end stay solid, because a
//     knockout rect up there would paint outside the card for the same reason a
//     fill rect would. The loop starts at r + ON and draws while
//     yy + OFF <= h - r, so a SECOND gap needs r + ON + P + OFF <= h - r, i.e.
//     exactly 2P <= straight. Two gaps are what makes a spine read as segmented
//     rather than as one broken in the middle, so P <= straight/2.
//     The shortest spine the ladder can actually produce is a 62px row (six
//     sessions under the "+N more" strip), whose straight section is
//     62 - 2*BORDER_CARD - 2*SESSION_SPINE_INSET - 2*(R_MD - BORDER_CARD) = 36,
//     so P <= 18 and 11 clears it three times over.
//     Note SESSION_ROW_H_MIN (47) would give 21 and hold only ONE gap - it is the
//     constrain() floor for a smaller panel and is unreachable on this board's
//     ladder, which sessions-geom-check.mjs establishes by ENUMERATING the
//     reachable heights rather than by asserting against the floor. Stated here
//     rather than left as a silent 1px of luck.
const int SESSION_SPINE_ON = 7;
const int SESSION_SPINE_OFF = 4;
// ONE PIXEL DOWN AND UP, NEVER SIDEWAYS, AND THE 1 IS MEASURED RATHER THAN CHOSEN.
// VERTICAL ONLY is not a detail: applying it in x as well moves the capsule's arc
// off the card interior's own centre AND slides the spine's six columns one right,
// putting its LAST column on the working spinner blit's FIRST. That was built,
// flashed and read back off the panel - x=20 white for rows +14..+33 and coloured
// below, i.e. 20 pixels a row erased - which is the very defect this constant was
// added to help fix, reintroduced by its own fix. The checker now derives the
// spine's left edge from the DRAW's own x expression for exactly that reason.
// The
// carving rect's own left edge lands at x = spine + SESSION_SPINE_W = 20, and at
// the interior's top row (+2) that pixel is still 77% BORDER ink - the card's 2px
// ring is anti-aliased, so its last trace at x=20 is row +2, and a rect starting
// there rubs out three quarters of a border pixel at both left corners. That is
// the white-nick-in-a-rounded-corner defect SESSION_DOT_CX exists for, arriving
// through the carve instead of through a blit.
// Replicating PanelShim's fillSmoothRoundRect and drawSmoothRoundRect exactly and
// reading the border's coverage at x=20 off the result: +0 0.351, +1 1.000,
// +2 0.770, +3 0.000 - clean from +3 down. So the spine's box is inset one further
// pixel on all four sides, which costs 24 of 548 ink pixels on a 100px row and
// takes the border damage to ZERO. Asserted, with the injected fault, in
// sessions-geom-check.mjs.
const int SESSION_SPINE_INSET = 1;

// ---------- §6 THE SPINE SHIMMER: a light travelling a working row ----------
// The cheapest animation §6 considered, and it touches only the spine's SIX
// COLUMNS - the same bound the straight carve gives the fill, which is what
// keeps it off the card's rounded outline and off the working spinner's blit at
// x=20. It repaints only the STRAIGHT SECTION between the two arcs, for exactly
// the reason the Codex knockout does: up in the arc the fill's left edge has
// moved right, so a rect at x there would paint outside the card.
//
// LEN is the falloff either side of the travelling head, in rows. It has to fit
// WHOLE inside the shortest straight section the ladder can produce (36px on a
// 62px row - see SESSION_SPINE_ON above), or the light is clipped at both ends
// on the very rows the spine exists for; 2*LEN = 20 against 36 clears it.
// STEPS is one full traverse, at ANIM_INTERVAL_MS: 24 * 120ms = ~2.9s, slow
// enough to read as a travelling light rather than as a flicker.
const int SESSION_SHIMMER_LEN = 10;
const int SESSION_SHIMMER_STEPS = 24;
// PEAK STRENGTH, TOWARDS COLOR_VALUE - the theme's INK, not white and not
// COLOR_CARD, and that is the one choice here with a real argument behind it.
// A literal white reads as a light under DARK and, under LIGHT, blends the
// spine towards the colour of the card it sits on: at full strength the spine
// would briefly VANISH, a hole travelling down it rather than a light. Blending
// towards COLOR_VALUE can never do that, because COLOR_VALUE is by construction
// the token furthest from the surface in whichever palette is live - so the
// mark is always visible against the status colour and never against nothing.
// 110/255 keeps it a highlight rather than a second colour.
// `const int` rather than uint8_t so geom-common.mjs PARSES it: that parser reads
// `const int` declarations only, and a constant it cannot see is one no assertion
// can certify - which is this repo's rule, arriving from the type system.
const int SESSION_SHIMMER_MAX = 110;
// BOTH PEAKS NOW CARRY A PERCEPTUAL BOUND, and the "< 128" that used to stand
// alone here is a blend WEIGHT, which is not a distance: 126/255 is under half by
// arithmetic and yet lands the peak NEARER COLOR_VALUE than the status colour it
// is supposed to still read as. sessions-geom-check.mjs now parses THEMES[] out of
// deckhand_display.ino and states the claim in CIE Lab, where "nearer" means
// something - visible at all (>= the standard dE*ab JND of 2.3, which a peak that
// quantises back onto the base colour fails outright: at 16/255 the ramp's dE is
// 0.00 and nothing moves) and still its own colour (dE to the base below dE to
// COLOR_VALUE). 110 measures dE 14.3..32.2 from base against 30.1..53.9 to
// COLOR_VALUE, worst ratio 0.85; 126 is 1.08 and fails.

// ---------- §6 THE ATTENTION PULSE: the band breathes while a prompt waits -----
// SHIPS DISABLED AND UNMEASURED, behind the runtime `PULSE 0|1` toggle. §6 gates
// this one animation on a POWERPROBE A/B because it is the only candidate that
// costs current INDEFINITELY - the crossfade is one-shot and the shimmer rides a
// flush that was happening anyway - on a board where the backlight is already ~80
// of ~142 mV/h. The exact procedure is committed beside the toggle in
// deckhand_display.ino; it needs the cable physically out, which is why it is not
// something the implementation could run for itself.
//
// PEAK STRENGTH, TOWARDS COLOR_VALUE, exactly as the shimmer's is, and here the
// direction has a second argument the spine does not need: the band carries INK,
// in COLOR_CARD, and COLOR_CARD is the surface COLOR_VALUE is furthest from. So
// breathing towards COLOR_VALUE moves the fill AWAY from its own ink and the
// word's contrast can only IMPROVE at the peak. Breathing towards COLOR_CARD -
// the obvious reading of "brighten" under LIGHT - would collapse the status word
// to nothing at the top of every breath.
//
// A SEPARATE CONSTANT FROM SESSION_SHIMMER_MAX EVEN THOUGH THE TWO AGREE TODAY:
// the roles differ by three orders of magnitude in area (a travelling head on 6
// columns against a whole 292x42 field), so a strength that reads as a highlight
// on one is not automatically right on the other. They are held to the SAME
// perceptual bound, which is the part that should be shared.
const int SESSION_PULSE_MAX = 110;

// ---------- The band card's block stack ----------
// SESSION_EXP_MAX_H is the SUM of these, not a chosen number - the same way the
// 212 it replaces was derived. sessions-geom-check.mjs asserts the sum, so a future
// field cannot silently push a line past what its data can fill.
const int SESSION_BAND_NAME_H = 34;      // T_HEAD 24 + 10 leading
const int SESSION_BAND_SUB_H = 32;       // T_BODY 16 + 16, the agent/model/branch line
const int SESSION_BAND_TITLE_STEP = 20;  // T_BODY 16 + 4
const int SESSION_BAND_RULE_H = 18;      // 1px rule + air either side
const int SESSION_BAND_LABEL_H = 28;     // the "LAST PROMPT" caption
const int SESSION_BAND_PROMPT_STEP = 24; // T_BODY 16 + 8; prompt gets the most air
const int SESSION_BAND_PATH_H = 20;
const int SESSION_BAND_BOTTOM_PAD = 6;
//
// TWO HARD CAPS ON THE LINE COUNTS, both inherited from the existing derivation and
// both asserted: the lane is (296 - 2*14) / 8 = 33 columns, so prompt[104]'s 100
// characters need 4 lines (3 x 33 = 99 is one short) and a 5th is permanently
// blank; title[44]'s 43 characters need 2 (1 x 33 = 33 is short) and a 3rd is
// permanently blank. SESSION_EXP_PROMPT_MAX and SESSION_EXP_TITLE_LINES are those
// counts and must not be raised without new byte caps to justify them.
//
//   band 44 + name 34 + sub 32 + title 2x20 + rule 18
//        + LAST PROMPT 28 + prompt 4x24 + rule 18 + path 20 + pad 6 = 336

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
//   grant    = leftover < SESSION_EXP_MIN_H ? 0 : min(leftover, SESSION_EXP_MAX_H)
//   expanded = min(grant, the block stack this session's own content fills)
// i.e. the TOP row of the urgency-sorted list absorbs exactly what the ladder
// would have left empty, every other row keeps the height the ladder already gave
// it, and the whole thing collapses to today's uniform list the moment the ladder
// fills the column. The leftover is derived from the GLOBAL sessionRowH - the
// ladder's own output - and not from a second copy of the ladder formula, so the
// two cannot drift.
//
// THE SIX GRANTS, avail 410 (see the ladder above). These are the CEILINGS, not
// the heights: what the card actually takes is the block stack its own session
// fills, and the rest stays outside it as list area (see the paragraph below).
//   1 session  leftover 410 -> 336 (cap)   prompt <= 4 lines  74px spare at the cap
//   2 sessions leftover 307 -> 307         prompt <= 2 lines
//   3 sessions leftover 204 ->   0         under the floor - see SESSION_EXP_MIN_H
//   4 sessions leftover 101 ->   0         the ladder already fills the column
//   5 sessions leftover  82 ->   0
//   6 sessions leftover  70 ->   0
// With the "+N more" strip (avail 391) only the six-row case is reachable, and it
// is 66 -> 0. So expansion is a ONE-to-TWO session behaviour by arithmetic, not
// by a special case at either end.
//
// THE CARD IS AS TALL AS WHAT IT DRAWS, AND THE SURPLUS STAYS OUTSIDE IT. The
// grant above only bounds it: sessionExpMeasure() walks the same block stack the
// draw's cursor walks, with the REAL wrapped line counts, and sessionExpandedH()
// returns the smaller of the two. §4: "if the derived total lands below 410, the
// remainder stays OUTSIDE the card as list area, as it does today, rather than
// becoming a card of air."
//
// THE DEFECT THAT FORCED IT, measured off the glass. The prompt block is BUDGETED
// its full line count and a real prompt often wraps to fewer, so the unused lines
// pooled between the prompt and the bottom-anchored path rule: 36px against a
// normal inter-block leading of 9-19px, which reads as a rendering fault rather
// than as padding. A session with no prompt yet - the just-started case, i.e.
// exactly the one-session screen this card exists for - pooled 142px with a title
// and 182 without. Flowing the path up with the cursor instead would only move the
// hole to the card's bottom edge, which is the trailing air the 288 floor below
// was raised to remove.
//
// AND A LONE CARD IS CENTRED IN THE LIST AREA (sessionRowYAt), which is the other
// half of the one-session case: a full 336 of 410 leaves 74px, and all of it sitting
// BELOW the card reads as "a card, then nothing" no matter how much the card
// carries. Centred it is 37px above and 37 below. ONLY when the card is alone - in
// a mixed layout the stack's top alignment is the rhythm, and dropping the first
// card would open a gap above a list that still ends flush at the bottom.
//
// SESSION_EXP_MIN_H IS THE SAME BLOCK STACK AS THE CAP WITH THE PROMPT AT ITS
// MINIMUM, which is what makes the two ends of the range ONE derivation instead
// of two that can drift:
//   MIN = band 44 + name 34 + sub 32 + title 2x20 + rule 18 + LAST PROMPT 28
//         + prompt 2x24 + rule 18 + path 20 + pad 6                       = 288
//   MAX = MIN + (PROMPT_MAX - PROMPT_MIN) * SESSION_BAND_PROMPT_STEP      = 336
// So every SESSION_BAND_PROMPT_STEP above the floor buys exactly one more prompt
// line, and sessionExpPromptLines() is that same arithmetic run backwards. Below
// the floor the card cannot draw the body at all, which is why the rule returns 0
// rather than a short card - the same thing SESSION_TITLE_MIN_H does a rung down.
//
// IT WAS 199, AND THAT NUMBER DESCRIBED A BODY NOBODY DRAWS ANY MORE. 199 is the
// OLD row layout pushed down by the band: a 16px line step, 3px gaps, no rules,
// no leading. It fits 204, so the gate admitted a three-session band card - which
// then drew 77px of nothing below its own content, exactly the "card of air" the
// design forbids. The body drawn today is 244px of blocks before the band, so the
// floor is 288 and THREE SESSIONS NO LONGER GET A BAND CARD.
//
// THAT IS A DELIBERATE CONSEQUENCE AND IT HAS A PRICE: 3.9% of ticks (365 of
// 9,452 measured). It is not a tuning choice that could have gone the other way.
// A 204 card has 160px of body and the body is NINE blocks - name, sub, title,
// rule, caption, two prompt lines, rule, path - which is 17.8px each against a
// 16px cell, i.e. zero leading and no rules. So the choice was never "a shorter
// card or a taller one"; it was "a card that draws its content or one that does
// not", and the design's own rule for the second case is that it stops being a
// card. The four-piece spec's table listing 3 -> band card predates the body it
// is now measured against.
//
// The checker re-derives this from the PARSED blocks rather than trusting the sum
// written above, and separately asserts that ONE PIXEL SHORTER overdraws - so
// this is the floor, not a bound chosen with room to spare.
const int SESSION_EXP_MIN_H = 288;
// THE CAP IS THAT SAME BLOCK STACK AT ITS FULL PROMPT, and every block in it is
// DRAWN - which is the whole difference between this number and the 212 it
// replaced. prompt[104] carries at most 100 characters against the card's lane,
// so 4 lines are the most that can ever hold ink and a fifth would be permanently
// blank; title[44] is 2 by the same argument. Above this there is nothing left to
// put in the card, so the surplus stays OUTSIDE it as list area - 74px at one
// session, spent on centring the lone card - rather than becoming a card of air.
// The same rule applies BELOW the cap, per card rather than per board: a card
// whose content is shorter than its grant takes the content's height, and the
// difference is list area too. See sessionExpMeasure().
const int SESSION_EXP_MAX_H = 336;
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
// THE STATUS PILL'S HEIGHT - see board_e32r28t.h for why this is a name rather
// than the four literals it replaces. 18, UNCHANGED from board 1, and that is the
// one number in the row stack this board does NOT grow: the pill is sized by its
// label's ink, and MC_DATUM centres on the ASCENT, so Spleen 8x16's ascent is 12
// against Cozette's 10 - two rows more, inside an 18px pill that already carried
// 2px of slack top and bottom. The band table in the sessions section spends this
// number as 18 on both boards for exactly that reason.
//
// THE COST OF NOT GROWING IT is real and recorded: the label's own 16-row opaque
// box does not fit (it would ink +3..+18 in a pill occupying +0..+17, erasing the
// bottom edge and both bottom arcs), which is why drawStatusPill draws the label
// TRANSPARENTLY on this board instead of widening the pill. Raising this to 20
// would give the box room - and cost every tall row 2px, which the ladder's
// four-session rung has 6px of margin for and its five-session rung does not.
const int PILL_H = 18;
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
// 184px title lane for a longest title ("DISPLAY & SOUND") of 120px at THIS board's
// 8px advance - 15 chars * TEXT_ADV, not the 90px that sentence used to claim, which
// was Cozette's 6 - centred at 160 so it runs 100..219 inside a lane of 68..251.
const int PAGER_BTN_W  = 60;
// 8, and the arithmetic first: board 1's 6 held physically is 6 / 5.624 * 6.489 =
// 6.9, taken up to 8 to sit on the 4px spacing scale (SP_2). That it does not match
// CARD_X (12), so the pager keys sit slightly outside the card lane on both boards,
// is a CONSEQUENCE of that arithmetic rather than the reason for it - and the claim
// that this is what makes the band read as chrome above the page rather than as the
// page's first row is a JUDGEMENT, unmeasured, and not what set the number.
const int PAGER_BTN_X0 = 8;
const int PAGE_TOP = CONTENT_Y + PAGER_H + 4;   // 104

// THE PAGE REGION IS PAGE_TOP(104)..contentBottom(460) = 356px, against board 1's
// 222. (462 in an earlier revision of this comment: FOOTER_H went 18 -> 20 when
// the footer's line became 16px, which moved contentBottom() with it. Two pixels,
// but a page region quoted from a stale contentBottom is exactly how a last row
// gets blessed against a footer it actually touches.)
//
// THE RHYTHM IS TWO NUMBERS, NOT ONE, and the split is what the 16px line forced:
// SP_3 (12) BETWEEN cards and page rows, SP_2 (8) BETWEEN THE ROWS INSIDE a card.
// The previous revision used 12 everywhere and said so; it also said "8 is the
// rhythm INSIDE a card rather than between rows of one", which is the rule now
// actually applied. It had to be, arithmetically: six 16px rows plus a label at a
// 12px inter-row gap is a 216px STATUS card, where at SP_2 it is 176 - and a card
// whose own rows are 16px tall separated by 12 is a gap most of a row wide, which
// is the thing the comment above already says stops reading as one list.
//
// Every page is still TOP-ALIGNED under the pager. Trailing air, re-derived at
// 16px: 28px on STATUS (two cards now - the 16px pass left 168px there and the
// LINK card spends 140 of it), 22 on DISPLAY & SOUND, 148 on ACTIONS, 108 on
// PAIRED MACS with four Macs. Growing the gaps until the last row lands 8px
// above the footer, the way the USAGE column does, is still rejected on the same
// arithmetic: it needs a gap wider than the 16px rows it separates.

// ---------- SETTINGS page 0: the DEVICE card, then the LINK card ----------
// BOTH CARDS ARE SIZED BY THEIR CONTENTS, like the stepper card and unlike the
// USAGE column, and both are laid out on ONE nominal row pitch: 24 = a 16px line
// (uiLineH(T_BODY)) plus SP_2. Six rows for DEVICE, four for LINK.
//
// WHY 24 AND NOT THE 28 THIS CARD USED TO HAVE. 28 was a 13px line plus 15, and
// the 13 is gone; keeping 28 would spend 226px on the DEVICE card and leave the
// page unable to hold the LINK card at all (226 + 12 + 160 = 398 against 356).
// At 24 the two cards are 176 and 128, which is 328 of the region with 28px of
// trailing air. The physical cost is stated rather than hidden: board 1's rows are
// 28px apart at 5.624 px/mm = 2.67mm of gap, and 8px here is 1.23mm, so these two
// cards are the one place on this board where the rhythm is TIGHTER than board 1
// rather than looser. The alternative was not having the LINK card.
//
// CHECK CLEAR BOXES, NOT GLYPHS, the same discipline the USAGE card is built on.
// A field drawn through drawIfChanged clears y-1..y+cellH, i.e. ONE ROW ABOVE AND
// ONE BELOW its own 16px box - which is why the printed gaps below run 12/8/7/7/6
// rather than a flat 12/8/8/8/8. That is the overhang, not a varying rhythm.
// What each row actually paints:
//   - a connection row is drawConnRow(): fillRect(xRight-CONN_TEXT_W, y,
//     CONN_TEXT_W, CONN_TEXT_H), i.e. y..y+15, plus a 13px dot centred at y+8
//   - the battery row is that dot plus drawIfChanged at y+DROW_BATT_VAL_DY
//   - ID is a plain 16px line at +DROW_ID, clearing nothing extra
//   - the Mac rows and every LINK value are 16px lines clearing y-1..y+16
//
//   +0..+1     border
//   +2..+5     pad 4
//   +6..+21    "DEVICE" label (16px cell, drawn at +6)
//   +22..+33   gap 12 (SP_3 - a card's own label is not one of its rows)
//   +34..+49   Bluetooth      (DROW_BT;  dot +35..+48)
//   +50..+57   gap 8
//   +58..+73   USB            (DROW_USB)
//   +74..+80   gap 7
//   +81..+98   Battery        (DROW_BATT 82: label +82..+97, dot +83..+96,
//                              reading clears +81..+98)
//   +99..+104  gap 6
//   +105..+122 SoC temp       (DROW_TEMP 106: label +106..+121, reading clears
//                              +105..+122)
//   +123..+129 gap 7
//   +130..+145 device id      (DROW_ID)
//   +146..+152 gap 7
//   +153..+170 Mac link row 0 (DROW_MAC0 154, clears +153..+170)
//   +171..+176 gap 6
//   +177..+194 Mac link row 1 (DROW_MAC1 178, clears +177..+194)
//   +195..+197 pad
//   +198..+199 border                                              = 200
// The 2px border owns +198..+199 so nothing may end past +197; the last clear
// ends +194, 3 rows clear. Board 1's equivalent card is 160 with 6px of slack.
//
// THE CARD GREW 176 -> 200 FOR THE SoC TEMP ROW, and the 24px comes out of this
// page's TRAILING AIR, not out of another row. LINK_CARD_Y is derived from
// DEV_CARD_H below, so the LINK card slides 304 -> 328 on its own and the page's
// air goes 28px -> 4px - the same margin the USAGE tab settled on, and
// settings-geom-check.mjs asserts it stays above zero (a card ending flush on
// contentBottom() reads as joined to the footer, which board 1 shipped once).
// There is no room left on page 0: a further row has to come from somewhere else.
const int DEV_CARD_Y = PAGE_TOP + 12;   // 116
const int DEV_CARD_H = 200;             // 116..315
const int DROW_BT = 34, DROW_USB = 58, DROW_BATT = 82, DROW_ID = 130;
// BOARD 2 ONLY, and it is a capability rather than a preference: the ESP32-S3 has
// an internal temperature sensor whose driver is real here (measured: a 522-byte
// temperature_sensor_install, not one of the three-instruction stubs esp_pm ships
// on this core), and the plain ESP32 has no usable equivalent. So this constant
// exists in ONE header, the same shape as P2_MIC_Y and the LINK card, and board 1
// never sees the row.
//
// It sits directly under Battery because the two are read together, and it mirrors
// that row's geometry exactly - T_BODY label indented past the dot column,
// T_META reading right-aligned on the same DROW_BATT_VAL_DY baseline - rather than
// introducing a second row rhythm inside one card. It carries no health dot: the
// reading is a NUMBER and its colour is an accent on it, so the dot column stays
// empty here and colour is never the only carrier.
const int DROW_TEMP = 106;
// Two fixed row SLOTS, not one per hostLinks[] index - renderMacLinkRows()
// compacts to however many links are used, so one remaining Mac always draws in
// slot 0 rather than leaving a hole where the other one was.
const int DROW_MAC0 = 154, DROW_MAC1 = 178;
// 0, WHERE BOARD 1 HAS 4, and this constant exists because that 4 was invisible
// at 13px and is not at 16. The battery READING is drawn DROW_BATT_VAL_DY below
// the "Battery" label beside it; on board 1 that is a 4px stagger between two 13px
// lines, which ships and is left exactly as it is. At 16px the same 4 reads as two
// halves of one row failing to line up, so this board draws them on the same
// baseline. It is a board constant rather than a literal for the usual reason:
// board 1 substitutes its own 4 and its binary cannot move.
const int DROW_BATT_VAL_DY = 0;
// 24, WHERE BOARD 1 HAS 20, because this board also draws the CHARGING estimate and
// its widest label is longer than the discharge one: "90% 4.10V topping up" is 20
// characters, so board 1's 20 bytes truncated it by exactly one. Derived rather
// than guessed - "topping up" only appears at or above BATT_CHG_KNEE_MV (4100) and
// BATT_CHARGING only holds below BATT_FULL_MV (4180), so the percentage in that
// band is 90..97. settings-geom-check.mjs re-derives the same bound and asserts it.
const int BATT_ROW_CACHE = 24;
// 12, WHERE BOARD 1 HAS 8: this board's charging label "topping up" is 10 chars +
// NUL, and 8 would truncate it to "topping". See BATT_ROW_CACHE above.
const int BATT_LEFT_BYTES = 12;
// THE CONNECTION ROW'S ERASE BOX, and the width is DATA-derived and was WRONG.
// drawConnRow right-aligns "Connected" or "Not connected" and clears a fixed box
// first; the box was a literal 100 on both boards, which covers 13 Cozette
// characters (78px) with room to spare and 13 Spleen characters (104px) NOT AT
// ALL. The uncovered 4px is the left edge of the "N", so going Not connected ->
// Connected left a sliver of the old string behind - a ghost small enough to read
// as a rendering artefact rather than as a stale value. 112 is 14 characters at
// this board's 8px advance, i.e. the widest string plus one.
// The HEIGHT is 16 on both boards: it must cover uiLineH(T_BODY), which is exactly
// 16 here and 13 on board 1 (where the extra 3 rows are free clearance). Named so
// settings-geom-check.mjs can assert that relationship instead of reading a
// literal it would have to regex out of the .ino.
const int CONN_TEXT_W = 112;
const int CONN_TEXT_H = 16;
// 28, UNCHANGED, and this is one of the few numbers that is genuinely NOT
// panel-derived: it is the width of the DATA. "Mac  feedfeed  999s ago" - a bare
// 11-character hostId with no tag, plus a generously wide age - is 23 characters,
// and every row is padded to this same fixed width whether used or not, which is
// what makes a row that goes away actually get ERASED rather than merely stop
// updating (the erase box is sized to the padded text). macRowCache is shared at
// [40]: worst case 28 (text) + 1 (\x01 sentinel) + 2 (icon id) + 1 (NUL) = 32.
// Lane check, AT THIS BOARD'S OWN ADVANCE: the row starts at CARD_X + PAD = 30 and
// renderMacLinkRows() sizes its erase box from a MEASURED tft.textWidth(), which
// at 8px is 28*8 + 4 + 16 + 2 = 246 wide, ending at 276 inside a card whose
// interior runs to 305. (The old comment did this multiplication at 6px AND with
// board 1's 13px icon, both of which were true of every board when it was written
// and are now true of one.)
const int MAC_ROW_W = 28;

// THE LINK CARD - four facts the device already had and could only be read from a
// Mac's log: host liveness, the last payload's size, the last flush's duration and
// uptime. It exists because the STATUS page was spending 144 of its 356 rows on
// nothing, and because on this board those four numbers are the only instrument
// there is: board 2 has no USB serial console in normal operation, so "is the host
// still ticking, and how big and how slow is a frame" was unanswerable from the
// device itself. BOARD 2 ONLY - lastFlushUs() is a PanelShim accessor that does
// not exist on board 1, and board 1's STATUS page has no 144 spare rows to put a
// card in even if it did.
//
// Same 24 pitch, same label-then-rows shape, one row fewer than DEVICE has two:
//   +0..+1     border
//   +2..+5     pad 4
//   +6..+21    "LINK" label
//   +22..+32   gap 11 (SP_3 less the value's one-row overhang)
//   +33..+50   HOST     (LROW_HOST 34;    value clears +33..+50)
//   +51..+56   gap 6
//   +57..+74   PAYLOAD  (LROW_PAYLOAD 58)
//   +75..+80   gap 6
//   +81..+98   FLUSH    (LROW_FLUSH 82)
//   +99..+104  gap 6
//   +105..+122 UPTIME   (LROW_UPTIME 106)
//   +123..+125 pad
//   +126..+127 border                                              = 128
// Last clear ends +122 against a border at +126, 3 rows clear.
//
// THE FLUSH FIELD PARTLY MEASURES ITS OWN REPAINT, and it never settles. Its value
// goes through drawIfChanged, which dirties a rect, so every settings render while
// this page is showing guarantees a NON-EMPTY flush - and the duration that flush
// records is then what the field displays on the next one. So FLUSH ticks forever
// on this page and reads the cost of a small dirty-rect push rather than of a
// frame you were interested in; SHIMBENCH is still the instrument for a full-screen
// flush. Harmless, and the same class as the footer's per-second fields, but a
// reader watching a number change with nothing happening deserves to find the
// reason here rather than wonder whether it is broken.
const int LINK_CARD_Y = DEV_CARD_Y + DEV_CARD_H + 12;   // 328..455
const int LINK_CARD_H = 128;
const int LROW_HOST = 34, LROW_PAYLOAD = 58, LROW_FLUSH = 82, LROW_UPTIME = 106;

// ---------- SETTINGS page 1: the stepper cards ----------
// THE CARD IS NO LONGER SIZED BY THE KEY, AND SAYING SO IS THE POINT. Board 1's
// rework moved the label into the MIDDLE column - above the value it names, clear
// of both key columns - precisely so the keys could own the whole interior height,
// and this file inherited that sentence. At a 16px label, a 24px value and an 8px
// bar it is simply no longer true: the middle column needs 16 + 28 + 8 = 52 rows
// of content, and with SP_2 between its three bands and 4px of pad top and bottom
// that is a 76-row INTERIOR - where the key needed 50 + 12 = 62. The taller of the
// two now sets the card, so the middle column does.
//
// (The 28 is the VALUE's real painted extent, not its 24px cell: drawIfChanged
// clears cy-13..cy+12 for a 24px box under MC_DATUM while drawString paints
// cy-9..cy+14, because MC_DATUM centres on the ASCENT and biases the box low by
// half the descent. The union is 28 rows. Using 24 here is what put the value's
// own opaque box one row into the bar - see the previous revision's +35/+49.)
//
// STEP_BTN_SIZE IS THEREFORE 64, NOT 50, and it is grown to the interior rather
// than left floating in it. 50 was TAP_MIN + 4, the same "4px over, not merely at
// it" relation board 1 has at 40 + 4; a 50px key in a 76px interior would sit in
// 13px of dead air top and bottom, and a bigger touch target is the only thing
// that air could buy. 64 = 76 - 2*6, keeping the same 6px of air the 50px key had.
//
//   +0..+1    border
//   +2..+77   interior (76 rows)
//   +8..+71   the two +/- keys (STEP_BTN_TOP 8, STEP_BTN_SIZE 64)
//   +78..+79  border                                                = 80
//
// The MIDDLE COLUMN's own stack, horizontally clear of both keys, so it is checked
// against the card and not against the key band:
//   +2..+5    pad 4
//   +6..+21   label  (STEP_LABEL_CY 12, MC_DATUM, 16px box +6..+21)
//   +22..+29  gap 8
//   +30..+57  value  (STEP_VALUE_CY 43, MC_DATUM, T_HEAD: clears +30..+55,
//                     paints +34..+57 - the union is what must be disjoint)
//   +58..+65  gap 8
//   +66..+73  BRIGHTNESS bar only (STEP_BAR_Y 66, STEP_BAR_H 8)
//   +74..+77  pad 4
// Every band is disjoint - the value's fat, LOW-BIASED clear box is what makes
// that worth stating rather than assuming.
const int STEPPER_CARD_H = 80;
const int STEP_LABEL_CY  = 12;
const int STEP_VALUE_CY  = 43;
const int STEP_BAR_Y     = 66;
const int STEP_BTN_TOP   = 8;
const int STEP_BTN_SIZE  = 64;
// 8, from board 1's 6: physically 1.23mm against 1.07mm, i.e. the bar keeps its
// thickness while getting longer, the same trade BAR_H makes on the USAGE cards.
const int STEP_BAR_H     = 8;
// 10, UNCHANGED. It is the clearance between a key's edge and the bar, and neither
// side is the constraint on it. Lane, re-derived for the 64px key:
// CARD_X + PAD + 64 + 10 = 104 to 215, against keys at 30..93 and 226..289.
const int STEP_BAR_GAP   = 10;
// The page: 3 * 80 + H_ROW(46) = 286 of 356, laid out top-aligned on the 12px
// rhythm - cards at 116 / 208 / 300 and the toggle row at 392..437, 22px clear of
// the footer. Board 1 has 14px for the same five gaps and its own comment says
// neither its cards nor its toggles could give another pixel.
//
// THE THREE TOGGLES, measured at 8px rather than counted: P1_THIRD_W is
// (CARD_W - 16) / 3 = 93, and the widest of the seven labels the row can show
// ("FLIPPED", 7 chars = 56px) needs 64 with uiButton's 8px of padding. So the row
// still fits with 29px to spare per third, and 93 also clears TAP_MIN 46 twice
// over. uiButton centres its label with MC_DATUM at y + h/2 = y+23, which at a
// 16px box lands y+17..y+32 inside the 46px row - the 2px low bias is absorbed by
// 30 rows of slack here, where on the status pill it was fatal.
const int P1_TOP = 12;
const int P1_GAP = 12;
// ---------- SETTINGS page 2: the action buttons ----------
// H_BTN, where board 1 had to drop to 38 because four buttons plus a hint would
// not fit at 44 - so these are the one control on this page that was UNDER the
// floor on board 1 and is over it here.
// THREE buttons, not four: BOARD_HAS_MIC is 0 here, so there is no MIC TEST and no
// slot reserved for one (see the #if in deckhand_display.ino). 3 * 50 + 2 * 12 =
// 174, from 116 to 289, with the hint at 302 (inking 296..311, MC_DATUM) and 148px
// clear below it. (An earlier revision of this comment did the four-button
// arithmetic and put the hint at 364 - it was copied from board 1's chain, which
// does have the mic button, and the numbers it quoted never described this board.)
// The 16px pass changes nothing here: these are control heights, and the labels
// re-measure clear - "CALIBRATE TOUCH" is 15 chars = 120px in a 296px button, and
// the hint ("power off = deep sleep, RESET to wake", the no-touch-wake arm this
// board compiles) is 37 chars = 296px centred on a 320px panel, inking 12..307.
const int P2_TOP   = 12;
const int P2_BTN_H = 50;
const int P2_GAP   = 12;

// ---------- SETTINGS: the confirm dialog ----------
// 28, board 1's 24 held physically (24 / 5.624 * 6.489 = 27.7). Top-anchored to
// PAGE_TOP exactly as board 1 is, deliberately not centred in the page region:
// the dialog is modal and must land in the same place regardless of which page it
// was raised from, and three of the four pages have different lengths.
//
// CFM_H 160, sized by the block it holds rather than scaled, and RE-DERIVED at
// 16px rather than assumed to still fit. drawConfirm() lays its three text
// elements out as ONE BLOCK centred in the space above the button row, so what the
// height has to hold is the WORST block: title (T_HEAD, 24) + SP_2-2 + emph
// (T_BODY, 16) + SP_2 + 2 note lines (32) = 86, against
// avail = CFM_H - H_BTN - SP_3 - BORDER_CARD = 160 - 50 - 12 - 2 = 96. So the
// block is centred in 96 rows with 5 above and 5 below, and 160 stands.
// (Board 1: a 71px block in 86.)
//
// THE LANE IS CARD_W - 2*SP_3 = 272px, WHICH IS 34 CHARACTERS AT 8px, and the
// previous revision's "45 characters" was that same 272 divided by 6. Two of the
// four shipping notes now wrap where NONE of them did at 6px:
//   "its key is deleted; re-pairs over USB"   37 chars, 296px -> 2 lines
//   "5 taps; current setup kept if it fails"  38 chars, 304px -> 2 lines
//   "every paired Mac is forgotten"           29 chars, 232px -> 1 line
//   "deep sleep - press RESET to wake"        32 chars, 256px -> 1 line
// which is why the two-line height was worth deriving for rather than treating as
// a hypothetical: it is now the case that actually ships. countWrappedLines()
// still decides at runtime and drawConfirm() draws at most 2, so a future note
// needing 3 would be CLIPPED - settings-geom-check.mjs asserts against that.
// The four titles are measured at T_HEAD's 12px advance: the widest
// ("Recalibrate touch?" and "Reset all pairing?", 18 chars) is 216px in the 272px
// lane, so none of them can reach the border its opaque box would rub out.
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
//   KB_COLS       = (CARD_W - 12) / TEXT_ADV = (296 - 12) / 8 = 35.5 -> 35
//   KB_TEXT_LINES = ceil(KB_MAX_BYTES / KB_COLS) = ceil(150 / 35) = 4.29 -> 5
//
// THE LANE IS CARD_W - 12, NOT CARD_W - 8, and the two are worth separating once
// because they agree at board 1's width and so the wrong one survived in CLAUDE.md
// for a whole port: the text is drawn at CARD_X + 6 and the card ends at CARD_X +
// CARD_W - 1, so a symmetric 6px pad leaves CARD_W - 12. At board 1's 216 both
// expressions floor to 34; at 296 they give 35 and 36.
//
// 35 IS THE EXACT MAXIMUM AND IT IS MEASURED, not divided. drawString charges the
// last glyph xOffset + width rather than xAdvance, so a count that divides exactly
// can still overflow - board 1's 34 does, by 1px, for a line ending in space, '4'
// or 'q'. Spleen 8x16 has xOffset 0 and width == xAdvance == 8 for every glyph in
// 0x20..0x7E, so the widest 35-column line inks 34*8 + 8 = 280px in the 284px lane
// with 4px to spare, for ANY string, and 36 columns would need 288. See TEXT_ADV.
//
// THIS BOARD'S EARLIER 47 CAME FROM DIVIDING BY 6 - Cozette's advance - after the
// face here became Spleen 8x16. The hard wrap does not measure anything (it slices
// KB_COLS bytes and draws them), so 47 columns painted 47*8 = 376px of text from
// x = 18 across a 320px panel: the tail of every long line ran off the screen, and
// the 4-line budget under it meant a 150-byte answer could put text where the card
// does not reach at all. Nothing errors on either count.
//
// SO THE CARD GAINS A LINE RATHER THAN LOSING ONE: 5 lines here as on board 1, not
// the 4 the 47-column arithmetic claimed. The caret's furthest reachable position
// moves with it and stays provable rather than clamped: at kbLen = KB_MAX_BYTES the
// caret is at line 150 / 35 = 4, column 150 % 35 = 10 - inside the 5 lines the card
// budgets, at x = CARD_X + 6 + 10*TEXT_ADV = 98.
//
// KB_MAX_BYTES IS NOT TOUCHED. It is 150 on the HOST too (ANSWER_TEXT_MAX_BYTES
// in host/voice-answer.mjs, re-exported for the typed form), so only the columns
// and the resulting line count move.
//
// THE OTHER PAIRING THIS COULD HAVE BROKEN, re-measured rather than reasoned: the
// voice-answer confirm screen caps its transcript panel at 8 WORD-wrapped lines
// (askVoiceTooLong() in sessions.ino, measured against CARD_W - 8), and CLAUDE.md
// records that cap and the 150-byte one as consistent by arithmetic. A wider lane
// does NOT automatically loosen that, because word wrap's worst case depends on the
// lane: wrapLineLen breaks no further back than halfway, so the adversarial word
// length is per-board and a board-1 string measures nothing about a 288px lane.
// Searched per board at each board's own worst word length (settings-geom-check.mjs
// does the same search): board 1 lands on exactly 8 at 17-character words, board 2
// on 7 at 18-character words. So the shared cap of 8 still holds, with one line of
// slack here against board 1's none, and the constant is left alone.
const int KB_COLS = 35;
const int KB_TEXT_LINES = 5;
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
// on a reserved row, and the invariant is preserved here by construction. At a
// 16px cell and 5 lines the card is 120 rather than 90, which is arithmetic:
// 8 + 16 + 8 + 5*16 + 8 = 120, every term below.
//   card    +0..+119  (KB_TEXT_Y 12 .. 131, KB_TEXT_H 120)
//   meta    +8..+23   (KB_META_DY 8  -> y 20..35: byte counter left, countdown right)
//   gap     +24..+31  (8 rows - board 1 has 3)
//   line 0  +32..+47  (KB_LINE0_DY 32 -> y 44)
//   line 1            y 60
//   line 2            y 76
//   line 3            y 92
//   line 4            y 108..123
//   pad     +112..+119 (8 rows below the last line, inside the card)
// The meta row occupies y 20..35 and the first text line starts at y 44, so they
// share no pixel row with 8 to spare. The two gaps are equal at 8 deliberately:
// the card's only job is to hold the meta row and the text, so the air above and
// below the block is the same, and the residual lands in the BREAK below the card
// rather than inside it.
const int KB_TEXT_Y  = 12;
const int KB_TEXT_H  = 120;
const int KB_META_DY = 8;
const int KB_LINE0_DY = 32;
const int KB_LINE_PITCH = 16;                  // Spleen 8x16's cell - text-derived
// THE VERTICAL BUDGET, and where this board's surplus actually goes. The content
// is a fixed grid plus a provably 5-line card, so there is nothing here to add:
//
//   12 (top margin) + 120 (card) + 38 (break) + 232 (4 rows * 58)
//   + 12 (gap) + 58 (action row) + 8 (bottom margin) = 480
//
// The 38px BREAK is a RESIDUAL, not a chosen number: it is what is left once every
// other term is fixed by something else (the card by its 5 lines at a 16px cell,
// the rows by the aspect cap on KB_ROW_H, the action row by KB_ROW_H, the margins
// by the 4px scale). It was 68 while the card was mis-derived at 4 lines of 13, and
// the 30 rows the card now needs came straight out of it - which is the right
// direction: the break is the term with no job of its own, and the card's height is
// the one number that decides whether SEND can sign text that is off screen.
// KB_ROWS_Y itself does not move, so the key grid, the action row and every touch
// band below the card are untouched by this.
const int KB_ROWS_Y = 170;                     // 4 rows * 58 = 232, ending 401
const int KB_ACT_Y  = 414;                     // 414..471, 8px above the panel edge
const int KB_ACT_H  = 58;                      // == KB_ROW_H, as on board 1
// The peek overlay covers the keys and the action row but NEVER the text card, so
// its height is BOARD_H - KB_ROWS_Y - 4 = 306. Its three stacked rows were the
// literals 8 / 22 / 40 in drawKbPeek(), and at a 16px cell the middle one was a
// real defect rather than merely tight: a T_META title box at +22..+37 starts
// INSIDE the "PROMPT" label's own box at +8..+23, and drawString paints that box
// opaquely, so the label's last TWO rows - 22 and 23, not one - were rubbed out on
// every draw. Each row now starts a full
// cell plus its air below the one above it - label +8..+23, title +25..+40, text
// from +46 - which reproduces board 1's 8 / 22 / 40 exactly at its 13px cell.
const int KB_PEEK_LBL_DY   = 8;
const int KB_PEEK_TITLE_DY = 25;
const int KB_PEEK_TEXT_DY  = 46;
// The text stops 8 short of the overlay's bottom, so (306 - 46 - 8) / 16 = 15.75
// -> 15 lines against board 1's 13. It was 19, which came from dividing by 13.
const int KB_PEEK_LINES = 15;

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
// row centred against the chip: a 16px line (TL_DATUM, so the box IS the cell)
// centred on the chip's own centre (27) starts at 27 - 16/2 = 19, inking 19..34
// against a chip drawn 4..49 and a rule at 54. It was 21, which was the same
// derivation done with Cozette's 13px cell.
const int HIST_HDR_TEXT_Y  = 19;
const int HIST_RULE_Y      = 54;
const int HIST_TOP         = 60;   // first entry row, 6 below the rule
// Centred between the rule and the control bar: (54 + 422) / 2 = 238. Board 1's
// 130 is NOT that midpoint (147) - a literal that predates the control bar - so
// this is derived rather than carried across.
const int HIST_EMPTY_CY    = 238;
// The CODE cell, and the one number the reader's whole page budget hangs off. It
// was 13 - Cozette's - which stayed put when the face here became Spleen 8x16, so
// the list, the full-entry pager AND the budget this board REPORTS to the Mac were
// all laid out on a 13px grid while the panel drew 16px lines. == uiLineH(FONT_CODE).
const int HIST_LINE_H      = CODE_LINE_H;
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
// 18 lines of 16 against board 1's 16. (It read "23 lines of 13" while HIST_LINE_H
// was Cozette's, which is the number this board was telling the host it could hold.)
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
