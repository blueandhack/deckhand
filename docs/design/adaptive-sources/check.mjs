#!/usr/bin/env node
// Binds this mock's solo geometry to board_es3c35p.h. A committed mock whose
// numbers can drift while it still reports "passed" is the same class as an
// assertion that cannot fail - and this repo has paid for it three times.
//
// Diverges from the brief's own template script in two ways, both deliberate:
//
// 1. There is no `CONTENT_ROWS` constant anywhere in board_es3c35p.h - it is a
//    derivation the mock names for its own convenience, the same way
//    usage-geom-check.mjs derives its local `content` rather than reading a
//    constant that does not exist. `c.CONTENT_ROWS` off consts() is `undefined`,
//    so the brief's literal `... === c.CONTENT_ROWS` is `414 === undefined`,
//    which is false FOREVER regardless of what adaptive.html says - a check that
//    cannot pass is exactly the "assertion that cannot fail" class in reverse,
//    and just as useless. Derived here as `(BOARD_H - FOOTER_H) - CONTENT_Y`,
//    parsed rather than transcribed, matching usage-geom-check.mjs:852.
//
// 2. The rejected "All to NOW" panel (SOLO_NOW) is this branch's WAS: kept as
//    the record of what was compared and passed over, per
//    docs/design/usage-redesign/usage.js's own precedent for layouts A and C.
//    docs/design/usage-redesign/check.mjs asserts every WAS entry differs from
//    what K (the bound object) actually says - a WAS value equal to the shipped
//    one records nothing and is how a live constant escapes the bind. SOLO_NOW
//    overrides three of the same key names SOLO_BOTH does (NOW_CARD_H,
//    NOW_SPARK_H, NOW_META_Y); this file asserts each of SOLO_NOW's three
//    actually differs from SOLO_BOTH's, the identical rule.
import fs from "node:fs";
import path from "node:path";
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";

const c = consts("deckhand_display.ino", consts("board_es3c35p.h"));
const src = fs.readFileSync(path.join(import.meta.dirname, "adaptive.html"), "utf8");

let pass = 0; const fails = [];
const ok = (cond, what) => cond ? pass++ : fails.push(what);

// ---- pull the two K-override object literals out by TEXT, each scoped to its
// own `const NAME = { ... };` block - not a bare whole-file regex. SOLO_NOW
// reuses three of SOLO_BOTH's key spellings (NOW_CARD_H, NOW_SPARK_H,
// NOW_META_Y), so a global search for "NOW_CARD_H\s*:\s*(\d+)" would find
// whichever block happens to come first in the file and could never tell the
// two apart for the differ-check below.
function block(varName) {
  const m = src.match(new RegExp(`const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  return m ? m[1] : null;
}
const soloBothSrc = block("SOLO_BOTH");
const soloNowSrc = block("SOLO_NOW");
ok(soloBothSrc !== null, "SOLO_BOTH: no `const SOLO_BOTH = { ... };` object found in adaptive.html");
ok(soloNowSrc !== null, "SOLO_NOW: no `const SOLO_NOW = { ... };` object found in adaptive.html");

function field(blockSrc, name) {
  if (!blockSrc) return null;
  const m = blockSrc.match(new RegExp(`${name}\\s*:\\s*(-?\\d+)`));
  return m ? +m[1] : null;
}

// every constant the mock names for the SHIPPED (grow-both) solo layout must
// equal the header's, matched inside SOLO_BOTH specifically - that is the
// object the "Grow both" panel patches K with.
const SOLO = ["NOW_CARD_H_SOLO", "NOW_SPARK_H_SOLO", "NOW_META_Y_SOLO", "WEEK_CARD_H_SOLO",
  "WEEK_NUM_Y_SOLO", "WEEK_BURN_Y_SOLO", "WEEK_BAR_Y_SOLO", "WEEK_META_Y_SOLO",
  "WEEK_FABLE_Y_SOLO", "WEEK_FABLE_BAR_Y_SOLO"];
for (const n of SOLO) {
  const bare = n.replace(/_SOLO$/, "");
  const v = field(soloBothSrc, bare);
  ok(v !== null && v === c[n], `${n}: mock says ${v === null ? "MISSING" : v}, header says ${c[n]}`);
}

// the solo column the mock draws sums to exactly the same content area the duo
// column fills - derived from BOARD_H/FOOTER_H/CONTENT_Y/SP_2, all parsed, none
// transcribed. (No `CONTENT_ROWS` constant exists in the header - see the
// header comment above.)
const contentBottom = c.BOARD_H - c.FOOTER_H;
const CONTENT_ROWS = contentBottom - c.CONTENT_Y;
ok(c.SP_2 + c.NOW_CARD_H_SOLO + c.SP_2 + c.WEEK_CARD_H_SOLO + c.SP_2 === CONTENT_ROWS,
  `the solo column the mock draws (${c.SP_2}+${c.NOW_CARD_H_SOLO}+${c.SP_2}+${c.WEEK_CARD_H_SOLO}+${c.SP_2}) `
  + `does not sum to the content area (${CONTENT_ROWS})`);

// the rejected "All to NOW" panel must actually DIFFER from what shipped - a
// value equal to SOLO_BOTH's records nothing and is how a live constant would
// escape the bind, the same rule docs/design/usage-redesign/check.mjs applies
// to its own WAS table.
for (const bare of ["NOW_CARD_H", "NOW_SPARK_H", "NOW_META_Y"]) {
  const now = field(soloNowSrc, bare), both = field(soloBothSrc, bare);
  ok(now !== null && both !== null && now !== both,
    `SOLO_NOW.${bare} is ${now === null ? "MISSING" : now}, the same as SOLO_BOTH.${bare} `
    + `(${both === null ? "MISSING" : both}) - it records nothing`);
}

for (const f of fails) console.log("FAIL  " + f);
console.log(fails.length ? `\n${fails.length} failed, ${pass} passed`
  : `ok  ${pass} bindings pass`);
process.exit(fails.length ? 1 : 0);
