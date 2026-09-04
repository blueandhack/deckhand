// ---------------------------------------------------------------------------
// docs/design/compose/compose.js - the COMPOSE SURFACE mock, BOTH BOARDS.
//
// Two screens (the reply panel and the sharpened keyboard) x two boards x two
// states = eight pictures, each drawn into an op list rather than onto a canvas,
// so check.mjs can assert the geometry with no browser present.
//
// WHAT IS EXACT AND WHAT IS NOT, stated up front because the other mocks in this
// directory carry real bitmaps and this one deliberately does not:
//   - GEOMETRY IS EXACT. Every rectangle, every band, every column and every
//     text ORIGIN is the number the firmware will use, and check.mjs binds K
//     name-for-name to BOTH board headers through the geometry checkers' own
//     consts() parser.
//   - GLYPH RENDERING IS APPROXIMATE. compose.html paints strings with a web
//     monospace face stepped at the board's own ADV and CELL. Cozette has no
//     committed JS dump in this repo (settings-redesign/spleenfonts.js is
//     SPLEEN, i.e. board 2 only), and inventing one for board 1 would be the
//     "flattered by a Mac font" mistake that mock already paid for. So the mock
//     measures every string by ADV/CELL - which IS what the panel advances by,
//     since both boards' body faces are monospace - and does not pretend the
//     ink inside each cell is right.
//   - TEXT IS PLACED BY ITS CELL BOX, top-left. The device's MC_DATUM centres on
//     the ASCENT and so sits biased low by half the descent (geom-common.mjs's
//     mcBox()). That bias is a rendering property of drawString, not of this
//     layout, and it is task 6's business, not the mock's.
//
// EVERY STRING HERE IS ASCII 0x20..0x7E. The fonts hold nothing else and an
// out-of-range codepoint draws nothing AND advances nothing, so truncation uses
// THREE ASCII DOTS. BAD_CHARS below is the enforcement, and check.mjs scans it
// after every screen.
// ---------------------------------------------------------------------------

// THEMES[] from deckhand_display.ino, field order bg,card,label,value,accent,
// good,warn,bad,unknown. Board-independent - the palette is not per board.
const THEME_RAW = {
  DARK:  [0x0000,0x18C4,0x8410,0xFFFF,0xFD20,0x0396,0xE4E0,0xCBD4,0x7BEF],
  LIGHT: [0xEF5C,0xFFFF,0x62CA,0x18C3,0xB240,0x12F4,0xB3A0,0x6887,0x8C30],
};
const THEME_NAMES = ["bg","card","label","value","accent","good","warn","bad","unknown"];
function c565(v){const r=(v>>11&31)*255/31,g=(v>>5&63)*255/63,b=(v&31)*255/31;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;}
const TH = {}; for(const k in THEME_RAW){TH[k]={}; THEME_RAW[k].forEach((v,i)=>TH[k][THEME_NAMES[i]]=c565(v));}

// ---------------------------------------------------------------------------
// K - EVERY CONSTANT THIS MOCK SHARES WITH A BOARD HEADER, per board, under the
// HEADER'S OWN NAME. check.mjs parses board_e32r28t.h into H[1] and
// board_es3c35p.h into H[2] and asserts every one of these against its board, so
// the mock cannot drift from a header while still reporting itself green - an
// unbound spec being the same class of defect as an assertion that cannot fail.
//
// EVERY VALUE HERE IS A LITERAL, on purpose. Writing KB_STRIP_H as
// KB_LINE_PITCH + 4 would make check.mjs's derivation assertion compare an
// expression against its own term, which always holds. Two independent literals
// can disagree; a derivation cannot.
//
// AS OF TASK 2, EIGHT OF THESE NAMES DO NOT EXIST IN EITHER HEADER YET
// (KB_ACT_DRAWN, KB_ACT_DY, KB_STRIP_H, KB_STRIP_Y, COMPOSE_PROMPT_H,
// COMPOSE_LEGEND_H, COMPOSE_DRAFT_H, COMPOSE_GAP - KB_KEY_R landed and is no
// longer among them) and five more still hold their pre-compose values (board
// 1's KB_TEXT_Y, KB_ROWS_Y, KB_ROW_H, and both boards' KB_TEXT_Y, KB_ACT_Y,
// KB_ACT_H). check.mjs therefore FAILS BY NAME on each of them today. That
// failure is the binding working; see README.md. THIS COUNT IS PROSE, NOT
// CODE - it is not read by check.mjs and cannot be derived from PENDING
// automatically without executing the mock first, so each landing task must
// hand-correct it same as this one did, rather than it going silently stale.
// ---------------------------------------------------------------------------
const K = {
  1: {
    BOARD_W:240, BOARD_H:320,
    TAP_MIN:40,                 // 7.11mm on this panel's 5.624 px/mm
    CARD_X:12, CARD_W:216,
    TEXT_ADV:6,                 // Cozette 6x13's uniform advance
    R_MD:10,                    // the CARD radius - what keys used to be drawn with
    // the key grid
    KB_PITCH:24, KB_KEY_W:22,
    KB_KEY_R:2,                 // NEW: derived from the key, 9.1% of KB_KEY_W
    KB_COLS:34, KB_TEXT_LINES:5,
    // the prompt strip, new on both boards
    KB_STRIP_Y:4, KB_STRIP_H:17,          // NEW: KB_LINE_PITCH + 4
    // the text card - height unchanged, pushed down by the strip
    KB_TEXT_Y:24, KB_TEXT_H:88,
    KB_META_DY:6, KB_LINE0_DY:22, KB_LINE_PITCH:13,
    // the key rows - KB_ROW_H 44 -> 41, which is what buys the strip
    KB_ROWS_Y:115, KB_ROW_H:41,
    // the action row, with the drawn/tested split it never had
    KB_ACT_Y:280, KB_ACT_H:40,            // KB_ACT_H 44 -> 40 == TAP_MIN
    KB_ACT_DRAWN:26, KB_ACT_DY:7,         // NEW: 2 * KB_LINE_PITCH, centred
    // the reply panel
    COMPOSE_PROMPT_H:52,                  // NEW: 5 + KB_LINE_PITCH + 4 + 2 lines + 4
    COMPOSE_LEGEND_H:16,                  // NEW: KB_LINE_PITCH + 3
    COMPOSE_DRAFT_H:21,                   // NEW: KB_LINE_PITCH + 8
    COMPOSE_GAP:4,                        // NEW: the 4px scale on this board
  },
  2: {
    BOARD_W:320, BOARD_H:480,
    TAP_MIN:46,                 // 7.09mm on this panel's 6.489 px/mm
    CARD_X:12, CARD_W:296,
    TEXT_ADV:8,                 // Spleen 8x16's uniform advance
    R_MD:12,
    KB_PITCH:32, KB_KEY_W:30,
    KB_KEY_R:3,                 // NEW: KB_KEY_W / 10 truncated, 10.0% of KB_KEY_W - NOT x1.154 off board 1's 2 (that computes to 2.31, truncating back to 2)
    KB_COLS:35, KB_TEXT_LINES:5,
    KB_STRIP_Y:6, KB_STRIP_H:20,          // NEW: KB_LINE_PITCH + 4
    KB_TEXT_Y:34, KB_TEXT_H:120,
    KB_META_DY:8, KB_LINE0_DY:32, KB_LINE_PITCH:16,
    KB_ROWS_Y:170, KB_ROW_H:58,           // both UNCHANGED - the strip comes out
                                          // of the header's own 38px residual
    KB_ACT_Y:426, KB_ACT_H:46,            // KB_ACT_H 58 -> 46 == TAP_MIN
    KB_ACT_DRAWN:32, KB_ACT_DY:7,         // NEW: 2 * KB_LINE_PITCH, centred
    COMPOSE_PROMPT_H:77,                  // NEW: 5 + KB_LINE_PITCH + 4 + 3 lines + 4
    COMPOSE_LEGEND_H:19,                  // NEW: KB_LINE_PITCH + 3
    COMPOSE_DRAFT_H:24,                   // NEW: KB_LINE_PITCH + 8
    COMPOSE_GAP:8,                        // NEW: the 8px scale on this board
  },
};

