// Board 1: ELEGOO E32R28T/E32N28T, ILI9341 240x320 over TFT_eSPI's default
// VSPI bus (configured in the library's User_Setup.h). The resistive touch
// controller (XPT2046) is wired to DIFFERENT pins on a separate SPI bus (see
// LCDWIKI pin table), so it needs its own SPIClass instance and the
// standalone XPT2046_Touchscreen library rather than TFT_eSPI's built-in
// touch support.
//
// Every pin define and layout constant below MOVED here verbatim from
// deckhand_display.ino - comments included, since several of them document a
// derivation (why this number and not some other) rather than a preference.
#pragma once

#define BOARD_NAME "E32R28T"
#define BOARD_W 240
#define BOARD_H 320

#define BOARD_USES_TFT_ESPI  1
#define BOARD_BLE_NIMBLE     0
#define BOARD_HAS_MIC        1
#define BOARD_HAS_BEEPER     1
// Informational only on both boards - see board_es3c35p.h. Neither is read.
#define BOARD_HAS_SD         0
#define BOARD_HAS_RGBLED     0
#define BOARD_TOUCH_NEEDS_CAL 1
#define BOARD_SETTINGS_HOME  0   // four pages behind a chevron pager; see settings.ino
// The scrolling transcript is board 2's. This board keeps its paged reader: the
// panel is RESISTIVE, where this repo has already measured that drag-scroll
// misfires and settled on discrete pages, and its binary is held byte-identical.
// A #define, NOT a const int - the preprocessor cannot see a C++ const int, so
// `#if` on one is silently false with no warning. That has shipped here twice.
#define BOARD_HISTORY_SCROLL 0
#define BOARD_HAS_WIRELESS_PAIR 0  // PROVISION over USB is the only pairing path here; see board_es3c35p.h
// The USAGE tab's NOW / WEEK / CODEX layout is board 2 only: it needs a trend
// ring (~165 bytes of DRAM against board 1's ~26KB of free heap, which the audio
// path already competes for) and a 64px native hero this board does not have.
#define BOARD_USAGE_V2 0
// Deep sleep can be ended by TOUCHING THE GLASS on this board, which is a
// capability and not a preference: ext0/ext1 wake only from an RTC GPIO, and
// this panel's PENIRQ happens to be on one (IO36). See BOARD_SLEEP_WAKE_GPIO
// below, and the opposite case in board_es3c35p.h.
#define BOARD_HAS_TOUCH_SLEEP_WAKE 1
// No shadow framebuffer on this board - TFT_eSPI writes the panel directly and
// handles its own byte order - so there is nothing to swap. Named here anyway so
// the two board headers answer the same questions.
#define BOARD_PANEL_SWAP_BYTES 0

// ---- Radii and border weights ----------------------------------------------
// Unchanged from when they were shared globals; board 1 is the board they were
// chosen on. 10px is 1.78mm here and 6px is 1.07mm.
const int R_SM = 6;          // chips, pills, small controls
const int R_MD = 10;         // cards, buttons, rows
const int BORDER_CARD = 2;   // usage cards, session rows, settings cards, dialogs
const int BORDER_CTRL = 1;   // buttons, list rows, pills, chips, pager keys
// TFT_eSPI owns this board's inversion via its own init; nothing here applies it.
#define BOARD_PANEL_INVERT 0

// If the layout renders sideways/upside down on your unit, try 0/1/2/3 here.
#define SCREEN_ROTATION 0
// Flip this (and re-run calibration, see runCalibration) if touches feel
// transposed - e.g. moving your finger left/right moves the cursor up/down.
#define TOUCH_SWAP_XY true

#define TFT_BL_PIN 21

// BAT+ -> 100K/100K divider -> IO34 ("Battery level detection circuit" in
// the LCDWIKI E32R28T user manual), so VBAT = 2x the pin voltage. IO34 is
// ADC1, which stays usable while WiFi/BT is active (ADC2 does not).
#define BAT_ADC_PIN 34
// VBAT = BOARD_BAT_MV_SCALE x the pad voltage. A macro rather than a literal
// because it is the one number in sampleBattery() that is a property of the
// BOARD's divider, not of the code - so the shared function can serve two
// boards without either one's ratio being hidden inside it.
#define BOARD_BAT_MV_SCALE 2

// Onboard FM8002E 1W amplifier -> JP1 speaker terminals. IO26 is the
// amplifier's audio input (AUDIO_IN net); IO4 is its shutdown pin
// (AUDIO_EN net, 10K pulled high = amp muted; drive LOW to enable). Keeping
// the amp disabled except while actually beeping avoids idle hiss.
#define AUDIO_OUT_PIN 26
// Beeper volume presets. A LIST MACRO rather than an array because the array has
// to be defined once in the sketch (where VOL_PRESETS is declared) while the
// VALUES are board-specific: here they are LEDC duty out of 255, and on board 2
// they are ES8311 volume out of 100 - same three rungs, different units and
// therefore no shared literal that could be right for both.
#define VOL_PRESET_LIST {6, 18, 45}
#define AUDIO_EN_PIN 4

// Microphone: MAX4466 electret amp on the board's 4-pin "Expand" connector
// (VCC->3.3V, GND->GND, OUT->IO35). IO35 is the ONLY free ADC1 channel on this
// board - touch took 32/33/36/39 and the battery divider took 34 - and ADC1 is
// mandatory here because ADC2 is dead while BT is active. Input-only, which an
// ADC pin doesn't mind.
//
// The module idles at VCC/2 (~1.65V) and swings around that, so a healthy line
// sits near mid-scale in silence and widens when you speak. That bias is why
// the pin needs 11dB attenuation (~0-3.1V full scale); at the default range it
// would sit hard against the ceiling and clip everything.
#define MIC_ADC_PIN 35

// The BOOT key (10K pulled high, pressed = low). Only a strapping pin at
// reset; at runtime it's an ordinary button. Held for POWER_OFF_HOLD_MS it
// powers the device down (deep sleep - see powerOff()).
#define BOOT_BTN_PIN 0

// Touch controller pins, from the LCDWIKI E32R28T/E32N28T pin table -
// these are independent of the TFT's SPI pins.
#define TOUCH_SCK  25
#define TOUCH_MOSI 32
#define TOUCH_MISO 39
// TOUCH_CS's macro NAME is established back in deckhand_display.ino, not
// here - see the comment there. TFT_eSPI.h gates a chunk of its own built-in
// touch support (which we do not want; our touch controller is wired to a
// separate SPI bus, not the TFT's) purely on `#ifdef TOUCH_CS`
// (TFT_eSPI.h:963), so defining that name this early - before TFT_eSPI.h is
// included - silently pulls that code in: measured, it grows `tft` and every
// TFT_eSprite (e.g. octoSprite) by 20 bytes each. BOARD_TOUCH_CS_PIN holds
// the actual pin number; only the TOUCH_CS name itself is deferred.
#define BOARD_TOUCH_CS_PIN 33
#define TOUCH_IRQ  36
// The deep-sleep wake source: PENIRQ, low while the glass is touched. Named
// separately from TOUCH_IRQ because what qualifies a pin here is not that it
// is the touch interrupt but that it is an RTC GPIO - ext0 wakes from nothing
// else. On this chip the RTC set is 0,2,4,12-15,25-27,32-39, and 36 is in it.
#define BOARD_SLEEP_WAKE_GPIO TOUCH_IRQ

// ---------- Layout constants ----------
// THE BODY/CODE FACE'S X-ADVANCE, as a constant rather than the literal 6 that
// used to sit inline in every character-lane division. Cozette 6x13 advances 6px
// for every one of its 95 glyphs (T_META, T_BODY and FONT_CODE all resolve to it -
// see UI_FONTS in deckhand_display.ino), so a lane's column count is lane /
// TEXT_ADV. It is a named per-board constant because board 2's face is not this
// one: a literal 6 there described Cozette while the panel drew Spleen 8x16, which
// is how its keyboard came to claim 47 columns of a 35-column lane and its reader
// to report a page budget half again as big as it could draw.
const int TEXT_ADV = 6;
// THE BODY/CODE FACE'S CELL HEIGHT - the other half of TEXT_ADV, and named for the
// same reason: every surface that draws FONT_CODE steps by it, and a literal here
// describes ONE board's face. == uiLineH(FONT_CODE), which FONT_CODE aliasing
// T_BODY makes uiLineH(T_BODY) too; the checkers assert that against the parsed
// UI_FONTS[] table, since uiLineH() is not a constant expression and so cannot be
// used in a static_assert.
const int CODE_LINE_H = 13;
// AND THE HERO CELL, for the same reason and one specific caller: the waiting
// screen's wordmark is T_HERO with no size override on either board, and the five
// offsets below it are derived from it. It was a literal 32 gap, which is Cozette's
// 26 plus 6 - so on this board the 64px wordmark's own opaque box swallowed the
// device name and the first message line. == uiLineH(T_HERO). (Cozette 6x13 / Cozette 12x26 at size 2.)
const int HERO_LINE_H = 26;
// THE VOICE CARD'S LABEL STEP - the gap from a "YOU SAID"/"CLAUDE" label to the block
// it names (drawVoiceCard, audio.ino). It is CODE_LINE_H - 1, i.e. ONE PIXEL SHORT of
// the cell, so the block's top row lands on the label's last row. Harmless on this
// board and pre-existing: every Cozette glyph without a descender leaves its bottom
// row blank, the same allowance the ask badge/title pair already takes and that
// sessions-geom-check.mjs records as a board-1 `known`. It is a named per-board
// constant because reproducing that 1px encroachment on a 16px face would eat FOUR
// rows of a real 12-row ascent, which is not the same trade at all.
const int VOICE_LBL_STEP = 12;
const int TAB_BAR_H = 34;
const int CONTENT_Y = TAB_BAR_H;
// Persistent footer (clock + last-updated), visible under both tabs. Content
// clearing/redraw on either tab must stop above this band, not paint over it.
const int FOOTER_H = 18;

