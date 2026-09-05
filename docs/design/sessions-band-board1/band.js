// ---------------------------------------------------------------------------
// docs/design/sessions-band-board1/band.js - THE STATUS BAND CARD, BOTH BOARDS.
//
// Board 1's card at 240x320 beside board 2's at 320x480, so the two can be
// compared without a device. Four pictures: each board's ONE-session band card
// (the surface this task is about) and each board's multi-session list, where the
// band's compact form - the spine - is what carries the status colour.
//
// WHAT IS EXACT AND WHAT IS NOT, stated up front, the same way compose/ does:
//   - GEOMETRY IS EXACT. Every rectangle, every block boundary and every text
//     ORIGIN is the number the firmware uses, and check.mjs binds K name-for-name
//     to BOTH board headers through the geometry checkers' own consts() parser.
//   - THE BLOCK STACK IS THE POINT. Each card's body is the running cursor
//     drawSessionRow() walks, one SESSION_BAND_* block at a time, and every block
//     is emitted into `blocks` with its own height so the page can label it. That
//     labelled column IS the deliverable: the card's height is the sum of those
//     blocks (SESSION_EXP_MAX_H) and a picture that did not show them would be a
//     picture of a number nobody can check.
//   - GLYPH RENDERING IS APPROXIMATE. The panel draws 1-bit Cozette 6x13 / Spleen
//     8x16; this page steps a browser monospace face at each board's real ADV and
//     CELL. The METRICS are the panel's, the ink inside each cell is not - and
//     inventing a Cozette dump would flatter the design, the mistake the settings
//     mock already paid for.
//   - THE AGENT MARK IS A BOX, not the art. It is a 32x32 2bpp blit on both
//     boards (SPARK_SIZE, parsed by check.mjs) and what matters here is that it
//     OWNS 32x32 of the band - which on board 1 is the whole of the band's
//     interior height and the reason the status word had to give ground.
//
// EVERY STRING HERE IS ASCII 0x20..0x7E. The fonts hold nothing else and an
// out-of-range codepoint draws nothing AND advances nothing, so truncation uses
// THREE ASCII DOTS. BAD_CHARS below is the enforcement and check.mjs scans it
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
// the mock cannot drift from a header while still reporting itself green.
//
// EVERY VALUE HERE IS A LITERAL, on purpose. Writing SESSION_EXP_MAX_H as a sum
// of the blocks beside it would make check.mjs's derivation assertion compare an
// expression against its own term, which always holds. Two independent literals
// can disagree; a derivation cannot.
// ---------------------------------------------------------------------------
const K = {
  1: {
    BOARD_W:240, BOARD_H:320,
    TAB_BAR_H:34, CONTENT_Y:34, FOOTER_H:18,
    TEXT_ADV:6, BORDER_CARD:2, R_MD:10,
    SESSION_ROW_X:8, SESSION_ROW_W:224, SESSION_ROW_Y0:38,
    SESSION_ROW_GAP:3, SESSION_ROW_H_MIN:38, SESSION_ROW_H_MAX:90,
    SESSION_NAME_H:26, SESSION_LINE_H:13, SESSION_NAME_TOP_RUNG:0,
    SESSION_DOT_CX:31, SESSION_NAME_DX:40,
    // the band
    SESSION_BAND_H:34, SESSION_BAND_PAD:10, SESSION_BAND_MARK_GAP:8,
    SESSION_BAND_BODY_X:20, SESSION_BAND_BODY_LANE:200, SESSION_BAND_DUR_CHARS:3,
    // the block stack
    SESSION_BAND_NAME_H:32, SESSION_BAND_SUB_H:24, SESSION_SUB_ICON_GAP:4,
    SESSION_BAND_TITLE_STEP:15, SESSION_BAND_RULE_H:12, SESSION_BAND_LABEL_H:21,
    SESSION_BAND_PROMPT_STEP:18, SESSION_BAND_PATH_H:15, SESSION_BAND_BOTTOM_PAD:4,
    SESSION_EXP_MIN_H:220, SESSION_EXP_MAX_H:256,
    SESSION_EXP_TITLE_LINES:2, SESSION_EXP_PROMPT_MIN:2, SESSION_EXP_PROMPT_MAX:4,
    // the spine
    SESSION_SPINE_W:5, SESSION_SPINE_ON:6, SESSION_SPINE_OFF:4, SESSION_SPINE_INSET:1,
  },
  2: {
    BOARD_W:320, BOARD_H:480,
    TAB_BAR_H:46, CONTENT_Y:46, FOOTER_H:20,
    TEXT_ADV:8, BORDER_CARD:2, R_MD:12,
    SESSION_ROW_X:12, SESSION_ROW_W:296, SESSION_ROW_Y0:50,
    SESSION_ROW_GAP:3, SESSION_ROW_H_MIN:47, SESSION_ROW_H_MAX:100,
    SESSION_NAME_H:24, SESSION_LINE_H:16, SESSION_NAME_TOP_RUNG:1,
    SESSION_DOT_CX:36, SESSION_NAME_DX:40,
    SESSION_BAND_H:44, SESSION_BAND_PAD:14, SESSION_BAND_MARK_GAP:8,
    SESSION_BAND_BODY_X:28, SESSION_BAND_BODY_LANE:264, SESSION_BAND_DUR_CHARS:3,
    SESSION_BAND_NAME_H:34, SESSION_BAND_SUB_H:32, SESSION_SUB_ICON_GAP:4,
    SESSION_BAND_TITLE_STEP:20, SESSION_BAND_RULE_H:18, SESSION_BAND_LABEL_H:28,
    SESSION_BAND_PROMPT_STEP:24, SESSION_BAND_PATH_H:20, SESSION_BAND_BOTTOM_PAD:6,
    SESSION_EXP_MIN_H:288, SESSION_EXP_MAX_H:336,
    SESSION_EXP_TITLE_LINES:2, SESSION_EXP_PROMPT_MIN:2, SESSION_EXP_PROMPT_MAX:4,
    SESSION_SPINE_W:6, SESSION_SPINE_ON:7, SESSION_SPINE_OFF:4, SESSION_SPINE_INSET:1,
  },
};