// ---------------------------------------------------------------------------
// D - the mock's OWN terms of the vertical column: the margins, the gaps, the
// single residual, and the band COUNTS. Deliberately outside K, because a name
// in K that a header does not define has to FAIL rather than be skipped, and
// these are not header constants - they are the terms with no job of their own.
//
// They are still not free: check.mjs asserts each screen's column sums to
// exactly BOARD_H and that the cumulative offset of every anchored band equals
// the K constant that names it, so a gap that drifts moves an anchor and fails.
//
// RP_TOKEN_BANDS IS 1 ON BOTH BOARDS, AND THE SPEC CONTRADICTS ITSELF HERE.
// docs/superpowers/specs/2026-09-04-compose-surface-design.md's board-2 reply
// budget block lists "92 tokens 2 x 46 band" and "18 residual"; three separate
// prose claims in the same document say the opposite - "one band on both boards
// keeps the two panels structurally identical", "a second token band costs 46 of
// [the] 64 px residual ... It is deliberately NOT in this design", and "same
// stack as board 1, one row taller because recents fit". The chip arithmetic
// settles it: the host caps chips at 4, a token band is 3 columns (2 chips + the
// pager), so one band shows 2 - which is what the spec says board 1 shows - and
// a second band would re-lay out at 2 wider columns to show "3 of 4 chips", also
// exactly what the spec says. Six 3-column cells could never fill from a 4-chip
// cap. So ONE band, and the residual is 64. Both columns close on 480 either
// way; flipping this is RP_TOKEN_BANDS 1 -> 2 and RP_RESIDUAL 64 -> 18, one line
// each, and check.mjs will hold the new column to 480 just as tightly.
// ---------------------------------------------------------------------------
const D = {
  1: {
    KB_TOP:4, KB_GAP_STRIP:3, KB_GAP_CARD:3, KB_GAP_ROWS:1, KB_BOTTOM:0,
    KB_ROWS:4,
    RP_TOP:4, RP_RESIDUAL:31, RP_BOTTOM:0,
    RP_PROMPT_LINES:2, RP_REPLY_BANDS:2, RP_TOKEN_BANDS:1, RP_RECENT_BANDS:0,
  },
  2: {
    KB_TOP:6, KB_GAP_STRIP:8, KB_GAP_CARD:16, KB_GAP_ROWS:24, KB_BOTTOM:8,
    KB_ROWS:4,
    RP_TOP:12, RP_RESIDUAL:64, RP_BOTTOM:8,
    RP_PROMPT_LINES:3, RP_REPLY_BANDS:2, RP_TOKEN_BANDS:1, RP_RECENT_BANDS:1,
  },
};

// Font metrics per board. Ids are UI_FONTS[]'s: 1 T_META, 2 T_BODY (== FONT_CODE,
// which aliases body on both boards), 3 T_HEAD. check.mjs re-derives every one of
// these from the firmware's own glyph tables through geom-common's advanceB() and
// lineHB(), so a font swap fails here rather than drifting past.
const ADV  = { 1:{1:6,2:6,3:10}, 2:{1:8,2:8,3:12} };
const CELL = { 1:{1:13,2:13,3:18}, 2:{1:16,2:16,3:24} };

// Every codepoint outside 0x20..0x7E that any draw call has tried to paint.
const BAD_CHARS = new Set();