// The two Claude cards were 122 tall and, with the gaps, filled the content area
// exactly - there was no room for Codex anywhere. They are now 104: only the padding
// around the hero number tightened, the number itself is the same 39px Cozette, so
// the figures you actually read did not shrink.
const int CARD_X = 12, CARD_W = 216, CARD_H = 104;
// Gaps were tightened 10/8/6 -> 6/4/4 to free the 10px the Codex row needed for a real
// pace bar, and are now a uniform 4 - see the bottom-gap note on CODEX_H below. The
// space came from the GAPS, deliberately not from the cards: a card's content ends at
// y0+102 (label +6, hero +20..60, bar +62..72, stats +74, reset line +89..102) inside
// CARD_H 104, so shrinking them to 98 would have clipped the reset line by 4px. The
// hero figures are also the one thing the 122->104 pass explicitly protected.
const int CARD1_Y = 38, CARD2_Y = 146;
// Codex gets a single compact row rather than a full card, because it publishes a
// single percentage - there is no token count and no second window. One text line at
// +8 plus a full-height BAR_H pace bar at +26, so Codex reads the same way the Claude
// cards do rather than being the one figure with no bar to judge it against.
//
// THE COLUMN MUST NOT END FLUSH ON contentBottom(). It used to: 6+104+4+104+4+46 spent
// all 268px of the content area, so this row's bottom edge landed exactly on 302 and
// sat against the footer with no gap, reading as one joined block. The four gaps are
// now 4/4/4/4 - two px came off the top gap and two off this row - so the column ends
// at 298 with 4px of air below it, matching the gaps between the cards. The row keeps
// its slack: content reaches +39 (the pace bar's clear starts 4px above the bar at +26
// and runs 18 rows) inside CODEX_H 44, leaving the 2px border at +42..+43 clear of it.
const int CODEX_Y = 254, CODEX_H = 44;
// HOW LONG A CODEX READING STAYS ALIVE. usageCodexShown() (usage.ino) hides the row
// once a full window has passed with no refresh - the host polled and learned
// nothing, so nobody is running the tool - and this board now honours that instead
// of drawing "CODEX  --" for ever on a Mac that has never run Codex.
//
// SAME VALUE AS BOARD 2, and it has to be: the threshold is really DATA-DRIVEN (the
// window rides the wire as cxWin into usage.cxWindowMin and moves with the plan),
// and this is only the fallback for a percentage that arrives with no window beside
// it - the host sends `cxWin: primary?.windowMin ?? null`, so the two genuinely can
// arrive apart, and trusting an absent window would mean win = 0 and a row that hides
// the instant it is measured. Declared per board rather than shared because every
// other constant this predicate touches is, and a header is where a future board
// with a different plan would change it.
const int CODEX_HIDE_FALLBACK_MIN = 10080;   // 7 days, the observed Codex window
// RADIUS is defined FROM R_MD rather than repeated, so the two cannot drift -
// drawCardBorder() strokes with RADIUS over a fill uiCard() drew with R_MD, and
// a mismatch fringes every card corner. Same value as before on this board.
const int PAD = 14, BAR_H = 10, RADIUS = R_MD;

// ---------- USAGE tab: offsets inside a card, and the Codex row's lanes ------
// These were literals at their call sites (renderCard() in
// deckhand_display.ino, renderCodexRow() and renderFooter() in usage.ino) until
// board 2 needed different ones. THE VALUES ARE UNCHANGED - every number below
// is the literal that was there, moved and named, so this board's binary is
// byte-for-byte what it was.
//
// CHECK CLEAR BOXES, NOT GLYPHS: drawIfChanged() clears
// fillRect(fx-1, fy-1, tw+2, th+2) and drawPaceBar() clears
// fillRect(x-1, y-4, w+2, h+8) for its tick overhang. The two invariants this
// card is built on, both re-derived per board:
//   1. The 2px border owns +102..+103, so NOTHING MAY END PAST +101. The foot
//      row at +88 clears +87..+101 - exactly on the ceiling, which is why it is
//      at +88 and not +89 (at +89 it cleared +88..+102 and rubbed out the
//      border's inner row along the width of those two strings).
//   2. The label row is +6..+18 because the hero box starts at +20 and clears
//      from there across the full card interior - so a 16px icon in that row
//      would be erased by the hero's own clear on every tick the digits move.
//      The Mac icon is 13x13 for exactly this reason - and this is why
//      MAC_EMOJI_SIZE is PER BOARD rather than one number: board 2's hero box
//      starts at +24, so 16 fits there with 2 rows to spare, while raising this
//      board to 16 would put the icon under the hero's own erase.
// Known and NOT fixed here, because fixing it would move this board's binary:
// the stats row at +74 clears +73..+87 while the pace bar's clear runs
// +58..+75, so they overlap by 3 rows and a changing token count shaves the
// bottom of the pace tick until the bar next repaints. Board 2's derivation
// leaves every band disjoint.
const int CARD_PIN_BAR_Y = 3;    // pin bar, +3..+5, above the icon
const int CARD_LABEL_Y   = 6;    // label / Mac icon row, +6..+18
const int CARD_HERO_Y    = 20;   // hero box +20..+59
const int CARD_HERO_H    = 40;   // for a 39px glyph, 1px of slack
const int CARD_HERO_SIZE = 3;    // Cozette 6x13 at setTextSize(3) = 18x39
const int CARD_BAR_Y     = 62;   // bar +62..+71, clear +58..+75
const int CARD_STATS_Y   = 74;   // clear +73..+87
const int CARD_FOOT_Y    = 88;   // clear +87..+101 - on the ceiling, see above

const int CODEX_TEXT_Y = 8;      // clear +7..+21
const int CODEX_BAR_Y  = 26;     // bar +26..+35, clear +22..+39

// The Codex label's lane, bounded by ITS NEIGHBOUR rather than by anything of
// its own - the full derivation is the long comment in renderCodexRow(). Four
// numbers: the right field draws at CARD_X + CARD_W - PAD = 214 with TR_DATUM,
// its own WORST-CASE CONTENT ("100%  23h 59m left", 18 chars - not
// CODEX_RIGHT_CHARS, which padLeftTo() only ever pads UP to and never
// truncates past) = 108px, so it spans 106..214 and drawIfChanged clears from
// 105; the label starts at CARD_X + PAD = 26; so (105 - 26) / 6 = 13.17 -> 13
// characters. EVERY ONE of those numbers changes on a wider card - do not
// copy 13 forward.
//
// THIS WAS 11, derived from CODEX_RIGHT_CHARS (20) rather than from the right
// field's real content - which, with a wall-clock suffix renderCodexRow() no
// longer prints, ran to ~24 characters and was never truncated (padLeftTo()
// refuses an over-long string instead). At the real worst case the right
// field's clear box - which draws AFTER the label on every tick - reached
// further left than 11 assumed and ate the label's own tail. Dropping the
// wall clock took the real worst case to 18, safely under CODEX_RIGHT_CHARS
// now that it is ALSO 18, so the pad width is a genuine ceiling again.
const int CODEX_LANE_CHARS  = 13;
// The right field's pad WIDTH - padLeftTo() pads any shorter string UP to
// this many characters, so this constant IS the field's assumed worst case,
// not merely a cap that content happens to respect. It must never exceed the
// field's true longest formatted output ("100%  23h 59m left", 18 chars) or
// CODEX_LANE_CHARS above is derived from a case padLeftTo() can no longer
// guarantee - usage-geom-check.mjs asserts CODEX_RIGHT_CHARS <= that worst
// case directly, so raising this back past 18 fails by name.
const int CODEX_RIGHT_CHARS = 18;
// The buffer AND the change-only cache that hold a CODEX_LANE_CHARS-wide
// padded string. Sized to the RIGHT field's worst case, not the label's -
// CODEX_LANE_CACHE is shared by both drawIfChanged() calls in
// renderCodexRow(). The right field's content ("100%  23h 59m left", 18
// chars now that the wall clock is gone) is still the longer of the two, and
// is what this size must hold (19 of these 24 bytes) - the label's 13 chars
// needs nowhere near it. This is the size cxPctCache/cxRightCache have
// always been declared and compared at - see the note on them in
// deckhand_display.ino, which is emphatic that the declaration and the
// cacheSize passed at the call site must be the SAME number.
const int CODEX_LANE_CACHE = 24;

// Footer battery pill. The clock and the freshness field are edge-pinned and
// need no constant; this group is centred, so a wider panel moves it. 21px
// glyph + 4px gap + a 4-character reading, at 88..137 on a 240px panel.
const int FOOTER_BATT_X      = 88;
const int FOOTER_BATT_TEXT_X = 113;

// TOUCH - the panel is resistive and fingertips are ~9mm. 320px of height can't
// give every control 9mm, so this is the floor everything tappable must clear,
// and the vertical budget is spent to get as close to it as each page allows.
const int TAP_MIN = 40;   // 7.1mm

// Replaces both the BOOT-key trigger (GPIO0 doubles as the bootloader strap, so
// the USB adapter's DTR line fired it by itself) and the fixed tab-bar button
// (which cost the three tabs 42px).
//
// IT LIVES IN THE TAB BAR, in a reserved slot at the right end, so it is chrome
// rather than something floating over content. That costs the three tabs width
// (80px each -> 66) but buys back everything a floating button was fighting:
// it can no longer cover a card, a status pill, or the settings pager's "next"
// key, and it no longer has to appear and disappear per screen to stay safe.
//
// It used to float and be draggable - hold 700ms, drag, release to persist the
// position to NVS - which on a resistive panel needed a 70px spike reject, a 2px
// deadband, and a CLEARED content area to drag over (with no framebuffer to read
// back, there is no way to restore what was under a moving object). All of that
// went with the gesture.
//
// The slot is 40px wide against a 34px-tall bar, so the ring is 26px rather than
// the old 48. Its tap target is the full slot. That is under TAP_MIN (40) in
// height - unavoidable, and no worse than the three tabs beside it, which have
// always been 34 tall.
const int TAB_REC_W = 40;                       // slot reserved at the right end

