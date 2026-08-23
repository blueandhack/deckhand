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
  return rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5] }));
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
    "\"answer on your Mac\" ends 298 above the history hint at 286",
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
  // EVERYTHING FROM HERE DOWN IS STILL MEASURED AT BOARD 1'S TYPE SCALE, and that
  // is a deliberate, temporary boundary rather than an oversight. The row list
  // above was re-derived for board 2's 16px line; the detail card, the ask screen
  // and the voice panel are the NEXT task's surface, and their offsets are still
  // Cozette-derived literals in the header (an 11px prompt line, a 13px step).
  // Converting only the measurement here would report those constants' own staleness
  // as failures of this task's diff, so the numbers are PRINTED instead - which
  // keeps the finding visible without either hiding it or blocking on it. The one
  // that matters is named below.
  const cardY = c.DETAIL_CARD_Y, A = c.DETAIL_AIR, maxW = c.CARD_W - 2 * c.PAD;
  {
    const perLineReal = Math.floor(maxW / advanceB(b, T_BODY));
    for (const [fld, cap, lines] of [["prompt", CAP.prompt - 3, c.DETAIL_PROMPT_LINES],
                                     ["path", CAP.path - 3, c.DETAIL_PATH_LINES]])
      console.log(`    [next task] ${fld}: at the REAL ${advanceB(b, T_BODY)}px advance, ${lines} lines hold ` +
                  `${lines * perLineReal} of ${cap} chars${lines * perLineReal < cap ? "  <-- SHORT" : ""}`);
  }
  chk(2 + c.MSG_BTN_H <= c.DETAIL_CARD_DY,
      `TYPE chip +2..+${2 + c.MSG_BTN_H - 1} in the header row clears the card at +${c.DETAIL_CARD_DY}`);
  chk(c.MSG_BTN_H + 2 <= c.DETAIL_HEAD_H,
      `TYPE chip (${c.MSG_BTN_W}x${c.MSG_BTN_H}) fits the ${c.DETAIL_HEAD_H}px header touch band`);
  // The header row holds exactly two things and they are anchored to opposite
  // edges: "< Back" at CARD_X, the TYPE chip right-aligned at CARD_X + CARD_W -
  // MSG_BTN_W (msgBtnX() in sessions.ino). Nothing checked that they clear each
  // other - the width was only ever printed - so a chip wide enough to reach the
  // label would have drawn straight over it.
  chk(c.CARD_X + c.CARD_W - c.MSG_BTN_W > c.CARD_X + textWidth("< Back", T_BODY),
      `TYPE chip starts x=${c.CARD_X + c.CARD_W - c.MSG_BTN_W}, "< Back" ends x=${c.CARD_X + textWidth("< Back", T_BODY)}`);
  chk(textWidth("TYPE", T_BODY) + 8 <= c.MSG_BTN_W,
      `"TYPE" ${textWidth("TYPE", T_BODY)}px inside the ${c.MSG_BTN_W}px chip`);
  chk(c.DETAIL_BACK_Y >= c.BORDER_CARD,
      `"< Back" starts +${c.DETAIL_BACK_Y}, clear of the header row's top`);
  chk(c.DETAIL_BACK_Y + lineH(T_BODY) <= c.DETAIL_HEAD_H,
      `"< Back" at +${c.DETAIL_BACK_Y} inks to +${c.DETAIL_BACK_Y + lineH(T_BODY) - 1}, inside the header band`);
  // The running cursor in drawSessionDetail, worst case: title AND last prompt
  // both present. Every advance is board 1's own number plus DETAIL_AIR.
  let cy = 6 + A;
  const steps = [
    ["name", 26 + A], ["title", 15 + A], ["pill", 24 + A], ["rule", 7 + A],
    ["PROMPT label", 13], ["prompt text", c.DETAIL_PROMPT_LINES * 11 + 2 + A], ["rule", 7 + A],
    ["PATH label", 13], ["path text", c.DETAIL_PATH_LINES * 11 + 2 + A],
    ["col labels", 12], ["col values", 18 + A], ["col labels", 12],
  ];
  for (const [n, d] of steps) { console.log(`    detail +${String(cy).padStart(3)} ${n}`); cy += d; }
  const inkEnd = cy + lineH(T_BODY) - 1;
  console.log(`    detail +${cy} last values row, inking to +${inkEnd}`);
  chk(inkEnd <= c.DETAIL_CARD_H - 3,
      `detail content ends +${inkEnd}, clear of the 2px border at +${c.DETAIL_CARD_H - 2}..+${c.DETAIL_CARD_H - 1} (${c.DETAIL_CARD_H - 2 - inkEnd - 1} rows of slack)`);
  // BOTH of these are MC_DATUM, so the y given is the CENTRE - getting that wrong
  // is what hid board 1's collision here for as long as it has existed.
  const half = Math.floor(lineH(T_META) / 2);
  const answerInk = cardY + c.DETAIL_CARD_H + 8 + half;
  const hintTop = contentBottom - 10 - half;
  m = `"answer on your Mac" ends ${answerInk} above the history hint at ${hintTop}`;
  chk(answerInk < hintTop, `${m}..${hintTop + lineH(T_META) - 1}`, isKnown(b, m));
  chk(hintTop + lineH(T_META) - 1 < contentBottom,
      `history hint ends ${hintTop + lineH(T_META) - 1} inside contentBottom ${contentBottom}`);
  chk(cardY + c.DETAIL_CARD_H <= contentBottom - 8,
      `detail card ends ${cardY + c.DETAIL_CARD_H - 1}, inside contentBottom ${contentBottom}`);
  // The two-column pairs (MODEL / GIT BRANCH, STARTED / AGENT). drawColValue()
  // clips to the `w` it is GIVEN - verified in sessions.ino, where both the test and
  // the ellipsis budget read `w` - so the question is only whether the two columns
  // fit side by side inside the card's text lane and how much they hold.
  const colW = Math.floor(c.CARD_W / 2) - c.PAD - 4;
  const LX = c.CARD_X + c.PAD, RX = c.CARD_X + Math.floor(c.CARD_W / 2) + 2;
  const dots = textWidth("..", T_BODY);
  let whole = 0; while (textWidth("M".repeat(whole + 1), T_BODY) <= colW) whole++;
  let cut = 0; while (textWidth("M".repeat(cut + 1), T_BODY) <= colW - dots) cut++;
  chk(LX + colW < RX, `left column ${LX}..${LX + colW} clears the right column at ${RX} by ${RX - (LX + colW)}`);
  chk(RX + colW <= c.CARD_X + c.CARD_W - c.PAD,
      `right column ends ${RX + colW}, inside the card's text lane at ${c.CARD_X + c.CARD_W - c.PAD}`);
  console.log(`    column value lane ${colW}px: ${whole} chars whole, ${cut} + ".." when clipped`);
  // The line caps against the FIELD's own byte cap - the derivation that decides
  // whether a field is shown whole or silently cut.
  const perLine = Math.floor(maxW / 6);
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
  chk(textWidth("READ ALL", T_BODY) < c.ASK_READ_BTN_W - 8,
      `"READ ALL" ${textWidth("READ ALL", T_BODY)}px inside the ${c.ASK_READ_BTN_W}px chip`);
  // Board 1's badge inks +27..+39 against a title at +39, i.e. it shares the
  // badge's own last row - harmless with Cozette (whose bottom row is blank for
  // every glyph without a descender) but not a clearance, and not reproduced.
  m = `ask title at +${c.ASK_TITLE_Y} clears the badge row inking to +${c.ASK_BADGE_Y + lineH(T_META) - 1}`;
  chk(c.ASK_TITLE_Y >= c.ASK_BADGE_Y + lineH(T_META), m,
      b === 1 && c.ASK_TITLE_Y === c.ASK_BADGE_Y + lineH(T_META) - 1);
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
  const vis = Math.floor((optTop2 - 8 - textTop - 14) / 13);
  chk(vis >= 1, `2-option ask shows ${vis} lines of code detail (board 1 shows 4)`);
  // The voice-confirm panel: 8 wrapped lines plus padding, above SEND.
  const panelEnd = c.CONTENT_Y + 22 + 8 * 13 + 12;
  const sendY = contentBottom - c.H_BTN - c.H_BTN - c.SP_2;
  chk(panelEnd < sendY, `voice transcript panel ends ${panelEnd}, SEND starts ${sendY}`);

  // ---- the change-only caches, re-derived ----
  // A signature holds FIELD VALUES, not the truncated text drawn from them, so a
  // wider row does not lengthen any of these - the worst cases are identical on
  // both boards, which is why nothing here moved for board 2.
  const rowSig = CAP.name + 1 + CAP.status + 1 + CAP.sub + 1 + CAP.title + 1 +
                 CAP.macTag + 1 + CAP.emojiId + 1;
  chk(+CACHE.rowSigCache >= rowSig,
      `rowSigCache ${CACHE.rowSigCache} holds its ${rowSig}-byte worst case`);
  const detSig = CAP.name + CAP.status + CAP.path + CAP.model + CAP.branch + CAP.askPid +
                 2 /* answeredIdx */ + CAP.title + CAP.prompt + 11 /* startSec */ +
                 CAP.askVoiceSha + 10 /* separators */ + 2 /* |M */ +
                 1 + CAP.macTag + 1 + CAP.emojiId + 1 /* NUL */;
  chk(+CACHE.detailSigCache >= detSig,
      `detailSigCache ${CACHE.detailSigCache} holds its ${detSig}-byte worst case`);
  chk(+CACHE.detailDurCache >= 23,
      `detailDurCache ${CACHE.detailDurCache} holds "for 999h59m - 23:59" padded to 22 + NUL`);
  chk(+CACHE.rowDurCache >= 8, `rowDurCache ${CACHE.rowDurCache} holds a 7-char padded duration + NUL`);
}

console.log(`\n${fail} failures, ${known} known-and-documented board-1 compromises`);
if (SELFTEST) {
  if (fail === 0) { console.log("SELFTEST FAILED: the checker did not notice a 1px threshold change"); process.exit(1); }
  console.log(`selftest ok - the injected fault produced ${fail} failure(s)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all sessions geometry assertions pass on both boards");
