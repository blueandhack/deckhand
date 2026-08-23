// SESSIONS tab geometry checker - runs on the Mac, needs no hardware.
//
// WHY THIS EXISTS, and why it is a sibling of usage-geom-check.mjs rather than
// more assertions inside it. The USAGE tab's hazard is a field's CLEAR BOX landing
// on a card border; the sessions tab's hazard is different in kind. Session rows
// and the detail card repaint WHOLESALE, so no clear box can reach their borders -
// what can go wrong here is ARITHMETIC on a row height that is itself computed at
// runtime from the session count. Board 1's own history is the argument: the
// sub-line ends at y+60 and the pill top is y+rowH-22, so a row one pixel short
// draws the pill over the text; and a hardcoded 11-character name cap was
// simultaneously too small on compact rows (room for 19) and too large on tall
// ones (an 8px overlap with the CLAUDE tag). Neither shows up as anything that
// looks like an off-by-one.
//
// So this file re-derives, from the REAL header text, the whole ladder and every
// band it produces, on both boards - which is the only transferable evidence a
// layout change can produce while board 2 is unreachable over USB.
//
//   node sessions-geom-check.mjs             check both boards
//   node sessions-geom-check.mjs --selftest  prove the checker has teeth
import { cacheSizes, consts, DIR, lineH, PANEL, preflight, textWidth } from "./geom-common.mjs";
import fs from "fs";
preflight();