// ---------- Sessions tab ----------
// EVERY NUMBER IN THIS SECTION IS THE LITERAL THAT WAS ALREADY HERE (or already
// at its call site in sessions.ino) - the section grew names, not values, so this
// board's binary is unchanged. SESSION_AIR below is the one new knob, and it is 0
// here precisely so every derived offset in deckhand_display.ino collapses back
// to the number sessions.ino used to hardcode.
const int SESSION_ROW_Y0 = CONTENT_Y + 4;
// Smallest row that can carry name + title + model/branch + pill without them touching.
// 85 is not a preference, it is the arithmetic: the sub-line ends at y+60 and the pill
// top sits at y+rowH-22, so anything under 85 would draw the pill over the text.
// As a PACKED BAND TABLE, which is the form board 2 re-derives from:
//   +0..+1 border | +2..+3 pad | +4..+29 name (T_HERO, 26) | +30..+31 gap
//   | +32..+44 title (13) | +45..+46 gap | +47..+59 sub-line (13) | +60..+62 gap
//   | +63..+80 pill (18) | +81..+82 pad | +83..+84 border  = 85
const int SESSION_TITLE_MIN_H = 85;
// The tall-row layout WITHOUT a title: name, model/branch sub-line, pill. 70 is
// the height at which the pill's top row lands exactly ON the sub-line's last ink
// row (sub at y+34..y+46, pill top at y+rowH-24), i.e. the boundary case this
// gate admits. Below it the sub-line is suppressed and the row shows name + tag
// + pill only.
const int SESSION_SUB_MIN_H = 70;
// Above this a row uses the TALL layout (big name, pill along the bottom); below
// it the COMPACT one (small name, sub-line, pill top-right). 56 is name (26) +
// pill (18) + the two 2px borders + the two 4px pads a title-less tall row uses,
// i.e. the least height in which that layout's two elements do not collide.
// Consequence, kept deliberately: 56..69 is a band where a tall row has room for
// its big name but not for its sub-line, so those rows trade model/branch for a
// 26px name. Board 1's ladder puts four sessions (63) in that band.
const int SESSION_LARGE_MIN_H = 56;
// The ladder's floor and ceiling (constrain() in renderSessionsList).
//
// 38 IS TWO PIXELS TOO SMALL, and it is reachable. The floor's job is to be the
// least height the COMPACT layout can legally draw, and that layout's sub-line
// inks SESSION_SUBC_Y..+12 (+25..+37) against a 2px border owning rowH-2..rowH-1,
// so a legal row needs rowH >= SESSION_SUBC_Y + 15 = 40. At 38 the sub-line's last
// two rows are drawn over the row's own outline. It is reached whenever the list
// truncates: seven or more sessions add the 16px "+N more" strip, leaving
// avail 248, and (248 - 5*3) / 6 = 38 exactly - so nothing clamps it and nothing
// on screen names the cause. NOT FIXED HERE, because this board's binary is held
// byte-identical across the two-board port and a board-1 rendering change must not
// ride inside a board-2 diff; sessions-geom-check.mjs carries it as a known entry
// with this arithmetic, and board 2 derives its floor (43) instead of inheriting
// this number.
//
// 90 is SESSION_TITLE_MIN_H (85) plus 5 of slack, which the layout spends between
// the sub-line and the bottom-anchored pill.
const int SESSION_ROW_H_MIN = 38;
const int SESSION_ROW_H_MAX = 90;
const int SESSION_ROW_GAP = 3;
const int SESSION_ROW_X = 8;
// Centre of a row's status indicator. ONE definition because two paths draw it -
// drawSessionRow() on a repaint and tickWorkingSpinner() every 120ms - and when
// they disagreed the animation kept redrawing at the old x, undoing the fix and
// painting over the card's rounded corner four times a second.
// +23 is a constraint, not taste: the spinner is a 32x32 BLIT that paints its own
// background, so its rect (x 15..46 here) has to clear both the corner curve and
// the 2px border that follows it, and still leave the name lane at x=48 alone.
const int SESSION_DOT_CX = SESSION_ROW_X + 23;
const int SESSION_ROW_W = 224;
// The text lane's left edge, as an offset from the row. 40 is set by the ART, not
// by the panel: the spinner blit is 32x32 centred on SESSION_DOT_CX, so it owns
// x SESSION_ROW_X+7..+38 and the name starts 2px clear of it. Same 32x32 frames
// on both boards, so this number does not move.
const int SESSION_NAME_DX = 40;
// The sub-line's measured lane. This board shipped it as the literal 184 - 12px
// WIDER than the row's own text lane (SESSION_ROW_X + SESSION_ROW_W - 12 - nameX
// = 172, the same expression the title on this card is bounded by two lines
// above its own call site in sessions.ino) - which let two columns of sub-line
// text land ON the card's 2px border (BORDER_CARD), visible on the real panel as
// the model/branch line running into the ring. DERIVED here instead, so the two
// boards can never drift apart again: this comes out to 172 on this board, a 12px
// narrower lane than before, and 244 on board 2 - unchanged there, since board 2
// was already exactly this expression.
const int SESSION_SUB_LANE_W = SESSION_ROW_W - SESSION_NAME_DX - 12;
// The "+N more" strip's reserved band at the bottom of the list. Derived from the
// TEXT, not the panel: one Cozette 6x13 line plus 3px, so it does not move with
// the screen.
const int SESSION_OVERFLOW_H = 16;
// The row signature's buffer. WAS 176 - the literal that was in
// deckhand_display.ino's rowSigCache declaration - and is now 304, because this
// board draws the band card too and its expanded first row appends the LAST PROMPT
// and the PATH to that row's signature. A field drawn but not signed is exactly the
// staleness the title itself shipped once. The worst case: name 23 + status 9 +
// sub 35 + title 43 + tag 6 + icon 3 + 5 separators + NUL = 125 for an ordinary
// row, plus prompt 103 + path 67 + 2 separators = 297 for the expanded one.
// It costs MAX_SESSIONS copies of RAM - 6 x 128 = 768 bytes - and that is the
// price of the card; appending them for every row instead would repaint a COMPACT
// row whenever its prompt changed, which is a wholesale clear-and-redraw of pixels
// that did not change.
const int SESSION_ROW_SIG_LEN = 304;
// Vertical air added at every gap and pad inside a row (see the derived offsets
// in deckhand_display.ino). 0 here: this board's content area cannot afford any -
// its own band table above is packed with 2px gaps and 2px pads.
const int SESSION_AIR = 0;
// THE TWO INK HEIGHTS THE ROW STACK IS BUILT FROM, named rather than left as the
// literals 26 and 13 inside deckhand_display.ino's derived offsets. Both are the
// numbers that were already there, so this board's binary does not move - but a
// row's ink height is no longer identical on the two panels (board 2 draws a
// native Spleen scale, 16px body against this board's 13), and a literal 13 in a
// shared expression would have silently laid board 2's rows out at board 1's
// text size. Every SESSION_* threshold in this section is arithmetic on these two
// numbers plus the 18px pill; sessions-geom-check.mjs re-derives each one from
// them and from the real UI_FONTS[] cell heights, so a font change fails there
// rather than on the glass.
const int SESSION_NAME_H = 26;   // the name band: uiLineH(T_HERO), Cozette 12x26
const int SESSION_LINE_H = 13;   // one body/meta line: uiLineH(T_BODY), Cozette 6x13
// Where drawSessionRow's name ladder STARTS, as an index into its NAME_RUNGS[]
// { T_HERO, T_HEAD, T_BODY }. 0 here: T_HERO's 26px cell is exactly this board's
// name band, so the tallest rung is admissible and the ladder is the full three
// steps it has always been. It is an index rather than a runtime height test
// because a test costs flash on a board whose binary is frozen, and because the
// invariant it encodes - the top rung's cell must FIT the band - is asserted in
// sessions-geom-check.mjs against the parsed font table, where it costs nothing.
const int SESSION_NAME_TOP_RUNG = 0;

