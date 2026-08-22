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
const DEFS = {};                 // board number -> {NAME: number}
function defsFor(file) {
  if (!BOARD_OF[file]) return DEFS[curBoard] || {};
  const d = {};
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
  const src = preprocess(read(file), defsFor(file));
  const out = { ...seed };
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
  for (const m of src.matchAll(/^char ([A-Za-z_0-9]+)((?:\[[A-Za-z_0-9]+\])+)/gm)) {
    const dims = [...m[2].matchAll(/\[([A-Za-z_0-9]+)\]/g)].map(d => d[1]);
    out[m[1]] = dims[dims.length - 1];
  }
  return out;
}

export const PANEL = { 1: [240, 320], 2: [320, 480] };