// The four UI_FONTS[] rungs, per board: [advance, cell]. T_META 1, T_BODY 2,
// T_HEAD 3, T_HERO 4. check.mjs asserts each against the parsed UI_FONTS[] arm
// rather than trusting this table - a font swap must fail there, not on the glass.
const ADV  = { 1: {1:6,2:6,3:10,4:12},  2: {1:8,2:8,3:12,4:32} };
const CELL = { 1: {1:13,2:13,3:18,4:26}, 2: {1:16,2:16,3:24,4:64} };
// The agent mark's blit, square. Parsed from ClaudeSpark.h by check.mjs: it is
// the SAME art on both boards and does not scale, which is exactly why board 1's
// band could not also hold labelForStatus()'s longest phrase.
const SPARK_SIZE = 32;

// The three status words each board's band actually draws. Board 2's 199px word
// lane holds labelForStatus()'s full phrase; board 1's 141px lane does not, so
// bandStatusWord() falls back - MEASURED, not per board - to the words its own
// tall-row pill already draws. check.mjs re-derives which form each board lands
// on from the parsed labels and this board's own room, and fails if this table
// disagrees.
const BAND_WORD = {
  1: { working:"WORKING", asking:"NEEDS INPUT",      waiting:"READY" },
  2: { working:"WORKING", asking:"NEEDS YOUR INPUT", waiting:"WAITING FOR YOU" },
};
const STATUS_TOKEN = { working:"label", asking:"bad", waiting:"good" };

const BAD_CHARS = [];
function ascii(s) {
  for (const ch of String(s))
    if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7E) BAD_CHARS.push([s, ch]);
  return s;
}

// A greedy word wrap at the lane's whole-character width, which is what
// countWrappedLines()/drawWrappedText() do on the device for a monospace face.
function wrap(text, cols, maxLines) {
  const out = [];
  let line = "";
  for (const w of String(text).split(/\s+/)) {
    const probe = line ? line + " " + w : w;
    if (probe.length <= cols) { line = probe; continue; }
    if (line) out.push(line);
    line = w.length <= cols ? w : w.slice(0, cols);
  }
  if (line) out.push(line);
  return maxLines ? out.slice(0, maxLines) : out;
}

