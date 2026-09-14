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
// TWO SETTINGS FLAGS STOOD HERE AND TASK 4 DELETED BOTH. The record is kept
// because it is the reason the SETTINGS tab looks the way it does, not because
// anything still reads it: BOARD_SETTINGS_GROUPS gated the six page BODIES and
// their geometry chains, BOARD_SETTINGS_HOME gated NAVIGATION ONLY - the HOME
// list, the back band, and the chevron pager (drawPager(), gotoSettingsPage(),
// SETTINGS_PAGES and the 45/55 band split) that this board used before them. They
// were ONE flag meaning two things until Task 3A split them, and the split existed
// so board 1's content (Task 3A) and its navigation (Task 3B) could converge in
// separate commits with separately attributable binary movement. Both reached 1 on
// both boards, which made every `#else` arm dead code; Task 4 removed the flags and
// those arms, and BOTH BINARIES CAME OUT BYTE-IDENTICAL - the proof that nothing
// live went with them. There is one implementation of this tab now.
// The flags that remain below are #defines, NEVER const ints: the preprocessor
// cannot see a C++ const int, so `#if` on one is silently false with no warning.
// That has shipped twice.
// BOARD 1's DEVICE PAGE CARRIES NO DIAGNOSTICS BLOCK, and that is a measured
// decision rather than an omission. board_es3c35p.h's own note says those facts
// "earn their place on this board specifically because there is no serial console
// in normal operation here". THIS board has a CH340: payload size, flush time,
// uptime, the BT address and the build stamp are a `screen /dev/cu.usbserial-*`
// away, and WHOAMI re-emits the HELLO line on demand. Six DIAGNOSTICS lines at
// DEV_DIAG_STEP plus their caption would be ~100 rows on a 222px page that also
// has to hold the two live cards and CALIBRATE TOUCH - and the two live cards are
// the half a console cannot give you. Guarded around the DEFINITION as well as
// the call: this board declares no DEV_DIAG_* at all, so an unguarded body would
// not compile rather than merely drawing nothing.
#define BOARD_DEVICE_DIAGNOSTICS 0
// A STANDING PER-BOARD DIVERGENCE, NOT SCAFFOLDING. This flag and
// BOARD_DEVICE_DIAGNOSTICS are permanent facts about the two panels, the shape
// BOARD_HAS_MIC and BOARD_TOUCH_NEEDS_CAL already have - board 1's group page is
// 222px against board 2's 356, and no refactor removes that. THE TWO FLAGS THAT
// WERE SCAFFOLDING (BOARD_SETTINGS_GROUPS and BOARD_SETTINGS_HOME) ARE GONE, deleted
// in Task 4 once both boards took the same arm; the note above records them. A
// reader needs to know which kind a flag is before deciding whether a guard is
// worth removing, and the two kinds no longer sit side by side here.
//
// NAMED FOR THE CAUSE, NOT THE SYMPTOM (RULING 18). It was BOARD_SETTINGS_CAPTIONS,
// which says WHAT is gated; FITS says WHY - this board's group page is 222px against
// board 2's 356, and a caption costs SET_CAP_STEP (21) plus its gap while a hint
// costs its 13px cell plus two. The repo's own shape is BOARD_HAS_MIC,
// BOARD_TOUCH_NEEDS_CAL, BOARD_HAS_TOUCH_SLEEP_WAKE: names that carry the reason to
// every guard site, so nobody has to come back here to find out whether flipping it
// is a preference or an arithmetic impossibility.
//
// THE SECTION CAPTIONS AND THE HINTS THAT BELONG TO THEM, on the three groups
// where board 2 frames a control block with them: Display ("THEME" + the AUTO
// hint), Sound ("ALERTS" + its hint + "MICROPHONE") and Macs ("ANSWER PROMPTS
// FROM" + "PAIRED MACS"). This board draws none of the six, and the reason is
// arithmetic rather than taste - a caption costs SET_CAP_STEP (21) plus its gap
// and a hint costs its 13px cell plus two, against a page region of
// PAGE_TOP(80)..contentBottom(302) = 222px where board 2 has 356:
//   Display  2 steppers(112) + segments(40) + flip(40) = 192 of 222. The caption
//            and hint want ~46 more; there are 30, and they are the four gaps.
//   Sound    toggle(40) + stepper(56) + 2 buttons(88) = 184 of 222. The two
//            captions and the hint want ~55 more; there are 38.
//   Macs     ANY row(40) + four rows(172) = 212 of 222. Two captions want 42+;
//            there are 10. (This is the same arithmetic the spec's AMENDMENT used
//            to reject the five-group set - see its table.)
// NOT A BLANKET "this board has no captions": the captions that carry MEANING
// rather than grouping are decided per page on their own arithmetic and are NOT
// gated here - Danger's CANNOT BE UNDONE, Messages' HOW MY MESSAGES LAND, and
// this board's own SETUP over CALIBRATE TOUCH, which fits with 1 row to spare.
#define BOARD_SETTINGS_FITS_CAPTIONS 0
// The scrolling transcript is board 2's. This board keeps its paged reader: the
// panel is RESISTIVE, where this repo has already measured that drag-scroll
// misfires and settled on discrete pages. (This line also said "and its binary is
// held byte-identical"; that constraint is lifted - see CLAUDE.md - and the
// resistive-panel measurement was always the reason that mattered.)
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

