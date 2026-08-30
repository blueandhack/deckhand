// SETTINGS / KEYBOARD / READER geometry checker - runs on the Mac, needs no
// hardware. Sibling of usage-geom-check.mjs and sessions-geom-check.mjs, and a
// separate file for the same reason those two are separate from each other: the
// hazard on these surfaces is a different one again.
//
// WHAT GOES WRONG HERE.
//  - SETTINGS is FOUR pages sharing one region, each a stack of fixed-height rows
//    under a pager band. Board 1's page 1 is over-subscribed to the pixel (14px
//    across five gaps) and its own comment says the bottom gap is not optional,
//    because without it the toggle row sat against the footer and read as part of
//    the status line. None of that shows up as anything that looks like an
//    off-by-one.
//  - The CONFIRM DIALOG is the one surface where an over-wide string does not
//    merely spill: drawString paints an OPAQUE background box, so a note wider
//    than the card RUBS OUT THE CARD BORDER it crosses, which reads as a gap in
//    the outline. Three of board 1's four notes were up to 228px against a 212px
//    interior before they were wrapped.
//  - The KEYBOARD is a derived chain - KB_COLS from the text card's lane, then
//    KB_TEXT_LINES = ceil(KB_MAX_BYTES / KB_COLS) - and that chain is the only
//    thing stopping SEND signing text that scrolled off the bottom of the card.
//    Its meta row and its text lines must also share no pixel row, for the
//    opaque-box reason above; board 1 found that bug twice before fixing it.
//  - The READER and history pager own the whole screen, so their controls answer
//    to no shared layout at all, and every one of them was a literal at its call
//    site until this port.
//
// Text is measured the way the panel measures it (geom-common.mjs reimplements
// TFT_eSPI's rule and pre-flights itself against 136 widths recorded from the
// real device), and the word wrap below is wrapLineLen()/countWrappedLines()
// reimplemented from deckhand_display.ino - because "does this note need two
// lines" is a WRAP question, not a width question.
//
//   node settings-geom-check.mjs             check both boards
//   node settings-geom-check.mjs --selftest  prove the checker has teeth
import { advanceB, ascentB, cacheSizes, consts, countWrappedLinesB, DIR, evalInt, fieldBox,
         lineHB, mcBox, PANEL, preflight, tlBox, widthB } from "./geom-common.mjs";
import fs from "fs";
preflight();

