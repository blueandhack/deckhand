// Shared machinery for the geometry checkers (usage-geom-check.mjs,
// sessions-geom-check.mjs). Extracted rather than copied: there is exactly ONE
// interesting thing in here - a reimplementation of TFT_eSPI's text measurement -
// and a second copy of it that drifts would let a checker bless a layout the panel
// draws differently, which is the failure the checkers exist to prevent.
//
// The measurement rule, and it is not obvious: every character but the LAST is
// charged xAdvance; the last is charged xOffset + width. Those differ for 20 of
// Cozette's 95 glyphs, so counting 6px a character is wrong by a few pixels in
// exactly the places a lane is tightest. preflight() checks this implementation
// against the 136 widths text-widths-board2.txt records from the real panel, so a
// wrong measurement fails loudly instead of quietly approving a wrong layout.
import fs from "fs";
import path from "path";
export const DIR = path.dirname(new URL(import.meta.url).pathname);

// Every source read goes through here. It is memoised purely for geom-sweep.mjs,
// which re-executes a whole checker thousands of times in one process - the
// checkers themselves read each file once and would not notice. Nothing mutates
// what it returns.
const SRC = new Map();
function read(file) {
  const p = `${DIR}/${file}`;
  if (!SRC.has(p)) SRC.set(p, fs.readFileSync(p, "utf8"));
  return SRC.get(p);
}

function parseFont(file, name) {
  const src = read(file);
  const gl = src.slice(src.indexOf("Glyphs[]"));
  const rows = [...gl.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)];
  const glyphs = rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5], yo: +m[6] }));
  return { name, first: 0x20, glyphs };
}
const COZ = parseFont("Cozette6x13.h", "coz");
const TER = parseFont("Terminus10x18b.h", "ter");
// UI_FONTS: 1,2 -> Cozette size1; 3 (T_HEAD) -> Terminus size1; 4 (T_HERO) -> Cozette size2
export const FONTS = { 1: [COZ, 1, 13], 2: [COZ, 1, 13], 3: [TER, 1, 18], 4: [COZ, 2, 26] };
export function textWidth(s, fontId, sizeOverride) {
  const [f, fsize] = FONTS[fontId];
  const size = sizeOverride || fsize;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const g = f.glyphs[s.charCodeAt(i) - f.first];
    if (!g) continue;
    if (i === s.length - 1) w += (g.xo + g.w) * size;
    else w += g.xa * size;
  }
  return w;
}
// uiLineH(): the registry's cell height for a font id.
export function lineH(fontId) { return FONTS[fontId][2]; }

// Refuse to run at all unless the measurement matches the device's own numbers.
export function preflight() {
  let bad = 0, checked = 0;
  for (const line of read("text-widths-board2.txt").split("\n")) {
    const m = line.match(/^WIDTH (\d+) (\d+) (\d+) "(.*)"$/);
    if (!m) continue;
    const [, font, size, want, text] = m;
    const got = textWidth(text, +font, +size > 1 ? +size : 0);
    checked++;
    if (got !== +want) { bad++; if (bad < 6) console.log(`MISMATCH ${font}/${size} want ${want} got ${got} "${text}"`); }
  }
  console.log(`textWidth self-check: ${checked - bad}/${checked} match device measurements`);
  if (bad) { console.log("ABORT: implementation disagrees with the panel"); process.exit(1); }
}