// ---------- §3 THE STATUS BAND ----------
// The band card, ported from board 2 (docs/superpowers/specs/
// 2026-08-28-sessions-redesign-board2-design.md §3-§5). It exists here for the
// same measured reason it exists there: with ONE session - 69% of ticks - the
// ladder draws a 90px row and then 174px of nothing, 66% of this board's list
// area. Every constant below is DERIVED FROM THIS BOARD'S OWN CELLS, never scaled
// off board 2's: the type scale is Cozette 6x13 / Terminus 10x18b / Cozette 12x26
// against board 2's Spleen 8x16 / 12x24 / 32x64, and the list area is 264px
// against 410.
//
// 34 = SPARK_SIZE (32) + BORDER_CARD, AND THAT IS THE BINDING CONSTRAINT rather
// than the rung argument board 2 uses. Board 2's 44 is TAB_BAR_H (46) less the
// card's own 2px border - "sized to the same rung so it does not read as a thin
// stripe against the tab bar" - which here would give 34 - 2 = 32. But the agent
// mark is a 32x32 BLIT and the SAME art on both boards (SPARK_SIZE does not
// scale), and the band is drawn on the card INTERIOR, so the interior must be at
// least 32 rows: SESSION_BAND_H - BORDER_CARD >= SPARK_SIZE, i.e. 34. The two
// derivations land 2px apart and the mark's is the one that must hold, so the
// mark sits FLUSH in the band's 32-row interior with no clearance either side.
// Stated rather than left as a coincidence: a regenerated mark at any size above
// 32 moves this constant, and sessions-geom-check.mjs parses SPARK_SIZE for it.
const int SESSION_BAND_H = 34;
// THE SIDE PAD IS THE ROW'S OWN TEXT MARGIN, MOVED ONTO THE INTERIOR. Every
// ordinary row on this board bounds its text at SESSION_ROW_X + SESSION_ROW_W - 12
// (the title's lane, and the expression SESSION_SUB_LANE_W is derived from), i.e.
// 12px in from the card's OUTER edge. The band is drawn on the interior, which is
// already BORDER_CARD in, so the same margin is 12 - BORDER_CARD = 10 here. Board
// 2's 14 is its own number; copying it would have spent 8px of a 224px card on
// air the rows beside it do not spend.
const int SESSION_BAND_PAD = 10;
// Agent mark -> status word. 8 rather than the bare 4 every icon-beside-text site
// uses, for board 2's reason: this gap divides the AGENT from the STATUS, two
// different facts, where the 4 binds an icon to the name it belongs to.
const int SESSION_BAND_MARK_GAP = 8;
// THE BODY'S OWN LEFT EDGE AND LANE, derived from the band's box rather than
// restated - "band and body share the pad", made true. The band card draws no row
// indicator (its mark is up in the band), so the ordinary row's SESSION_NAME_DX
// (40px of clearance for the 32x32 indicator blit) would reserve space for nothing
// and hang every body line 28px right of the band above it.
//   x    = 8 + 2 + 10 = 20, against the ordinary row's name origin at 48
//   lane = 224 - 4 - 20 = 200 = 33 characters at TEXT_ADV 6
// 33 columns is the SAME lane width board 2's 264px/8px card gives, which is why
// the two boards' line caps below come out identical from independent arithmetic.
const int SESSION_BAND_BODY_X = SESSION_ROW_X + BORDER_CARD + SESSION_BAND_PAD;
const int SESSION_BAND_BODY_LANE = SESSION_ROW_W - 2 * BORDER_CARD - 2 * SESSION_BAND_PAD;
// THE DURATION'S LANE IS FIXED AT 3 CHARACTERS, for board 2's reason and with the
// same bound: it is a change-only field, so its clear box must be a CONSTANT width
// or it grows into the status word beside it. bandDurText() drops to one unit
// (s / m / h / d) and statusSinceMillis is a millis() value, which wraps at 49.7
// days - so "49d" is the widest string reachable and 3 is a bound, not a hope.
const int SESSION_BAND_DUR_CHARS = 3;
//
// THE BAND'S CONTENTS FIT ACROSS - AND THE FULL STATUS PHRASE DOES NOT. This is
// the same arithmetic §7 records failing on board 2's detail screen, arriving here
// on the LIST's card because this panel is 72px narrower and its head face 2px
// narrower per character:
//   room = SESSION_ROW_W - 2*BORDER_CARD - 2*PAD - SPARK_SIZE - MARK_GAP
//          - DUR_CHARS*TEXT_ADV - 1                                      = 141
// labelForStatus()'s longest phrase, "NEEDS YOUR INPUT", inks 16 x T_HEAD's 10px
// advance = 160. It is over by 19 and NO pad this card can afford closes it:
// clearing 160 needs 2*PAD + MARK_GAP <= 9. So the band cannot carry both the
// 32px mark and the full phrase, and the mark is what stays - it is the card's
// only agent carrier and its only motion (the row indicator is skipped there).
// bandStatusWord() therefore shows THE LONGEST FORM ITS LANE CAN HOLD, measured:
// the full phrase where it fits (board 2, always) and shortLabelForStatus()'s
// "WORKING" / "NEEDS INPUT" / "READY" - the words this board's own tall-row pill
// already draws - where it does not. Longest short form: 11 x 10 = 110 of 141.
// One mechanism, two boards, no second vocabulary invented for this card.

// ---------- §4 THE SPINE ----------
// The band's compact form for every row the band card is not: a status-coloured
// bar down the row's left edge. Same vocabulary, scales to any row height.
//
// 5, NOT BOARD 2'S 6, AND THE BLIT IS WHY. The spine is drawn on the card's
// interior at x = SESSION_ROW_X + BORDER_CARD = 10 and the 32x32 row-indicator
// blit paints its own background from x = SESSION_DOT_CX - SPARK_SIZE/2 = 15, so
// the spine's ink must end at 14: SESSION_SPINE_W <= 15 - 10 = 5. At 6 its last
// column would be erased four times a second on every working row - the exact
// defect board 2 measured at 17 pixels and fixed with the straight carve.
const int SESSION_SPINE_W = 5;
// CLAUDE SOLID, CODEX SEGMENTED, as a fill pattern rather than art. Neither
// number is a taste call and both are board 2's own derivations re-run on a 5px
// spine: ON is one more than the spine is wide, so a run reads as a SEGMENT
// rather than a square dot; OFF is 2/3 of the width (ceil(2*5/3) = 4), so a gap
// reads as a gap rather than as a seam.
//
// THE PERIOD IS 10 AND THE TWO SHORTEST RUNGS HOLD ONE GAP, NOT TWO. The knockout
// is cut from the STRAIGHT section only (an arc knockout paints outside the card),
// so a second gap needs r + ON + P + OFF <= h - r, i.e. 2P <= straight, where
// straight = rowH - 2*BORDER_CARD - 2*SESSION_SPINE_INSET - 2*(R_MD - BORDER_CARD)
// = rowH - 22. So two gaps need rowH >= 42, and this board's ladder produces 41
// (five sessions) and 38 (six, under the "+N more" strip). Unreachable in
// practice - 5 and 6 sessions are 0 of 9,452 measured ticks - and unfixable
// anyway: ON >= 6 and OFF >= 4 by the two bounds above, so P >= 10 while a 38px
// row allows 6. sessions-geom-check.mjs asserts two gaps on every rung reachable
// at FOUR OR FEWER sessions and one everywhere else, by enumeration.
const int SESSION_SPINE_ON = 6;
const int SESSION_SPINE_OFF = 4;
// ONE PIXEL DOWN AND UP, NEVER SIDEWAYS. Board 2's note carries the measurement;
// both halves apply here unchanged and the second one harder. The carving rect's
// left edge lands at x = 15, and at the interior's top row (+2) the border's own
// inner edge is still at x = 18 - so without the inset the rect would rub out the
// card's anti-aliased corner. With it (+3) the inner edge is 14.1 and the carve
// clears it. And an x inset would put the spine's LAST column at 15, which is the
// blit's FIRST - the very defect SESSION_SPINE_W = 5 exists to avoid, reintroduced
// by its own fix. Both are asserted from the DRAW's own x expression.
const int SESSION_SPINE_INSET = 1;
// NO SHIMMER ON THIS BOARD, deliberately and by name: SESSION_SHIMMER_* do not
// exist here. Board 2 composes into a PSRAM shadow framebuffer and flushes once,
// so a travelling light rides a flush that was happening anyway; this board draws
// STRAIGHT TO THE GLASS, where the same animation is a per-frame repaint with no
// flush to hide behind and no PERF command to measure it with. The spine here is
// STATIC. Written down rather than left to be discovered.

// ---------- The band card's block stack ----------
// SESSION_EXP_MAX_H is the SUM of these, not a chosen number, and
// sessions-geom-check.mjs asserts that sum against the parsed blocks on BOTH
// boards - so a future field cannot silently push a line past what its data can
// fill.
//
// HOW THE LEADINGS WERE DERIVED, because they are the one place this card could
// have been fitted by eye. Each block is one line of INK plus its own leading.
// The ink is fixed by this board's faces (name 26, every body line 13, a rule 1)
// and comes to 145px for the full stack; the band takes 34 of the 264px list
// area, leaving 230, i.e. 85px of leading to distribute against board 2's 122.
// Each block therefore gets board 2's own leading scaled by 85/122 = 0.697 and
// floored - which spends 77 of the 85 and leaves 8px outside the card as list
// area, exactly as §4 requires. The reason this board is TIGHTER than a
// proportional scale of board 2's card is that its name is not scaled: the hero
// rung's 26px cell stays (the user is already looking at a 26px "deckhand" and it
// should not shrink), which is 2px MORE than board 2's head-rung name on a panel
// with 64% of the height.
//
//   block          ink   b2 lead   x0.697   this board
//   name            26      10        6      32
//   sub-line        13      16       11      24
//   title (each)    13       4        2      15
//   rule             1      17       11      12
//   LAST PROMPT     13      12        8      21
//   prompt (each)   13       8        5      18
//   path            13       4        2      15
//   bottom pad       -       6        4       4
const int SESSION_BAND_NAME_H = 32;      // T_HERO 26 + 6 leading
const int SESSION_BAND_SUB_H = 24;       // T_BODY 13 + 11, the agent/model/branch line
// The Mac's icon rides the sub-line, right-anchored, and this is the 4px every
// icon-beside-text site on this device already uses. A named constant rather than
// the literal its neighbours carry because the checker asserts the LANE
// arithmetic against it: the facts are fitText'd into `lane - MAC_EMOJI_SIZE -
// SESSION_SUB_ICON_GAP`, measuring the icon FIRST, so no model or branch name can
// collide with it however long it is.
const int SESSION_SUB_ICON_GAP = 4;
const int SESSION_BAND_TITLE_STEP = 15;  // T_BODY 13 + 2
const int SESSION_BAND_RULE_H = 12;      // 1px rule + air either side
const int SESSION_BAND_LABEL_H = 21;     // the "LAST PROMPT" caption
const int SESSION_BAND_PROMPT_STEP = 18; // T_BODY 13 + 5; the prompt gets the most air
const int SESSION_BAND_PATH_H = 15;
const int SESSION_BAND_BOTTOM_PAD = 4;   // 2 of which is the card's own border
//
// TWO HARD CAPS ON THE LINE COUNTS, both re-derived for this board's lane and
// advance rather than carried over, and both asserted. The lane is
// (224 - 2*2 - 2*10) / 6 = 33 columns - the SAME column count board 2's wider
// card and wider face give - so:
//   prompt[104] holds 100 characters: 3 x 33 = 99 is ONE SHORT, so 4 lines are
//     needed and a 5th is permanently blank.
//   title[44] holds 43: 1 x 33 = 33 is short, so 2 lines are needed and a 3rd is
//     permanently blank.
// SESSION_EXP_PROMPT_MAX and SESSION_EXP_TITLE_LINES are those counts and must
// not be raised without new byte caps to justify them.
//
//   band 34 + name 32 + sub 24 + title 2x15 + rule 12
//        + LAST PROMPT 21 + prompt 4x18 + rule 12 + path 15 + pad 4 = 256