// The mV at which batteryState() calls the cell FULL. PER-BOARD because the two
// boards read ~60mV apart at the top of a charge through nominally identical x2
// dividers, and one shared threshold cannot be right for both.
// MEASURED, from the host logs: this board settles at 4221..4226 mV and reports
// state=3 routinely. 4226 is ABOVE the 4.20V a standard CC/CV charger terminates
// at, which is itself the evidence that this divider reads slightly HIGH - so the
// number below is reached comfortably here, and that is not proof it is correct.
#define BOARD_BATT_FULL_MV 4180

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
// it can no longer cover a card, a status pill, or the SETTINGS band's key (the
// pager's "next" key, when that sentence was written; the band's one BACK key since
// Task 3B), and it no longer has to appear and disappear per screen to stay safe.
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
// TAB_REC_W STOOD HERE - the 40px slot the record button owned at the right end
// of the tab bar. The button is gone (2026-09-13): it was global chrome doing a
// per-session job, and speaking to a session now starts from that session's own
// detail screen. The three tabs share the whole width again.

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
// 38 IS TWO PIXELS UNDER THE UNCLAMPED COMPACT LAYOUT, AND THAT IS NOW HANDLED IN
// THE DRAW RATHER THAN HERE. The arithmetic that made it a defect is unchanged and
// worth keeping: the compact sub-line inks SESSION_SUBC_Y..+12 (+25..+37) against a
// 2px border owning rowH-2..rowH-1, so an unclamped row needs rowH >= 40, and 38 is
// reached whenever the list truncates - seven or more sessions add the 16px
// "+N more" strip, leaving avail 248, and (248 - 5*3) / 6 = 38 exactly, so nothing
// clamped it and nothing on screen named the cause.
//
// THE STATED REASON FOR LEAVING IT WAS THAT THIS BOARD'S BINARY WAS HELD
// BYTE-IDENTICAL. That constraint is lifted (see CLAUDE.md), so it was fixed - but
// NOT by raising this constant to 40, and the reason is arithmetic rather than
// caution: six rows at 40 plus five 3px gaps is 255 against an avail of 248, so the
// sixth row would be drawn 7px through the footer. Two rows of sub-line on an
// outline is a smaller defect than seven rows of row on the footer, and dropping
// the list to five visible rows is a product decision, not a geometry fix.
// sessionSubcYAt() (sessions.ino) clamps the sub-line to the row it is drawn in
// instead; sessions-geom-check.mjs mirrors that clamp in its band walk and binds
// the firmware's own expression and both draw sites. Board 2 derives its floor (47)
// rather than inheriting this number, which is why the clamp is inert there.
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
// deckhand_display.ino's rowSigCache declaration - then 304, because this board
// draws the band card too and its expanded first row appends the LAST PROMPT and
// the PATH to that row's signature. A field drawn but not signed is exactly the
// staleness the title itself shipped once. The worst case: name 23 + status 9 +
// sub 35 + title 43 + tag 6 + icon 3 + 5 separators + NUL = 125 for an ordinary
// row, plus prompt 103 + path 67 + 2 separators = 297 for the expanded one.
//
// 368 NOW, AND THE SIX BYTES IT HAD LEFT ARE WHY - the same argument, and the same
// 64-byte step, that took detailSigCache from 384 to 448. At 304 this held its
// 298-byte worst case with SIX bytes spare, and the expanded row's append is
// guarded by `if (used + 2 < sizeof(sig))` - which reserves room for the two
// SEPARATORS and nothing else, so snprintf truncates in silence rather than
// overflowing. One more signed field and the band card stops repainting when the
// tail of its path changes: a card that never repaints, with no symptom on the
// glass but the wrong text. 368 = 304 + 64 leaves 70, which is one more field of
// every kind this signature already carries but the prompt, and the margin is
// asserted rather than trusted (SESSION_SIG_MARGIN, see deckhand_display.ino).
// It costs MAX_SESSIONS copies of RAM - 6 x 64 = 384 bytes more, 2208 in all - and
// that is the price of the card; appending prompt and path for every row instead
// would repaint a COMPACT row whenever its prompt changed, which is a wholesale
// clear-and-redraw of pixels that did not change.
const int SESSION_ROW_SIG_LEN = 368;
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
// the card's border. IT STANDS, and the reason is a trade rather than a freeze
// (the byte-identity clause that used to be given here is gone with the constraint
// - see CLAUDE.md). Two facts decide it. First, this band puts no INK on the
// border: unlike SESSION_SUB_LANE_W, which really did draw over the outline, this
// one only shares touch rows with it, and a border is not tappable content, so the
// overlap costs nothing on the glass. Second, the only way to remove it is to
// SHRINK the band to 26 - and 28 is already 12px under this board's own TAP_MIN of
// 40, the shortfall sessions-geom-check.mjs records for the reader chip's zone and
// every other control in this row. Taking a sub-floor tap target down by another
// 2px to tidy an invisible 2-row overlap makes the device worse. Growing it instead
// is not available: CONTENT_Y+26 is where the card starts, and the band would then
// eat the card.
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
// power.ino. (That last clause used to read "and this board's binary is held
// byte-identical"; the constraint is lifted and the flash argument was always the
// real one: a `const char*` here is a pointer AND its string in .rodata on a board
// whose free flash is the tightest thing about it, for a literal used at one site.)
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

// THE BAND UNDER THE TAB BAR IS A *BACK* BAND ON BOTH BOARDS SINCE TASK 3B, and
// these three keep their PAGER_ names because PAGE_TOP is derived from PAGER_H and
// every group body on both boards is derived from PAGE_TOP - renaming them would move
// nothing and touch forty sites. BACK_BTN_W is PAGER_BTN_W for the same reason board
// 2 makes it so: one chrome size across the two boards.
const int PAGER_BTN_W  = 52;   // the band's one key; was the prev/next key width
const int PAGER_BTN_X0 = 6;    // inset from each edge
const int PAGER_H = 42;                       // the band under the tab bar. Sized for
                                              // TOUCH, not for the text: at 26 the prev/next
                                              // targets were only ~5mm tall, well under the
                                              // ~9mm fingertip guideline, and were the most
                                              // missed control on the device. THE DRAWN KEY
                                              // IS PAGER_H - 8 = 34, under this board's own
                                              // TAP_MIN of 40 - which was a documented
                                              // shortfall while there were two keys to hit
                                              // and is not one now: the WHOLE band
                                              // (CONTENT_Y..PAGE_TOP = 46px) is the single
                                              // back target, and that is what is asserted.
// PAGE_TOP moved here alongside PAGER_H rather than staying in the main file: the
// board headers are visible at the point board.h is included, before PAGE_TOP's
// original declaration point, and everything that derives from it is per board.
// (It said "DEV_CARD_Y (below) is defined from it" - that was the pre-redesign
// page 0's card, deleted in Task 4 with the page.)
const int PAGE_TOP = CONTENT_Y + PAGER_H + 4; // top of each page's content

// THE PRE-REDESIGN PAGE 0 / DEVICE CARD'S GEOMETRY STOOD HERE AND TASK 4 DELETED
// IT: DEV_CARD_Y, DEV_CARD_H (160), DROW_BT/USB/BATT/ID, DROW_MAC0/MAC1,
// DROW_BATT_VAL_DY, CONN_TEXT_W/H (drawConnRow()'s 100x16 erase box) and MAC_ROW_W
// (28, the per-Mac row's padded width). They sized ONE card: a "DEVICE" heading, two
// connection rows with a dot each, a one-line battery reading, the device id, and two
// per-Mac link rows keyed off hostLinks[]. Task 3A replaced that page on this board
// with the six group bodies - the CONNECTION and POWER cards carry those facts now,
// and the Pairing group's two-line cards carry the Macs - which left every constant
// above reading only code the preprocessor excluded. Task 4 deleted that code
// (drawStatusPageStatic, renderStatusPage, drawConnRow, renderMacLinkRows), the
// assertions in settings-geom-check.mjs that measured it, and these declarations,
// and BOTH BINARIES CAME OUT BYTE-IDENTICAL - an unread `const int` emits nothing,
// which is the proof it was dead rather than merely unreferenced by this file.
// TWO SURVIVED because live code still reads them, and they are below with their
// own reasoning: BATT_ROW_CACHE (the POWER card's headline field) and
// BATT_LEFT_BYTES (its runtime label).
// The battery row's change-only cache, in BYTES. It was 20, sized for the old
// STATUS page's one-line "100% 4.20V ~99h" (15 + NUL) - a page this board no
// longer draws. The DEVICE group's POWER card gives the runtime estimate a line
// of its own, so the headline field is "100%  4.20V" padded to ST_BIG_CHARS, and
// 12 is that plus its NUL. A cache shorter than its string silently stops
// noticing changes past that point, so settings-geom-check.mjs asserts this
// against the header's own ST_BIG_CHARS rather than against this comment.
// A LITERAL rather than `ST_BIG_CHARS + 1` (which is how board 2 writes it)
// because ST_BIG_CHARS is declared further down this file, with the Device
// group - and a const int cannot be used above its own declaration.
const int BATT_ROW_CACHE = 12;
// The battery row's TRAILING LABEL buffer, in bytes. 8, UNCHANGED, and it is worth
// saying why it did not have to move with the rest of this page: the DEVICE
// group's POWER card draws the same two labels board 2's does, but the CHARGING
// one - battChargeLabel(), whose widest is "topping up" at 10 + NUL - is inside
// power.ino's `#if !BOARD_USES_TFT_ESPI` and is not compiled here, so this board
// still only ever draws the DISCHARGE estimate, whose widest is "~119m" (5 + NUL).
// Raising this to 12 "to be safe" would be a size justified by a string this
// binary cannot produce. Named per board because board 2 genuinely needs 12 - and
// because leaving this as a shared literal 12 changed board 1's binary at +0
// BYTES once, exactly the case a size comparison cannot see.
const int BATT_LEFT_BYTES = 8;

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

