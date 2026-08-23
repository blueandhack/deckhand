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
import { advanceB, ascentB, cacheSizes, consts, countWrappedLinesB, DIR, fieldBox, lineH,
         lineHB, mcBox, PANEL, preflight, textWidth, tlBox, widthB } from "./geom-common.mjs";
import fs from "fs";
preflight();

const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };
// The board header FIRST, then deckhand_display.ino seeded with it - the order the
// compiler sees, and what makes the derived P1_/P2_/P3_/CFM_ offsets resolve.
const B = {};
for (const b of [1, 2]) B[b] = consts("deckhand_display.ino", consts(HDR[b]));
const SET_CACHE = cacheSizes("deckhand_display.ino");   // the settings caches live in the main file
const T_META = 1, T_BODY = 2, T_HEAD = 3;
const MAX_HOSTS = 4;

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

// wrapLineLen() / countWrappedLines(), reimplemented. The 60-character ceiling and
// the "break no further back than half the line" rule are both real and both
// matter: the first caps every lane on the device, the second is why word wrap's
// worst case can leave a line barely half full - which is the whole reason the
// keyboard hard-wraps instead.
function wrapLineLen(text, pos, maxW, font) {
  const len = text.length - pos;
  let n = 0;
  while (n < len && n < 60) {
    if (text[pos + n] === "\n") return n;
    if (textWidth(text.slice(pos, pos + n + 1), font) > maxW) break;
    n++;
  }
  if (n >= len) return n;
  if (n === 0) return 1;
  for (let b = n; b > Math.floor(n / 2); b--) if (text[pos + b - 1] === " ") return b;
  return n;
}
function countWrappedLines(text, font, maxW) {
  let pos = 0, lines = 0;
  while (pos < text.length && lines < 80) {
    pos += wrapLineLen(text, pos, maxW, font);
    if (pos < text.length && text[pos] === "\n") pos++;
    lines++;
  }
  return lines;
}