// ---- the fault-injection seam, for geom-sweep.mjs ----
//
// INERT UNLESS SET, which is the whole design requirement: with no injection and
// no recording, consts() below behaves exactly as it did before this seam existed,
// so the three checkers' standalone output and exit codes are untouched.
//
// The perturbation is applied AT PARSE TIME rather than to the finished constant
// table, and that is the only faithful place for it. A board header's numbers feed
// the derived offsets in deckhand_display.ino (SESSION_TITLE_Y = SESSION_NAME_Y_T +
// 26 + SESSION_LINE_GAP, and forty more like it), so "this header number is wrong"
// has to mean "and everything computed from it moved too" - patching the table
// afterwards would leave the derivations at their correct values and report a
// constant as unguarded when the checker would in fact have caught it.
//
// WHICH BOARD a perturbation belongs to is tracked here rather than passed in,
// because consts() is called twice per board (header, then the .ino seeded with
// it) and only the first call names a board. Every checker parses the header for a
// board immediately before the .ino for that same board - the order the compiler
// sees, and the order all three files already document - so the last header parsed
// identifies the board. geom-sweep.mjs does not take this on trust: it asserts that
// each injection landed exactly once, so a checker that ever parsed the two files
// in some other order would fail the sweep's own internal check rather than
// silently attribute a constant to the wrong board.
const BOARD_OF = { "board_e32r28t.h": 1, "board_es3c35p.h": 2 };
let curBoard = 0;
let INJECT = null, injectHits = 0;
let SEEN = null;
// {board, name, delta} to perturb one parsed constant; null to clear.
export function setInject(spec) { INJECT = spec; injectHits = 0; }
// How many times the pending injection actually landed. 0 means the constant was
// never parsed under that board; >1 means it is declared twice.
export function injectHitCount() { return injectHits; }
// Record the `board:NAME` of every constant a run parses - which is how the sweep
// learns each checker's universe of constants from the checker itself, instead of
// from a hand-maintained list that would drift the moment a checker parsed one
// more file.
export function beginRecord() { SEEN = new Set(); }
export function endRecord() { const s = SEEN; SEEN = null; return s; }

// C DIVISION TRUNCATES AND JAVASCRIPT'S DOES NOT, so the expression is evaluated
// by this instead of by eval(). `const int P1_THIRD_W = (CARD_W - 16) / 3` is 66 on
// board 1 and the float answer is 66.67, which then propagated: P1_THEME_X came out
// 161.33 against the compiler's 160. Nothing asserted those three constants at the
// time, so nothing was wrong on screen - but a checker whose constant table
// disagrees with the compiler by a pixel is the exact failure mode these files
// exist to prevent, and the toggle-row assertions added afterwards would have been
// measuring the wrong numbers.
//
// It is a recursive-descent evaluator over the only grammar the declaration regex
// can admit - numbers, + - * /, parentheses, unary minus - with Math.trunc at every
// division, which is C's round-toward-zero. Doing it as a parser rather than a
// regex around eval() is what makes a nested case like `(a / 3) * 2` come out right,
// and it stops feeding file text to eval() as a bonus. An unparseable expression
// THROWS, and consts() skips that declaration exactly as it skipped an eval()
// failure before.
function evalInt(expr) {
  let i = 0;
  const ws = () => { while (i < expr.length && expr[i] === " ") i++; };
  const peek = () => { ws(); return expr[i]; };
  function primary() {
    ws();
    if (expr[i] === "(") { i++; const v = sum(); ws(); if (expr[i] !== ")") throw new Error("expected )"); i++; return v; }
    if (expr[i] === "-") { i++; return -primary(); }
    if (expr[i] === "+") { i++; return primary(); }
    const m = /^\d+/.exec(expr.slice(i));
    if (!m) throw new Error(`not a number at "${expr.slice(i)}"`);
    i += m[0].length;
    return +m[0];
  }
  function product() {
    let v = primary();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= primary(); }
      else if (c === "/") { i++; const d = primary(); if (!d) throw new Error("divide by zero"); v = Math.trunc(v / d); }
      else return v;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += product(); }
      else if (c === "-") { i++; v -= product(); }
      else return v;
    }
  }
  const v = sum();
  ws();
  if (i !== expr.length) throw new Error(`trailing "${expr.slice(i)}"`);
  return v;
}