const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };
// The board header FIRST, then deckhand_display.ino seeded with it - the order the
// compiler sees, and what makes the derived P1_/P2_/P3_/CFM_ offsets resolve.
const B = {};
for (const b of [1, 2]) B[b] = consts("deckhand_display.ino", consts(HDR[b]));
const SET_CACHE = cacheSizes("deckhand_display.ino");   // the settings caches live in the main file
// The main file's own TEXT, for a claim that is about a DECLARATION rather than
// about a constant's value.
const SRC_MAIN = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
// Charge-estimator thresholds, PARSED out of power.ino rather than transcribed -
// the same drift discipline batt-trend-check.py uses, and for the same reason: the
// widest string the battery row can draw is a function of these two.
const POWER_SRC = fs.readFileSync(`${DIR}/power.ino`, "utf8");
const POWER_CONST = Object.fromEntries(["BATT_CHG_KNEE_MV", "BATT_FULL_MV"].map(n => {
  const m = POWER_SRC.match(new RegExp(`${n}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`${n} not found in power.ino - was it renamed?`);
  return [n, +m[1]];
}));
// pctFromMv()'s table, mirrored to derive that string's length. Integer division,
// matching the firmware.
const PCT_MV = [3300, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200];
const PCT_PC = [0, 8, 15, 28, 45, 62, 78, 90, 100];
function pctFromMvJs(mv) {
  if (mv <= PCT_MV[0]) return 0;
  if (mv >= PCT_MV[8]) return 100;
  for (let i = 1; i < 9; i++)
    if (mv < PCT_MV[i])
      return PCT_PC[i - 1] + Math.floor((PCT_PC[i] - PCT_PC[i - 1]) * (mv - PCT_MV[i - 1]) / (PCT_MV[i] - PCT_MV[i - 1]));
  return 100;
}
const T_META = 1, T_BODY = 2, T_HEAD = 3;

// THE ASK READER'S TWO LINE STEPS, READ OUT OF drawReader() rather than restated
// here. A checker that transcribes the constant it certifies certifies nothing -
// this file already had that exact defect on these two numbers - so the ternary's
// own tokens are parsed and then resolved against each board's constant table.
// A literal resolves to itself, so reverting the fix is still MEASURED (and fails
// the cell assertion below on board 2), and a token the table does not know
// THROWS rather than defaulting to a number that would quietly pass.
const READER_SRC = fs.readFileSync(`${DIR}/reader.ino`, "utf8");
const READER_STEP = (() => {
  const m = READER_SRC.match(/int lineH\s*=\s*isCode\s*\?\s*([A-Za-z_0-9]+)\s*:\s*([A-Za-z_0-9]+)\s*;/);
  if (!m) throw new Error("settings-geom-check: drawReader()'s `int lineH = isCode ? .. : ..;` " +
                          "no longer parses - if the reader's line step moved, move this with it " +
                          "rather than leaving the assertion looking at nothing");
  return { code: m[1], prose: m[2] };
})();
function readerStep(c, which) {
  const tok = READER_STEP[which];
  if (/^\d+$/.test(tok)) return +tok;
  if (!(tok in c)) throw new Error(`settings-geom-check: drawReader()'s ${which} line step is ` +
                                   `"${tok}", which is not a const int either board header declares`);
  return c[tok];
}
const MAX_HOSTS = 4;
const T_HERO = 4;

// ---- THE WIRELESS-PAIRING PANEL (board 2) ----
// The code's digit count is a CRYPTO constant and lives in pairing.ino, not in a
// board header, so it is parsed from there: 6 digits at T_HERO is the one width on
// that screen that cannot be trimmed, and a checker that transcribed the 6 would
// certify nothing.
const PAIRING_INO = fs.readFileSync(`${DIR}/pairing.ino`, "utf8");
const PAIR_CODE_DIGITS = (() => {
  const m = PAIRING_INO.match(/#define\s+PAIR_CODE_DIGITS\s+(\d+)/);
  if (!m) throw new Error("settings-geom-check: PAIR_CODE_DIGITS not found in pairing.ino - " +
                          "if the code's length moved, move this parse with it rather than " +
                          "leaving the panel's one un-trimmable width asserted against nothing");
  return +m[1];
})();
// settings.ino's own caches (the panel's two live there, beside the code that can
// see pairing.ino's #defines, rather than with the other settings caches).
const SETTINGS_CACHE = cacheSizes("settings.ino");
// A function's SOURCE, comments stripped, brace-balanced. The "one predicate read by
// the draw site AND the hit test" rule is a claim about what those two functions SAY,
// not about a number, so it can only be asserted over their text - and a commented-out
// call is not a call, which is the trap panel_shim.cpp's invertColor note records.
// The SPAN of a function whose body straddles a #if/#else, which brace-balancing
// cannot do: handleSettingsTouch has one arm per board and the UNION of the two is
// unbalanced as plain text, so a balancer runs off the end of the file and returns
// nothing - which reads exactly like an assertion that passed. It stops at the next
// definition that starts in column 0 instead.
function fnSpan(src, name) {
  const clean = src.replace(/^[ \t]*\/\/.*$/gm, "");
  const i = clean.indexOf(`${name}(`);
  if (i < 0) return "";
  const after = clean.slice(i + name.length);
  const m = after.match(/\n([A-Za-z_]\w[\w \t*&]*\w\s*\([^);]*\)\s*\{)/);
  return m ? after.slice(0, m.index) : after;
}
function fnSrc(src, name) {
  const clean = src.replace(/^[ \t]*\/\/.*$/gm, "");
  const i = clean.indexOf(`${name}(`);
  if (i < 0) return "";
  const open = clean.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < clean.length; j++) {
    if (clean[j] === "{") depth++;
    else if (clean[j] === "}" && --depth === 0) return clean.slice(i, j + 1);
  }
  return "";
}

// THE SEVERITY SPINE'S DRAW GEOMETRY, READ OUT OF drawSeverityAction() rather than
// restated. The four assertions this replaced constrained CONSTANTS only, under a
// comment at the draw site claiming they bounded the draw CALL - and they did not:
// rewriting it to uiFillRound(CARD_X, y, P2_SPINE_W, P2_BTN_H, ...), i.e. the spine
// flush to the card's edge and running its full height across BOTH corner arcs and
// over the stroke it exists to reinforce, passed all four with 0 failures. Same rule
// as everywhere else in this repo, arriving from a new direction: a checker must
// PARSE THE SITE IT CERTIFIES, the way sessions-geom-check.mjs parses the TYPE chip's
// hit-test slack term out of sessions.ino instead of restating a 24.
const SETTINGS_INO = fs.readFileSync(`${DIR}/settings.ino`, "utf8");
const SPINE_ARGS = (() => {
  const src = SETTINGS_INO.replace(/^[ \t]*\/\/.*$/gm, "");   // a commented-out call is not a call
  const i = src.indexOf("void drawSeverityAction(");
  if (i < 0) throw new Error("settings-geom-check: drawSeverityAction() not found in settings.ino - " +
                             "if the spine's draw site moved, move this parse with it rather than " +
                             "leaving the assertions looking at nothing");
  const z = src.indexOf("\n}\n", i);
  const body = src.slice(i, z < 0 ? undefined : z);
  const a = body.indexOf("uiFillRound(");
  if (a < 0) throw new Error("settings-geom-check: drawSeverityAction() no longer calls uiFillRound() - " +
                             "the spine is what that function exists to draw");
  // Brace-balanced rather than "up to the first )", so a parenthesised term or a
  // nested call inside an argument cannot end the list early.
  let depth = 0, j = a + "uiFillRound".length;
  for (; j < body.length; j++) {
    if (body[j] === "(") depth++;
    else if (body[j] === ")" && --depth === 0) break;
  }
  if (depth !== 0) throw new Error("settings-geom-check: the spine's uiFillRound(...) has unbalanced parentheses");
  const inner = body.slice(a + "uiFillRound(".length, j);
  const args = [];
  let d = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
    if (ch === "," && d === 0) { args.push(cur.trim()); cur = ""; } else cur += ch;
  }
  args.push(cur.trim());
  if (args.length !== 7) throw new Error(`settings-geom-check: uiFillRound() takes 7 arguments, ` +
                                         `the spine's call parses to ${args.length}`);
  return args;
})();
// One parsed argument, resolved against the BOARD's own constant table. A literal
// resolves to itself, so reverting a named constant back to a number is still
// MEASURED; the button's own `y` parameter resolves to 0, since what is being
// certified is the spine's offsets INSIDE the button; and a token that is neither
// THROWS rather than defaulting to a number that would quietly pass. evalInt is the
// same truncating-division parser consts() uses, so `P2_SPINE_W / 2` comes out the
// way the compiler computes it.
function spineArg(c, n) {
  const e = SPINE_ARGS[n].replace(/[A-Za-z_][A-Za-z_0-9]*/g, (t) => {
    if (t === "y") return "0";
    if (t in c) return String(c[t]);
    throw new Error(`settings-geom-check: the spine's argument ${n} ("${SPINE_ARGS[n]}") names ` +
                    `"${t}", which is neither a const int either board header declares nor the ` +
                    `button's own y`);
  });
  return evalInt(e);
}

// KB_MAX_BYTES is shared with the HOST, so read it from there rather than trust a
// comment claiming the two agree.
// EVERY path here goes through DIR (the same anchor geom-common.mjs uses) and NOT
// through the cwd. These three were relative, so the checker crashed with ENOENT
// when run from the repo root - which is exactly how every other checker in this
// repo is documented to be invoked (`node firmware/deckhand_display/...`). A
// verification tool that only runs from one directory is a tool people stop
// running.
const HOST_CAP = +fs.readFileSync(`${DIR}/../../host/voice-answer.mjs`, "utf8")
  .match(/ANSWER_TEXT_MAX_BYTES\s*=\s*(\d+)/)[1];
const KB_MAX_BYTES = +fs.readFileSync(`${DIR}/keyboard.ino`, "utf8")
  .match(/KB_MAX_BYTES\s*=\s*(\d+)/)[1];
const HIST_ARENA = +fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8")
  .match(/HIST_ARENA (\d+)/)[1];

// wrapLineLen() / countWrappedLines() USED TO BE REIMPLEMENTED HERE, board-1-only,
// and they are gone rather than fixed: every caller already went through
// geom-common's countWrappedLinesB(), which measures at the board's own face, so
// the local pair was dead code measuring Spleen with Cozette's advance. A dead
// board-agnostic measurer next to a live per-board one is the trap this whole pass
// is closing - the next person to need a wrap count could reach for either.

// The real strings, so a label that outgrows its lane fails here rather than on
// the glass. Kept as data next to the assertions that use them.
const PAGER_TITLES = ["STATUS", "DISPLAY & SOUND", "ACTIONS", "PAIRED MACS"];
const STEP_LABELS = ["BRIGHTNESS", "SLEEP AFTER", "VOLUME"];
const TOGGLES = ["SOUND", "MUTED", "FLIPPED", "NORMAL", "DARK", "LIGHT", "AUTO"];
// BOARD 2's settings tree: the five group names (one table serving both the back
// band's title and HOME's row name - they must be the same word or the screen you
// tapped into is not the one you tapped on), the labels its split Display and Sound
// groups draw, and the WORST CASE of each of HOME's five composed summaries.
const GROUP_TITLES = ["Status", "Display", "Sound", "Pairing", "Actions"];
const THEME_SEGS = ["DARK", "LIGHT", "AUTO"];
const SOUND_LABELS = ["SOUND ON", "SOUND OFF", "TEST BEEP", "MIC TEST",
                      "SCREEN FLIPPED", "SCREEN NORMAL"];
const SET_CAPTIONS = ["THEME", "ALERTS", "MICROPHONE", "SETUP", "CANNOT BE UNDONE"];
// Each is the longest string settingsHomeSummary() can build for that group:
// every link down / full battery / a two-digit-below-zero die temperature; 100%
// brightness with sleep OFF and the longest theme name; sound off at the loudest
// preset; four Macs restricted to one; and the Actions line, which is fixed.
const HOME_SUMMARIES = ["Both links up   100%   -10 C", "100%   sleep OFF   LIGHT",
                        "OFF   volume HIGH   mic", "4 Macs   one may answer",
                        "calibrate, pairing, power"];
// THE STATUS GROUP'S OWN STRINGS (board 2), hand-transcribed the way
// HOME_SUMMARIES and P2_LABELS are, and each measured against the character count
// its field is PADDED to rather than against a lane: a string longer than its pad
// is a silent truncation mid-word, which reads as a wrong reading rather than as a
// spill. Every one is the worst case its branch can produce.
const ST_VERDICTS = ["Both links up", "Bluetooth only", "USB only", "No host"];
const ST_BIGS = ["100%  4.20V", "no battery"];
const ST_DETAILS = ["USB and Bluetooth, 9999s ago", "USB and Bluetooth, waiting",
                    "nothing connected", "Deckhand-C114, 4 paired",
                    "~119m left on battery", "charging, >=119m to full",
                    "charging, topping up", "no battery fitted", "battery full",
                    "on battery", "SoC -10.0 C", "SoC --"];
const ST_HOST_LEFT = ["16000 B per tick", "no payload yet", "flush 999.9 ms"];
const ST_HOST_RIGHT = ["up 99h 59m", "no Macs", "2 Macs"];
// The PAIRING group's state line, all three branches. "not seen since boot" is the
// one drawn when no hostLinks[] slot matches at all - there is no persisted
// lastSeen on this device, so a Mac that has not been here THIS BOOT cannot be
// dated and the row says so rather than inventing an age.
const P3_SUBS = ["connected, 9999s ago", "last seen 999m ago", "last seen 59s ago", "not seen since boot"];
// uiHint centres on the PANEL, not on the card, so these two are measured against
// the panel width the way page 2's hints are.
const SET_HINTS = ["AUTO = light 07:00 to 19:00", "beeps when a session needs input"];
const P2_LABELS = ["MIC TEST", "CALIBRATE TOUCH", "RESET PAIRING", "POWER OFF"];
// BOTH ARMS of the #if BOARD_HAS_TOUCH_SLEEP_WAKE pair, on both boards. Only the
// touch-wake string was checked before, which is the arm board 1 compiles - so the
// longer no-touch-wake hint board 2 actually draws was measured by nothing. They
// happen to be the same length; that is a fact worth asserting rather than
// assuming, because the strings are edited independently.
const P2_HINTS = ["power off = deep sleep, touch to wake",
                  "power off = deep sleep, RESET to wake"];
// drawPendingConfirm()'s four dialogs: [title, emph, note, yesLabel]. POWER OFF
// has one note per arm of the same #if, and BOTH are checked on both boards for
// the reason above - the note is the string the dialog exists to show.
const DIALOG_NOTES_POWER = ["deep sleep - touch the screen to wake",
                            "deep sleep - press RESET to wake"];
const DIALOGS = [
  ["Forget this Mac?", "a-long-mac-label", "its key is deleted; re-pairs over USB", "FORGET"],
  ["Recalibrate touch?", null, "5 taps; current setup kept if it fails", "CALIBRATE"],
  ["Reset all pairing?", null, "every paired Mac is forgotten", "RESET"],
  ...DIALOG_NOTES_POWER.map(n => ["Power off?", null, n, "POWER OFF"]),
];
// hosts[].label is char[20], and uiListRow draws "\xB7 " + it with no fitText at
// all - so the widest row the PAIRED MACS page can draw is 21 characters.
const HOST_LABEL_MAX = 19;
// Key row lengths, from KB_ALPHA/KB_SYM (the two control bytes count as cells).
const KB_ROW_CELLS = [10, 9, 9, 10, 10, 9];

// THE OTHER 150-BYTE PAIRING. The voice-answer confirm screen caps its transcript
// panel at 8 WORD-wrapped lines (askVoiceTooLong() in sessions.ino, measured
// against CARD_W - 8) and CLAUDE.md records that cap and the 150-byte one as
// "consistent by arithmetic".
//
// TWO THINGS TO GET RIGHT HERE, and an earlier version of this file got the second
// one wrong. First, this is NOT the keyboard's lane: the keyboard measures
// CARD_W - 12 and the confirm screen CARD_W - 8, so the two surfaces do not share
// a column count and cannot share a worst case. Second, the adversarial string is
// PER BOARD. Word wrap's worst case is a word length that forces every break back
// to just past halfway, and which length does that depends on the lane - probing a
// 288px lane with the string that is adversarial for a 208px one measures nothing
// about the wider board. So the probe below SEARCHES word lengths per board and
// takes the worst it finds.
// Measured: board 1 lands on EXACTLY 8 (17-character words; 9 is unreachable
// because after 7 lines of 18 bytes the remaining 24 all fit on one more line), so
// the claim is true with zero slack. Board 2's own worst is 7, on 18-character
// words, measured at ITS OWN face - this file previously said 6 at 24, which was
// board 2's lane probed with board 1's 6px advance.
// The assertion stays comparative rather than absolute because what board 2 has to
// prove is that its wider lane cannot make the count worse: a lane that improved
// the average while worsening the tail would be a regression nothing else here
// would catch, and an absolute "<= 8" would pass right up to the moment it broke.
// MEASURED PER BOARD, through countWrappedLinesB/advanceB rather than the
// board-1-only countWrappedLines above: board 2 draws Spleen 8x16, so a wrap
// counted at Cozette's 6px advance describes a layout that panel never renders.
// That was live here - it reported board 2's worst as 6 lines at 24-character
// words, where the real figures are 7 at 18.
function worstWrappedLines(b, lane) {
  let worst = 0, at = 0;
  // Every word length that can matter: 1 up to the number of characters the lane
  // holds. Longer than that and wrapLineLen's "never stall" path takes over, which
  // is a different (and less bad) case.
  for (let w = 1; w <= Math.floor(lane / advanceB(b, T_META)); w++) {
    const word = "w".repeat(w) + " ";
    const text = word.repeat(Math.ceil(KB_MAX_BYTES / word.length) + 1).slice(0, KB_MAX_BYTES);
    const n = countWrappedLinesB(b, text, T_META, lane);
    if (n > worst) { worst = n; at = w; }
  }
  return { worst, at };
}
// The exact maximum column count for a lane, MEASURED rather than divided: the
// panel charges the last glyph xOffset + width instead of xAdvance, so a count that
// divides exactly can still overflow (board 1's 34 does, by 1px, for a line ending
// in space / '4' / 'q'). The probe walks up from 0 with the widest glyph the face
// has in that final position, which is what makes the answer content-independent.
function maxCols(b, id, lane) {
  let widest = " ";
  for (let c = 0x20; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (widthB(b, id, ch) > widthB(b, id, widest)) widest = ch;
  }
  let n = 0;
  while (widthB(b, id, "M".repeat(n) + widest) <= lane) n++;
  return { cols: n, widest };
}
const voiceLines = {}, voiceWord = {};
for (const b of [1, 2]) {
  const r = worstWrappedLines(b, B[b].CARD_W - 8);
  voiceLines[b] = r.worst; voiceWord[b] = r.at;
}

// Documented, deliberately-unfixed board-1 facts. Every one is a place board 1's
// packed layout gives something up; an entry appearing under 2 would mean a
// board-2 layout change quietly gave up the same clearance instead of keeping it.
const KNOWN = {
  1: [
    // Its own header comment says so: at 26 these were "the most missed control".
    "pager key 34px tall >= TAP_MIN 40",
    // Four buttons plus a hint would not fit at H_BTN, so the height came down.
    "action button 38px tall >= TAP_MIN 40",
    // The list above the chip and the control bar below own every other row.
    "history filter chip 17px drawn >= TAP_MIN 40",
    // The ALL state is 32 wide against a 40 floor, so the chip is under the floor in
    // WIDTH as well as height on this board - and only in one of its two states,
    // which is the part that would never be noticed by eye.
    "chip widths 40/32 both clear TAP_MIN 40",
    "history chip tap band 25px >= TAP_MIN 40",
    "history scrubber tap band 16px >= TAP_MIN 40",
    // FOUND BY THIS CHECKER, all pre-existing and all left alone because board 1's
    // binary is held byte-identical across this port. Reported in the task report.
    //
    // (a) The chip's tap band is `sy <= 24`, i.e. 0..24, while the header's rule is
    // drawn at 22 - so the band reaches 2px past the rule and into the first list
    // row's territory. Harmless in practice (the first row starts at HIST_TOP 28)
    // but it is the chip claiming rows that are not the chip.
    "chip tap band ends 24 above the rule, or it would claim the first list row",
    // (b) The three reader control bars split their x range at 78/156 in the
    // history list and the full-entry pager but at 82/158 in the ask reader. Both
    // merely hand the 8px gap between two keys to a different neighbour, so
    // neither is wrong - but the same bar behaves differently depending on which
    // screen drew it, and nothing on screen says so.
    "reader tap splits agree across the three control bars (78/156 vs 82/158)",
    // (c) The chip's label is drawn at a literal 13 where the chip runs 4..20, whose
    // centre is 12 - one pixel low, invisible at this size and pre-existing.
    "chip label centre 13 == the chip's own centre 12",
    // (h) THE LAST-CHARACTER RULE, on both of board 1's counted lanes. Cozette
    // advances 6px for every glyph but drawString charges the FINAL one xOffset +
    // width, which is 7 for space, '4' and 'q' - so a lane divided by 6 is 1px hot
    // whenever a line ends in one of those three. Board 1's own header already
    // states this for KB_COLS and calls it harmless, and the same holds for the
    // reader: 34 keyboard columns ink 205px in a 204px lane but end at x=222 inside
    // a card interior reaching 225, and 36 reader columns ink 217px in a 216px lane
    // but end at x=228 on a 240px panel. Both are pre-existing and board 1's binary
    // is frozen; board 2's Spleen has xOffset 0 and width == xAdvance for every
    // glyph, so its counts are exact for ANY string and it needs no such entry.
    "KB_COLS 34 == the MEASURED maximum 33 for the 204px lane",
    "34 columns ending in the widest glyph ink 205px inside the 204px lane",
    "reader columns 36 == the MEASURED maximum 35 for the 216px lane",
    // (g) The history header's text row is a literal 8 where a 13px line centred on
    // the chip's own centre (13) starts at 7 - so the name and the position field
    // sit 1px low against the chip beside them. Same class as (c), invisible at
    // this size, and pre-existing; board 2 derives the number instead.
    "HIST_HDR_TEXT_Y 8 centres a 13px line on the chip's centre 13",
    // (d) "Asking the Mac..." is drawn at a literal 130, which is NOT the midpoint
    // of the region it sits in (22..272 -> 147) - it predates the control bar.
    "history empty-state y 130 is the midpoint of 22..272 (147)",
    // (f) The battery READING is drawn 4px below the "Battery" label beside it, so
    // the two halves of one row do not share a baseline. Both are 13px here, so the
    // stagger is invisible and it ships; at 16px it is not, which is why
    // DROW_BATT_VAL_DY became a board constant (0 on board 2) rather than a literal.
    // Listed rather than fixed because board 1's binary is frozen.
    "DROW_BATT_VAL_DY 4 puts the reading on the \"Battery\" label's own baseline (needs 0 = ascent 10 - 10)",
    // (e) FOUND by the per-board band model added for the 16px pass, and benign.
    // The stepper label's own glyph box is 10..22 (Cozette, MC_DATUM at 15) and the
    // value's drawIfChanged ERASE box starts at 22, so the erase covers the label
    // box's last row. That row is the label's second DESCENDER row, and all three
    // labels (BRIGHTNESS / SLEEP AFTER / VOLUME) are upper case, so no ink is ever
    // there. Left alone because board 1's binary is frozen, and listed because a
    // board-2 layout arriving in this state would be a real defect.
    "stepper: label -> value gap -1",
  ],
  2: [],
};
const SELFTEST = process.argv.includes("--selftest");
let fail = 0, known = 0, total = 0;
// THE MESSAGES, not just the count. With two faults injected at once a bare total
// cannot say that BOTH were caught - one fault firing twice looks identical to two
// faults firing once - and "caught" alone cannot tell the assertion that exists for
// a fault from an unrelated crash. Same reason wire-bytes-check.mjs's selftest names
// which assertion caught each of its injected faults.
const FAILED = [];
let CUR = 1;
function chk(cond, msg) {
  total++;
  if (!cond && KNOWN[CUR].includes(msg)) { known++; console.log(` known  ${msg}`); return; }
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) { fail++; FAILED.push(msg); }
}

if (SELFTEST) {
  // Push board 2's keyboard meta row down by 9. The gap between the meta row and
  // the first text line is 8 rows, so 9 is the FIRST offset that puts the two on a
  // shared pixel row - and a shared row means the byte counter's opaque background
  // box erases the tail of a line of the answer being composed, which is the exact
  // defect board 1 hit twice. 9 rather than 1 because a 1px nudge is INSIDE spec
  // and must not fail. It can only be caught by laying the rows out, so a checker
  // that merely echoed the header's own arithmetic back would pass.
  B[2].KB_META_DY += 9;
  console.log("--selftest: board 2's keyboard meta row pushed 9px onto the first text line; the meta-row assertion MUST fail");
  // AND ONE FAULT FROM THE SETTINGS REDESIGN, because the injection above predates
  // it and a selftest that only exercises the keyboard says nothing about HOME.
  // +1 on the row height, which is the smallest change there is: HOME's five rows
  // and four gaps are pitched to land EXACTLY on contentBottom(), so one extra row
  // of height per card puts the fifth row 5px past the bottom of the content area
  // and under the footer. It is caught by the pitch IDENTITY rather than by a
  // clearance, which is the point of asserting the identity: a +1 leaves every
  // individual row still inside its own card and still a touch target, so nothing
  // measuring one row can see it.
  B[2].HOME_ROW_H += 1;
  console.log("--selftest: board 2's HOME row height raised by 1; the pitch identity MUST fail");
  // AND THREE FROM THE WIRELESS-PAIRING PANEL, whose CONFIRM button is the thing
  // that commits a pairing key - so its geometry is not cosmetic.
  //
  // The countdown lifted 30px onto the Mac's label. Both are drawn with an OPAQUE
  // box, so a shared pixel row means the once-a-second counter erases the tail of
  // the name the code is being compared against - and nothing measuring either
  // block on its own can see it.
  B[2].PAIR_LEFT_Y -= 30;
  console.log("--selftest: board 2's pairing countdown pulled 30px onto the Mac's label; " +
              "the panel's block-disjointness MUST fail");
  // One pixel on the button width, which is the smallest change there is: the two
  // buttons plus SP_3 stop filling the card lane exactly, so CANCEL's right edge
  // leaves the margin every other card on this device sits on.
  B[2].PAIR_BTN_W += 1;
  console.log("--selftest: board 2's pairing button widened by 1; the card-lane identity MUST fail");
  // The row step widened by 6, which pushes the LAST free slot (3 Macs paired)
  // 1px under the footer. The button would still be drawn and still be a touch
  // target - only its bottom row would be gone - so this is only visible to an
  // assertion that walks every reachable slot.
  B[2].P3_ROW_STEP += 6;
  console.log("--selftest: board 2's pairing row step widened by 6; the free-slot walk MUST fail");
  // And ONE PIXEL on the panel's surplus, the term that closes its stack onto the
  // button row. It is the smallest change there is and it is the assertion that
  // gives every other gap on this screen teeth - the sweep measured five of them
  // UNGUARDED at +-16 before it existed - so the tooth has to be proven on the
  // closing term itself rather than only on the chain it pins.
  B[2].PAIR_AIR_LEFT += 1;
  console.log("--selftest: board 2's pairing surplus widened by 1; the stack no longer lands on the button row and that identity MUST fail");
}

console.log(`\nvoice-confirm panel (lane CARD_W - 8, NOT the keyboard's CARD_W - 12), ` +
            `${KB_MAX_BYTES} bytes at each board's OWN adversarial word length:\n` +
            `  board 1: ${voiceLines[1]} lines (lane ${B[1].CARD_W - 8}px, worst at ${voiceWord[1]}-char words)\n` +
            `  board 2: ${voiceLines[2]} lines (lane ${B[2].CARD_W - 8}px, worst at ${voiceWord[2]}-char words)`);
CUR = 2;
chk(voiceLines[2] <= voiceLines[1],
    `board 2's wider lane cannot loosen the 8-line voice-confirm cap: ${voiceLines[2]} <= ${voiceLines[1]}`);

for (const b of [1, 2]) {
  CUR = b;
  const c = B[b], [W, H] = PANEL[b];
  const contentBottom = H - c.FOOTER_H;
  console.log(`\n=== board ${b} (${W}x${H}) ===`);
  // The BODY/CODE face's advance and cell, measured per board. The keyboard's hard
  // wrap and the reader's page budget both divide a lane by this, and both divided
  // by a literal 6 until now - Cozette's, on a board that draws Spleen 8x16.
  const adv = advanceB(b, T_BODY), cellH = lineHB(b, T_BODY);

  // ================= SETTINGS: the pager band =================
  const pagerKeyH = c.PAGER_H - 8;                 // drawPager: by = +4, bh = PAGER_H - 8
  const region = contentBottom - c.PAGE_TOP;
  console.log(`pager ${c.CONTENT_Y}..${c.CONTENT_Y + c.PAGER_H - 1} (key ${c.PAGER_BTN_W}x${pagerKeyH}), page region ${c.PAGE_TOP}..${contentBottom} = ${region}px`);
  chk(c.PAGE_TOP === c.CONTENT_Y + c.PAGER_H + 4, `PAGE_TOP ${c.PAGE_TOP} == CONTENT_Y + PAGER_H + 4`);
  chk(pagerKeyH >= c.TAP_MIN, `pager key ${pagerKeyH}px tall >= TAP_MIN ${c.TAP_MIN}`);
  // ITS WIDTH TOO. Only the height was checked, which geom-sweep.mjs surfaced as
  // PAGER_BTN_W being unguarded on both boards - and a tap floor that holds in one
  // dimension is not a tap floor, as this file's own history with the history chip
  // (40 wide in one state, 32 in the other) already showed.
  chk(c.PAGER_BTN_W >= c.TAP_MIN, `pager key ${c.PAGER_BTN_W}px wide >= TAP_MIN ${c.TAP_MIN}`);
  chk(c.PAGER_BTN_X0 > 0, `pager keys are inset ${c.PAGER_BTN_X0}px from each edge (0 or less draws off the panel)`);
  {
    const cy = c.CONTENT_Y + Math.floor(c.PAGER_H / 2);
    chk(c.CONTENT_Y + 4 + pagerKeyH <= c.PAGE_TOP, `pager key ends ${c.CONTENT_Y + 4 + pagerKeyH} inside the band cleared to ${c.PAGE_TOP}`);
    // THE DOTS AND THE CENTRED TITLE ARE drawPager()'S, AND BOARD 2 NO LONGER
    // COMPILES drawPager(). Checking them there measured a band that is not drawn:
    // its back band has ONE key and a LEFT-ALIGNED title, so the constraint is a
    // different one and it is asserted separately below.
    if (b === 1) {
      chk(cy + 8 + 3 < c.PAGE_TOP, `page dots end ${cy + 11} inside the band cleared to ${c.PAGE_TOP}`);
      const laneL = c.PAGER_BTN_X0 + c.PAGER_BTN_W, laneR = W - c.PAGER_BTN_X0 - c.PAGER_BTN_W;
      for (const t of PAGER_TITLES) {
        // widthB, not textWidth: the pager title lane is the last board-agnostic
        // measurement in this file. "DISPLAY & SOUND" is 90px at Cozette's 6px
        // advance and 120px at Spleen's 8 - it still fits board 2's 184px lane, but
        // the header comment claiming 90px there has been corrected too.
        const w = widthB(b, T_META, t);
        const x0 = Math.floor(W / 2 - w / 2);
        chk(x0 > laneL && x0 + w < laneR, `pager title "${t}" ${w}px spans ${x0}..${x0 + w} inside the keys' lane ${laneL}..${laneR}`);
      }
    }
  }

  // ================= SETTINGS: HOME and the back band (board 2 only) =================
  if (b === 2) {
    // ---- the six page ids, which are an ORDINAL RANGE and not just names ----
    // Nothing here is geometry, and that is exactly why it was uncovered: the sweep
    // reported all seven of these as constants the branch ADDED and no assertion
    // reads. They are load-bearing anyway, in three separate places that all fail
    // SILENTLY:
    //   - `int settingsPage = 0;` is SHARED with board 1, so board 2 boots into
    //     whichever id is 0. The initialiser is PARSED below rather than restated,
    //     because a checker that transcribed the 0 would still pass if someone
    //     changed the declaration.
    //   - drawSettingsHomeStatic() and the HOME hit test both walk
    //     `SET_STATUS + i` for i in [0, SET_GROUP_COUNT), so the ids have to be
    //     consecutive in the order the rows are drawn AND the last one has to land
    //     on SET_ACTIONS - which is also what openSettingsGroup()'s
    //     `constrain(g, SET_STATUS, SET_ACTIONS)` clamps against.
    //   - settingsGroupTitle() names four cases and RETURNS "Actions" from its
    //     default, so an id that has drifted out of the run does not error: it
    //     draws a row labelled Actions that opens something else.
    {
      const m = SRC_MAIN.match(/^int settingsPage = (-?\d+);/m);
      if (!m) throw new Error("settingsPage's declaration not found in deckhand_display.ino");
      chk(c.SET_HOME === +m[1],
          `SET_HOME ${c.SET_HOME} == the shared \`int settingsPage = ${+m[1]};\` the device boots with`);
      const ids = [["SET_STATUS", c.SET_STATUS], ["SET_DISPLAY", c.SET_DISPLAY],
                   ["SET_SOUND", c.SET_SOUND], ["SET_PAIRING", c.SET_PAIRING],
                   ["SET_ACTIONS", c.SET_ACTIONS]];
      for (let i = 0; i < ids.length; i++)
        chk(ids[i][1] === c.SET_HOME + 1 + i,
            `${ids[i][0]} is HOME + ${1 + i} (${ids[i][1]} == ${c.SET_HOME + 1 + i}): HOME's row ${i} draws SET_STATUS + ${i}`);
      chk(c.SET_GROUP_COUNT === c.SET_ACTIONS - c.SET_STATUS + 1,
          `SET_GROUP_COUNT ${c.SET_GROUP_COUNT} == SET_ACTIONS - SET_STATUS + 1 (${c.SET_ACTIONS - c.SET_STATUS + 1}): the last HOME row lands on SET_ACTIONS`);
    }
    // HOME's pitch is derived to land exactly on contentBottom(). Asserting the
    // IDENTITY rather than the number is what makes a row-height change fail here
    // instead of silently eating the bottom row. The row COUNT is SET_GROUP_COUNT,
    // not a literal 5 - the loop that draws them counts with it, and transcribing
    // the 5 here left that constant unswept.
    const homeRows = c.SET_GROUP_COUNT;
    const homeEnd = c.HOME_Y0 + homeRows * c.HOME_ROW_H + (homeRows - 1) * c.HOME_GAP + c.HOME_Y0_BOT;
    chk(homeEnd === contentBottom,
        `HOME's ${homeRows} rows land exactly on contentBottom: ${homeEnd} == ${contentBottom}`);
    chk(c.HOME_ROW_H >= c.TAP_MIN,
        `a HOME row is a touch target: ${c.HOME_ROW_H} >= TAP_MIN ${c.TAP_MIN}`);
    // The row's own stack must clear its 2px card border at both ends.
    const subEnd = c.HOME_SUB_DY + lineHB(b, T_BODY) - 1;
    chk(c.HOME_NAME_DY >= c.BORDER_CARD,
        `HOME's name clears the card's top border: ${c.HOME_NAME_DY} >= ${c.BORDER_CARD}`);
    chk(subEnd <= c.HOME_ROW_H - c.BORDER_CARD - 1,
        `HOME's summary clears the bottom border: ${subEnd} <= ${c.HOME_ROW_H - c.BORDER_CARD - 1}`);
    const nameEnd = c.HOME_NAME_DY + lineHB(b, T_HEAD) - 1;
    chk(nameEnd < c.HOME_SUB_DY,
        `HOME's name and summary share no pixel row: ${nameEnd} < ${c.HOME_SUB_DY}`);
    // The back band must be the pager band's height, or every group body moves.
    chk(c.BACK_BTN_W === c.PAGER_BTN_W,
        `the back key is the pager key's width: ${c.BACK_BTN_W} == ${c.PAGER_BTN_W}`);
    // ---- ALL FIVE GROUPS START LEVEL UNDER THE BACK BAND ----
    // Actions used to start 4px lower than the other four (P2_TOP 16 against
    // P1_TOP/PS_TOP 12), reproducing settings.js's own inconsistency rather than a
    // decision anybody made - so moving between groups jogged everything down and
    // back up again. The rule is asserted as an EQUALITY across the five parsed
    // tops, never against a literal 116: what matters is that they agree, and this
    // way a perturbation of ANY one of them breaks it. That also closes the gap the
    // note in the Actions block used to describe, where P2_TOP and P2_SETUP_CAP_Y
    // were pure page translations no relative bound could see.
    // Status and Pairing are absolute y's rather than PAGE_TOP + <top> offsets, so
    // they enter as themselves; the equality is over what the draw sites use.
    {
      const firsts = [["Status", c.ST_CONN_Y], ["Display", c.PAGE_TOP + c.P1_TOP],
                      ["Sound", c.PAGE_TOP + c.PS_TOP], ["Pairing", c.P3_ANY_CAP_Y],
                      ["Actions", c.PAGE_TOP + c.P2_TOP]];
      const y0 = firsts[0][1];
      chk(firsts.every(([, y]) => y === y0),
          `all five groups' first content starts level at ${y0}: ` +
          firsts.map(([n, y]) => `${n} ${y}`).join(", "));
      chk(y0 > c.PAGE_TOP,
          `the groups' first content starts below the back band: ${y0} > PAGE_TOP ${c.PAGE_TOP}`);
    }
    // THE BACK BAND'S TITLE IS ML_DATUM at BACK_BTN_X0 + BACK_BTN_W + BACK_TITLE_DX
    // and drawn at T_HEAD, so it is measured against the panel's right edge rather
    // than centred between two keys the way the pager's is. It is also the same
    // string HOME's row name uses, so one table has to fit two lanes.
    {
      const tx = c.PAGER_BTN_X0 + c.BACK_BTN_W + c.BACK_TITLE_DX;
      chk(c.BACK_TITLE_DX >= c.SP_3,
          `back band: the title is ${c.BACK_TITLE_DX}px clear of the key, at least SP_3 ${c.SP_3}`);
      // LEFT-ANCHORED, unlike the pager's centred title: the band's one key and its
      // title are a pair, and a title drifting toward the middle stops reading as
      // the label ON that key and starts reading as a heading of its own.
      chk(tx < Math.floor(W / 2),
          `back band: the title starts ${tx}, left of the panel's midpoint ${Math.floor(W / 2)}`);
      for (const t of GROUP_TITLES) {
        const w = widthB(b, T_HEAD, t);
        chk(tx + w <= W - c.PAGER_BTN_X0,
            `back band title "${t}" ${w}px ends ${tx + w - 1} inside the panel (${W - c.PAGER_BTN_X0 - 1})`);
      }
      // VERTICAL bound, absent until now (the retired page-dot assertion carried
      // one; the three above are all horizontal). ML_DATUM shares MC_DATUM's
      // vertical bias - only the horizontal alignment differs between the two -
      // so mcBox gives the real ink box the title paints, centred in the band at
      // CONTENT_Y + PAGER_H/2. It must land inside the band itself, or the title
      // clips against the tab bar above or the group body below.
      const titleY = c.CONTENT_Y + Math.floor(c.PAGER_H / 2);
      const [vTop, vBot] = mcBox(b, T_HEAD, titleY);
      chk(vTop >= c.CONTENT_Y && vBot <= c.CONTENT_Y + c.PAGER_H - 1,
          `back band title ink ${vTop}..${vBot} inside the band ${c.CONTENT_Y}..${c.CONTENT_Y + c.PAGER_H - 1}`);
    }
    // HOME's row: name at T_HEAD and summary at T_META share the row's text column,
    // which ends where the chevron begins. The chevron is MR_DATUM at
    // CARD_X + CARD_W - PAD, so its ink starts one T_HEAD advance left of that -
    // and the summary is drawn PADDED to HOME_SUB_CHARS, so the width that has to
    // fit is the pad, not whichever string happens to be longest today.
    {
      const lane = (c.CARD_X + c.CARD_W - c.PAD - advanceB(b, T_HEAD)) - (c.CARD_X + c.PAD);
      const subW = c.HOME_SUB_CHARS * advanceB(b, T_META);
      console.log(`  HOME row: text lane ${lane}px, padded summary ${c.HOME_SUB_CHARS} chars = ${subW}px`);
      chk(subW <= lane,
          `HOME's padded summary ${subW}px fits the lane left of the chevron (${lane}px)`);
      for (const t of GROUP_TITLES)
        chk(widthB(b, T_HEAD, t) <= lane, `HOME row name "${t}" ${widthB(b, T_HEAD, t)}px fits the ${lane}px lane`);
      // The cache is what drawIfChanged COMPARES, so it has to hold the padded
      // string plus its NUL - a cache shorter than its string silently stops
      // noticing changes past its end. Parsed from the declaration, not restated:
      // homeSubCache[][] must be declared with HOME_SUB_BYTES itself.
      chk(SET_CACHE.homeSubCache === "HOME_SUB_BYTES",
          `homeSubCache is declared [${SET_CACHE.homeSubCache}], i.e. the header's own HOME_SUB_BYTES`);
      chk(c.HOME_SUB_BYTES >= c.HOME_SUB_CHARS + 1,
          `HOME_SUB_BYTES ${c.HOME_SUB_BYTES} holds ${c.HOME_SUB_CHARS} chars + NUL`);
      // Every summary this device can COMPOSE, at its own worst case, measured
      // against the pad it is truncated to. A summary longer than the pad is not a
      // spill - it is a silent truncation mid-word, which reads as a wrong reading.
      for (const t of HOME_SUMMARIES)
        chk(t.length <= c.HOME_SUB_CHARS,
            `HOME summary "${t}" is ${t.length} of the ${c.HOME_SUB_CHARS} characters the row pads to`);
    }
  }

  // ================= SETTINGS page 0: the DEVICE card (board 1) =================
  // BOARD 1 KEEPS THIS PAGE. Board 2's STATUS group replaced the DEVICE and LINK
  // cards with three of its own and moved the per-Mac rows to Pairing, so it
  // declares none of DEV_CARD_*, DROW_*, CONN_TEXT_* or MAC_ROW_W any more -
  // running this arm there would compare against undefined and report NaN, which
  // LOOKS like a layout failure and is a parse gap. The two arms are separate
  // assertions, not one loop with holes in it, the same split page 1 already makes.
  if (b === 1) {
    // BANDS ARE WHAT A ROW ACTUALLY PAINTS, at each board's OWN cell height - not at
    // the 13px this file used to assume for both. Three different rectangles are in
    // play and they are not interchangeable, which is why they come from named
    // helpers now (geom-common.mjs) rather than from arithmetic inline here:
    //   - tlBox: a plain drawString's opaque box, y..y+cellH-1
    //   - mcBox: the same box under MC_DATUM, which centres on the ASCENT and so
    //            sits floor(descent/2) rows LOW of a symmetric centre
    //   - fieldBox: a drawIfChanged field, the UNION of its erase rect (which
    //            centres on the CELL) and the drawString box inside it
    // A connection row is drawConnRow(): fillRect(xRight-CONN_TEXT_W, y, CONN_TEXT_W,
    // CONN_TEXT_H) plus a 13px dot at y+8; the battery reading is a fieldBox at
    // y+DROW_BATT_VAL_DY; ID is a tlBox; the two Mac rows are fieldBoxes.
    const devRows = [
      ["label", tlBox(b, T_META, 6)],
      ["bluetooth", [c.DROW_BT, c.DROW_BT + c.CONN_TEXT_H - 1]],
      ["usb", [c.DROW_USB, c.DROW_USB + c.CONN_TEXT_H - 1]],
      ["battery", (() => {
        const lbl = tlBox(b, T_BODY, c.DROW_BATT);
        const val = fieldBox(b, T_META, c.DROW_BATT + c.DROW_BATT_VAL_DY);
        return [Math.min(lbl[0], val[0], c.DROW_BATT + 1), Math.max(lbl[1], val[1], c.DROW_BATT + 14)];
      })()],
      ["device id", tlBox(b, T_META, c.DROW_ID)],
      ["mac row 0", fieldBox(b, T_META, c.DROW_MAC0)],
      ["mac row 1", fieldBox(b, T_META, c.DROW_MAC1)],
    ];
    // A LIST OF CARDS rather than one card inline, because page 0 is a stack: the
    // walk below has to hold for every card on it, not just the first, and a second
    // card whose row rhythm drifted from the one above it is the failure "the same
    // style" has to be able to catch.
    const cards = [["DEVICE", c.DEV_CARD_Y, c.DEV_CARD_H, devRows]];
    for (const [cname, cy, ch, rows] of cards) {
      console.log(`  ${cname} card ${cy}..${cy + ch - 1} (h ${ch}):`);
      for (const [n, [a, z]] of rows) console.log(`    ${n.padEnd(10)} +${a}..+${z}`);
      for (let i = 1; i < rows.length; i++) {
        const gap = rows[i][1][0] - rows[i - 1][1][1] - 1;
        chk(gap >= 0, `${cname} card: ${rows[i - 1][0]} -> ${rows[i][0]} gap ${gap} (negative = a paint box eats its neighbour)`);
      }
      chk(rows[0][1][0] >= 2, `${cname} card: label starts +${rows[0][1][0]} inside the interior (border owns +0..+1)`);
      const ceil = ch - 3, last = Math.max(...rows.map(x => x[1][1]));
      chk(last <= ceil, `${cname} card: last band ends +${last} <= +${ceil} (2px border owns +${ch - 2}..+${ch - 1})`);
      chk(cy + ch <= contentBottom, `${cname} card ends ${cy + ch} inside the region (${contentBottom})`);
      chk(cy >= c.PAGE_TOP, `${cname} card starts ${cy}, at or below PAGE_TOP ${c.PAGE_TOP}`);
    }
    // THE WHOLE PAGE, which is what Task 8's card had to be paid for out of. Both
    // cards plus their gaps against the region, and trailing air stated rather than
    // implied: a card ending flush on contentBottom() reads as joined to the footer.
    {
      const lastCard = cards[cards.length - 1];
      const pageEnd = lastCard[1] + lastCard[2];
      const air = contentBottom - pageEnd;
      console.log(`  page 0: ${cards.length} card(s) ${cards[0][1]}..${pageEnd - 1} of ${c.PAGE_TOP}..${contentBottom}, ${air}px trailing air`);
      chk(air > 0, `page 0: last card ends ${pageEnd}, ${air}px above the footer (must be > 0)`);
    }
    {
      // The battery reading is right-aligned and padded to 15 characters
      // ("100% 4.20V ~99h"); "Battery" sits at CARD_X + PAD + 20.
      const readingW = widthB(b, T_META, "100% 4.20V ~99h");
      const xRight = c.CARD_X + c.CARD_W - c.PAD;
      const labelEnd = c.CARD_X + c.PAD + 20 + widthB(b, T_BODY, "Battery");
      chk(xRight - readingW > labelEnd, `battery reading ${readingW}px starts ${xRight - readingW}, "Battery" ends ${labelEnd}`);
      // DROW_BATT_VAL_DY, CONSTRAINED - and stated as the SHARED BASELINE rather than
      // as "the constant is 0", because that is the property a reader can see and it
      // is the one that survives the edits this is guarding against. The band walk
      // above cannot catch this on its own: the battery row is asserted as a UNION,
      // so a stagger merely widens the band and shrinks a legal gap. A pitch re-tune
      // moves both halves together and this stays quiet; restoring the old literal,
      // or bumping it "for symmetry with board 1", fires. It also fires if either
      // half's FONT changes, where a box-top or an is-it-zero test would not: both
      // are TL_DATUM, so their tops are y and their baselines are y + ascent, and two
      // faces with different ascents can share a top row while sitting visibly apart.
      const battDyForBaseline = ascentB(b, T_BODY) - ascentB(b, T_META);
      chk(c.DROW_BATT_VAL_DY === battDyForBaseline,
          `DROW_BATT_VAL_DY ${c.DROW_BATT_VAL_DY} puts the reading on the "Battery" label's own baseline ` +
          `(needs ${battDyForBaseline} = ascent ${ascentB(b, T_BODY)} - ${ascentB(b, T_META)})`);
      // BATT_ROW_CACHE, the BOARD's constant - not the parsed array size, which now
      // reads through a per-board name and would report one board's value for both.
      chk(c.BATT_ROW_CACHE >= 16, `BATT_ROW_CACHE ${c.BATT_ROW_CACHE} holds 15 chars + NUL`);
      // The trailing-label buffer, on BOTH boards: board 1 needs only the discharge
      // label, whose widest is "~119m".
      chk(c.BATT_LEFT_BYTES >= 6, `BATT_LEFT_BYTES ${c.BATT_LEFT_BYTES} holds "~119m" + NUL (6)`);
      // CONN_TEXT_W/H, measured, and this is the assertion whose absence let a 100px
      // box ship against a 104px string on board 2. The height must cover the CELL,
      // because the row's own drawString paints a full cell of opaque background.
      const notConn = widthB(b, T_BODY, "Not connected");
      chk(notConn <= c.CONN_TEXT_W, `"Not connected" ${notConn}px inside drawConnRow's ${c.CONN_TEXT_W}px erase box`);
      chk(c.CONN_TEXT_H >= lineHB(b, T_BODY), `CONN_TEXT_H ${c.CONN_TEXT_H} covers uiLineH(T_BODY) ${lineHB(b, T_BODY)}`);
      const connLabelEnd = c.CARD_X + c.PAD + 20 + widthB(b, T_BODY, "Bluetooth");
      chk(xRight - c.CONN_TEXT_W > connLabelEnd, `conn erase box starts ${xRight - c.CONN_TEXT_W}, "Bluetooth" ends ${connLabelEnd}`);
      // A Mac row's erase box always reserves the icon slot, used or not, and
      // renderMacLinkRows() sizes it from a MEASURED textWidth - so this multiplies
      // by the BOARD'S advance, not by 6.
      const macW = c.MAC_ROW_W * advanceB(b, T_META) + 4 + 13 + 2;
      chk(c.CARD_X + c.PAD + macW < c.CARD_X + c.CARD_W - 2,
          `mac row erase box ends ${c.CARD_X + c.PAD + macW} inside the card (${c.CARD_X + c.CARD_W - 2})`);
      const macWorst = c.MAC_ROW_W + 1 + 2 + 1;   // padded text + \x01 + icon id + NUL
      chk(+SET_CACHE.macRowCache >= macWorst, `macRowCache ${SET_CACHE.macRowCache} >= worst signature ${macWorst}`);
    }
  }

  // ================= SETTINGS: the STATUS group (board 2) =================
  // THREE CARDS, and they are asserted the same way page 0's stack is: as CLEAR
  // BOXES rather than glyphs. Every value here goes through drawIfChanged, whose
  // erase rect is one row taller than the cell at each end - which is why the
  // printed gaps are not the differences between the ST_*_DY constants.
  if (b === 2) {
    const stCards = [["CONNECTION", c.ST_CONN_Y, c.ST_CONN_H],
                     ["POWER", c.ST_PWR_Y, c.ST_PWR_H],
                     ["HOST", c.ST_HOST_Y, c.ST_HOST_H]];
    const stEnd = stCards[2][1] + stCards[2][2];
    console.log(`  Status: ${stCards.map(x => `${x[0]} ${x[1]}..${x[1] + x[2] - 1}`).join(", ")}, ` +
                `${contentBottom - stEnd}px trailing air`);
    chk(stCards[0][1] >= c.PAGE_TOP,
        `Status: the first card starts ${stCards[0][1]}, at or below PAGE_TOP ${c.PAGE_TOP}`);
    for (let i = 1; i < stCards.length; i++)
      chk(stCards[i][1] >= stCards[i - 1][1] + stCards[i - 1][2],
          `Status card ${stCards[i][0]} starts ${stCards[i][1]}, clear of ${stCards[i - 1][0]} ` +
          `(ends ${stCards[i - 1][1] + stCards[i - 1][2] - 1})`);
    // Trailing air stated rather than implied: a card ending flush on
    // contentBottom() reads as joined to the footer, which board 1 shipped once.
    chk(contentBottom - stEnd > 0,
        `Status: the last card ends ${stEnd}, ${contentBottom - stEnd}px above the footer (must be > 0)`);
    // CONNECTION and POWER share ONE stack, so it is asserted once against BOTH
    // heights - that is what makes them the same component rather than two layouts
    // that happen to agree today.
    const stStack = [["caption", tlBox(b, T_META, c.ST_CAP_DY)],
                     ["headline", fieldBox(b, T_HEAD, c.ST_BIG_DY)],
                     ["detail 1", fieldBox(b, T_BODY, c.ST_L1_DY)],
                     ["detail 2", fieldBox(b, T_BODY, c.ST_L2_DY)]];
    const hostStack = [["caption", tlBox(b, T_META, c.ST_CAP_DY)],
                       ["row 1", fieldBox(b, T_BODY, c.ST_HOST_R1_DY)],
                       ["row 2", fieldBox(b, T_BODY, c.ST_HOST_R2_DY)]];
    for (const [cname, ch, rows] of [["CONNECTION", c.ST_CONN_H, stStack], ["POWER", c.ST_PWR_H, stStack],
                                     ["HOST", c.ST_HOST_H, hostStack]]) {
      for (const [n, [a, z]] of rows) console.log(`    ${cname} ${n.padEnd(9)} +${a}..+${z}`);
      for (let i = 1; i < rows.length; i++)
        chk(rows[i][1][0] > rows[i - 1][1][1],
            `${cname} card: ${rows[i - 1][0]} (+${rows[i - 1][1][1]}) and ${rows[i][0]} (+${rows[i][1][0]}) share no pixel row`);
      chk(rows[0][1][0] >= c.BORDER_CARD,
          `${cname} card: the caption starts +${rows[0][1][0]}, clear of the ${c.BORDER_CARD}px top border`);
      const last = Math.max(...rows.map(x => x[1][1]));
      chk(last <= ch - c.BORDER_CARD - 1,
          `${cname} card: the last line's clear box ends +${last} <= +${ch - c.BORDER_CARD - 1} ` +
          `(the border owns +${ch - c.BORDER_CARD}..+${ch - 1})`);
    }
    // EVERY FIELD IS PADDED, so what has to fit is the PAD - not whichever string
    // happens to be longest today. Ink must stop inside the card's own 2px border,
    // because drawString paints an opaque box and would rub the border out.
    {
      const inkR = c.CARD_X + c.CARD_W - c.BORDER_CARD - 1;
      const x0 = c.CARD_X + c.PAD;
      for (const [n, chars, id] of [["verdict", c.ST_VERDICT_CHARS, T_HEAD],
                                    ["headline", c.ST_BIG_CHARS, T_HEAD],
                                    ["detail", c.ST_LINE_CHARS, T_BODY]]) {
        const w = chars * advanceB(b, id);
        chk(x0 + w - 1 <= inkR,
            `Status ${n}: ${chars} padded chars = ${w}px ends ${x0 + w - 1}, inside the card's border at ${inkR + 1}`);
      }
      // The HOST card's two columns, left-aligned and right-aligned into one row.
      const hostL = x0 + c.ST_HOST_L_CHARS * advanceB(b, T_BODY);
      const hostR = c.CARD_X + c.CARD_W - c.PAD - c.ST_HOST_R_CHARS * advanceB(b, T_BODY);
      console.log(`    HOST columns: left ends ${hostL - 1}, right starts ${hostR}`);
      chk(hostL <= hostR,
          `HOST card: the left column ends ${hostL - 1}, clear of the right column at ${hostR}`);
    }
    // Every string this page can COMPOSE, at its own worst case, measured against
    // the pad it is truncated to - a string longer than its pad is not a spill, it
    // is a silent truncation mid-word, which reads as a wrong reading.
    for (const s of ST_VERDICTS)
      chk(s.length <= c.ST_VERDICT_CHARS,
          `Status verdict "${s}" is ${s.length} of the ${c.ST_VERDICT_CHARS} characters it pads to`);
    for (const s of ST_BIGS)
      chk(s.length <= c.ST_BIG_CHARS,
          `POWER headline "${s}" is ${s.length} of the ${c.ST_BIG_CHARS} characters it pads to`);
    for (const s of ST_DETAILS)
      chk(s.length <= c.ST_LINE_CHARS,
          `Status detail "${s}" is ${s.length} of the ${c.ST_LINE_CHARS} characters it pads to`);
    for (const s of ST_HOST_LEFT)
      chk(s.length <= c.ST_HOST_L_CHARS,
          `HOST left "${s}" is ${s.length} of the ${c.ST_HOST_L_CHARS} characters it pads to`);
    for (const s of ST_HOST_RIGHT)
      chk(s.length <= c.ST_HOST_R_CHARS,
          `HOST right "${s}" is ${s.length} of the ${c.ST_HOST_R_CHARS} characters it pads to`);
    // THE ESTIMATE LINE'S WORST CASE IS DERIVED FROM THE LABELS, not transcribed:
    // the sentence is built AROUND battLeftLabel()/battChargeLabel()'s own output
    // precisely so "~" (about) and ">=" (at least - a FLOOR, because the charge fit
    // extrapolates through the CV knee) are never rendered as one another, so the
    // labels are what set the width.
    {
      const dis = ["~119m", "~99h"], chg = ["topping up", ">=119m", ">=99h"];
      const estWorst = Math.max(...dis.map(l => `${l} left on battery`.length),
                                ...chg.map(l => l[0] === ">" ? `charging, ${l} to full`.length
                                                             : `charging, ${l}`.length));
      chk(c.ST_LINE_CHARS >= estWorst,
          `ST_LINE_CHARS ${c.ST_LINE_CHARS} holds the widest runtime estimate (${estWorst} chars)`);
      const labelWorst = [...dis, ...chg].reduce((a, l) => l.length > a.length ? l : a, "");
      chk(c.BATT_LEFT_BYTES >= labelWorst.length + 1,
          `BATT_LEFT_BYTES ${c.BATT_LEFT_BYTES} holds "${labelWorst}" + NUL (${labelWorst.length + 1})`);
    }
    // THE CACHES ARE PARSED FROM THEIR DECLARATIONS, not restated: each must be the
    // header's own *_BYTES for the field it holds, and that constant must hold the
    // pad plus its NUL. A cache shorter than its padded string silently stops
    // noticing changes past its end.
    {
      const CACHES = [["stVerdictCache", "ST_VERDICT_BYTES", c.ST_VERDICT_BYTES, c.ST_VERDICT_CHARS],
                      ["stLinksCache", "ST_LINE_BYTES", c.ST_LINE_BYTES, c.ST_LINE_CHARS],
                      ["stIdCache", "ST_LINE_BYTES", c.ST_LINE_BYTES, c.ST_LINE_CHARS],
                      ["stLeftCache", "ST_LINE_BYTES", c.ST_LINE_BYTES, c.ST_LINE_CHARS],
                      // The die-temp line is one of the POWER card's details now, so
                      // it pads and caches like the others rather than carrying a
                      // size of its own.
                      ["tempRowTextCache", "ST_LINE_BYTES", c.ST_LINE_BYTES, c.ST_LINE_CHARS],
                      ["stPayloadCache", "ST_HOST_L_BYTES", c.ST_HOST_L_BYTES, c.ST_HOST_L_CHARS],
                      ["stFlushCache", "ST_HOST_L_BYTES", c.ST_HOST_L_BYTES, c.ST_HOST_L_CHARS],
                      ["stUptimeCache", "ST_HOST_R_BYTES", c.ST_HOST_R_BYTES, c.ST_HOST_R_CHARS],
                      ["stMacsCache", "ST_HOST_R_BYTES", c.ST_HOST_R_BYTES, c.ST_HOST_R_CHARS]];
      for (const [cache, token, bytes, chars] of CACHES) {
        chk(SET_CACHE[cache] === token, `${cache} is declared [${SET_CACHE[cache]}], i.e. the header's own ${token}`);
        chk(bytes >= chars + 1, `${token} ${bytes} holds ${chars} chars + NUL`);
      }
      // battRowTextCache is SHARED with board 1 and sized per board, because the two
      // draw different strings: board 1's row carries the estimate on the same line,
      // board 2's POWER card gives it a line of its own.
      chk(c.BATT_ROW_CACHE >= c.ST_BIG_CHARS + 1,
          `BATT_ROW_CACHE ${c.BATT_ROW_CACHE} holds the POWER headline's ${c.ST_BIG_CHARS} chars + NUL`);
    }
  }

  // ================= SETTINGS: the PAIRING group (board 2) =================
  if (b === 2) {
    const pairEnd = c.P3_LIST_Y + (MAX_HOSTS - 1) * c.P3_ROW_STEP + c.P3_ROW_H - 1;
    console.log(`  Pairing: ANY at ${c.P3_ANY_Y}, ${MAX_HOSTS} Mac cards ${c.P3_LIST_Y}..${pairEnd} of ${contentBottom}`);
    chk(c.P3_ANY_CAP_Y >= c.PAGE_TOP,
        `Pairing: the first caption is at ${c.P3_ANY_CAP_Y}, at or below PAGE_TOP ${c.PAGE_TOP}`);
    // A caption's own text box must clear the control it heads - the same
    // constraint the DISPLAY and SOUND groups' captions answer to.
    chk(c.P3_ANY_CAP_Y + lineHB(b, T_META) - 1 < c.P3_ANY_Y,
        `Pairing: "ANSWER PROMPTS FROM" ends ${c.P3_ANY_CAP_Y + lineHB(b, T_META) - 1}, clear of the ANY row at ${c.P3_ANY_Y}`);
    chk(c.P3_LIST_CAP_Y >= c.P3_ANY_Y + c.H_ROW,
        `Pairing: "PAIRED MACS" at ${c.P3_LIST_CAP_Y}, clear of the ANY row (ends ${c.P3_ANY_Y + c.H_ROW - 1})`);
    chk(c.P3_LIST_CAP_Y + lineHB(b, T_META) - 1 < c.P3_LIST_Y,
        `Pairing: "PAIRED MACS" ends ${c.P3_LIST_CAP_Y + lineHB(b, T_META) - 1}, clear of the first card at ${c.P3_LIST_Y}`);
    chk(pairEnd < contentBottom, `Pairing: ${MAX_HOSTS} Macs end ${pairEnd}, inside the region (${contentBottom})`);
    chk(c.P3_ROW_STEP >= c.P3_ROW_H, `Pairing: rows do not overlap (step ${c.P3_ROW_STEP} >= height ${c.P3_ROW_H})`);
    chk(c.P3_ROW_H >= c.TAP_MIN, `a pairing row is a touch target: ${c.P3_ROW_H} >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.P3_X_W >= c.TAP_MIN, `the "forget" x zone (${c.P3_X_W}) clears TAP_MIN (${c.TAP_MIN})`);
    // THE ROW'S OWN STACK. The name is a plain drawString (tlBox); the state line
    // goes through drawIfChanged (fieldBox, a row taller at each end).
    {
      const nameBox = tlBox(b, T_BODY, c.P3_ROW_NAME_DY);
      const subBox = fieldBox(b, T_BODY, c.P3_ROW_SUB_DY);
      console.log(`    pairing row: name +${nameBox[0]}..+${nameBox[1]}, state +${subBox[0]}..+${subBox[1]} of ${c.P3_ROW_H}`);
      chk(nameBox[0] >= c.BORDER_CARD,
          `pairing row: the name starts +${nameBox[0]}, clear of the ${c.BORDER_CARD}px top border`);
      chk(nameBox[1] < subBox[0],
          `pairing row: the name (+${nameBox[1]}) and the state line (+${subBox[0]}) share no pixel row`);
      chk(subBox[1] <= c.P3_ROW_H - c.BORDER_CARD - 1,
          `pairing row: the state line's clear box ends +${subBox[1]} <= +${c.P3_ROW_H - c.BORDER_CARD - 1}`);
      // THE DOT TAKES NO y OF ITS OWN - it is centred on the name line, the same
      // "the icon's y IS its neighbouring text's y" rule every icon-beside-text
      // surface here uses - so this measures where that puts drawConnDot's own
      // fillRect (cy-r-1 .. cy+r+1).
      const dotCy = c.P3_ROW_NAME_DY + Math.floor(lineHB(b, T_BODY) / 2);
      chk(dotCy - c.P3_ROW_DOT_R - 1 >= c.BORDER_CARD && dotCy + c.P3_ROW_DOT_R + 1 <= c.P3_ROW_H - c.BORDER_CARD - 1,
          `pairing row: the live dot's box +${dotCy - c.P3_ROW_DOT_R - 1}..+${dotCy + c.P3_ROW_DOT_R + 1} inside the card's border`);
      chk(c.P3_ROW_TEXT_DX > 2 * c.P3_ROW_DOT_R + 1,
          `pairing row: the text column at +${c.P3_ROW_TEXT_DX} clears the dot's box (ends +${2 * c.P3_ROW_DOT_R + 1})`);
    }
    // WIDTHS. The state line is padded, so what has to fit is the pad; the "x" zone
    // is what it must stop short of, since a drawString's opaque box would
    // otherwise erase the glyph that forgets this Mac.
    {
      const textX = c.CARD_X + c.PAD + c.P3_ROW_TEXT_DX;
      const subW = c.P3_SUB_CHARS * advanceB(b, T_BODY);
      const xZoneL = c.CARD_X + c.CARD_W - c.P3_X_W;
      console.log(`    pairing state line ${c.P3_SUB_CHARS} chars = ${subW}px, ${textX}..${textX + subW - 1} against the x zone at ${xZoneL}`);
      chk(textX + subW - 1 < xZoneL,
          `pairing row: the state line ends ${textX + subW - 1}, clear of the "x" zone at ${xZoneL}`);
      for (const s of P3_SUBS)
        chk(s.length <= c.P3_SUB_CHARS,
            `pairing state "${s}" is ${s.length} of the ${c.P3_SUB_CHARS} characters it pads to`);
      chk(SET_CACHE.p3SubCache === "P3_SUB_BYTES",
          `p3SubCache is declared [${SET_CACHE.p3SubCache}], i.e. the header's own P3_SUB_BYTES`);
      chk(c.P3_SUB_BYTES >= c.P3_SUB_CHARS + 1,
          `P3_SUB_BYTES ${c.P3_SUB_BYTES} holds ${c.P3_SUB_CHARS} chars + NUL`);
      // THE "ONLY" TAG KEEPS ITS rightInset, which is the whole reason that
      // parameter exists: both it and the "x" are right-anchored, and without the
      // inset they were drawn on top of each other.
      const tagX = c.CARD_X + c.CARD_W - (c.P3_X_W + c.SP_2);
      const xGlyphL = c.CARD_X + c.CARD_W - Math.floor(c.P3_X_W / 2) - Math.floor(widthB(b, T_HEAD, "x") / 2);
      chk(tagX < xGlyphL, `pairing row: the ONLY tag ends ${tagX}, clear of the "x" at ${xGlyphL}`);
      // The name is fitText'd into whatever is left, so what has to be asserted is
      // that anything is left: a lane too short for a useful name would show every
      // Mac as "..." with the disambiguating suffix still attached.
      const nameLane = tagX - widthB(b, T_META, "ONLY") - c.SP_2 - textX;
      chk(nameLane >= 8 * advanceB(b, T_BODY),
          `pairing row: the name lane is ${nameLane}px beside an ONLY tag, at least 8 characters`);
      // The forget glyph's own ink, MC_DATUM at the row's middle.
      const [xt, xb] = mcBox(b, T_HEAD, Math.floor(c.P3_ROW_H / 2));
      chk(xt >= c.BORDER_CARD && xb <= c.P3_ROW_H - c.BORDER_CARD - 1,
          `pairing row: the "x" ink +${xt}..+${xb} inside the card's border`);
    }

    // ============ the WIRELESS-PAIRING panel and its way in ============
    //
    // CONFIRM ON THIS GLASS IS THE SECURITY PROPERTY. The pairing key is committed
    // by a person comparing two codes and tapping here, not by the Mac's proof -
    // any peer that completes the ECDH can compute that proof without ever seeing
    // the code. So these are not cosmetic bounds: a code that does not fit is a
    // code nobody can compare, and a CONFIRM tappable while invisible commits a key
    // nobody approved.

    // ---- the way in: PAIR NEW MAC in the list's next free row slot ----
    // THE PAIR IS THE POINT. Every slot a button can take must clear the footer AND
    // the slot for a full store must not - that second half is what pins the
    // "absence encodes full" argument to the geometry instead of leaving it in a
    // comment, and without it the button could quietly be given a home that also
    // exists at MAX_HOSTS, where there is no NVS slot to pair into.
    const slotFits = (n) => c.P3_LIST_Y + n * c.P3_ROW_STEP + c.H_ROW - 1 < contentBottom;
    console.log(`  PAIR NEW MAC: slot n ends ${[0, 1, 2, 3, 4].map(n =>
      c.P3_LIST_Y + n * c.P3_ROW_STEP + c.H_ROW - 1).join("/")} of ${contentBottom}`);
    for (let n = 0; n < MAX_HOSTS; n++)
      chk(slotFits(n), `PAIR NEW MAC fits the free slot at ${n} Mac(s): ends ` +
          `${c.P3_LIST_Y + n * c.P3_ROW_STEP + c.H_ROW - 1}, inside the region (${contentBottom})`);
    chk(!slotFits(MAX_HOSTS),
        `... and does NOT fit at ${MAX_HOSTS} Macs (ends ` +
        `${c.P3_LIST_Y + MAX_HOSTS * c.P3_ROW_STEP + c.H_ROW - 1}), which is how its ABSENCE ` +
        `encodes a full store - the same limit twice`);
    chk(c.H_ROW >= c.TAP_MIN, `PAIR NEW MAC is a touch target: H_ROW ${c.H_ROW} >= TAP_MIN ${c.TAP_MIN}`);
    chk(widthB(b, T_BODY, "PAIR NEW MAC") < c.CARD_W - 2 * c.PAD,
        `"PAIR NEW MAC" is ${widthB(b, T_BODY, "PAIR NEW MAC")}px inside the button's ` +
        `${c.CARD_W - 2 * c.PAD}px lane`);
    // The empty-list hint moved DOWN a slot, because the button is standing where it
    // used to be drawn.
    {
      const [ht, hb] = mcBox(b, T_META, c.P3_EMPTY_HINT_Y);
      chk(ht > c.P3_LIST_Y + c.H_ROW - 1,
          `the empty-list hint's ink starts ${ht}, clear of PAIR NEW MAC in slot 0 ` +
          `(ends ${c.P3_LIST_Y + c.H_ROW - 1})`);
      chk(hb < contentBottom, `... and ends ${hb}, inside the region (${contentBottom})`);
    }

    // ---- the panel: the code has to FIT, and it cannot be trimmed ----
    const codeW = widthB(b, T_HERO, "8".repeat(PAIR_CODE_DIGITS));
    console.log(`  pairing panel: ${PAIR_CODE_DIGITS} digits at T_HERO = ${codeW}px of ${W}`);
    chk(codeW <= W, `the ${PAIR_CODE_DIGITS}-digit code is ${codeW}px in a ${W}px panel - ` +
        `the one width on this screen that cannot be trimmed, since a code nobody can ` +
        `read is a code nobody can compare`);
    chk(codeW <= c.CARD_W, `... and inside the card lane too (${codeW} <= ${c.CARD_W}), so it ` +
        `sits on the same margins as everything else`);

    // ---- the panel's rhythm is a CHAIN, not six literals ----
    // A stack of independent offsets is a stack of constants no perturbation can
    // catch: the gaps here are wide enough that geom-sweep.mjs reported +-16 on
    // every one of them as harmless, and "harmless" is only true until someone
    // moves two at once. Each block is derived from the one above it, so a single
    // +-1 on ANY of them fails an identity - which is the standard this file sets
    // for a constant the repo has just added.
    chk(c.PAIR_HEAD_H === lineHB(b, T_HEAD),
        `pairing panel: PAIR_HEAD_H ${c.PAIR_HEAD_H} IS uiLineH(T_HEAD) ${lineHB(b, T_HEAD)}`);
    for (const [name, y, prev, cell, air] of [
      ["the state line", c.PAIR_STATE_Y, c.PAIR_TITLE_Y, c.PAIR_HEAD_H, c.PAIR_AIR_TITLE],
      ["the code", c.PAIR_CODE_Y, c.PAIR_STATE_Y, c.CODE_LINE_H, c.PAIR_AIR_STATE],
      ["the Mac's label", c.PAIR_LABEL_Y, c.PAIR_CODE_Y, c.HERO_LINE_H, c.PAIR_AIR_CODE],
      ["the countdown", c.PAIR_LEFT_Y, c.PAIR_LABEL_Y, c.CODE_LINE_H, c.PAIR_AIR_LABEL],
    ]) chk(y === prev + cell + air,
        `pairing panel: ${name} is at ${prev} + ${cell} + ${air} = ${prev + cell + air} (${y})`);
    // AND THE CLOSING TERM, which is the one that gives every gap above teeth.
    // Without it the chain is a derivation asserted against its own term: perturb
    // PAIR_TOP_AIR and every block below moves with it, so each step's identity
    // still holds. MEASURED - geom-sweep.mjs called PAIR_TOP_AIR, PAIR_AIR_STATE,
    // PAIR_AIR_CODE, PAIR_AIR_LABEL and PAIR_BTN_BOTTOM unguarded at +-16 with the
    // chain alone. The stack is pitched to LAND on a button row anchored from the
    // other end, so naming the surplus makes a +-1 on any one gap break this.
    chk(c.PAIR_LEFT_Y + c.CODE_LINE_H + c.PAIR_AIR_LEFT === c.PAIR_BTN_Y,
        `pairing panel: the stack lands exactly on the button row ` +
        `(${c.PAIR_LEFT_Y} + ${c.CODE_LINE_H} + ${c.PAIR_AIR_LEFT} == ${c.PAIR_BTN_Y})`);
    // ---- AND THE COVERAGE DOES NOT REST ON THAT ONE LINE ----
    // The closing term above constrains the SUM of the seven gaps, which is exactly
    // what geom-sweep.mjs (one constant at a time) exercises - so it looked like
    // full coverage while all six air constants failed through a single assertion,
    // and deleting that line unguarded every one of them at once. Two bindings from
    // different directions follow, each catching a class the other cannot.
    //
    // (1) A REDISTRIBUTION PRESERVES THE SUM. Move 24 out of the countdown's gap
    // and into PAIR_AIR_STATE and the identity above still holds while the ink
    // stack walks down the screen. The header names PAIR_AIR_LEFT as where this
    // panel's surplus lives, so that is asserted rather than described: the gap
    // that carries no ink must be strictly the largest, which a swap breaks.
    {
      const gaps = ["PAIR_TOP_AIR", "PAIR_AIR_TITLE", "PAIR_AIR_STATE", "PAIR_AIR_CODE",
                    "PAIR_AIR_LABEL", "PAIR_BTN_BOTTOM"];
      const worst = gaps.reduce((a, n) => (c[n] > c[a] ? n : a), gaps[0]);
      chk(c.PAIR_AIR_LEFT > c[worst],
          `pairing panel: the SURPLUS lives in PAIR_AIR_LEFT ${c.PAIR_AIR_LEFT}, strictly the ` +
          `largest gap (next is ${worst} ${c[worst]}) - a sum-preserving swap passes the ` +
          `landing identity above and fails here`);
    }
    // (2) THE BUTTON ROW IS BOUND TO THE ROW THAT OPENS THE PANEL, which anchors
    // PAIR_BTN_BOTTOM to something outside the chain entirely. PAIR NEW MAC is
    // drawn at p3RowY(hostCount), and at the last reachable slot that row OVERLAPPED
    // CONFIRM's rect - so the finger that opened the panel was resting on the button
    // that stores a key, and an impatient second tap committed a code nobody had
    // compared. (The assertion that used to sit near here -
    // PAIR_BTN_Y + H_BTN + PAIR_BTN_BOTTOM == contentBottom - is PAIR_BTN_Y's own
    // definition rearranged, so it holds by construction and binds nothing.)
    {
      const lastSlotY = c.P3_LIST_Y + (MAX_HOSTS - 1) * c.P3_ROW_STEP;
      chk(c.PAIR_BTN_Y + c.H_BTN <= lastSlotY,
          `pairing panel: the button row ends ${c.PAIR_BTN_Y + c.H_BTN - 1}, clear of PAIR NEW ` +
          `MAC's own last slot at ${lastSlotY}..${lastSlotY + c.H_ROW - 1} - so a second tap ` +
          `where the first one opened this panel can never land on CONFIRM`);
    }
    chk(c.PAIR_RESULT_Y === c.PAIR_CODE_Y + Math.floor((c.HERO_LINE_H - c.PAIR_HEAD_H) / 2),
        `pairing result: the verdict is centred in the band the code occupied ` +
        `(${c.PAIR_RESULT_Y})`);
    chk(c.PAIR_RESULT_SUB_Y === c.PAIR_RESULT_Y + c.PAIR_HEAD_H + c.PAIR_AIR_TITLE,
        `pairing result: its reason takes the panel's own title->state step ` +
        `(${c.PAIR_RESULT_SUB_Y})`);
    // The label buffer that every one of those blocks is sized against is the SAME
    // one HostPairing stores, parsed rather than transcribed: a label the panel can
    // hold but the store cannot (or the reverse) is a name truncated on one screen
    // and not the other.
    {
      const m = SRC_MAIN.match(/char label\[(\d+)\];/);
      chk(m != null && c.PAIR_LABEL_BYTES === +m[1],
          `PAIR_LABEL_BYTES ${c.PAIR_LABEL_BYTES} IS HostPairing::label's own ` +
          `char[${m ? m[1] : "?"}]`);
    }
    chk(c.P3_EMPTY_HINT_Y === c.P3_LIST_Y + c.P3_ROW_STEP + Math.floor(c.P3_ROW_H / 2),
        `the empty-list hint is centred in slot 1, one below PAIR NEW MAC ` +
        `(${c.P3_EMPTY_HINT_Y})`);

    // ---- the panel's blocks share no pixel row ----
    // As PAINTED extents, never as glyphs: drawString paints an opaque box, so two
    // blocks that merely look apart still erase each other. TC_DATUM is a TOP datum,
    // so fieldBox's default is the right rectangle for all five.
    {
      const blocks = [
        ["title", fieldBox(b, T_HEAD, c.PAIR_TITLE_Y)],
        ["state line", fieldBox(b, T_BODY, c.PAIR_STATE_Y)],
        ["the code", fieldBox(b, T_HERO, c.PAIR_CODE_Y)],
        ["the Mac's label", fieldBox(b, T_BODY, c.PAIR_LABEL_Y)],
        ["the countdown", fieldBox(b, T_BODY, c.PAIR_LEFT_Y)],
        ["CONFIRM / CANCEL", [c.PAIR_BTN_Y, c.PAIR_BTN_Y + c.H_BTN - 1]],
      ];
      console.log("    " + blocks.map(([n, [t, bo]]) => `${n} ${t}..${bo}`).join(", "));
      // THE TOP END, BOUND TO THE CLEAR drawPairPanelStatic ACTUALLY MAKES rather
      // than to the literal 0. `blocks[0][1][0] >= 0` stood here and could not fail:
      // PAIR_TITLE_Y is PAIR_TOP_AIR, a positive constant, so no perturbation the
      // sweep can make drives it negative - the ninth unfalsifiable assertion this
      // branch has now paid for. What it was standing in for is that every block
      // lands inside the region the panel CLEARS, and that rectangle is parsed out
      // of the draw site's own fillRect: the panel deliberately covers the tab bar
      // ("chrome drawn but dead is the bug fabVisible() is gated to avoid"), and
      // nothing asserted that until now. Narrow the clear to CONTENT_Y - the
      // plausible edit, since every other surface here starts there - and the title
      // at 40..63 is painted onto live tab-bar chrome, which this now names.
      {
        const call = /tft\.fillRect\(([^;]*?)\);/.exec(fnSrc(SETTINGS_INO, "drawPairPanelStatic"));
        const args = call ? call[1].split(",").map((a) => a.trim()) : [];
        const clearTop = args.length === 5 ? evalInt(args[1], c) : null;
        chk(clearTop === 0,
            `pairing panel: drawPairPanelStatic clears from y=${clearTop} - the panel covers ` +
            `the tab bar, so a tap can never reach chrome it has painted over`);
        chk(clearTop != null && blocks[0][1][0] >= clearTop,
            `pairing panel: the title starts ${blocks[0][1][0]}, inside the cleared region ` +
            `from ${clearTop}`);
      }
      for (let i = 1; i < blocks.length; i++)
        chk(blocks[i - 1][1][1] < blocks[i][1][0],
            `pairing panel: ${blocks[i - 1][0]} ends ${blocks[i - 1][1][1]}, clear of ` +
            `${blocks[i][0]} at ${blocks[i][1][0]}`);
      chk(blocks[blocks.length - 1][1][1] < contentBottom,
          `pairing panel: the button row ends ${blocks[blocks.length - 1][1][1]}, above the ` +
          `footer at ${contentBottom} - the panel stops there so the clock, the battery and ` +
          `the freshness stay live through a 120s window`);
    }

    // ---- the two buttons ----
    chk(c.PAIR_BTN_GAP === c.SP_3,
        `pairing panel: PAIR_BTN_GAP ${c.PAIR_BTN_GAP} IS SP_3 ${c.SP_3} - a header cannot ` +
        `name a constant from the file that includes it, so the restatement is bound here`);
    chk(2 * c.PAIR_BTN_W + c.PAIR_BTN_GAP === c.CARD_W,
        `pairing panel: two ${c.PAIR_BTN_W}px buttons plus ${c.PAIR_BTN_GAP} fill the card lane ` +
        `exactly (${2 * c.PAIR_BTN_W + c.PAIR_BTN_GAP} == ${c.CARD_W})`);
    chk(c.PAIR_BTN_W >= c.TAP_MIN && c.H_BTN >= c.TAP_MIN,
        `pairing panel: each button is ${c.PAIR_BTN_W}x${c.H_BTN}, over TAP_MIN ${c.TAP_MIN} both ways`);
    // CONFIRM sits at CARD_X and CANCEL at CARD_X + CARD_W - PAIR_BTN_W. Their hit
    // zones must not touch: a tap that lands on the wrong one either throws away an
    // exchange or commits a key.
    chk(c.CARD_X + c.PAIR_BTN_W <= c.CARD_X + c.CARD_W - c.PAIR_BTN_W,
        `pairing panel: CONFIRM's zone ends ${c.CARD_X + c.PAIR_BTN_W}, at or before CANCEL's ` +
        `starts ${c.CARD_X + c.CARD_W - c.PAIR_BTN_W}`);
    for (const lab of ["CONFIRM", "CANCEL"])
      chk(widthB(b, T_BODY, lab) < c.PAIR_BTN_W,
          `pairing panel: "${lab}" is ${widthB(b, T_BODY, lab)}px inside its ${c.PAIR_BTN_W}px button`);

    // ---- the countdown is the ONE change-only field, and its cache holds it ----
    // The widest string is the WINDOW's own length, derived from PAIR_WINDOW_MS
    // rather than transcribed: a longer window would otherwise outgrow the cache
    // silently, and a cache shorter than its string stops noticing changes at all.
    {
      const secs = Math.ceil(c.PAIR_WINDOW_MS / 1000);
      const longest = `${secs}s left`;
      chk(c.PAIR_LEFT_CHARS === longest.length,
          `pairing panel: PAIR_LEFT_CHARS ${c.PAIR_LEFT_CHARS} == "${longest}" (${longest.length}), ` +
          `derived from PAIR_WINDOW_MS ${c.PAIR_WINDOW_MS}`);
      chk(c.PAIR_LEFT_BYTES >= c.PAIR_LEFT_CHARS + 1,
          `PAIR_LEFT_BYTES ${c.PAIR_LEFT_BYTES} holds ${c.PAIR_LEFT_CHARS} chars + NUL`);
      chk(SETTINGS_CACHE.pairLeftCache === "PAIR_LEFT_BYTES",
          `pairLeftCache is declared [${SETTINGS_CACHE.pairLeftCache}], i.e. the header's own ` +
          `PAIR_LEFT_BYTES`);
      chk(widthB(b, T_BODY, longest) <= W,
          `pairing panel: "${longest}" is ${widthB(b, T_BODY, longest)}px in a ${W}px panel`);
      // The repaint signature: "<code>|<label>". Its buffer has to hold the worst
      // case or the panel stops repainting on a REPLACEMENT PAIRREQ - which derives
      // a NEW code, and showing the old one is the one failure this screen must not
      // have.
      // cacheSizes() only parses a single-token dimension, and this one is an
      // EXPRESSION, so the declaration is read here and evaluated against the same
      // two constants the firmware uses.
      const sigDecl = SETTINGS_INO.match(/char pairPanelSig\[([^\]]+)\]/);
      // evalInt() takes NUMBERS, so the two names are resolved first - from the
      // board header and from pairing.ino, never transcribed.
      const sigSize = sigDecl ? evalInt(sigDecl[1]
        .replace(/PAIR_CODE_DIGITS/g, String(PAIR_CODE_DIGITS))
        .replace(/PAIR_LABEL_BYTES/g, String(c.PAIR_LABEL_BYTES))) : NaN;
      const sigWorst = PAIR_CODE_DIGITS + 1 + (c.PAIR_LABEL_BYTES - 1) + 1;
      chk(sigDecl != null && sigSize >= sigWorst,
          `pairPanelSig is declared [${sigDecl ? sigDecl[1] : "?"}] = ${sigSize}, holding ` +
          `"<${PAIR_CODE_DIGITS} digits>|<label>" + NUL (${sigWorst}) - a signature cache too ` +
          `short stops noticing a REPLACEMENT PAIRREQ, and showing the old code is the one ` +
          `failure this screen must not have`);
    }

    // ---- the result screen ----
    {
      const rh = fieldBox(b, T_HEAD, c.PAIR_RESULT_Y);
      const rs = fieldBox(b, T_BODY, c.PAIR_RESULT_SUB_Y);
      console.log(`    result screen: verdict ${rh[0]}..${rh[1]}, reason ${rs[0]}..${rs[1]}`);
      chk(rh[0] >= 0 && rh[1] < rs[0] && rs[1] < contentBottom,
          `pairing result: verdict ${rh[0]}..${rh[1]} clear of the reason ${rs[0]}..${rs[1]}, ` +
          `both inside the panel (${contentBottom})`);
      for (const t of ["PAIRED WITH", "PAIRING FAILED"])
        chk(widthB(b, T_HEAD, t) <= W, `pairing result: "${t}" is ${widthB(b, T_HEAD, t)}px of ${W}`);
      for (const t of ["code did not match", "no free slots", "timed out", "cancelled"])
        chk(widthB(b, T_BODY, t) <= W, `pairing result: "${t}" is ${widthB(b, T_BODY, t)}px of ${W}`);
      chk(c.PAIR_RESULT_MS >= 1000,
          `pairing result: it dwells ${c.PAIR_RESULT_MS}ms, long enough to read`);
    }

    // ---- SOURCE: one predicate, read by the draw site AND the hit test ----
    // This codebase's classic defect is a control drawn under one condition and
    // hit-tested under another. Here that defect stores a pairing key nobody
    // approved, so a SECOND SPELLING of the condition is what is forbidden - not
    // merely avoided. Same shape as pair-crypto-check.mjs's own rule on
    // pairConfirmable().
    {
      const draw = fnSrc(SETTINGS_INO, "void drawPairPanelStatic");
      const hit = fnSrc(SETTINGS_INO, "void pairPanelTouch");
      const pred = fnSrc(SETTINGS_INO, "bool pairConfirmVisible");
      chk(draw.length > 100 && hit.length > 50 && pred.length > 10,
          `pairing panel: drawPairPanelStatic, pairPanelTouch and pairConfirmVisible are all found`);
      chk(/pairConfirmable\s*\(\s*\)/.test(pred) && !/pairPending|pairWindowOpen|pairProofOk/.test(pred),
          `pairing panel: pairConfirmVisible IS pairing.ino's own pairConfirmable(), not a second ` +
          `spelling of it`);
      for (const [n, body] of [["the draw site", draw], ["the hit test", hit]]) {
        chk(/pairConfirmVisible\s*\(\s*\)/.test(body),
            `pairing panel: ${n} gates CONFIRM on pairConfirmVisible()`);
        chk(!/pairPending|pairWindowOpen|pairProofOk|pairConfirmed/.test(body),
            `pairing panel: ${n} spells that condition NO OTHER WAY - a CONFIRM tappable while ` +
            `invisible commits a key nobody approved`);
      }
      // The verdict has to reach the GLASS before the dwell. On a shadow-buffered
      // board a message drawn and then slept on exists for zero frames while the
      // previous screen sits there - the farewell screens fixed this once already.
      const res = fnSrc(SETTINGS_INO, "void drawPairResult");
      chk(/tft\.flush\s*\(\s*\)/.test(res) && /delay\s*\(/.test(res) &&
          res.indexOf("tft.flush") < res.indexOf("delay("),
          `pairing result: it FLUSHES before it delays, not after`);
      // The panel absorbs both periodic repaints, the way the confirm dialog and the
      // reader do - without either, the settings page is painted over a code someone
      // is in the middle of comparing.
      chk(/if\s*\(\s*pairPanelActive\s*\)\s*return;/.test(fnSrc(SETTINGS_INO, "void renderSettingsTab")),
          `pairing panel: renderSettingsTab() absorbs the 1s settings repaint`);
      chk(/if\s*\(\s*pairPanelActive\s*\)\s*\{[^}]*renderFooter\s*\(\s*\)[^}]*return;\s*\}/
            .test(SRC_MAIN.replace(/^[ \t]*\/\/.*$/gm, "")),
          `pairing panel: handleLine() absorbs the ~5s host tick and keeps the footer live`);
      // The button and its hit test come from the SAME expression and the SAME
      // condition, which is what makes "absence encodes full" true of the tap zone
      // as well as of the pixels.
      const stat = fnSrc(SETTINGS_INO, "void drawHostsPageStatic");
      const touch = fnSpan(SETTINGS_INO, "void handleSettingsTouch");
      for (const [n, body] of [["drawn", stat], ["hit-tested", touch]]) {
        chk(/p3RowY\s*\(\s*hostCount\s*\)/.test(body),
            `PAIR NEW MAC is ${n} at p3RowY(hostCount), the list's own row expression`);
        chk(/hostCount\s*<\s*MAX_HOSTS/.test(body),
            `... and ${n} only while hostCount < MAX_HOSTS, so a full store offers no button ` +
            `AND claims no taps`);
      }
    }
  }

  // ================= SETTINGS page 1: steppers + toggles =================
  console.log(`  stepper card h ${c.STEPPER_CARD_H}, key ${c.STEP_BTN_SIZE} at +${c.STEP_BTN_TOP}`);
  chk(c.STEP_BTN_SIZE > c.TAP_MIN, `stepper key ${c.STEP_BTN_SIZE} > TAP_MIN ${c.TAP_MIN} (over it, not merely at it)`);
  chk(c.STEP_BTN_TOP >= 2 && c.STEP_BTN_TOP + c.STEP_BTN_SIZE <= c.STEPPER_CARD_H - 2,
      `stepper keys +${c.STEP_BTN_TOP}..+${c.STEP_BTN_TOP + c.STEP_BTN_SIZE - 1} inside the interior +2..+${c.STEPPER_CARD_H - 3}`);
  {
    // The MIDDLE column's bands, as PAINTED extents. The label is a plain MC
    // drawString (mcBox: low-biased by half the descent); the value goes through
    // drawIfChanged under MC_DATUM, whose erase rect centres on the CELL while its
    // drawString centres on the ASCENT - so its real extent is the UNION of the
    // two, which at T_HEAD is 28 rows on board 2 against a 24px cell. Modelling it
    // as the cell alone is what put the value's own opaque box one row into the bar.
    const mid = [
      ["label", mcBox(b, T_META, c.STEP_LABEL_CY)],
      ["value", fieldBox(b, T_HEAD, c.STEP_VALUE_CY, "M")],
      ["bar", [c.STEP_BAR_Y, c.STEP_BAR_Y + c.STEP_BAR_H - 1]],
    ];
    for (const [n, [a, z]] of mid) console.log(`    stepper ${n.padEnd(6)} +${a}..+${z}`);
    for (let i = 1; i < mid.length; i++) {
      const gap = mid[i][1][0] - mid[i - 1][1][1] - 1;
      chk(gap >= 0, `stepper: ${mid[i - 1][0]} -> ${mid[i][0]} gap ${gap}`);
    }
    chk(mid[0][1][0] >= 2, `stepper label starts +${mid[0][1][0]} inside the interior`);
    chk(mid[2][1][1] <= c.STEPPER_CARD_H - 3, `stepper bar ends +${mid[2][1][1]} clear of the 2px border at +${c.STEPPER_CARD_H - 2}`);
    // THE CARD IS SIZED BY WHICHEVER COLUMN IS TALLER, and on board 2 that stopped
    // being the key: the middle column needs mid[0].top..mid[2].bottom plus its own
    // pad, so assert the interior holds BOTH rather than only the key band.
    const keyBand = c.STEP_BTN_TOP + c.STEP_BTN_SIZE - 1;
    console.log(`    stepper key band +${c.STEP_BTN_TOP}..+${keyBand}, middle column +${mid[0][1][0]}..+${mid[2][1][1]}`);
    chk(keyBand <= c.STEPPER_CARD_H - 3, `stepper key ends +${keyBand} clear of the 2px border`);
    // The bar's lane must clear both keys, and the label must clear both hit
    // thirds - a tap meant to read the label must not step the value.
    const barX = c.CARD_X + c.PAD + c.STEP_BTN_SIZE + c.STEP_BAR_GAP;
    const barW = c.CARD_W - 2 * (c.PAD + c.STEP_BTN_SIZE + c.STEP_BAR_GAP);
    chk(barX > c.CARD_X + c.PAD + c.STEP_BTN_SIZE - 1, `bar starts ${barX} right of the left key (ends ${c.CARD_X + c.PAD + c.STEP_BTN_SIZE - 1})`);
    chk(barX + barW <= c.CARD_X + c.CARD_W - c.PAD - c.STEP_BTN_SIZE, `bar ends ${barX + barW - 1} left of the right key`);
    const hitL = c.CARD_X + Math.floor(c.CARD_W / 3), hitR = c.CARD_X + Math.floor(c.CARD_W * 2 / 3);
    // MEASURED at the board's own advance. The label has to clear BOTH hit thirds,
    // or a tap meant to read it steps the value it names - and the dead band is
    // only hitR-hitL wide, so this is the assertion that caps how long a stepper
    // label may be (12 characters on board 2 at 8px, in a 99px band).
    for (const l of STEP_LABELS) {
      const w = widthB(b, T_META, l), x0 = Math.floor(W / 2 - w / 2);
      chk(x0 >= hitL && x0 + w < hitR, `stepper label "${l}" ${w}px spans ${x0}..${x0 + w} inside the dead band ${hitL}..${hitR}`);
    }
    const labelCap = Math.floor((hitR - hitL) / advanceB(b, T_META));
    console.log(`    stepper label lane: dead band ${hitR - hitL}px = ${labelCap} chars at ${advanceB(b, T_META)}px`);
    for (const l of STEP_LABELS) chk(l.length <= labelCap, `stepper label "${l}" is ${l.length} of the ${labelCap} characters the dead band holds`);
    // The VALUE is padTo(5) and drawn in T_HEAD, so its box is 5 advances wide even
    // when the text is shorter - which is the width that has to clear the thirds.
    for (const v of ["100%", "never", "LOUD"]) {
      const w = widthB(b, T_HEAD, v.padStart(5));
      const x0 = Math.floor(W / 2 - w / 2);
      chk(x0 >= hitL, `stepper value "${v}" ${w}px starts ${x0}, clear of the left hit third (${hitL})`);
      chk(x0 + w < hitR, `stepper value "${v}" ends ${x0 + w}, clear of the right hit third (${hitR})`);
    }
  }
  // ================= SETTINGS page 1: the stepper page and what board 2 split it into ===
  // BOARD 1 KEEPS THE FOUR-ROW PAGE: three steppers and a row of three third-width
  // toggles. Board 2 no longer declares P1_VOL_Y, P1_SOUND_Y, P1_SOUND_H, P1_THIRD_W,
  // P1_FLIP_X or P1_THEME_X at all - VOLUME and SOUND moved to their own group - so
  // running this arm there would compare against undefined and report NaN, which
  // LOOKS like a failure and is a parse gap. The two arms are separate assertions,
  // not one loop with holes in it.
  if (b === 1) {
    {
      const rows = 3 * c.STEPPER_CARD_H + c.P1_SOUND_H;
      const used = c.P1_TOP + rows + 3 * c.P1_GAP;
      const below = region - used;
      console.log(`  page 1: ${rows}px of rows + ${c.P1_TOP} top + 3x${c.P1_GAP} = ${used} of ${region}, ${below} below`);
      chk(below > 0, `page 1: toggle row ends ${c.P1_SOUND_Y + c.P1_SOUND_H}, ${below}px above the footer (must be > 0, or MUTE/NORMAL/LIGHT read as the status line)`);
      // THE ASSERTION ABOVE TESTS A RE-DERIVED TOTAL, NOT THE ROWS THE DEVICE ACTUALLY
      // DRAWS AT, and that is exactly the gap geom-sweep.mjs found: P1_BRIGHT_Y,
      // P1_SLEEP_Y, P1_VOL_Y and P1_SOUND_Y are the four y's every draw site and hit
      // test uses, and all four could move 16px with nothing failing, because `used`
      // is computed from P1_TOP/P1_GAP instead. Same shape as the page-2 chain the
      // preprocessor-blind parser used to mis-read: a sum that agrees with the layout
      // only as long as nobody breaks the chain. So the chain itself is pinned, and
      // the last row's own bottom edge - the thing the message claims - is asserted.
      const p1Y = [c.P1_BRIGHT_Y, c.P1_SLEEP_Y, c.P1_VOL_Y, c.P1_SOUND_Y];
      const p1H = [c.STEPPER_CARD_H, c.STEPPER_CARD_H, c.STEPPER_CARD_H, c.P1_SOUND_H];
      const p1N = ["BRIGHTNESS", "SLEEP AFTER", "VOLUME", "SOUND/FLIP/THEME"];
      chk(p1Y[0] === c.PAGE_TOP + c.P1_TOP, `page 1: ${p1N[0]} at ${p1Y[0]} == PAGE_TOP + P1_TOP (${c.PAGE_TOP + c.P1_TOP})`);
      for (let i = 1; i < 4; i++)
        chk(p1Y[i] === p1Y[i - 1] + p1H[i - 1] + c.P1_GAP,
            `page 1: ${p1N[i]} at ${p1Y[i]} == ${p1N[i - 1]} (${p1Y[i - 1]}) + ${p1H[i - 1]} + gap ${c.P1_GAP}`);
      chk(p1Y[3] + p1H[3] <= contentBottom,
          `page 1: the toggle row's own bottom edge ${p1Y[3] + p1H[3]} is inside the region (${contentBottom})`);
      chk(c.P1_GAP <= c.P1_SOUND_H, `page 1 gap ${c.P1_GAP} <= its shortest row ${c.P1_SOUND_H} (a wider gap stops reading as one list)`);
      chk(c.P1_SOUND_H >= c.TAP_MIN, `toggle row ${c.P1_SOUND_H} >= TAP_MIN ${c.TAP_MIN}`);
      // THE THREE CONTROLS THEMSELVES, measured from the constants the draw sites and
      // the hit tests actually use (CARD_X / P1_FLIP_X / P1_THEME_X, each P1_THIRD_W
      // wide - settings.ino lines 263/267/281 and the three touch branches). Only a
      // locally re-derived `third` was checked before, so all three constants were
      // unread by any checker: SOUND, FLIPPED and the theme button could have
      // overlapped each other or run off the card and nothing would have said so.
      // They are also the touch boundaries - `sx < P1_FLIP_X`, `sx < P1_THEME_X`,
      // `sx >= P1_THEME_X` - so a control overlapping its neighbour is a tap landing
      // on the wrong setting, not merely a cosmetic collision.
      const third = Math.floor((c.CARD_W - 16) / 3);
      chk(c.P1_THIRD_W === third, `P1_THIRD_W ${c.P1_THIRD_W} == floor((CARD_W - 16) / 3) = ${third}`);
      const cols = [["SOUND", c.CARD_X], ["FLIP", c.P1_FLIP_X], ["THEME", c.P1_THEME_X]];
      for (let i = 1; i < cols.length; i++)
        chk(cols[i][1] >= cols[i - 1][1] + c.P1_THIRD_W,
            `toggle row: ${cols[i][0]} starts ${cols[i][1]}, clear of ${cols[i - 1][0]} ending ${cols[i - 1][1] + c.P1_THIRD_W - 1}`);
      chk(cols[2][1] + c.P1_THIRD_W <= c.CARD_X + c.CARD_W,
          `toggle row: THEME ends ${cols[2][1] + c.P1_THIRD_W - 1}, inside the card's right edge (${c.CARD_X + c.CARD_W - 1})`);
      chk(c.P1_THIRD_W >= c.TAP_MIN, `toggle ${c.P1_THIRD_W}px wide >= TAP_MIN ${c.TAP_MIN}`);
      // MEASURED at the board's advance, and against T_TITLE - which is the id
      // uiButton actually sets, not T_BODY. They alias today on both boards; naming
      // the real one is what makes the T_TITLE -> T_HEAD migration fail here.
      for (const t of TOGGLES) chk(widthB(b, 2, t) + 8 <= c.P1_THIRD_W, `toggle label "${t}" ${widthB(b, 2, t)}px inside a ${c.P1_THIRD_W}px third`);
      // uiButton centres its label with MC_DATUM at y + h/2, and MC_DATUM biases the
      // box LOW - so a label in an exactly-sized control overflows the bottom before
      // it overflows the top. Both edges, against the row's own height.
      {
        const [t0, t1] = mcBox(b, 2, Math.floor(c.P1_SOUND_H / 2));
        const bias = Math.floor(lineHB(b, 2) / 2) - Math.floor(ascentB(b, 2) / 2);
        chk(t0 >= 0 && t1 <= c.P1_SOUND_H - 1,
            `toggle label box +${t0}..+${t1} inside the ${c.P1_SOUND_H}px row (MC_DATUM biases it ${bias}px low)`);
      }
    }
  } else {
    // ---------------- board 2: the DISPLAY group ----------------
    // Two steppers, a caption, three theme segments, the AUTO hint, the flip toggle.
    // THE BLOCKS ARE LAID OUT AND WALKED, not summed: a re-derived total agrees with
    // the layout only for as long as nobody breaks the chain, which is the gap
    // geom-sweep.mjs found in the arm above. Every band here is what the control
    // actually PAINTS - mcBox for the hint, because uiHint centres on the ASCENT and
    // so sits low of a symmetric centre by half the descent.
    const disp = [
      ["BRIGHTNESS", c.P1_BRIGHT_Y, c.P1_BRIGHT_Y + c.STEPPER_CARD_H - 1],
      ["SLEEP AFTER", c.P1_SLEEP_Y, c.P1_SLEEP_Y + c.STEPPER_CARD_H - 1],
      ["THEME caption", ...tlBox(b, T_META, c.P1_THEME_CAP_Y)],
      ["theme segments", c.P1_THEME_Y, c.P1_THEME_Y + c.H_ROW - 1],
      ["AUTO hint", ...mcBox(b, T_META, c.P1_AUTO_HINT_Y)],
      ["flip toggle", c.P1_FLIP_Y, c.P1_FLIP_Y + c.H_ROW - 1],
    ];
    for (const [n, a, z] of disp) console.log(`    Display ${n.padEnd(15)} ${a}..${z}`);
    chk(disp[0][1] === c.PAGE_TOP + c.P1_TOP,
        `Display: BRIGHTNESS at ${disp[0][1]} == PAGE_TOP + P1_TOP (${c.PAGE_TOP + c.P1_TOP})`);
    for (let i = 1; i < disp.length; i++)
      chk(disp[i][1] > disp[i - 1][2],
          `Display: ${disp[i][0]} starts ${disp[i][1]}, clear of ${disp[i - 1][0]} ending ${disp[i - 1][2]}`);
    // The Display group's last control must clear the footer.
    const dispEnd = c.P1_FLIP_Y + c.H_ROW - 1;
    chk(dispEnd < contentBottom, `Display's flip toggle clears the footer: ${dispEnd} < ${contentBottom}`);
    // The three theme segments fit the card with their gaps, and each is still a
    // touch target - they are also the touch boundaries (the hit test divides by
    // the PITCH), so a segment wider than its share is a tap landing on the wrong
    // theme, not merely a cosmetic overlap.
    const segTotal = 3 * c.P1_THEME_SEG_W + 2 * c.P1_THEME_GAP;
    chk(segTotal <= c.CARD_W, `three theme segments fit the card: ${segTotal} <= ${c.CARD_W}`);
    chk(c.P1_THEME_SEG_W >= c.TAP_MIN, `a theme segment is tappable: ${c.P1_THEME_SEG_W} >= ${c.TAP_MIN}`);
    // THE FIT ASSERTION ABOVE CANNOT SEE A CHANGE TO THE GAP, and geom-sweep.mjs
    // said so: P1_THEME_SEG_W is DERIVED from P1_THEME_GAP, so widening the gap
    // narrows the segments by exactly as much and the sum stays under the card.
    // What the gap actually decides is whether the row lands FLUSH on the card -
    // and it has to, because the flip toggle directly under it is CARD_W wide and a
    // theme row a few pixels short would read as a different, narrower control.
    chk(segTotal === c.CARD_W,
        `the theme row is flush with the card: 3x${c.P1_THEME_SEG_W} + 2x${c.P1_THEME_GAP} = ${segTotal} == ${c.CARD_W}`);
    // And that the gap exists at all: a filled segment abutting an outlined one
    // with no air between them reads as one control, which is the whole thing three
    // segments are for.
    chk(c.P1_THEME_GAP >= c.SP_1,
        `theme segments are separated: gap ${c.P1_THEME_GAP} >= SP_1 ${c.SP_1}`);
    for (const t of THEME_SEGS)
      chk(widthB(b, 2, t) + 8 <= c.P1_THEME_SEG_W,
          `theme segment label "${t}" ${widthB(b, 2, t)}px inside a ${c.P1_THEME_SEG_W}px segment`);
    // uiButton centres its label MC_DATUM and MC_DATUM biases the box LOW, so a
    // label overflows the bottom before the top. Both edges, on the full-width
    // flip toggle and on a segment - they share H_ROW, so one check covers both.
    {
      const [t0, t1] = mcBox(b, 2, Math.floor(c.H_ROW / 2));
      chk(t0 >= 0 && t1 <= c.H_ROW - 1,
          `theme/flip label box +${t0}..+${t1} inside the ${c.H_ROW}px row`);
    }

    // ---------------- board 2: the SOUND group ----------------
    const snd = [
      ["ALERTS caption", ...tlBox(b, T_META, c.PS_ALERTS_Y)],
      ["SOUND toggle", c.PS_SOUND_Y, c.PS_SOUND_Y + c.H_ROW - 1],
      ["what hint", ...mcBox(b, T_META, c.PS_WHAT_HINT_Y)],
      ["VOLUME stepper", c.PS_VOL_Y, c.PS_VOL_Y + c.STEPPER_CARD_H - 1],
      ["TEST BEEP", c.PS_BEEP_Y, c.PS_BEEP_Y + c.PS_BTN_H - 1],
      ["MIC caption", ...tlBox(b, T_META, c.PS_MIC_CAP_Y)],
      ["MIC TEST", c.PS_MIC_Y, c.PS_MIC_Y + c.PS_BTN_H - 1],
    ];
    for (const [n, a, z] of snd) console.log(`    Sound   ${n.padEnd(15)} ${a}..${z}`);
    chk(snd[0][1] === c.PAGE_TOP + c.PS_TOP,
        `Sound: the ALERTS caption at ${snd[0][1]} == PAGE_TOP + PS_TOP (${c.PAGE_TOP + c.PS_TOP})`);
    for (let i = 1; i < snd.length; i++)
      chk(snd[i][1] > snd[i - 1][2],
          `Sound: ${snd[i][0]} starts ${snd[i][1]}, clear of ${snd[i - 1][0]} ending ${snd[i - 1][2]}`);
    // The Sound group's last control must clear the footer.
    const soundEnd = c.PS_MIC_Y + c.PS_BTN_H - 1;
    chk(soundEnd < contentBottom, `Sound's last button clears the footer: ${soundEnd} < ${contentBottom}`);
    chk(c.PS_BTN_H >= c.TAP_MIN, `Sound's action buttons ${c.PS_BTN_H}px tall >= TAP_MIN ${c.TAP_MIN}`);
    // EACH CAPTION'S OWN TEXT BOX MUST CLEAR THE CONTROL IT HEADS. The equality
    // this replaced (`PS_SOUND_Y - PS_ALERTS_Y === SET_CAP_STEP`) was vacuous:
    // both sides are DERIVED in deckhand_display.ino as `<caption> + SET_CAP_STEP`,
    // so it holds by construction and cannot fail - proven by injection, shrinking
    // SET_CAP_STEP from 24 to 26 (or below the caption's own cell height) still
    // gave 0 failures. This binds the real geometry instead: the caption's ink,
    // not the formula that placed it, must end before its control begins.
    // THEME is deliberately NOT here: the Display walk above already asserts its
    // caption's own tlBox clears the segments, and a second copy of one constraint
    // is how a checker's count grows without its coverage doing the same.
    const capPairs = [
      ["ALERTS", c.PS_ALERTS_Y, c.PS_SOUND_Y],
      ["MICROPHONE", c.PS_MIC_CAP_Y, c.PS_MIC_Y],
    ];
    for (const [name, capY, controlY] of capPairs) {
      const capBottom = capY + lineHB(b, T_BODY) - 1;
      chk(capBottom < controlY,
          `"${name}" caption's own text box ends ${capBottom}, clear of its control starting ${controlY}`);
    }
    chk(c.SET_CAP_STEP > lineHB(b, T_META),
        `SET_CAP_STEP ${c.SET_CAP_STEP} clears the caption's own ${lineHB(b, T_META)}px cell`);
    // ONE STEP FOR ALL FOUR CAPTIONED CONTROLS ON THIS BOARD. P1_THEME_CAP_STEP was
    // a second name for the same concept and is gone; asserting the identity is
    // what makes re-introducing it fail here rather than merely look inconsistent.
    for (const [name, capY, controlY] of
         [["THEME", c.P1_THEME_CAP_Y, c.P1_THEME_Y],
          ["ALERTS", c.PS_ALERTS_Y, c.PS_SOUND_Y],
          ["MICROPHONE", c.PS_MIC_CAP_Y, c.PS_MIC_Y],
          ["SETUP", c.P2_SETUP_CAP_Y, c.P2_CAL_Y],
          ["CANNOT BE UNDONE", c.P2_DANGER_CAP_Y, c.P2_PAIR_Y]])
      chk(controlY - capY === c.SET_CAP_STEP,
          `"${name}" takes the one caption step: ${controlY - capY} == SET_CAP_STEP ${c.SET_CAP_STEP}`);
    // Captions are TL_DATUM at CARD_X + PAD; the labels go through uiButton.
    for (const t of SET_CAPTIONS)
      chk(c.CARD_X + c.PAD + widthB(b, T_META, t) <= c.CARD_X + c.CARD_W - c.PAD,
          `caption "${t}" ${widthB(b, T_META, t)}px inside the card's text lane`);
    for (const t of SOUND_LABELS)
      chk(widthB(b, 2, t) + 2 * c.SP_3 <= c.CARD_W,
          `full-width label "${t}" ${widthB(b, 2, t)}px inside the ${c.CARD_W}px control`);
    // Every hint is centred on the PANEL, so its lane is the panel, not the card.
    for (const t of SET_HINTS)
      chk(widthB(b, T_META, t) <= W - 8,
          `hint "${t}" ${widthB(b, T_META, t)}px inside the ${W}px panel`);
  }

  // ================= SETTINGS page 2: actions =================
  // BOARD 1 is a single evenly-gapped column of FOUR buttons; BOARD 2's Actions
  // group is two CAPTIONED sections of three, so the two are checked apart. An
  // assertion that still RESOLVES on the other board is worse than one that fails
  // there: the old chain walk (`P2_PAIR_Y === P2_CAL_Y + P2_BTN_H + P2_GAP`) holds
  // by construction on board 1 and would simply be FALSE on board 2 for a page
  // that is correct, which is the wrong kind of failure - it measures the formula
  // rather than the geometry.
  if (b === 1) {
    const hintY = c.P2_PWR_Y + c.P2_BTN_H + c.SP_3;
    const hintEnd = mcBox(b, T_META, hintY)[1];
    const p2 = [["MIC TEST", c.P2_MIC_Y], ["CALIBRATE", c.P2_CAL_Y],
                ["RESET PAIRING", c.P2_PAIR_Y], ["POWER OFF", c.P2_PWR_Y]];
    console.log(`  page 2: ${p2.length} buttons ${p2[0][1]}..${c.P2_PWR_Y + c.P2_BTN_H - 1} (h ${c.P2_BTN_H}), hint inks ..${hintEnd}`);
    chk(p2[0][1] === c.PAGE_TOP + c.P2_TOP, `page 2: ${p2[0][0]} at ${p2[0][1]} == PAGE_TOP + P2_TOP (${c.PAGE_TOP + c.P2_TOP})`);
    for (let i = 1; i < p2.length; i++)
      chk(p2[i][1] === p2[i - 1][1] + c.P2_BTN_H + c.P2_GAP,
          `page 2: ${p2[i][0]} at ${p2[i][1]} == ${p2[i - 1][0]} (${p2[i - 1][1]}) + ${c.P2_BTN_H} + gap ${c.P2_GAP}`);
    chk(hintEnd < contentBottom, `page 2 hint ends ${hintEnd} above the footer ${contentBottom}`);
    {
      const [t0, t1] = mcBox(b, T_META, hintY);
      chk(t1 < contentBottom, `page 2 hint box ${t0}..${t1} above the footer ${contentBottom}`);
    }
  } else {
    // ---------------- board 2: the ACTIONS group ----------------
    // Captions are drawn in T_META, which on this board is the SAME face as T_BODY
    // (Spleen 8x16 - see UI_FONTS), so the two measure identically here. T_META is
    // what the draw site passes, and a checker certifies what is drawn.
    //
    // P2_TOP AND P2_SETUP_CAP_Y ARE NO LONGER UNGUARDED. They are pure TRANSLATIONS
    // of the whole page, so no bound relative to this page can see them - which is
    // exactly why the "all five groups start level" assertion up in the HOME block
    // is where they are caught: any perturbation of P2_TOP breaks that equality,
    // in both directions, without needing a bound this page could supply.
    // (This note used to say the levelling rule "would fail today, so it is flagged
    // here rather than encoded" - correct at the time, and the reason the rule was
    // adopted was that a 4px jog between groups was nobody's decision.)
    // THREE buttons. MIC TEST moved to Sound, and P2_MIC_Y is GONE rather than
    // left unread - a constant a draw site no longer uses but a hit test still
    // does is exactly how a page comes to claim taps for a button it does not
    // draw, so its absence is asserted here and not merely described.
    chk(c.P2_MIC_Y === undefined,
        `board 2 has no P2_MIC_Y: MIC TEST lives on the Sound group (got ${c.P2_MIC_Y})`);
    const hintEnd = mcBox(b, T_META, c.P2_HINT_Y)[1];
    const act = [
      ["SETUP caption", ...tlBox(b, T_META, c.P2_SETUP_CAP_Y)],
      ["CALIBRATE TOUCH", c.P2_CAL_Y, c.P2_CAL_Y + c.P2_BTN_H - 1],
      ["danger caption", ...tlBox(b, T_META, c.P2_DANGER_CAP_Y)],
      ["RESET PAIRING", c.P2_PAIR_Y, c.P2_PAIR_Y + c.P2_BTN_H - 1],
      ["POWER OFF", c.P2_PWR_Y, c.P2_PWR_Y + c.P2_BTN_H - 1],
      ["hint", ...mcBox(b, T_META, c.P2_HINT_Y)],
    ];
    for (const [n, a, z] of act) console.log(`    Actions ${n.padEnd(16)} ${a}..${z}`);
    // NOT `=== PAGE_TOP + P2_TOP`, which is how the constant is DERIVED and so
    // could never fail. What bounds P2_TOP downward is the back band above it: the
    // page region opens at PAGE_TOP and a caption above that is drawn over the
    // band's own title.
    chk(c.P2_SETUP_CAP_Y >= c.PAGE_TOP,
        `Actions: the SETUP caption at ${c.P2_SETUP_CAP_Y} is at or below PAGE_TOP ${c.PAGE_TOP}`);
    // EVERY block clears the one above it, in the order they are drawn - the same
    // walk the Sound group uses, and the only one that can see a caption's own ink
    // running into the control it heads.
    for (let i = 1; i < act.length; i++)
      chk(act[i][1] > act[i - 1][2],
          `Actions: ${act[i][0]} starts ${act[i][1]}, clear of ${act[i - 1][0]} ending ${act[i - 1][2]}`);
    // The brief's own three bounds, stated against this board's constants rather
    // than against board 1's literals.
    const btns = [c.P2_CAL_Y, c.P2_PAIR_Y, c.P2_PWR_Y];
    for (let i = 1; i < btns.length; i++)
      chk(btns[i] >= btns[i - 1] + c.P2_BTN_H,
          `Actions button ${i} at ${btns[i]} clears button ${i - 1} ending ${btns[i - 1] + c.P2_BTN_H - 1}`);
    chk(c.P2_BTN_H >= c.TAP_MIN,
        `an action button is a touch target: ${c.P2_BTN_H} >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.P2_SETUP_CAP_Y + lineHB(b, T_META) - 1 < c.P2_CAL_Y,
        `the SETUP caption's own text box ends ${c.P2_SETUP_CAP_Y + lineHB(b, T_META) - 1}, clear of CALIBRATE at ${c.P2_CAL_Y}`);
    chk(c.P2_DANGER_CAP_Y + lineHB(b, T_META) - 1 < c.P2_PAIR_Y,
        `the danger caption's own text box ends ${c.P2_DANGER_CAP_Y + lineHB(b, T_META) - 1}, clear of RESET PAIRING at ${c.P2_PAIR_Y}`);
    chk(c.SET_CAP_STEP > lineHB(b, T_META),
        `SET_CAP_STEP ${c.SET_CAP_STEP} clears the caption's own ${lineHB(b, T_META)}px cell`);
    // THE DESTRUCTIVE PAIR MUST BE SEPARATED FROM THE SAFE ONE BY MORE THAN THE
    // GAP INSIDE A SECTION, or position stops being one of the three carriers of
    // severity and the page is back to four identical slabs in one column.
    // Measured on the DRAWN gap rather than by comparing the two constants, so it
    // also catches a caption moved on its own: what has to be true is that the air
    // between the safe section and the destructive one is wider than the air
    // between two buttons INSIDE a section, whatever placed it.
    {
      const sectionAir = c.P2_DANGER_CAP_Y - (c.P2_CAL_Y + c.P2_BTN_H);
      chk(sectionAir > c.P2_GAP,
          `the sections are separated: ${sectionAir}px between CALIBRATE and the danger caption > P2_GAP ${c.P2_GAP}`);
    }
    // ---- the severity spine, MEASURED AT ITS DRAW SITE ----
    // Every number below comes from drawSeverityAction()'s own uiFillRound(...)
    // arguments (SPINE_ARGS, parsed above), NOT from restating what the constants
    // would allow. The four assertions this replaced were all of the second kind and
    // the reviewer's mutation - uiFillRound(CARD_X, y, P2_SPINE_W, P2_BTN_H, ...) -
    // passed every one of them.
    {
      const sx = spineArg(c, 0), sy = spineArg(c, 1);
      const sw = spineArg(c, 2), sh = spineArg(c, 3), sr = spineArg(c, 4);
      // ANCHORING FIRST: an offset means nothing unless it is taken from the button's
      // own origin. Drawn at absolute coordinates the arithmetic below would still
      // pass on the first button and be wrong on the second.
      chk(/\bCARD_X\b/.test(SPINE_ARGS[0]) && /\by\b/.test(SPINE_ARGS[1]),
          `the spine is anchored on the button's own CARD_X and y ("${SPINE_ARGS[0]}", "${SPINE_ARGS[1]}")`);
      chk(sx - c.CARD_X >= c.BORDER_CTRL,
          `the spine is DRAWN ${sx - c.CARD_X}px inside the button's left edge, clear of its ${c.BORDER_CTRL}px stroke`);
      // The two ends are what the corner arcs threaten: inside R_MD of either end the
      // button's outline is curving in, so a bar drawn there paints over the very
      // stroke it exists to reinforce.
      chk(sy >= c.R_MD,
          `the spine is DRAWN starting +${sy}, below the top corner arc at R_MD ${c.R_MD}`);
      chk(sy + sh <= c.P2_BTN_H - c.R_MD,
          `the spine is DRAWN ending +${sy + sh}, above the bottom corner arc at ${c.P2_BTN_H - c.R_MD}`);
      chk(sw === c.P2_SPINE_W,
          `the spine is DRAWN P2_SPINE_W (${c.P2_SPINE_W}) wide, not a literal (${sw})`);
      // uiFillRound rounds the ends, and fillSmoothRoundRect can only draw a radius
      // that fits BOTH dimensions of the bar it is given - so this is the bound taken
      // against the DRAWN width and height rather than against what the constants
      // would have allowed. (The assertion this replaced compared floor(w/2)*2 with w,
      // which is true for every non-negative integer and could not fail.)
      chk(2 * sr <= sh, `the spine's DRAWN end radius ${sr} fits its ${sh}px height`);
      // THE TWO BOUNDS THAT PIN THE WIDTH AT +-1, and they are why they exist rather
      // than a range fitted to today's 4. geom-sweep.mjs reported P2_SPINE_W guarded
      // only at +-16: the pair below it allowed 2..11, so 3, 5 and 8 all passed while
      // the spine's ENTIRE justification is ink mass - it is the one control on this
      // device whose width IS its meaning. This repo's standard for a constant a
      // branch has just added is +-1 in both directions.
      //
      // Both are taken from the draw site's own claim: "its ends are rounded at
      // P2_SPINE_W / 2 so it reads as a deliberate mark rather than as a clipped
      // edge". That claim is only true of a STADIUM - two full semicircular caps -
      // and a stadium needs both:
      //   - a radius of at least BORDER_CARD, the heaviest structural stroke on the
      //     device. At r = 1 the "rounding" is a single anti-aliased pixel per
      //     corner, which is a clipped edge with an apology; this is what stops the
      //     bar being thinned to 3 or 2.
      //   - caps that MEET in the middle - 2r == w. An odd width leaves a flat
      //     between the two arcs, so the ends are not "rounded at P2_SPINE_W / 2" at
      //     all; this is what stops it being widened to 5.
      // Measured on the DRAWN radius and width, like every other number in this
      // block, so a draw site that hardcoded a radius fails here too.
      chk(sr >= c.BORDER_CARD,
          `the spine's DRAWN end radius ${sr} is a real arc, >= BORDER_CARD ${c.BORDER_CARD}`);
      chk(2 * sr === sw,
          `the spine's DRAWN caps are full semicircles that meet: 2 x ${sr} == ${sw}`);
      // NOT the corner bound - the y-inset above is what keeps the spine off the arcs,
      // and with it in place no WIDTH can reach one. What this constrains is that the
      // spine stays a MARK on the left edge rather than becoming a slab: no wider,
      // inset and all, than the button's own corner treatment.
      chk(c.P2_SPINE_W + c.BORDER_CTRL <= c.R_MD,
          `the spine stays a left-edge MARK rather than a slab: ${c.P2_SPINE_W} + ${c.BORDER_CTRL} inset <= R_MD ${c.R_MD}`);
      chk(c.P2_SPINE_W >= c.BORDER_CTRL * 2,
          `the spine outweighs the stroke it reinforces: ${c.P2_SPINE_W} >= 2 x BORDER_CTRL ${c.BORDER_CTRL}`);
      chk(sh >= sw, `the spine is taller than it is wide: ${sh} >= ${sw}`);
    }
    // The hint is centred on the PANEL, so its lane is the panel and not the card.
    // (A `<= W` assertion on one transcribed hint string used to sit here. It was
    // dead: the P2_HINTS loop below measures BOTH arms of the #if against the
    // stricter W - 8, so it can never have failed first, and its inline literal could
    // drift from the draw site with nothing noticing.)
    chk(hintEnd < contentBottom, `Actions' hint inks to ${hintEnd}, above the footer ${contentBottom}`);
    // THE HINT BELONGS TO POWER OFF, so it has to sit nearer the button it explains
    // than the footer it is not part of - proximity is what says which thing a note
    // is about, and this page has 48 rows of trailing air for it to drift into.
    // Bounding it only against contentBottom() would let it float to the bottom of
    // the page and read as page furniture. Measured on the INK at both ends, not on
    // the MC_DATUM centre, because the two disagree by half the descent.
    {
      const [hi0, hi1] = mcBox(b, T_META, c.P2_HINT_Y);
      const above = hi0 - (c.P2_PWR_Y + c.P2_BTN_H);
      const below = contentBottom - 1 - hi1;
      chk(above < below,
          `the hint is attached to POWER OFF, not to the footer: ${above} above < ${below} below`);
      // AND IT IS PINNED, not merely nearer. P2_HINT_Y is the LAST thing on this
      // page, which is exactly why it lost its guard: every other block on every
      // group is bounded from both sides by the walk above - clear of the thing
      // before it, cleared by the thing after it - and this one has nothing after
      // it but trailing air. The levelling that took P2_TOP 16 -> 12 gave the page
      // 8 more rows of that air and widened the `above < below` slack from 32 to
      // 40, at which point geom-sweep.mjs reported P2_HINT_Y unguarded at +-16 in
      // BOTH directions: a constant this branch had just moved.
      //
      // What pins it is the STEP a T_META label takes from the control it is bound
      // to. SET_CAP_STEP is that step everywhere else in this redesign - a
      // caption's own datum to the top of the control it heads - and the hint takes
      // the same step in the other direction, from POWER OFF's bottom to its own
      // MC_DATUM centre. Two things about that are stated rather than left to be
      // rediscovered:
      //   - THE DATUMS DIFFER, so this is a step-for-step equality and NOT an equal
      //     air gap. The danger caption's ink stops 8 rows above the button it
      //     heads; the hint's ink starts 18 rows below the button it explains. What
      //     the two share is the named offset, not the white space. Anyone who
      //     wants the INK equal instead has to move P2_HINT_GAP and re-derive this.
      //   - It is asserted against SET_CAP_STEP and deliberately NOT against
      //     P2_HINT_GAP, which is how P2_HINT_Y is DERIVED one file over. A
      //     derivation compared with its own term cannot fail - this branch shipped
      //     that shape twice and caught it twice - and routing through SET_CAP_STEP
      //     is also what makes P2_HINT_GAP guarded, since perturbing it moves the
      //     left side alone.
      const step = c.P2_HINT_Y - (c.P2_PWR_Y + c.P2_BTN_H);
      chk(step === c.SET_CAP_STEP,
          `the hint takes a caption's step from POWER OFF's bottom: ${step} == SET_CAP_STEP ${c.SET_CAP_STEP}`);
    }
    for (const l of ["CALIBRATE TOUCH", "RESET PAIRING", "POWER OFF"])
      chk(widthB(b, 2, l) + 2 * c.SP_3 + c.P2_SPINE_W <= c.CARD_W,
          `action label "${l}" ${widthB(b, 2, l)}px inside the ${c.CARD_W}px button beside its spine`);
  }
  // BOTH ARMS of #if BOARD_HAS_TOUCH_SLEEP_WAKE, on both boards. uiHint centres
  // with MC_DATUM on the panel, so the box is symmetric in x and the constraint is
  // the panel width - and the string board 2 draws is the one board 1 does not
  // compile, so checking only the touch-wake arm measured nothing about it.
  for (const h of P2_HINTS)
    chk(widthB(b, T_META, h) <= W - 8, `page 2 hint "...${h.slice(-18)}" ${widthB(b, T_META, h)}px inside the ${W}px panel`);
  for (const l of P2_LABELS)
    if (b === 1 || l !== "MIC TEST")
      chk(widthB(b, 2, l) + 2 * c.SP_3 <= c.CARD_W, `action label "${l}" ${widthB(b, 2, l)}px inside the ${c.CARD_W}px button`);

  // ================= SETTINGS page 3: paired Macs (board 1) =================
  // BOARD 1 ONLY. Board 2's Pairing group is two captions and a list of two-line
  // CARDS at P3_ROW_STEP, so nothing here derives from H_ROW + SP_1 any more - and
  // an assertion that still RESOLVES on the other board is worse than one that
  // fails there: at board 2's own P3_LIST_Y the row walk below passes while
  // measuring a layout that board no longer draws. Board 2's arm is under the
  // STATUS group above.
  if (b === 1) {
      const last = c.P3_LIST_Y + (MAX_HOSTS - 1) * (c.H_ROW + c.SP_1) + c.H_ROW;
      console.log(`  page 3: ANY at ${c.P3_ANY_Y}, ${MAX_HOSTS} Macs end ${last} of ${contentBottom}`);
      chk(last <= contentBottom, `page 3: ANY + ${MAX_HOSTS} Macs end ${last} inside the region (${contentBottom})`);
      chk(c.H_ROW >= c.TAP_MIN, `list row ${c.H_ROW} >= TAP_MIN ${c.TAP_MIN}`);
      // The ANY MAC row sits above the list and nothing separated the two: only the
      // list's own end was bounded, so P3_ANY_Y and P3_LIST_Y were both unguarded and
      // the first Mac row could have been drawn straight over "ANY MAC".
      chk(c.P3_ANY_Y >= c.PAGE_TOP, `page 3: ANY row at ${c.P3_ANY_Y}, at or below PAGE_TOP ${c.PAGE_TOP}`);
      chk(c.P3_LIST_Y >= c.P3_ANY_Y + c.H_ROW + c.SP_1,
          `page 3: list starts ${c.P3_LIST_Y}, clear of the ANY row (${c.P3_ANY_Y}..${c.P3_ANY_Y + c.H_ROW - 1}) plus SP_1`);
      chk(c.P3_X_W >= 40, `the "forget" x zone is ${c.P3_X_W}px wide`);
      // uiListRow's LABEL LANE, which nothing measured: the label is drawn at x+SP_3
      // with NO fitText, and the "ONLY" tag is right-aligned to x+w-rightInset where
      // drawHostsPageStatic passes P3_X_W + SP_2. hosts[].label is char[20], and the
      // row prepends "\xB7 ", so the widest row is 21 characters.
      const rowStr = "\xB7 " + "M".repeat(HOST_LABEL_MAX);
      const rowW = widthB(b, 2, rowStr);
      const tagX = c.CARD_X + c.CARD_W - (c.P3_X_W + c.SP_2) - widthB(b, T_META, "ONLY");
      chk(c.CARD_X + c.SP_3 + rowW < tagX,
          `page 3: widest row (${rowStr.length} chars, ${rowW}px) ends ${c.CARD_X + c.SP_3 + rowW}, clear of the ONLY tag at ${tagX}`);
      // The tag's own right edge against the "x", which is drawn MC at
      // CARD_X + CARD_W - P3_X_W/2 - that is the overlap rightInset exists to prevent.
      const xGlyphL = c.CARD_X + c.CARD_W - Math.floor(c.P3_X_W / 2) - Math.floor(widthB(b, 2, "x") / 2);
      chk(c.CARD_X + c.CARD_W - (c.P3_X_W + c.SP_2) < xGlyphL,
          `page 3: ONLY tag ends ${c.CARD_X + c.CARD_W - (c.P3_X_W + c.SP_2)}, clear of the "x" at ${xGlyphL}`);
      // The row's own label box, MC-biased low like every other centred label.
      {
        const [t0, t1] = mcBox(b, 2, Math.floor(c.H_ROW / 2));
        chk(t0 >= 0 && t1 <= c.H_ROW - 1, `page 3: row label box +${t0}..+${t1} inside the ${c.H_ROW}px row`);
      }
  }

  // ================= SETTINGS: the confirm dialog =================
  {
    const lane = c.CARD_W - 2 * c.SP_3;
    const top = c.CFM_Y + c.BORDER_CARD;
    const avail = c.CFM_BTN_Y - top;
    console.log(`  confirm ${c.CFM_Y}..${c.CFM_Y + c.CFM_H - 1}, buttons at ${c.CFM_BTN_Y} (${c.CFM_BTN_W}x${c.H_BTN}), text lane ${lane}px, ${avail}px above the buttons`);
    chk(c.CFM_Y + c.CFM_H <= contentBottom, `dialog ends ${c.CFM_Y + c.CFM_H} inside the region (${contentBottom})`);
    chk(c.CFM_BTN_Y + c.H_BTN <= c.CFM_Y + c.CFM_H - c.BORDER_CARD,
        `dialog buttons end ${c.CFM_BTN_Y + c.H_BTN} clear of the card's 2px border`);
    // wrapLineLen()'s 60-character ceiling, at the board's OWN advance - the lane
    // used to be divided by a literal 6 here, which is 45 characters of a 272px
    // board-2 lane that actually holds 34.
    const laneChars = Math.floor(lane / advanceB(b, T_META));
    console.log(`    lane holds ${laneChars} characters at ${advanceB(b, T_META)}px`);
    chk(laneChars <= 60, `dialog lane ${lane}px = ${laneChars} chars, under wrapLineLen's 60-character ceiling`);
    let worstBlock = 0, wrapped = 0;
    for (const [title, emph, note, yes] of DIALOGS) {
      // WRAPPED PER BOARD. At 6px none of the four notes wrapped; at 8px two of
      // them do, so the two-line height stopped being hypothetical and became the
      // case that ships. drawConfirm draws min(nl, 2) - a note needing 3 is CLIPPED.
      const nl = countWrappedLinesB(b, note, T_META, lane);
      if (nl > 1) wrapped++;
      chk(nl <= 2, `dialog note "${note.slice(0, 24)}..." wraps to ${nl} line(s) (3+ would be silently clipped)`);
      const block = lineHB(b, T_HEAD) + (emph ? c.SP_2 - 2 + lineHB(b, T_BODY) : 0)
                  + c.SP_2 + Math.min(nl, 2) * lineHB(b, T_META);
      worstBlock = Math.max(worstBlock, block);
      chk(widthB(b, T_HEAD, title) <= lane, `dialog title "${title}" ${widthB(b, T_HEAD, title)}px inside the ${lane}px lane`);
      chk(widthB(b, 2, yes) + 8 <= c.CFM_BTN_W, `dialog action "${yes}" ${widthB(b, 2, yes)}px inside the ${c.CFM_BTN_W}px button`);
    }
    console.log(`    ${wrapped} of ${DIALOGS.length} shipping notes wrap to 2 lines on this board`);
    chk(widthB(b, 2, "CANCEL") + 8 <= c.CFM_BTN_W, `dialog "CANCEL" inside the ${c.CFM_BTN_W}px button`);
    // THE TWO BUTTONS SIDE BY SIDE, which nothing checked in x at all: CFM_NO_X,
    // CFM_YES_X and CFM_BTN_W were literals at their call site until this port and
    // then unread by any checker, so the pair could have overlapped in the middle of
    // a modal - and both are also touch targets, tested by the same three numbers
    // (handleSettingsTouch). The fit is EXACT by construction (CFM_BTN_W is
    // (CARD_W - 3*SP_3)/2), so this is a 1px-tight assertion rather than a
    // formality.
    chk(c.CFM_NO_X + c.CFM_BTN_W < c.CFM_YES_X,
        `dialog CANCEL ${c.CFM_NO_X}..${c.CFM_NO_X + c.CFM_BTN_W - 1} clears the action button at ${c.CFM_YES_X}`);
    chk(c.CFM_YES_X + c.CFM_BTN_W <= c.CARD_X + c.CARD_W - c.SP_3,
        `dialog action button ends ${c.CFM_YES_X + c.CFM_BTN_W}, inside the card's text lane (${c.CARD_X + c.CARD_W - c.SP_3})`);
    chk(c.CFM_NO_X >= c.CARD_X + c.SP_3, `dialog CANCEL starts ${c.CFM_NO_X}, inside the card's left pad (${c.CARD_X + c.SP_3})`);
    chk(c.CFM_BTN_W >= c.TAP_MIN, `dialog button ${c.CFM_BTN_W}px wide >= TAP_MIN ${c.TAP_MIN}`);
    // H_BTN is the SHARED button height - this dialog, the keyboard's action row and
    // the voice-confirm SEND all use it - and nothing anywhere asserted it clears
    // the touch floor.
    chk(c.H_BTN >= c.TAP_MIN, `H_BTN ${c.H_BTN} (every shared button's height) >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.CFM_Y >= c.PAGE_TOP, `dialog starts ${c.CFM_Y}, at or below PAGE_TOP ${c.PAGE_TOP} (it must not cover the pager)`);
    // Sized for a two-line note whether or not today's strings need one.
    const twoLineBlock = lineHB(b, T_HEAD) + c.SP_2 - 2 + lineHB(b, T_BODY) + c.SP_2 + 2 * lineHB(b, T_META);
    chk(twoLineBlock <= avail, `dialog holds its worst block (${twoLineBlock}px: title + emph + 2 note lines) in ${avail}px`);
    console.log(`    worst block among today's dialogs: ${worstBlock}px, worst possible ${twoLineBlock}px in ${avail}px`);
    // THE BLOCK'S REAL PAINTED EXTENT, walked the way drawConfirm walks it, because
    // blockH is a sum of CELLS and every centred element inside it paints a
    // LOW-BIASED box. The title's box reaches 3 rows past its nominal cell on
    // board 2 - so the check that matters is that no element's box touches the one
    // below it, and that the last note line clears the button row.
    {
      const cy = top + Math.floor((avail - twoLineBlock) / 2);
      const tBox = mcBox(b, T_HEAD, cy + Math.floor(lineHB(b, T_HEAD) / 2));
      const eY = cy + lineHB(b, T_HEAD) + c.SP_2 - 2;
      const eBox = mcBox(b, T_BODY, eY + Math.floor(lineHB(b, T_BODY) / 2));
      const nY = eY + lineHB(b, T_BODY) + c.SP_2;
      const n0 = tlBox(b, T_META, nY), n1 = tlBox(b, T_META, nY + lineHB(b, T_META));
      console.log(`    block at ${cy}: title ${tBox.join("..")} emph ${eBox.join("..")} notes ${n0.join("..")} / ${n1.join("..")}`);
      chk(tBox[1] < eBox[0], `dialog title box ends ${tBox[1]} above the emphasis line at ${eBox[0]}`);
      chk(eBox[1] < n0[0], `dialog emphasis box ends ${eBox[1]} above the first note line at ${n0[0]}`);
      chk(n1[1] < c.CFM_BTN_Y, `dialog last note line ends ${n1[1]} above the button row at ${c.CFM_BTN_Y}`);
      chk(tBox[0] >= top, `dialog title box starts ${tBox[0]}, inside the card interior (${top})`);
      // The emphasis is fitText'd to the lane into a char[40] buffer.
      chk(40 >= laneChars + 1, `emphBuf[40] holds the ${laneChars} characters the lane can show + NUL`);
    }
  }

  // ================= THE KEYBOARD =================
  {
    // THE LANE IS CARD_W - 12, and the advance is the BOARD's - not a literal 6.
    // Both were wrong here: this section divided by 6 (Cozette's) on a board that
    // draws Spleen 8x16, so it blessed KB_COLS 47 against a lane that holds 35.
    const lane = c.CARD_W - 12;
    const cols = Math.floor(lane / adv);
    const lines = Math.ceil(KB_MAX_BYTES / c.KB_COLS);
    console.log(`  keyboard: KB_COLS ${c.KB_COLS} (lane ${lane}px / ${adv} = ${(lane / adv).toFixed(2)}), ${c.KB_TEXT_LINES} lines (ceil(${KB_MAX_BYTES}/${c.KB_COLS}) = ${(KB_MAX_BYTES / c.KB_COLS).toFixed(2)})`);
    chk(KB_MAX_BYTES === HOST_CAP, `KB_MAX_BYTES ${KB_MAX_BYTES} == the host's ANSWER_TEXT_MAX_BYTES ${HOST_CAP}`);
    chk(c.TEXT_ADV === adv, `TEXT_ADV ${c.TEXT_ADV} == the body face's measured advance ${adv}`);
    chk(c.KB_COLS === cols, `KB_COLS ${c.KB_COLS} == floor((CARD_W - 12) / TEXT_ADV) = ${cols}`);
    chk(c.KB_TEXT_LINES === lines, `KB_TEXT_LINES ${c.KB_TEXT_LINES} == ceil(KB_MAX_BYTES / KB_COLS) = ${lines}`);
    // THE LAST-CHARACTER RULE, which dividing cannot see: drawString charges the
    // final glyph xOffset + width rather than xAdvance. Board 1's 34 columns is 1px
    // hot against its own 204px lane for a line ending in space / '4' / 'q', which
    // is documented and frozen; on Spleen every glyph has xOffset 0 and width ==
    // xAdvance, so the measured maximum equals the division exactly.
    const mc = maxCols(b, T_BODY, lane);
    const widestLine = "M".repeat(c.KB_COLS - 1) + mc.widest;
    console.log(`    widest ${c.KB_COLS}-column line inks ${widthB(b, T_BODY, widestLine)}px in the ${lane}px lane (measured max ${mc.cols} columns)`);
    chk(c.KB_COLS === mc.cols, `KB_COLS ${c.KB_COLS} == the MEASURED maximum ${mc.cols} for the ${lane}px lane`);
    chk(widthB(b, T_BODY, widestLine) <= lane,
        `${c.KB_COLS} columns ending in the widest glyph ink ${widthB(b, T_BODY, widestLine)}px inside the ${lane}px lane`);
    const caretLine = Math.floor(KB_MAX_BYTES / c.KB_COLS), caretCol = KB_MAX_BYTES % c.KB_COLS;
    chk(caretLine < c.KB_TEXT_LINES, `caret's furthest position is line ${caretLine} col ${caretCol}, inside the ${c.KB_TEXT_LINES} lines budgeted`);
    // ...and it must be inside the LANE too, not merely inside the line budget: the
    // caret is a TEXT_ADV-wide block at column caretCol.
    chk((caretCol + 1) * adv <= lane,
        `caret at column ${caretCol} inks ${caretCol * adv}..${(caretCol + 1) * adv - 1} inside the ${lane}px lane`);
    // THE META ROW must share no pixel row with any text line - drawString paints
    // an opaque box the full height of a line, so a shared row erases text.
    const metaY = c.KB_TEXT_Y + c.KB_META_DY, line0 = c.KB_TEXT_Y + c.KB_LINE0_DY;
    const metaEnd = metaY + cellH - 1;
    chk(c.KB_LINE_PITCH === cellH, `KB_LINE_PITCH ${c.KB_LINE_PITCH} == the body cell ${cellH}`);
    const lastLineEnd = line0 + (c.KB_TEXT_LINES - 1) * c.KB_LINE_PITCH + cellH - 1;
    console.log(`    text card ${c.KB_TEXT_Y}..${c.KB_TEXT_Y + c.KB_TEXT_H - 1}: meta ${metaY}..${metaEnd}, lines ${line0}..${lastLineEnd}`);
    chk(metaEnd < line0, `meta row ends ${metaEnd} before the first text line starts ${line0} (gap ${line0 - metaEnd - 1})`);
    chk(lastLineEnd < c.KB_TEXT_Y + c.KB_TEXT_H, `last text line ends ${lastLineEnd} inside the card (${c.KB_TEXT_Y + c.KB_TEXT_H - 1})`);
    // The grid, and the drawn-versus-tested split.
    const drawnKeyH = c.KB_ROW_H - 4;
    // The TESTED band's width is KB_PITCH, not KB_KEY_W: kbTouch() divides by
    // KB_PITCH, so the 2px gap belongs to the key on its left and no column is
    // dead. Board 1's own header used to state 22x44 = 968 here, which mixed the
    // drawn width with the tested height.
    console.log(`    key drawn ${c.KB_KEY_W}x${drawnKeyH}, tap band ${c.KB_PITCH}x${c.KB_ROW_H} = ${c.KB_PITCH * c.KB_ROW_H}px2`);
    chk(drawnKeyH >= c.TAP_MIN, `drawn key ${drawnKeyH}px tall >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.KB_ROW_H > drawnKeyH && c.KB_PITCH > c.KB_KEY_W,
        `the tap band (${c.KB_PITCH}x${c.KB_ROW_H}) is bigger than the drawn key (${c.KB_KEY_W}x${drawnKeyH}) in BOTH dimensions - the split is kept, not collapsed`);
    chk(drawnKeyH / c.KB_KEY_W <= 40 / 22 + 0.001,
        `key aspect 1:${(drawnKeyH / c.KB_KEY_W).toFixed(2)} no more elongated than board 1's 1:${(40 / 22).toFixed(2)}`);
    chk(10 * c.KB_PITCH <= W, `10 columns x ${c.KB_PITCH} = ${10 * c.KB_PITCH} inside the ${W}px panel`);
    chk(c.KB_PITCH - c.KB_KEY_W === 2, `${c.KB_PITCH - c.KB_KEY_W}px of the pitch is the gap`);
    for (const n of KB_ROW_CELLS) {
      const x0 = Math.floor((W - n * c.KB_PITCH) / 2);
      chk(x0 >= 0, `key row of ${n} cells starts x=${x0} (centred, must not go negative)`);
    }
    chk(8 * c.KB_PITCH < W, `row 3: ?123 (2 cells) + SPACE (6) = ${8 * c.KB_PITCH} leaves ${W - 8 * c.KB_PITCH} for "."`);
    // The whole vertical budget.
    const keysEnd = c.KB_ROWS_Y + 4 * c.KB_ROW_H;
    console.log(`    card ..${c.KB_TEXT_Y + c.KB_TEXT_H - 1} | keys ${c.KB_ROWS_Y}..${keysEnd - 1} | actions ${c.KB_ACT_Y}..${c.KB_ACT_Y + c.KB_ACT_H - 1} of ${H}`);
    chk(c.KB_TEXT_Y + c.KB_TEXT_H <= c.KB_ROWS_Y, `text card ends ${c.KB_TEXT_Y + c.KB_TEXT_H - 1} above the keys at ${c.KB_ROWS_Y} (break ${c.KB_ROWS_Y - c.KB_TEXT_Y - c.KB_TEXT_H})`);
    chk(keysEnd <= c.KB_ACT_Y, `keys end ${keysEnd - 1} above the action row at ${c.KB_ACT_Y}`);
    chk(c.KB_ACT_Y + c.KB_ACT_H <= H, `action row ends ${c.KB_ACT_Y + c.KB_ACT_H - 1} inside the ${H}px panel`);
    chk(c.KB_ACT_H === c.KB_ROW_H, `action row ${c.KB_ACT_H} == KB_ROW_H ${c.KB_ROW_H}`);
    // The action row's two buttons, and the closed-window message sharing the lane.
    const halfW = Math.floor((W - c.CARD_X * 2 - 8) / 2);
    for (const l of ["CANCEL", "SEND"]) chk(widthB(b, T_BODY, l) + 8 <= halfW, `"${l}" ${widthB(b, T_BODY, l)}px inside a ${halfW}px half`);
    const laneW = c.CARD_W - halfW - 8;
    for (const why of ["NO LONGER READY", "WINDOW CLOSED - ANSWER ON YOUR MAC"]) {
      const n = countWrappedLinesB(b, why, T_META, laneW - 8);
      chk(n * c.KB_LINE_PITCH <= c.KB_ACT_H, `"${why}" wraps to ${n} line(s) = ${n * c.KB_LINE_PITCH}px inside the ${c.KB_ACT_H}px action row`);
    }
    // THE PEEK OVERLAY, and its three STACKED ROWS. The rows are what needed adding:
    // they were the literals 8 / 22 / 40 in drawKbPeek(), and drawString paints an
    // opaque box one full cell tall - so at board 2's 16px cell a title at +22 starts
    // INSIDE the "PROMPT" label's box at +8..+23 and erases its last row. Nothing
    // measured that, which is the same defect class as the counted lane above.
    const peekH = H - c.KB_ROWS_Y - 4;
    const pRows = [["label", c.KB_PEEK_LBL_DY], ["title", c.KB_PEEK_TITLE_DY]];
    console.log(`    peek ${peekH}px: label ${c.KB_PEEK_LBL_DY}..${c.KB_PEEK_LBL_DY + cellH - 1}, title ${c.KB_PEEK_TITLE_DY}..${c.KB_PEEK_TITLE_DY + cellH - 1}, text from ${c.KB_PEEK_TEXT_DY}`);
    for (let i = 1; i < pRows.length; i++)
      chk(pRows[i - 1][1] + cellH <= pRows[i][1],
          `peek ${pRows[i - 1][0]} ends ${pRows[i - 1][1] + cellH - 1} before ${pRows[i][0]} starts ${pRows[i][1]}`);
    chk(c.KB_PEEK_TITLE_DY + cellH <= c.KB_PEEK_TEXT_DY,
        `peek title ends ${c.KB_PEEK_TITLE_DY + cellH - 1} before the text starts ${c.KB_PEEK_TEXT_DY}`);
    const peekLines = Math.floor((peekH - c.KB_PEEK_TEXT_DY - 8) / c.KB_LINE_PITCH);
    chk(c.KB_PEEK_LINES === peekLines,
        `KB_PEEK_LINES ${c.KB_PEEK_LINES} == (${peekH} - ${c.KB_PEEK_TEXT_DY} - 8) / ${c.KB_LINE_PITCH} = ${((peekH - c.KB_PEEK_TEXT_DY - 8) / c.KB_LINE_PITCH).toFixed(2)} -> ${peekLines}`);
    chk(c.KB_PEEK_TEXT_DY + peekLines * c.KB_LINE_PITCH <= peekH,
        `peek's ${peekLines} lines end ${c.KB_PEEK_TEXT_DY + peekLines * c.KB_LINE_PITCH - 1} inside the ${peekH}px overlay`);
  }

  // ================= THE READER AND HISTORY PAGER =================
  {
    console.log(`  reader: chip ${c.HIST_CHIP_W_CHAT}x${c.HIST_CHIP_H} at ${c.HIST_CHIP_X},${c.HIST_CHIP_Y}; rule ${c.HIST_RULE_Y}; list ${c.HIST_TOP}..${c.HIST_JUMP_Y - 4}; scrubber band ${c.HIST_JUMP_Y}..${c.HIST_JUMP_Y + c.HIST_JUMP_TAP_H - 1}; ctrl ${c.READER_CTRL_Y}..${c.READER_CTRL_Y + c.READER_BTN_H - 1} of ${H}`);
    chk(c.HIST_CHIP_Y + c.HIST_CHIP_H <= c.HIST_RULE_Y, `chip ends ${c.HIST_CHIP_Y + c.HIST_CHIP_H - 1} above the rule at ${c.HIST_RULE_Y}`);
    chk(c.HIST_CHIP_H >= c.TAP_MIN, `history filter chip ${c.HIST_CHIP_H}px drawn >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.HIST_CHIP_TAP_H + 1 >= c.TAP_MIN, `history chip tap band ${c.HIST_CHIP_TAP_H + 1}px >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.HIST_CHIP_TAP_H >= c.HIST_CHIP_H, `chip tap band ${c.HIST_CHIP_TAP_H} >= drawn ${c.HIST_CHIP_H}`);
    chk(c.HIST_CHIP_TAP_H < c.HIST_RULE_Y, `chip tap band ends ${c.HIST_CHIP_TAP_H} above the rule, or it would claim the first list row`);
    chk(c.HIST_CHIP_TAP_W >= c.HIST_CHIP_X + c.HIST_CHIP_W_CHAT, `chip tap band ${c.HIST_CHIP_TAP_W}px wide covers the drawn chip (ends ${c.HIST_CHIP_X + c.HIST_CHIP_W_CHAT})`);
    chk(c.HIST_CHIP_W_CHAT >= c.TAP_MIN && c.HIST_CHIP_W_ALL >= c.TAP_MIN,
        `chip widths ${c.HIST_CHIP_W_CHAT}/${c.HIST_CHIP_W_ALL} both clear TAP_MIN ${c.TAP_MIN}`);
    for (const [w, t] of [[c.HIST_CHIP_W_CHAT, "CHAT"], [c.HIST_CHIP_W_ALL, "ALL"]])
      chk(widthB(b, T_META, t) + 8 <= w, `chip label "${t}" ${widthB(b, T_META, t)}px inside ${w}px`);
    const nameX = c.HIST_CHIP_X + c.HIST_CHIP_W_CHAT + 8;
    const posStart = W - 12 - widthB(b, T_META, "2515/2515");
    chk(nameX + widthB(b, T_META, "deckhand") < posStart, `header: name at ${nameX} clears the position field starting ${posStart}`);
    chk(c.HIST_CHIP_CY === c.HIST_CHIP_Y + Math.floor(c.HIST_CHIP_H / 2), `chip label centre ${c.HIST_CHIP_CY} == the chip's own centre ${c.HIST_CHIP_Y + Math.floor(c.HIST_CHIP_H / 2)}`);
    // The list, the scrubber and the control bar.
    const listH = (c.HIST_JUMP_Y - 4) - c.HIST_TOP;
    const listLines = Math.floor(listH / c.HIST_LINE_H);
    console.log(`    list ${listH}px = ${listLines} lines of ${c.HIST_LINE_H}`);
    // The header's own text row, which nothing measured vertically - only the x
    // separation of the name and the position field was checked. It is TL/TR text
    // above the rule, so it has to clear it.
    chk(c.HIST_HDR_TEXT_Y >= 2, `history header text at ${c.HIST_HDR_TEXT_Y}, inside the top of the screen`);
    chk(c.HIST_HDR_TEXT_Y + lineHB(b, T_META) <= c.HIST_RULE_Y,
        `history header text inks ${c.HIST_HDR_TEXT_Y}..${c.HIST_HDR_TEXT_Y + lineHB(b, T_META) - 1}, clear of the rule at ${c.HIST_RULE_Y}`);
    // It is a TL_DATUM row centred against the chip, so the box IS the cell: the
    // derivation is HIST_CHIP_CY - cell/2, and it was 21 here (13/2) after the cell
    // became 16. Board 1's own 21 is exactly that at its 13px cell.
    chk(c.HIST_HDR_TEXT_Y === c.HIST_CHIP_CY - Math.floor(lineHB(b, T_META) / 2),
        `HIST_HDR_TEXT_Y ${c.HIST_HDR_TEXT_Y} centres a ${lineHB(b, T_META)}px line on the chip's centre ${c.HIST_CHIP_CY}`);
    chk(c.HIST_HDR_TEXT_Y >= c.HIST_CHIP_Y && c.HIST_HDR_TEXT_Y + lineHB(b, T_META) <= c.HIST_CHIP_Y + c.HIST_CHIP_H,
        `chip label row ${c.HIST_HDR_TEXT_Y}..${c.HIST_HDR_TEXT_Y + lineHB(b, T_META) - 1} inside the chip ${c.HIST_CHIP_Y}..${c.HIST_CHIP_Y + c.HIST_CHIP_H - 1}`);
    chk(c.HIST_LINE_H === lineHB(b, T_BODY), `HIST_LINE_H ${c.HIST_LINE_H} == uiLineH(FONT_CODE) ${lineHB(b, T_BODY)}`);
    chk(c.HIST_TOP > c.HIST_RULE_Y, `list starts ${c.HIST_TOP} below the rule ${c.HIST_RULE_Y}`);
    chk(listLines >= 8, `the list holds ${listLines} lines (an entry is a label plus at least one line, so this bounds entries per page)`);
    const trackY = c.HIST_JUMP_Y + Math.floor((c.HIST_JUMP_TAP_H - c.HIST_JUMP_H) / 2);
    chk(trackY >= c.HIST_JUMP_Y && trackY + c.HIST_JUMP_H <= c.HIST_JUMP_Y + c.HIST_JUMP_TAP_H,
        `scrubber track ${trackY}..${trackY + c.HIST_JUMP_H - 1} centred inside its tap band`);
    chk(c.HIST_JUMP_TAP_H >= c.TAP_MIN, `history scrubber tap band ${c.HIST_JUMP_TAP_H}px >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.HIST_JUMP_Y + c.HIST_JUMP_TAP_H <= c.READER_CTRL_Y, `scrubber band ends ${c.HIST_JUMP_Y + c.HIST_JUMP_TAP_H - 1} above the control bar ${c.READER_CTRL_Y}`);
    chk(c.READER_CTRL_Y + c.READER_BTN_H <= H, `control bar ends ${c.READER_CTRL_Y + c.READER_BTN_H - 1} inside the ${H}px panel`);
    chk(c.READER_BTN_H >= c.TAP_MIN, `reader control ${c.READER_BTN_H}px tall >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.HIST_EMPTY_CY === Math.floor((c.HIST_RULE_Y + c.READER_CTRL_Y) / 2),
        `history empty-state y ${c.HIST_EMPTY_CY} is the midpoint of ${c.HIST_RULE_Y}..${c.READER_CTRL_Y} (${Math.floor((c.HIST_RULE_Y + c.READER_CTRL_Y) / 2)})`);
    // Three keys, symmetric, and the tap splits that divide them.
    const keys = [[c.READER_BTN_L_X, c.READER_BTN_L_W], [c.READER_BTN_M_X, c.READER_BTN_M_W], [c.READER_BTN_R_X, c.READER_BTN_R_W]];
    chk(keys[0][0] === W - (keys[2][0] + keys[2][1]), `control bar symmetric: left margin ${keys[0][0]} == right margin ${W - (keys[2][0] + keys[2][1])}`);
    for (let i = 1; i < 3; i++) chk(keys[i][0] > keys[i - 1][0] + keys[i - 1][1], `control keys ${i - 1}->${i} gap ${keys[i][0] - keys[i - 1][0] - keys[i - 1][1]}`);
    for (const [x, w] of keys) chk(w >= c.TAP_MIN, `control key ${w}px wide >= TAP_MIN ${c.TAP_MIN}`);
    for (const l of ["< PREV", "NEXT >", "CLOSE", "BACK"])
      chk(widthB(b, T_BODY, l) + 8 <= keys[1][1], `control label "${l}" ${widthB(b, T_BODY, l)}px inside the narrowest key (${keys[1][1]}px)`);
    for (const [n, t1, t2] of [["history", c.HIST_TAP_1, c.HIST_TAP_2], ["reader", c.READER_TAP_1, c.READER_TAP_2]]) {
      chk(t1 > keys[0][0] + keys[0][1] - 1 && t1 <= keys[1][0], `${n} tap split 1 (${t1}) falls in the gap ${keys[0][0] + keys[0][1]}..${keys[1][0]}`);
      chk(t2 > keys[1][0] + keys[1][1] - 1 && t2 <= keys[2][0], `${n} tap split 2 (${t2}) falls in the gap ${keys[1][0] + keys[1][1]}..${keys[2][0]}`);
    }
    chk(c.HIST_TAP_1 === c.READER_TAP_1 && c.HIST_TAP_2 === c.READER_TAP_2,
        `reader tap splits agree across the three control bars (${c.HIST_TAP_1}/${c.HIST_TAP_2} vs ${c.READER_TAP_1}/${c.READER_TAP_2})`);
    // The full-entry pager and the ask reader share the region above the bar.
    const textTop = c.READER_TEXT_TOP;
    // THE FULL-ENTRY PAGER steps at HIST_LINE_H; THE ASK READER has its own two
    // steps, and this used to model them as HIST_LINE_H and uiLineH(T_HEAD) - a
    // TRANSCRIPTION, and a wrong one in both arms. drawReader() drew a literal
    // `isCode ? 14 : 18`, so on board 1 the prose arm agreed with the real 18 only
    // because Terminus's cell happens to be 18, and the code arm was checked at 13
    // against a real 14; on board 2 the pair modelled 16/24 against a real 14/18.
    // A model that is not the source cannot catch the source being wrong, and it
    // did not: board 2 shipped 16px cells at a 14px step. So both steps are now
    // READ OUT OF drawReader() ITSELF and resolved against the board's constant
    // table, which means a revert to literals is still measured rather than
    // silently un-checked.
    for (const [n, lh] of [["pager", c.HIST_LINE_H],
                           ["ask code", readerStep(c, "code")],
                           ["ask prose", readerStep(c, "prose")]]) {
      const vis = Math.floor((c.READER_CTRL_Y - 8 - textTop) / lh);
      console.log(`    reader ${n}: ${vis} visible lines of ${lh}`);
      chk(vis >= 8, `reader shows ${vis} ${n} lines`);
    }
    // THE ASSERTION THIS FILE EXISTS FOR, and the one that generalises past this
    // bug: drawString paints an OPAQUE box the full CELL tall, so any line step
    // under the face's cell has each line's box erase the bottom rows of the line
    // above it - descenders in g/j/p/q/y chopped. Both of the reader's steps draw
    // the SAME face (dFont is FONT_CODE or 2, and FONT_CODE aliases T_BODY), so
    // both are measured against that one cell, taken from the parsed UI_FONTS[]
    // rather than transcribed - which is what makes this survive a face change.
    // MEASURED on board 2 before the fix: an all-`g` line inked y 135..143 with
    // 144..145 blank, 2 of Spleen 8x16's 4 descender rows gone.
    const codeCell = lineHB(b, T_BODY);
    for (const n of ["code", "prose"]) {
      const lh = readerStep(c, n);
      chk(lh >= codeCell,
          `the reader's ${n} line step (${READER_STEP[n]} = ${lh}) is >= the ${codeCell}px cell ` +
          `it draws - a shorter step has drawString's opaque box eat the line above`);
    }
    chk(textTop > c.HIST_RULE_Y, `reader text starts ${textTop} below the rule ${c.HIST_RULE_Y}`);
    // THE PAGE BUDGET THE DEVICE REPORTS TO THE MAC, and the arena it has to fit.
    // Both numbers come off the same expressions requestHistory() sends (board 2) or
    // static_asserts (board 1), so a lane counted at the wrong advance shows up here
    // rather than as pages that silently arrive half full. It did: board 2 reported
    // 49x23 against a real 37x18 while this divided by a literal 6 too.
    const readerLane = W - 24;
    const chars = Math.floor(readerLane / adv);
    const rmc = maxCols(b, T_BODY, readerLane);
    console.log(`    reader page budget ${chars}x${listLines} (lane ${readerLane}px / ${adv}); measured max ${rmc.cols} columns`);
    chk(chars === rmc.cols, `reader columns ${chars} == the MEASURED maximum ${rmc.cols} for the ${readerLane}px lane`);
    // A page is at most (cols + 1) * lines bytes - each line plus its NUL - which is
    // the bound reader.ino's own static_assert carries for board 2.
    const page = (chars + 1) * listLines;
    chk(HIST_ARENA >= page, `HIST_ARENA ${HIST_ARENA} >= one page ((${chars} + 1) x ${listLines} = ${page})`);
    chk(chars < 60, `the reader's ${chars}-character lane is under wrapLineLen's 60-character ceiling`);
  }
}
console.log(`\n${total} assertions, ${fail} failures, ${known} known-and-documented board-1 shortfalls`);
if (SELFTEST) {
  // EXIT 0 ONLY WHEN EVERY INJECTED FAULT IS CAUGHT BY THE ASSERTION THAT EXISTS
  // FOR IT. Matching the message rather than counting is what makes that a claim
  // per fault: a checker blind to one of the two would otherwise still print a
  // non-zero total and pass.
  const WANT = [
    ["the moved keyboard meta row", /^meta row ends \d+ before the first text line/],
    ["the raised HOME row height", /^HOME's \d+ rows land exactly on contentBottom/],
    ["the pairing countdown moved onto the label",
     /^pairing panel: the Mac's label ends \d+, clear of the countdown/],
    ["the widened pairing button",
     /^pairing panel: two \d+px buttons plus \d+ fill the card lane exactly/],
    ["the widened pairing row step",
     /^PAIR NEW MAC fits the free slot at 3 Mac\(s\)/],
    ["the widened pairing surplus",
     /^pairing panel: the stack lands exactly on the button row/],
  ];
  let missed = 0;
  for (const [what, re] of WANT) {
    const hit = FAILED.find(m => re.test(m));
    if (hit) console.log(`selftest: ${what} was caught by - ${hit}`);
    else { console.log(`SELFTEST FAILED: the checker did not notice ${what}`); missed++; }
  }
  if (missed) process.exit(1);
  console.log(`selftest ok - ${WANT.length} injected faults, ${WANT.length} caught by name (${fail} failure(s) in total)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all settings / keyboard / reader assertions pass on both boards");
