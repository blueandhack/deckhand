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
import { cacheSizes, consts, DIR, lineH, PANEL, preflight, textWidth } from "./geom-common.mjs";
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
const P2_HINT = "power off = deep sleep, touch to wake";
// drawPendingConfirm()'s four dialogs: [title, emph, note, yesLabel].
const DIALOGS = [
  ["Forget this Mac?", "a-long-mac-label", "its key is deleted; re-pairs over USB", "FORGET"],
  ["Recalibrate touch?", null, "5 taps; current setup kept if it fails", "CALIBRATE"],
  ["Reset all pairing?", null, "every paired Mac is forgotten", "RESET"],
  ["Power off?", null, "deep sleep - touch the screen to wake", "POWER OFF"],
];
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

  // ================= SETTINGS page 0: the DEVICE card =================
  // Bands as CLEARED extents. A connection row is drawConnRow's
  // fillRect(xRight-100, y, 100, 16) plus a 13px dot at y+8; the battery reading is
  // drawIfChanged at y+4 (TR_DATUM, 13px cell -> clears y+3..y+17); the id and the
  // two Mac rows are 13px lines clearing y-1..y+13.
  const dev = [
    ["label", 6, 6 + lineH(T_META) - 1],
    ["bluetooth", c.DROW_BT, c.DROW_BT + 15],
    ["usb", c.DROW_USB, c.DROW_USB + 15],
    ["battery", c.DROW_BATT, c.DROW_BATT + 17],
    ["device id", c.DROW_ID - 1, c.DROW_ID + lineH(T_META)],
    ["mac row 0", c.DROW_MAC0 - 1, c.DROW_MAC0 + lineH(T_META)],
    ["mac row 1", c.DROW_MAC1 - 1, c.DROW_MAC1 + lineH(T_META)],
  ];
  console.log(`  DEVICE card ${c.DEV_CARD_Y}..${c.DEV_CARD_Y + c.DEV_CARD_H - 1} (h ${c.DEV_CARD_H}):`);
  for (const [n, a, z] of dev) console.log(`    ${n.padEnd(10)} +${a}..+${z}`);
  for (let i = 1; i < dev.length; i++) {
    const gap = dev[i][1] - dev[i - 1][2] - 1;
    chk(gap >= 0, `device card: ${dev[i - 1][0]} -> ${dev[i][0]} gap ${gap} (negative = a clear box eats its neighbour)`);
  }
  chk(dev[0][1] >= 2, `device card: label starts +${dev[0][1]} inside the interior (border owns +0..+1)`);
  {
    const devCeil = c.DEV_CARD_H - 3;
    const devLast = Math.max(...dev.map(x => x[2]));
    chk(devLast <= devCeil, `device card: last band ends +${devLast} <= +${devCeil} (2px border owns +${c.DEV_CARD_H - 2}..+${c.DEV_CARD_H - 1})`);
    chk(c.DEV_CARD_Y + c.DEV_CARD_H <= contentBottom, `device card ends ${c.DEV_CARD_Y + c.DEV_CARD_H} inside the region (${contentBottom})`);
    // The battery reading is right-aligned and padded to 15 characters
    // ("100% 4.20V ~99h"); "Battery" sits at CARD_X + PAD + 20.
    const readingW = textWidth("100% 4.20V ~99h", T_BODY);
    const xRight = c.CARD_X + c.CARD_W - c.PAD;
    const labelEnd = c.CARD_X + c.PAD + 20 + textWidth("Battery", T_BODY);
    chk(xRight - readingW > labelEnd, `battery reading ${readingW}px starts ${xRight - readingW}, "Battery" ends ${labelEnd}`);
    chk(+SET_CACHE.battRowTextCache >= 16, `battRowTextCache ${SET_CACHE.battRowTextCache} holds 15 chars + NUL`);
    chk(textWidth("Not connected", T_BODY) <= 100, `"Not connected" ${textWidth("Not connected", T_BODY)}px inside drawConnRow's 100px erase box`);
    // A Mac row's erase box always reserves the icon slot, used or not.
    const macW = c.MAC_ROW_W * 6 + 4 + 13 + 2;
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
    // The MIDDLE column's bands, as cleared extents. The value goes through
    // drawIfChanged with MC_DATUM, which clears cy-th/2-1 .. cy-th/2+th.
    const vh = lineH(T_HEAD);
    const mid = [
      ["label", c.STEP_LABEL_CY - Math.floor(lineH(T_META) / 2), c.STEP_LABEL_CY + Math.floor(lineH(T_META) / 2)],
      ["value", c.STEP_VALUE_CY - Math.floor(vh / 2) - 1, c.STEP_VALUE_CY - Math.floor(vh / 2) + vh],
      ["bar", c.STEP_BAR_Y, c.STEP_BAR_Y + c.STEP_BAR_H - 1],
    ];
    for (const [n, a, z] of mid) console.log(`    stepper ${n.padEnd(6)} +${a}..+${z}`);
    for (let i = 1; i < mid.length; i++) {
      const gap = mid[i][1] - mid[i - 1][2] - 1;
      chk(gap >= 0, `stepper: ${mid[i - 1][0]} -> ${mid[i][0]} gap ${gap}`);
    }
    chk(mid[0][1] >= 2, `stepper label starts +${mid[0][1]} inside the interior`);
    chk(mid[2][2] <= c.STEPPER_CARD_H - 3, `stepper bar ends +${mid[2][2]} clear of the 2px border at +${c.STEPPER_CARD_H - 2}`);
    // The bar's lane must clear both keys, and the label must clear both hit
    // thirds - a tap meant to read the label must not step the value.
    const barX = c.CARD_X + c.PAD + c.STEP_BTN_SIZE + c.STEP_BAR_GAP;
    const barW = c.CARD_W - 2 * (c.PAD + c.STEP_BTN_SIZE + c.STEP_BAR_GAP);
    chk(barX > c.CARD_X + c.PAD + c.STEP_BTN_SIZE - 1, `bar starts ${barX} right of the left key (ends ${c.CARD_X + c.PAD + c.STEP_BTN_SIZE - 1})`);
    chk(barX + barW <= c.CARD_X + c.CARD_W - c.PAD - c.STEP_BTN_SIZE, `bar ends ${barX + barW - 1} left of the right key`);
    const hitL = c.CARD_X + Math.floor(c.CARD_W / 3), hitR = c.CARD_X + Math.floor(c.CARD_W * 2 / 3);
    for (const l of STEP_LABELS) {
      const w = textWidth(l, T_META), x0 = Math.floor(W / 2 - w / 2);
      chk(x0 >= hitL && x0 + w < hitR, `stepper label "${l}" spans ${x0}..${x0 + w} inside the dead band ${hitL}..${hitR}`);
    }
    for (const v of ["100%", "never", "LOUD"]) {
      const w = textWidth(v.padStart(5), T_HEAD);
      chk(Math.floor(W / 2 - w / 2) >= hitL, `stepper value "${v}" ${w}px clear of the left hit third`);
    }
  }
  {
    const rows = 3 * c.STEPPER_CARD_H + c.P1_SOUND_H;
    const used = c.P1_TOP + rows + 3 * c.P1_GAP;
    const below = region - used;
    console.log(`  page 1: ${rows}px of rows + ${c.P1_TOP} top + 3x${c.P1_GAP} = ${used} of ${region}, ${below} below`);
    chk(below > 0, `page 1: toggle row ends ${c.P1_SOUND_Y + c.P1_SOUND_H}, ${below}px above the footer (must be > 0, or MUTE/NORMAL/LIGHT read as the status line)`);
    chk(c.P1_GAP <= c.P1_SOUND_H, `page 1 gap ${c.P1_GAP} <= its shortest row ${c.P1_SOUND_H} (a wider gap stops reading as one list)`);
    chk(c.P1_SOUND_H >= c.TAP_MIN, `toggle row ${c.P1_SOUND_H} >= TAP_MIN ${c.TAP_MIN}`);
    const third = Math.floor((c.CARD_W - 16) / 3);
    for (const t of TOGGLES) chk(textWidth(t, T_BODY) + 8 <= third, `toggle label "${t}" ${textWidth(t, T_BODY)}px inside a ${third}px third`);
  }

  // ================= SETTINGS page 2: actions =================
  {
    const hintY = c.P2_PWR_Y + c.P2_BTN_H + c.SP_3;
    const hintEnd = hintY + Math.floor(lineH(T_META) / 2);
    console.log(`  page 2: buttons ${c.P2_MIC_Y}..${c.P2_PWR_Y + c.P2_BTN_H - 1} (h ${c.P2_BTN_H}), hint inks ..${hintEnd}`);
    chk(c.P2_BTN_H >= c.TAP_MIN, `action button ${c.P2_BTN_H}px tall >= TAP_MIN ${c.TAP_MIN}`);
    chk(hintEnd < contentBottom, `page 2 hint ends ${hintEnd} above the footer ${contentBottom}`);
    for (const l of P2_LABELS) chk(textWidth(l, T_BODY) + 2 * c.SP_3 <= c.CARD_W, `action label "${l}" ${textWidth(l, T_BODY)}px inside the ${c.CARD_W}px button`);
    chk(textWidth(P2_HINT, T_META) <= W - 8, `page 2 hint ${textWidth(P2_HINT, T_META)}px inside the ${W}px panel`);
  }

  // ================= SETTINGS page 3: paired Macs =================
  {
    const last = c.P3_LIST_Y + (MAX_HOSTS - 1) * (c.H_ROW + c.SP_1) + c.H_ROW;
    console.log(`  page 3: ANY at ${c.P3_ANY_Y}, ${MAX_HOSTS} Macs end ${last} of ${contentBottom}`);
    chk(last <= contentBottom, `page 3: ANY + ${MAX_HOSTS} Macs end ${last} inside the region (${contentBottom})`);
    chk(c.H_ROW >= c.TAP_MIN, `list row ${c.H_ROW} >= TAP_MIN ${c.TAP_MIN}`);
    chk(c.P3_X_W >= 40, `the "forget" x zone is ${c.P3_X_W}px wide`);
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
    chk(lane < 60 * 6, `dialog lane ${lane}px is under wrapLineLen's 60-character ceiling`);
    let worstBlock = 0;
    for (const [title, emph, note, yes] of DIALOGS) {
      const nl = countWrappedLines(note, T_META, lane);
      // drawConfirm draws min(nl, 2) lines - a note needing 3 would be CLIPPED.
      chk(nl <= 2, `dialog note "${note.slice(0, 24)}..." wraps to ${nl} line(s) (3+ would be silently clipped)`);
      const block = lineH(T_HEAD) + (emph ? c.SP_2 - 2 + lineH(T_BODY) : 0) + c.SP_2 + Math.min(nl, 2) * lineH(T_META);
      worstBlock = Math.max(worstBlock, block);
      chk(textWidth(title, T_HEAD) <= lane, `dialog title "${title}" ${textWidth(title, T_HEAD)}px inside the ${lane}px lane`);
      chk(textWidth(yes, T_BODY) + 8 <= c.CFM_BTN_W, `dialog action "${yes}" ${textWidth(yes, T_BODY)}px inside the ${c.CFM_BTN_W}px button`);
    }
    chk(textWidth("CANCEL", T_BODY) + 8 <= c.CFM_BTN_W, `dialog "CANCEL" inside the ${c.CFM_BTN_W}px button`);
    // Sized for a two-line note whether or not today's strings need one.
    const twoLineBlock = lineH(T_HEAD) + c.SP_2 - 2 + lineH(T_BODY) + c.SP_2 + 2 * lineH(T_META);
    chk(twoLineBlock <= avail, `dialog holds its worst block (${twoLineBlock}px: title + emph + 2 note lines) in ${avail}px`);
    console.log(`    worst block among today's four dialogs: ${worstBlock}px`);
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