// ---------- THE EXPANDED FIRST ROW ----------
// THE RULE, arithmetic on the ladder rather than a second layout - identical to
// board 2's, reading this board's own numbers:
//   leftover = avail - (count - 1) * (sessionRowH + SESSION_ROW_GAP)
//   grant    = leftover < SESSION_EXP_MIN_H ? 0 : min(leftover, SESSION_EXP_MAX_H)
//   expanded = min(grant, the block stack this session's own content fills)
//
// THE SIX GRANTS, avail 264. These are CEILINGS, not heights: what the card takes
// is the block stack its own session fills and the rest stays outside it as list
// area.
//   1 session  leftover 264 -> 256 (cap)   prompt <= 4 lines   8px spare at the cap
//   2 sessions leftover 171 ->   0         under the floor
//   3 sessions leftover  86 ->   0
//   4 sessions leftover  66 ->   0
//   5 sessions leftover  52 ->   0
//   6 sessions leftover  44 ->   0
// So THE BAND CARD IS A ONE-SESSION BEHAVIOUR ON THIS BOARD, where board 2's is
// one-to-two. That is not a tuning choice that could have gone the other way: at
// two sessions the ladder gives each row its 90px cap and 171px is left, against a
// floor of 220 - a card admitted there would have 137px for a 186px body, i.e. no
// leading and no rules, which is the "card of air" §4 forbids. One session is 69%
// of 9,452 measured ticks and it is the case that looked worst.
//
// SESSION_EXP_MIN_H IS THE SAME BLOCK STACK AS THE CAP WITH THE PROMPT AT ITS
// MINIMUM, which is what makes the two ends of the range ONE derivation:
//   MIN = band 34 + name 32 + sub 24 + title 2x15 + rule 12 + LAST PROMPT 21
//         + prompt 2x18 + rule 12 + path 15 + pad 4                      = 220
//   MAX = MIN + (PROMPT_MAX - PROMPT_MIN) * SESSION_BAND_PROMPT_STEP     = 256
// The checker re-derives both from the PARSED blocks and separately asserts that
// ONE PIXEL SHORTER overdraws the bottom-anchored path group - so this is the
// floor, not a bound chosen with room to spare.
const int SESSION_EXP_MIN_H = 220;
const int SESSION_EXP_MAX_H = 256;
const int SESSION_EXP_TITLE_LINES = 2;
const int SESSION_EXP_PROMPT_MIN = 2;
const int SESSION_EXP_PROMPT_MAX = 4;

// ---------- Session detail card and the ask screen ----------
// The header row's TOUCH band ("< Back" on the left; TYPE or READ ALL on the
// right), used by both handleAskTouch's `sy < CONTENT_Y + DETAIL_HEAD_H` gates.
// 28 against a card starting at CONTENT_Y+26, i.e. the band's last 2 rows overlap
// the card's border - harmless (the border is not tappable content) and left
// alone here: unlike SESSION_SUB_LANE_W this one does not put ink on the border,
// it only shares touch rows with it, so it stays the byte-identical literal.
const int DETAIL_HEAD_H = 28;
const int DETAIL_BACK_Y = 4;      // "< Back" baseline inside that row
const int DETAIL_CARD_DY = 26;    // card top = CONTENT_Y + this
// 210, AND IT CAME DOWN FROM 224 WHILE GAINING A BAND - because 224 was 13px OVER
// the ceiling this card's own footer sets, and had been since it was written.
//
// THE DEFECT THAT WAS ON THE ALLOWLIST TWICE. The detail screen draws two MC_DATUM
// T_META strings: "answer this one on your Mac" at cardY + DETAIL_CARD_H + 8, and
// the "tap here for history" hint at contentBottom() - 10. At H = 224 those are the
// SAME y (60 + 224 + 8 = 292 = 302 - 10), drawString paints an OPAQUE box, and the
// hint is drawn second - so on this board the warning was INVISIBLE. The device
// showed an ask it could not answer and silently swallowed the sentence saying why.
// sessions-geom-check.mjs carried it as two KNOWN[1] entries (the two strings
// colliding, and the constant over its ceiling); both are gone now, and the comment
// left in their place says what they were.
//
// THE CEILING IS 211, DERIVED NOT CHOSEN. drawString centres MC_DATUM on the ASCENT
// (10 for Cozette) and paints a box ascent+descent (13) tall, so a string at y inks
// y-5 .. y+7. The hint at 292 owns 287..299; the answer line at 60 + H + 8 owns
// H + 63 .. H + 75, and the two collide when H + 75 >= 287, i.e. AT 212. The checker
// derives that number from the hint's own y and PRINTS it.
//
// AND THE STACK BELOW IT FITS WITH ROOM SPARE, because §7 spends less card than the
// layout it replaces. The running cursor in drawSessionDetail(), every step DERIVED:
//   +0   BAND 34 (SESSION_BAND_H) - mark, status WORD, duration. NO top pad: the
//        band REPLACES DETAIL_PAD_Y, which neither board draws any more.
//   +34  name 26 ink +34..+59  | step 31
//   +65  title 13 ink +65..+77 | step 20
//   (NO PILL. It was 18px of ink and 23 of step; the band 34px above says the same
//    word at T_HEAD, and the "for 12m - 14:31" line beside it went with it.)
//   +85  rule | step 12
//   +97  LAST PROMPT label 13 | step 13
//   +110 prompt 2 lines (11 step, last inks +121..+133) | step 29
//   +139 rule | step 12
//   +151 PATH label 13 | step 13
//   +164 path 2 lines (last inks +175..+187) | step 29
//   +193 THE META LINE, inking +193..+205 - `model - branch` on the left, the Mac's
//        icon and (with a second Mac up) its tag right-anchored. One line where the
//        two column pairs were four.
// so the content ends at +205 and TWO clear rows sit above the 2px border at
// +208..+209 - board 2's own figure, and 1px still under the 211 ceiling.
const int DETAIL_CARD_H = 210;
// TYPE, in the header row. 76x22 drawn; the hit zone is the whole right end of
// the row (100x28), the same trade the tab bar's slots make.
const int MSG_BTN_W = 76, MSG_BTN_H = 22;
// Wrapped-text line caps on the detail card. BOTH TRUNCATE ON THIS BOARD, and
// that is the constraint rather than a choice: prompt[104] holds up to 100
// characters against a 188px lane = 31 characters a line, so showing all of it
// needs 4 lines; path[68] holds 64 against the same lane and needs 3. The card
// has room for neither, so 2 each is what fits. Board 2's wider lane and taller
// card is what finally makes these caps big enough to show the whole field.
const int DETAIL_PROMPT_LINES = 2;
const int DETAIL_PATH_LINES = 2;
// 5, AND IT IS THE SCALED LEADING BUDGET RATHER THAN A CHOSEN NUMBER - the same
// method 5d1acf1 used for this board's band-card block stack (board 2's leadings
// scaled by the leading each board can actually afford after its own ink).
//
// THE INK IS FIXED BY THIS BOARD'S FACES and comes to 162px for the worst-case
// stack: band 34 (its own 2px card border included) + name 26 + title 13 + rule 1
// + label 13 + prompt 24 + rule 1 + label 13 + path 24 + meta 13. The card's
// ceiling is 211 (see DETAIL_CARD_H), and 2 of what is left is the bottom border -
// so 47px is the whole leading budget, against board 2's 66.
//
// EVERY BOUNDARY THIS WIDENS IS ONE TERM IN 6*AIR + 14, and that is the identity
// that picks the number: DETAIL_NAME_STEP, DETAIL_TITLE_STEP, both
// DETAIL_RULE_STEPs and both detailTextStep() tails carry one AIR each, and the
// fixed 14 is their own non-air leading. (Board 2's identity is 6*AIR + 18 rather
// than +14, because its DETAIL_TEXT_LINE_H equals its cell and this board's 11 is
// 2 under its 13 - so 2 of each wrapped tail's "+2" is spent recovering the last
// line's own ink here.) 6*5 + 14 = 44 of the 47 available; AIR 6 would need 50 and
// put the card 3px past its ceiling. The 3px left over is the two clear rows above
// the border plus 1 under the ceiling.
//
// It was 0, with a note saying "this card already runs to 8px of slack" - which was
// true of a card that was 13px over its footer's ceiling. §7 returned the room: the
// two label+value column pairs (four labels, four values, 71px) became one line.
const int DETAIL_AIR = 5;
// THE DETAIL CARD'S INK HEIGHTS, which its whole running cursor is now built from.
// 26 is uiLineH(T_HERO) and 13 is uiLineH(T_BODY) - which on this board is also
// uiLineH(T_META), Cozette having exactly one size and its double. Every step in
// drawSessionDetail (the top pad, the name, the title, the pill, the rules, the
// labels and the two column rows) is derived from these plus DETAIL_AIR instead of
// being written as a literal, and EVERY DERIVED STEP EQUALS THE LITERAL IT
// REPLACES HERE - which is why this board's binary does not move. Board 2's faces
// are 24 and 16, and a literal 13 left in that cursor is what drew its 16px lines
// on 13px spacing.
const int DETAIL_NAME_H = 26;
const int DETAIL_LINE_H = 13;
// The WRAPPED-text line step (LAST PROMPT and PATH), and the one number here that
// is not a cell height: 11, this board's own long-shipping value. It is 2 under
// Cozette's 13px cell and one OVER its 10px ascent, so the next line's opaque box
// clips only the previous line's descender rows - which is why it has always
// looked right here. Its own constant rather than DETAIL_LINE_H - 2, because
// board 2's ascent is 12 and the relationship is to the ascent, not to the cell.
const int DETAIL_TEXT_LINE_H = 11;
// Which rung the project name is drawn at: 4 = T_HERO (Cozette 12x26), whose cell
// IS DETAIL_NAME_H. A number rather than the name because the T_* ids are declared
// after this header is included; sessions-geom-check.mjs asserts it against the
// font registry (uiLineH(DETAIL_NAME_FONT) == DETAIL_NAME_H) rather than trusting
// the pair to stay in step.
const int DETAIL_NAME_FONT = 4;
// The gap between the meta line's text and the Mac cluster right-anchored at the
// card's text edge. 8, THE SAME NUMBER BOARD 2 USES, and for the same reason
// rather than by transcription: it is twice the bare 4 that binds an icon to the
// text beside it (SESSION_SUB_ICON_GAP here, the same literal in the SETTINGS row
// and in the cluster below), because this gap divides two DIFFERENT things - a
// sentence of facts from an identity - where the 4 binds one thing to its own
// label. The 4 is not scaled between the boards, so this is not either.
//
// It costs this board more than it costs board 2 - 8px is 1.3 characters at
// TEXT_ADV 6 against exactly 1 at 8 - and that cost is counted in the meta line's
// own measurement in drawSessionDetail(), which is what decides that this board
// carries two facts where board 2 carries three. It is what fitText clips the left
// half against, so it can never be merely decorative. (Two facts BESIDE A SECOND
// MAC'S TAG, which is the binding case; with one Mac the tag is empty, the lane is
// 46px wider and all three fit. The fall-back is measured per render, not a flag.)
const int DETAIL_META_GAP = 8;

