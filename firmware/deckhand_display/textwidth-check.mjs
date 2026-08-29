#!/usr/bin/env node
// THE textWidth EQUIVALENCE GATE, closed against REAL HARDWARE OUTPUT.
//
// WHAT THIS REPLACES, AND WHY. text_probe.h documented the gate as a diff of
// TEXTPROBE output between the two boards. That stopped working when the type
// scale landed: UI_FONTS[] is per board now, so board 1 draws Cozette/Terminus
// and board 2 draws Spleen, and differing widths are the CORRECT answer. Worse,
// every Spleen glyph has xOffset == 0 and width == xAdvance == 8, so the LAST-
// CHARACTER RULE - the whole thing the gate exists to catch - is a no-op there
// and board 2's half discriminates nothing.
//
// So the comparison moved. The question was never "do the two boards measure the
// same string the same" (they cannot, they draw different faces). It is: DOES
// PanelShim's textWidth IMPLEMENT TFT_eSPI's ALGORITHM. That is font-independent,
// and it is answerable with board 1 alone: run TEXTPROBE on board 1, which IS
// real TFT_eSPI, and check the shim's arithmetic reproduces it on the same font.
//
// This is STRONGER than the diff it replaces. The old note said the residual risk
// its offline derivation could not cover was "that TFT_eSPI's runtime behaviour
// differs from its source on this board". The reference here IS the runtime
// behaviour, captured off the device, so that risk is gone for these 136 entries.
//
// Regenerate the reference (board 1 attached, current firmware):
//   ./flash.sh                                   # TEXTPROBE landed 2026-08-22
//   MARK=$(wc -l < /tmp/deckhand-$(id -u)/host.log)
//   echo "TEXTPROBE" > ~/.claude/deckhand-device-command
//   sleep 25                                     # 136 entries over TWO transports
//   tail -n +$((MARK+1)) /tmp/deckhand-$(id -u)/host.log \
//     | grep -a "^\[device/usb\] WIDTH" | sed 's/.*WIDTH/WIDTH/' | sort -u \
//     > firmware/deckhand_display/text-widths-board1.txt
import fs from "fs";
import path from "path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => fs.readFileSync(`${DIR}/${f}`, "utf8");

// ---------- parse the glyph tables, never transcribe them ----------
function parseFont(file, sym) {
  const s = read(file);
  const gl = s.match(new RegExp(sym + "Glyphs\\[\\]\\s*PROGMEM\\s*=\\s*\\{([\\s\\S]*?)\\};"));
  if (!gl) throw new Error(`${sym}: glyph table not found in ${file}`);
  const glyphs = [...gl[1].matchAll(/\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+)\s*\}/g)]
    .map((m) => ({ w: +m[2], adv: +m[4], xo: +m[5] }));
  const hd = s.match(new RegExp(sym + "\\s*PROGMEM\\s*=\\s*\\{[^}]*?(0x[0-9A-Fa-f]+),\\s*(0x[0-9A-Fa-f]+),\\s*(\\d+)\\s*\\}"));
  if (!hd) throw new Error(`${sym}: font header (first/last/yAdvance) not found`);
  return { glyphs, first: parseInt(hd[1], 16), last: parseInt(hd[2], 16) };
}
const COZ = parseFont("Cozette6x13.h", "Cozette6x13");
const TER = parseFont("Terminus10x18b.h", "Terminus10x18b");