// The op-list painter. "r" fill, "s" stroke, "t" text (top-left of the CELL box).
// `blocks` is the annotation layer: one entry per SESSION_BAND_* block the body
// cursor spends, which is what the page labels beside the card.
class P {
  constructor(board, theme) {
    this.b = board; this.k = K[board]; this.t = TH[theme]; this.theme = theme;
    this.ops = []; this.blocks = [];
  }
  fill(x,y,w,h,c,r)   { this.ops.push(["r",x,y,w,h,c,r||0]); }
  stroke(x,y,w,h,c,r) { this.ops.push(["s",x,y,w,h,c,r||0]); }
  text(s,x,y,f,c)     { this.ops.push(["t",ascii(s),x,y,f,c]); }
  block(name,y,h)     { this.blocks.push({ name, y, h }); }
}

// ---------------------------------------------------------------------------
// THE BAND CARD, drawn exactly as drawSessionRow()'s expanded arm draws it: the
// band first, then a running cursor over the block stack, with the rule+path
// group BOTTOM-ANCHORED. A block the session does not have costs nothing and the
// blocks below it move up - which is why the card's height is its content's.
// ---------------------------------------------------------------------------
const SESSION = {
  name: "deckhand",
  status: "working",
  dur: " 4m",
  sub: "CC opus-5 (main)",
  title: "make sure board 1 aligns with board 2 as much as you can",
  // 99 CHARACTERS AGAINST prompt[104]'S 100-CHARACTER CAP - the worst case the block
  // stack is summed from, so this picture is the card at SESSION_EXP_MAX_H rather
  // than a shorter one that happens to look tidy. Both boards wrap it to FOUR
  // lines, because both their body lanes are 33 columns.
  prompt: "port the status band card across to board 1 so that the one-session " +
          "screen stops being 174px of air",
  path: "~/projects/deckhand",
};

