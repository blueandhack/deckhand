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

// The transcript cap comes from the file that OWNS it - host/index.mjs - rather than
// from a number copied here, the same way settings-geom-check.mjs reads KB_MAX_BYTES
// out of the firmware and ANSWER_TEXT_MAX_BYTES out of the host.
const VOICE_TEXT_MAX = +fs.readFileSync(`${DIR}/../../host/index.mjs`, "utf8")
  .match(/VOICE_TEXT_MAX\s*=\s*(\d+)/)[1];

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
    // (e) The VOICE RESULT CARD, both pre-existing and both unreachable on board 2.
    // The label step is 1px under Cozette's cell, so the transcript panel's fill lands
    // on the label's last row - blank for every glyph without a descender, the same
    // allowance (d)'s neighbours take. And six lines of a 33-column lane hold 198 of
    // the host's 200-character transcript cap, so a full-length transcript loses its
    // last two characters (word wrap can cost more). Both are left alone because this
    // board's binary is held byte-identical; board 2 takes the full cell and 210.
    "voice card label step 12 >= the label's own 13px cell",
    "voice card: 6 lines hold 198 of 200 transcript chars",
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
//
// n=1 is the full avail (410) capped at 336; n=2's leftover is 307, under the cap
// and over the floor, so it is neither capped nor refused.
//
// THREE SESSIONS IS A ZERO AND THAT IS THE BODY RESTYLE'S ONE VISIBLE COST. 204
// used to expand, against a floor (199) derived from a body nobody draws any more
// - the old row layout shifted down by the band - and it drew 77px of nothing
// under its own content. The body is now the block stack the cap is summed from,
// which needs 288, so 204 is refused and three sessions get three ordinary spine
// rows. Deliberate, and asserted here so it cannot happen by accident.
const EXPANDED_H = { 1: [0, 0, 0, 0, 0, 0], 2: [336, 307, 0, 0, 0, 0] };

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
    bands.push(["pill", rowH - c.SESSION_PILL_UP_T, rowH - c.SESSION_PILL_UP_T + c.PILL_H - 1]);
  } else if (kind === "sub") {
    bands.push(["name", c.SESSION_NAME_Y, c.SESSION_NAME_Y + N - 1]);
    bands.push(["sub-line", c.SESSION_SUB2_Y, c.SESSION_SUB2_Y + L - 1]);
    bands.push(["pill", rowH - c.SESSION_PILL_UP, rowH - c.SESSION_PILL_UP + c.PILL_H - 1]);
  } else if (kind === "name") {
    bands.push(["name", c.SESSION_NAME_Y, c.SESSION_NAME_Y + N - 1]);
    bands.push(["pill", rowH - c.SESSION_PILL_UP, rowH - c.SESSION_PILL_UP + c.PILL_H - 1]);
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
function expCandidateH(c, count, avail, rowH) {
  if (c.SESSION_EXP_MIN_H === undefined) return 0;
  const leftover = avail - (count - 1) * (rowH + c.SESSION_ROW_GAP);
  if (leftover < c.SESSION_EXP_MIN_H) return 0;
  return Math.min(leftover, c.SESSION_EXP_MAX_H);
}
// sessionExpandedH(), replicated: the grant above, CAPPED BY THE CARD'S OWN
// CONTENT. The grant is only a ceiling - what the card takes is the block stack
// its session actually fills, and the remainder stays outside it as list area.
// Modelling the grant alone is how a 336px card carrying a two-line prompt kept
// 36px of nothing above its own path rule while every assertion here stayed green:
// expBands' `gap >= 0` is an OVERDRAW guard and says nothing about a hole.
function expandedH(c, count, avail, rowH, have) {
  const cand = expCandidateH(c, count, avail, rowH);
  if (cand <= 0) return 0;
  return Math.min(cand, expCardH(c, cand, have));
}
// How many lines of each optional block the card DRAWS. `have.title`/`have.prompt`
// are line counts (a truthy 1 therefore means one line); `titleLines`/`promptLines`
// name a shorter wrap than the field's worst case, which is the case the hole was
// measured in. The prompt is capped by sessionExpPromptLines()'s budget against the
// GRANT - the same guard the firmware keeps, and taken against the grant rather
// than the final height because the final height is derived from it.
function expTitleLines(c, have) {
  return have.title ? Math.min(have.titleLines ?? c.SESSION_EXP_TITLE_LINES,
                               c.SESSION_EXP_TITLE_LINES) : 0;
}
function expPromptDrawn(c, cand, have) {
  if (!have.prompt) return 0;
  return Math.max(1, Math.min(have.promptLines ?? c.SESSION_EXP_PROMPT_MAX,
                              expPromptLines(c, cand - c.SESSION_BAND_H)));
}
// sessionExpMeasure(), replicated: the card's height IS its block stack. Every
// term is one of the eight SESSION_BAND_* blocks SESSION_EXP_MAX_H is summed from,
// so a card that drops a block gets shorter by exactly that block.
function expCardH(c, cand, have) {
  let h = c.SESSION_BAND_H + c.SESSION_BAND_NAME_H;
  if (have.sub) h += c.SESSION_BAND_SUB_H;
  h += expTitleLines(c, have) * c.SESSION_BAND_TITLE_STEP;
  if (have.prompt)
    h += c.SESSION_BAND_RULE_H + c.SESSION_BAND_LABEL_H +
         expPromptDrawn(c, cand, have) * c.SESSION_BAND_PROMPT_STEP;
  if (have.path) h += c.SESSION_BAND_RULE_H + c.SESSION_BAND_PATH_H;
  return h + c.SESSION_BAND_BOTTOM_PAD;
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
// sessionExpPromptLines(), replicated: every SESSION_BAND_PROMPT_STEP above the
// floor buys one more prompt line, up to the field's own byte cap. The STEP is
// the prompt's own block, not SESSION_LINE_H - the body lays its prompt lines out
// at 24px, so a budget counted in 16px cells grants a line the card has not paid
// for and the bottom-anchored path is overdrawn from above.
// THE ARGUMENT IS THE BODY'S HEIGHT - the card LESS the band - and so is the
// baseline it is measured against, because SESSION_EXP_MIN_H is the whole card's
// floor and the caller has already taken the band off. Modelling it with the
// card's own floor here is how the checker's own summary line came to report a
// three-line prompt for the 204 card its band table draws with two.
function expPromptLines(c, bodyH) {
  const n = c.SESSION_EXP_PROMPT_MIN +
            Math.trunc((bodyH - (c.SESSION_EXP_MIN_H - c.SESSION_BAND_H)) /
                       c.SESSION_BAND_PROMPT_STEP);
  return Math.min(Math.max(n, c.SESSION_EXP_PROMPT_MIN), c.SESSION_EXP_PROMPT_MAX);
}
// The expanded card's bands, walked by the SAME running cursor the draw uses -
// which is the point: the blocks are optional (a Codex row has no title, a fresh
// session has no prompt), so a fixed band table would describe a card the device
// does not draw. `have` names which blocks are present.
//
// EVERY STEP IS ONE OF THE EIGHT SESSION_BAND_* BLOCKS SESSION_EXP_MAX_H IS
// SUMMED FROM. That is the whole content of the body: name, agent/model/branch,
// title, a rule, LAST PROMPT + prompt, a rule, path. Modelling it as the ordinary
// row's layout pushed down by the band - which is what the firmware did, and what
// this function used to describe - is how a 336px card came to draw 231px of
// content and 105px of nothing while every assertion here stayed green.
//
// THE PATH AND ITS RULE ARE BOTTOM-ANCHORED, exactly as the draw anchors them, so
// a card whose content stops early pools its surplus as air ABOVE that group
// rather than as a blank tail below it.
//
// The bands are INK extents, which is what makes `gap >= 0` an overdraw guard:
// the last line of a block inks lineH of its step and the rest of the step is
// leading. The FLOOR is derived from the blocks instead - see expCursorEnd().
function expBands(b, c, rowH, have, cand) {
  const NL = lineHB(b, T_HEAD);          // the name's tallest admissible rung
  const L = lineHB(b, T_BODY);
  const BAND = c.SESSION_BAND_H, RULE = c.SESSION_BAND_RULE_H;
  const ruleDY = Math.trunc((RULE - 1) / 2);
  const bands = [["border top", 0, 1],
                 ["band", c.BORDER_CARD, BAND - 1]];
  // Centred in its own block, exactly as the draw centres it - the name rung can
  // fall to T_BODY, and the taller T_HEAD is the case that has to clear the band.
  const nameOff = Math.trunc((c.SESSION_BAND_NAME_H - NL) / 2);
  bands.push(["name", BAND + nameOff, BAND + nameOff + NL - 1]);
  let cy = BAND + c.SESSION_BAND_NAME_H;
  if (have.sub) { bands.push(["sub-line", cy, cy + L - 1]); cy += c.SESSION_BAND_SUB_H; }
  if (have.title) {
    const n = expTitleLines(c, have), st = c.SESSION_BAND_TITLE_STEP;
    bands.push([`title (${n} lines)`, cy, cy + (n - 1) * st + L - 1]);
    cy += n * st;
  }
  if (have.prompt) {
    bands.push(["rule", cy + ruleDY, cy + ruleDY]);
    cy += RULE;
    bands.push(["PROMPT label", cy, cy + L - 1]);
    cy += c.SESSION_BAND_LABEL_H;
    // THE GRANT, NOT rowH. rowH is now the CONTENT's height, so a card missing its
    // title is shorter and a budget read back off it would come out under the
    // lines the height paid for - the firmware makes the same distinction, and for
    // the same reason (see the draw's own note).
    const n = expPromptDrawn(c, cand, have), st = c.SESSION_BAND_PROMPT_STEP;
    bands.push([`prompt (${n} lines)`, cy, cy + (n - 1) * st + L - 1]);
    cy += n * st;
  }
  if (have.path) {
    const top = expAnchorTop(c, rowH) + RULE;
    bands.push(["rule2", top - RULE + ruleDY, top - RULE + ruleDY]);
    bands.push(["path", top, top + L - 1]);
  }
  bands.push(["border bottom", rowH - 2, rowH - 1]);
  return bands;
}
// The body cursor's END and the bottom-anchored group's TOP, in BLOCK terms. This
// is what SESSION_EXP_MIN_H is derived from and what the "one pixel shorter
// overdraws" assertion is made against: the ink bands above stop at the last
// LINE's ink and therefore carry the final prompt step's trailing leading as
// slack, so an ink comparison would call an 8px-short card fine.
function expCursorEnd(c, cand, have) {
  let cy = c.SESSION_BAND_H + c.SESSION_BAND_NAME_H;
  if (have.sub) cy += c.SESSION_BAND_SUB_H;
  cy += expTitleLines(c, have) * c.SESSION_BAND_TITLE_STEP;
  if (have.prompt)
    cy += c.SESSION_BAND_RULE_H + c.SESSION_BAND_LABEL_H +
          expPromptDrawn(c, cand, have) * c.SESSION_BAND_PROMPT_STEP;
  return cy;
}
function expAnchorTop(c, rowH) {
  return rowH - c.SESSION_BAND_BOTTOM_PAD - c.SESSION_BAND_PATH_H - c.SESSION_BAND_RULE_H;
}
// labelForStatus()'s three words, PARSED. The expanded card draws no status pill
// and no shape-distinct indicator - the band replaces both - so on that card this
// word is the ONLY carrier of status that is not hue. Collapsing two of these arms
// left this checker at zero failures before the assertion below existed.
function statusLabels() {
  const src = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
  const m = src.match(/const char\* labelForStatus\(const char\* status\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error("labelForStatus() not found in deckhand_display.ino");
  return [...m[1].matchAll(/return\s+"([^"]*)"/g)].map((x) => x[1]);
}
// The spinner art's own size, PARSED. It was transcribed as a literal 16
// (SPARK_SIZE / 2) at three sites, and it is the constant the spine's clearance
// turns on - a regenerated 40px mark would move the blit's left edge under every
// one of those literals without any of them noticing.
function sparkSize() {
  const m = fs.readFileSync(`${DIR}/ClaudeSpark.h`, "utf8").match(/#define\s+SPARK_SIZE\s+(\d+)/);
  if (!m) throw new Error("SPARK_SIZE not found in ClaudeSpark.h");
  return Number(m[1]);
}
// THE SPINE IS NOT A RECT, so `spineL + SESSION_SPINE_W - 1` is NOT its rightmost
// ink and must never be used as one - that model is what let a real overlap ship.
// This returns the rightmost x the spine's CAPSULE alone would ink at a given
// row-relative y, i.e. what the shape does before the carve bounds it. The arc is
// the card interior's own: centre (SESSION_ROW_X + R_MD, R_MD), radius
// R_MD - BORDER_CARD, which is what the fill is drawn at.
function spineArcRight(c, dy) {
  const r = c.R_MD - c.BORDER_CARD;
  const d = Math.abs(dy - c.R_MD);
  if (d >= r) return null;                       // above/below the capsule's arc
  const left = c.SESSION_ROW_X + c.R_MD - Math.sqrt(r * r - d * d);
  return left + c.SESSION_SPINE_W - 1;           // if the carve followed the arc too
}
// drawSpineGaps()'s Codex knockout loop, replicated - the helper drawSessionSpine
// and drawSpineShimmer both cut their gaps with. The spine's own box is
// the card's INTERIOR, and the gaps may only be cut from the STRAIGHT section
// between the two corner arcs - the loop draws a gap only where a whole one fits,
// so nothing is ever clipped by an arc.
function spineGaps(c, rowH) {
  const h = rowH - 2 * c.BORDER_CARD - 2 * c.SESSION_SPINE_INSET;
  const r = c.R_MD - c.BORDER_CARD;
  const gaps = [];
  for (let yy = r + c.SESSION_SPINE_ON; yy + c.SESSION_SPINE_OFF <= h - r;
       yy += c.SESSION_SPINE_ON + c.SESSION_SPINE_OFF)
    gaps.push([yy, yy + c.SESSION_SPINE_OFF - 1]);
  return { h, r, gaps };
}
// Every row height a spine can actually be drawn at: the ladder's own output for
// each session count, with and without the "+N more" strip, skipping the one case
// that has no ordinary row at all (a lone session, whose only row is the band
// card). Derived from the ladder rather than listed, so a change to the floor, the
// cap or the content area moves this set with it.
function spineHeights(c, contentBottom, maxSessions) {
  const out = new Set();
  for (const strip of [false, true]) {
    const avail = contentBottom - c.SESSION_ROW_Y0 - (strip ? c.SESSION_OVERFLOW_H : 0);
    for (let n = 1; n <= maxSessions; n++) {
      const raw = Math.floor((avail - c.SESSION_ROW_GAP * (n - 1)) / n);
      const rowH = Math.min(Math.max(raw, c.SESSION_ROW_H_MIN), c.SESSION_ROW_H_MAX);
      // The GRANT, not the measured height: whether a lone session has an ordinary
      // row at all is the gate's question, and it does not depend on how much of
      // its grant that card's content ends up taking.
      if (n === 1 && expCandidateH(c, 1, avail, rowH) > 0) continue;   // no ordinary row
      out.add(rowH);
    }
  }
  return [...out].sort((a, z) => a - z);
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
  // PILL_H is PARSED from the board header, not transcribed here. It used to be a
  // local `const PILL_H = 18` copied from drawStatusPill, and the consequence was
  // measured: changing the draw sites' 18 to 22 left all three checkers exiting 0
  // while "the pill ends clear of the row's own 2px border" was false. A checker
  // that transcribes the constant it certifies cannot see the change it exists to
  // catch - the same defect as the BODY_H = {1:13, 2:16} hardcode this file already
  // replaced with a parse of the font registry.
  const PILL_H = c.PILL_H;
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
  chk(c.SESSION_PILLC_Y + PILL_H - 1 <= c.SESSION_ROW_H_MIN - 3,
      `compact pill +${c.SESSION_PILLC_Y}..+${c.SESSION_PILLC_Y + PILL_H - 1} clears the border of even the shortest legal row (${c.SESSION_ROW_H_MIN})`);
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
        chk(c.SESSION_PILLC_Y + c.PILL_H - 1 <= rowH - 3,
            `${strip ? "strip " : ""}${n}x${rowH} (compact): top-right pill +${c.SESSION_PILLC_Y}..+${c.SESSION_PILLC_Y + c.PILL_H - 1} clears the border at +${rowH - 2}`);
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
      // THE FLOOR IS THE CAP'S OWN BLOCK STACK WITH THE PROMPT AT ITS MINIMUM.
      // Same eight blocks, same order, one term different - which is what makes
      // the two ends of the range ONE derivation instead of two that can drift,
      // and it is asserted from the PARSED blocks rather than from the sum the
      // header writes out beside it.
      //
      // IT USED TO BE THE PRE-BODY PACKED STACK (199): the ordinary row's 16px
      // line step and 3px gaps, shifted down by the band, with no rules and no
      // leading. That is not the body this card draws, and the gap was 89px -
      // enough to admit a three-session card that then drew 77px of nothing.
      const FLOOR_BLOCKS = [
        ["band", c.SESSION_BAND_H],
        ["name", c.SESSION_BAND_NAME_H],
        ["sub", c.SESSION_BAND_SUB_H],
        ["title", c.SESSION_BAND_TITLE_STEP * c.SESSION_EXP_TITLE_LINES],
        ["rule", c.SESSION_BAND_RULE_H],
        ["lastprompt", c.SESSION_BAND_LABEL_H],
        ["prompt", c.SESSION_BAND_PROMPT_STEP * c.SESSION_EXP_PROMPT_MIN],
        ["rule2", c.SESSION_BAND_RULE_H],
        ["path", c.SESSION_BAND_PATH_H],
        ["pad", c.SESSION_BAND_BOTTOM_PAD],
      ];
      const floorSum = FLOOR_BLOCKS.reduce((a, [, v]) => a + v, 0);
      chk(c.SESSION_EXP_MIN_H === floorSum,
          `SESSION_EXP_MIN_H ${c.SESSION_EXP_MIN_H} is the band card's blocks at ` +
          `PROMPT_MIN (${FLOOR_BLOCKS.map(([n, v]) => `${n} ${v}`).join(" + ")} = ${floorSum})`);
      // ... and the CAP is the same stack at PROMPT_MAX, so the range is exactly
      // the prompt lines the extra height buys. This identity was lost when the
      // cap moved to a block sum the floor did not share; restoring it is what
      // makes sessionExpPromptLines() the same arithmetic run backwards.
      chk(c.SESSION_EXP_MAX_H === c.SESSION_EXP_MIN_H +
            (c.SESSION_EXP_PROMPT_MAX - c.SESSION_EXP_PROMPT_MIN) * c.SESSION_BAND_PROMPT_STEP,
          `SESSION_EXP_MAX_H ${c.SESSION_EXP_MAX_H} == MIN ${c.SESSION_EXP_MIN_H} + ` +
          `${c.SESSION_EXP_PROMPT_MAX - c.SESSION_EXP_PROMPT_MIN} x ` +
          `SESSION_BAND_PROMPT_STEP ${c.SESSION_BAND_PROMPT_STEP}`);
      // ... AND ONE PIXEL SHORTER OVERDRAWS. This is what makes it the FLOOR
      // rather than a bound with room in it: at MIN_H the body cursor ends
      // EXACTLY on the bottom-anchored group's top, and at MIN_H - 1 it runs
      // past it. Measured in BLOCKS, not ink - an ink comparison carries the last
      // prompt step's 8px of trailing leading as slack and would pass an 8px-short
      // card. Without the second half, raising the constant to any
      // comfortable-looking number would pass.
      {
        const full = { title: 1, sub: 1, prompt: 1, path: 1 };
        const slack = (H) => expAnchorTop(c, H) - expCursorEnd(c, H, full);
        chk(slack(c.SESSION_EXP_MIN_H) === 0,
            `at SESSION_EXP_MIN_H (${c.SESSION_EXP_MIN_H}) the body's cursor ends exactly on the ` +
            `bottom-anchored rule+path group (${slack(c.SESSION_EXP_MIN_H)}px of slack)`);
        chk(slack(c.SESSION_EXP_MIN_H - 1) < 0,
            `and at ${c.SESSION_EXP_MIN_H - 1} it OVERRUNS it by ${-slack(c.SESSION_EXP_MIN_H - 1)}px ` +
            `- so the gate is the floor, not a guess`);
      }
      // THE BASELINE IS THE GATE LESS THE BAND, PARSED OUT OF THE DRAW. The model
      // above cannot see which number the firmware counts prompt lines from, and
      // the two have to be the same one: a baseline that is not
      // SESSION_EXP_MIN_H - SESSION_BAND_H hands the smallest card the rule can
      // produce a prompt line its height never paid for, and the band tables would
      // stay green because they model the baseline rather than read it.
      {
        const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
        chk(/\(bodyH - \(SESSION_EXP_MIN_H - SESSION_BAND_H\)\) \/\s*\n?\s*SESSION_BAND_PROMPT_STEP/.test(src),
            "sessionExpPromptLines() counts from SESSION_EXP_MIN_H - SESSION_BAND_H " +
            "(the gate's own floor, less the band the caller already subtracted) " +
            "in steps of SESSION_BAND_PROMPT_STEP (the block the body lays a prompt line out at)");
      }
      chk(c.SESSION_EXP_MIN_H >= c.SESSION_TITLE_MIN_H,
          `an expanded row (>= ${c.SESSION_EXP_MIN_H}) is always a title row (>= ${c.SESSION_TITLE_MIN_H})`);
      // THE CAP IS THE FIELD'S BYTE CAP, MEASURED. A prompt line past this could
      // never carry ink, and one short of it cuts the field the card exists for.
      // THE BAND CARD'S OWN LANE, NOT THE ORDINARY ROW'S. This read
      // SESSION_SUB_LANE_W (the compact row's name-origin lane, 244) while the
      // body is inset by the BAND's pad on both sides - so it modelled a lane
      // 20px narrower than the one drawWrappedText wraps at, and every character
      // budget below was measured against a card that is not this one.
      const adv = advanceB(b, T_BODY), lane = c.SESSION_BAND_BODY_LANE;
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
      // THE WIDEST LEADING ANY BLOCK CARRIES, derived from the parsed blocks. It is
      // the bound on a legitimate gap between two blocks' ink: each block's step is
      // one line of ink plus its own leading, and a rule contributes the air either
      // side of its single row. A gap wider than the widest of those is space no
      // block paid for - which is precisely what a prompt block BUDGETED four lines
      // and drawing two pooled above the path rule. Measured off the glass at 36px
      // against a normal 9-19px, and 142/182px on a session with no prompt yet.
      // A block's leading is its step less the one line of ink in it, and a RULE may
      // follow any of them - the rule's own row sits RDY below the block above, so
      // the widest legitimate gap is the widest leading plus that. The rule's
      // trailing air and the path's tail are both smaller and therefore covered.
      const RDY = Math.trunc((c.SESSION_BAND_RULE_H - 1) / 2);
      const MAX_LEAD = Math.max(
        c.SESSION_BAND_NAME_H - lineHB(b, T_HEAD),
        c.SESSION_BAND_SUB_H - L,
        c.SESSION_BAND_TITLE_STEP - L,
        c.SESSION_BAND_LABEL_H - L,
        c.SESSION_BAND_PROMPT_STEP - L) + RDY;
      // THE SHORT-CONTENT CASES ARE THE ONES THE HOLE LIVED IN, and they were
      // absent: every entry here used to describe a card whose blocks are all at
      // their WORST CASE, which is the one shape where a budgeted prompt and a
      // drawn prompt agree. A real two-line prompt in a card granted four is what
      // the 36px hole was measured on.
      const HAVE = [
        ["all blocks", { title: 1, sub: 1, prompt: 1, path: 1 }],
        ["no title (Codex)", { title: 0, sub: 1, prompt: 1, path: 1 }],
        ["no prompt yet", { title: 1, sub: 1, prompt: 0, path: 1 }],
        ["name + pill only", { title: 0, sub: 0, prompt: 0, path: 0 }],
        ["2-line prompt", { title: 1, sub: 1, prompt: 1, promptLines: 2, path: 1 }],
        ["1-line prompt", { title: 1, sub: 1, prompt: 1, promptLines: 1, path: 1 }],
        ["1-line title", { title: 1, titleLines: 1, sub: 1, prompt: 1, path: 1 }],
        ["1-line title, 1-line prompt",
         { title: 1, titleLines: 1, sub: 1, prompt: 1, promptLines: 1, path: 1 }],
      ];
      for (const strip of [false, true]) {
        const avail = contentBottom - c.SESSION_ROW_Y0 - (strip ? c.SESSION_OVERFLOW_H : 0);
        const tags = [];
        for (let n = 1; n <= 6; n++) {
          const raw = Math.floor((avail - c.SESSION_ROW_GAP * (n - 1)) / n);
          const rowH = Math.min(Math.max(raw, c.SESSION_ROW_H_MIN), c.SESSION_ROW_H_MAX);
          // THE GRANT is what the ladder can spare and what the header documents;
          // the HEIGHT is per content case, below. Keeping the two names apart here
          // is the whole change: the documented table is a table of ceilings.
          const cand = expCandidateH(c, n, avail, rowH);
          tags.push(cand ? `${n}:<=${cand}(<=${expPromptLines(c, cand - c.SESSION_BAND_H)}p)`
                         : `${n}:-`);
          if (!strip)
            chk(cand === EXPANDED_H[b][n - 1],
                `${n} session(s): the ladder's grant ${cand} == the ${EXPANDED_H[b][n - 1]} this board documents`);
          if (!cand) continue;
          chk(cand >= c.SESSION_EXP_MIN_H && cand <= c.SESSION_EXP_MAX_H,
              `${strip ? "strip " : ""}${n}: grant ${cand} inside [${c.SESSION_EXP_MIN_H}, ${c.SESSION_EXP_MAX_H}]`);
          // EVERY CONTENT CASE IS A LAYOUT OF ITS OWN, because the card's height is
          // its content's. A case that was only ever checked at the worst-case
          // wrap is a case whose real shape nobody looked at.
          for (const [lbl, have] of HAVE) {
            const e = expandedH(c, n, avail, rowH, have);
            const tag = `${strip ? "strip " : ""}${n}x${e} expanded (${lbl})`;
            // ---- THE CARD IS EXACTLY ITS CONTENT ----
            // The assertion this defect existed for, and the one `gap >= 0` can
            // never make: that guard is an OVERDRAW guard - it fires when a block
            // runs INTO the one below it and says nothing at all about a block
            // sitting 142px above it. The card's height is the body cursor's own
            // end plus the bottom-anchored group, so there is no pixel inside the
            // card that no block paid for.
            const bodyEnd = expCursorEnd(c, cand, have);
            const want = bodyEnd + (have.path ? c.SESSION_BAND_RULE_H + c.SESSION_BAND_PATH_H : 0) +
                         c.SESSION_BAND_BOTTOM_PAD;
            chk(e === want,
                `${tag}: the card is ${e} = its content exactly ` +
                `(cursor ${bodyEnd}${have.path ? ` + rule ${c.SESSION_BAND_RULE_H} + path ${c.SESSION_BAND_PATH_H}` : ""} ` +
                `+ pad ${c.SESSION_BAND_BOTTOM_PAD} = ${want}) - no air inside it`);
            // ... AND THE SURPLUS IS OUTSIDE IT. §4: the remainder stays as list
            // area rather than becoming a card of air.
            chk(e <= cand,
                `${tag}: ${cand - e}px of the ${cand} grant stays OUTSIDE the card as list area`);
            // THE BOTTOM ANCHOR NOW LANDS ON THE CURSOR. It is kept - flowing the
            // path up would put the surplus at the card's bottom edge instead, which
            // is the trailing air the 288 floor was raised to remove - so what has
            // to be true is that the two meet, for EVERY content case and not only
            // at the cap.
            if (have.path)
              chk(expAnchorTop(c, e) === bodyEnd,
                  `${tag}: the bottom-anchored rule+path starts at ${expAnchorTop(c, e)}, exactly where the body cursor ends`);
            // THE WHOLE STACK STILL FITS. This is the assertion the feature can
            // actually break: the first row grew, the others did not shrink, and the
            // list must still end inside `avail`.
            const used = e + (n - 1) * (rowH + c.SESSION_ROW_GAP);
            chk(used <= avail,
                `${tag}: expanded ${e} + ${n - 1}x${rowH} + ${n - 1} gaps = ${used} <= avail ${avail} (${avail - used} left)`);
            // A CONTENT-SHRUNK CARD MAY SIT BELOW SESSION_EXP_MIN_H - that gate is
            // on the GRANT, i.e. on whether there is room for a card at all, not on
            // how much of that room this one needs. What it may never do is fall
            // under the blocks that are always drawn.
            chk(e >= c.SESSION_BAND_H + c.SESSION_BAND_NAME_H + c.SESSION_BAND_BOTTOM_PAD,
                `${tag}: at least the band, the name and the bottom pad`);
            // THE ROW STACK, walked exactly as sessionRowYAt() lays it out - which is
            // also what the touch hit test walks, so this is the assertion that says a
            // tap and a card cannot disagree about where a row is.
            for (let pos = 0; pos < n; pos++) {
              const yy = rowYAt(c, pos, n, e, rowH, avail);
              const h = pos === 0 ? e : rowH;
              chk(yy >= c.SESSION_ROW_Y0 && yy + h <= c.SESSION_ROW_Y0 + avail,
                  `${tag}: row ${pos} ${yy}..${yy + h - 1} inside the list area ${c.SESSION_ROW_Y0}..${c.SESSION_ROW_Y0 + avail - 1}`);
              if (pos > 0)
                chk(yy === rowYAt(c, pos - 1, n, e, rowH, avail) +
                          (pos === 1 ? e : rowH) + c.SESSION_ROW_GAP,
                    `${tag}: row ${pos} starts exactly one gap below row ${pos - 1}`);
            }
            // A LONE expanded card is CENTRED, and the two margins are asserted equal
            // to within the odd pixel - "card, then 198px of nothing" is what the
            // centring exists to remove, so the number is checked rather than trusted.
            // It matters MORE now: a short card leaves more to centre.
            if (n === 1) {
              const yy = rowYAt(c, 0, 1, e, rowH, avail);
              const above = yy - c.SESSION_ROW_Y0;
              const below = c.SESSION_ROW_Y0 + avail - (yy + e);
              chk(Math.abs(above - below) <= 1,
                  `${tag}: the lone card is centred - ${above}px above, ${below}px below`);
            }
            // THE STRIP CASES BELOW SIX SESSIONS USED TO BE SKIPPED HERE, and the
            // skip is GONE because the thing it was standing in front of is fixed.
            // It was legitimate at the time - hiddenCount > 0 implies
            // sessionCount == MAX_SESSIONS (the host caps its list at 6 and only then
            // reports more), so a strip and a band card cannot coexist, and the 185
            // the strip produces at three sessions was 14px shorter than the band
            // plus its packed body. But the shortfall was real: it was the
            // SESSION_EXP_MIN_H question, the gate still being the PRE-band packed
            // stack (180) where a band card needs 199. With the gate corrected, 185
            // no longer expands at all - the grant is 0 and the `if (!cand)
            // continue` above takes it - so there is nothing left to skip, and the
            // two strip heights that DO expand now get their band tables checked
            // like any other. An unreachable configuration is a fine reason to skip
            // a check and a bad reason to leave one broken.
            const bands = expBands(b, c, e, have, cand);
            if (!strip && n === 1) {
              console.log(`  expanded ${e} of ${cand} (${lbl}):`);
              for (const [nm, a, z] of bands) console.log(`    ${nm.padEnd(18)} +${a}..+${z}`);
            }
            for (let i = 1; i < bands.length; i++) {
              const gap = bands[i][1] - bands[i - 1][2] - 1;
              chk(gap >= 0, `${tag}: ${bands[i - 1][0]} -> ${bands[i][0]} gap ${gap}`);
              // ... AND NO GAP IS A HOLE. The largest legitimate space between two
              // blocks' ink is one block's own leading; anything past that is space
              // the layout did not intend, which is exactly what a budgeted-but-
              // unwrapped prompt line pooled. Derived from the parsed blocks, not
              // transcribed: the widest leading any block carries.
              chk(gap <= MAX_LEAD,
                  `${tag}: ${bands[i - 1][0]} -> ${bands[i][0]} gap ${gap} <= the widest block leading ${MAX_LEAD}`);
            }
          }
        }
        console.log(`  expanded${strip ? " (+N more strip)" : "           "} avail ${avail}: ${tags.join("  ")}`);
      }
    }
  }

  // ---- §3/§4 band card: the cap is DERIVED, so assert it against its own blocks ----
  // The spec's rule: "the sum of the blocks that can actually carry ink". A future
  // field that adds a line must move this sum, not slip past it.
  if (b === 2) {
    const B2 = (n) => c[`SESSION_BAND_${n}`];
    const blocks = [
      ["band", c.SESSION_BAND_H],
      ["name", B2("NAME_H")],
      ["sub", B2("SUB_H")],
      ["title", B2("TITLE_STEP") * c.SESSION_EXP_TITLE_LINES],
      ["rule", B2("RULE_H")],
      ["lastprompt", B2("LABEL_H")],
      ["prompt", B2("PROMPT_STEP") * c.SESSION_EXP_PROMPT_MAX],
      ["rule2", B2("RULE_H")],
      ["path", B2("PATH_H")],
      ["pad", B2("BOTTOM_PAD")],
    ];
    const sum = blocks.reduce((a, [, v]) => a + v, 0);
    chk(c.SESSION_EXP_MAX_H === sum,
        `SESSION_EXP_MAX_H ${c.SESSION_EXP_MAX_H} is the sum of the band card blocks ` +
        `(${blocks.map(([n, v]) => `${n} ${v}`).join(" + ")} = ${sum})`);

    // The two byte caps that bound the line counts. These are the reason the sum is
    // what it is: a 5th prompt line and a 3rd title line can never carry ink.
    // SESSION_BAND_BODY_LANE, not ROW_W - 2*PAD: that approximation forgot the
    // card's own 2px border, which the band is drawn INSIDE. Same column count
    // here (33 either way), which is exactly why it survived - a model that is
    // right by 4px of luck is one field change from being wrong.
    const lane = Math.floor(c.SESSION_BAND_BODY_LANE / c.TEXT_ADV);
    chk(lane * c.SESSION_EXP_PROMPT_MAX >= 100,
        `a 5th prompt line is unreachable: prompt[104] holds 100 chars, ` +
        `${c.SESSION_EXP_PROMPT_MAX} lines x ${lane} cols = ${lane * c.SESSION_EXP_PROMPT_MAX}`);
    chk(lane * c.SESSION_EXP_TITLE_LINES >= 43,
        `a 3rd title line is unreachable: title[44] holds 43 chars, ` +
        `${c.SESSION_EXP_TITLE_LINES} lines x ${lane} cols = ${lane * c.SESSION_EXP_TITLE_LINES}`);
    // ... and that one FEWER line would NOT hold the data, which is what makes the
    // counts derived rather than generous.
    chk(lane * (c.SESSION_EXP_PROMPT_MAX - 1) < 100,
        `4 prompt lines is the MINIMUM that holds prompt[104]`);
    chk(lane * (c.SESSION_EXP_TITLE_LINES - 1) < 43,
        `2 title lines is the MINIMUM that holds title[44]`);

    // ---- THE BODY HANGS UNDER THE BAND, so it starts where the band's ink does ----
    // THE DEFECT THIS EXISTS FOR, reported off the glass: the body was drawn at
    // SESSION_ROW_X + SESSION_NAME_DX - the ORDINARY row's name origin, whose 40px
    // are clearance for the 32x32 row-indicator blit. The band card draws no
    // indicator (its mark is in the band), so those pixels were reserved for
    // nothing and every body line sat 24px right of the band above it, losing 3
    // characters a line on the card whose whole job is text.
    //
    // The band's own two edges are PARSED rather than restated, because that is
    // the pair this has to agree with: the mark's origin comes from bandMarkX()
    // applied to the x drawSessionRow passes, and the right edge from the
    // duration's own right-aligned datum. A model of "14 from the interior" would
    // go on agreeing with itself after either moved.
    {
      const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      chk(/drawSessionBand\(SESSION_ROW_X \+ BORDER_CARD, y \+ BORDER_CARD,\s*\n?\s*SESSION_ROW_W - 2 \* BORDER_CARD/.test(src),
          "the band is drawn on the card INTERIOR (SESSION_ROW_X + BORDER_CARD, " +
          "SESSION_ROW_W - 2*BORDER_CARD) - which is what the body's edges are measured from");
      chk(/int bandMarkX\(int x\) \{ return x \+ SESSION_BAND_PAD; \}/.test(src),
          "the band's mark sits SESSION_BAND_PAD inside that interior (bandMarkX)");
      chk(/drawString\(dur, x \+ w - SESSION_BAND_PAD, y \+ bandDurDY\(\)\);/.test(src),
          "and the band's duration is right-aligned SESSION_BAND_PAD inside it");
      const interiorL = c.SESSION_ROW_X + c.BORDER_CARD;
      const interiorR = c.SESSION_ROW_X + c.SESSION_ROW_W - c.BORDER_CARD;
      const markX = interiorL + c.SESSION_BAND_PAD;
      const durR = interiorR - c.SESSION_BAND_PAD;
      chk(c.SESSION_BAND_BODY_X === markX,
          `the body's left edge x=${c.SESSION_BAND_BODY_X} IS the band's own content left edge ` +
          `(bandMarkX = ${interiorL} + ${c.SESSION_BAND_PAD} = ${markX})`);
      chk(c.SESSION_BAND_BODY_X + c.SESSION_BAND_BODY_LANE === durR,
          `and its lane ends x=${c.SESSION_BAND_BODY_X + c.SESSION_BAND_BODY_LANE} on the band's own ` +
          `right pad edge (${interiorR} - ${c.SESSION_BAND_PAD} = ${durR}) - one inset, both sides, both halves of the card`);
      // The old origin, named so a revert cannot pass quietly.
      chk(c.SESSION_BAND_BODY_X < c.SESSION_ROW_X + c.SESSION_NAME_DX,
          `the body does NOT reserve the row indicator's ${c.SESSION_NAME_DX}px: it starts ` +
          `${c.SESSION_ROW_X + c.SESSION_NAME_DX - c.SESSION_BAND_BODY_X}px left of the ordinary row's name origin, ` +
          `which is ${Math.floor((c.SESSION_ROW_X + c.SESSION_NAME_DX - c.SESSION_BAND_BODY_X) / c.TEXT_ADV)} characters a line`);
      chk(c.SESSION_BAND_BODY_X >= interiorL,
          `and it still clears the card's own border (x=${c.SESSION_BAND_BODY_X} >= interior ${interiorL})`);
      console.log(`    band card body: x=${c.SESSION_BAND_BODY_X} lane=${c.SESSION_BAND_BODY_LANE}px = ` +
                  `${Math.floor(c.SESSION_BAND_BODY_LANE / c.TEXT_ADV)} chars ` +
                  `(was x=${c.SESSION_ROW_X + c.SESSION_NAME_DX} lane=${c.SESSION_SUB_LANE_W}px = ` +
                  `${Math.floor(c.SESSION_SUB_LANE_W / c.TEXT_ADV)})`);
    }

    // ---- THE BODY'S DRAW SITES, PARSED - not modelled ----
    // EVERYTHING ABOVE MODELS THE LAYOUT AND NONE OF IT READS THE CODE, which is
    // exactly how the body came to be the ordinary row's stack shifted down by
    // the band while every band table stayed green. The reviewer proved it: it
    // commented out the body's shift and reverted the cursor's origin - drawing
    // the name and title ON TOP of the 44px band, opaque boxes rubbing holes in
    // it - and this checker reported zero failures.
    //
    // So each of the eight blocks is tied to the line that spends it. The known
    // limit is the one this repo already documents for text-matching tests: it
    // sees the line, not whether the preprocessor kept it. The band tables above
    // are what constrain the geometry; these are what tie them to the code.
    const drawSrc = (() => {
      const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      const a = src.indexOf("void drawSessionRow(int pos) {");
      const z = src.indexOf("\nvoid renderSessionsList()", a);
      if (a < 0 || z < 0) throw new Error("drawSessionRow() not found in sessions.ino");
      // COMMENTS STRIPPED FIRST. A text-matching test cannot see the preprocessor
      // delete a line, which this repo already documents - but it CAN be made to
      // see a line commented out, and that is the likeliest way one of these
      // blocks gets disabled by hand. Measured: without this, commenting out the
      // second rule's draw left all twelve assertions green.
      return src.slice(a, z).replace(/^[ \t]*\/\/.*$/gm, "");
    })();
    const DRAW_SITES = [
      ["the body starts where the band ends",
       /nameTop = y \+ SESSION_BAND_H;/],
      // THE LEFT EDGE, and it is the whole point of the block above: the body
      // takes the band's origin, not the ordinary row's name origin.
      ["the body's left edge is the band's, not SESSION_NAME_DX",
       /if \(expanded\) nameX = SESSION_BAND_BODY_X;/],
      ["the name's lane runs to the band's right edge too",
       /if \(expanded\) laneRight = SESSION_BAND_BODY_X \+ SESSION_BAND_BODY_LANE;/],
      ["every block below wraps at SESSION_BAND_BODY_LANE",
       /const int lane = SESSION_BAND_BODY_LANE;/],
      ["the name is centred in SESSION_BAND_NAME_H",
       /nameOffset = \(SESSION_BAND_NAME_H - uiLineH\(nameFont\)\) \/ 2;/],
      ["the body cursor opens below the name block",
       /int cy = nameTop \+ SESSION_BAND_NAME_H;/],
      ["the sub-line advances by SESSION_BAND_SUB_H",
       /cy \+= SESSION_BAND_SUB_H;/],
      ["the title is wrapped at SESSION_BAND_TITLE_STEP",
       /drawWrappedText\(s\.title[\s\S]{0,200}?SESSION_BAND_TITLE_STEP/],
      ["the rule above LAST PROMPT advances by SESSION_BAND_RULE_H",
       /drawBandRule\(nameX, cy \+ \(SESSION_BAND_RULE_H - 1\) \/ 2, lane\);[\s\S]{0,40}?cy \+= SESSION_BAND_RULE_H;/],
      ["the LAST PROMPT caption advances by SESSION_BAND_LABEL_H",
       /drawString\("LAST PROMPT", nameX, cy\);[\s\S]{0,40}?cy \+= SESSION_BAND_LABEL_H;/],
      ["the prompt is wrapped at SESSION_BAND_PROMPT_STEP",
       /drawWrappedText\(s\.prompt[\s\S]{0,200}?SESSION_BAND_PROMPT_STEP/],
      // THE DRAW READS THE COUNT ITS CARD'S HEIGHT WAS DERIVED FROM. It used to
      // re-derive one from rowH, which was right while rowH was the ladder's grant
      // and is circular now that rowH IS the content's height: a card missing a
      // block is shorter, so the budget read back off it comes out UNDER the lines
      // the height already paid for, and the card opens a hole in the space it
      // had already spent. The budget itself has not gone anywhere - see the
      // sessionExpMeasure() assertions below.
      ["the prompt line count is the MEASURED one, not one re-derived from rowH",
       /drawWrappedText\(s\.prompt[\s\S]{0,300}?expCardPrompt/],
      ["the path is BOTTOM-ANCHORED off SESSION_BAND_BOTTOM_PAD + SESSION_BAND_PATH_H",
       /pathTop = y \+ rowH - SESSION_BAND_BOTTOM_PAD - SESSION_BAND_PATH_H;/],
      ["the second rule sits one SESSION_BAND_RULE_H above the path",
       /drawBandRule\(nameX, pathTop - SESSION_BAND_RULE_H \+/],
    ];
    for (const [what, re] of DRAW_SITES)
      chk(re.test(drawSrc), `the expanded draw reads its own block: ${what}`);
    chk(!/sessionExpPromptLines\(rowH/.test(drawSrc),
        `... and does NOT re-derive the budget from rowH, which is now the content's own height`);

    // ---- sessionExpMeasure(): THE HEIGHT IS THE SAME BLOCK STACK THE DRAW WALKS ----
    // The card is as tall as what it draws, so the measurement and the draw are two
    // readings of ONE stack and a term present in either and missing from the other
    // is a hole or an overdraw. Parsed, for the reason every other site here is: a
    // model of this arithmetic would go on agreeing with itself after the firmware
    // stopped agreeing with it.
    {
      const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      const a = src.indexOf("void sessionExpMeasure(");
      if (a < 0) throw new Error("sessionExpMeasure() not found in sessions.ino");
      const m = src.slice(a, src.indexOf("\n}\n", a)).replace(/^[ \t]*\/\/.*$/gm, "");
      const MEASURE_SITES = [
        // THE SAME LANE THE DRAW WRAPS AT. Not a matching number - the same
        // identifier: the card's HEIGHT is this sum, so a lane that differs from
        // the draw's changes the card's SIZE, not merely where its text breaks.
        ["wraps at SESSION_BAND_BODY_LANE, the lane the draw uses",
         /const int lane = SESSION_BAND_BODY_LANE;/],
        ["opens with the band and the name, the two blocks every card draws",
         /int h = SESSION_BAND_H \+ SESSION_BAND_NAME_H;/],
        ["adds SESSION_BAND_SUB_H only when there is a sub-line",
         /if \(sub\[0\]\) h \+= SESSION_BAND_SUB_H;/],
        ["counts the title's REAL wrapped lines, capped at SESSION_EXP_TITLE_LINES",
         /countWrappedLines\(s\.title, T_BODY, lane\)[\s\S]{0,160}?SESSION_EXP_TITLE_LINES[\s\S]{0,120}?h \+= n \* SESSION_BAND_TITLE_STEP;/],
        ["counts the prompt's REAL wrapped lines",
         /countWrappedLines\(s\.prompt, T_BODY, lane\)/],
        ["... capped by sessionExpPromptLines() against the GRANT less the band",
         /sessionExpPromptLines\(cand - SESSION_BAND_H\)/],
        ["the prompt block is its rule, its caption and its lines",
         /h \+= SESSION_BAND_RULE_H \+ SESSION_BAND_LABEL_H \+ n \* SESSION_BAND_PROMPT_STEP;/],
        ["the path block is its own rule plus SESSION_BAND_PATH_H",
         /if \(s\.path\[0\]\) h \+= SESSION_BAND_RULE_H \+ SESSION_BAND_PATH_H;/],
        ["and it closes on SESSION_BAND_BOTTOM_PAD",
         /h \+= SESSION_BAND_BOTTOM_PAD;/],
        ["the grant is the ceiling, never exceeded",
         /expCardH = h > cand \? cand : h;/],
        ["the count the draw reads is the count the height was derived from",
         /expCardPrompt = n;/],
      ];
      for (const [what, re] of MEASURE_SITES)
        chk(re.test(m), `sessionExpMeasure() ${what}`);
      // AND sessionExpandedH() TAKES THE SMALLER OF THE TWO. Without this the
      // measurement above could be computed, stored, and never applied - which is
      // exactly the shape of the defect it exists to fix.
      const eh = src.slice(src.indexOf("int sessionExpandedH("));
      chk(/expCardH > 0 && expCardH < cand[\s\S]{0,40}?expCardH : cand/.test(eh.slice(0, eh.indexOf("\n}\n"))),
          `sessionExpandedH() returns the CONTENT's height when it is under the ladder's grant`);
      // ---- A HEIGHT CHANGE IS A LAYOUT CHANGE ----
      // The card's height now moves without the session COUNT moving, and the row
      // signatures cannot carry that: row 0 repaints (its prompt is in its
      // signature) at its new height, and every row BELOW it keeps the y it was
      // drawn at, with the tail of the old card still on the glass. So the height
      // gets its own cache and the same wholesale rebuild the count gets. Parsed,
      // because nothing geometric here can see a stale row.
      const rl = src.slice(src.indexOf("void renderSessionsList("));
      const rlBody = rl.slice(0, rl.indexOf("\nvoid "));
      chk(/sessionExpMeasure\(\);/.test(rlBody),
          `renderSessionsList() measures the band card ONCE per pass, before anything reads the geometry`);
      chk(/expNow != expHCache[\s\S]{0,120}?fillRect\(0, CONTENT_Y[\s\S]{0,200}?rowSigCache\[i\]\[0\] = '\\0'/.test(rlBody),
          `... and a CHANGE of that height clears the list and drops every row signature, the same rebuild a count change gets`);
    }
    // Both rules are drawn, and through the one helper - a rule inlined as a
    // fillRect at a second site is how the two would come to differ in colour or
    // in lane, and the lane is what makes the three left edges line up.
    chk((drawSrc.match(/drawBandRule\(/g) || []).length === 2,
        `the body draws exactly two rules, both through drawBandRule()`);

    // ---- §5 THE BAND CARD'S ONLY NON-HUE STATUS CARRIER ----
    // The expanded card draws NO pill and no shape-distinct indicator - the band
    // replaces both, and its border is hue - so labelForStatus()'s word is the
    // only thing separating asking from waiting there that a colourblind reader
    // or a greyscale capture can see. MUTATED and it went unnoticed: collapsing
    // the asking and waiting arms to one string left this checker at zero
    // failures, on the card this whole feature is built around.
    const LBL = statusLabels();
    chk(LBL.length === 3,
        `labelForStatus() returns three status words (${LBL.join(" / ")})`);
    chk(new Set(LBL).size === LBL.length && LBL.every((w) => w.trim().length > 0),
        `the band's three status words are DISTINCT, non-empty strings ` +
        `(${LBL.join(" / ")}) - the band card has no pill and no shape, so this ` +
        `word is its only carrier that is not hue`);
    // ... and the band really does draw THAT string, rather than a fourth copy of
    // the vocabulary that could drift from it.
    chk(/labelForStatus\(status\)/.test(fs.readFileSync(`${DIR}/sessions.ino`, "utf8")
          .slice(fs.readFileSync(`${DIR}/sessions.ino`, "utf8").indexOf("void bandStatusWord("))),
        `the band's word comes from labelForStatus(), not a second table`);

    // The card must fit the column it is drawn in.
    chk(c.SESSION_EXP_MAX_H <= 410,
        `the band card cap (${c.SESSION_EXP_MAX_H}) fits the 1-session list area`);
    // The band's own contents must fit ACROSS. This is the arithmetic that fails on
    // the detail screen (FINDING 1) and passes here - assert it so the two stay apart.
    // DERIVED FROM THE TWO HELPERS, term for term, rather than written out:
    //   lane = bandDurLeft(x, w) - wordX
    //        = (x + w - PAD - DUR_CHARS*ADV - 1) - (x + PAD + SPARK_SIZE + MARK_GAP)
    // with w the card INTERIOR (ROW_W - 2*BORDER_CARD). The trailing -1 is
    // bandDurLeft's own - it names where drawIfChanged's clear box STARTS, not
    // where the digits do - and transcribing this sum without it reported 200px
    // of room where the code gives 199. The mark's size is PARSED for the same
    // reason the spine's clearance parses it: a regenerated 40px mark moves this.
    const bandRoom = c.SESSION_ROW_W - 2 * c.BORDER_CARD - 2 * B2("PAD")
                     - sparkSize() - B2("MARK_GAP") - B2("DUR_CHARS") * c.TEXT_ADV - 1;
    // DUR_CHARS, not a "4m" a reader can imagine: the duration is a change-only
    // field, so the lane it clears is a CONSTANT and the word gets the rest.
    // T_HEAD's advance, parsed rather than transcribed - see UI[b][T_HEAD] above.
    // The literal 12 in the plan mirrors board_es3c35p.h's own comment
    // ("16 chars at T_HEAD's 12px advance = 192"); parsed here instead so a face
    // swap fails this checker rather than drifting past it.
    const headAdv = advanceB(b, T_HEAD);
    const longestWord = "NEEDS YOUR INPUT".length * headAdv;
    chk(longestWord <= bandRoom,
        `the band's longest status word (${longestWord}px) clears the duration (room ${bandRoom}px)`);

    chk(c.SESSION_SPINE_W >= 4 && c.SESSION_SPINE_W <= 8,
        `the spine is narrower than the card border radius allows to be lost`);

    // ---- §4 THE SPINE ----
    // THE SPINE'S LEFT EDGE IS READ OUT OF THE DRAW, not assumed. Transcribing it
    // as ROW_X + BORDER_CARD is what let an x inset ship: the constant said 14, the
    // firmware drew at 15, and every clearance assertion below went on describing
    // the shape the checker imagined. `x0` is the interior the call site passes;
    // anything the function adds to it has to move these numbers with it.
    const spineSrc = (() => {
      const s = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      const fn = s.slice(s.indexOf("void drawSessionSpine("));
      return fn.slice(0, fn.indexOf("\n}\n") + 2);
    })();
    const xShift = /const int x = x0 \+ SESSION_SPINE_INSET/.test(spineSrc) ? c.SESSION_SPINE_INSET : 0;
    const spineL = c.SESSION_ROW_X + c.BORDER_CARD + xShift;
    const spineR = spineL + c.SESSION_SPINE_W - 1;
    const sr = c.R_MD - c.BORDER_CARD;                 // the card's interior radius
    // IT CANNOT BE A RECT, and this is the assertion that says so rather than the
    // comment. On the interior's TOP row the card's fill has not reached the
    // spine's own x at all - the corner arc is still `sr` to the right of it - so a
    // fillRect there paints outside the outline. borderInnerX at dy 0 is that edge.
    chk(borderInnerX(c.SESSION_ROW_X, 0, c.RADIUS, c.BORDER_CARD) > spineL,
        `a plain rect spine would paint outside the card: at the interior's top row ` +
        `the fill starts at x=${borderInnerX(c.SESSION_ROW_X, 0, c.RADIUS, c.BORDER_CARD)}, ` +
        `the spine's left edge is x=${spineL}`);
    // ... so the fill is a capsule at the INTERIOR radius, whose left edge IS that
    // arc. Parsed, because none of the geometry above can see which shape the
    // firmware actually fills.
    {
      const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      const fn = src.slice(src.indexOf("void drawSessionSpine("));
      const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
      chk(/const int r = R_MD - BORDER_CARD;/.test(body),
          "drawSessionSpine() rounds at the card's INTERIOR radius (R_MD - BORDER_CARD), not a literal");
      chk(/uiFillRound\(x, y, 2 \* r, h, r, col, COLOR_CARD\);/.test(body),
          "drawSessionSpine() fills a capsule 2r wide, so its left edge is the interior's own arc");
      // THE CARVE MUST BE A STRAIGHT RECT, and this is the assertion the overlap
      // below exists to justify: a second capsule here carries the ink right with
      // the arc, into the spinner blit.
      chk(/tft\.fillRect\(x \+ SESSION_SPINE_W, y, 2 \* r - SESSION_SPINE_W, h, COLOR_CARD\);/.test(body),
          "... and carves it back with a STRAIGHT rect, which bounds the ink at x + SESSION_SPINE_W - 1 on every row");
      chk(!/uiFillRound\(x \+ SESSION_SPINE_W,/.test(body),
          "the carve is NOT a second capsule - that shape follows the arc and walks the ink into the spinner blit");
      chk(/const int y = y0 \+ SESSION_SPINE_INSET;/.test(body) &&
          /const int h = h0 - 2 \* SESSION_SPINE_INSET;/.test(body),
          "drawSessionSpine() insets its own box by SESSION_SPINE_INSET, clear of the border's last anti-aliased row");
      // AND THE INSET IS VERTICAL ONLY. This is not tidiness: an x inset moves the
      // capsule's arc off the card interior's own centre, and it slides the spine's
      // six columns one to the right, which puts its LAST column on the spinner
      // blit's FIRST. That shipped for one build and was read back off the panel
      // as 20 erased pixels a row. spineL below is derived from THIS expression,
      // so the geometric assertions move with the draw instead of describing a
      // shape it has stopped having.
      chk(/const int x = x0;/.test(body),
          "the spine's inset is VERTICAL ONLY - an x inset puts its last column on the spinner blit's first");
    }
    // THE PATTERN'S TWO NUMBERS, both bounded rather than chosen.
    chk(c.SESSION_SPINE_ON > c.SESSION_SPINE_W,
        `a Codex run (${c.SESSION_SPINE_ON}) is longer than the spine is wide (${c.SESSION_SPINE_W}) - a segment, not a square dot`);
    chk(c.SESSION_SPINE_OFF * 3 >= c.SESSION_SPINE_W * 2,
        `a gap (${c.SESSION_SPINE_OFF}) is at least 2/3 of the spine's width (${c.SESSION_SPINE_W}) - a gap, not a seam`);
    // The straight section is all the pattern may touch (the arcs stay solid, or a
    // knockout paints outside the card for the same reason a fill would), and the
    // SHORTEST spine the ladder can actually produce must still hold two gaps -
    // one break reads as a defect, two read as a texture.
    //
    // THE BOUND IS THE LOOP'S OWN, not a rule of thumb: the loop starts at r + ON
    // and runs while yy + OFF <= h - r, so a second gap needs
    // r + ON + P + OFF <= h - r, i.e. exactly 2P <= straight.
    //
    // AGAINST THE SHORTEST REACHABLE HEIGHT, NOT SESSION_ROW_H_MIN. That floor is
    // constrain()'s, for a panel smaller than this one, and the ladder never
    // reaches it here - spineHeights() establishes that by ENUMERATION rather than
    // by assertion. At the floor the straight section would hold only one gap; it
    // is stated in the header rather than left as a silent pixel of luck.
    const rows = spineHeights(c, contentBottom, MAX_SESSIONS);
    const shortest = rows[0];
    const straightMin = shortest - 2 * c.BORDER_CARD - 2 * c.SESSION_SPINE_INSET - 2 * sr;
    chk((c.SESSION_SPINE_ON + c.SESSION_SPINE_OFF) * 2 <= straightMin,
        `the pattern's period ${c.SESSION_SPINE_ON + c.SESSION_SPINE_OFF} fits twice in the shortest ` +
        `REACHABLE spine's straight section (${straightMin}px on a ${shortest}px row; the ladder never ` +
        `reaches SESSION_ROW_H_MIN ${c.SESSION_ROW_H_MIN} on this board)`);
    // EVERY REACHABLE SPINE HEIGHT, walked the way the loop in drawSessionSpine
    // walks it: no knockout may start above the top arc or end below the bottom
    // one, and every row that can carry a spine must show at least two gaps.
    for (const rowH of rows) {
      const g = spineGaps(c, rowH);
      chk(g.gaps.length >= 2,
          `spine on a ${rowH}px row: ${g.gaps.length} Codex gaps ` +
          `(${g.gaps.map(([a, z]) => `+${a}..+${z}`).join(" ")})`);
      for (const [a, z] of g.gaps)
        chk(a >= g.r && z <= g.h - g.r - 1,
            `spine on a ${rowH}px row: gap +${a}..+${z} is inside the straight section +${g.r}..+${g.h - g.r - 1}`);
    }
    // IT CLEARS EVERYTHING THE ROW ALREADY DRAWS, which is what makes this a
    // second carrier rather than a replacement. The mark is a 32x32 BLIT that
    // paints its own COLOR_CARD background across its whole rect, so any spine ink
    // inside it is erased - the same class of defect SESSION_DOT_CX exists for,
    // and the reason that constant is named at all.
    //
    // THIS ASSERTION USED TO BE PRECAUTIONARY AND IS NOW LOAD-BEARING. The blit
    // was once a WORKING-row thing, so a spine on a waiting or asking row met no
    // blit at all and the clearance was slack nobody was spending. drawStatusDot
    // now draws the mark at every status on this board, so every spine on the tab
    // sits beside a live 32x32 blit and this is the only thing standing between
    // the two.
    //
    // MODELLED FROM THE CAPSULE, NOT FROM A RECT. `spineL + SESSION_SPINE_W - 1`
    // is the rect model, and it is the wrong one: it reports 19 while a band that
    // followed the arc on BOTH edges reaches x=26 near the top of the row. That
    // model passed this assertion while 17 pixels were being erased on every
    // working row. The arc is asserted first so the hazard is on the record, then
    // the carve is asserted to bound it.
    const SPARK = sparkSize();                 // parsed, not the transcribed 16
    const blitL = c.SESSION_DOT_CX - SPARK / 2;
    const blitTop = c.SESSION_DOT_DY - SPARK / 2, blitBot = c.SESSION_DOT_DY + SPARK / 2 - 1;
    let arcWorst = -1, arcWorstRow = -1;
    for (let dy = c.BORDER_CARD; dy < 2 * c.R_MD; dy++) {
      const rt = spineArcRight(c, dy);
      if (rt !== null && rt > arcWorst && dy >= blitTop && dy <= blitBot) { arcWorst = rt; arcWorstRow = dy; }
    }
    chk(arcWorst >= blitL,
        `an arc-following right edge WOULD reach x=${arcWorst.toFixed(2)} at row +${arcWorstRow}, ` +
        `inside the spinner blit from x=${blitL} - which is why the carve is a straight rect`);
    // ... and with the straight carve the ink is bounded at spineL + SPINE_W - 1 on
    // every row, so the blit never touches it. This is the same number the rect
    // model reported; what changed is that it is now a CONSEQUENCE of the carve
    // rather than an assumption about the shape.
    chk(spineR < blitL,
        `the carve bounds the spine's ink at x=${spineR} on every row, clear of the spinner blit at x=${blitL}`);
    chk(spineR < c.SESSION_ROW_X + c.SESSION_NAME_DX,
        `spine x=${spineL}..${spineR} clears the name lane at x=${c.SESSION_ROW_X + c.SESSION_NAME_DX} - SESSION_NAME_DX needs no widening`);
    // THE CARVE'S OWN LEFT EDGE MUST CLEAR THE BORDER, which is what
    // SESSION_SPINE_INSET buys. borderInnerX is this file's conservative model of
    // the interior's left boundary; at the spine's topmost row the carve starts to
    // its right, so the rect can never rub out a border pixel.
    const carveX = spineL + c.SESSION_SPINE_W;
    const carveTop = c.BORDER_CARD + c.SESSION_SPINE_INSET;
    const innerAtCarve = borderInnerX(c.SESSION_ROW_X, carveTop, c.RADIUS, c.BORDER_CARD);
    chk(carveX >= innerAtCarve,
        `the carve's left edge x=${carveX} is inside the interior at its top row (+${carveTop}), ` +
        `where the border's inner edge is x=${innerAtCarve.toFixed(2)} - so it cannot nick the corner`);
    chk(borderInnerX(c.SESSION_ROW_X, c.BORDER_CARD, c.RADIUS, c.BORDER_CARD) > carveX,
        `and WITHOUT the inset it would not: at +${c.BORDER_CARD} the interior only starts at ` +
        `x=${borderInnerX(c.SESSION_ROW_X, c.BORDER_CARD, c.RADIUS, c.BORDER_CARD).toFixed(2)}`);
    // COLOUR IS NEVER THE ONLY CARRIER: a spine row still draws its text pill, and
    // a band row draws no spine. Both are properties of the call site, not of the
    // geometry, so both are parsed.
    {
      const src = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      chk(/if \(expanded\)\s*\n\s*drawSessionBand\([\s\S]*?\n\s*else\b[\s\S]*?drawSessionSpine\(/.test(src),
          "the spine is the band's ELSE - a row gets one head or the other, never both");
      chk(/drawSessionSpine\(SESSION_ROW_X \+ BORDER_CARD, y \+ BORDER_CARD,\s*\n\s*rowH - 2 \* BORDER_CARD,/.test(src),
          "the spine is drawn on the card's INTERIOR (inset by BORDER_CARD on all four sides)");
      // COLOUR IS NEVER THE ONLY CARRIER, and this is the assertion that says so.
      // It has to name the TWO ROW call sites specifically. Counting
      // `drawStatusPill(` occurrences does NOT: the file also holds the function's
      // own definition and the detail screen's call, so a count of >= 2 stays true
      // with both row pills deleted - which is the rule the spine exists to satisfy
      // passing green with the thing it guards removed. Anchored on each site's own
      // arguments, the way the band/spine `else` assertion already is.
      chk(/drawStatusPill\(nameX, y \+ rowH - \(showTitle \? SESSION_PILL_UP_T : SESSION_PILL_UP\),\s*\n\s*label, s\.status, false\);/.test(src),
          "the TALL row still draws its status pill - the spine is a second carrier, never the only one");
      chk(/drawStatusPill\(SESSION_ROW_X \+ SESSION_ROW_W - 16, y \+ SESSION_PILLC_Y, label, s\.status, true\);/.test(src),
          "the COMPACT row still draws its status pill - the spine is a second carrier, never the only one");
      // HOW MUCH MARGIN THE CARRIER HAS, IN BOTH THEMES, because the obvious
      // guess is backwards and a palette edit judged against the wrong one is how
      // this becomes a real defect. WCAG relative luminance on the decoded RGB565,
      // asking's filled body (COLOR_BAD) against waiting's body (COLOR_CARD, since
      // an outlined pill's interior IS the card):
      //
      //     LIGHT  0x6887 on 0xFFFF  =  11.93:1
      //     DARK   0xCBD4 on 0x18C4  =   5.78:1   <- THE HARDER CASE, about half
      //
      // DARK is the tighter of the two, not the looser. It still clears the 3:1
      // non-text threshold comfortably, and the carrier is topological anyway - an
      // unbroken field of ink against ink only at the edges, which is invariant
      // under inversion - so no palette change is owed. But anyone darkening these
      // must check DARK, not LIGHT.
      //
      // MARGINAL ELEMENT, worth knowing before COLOR_GOOD is touched: waiting's 2px
      // STROKE on its card is 3.37:1 under DARK against 6.71:1 under LIGHT. That
      // stroke is the thinnest ink in the scheme and has the least room in it.
      //
      // ...AND THE PILL'S FORM, WHICH THE TWO ABOVE DO NOT COVER. They assert the
      // call sites exist. They say nothing about what drawStatusPill DRAWS, so
      // changing asking's uiFillRound to uiStrokeRound - which destroys the last
      // non-hue carrier between asking and waiting outright - passed all of this
      // green. Presence was guarded; FORM was not, and form is the half that
      // carries the meaning.
      //
      // Branches are SLICED, not matched with a lazy regex across the function. A
      // /if \(asking\)[\s\S]*?uiFillRound\(/ would happily run past the asking
      // branch and find the uiStrokeRound branch's neighbour further down, which
      // is the vacuous-check trap this file has already paid for once.
      const pill = src.slice(src.indexOf("void drawStatusPill("));
      const pbody = pill.slice(0, pill.indexOf("\n}\n"));
      const iA = pbody.indexOf("if (asking) {");
      const iW = pbody.indexOf("} else if (working) {");
      const iE = pbody.indexOf("} else {", iW);
      chk(iA > 0 && iW > iA && iE > iW,
          "drawStatusPill branches three ways: asking / working / else");
      const askB = pbody.slice(iA, iW), workB = pbody.slice(iW, iE), elseB = pbody.slice(iE);
      chk(/uiFillRound\(/.test(askB) && !/uiStrokeRound\(/.test(askB),
          "asking draws a FILLED pill (uiFillRound) - the solid half of the fill/outline code");
      chk(/uiStrokeRound\(/.test(elseB) && !/uiFillRound\(/.test(elseB),
          "waiting draws an OUTLINED pill (uiStrokeRound) - the hollow half of the fill/outline code");
      chk(!/uiFillRound\(|uiStrokeRound\(/.test(workB),
          "working draws NO box at all - three states, three forms, so none is told by hue alone");
    }
    // ---- the agent mark is the indicator at EVERY status, not only working ----
    // drawStatusDot used to fall through to an anonymous square or ring for
    // `asking` and `waiting`, so the row said WHICH AGENT only while it happened
    // to be busy. The board-2 branch now draws the mark unconditionally.
    //
    // WHAT THIS SPENDS is asserted a few lines up rather than here: with the mark
    // at every status, `asking` and `waiting` no longer differ by shape AT THE
    // INDICATOR, and the two drawStatusPill assertions above are what say the
    // filled-vs-outlined carrier survives. Deleting either of them now costs the
    // distinction outright, where before it only cost a duplicate.
    {
      const src = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
      const fn = src.slice(src.indexOf("void drawStatusDot("));
      const body = fn.slice(0, fn.indexOf("\n}\n"));
      const i2 = body.indexOf("#else"), i3 = body.indexOf("#endif");
      chk(i2 > 0 && i3 > i2, "drawStatusDot splits on BOARD_USES_TFT_ESPI");
      const b1 = body.slice(0, i2), b2 = body.slice(i2, i3);
      // Board 1's half is held byte-identical by board-baseline.mjs; this only
      // says the shape vocabulary is still THERE, so a future tidy-up that
      // collapsed both boards onto the mark would fail here and not merely move
      // a binary somebody might re-baseline.
      chk(/uiRing\(cx, cy, r, 2, color, bg\);/.test(b1) && /drawAgentSpinner\(cx, cy, bg, codex\)/.test(b1),
          "board 1 keeps its square/ring/spinner vocabulary untouched");
      chk(/drawAgentMark\(/.test(b2),
          "board 2 draws the agent mark from drawStatusDot");
      // The point of the change: NO status-conditional shape is left on board 2.
      chk(!/uiRing\(|fillRect\(/.test(b2),
          "board 2's branch has NO square and NO ring left - the mark is the indicator at every status");
      // SPARK_SIZE / 2, never the literal 16. That literal was already dug out of
      // three sites once; a fourth would put the indicator's origin out of step
      // with the blit-clearance model above the moment the art changed size.
      chk(/drawAgentMark\(cx - SPARK_SIZE \/ 2, cy - SPARK_SIZE \/ 2,/.test(b2),
          "the mark's origin is derived from SPARK_SIZE, not a transcribed 16");
      // The rest pose, which is the part a reader will be tempted to simplify:
      // dim and unanimated, full status colour and animated only while working.
      chk(/working \? colorForStatus\(status\) : COLOR_LABEL, bg, working\);/.test(b2),
          "at rest the mark is COLOR_LABEL and unanimated; while working it is the status colour and animated");
    }

    // ---- THE BAND CARD'S MARK MUST ACTUALLY MOVE ----
    // NOTHING ELSE IN THIS FILE CAN SEE THIS, and it shipped broken once.
    // drawSessionBand was written with a literal /*animate=*/false - chosen before
    // the mark and the shimmer existed and never rejoined to them - while
    // tickWorkingSpinner SKIPPED the expanded row and the shimmer skips it too. So
    // a single working session, the most common screen on this tab, was completely
    // static: a regression from the plain row it replaced, at zero failures here.
    //
    // THE REST-POSE ASSERTION ABOVE LOOKS LIKE IT COVERS THIS AND DOES NOT. It
    // parses drawStatusDot's board-2 branch, which is the ORDINARY row's
    // indicator; the band card draws no indicator at all and never calls it.
    //
    // TWO SITES, because reverting EITHER ONE ALONE reproduces the regression in
    // full - the band's own draw decides the pose, and the tick is the only thing
    // that advances it. Both reverts were performed by hand and each fails by
    // name. Comments are stripped first, for the reason the body's draw sites
    // are: a commented-out call is the likeliest way one of these gets disabled.
    {
      const strip = (f) =>
        fs.readFileSync(`${DIR}/${f}`, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
      const fnBody = (src, sig, where) => {
        const a = src.indexOf(sig);
        const z = src.indexOf("\n}\n", a);
        if (a < 0 || z < 0) throw new Error(`${sig} not found in ${where}`);
        return src.slice(a, z);
      };
      const band = fnBody(strip("sessions.ino"), "void drawSessionBand(", "sessions.ino");
      chk(/const bool working = strcmp\(s\.status, "working"\) == 0;/.test(band),
          "the band binds `working` to the row's OWN status");
      chk(/drawAgentMark\([\s\S]{0,160}?\/\*animate=\*\/working\);/.test(band),
          "the band's mark ANIMATES on that working state - reverting the argument to " +
          "a literal false is a fully static one-session working card");
      chk(!/\/\*animate=\*\/false/.test(band),
          "... and no literal false is left in the band's mark call");
      const tick = fnBody(strip("deckhand_display.ino"), "void tickWorkingSpinner()",
                          "deckhand_display.ino");
      chk(/if \(sessionRowExpanded\(pos\)\) \{ drawBandMark\(pos\); continue; \}/.test(tick),
          "tickWorkingSpinner ADVANCES the band card's mark rather than skipping the row - " +
          "deleting drawBandMark(pos) is the same static card by the other route");
    }

    // ---- §6 THE TWO ADOPTED ANIMATIONS ----
    // Both are PARSED out of the draw and the tick, because none of the geometry
    // above can see an animation at all: a crossfade and an instant swap produce
    // the same final frame, and a shimmer that painted the arcs would look right
    // in every screenshot taken between two frames.
    {
      const dsrc = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
      const ssrc = fs.readFileSync(`${DIR}/sessions.ino`, "utf8");
      // Body of a function, sliced to its own closing brace at column 0 - the
      // same anchoring drawStatusPill's branch check uses, and for the same
      // reason: a lazy regex across a whole file finds a neighbour's line.
      const cut = (src, sig) => {
        const i = src.indexOf(sig);
        if (i < 0) throw new Error(`${sig} not found`);
        const f = src.slice(i);
        return f.slice(0, f.indexOf("\n}\n"));
      };

      // THE GATE IS COMPARED, NOT TRANSCRIBED. tickWorkingSpinner's guard list is
      // the one this repo already trusts; a second list kept in step by hand is
      // how a new animation ends up painting over the history reader. So the
      // spinner's own guard is parsed and every identifier in it must appear in
      // tickSessionAnim's - miss one and this fails by naming it.
      const spin = cut(dsrc, "void tickWorkingSpinner(");
      const anim = cut(ssrc, "void tickSessionAnim(");
      const ids = (t) => new Set(t.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
      // EVERY COMMENT ANCHOR IS CHECKED BEFORE IT IS SLICED ON, because indexOf
      // returns -1 rather than throwing: rename one of these comments and the
      // slice silently WIDENS to nearly the whole function body, at which point
      // the gate assertion below finds every identifier it is looking for and
      // passes vacuously. That is the same defect class as a pill count that
      // counted nothing and a transcribed spine edge - it has come up three times
      // in this feature's reviews, so the anchors are now assertions themselves.
      const anchor = (t, s, why) => {
        const i = t.indexOf(s);
        chk(i > 0, `anchor "${s}" is present - ${why}`);
        return i;
      };
      const spinGuard = spin.slice(spin.indexOf("\n"),
        anchor(spin, "if (millis() - lastAnimMs", "tickWorkingSpinner's guard list must end where its timer begins"));
      const animGuard = anim.slice(anim.indexOf("\n"),
        anchor(anim, "// ---- the state crossfade", "tickSessionAnim's guard list must end where its first animation begins"));
      const seen = ids(animGuard);
      const missing = [...ids(spinGuard)].filter((k) => !seen.has(k));
      chk(missing.length === 0,
          `tickSessionAnim()'s gate is at least as tight as tickWorkingSpinner()'s` +
          (missing.length ? ` - MISSING ${missing.join(", ")}` : ""));
      // NEITHER TICK MAY TOUCH lastNonIdleMillis. An animation that did would read
      // as activity to the sleep timer and hold the backlight on - which on this
      // board is the ONLY power saving left, ~80 of ~142 mV/h.
      chk(!/lastNonIdleMillis/.test(anim) && !/lastNonIdleMillis/.test(spin),
          "neither session tick touches lastNonIdleMillis - an animation must not read as activity");

      // THE LABEL CROSSFADES; IT DOES NOT SWAP AT THE MIDPOINT. Both words are on
      // the glass at the SAME position, at complementary strengths, so at t = 0.5
      // both sit at half and are briefly illegible. That is §6 as written and was
      // asked and answered - this assertion exists so "fixing" it to a swap fails
      // here rather than passing as a tidy-up.
      const band = cut(ssrc, "void drawSessionBand(");
      chk(/bandStatusWord\(xfadeFrom, fromFit, sizeof\(fromFit\), lane\);/.test(band) &&
          /tft\.drawString\(fromFit, wordX, wordY\);/.test(band) &&
          /tft\.drawString\(wordFit, wordX, wordY\);/.test(band),
          "§6: the band draws BOTH status words at the SAME position while a fade runs - a crossfade, not a swap");
      chk(/blend565\(fill, COLOR_CARD, \(uint8_t\) \(255 - t\)\)/.test(band) &&
          /blend565\(fill, COLOR_CARD, \(uint8_t\) t\)/.test(band),
          "... at COMPLEMENTARY strengths (255 - t and t), which is what makes both half at the midpoint");
      // Opaque-then-transparent is the mechanism: drawString skips its background
      // box when fg == bg, so the arriving word inks only its glyph runs and the
      // leaving word survives underneath. Two opaque draws would leave only one.
      chk(/tft\.setTextColor\(ink, t < 0 \? fill : ink\);/.test(band),
          "... and the arriving word draws TRANSPARENT (fg == bg) over the leaving one");
      // The fade has to have frames. Parsed from the two constants rather than
      // transcribed, so shortening either fails here instead of quietly turning
      // the crossfade into a two-step swap wearing its name.
      const num = (src, n) => {
        const m = src.match(new RegExp(`\\b${n}\\s*=\\s*(\\d+)`));
        if (!m) throw new Error(`${n} not found`);
        return Number(m[1]);
      };
      const xms = num(dsrc, "SESSION_XFADE_MS"), xiv = num(dsrc, "SESSION_XFADE_INTERVAL_MS");
      chk(Math.floor(xms / xiv) >= 8,
          `the crossfade runs ${Math.floor(xms / xiv)} frames (${xms}ms at ${xiv}ms) - motion, not a two-step swap`);

      // ---- the shimmer stays inside the six columns, and off the arcs ----
      // Same two hazards the spine's own fill and knockout carry, arriving through
      // the animation: an x inset puts its last column on the spinner blit's
      // first, and painting up in an arc paints OUTSIDE the card, because there
      // the fill's left edge has moved right and this rect's has not.
      const shim = cut(ssrc, "void drawSpineShimmer(");
      chk(/const int x = x0;/.test(shim),
          "the shimmer's inset is VERTICAL ONLY, exactly as the spine's is");
      chk(/tft\.fillRect\(x, y \+ r \+ yy, SESSION_SPINE_W, 1,/.test(shim),
          "the shimmer paints SESSION_SPINE_W columns at the spine's own x - the bound the straight carve gives the fill");
      chk(/const int span = h - 2 \* r;/.test(shim) && /for \(int yy = 0; yy < span; yy\+\+\)/.test(shim),
          "... and only the STRAIGHT section between the arcs, where the fill's left edge really is at x");
      // ONE COPY OF THE KNOCKOUT. The shimmer repaints the column solid, so a
      // Codex row owes its gaps back - through the same helper the spine draws
      // them with, or the two loops drift and one of them paints into an arc.
      chk(/if \(codex\) drawSpineGaps\(x, y, r, h\);/.test(shim) &&
          /if \(codex\) drawSpineGaps\(x, y, r, h\);/.test(cut(ssrc, "void drawSessionSpine(")),
          "the shimmer and the spine cut their Codex gaps with the SAME helper");

      // ---- THE SHIMMER RIDES THE SPINNER'S FLUSH, and all three halves of that
      // are load-bearing. MEASURED on the panel: a flush's transfer is fixed
      // per-STRIP, not per-pixel (1453us for a 320x32 strip, 792us for an 8x32
      // one), so the spine's six columns spanning the whole list are 8 strips and
      // ~6.3ms - four times a second, for 2,424 pixels. The spinner already
      // pushes those strips, so the shimmer's marginal transfer is nothing.
      //
      // (1) tickSessionAnim must be called BEFORE tickWorkingSpinner, or the
      //     paint waits a frame for a flush. (2) the shimmer must READ lastAnimMs
      //     and not write it, or it consumes the spinner's own timer and the
      //     spark stops animating outright. (3) the spinner must still end in a
      //     flush, or nothing carries either of them.
      const loopFn = cut(dsrc, "void loop() {");
      const iAnim = loopFn.indexOf("tickSessionAnim();");
      const iSpin = loopFn.indexOf("tickWorkingSpinner();");
      chk(iAnim > 0 && iSpin > iAnim,
          "loop() calls tickSessionAnim() BEFORE tickWorkingSpinner(), so the shimmer's paint is in the frame the spinner flushes");
      // BOUNDED AT THE PULSE BLOCK, not run to the end of the function. This slice
      // used to be open-ended, which was only correct while the shimmer was the
      // last thing in tickSessionAnim - the attention pulse flushes its own
      // rectangle, so an unbounded slice would read the pulse's flush as the
      // shimmer's and fail the very assertion that keeps the shimmer free.
      const iPulse = anchor(anim, "// ---- §6 the attention pulse",
        "the shimmer's slice must END at the pulse, whose own flush would otherwise read as the shimmer's");
      const shimBlock = anim.slice(
        anchor(anim, "// ---- the spine shimmer", "the shimmer's block must be findable to be checked"), iPulse);
      chk(/if \(millis\(\) - lastAnimMs >= ANIM_INTERVAL_MS\)/.test(shimBlock) &&
          !/lastAnimMs\s*=[^=]/.test(shimBlock),
          "the shimmer READS lastAnimMs and never writes it - consuming the spinner's timer would stop the spark animating");
      chk(!/tft\.flush\(\)/.test(shimBlock),
          "the shimmer flushes NOTHING of its own - a tall narrow dirty rect is the worst shape this flush path has");
      chk(/tft\.flush\(\);\n#endif\s*$/.test(spin),
          "... and tickWorkingSpinner still ends in the flush that carries it");

      // ---- §6 THE ATTENTION PULSE, which ships DISABLED and UNMEASURED ----
      // It is the one animation §6 adopts "only after measurement", because it is
      // the only one that costs current indefinitely. Nothing here judges whether
      // it should ship - that is a POWERPROBE A/B nobody has run - but everything
      // here holds the shape that makes the A/B possible and its default safe.
      const pulseBlock = anim.slice(iPulse);
      chk(/\bbool sessionPulse = false;/.test(dsrc),
          "§6: the attention pulse ships DISABLED - its A/B is unrun, and an unmeasured continuous animation must not default on");
      chk(/buf\.startsWith\("PULSE "\)/.test(dsrc) && /sessionPulse = buf\.substring\(6\)\.toInt\(\) != 0;/.test(dsrc),
          "... behind a RUNTIME toggle (PULSE 0|1), so both legs of the A/B fit one battery session instead of costing a reflash each");
      // The gate on WHICH session breathes. "While a prompt waits" is `asking`, and
      // it is read from the status rather than from a row index, exactly as the
      // crossfade keys on an id: a status change is what re-ranks this list.
      const pa = cut(ssrc, "uint8_t sessionPulseA(");
      chk(/if \(!sessionPulse \|\| strcmp\(status, "asking"\) != 0\) return 0;/.test(pa),
          "the pulse's ramp is zero unless the toggle is on AND the session is `asking` - §6's \"while a prompt waits\"");
      // Composition order, which is what makes a fade INTO asking seamless: the
      // pulse rides ON TOP of the crossfade's blend rather than replacing it.
      const bf = cut(ssrc, "uint16_t sessionBandFill(");
      chk(/return pulseA \? blend565\(base, COLOR_VALUE, pulseA\) : base;/.test(bf),
          "the pulse composes ON TOP of the crossfade's blend, and towards COLOR_VALUE - away from the band's own COLOR_CARD ink, so the word's contrast can only improve at the peak");
      // THE CHANGE-ONLY REPAINT. This is the design, not a tuning: the ramp has
      // only a handful of distinct RGB565 colours (asserted below), so a band
      // repainted every sample pushes an identical 292x42 region most of the time.
      chk(/if \(want != bandFillShown\)/.test(pulseBlock),
          "the pulse repaints on a CHANGE OF FILL, not on a timer - the change-only discipline applied to an animation");
      // A RECORD, NOT A REQUEST, and written where the painting happens. Counted
      // rather than merely found: a second writer anywhere is how the record and
      // the panel drift apart, which is the failure savingsSync was rewritten for.
      const writes = [...(ssrc + dsrc).matchAll(/\bbandFillShown\s*=[^=]/g)].length;
      chk(writes === 2 && /bandFillShown = fill;/.test(band),
          `bandFillShown is written in exactly two places - its declaration and drawSessionBand (found ${writes}) - so the record of what is on the glass cannot drift from it`);
      chk(/if \(sessionXfadeT\(sessions\[i\]\.id\) < 0\) \{/.test(pulseBlock),
          "the crossfade OWNS the band while it runs - it already paints at the pulse's own alpha, so a second repaint in the same frame would double its cost to change nothing");
      // Its own rectangle, leading and trailing, exactly as the crossfade's - and
      // NOT the shimmer's ride-along, which only works because something else was
      // pushing those strips anyway. Nothing else pushes the band.
      chk((pulseBlock.match(/tft\.flush\(\);/g) || []).length === 2,
          "the pulse flushes its OWN rectangle, leading and trailing, as the crossfade does - nothing else is pushing the band's strips");

      // ---- THE PALETTE, PARSED - and the peaks bounded in a space where
      // "nearer" means something. The old bound on SESSION_SHIMMER_MAX was
      // `< 128`, a blend WEIGHT: 126/255 is under half by arithmetic and still
      // lands the peak NEARER COLOR_VALUE than the status colour it is supposed to
      // read as. Parsed from THEMES[] and its own struct, so neither the values nor
      // the COLUMN ORDER is transcribed here.
      const tstruct = dsrc.match(/struct Theme \{[^}]*?uint16_t ([^;]+);/);
      if (!tstruct) throw new Error("struct Theme not found");
      const tf = tstruct[1].split(",").map((s) => s.trim());
      const trows = dsrc.match(/const Theme THEMES\[\] = \{([\s\S]*?)\n\};/);
      if (!trows) throw new Error("THEMES[] not found");
      const themes = [...trows[1].matchAll(/\{\s*"([A-Z]+)"\s*,\s*([^}]+)\}/g)].map((m) => {
        const v = m[2].split(",").map((s) => parseInt(s.trim(), 16));
        const o = { name: m[1] };
        tf.forEach((k, j) => { o[k] = v[j]; });
        return o;
      });
      chk(themes.length >= 2 && themes.every((t) => Number.isFinite(t.value) && Number.isFinite(t.bad)),
          `parsed ${themes.length} palettes out of THEMES[] with ${tf.length} colour columns`);
      // blend565, byte for byte from deckhand_display.ino - integer truncation and
      // all, because the quantisation is exactly what the bounds are about.
      const blend565 = (a, bb, t) => {
        const ar = (a >> 11) & 31, ag = (a >> 5) & 63, ab = a & 31;
        const br = (bb >> 11) & 31, bg = (bb >> 5) & 63, bl = bb & 31;
        return (((ar + Math.trunc((br - ar) * t / 255)) & 31) << 11) |
               (((ag + Math.trunc((bg - ag) * t / 255)) & 63) << 5) |
                ((ab + Math.trunc((bl - ab) * t / 255)) & 31);
      };
      // CIE Lab and dE*ab - the same method palette-check.mjs uses to judge colour,
      // rather than the WCAG luminance ratio, which cannot see hue at all.
      const srgb = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
      const lab = (c565) => {
        const r = srgb(((c565 >> 11) & 31) * 255 / 31), g = srgb(((c565 >> 5) & 63) * 255 / 63),
              bl = srgb((c565 & 31) * 255 / 31);
        const fx = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
        const X = fx((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047),
              Y = fx(0.2126 * r + 0.7152 * g + 0.0722 * bl),
              Z = fx((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
        return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
      };
      const dE = (a, bb) => {
        const A = lab(a), B = lab(bb);
        return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
      };
      // THE STANDARD JND, from outside this repo and not tuned to anything in it.
      // A peak under it is an animation nobody can see: at 16/255 the ramp's dE is
      // 0.00 outright, because blend565 quantises straight back onto the base.
      //
      // THE RATIO BOUND IS NOT MONOTONE, AND THE SWEEP'S "+16 IS CAUGHT" MUST NOT
      // BE READ AS HEADROOM. Swept 90..170, the ratio fails at 124 and 126 (1.081)
      // and again from 132 up, but 128 and 130 PASS at 0.987 - an RGB565
      // quantisation dip, not a smooth curve. So the constraint is real and the
      // shipped 110 clears it, but a perturbation of +18 would land in the dip and
      // pass where +16 fails. If either MAX moves, re-sweep the neighbourhood
      // rather than assuming the margin scales.
      const JND = 2.3;
      // The three status colours are the ones colorForStatus can return; taken by
      // NAME from the parsed palette rather than transcribed as hex.
      const STATUS = ["good", "warn", "bad"];
      const peakCheck = (name, max) => {
        let worstVis = Infinity, worstVisAt = "", worstRatio = 0, worstRatioAt = "";
        for (const t of themes) for (const k of STATUS) {
          const peak = blend565(t[k], t.value, max);
          const d = dE(t[k], peak), dv = dE(peak, t.value);
          if (d < worstVis) { worstVis = d; worstVisAt = `${t.name} ${k}`; }
          if (d / dv > worstRatio) { worstRatio = d / dv; worstRatioAt = `${t.name} ${k}`; }
        }
        chk(worstVis >= JND,
            `${name} = ${max} is VISIBLE in every palette: worst peak dE ${worstVis.toFixed(1)} ` +
            `(${worstVisAt}) against the ${JND} JND`);
        chk(worstRatio < 1,
            `... and still reads as its STATUS colour: the peak is nearer the base than COLOR_VALUE ` +
            `in every palette (worst ratio ${worstRatio.toFixed(2)}, ${worstRatioAt})`);
      };
      peakCheck("SESSION_SHIMMER_MAX", c.SESSION_SHIMMER_MAX);
      peakCheck("SESSION_PULSE_MAX", c.SESSION_PULSE_MAX);

      // THE SAMPLE RATE'S BOUND IS THE RAMP'S OWN RESOLUTION, and the number it
      // produces is the reason the pulse repaints on a change rather than a timer.
      // A "smooth enough" bound does not exist here: one LSB of green on DARK is
      // already dE 5.5, so NO frame rate makes the steps sub-JND. What the sample
      // rate must do is skip no distinct colour - frames per HALF breath >= the
      // ramp's distinct-colour count.
      const pms = num(dsrc, "SESSION_PULSE_MS"), piv = num(dsrc, "SESSION_PULSE_INTERVAL_MS");
      const ramp = (base, val, max) => {
        const s = new Set();
        for (let a = 0; a <= max; a++) s.add(blend565(base, val, a));
        return s.size;
      };
      // The no-skip bound is taken over EVERY status colour, not just the one the
      // pulse uses today: the sample is nearly free (the repaint is what costs, and
      // that is gated on a change), so sampling fine enough for the whole
      // vocabulary keeps the constant right if the pulse is ever extended.
      let steps = 0;
      for (const t of themes) for (const k of STATUS)
        steps = Math.max(steps, ramp(t[k], t.value, c.SESSION_PULSE_MAX));
      chk(Math.floor(pms / piv) / 2 >= steps,
          `the pulse samples ${Math.floor(pms / piv)} times a breath (${pms}ms at ${piv}ms), ` +
          `${Math.floor(pms / piv) / 2} per half, against the ${steps} distinct colours of the coarsest ` +
          `status ramp - so no step is skipped in ANY palette`);
      // WHAT THE CHANGE-ONLY RECONCILE ACTUALLY BUYS, on the colour the pulse
      // really ramps - which is derived by parsing colorForStatus and the ramp's own
      // strcmp rather than by transcribing "asking is COLOR_BAD" into this file.
      const gate = pa.match(/strcmp\(status, "([a-z]+)"\) != 0\) return 0;/);
      if (!gate) throw new Error("the pulse's status gate could not be parsed");
      const cfs = cut(dsrc, "uint16_t colorForStatus(");
      const tok = cfs.match(new RegExp(`strcmp\\(status, "${gate[1]}"\\) == 0\\) return COLOR_([A-Z]+);`));
      if (!tok) throw new Error(`colorForStatus has no branch for "${gate[1]}"`);
      const key = tok[1].toLowerCase();
      let paints = 0;
      for (const t of themes)
        paints = Math.max(paints, 2 * (ramp(t[key], t.value, c.SESSION_PULSE_MAX) - 1));
      chk(paints < Math.floor(pms / piv),
          `a whole breath of the "${gate[1]}" colour (COLOR_${tok[1]}) costs at most ${paints} band repaints ` +
          `against ${Math.floor(pms / piv)} samples - what painting only on a CHANGE buys on the one ` +
          `animation whose cost is being weighed against a battery`);
    }
    // The shimmer's own two numbers, bounded rather than chosen. The head plus its
    // falloff has to fit WHOLE inside the shortest straight section the ladder can
    // produce, or the light is clipped at both ends on the very rows the spine
    // exists for; and the peak must stay under half, or the spine stops reading as
    // its status colour at the moment it is most visible.
    chk(2 * c.SESSION_SHIMMER_LEN <= straightMin,
        `the shimmer's head and falloff (${2 * c.SESSION_SHIMMER_LEN}px) fit inside the shortest ` +
        `reachable straight section (${straightMin}px on a ${shortest}px row)`);
    // The ARITHMETIC half only. "Under half the blend weight" is NOT the same claim
    // as "still reads as its status colour" - 126/255 satisfies this and fails the
    // perceptual bound in the animation block above, which is the one that means
    // it. Kept because it is a cheap sanity floor on the raw value, not because it
    // is sufficient.
    chk(c.SESSION_SHIMMER_MAX > 0 && c.SESSION_SHIMMER_MAX < 128,
        `the shimmer's peak ${c.SESSION_SHIMMER_MAX}/255 is a sane blend weight (the claim that it still ` +
        `reads as its status colour is the perceptual bound, not this)`);
    chk(c.SESSION_SHIMMER_STEPS * 2 >= straightMin,
        `one traverse is ${c.SESSION_SHIMMER_STEPS} frames over ${straightMin}px - the head moves at most ` +
        `2px a frame, so it travels rather than jumps`);
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
  const blitL = c.SESSION_DOT_CX - sparkSize() / 2, blitTopRow = c.SESSION_DOT_DY - sparkSize() / 2;
  const inner = borderInnerX(c.SESSION_ROW_X, blitTopRow, c.RADIUS, c.BORDER_CARD);
  chk(blitL >= inner,
      `spinner blit left x=${blitL} clears the corner border's inner edge x=${inner.toFixed(2)} on its top row (y+${blitTopRow}) by ${(blitL - inner).toFixed(2)}px`);
  chk((c.SESSION_DOT_CX + sparkSize() / 2 - 1) < nameX,
      `spinner blit right x=${(c.SESSION_DOT_CX + sparkSize() / 2 - 1)} clears the name lane at x=${nameX}`);
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
  blk.push(["pill", cy, cy + c.PILL_H - 1]);                 cy += c.DETAIL_PILL_STEP;
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

  // ---- the VOICE RESULT CARD (drawVoiceCard, audio.ino) ----
  // Checked HERE rather than in a fourth checker, and the reason is that it is the same
  // KIND of surface as the ask screen above it: a full-content-area overlay whose text
  // is host-published and whose geometry is a running cursor down the content area.
  // It shares this block's helpers and its `known` machinery, and a checker of its own
  // would duplicate the header parse and the font registry for eight assertions.
  // Nothing covered it at all before, which is how it kept a 13px step under a 16px
  // cell through a whole type-scale port.
  const V_META = lineHB(b, T_META);
  // The state label / "tap to dismiss" row at +6 against the block at +22. Board 2
  // clears it exactly.
  chk(c.CONTENT_Y + 6 + V_META <= c.CONTENT_Y + 22,
      `voice card: state label inks +6..+${6 + V_META - 1}, YOU SAID starts +22`);
  // THE LABEL STEP against the label's own cell. Board 1 is 1px short - the block's fill
  // lands on the label's last row - which its blank glyph bottom row absorbs; the same
  // encroachment on a 16px face would cost four real rows, so board 2 takes the full
  // cell. Same shape of allowance as the ask badge/title pair above.
  let vm = `voice card label step ${c.VOICE_LBL_STEP} >= the label's own ${V_META}px cell`;
  chk(c.VOICE_LBL_STEP >= V_META, vm, isKnown(b, vm));
  // The running cursor, laid out rather than echoed - the only way a step that is
  // right in one place and wrong in another gets caught.
  const vPanelY = c.CONTENT_Y + 22 + c.VOICE_LBL_STEP;
  const vPanelH = c.VOICE_TEXT_LINES * c.CODE_LINE_H + 12;
  const vTextEnd = vPanelY + 6 + c.VOICE_TEXT_LINES * c.CODE_LINE_H - 1;
  const vReplyLblY = vPanelY + vPanelH + 10;
  const vReplyY = vReplyLblY + c.VOICE_LBL_STEP;
  const vBound = contentBottom - 8;
  const vAvail = Math.floor((vBound - vReplyY) / c.CODE_LINE_H);
  console.log(`    voice card: panel ${vPanelY}..${vPanelY + vPanelH - 1} (text to ${vTextEnd}), ` +
              `reply label ${vReplyLblY}, reply ${vReplyY}..${vReplyY + vAvail * c.CODE_LINE_H - 1} of ${vBound}`);
  chk(vTextEnd < vPanelY + vPanelH,
      `voice card: ${c.VOICE_TEXT_LINES} text lines end ${vTextEnd} inside a ${vPanelH}px panel`);
  chk(vReplyLblY >= vPanelY + vPanelH,
      `voice card: reply label at ${vReplyLblY} clears the panel ending ${vPanelY + vPanelH - 1}`);
  chk(vAvail >= 1, `voice card: ${vAvail} reply lines fit above the footer bound ${vBound}`);
  chk(vReplyY + vAvail * c.CODE_LINE_H - 1 <= vBound,
      `voice card: the reply block ends ${vReplyY + vAvail * c.CODE_LINE_H - 1}, inside ${vBound}`);
  // THE TWO LITERAL 6s IN drawVoiceCard's CLAMP, parsed out of audio.ino and pinned to
  // VOICE_TEXT_LINES. They are literals on purpose - naming them costs board 1 eight
  // bytes for identical codegen, see the note at that call site - which leaves exactly
  // the drift this checker exists to catch: the panel's HEIGHT would be sized for one
  // line count while drawWrappedText drew another, and the symptom is a panel that no
  // longer wraps its own text. Board-independent, so only checked once.
  if (b === 1) {
    const audio = fs.readFileSync(`${DIR}/audio.ino`, "utf8");
    const clamp = audio.match(/int h = \(lines > (\d+) \? (\d+) : lines\) \* CODE_LINE_H/);
    const maxLines = audio.match(/drawWrappedText\(voiceText,[^;]*?CODE_LINE_H, maxW - 14, 0, (\d+),/s);
    chk(!!clamp && !!maxLines, "drawVoiceCard's clamp and maxLines literals are still parseable from audio.ino");
    if (clamp && maxLines) {
      const got = [+clamp[1], +clamp[2], +maxLines[1]];
      chk(got.every(n => n === c.VOICE_TEXT_LINES),
          `voice card: audio.ino's clamp/maxLines literals ${got.join("/")} all equal VOICE_TEXT_LINES ${c.VOICE_TEXT_LINES}`);
    }
  }
  // THE TRANSCRIPT CAP, hard-wrapped at this board's own advance. Board 1 needs 7 lines
  // for the host's 200 characters and shows 6, which is pre-existing and left alone
  // because its binary is held byte-identical; the point of asserting it is that board 2
  // must not be WORSE, and it is exact.
  const vCols = Math.floor((W - 2 * c.CARD_X - 14) / advanceB(b, T_META));
  vm = `voice card: ${c.VOICE_TEXT_LINES} lines hold ${c.VOICE_TEXT_LINES * vCols} of ${VOICE_TEXT_MAX} transcript chars`;
  chk(c.VOICE_TEXT_LINES * vCols >= VOICE_TEXT_MAX, `${vm} (lane ${W - 2 * c.CARD_X - 14}px = ${vCols}/line)`,
      isKnown(b, vm));

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