// ---------- SETTINGS: the six groups ----------
// ONE LINE, and it has to stay one line: geom-common.mjs parses `const int`
// declarations with /^const int (...);/m, so a wrapped one is invisible to every
// checker that reads these ids - it failed loudly on board 2 when that line was
// split, which is the only reason this is a note rather than a defect.
//
// THE IDS ARE THE SAME RUN BOARD 2 USES, and since Task 3B this board reaches all
// seven of them. `settingsPage` is ONE global shared by both boards and SET_HOME is
// 0, which is also the initialiser that global is declared with - so BOTH boards now
// boot SETTINGS into HOME and every group is SET_DEVICE..SET_DANGER on both.
// The MESSAGES surface is addressed as SET_MESSAGES everywhere, and HOME's rows
// address exactly the ids the dispatch addresses rather than a second numbering
// nobody can see. (The SETTINGS_PAGE_MESSAGES alias that carried board 1's own
// ordinal 4 is gone; deckhand_display.ino records what it was for.)
//
// TWO SENTENCES STOOD HERE FOR ONE TASK AND ARE KEPT MARKED RATHER THAN DELETED,
// because they are the record of what Task 3A deliberately built and Task 3B
// deliberately undid: "the pager here walks SET_DEVICE..SET_DANGER rather than an
// 0..5 ordinal of its own", and "SET_HOME IS DECLARED AND IS NOT REACHABLE HERE,
// deliberately: drawSettingsTab() enters at SET_DEVICE and gotoSettingsPage() wraps
// INSIDE the run, so 0 is the one id this board's navigation can never produce."
// Both were true for the one task this board drew a pager. SET_HOME is reachable
// now, it is where drawSettingsTab() enters, and the pager that could not produce
// it - with gotoSettingsPage(), SETTINGS_PAGES and the flag that gated them - was
// deleted in Task 4.
const int SET_HOME = 0, SET_DEVICE = 1, SET_DISPLAY = 2, SET_SOUND = 3, SET_PAIRING = 4, SET_MESSAGES = 5, SET_DANGER = 6;
const int SET_GROUP_COUNT = 6;   // SET_DEVICE..SET_DANGER, contiguous by design