// 32 tall, under this board's own TAP_MIN of 40, and 4 of gap between two buttons
// that may be Allow and Deny - both are the most the content area can give rather
// than a judgement about how big a decision button should be: at 46 + 8 (what
// board 2 uses) the worst-case stack of 4 options plus the SPEAK/TYPE row would be
// 270 of this board's 268px content area. The proportion is what carries across -
// 5 * 36 = 180 of 268 is 67%, and board 2 spends the identical 65% on 5 * 54.
const int ASK_OPT_H = 32;
const int ASK_OPT_GAP = 4;
// READ ALL sits in the header row, top-right: maximum distance from the
// decision buttons at the bottom, so reading can't be fat-fingered into an
// Allow/Deny.
const int ASK_READ_BTN_X = 150;
const int ASK_READ_BTN_W = 78;
const int ASK_READ_BTN_H = 24;
// THE CHIP'S LABEL IS PER BOARD because the two boards' chips offer different
// things. This board draws no option descriptions (ASK_OPT_DESC_BYTES is a
// 1-byte placeholder here), so the chip means exactly what it always meant:
// the whole of a detail that did not fit. A MACRO rather than a `const char*`
// so it costs this board nothing at all - the same shape WAKE_HINT uses in
// power.ino, and this board's binary is held byte-identical.
#define ASK_READ_BTN_LABEL "READ ALL"
// The ask screen's own header stack, below "< Back": the kind badge (with the
// session name right-aligned on the same row) and then the question title.
const int ASK_BADGE_Y = 27;
const int ASK_TITLE_Y = 39;
// THE PER-OPTION DESCRIPTION BUFFER - A PLACEHOLDER ON THIS BOARD, which does not
// draw option descriptions at all. 1 is the smallest legal size (a zero-length
// array is not legal C++), so every slot can only ever hold "", and anything that
// would show one falls back to "no description".
// It has to exist at all because SessionInfo is SHARED: the member is compiled into
// this board whether or not a single pixel of it is ever drawn. What is NOT shared
// is the cost - sizing it to the host's real 96-byte cap would spend
// 4 x 97 x MAX_SESSIONS = 2,328 bytes of DRAM here for text this panel can never
// render, on the board whose free heap (~26KB after the BLE stack) is the binding
// constraint on the audio path. At 1 it costs 4 x 1 x 6 = 24.
// A CONSTANT rather than an #if at the declaration, and that is not style: with the
// size behind an #if, cacheSizes()/consts() parse ONE arm and report it for BOTH
// boards, so this board would carry board 2's number as a false reading. That is
// exactly what BATT_LEFT_BYTES was fixed for.
const int ASK_OPT_DESC_BYTES = 1;

const int PAGER_BTN_W  = 52;   // prev/next key width
const int PAGER_BTN_X0 = 6;    // inset from each edge
const int PAGER_H = 42;                       // pager band under the tab bar. Sized for
                                              // TOUCH, not for the text: at 26 the prev/next
                                              // targets were only ~5mm tall, well under the
                                              // ~9mm fingertip guideline, and were the most
                                              // missed control on the device.
// PAGE_TOP moved here alongside PAGER_H rather than staying in the main file:
// DEV_CARD_Y (below) is defined from it, and both need to be visible at the
// point board.h is included, before PAGE_TOP's original declaration point.
const int PAGE_TOP = CONTENT_Y + PAGER_H + 4; // top of each page's content

// Page 0 - DEVICE card
const int DEV_CARD_Y = PAGE_TOP + 4;
// 160, not 120: +40 makes room for up to MAX_LINKS per-Mac rows below ID (see
// DROW_MAC0/DROW_MAC1) at the same 20px gap ID already uses below BATT, plus
// the same ~7px clearance ID itself leaves above the card's own border.
const int DEV_CARD_H = 160;
const int DROW_BT = 24, DROW_USB = 52, DROW_BATT = 80, DROW_ID = 100;
// Per-Mac link rows (see renderMacLinkRows() in settings.ino). Two fixed row
// SLOTS, not one per hostLinks[] index - the renderer compacts to however
// many links are actually used, so a single remaining Mac always draws in
// the first slot rather than leaving a gap where the other one used to be.
const int DROW_MAC0 = 120, DROW_MAC1 = 140;
// The battery READING's vertical offset from the "Battery" label beside it, and
// board 1's value is the one that already shipped: 4. Named here only so board 2
// can differ - at a 13px line the stagger is invisible, at 16px it reads as two
// halves of one row failing to line up. Substituting the literal it replaces,
// so this binary cannot move.
const int DROW_BATT_VAL_DY = 4;
// The battery row's change-only cache, in BYTES. Board 1's widest string is the
// discharge case, "100% 4.20V ~99h" - 15 chars + NUL. It is a named per-board
// constant rather than a literal at the declaration because board 2's row can draw
// a LONGER string (its charging label), and a cache shorter than its string
// silently stops noticing changes past that point. One name that the declaration
// and settings-geom-check.mjs both read, so the two cannot drift.
const int BATT_ROW_CACHE = 20;
// The battery row's TRAILING LABEL buffer, in bytes. Board 1 only ever draws the
// discharge estimate, whose widest is "~119m" (5 + NUL). Named per board because
// board 2 also draws a charging label that does not fit in 8 - and because leaving
// this as a shared literal 12 changed board 1's binary at +0 BYTES, which is exactly
// the case a size comparison cannot see and board-baseline.mjs can.
const int BATT_LEFT_BYTES = 8;
// drawConnRow()'s erase box, likewise the shipping values (100 x 16). The WIDTH
// has to cover the widest string the row draws, "Not connected", which is 78px in
// Cozette 6x13 - so 100 has 22px of headroom here and had NONE on board 2 at 8px
// (104), which is why this became a constant. The HEIGHT must cover
// uiLineH(T_BODY): 16 against 13 here, i.e. 3 rows of free clearance.
const int CONN_TEXT_W = 100;
const int CONN_TEXT_H = 16;

// Per-Mac link rows. "Mac  feedfeed  999s ago" (a bare 11-char hostId with no
// tag, plus a generously wide age) is 26 chars - MAC_ROW_W pads to 28. Indexed
// by ROW SLOT (0/1), not by hostLinks[] index - see renderMacLinkRows().
// Padding every row to this SAME fixed width, used or not, is what makes a row
// that goes away actually get erased: the erase box is sized to the padded
// text, so an unpadded "" would leave a wide stale row un-erased instead of
// blanking it.
// This cache no longer holds only the padded text: renderMacLinkRows() appends
// a "\x01" sentinel plus the row's icon id before comparing, because the icon
// is drawn separately from that text and a changed icon otherwise leaves a
// stale one on screen (the visible text is unaffected by an icon-only change).
// Worst case: 28 (padded text) + 1 (sentinel) + 2 (id, "-1".."15") = 31, +1 NUL
// = 32 - so 40 keeps 8 bytes of headroom, the same margin battRowTextCache
// keeps over its own worst case. A cache shorter than the string it holds
// silently stops noticing changes past that length - this file's oldest bug.
const int MAC_ROW_W = 28;

// Easter-egg crab-walk surface geometry. OCTO_H depends on CRAB_H (from
// ClawdCrab.h), which is why deckhand_display.ino now includes ClawdCrab.h
// before board.h - CRAB_H must already be a defined macro at this point.
const int OCTO_W = 240;                  // full width: the crab walks across it
const int OCTO_H = CRAB_H * 3;           // == CRAB_DRAW_H
const int OCTO_X = 0;
const int OCTO_Y = 110;

