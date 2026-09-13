// Binds this mock to board_es3c35p.h, the way docs/design/scrollback/check.mjs already
// binds its predecessor. A committed design artifact whose numbers can drift while it
// still reports "all passed" is the same class of defect as an assertion that cannot
// fail - the class CLAUDE.md names against a transcribed constant, and this repo has
// paid for it before.
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";
import fs from "node:fs";

// consts() is keyed by BASENAME (BOARD_OF[file] picks the board), so it takes a name
// and not a path - it resolves against geom-common's own DIR itself.
const c = consts("board_es3c35p.h");
const page = fs.readFileSync(new URL("./markup.html", import.meta.url), "utf8");

// Walk every `var` line's comma-joined literal assignments, not just the first
// identifier on the line - docs/design/scrollback/check.mjs records why the naive
// `^var NAME = value` regex silently loses every name after the first on a line
// like `var W=320, H=480, ADV=8, LH=16;`. This mock's geometry block is written the
// same way on purpose, so the same walk is used here rather than re-deriving it.
const g = {};
for (const line of page.split("\n")) {
  if (!line.startsWith("var ")) continue;
  for (const m of line.matchAll(/([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+)\b/g)) g[m[1]] = +m[2];
}

let total = 0, fail = 0;
const chk = (cond, msg) => { total++; console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`); if (!cond) fail++; };

// Shared with the header and therefore BOUND. Keys are the mock's names; values are
// the header's, so a rename on either side fails rather than passing silently.
const BOUND = {
  W: "BOARD_W", H: "BOARD_H", ADV: "TEXT_ADV", LH: "CODE_LINE_H",
  GUT_X: "SCROLL_GUT_X", TXT_X: "SCROLL_TXT_X", COLS: "SCROLL_COLS",
  SB_W: "SCROLL_RAIL_W",
  HDR_H: "SCROLL_HDR_H", TOP: "SCROLL_TOP", LINES: "SCROLL_LINES",
  BOT: "SCROLL_BOT", BOT_AIR: "SCROLL_BOT_AIR",
  // The three constants THIS task's design introduced. geom-sweep.mjs reports all
  // three "unguarded, read by no checker" (its CHECKERS map has never included
  // scrollback-check.mjs) - this bind is not a substitute for that sweep, but it is
  // real: it fails BY NAME the moment either of these moves without the mock moving
  // with it.
  EDGE_X: "SCROLL_CODE_EDGE_X", EDGE_W: "SCROLL_CODE_EDGE_W", HANG_MAX: "SCROLL_HANG_MAX",
  BACK_X: "SCROLL_BACK_X", BACK_W: "SCROLL_BACK_W", NAME_X: "SCROLL_NAME_X",
  CHIP_W: "HIST_CHIP_W_CHAT", CHIP_Y: "HIST_CHIP_Y", CHIP_H: "HIST_CHIP_H",
};
for (const [mockName, hdrName] of Object.entries(BOUND)) {
  chk(g[mockName] !== undefined, `the mock still declares ${mockName}`);
  chk(c[hdrName] !== undefined, `the header still declares ${hdrName}`);
  chk(g[mockName] === c[hdrName],
    `${mockName} (${g[mockName]}) == ${hdrName} (${c[hdrName]})`);
}

// The two closing identities scrollback.md already asserts of the real firmware,
// re-checked here against the MOCK's own declared numbers so a hand-edit to the
// mock that breaks either one is caught before it is mistaken for a picture of
// what ships. Parsed, not transcribed: derived from the already-bound values above.
chk(g.TXT_X === g.GUT_X + 2 * g.ADV, "TXT_X == GUT_X + 2*ADV, the mock's own gutter arithmetic");
chk(g.BOT === g.TOP + g.LINES * g.LH, "BOT == TOP + LINES*LH, the mock's own vertical closing identity");
chk(g.NAME_X === g.BACK_X + g.BACK_W + 8, "NAME_X == BACK_X + BACK_W + 8, the mock's own header arithmetic");

console.log(`\n${total} bindings, ${fail} failures`);
if (fail) process.exit(1);
console.log("the scrollback-markup mock agrees with board_es3c35p.h");
