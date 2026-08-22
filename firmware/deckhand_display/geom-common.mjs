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

function parseFont(file, name) {
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
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
  for (const line of fs.readFileSync(`${DIR}/text-widths-board2.txt`, "utf8").split("\n")) {
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

// `const int` declarations, parsed out of the real source so a header that drifts
// from the checker fails instead of being silently ignored. `seed` lets a second
// file be parsed against constants an earlier one defined - which is how the
// board headers' inputs reach the derived offsets in deckhand_display.ino.
export function consts(file, seed = {}) {
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
  const out = { ...seed };
  for (const m of src.matchAll(/^const int ([A-Za-z_0-9 ,=\-+*\/()]+);/gm)) {
    for (const part of m[1].split(",")) {
      const kv = part.split("=");
      if (kv.length !== 2) continue;
      const k = kv[0].trim();
      let v = kv[1].trim();
      for (const [kk, vv] of Object.entries(out)) v = v.replace(new RegExp(`\\b${kk}\\b`, "g"), vv);
      try { out[k] = eval(v); } catch { }
    }
  }
  return out;
}

// A fixed-size char cache's declared length, from the source. A cache shorter
// than the padded string it holds silently stops noticing changes past that
// point - this codebase's oldest bug - so the checkers compare these against
// re-derived worst cases rather than trusting the comment beside them.
export function cacheSizes(file) {
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
  const out = {};
  for (const m of src.matchAll(/^char ([A-Za-z_0-9]+)((?:\[[A-Za-z_0-9]+\])+)/gm)) {
    const dims = [...m[2].matchAll(/\[([A-Za-z_0-9]+)\]/g)].map(d => d[1]);
    out[m[1]] = dims[dims.length - 1];
  }
  return out;
}

export const PANEL = { 1: [240, 320], 2: [320, 480] };