// ---------- Component heights (moved from deckhand_display.ino) -------------
// These two are the design system's interactive heights and their own comment
// there always said "derived from TAP_MIN, not chosen per page" - which makes
// them per-board by definition, since TAP_MIN is. H_BTN is TAP_MIN + 4 and
// H_ROW is TAP_MIN exactly. VALUES UNCHANGED: 40 + 4 = 44, and 40.
const int H_BTN = 44;     // buttons and toggles (pages with room)
const int H_ROW = 40;     // list rows (the tightest page fits 5 of these)
// THE STATUS PILL'S HEIGHT, named because it had FOUR copies and is the constant
// most likely to be re-tuned next. drawStatusPill() drew an 18 literal twice, the
// detail card's (now deleted) DETAIL_PILL_STEP added a third, and
// sessions-geom-check.mjs
// TRANSCRIBED a fourth - so raising the pill by mutating the draw sites left all
// three checkers passing while the assertion they exist for ("the pill ends clear
// of the row's own 2px border") was false. The checker parses this name now, which
// is what makes that mutation fail by name instead of silently.
//
// 18 is not derived from TAP_MIN: a pill is a LABEL, not a control - nothing taps
// it - and what bounds it is the label's own ink against the row height the ladder
// hands it. It comes out the same on both boards even though the faces differ, and
// drawStatusPill's own comment carries that arithmetic (a 13px opaque box has the
// slack inside 18; a 16px one does not, which is why board 2 draws the label
// transparently rather than widening the pill). Named per-board anyway, because
// every other band in the row stack is, and a shared number here would be the one
// thing in that stack that could not move.
const int PILL_H = 18;

// ---------- SETTINGS: the stepper card ----------
// EVERY NUMBER BELOW IS THE LITERAL THAT WAS ALREADY IN deckhand_display.ino (or
// at its call site in settings.ino) - the section grew names, not values.
//
// The card is sized by its CONTENTS, and the content that sets the height is the
// +/- key: 2 (border) + 4 (air) + 44 (key) + 4 (air) + 2 (border) = 56. The label
// sits in the MIDDLE column, above the value it names, rather than in the same
// column as the left key - which is what forced the keys down until they ended
// flush on the bottom border with no padding at all.
// Layout inside a 56px card (interior +2..+53): keys +6..+49, label centred +15,
// value centred +32, and for BRIGHTNESS only a bar at +43..+48.
const int STEPPER_CARD_H = 56;
const int STEP_LABEL_CY  = 15;   // label centre, from the card top
const int STEP_VALUE_CY  = 32;   // value centre (T_HEAD, 18px cell)
const int STEP_BAR_Y     = 43;   // BRIGHTNESS bar
const int STEP_BTN_TOP   = 6;    // 4px clear of the 2px border
const int STEP_BTN_SIZE  = 44;   // +/- keys: 4px OVER TAP_MIN, not merely at it
// The BRIGHTNESS bar's own thickness and its inset from each key. Both were
// literals at the drawBar() call site; named here because a wider card wants a
// thicker bar and the inset is what keeps it clear of the two keys.
const int STEP_BAR_H     = 6;
const int STEP_BAR_GAP   = 10;   // between a key's edge and the bar

// ---------- SETTINGS: per-page knobs ----------
// PAGE 1 IS OVER-SUBSCRIBED ON THIS BOARD, which is why its gap is page-local
// rather than SP_1. The region runs PAGE_TOP(80)..contentBottom(302) = 222px and
// the content is 3*STEPPER_CARD_H + H_ROW = 208 of it, leaving 14px for five gaps
// (top, three between rows, and the one under the bottom row). The bottom one is
// NOT optional: with SP_1 (4) throughout, the toggle row ended at exactly 302 and
// sat against the footer, which made MUTE/NORMAL/LIGHT read as part of the status
// line. Budget: 1 top, 3/3/3 between, 4 below.
const int P1_TOP = 1;
const int P1_GAP = 3;
// PAGE 2: four buttons plus a hint. 38px is under H_BTN because four buttons and
// a hint would not fit at 44; it is still ~8.5mm on this panel.
const int P2_TOP   = 12;
const int P2_BTN_H = 38;
const int P2_GAP   = 8;
// The confirm dialog's card. CFM_H holds a centred text block (title T_HEAD 18 +
// emph T_BODY 13 + up to 2 note lines of 13, with SP_2 between) above a button
// row of H_BTN + SP_3.
const int CFM_TOP = 24;          // card top, from PAGE_TOP
const int CFM_H   = 150;

// ---------- KEYBOARD (moved from keyboard.ino) ----------
// EVERY NUMBER IS THE LITERAL keyboard.ino ALREADY USED. The keyboard owns the
// whole screen, and what that buys is the TOUCH target rather than the artwork.
// The drawn key is KB_KEY_W x (KB_ROW_H - 4) = 22x37; the TESTED band is
// KB_PITCH x KB_ROW_H = 24x41 = 984px2, and the width comes from the PITCH
// rather than from KB_KEY_W because kbTouch() divides by KB_PITCH - so the 2px
// gap between two keys belongs to the key on its left and no column is dead.
// (An earlier version of this comment said 968, i.e. 22x44: it used the DRAWN
// width against the TESTED height. Understated, but wrong. The pair was 22x40
// and 24x44 = 1056px2 until the prompt strip took 3px off KB_ROW_H - see there.)
//
// 10 * 24 = 240, exactly the panel width; 2px of the pitch is the gap.
const int KB_PITCH = 24;
const int KB_KEY_W = 22;
// THE KEY'S OWN RADIUS, not the card's. R_MD is 10, which is 4.6% of the 216px
// card it was sized for and 45.5% of a 22px key - a pill. WRITTEN AS THE
// DERIVATION, not a literal that merely happens to agree with one in a
// comment: KB_KEY_W / 10 under C truncation (22/10 = 2 here, 30/10 = 3 on
// board 2) gives BOTH boards their value exactly - unlike scaling 2 by
// board_es3c35p.h's x1.154 (the ratio R_MD and the borders use), which
// computes to 2.31 and truncates back to 2, not 3. Worse than the pill look:
// at r=10 the four corners lose 4*r^2*(1 - pi/4) = 85.8px2 off a 22x40 key at
// the OLD KB_ROW_H 44 (9.8% of that drawn key) - and at KB_ROW_H 41 (Task 6)
// the drawn key is 22x37, so the same 85.8px2 is 10.5% of it. They are lost
// FURTHEST FROM CENTRE, which is exactly where a mis-aim lands on a key
// already 40% under TAP_MIN. 2px is 9.1% of the width and 0.36mm, and costs
// only 3.4px2 - 0.4% of the drawn key.
const int KB_KEY_R = KB_KEY_W / 10;
// THE TESTED BAND, and it is the one that has to clear TAP_MIN: 41 = TAP_MIN + 1.
// It was 44 = TAP_MIN + 4, which made the DRAWN key (KB_ROW_H - 4) exactly TAP_MIN
// as well - a coincidence of that value, never a rule, and the checker's own
// `drawn key >= TAP_MIN` assertion was reading it as one. The drawn key is now
// 22x37, under TAP_MIN in BOTH dimensions (it always was in width: 22 against 40),
// which is the same drawn/tested split the action row got in Task 3 - what the
// finger is tested against is the band, and the band still clears the floor.
// The 3px is what pays for KB_STRIP_H alongside Task 3's KB_ACT_H 44 -> 40; this
// board has 12 spare pixels in 320 and the strip needs 17. The key gets SHORTER
// but no more elongated: 37/22 = 1.68 against the 40/22 = 1.82 it was, which is
// the cap settings-geom-check.mjs already holds every key on both boards to.
const int KB_ROW_H = 41;
// THE TEXT CARD'S BUDGET IS ARITHMETIC, and it is what stops SEND signing text
// that scrolled off the bottom. KB_COLS is the card's text lane divided by
// Cozette's uniform 6px advance - (CARD_W - 12) / 6 = (216 - 12) / 6 = 34 - and
// the line count is then ceil(KB_MAX_BYTES / KB_COLS) = ceil(150 / 34) = 5. The
// wrap is a HARD slice at KB_COLS, deliberately not drawWrappedText's word wrap:
// word wrap can leave as few as 18 of 34 columns used on a line (a 17-character
// word pushes the break back past halfway), so 150 bytes could need 8 lines by
// that algorithm - more than this screen has room for. A fixed column count makes
// the budget provable instead.
//
// THIS BOARD'S 34 IS ALREADY 1PX HOT AGAINST ITS OWN LANE, which the next person
// deriving from that lane needs to know. 34 columns of Cozette advance 34*6 = 204
// and the last character is charged xOffset + width rather than xAdvance, so the
// widest 34-character line inks 33*6 + 7 = 205px against a 204px lane. Harmless
// and pre-existing: the card interior reaches x = CARD_X + CARD_W - 3 = 225 and
// the text starts at CARD_X + 6 = 18, so 205px of ink ends at 222 - 3px inside the
// card, overrunning only the nominal lane and never the card.
// (This paragraph used to close by calling board 2's 47 "exact by the same rule",
// measured at a 6px advance. Board 2 draws Spleen 8x16, so its real maximum is 35
// and 47 was never reachable - see the corrected derivation in board_es3c35p.h.)
const int KB_COLS = 34;
const int KB_TEXT_LINES = 5;                   // ceil(KB_MAX_BYTES / KB_COLS)
// KB_LINE_PITCH IS DECLARED FIRST because three of the terms below are derived
// from it (KB_STRIP_H here, KB_ACT_DRAWN lower down, and the card's own line
// spacing), and both the compiler and the checkers' consts() parser read this
// file top to bottom - a derivation written above its input silently fails to
// resolve on the checker side.
const int KB_LINE_PITCH = 13;                  // Cozette's cell - text-derived
// THE PROMPT STRIP: one line of the ask, above the card, that never leaves.
// Re-reading the question used to mean opening the peek, which covers the keys
// and routes every tap to its pager - so you could not read and type at once.
// ITS COST IS STATED because this board had 12 spare pixels in 320 and the strip
// needs 17: KB_ROW_H 44 -> 41 gives 3 per row (12 in all) and Task 3's KB_ACT_H
// 44 -> 40 gives 4, less the 3 the gaps below hand back. The whole column:
//   4 (margin) + 17 (strip, 4..20) + 3 (gap) + 88 (card, 24..111) + 3 (gap)
//   + 164 (4 rows * 41, 115..278) + 1 (gap) + 40 (actions, 280..319) = 320
// settings-geom-check.mjs sums exactly that, with every GAP written as a
// difference of the constants around it rather than as a number of its own.
// The strip's own text is one KB_LINE_PITCH cell centred in the band, so it inks
// 6..18 and drawString's OPAQUE box stops 5 rows above the card's top border at
// 24. That clearance is the reason the band is pitch + 4 and not pitch.
const int KB_STRIP_Y = 4;
const int KB_STRIP_H = KB_LINE_PITCH + 4;      // 17
// The card, and the RESERVED META ROW inside it. The byte counter and the
// countdown used to sit ON a text row, and drawString paints an OPAQUE box the
// full height of a text line, so each silently erased whatever text shared its
// row - found twice, fixed once. The meta row and the text lines share no pixel
// row: meta inks 30..42, lines at 46/59/72/85/98 (the last ending 110, one row
// inside the card's 111). KB_TEXT_H, KB_COLS and KB_TEXT_LINES did NOT move for
// the strip - the card keeps its five PROVABLE lines, so what SEND can sign is
// unchanged; only its top edge moved, 4 -> 24.
const int KB_TEXT_Y  = 24;                     // was 4, before the strip
const int KB_TEXT_H  = 88;
const int KB_META_DY = 6;                      // meta row, from the card top
const int KB_LINE0_DY = 22;                    // first wrapped line, from the card top
const int KB_ROWS_Y = 115;                     // was 96; 4 rows * 41 = 164, ending 278
// THE ACTION ROW, drawn and tested separately - the split the keys already have
// (KB_KEY_W in KB_PITCH, KB_ROW_H - 4 in KB_ROW_H) and this row never did.
// TESTED stays TAP_MIN: CANCEL and SEND are the two taps that must not miss.
// DRAWN is TEXT-DERIVED at 2 * KB_LINE_PITCH - one cell for the glyph, one for
// the air - which is 26px = 4.62mm, against the 44px = 7.82mm this row painted
// while a letter key, pressed up to 150 times, gets 4.27mm of width.
// The 4px this freed is SPENT: it went into KB_STRIP_H along with the 12 that
// KB_ROW_H 44 -> 41 freed, and what is left of the two is the 3px gaps above and
// below the card and the 1px above this row. Board 1 has no spare pixel now.
const int KB_ACT_H     = TAP_MIN;                 // 40, the tested band
const int KB_ACT_DRAWN = 2 * KB_LINE_PITCH;       // 26
const int KB_ACT_DY    = (KB_ACT_H - KB_ACT_DRAWN) / 2;   // 7
const int KB_ACT_Y     = BOARD_H - KB_ACT_H;      // 280, was 276
// The peek overlay's three stacked rows, and its line budget. These were the
// literals 8 / 22 / 40 at drawKbPeek()'s call sites; they are constants now because
// drawString paints an OPAQUE box one full cell tall, so at a 16px cell a title at
// +22 starts INSIDE a label whose box is +8..+23 and rubs out its last row. Board 1
// keeps its own numbers exactly: label +8, title +22 (one row of air), text +40
// (five rows of air).
const int KB_PEEK_LBL_DY   = 8;
const int KB_PEEK_TITLE_DY = 22;
const int KB_PEEK_TEXT_DY  = 40;
// It covers the keys and the action row (never the text card), so its height is
// BOARD_H - KB_ROWS_Y - 4 = 201, its text starts KB_PEEK_TEXT_DY inside it and
// stops 8 short of its bottom - (201 - 40 - 8) / 13 = 11.77 -> 11.
//
// RE-DERIVED, NOT ADJUSTED, and this constant is the reason to be careful with
// KB_ROWS_Y: keyboard.ino's KB_PEEK_H follows KB_ROWS_Y automatically (it is
// BOARD_H - KB_ROWS_Y - 4), but this line does NOT - it is hand-written. The
// strip moved KB_ROWS_Y 96 -> 115, so the overlay lost 19px and 13 lines no
// longer fit: drawWrappedText would have painted 13 lines into room for 11, two
// of them past the overlay's bottom edge and over the key grid, silently. The
// same formula gives board 2 its unchanged 15 at its own 306px overlay.
const int KB_PEEK_LINES = 11;                  // was 13, at KB_ROWS_Y 96

