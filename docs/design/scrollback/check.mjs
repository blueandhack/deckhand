// Binds the mock to board_es3c35p.h. A committed design artifact whose numbers can
// drift while it still reports "all passed" is the same class of defect as an
// assertion that cannot fail, and it is a class this repo has paid for three times.
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";
import fs from "node:fs";

// consts() is keyed by BASENAME (BOARD_OF[file] picks the board), so it takes a
// name and not a path - it resolves against geom-common's own DIR itself.
const c = consts("board_es3c35p.h");
const page = fs.readFileSync(new URL("./scrollback.html", import.meta.url), "utf8");

// The mock's own geometry block, parsed out of its JS rather than transcribed.
//
// DEVIATION FROM THE TASK BRIEF, RECORDED HERE RATHER THAN LEFT SILENT: the
// brief's own regex (`^var NAME = value`, one match per line) reads only the
// FIRST identifier on each line, and scrollback.html declares its geometry as
// comma-joined statements - `var W=320, H=480, ADV=8, LH=16;` - so that regex
// captures W and misses H, ADV and LH, and likewise for every other line below.
// Verified: run verbatim against the committed mock, 21 of 22 bindings FAIL
// before any injection, all with "the mock still declares X" rather than a
// real geometry disagreement - the failure the checker exists to report never
// gets a chance to be judged. This walks every `var` line's comma-joined
// literal assignments instead of only the first.
const g = {};
for (const line of page.split("\n")) {
  if (!line.startsWith("var ")) continue;
  for (const m of line.matchAll(/([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+)\b/g)) g[m[1]] = +m[2];
}
// VIS and LIST_H are the two the mock COMPUTES rather than states
// (`var VIS=Math.floor(LIST_H/LH);`), so no literal-only parse can see them -
// derived here from the mock's own formula and its own already-parsed
// literals, not invented. LIST_H is not otherwise bound or asserted below.
if (g.LIST_BOT !== undefined && g.LIST_TOP !== undefined) g.LIST_H = g.LIST_BOT - g.LIST_TOP;
if (g.LIST_H !== undefined && g.LH !== undefined) g.VIS = Math.floor(g.LIST_H / g.LH);

let total = 0, fail = 0;
const chk = (cond, msg) => { total++; console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`); if (!cond) fail++; };

// Shared with the header and therefore BOUND. Keys are the mock's names; values
// are the header's, so a rename on either side fails rather than passing silently.
const BOUND = {
  W: "BOARD_W", H: "BOARD_H", ADV: "TEXT_ADV", LH: "CODE_LINE_H",
  GUT_X: "SCROLL_GUT_X", TXT_X: "SCROLL_TXT_X", COLS: "SCROLL_COLS",
  SB_W: "SCROLL_RAIL_W", CHIP_W: "HIST_CHIP_W_CHAT", CHIP_Y: "HIST_CHIP_Y",
  CHIP_H: "HIST_CHIP_H", BACK_X: "SCROLL_BACK_X", BACK_W: "SCROLL_BACK_W",
  NAME_X: "SCROLL_NAME_X", RULE_Y: "HIST_RULE_Y", HDR_H: "HIST_RULE_Y",
};
for (const [mockName, hdrName] of Object.entries(BOUND)) {
  chk(g[mockName] !== undefined, `the mock still declares ${mockName}`);
  chk(c[hdrName] !== undefined, `the header still declares ${hdrName}`);
  chk(g[mockName] === c[hdrName],
    `${mockName} (${g[mockName]}) == ${hdrName} (${c[hdrName]})`);
}

// DELIBERATELY UNBOUND, each with its reason. The rule that keeps this honest:
// an entry here must actually DIFFER from what ships, so a live constant cannot be
// parked here to escape the bind.
const WAS = {
  LIST_BOT: [472, "SCROLL_BOT", "the mock left a 12px bottom margin; the spec tightens it to 4"],
  VIS: [25, "SCROLL_LINES", "and so renders one line fewer"],
};
for (const [k, [want, hdrName, why]] of Object.entries(WAS)) {
  chk(g[k] === want, `the mock's ${k} is still ${want} (${why})`);
  chk(g[k] !== c[hdrName], `${k} genuinely differs from ${hdrName} - not a bind in disguise`);
}

console.log(`\n${total} bindings, ${fail} failures`);
if (fail) process.exit(1);
console.log("the scrollback mock agrees with board_es3c35p.h");