// ---------------------------------------------------------------------------
// The op list. ["r",x,y,w,h,color,radius?] filled rect, ["s",...] stroked rect,
// ["t",str,xLeft,yTop,fontId,color]. Text ops always store the LEFT x and TOP y
// so an extent is arithmetic rather than a datum lookup.
// ---------------------------------------------------------------------------
class P {
  constructor(board, theme = "DARK") {
    this.b = board; this.k = K[board]; this.d = D[board];
    this.t = TH[theme]; this.theme = theme;
    this.ops = [];        // everything drawn
    this.bands = [];      // {name,y,h,taps} - the vertical column
    this.controls = [];   // {band,kind,label,tested,drawn}
  }
  rect(x,y,w,h,c,r=0){ this.ops.push(["r",x,y,w,h,c,r]); }
  stroke(x,y,w,h,c,r=0){ this.ops.push(["s",x,y,w,h,c,r]); }
  // align: "L" (x is the left edge), "C" (x is the centre), "R" (x is the right
  // edge, exclusive). The stored op is always left-anchored.
  text(s,x,y,f,c,align="L"){
    for (const ch of s) { const cp = ch.codePointAt(0); if (cp < 0x20 || cp > 0x7E) BAD_CHARS.add(cp); }
    const w = s.length * ADV[this.b][f];
    const x0 = align === "C" ? x - (w >> 1) : align === "R" ? x - w : x;
    this.ops.push(["t",s,x0,y,f,c]);
    return w;
  }
  // A string that must fit maxW pixels, truncated with THREE ASCII DOTS. Never
  // U+2026: an out-of-range codepoint draws nothing and advances nothing, so an
  // ellipsis is invisible AND silently shortens the string.
  fit(s,maxW,f){
    const a = ADV[this.b][f];
    if (s.length * a <= maxW) return s;
    const room = Math.floor(maxW / a) - 3;
    return room <= 0 ? "..." : s.slice(0, room) + "...";
  }
  band(name,y,h,taps){ const b={name,y,h,taps}; this.bands.push(b); return b; }
  // One control: its TESTED rect (what handleTouch dispatches on) and its DRAWN
  // rect (what the eye aims at). Recorded so check.mjs can assert the split
  // exists rather than trusting that it does.
  control(band,kind,label,tested,drawn,font,opts={}){
    const t = this.t;
    const r = opts.radius === undefined ? this.k.R_MD : opts.radius;
    if (kind === "send") {
      this.rect(drawn.x,drawn.y,drawn.w,drawn.h,t.good,r);
      this.text(this.fit(label,drawn.w-4,font), drawn.x+(drawn.w>>1), drawn.y+((drawn.h-CELL[this.b][font])>>1), font, t.bg, "C");
    } else if (kind === "insert") {
      // COLOR_CARD fill, NO stroke, FONT_CODE, left aligned, prefixed "+ ":
      // a flag is literal text, and the verb belongs in the control.
      this.rect(drawn.x,drawn.y,drawn.w,drawn.h,t.card,r);
      this.text(this.fit("+ "+label,drawn.w-8,font), drawn.x+4, drawn.y+((drawn.h-CELL[this.b][font])>>1), font, t.value, "L");
    } else if (kind === "reuse") {
      this.rect(drawn.x,drawn.y,drawn.w,drawn.h,t.card,r);
      this.stroke(drawn.x,drawn.y,drawn.w,drawn.h,t.label,r);
      this.text(this.fit(label,drawn.w-8,font), drawn.x+4, drawn.y+((drawn.h-CELL[this.b][font])>>1), font, t.value, "L");
    } else if (kind === "navigate" || kind === "danger") {
      const edge = kind === "danger" ? t.warn : t.accent;
      this.rect(drawn.x,drawn.y,drawn.w,drawn.h,t.card,r);
      this.stroke(drawn.x,drawn.y,drawn.w,drawn.h,edge,r);
      this.text(this.fit(label,drawn.w-4,font), drawn.x+(drawn.w>>1), drawn.y+((drawn.h-CELL[this.b][font])>>1), font, kind === "danger" ? t.warn : t.value, "C");
    } else if (kind === "key") {
      // THE FILLED TILE. uiButton already fills an unpressed control with
      // COLOR_CARD before stroking it, so this is that fill with uiStrokeRound
      // dropped and the label moved from COLOR_ACCENT to COLOR_VALUE. No new
      // palette entry. Whether COLOR_CARD lifts off COLOR_BG without the stroke
      // is a question for COLORTEST and a person; it is not answerable here.
      this.rect(drawn.x,drawn.y,drawn.w,drawn.h,t.card,this.k.KB_KEY_R);
      this.text(this.fit(label,drawn.w,font), drawn.x+(drawn.w>>1), drawn.y+((drawn.h-CELL[this.b][font])>>1), font, t.value, "C");
    } else throw new Error(`control(): unknown kind ${kind}`);
    this.controls.push({band,kind,label,tested,drawn,font});
  }
}

// ---------------------------------------------------------------------------
// The lane and its three columns. The cell is lane/3 and the GAP BELONGS TO THE
// BUTTON ON ITS LEFT, exactly as KB_PITCH relates to KB_KEY_W; the remainder
// lands on the last column so the row closes on the lane exactly (72+72+72=216
// on board 1, 98+98+100=296 on board 2).
// ---------------------------------------------------------------------------
function colWidths(b){ const w = K[b].CARD_W, c = Math.floor(w/3); return [c,c,w-2*c]; }
function colX(b,i){ const cw = colWidths(b); let x = K[b].CARD_X; for (let j=0;j<i;j++) x += cw[j]; return x; }
function colSpan(b,i,n){ const cw = colWidths(b); let w = 0; for (let j=i;j<i+n;j++) w += cw[j]; return w; }
// The horizontal half of the drawn/tested split, and it is the KEY's own gap
// rather than a new number: KB_PITCH - KB_KEY_W, which is 2 on both boards.
function keyGap(b){ return K[b].KB_PITCH - K[b].KB_KEY_W; }