// ---------- HISTORY READER / FULL-SCREEN READER ----------
// Moved from deckhand_display.ino and from literals in reader.ino. Every value
// is the one already in use.
//
// The header: filter chip on the left, session name beside it, position on the
// right, then a rule. The chip's TAP band is deliberately larger than the chip
// (24 tall against 17 drawn, 76 wide against 40) - the same drawn-versus-tested
// split the keyboard's rows use. Both are under this board's TAP_MIN of 40.
const int HIST_CHIP_X      = 10;
const int HIST_CHIP_Y      = 4;
const int HIST_CHIP_H      = 17;
// 13, where the chip's own centre is HIST_CHIP_Y + HIST_CHIP_H / 2 = 4 + 8 = 12 -
// so the label sits ONE PIXEL LOW. Pre-existing and invisible at this size, and
// left alone because this board's binary is held byte-identical across the port;
// stated here rather than papered over with arithmetic that yields 12.
// settings-geom-check.mjs carries it as a known board-1 entry.
const int HIST_CHIP_CY     = 13;
const int HIST_CHIP_W_CHAT = 40;
const int HIST_CHIP_W_ALL  = 32;
const int HIST_CHIP_TAP_W  = 76;
const int HIST_CHIP_TAP_H  = 24;
const int HIST_HDR_TEXT_Y  = 8;    // name (left) and position (right), TL/TR
const int HIST_RULE_Y      = 22;   // the divider under the header
const int HIST_TOP         = 28;   // first entry row
const int HIST_EMPTY_CY    = 130;  // "Asking the Mac..." / "Nothing here"
const int HIST_LINE_H      = CODE_LINE_H;   // the code cell, Cozette 6x13
// THE SCRUBBER, and its band is where the drawn/tested split matters most: the
// track is 16 tall and so is its tap band on this board, i.e. 2.8mm - well under
// TAP_MIN and the tightest control in the reader. It cannot be grown here (the
// list above it and the control bar below it own every other row), which is why
// HIST_JUMP_TAP_H exists as a separate name rather than being spelled
// HIST_JUMP_H twice: board 2 has the rows to make the band a real target while
// keeping the track a track.
const int HIST_JUMP_Y      = 248;  // TOP OF THE TAP BAND (the track is centred in it)
const int HIST_JUMP_H      = 16;   // drawn track
const int HIST_JUMP_TAP_H  = 16;   // tap band == the track here
// THE ASK READER'S TWO LINE STEPS (drawReader, reader.ino). Both draw the SAME
// face - dFont is FONT_CODE or 2, and FONT_CODE aliases T_BODY - so the only
// difference between them is leading, and BOTH must be >= that face's cell
// height (uiLineH(T_BODY), CODE_LINE_H). drawString paints an OPAQUE box the full
// cell tall, so a step UNDER the cell has each line's box eat the bottom rows of
// the line above it: descenders in g/j/p/q/y are chopped. That is not
// hypothetical - it was a literal `isCode ? 14 : 18` here, and 14 under board 2's
// 16px Spleen cell cost 2 of that face's 4 descender rows on every code line.
// They are PER-BOARD constants rather than one shared derivation because
// CODE_LINE_H alone would take this board from 14 to 13, tighter than it ships,
// and move its binary. So this board keeps the one row of leading it has always
// drawn, spelled as the cell plus that row rather than as a literal that
// describes only Cozette.
const int READER_CODE_LINE_H  = CODE_LINE_H + 1;   // 14: Cozette 6x13 + 1 leading
// The prose step, drawn at font 2 (T_BODY) - the same 13px cell, with 5 rows of
// leading because prose is read in paragraphs rather than scanned. It is a stated
// value, not a derivation, for the same reason the ask preview's 17 is: any
// derivation would move this board's binary. What the checker enforces is the
// invariant that matters (>= the cell), not the leading.
const int READER_PROSE_LINE_H = 18;
// The control bar: PREV / CLOSE / NEXT, and the reader's text region above it.
const int READER_CTRL_Y  = 272;
const int READER_BTN_H   = 42;
const int READER_TEXT_TOP = 30;
// Three keys, symmetric: 8 + 70 + 8 + 68 + 8 + 70 + 8 = 240, the middle one 2px
// narrower so the margins and gaps can all be 8.
const int READER_BTN_L_X = 8,   READER_BTN_L_W = 70;
const int READER_BTN_M_X = 86,  READER_BTN_M_W = 68;
const int READER_BTN_R_X = 162, READER_BTN_R_W = 70;
// The x boundaries the three touch handlers split on. TWO SETS, because this
// board has always had two: the history list and the full-entry pager split at
// 78/156 while the ask reader splits at 82/158. Both merely assign the 8px gap
// between two keys to a different neighbour, so neither is wrong - but they are
// inconsistent, and that inconsistency is preserved here rather than fixed,
// because this board's binary is held byte-identical across the two-board port.
// Board 2 derives ONE pair from its own key geometry.
const int HIST_TAP_1   = 78,  HIST_TAP_2   = 156;
const int READER_TAP_1 = 82,  READER_TAP_2 = 158;