// The real strings, so a label that outgrows its lane fails here rather than on
// the glass. Kept as data next to the assertions that use them.
const PAGER_TITLES = ["STATUS", "DISPLAY & SOUND", "ACTIONS", "PAIRED MACS"];
const STEP_LABELS = ["BRIGHTNESS", "SLEEP AFTER", "VOLUME"];
const TOGGLES = ["SOUND", "MUTED", "FLIPPED", "NORMAL", "DARK", "LIGHT", "AUTO"];
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
// the claim is true with zero slack. Board 2's own worst is 6, on 24-character
// words - not the 4 a board-1 string reports for it.
// The assertion stays comparative rather than absolute because what board 2 has to
// prove is that its wider lane cannot make the count worse: a lane that improved
// the average while worsening the tail would be a regression nothing else here
// would catch, and an absolute "<= 8" would pass right up to the moment it broke.
function worstWrappedLines(lane) {
  let worst = 0, at = 0;
  // Every word length that can matter: 1 up to the number of characters the lane
  // holds. Longer than that and wrapLineLen's "never stall" path takes over, which
  // is a different (and less bad) case.
  for (let w = 1; w <= Math.floor(lane / 6); w++) {
    const word = "w".repeat(w) + " ";
    const text = word.repeat(Math.ceil(KB_MAX_BYTES / word.length) + 1).slice(0, KB_MAX_BYTES);
    const n = countWrappedLines(text, T_META, lane);
    if (n > worst) { worst = n; at = w; }
  }
  return { worst, at };
}
const voiceLines = {}, voiceWord = {};
for (const b of [1, 2]) {
  const r = worstWrappedLines(B[b].CARD_W - 8);
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
    // (d) "Asking the Mac..." is drawn at a literal 130, which is NOT the midpoint
    // of the region it sits in (22..272 -> 147) - it predates the control bar.
    "history empty-state y 130 is the midpoint of 22..272 (147)",
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
let fail = 0, known = 0;
let CUR = 1;
function chk(cond, msg) {
  if (!cond && KNOWN[CUR].includes(msg)) { known++; console.log(` known  ${msg}`); return; }
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) fail++;
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
    chk(cy + 8 + 3 < c.PAGE_TOP, `page dots end ${cy + 11} inside the band cleared to ${c.PAGE_TOP}`);
    const laneL = c.PAGER_BTN_X0 + c.PAGER_BTN_W, laneR = W - c.PAGER_BTN_X0 - c.PAGER_BTN_W;
    for (const t of PAGER_TITLES) {
      const w = textWidth(t, T_META);
      const x0 = Math.floor(W / 2 - w / 2);
      chk(x0 > laneL && x0 + w < laneR, `pager title "${t}" ${w}px spans ${x0}..${x0 + w} inside the keys' lane ${laneL}..${laneR}`);
    }
  }

  // ================= SETTINGS page 0: the DEVICE and LINK cards =================
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
    if (cards.length > 1)
      chk(cards[1][1] === cards[0][1] + cards[0][2] + c.SP_3,
          `page 0: LINK card at ${cards[1][1]} == DEVICE (${cards[0][1]}) + ${cards[0][2]} + SP_3 ${c.SP_3}`);
  }
  {
    // The battery reading is right-aligned and padded to 15 characters
    // ("100% 4.20V ~99h"); "Battery" sits at CARD_X + PAD + 20.
    const readingW = widthB(b, T_META, "100% 4.20V ~99h");
    const xRight = c.CARD_X + c.CARD_W - c.PAD;
    const labelEnd = c.CARD_X + c.PAD + 20 + widthB(b, T_BODY, "Battery");
    chk(xRight - readingW > labelEnd, `battery reading ${readingW}px starts ${xRight - readingW}, "Battery" ends ${labelEnd}`);
    chk(+SET_CACHE.battRowTextCache >= 16, `battRowTextCache ${SET_CACHE.battRowTextCache} holds 15 chars + NUL`);
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

  // ================= SETTINGS page 2: actions =================
  {
    const hintY = c.P2_PWR_Y + c.P2_BTN_H + c.SP_3;
    const hintEnd = mcBox(b, T_META, hintY)[1];
    // FOUR buttons on board 1, THREE on board 2 - which has no capture path, so no
    // MIC TEST and no slot reserved for one (`#if BOARD_HAS_MIC` in the .ino, which
    // geom-common.mjs now honours; it used to read the no-mic arm for both boards
    // and put board 1's last two buttons a whole button too high).
    const p2 = c.P2_MIC_Y === undefined
      ? [["CALIBRATE", c.P2_CAL_Y], ["RESET PAIRING", c.P2_PAIR_Y], ["POWER OFF", c.P2_PWR_Y]]
      : [["MIC TEST", c.P2_MIC_Y], ["CALIBRATE", c.P2_CAL_Y], ["RESET PAIRING", c.P2_PAIR_Y], ["POWER OFF", c.P2_PWR_Y]];
    console.log(`  page 2: ${p2.length} buttons ${p2[0][1]}..${c.P2_PWR_Y + c.P2_BTN_H - 1} (h ${c.P2_BTN_H}), hint inks ..${hintEnd}`);
    chk(p2[0][1] === c.PAGE_TOP + c.P2_TOP, `page 2: ${p2[0][0]} at ${p2[0][1]} == PAGE_TOP + P2_TOP (${c.PAGE_TOP + c.P2_TOP})`);
    for (let i = 1; i < p2.length; i++)
      chk(p2[i][1] === p2[i - 1][1] + c.P2_BTN_H + c.P2_GAP,
          `page 2: ${p2[i][0]} at ${p2[i][1]} == ${p2[i - 1][0]} (${p2[i - 1][1]}) + ${c.P2_BTN_H} + gap ${c.P2_GAP}`);
    chk(c.P2_BTN_H >= c.TAP_MIN, `action button ${c.P2_BTN_H}px tall >= TAP_MIN ${c.TAP_MIN}`);
    chk(hintEnd < contentBottom, `page 2 hint ends ${hintEnd} above the footer ${contentBottom}`);
    for (const l of P2_LABELS) chk(widthB(b, 2, l) + 2 * c.SP_3 <= c.CARD_W, `action label "${l}" ${widthB(b, 2, l)}px inside the ${c.CARD_W}px button`);
    // BOTH arms of #if BOARD_HAS_TOUCH_SLEEP_WAKE, on both boards. uiHint centres
    // with MC_DATUM on the panel, so the box is symmetric in x and the constraint
    // is the panel width - and the string board 2 draws is the one board 1 does
    // not compile, so checking only the touch-wake arm measured nothing about it.
    for (const h of P2_HINTS)
      chk(widthB(b, T_META, h) <= W - 8, `page 2 hint "...${h.slice(-18)}" ${widthB(b, T_META, h)}px inside the ${W}px panel`);
    {
      const [t0, t1] = mcBox(b, T_META, hintY);
      chk(t1 < contentBottom, `page 2 hint box ${t0}..${t1} above the footer ${contentBottom}`);
    }
  }

  // ================= SETTINGS page 3: paired Macs =================
  {
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
    const cols = Math.floor((c.CARD_W - 12) / 6);
    const lines = Math.ceil(KB_MAX_BYTES / c.KB_COLS);
    console.log(`  keyboard: KB_COLS ${c.KB_COLS} (lane ${c.CARD_W - 12}px / 6 = ${((c.CARD_W - 12) / 6).toFixed(2)}), ${c.KB_TEXT_LINES} lines (ceil(${KB_MAX_BYTES}/${c.KB_COLS}) = ${(KB_MAX_BYTES / c.KB_COLS).toFixed(2)})`);
    chk(KB_MAX_BYTES === HOST_CAP, `KB_MAX_BYTES ${KB_MAX_BYTES} == the host's ANSWER_TEXT_MAX_BYTES ${HOST_CAP}`);
    chk(c.KB_COLS === cols, `KB_COLS ${c.KB_COLS} == floor((CARD_W - 12) / 6) = ${cols}`);
    chk(c.KB_TEXT_LINES === lines, `KB_TEXT_LINES ${c.KB_TEXT_LINES} == ceil(KB_MAX_BYTES / KB_COLS) = ${lines}`);
    chk(c.KB_COLS * 6 <= c.CARD_W - 12, `${c.KB_COLS} columns = ${c.KB_COLS * 6}px inside the ${c.CARD_W - 12}px lane`);
    const caretLine = Math.floor(KB_MAX_BYTES / c.KB_COLS), caretCol = KB_MAX_BYTES % c.KB_COLS;
    chk(caretLine < c.KB_TEXT_LINES, `caret's furthest position is line ${caretLine} col ${caretCol}, inside the ${c.KB_TEXT_LINES} lines budgeted`);
    // THE META ROW must share no pixel row with any text line - drawString paints
    // an opaque box the full height of a line, so a shared row erases text.
    const metaY = c.KB_TEXT_Y + c.KB_META_DY, line0 = c.KB_TEXT_Y + c.KB_LINE0_DY;
    const metaEnd = metaY + lineH(T_META) - 1;
    const lastLineEnd = line0 + (c.KB_TEXT_LINES - 1) * c.KB_LINE_PITCH + lineH(T_META) - 1;
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
    for (const l of ["CANCEL", "SEND"]) chk(textWidth(l, T_BODY) + 8 <= halfW, `"${l}" ${textWidth(l, T_BODY)}px inside a ${halfW}px half`);
    const laneW = c.CARD_W - halfW - 8;
    for (const why of ["NO LONGER READY", "WINDOW CLOSED - ANSWER ON YOUR MAC"]) {
      const n = countWrappedLines(why, T_META, laneW - 8);
      chk(n * lineH(T_META) <= c.KB_ACT_H, `"${why}" wraps to ${n} line(s) = ${n * lineH(T_META)}px inside the ${c.KB_ACT_H}px action row`);
    }
    // The peek overlay.
    const peekH = H - c.KB_ROWS_Y - 4;
    const peekLines = Math.floor((peekH - 40 - 8) / c.KB_LINE_PITCH);
    chk(c.KB_PEEK_LINES === peekLines, `KB_PEEK_LINES ${c.KB_PEEK_LINES} == (${peekH} - 48) / 13 = ${((peekH - 48) / 13).toFixed(2)} -> ${peekLines}`);
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
      chk(textWidth(t, T_META) + 8 <= w, `chip label "${t}" ${textWidth(t, T_META)}px inside ${w}px`);
    const nameX = c.HIST_CHIP_X + c.HIST_CHIP_W_CHAT + 8;
    const posStart = W - 12 - textWidth("2515/2515", T_META);
    chk(nameX + textWidth("deckhand", T_META) < posStart, `header: name at ${nameX} clears the position field starting ${posStart}`);
    chk(c.HIST_CHIP_CY === c.HIST_CHIP_Y + Math.floor(c.HIST_CHIP_H / 2), `chip label centre ${c.HIST_CHIP_CY} == the chip's own centre ${c.HIST_CHIP_Y + Math.floor(c.HIST_CHIP_H / 2)}`);
    // The list, the scrubber and the control bar.
    const listH = (c.HIST_JUMP_Y - 4) - c.HIST_TOP;
    const listLines = Math.floor(listH / c.HIST_LINE_H);
    console.log(`    list ${listH}px = ${listLines} lines of ${c.HIST_LINE_H}`);
    // The header's own text row, which nothing measured vertically - only the x
    // separation of the name and the position field was checked. It is TL/TR text
    // above the rule, so it has to clear it.
    chk(c.HIST_HDR_TEXT_Y >= 2, `history header text at ${c.HIST_HDR_TEXT_Y}, inside the top of the screen`);
    chk(c.HIST_HDR_TEXT_Y + lineH(T_META) <= c.HIST_RULE_Y,
        `history header text inks ${c.HIST_HDR_TEXT_Y}..${c.HIST_HDR_TEXT_Y + lineH(T_META) - 1}, clear of the rule at ${c.HIST_RULE_Y}`);
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
      chk(textWidth(l, T_BODY) + 8 <= keys[1][1], `control label "${l}" ${textWidth(l, T_BODY)}px inside the narrowest key (${keys[1][1]}px)`);
    for (const [n, t1, t2] of [["history", c.HIST_TAP_1, c.HIST_TAP_2], ["reader", c.READER_TAP_1, c.READER_TAP_2]]) {
      chk(t1 > keys[0][0] + keys[0][1] - 1 && t1 <= keys[1][0], `${n} tap split 1 (${t1}) falls in the gap ${keys[0][0] + keys[0][1]}..${keys[1][0]}`);
      chk(t2 > keys[1][0] + keys[1][1] - 1 && t2 <= keys[2][0], `${n} tap split 2 (${t2}) falls in the gap ${keys[1][0] + keys[1][1]}..${keys[2][0]}`);
    }
    chk(c.HIST_TAP_1 === c.READER_TAP_1 && c.HIST_TAP_2 === c.READER_TAP_2,
        `reader tap splits agree across the three control bars (${c.HIST_TAP_1}/${c.HIST_TAP_2} vs ${c.READER_TAP_1}/${c.READER_TAP_2})`);
    // The full-entry pager and the ask reader share the region above the bar.
    const textTop = c.READER_TEXT_TOP;
    for (const [n, lh] of [["code", c.HIST_LINE_H], ["prose", 18]]) {
      const vis = Math.floor((c.READER_CTRL_Y - 8 - textTop) / lh);
      console.log(`    reader ${n}: ${vis} visible lines of ${lh}`);
      chk(vis >= 8, `reader shows ${vis} ${n} lines`);
    }
    chk(textTop > c.HIST_RULE_Y, `reader text starts ${textTop} below the rule ${c.HIST_RULE_Y}`);
    // The page arena holds ONE SCREEN, so what it has to cover is the text a full
    // screen of entries can carry - not a worst case per entry.
    const chars = Math.floor((W - 24) / 6);
    const need = listLines * chars;
    chk(HIST_ARENA >= need, `HIST_ARENA ${HIST_ARENA} >= one screen's text (${listLines} lines x ${chars} chars = ${need})`);
    chk(chars < 60, `the reader's ${chars}-character lane is under wrapLineLen's 60-character ceiling`);
  }
}
console.log(`\n${fail} failures, ${known} known-and-documented board-1 shortfalls`);
if (SELFTEST) {
  if (fail === 0) { console.log("SELFTEST FAILED: the checker did not notice the moved meta row"); process.exit(1); }
  console.log(`selftest ok - the injected fault produced ${fail} failure(s)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all settings / keyboard / reader assertions pass on both boards");