// ---------- SETTINGS: HOME ----------
// HOME OWNS THE WHOLE CONTENT AREA - there is NO band above it, because the tab bar
// already says SETTINGS and a second title would be chrome repeating itself. So the
// region is CONTENT_Y(34)..contentBottom(302) = 268px, NOT the 222px a group PAGE
// gets under the back band. That 46px difference is the whole reason six rows fit
// here at all.
//
// THE PITCH WAS SEARCHED, NOT NUDGED. The identity is
//   HOME_Y0 + 6*HOME_ROW_H + 5*HOME_GAP + HOME_Y0_BOT == contentBottom()
//   38      + 6*42         + 5*2        + 2           == 302
// and settings-geom-check.mjs asserts the IDENTITY rather than any of the values,
// so a row-height change must be paid for out of the gap or the pads or it fails.
//
// THE WHOLE SOLUTION SPACE, under four rules each of which is a floor rather than a
// preference - row height >= TAP_MIN (40); gap >= BORDER_CARD (2), since two cards
// separated by less than one border read as a single rule; top and bottom pad >=
// BORDER_CARD for the same reason against the tab bar and the footer; and the row
// interior must hold T_HEAD 18 + T_BODY 13 + two 2px borders = 35 WITHOUT shrinking
// a face. It is SIX (row height, gap) pairs and 46 four-tuples in total:
//   R=42 (TAP_MIN+2)  G=2  pads 6    <- taken, split 4/2
//   R=41 (TAP_MIN+1)  G=3  pads 7
//   R=41 (TAP_MIN+1)  G=2  pads 12
//   R=40 (TAP_MIN+0)  G=4  pads 8
//   R=40 (TAP_MIN+0)  G=3  pads 13
//   R=40 (TAP_MIN+0)  G=2  pads 18
// R=42 IS THE ONLY ROW HEIGHT WITH ANY MARGIN OVER THE FINGERTIP FLOOR AT ALL, and
// picking it fixes the gap at 2 and the pads at 6 - there is exactly one (gap, pads)
// answer once the margin is taken. The trade against the alternatives is explicit:
// R=40/G=4 buys a gap on the spacing scale (SP_1) and symmetric 4/4 pads by putting
// every row EXACTLY on TAP_MIN with zero margin, which is the P3_ROW_H shape this
// page's own neighbour already had to accept once and flagged as a concern. On a
// RESISTIVE panel, where this repo's measured history is of controls being MISSED
// (PAGER_H's own comment), giving up the only 2px of fingertip margin available in
// order to buy 2px of INERT space between two cards is the wrong way round: the row
// is the target, the gap is not.
//
// THE PAD SPLIT is 4/2 of the 6 available, and it is the one place taste entered
// (2/4 and 3/3 close the identity just as well). 4 at the top is SP_1, the same
// inset from CONTENT_Y that SESSION_ROW_Y0 uses - the only other list on this board
// that owns the whole content area - and it is written as the RELATION rather than
// as 38, because what was derived is the pad and not the absolute y. 2 at the foot
// is BORDER_CARD, the floor, and it is the CLOSING TERM: it is named for the same
// reason DEV_AIR_BOT / PAIR_AIR_LEFT / P1_AIR_BOT are, so that every other constant
// in the chain has something to be wrong against.
const int HOME_Y0     = CONTENT_Y + 4;
const int HOME_ROW_H  = 42;    // TAP_MIN + 2
const int HOME_GAP    = 2;     // == BORDER_CARD, the floor: one full background row
const int HOME_Y0_BOT = 2;     // the closing term
// Inside a 42px row: name at T_HEAD, summary at T_BODY under it, chevron right.
//   +0..+1    border
//   +4..+21   name    (T_HEAD, Terminus 10x18)
//   +22..+23  gap 2
//   +24..+36  summary (T_META - see the note under the stack)
//   +37..+39  pad
//   +40..+41  border                                   = 42
// The two ends clear the card's own 2px border (4 >= 2 at the top, 36 <= 39 at the
// foot) and the two lines share no pixel row (21 < 24) - the same three board 2's
// stack asserts, plus the pitch identity above, and none of the four is assumed
// from this comment.
// THE SUMMARY'S ID IS T_META, which is what renderSettingsHome() passes to
// drawIfChanged; this stack said T_BODY, copied from board 2's, which says it too.
// It changes no number - the font registry resolves T_META and T_BODY to the SAME
// face at the same size on BOTH boards (Cozette 6x13 here, Spleen 8x16 there), so
// the 13 above is right either way - but two ids being interchangeable today is a
// property of that registry and not a guarantee, and a header naming an id the code
// does not pass is the drift this file has been unpicking all branch. THE TWO FACES ARE NOT NEGOTIABLE and did not pay for the row:
// the name is T_HEAD and the summary T_BODY at every pitch in the table above,
// because shrinking a face to fit one more row is how a menu becomes unreadable one
// row at a time (board_es3c35p.h's rule, and it binds here).
const int HOME_NAME_DY = 4;
const int HOME_SUB_DY  = 24;
// THE SUMMARY'S CHARACTER CAP IS DERIVED FROM THIS BOARD'S OWN LANE. It is NOT
// board 2's 30 - a transcribed character cap is the defect class this tab has
// already paid for with P3_X_W, which was asserted against the WRONG board's
// fingertip floor.
//   text starts   CARD_X + PAD                              = 26
//   chevron ink   MR_DATUM at CARD_X + CARD_W - PAD (214),
//                 one T_HEAD advance wide                   = 204..213
//   lane          204 - 26                                  = 178px
//   Cozette advances 6, so the lane holds 29 (29 * 6 = 174; 30 * 6 = 180 does not).
//
// 28, NOT THE 29 THE LANE ALLOWS, AND THE REASON IS WHAT THE LAST PIXEL RESTS ON.
// The bound that actually matters is not the lane but the ERASE BOX: drawIfChanged
// clears fillRect(fx-1, fy-1, tw+2, th+2) before drawing, and tw is the PADDED
// string's real width, whose last glyph is a space - charged xOffset + width = 7
// rather than the 6 it advances. At 28 that box ends at 26 + (27*6 + 7) + 1 = 196,
// SEVEN rows of background clear of the chevron's ink at 204. At 29 it ends at 202
// and the margin is ONE row; at 30 it ends at 208 and RUBS THE CHEVRON OUT, which
// is permanent - drawSettingsHomeStatic() draws the chevron once and the summary
// repaints on change, so nothing ever puts it back.
//
// 29 was written first and was arithmetically honest. Three things decide against
// it. (1) The 7 in that sum comes from geom-common.mjs's MIRROR of TFT_eSPI's
// last-character rule, and a mirror proves an algorithm and binds nothing - one
// pixel is inside that model's own error bar, so the last pixel is the worst place
// on the device to lean on it. (2) The extra character is unreachable: the longest
// summary settingsHomeSummary() can compose HERE is 24 ("100%   sleep OFF   LIGHT"
// and "reset pairing, power off"), so 29 buys five characters no branch can produce
// and spends the whole margin to do it. (3) 28 costs nothing measurable - the cap
// only sets how wide the opaque box is, and 168px still covers every string with
// four characters to spare.
//
// BOARD 2's 30 IS THE SAME DERIVATION AT ITS OWN NUMBERS and is NOT the source of
// this one: its lane is 248px = 31 characters, its erase box at 30 ends at 271
// against ink at 278 (6 rows), and 31 would end at 279 and overlap. Both boards
// therefore sit one character under what their lane alone would allow, and
// settings-geom-check.mjs asserts the erase box on both - the lane division on its
// own would have passed board 2 at 31.
//
// THE WORST CASE IS BOARD 1's OWN, AND THE SENTENCE HERE ONCE QUOTED BOARD 2's.
// It read: "the longest summary settingsHomeSummary() can compose is 28 characters
// ("Both links up   100%   -10 C"), so the cap has one character of margin" - which
// is board 2's string, in board 1's header, for a term this board does not draw:
// the die temperature is behind `#if !BOARD_USES_TFT_ESPI` at the composing site
// because dieTempRead() does not exist here. Board 1's Device row is
// "Both links up   100%", 20 characters. Kept marked rather than deleted, because
// it is the ninth instance of the "a comment is not parsed" class on this tab and
// it arrived inside the commit that swept fifteen others for it.
// The real margins are asserted per board against every branch of that function,
// never against this comment.
// HOME_SUB_BYTES is what homeSubCache[] is declared with; a cache shorter than the
// string it holds silently stops noticing changes past its end.
const int HOME_SUB_CHARS = 28;
const int HOME_SUB_BYTES = HOME_SUB_CHARS + 1;

// The back band replaces the pager band AT THE SAME HEIGHT, which is the whole
// reason no group body needed re-deriving when this board's navigation flipped:
// PAGE_TOP is CONTENT_Y + PAGER_H + 4 on both boards and it is unchanged at 80.
// The key keeps the pager's own PAGER_BTN_W so the two boards' chrome stays one
// size, and the WHOLE band is the back target - there is nothing else in it, so the
// 45/55 split the chevron pager needed to separate two keys is not needed and is not
// declared (drawPager() itself went in Task 4). THAT IS ALSO WHAT RETIRED A
// DOCUMENTED SHORTFALL: the drawn key is PAGER_H - 8 = 34px, under
// this board's TAP_MIN of 40, and settings-geom-check.mjs carried a KNOWN entry
// excusing it while it was one of TWO keys you had to hit. It is an affordance
// inside a 46px single target now (CONTENT_Y..PAGE_TOP), the entry is deleted, and
// what is asserted is the band.
// BACK_TITLE_DX is 16 = SP_4, the SAME as board 2's: SP_1..SP_4 are 4/8/12/16 on
// both boards, so the gap between the key and its title does not scale - what
// differs is the lane the title has to fit, and that is asserted rather than
// assumed. The title starts at PAGER_BTN_X0 + BACK_BTN_W + 16 = 74, left of the
// panel's midpoint (120), and "Messages" at T_HEAD is 80px, ending 153 inside 234.
const int BACK_BTN_W    = PAGER_BTN_W;
const int BACK_TITLE_DX = 16;

// SET_CAP_STEP IS DERIVED, NOT COPIED. Board 2's is 24 = its T_META cell (16)
// plus SP_2; the same relation at this board's 13px cell is 21. Written as the
// relation rather than as 21, because the two boards' faces are what differ and a
// transcribed 24 would have put the caption's descenders into the first row.
// The 8 is SP_2. It is a LITERAL because SP_1..SP_4 are declared in
// deckhand_display.ino AFTER board.h is included, so no board header can name
// them - which is why every other spacing value in this file is a literal too.
// DECLARED ABOVE THE FIRST GROUP THAT USES IT, the way board 2 has it: the Device
// group's own stack steps through it, and a const int cannot be used above its
// own declaration.
const int SET_CAP_STEP = CODE_LINE_H + 8;