// THE PARSER IS PREPROCESSOR-AWARE, and it had to become so: it was not, and
// geom-sweep.mjs found the consequence. Exactly one conditional block in the
// sketch declares `const int` - page 2's action-button chain, where
// `#if BOARD_HAS_MIC` gives board 1 a MIC TEST button board 2 does not have - and a
// blind parse takes the LAST declaration, so BOTH boards were read as the no-mic
// arm. Board 1's P2_PAIR_Y/P2_PWR_Y then came out one whole button too HIGH (184
// against the real 230), and the only assertion downstream of them was checking
// its clearance against the footer with 46px of phantom slack. It passed either
// way - the real hint ends at 286 of 302 - so nothing was ever wrong on the glass,
// but the assertion was not guarding what it claimed to, which is the same class
// of defect as a change-only cache shorter than its string.
//
// The `#define`s come from the BOARD HEADER being parsed, so the two boards
// genuinely disagree here rather than sharing one guess. An expression this cannot
// evaluate does NOT default to "include": the block is marked unknown, and a
// `const int` found inside one throws. Defaulting is precisely how a parser reads
// the wrong arm, and a loud refusal is what stops the next conditional constant
// repeating the bug this comment exists because of.
// ART HEADERS whose #defines the sketch's own constants are derived FROM. These
// are board-independent (the artwork is one size on both panels) but they must be
// in the constant table, or an expression naming one evaluates to NaN and every
// assertion downstream of it silently reports NaN instead of failing on a real
// number. That is not hypothetical: WAIT_NAME_Y is derived from LOGO_SIZE, and
// before this the whole waiting-screen column came out NaN - which LOOKS like a
// failure but is a parse gap, and the two are worth telling apart immediately.
// Add a header here the moment a sketch constant is derived from one of its
// #defines; parsing it rather than hardcoding the number is what makes a resized
// asset fail the check instead of passing it.
const ART_HEADERS = ["DeckhandLogo.h"];
const DEFS = {};                 // board number -> {NAME: number}
function defsFor(file) {
  if (!BOARD_OF[file]) return DEFS[curBoard] || {};
  const d = {};
  for (const h of ART_HEADERS)
    for (const m of read(h).matchAll(/^#define\s+([A-Za-z_0-9]+)\s+(-?\d+)\s*(?:\/\/.*)?$/gm))
      d[m[1]] = +m[2];
  for (const m of read(file).matchAll(/^#define\s+([A-Za-z_0-9]+)\s+(-?\d+)\s*(?:\/\/.*)?$/gm))
    d[m[1]] = +m[2];
  return (DEFS[BOARD_OF[file]] = d);
}
// Blank out every line the preprocessor would drop, keeping the line count so
// nothing else about the parse shifts.
function preprocess(src, defs) {
  const lines = src.split("\n");
  const stack = [];              // {taken, active, unknown}
  const live = () => stack.every(f => f.active);
  const unknownHere = () => stack.some(f => f.unknown);
  const evalIf = (expr) => {
    let e = expr.replace(/\/\/.*$/, "").replace(/defined\s*\(\s*([A-Za-z_0-9]+)\s*\)/g,
                                                (_, n) => (n in defs ? "1" : "0"));
    let unknown = false;
    e = e.replace(/[A-Za-z_][A-Za-z_0-9]*/g, (n) => {
      if (n in defs) return String(defs[n]);
      unknown = true; return "0";
    });
    if (unknown) return { unknown: true, value: true };
    try { return { unknown: false, value: !!eval(e) }; } catch { return { unknown: true, value: true }; }
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m;
    if ((m = t.match(/^#if(?:ndef|def)?\s+(.+)$/)) || (m = t.match(/^#if\s*(.+)$/))) {
      const neg = /^#ifndef\b/.test(t);
      let r;
      if (/^#ifn?def\b/.test(t)) r = { unknown: false, value: (m[1].trim() in defs) !== neg };
      else r = evalIf(m[1]);
      stack.push({ taken: r.value, active: r.value, unknown: r.unknown });
    } else if (/^#el(se|if)\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (f) {
        if (/^#elif\b/.test(t)) {
          const r = evalIf(t.replace(/^#elif\s*/, ""));
          f.active = !f.taken && r.value;
          f.unknown = f.unknown || r.unknown;
        } else f.active = !f.taken;
        f.taken = f.taken || f.active;
      }
    } else if (/^#endif\b/.test(t)) {
      stack.pop();
    } else if (!live()) {
      lines[i] = "";
    } else if (unknownHere() && /^const int\b/.test(t)) {
      throw new Error(`consts(): "${t}" sits inside a #if this parser cannot evaluate - ` +
                      `teach it the flag rather than letting it guess which arm the compiler takes`);
    }
  }
  return lines.join("\n");
}

// `const int` declarations, parsed out of the real source so a header that drifts
// from the checker fails instead of being silently ignored. `seed` lets a second
// file be parsed against constants an earlier one defined - which is how the
// board headers' inputs reach the derived offsets in deckhand_display.ino.
export function consts(file, seed = {}) {
  if (BOARD_OF[file]) curBoard = BOARD_OF[file];
  const defs = defsFor(file);
  const src = preprocess(read(file), defs);
  // The #defines join the SUBSTITUTION SCOPE, not just the #if evaluator. A
  // `const int` derived from one (WAIT_NAME_Y from LOGO_SIZE) would otherwise
  // eval to NaN, and NaN propagates into every assertion downstream as a
  // NaN-vs-number comparison - which fails, so it looks like a layout bug rather
  // than the parse gap it is. Seed wins over a define on a name collision,
  // because a caller passing an explicit value means it.
  const out = { ...defs, ...seed };
  for (const m of src.matchAll(/^const int ([A-Za-z_0-9 ,=\-+*\/()]+);/gm)) {
    for (const part of m[1].split(",")) {
      const kv = part.split("=");
      if (kv.length !== 2) continue;
      const k = kv[0].trim();
      let v = kv[1].trim();
      for (const [kk, vv] of Object.entries(out)) v = v.replace(new RegExp(`\\b${kk}\\b`, "g"), vv);
      let val;
      try { val = evalInt(v); } catch { continue; }
      out[k] = val;
      if (SEEN) SEEN.add(`${curBoard}:${k}`);
      if (INJECT && INJECT.name === k && INJECT.board === curBoard) {
        out[k] += INJECT.delta;
        injectHits++;
      }
    }
  }
  return out;
}

// A fixed-size char cache's declared length, from the source. A cache shorter
// than the padded string it holds silently stops noticing changes past that
// point - this codebase's oldest bug - so the checkers compare these against
// re-derived worst cases rather than trusting the comment beside them.
export function cacheSizes(file) {
  const src = read(file);
  const out = {};
  // THE WHOLE DECLARATION, not just its first declarator. This used to anchor on
  // ^char and take one name, so every cache after a comma - `char a[12] = "",
  // b[12] = "";`, which is how most of them are written in this sketch - came back
  // UNDEFINED. An assertion on one then compares NaN and FAILS, which is at least
  // loud; the trap is a checker that never asserts on it at all and reads as
  // covering a cache it cannot see. Found by adding the LINK card's four caches in
  // two comma pairs and having exactly the second of each pair come back missing.
  for (const m of src.matchAll(/^char\s+([^;]*);/gm)) {
    for (const decl of m[1].split(",")) {
      const d = decl.match(/^\s*([A-Za-z_0-9]+)((?:\[[A-Za-z_0-9]+\])+)/);
      if (!d) continue;
      const dims = [...d[2].matchAll(/\[([A-Za-z_0-9]+)\]/g)].map(x => x[1]);
      out[d[1]] = dims[dims.length - 1];
    }
  }
  return out;
}

export const PANEL = { 1: [240, 320], 2: [320, 480] };

// ============================================================================
// PER-BOARD TEXT MEASUREMENT
// ============================================================================
// textWidth()/lineH() above know ONE type scale - Cozette plus Terminus, i.e.
// board 1's - because that was every board's scale when they were written. It is
// not any more: board 2 draws a native Spleen scale (8x16 body, 12x24 head, 32x64
// hero), so anything measured through them for board 2 describes a layout the
// panel does not render. That is the same defect class as a counted character
// lane, and this branch has already shipped three of those.
//
// This is that machinery's HOME, deliberately: sessions-geom-check.mjs grew its
// own copy first and settings-geom-check.mjs would have been the third, at which
// point the copies drift and a checker blesses a layout the panel draws
// differently - the exact failure the checkers exist to prevent. The mapping comes
// from UI_FONTS[] in deckhand_display.ino rather than a literal table, so a font
// swap fails a checker instead of drifting past it.
function parseGfxFontFile(file) {
  const src = read(file);
  const gl = src.slice(src.indexOf("Glyphs[]"));
  const rows = [...gl.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)];
  return rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5], yo: +m[6] }));
}
// UI_FONTS[] both arms: index -> { face, size, cellH }. A shape this does not
// recognise THROWS - a parser that silently falls back to a default is worse than
// the literal it replaced.
function parseUiFonts() {
  const src = read("deckhand_display.ino");
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
export const UI = parseUiFonts();
const GLYPHS = {};
function glyphsFor(face) {
  if (!GLYPHS[face]) GLYPHS[face] = parseGfxFontFile(`${face}.h`);
  return GLYPHS[face];
}
// The board's own cell height for a font id - what uiLineH() returns on it.
export function lineHB(b, id) { return UI[b][id].cellH; }
// Full string width, the panel's own rule: every character but the LAST is charged
// xAdvance, the last xOffset + width. Board 1 goes through textWidth() above, which
// preflight() checks against 136 widths recorded from the real device.
export function widthB(b, id, s) {
  if (b === 1) return textWidth(s, id);
  const { face, size } = UI[b][id];
  const g = glyphsFor(face);
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const q = g[s.charCodeAt(i) - 0x20];
    if (!q) continue;
    if (i === s.length - 1) w += (q.xo + q.w) * size;
    else w += q.xa * size;
  }
  return w;
}
// One glyph's advance. Board 2's faces are genuinely monospace, which is ASSERTED
// rather than assumed: a regenerated font that broke it must fail loudly.
export function advanceB(b, id) {
  const { face, size } = UI[b][id];
  if (b === 1) return textWidth("AA", id) - textWidth("A", id);  // cancels the last-char rule
  const g = glyphsFor(face);
  for (const q of g)
    if (q.xo !== 0 || q.w !== q.xa)
      throw new Error(`advanceB(): ${face} is no longer monospace - this needs the real last-char rule`);
  return g[0].xa * size;
}
// A face's ASCENT (ink rows above the baseline), read from the glyph table - the
// same source the shim's own _glyphAb is computed from.
export function ascentB(b, id) {
  const g = b === 1 ? glyphsFor(UI[1][id].face) : glyphsFor(UI[b][id].face);
  let a = 0;
  for (const q of g) a = Math.max(a, -q.yo);
  return a * UI[b][id].size;
}
// THE BOX drawString ACTUALLY PAINTS, which is not the same rectangle as the cell
// and is the whole reason this helper exists. drawString paints ONE OPAQUE BOX
// ascent+descent tall before any glyph, and MC_DATUM centres on the ASCENT ONLY
// (panel_text.cpp:277-327, and TFT_eSPI upstream does the same) - so the box lands
// at [y - floor(ascent/2), that + cellH - 1], biased LOW by half the descent. On
// board 2 that is 2px at T_BODY and 3px at T_HEAD, which is what destroyed the
// status pill; board 1 has the same bias but its 13px box in an 18px pill absorbs
// it. Returned as [top, bottom] inclusive.
export function mcBox(b, id, y) {
  const top = y - Math.floor(ascentB(b, id) / 2);
  return [top, top + lineHB(b, id) - 1];
}
// TL_DATUM/TR_DATUM: the box origin IS y.
export function tlBox(b, id, y) { return [y, y + lineHB(b, id) - 1]; }
// drawIfChanged's own ERASE rect, which is a DIFFERENT rectangle again: it clears
// fillRect(fx-1, fy-1, tw+2, th+2) where th is the cell and fy is y (top datums) or
// y - th/2 (the M datums) - i.e. it uses the CELL for centring where drawString
// uses the ascent, so the two disagree by exactly the bias above. A field's real
// painted extent is the UNION, and that is what has to be disjoint from its
// neighbours.
export function ifBox(b, id, y, datum = "T") {
  const th = lineHB(b, id);
  const fy = datum === "M" ? y - Math.floor(th / 2) : y;
  return [fy - 1, fy - 1 + th + 1];
}
// The union of the two: what a drawIfChanged field really paints.
export function fieldBox(b, id, y, datum = "T") {
  const e = ifBox(b, id, y, datum);
  const d = datum === "M" ? mcBox(b, id, y) : tlBox(b, id, y);
  return [Math.min(e[0], d[0]), Math.max(e[1], d[1])];
}
// wrapLineLen()/countWrappedLines() from deckhand_display.ino, measured per board.
// The 60-character ceiling and the "break no further back than half the line" rule
// are both real: the first caps every lane on the device, the second is why word
// wrap's worst case can leave a line barely half full.
export function wrapLineLenB(b, text, pos, maxW, id) {
  const len = text.length - pos;
  let n = 0;
  while (n < len && n < 60) {
    if (text[pos + n] === "\n") return n;
    if (widthB(b, id, text.slice(pos, pos + n + 1)) > maxW) break;
    n++;
  }
  if (n >= len) return n;
  if (n === 0) return 1;
  for (let k = n; k > Math.floor(n / 2); k--) if (text[pos + k - 1] === " ") return k;
  return n;
}
export function countWrappedLinesB(b, text, id, maxW) {
  let pos = 0, lines = 0;
  while (pos < text.length && lines < 80) {
    pos += wrapLineLenB(b, text, pos, maxW, id);
    if (pos < text.length && text[pos] === "\n") pos++;
    lines++;
  }
  return lines;
}