// ---------------------------------------------------------------------------
// The vertical column, as an ordered term list. `at` names the K constant that
// must equal the term's cumulative offset - which is how a drifted gap fails.
// ---------------------------------------------------------------------------
function stack(b, screen) {
  const k = K[b], d = D[b], T = [];
  const push = (name, h, at, taps) => T.push({name, h, at: at||null, taps: !!taps});
  if (screen === "keyboard") {
    push("top margin", d.KB_TOP);
    push("prompt strip", k.KB_STRIP_H, "KB_STRIP_Y", true);
    push("gap", d.KB_GAP_STRIP);
    push("text card", k.KB_TEXT_H, "KB_TEXT_Y", true);
    push("gap", d.KB_GAP_CARD);
    for (let r=0;r<d.KB_ROWS;r++) push(`key row ${r}`, k.KB_ROW_H, r===0?"KB_ROWS_Y":null, true);
    push("gap", d.KB_GAP_ROWS);
    push("action band", k.KB_ACT_H, "KB_ACT_Y", true);
    push("bottom margin", d.KB_BOTTOM);
  } else {
    push("top margin", d.RP_TOP);
    push("prompt card", k.COMPOSE_PROMPT_H, null, true);
    push("gap", k.COMPOSE_GAP);
    push("legend reply", k.COMPOSE_LEGEND_H);
    for (let i=0;i<d.RP_REPLY_BANDS;i++) push(`reply band ${i}`, k.TAP_MIN, null, true);
    push("legend insert", k.COMPOSE_LEGEND_H);
    for (let i=0;i<d.RP_TOKEN_BANDS;i++) push(`token band ${i}`, k.TAP_MIN, null, true);
    push("draft line", k.COMPOSE_DRAFT_H, null, true);
    push("legend recent", k.COMPOSE_LEGEND_H);
    for (let i=0;i<d.RP_RECENT_BANDS;i++) push(`recent band ${i}`, k.TAP_MIN, null, true);
    push("residual", d.RP_RESIDUAL);
    push("action band", k.KB_ACT_H, "KB_ACT_Y", true);
    push("bottom margin", d.RP_BOTTOM);
  }
  let y = 0;
  for (const t of T) { t.y = y; y += t.h; }
  return { terms: T, total: y, find: (n) => T.find(t => t.name === n) };
}

// ---------------------------------------------------------------------------
// SUB-FLOOR CONTROLS, NAMED. Three controls on these two screens are tested
// under TAP_MIN in one dimension, each for a reason this design states rather
// than discovers. The list is exact in both directions: check.mjs fails on a
// sub-floor control that is NOT here (so a new one cannot slip in) and on an
// entry here that is no longer sub-floor (so the list cannot rot). The repo has
// the precedent - HIST_CHIP_H ships at 17 drawn / 24 tested and says so.
// ---------------------------------------------------------------------------
const EXCEPTIONS = [
  { screen:"keyboard", band:/^key row/, axis:"w",
    why:"THE PREMISE OF THIS DESIGN. KB_PITCH is the band kbTouch() divides by, "
       +"and it is 4.27mm on board 1 and 4.93mm on board 2 against a 7.1mm floor. "
       +"floor(BOARD_W / TAP_MIN) is 6 on both boards and QWERTY needs 10, so no "
       +"ten-column layout can clear it. Release-commit and the filled tile make "
       +"the sub-floor key HIT better; the reply panel is what stops asking." },
  { screen:"keyboard", band:"prompt strip", axis:"h",
    why:"A one-line strip is KB_LINE_PITCH + 4 by definition. It is a re-read, "
       +"not an answer: the full paged peek behind it is reachable from the ask "
       +"screen too, and the cost of a miss is one extra tap on a label." },
  // LABELLED, not merely banded: this permits CLR and nothing else. TYPE... was
  // briefly parked on this line and this entry covered it too, which was wrong -
  // TYPE... is the only bridge from the reply panel to free text, so making it
  // the hardest control on the screen to hit inverts the design's own priority.
  // It is in the action band now, and if it ever comes back here it FAILS.
  { screen:"reply", band:"draft line", label:"CLR", axis:"h",
    why:"CLR sits on a line that is one text cell plus its air, so it cannot be "
       +"TAP_MIN tall without a band board 1 does not have (12 spare pixels in "
       +"320). It is the right control to spend that on: CLR is a RECOVERY for a "
       +"draft you can still see and re-edit character by character, so a miss "
       +"costs one more tap and loses nothing. It is TAP_MIN WIDE, so it is short "
       +"in one axis only. Same treatment HIST_CHIP_H already ships with - 17 "
       +"drawn, 24 tested, both under board 1's floor." },
];

// ---------------------------------------------------------------------------
// The content. One fake ask, its extracted chips, and a draft - the host-side
// values the two screens render.
// ---------------------------------------------------------------------------
const ASK = {
  session: "deckhand",
  title: "Run the release script with --no-verify?",
  detail: "The pre-commit hook rejects the vendored font dump in "
        + "firmware/tft_setup/User_Setup.h, which is expected.",
  // The four extraction rules, in order: backticked spans, flags, whitespace-free
  // tokens containing "/", quoted spans. Deduped, first-appearance order, nothing
  // over 32 bytes, capped at 4. These are what the host would have shipped.
  chips: ["--no-verify", "firmware/tft_setup/User_Setup.h", "--dry-run", "yes"],
  // The buttons that answer in one tap.
  replies: ["YES", "NO", "GO AHEAD", "USE THE OTHER ONE", "STOP", "TELL ME MORE"],
  recents: ["yes", "use --no-verify", "not that one"],
};
const DRAFT = "use --no-verify and skip the hook";
const KB_MAX_BYTES_SHOWN = 150;   // the label only; check.mjs parses the real cap