// ---------- SETTINGS group: Device ----------
// TWO LIVE CARDS AND ONE BUTTON. The two facts you actually came for - is the
// host talking to me, and how is the battery - lead a card each as a T_HEAD line
// with one dimmed detail under it, exactly as on board 2. What this board does
// NOT carry is the DIAGNOSTICS block (see BOARD_DEVICE_DIAGNOSTICS at the top of
// this file for the arithmetic and the reason), and what it carries instead is
// CALIBRATE TOUCH, which board 2 cannot offer at all.
//
//   92..151   CONNECTION        ST_CONN_Y, ST_CONN_H
//   164..223  POWER             ST_PWR_Y,  ST_PWR_H   (12px gap, SP_3)
//   236..248  "SETUP"           DEV_CAL_CAP_Y, T_META, TL_DATUM  (12px gap)
//   257..300  CALIBRATE TOUCH   DEV_CAL_Y = 236 + SET_CAP_STEP, H_BTN
//   301       1 row clear       DEV_AIR_BOT
//
// CALIBRATE TOUCH IS ON THIS PAGE AND NOT IN THE DANGER GROUP, which is what
// leaves that group holding exactly the two controls that destroy state on BOTH
// boards - so its name is right in both places. It is not on DISPLAY either, and
// that is measured rather than preferred: after the Display/Sound split this
// board's Display group spends 192 of 222px on two stepper cards, the theme
// segments and the flip toggle, leaving 30px across four gaps against the 72-78
// a captioned button needs. This page had ~78px of otherwise unconstrained air
// under the POWER card - the "a page with enough air in it is a page whose
// constants are constrained by nothing" smell - and the button closes it with
// one row to spare.
//
// THE BUTTON AND ITS HIT TEST MOVE TOGETHER, and board 2 has NEITHER constant.
// settings-geom-check.mjs asserts DEV_CAL_Y's and DEV_CAL_CAP_Y's ABSENCE there
// by name, the treatment P2_MIC_Y already gets: a constant a draw site no longer
// uses but a hit test still does is how a page claims taps for a button it does
// not draw. Both sites are guarded on BOARD_TOUCH_NEEDS_CAL, one flag.
const int ST_CONN_Y = 92,  ST_CONN_H = 60;
const int ST_PWR_Y  = 164, ST_PWR_H  = 60;   // 12px gap under CONNECTION
// ONE stack, shared by CONNECTION and POWER, so the two read as the same
// component with different content. Offsets are from the card's own y, and what
// each one PAINTS is its clear box rather than its glyphs - drawIfChanged clears
// y-1..y+cellH, one row above and one below the cell:
//   +0..+1     border
//   +6..+18    caption      ST_CAP_DY, T_META 13, a plain drawString (tlBox)
//   +21..+40   the headline ST_BIG_DY, T_HEAD 18 (ink +22..+39)
//   +42..+56   detail       ST_L1_DY,  T_BODY 13 (ink +43..+55)
//   +57        pad
//   +58..+59   border                                            = 60
// 60, not board 2's 70, and the difference is the two faces: 18 + 13 here against
// 24 + 16 there. Every bound above is asserted by settings-geom-check.mjs against
// the parsed cell heights, none of them by this comment.
const int ST_CAP_DY = 6, ST_BIG_DY = 22, ST_L1_DY = 43;
// EVERY FIELD IS PADDED TO A FIXED CHARACTER COUNT, because drawIfChanged sizes
// its erase box from the text it is GIVEN - so a value that shrinks ("Bluetooth
// only" -> "USB only") would otherwise leave the tail of the longer one behind.
// These are widths of the DATA, so the counts are the same as board 2's; what
// differs is the lane they are checked against. At this board's 10px (T_HEAD) and
// 6px (T_BODY) advances, from CARD_X + PAD (26) against a card interior ending at
// CARD_X + CARD_W - 2 (226):
//   verdict  14 * 10 = 140 -> ends 165     ("Bluetooth only")
//   headline 11 * 10 = 110 -> ends 135     ("100%  4.20V")
//   detail   28 *  6 = 168 -> ends 193     ("USB and Bluetooth, 9999s ago")
// All three are asserted rather than trusted to this comment.
const int ST_VERDICT_CHARS = 14;
const int ST_VERDICT_BYTES = ST_VERDICT_CHARS + 1;
const int ST_BIG_CHARS     = 11;
const int ST_LINE_CHARS    = 28;
const int ST_LINE_BYTES    = ST_LINE_CHARS + 1;
// The SETUP section, and the page's closing term. Both are literals rather than
// chained expressions for the reason board 2's DEV_DIAG_Y is one: an identity
// asserted against the formula that produced it cannot fail.
const int DEV_CAL_CAP_Y = 236;   // 12px (SP_3) under the POWER card
const int DEV_CAL_Y     = 257;   // DEV_CAL_CAP_Y + SET_CAP_STEP, the one caption step
// THE NAMED SURPLUS THAT CLOSES THE STACK, the HOME_Y0_BOT / P4_AIR_BOT shape,
// and it exists for the reason geom-sweep found rather than one anybody argued:
// air that is not named is slack no assertion constrains, and every constant
// above it reads as unguarded at +-16.
//   DEV_CAL_Y + H_BTN - 1 == 300, and 300 + 1 + DEV_AIR_BOT == contentBottom()
const int DEV_AIR_BOT   = 1;

// ---------- SETTINGS: the DISPLAY group ----------
// BRIGHTNESS stepper, SLEEP AFTER stepper, three THEME segments, the flip toggle.
// VOLUME and SOUND have left for the SOUND group, which is what makes the split
// worth making on this board at all: page 1 was OVER-SUBSCRIBED at 208 of 222px
// with 14px across five gaps, and its own comment recorded that the bottom gap
// was not optional because without it the toggle row sat against the footer.
//
//   86..141   BRIGHTNESS stepper   P1_BRIGHT_Y, STEPPER_CARD_H
//   148..203  SLEEP AFTER stepper  P1_SLEEP_Y   (P1_GAP)
//   212..251  DARK | LIGHT | AUTO  P1_THEME_Y, H_ROW   (P1_THEME_TOP_GAP)
//   258..297  SCREEN FLIPPED       P1_FLIP_Y,  H_ROW   (P1_FLIP_TOP_GAP)
//   298..301  4 rows clear         P1_AIR_BOT
//
// THREE SEGMENTS, NOT THE THIRD-WIDTH CYCLE BUTTON THIS BOARD SHIPPED, and the
// arithmetic is what decided it rather than the preference. A cycle button shows
// ONE state and hides the other two; what it buys is a shared row with the flip
// toggle, which is 40 rows. Those 40 rows do not buy the caption and the hint
// back: "THEME" costs SET_CAP_STEP (21) plus its gap and the AUTO hint costs its
// 13px cell plus two gaps, i.e. ~46 against the 30 this page has across FOUR
// gaps. So the choice was between a cycle button with air under it and segments
// with none of board 2's framing, and the segments win the thing the framing was
// for: all three options on screen at once, with selection carried by fill AND
// position rather than by "the label is the state".
//
// NO "THEME" CAPTION AND NO AUTO HINT HERE - see BOARD_SETTINGS_FITS_CAPTIONS. This
// board has never had either (its cycle button carried neither), so what changes
// is the control, not the chrome around it.
//
// P1_TOP IS 6 AND THE SIX GROUPS DO NOT START LEVEL ON THIS BOARD, unlike board 2
// where all six start at PAGE_TOP + 12. See the note at P3_ANY_Y below: the Macs
// group is what makes levelling impossible here, so the explanation lives with the
// page that causes it and every other group's top says which side of it it is on.
// The tops are Display 6, Sound 6, Macs 2, Device 12, Messages 12, Danger 12.
const int P1_TOP = 6;
const int P1_GAP = 6;
const int P1_THEME_GAP     = 4;   // between two segments; it belongs to the LEFT
                                  // one for touch, the pitch rule the keyboard uses