function drawBandCard(p, y, h, s) {
  const k = p.k, t = p.t;
  const col = t[STATUS_TOKEN[s.status]];
  const lane = k.SESSION_BAND_BODY_LANE;
  const cols = Math.floor(lane / k.TEXT_ADV);
  const nameFont = [4,3,2][k.SESSION_NAME_TOP_RUNG];

  // The card: fill, then one even 2px ring.
  p.fill(k.SESSION_ROW_X, y, k.SESSION_ROW_W, h, t.card, k.R_MD);
  p.stroke(k.SESSION_ROW_X, y, k.SESSION_ROW_W, h, t.label, k.R_MD);

  // ---- the band, on the card INTERIOR so its fill cannot reach the outline ----
  const ix = k.SESSION_ROW_X + k.BORDER_CARD, iw = k.SESSION_ROW_W - 2 * k.BORDER_CARD;
  const bh = k.SESSION_BAND_H - k.BORDER_CARD;
  p.fill(ix, y + k.BORDER_CARD, iw, bh, col, k.R_MD - k.BORDER_CARD);
  p.fill(ix, y + k.BORDER_CARD + (k.R_MD - k.BORDER_CARD), iw,
         bh - (k.R_MD - k.BORDER_CARD), col);
  p.block("band SESSION_BAND_H", y, k.SESSION_BAND_H);

  // the agent mark: a 32x32 blit, PAD inside the interior, vertically centred
  const markX = ix + k.SESSION_BAND_PAD;
  const markY = y + k.BORDER_CARD + Math.trunc((bh - SPARK_SIZE) / 2);
  p.stroke(markX, markY, SPARK_SIZE, SPARK_SIZE, t.card);
  p.text("CC", markX + 8, markY + SPARK_SIZE / 2 - CELL[p.b][2] / 2, 2, t.card);

  // the duration: a FIXED SESSION_BAND_DUR_CHARS lane, right-anchored PAD inside
  const durW = k.SESSION_BAND_DUR_CHARS * ADV[p.b][2];
  p.text(s.dur, ix + iw - k.SESSION_BAND_PAD - durW,
         y + k.BORDER_CARD + Math.trunc((bh - CELL[p.b][2]) / 2), 2, t.card);

  // the status WORD, T_HEAD, in whatever form this board's lane holds
  const wordX = ix + k.SESSION_BAND_PAD + SPARK_SIZE + k.SESSION_BAND_MARK_GAP;
  p.text(BAND_WORD[p.b][s.status], wordX,
         y + k.BORDER_CARD + Math.trunc((bh - CELL[p.b][3]) / 2), 3, t.card);

  // ---- the body: a running cursor over the block stack ----
  const bx = k.SESSION_BAND_BODY_X;
  let cy = y + k.SESSION_BAND_H;
  p.text(s.name, bx, cy + Math.trunc((k.SESSION_BAND_NAME_H - CELL[p.b][nameFont]) / 2),
         nameFont, t.value);
  p.block("name SESSION_BAND_NAME_H", cy, k.SESSION_BAND_NAME_H);
  cy += k.SESSION_BAND_NAME_H;

  if (s.sub) {
    p.text(s.sub, bx, cy, 1, t.label);
    p.block("sub SESSION_BAND_SUB_H", cy, k.SESSION_BAND_SUB_H);
    cy += k.SESSION_BAND_SUB_H;
  }
  if (s.title) {
    const lines = wrap(s.title, cols, k.SESSION_EXP_TITLE_LINES);
    lines.forEach((l, i) => p.text(l, bx, cy + i * k.SESSION_BAND_TITLE_STEP, 2, t.value));
    p.block(`title ${lines.length}x SESSION_BAND_TITLE_STEP`,
            cy, lines.length * k.SESSION_BAND_TITLE_STEP);
    cy += lines.length * k.SESSION_BAND_TITLE_STEP;
  }
  if (s.prompt) {
    p.fill(bx, cy + Math.trunc((k.SESSION_BAND_RULE_H - 1) / 2), lane, 1, t.label);
    p.block("rule SESSION_BAND_RULE_H", cy, k.SESSION_BAND_RULE_H);
    cy += k.SESSION_BAND_RULE_H;
    p.text("LAST PROMPT", bx, cy, 1, t.label);
    p.block("label SESSION_BAND_LABEL_H", cy, k.SESSION_BAND_LABEL_H);
    cy += k.SESSION_BAND_LABEL_H;
    const lines = wrap(s.prompt, cols, k.SESSION_EXP_PROMPT_MAX);
    lines.forEach((l, i) => p.text(l, bx, cy + i * k.SESSION_BAND_PROMPT_STEP, 2, t.value));
    p.block(`prompt ${lines.length}x SESSION_BAND_PROMPT_STEP`,
            cy, lines.length * k.SESSION_BAND_PROMPT_STEP);
    cy += lines.length * k.SESSION_BAND_PROMPT_STEP;
  }
  if (s.path) {
    // BOTTOM-ANCHORED, exactly as the draw anchors it: run off the cursor it would
    // end wherever the content stopped, and a card with no title would put all of
    // that difference below the last thing on it.
    const pathTop = y + h - k.SESSION_BAND_BOTTOM_PAD - k.SESSION_BAND_PATH_H;
    p.fill(bx, pathTop - k.SESSION_BAND_RULE_H + Math.trunc((k.SESSION_BAND_RULE_H - 1) / 2),
           lane, 1, t.label);
    p.block("rule2 SESSION_BAND_RULE_H", pathTop - k.SESSION_BAND_RULE_H, k.SESSION_BAND_RULE_H);
    p.text(s.path, bx, pathTop, 1, t.label);
    p.block("path SESSION_BAND_PATH_H", pathTop, k.SESSION_BAND_PATH_H);
  }
  p.block("pad SESSION_BAND_BOTTOM_PAD", y + h - k.SESSION_BAND_BOTTOM_PAD,
          k.SESSION_BAND_BOTTOM_PAD);
  return cy - y;   // where the body cursor ended, card-relative
}

// The spine: SESSION_SPINE_W of status colour down the row's left edge, drawn on
// the interior. A capsule at the interior radius carved back with a STRAIGHT rect,
// which is what bounds the ink at x + SESSION_SPINE_W - 1 on every row.
function drawSpine(p, y, h, status, codex) {
  const k = p.k, col = p.t[STATUS_TOKEN[status]];
  const r = k.R_MD - k.BORDER_CARD;
  const x = k.SESSION_ROW_X + k.BORDER_CARD;
  const sy = y + k.BORDER_CARD + k.SESSION_SPINE_INSET;
  const sh = h - 2 * k.BORDER_CARD - 2 * k.SESSION_SPINE_INSET;
  p.fill(x, sy, 2 * r, sh, col, r);
  p.fill(x + k.SESSION_SPINE_W, sy, 2 * r - k.SESSION_SPINE_W, sh, p.t.card);
  if (!codex) return;
  for (let yy = r + k.SESSION_SPINE_ON; yy + k.SESSION_SPINE_OFF <= sh - r;
       yy += k.SESSION_SPINE_ON + k.SESSION_SPINE_OFF)
    p.fill(x, sy + yy, k.SESSION_SPINE_W, k.SESSION_SPINE_OFF, p.t.card);
}