// The keyboard's three pages. KB_ALPHA and KB_SYM are keyboard.ino's own rows;
// KB_SYM2 is new and exists for exactly one reason - the 14 printable ASCII
// characters neither of the other two can reach ($ % * < > [ \ ] ^ ` { | } ~).
// It is SPARSE on purpose: DEL stays on row 2 where muscle memory has it, rather
// than being pulled up to fill row 1.
const PAGES = [
  { name:"ABC",  pager:"?123", rows:["qwertyuiop","asdfghjkl","\u0001zxcvbnm\u0002"] },
  { name:"SYM",  pager:"#+=",  rows:["1234567890","-_/:;()&@#",".,?!'\"+=\u0002"] },
  { name:"SYM2", pager:"ABC",  rows:["$%*<>[]{}|","\\^`~","\u0002"] },
];
const KEY_SHIFT = "\u0001", KEY_DEL = "\u0002";
// ROW 3, AS DATA, because it holds two of the 95 characters and the checker's
// reachability sweep has to read the SAME source the renderer draws from. It
// used to be three inline uiButton calls here and a hand-written
// `reach.add(" "); reach.add(".")` there - a transcription of 2 of the 95, and
// relabelling the period key left the sweep still reporting 95 of 95.
//
// A character cell carries ONLY `emits`; its label is DERIVED from that, exactly
// as keyLabel() derives a letter key's label from its character. So there is no
// label to change independently of the character, which is what closes the hole:
// "relabel the period key" now means editing `emits`, and the sweep sees it.
// `pitch` is the cell's width in KB_PITCHes, 0 meaning "the remainder".
const KB_ROW3 = [
  { pitch:2, emits:null },   // the page pager - a navigate, not a character
  { pitch:6, emits:" " },
  { pitch:0, emits:"." },    // the remainder column
];
function row3Label(cell, page) {
  if (cell.emits === null) return page.pager;
  return cell.emits === " " ? "SPACE" : cell.emits;
}
function keyLabel(c, shift){
  if (c === KEY_SHIFT) return shift === 2 ? "CAPS" : "CAP";
  if (c === KEY_DEL)   return "DEL";
  return shift > 0 && c >= "a" && c <= "z" ? c.toUpperCase() : c;
}