// 69, against a widest label ("LIGHT", 5 chars = 30px) needing 38 with uiButton's
// padding - so the constraint here is the card's width, not the text. 3*69 + 2*4
// is 215 of a 216px card: this board's lane does NOT divide evenly the way board
// 2's 296 does, so the row is one pixel short of flush and the assertion is that
// the last segment ends INSIDE the card, not that the three land on it exactly.
const int P1_THEME_SEG_W   = (CARD_W - 2 * P1_THEME_GAP) / 3;
const int P1_THEME_TOP_GAP = 8;   // the SLEEP card's bottom -> the segments' top
const int P1_FLIP_TOP_GAP  = 6;   // the segments' bottom -> the flip toggle's top
// The named surplus that closes this page, the DEV_AIR_BOT shape:
//   P1_FLIP_Y + H_ROW - 1 == 297, and 297 + 1 + P1_AIR_BOT == contentBottom()
const int P1_AIR_BOT       = 4;

// ---------- SETTINGS: the SOUND group ----------
// SOUND toggle, VOLUME stepper, TEST BEEP, MIC TEST - output and input together,
// because a mic test IS a sound test and it is the one action you run repeatedly
// (MICMON is how MIC_GAIN gets settled).
//
//   86..125   SOUND ON / SOUND OFF  PS_SOUND_Y, H_ROW
//   134..189  VOLUME stepper        PS_VOL_Y   (PS_VOL_GAP)
//   198..241  TEST BEEP             PS_BEEP_Y, PS_BTN_H  (PS_BEEP_GAP)
//   250..293  MIC TEST              PS_MIC_Y   (PS_MIC_GAP)
//   294..301  8 rows clear          PS_AIR_BOT
//
// NO "ALERTS" OR "MICROPHONE" CAPTION AND NO HINT - see BOARD_SETTINGS_FITS_CAPTIONS
// for the arithmetic. The four controls name themselves: the toggle reads SOUND
// ON / SOUND OFF, the stepper carries its own card label, and the two buttons say
// what they do. What is lost is the output/input separation the MICROPHONE
// caption drew, and the hint saying a beep means a session needs input.
//
// No bar under VOLUME, deliberately: only BRIGHTNESS gets one, because it is the
// single continuous 0-100 setting and a bar under three named presets would be
// decoration.
// 6, the same as P1_TOP and NOT the 12 the other three groups use - see the note at
// P3_ANY_Y for why this board has no common top to level on. 6 rather than 12
// because this page spends 184 of its 222px on four controls and the four gaps have
// to come out of the remaining 38.
const int PS_TOP      = 6;    // PAGE_TOP -> the SOUND toggle
const int PS_VOL_GAP  = 8;    // the toggle's bottom -> the VOLUME card
const int PS_BEEP_GAP = 8;    // the VOLUME card's bottom -> TEST BEEP
const int PS_BTN_H    = H_BTN;   // the two actions; H_BTN is TAP_MIN + 4
const int PS_MIC_GAP  = 8;    // TEST BEEP's bottom -> MIC TEST
// The named surplus that closes this page:
//   PS_MIC_Y + PS_BTN_H - 1 == 293, and 293 + 1 + PS_AIR_BOT == contentBottom()
const int PS_AIR_BOT  = 8;