// Board 1's UI_FONTS[], parsed out of the sketch rather than assumed, so a
// registry edit cannot leave this checker measuring the wrong face.
function parseBoard1Registry() {
  const s = read("deckhand_display.ino");
  const at = s.indexOf("static const UiFont UI_FONTS[]");
  const body = s.slice(at, s.indexOf("};", at));
  const rows = [...body.matchAll(/\{\s*&(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)]
    .map((m) => ({ face: m[1], size: +m[2] }));
  if (rows.length < 5) throw new Error(`UI_FONTS parsed ${rows.length} rows, expected 5`);
  const faces = { Cozette6x13: COZ, Terminus10x18b: TER };
  const reg = {};
  rows.forEach((r, i) => { if (faces[r.face]) reg[i] = { font: faces[r.face], size: r.size }; });
  return reg;
}
const REG = parseBoard1Registry();

// ---------- the shim's algorithm ----------
// Transcribed from PanelShim::textWidth (panel_text.cpp). A transcription is a
// drift risk, so the shape of the real loop is ASSERTED below rather than trusted.
function shimTextWidth(str, font, size, mutate) {
  let w = 0, n = 0;
  const L = str.length;
  while (n < L) {
    const c = str.charCodeAt(n); n++;
    if (c >= font.first && c <= font.last) {
      const g = font.glyphs[c - font.first];
      if (mutate === "no-last-rule")      w += g.adv;
      else if (mutate === "last-always")  w += g.xo + g.w;
      else if (mutate === "off-by-one")   w += (n < L - 1) ? g.adv : g.xo + g.w;
      else                                w += (n < L) ? g.adv : g.xo + g.w;
    }
  }
  return w * size;
}

// ---------- run ----------
const ref = read("text-widths-board1.txt").split("\n").filter(Boolean).map((line) => {
  const m = line.match(/^WIDTH (\d+) (\d+) (\d+) "(.*)"$/);
  if (!m) throw new Error(`unparseable reference line: ${line}`);
  return { font: +m[1], size: +m[2], width: +m[3], str: m[4] };
});

function run(mutate) {
  let bad = 0; const first = [];
  for (const r of ref) {
    const e = REG[r.font];
    if (!e) continue;
    const got = shimTextWidth(r.str, e.font, r.size, mutate);
    if (got !== r.width) { bad++; if (first.length < 4) first.push(`font${r.font} "${r.str}" device=${r.width} shim=${got}`); }
  }
  return { bad, first };
}

const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };

// 1. The gate itself.
const live = run(null);
ok(`PanelShim's textWidth reproduces REAL TFT_eSPI on all ${ref.length} entries`
   + (live.bad ? ` — ${live.bad} disagree: ${live.first.join("; ")}` : ""), live.bad === 0);

// 2. The source still has the shape this file transcribes. A text match cannot see
//    the preprocessor, but none of these lines sits behind an #if.
const pt = read("panel_text.cpp");
ok("panel_text.cpp still charges the LAST character xOffset + width",
   /if\s*\(n\s*<\s*len\)\s*str_width\s*\+=\s*g->xAdvance;/.test(pt)
   && /else\s*str_width\s*\+=\s*\(int32_t\)\s*g->xOffset\s*\+\s*g->width;/.test(pt));
ok("panel_text.cpp still scales the total by textsize",
   /return\s*\(int\)\s*\(str_width\s*\*\s*textsize\);/.test(pt));
ok("panel_text.cpp still range-checks against the font's first/last",
   /uniCode\s*>=\s*first\s*&&\s*uniCode\s*<=\s*last/.test(pt));

// 3. THE KNOWN BLIND SPOT, asserted so it cannot be forgotten. Reported, not
//    silently tolerated: no probe string carries a divergent glyph in the
//    PENULTIMATE position, so a shim charging the rule to the last TWO characters
//    passes every entry. See the note printed below.
const divergent = new Set();
for (let i = 0; i < COZ.glyphs.length; i++) {
  const g = COZ.glyphs[i];
  if (g.xo + g.w !== g.adv) divergent.add(String.fromCharCode(COZ.first + i));
}
const pen = ref.filter((r) => r.str.length >= 2 && divergent.has(r.str[r.str.length - 2]));

// ---------- selftest ----------
if (process.argv.includes("--selftest")) {
  const cases = [["no-last-rule", true], ["last-always", true], ["off-by-one", false]];
  let bad = 0;
  console.log("");
  for (const [m, shouldCatch] of cases) {
    const r = run(m);
    const caught = r.bad > 0;
    const verdict = caught === shouldCatch ? "as expected" : "UNEXPECTED";
    if (caught !== shouldCatch) bad++;
    console.log(`  ${m.padEnd(14)} ${String(r.bad).padStart(3)}/${ref.length} caught — ${verdict}`);
  }
  console.log(`\n  off-by-one is EXPECTED to escape: no probe string has a divergent glyph`);
  console.log(`  in the penultimate position, so the table cannot tell "the rule fires on`);
  console.log(`  the last character" from "on the last two". That is a gap in text_probe.h's`);
  console.log(`  table, not in the shim. Adding e.g. "4x" or "q1" would close it — at the`);
  console.log(`  cost of moving board 1's binary and needing both boards to re-capture.`);
  if (bad) { console.error(`\n  ${bad} selftest case(s) behaved unexpectedly`); process.exit(1); }
  console.log(`\n  selftest ok — the two real mutations are caught, the known gap is documented`);
  process.exit(0);
}

if (fails.length) {
  console.error("");
  for (const f of fails) console.error("  FAIL " + f);
  console.error(`\n${fails.length} of ${3 + 1} assertions FAILED`);
  process.exit(1);
}
console.log(`textWidth gate: PanelShim's algorithm matches REAL TFT_eSPI on all ${ref.length} board-1 entries`);
console.log(`  reference is runtime output, not a source derivation — 3 source-shape assertions also pass`);
console.log(`  KNOWN GAP: ${pen.length} probe strings carry a divergent glyph penultimate, so an`);
console.log(`  off-by-one in the last-character rule would NOT be caught (see --selftest)`);