// ---- PER-BOARD TEXT MEASUREMENT, and why this file needed it ----
// geom-common.mjs's textWidth()/lineH() know one type scale: Cozette plus
// Terminus, i.e. board 1's. That was every board's scale when this checker was
// written, and it is not any more - board 2 draws a native Spleen scale (8x16
// body, 12x24 head, 32x64 hero), so every band this file laid out for board 2 was
// being measured at 13px lines the device does not draw. That is the same defect
// class as the counted character lanes the USAGE tab had to have measured instead:
// an assertion that passes while describing a layout the panel does not render.
//
// The mapping comes from UI_FONTS[] in deckhand_display.ino rather than a literal
// table here, so a font swap fails this checker instead of drifting past it.
// Board 1 keeps geom-common's measurement (it is the one checked against the
// device's own 136 recorded widths by preflight()); board 2's faces are genuinely
// monospace, which is asserted rather than assumed.
function parseGfxFont(file) {
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
  const gl = src.slice(src.indexOf("Glyphs[]"));
  const rows = [...gl.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)];
  return rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5], yo: +m[6] }));
}
// UI_FONTS[] both arms: index -> { face, size, cellH }. The #if/#else is walked
// the same way usage-geom-check.mjs walks it (last "#if BOARD_USES_TFT_ESPI" at or
// before the array), and a shape it does not recognise THROWS - a parser that
// silently falls back to a default is worse than the literal it replaces.
function parseUiFonts() {
  const src = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
  const at = src.indexOf("UI_FONTS[] = {");
  if (at < 0) throw new Error("parseUiFonts(): UI_FONTS[] = { not found");
  let ifStart = -1, idx = -1;
  while ((idx = src.indexOf("#if BOARD_USES_TFT_ESPI", idx + 1)) >= 0 && idx < at) ifStart = idx;
  const ifEnd = src.indexOf("#endif", ifStart);
  if (ifStart < 0 || ifEnd < at) throw new Error("parseUiFonts(): no #if/#endif pair around UI_FONTS[]");
  const arms = src.slice(ifStart, ifEnd).split(/\n#else\b/);
  if (arms.length !== 2) throw new Error(`parseUiFonts(): expected one #else, found ${arms.length - 1}`);
  const rowsOf = (arm) => {
    const a = arm.indexOf("UI_FONTS[] = {");
    if (a < 0) throw new Error("parseUiFonts(): UI_FONTS[] missing from one arm");
    const rows = [...arm.slice(a, arm.indexOf("};", a))
      .matchAll(/\{\s*&(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)]
      .map(m => ({ face: m[1], size: +m[2], cellH: +m[3] }));
    if (rows.length !== 5) throw new Error(`parseUiFonts(): expected 5 rows, found ${rows.length}`);
    return rows;
  };
  return { 1: rowsOf(arms[0]), 2: rowsOf(arms[1]) };
}
const UI = parseUiFonts();
// Board 1's own glyph tables, keyed the same way, so ascentB() has one code path.
const FONTS_B1 = {};
for (const id of [1, 2, 3, 4]) FONTS_B1[id] = parseGfxFont(`${UI[1][id].face}.h`);
const GLYPHS = {};   // face name -> glyph table, loaded on demand
function glyphsFor(face) {
  if (!GLYPHS[face]) GLYPHS[face] = parseGfxFont(`${face}.h`);
  return GLYPHS[face];
}
// The board's own cell height for a font id.
function lineHB(b, id) { return UI[b][id].cellH; }
// One glyph's advance, and the monospace check that lets board 2 skip
// geom-common's last-character rule (every Spleen glyph declares xOffset 0 and
// width == xAdvance; a regenerated font that broke that must fail loudly).
function advanceB(b, id) {
  const { face, size } = UI[b][id];
  if (b === 1) return textWidth("AA", id) - textWidth("A", id);  // cancels the last-char rule
  const g = glyphsFor(face);
  for (const q of g)
    if (q.xo !== 0 || q.w !== q.xa)
      throw new Error(`advanceB(): ${face} is no longer monospace - this needs the real last-char rule`);
  return g[0].xa * size;
}
// A face's ASCENT (rows of ink above the baseline), which is what a stacked text
// block's line STEP has to clear: drawString paints an opaque box ascent+descent
// tall, so a step under the ascent means the next line erases ink that is not a
// descender. Read from the glyph table, the same source the shim's own _glyphAb is
// computed from - board 1 keeps geom-common's table, which carries the same yOffset.
function ascentB(b, id) {
  const g = b === 1 ? FONTS_B1[id] : glyphsFor(UI[b][id].face);
  let a = 0;
  for (const q of g) a = Math.max(a, -q.yo);
  return a * UI[b][id].size;
}
function widthB(b, id, s) {
  if (b === 1) return textWidth(s, id);
  const { face, size } = UI[b][id];
  const g = glyphsFor(face);
  let w = 0;
  for (const ch of s) { const q = g[ch.charCodeAt(0) - 0x20]; if (q) w += q.xa * size; }
  return w;
}

const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };
// The board header FIRST, then deckhand_display.ino seeded with it - which is the
// same order the compiler sees, and the reason the derived offsets
// (SESSION_TITLE_Y and friends) resolve at all.
const B = {};
for (const b of [1, 2]) B[b] = consts("deckhand_display.ino", consts(HDR[b]));
const CACHE = cacheSizes("deckhand_display.ino");

// Field caps, straight off SessionInfo in deckhand_display.ino (a char[N] holds
// N-1 characters). These are DATA widths, identical on both boards - which is
// itself the finding for the signature caches below: a wider row does not make
// any of these strings longer, because a signature holds the field's value and
// not the truncated text drawn from it.
const CAP = {
  name: 23, status: 9, title: 43, path: 67, prompt: 103, model: 23, branch: 23,
  askPid: 11, askVoiceSha: 19, sub: 35 /* char sub[36] in drawSessionRow */,
  macTag: 6 /* macTag() caps at 6 on the Mac */, emojiId: 3 /* "-1".."15" */,
};
const T_HERO = 4, T_HEAD = 3, T_BODY = 2, T_META = 1;
// drawSessionRow's NAME_RUNGS[], largest first. Kept in the same order as the
// firmware's array, because SESSION_NAME_TOP_RUNG is an INDEX into it.
const NAME_RUNGS = [T_HERO, T_HEAD, T_BODY];

// Documented, deliberately-unfixed board-1 facts. Every one of them is a place
// board 1's packed content area gives something up; board 2's derivation does
// not, so an entry appearing under 2 means a board-2 layout change quietly gave
// up the same clearance rather than keeping it.
const KNOWN = {
  1: [
    "sub-line lane 184 <= the row's own text lane 172",
    "prompt: 2 lines hold 62 of 100 chars",
    "path: 2 lines hold 62 of 64 chars",
    "ask badge row starts at +27, inside the +28 header touch band",
    // FOUND BY THIS CHECKER, both pre-existing and both left alone because board
    // 1's binary is held byte-identical across the two-board port. Reported
    // rather than fixed - see the task report.
    //
    // (a) Seven or more sessions: the "+N more" strip takes 16px, six rows then
    // come out at (248-15)/6 = 38 - exactly SESSION_ROW_H_MIN, so nothing clamps
    // it - and a compact row's sub-line inks y+25..y+37 while the 2px border owns
    // y+36..y+37. The last two rows of the model/branch line are drawn over the
    // row's own outline. Board 2 cannot reach it: its smallest row is 63.
    "strip 6x38 (compact): sub-line -> border bottom gap -2",
    // (b) The detail screen's two footer strings are drawn at the SAME y. Both use
    // MC_DATUM: "answer this one on your Mac" at cardY + DETAIL_CARD_H + 8 =
    // 60+224+8 = 292, and the history hint at contentBottom() - 10 = 292. Since
    // drawString paints an opaque box and the hint is drawn second, the warning is
    // invisible on this board. Board 2's card leaves 27px between them.
    "\"answer on your Mac\" ends 299 above the history hint at 287",
    // (c) Both under board 1's own TAP_MIN of 40, and its own header comment says
    // so: at board 2's 46+8 the worst-case option stack would be 270 of a 268px
    // content area. The proportion carries across even though the pixels cannot.
    "ask option 32px tall >= TAP_MIN 40",
    "ask option gap 4 separates two decision buttons",
    // (d) The ladder floor, 2px under the least legal compact row - the same
    // arithmetic as (a), stated as the constant rather than as the row it produces.
    "ladder floor 38 >= SESSION_SUBC_Y + line + 2 = 40 (least legal compact row)",
  ],
  2: [],
};

// The six-rung ladder each board header writes out beside SESSION_ROW_H_MAX, as
// the layout each rung DRAWS: t = name + title + model/branch, s = name +
// model/branch, n = big name only, c = compact. Board 1 gives three sessions a
// title and drops to compact at five; board 2 gives FOUR a title and a fifth its
// model/branch line, which is the whole stated return on its extra height. This is
// two hand-written strings on purpose - changing the ladder deliberately should
// cost a deliberate edit here, which is the point of asserting it at all.
const LADDER_SHAPE = { 1: "tttncc", 2: "ttttsn" };
// THE SIX EXPANDED HEIGHTS, one per session count, asserted for the same reason
// LADDER_SHAPE is: changing them deliberately should cost a deliberate edit here.
// Board 1 never expands - it has no surplus height to give and sessionExpandedH()
// returns 0 there unconditionally - so its row is six zeros and that is the claim,
// not an absence of one. Board 2: the top row absorbs the leftover up to
// SESSION_EXP_MAX_H, and 4+ sessions fall back to the uniform ladder because the
// ladder already fills the column.
const EXPANDED_H = { 1: [0, 0, 0, 0, 0, 0], 2: [212, 212, 204, 0, 0, 0] };

const SELFTEST = process.argv.includes("--selftest");
let fail = 0, known = 0;
function chk(cond, msg, allow) {
  if (!cond && allow) { known++; console.log(` known  ${msg}`); return; }
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) fail++;
}
function isKnown(b, msg) { return KNOWN[b].includes(msg); }

if (SELFTEST) {
  // Raise the bottom-anchored pill by 10px on board 2. That is the exact shape of
  // the defect this tab is prone to - the pill drawn over the model/branch line -
  // and it is injected into the OFFSET rather than into a threshold on purpose:
  // it can only be caught by actually laying the bands out and comparing them, so
  // a checker that merely echoed the header's own arithmetic back would pass.
  // 12 rather than 1 because SESSION_TITLE_MIN_H is the PACKED stack and carries a
  // real 3+AIR gap above the pill, so a 1px nudge is inside spec and must not fail.
  // It was 10, which was enough while the four-session rung sat 0px above the
  // packed stack; the re-derived ladder leaves that rung 6px of margin, so 10 now
  // fails only the threshold band table and no longer exercises the PER-RUNG path -
  // which is the one that actually caught the FOOTER_H regression. 12 fails both.
  B[2].SESSION_PILL_UP_T += 12;
  console.log("--selftest: board 2's pill raised 12px into the sub-line; the threshold AND per-rung band assertions MUST fail");
}

// A tall row's vertical bands, as [name, top, bottom-inclusive]. `kind` picks
// which of the three layouts drawSessionRow actually draws at this height.
//
// THE NAME BAND IS SESSION_NAME_H, NOT lineH(T_HERO). On board 1 they are the same
// 26px; on board 2 the band is the HEAD rung's 24 while T_HERO is 64, and laying
// these bands out at 64 would describe a row the device cannot draw (see the
// derivation in board_es3c35p.h). Body lines are the board's own cell height.
function rowBands(b, c, rowH, kind) {
  const L = lineHB(b, T_BODY), N = c.SESSION_NAME_H;
  const bands = [["border top", 0, 1]];
  if (kind === "title") {
    bands.push(["name", c.SESSION_NAME_Y_T, c.SESSION_NAME_Y_T + N - 1]);
    bands.push(["title", c.SESSION_TITLE_Y, c.SESSION_TITLE_Y + L - 1]);
    bands.push(["sub-line", c.SESSION_SUB_Y, c.SESSION_SUB_Y + L - 1]);
    bands.push(["pill", rowH - c.SESSION_PILL_UP_T, rowH - c.SESSION_PILL_UP_T + 17]);
  } else if (kind === "sub") {
    bands.push(["name", c.SESSION_NAME_Y, c.SESSION_NAME_Y + N - 1]);
    bands.push(["sub-line", c.SESSION_SUB2_Y, c.SESSION_SUB2_Y + L - 1]);
    bands.push(["pill", rowH - c.SESSION_PILL_UP, rowH - c.SESSION_PILL_UP + 17]);
  } else if (kind === "name") {
    bands.push(["name", c.SESSION_NAME_Y, c.SESSION_NAME_Y + N - 1]);
    bands.push(["pill", rowH - c.SESSION_PILL_UP, rowH - c.SESSION_PILL_UP + 17]);
  } else {
    // Compact: the pill is TOP-RIGHT, in the lane the name is already measured
    // against (laneRight subtracts its width), so it shares no pixel row question
    // with the text below it and is checked against the border on its own. The name
    // is drawn at the BOTTOM rung here, so it is one body line and not the band.
    bands.push(["name", c.SESSION_NAME_Y, c.SESSION_NAME_Y + L - 1]);
    bands.push(["sub-line", c.SESSION_SUBC_Y, c.SESSION_SUBC_Y + L - 1]);
  }
  bands.push(["border bottom", rowH - 2, rowH - 1]);
  return bands;
}
// sessionExpandedH(), replicated: the leftover after the OTHER rows have taken the
// ladder's height, floored at the packed stack and capped at the all-content
// height. A board that declares no SESSION_EXP_MIN_H never expands, which is
// exactly how board 1 is wired (the constant does not exist in its header and the
// firmware's own arm returns 0 under #if BOARD_USES_TFT_ESPI).
function expandedH(c, count, avail, rowH) {
  if (c.SESSION_EXP_MIN_H === undefined) return 0;
  const leftover = avail - (count - 1) * (rowH + c.SESSION_ROW_GAP);
  if (leftover < c.SESSION_EXP_MIN_H) return 0;
  return Math.min(leftover, c.SESSION_EXP_MAX_H);
}
// sessionRowYAt(), replicated - INCLUDING the centring. A lone expanded card is
// the whole list, so it sits in the middle of the list area; a mixed layout keeps
// its top alignment, because there the stack itself is the rhythm.
function rowYAt(c, pos, n, e, rowH, avail) {
  if (e <= 0) return c.SESSION_ROW_Y0 + pos * (rowH + c.SESSION_ROW_GAP);
  if (pos === 0) return n === 1 ? c.SESSION_ROW_Y0 + Math.trunc((avail - e) / 2)
                               : c.SESSION_ROW_Y0;
  return c.SESSION_ROW_Y0 + e + c.SESSION_ROW_GAP +
         (pos - 1) * (rowH + c.SESSION_ROW_GAP);
}
// sessionExpPromptLines(), replicated: every SESSION_LINE_H above the packed
// minimum buys one more prompt line, up to the field's own byte cap.
function expPromptLines(c, rowH) {
  const n = c.SESSION_EXP_PROMPT_MIN +
            Math.trunc((rowH - c.SESSION_EXP_MIN_H) / c.SESSION_LINE_H);
  return Math.min(Math.max(n, c.SESSION_EXP_PROMPT_MIN), c.SESSION_EXP_PROMPT_MAX);
}
// The expanded card's bands, walked by the SAME running cursor the draw uses -
// which is the point: the blocks are optional (a Codex row has no title, a fresh
// session has no prompt), so a fixed band table would describe a card the device
// does not draw. `have` names which blocks are present.
//
// These are the WORST CASE within each shape: the draw advances by the y
// drawWrappedText actually returns, so a title or prompt that does not fill its
// budgeted lines only ever moves the blocks below it UP, widening the gap to the
// bottom-anchored pill. Budgeting the full count here is therefore the bound, and
// the assertion below reads `gap >= 0` against it.
function expBands(b, c, rowH, have) {
  const L = lineHB(b, T_BODY), N = c.SESSION_NAME_H, G = c.SESSION_LINE_GAP;
  const bands = [["border top", 0, 1],
                 ["name", c.SESSION_NAME_Y_T, c.SESSION_NAME_Y_T + N - 1]];
  let cy = c.SESSION_TITLE_Y;
  if (have.title) {
    bands.push([`title (${c.SESSION_EXP_TITLE_LINES} lines)`, cy,
                cy + c.SESSION_EXP_TITLE_LINES * L - 1]);
    cy += c.SESSION_EXP_TITLE_LINES * L + G;
  }
  if (have.sub) { bands.push(["sub-line", cy, cy + L - 1]); cy += L + G; }
  if (have.prompt) {
    const n = expPromptLines(c, rowH);
    bands.push(["PROMPT label", cy, cy + L - 1]);
    cy += L;                                  // label and value are one block
    bands.push([`prompt (${n} lines)`, cy, cy + n * L - 1]);
    cy += n * L + G;
  }
  if (have.path) bands.push(["path", cy, cy + L - 1]);
  bands.push(["pill", rowH - c.SESSION_PILL_UP_T, rowH - c.SESSION_PILL_UP_T + 17]);
  bands.push(["border bottom", rowH - 2, rowH - 1]);
  return bands;
}
// Which layout drawSessionRow picks for a given height - the SAME three tests it
// makes, so the checker cannot describe a row the device does not draw.
function layoutFor(c, rowH, hasTitle = true) {
  if (rowH < c.SESSION_LARGE_MIN_H) return "compact";
  if (hasTitle && rowH >= c.SESSION_TITLE_MIN_H) return "title";
  if (rowH >= c.SESSION_SUB_MIN_H) return "sub";
  return "name";
}
// The inner edge of a rounded rect's 2px border, x rows down from its top-left
// corner. This is what a 32x32 spinner blit - which paints its own background,
// background pixels included - has to clear.
function borderInnerX(x0, dy, radius, border) {
  const r = radius - border;
  const d = radius - dy;
  if (Math.abs(d) >= r) return x0 + radius;      // still in the arc's dead zone
  return x0 + radius - Math.sqrt(r * r - d * d);
}

for (const b of [1, 2]) {
  const c = B[b], [W, H] = PANEL[b];
  const contentBottom = H - c.FOOTER_H;
  let m;
  console.log(`\n=== board ${b} (${W}x${H}) ===`);
  console.log(`content ${c.CONTENT_Y}..${contentBottom}, air ${c.SESSION_AIR}, ` +
              `row x ${c.SESSION_ROW_X} w ${c.SESSION_ROW_W}, gap ${c.SESSION_ROW_GAP}`);
  console.log(`derived: nameY ${c.SESSION_NAME_Y_T}/${c.SESSION_NAME_Y} title +${c.SESSION_TITLE_Y} ` +
              `sub +${c.SESSION_SUB_Y}/+${c.SESSION_SUB2_Y} pillUp ${c.SESSION_PILL_UP_T}/${c.SESSION_PILL_UP} ` +
              `dot +${c.SESSION_DOT_DY} tag +${c.SESSION_TAG_Y}`);
  const LH = lineHB(b, T_BODY), NH = c.SESSION_NAME_H;
  // Range-checked BEFORE anything indexes with it, and the fault-injection sweep is
  // why: an out-of-range SESSION_NAME_TOP_RUNG used to reach UI[b][undefined] and
  // CRASH the checker, which the sweep counts as "caught" while reporting it as a
  // crash - and a crash says nothing about which assertion would have fired.
  const rungOk = c.SESSION_NAME_TOP_RUNG >= 0 && c.SESSION_NAME_TOP_RUNG < NAME_RUNGS.length;
  chk(rungOk, `SESSION_NAME_TOP_RUNG ${c.SESSION_NAME_TOP_RUNG} indexes NAME_RUNGS[${NAME_RUNGS.length}]`);
  const topRung = rungOk ? NAME_RUNGS[c.SESSION_NAME_TOP_RUNG] : T_BODY;
  console.log(`type scale: name band ${NH} (${UI[b][topRung].face}), ` +
              `body ${LH} (${UI[b][T_BODY].face}, ${advanceB(b, T_BODY)}px advance), ` +
              `hero ${lineHB(b, T_HERO)} (${UI[b][T_HERO].face})`);
  // The header's own line height against the FONT REGISTRY. Every threshold in the
  // board headers is arithmetic on SESSION_LINE_H and SESSION_NAME_H, and the
  // derived offsets in deckhand_display.ino are too - so if either drifts from
  // UI_FONTS[] the whole section is laid out for a face the device does not install.
  chk(c.SESSION_LINE_H === LH,
      `SESSION_LINE_H ${c.SESSION_LINE_H} == uiLineH(T_BODY) ${LH} (${UI[b][T_BODY].face})`);
  // The registry and geom-common's own font table must agree about board 1, or
  // every measurement in this file that still goes through textWidth()/lineH() is
  // describing a different face from the one the sketch installs.
  if (b === 1)
    for (const id of [T_META, T_BODY, T_HEAD, T_HERO])
      chk(lineHB(1, id) === lineH(id),
          `font ${id}: UI_FONTS cellH ${lineHB(1, id)} == geom-common's ${lineH(id)}`);

  // ---- THE NAME LADDER'S HEIGHT TEST, which is a constant in the firmware ----
  // drawSessionRow starts its width walk at SESSION_NAME_TOP_RUNG instead of
  // testing each rung's cell height at runtime, because board 1's binary is frozen
  // and a runtime test costs it flash. So the invariant lives here: the top rung
  // must FIT the band, and must be the TALLEST that does. Get it wrong low and a
  // row draws a name over its own sub-line; wrong high and the row silently gives
  // up a rung it had room for.
  chk(lineHB(b, topRung) <= NH,
      `top name rung (font ${topRung}, ${lineHB(b, topRung)}px) fits the ${NH}px name band`);
  chk(lineHB(b, topRung) === NH,
      `the band IS the top rung's cell (${NH} == ${lineHB(b, topRung)}) - no dead pixels above the tallest name`);
  for (let r = 0; r < c.SESSION_NAME_TOP_RUNG; r++)
    chk(lineHB(b, NAME_RUNGS[r]) > NH,
        `rung ${r} (font ${NAME_RUNGS[r]}, ${lineHB(b, NAME_RUNGS[r])}px) is excluded by HEIGHT, not by taste - it does not fit ${NH}px`);
  for (let r = c.SESSION_NAME_TOP_RUNG + 1; r < NAME_RUNGS.length; r++)
    chk(lineHB(b, NAME_RUNGS[r]) <= NH,
        `rung ${r} (font ${NAME_RUNGS[r]}, ${lineHB(b, NAME_RUNGS[r])}px) is drawable in the band`);

  chk(c.SESSION_ROW_X + c.SESSION_ROW_W <= W - 4,
      `row ${c.SESSION_ROW_X}..${c.SESSION_ROW_X + c.SESSION_ROW_W - 1} fits the ${W}px panel`);

  // ---- the three height thresholds ARE boundaries, not preferences ----
  for (const [label, rowH, kind] of [
    ["SESSION_TITLE_MIN_H", c.SESSION_TITLE_MIN_H, "title"],
    ["SESSION_SUB_MIN_H", c.SESSION_SUB_MIN_H, "sub"],
    ["SESSION_LARGE_MIN_H", c.SESSION_LARGE_MIN_H, "name"],
  ]) {
    const bands = rowBands(b, c, rowH, kind);
    console.log(`  ${label} = ${rowH}:`);
    for (const [n, a, z] of bands) console.log(`    ${n.padEnd(14)} +${a}..+${z}`);
    // The pill is bottom-anchored, so at the threshold it must not reach the text
    // above it. SESSION_SUB_MIN_H is the documented TOUCHING case (board 1's gate
    // admits it), so it is checked one row looser.
    const above = bands[bands.length - 3], pill = bands[bands.length - 2];
    const slack = pill[1] - above[2] - 1;
    if (label === "SESSION_SUB_MIN_H") {
      chk(slack === -1, `${label}: pill top +${pill[1]} lands exactly on the sub-line's last ink row +${above[2]} (the documented boundary)`);
    } else {
      // NOTE the two thresholds differ in kind. SESSION_LARGE_MIN_H is the exact
      // collision boundary (slack 0). SESSION_TITLE_MIN_H is the PACKED STACK,
      // which carries a real 3px (+AIR) gap above the pill - so it is 3 larger
      // than the height at which the pill would actually touch the sub-line. The
      // identity check below (85 + 5*AIR) is what pins it; this only says the
      // layout is legal at the threshold.
      chk(slack >= 0, `${label}: pill top +${pill[1]} clears ${above[0]} ending +${above[2]} by ${slack}`);
    }
    chk(pill[2] <= rowH - 3,
        `${label}: pill ends +${pill[2]} clear of the 2px border at +${rowH - 2}..+${rowH - 1}`);
  }
  // THE THREE IDENTITIES, re-derived from the INK as well as the air. They used to
  // read "85 + 5*AIR" and friends, which was only true while both boards drew the
  // same 26px name and 13px lines: board 2's are 24 and 16, so those forms are off
  // by 4, 5 and -2 respectively and would have failed against a correct header.
  //
  // Each is the same sum the board headers write out as a band table:
  //   TITLE_MIN = two borders + the pill + FIVE gaps/pads (2/2/2/3/2, each +AIR)
  //               + the name band + TWO body lines = 33 + N + 2L + 5*AIR
  //   SUB_MIN   = the title-less stack's own sub-line end, plus the bottom-anchored
  //               pill's offset - i.e. the height at which the pill's first row
  //               lands ON that line's last ink row (the boundary the gate admits)
  //   LARGE_MIN = two borders + two 4+AIR pads + the name band + the pill
  const PILL_H = 18;   // drawStatusPill's own literal, shared by both boards
  chk(c.SESSION_TITLE_MIN_H === 15 + PILL_H + NH + 2 * LH + 5 * c.SESSION_AIR,
      `SESSION_TITLE_MIN_H ${c.SESSION_TITLE_MIN_H} == 15 + pill ${PILL_H} + name ${NH} + 2*line ${LH} + 5*AIR(${c.SESSION_AIR})`);
  chk(c.SESSION_SUB_MIN_H === c.SESSION_SUB2_Y + LH - 1 + c.SESSION_PILL_UP,
      `SESSION_SUB_MIN_H ${c.SESSION_SUB_MIN_H} == sub-line end +${c.SESSION_SUB2_Y + LH - 1} + pillUp ${c.SESSION_PILL_UP}`);
  chk(c.SESSION_LARGE_MIN_H === 12 + NH + PILL_H + 2 * c.SESSION_AIR,
      `SESSION_LARGE_MIN_H ${c.SESSION_LARGE_MIN_H} == 12 + name ${NH} + pill ${PILL_H} + 2*AIR(${c.SESSION_AIR})`);
  // The floor is the least height the COMPACT layout can legally draw: its
  // sub-line inks SUBC_Y..+L-1 against a 2px border owning rowH-2..rowH-1. The
  // "+ 15" this used to read was 13 + 2, a line height with a literal baked in.
  m = `ladder floor ${c.SESSION_ROW_H_MIN} >= SESSION_SUBC_Y + line + 2 = ${c.SESSION_SUBC_Y + LH + 2} (least legal compact row)`;
  chk(c.SESSION_ROW_H_MIN >= c.SESSION_SUBC_Y + LH + 2, m, isKnown(b, m));
  // The compact pill against the LADDER FLOOR rather than only against the rungs
  // the ladder happens to produce. Added because geom-sweep.mjs found
  // SESSION_PILLC_Y completely unguarded on board 2: its ladder never emits a row
  // under SESSION_LARGE_MIN_H, so the per-rung check below never runs there at
  // all - yet drawSessionRow draws the compact layout at ANY height below that
  // threshold, and SESSION_ROW_H_MIN is the shortest height it can be handed. A
  // constant that is only checked on the boards whose ladder reaches it is not
  // checked.
  chk(c.SESSION_PILLC_Y + 17 <= c.SESSION_ROW_H_MIN - 3,
      `compact pill +${c.SESSION_PILLC_Y}..+${c.SESSION_PILLC_Y + 17} clears the border of even the shortest legal row (${c.SESSION_ROW_H_MIN})`);
  chk(c.SESSION_PILLC_Y >= c.BORDER_CARD,
      `compact pill starts +${c.SESSION_PILLC_Y} inside the interior (border owns +0..+${c.BORDER_CARD - 1})`);
  chk(c.SESSION_ROW_H_MAX >= c.SESSION_TITLE_MIN_H,
      `ladder cap ${c.SESSION_ROW_H_MAX} >= the title threshold ${c.SESSION_TITLE_MIN_H} (or no row ever gets a title)`);

  // ---- THE LADDER, exactly as renderSessionsList computes it ----
  const MAX_SESSIONS = 6;
  for (const strip of [false, true]) {
    const avail = contentBottom - c.SESSION_ROW_Y0 - (strip ? c.SESSION_OVERFLOW_H : 0);
    const tags = [];
    for (let n = 1; n <= MAX_SESSIONS; n++) {
      const raw = Math.floor((avail - c.SESSION_ROW_GAP * (n - 1)) / n);
      const rowH = Math.min(Math.max(raw, c.SESSION_ROW_H_MIN), c.SESSION_ROW_H_MAX);
      const used = n * rowH + c.SESSION_ROW_GAP * (n - 1);
      const kind = layoutFor(c, rowH);
      tags.push(`${n}:${rowH}${kind[0]}`);
      chk(used <= avail, `${strip ? "strip " : ""}${n} session(s): ${n}x${rowH} + ${n - 1} gaps = ${used} <= avail ${avail} (${avail - used} left)`);
      // EVERY RUNG CLEARS ITS OWN GATE, with the margin named. layoutFor picks the
      // layout FROM the height, so the pass is structural - the number is the
      // point: it is how far `avail` can move before this rung silently drops a
      // line, which is exactly what a 2px FOOTER_H change did to the old geometry.
      const gate = { title: c.SESSION_TITLE_MIN_H, sub: c.SESSION_SUB_MIN_H,
                     name: c.SESSION_LARGE_MIN_H, compact: c.SESSION_ROW_H_MIN }[kind];
      chk(rowH >= gate,
          `${strip ? "strip " : ""}${n}x${rowH} (${kind}): clears its gate ${gate} by ${rowH - gate}`);
      // Every height the ladder can actually produce must draw a legal row.
      const bands = rowBands(b, c, rowH, kind);
      for (let i = 1; i < bands.length; i++) {
        const gap = bands[i][1] - bands[i - 1][2] - 1;
        // STRICTLY >= 0 here, where the threshold band tables above tolerate the
        // documented -1 boundary. A rung is a height the device actually renders,
        // and the five-session rung sits on that boundary with a 0px gap: 80
        // against SESSION_SUB_MIN_H 79. Allowing -1 here too would let a 1px
        // change to FOOTER_H / TAB_BAR_H / SESSION_ROW_Y0 drop that rung to 79 -
        // a real 1-row pill-over-text overlap - and pass in silence.
        m = `${strip ? "strip " : ""}${n}x${rowH} (${kind}): ${bands[i - 1][0]} -> ${bands[i][0]} gap ${gap}`;
        chk(gap >= 0, m, isKnown(b, m));
      }
      // The bottom-anchored pill against the row's own 2px border, PER RUNG rather
      // than only at the three thresholds. A rung is a height the device actually
      // renders, and the threshold checks above cannot speak for a rung that sits
      // above its gate: the pill moves with rowH, so its distance to the border is
      // fixed by SESSION_PILL_UP alone and a bad offset would be invisible in the
      // band-gap walk (the gap it breaks is pill -> border, which that walk does
      // cover - but only for the heights it happens to visit).
      if (kind !== "compact") {
        const pill = bands[bands.length - 2];
        chk(pill[2] <= rowH - 3,
            `${strip ? "strip " : ""}${n}x${rowH} (${kind}): pill ends +${pill[2]} clear of the border at +${rowH - 2}`);
      }
      if (kind === "compact")
        chk(c.SESSION_PILLC_Y + 17 <= rowH - 3,
            `${strip ? "strip " : ""}${n}x${rowH} (compact): top-right pill +${c.SESSION_PILLC_Y}..+${c.SESSION_PILLC_Y + 17} clears the border at +${rowH - 2}`);
    }
    console.log(`  ladder${strip ? " (+N more strip)" : "             "} avail ${avail}: ${tags.join("  ")}`);
    // THE LADDER'S SHAPE IS THE CLAIM EACH BOARD HEADER MAKES, so it is asserted
    // rather than only printed. This is what guards the `avail` inputs - FOOTER_H,
    // TAB_BAR_H, SESSION_ROW_Y0, SESSION_ROW_GAP - now that the re-derived geometry
    // has real margin at every rung: the fault-injection sweep used to "catch" a
    // 1px FOOTER_H move only because a rung sat one pixel from drawing its pill over
    // its own text, which is being guarded by fragility rather than by an assertion.
    // A rung that silently stops drawing a title or a model/branch line is the
    // failure worth naming, and this is the line that names it.
    if (!strip) {
      const got = [];
      for (let n = 1; n <= MAX_SESSIONS; n++) {
        const raw = Math.floor((avail - c.SESSION_ROW_GAP * (n - 1)) / n);
        got.push(layoutFor(c, Math.min(Math.max(raw, c.SESSION_ROW_H_MIN), c.SESSION_ROW_H_MAX))[0]);
      }
      chk(got.join("") === LADDER_SHAPE[b],
          `ladder shape ${got.join("")} == the ${LADDER_SHAPE[b]} this board's header documents ` +
          `(t=title s=sub-line n=big name only c=compact)`);
    }
  }

  // ---- THE EXPANDED FIRST ROW ----
  // The most urgent session absorbs the height the ladder leaves empty. Every
  // number here is re-derived from the offsets rather than read back from the
  // header's own band table, which is the only way this catches the defect it is
  // for: a card whose content runs into its own bottom-anchored pill.
  {
    const L = lineHB(b, T_BODY), A = c.SESSION_AIR;
    const EXP = c.SESSION_EXP_MIN_H !== undefined;
    if (!EXP) {
      // Board 1's claim is an ABSENCE: no expanded constants, so sessionExpandedH()
      // can only be its `return 0` arm. Asserted rather than assumed, because a
      // half-ported header (constants present, firmware arm not) would otherwise
      // pass in silence.
      chk(c.SESSION_EXP_MAX_H === undefined && c.SESSION_EXP_PROMPT_MAX === undefined,
          `no expanded-row constants: this board's list is uniform by construction`);
      chk(EXPANDED_H[b].every(v => v === 0),
          `EXPANDED_H says this board never expands a row`);
    } else {
      // THE PACKED STACK, as an identity on the offsets. Same shape as
      // SESSION_TITLE_MIN_H's: title lines, sub-line, label, prompt lines and the
      // path, then the 3+AIR gap the bottom-anchored pill needs above it.
      const pathTop = c.SESSION_TITLE_Y +
                      (c.SESSION_EXP_TITLE_LINES * L + c.SESSION_LINE_GAP) +
                      (L + c.SESSION_LINE_GAP) + L +
                      (c.SESSION_EXP_PROMPT_MIN * L + c.SESSION_LINE_GAP);
      const pathEnd = pathTop + L - 1;
      chk(c.SESSION_EXP_MIN_H === pathEnd + 4 + A + c.SESSION_PILL_UP_T,
          `SESSION_EXP_MIN_H ${c.SESSION_EXP_MIN_H} == path end +${pathEnd} + gap ${3 + A} + 1 + pillUp ${c.SESSION_PILL_UP_T}`);
      chk(c.SESSION_EXP_MAX_H === c.SESSION_EXP_MIN_H +
            (c.SESSION_EXP_PROMPT_MAX - c.SESSION_EXP_PROMPT_MIN) * L,
          `SESSION_EXP_MAX_H ${c.SESSION_EXP_MAX_H} == MIN ${c.SESSION_EXP_MIN_H} + ` +
          `${c.SESSION_EXP_PROMPT_MAX - c.SESSION_EXP_PROMPT_MIN} more prompt lines x ${L}`);
      chk(c.SESSION_EXP_MIN_H >= c.SESSION_TITLE_MIN_H,
          `an expanded row (>= ${c.SESSION_EXP_MIN_H}) is always a title row (>= ${c.SESSION_TITLE_MIN_H})`);
      // THE CAP IS THE FIELD'S BYTE CAP, MEASURED. A prompt line past this could
      // never carry ink, and one short of it cuts the field the card exists for.
      const adv = advanceB(b, T_BODY), lane = c.SESSION_SUB_LANE_W;
      const perLine = Math.floor(lane / adv);
      chk(c.SESSION_EXP_PROMPT_MAX * perLine >= CAP.prompt - 3,
          `prompt: ${c.SESSION_EXP_PROMPT_MAX} lines hold ${c.SESSION_EXP_PROMPT_MAX * perLine} of ${CAP.prompt - 3} chars (lane ${lane}px = ${perLine}/line at ${adv}px)`);
      chk((c.SESSION_EXP_PROMPT_MAX - 1) * perLine < CAP.prompt - 3,
          `and ${c.SESSION_EXP_PROMPT_MAX - 1} lines would hold only ${(c.SESSION_EXP_PROMPT_MAX - 1) * perLine} - so the cap is the byte cap, not taste`);
      chk(c.SESSION_EXP_TITLE_LINES * perLine >= CAP.title,
          `title: ${c.SESSION_EXP_TITLE_LINES} wrapped lines hold ${c.SESSION_EXP_TITLE_LINES * perLine} of ${CAP.title} chars`);
      chk(perLine <= 63,
          `the ${lane}px wrapped lane is ${perLine} chars, inside drawWrappedText's 63-char buffer`);
      // EVERY REACHABLE HEIGHT, with the strip case too - and both content
      // extremes, because the cursor SKIPS a missing block: a Codex row carries no
      // title and a session that has not been prompted yet carries no prompt.
      const HAVE = [
        ["all blocks", { title: 1, sub: 1, prompt: 1, path: 1 }],
        ["no title (Codex)", { title: 0, sub: 1, prompt: 1, path: 1 }],
        ["no prompt yet", { title: 1, sub: 1, prompt: 0, path: 1 }],
        ["name + pill only", { title: 0, sub: 0, prompt: 0, path: 0 }],
      ];
      for (const strip of [false, true]) {
        const avail = contentBottom - c.SESSION_ROW_Y0 - (strip ? c.SESSION_OVERFLOW_H : 0);
        const tags = [];
        for (let n = 1; n <= 6; n++) {
          const raw = Math.floor((avail - c.SESSION_ROW_GAP * (n - 1)) / n);
          const rowH = Math.min(Math.max(raw, c.SESSION_ROW_H_MIN), c.SESSION_ROW_H_MAX);
          const e = expandedH(c, n, avail, rowH);
          tags.push(e ? `${n}:${e}(${expPromptLines(c, e)}p)` : `${n}:-`);
          if (!strip)
            chk(e === EXPANDED_H[b][n - 1],
                `${n} session(s): expanded first row ${e} == the ${EXPANDED_H[b][n - 1]} this board documents`);
          if (!e) continue;
          // THE WHOLE STACK STILL FITS. This is the assertion the feature can
          // actually break: the first row grew, the others did not shrink, and the
          // list must still end inside `avail`.
          const used = e + (n - 1) * (rowH + c.SESSION_ROW_GAP);
          chk(used <= avail,
              `${strip ? "strip " : ""}${n} session(s): expanded ${e} + ${n - 1}x${rowH} + ${n - 1} gaps = ${used} <= avail ${avail} (${avail - used} left)`);
          chk(e >= c.SESSION_EXP_MIN_H && e <= c.SESSION_EXP_MAX_H,
              `${strip ? "strip " : ""}${n}: expanded ${e} inside [${c.SESSION_EXP_MIN_H}, ${c.SESSION_EXP_MAX_H}]`);
          // THE ROW STACK, walked exactly as sessionRowYAt() lays it out - which is
          // also what the touch hit test walks, so this is the assertion that says a
          // tap and a card cannot disagree about where a row is.
          for (let pos = 0; pos < n; pos++) {
            const yy = rowYAt(c, pos, n, e, rowH, avail);
            const h = pos === 0 ? e : rowH;
            chk(yy >= c.SESSION_ROW_Y0 && yy + h <= c.SESSION_ROW_Y0 + avail,
                `${strip ? "strip " : ""}${n}: row ${pos} ${yy}..${yy + h - 1} inside the list area ${c.SESSION_ROW_Y0}..${c.SESSION_ROW_Y0 + avail - 1}`);
            if (pos > 0)
              chk(yy === rowYAt(c, pos - 1, n, e, rowH, avail) +
                        (pos === 1 ? e : rowH) + c.SESSION_ROW_GAP,
                  `${strip ? "strip " : ""}${n}: row ${pos} starts exactly one gap below row ${pos - 1}`);
          }
          // A LONE expanded card is CENTRED, and the two margins are asserted equal
          // to within the odd pixel - "card, then 198px of nothing" is what the
          // centring exists to remove, so the number is checked rather than trusted.
          if (n === 1) {
            const yy = rowYAt(c, 0, 1, e, rowH, avail);
            const above = yy - c.SESSION_ROW_Y0;
            const below = c.SESSION_ROW_Y0 + avail - (yy + e);
            chk(Math.abs(above - below) <= 1,
                `${strip ? "strip " : ""}1 session: the lone card is centred - ${above}px above, ${below}px below`);
          }
          for (const [lbl, have] of HAVE) {
            const bands = expBands(b, c, e, have);
            if (!strip && n === 1) {
              console.log(`  expanded ${e} (${lbl}):`);
              for (const [nm, a, z] of bands) console.log(`    ${nm.padEnd(18)} +${a}..+${z}`);
            }
            for (let i = 1; i < bands.length; i++) {
              const gap = bands[i][1] - bands[i - 1][2] - 1;
              chk(gap >= 0,
                  `${strip ? "strip " : ""}${n}x${e} expanded (${lbl}): ${bands[i - 1][0]} -> ${bands[i][0]} gap ${gap}`);
            }
          }
        }
        console.log(`  expanded${strip ? " (+N more strip)" : "           "} avail ${avail}: ${tags.join("  ")}`);
      }
    }
  }

  // ---- the name lane: MEASURED, never counted ----
  const nameX = c.SESSION_ROW_X + c.SESSION_NAME_DX;
  const tagRight = c.SESSION_ROW_X + c.SESSION_ROW_W - 12;
  // Worst blockers: the widest text tag ("CLAUDE/studio", a 6-char Mac tag) on a
  // tall row, and the widest pill label ("WORKING", + 12px of pill) on a compact
  // one. The icon form is narrower (base word + 4 + 13), so it is not the bound.
  const wideTag = widthB(b, T_META, "CLAUDE/studio");
  const iconTag = widthB(b, T_META, "CLAUDE") + 4 + 13;
  chk(wideTag >= iconTag, `text tag ${wideTag}px is the wider blocker (icon form ${iconTag}px)`);
  const laneTall = tagRight - wideTag - nameX - 6;
  const lanePill = c.SESSION_ROW_X + c.SESSION_ROW_W - 16 - (widthB(b, T_META, "WORKING") + 12) - nameX - 6;
  chk(laneTall > 0, `tall-row name lane ${laneTall}px (nameX ${nameX} .. tag at ${tagRight - wideTag})`);
  chk(lanePill > 0, `compact-row name lane ${lanePill}px`);
  // THE TAG AND THE NAME, at the TOP RUNG. drawSessionRow measures the lane from
  // this same tag string and hands it to fitText, so the collision the old fixed
  // 11-character cap caused (a 12-char name running 8px into the CLAUDE tag) cannot
  // recur by arithmetic - but the lane still has to hold at least ONE glyph of the
  // top rung, or fitText returns "" and the row falls all the way to T_BODY for a
  // reason no comment would explain.
  chk(laneTall >= advanceB(b, topRung),
      `tall-row lane ${laneTall}px holds at least one ${lineHB(b, topRung)}px glyph (${advanceB(b, topRung)}px advance) beside the widest tag`);
  // And the 64px face specifically, because that is the rung this board's band
  // excludes: it is excluded by HEIGHT, and the width is the corroborating
  // evidence rather than the reason. 32px advance into a 134px lane is FOUR
  // characters, which is what makes a 64px name band the wrong trade here even
  // though a taller row could physically hold one.
  console.log(`    hero rung (${lineHB(b, T_HERO)}px, ${advanceB(b, T_HERO)}px advance) would fit ` +
              `${Math.floor(laneTall / advanceB(b, T_HERO))} chars in the tall lane, ` +
              `${Math.floor((tagRight - widthB(b, T_META, "CLAUDE") - nameX - 6) / advanceB(b, T_HERO))} with one Mac` +
              `${c.SESSION_NAME_TOP_RUNG > 0 ? " - and is excluded by the band's height anyway" : ""}`);
  // Which rung a full-length name (host caps at 22) lands on. This is a report,
  // not a pass/fail - the ladder always terminates at T_BODY - but it is the one
  // number that says whether the extra width bought anything.
  const worst = "M".repeat(22);
  // The SINGLE-MAC tall row is the common case (dispMacTag() returns "" until a
  // second Mac connects), so it is reported alongside the worst case - it is the
  // lane most rows are actually measured against.
  const laneOne = tagRight - widthB(b, T_META, "CLAUDE") - nameX - 6;
  for (const [lbl, lane] of [["tall", laneTall], ["tall, one Mac", laneOne],
                             ["compact", lanePill]]) {
    // Only the rungs the ladder can actually start from, so the report describes
    // the device's own walk rather than a hypothetical one.
    const rungs = NAME_RUNGS.slice(c.SESSION_NAME_TOP_RUNG);
    const rung = rungs.find(f => widthB(b, f, worst) <= lane);
    const longest = f => { let n = 0; while (widthB(b, f, "M".repeat(n + 1)) <= lane) n++; return n; };
    console.log(`    ${lbl} lane ${lane}px: 22-char name fits at ${rung ? `font ${rung}` : "no rung (truncated at T_BODY)"}` +
                `; longest whole name top rung ${longest(topRung)} / T_BODY ${longest(T_BODY)} chars`);
  }
  // THE TAG'S OWN VERTICAL BAND. Nothing measured it before - the name lane above
  // is an x-wise question, and geom-sweep.mjs reported SESSION_TAG_Y as unguarded
  // on both boards as a result. It is drawn TL_DATUM inside the name band on a tall
  // row, so it has to clear the top border and the line below it, which is the
  // title on a title row and the sub-line on a sub row.
  chk(c.SESSION_TAG_Y >= c.BORDER_CARD,
      `tag row +${c.SESSION_TAG_Y} is inside the interior (border owns +0..+${c.BORDER_CARD - 1})`);
  for (const [n, below] of [["title", c.SESSION_TITLE_Y], ["sub-line", c.SESSION_SUB2_Y]])
    chk(c.SESSION_TAG_Y + lineHB(b, T_META) <= below,
        `tag inks +${c.SESSION_TAG_Y}..+${c.SESSION_TAG_Y + lineHB(b, T_META) - 1}, clear of the ${n} at +${below}`);
  // The accent chevron sits at the row's right edge and must not be walked into.
  chk(tagRight + 4 <= c.SESSION_ROW_X + c.SESSION_ROW_W - 8,
      `tag right edge ${tagRight} clears the chevron's ink at ${c.SESSION_ROW_X + c.SESSION_ROW_W - 8}..${c.SESSION_ROW_X + c.SESSION_ROW_W - 2}`);

  // ---- the spinner blit vs the row's rounded corner ----
  const blitL = c.SESSION_DOT_CX - 16, blitTopRow = c.SESSION_DOT_DY - 16;
  const inner = borderInnerX(c.SESSION_ROW_X, blitTopRow, c.RADIUS, c.BORDER_CARD);
  chk(blitL >= inner,
      `spinner blit left x=${blitL} clears the corner border's inner edge x=${inner.toFixed(2)} on its top row (y+${blitTopRow}) by ${(blitL - inner).toFixed(2)}px`);
  chk(c.SESSION_DOT_CX + 15 < nameX,
      `spinner blit right x=${c.SESSION_DOT_CX + 15} clears the name lane at x=${nameX}`);
  chk(c.SESSION_DOT_DY === c.SESSION_NAME_Y + Math.trunc(NH / 2),
      `dot row +${c.SESSION_DOT_DY} centres on the title-less name band (+${c.SESSION_NAME_Y}..+${c.SESSION_NAME_Y + NH - 1})`);

  // ---- the sub-line lane and the compact row's duration clear box ----
  const textLane = tagRight - nameX;
  m = `sub-line lane ${c.SESSION_SUB_LANE_W} <= the row's own text lane ${textLane}`;
  chk(c.SESSION_SUB_LANE_W <= textLane, m, isKnown(b, m));
  // What that lane HOLDS, measured: buildSessionSubline can emit 35 characters, so
  // a lane under that trims with "...". Reported rather than asserted - trimming is
  // correct behaviour - but it is the number the board headers quote, and one of
  // them quoted it at the wrong advance.
  console.log(`    sub-line lane ${c.SESSION_SUB_LANE_W}px = ${Math.floor(c.SESSION_SUB_LANE_W / advanceB(b, T_META))} chars ` +
              `of buildSessionSubline's ${CAP.sub} worst case`);
  const durBoxLeft = c.SESSION_ROW_X + c.SESSION_ROW_W - 16 - widthB(b, T_META, "0000000") - 1;
  chk(durBoxLeft - nameX - 4 > 0,
      `compact sub-line lane ${durBoxLeft - nameX - 4}px stops 4px short of the duration's clear box at x=${durBoxLeft}`);
  // The duration on a large row is drawn at rowH - SESSION_DUR_UP through
  // drawIfChanged, which clears y-1 .. y+13 - so the offset has to leave 16 rows
  // above the row's own 2px border or that clear box eats it. Nothing checked the y
  // at all before; only the duration's x lane was measured.
  chk(c.SESSION_DUR_UP >= lineHB(b, T_META) + 3,
      `duration clear box ends rowH-${c.SESSION_DUR_UP - lineHB(b, T_META)}, clear of the border at rowH-2 (SESSION_DUR_UP ${c.SESSION_DUR_UP})`);
  chk(c.SESSION_OVERFLOW_H >= lineHB(b, T_META) + 2,
      `"+N more" strip reserves ${c.SESSION_OVERFLOW_H} for a ${lineHB(b, T_META)}px line plus its clear margin`);
  // WHERE the strip is drawn, which nothing checked: sessions.ino places it at
  // contentBottom() - SESSION_OVERFLOW_H + 4 and drawIfChanged clears from y-1 to
  // y+cellH, so at board 2's 16px line the old literal -12 would have cleared into
  // the footer's own first drawn row (contentBottom + 4). Both boards now keep the
  // same single row of overhang into the footer's PADDING and no more.
  {
    const stripY = contentBottom - c.SESSION_OVERFLOW_H + 4;
    const clearEnd = stripY - 1 + lineHB(b, T_META) + 1;
    chk(clearEnd < contentBottom + 4,
        `"+N more" at ${stripY} clears rows ${stripY - 1}..${clearEnd}, above the footer's first drawn row ${contentBottom + 4}`);
  }

  // ---- drawWrappedText's own 63-character line buffer ----
  // A lane wider than 63 characters does not wrap, it DROPS the tail: the buffer
  // is clipped to 63 while pos advances by the full line length.
  const widestLane = Math.max(c.CARD_W - 2 * c.PAD, W - 2 * c.CARD_X - 14, c.CARD_W - 8);
  chk(Math.floor(widestLane / 6) <= 63,
      `widest wrapped lane ${widestLane}px = ${Math.floor(widestLane / 6)} Cozette chars, inside drawWrappedText's 63-char buffer`);

  // ---- the detail card ----
  // THE DETAIL CARD, now measured at each board's OWN type scale - the boundary this
  // file used to draw here (everything below still Cozette-measured, with the
  // findings printed) is gone, because the card's cursor is no longer stepped in
  // Cozette literals. Every step comes from DETAIL_NAME_H / DETAIL_LINE_H /
  // DETAIL_TEXT_LINE_H / DETAIL_AIR, and the band walk below is what proves the
  // steps are big enough for the ink they carry. It reproduces board 1's own
  // documented worst case (+213) exactly, which is the evidence that the model is
  // the device's and not a paraphrase of it.
  const cardY = c.DETAIL_CARD_Y, A = c.DETAIL_AIR, maxW = c.CARD_W - 2 * c.PAD;
  chk(2 + c.MSG_BTN_H <= c.DETAIL_CARD_DY,
      `TYPE chip +2..+${2 + c.MSG_BTN_H - 1} in the header row clears the card at +${c.DETAIL_CARD_DY}`);
  chk(c.MSG_BTN_H + 2 <= c.DETAIL_HEAD_H,
      `TYPE chip (${c.MSG_BTN_W}x${c.MSG_BTN_H}) fits the ${c.DETAIL_HEAD_H}px header touch band`);
  // The header row holds exactly two things and they are anchored to opposite
  // edges: "< Back" at CARD_X, the TYPE chip right-aligned at CARD_X + CARD_W -
  // MSG_BTN_W (msgBtnX() in sessions.ino). Nothing checked that they clear each
  // other - the width was only ever printed - so a chip wide enough to reach the
  // label would have drawn straight over it.
  chk(c.CARD_X + c.CARD_W - c.MSG_BTN_W > c.CARD_X + widthB(b, T_BODY, "< Back"),
      `TYPE chip starts x=${c.CARD_X + c.CARD_W - c.MSG_BTN_W}, "< Back" ends x=${c.CARD_X + widthB(b, T_BODY, "< Back")}`);
  chk(widthB(b, T_BODY, "TYPE") + 8 <= c.MSG_BTN_W,
      `"TYPE" ${widthB(b, T_BODY, "TYPE")}px inside the ${c.MSG_BTN_W}px chip`);
  chk(c.DETAIL_BACK_Y >= c.BORDER_CARD,
      `"< Back" starts +${c.DETAIL_BACK_Y}, clear of the header row's top`);
  chk(c.DETAIL_BACK_Y + lineHB(b, T_BODY) <= c.DETAIL_HEAD_H,
      `"< Back" at +${c.DETAIL_BACK_Y} inks to +${c.DETAIL_BACK_Y + lineHB(b, T_BODY) - 1}, inside the header band`);
  // ---- THE RUNNING CURSOR AS A BAND WALK, worst case (title AND last prompt) ----
  // The name's band is the FONT'S OWN CELL, not DETAIL_NAME_H, so a name font that
  // disagrees with the ink height it is stepped by is caught by the walk as well as
  // by the identity below it - which is exactly what board 2 shipped: rung 4
  // (Spleen 32x64) stepped by 34, so a 64-row box swallowed the title and the pill.
  // Range-checked BEFORE it indexes the registry, for the reason
  // SESSION_NAME_TOP_RUNG already documents: an out-of-range id reaches
  // UI[b][undefined] and CRASHES this checker, which geom-sweep.mjs scores as
  // "caught" while reporting it as a crash - and a crash names no assertion.
  const NFok = c.DETAIL_NAME_FONT >= 1 && c.DETAIL_NAME_FONT <= 4;
  chk(NFok, `DETAIL_NAME_FONT ${c.DETAIL_NAME_FONT} is a font id the registry has (1..4)`);
  const NF = NFok ? c.DETAIL_NAME_FONT : T_BODY;
  const LBLH = lineHB(b, T_META), BODYH = lineHB(b, T_BODY);
  chk(lineHB(b, NF) === c.DETAIL_NAME_H,
      `DETAIL_NAME_FONT ${NF} (${UI[b][NF].face}, ${lineHB(b, NF)}px) IS the ${c.DETAIL_NAME_H}px band it is stepped by`);
  // A label and its value, or two wrapped lines, are drawn one INTERNAL step apart
  // inside a single block, and drawString paints a box ascent+descent tall - so the
  // requirement there is the ASCENT (all non-descender ink survives), not the cell.
  // Board 1's 11px wrapped step against Cozette's 11px ascent is exactly that, and
  // is why it has always looked right there while 11 would have eaten Spleen's ink.
  const asc = ascentB(b, T_META);
  for (const [nm, step] of [["wrapped text line", c.DETAIL_TEXT_LINE_H],
                            ["label -> its value", c.DETAIL_LBL_STEP],
                            ["column label -> its value", c.DETAIL_COL_LBL_STEP]])
    chk(step >= asc,
        `detail ${nm} step ${step} >= the ${asc}px ascent of ${UI[b][T_META].face} (cell ${LBLH})`);
  // Blocks, each [name, first ink row, last ink row]. A wrapped block spans its
  // label through its last line's cell; a column pair spans its labels through its
  // values' cell. Steps are the DERIVED ones, read from the constant table.
  const blk = [];
  let cy = c.DETAIL_PAD_Y, top;
  const textInk = (t, n) => t + (n - 1) * c.DETAIL_TEXT_LINE_H + LBLH - 1;
  blk.push(["name", cy, cy + lineHB(b, NF) - 1]);            cy += c.DETAIL_NAME_STEP;
  blk.push(["title", cy, cy + BODYH - 1]);                   cy += c.DETAIL_TITLE_STEP;
  blk.push(["pill", cy, cy + 17]);                           cy += c.DETAIL_PILL_STEP;
  blk.push(["rule", cy, cy]);                                cy += c.DETAIL_RULE_STEP;
  top = cy; cy += c.DETAIL_LBL_STEP;
  blk.push([`LAST PROMPT + ${c.DETAIL_PROMPT_LINES} lines`, top, textInk(cy, c.DETAIL_PROMPT_LINES)]);
  cy += c.DETAIL_PROMPT_LINES * c.DETAIL_TEXT_LINE_H + 2 + A;
  blk.push(["rule", cy, cy]);                                cy += c.DETAIL_RULE_STEP;
  top = cy; cy += c.DETAIL_LBL_STEP;
  blk.push([`PATH + ${c.DETAIL_PATH_LINES} lines`, top, textInk(cy, c.DETAIL_PATH_LINES)]);
  cy += c.DETAIL_PATH_LINES * c.DETAIL_TEXT_LINE_H + 2 + A;
  top = cy; cy += c.DETAIL_COL_LBL_STEP;
  blk.push(["MODEL / GIT BRANCH", top, cy + BODYH - 1]);      cy += c.DETAIL_COL_VAL_STEP;
  top = cy; cy += c.DETAIL_COL_LBL_STEP;
  blk.push(["STARTED / AGENT", top, cy + BODYH - 1]);
  for (const [nm, a, z] of blk) console.log(`    detail +${String(a).padStart(3)}..+${String(z).padStart(3)} ${nm}`);
  for (let i = 1; i < blk.length; i++)
    chk(blk[i][1] - blk[i - 1][2] - 1 >= 0,
        `detail ${blk[i - 1][0]} -> ${blk[i][0]}: gap ${blk[i][1] - blk[i - 1][2] - 1}`);
  const inkEnd = blk[blk.length - 1][2];
  chk(inkEnd <= c.DETAIL_CARD_H - 3,
      `detail content ends +${inkEnd}, clear of the 2px border at +${c.DETAIL_CARD_H - 2}..+${c.DETAIL_CARD_H - 1} (${c.DETAIL_CARD_H - 2 - inkEnd - 1} rows of slack)`);
  // ---- THE TWO FOOTER STRINGS, measured as BOXES rather than baselines ----
  // Both are MC_DATUM T_META. drawString centres on the ASCENT (poY -= ascent/2 on
  // the baseline it just added) and then paints a box ascent+descent tall, so a
  // string drawn at y inks rows y - ascent/2 .. y - ascent/2 + cell - 1. Measuring
  // the baseline instead under-reported the answer line's bottom by 3px on board 2
  // and put DETAIL_CARD_H's documented ceiling 3px low.
  const mcBox = (y) => { const t = y - Math.floor(asc / 2); return [t, t + LBLH - 1]; };
  const [answerTop, answerBot] = mcBox(cardY + c.DETAIL_CARD_H + 8);
  const [hintTop, hintBot] = mcBox(contentBottom - 10);
  m = `"answer on your Mac" ends ${answerBot} above the history hint at ${hintTop}`;
  chk(answerBot < hintTop, `${m}..${hintBot} (box ${answerTop}..${answerBot})`, isKnown(b, m));
  // The largest card that still clears the hint, printed because it is the number
  // the header's own comment quotes and it was wrong by 3.
  console.log(`    largest DETAIL_CARD_H that clears the hint: ${hintTop - 1 - (answerBot - c.DETAIL_CARD_H)}` +
              ` (this board: ${c.DETAIL_CARD_H})`);
  chk(hintBot < contentBottom,
      `history hint ends ${hintBot} inside contentBottom ${contentBottom}`);
  chk(cardY + c.DETAIL_CARD_H <= contentBottom - 8,
      `detail card ends ${cardY + c.DETAIL_CARD_H - 1}, inside contentBottom ${contentBottom}`);
  // The two-column pairs (MODEL / GIT BRANCH, STARTED / AGENT). drawColValue()
  // clips to the `w` it is GIVEN - verified in sessions.ino, where both the test and
  // the ellipsis budget read `w` - so the question is only whether the two columns
  // fit side by side inside the card's text lane and how much they hold.
  const colW = Math.floor(c.CARD_W / 2) - c.PAD - 4;
  const LX = c.CARD_X + c.PAD, RX = c.CARD_X + Math.floor(c.CARD_W / 2) + 2;
  const dots = widthB(b, T_BODY, "..");
  let whole = 0; while (widthB(b, T_BODY, "M".repeat(whole + 1)) <= colW) whole++;
  let cut = 0; while (widthB(b, T_BODY, "M".repeat(cut + 1)) <= colW - dots) cut++;
  chk(LX + colW < RX, `left column ${LX}..${LX + colW} clears the right column at ${RX} by ${RX - (LX + colW)}`);
  chk(RX + colW <= c.CARD_X + c.CARD_W - c.PAD,
      `right column ends ${RX + colW}, inside the card's text lane at ${c.CARD_X + c.CARD_W - c.PAD}`);
  console.log(`    column value lane ${colW}px: ${whole} chars whole, ${cut} + ".." when clipped`);
  // The line caps against the FIELD's own byte cap - the derivation that decides
  // whether a field is shown whole or silently cut.
  // AT THE BOARD'S OWN ADVANCE, not a hardcoded 6: this was `maxW / 6`, Cozette's,
  // and on board 2 (Spleen 8x16) it therefore claimed 43 characters a line where
  // the panel draws 32 - which is exactly how DETAIL_PROMPT_LINES came to be 3
  // while the field needs 4. advanceB(1, T_META) is 6, so board 1's two KNOWN
  // messages below are unchanged character for character.
  const perLine = Math.floor(maxW / advanceB(b, T_META));
  for (const [fld, cap, lines] of [["prompt", CAP.prompt - 3, c.DETAIL_PROMPT_LINES],
                                   ["path", CAP.path - 3, c.DETAIL_PATH_LINES]]) {
    const holds = lines * perLine;
    m = `${fld}: ${lines} lines hold ${holds} of ${cap} chars`;
    chk(holds >= cap, `${m} (lane ${maxW}px = ${perLine}/line)`, isKnown(b, m));
  }

  // ---- the ask screen ----
  m = `ask badge row starts at +${c.ASK_BADGE_Y}, inside the +${c.DETAIL_HEAD_H} header touch band`;
  chk(c.ASK_BADGE_Y >= c.DETAIL_HEAD_H,
      `ask badge at +${c.ASK_BADGE_Y} clears the ${c.DETAIL_HEAD_H}px header touch band`, isKnown(b, m));
  chk(1 + c.ASK_READ_BTN_H <= c.DETAIL_HEAD_H,
      `READ ALL chip +1..+${c.ASK_READ_BTN_H} fits the ${c.DETAIL_HEAD_H}px header band`);
  chk(c.ASK_READ_BTN_X + c.ASK_READ_BTN_W === W - c.CARD_X,
      `READ ALL right-aligned to the card margin: ${c.ASK_READ_BTN_X}+${c.ASK_READ_BTN_W} = ${W - c.CARD_X}`);
  chk(widthB(b, T_BODY, "READ ALL") < c.ASK_READ_BTN_W - 8,
      `"READ ALL" ${widthB(b, T_BODY, "READ ALL")}px inside the ${c.ASK_READ_BTN_W}px chip`);
  // Board 1's badge inks +27..+39 against a title at +39, i.e. it shares the
  // badge's own last row - harmless with Cozette (whose bottom row is blank for
  // every glyph without a descender) but not a clearance, and not reproduced.
  m = `ask title at +${c.ASK_TITLE_Y} clears the badge row inking to +${c.ASK_BADGE_Y + lineHB(b, T_META) - 1}`;
  chk(c.ASK_TITLE_Y >= c.ASK_BADGE_Y + lineHB(b, T_META), m,
      b === 1 && c.ASK_TITLE_Y === c.ASK_BADGE_Y + lineHB(b, T_META) - 1);
  // The option stack is bottom-anchored, worst case 4 options + the SPEAK/TYPE row.
  const stack = 4 + 1;
  const optTop = contentBottom - stack * (c.ASK_OPT_H + c.ASK_OPT_GAP);
  const titleInk = c.CONTENT_Y + c.ASK_TITLE_Y + 2 * 17;
  chk(optTop > titleInk,
      `worst-case option stack (${stack} x ${c.ASK_OPT_H}+${c.ASK_OPT_GAP}) tops at ${optTop}, below the ask title's 2 lines ending ${titleInk}`);
  // Against TAP_MIN, not a literal 32 - board 2 does clear 46, but an assertion
  // that would still pass if it did not is decoration.
  m = `ask option ${c.ASK_OPT_H}px tall >= TAP_MIN ${c.TAP_MIN}`;
  chk(c.ASK_OPT_H >= c.TAP_MIN, m, isKnown(b, m));
  m = `ask option gap ${c.ASK_OPT_GAP} separates two decision buttons`;
  chk(c.ASK_OPT_GAP >= 8, m, isKnown(b, m));
  // Detail preview lines in the COMMON case (2 options + the input row), code style.
  const optTop2 = contentBottom - 3 * (c.ASK_OPT_H + c.ASK_OPT_GAP);
  const textTop = titleInk + 4;
  // CODE_LINE_H, not a literal 13 - this assertion measured a 13px step against a
  // 16px cell too, so it reported 9 lines where the board can draw 7.
  const vis = Math.floor((optTop2 - 8 - textTop - 14) / c.CODE_LINE_H);
  chk(vis >= 1, `2-option ask shows ${vis} lines of code detail (board 1 shows 4)`);
  // The voice-confirm panel: ASK_VOICE_MAX_LINES wrapped lines plus padding, above
  // SEND. THE LINE STEP IS CODE_LINE_H, NOT A LITERAL 13 - this assertion carried
  // the same Cozette literal the firmware did, so it agreed with the defect rather
  // than catching it, and measured a panel 24px shorter than board 2 would draw.
  chk(c.CODE_LINE_H === lineHB(b, T_BODY),
      `CODE_LINE_H ${c.CODE_LINE_H} is uiLineH(FONT_CODE) - FONT_CODE aliases T_BODY`);
  const panelEnd = c.CONTENT_Y + 22 + c.ASK_VOICE_MAX_LINES * c.CODE_LINE_H + 12;
  const sendY = contentBottom - c.H_BTN - c.H_BTN - c.SP_2;
  chk(panelEnd < sendY,
      `voice transcript panel (${c.ASK_VOICE_MAX_LINES} x ${c.CODE_LINE_H}) ends ${panelEnd}, SEND starts ${sendY}`);
  // The panel's LANE, for the same reason: the cap of 8 lines is only headroom if a
  // 150-byte transcript really wraps under it. Columns at this board's own advance.
  const voiceCols = Math.floor((c.CARD_W - 8) / advanceB(b, T_BODY));
  chk(Math.ceil(150 / voiceCols) <= c.ASK_VOICE_MAX_LINES,
      `a 150-byte transcript wraps to ${Math.ceil(150 / voiceCols)} of ${c.ASK_VOICE_MAX_LINES} lines (${voiceCols} cols)`);

  // ---- the change-only caches, re-derived ----
  // A signature holds FIELD VALUES, not the truncated text drawn from them, so a
  // wider row does not lengthen any of these - the worst cases are identical on
  // both boards, which is why nothing here moved for board 2.
  // A CACHE'S DECLARED LENGTH MAY NOW BE A NAME, not a number: rowSigCache is
  // sized per board (SESSION_ROW_SIG_LEN) because board 2's expanded row signs two
  // more fields and board 1's RAM is held byte-identical. cacheSizes() hands back
  // the dimension as written, so a symbolic one is resolved against THIS board's
  // constant table - unresolved would come out NaN, and `NaN >= n` is false, which
  // reports as a failure rather than passing in silence.
  const cacheLen = (name) => {
    const d = CACHE[name];
    const v = /^\d+$/.test(d) ? +d : c[d];
    if (v === undefined) throw new Error(`cacheLen(): ${name}'s dimension "${d}" is not a known constant`);
    return v;
  };
  let rowSig = CAP.name + 1 + CAP.status + 1 + CAP.sub + 1 + CAP.title + 1 +
               CAP.macTag + 1 + CAP.emojiId + 1;
  // The expanded first row appends the last prompt and the path to its signature -
  // both are DRAWN on that card, and a field drawn but not signed is the staleness
  // the title itself shipped once. Only a board that expands pays for them.
  if (c.SESSION_EXP_MIN_H !== undefined) rowSig += 1 + CAP.prompt + 1 + CAP.path;
  chk(cacheLen("rowSigCache") >= rowSig,
      `rowSigCache ${cacheLen("rowSigCache")} (${CACHE.rowSigCache}) holds its ${rowSig}-byte worst case`);
  const detSig = CAP.name + CAP.status + CAP.path + CAP.model + CAP.branch + CAP.askPid +
                 2 /* answeredIdx */ + CAP.title + CAP.prompt + 11 /* startSec */ +
                 CAP.askVoiceSha + 10 /* separators */ + 2 /* |M */ +
                 1 + CAP.macTag + 1 + CAP.emojiId + 1 /* NUL */;
  chk(cacheLen("detailSigCache") >= detSig,
      `detailSigCache ${CACHE.detailSigCache} holds its ${detSig}-byte worst case`);
  chk(cacheLen("detailDurCache") >= 23,
      `detailDurCache ${CACHE.detailDurCache} holds "for 999h59m - 23:59" padded to 22 + NUL`);
  chk(cacheLen("rowDurCache") >= 8, `rowDurCache ${CACHE.rowDurCache} holds a 7-char padded duration + NUL`);
}

console.log(`\n${fail} failures, ${known} known-and-documented board-1 compromises`);
if (SELFTEST) {
  if (fail === 0) { console.log("SELFTEST FAILED: the checker did not notice a 1px threshold change"); process.exit(1); }
  console.log(`selftest ok - the injected fault produced ${fail} failure(s)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all sessions geometry assertions pass on both boards");