// ---------- SETTINGS: the DANGER group ----------
// TWO buttons in ONE captioned section, and both of them destroy state. MIC TEST
// left for the SOUND group and CALIBRATE TOUCH for the DEVICE group, so what is
// left is a group whose NAME is the warning - and the name is now right on both
// boards rather than on one.
//
//   92..104   "CANNOT BE UNDONE"  P2_DANGER_CAP_Y, T_META, TL_DATUM
//   113..156  RESET PAIRING       P2_PAIR_Y, P2_BTN_H  (SET_CAP_STEP)
//   169..212  POWER OFF           P2_PWR_Y             (SP_3)
//   220..232  the wake hint       P2_PWR_Y + P2_BTN_H + SP_3 = 225, MC_DATUM ink
//   233..301  69 rows clear       P2_AIR_BOT
//
// RULING 13: P2_BTN_H IS H_BTN AGAIN. It was 38 - UNDER this board's own H_BTN of
// 44 and under its TAP_MIN of 40 - and the comment that stood here said why: "38
// is under H_BTN because four buttons and a hint would not fit at 44". That page
// no longer exists. The group carries TWO buttons, so the constraint that bought
// the 6px is gone, and a redesign should hand the fingertip floor back rather
// than inherit a workaround for a page it deleted. (This is the "a comment is not
// parsed" class this file has paid for repeatedly: the sentence stayed true-
// looking while the page it described was being dissolved one commit at a time.)
//
// AND THE HALF RULING 13 DID NOT ASK, ANSWERED HERE (final review, MINOR 5): board 2
// makes its destructive buttons TALLER than its ordinary ones - P2_BTN_H 56 against
// H_BTN 50, "TAP_MIN + 10; these are the destructive ones" - and this board does NOT.
// P2_BTN_H is exactly H_BTN here. THE STEP WAS CONSIDERED AND DECLINED; it is not an
// omission, and the room for it exists (P2_AIR_BOT is 69 rows, 12.3mm), so without
// this clause the next reader has to guess.
//
// MEASURED, at the two panels' own px/mm (5.624 here, 6.489 there, both derived in
// board_es3c35p.h from the diagonals): board 2's H_BTN 50 is 7.71mm and its P2_BTN_H
// 56 is 8.63mm, a 0.92mm step. THIS BOARD'S ORDINARY H_BTN 44 IS ALREADY 7.82mm -
// physically LARGER than board 2's ordinary button - and holding board 2's step
// physically would give 0.92 * 5.624 = 5.2 -> 49, i.e. H_BTN + 5, not + 6.
//
// Three reasons the step is declined rather than taken:
//   (1) IT SIGNALS ACROSS PAGES, NOT WITHIN ONE. The Danger group is the only page on
//       either board that holds these two buttons, and it holds NOTHING ELSE, so there
//       is no ordinary button beside them to be taller than. The contrast is a
//       comparison with a page you have left - the same argument Ruling 10 accepted
//       when it kept the destructive group LAST rather than relying on page position.
//   (2) THE SEVERITY SIGNALS THAT DO READ WITHOUT A REFERENCE ARE ALREADY HERE, all
//       three of them: the CANNOT BE UNDONE caption, the P2_SPINE_W 4 severity spine
//       (derived for this panel, not copied - see just below), and the confirm dialog.
//   (3) 5px HERE IS 0.89mm. Taking it would move a page every checker has closed and
//       cost a re-baseline of board 1's binary at the very end of an 18-commit branch
//       for a cross-page cue at the edge of discrimination. NOT MEASURED: whether a
//       person reads the two heights as different at all. That is a legibility claim
//       and no instrument in this repo settles one.
// If a person looks at the Danger page and wants the step, H_BTN + 5 is the derived
// value and the page closes: 69 rows of P2_AIR_BOT absorb 10 of them.
const int P2_TOP     = 12;   // PAGE_TOP -> the danger caption
const int P2_BTN_H   = H_BTN;   // NOT H_BTN + 5 - the step is declined just above
// The severity spine's width. 4, THE SAME AS BOARD 2, and it was DERIVED here
// rather than copied: physical parity would have given 3 (board 2's 4 at 6.489
// px/mm is 0.62mm, and 0.62mm at this board's 5.624 is 3.47), but 3 does not
// survive the shape. The spine's ends are rounded at P2_SPINE_W / 2 so they read
// as a deliberate mark rather than a clipped edge, and at width 3 that is an
// integer-truncated radius of 1 - which is under BORDER_CARD, i.e. thinner than a
// line, and 2 x 1 != 3, so the two caps do not meet in the middle.
// settings-geom-check.mjs asserts both of those at the DRAW SITE, and both failed
// at 3. The smallest width with real semicircular caps is 4, so 4 it is - 0.71mm
// here against 0.62mm there, i.e. the mark is slightly bolder on the smaller
// panel, which is the right direction for the one carrier of severity that
// survives greyscale. It sits BORDER_CTRL inside the button's own left edge and
// runs from R_MD to P2_BTN_H - R_MD, so it can never cross the rounded corner and
// paint over the stroke it exists to reinforce.
const int P2_SPINE_W = 4;
// The closing term, and the ONLY thing that gives P2_TOP and the gap between the
// two buttons any teeth: both are pure translations of a page with nothing
// anchored to its foot, so no relative bound can see them. Measured from the
// HINT's own MC_DATUM ink box, because the hint is the last thing this page
// paints:  hint ink 220..232, and 232 + 1 + P2_AIR_BOT == contentBottom().
const int P2_AIR_BOT = 69;
// P2_GAP IS GONE WITH THE PAGE IT SPACED. It was "a button's bottom -> the next
// button's top" on the four-button ACTIONS column, and this group has ONE section
// whose two buttons sit at SP_3, the page rhythm. The pre-3A page body that still
// mentioned it was behind a `#if` neither board took, and Task 4 deleted that body;
// a constant kept alive so dead text still parses is the shape this repo has had to
// unpick before (P1_THEME_CAP_STEP), and its absence is asserted rather than left
// to be noticed.

