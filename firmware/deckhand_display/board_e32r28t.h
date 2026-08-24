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
//      The Mac icon is 13x13 for exactly this reason.
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
// numbers: the right field draws at CARD_X + CARD_W - PAD = 214 with TR_DATUM
// padded to CODEX_RIGHT_CHARS (20) = 120px, so it spans 94..214 and
// drawIfChanged clears from 93; the label starts at CARD_X + PAD = 26; so
// (93 - 26) / 6 = 11.17 -> 11 characters. EVERY ONE of those numbers changes on
// a wider card - do not copy 11 forward.
const int CODEX_LANE_CHARS  = 11;
const int CODEX_RIGHT_CHARS = 20;
// The buffer and the change-only cache holding that padded string. 24 here (11
// chars needs nowhere near it, and this is the size cxPctCache/cxRightCache
// have always been declared and compared at - see the note on them in
// deckhand_display.ino, which is emphatic that the declaration and the
// cacheSize passed at the call site must be the SAME number).
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
// The sub-line's measured lane. 184 rather than the row's own text lane
// (SESSION_ROW_X + SESSION_ROW_W - 12 - nameX = 172) because that is the literal
// this board has always used - it over-runs the 12px right inset by 12px, which a
// 30-character sub-line has never reached. Kept AS IS rather than tightened: this
// board's binary is held byte-identical across the two-board port, and a silent
// 12px change to when a sub-line starts truncating is exactly the kind of
// board-1 behaviour change that must not ride inside a board-2 diff.
const int SESSION_SUB_LANE_W = 184;
// The "+N more" strip's reserved band at the bottom of the list. Derived from the
// TEXT, not the panel: one Cozette 6x13 line plus 3px, so it does not move with
// the screen.
const int SESSION_OVERFLOW_H = 16;
// The row signature's buffer. 176, UNCHANGED - it is the literal that was in
// deckhand_display.ino's rowSigCache declaration, moved here because board 2's
// expanded first row appends the last prompt and the path to its own signature and
// needs 304. Per board because it is MAX_SESSIONS copies of RAM. This board never
// expands a row (sessionExpandedH() returns 0 unconditionally on it - there is no
// surplus height to give), so its worst case is unchanged at 125 bytes.
const int SESSION_ROW_SIG_LEN = 176;
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

// ---------- Session detail card and the ask screen ----------
// The header row's TOUCH band ("< Back" on the left; TYPE or READ ALL on the
// right), used by both handleAskTouch's `sy < CONTENT_Y + DETAIL_HEAD_H` gates.
// 28 against a card starting at CONTENT_Y+26, i.e. the band's last 2 rows overlap
// the card's border - harmless (the border is not tappable content) and left
// alone here for the same byte-identical reason as SESSION_SUB_LANE_W.
const int DETAIL_HEAD_H = 28;
const int DETAIL_BACK_Y = 4;      // "< Back" baseline inside that row
const int DETAIL_CARD_DY = 26;    // card top = CONTENT_Y + this
// 224. The card runs y 60..283 and the "tap here for history" hint sits at 292.
// Content ends at cardY+213 in the worst case (title AND last prompt both
// present), so 8 rows of slack sit above the 2px border at +222..+223.
const int DETAIL_CARD_H = 224;
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
// Air added at every block boundary inside the detail card. 0 here for the same
// reason SESSION_AIR is: this card already runs to 8px of slack.
const int DETAIL_AIR = 0;
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
// The ask screen's own header stack, below "< Back": the kind badge (with the
// session name right-aligned on the same row) and then the question title.
const int ASK_BADGE_Y = 27;
const int ASK_TITLE_Y = 39;

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
// detail card's DETAIL_PILL_STEP added a third, and sessions-geom-check.mjs
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
// The drawn key is KB_KEY_W x (KB_ROW_H - 4) = 22x40; the TESTED band is
// KB_PITCH x KB_ROW_H = 24x44 = 1056px2, and the width comes from the PITCH
// rather than from KB_KEY_W because kbTouch() divides by KB_PITCH - so the 2px
// gap between two keys belongs to the key on its left and no column is dead.
// (An earlier version of this comment said 968, i.e. 22x44: it used the DRAWN
// width against the TESTED height. Understated, but wrong.)
//
// 10 * 24 = 240, exactly the panel width; 2px of the pitch is the gap.
const int KB_PITCH = 24;
const int KB_KEY_W = 22;
// 44 = TAP_MIN + 4, so the DRAWN key (KB_ROW_H - 4 = 40) is exactly TAP_MIN.
const int KB_ROW_H = 44;
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
// The card, and the RESERVED META ROW inside it. The byte counter and the
// countdown used to sit ON a text row, and drawString paints an OPAQUE box the
// full height of a text line, so each silently erased whatever text shared its
// row - found twice, fixed once. The meta row and the text lines share no pixel
// row: meta inks +10..+22, lines at 26/39/52/65/78 (the last ending ~90, 2px
// inside the card).
// 4 (top) + 88 (text, 4..91) + 4 (gap) + 176 (4 rows * 44, 96..271) + 4 (gap)
// + 44 (actions, 276..319) = 320 exactly - this board has no spare row at all.
const int KB_TEXT_Y  = 4;
const int KB_TEXT_H  = 88;
const int KB_META_DY = 6;                      // meta row, from the card top
const int KB_LINE0_DY = 22;                    // first wrapped line, from the card top
const int KB_LINE_PITCH = 13;                  // Cozette's cell - text-derived
const int KB_ROWS_Y = 96;
const int KB_ACT_Y  = 276;
const int KB_ACT_H  = 44;                      // == KB_ROW_H
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
// BOARD_H - KB_ROWS_Y - 4 = 220, its text starts KB_PEEK_TEXT_DY inside it and
// stops 8 short of its bottom - (220 - 40 - 8) / 13 = 13.2 -> 13.
const int KB_PEEK_LINES = 13;

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