// Hard wrap at KB_COLS - drawKbHardWrapped()'s own algorithm, deliberately not
// word wrap. See the KB_COLS derivation in either board header for why.
function hardWrap(s, cols, maxLines){
  const out = [];
  for (let p = 0; p < s.length && out.length < maxLines; p += cols) out.push(s.slice(p, p+cols));
  return out;
}
// Word wrap for the prompt card's n lines, which IS word-wrapped: the prompt is
// prose the host wrote, not a draft the user is mid-way through typing.
function wordWrap(s, cols, maxLines){
  const words = s.split(" "), out = [];
  let line = "";
  for (const w of words) {
    if (!line) { line = w; continue; }
    if (line.length + 1 + w.length <= cols) line += " " + w;
    else { out.push(line); line = w; if (out.length === maxLines) break; }
  }
  if (out.length < maxLines && line) out.push(line);
  return out.slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// SCREEN 1: the sharpened keyboard.
// ---------------------------------------------------------------------------
function drawKeyboard(p, opt = {}) {
  const k = p.k, b = p.b, t = p.t, S = stack(b, "keyboard");
  const page = PAGES[opt.page || 0], shift = opt.shift || 0;
  p.rect(0,0,k.BOARD_W,k.BOARD_H,t.bg);
  for (const term of S.terms) p.band(term.name, term.y, term.h, term.taps);

  // The PROMPT STRIP. Persistent, one line, and the whole point of it is that
  // re-reading the question no longer covers the keyboard and turns every
  // following tap into a pager tap. Tapping it still opens the full paged peek.
  const strip = S.find("prompt strip");
  p.rect(k.CARD_X, strip.y, k.CARD_W, strip.h, t.card, k.R_MD);
  const stripLane = k.CARD_W - 8;
  p.text(p.fit(ASK.title, stripLane, 1), k.CARD_X+4, strip.y + ((strip.h - CELL[b][1])>>1), 1, t.label);
  p.controls.push({ band:"prompt strip", kind:"peek", label:"prompt strip",
    tested:{x:k.CARD_X,y:strip.y,w:k.CARD_W,h:strip.h},
    drawn:{x:k.CARD_X,y:strip.y,w:k.CARD_W,h:strip.h}, font:1, noSplit:true });

  // THE TEXT CARD. Height, columns and line count all unchanged: the card keeps
  // its 5 PROVABLE lines, so SEND still cannot sign text that is off the card.
  const card = S.find("text card");
  p.rect(k.CARD_X, card.y, k.CARD_W, card.h, t.card, k.R_MD);
  // The RESERVED META ROW. drawString paints an opaque box a full cell tall, so
  // a counter sharing a row with wrapped text silently erases that line's tail -
  // found twice on board 1 before the row was reserved.
  const draft = opt.draft === undefined ? DRAFT : opt.draft;
  p.text(`${draft.length}/${KB_MAX_BYTES_SHOWN}`, k.CARD_X+6, card.y + k.KB_META_DY, 1, t.label);
  p.text("22s", k.CARD_X + k.CARD_W - 6, card.y + k.KB_META_DY, 1, t.label, "R");
  const lines = hardWrap(draft, k.KB_COLS, k.KB_TEXT_LINES);
  lines.forEach((ln,i) => p.text(ln, k.CARD_X+6, card.y + k.KB_LINE0_DY + i*k.KB_LINE_PITCH, 2, t.value));
  // The caret, at the end of the last line. Drag in the card places it; nothing
  // about the caret's POSITION is geometry this mock can assert, so it is drawn
  // where kbLen leaves it and no more is claimed.
  const last = lines.length ? lines[lines.length-1] : "";
  p.rect(k.CARD_X+6 + last.length*ADV[b][2], card.y + k.KB_LINE0_DY + Math.max(0,lines.length-1)*k.KB_LINE_PITCH, 1, CELL[b][2], t.accent);
  p.controls.push({ band:"text card", kind:"caret", label:"text card",
    tested:{x:k.CARD_X,y:card.y,w:k.CARD_W,h:card.h},
    drawn:{x:k.CARD_X,y:card.y,w:k.CARD_W,h:card.h}, font:2, noSplit:true });

  // THE KEY ROWS. Rows 0..2 are the page's characters, centred the way
  // kbRowX0() centres them; row 3 is the pager, SPACE and the period, at
  // keyboard.ino's own 2/6/rest split of the PITCH.
  for (let r = 0; r < 3; r++) {
    const row = page.rows[r], band = S.find(`key row ${r}`);
    const x0 = Math.floor((k.BOARD_W - row.length*k.KB_PITCH) / 2);
    for (let c = 0; c < row.length; c++) {
      const x = x0 + c*k.KB_PITCH;
      const pressed = opt.pressed && opt.pressed[0] === r && opt.pressed[1] === c;
      p.control(band.name, "key", keyLabel(row[c], shift),
        { x, y:band.y, w:k.KB_PITCH, h:band.h },
        { x, y:band.y, w:k.KB_KEY_W, h:band.h - 4 }, 1,
        { radius:k.KB_KEY_R });
      if (pressed) {
        // THE MAGNIFIED BUBBLE. Release-commit means the character under the
        // finger AT RELEASE is what commits, so the bubble is the only way to
        // see which key that is. It is clamped inside the key grid and NEVER
        // touches the text card - for row 0 it is drawn BELOW the finger - which
        // keeps it out of the card's change-only cache entirely.
        const bw = k.KB_PITCH*2, bh = band.h;
        const bx = Math.min(Math.max(x + (k.KB_KEY_W>>1) - (bw>>1), 0), k.BOARD_W - bw);
        const by = r === 0 ? band.y + band.h : band.y - bh;
        p.rect(bx, by, bw, bh, t.accent, k.KB_KEY_R);
        p.text(keyLabel(row[c], shift), bx + (bw>>1), by + ((bh - CELL[b][3])>>1), 3, t.bg, "C");
      }
    }
  }
  {
    // Walked from KB_ROW3 rather than written out, so the row the checker's
    // reachability sweep reads is the row this draws. keyboard.ino's own split
    // is 2 pitches for the pager, 6 for SPACE and the remainder for the period.
    const band = S.find("key row 3"), h = band.h - 4;
    const fixed = KB_ROW3.reduce((a, c) => a + c.pitch, 0) * k.KB_PITCH;
    let x = 0;
    for (const cell of KB_ROW3) {
      const w = cell.pitch ? cell.pitch * k.KB_PITCH : k.BOARD_W - fixed;
      p.control(band.name, "key", row3Label(cell, page),
        { x, y:band.y, w, h:band.h },
        { x, y:band.y, w: w - keyGap(b), h }, 1, { radius:k.KB_KEY_R });
      x += w;
    }
  }

  // THE ACTION BAND. Tested TAP_MIN, drawn 2 * KB_LINE_PITCH centred in it -
  // the split the action row never had, and the reason KB_ACT_H stopped being
  // defined as KB_ROW_H. The left key is BACK, not a destructive control:
  // DISCARD lives on the reply panel, one surface away from a full draft.
  actionRow(p, S.find("action band"), [
    { label:"BACK", kind:"navigate", frac:1 },
    { label:"SEND", kind:"send", frac:2 },
  ]);
}

// THE ACTION BAND IS PROPORTIONAL, AND IT IS NOT THE THREE-COLUMN MODEL. This
// is uiActionRow()'s own arithmetic (Task 3 of the plan), reproduced term for
// term, because the row the mock draws and the row the firmware draws have to be
// the same row:
//
//   gap = 8, lane = BOARD_W - 2 * CARD_X, total = sum(fracs)
//   avail = lane - gap * (n - 1)
//   w[i]  = last ? (CARD_X + lane - x) : avail * fracs[i] / total   (C truncated)
//   band  = w[i] + (last ? 0 : gap)      -- each zone SWALLOWS the gap to its
//                                           right, so no strip between two
//                                           buttons is dead, exactly as
//                                           kbTouch() treats KB_PITCH
//
// FRACS ARE PROPORTIONS, NOT CELLS, and that is the whole point: {1,1,2} puts
// SEND at half the lane and DISCARD at a quarter, so SEND is EXACTLY twice
// DISCARD with a third control still on the row. An earlier draft of this mock
// laid the action row out in the reply panel's lane/3 cells and concluded there
// was no room for TYPE... - which pushed the one bridge from the panel to free
// text onto the draft line, making the design's own 20% case the hardest thing
// on the screen to hit. The cells were the mistake, not the third control.
//
// ACT_GAP WAS THE ONE NUMBER ON THIS SCREEN NOTHING BOUND, and it is bound now:
// Task 3 landed uiActionRow() with `const int gap = 8` inside its body, and
// check.mjs PARSES that literal out of the body - brace-matched from the
// definition, with the parse gated first - the way settings-geom-check.mjs
// parses the severity spine's uiFillRound() arguments. So the gap assertions
// below no longer merely catch the band arithmetic drifting from the DRAW
// arithmetic (the bug the plan's own Step 4 warns about): moving the firmware's
// gap now fails here by name.
const ACT_GAP = 8;
function actionRow(p, band, spec) {
  const k = p.k;
  const lane = k.BOARD_W - 2 * k.CARD_X;
  const n = spec.length, total = spec.reduce((a, s) => a + s.frac, 0);
  const avail = lane - ACT_GAP * (n - 1);
  let x = k.CARD_X;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const w = last ? (k.CARD_X + lane - x) : Math.trunc(avail * spec[i].frac / total);
    p.control(band.name, spec[i].kind, spec[i].label,
      { x, y:band.y, w: w + (last ? 0 : ACT_GAP), h:band.h },
      { x, y:band.y + k.KB_ACT_DY, w, h:k.KB_ACT_DRAWN }, 2);
    x += w + ACT_GAP;
  }
}