// ---------- SETTINGS group: Macs ----------
// The live Mac rows are two-line CARDS here now, the same component board 2
// draws, rather than the one-line uiListRow with a "* " live marker this board
// shipped. It costs NOTHING vertically, which is the whole reason it is possible:
// two 13px lines fit a 40px row where board 2's two 16px lines need 52, so the
// pitch is exactly the H_ROW + SP_1 the one-line list already used.
//
//   82..121   ANY MAC / SELECTED   P3_ANY_Y, H_ROW - a uiListRow, unchanged
//   126..297  up to MAX_HOSTS rows P3_LIST_Y, P3_ROW_H at P3_ROW_STEP
//   298..301  4 rows clear to contentBottom()
//
// NO SECTION CAPTIONS - see BOARD_SETTINGS_FITS_CAPTIONS. This page spends 212 of its
// 222px on the ANY row and four Mac rows; "ANSWER PROMPTS FROM" and "PAIRED MACS"
// want 42px more and there are 10. It is the same arithmetic the spec's AMENDMENT
// used to reject the five-group set, arriving at the same answer.
//
// 40 IS TAP_MIN EXACTLY - a legal target with NO margin, which the assertion
// states rather than implies. Board 2's row is 6 over its own floor; this one is
// at it, and the four-Mac case is the case the geometry has to survive.
// THIS PAGE IS WHY BOARD 1's GROUPS DO NOT ALL START LEVEL, and the note belongs
// here rather than beside any one of the groups that jogs against it. Board 2 starts
// all six at PAGE_TOP + 12 and settings-geom-check.mjs asserts that equality; here
// the ANY row plus four Mac rows is 212 of the page's 222px, so this group has to
// open at PAGE_TOP + 2 and there is no common top the other five would accept. The
// cost is real and visible: moving between groups jogs the first content by up to
// 10 rows. The alternative was a fourth Mac row that does not fit, and the four-Mac
// case is the case this geometry exists to survive.
const int P3_ANY_Y  = 82;    // PAGE_TOP + SP_1/2
const int P3_LIST_Y = 126;   // P3_ANY_Y + H_ROW + SP_1
const int P3_ROW_H    = 40;
const int P3_ROW_STEP = 44;
// Inside a row, from its own y - clear boxes again, not glyphs:
//   +0..+1     border
//   +6..+18    name       P3_ROW_NAME_DY, T_BODY 13 (the live dot shares this line)
//   +21..+35   state      P3_ROW_SUB_DY,  T_BODY 13 through drawIfChanged
//   +36..+37   pad
//   +38..+39   border                                              = 40
// The dot is NOT given a y of its own: it is centred on the name line
// (P3_ROW_NAME_DY + uiLineH(T_BODY) / 2 = 12), the "the icon's y IS its
// neighbouring text's y" rule every icon-beside-text surface in this sketch uses.
const int P3_ROW_NAME_DY = 6, P3_ROW_SUB_DY = 22;
// The dot's radius, and the text column that clears it. drawConnDot fills
// cx-r-1..cx+r+1, so at cx = CARD_X + PAD + P3_ROW_DOT_R (30) the dot's box runs
// 25..35, against text at CARD_X + PAD + P3_ROW_TEXT_DX = 42 - six pixels clear,
// which is board 2's nine at its own 8px advance carried across at 6.
const int P3_ROW_DOT_R   = 4;
const int P3_ROW_TEXT_DX = 16;
// 40, and it is THIS BOARD'S OWN TAP_MIN - not board 2's 46. The constant was
// once asserted against the wrong board's fingertip floor, which is why the
// checker derives it from c.TAP_MIN rather than from a number.
const int P3_X_W         = 40;   // "forget" hit zone at the right edge
// The state line's padded width, and its cache. "connected, 9999s ago" is the
// widest the row can draw - the age is capped at 9999s for exactly that reason -
// and 20 * 6 = 120px from x=42 ends at 161, clear of the "x" zone which starts at
// CARD_X + CARD_W - P3_X_W = 188.
const int P3_SUB_CHARS = 20;
const int P3_SUB_BYTES = P3_SUB_CHARS + 1;
// P3_EMPTY_HINT_Y IS NOT DECLARED HERE. It positions the empty-list hint one slot
// BELOW the PAIR NEW MAC button, and this board has no such button
// (BOARD_HAS_WIRELESS_PAIR is 0) - so its own arm draws the hint at
// P3_LIST_Y + P3_ROW_H / 2 instead. A constant only the other arm reads is the
// P2_MIC_Y defect, so its absence is asserted rather than the value declared.
const int P4_TOP      = 12;   // PAGE_TOP -> the caption
const int P4_ROW_GAP  = 8;    // between two option rows
const int P4_HINT_GAP = 16;   // the last row's bottom -> the hint's MC_DATUM centre
// The trailing air, NAMED, so this page lands rather than merely ending - see
// board_es3c35p.h's own note for why (geom-sweep found the same three constants
// unconstrained there, and the identity guards both boards).
const int P4_AIR_BOT  = 29;
// P4_LABEL_CHARS is NOT here: it derives from SP_3, which no board header can
// name (see SET_CAP_STEP above), and it is the same expression on both boards.
// It lives with the P4 chain in deckhand_display.ino, once.

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
// ---------- THE REPLY PANEL (compose.ino) ----------
// The compose surface's OTHER screen, and its column closes exactly on BOARD_H
// the way the keyboard's does. There is no spare pixel on this board, so the
// terms are stated as arithmetic rather than as numbers:
//
//    4 (COMPOSE_TOP) + 52 (prompt card) + 4 (COMPOSE_GAP) + 16 (legend)
//  + 80 (reply, 2 x TAP_MIN) + 16 (legend) + 40 (tokens, 1 x TAP_MIN)
//  + 21 (draft line) + 16 (legend, "no room for recents") + 31 (residual)
//  + 40 (KB_ACT_H) = 320
//
// EVERY TERM IS ONE OF SIX EXPRESSIONS - TAP_MIN, KB_LINE_PITCH + k,
// 2 * KB_LINE_PITCH, KB_TEXT_H, n x KB_ROW_H, or a term with no job of its own
// (the two margins and the residual). There is no value here that was CHOSEN
// while having a job, which is the property that lets settings-geom-check.mjs
// assert the column instead of transcribing it.
//
// THE RESIDUAL IS NOT NAMED and must not be: compose.ino lays the bands out
// top-down from COMPOSE_TOP and the action band is anchored at KB_ACT_Y, so what
// is left between them is arithmetic. A constant for it would be a second place
// to keep the same number.
const int COMPOSE_PROMPT_H = 5 + KB_LINE_PITCH + 4 + 2 * KB_LINE_PITCH + 4;  // 52
const int COMPOSE_LEGEND_H = KB_LINE_PITCH + 3;                              // 16
const int COMPOSE_DRAFT_H  = KB_LINE_PITCH + 8;                              // 21
// The 4px scale this board's whole layout is pitched on (board 2 is 8), used for
// the one gap the panel has - between the prompt card and the first legend.
const int COMPOSE_GAP      = 4;
// THE TOP MARGIN, and it is a MARGIN - the same kind of term as the residual
// above the action band, at the other end of the column. It is the one term here
// that is neither derived nor free, so it is stated where the rest of the panel's
// geometry is: 4 on this board, 12 on board 2, which is what the spec's two reply
// budgets print and what docs/design/compose/compose.js's D.RP_TOP mirrors (that
// mock's check.mjs binds this name against it, so the two cannot drift).
const int COMPOSE_TOP      = 4;
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
// DERIVED, and it used to be a literal 13 where the chip's own centre is
// HIST_CHIP_Y + HIST_CHIP_H / 2 = 4 + 8 = 12 - so the label sat ONE PIXEL LOW.
// Pre-existing, invisible at this size, and left alone for exactly one reason:
// this board's binary was held byte-identical across the port. That constraint is
// lifted (CLAUDE.md), the fix is one pixel and the derivation is the same one
// settings-geom-check.mjs already asserted the literal against - so the constant is
// now the expression rather than a number that happened to differ from it.
// HIST_HDR_TEXT_Y is derived from this in turn (a 13px cell centred on it), and its
// own assertion is what pins the pair together.
const int HIST_CHIP_CY     = HIST_CHIP_Y + HIST_CHIP_H / 2;
const int HIST_CHIP_W_CHAT = 40;
const int HIST_CHIP_W_ALL  = 32;
const int HIST_CHIP_TAP_W  = 76;
const int HIST_CHIP_TAP_H  = 24;
// DERIVED FROM THE CHIP'S CENTRE, and it used to be a literal 8 where a 13px cell
// centred on that centre starts at 6 - so the name and the position field sat 2px
// low against the chip beside them (1px, back when HIST_CHIP_CY was itself 13). Same
// class as HIST_CHIP_CY above and fixed in the same pass, for the same reason: the
// only thing that had ever kept it was this board's binary being held byte-identical.
// Board 2 has always derived its own (27 - 16/2 = 19). The row still lands inside the
// chip (6..18 against 4..20), which settings-geom-check.mjs asserts.
const int HIST_HDR_TEXT_Y  = HIST_CHIP_CY - CODE_LINE_H / 2;   // name (left) / position (right), TL/TR
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
// The x boundaries the three touch handlers split on. ONE SET NOW, DERIVED FROM THE
// KEYS, which is what board 2 has always done.
//
// THIS BOARD HAD TWO SETS AND THE REASON GIVEN WAS BYTE-IDENTITY. The history list
// and the full-entry pager split at 78/156 while the ask reader split at 82/158;
// both merely handed the 8px gap between two keys to a different neighbour, so
// neither was WRONG - but the same bar behaved differently depending on which
// screen drew it, and nothing on the glass said so. With the constraint lifted
// (CLAUDE.md) the question is which of the two to keep, and that is not a coin
// toss: 82/158 are the MIDPOINTS of the two gaps (78..86 and 154..162), i.e. the
// only pair that gives each key its own half of the gap. 78 and 156 were the left
// key's right edge and a number two pixels off the other midpoint. So the reader's
// pair wins, both are derived from the key geometry rather than transcribed, and
// HIST_TAP_* is defined FROM it so the two cannot drift apart again.
// settings-geom-check.mjs asserts both that each split falls in its gap and that
// the two sets agree.
const int READER_TAP_1 = (READER_BTN_L_X + READER_BTN_L_W + READER_BTN_M_X) / 2;   // 82
const int READER_TAP_2 = (READER_BTN_M_X + READER_BTN_M_W + READER_BTN_R_X) / 2;   // 158
const int HIST_TAP_1   = READER_TAP_1,  HIST_TAP_2 = READER_TAP_2;