function drawCompactRow(p, y, h, s) {
  const k = p.k, t = p.t;
  p.fill(k.SESSION_ROW_X, y, k.SESSION_ROW_W, h, t.card, k.R_MD);
  p.stroke(k.SESSION_ROW_X, y, k.SESSION_ROW_W, h, t[STATUS_TOKEN[s.status]], k.R_MD);
  drawSpine(p, y, h, s.status, s.codex);
  // the 32x32 indicator blit still draws - the spine is a SECOND carrier, never
  // the only one, and the same is true of the text pill below.
  p.stroke(k.SESSION_DOT_CX - SPARK_SIZE / 2, y + 3, SPARK_SIZE, SPARK_SIZE, t.label);
  const nx = k.SESSION_ROW_X + k.SESSION_NAME_DX;
  p.text(s.name, nx, y + 4, 4, t.value);
  p.text(s.sub, nx, y + 4 + CELL[p.b][4] + 4, 1, t.label);
  const word = BAND_WORD[p.b][s.status];
  const pw = word.length * ADV[p.b][1] + 12;
  p.fill(k.SESSION_ROW_X + k.SESSION_ROW_W - 16 - pw, y + h - 26, pw, 18,
         s.status === "asking" ? t.bad : t.card, 9);
  p.text(word, k.SESSION_ROW_X + k.SESSION_ROW_W - 16 - pw + 6, y + h - 26 + 2, 1,
         s.status === "asking" ? t.bg : t.label);
}

// ---------------------------------------------------------------------------
// The four screens.
// ---------------------------------------------------------------------------
function chrome(p, title) {
  const k = p.k, t = p.t;
  p.fill(0, 0, k.BOARD_W, k.BOARD_H, t.bg);
  p.fill(0, 0, k.BOARD_W, k.TAB_BAR_H, t.card);
  p.text("USAGE  SESSIONS  SETTINGS", 8, Math.trunc((k.TAB_BAR_H - CELL[p.b][1]) / 2), 1, t.label);
  p.fill(0, k.BOARD_H - k.FOOTER_H, k.BOARD_W, k.FOOTER_H, t.card);
  p.text(title, 8, k.BOARD_H - k.FOOTER_H + 2, 1, t.label);
}
const contentBottom = (k) => k.BOARD_H - k.FOOTER_H;

const SCREENS = [];
for (const b of [1, 2]) {
  SCREENS.push({
    board: b, title: `board ${b} - ONE session, the band card`, sessions: 1,
    draw(p) {
      const k = p.k;
      chrome(p, "the band card");
      const h = k.SESSION_EXP_MAX_H;
      p.cursorEnd = drawBandCard(p, k.SESSION_ROW_Y0, h, SESSION);
      p.cardH = h;
      p.avail = contentBottom(k) - k.SESSION_ROW_Y0;
    },
  });
  SCREENS.push({
    board: b, title: `board ${b} - THREE sessions, spine rows`, sessions: 3,
    draw(p) {
      const k = p.k;
      chrome(p, "the spine, the band's compact form");
      const avail = contentBottom(k) - k.SESSION_ROW_Y0;
      const rowH = Math.min(Math.max(Math.trunc((avail - 2 * k.SESSION_ROW_GAP) / 3),
                                     k.SESSION_ROW_H_MIN), k.SESSION_ROW_H_MAX);
      const rows = [
        { name:"deckhand", sub:"CC opus-5 (main)",   status:"asking",  codex:false },
        { name:"host",     sub:"CX gpt-5.6 (main)",  status:"working", codex:true  },
        { name:"hooks",    sub:"CC opus-5 (align)",  status:"waiting", codex:false },
      ];
      rows.forEach((s, i) =>
        drawCompactRow(p, k.SESSION_ROW_Y0 + i * (rowH + k.SESSION_ROW_GAP), rowH, s));
      p.rowH = rowH;
      p.avail = avail;
    },
  });
}

globalThis.__X = { SCREENS, K, ADV, CELL, TH, BAD_CHARS, P, SPARK_SIZE, BAND_WORD,
                   STATUS_TOKEN, SESSION, wrap, contentBottom };