// ---------------------------------------------------------------------------
// SCREEN 2: the reply panel. Same column on both boards, one row taller on
// board 2 because recents fit there and do not fit on board 1 - which the
// board-1 panel SAYS on the glass rather than leaving a gap.
// ---------------------------------------------------------------------------
function drawReply(p, opt = {}) {
  const k = p.k, b = p.b, t = p.t, d = p.d, S = stack(b, "reply");
  const sent = !!opt.sent;
  const draft = opt.draft === undefined ? DRAFT : opt.draft;
  p.rect(0,0,k.BOARD_W,k.BOARD_H,t.bg);
  for (const term of S.terms) p.band(term.name, term.y, term.h, term.taps);

  // THE PROMPT CARD: 5 + KB_LINE_PITCH + 4 + n lines + 4. The label row is the
  // session, the lines are the question. Tapping it opens the full paged peek,
  // and the card is well over TAP_MIN so nothing is excepted here.
  const pc = S.find("prompt card");
  p.rect(k.CARD_X, pc.y, k.CARD_W, pc.h, t.card, k.R_MD);
  const lane = k.CARD_W - 12, cols = Math.floor(lane / ADV[b][1]);
  p.text(ASK.session.toUpperCase(), k.CARD_X+6, pc.y + 5, 1, t.label);
  p.text("PEEK", k.CARD_X + k.CARD_W - 6, pc.y + 5, 1, t.accent, "R");
  wordWrap(ASK.title, cols, d.RP_PROMPT_LINES).forEach((ln,i) =>
    p.text(ln, k.CARD_X+6, pc.y + 5 + k.KB_LINE_PITCH + 4 + i*k.KB_LINE_PITCH, 2, t.value));
  p.controls.push({ band:"prompt card", kind:"peek", label:"prompt card",
    tested:{x:k.CARD_X,y:pc.y,w:k.CARD_W,h:pc.h},
    drawn:{x:k.CARD_X,y:pc.y,w:k.CARD_W,h:pc.h}, font:2, noSplit:true });

  legend(p, S.find("legend reply"), "REPLY - ONE TAP SENDS");

  // THE REPLY BUTTONS. send form: filled COLOR_GOOD, label centred, the colour
  // SEND already owns. Three columns per band.
  for (let i = 0; i < d.RP_REPLY_BANDS; i++) {
    const band = S.find(`reply band ${i}`);
    for (let c = 0; c < 3; c++) {
      const idx = i*3 + c, label = ASK.replies[idx];
      if (label === undefined) continue;
      const x = colX(b,c), w = colSpan(b,c,1);
      p.control(band.name, "send", label,
        { x, y:band.y, w, h:band.h },
        { x, y:band.y + k.KB_ACT_DY, w: w - keyGap(b), h: k.KB_ACT_DRAWN }, 2);
    }
  }

  legend(p, S.find("legend insert"), "INSERT AT THE CARET");

  // THE TOKEN CHIPS. insert form: COLOR_CARD fill, no stroke, FONT_CODE, left
  // aligned, prefixed "+ ". The LABEL may be truncated; the VALUE never is -
  // check.mjs asserts every label is a three-dot truncation of its own value.
  for (let i = 0; i < d.RP_TOKEN_BANDS; i++) {
    const band = S.find(`token band ${i}`);
    for (let c = 0; c < 2; c++) {
      const value = ASK.chips[i*2 + c];
      if (value === undefined) continue;
      const x = colX(b,c), w = colSpan(b,c,1);
      p.control(band.name, "insert", value,
        { x, y:band.y, w, h:band.h },
        { x, y:band.y + k.KB_ACT_DY, w: w - keyGap(b), h: k.KB_ACT_DRAWN }, 2);
    }
    // The pager. navigate form: COLOR_CARD fill, COLOR_ACCENT stroke, centred -
    // the shape "?123" already has. "N>" is ASCII; there is no arrow glyph in
    // these fonts and an out-of-range codepoint would draw nothing at all.
    const pages = Math.ceil(ASK.chips.length / 2);
    const x = colX(b,2), w = colSpan(b,2,1);
    p.control(band.name, "navigate", `1/${pages}>`,
      { x, y:band.y, w, h:band.h },
      { x, y:band.y + k.KB_ACT_DY, w: w - keyGap(b), h: k.KB_ACT_DRAWN }, 2);
  }

  // THE DRAFT LINE. Repainted wholesale on every keystroke, like drawKbText()
  // already is, rather than cached: a change-only cache shorter than the string
  // it holds silently stops noticing changes past that point, and this string
  // changes per character. In the sent state it becomes a SENT: receipt.
  //
  // CLR IS THE ONLY CONTROL ON THIS LINE. TYPE... is in the action band, where a
  // full TAP_MIN band is - see actionRow() above for why the earlier "no room for
  // a third control" reading was wrong.
  const dl = S.find("draft line");
  // CLR is TAP_MIN WIDE even though it is three characters: the height is
  // already sub-floor and there is no reason to be short in both axes when the
  // lane has the pixels.
  const clrW = k.TAP_MIN;
  const dlLane = k.CARD_W - 12 - (sent ? 0 : clrW);
  p.rect(k.CARD_X, dl.y, k.CARD_W, dl.h, t.bg);
  if (sent) {
    p.text(p.fit("SENT: " + draft, dlLane, 2), k.CARD_X+6, dl.y + 4, 2, t.good);
  } else {
    p.text(p.fit(draft || "(empty)", dlLane, 2), k.CARD_X+6, dl.y + 4, 2, t.value);
    const clrX = k.CARD_X + k.CARD_W - clrW;
    p.control(dl.name, "navigate", "CLR",
      { x:clrX, y:dl.y, w:clrW, h:dl.h },
      { x:clrX, y:dl.y, w:clrW - keyGap(b), h:dl.h - 2 }, 1, { radius:k.KB_KEY_R });
  }

  // RECENTS DO NOT FIT ON BOARD 1, and the panel says so instead of leaving a
  // gap the reader has to interpret. Both strings are ASCII and both fit their
  // own lane - check.mjs measures them.
  legend(p, S.find("legend recent"),
    d.RP_RECENT_BANDS ? "RECENT - TAP TO REPLACE THE DRAFT"
                      : "RECENTS: NO ROOM ON THIS PANEL");
  for (let i = 0; i < d.RP_RECENT_BANDS; i++) {
    const band = S.find(`recent band ${i}`);
    for (let c = 0; c < 3; c++) {
      const value = ASK.recents[i*3 + c];
      if (value === undefined) continue;
      const x = colX(b,c), w = colSpan(b,c,1);
      // reuse form: COLOR_CARD fill, COLOR_LABEL stroke, left aligned - a
      // recall is not an action, so it is not shaped like one.
      p.control(band.name, "reuse", value,
        { x, y:band.y, w, h:band.h },
        { x, y:band.y + k.KB_ACT_DY, w: w - keyGap(b), h: k.KB_ACT_DRAWN }, 2);
    }
  }

  // THE ACTION BAND, at exactly the same KB_ACT_Y the keyboard's is. That is
  // derived, not arranged: both columns are fixed above it and both close on
  // BOARD_H, so the two surfaces cannot disagree about where SEND lives.
  if (sent) {
    // The row collapses to DONE: a one-tap send has no undo, so nothing that
    // looks like SEND is left on the glass to press again. One frac, so the
    // single button IS the lane.
    actionRow(p, S.find("action band"), [{ label:"DONE", kind:"navigate", frac:1 }]);
  } else {
    // THREE CONTROLS, fracs {1,1,2}: SEND takes half the lane and DISCARD a
    // quarter, so SEND is EXACTLY twice DISCARD - which is what defect 2 asks
    // for - and TYPE... still gets a full TAP_MIN band. DISCARD turns
    // COLOR_WARN and relabels because there is a draft to lose; with no draft it
    // is CLOSE and is not a destructive control at all. Label AND colour, never
    // colour alone. Today's row is CANCEL and SEND at the same width 8px apart.
    actionRow(p, S.find("action band"), [
      draft ? { label:"DISCARD", kind:"danger", frac:1 }
            : { label:"CLOSE", kind:"navigate", frac:1 },
      { label:"TYPE...", kind:"navigate", frac:1 },
      { label:"SEND", kind:"send", frac:2 },
    ]);
  }
}

function legend(p, band, s) {
  const k = p.k, b = p.b;
  p.text(p.fit(s, k.CARD_W - 12, 1), k.CARD_X + 6, band.y + ((band.h - CELL[b][1])>>1), 1, p.t.label);
}

// ---------------------------------------------------------------------------
// SCREENS - every picture the checker draws and the browser renders.
// ---------------------------------------------------------------------------
const SCREENS = [];
for (const b of [1,2]) {
  SCREENS.push({ key:`b${b}/reply`,        board:b, screen:"reply",
                 title:`Board ${b} - reply panel`, draw:(p)=>drawReply(p) });
  SCREENS.push({ key:`b${b}/reply-sent`,   board:b, screen:"reply",
                 title:`Board ${b} - reply panel, sent`, draw:(p)=>drawReply(p,{sent:true}) });
  SCREENS.push({ key:`b${b}/reply-empty`,  board:b, screen:"reply",
                 title:`Board ${b} - reply panel, empty draft`, draw:(p)=>drawReply(p,{draft:""}) });
  SCREENS.push({ key:`b${b}/keyboard`,     board:b, screen:"keyboard",
                 title:`Board ${b} - keyboard, ABC`, draw:(p)=>drawKeyboard(p,{pressed:[1,3]}) });
  SCREENS.push({ key:`b${b}/keyboard-shift`, board:b, screen:"keyboard",
                 title:`Board ${b} - keyboard, CAPS`, draw:(p)=>drawKeyboard(p,{shift:2,pressed:[0,0]}) });
  SCREENS.push({ key:`b${b}/keyboard-sym`, board:b, screen:"keyboard",
                 title:`Board ${b} - keyboard, ?123`, draw:(p)=>drawKeyboard(p,{page:1}) });
  SCREENS.push({ key:`b${b}/keyboard-sym2`,board:b, screen:"keyboard",
                 title:`Board ${b} - keyboard, #+=`, draw:(p)=>drawKeyboard(p,{page:2}) });
}

// The browser shell reads these off globalThis; check.mjs re-exports them from a
// new Function() wrapper. One list, two consumers, no second transcription.
if (typeof globalThis !== "undefined") {
  globalThis.__X = { SCREENS, K, D, ADV, CELL, BAD_CHARS, P, TH, stack, colWidths,
                     colX, colSpan, keyGap, ACT_GAP, EXCEPTIONS, ASK, DRAFT, PAGES,
                     KB_ROW3, row3Label, hardWrap };
}
