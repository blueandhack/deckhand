// ---------------------------------------------------------------------------
// Headless check of the COMPOSE SURFACE mock. It draws all fourteen pictures
// (two screens x two boards x their states) into op lists and asserts the four
// things every mock in this directory asserts - no string leaves the fonts'
// 0x20..0x7E, nothing lands off the panel, every tested band clears TAP_MIN,
// every drawn control sits strictly inside its band - plus the two this design
// turns on: that each of the FOUR vertical budgets closes exactly on BOARD_H,
// and that the three columns sum to the lane.
//
// AND, SINCE A COMMITTED MOCK IS THE NORMATIVE GEOMETRIC SPEC, that its K
// constants ARE the firmware's. A picture drawn from numbers nobody compares to
// the header is a spec that can go silently wrong while still reporting itself
// green - the same class of defect as an assertion that cannot fail.
//
// THIS IS THE FIRST CHECKER IN docs/design/ THAT BINDS TWO BOARDS. Every other
// one calls consts("board_es3c35p.h") once and describes board 2 alone. This
// design moves constants on BOTH panels, so K is per-board and H is
// { 1: board_e32r28t.h, 2: board_es3c35p.h } - which geom-common's own BOARD_OF
// table already makes possible, since it maps a header FILENAME to a board
// number. Every assertion below loops both.
//
// ===========================================================================
// THIS CHECKER IS EXPECTED TO FAIL TODAY, BY NAME, AND THAT IS THE DELIVERABLE.
// ===========================================================================
// Some of K's names are ahead of the headers: a later task of the compose plan
// adds or moves each one, and until it lands the bind below fails and PRINTS THE
// NAME. WHICH NAMES, AND HOW MANY, ARE NOT WRITTEN DOWN HERE - the PENDING table
// is the record and the closing summary counts and names them live from it, so
// there is no restated roster to go stale as tasks land (there was, twice, and
// it did). That is the binding working. There is deliberately no "not yet defined" escape
// hatch: an assertion that can be satisfied by the constant's absence is an
// assertion that cannot fail, which is the defect this whole family of files
// exists to prevent. The closing summary sorts the failures into "waiting on a
// later task" and "unexpected", and it is the UNEXPECTED count that has to be
// zero.
//
//   node docs/design/compose/check.mjs             -> fails by name (expected)
//   node docs/design/compose/check.mjs --selftest  -> exits 0 iff a fault is caught
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { consts, advanceB, lineHB, PANEL } from "../../../firmware/deckhand_display/geom-common.mjs";

const DIR = new URL("./", import.meta.url).pathname;

// The mock is a browser script; give it just enough of a DOM to load headlessly.
globalThis.document = { getElementById: () => null, querySelectorAll: () => [],
                        createElement: () => ({ appendChild(){}, style:{}, getContext: () => null }) };
globalThis.addEventListener = () => {};
new Function(fs.readFileSync(DIR + "compose.js", "utf8"))();
const X = globalThis.__X;
if (!X) { console.log("FATAL: compose.js did not publish globalThis.__X"); process.exit(1); }
const { SCREENS, K, D, ADV, CELL, BAD_CHARS, P, stack, colWidths, colX, colSpan,
        keyGap, ACT_GAP, EXCEPTIONS, ASK, PAGES, KB_ROW3, row3Label } = X;

const HEADER = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };

// ===========================================================================
// ACT_GAP, NOW BOUND. It was the one number on this screen nothing bound: the
// mock stated `const ACT_GAP = 8` and so did nothing else, because
// uiActionRow() did not exist. Task 3 added it with `const int gap = 8` inside
// its body, so the literal is PARSED out of that body here rather than
// transcribed - the same shape as settings-geom-check.mjs' extraction of the
// severity spine's uiFillRound() arguments out of drawSeverityAction(). A
// hardcoded 8 on both sides is a transcription: moving the firmware's gap to 6
// would leave every gap assertion in this file green while the row it describes
// had changed.
//
// BOUND TO THE FUNCTION BODY, not to the file: a grep over deckhand_display.ino
// would be satisfied by any neighbouring declaration that used the same name,
// now or later. The body is
// brace-matched from the definition, and the two parse gates below run BEFORE
// the comparison, because a parse that silently returned "" makes the regex
// below match nothing and the comparison meaningless.
// ===========================================================================
// fnBody: the text of ONE function, brace-matched from its definition. Used for
// every structural assertion in this file, because a grep over a whole file is
// satisfied by any neighbouring line that happens to spell the same thing.
// Returns "" when the definition is not found, and EVERY caller gates on
// `.length > 0` before testing anything, because !/re/.test("") is true.
function fnBody(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return "";
}

const FW_SRC = fs.readFileSync(DIR + "../../../firmware/deckhand_display/deckhand_display.ino", "utf8")
  .replace(/^[ \t]*\/\/.*$/gm, "");            // a commented-out gap is not a gap
const ACT_ROW_SRC = fnBody(FW_SRC, "int uiActionRow(");
const FW_ACT_GAP = (ACT_ROW_SRC.match(/const int gap\s*=\s*(\d+)/) || [])[1];

// The mock's OWN source, comments stripped, for the structural assertions that
// have to look at how a value is COMPUTED rather than at what it computes to.
const MOCK_SRC = fs.readFileSync(DIR + "compose.js", "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
const STACK_SRC = fnBody(MOCK_SRC, "function stack(");
// The two `push("action band", ...)` arms of stack(), one per screen, with the
// K name each takes its height from.
const ACT_H_TERMS = [...STACK_SRC.matchAll(/push\("action band",\s*k\.([A-Z_0-9]+)/g)].map(m => m[1]);

// compose.html is the browser shell, and check.mjs never loads it, so the ONE
// way it can rot is the seam between the two: the shell destructures a fixed set
// of names off globalThis.__X, and renaming any of them in compose.js leaves a
// blank page with a TypeError nobody here would see. Parsed, not transcribed.
const HTML_SRC = fs.readFileSync(DIR + "compose.html", "utf8");
const HTML_DESTRUCTURE = (HTML_SRC.match(/const\s*\{([^}]*)\}\s*=\s*globalThis\.__X\s*;/) || [])[1];
const HTML_NAMES = HTML_DESTRUCTURE
  ? HTML_DESTRUCTURE.split(",").map(s => s.trim().split(":")[0].trim()).filter(Boolean) : [];
const HTML_SCRIPT_SRC = (HTML_SRC.match(/<script src="([^"]+)"><\/script>/) || [])[1];

// A5. THE PICTURE COUNT, PARSED FROM THE PROSE THAT CLAIMS IT. A report once
// said this checker asserted "fourteen pictures"; it did not, and the number sat
// in two comments with nothing behind it - claimed in one place, checked in
// none, which is the worst of the three states. Both prose sites are now parsed
// and compared against SCREENS.length, so adding a state to the mock without
// saying so fails, and so does editing the prose without the mock.
const WORDS = { ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
                sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20 };
const README_SRC = fs.readFileSync(DIR + "README.md", "utf8");
// Only this file's HEADER BLOCK - everything above the first import - so a
// later message string that happens to say "pictures" cannot stand in for the
// header claim once someone deletes it. Scoping it is the difference between
// asserting the claim and asserting that SOMETHING says a number.
const CHECK_HEAD = fs.readFileSync(new URL(import.meta.url).pathname, "utf8").split("\nimport ")[0];
const claimedCount = (src) => {
  const m = src.match(/\b([A-Za-z]+|\d+) pictures\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? +m[1] : (WORDS[m[1].toLowerCase()] ?? null);
};

// ===========================================================================
// PENDING - the bind failures a later task is expected to fix, keyed on
// `board:name` and pinning BOTH VALUES: [ what this mock targets, what the
// header holds TODAY ] with null meaning "the header does not define the name
// at all". THE COUNT IS NOT WRITTEN HERE, and that is the fix for a defect this
// file kept re-committing: every restatement of "there are N" went stale the
// moment a task landed one, once per task for two tasks running. The closing
// summary computes it from this table - waiting, unexpected, and the names in
// each - so the table below is the only place the roster exists.
//
// IT USED TO BE TWO LISTS OF BARE NAMES, and that was an excuse that could not
// fail. Matching on the NAME alone excused any value: setting K[1].KB_ROW_H
// 41 -> 40 with a compensating gap in D produced BYTE-IDENTICAL output, headline
// `0 UNEXPECTED` included, and - worse - a later task landing KB_ROW_H = 42 in
// the header would have read exactly like that task not having run. The whole
// point of the bind is to tell those two apart, so the excuse has to name the
// VALUE it excuses, on both sides:
//
//   - the mock's target moved  -> the excuse no longer applies, and a [pending]
//                                 assertion says which half diverged
//   - the header landed a WRONG value -> likewise, and it says so in those words
//   - the header landed the RIGHT value -> the bind failure disappears and the
//                                 entry here is stale, which also FAILS: a
//                                 standing excuse for a passing constant is how
//                                 a real drift gets waved through later. The fix
//                                 is one deleted line, in the diff of the task
//                                 that landed it.
//
// Yes, the first column duplicates K. That is deliberate and is the same shape
// as WAS in settings-redesign/check.mjs: a second independent record is what
// makes the excuse exact, where a derivation from K would excuse whatever K
// happens to say.
// ===========================================================================
const PENDING = {
  "1:COMPOSE_PROMPT_H": [52,  null],
  "1:COMPOSE_LEGEND_H": [16,  null],
  "1:COMPOSE_DRAFT_H":  [21,  null],
  "1:COMPOSE_GAP":      [4,   null],
  "2:COMPOSE_PROMPT_H": [77,  null],
  "2:COMPOSE_LEGEND_H": [19,  null],
  "2:COMPOSE_DRAFT_H":  [24,  null],
  "2:COMPOSE_GAP":      [8,   null],
};

// ---- the assertion machinery ----------------------------------------------
// Messages carry a GROUP TAG so --selftest can say which assertion caught the
// injected fault rather than merely that something did.
// `id` is a STABLE KEY for one assertion, and --selftest gates on it rather than
// on the group TAG. The tag was not enough: four assertions share [budget], so
// replacing `chk(S.total === k.BOARD_H)` with `chk(true)` left the anchor
// assertions firing, the tag still present, and the selftest still printing "the
// column no longer closes on BOARD_H" while being blind to the very assertion it
// named. Group-level teeth behind an assertion-level claim.
let n = 0, msgs = [], failIds = [], quiet = false;
function chk(cond, group, m, id) {
  n++;
  if (!cond) {
    msgs.push(`[${group}] ${m}`);
    if (id) failIds.push(id);
    if (!quiet) console.log(`  FAIL [${group}] ${m}`);
  }
}
const say = (s) => { if (!quiet) console.log(s); };

// The bind failures, kept apart from the assertion log so the closing summary
// can name what is still waiting on a later task without excusing anything.
let pendingMissing = [], pendingStale = [];

// ===========================================================================
function run() {
  n = 0; msgs = []; failIds = []; pendingMissing = []; pendingStale = [];
  const exceptionsSeen = new Set(), live = new Set(), excused = new Set();

  // ---- 0. the parse gate ---------------------------------------------------
  // ASSERT THE PARSE SUCCEEDED BEFORE ANYTHING NEGATIVE RUNS. !/re/.test("") is
  // true and `undefined in {}` is false, so a checker whose parse silently
  // returned nothing reports every name as missing and every negative claim as
  // satisfied - a full page of confident nonsense. This gate is what makes the
  // failures below mean what they say.
  const H = {}, KBF = {};
  for (const b of [1, 2]) {
    // Header first, then the .ino seeded with it: the order the compiler sees,
    // and the order geom-common's injection seam requires (the last header
    // parsed is what identifies the board).
    H[b] = consts(HEADER[b]);
    KBF[b] = consts("keyboard.ino", H[b]);
    chk(Object.keys(H[b]).length > 100, "parse",
        `${HEADER[b]} parsed only ${Object.keys(H[b]).length} constants - the parse failed, `
      + `so nothing below can be trusted`);
    chk(H[b].BOARD_W === PANEL[b][0] && H[b].BOARD_H === PANEL[b][1], "parse",
        `${HEADER[b]} gave BOARD_W/BOARD_H ${H[b].BOARD_W}x${H[b].BOARD_H}, `
      + `geom-common's PANEL table says ${PANEL[b][0]}x${PANEL[b][1]}`);
    chk(Number.isFinite(KBF[b].KB_MAX_BYTES), "parse",
        `keyboard.ino's KB_MAX_BYTES did not parse for board ${b} (got ${KBF[b].KB_MAX_BYTES})`);
  }
  // The gap's parse gates, ahead of the comparison that depends on them.
  chk(ACT_ROW_SRC.length > 0, "parse",
      `uiActionRow()'s body was not found in deckhand_display.ino - if the function was renamed `
    + `or moved, move this parse with it rather than leaving the gap assertion looking at nothing`);
  chk(FW_ACT_GAP !== undefined, "parse",
      `uiActionRow()'s OWN BODY no longer declares "const int gap = <n>" - the mock's ACT_GAP `
    + `has nothing to bind to, so every gap assertion below would be measuring itself`);
  chk(+FW_ACT_GAP === ACT_GAP, "act",
      `the mock's ACT_GAP is ${ACT_GAP}, uiActionRow()'s own body says ${FW_ACT_GAP} - the row `
    + `the mock draws and the row the firmware draws are not the same row`);
  // The mock's own parse gates, likewise ahead of everything that reads them.
  chk(STACK_SRC.length > 0, "parse",
      `compose.js's stack() body was not found - every structural claim below about how the `
    + `column is BUILT would be testing the empty string, which passes vacuously`);
  chk(HTML_DESTRUCTURE !== undefined, "parse",
      `compose.html no longer destructures "const { ... } = globalThis.__X;" - the shell/mock `
    + `seam check below has nothing to look at, so move this parse with the shell`);

  // ---- 0b. compose.html, the browser shell -------------------------------
  // A3. This mock keeps its geometry in compose.js, which run() EVALUATES, so
  // there is no second copy of a number in the .html the way scrollback.html and
  // adaptive.html carry theirs. What the .html does carry is a SEAM: it reads a
  // fixed list of names off globalThis.__X and calls sc.draw()/sc.title. Rename
  // an export in compose.js and every assertion here stays green while the page
  // a human opens throws before it paints one pixel. That is the failure this
  // section exists to catch, and it is the only one the shell can have.
  {
    chk(HTML_SCRIPT_SRC === "compose.js", "html",
        `compose.html loads <script src="${HTML_SCRIPT_SRC}">, but check.mjs evaluates `
      + `compose.js - the page and the checker would be describing different mocks`);
    for (const name of HTML_NAMES)
      chk(name in X, "html",
          `compose.html destructures "${name}" off globalThis.__X, which compose.js does not `
        + `export - the page throws before it paints, and nothing else in this file would notice`);
    for (const sc of SCREENS) {
      chk(typeof sc.draw === "function" && typeof sc.title === "string" && sc.title.length > 0,
          "html", `SCREENS entry "${sc.key}" is missing the draw()/title the shell's paint() uses`);
      chk([...sc.title].every(c => c.codePointAt(0) >= 0x20 && c.codePointAt(0) <= 0x7E),
          "html", `SCREENS entry "${sc.key}" has a non-ASCII title "${sc.title}"`);
    }
    say(`  compose.html: ${HTML_NAMES.length} names off __X, all exported; `
      + `${SCREENS.length} screens x ${X.TH ? Object.keys(X.TH).length : 0} themes painted`);
  }

  // ---- 0c. the picture count, against the prose that claims it -------------
  // A5. Not `SCREENS.length === 14`, which is a transcription: the 14 is PARSED
  // out of both places the prose states it, so the number and the mock cannot
  // drift apart in either direction.
  {
    const rm = claimedCount(README_SRC), ck = claimedCount(CHECK_HEAD);
    chk(rm !== null, "count",
        `README.md no longer states a picture count in words this can parse ("N pictures") - `
      + `either restore it or delete this assertion, but do not leave the number claimed `
      + `somewhere and checked nowhere`);
    chk(ck !== null, "count",
        `check.mjs's own header no longer states a picture count ("N pictures")`);
    if (rm !== null) chk(rm === SCREENS.length, "count",
        `README.md claims ${rm} pictures, the mock builds ${SCREENS.length}`);
    if (ck !== null) chk(ck === SCREENS.length, "count",
        `check.mjs's header claims ${ck} pictures, the mock builds ${SCREENS.length}`);
    // And the SHAPE behind the number, so a count that happens to match by
    // accident still fails: the same states on both boards, no duplicate keys.
    const perBoard = { 1: [], 2: [] };
    for (const sc of SCREENS) perBoard[sc.board].push(sc.key.replace(/^b\d\//, ""));
    chk(perBoard[1].length === perBoard[2].length
        && perBoard[1].every((s, i) => s === perBoard[2][i]), "count",
        `the two boards do not draw the same states: board 1 has [${perBoard[1].join(", ")}], `
      + `board 2 has [${perBoard[2].join(", ")}] - a picture on one panel and not the other is `
      + `a design decision, not a mock detail`);
    chk(new Set(SCREENS.map(sc => sc.key)).size === SCREENS.length, "count",
        `two SCREENS entries share a key - the per-screen failures below would name the same `
      + `label twice and one of them would be unreadable`);
  }

  // ---- 1. the two-board header bind ---------------------------------------
  // For each board, every name in K[b] must be a constant that board's header
  // defines, and must be EQUAL. A name the header does not define FAILS - it is
  // not skipped - which is what makes a misnamed constant an error instead of a
  // silent pass.
  for (const b of [1, 2]) {
    let bound = 0, equal = 0;
    for (const [name, val] of Object.entries(K[b])) {
      const key = `${b}:${name}`, e = PENDING[key];
      const has = name in H[b], hdr = has ? H[b][name] : undefined;
      // THE EXCUSE MATCHES ON BOTH SIDES OR NOT AT ALL: the mock must still
      // target the value the excuse was written for, AND the header must still
      // hold the pre-compose value it was written against.
      const asExpected = !!e && e[0] === val && (e[1] === null ? !has : hdr === e[1]);
      if (!has) {
        const m = `K[${b}].${name} = ${val} is not a constant ${HEADER[b]} defines - either it is `
                + `misnamed, or the header does not name it yet`;
        pendingMissing.push(key);
        chk(false, "bind", m);
        if (asExpected) excused.add(`[bind] ${m}`);
        continue;
      }
      bound++;
      const eq = hdr === val;
      if (eq) equal++; else pendingStale.push(key);
      const m = `K[${b}].${name} is ${val}, ${HEADER[b]} says ${hdr}`;
      chk(eq, "bind", m);
      if (!eq && asExpected) excused.add(`[bind] ${m}`);
    }
    const total = Object.keys(K[b]).length;
    say(`  board ${b} bind: ${bound}/${total} names exist in ${HEADER[b]}, ${equal}/${total} agree`);
  }

  // ---- 1b. PENDING's own integrity, and it is never excused ----------------
  // These are the assertions that make the excuse table incapable of hiding
  // anything. Each names the divergence in the terms the reader needs to act on.
  for (const [key, e] of Object.entries(PENDING)) {
    const [b, name] = [+key.split(":")[0], key.split(":")[1]];
    if (!(b in K) || !(name in K[b])) {
      chk(false, "pending",
          `PENDING["${key}"] excuses a name the mock does not have - an orphan excuse, delete it`);
      continue;
    }
    chk(K[b][name] === e[0], "pending",
        `PENDING["${key}"] was written to excuse the mock targeting ${e[0]}, but K[${b}].${name} `
      + `is now ${K[b][name]} - either the mock's target moved (update this line and say why in `
      + `the commit) or it drifted, and either way the bind failure for it is NOT excused`);
    const has = name in H[b], hdr = has ? H[b][name] : undefined;
    chk(e[1] === null ? !has : hdr === e[1], "pending",
        `PENDING["${key}"] expects ${HEADER[b]} to still say `
      + `${e[1] === null ? "nothing" : e[1]}, but it says ${has ? hdr : "nothing"}. `
      + `${has && hdr === K[b][name]
            ? `The task that lands this constant has run and got it RIGHT - so delete this line; `
            + `a standing excuse for a passing constant is how a later drift gets waved through.`
            : `The task that lands this constant has run and got it WRONG, which is NOT the same `
            + `as it not having run - the whole point of this excuse naming the value.`}`);
  }

  // ---- 2. the derivations -------------------------------------------------
  // Every value in K is a LITERAL, so each of these compares two independent
  // literals and can genuinely disagree. Writing KB_STRIP_H as
  // KB_LINE_PITCH + 4 in the mock would make this arm always hold.
  for (const b of [1, 2]) {
    const k = K[b], d = D[b];
    chk(k.KB_STRIP_H === k.KB_LINE_PITCH + 4, "derive",
        `board ${b}: KB_STRIP_H ${k.KB_STRIP_H} != KB_LINE_PITCH + 4 (${k.KB_LINE_PITCH + 4})`);
    chk(k.COMPOSE_LEGEND_H === k.KB_LINE_PITCH + 3, "derive",
        `board ${b}: COMPOSE_LEGEND_H ${k.COMPOSE_LEGEND_H} != KB_LINE_PITCH + 3 (${k.KB_LINE_PITCH + 3})`);
    chk(k.COMPOSE_DRAFT_H === k.KB_LINE_PITCH + 8, "derive",
        `board ${b}: COMPOSE_DRAFT_H ${k.COMPOSE_DRAFT_H} != KB_LINE_PITCH + 8 (${k.KB_LINE_PITCH + 8})`);
    const promptWant = 5 + k.KB_LINE_PITCH + 4 + d.RP_PROMPT_LINES * k.KB_LINE_PITCH + 4;
    chk(k.COMPOSE_PROMPT_H === promptWant, "derive",
        `board ${b}: COMPOSE_PROMPT_H ${k.COMPOSE_PROMPT_H} != `
      + `5 + KB_LINE_PITCH + 4 + ${d.RP_PROMPT_LINES} lines + 4 (${promptWant})`);
    // DEFECT 9: KB_ACT_H was DEFINED as equal to KB_ROW_H, so the least-pressed
    // control was the tallest and had no drawn/tested split at all.
    chk(k.KB_ACT_H === k.TAP_MIN, "derive",
        `board ${b}: KB_ACT_H ${k.KB_ACT_H} != TAP_MIN ${k.TAP_MIN} - the action band is the `
      + `tap that answers Claude and its band is the floor, not KB_ROW_H`);
    chk(k.KB_ACT_DRAWN === 2 * k.KB_LINE_PITCH, "derive",
        `board ${b}: KB_ACT_DRAWN ${k.KB_ACT_DRAWN} != 2 * KB_LINE_PITCH (${2 * k.KB_LINE_PITCH}) `
      + `- one cell for the glyph, one for the air`);
    chk(2 * k.KB_ACT_DY + k.KB_ACT_DRAWN === k.KB_ACT_H, "derive",
        `board ${b}: the action button is not centred in its band - `
      + `2 * KB_ACT_DY(${k.KB_ACT_DY}) + KB_ACT_DRAWN(${k.KB_ACT_DRAWN}) = `
      + `${2 * k.KB_ACT_DY + k.KB_ACT_DRAWN}, KB_ACT_H is ${k.KB_ACT_H}`);
    // The horizontal half of the split, and it is the KEY's own gap on both
    // boards rather than a new number.
    chk(k.KB_PITCH - k.KB_KEY_W === 2, "derive",
        `board ${b}: KB_PITCH - KB_KEY_W is ${k.KB_PITCH - k.KB_KEY_W}, not the 2px gap both `
      + `boards put on the key's right`);
    // DEFECT 10: R_MD is a CARD radius. KB_KEY_R is derived from the KEY, and
    // C-truncated KB_KEY_W / 10 gives both boards' values exactly (22/10 = 2,
    // 30/10 = 3), which is why the derivation is stated this way rather than as
    // R_MD scaled by a ratio.
    chk(k.KB_KEY_R === Math.trunc(k.KB_KEY_W / 10), "derive",
        `board ${b}: KB_KEY_R ${k.KB_KEY_R} != KB_KEY_W / 10 (${Math.trunc(k.KB_KEY_W / 10)})`);
    // And the reason it moved: how much of the DRAWN key each radius rounds away.
    const drawnKey = k.KB_KEY_W * (k.KB_ROW_H - 4), corner = (r) => r * r * (4 - Math.PI);
    // 5%, not the spec's 9.8%. THAT FIGURE IS BOARD 1'S ALONE AND IT WAS
    // COMPUTED AGAINST THE OLD KEY: 85.8 / (22 x 40) = 9.75% at KB_ROW_H 44,
    // which is 10.5% once the drawn key is 22x37 at KB_ROW_H 41. Board 2's has
    // always been 7.6% (123.6 / 30 x 54), because R_MD scales x1.2 between the
    // boards while the key scales x1.36. A 9% threshold would therefore have
    // failed on board 2 while claiming to describe both, so the threshold is the
    // weaker claim that holds on both panels and the real numbers are PRINTED.
    chk(corner(k.R_MD) / drawnKey > 0.05, "derive",
        `board ${b}: R_MD as a key radius rounds only `
      + `${(100 * corner(k.R_MD) / drawnKey).toFixed(1)}% off the drawn key - under 5%, and the `
      + `case for a key-derived radius has changed`);
    chk(corner(k.R_MD) > 10 * corner(k.KB_KEY_R), "derive",
        `board ${b}: R_MD rounds ${corner(k.R_MD).toFixed(1)}px2 off the corners against `
      + `KB_KEY_R's ${corner(k.KB_KEY_R).toFixed(1)}px2 - less than the order of magnitude that `
      + `made the swap worth doing`);
    chk(corner(k.KB_KEY_R) / drawnKey < 0.01, "derive",
        `board ${b}: KB_KEY_R rounds ${(100 * corner(k.KB_KEY_R) / drawnKey).toFixed(2)}% off the `
      + `drawn key, which is no longer negligible`);
    say(`  board ${b} key corners: R_MD ${k.R_MD} rounded ${corner(k.R_MD).toFixed(1)}px2 `
      + `(${(100 * corner(k.R_MD) / drawnKey).toFixed(1)}% of the ${k.KB_KEY_W}x${k.KB_ROW_H - 4} `
      + `drawn key); KB_KEY_R ${k.KB_KEY_R} rounds ${corner(k.KB_KEY_R).toFixed(1)}px2 `
      + `(${(100 * corner(k.KB_KEY_R) / drawnKey).toFixed(2)}%)`);

    // The text card's budget, unchanged and still provable. KB_MAX_BYTES is
    // PARSED out of keyboard.ino, not restated: 150 on two sides of a checker is
    // a transcription that reverting would not catch.
    const wantLines = Math.ceil(KBF[b].KB_MAX_BYTES / k.KB_COLS);
    chk(k.KB_TEXT_LINES === wantLines, "derive",
        `board ${b}: KB_TEXT_LINES ${k.KB_TEXT_LINES} != ceil(KB_MAX_BYTES ${KBF[b].KB_MAX_BYTES} `
      + `/ KB_COLS ${k.KB_COLS}) = ${wantLines} - SEND could sign text off the card`);
    const wantCols = Math.trunc((k.CARD_W - 12) / k.TEXT_ADV);
    chk(k.KB_COLS === wantCols, "derive",
        `board ${b}: KB_COLS ${k.KB_COLS} != (CARD_W - 12) / TEXT_ADV (${wantCols})`);

    // The type scale, re-derived from the firmware's OWN glyph tables. A font
    // swap must fail here rather than drift past: ADV and CELL are what every
    // extent in this mock is measured with.
    for (const id of [1, 2, 3]) {
      chk(ADV[b][id] === advanceB(b, id), "font",
          `board ${b}: ADV[${id}] is ${ADV[b][id]}, the firmware's font table advances ${advanceB(b, id)}`);
      chk(CELL[b][id] === lineHB(b, id), "font",
          `board ${b}: CELL[${id}] is ${CELL[b][id]}, UI_FONTS[${id}].cellH is ${lineHB(b, id)}`);
    }
    chk(k.TEXT_ADV === advanceB(b, 2), "font",
        `board ${b}: TEXT_ADV ${k.TEXT_ADV} != the body face's advance ${advanceB(b, 2)}`);
    chk(k.KB_LINE_PITCH === lineHB(b, 2), "font",
        `board ${b}: KB_LINE_PITCH ${k.KB_LINE_PITCH} != the body face's cell ${lineHB(b, 2)}`);
  }

  // ---- 3. THE FOUR VERTICAL BUDGETS ---------------------------------------
  // Each column must close EXACTLY on BOARD_H, and every anchored band's
  // cumulative offset must equal the K constant that names it - which is how a
  // gap that drifts fails rather than quietly moving the grid.
  for (const b of [1, 2]) {
    for (const screen of ["keyboard", "reply"]) {
      const S = stack(b, screen), k = K[b];
      chk(S.total === k.BOARD_H, "budget",
          `board ${b} ${screen}: the column sums to ${S.total}, BOARD_H is ${k.BOARD_H} `
        + `(${S.total > k.BOARD_H ? "overruns by " + (S.total - k.BOARD_H)
                                  : "leaves " + (k.BOARD_H - S.total) + " unaccounted"})`,
          `column-closes:${b}:${screen}`);
      for (const t of S.terms) {
        if (!t.at) continue;
        chk(t.y === k[t.at], "budget",
            `board ${b} ${screen}: "${t.name}" starts at ${t.y}, but ${t.at} is ${k[t.at]}`);
      }
      // "The bands are contiguous" is NOT asserted here: stack() assigns each
      // term's y cumulatively, so re-adding the heights and comparing is a
      // derivation against its own term. What can fail is a NEGATIVE term - the
      // residual is the one number with no job of its own, and a column that
      // only closes because a gap went negative is not a column.
      chk(S.terms.every(t => t.h >= 0), "budget",
          `board ${b} ${screen}: a term has negative height (`
        + `${S.terms.filter(t => t.h < 0).map(t => t.name + " " + t.h).join(", ")}) - the column `
        + `closes only by borrowing pixels that do not exist`);
      say(`  board ${b} ${screen.padEnd(8)} column: ${S.terms.length} terms, `
        + `sums to ${S.total} of BOARD_H ${k.BOARD_H}`);
    }
    // The two surfaces put SEND in the same place. A1: this was ONE assertion,
    // `kbAct.y === rpAct.y && kbAct.h === rpAct.h`, and the second half COULD NOT
    // FAIL - stack() pushes `k.KB_ACT_H` for "action band" on both arms, so the
    // heights are the same expression compared against itself. The half that can
    // fail is the OFFSET, which two independently accumulated columns arrive at
    // separately; it is kept, and the height is now covered by a STRUCTURAL claim
    // over stack()'s own body instead - if the reply panel ever gets its own
    // height constant, that arm fails and says to re-point this comparison,
    // rather than a numeric equality quietly turning back into a tautology.
    const kbAct = stack(b, "keyboard").find("action band");
    const rpAct = stack(b, "reply").find("action band");
    chk(kbAct.y === rpAct.y, "budget",
        `board ${b}: the action band starts at ${kbAct.y} on the keyboard and ${rpAct.y} on the `
      + `reply panel - one surface would move SEND under the finger`, `act-band-y:${b}`);
  }
  // The height half of that claim, made where it can fail: both arms of stack()
  // must take "action band" from the SAME K name. Bound to the FUNCTION BODY -
  // a grep over compose.js would be satisfied by any neighbouring push().
  {
    chk(ACT_H_TERMS.length === 2, "budget",
        `stack()'s body pushes "action band" ${ACT_H_TERMS.length} time(s) with a k.<NAME> `
      + `height, expected 2 (one per screen) - the keyboard and the reply panel are supposed to `
      + `declare the same band, and this check reads them by name`);
    chk(ACT_H_TERMS.length === 2 && ACT_H_TERMS[0] === ACT_H_TERMS[1], "budget",
        `stack() gives the action band its height from ${ACT_H_TERMS.join(" and ")} on the two `
      + `screens - two constants can diverge, so the SEND row can move between surfaces without `
      + `any number in this file disagreeing`);
  }

  // ---- 4. the three columns ------------------------------------------------
  // The cell is lane/3, the gap belongs to the button on its LEFT, and the
  // remainder lands on the LAST column so the row closes on the lane exactly.
  // Summed against the HEADER's CARD_W, not the mock's, so a lane that moved
  // fails here.
  for (const b of [1, 2]) {
    const cw = colWidths(b), sum = cw.reduce((a, c) => a + c, 0);
    chk(sum === H[b].CARD_W, "cols",
        `board ${b}: the three columns sum to ${sum}, ${HEADER[b]}'s CARD_W is ${H[b].CARD_W}`);
    // AGAINST THE HEADER, NOT THE MOCK. `colX(b,0) === K[b].CARD_X` is how this
    // read first, and it is a derivation compared against its own term - colX()
    // RETURNS K[b].CARD_X for i = 0, so it could not fail. The same went for
    // "the first two columns are equal" and "the remainder landed on the last",
    // both of which are properties of colWidths()'s own arithmetic rather than
    // claims about the layout: cw is [c, c, W - 2c] by construction and
    // W - 3*floor(W/3) is 0..2 for every W there is. They are PRINTED below
    // instead, where a wrong split is visible and does not pretend to be a
    // passing test.
    chk(colX(b, 0) === H[b].CARD_X, "cols",
        `board ${b}: column 0 starts at ${colX(b, 0)}, ${HEADER[b]}'s CARD_X is ${H[b].CARD_X}`);
    chk(colX(b, 2) + colSpan(b, 2, 1) === H[b].CARD_X + H[b].CARD_W, "cols",
        `board ${b}: the row closes at ${colX(b, 2) + colSpan(b, 2, 1)}, the header's lane ends `
      + `at ${H[b].CARD_X + H[b].CARD_W}`);
    say(`  board ${b} columns: ${cw.join(" + ")} = ${sum} (lane ${H[b].CARD_W}); `
      + `cell ${cw[0]}, remainder ${cw[2] - cw[0]} on the last; drawn width is the cell less `
      + `the ${keyGap(b)}px key gap`);
  }

  // ---- 5. defect 1 of the spec: the fingertip floor, stated as arithmetic ---
  for (const b of [1, 2]) {
    const k = K[b];
    chk(k.KB_PITCH < k.TAP_MIN, "floor",
        `board ${b}: KB_PITCH ${k.KB_PITCH} now clears TAP_MIN ${k.TAP_MIN} - the premise of `
      + `this whole design (that no ten-column key can) no longer holds and it should be re-argued`);
    chk(Math.trunc(k.BOARD_W / k.TAP_MIN) < 10, "floor",
        `board ${b}: floor(BOARD_W / TAP_MIN) is ${Math.trunc(k.BOARD_W / k.TAP_MIN)}, so a `
      + `ten-column QWERTY WOULD clear the floor - the reply panel's case rests on it not doing so`);
    chk(k.KB_ROW_H >= k.TAP_MIN, "floor",
        `board ${b}: KB_ROW_H ${k.KB_ROW_H} is under TAP_MIN ${k.TAP_MIN} - height was the one `
      + `dimension that cleared, and this design must not spend it`);
    say(`  board ${b} floor: KB_PITCH ${k.KB_PITCH} vs TAP_MIN ${k.TAP_MIN} `
      + `(${(100 * (1 - k.KB_PITCH / k.TAP_MIN)).toFixed(0)}% short in width); `
      + `KB_ROW_H ${k.KB_ROW_H} clears by ${k.KB_ROW_H - k.TAP_MIN}; `
      + `floor(BOARD_W/TAP_MIN) = ${Math.trunc(k.BOARD_W / k.TAP_MIN)} columns against QWERTY's 10`);
  }

  // ---- 6. defect 3: every printable ASCII character reachable ---------------
  // 14 of the 95 cannot be typed today ($ % * < > [ \ ] ^ ` { | } ~). The second
  // symbol page exists for exactly them, and this is the assertion that says so
  // - it enumerates the pages rather than restating the 14.
  {
    const reach = new Set();
    for (const page of PAGES) {
      for (const row of page.rows) for (const ch of row) {
        if (ch.codePointAt(0) < 0x20) continue;   // the SHIFT and DEL sentinels
        reach.add(ch);
        if (ch >= "a" && ch <= "z") reach.add(ch.toUpperCase());
      }
    }
    // ROW 3 FROM ITS OWN DEFINITION, not by hand. This used to be
    // `reach.add(" "); reach.add(".")` - a transcription of 2 of the 95, so
    // relabelling the period key still printed "95 of 95". KB_ROW3 is the table
    // the renderer walks, and a character cell there carries only `emits`.
    chk(KB_ROW3.length > 0 && KB_ROW3.some(c => c.emits !== null), "ascii",
        `KB_ROW3 parsed as ${KB_ROW3.length} cells with no character among them - a sweep over `
      + `an empty row would report every character it holds as reachable by omission`);
    for (const cell of KB_ROW3) if (cell.emits !== null) reach.add(cell.emits);
    const missing = [];
    for (let cp = 0x20; cp <= 0x7E; cp++) if (!reach.has(String.fromCharCode(cp))) missing.push(String.fromCharCode(cp));
    chk(missing.length === 0, "ascii",
        `${missing.length} of the 95 printable ASCII characters cannot be typed: ${missing.join(" ")}`);
    // And the row the DRAWING produces must hold the same characters the sweep
    // credited it with - the two could still drift if row3Label() stopped
    // deriving a character cell's label from its own `emits`.
    for (const cell of KB_ROW3) {
      if (cell.emits === null) continue;
      const want = cell.emits === " " ? "SPACE" : cell.emits;
      chk(row3Label(cell, PAGES[0]) === want, "ascii",
          `row 3's cell emitting "${cell.emits}" is labelled "${row3Label(cell, PAGES[0])}", not `
        + `"${want}" - the label must be derived from the character, or a relabel changes what `
        + `the key types without the sweep noticing`);
    }
    say(`  reachable characters: ${95 - missing.length} of 95 printable ASCII across `
      + `${PAGES.length} pages (${PAGES.map(p => p.name).join(", ")}) plus row 3's `
      + `${KB_ROW3.filter(c => c.emits !== null).map(c => JSON.stringify(c.emits)).join(" ")}`);
  }

  // ---- 7. the chips: host cap, and label-may-truncate/value-never-does ------
  {
    chk(ASK.chips.length <= 4, "chips", `the mock ships ${ASK.chips.length} chips; the host caps at 4`);
    for (const v of ASK.chips) {
      chk(v.length <= 32, "chips", `chip "${v}" is ${v.length} bytes; the host drops anything over 32`);
      chk([...v].every(c => c.codePointAt(0) >= 0x20 && c.codePointAt(0) <= 0x7E), "chips",
          `chip "${v}" is not ASCII - the host transliterates before capping, so this cannot happen`);
    }
  }

  // ---- 8. the picture -----------------------------------------------------
  for (const sc of SCREENS) {
    const b = sc.board, k = K[b];
    BAD_CHARS.clear();
    const p = new P(b, "DARK");
    sc.draw(p);
    const label = sc.key;

    // 8a. THE FONTS ARE ASCII 0x20..0x7E AND NOTHING ELSE. An out-of-range
    // codepoint draws nothing AND advances nothing, so it is invisible rather
    // than a fallback box - which is why truncation uses three ASCII dots.
    chk(BAD_CHARS.size === 0, "chars",
        `${label}: ${BAD_CHARS.size} non-ASCII codepoint(s) drawn: `
      + `${[...BAD_CHARS].map(c => "U+" + c.toString(16).toUpperCase().padStart(4, "0")).join(" ")}`);

    // 8b. nothing lands off the panel
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const o of p.ops) {
      let x, y, w, h;
      if (o[0] === "r" || o[0] === "s") { [, x, y, w, h] = o; }
      else if (o[0] === "t") { x = o[2]; y = o[3]; w = o[1].length * ADV[b][o[4]]; h = CELL[b][o[4]]; }
      else continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + w - 1);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y + h - 1);
    }
    chk(minX >= 0 && maxX < k.BOARD_W, "panel", `${label}: x runs ${minX}..${maxX}, panel is 0..${k.BOARD_W - 1}`);
    chk(minY >= 0 && maxY < k.BOARD_H, "panel", `${label}: y runs ${minY}..${maxY}, panel is 0..${k.BOARD_H - 1}`);

    // 8c. NO CONTROL MAY LAND IN AN INK-ONLY BAND. Comparing the drawn band
    // COUNT to the column's term count (how this read first) is a tautology -
    // the screens push one band per term - so what is asserted instead is that
    // every band carrying a control is one the column declared TAPPABLE. A
    // control in a legend, a margin or the residual fails here.
    const S = stack(b, sc.screen);
    for (const c of p.controls) {
      const t = S.terms.find(t => t.name === c.band);
      chk(t && t.taps, "panel",
          `${label}: "${c.label}" sits in band "${c.band}", which the column does not declare `
        + `tappable - a legend, a margin and the residual are ink`);
      if (t) live.add(`${b}/${sc.screen}/${t.name}`);
    }

    // 8d. the drawn/tested split, per control
    const byBand = new Map();
    for (const c of p.controls) {
      const band = p.bands.find(bd => bd.name === c.band);
      chk(!!band, "split", `${label}: control "${c.label}" names band "${c.band}", which the screen never declared`);
      if (!band) continue;
      const inside = (a, o) => a.x >= o.x && a.y >= o.y && a.x + a.w <= o.x + o.w && a.y + a.h <= o.y + o.h;
      chk(inside(c.drawn, c.tested), "split",
          `${label}: "${c.label}" is drawn ${JSON.stringify(c.drawn)} outside its tested band ${JSON.stringify(c.tested)}`);
      chk(c.tested.y >= band.y && c.tested.y + c.tested.h <= band.y + band.h, "split",
          `${label}: "${c.label}" is tested ${c.tested.y}..${c.tested.y + c.tested.h - 1}, `
        + `outside band "${band.name}" ${band.y}..${band.y + band.h - 1}`);
      chk(c.tested.x >= 0 && c.tested.x + c.tested.w <= k.BOARD_W, "split",
          `${label}: "${c.label}"'s tested rect leaves the panel horizontally`);
      // A control drawn at exactly its tested size HAS NO SPLIT. The surfaces
      // that are their own target (the peek cards, the caret lane) say so with
      // noSplit and are exempt by name, not by accident.
      if (!c.noSplit)
        chk(c.drawn.w * c.drawn.h < c.tested.w * c.tested.h, "split",
            `${label}: "${c.label}" is drawn at its full tested size (${c.drawn.w}x${c.drawn.h}) - `
          + `the drawn/tested split is missing`);
      if (!byBand.has(band.name)) byBand.set(band.name, []);
      byBand.get(band.name).push(c);
    }
    // 8e. two controls in one band may not overlap - an ambiguous tap is worse
    // than a dead one, because the wrong thing happens rather than nothing.
    for (const [bandName, list] of byBand) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i].tested, z = list[j].tested;
        const over = a.x < z.x + z.w && z.x < a.x + a.w && a.y < z.y + z.h && z.y < a.y + a.h;
        chk(!over, "split",
            `${label}: "${list[i].label}" and "${list[j].label}" have overlapping tested rects in ${bandName}`);
      }
    }

    // 8e2. THE LANE-WIDE BANDS MUST TILE THE LANE EXACTLY - read off the DRAWN
    // control rects, not off colWidths(), which is why this can fail where "the
    // remainder landed on the last column" could not. A gap between two tested
    // rects is a strip where a tap does nothing, and this design's whole reason
    // for making adjacent bands contiguous was to remove one.
    for (const [bandName, list] of byBand) {
      if (!/^(reply|token|recent) band|^action band$/.test(bandName)) continue;
      const sorted = [...list].sort((a, z) => a.tested.x - z.tested.x);
      let x = k.CARD_X, gap = null;
      for (const c of sorted) { if (c.tested.x !== x) { gap = c; break; } x = c.tested.x + c.tested.w; }
      chk(!gap, "cols",
          `${label}: ${bandName} does not tile the lane - "${gap && gap.label}" starts at `
        + `${gap && gap.tested.x}, the previous control ended at ${x}`);
      chk(gap || x === k.CARD_X + k.CARD_W, "cols",
          `${label}: ${bandName} closes at ${x}, the lane ends at ${k.CARD_X + k.CARD_W}`);
    }

    // 8e3. THE ACTION ROW IS PROPORTIONAL, AND SEND IS EXACTLY TWICE DISCARD.
    // Read off the DRAWN widths, not off the fracs that produced them, so the
    // claim is about the row on the glass. The reply panel's row must carry
    // THREE controls: an earlier draft of this mock laid the row out in lane/3
    // cells, concluded a third would not fit, and exiled TYPE... to the draft
    // line - so this is the assertion that would have caught that.
    {
      const act = (byBand.get("action band") || []).slice().sort((a, z) => a.tested.x - z.tested.x);
      const lane = k.BOARD_W - 2 * k.CARD_X;
      chk(lane === H[b].CARD_W, "act",
          `${label}: uiActionRow derives its lane as BOARD_W - 2*CARD_X = ${lane}, but `
        + `${HEADER[b]}'s CARD_W is ${H[b].CARD_W} - the row and the panel would use `
        + `different lanes`);
      if (sc.screen === "reply" && !/-sent$/.test(sc.key)) {
        chk(act.length === 3, "act",
            `${label}: the reply panel's action band has ${act.length} controls, not the three `
          + `the design needs (CLOSE/DISCARD, TYPE..., SEND) - TYPE... is the only bridge from `
          + `this panel to free text and it belongs on a full TAP_MIN band`);
        if (act.length === 3) {
          const [left, type, send] = act;
          chk(send.drawn.w === 2 * left.drawn.w, "act",
              `${label}: SEND is drawn ${send.drawn.w}px against "${left.label}"'s `
            + `${left.drawn.w} - defect 2 asks for exactly twice, not ${(send.drawn.w / left.drawn.w).toFixed(2)}x`);
          chk(send.drawn.w === 2 * type.drawn.w, "act",
              `${label}: SEND is drawn ${send.drawn.w}px against TYPE...'s ${type.drawn.w}`);
          chk(left.label === "DISCARD" || left.label === "CLOSE", "act",
              `${label}: the left action is "${left.label}", expected DISCARD (a draft to lose) `
            + `or CLOSE (none)`);
          chk(type.label === "TYPE...", "act",
              `${label}: the middle action is "${type.label}", expected TYPE...`);
          chk(send.label === "SEND", "act", `${label}: the right action is "${send.label}"`);
        }
      }
      // Each zone swallows the gap to its RIGHT, so consecutive drawn buttons
      // must sit exactly ACT_GAP apart and the last must close on the lane.
      for (let i = 0; i + 1 < act.length; i++) {
        const d = act[i + 1].drawn.x - (act[i].drawn.x + act[i].drawn.w);
        chk(d === ACT_GAP, "act",
            `${label}: "${act[i].label}" and "${act[i + 1].label}" are ${d}px apart, `
          + `uiActionRow's gap is ${ACT_GAP}`);
      }
      if (act.length) {
        const lastC = act[act.length - 1];
        chk(lastC.drawn.x + lastC.drawn.w === k.CARD_X + lane, "act",
            `${label}: the action row closes at ${lastC.drawn.x + lastC.drawn.w}, the lane ends `
          + `at ${k.CARD_X + lane} - the remainder did not land on the last control`);
      }
    }

    // 8f. TAP_MIN, with the sub-floor controls named rather than tolerated.
    // The list is exact in BOTH directions: a sub-floor control that is not
    // excepted fails, and an exception that is no longer sub-floor fails too, so
    // the list cannot rot into a blanket permission.
    // An entry may name a LABEL as well as a band, and when it does it permits
    // that control ALONE. The draft line's does: it covers CLR and nothing else,
    // so TYPE... reappearing on that line fails instead of inheriting CLR's
    // reason - the reason is about a recoverable clear, not about a bridge to
    // free text.
    const matches = (e, bandName, label) => e.screen === sc.screen
      && (e.band instanceof RegExp ? e.band.test(bandName) : e.band === bandName)
      && (e.label === undefined || e.label === label);
    // A2. THERE IS NO EXEMPTION HERE ANY MORE. A `if (c.noSplit && c.kind ===
    // "caret") continue;` sat on this loop, excusing the text card's drag lane
    // from TAP_MIN - and the drag lane is CARD_W x KB_TEXT_H, which clears the
    // floor by a mile on both boards, so it excused nothing and never had. What
    // it WAS was a second, silent permission mechanism sitting outside
    // EXCEPTIONS: the day the caret's tested rect narrowed to a real caret lane,
    // it would have been waved through with no entry naming a reason, which is
    // precisely the property EXCEPTIONS exists to have. A sub-floor control is
    // named in EXCEPTIONS or it fails; there is no third door.
    const used = new Set();
    for (const c of p.controls) {
      for (const [axis, size] of [["h", c.tested.h], ["w", c.tested.w]]) {
        if (size >= k.TAP_MIN) continue;
        const e = EXCEPTIONS.find(e => e.axis === axis && matches(e, c.band, c.label));
        chk(!!e, "tapmin",
            `${label}: "${c.label}" is tested ${size}px in ${axis} against TAP_MIN ${k.TAP_MIN}, and `
          + `no EXCEPTIONS entry covers ${sc.screen}/${c.band}/"${c.label}" in that axis - a control under the `
          + `fingertip floor must be named with its reason, not merely allowed`);
        if (e) used.add(EXCEPTIONS.indexOf(e));
      }
    }
    // AND, STATED DIRECTLY RATHER THAN LEFT TO THE EXCEPTION MACHINERY: on the
    // reply panel every control except CLR clears TAP_MIN in BOTH axes. This
    // fails if anything else goes sub-floor AND if CLR stops being sub-floor, so
    // it cannot rot into a description of whatever the mock happens to draw.
    if (sc.screen === "reply") {
      // The caret filter is gone from here too, for the reason above and one
      // more: the reply panel has no caret control at all, so it filtered
      // nothing on the only screens it ran over.
      const sub = p.controls
        .filter(c => c.tested.h < k.TAP_MIN || c.tested.w < k.TAP_MIN)
        .map(c => c.label);
      const want = /-sent$/.test(sc.key) ? [] : ["CLR"];
      chk(sub.length === want.length && sub.every(l => want.includes(l)), "tapmin",
          `${label}: the sub-floor controls are [${sub.join(", ")}], expected `
        + `[${want.join(", ") || "none"}] - on this screen only CLR may be short, and only in `
        + `height`);
    }

    // `used` only holds entries a sub-floor control already matched, so asking
    // whether each matched something sub-floor is trivially true. The claim that
    // can fail - an entry matching nothing on ANY screen - is made once, after
    // the sweep.
    for (const i of used) exceptionsSeen.add(i);

    // 8g. the keyboard's text card still holds its provable line count
    if (sc.screen === "keyboard") {
      // hardWrap() is CAPPED at maxLines, so comparing its output length to that
      // cap can never fail. The real question is whether the draft NEEDS more
      // lines than the card has, which is arithmetic on the string itself.
      const need = Math.ceil(X.DRAFT.length / k.KB_COLS);
      chk(need <= k.KB_TEXT_LINES, "panel",
          `${label}: the ${X.DRAFT.length}-byte draft needs ${need} lines at KB_COLS `
        + `${k.KB_COLS}, the card holds ${k.KB_TEXT_LINES}`);
      const lastY = k.KB_TEXT_Y + k.KB_LINE0_DY + (k.KB_TEXT_LINES - 1) * k.KB_LINE_PITCH + k.KB_LINE_PITCH - 1;
      chk(lastY < k.KB_TEXT_Y + k.KB_TEXT_H, "panel",
          `${label}: the ${k.KB_TEXT_LINES}th text line ends at ${lastY}, the card ends at `
        + `${k.KB_TEXT_Y + k.KB_TEXT_H - 1}`);
      // The reserved meta row and the first text line must share no pixel row -
      // drawString paints an OPAQUE box a full cell tall, and this has been
      // found twice on board 1.
      const metaBot = k.KB_META_DY + k.KB_LINE_PITCH - 1;
      chk(metaBot < k.KB_LINE0_DY, "panel",
          `${label}: the meta row inks +${k.KB_META_DY}..+${metaBot} and line 0 starts `
        + `+${k.KB_LINE0_DY} - the counter would erase the first line's tail`);
    }

    // 8h. the chips: the LABEL may be truncated, the VALUE never is
    for (const c of p.controls) {
      if (c.kind !== "insert") continue;
      const full = "+ " + c.label;
      const drawn = p.ops.filter(o => o[0] === "t" && o[2] >= c.drawn.x && o[2] < c.drawn.x + c.drawn.w
                                   && o[3] >= c.drawn.y && o[3] < c.drawn.y + c.drawn.h).map(o => o[1]);
      chk(drawn.length === 1, "chips", `${label}: chip "${c.label}" drew ${drawn.length} strings, expected 1`);
      if (drawn.length !== 1) continue;
      const s = drawn[0];
      const truncated = s.endsWith("...") && full.startsWith(s.slice(0, -3));
      chk(s === full || truncated, "chips",
          `${label}: chip label "${s}" is neither "${full}" nor a three-dot truncation of it`);
      chk(!s.includes("\u2026"), "chips", `${label}: chip label "${s}" used U+2026, which draws NOTHING and advances NOTHING`);
    }

    say(`  ${label.padEnd(20)} ${String(p.ops.length).padStart(4)} ops, `
      + `${String(p.controls.length).padStart(3)} controls, ink ${minX}..${maxX} x ${minY}..${maxY} `
      + `(panel ${k.BOARD_W}x${k.BOARD_H})`);
  }

  // AND THE CONVERSE: a band the column declares TAPPABLE must carry a control
  // on at least one state of its screen. A dead tappable band is a claim the
  // touch router will honour and nothing will answer - and it is how the
  // residual, whose whole job is to have no job, would quietly acquire one. The
  // union across states is what is checked, because the draft line legitimately
  // holds no control once the reply is sent.
  for (const b of [1, 2]) for (const screen of ["keyboard", "reply"])
    for (const t of stack(b, screen).terms) {
      if (!t.taps) continue;
      chk(live.has(`${b}/${screen}/${t.name}`), "panel",
          `board ${b} ${screen}: band "${t.name}" is declared tappable but no state of that `
        + `screen puts a control in it`);
    }

  // Every EXCEPTIONS entry must have been used by at least one screen. An entry
  // matching nothing is a stale permission, and a stale permission is how a
  // sub-floor control gets waved through later.
  for (let i = 0; i < EXCEPTIONS.length; i++)
    chk(exceptionsSeen.has(i), "tapmin",
        `EXCEPTIONS[${i}] (${EXCEPTIONS[i].screen}/${EXCEPTIONS[i].band}, ${EXCEPTIONS[i].axis}) `
      + `matched no sub-floor control on any screen - it permits nothing and should go`);

  return { n, msgs: msgs.slice(), ids: new Set(failIds), excused };
}

// ===========================================================================
// --selftest: exit 0 ONLY when an injected fault IS caught, and say WHICH
// assertion caught it.
//
// The fault is the brief's: COMPOSE_DRAFT_H pushed up by 8 on both boards, so
// the reply panel's column overruns BOARD_H. It is perturbed IN MEMORY and run
// through the SAME run() the normal path uses - not a second reimplementation of
// the comparison, which could pass or fail independently of whether the real
// assertions still work.
//
// This checker has EXPECTED failures (the headers do not define every name in K
// yet - PENDING says which), so "did anything fail" cannot be the test. The test is whether
// the message set GREW, and whether the new messages come from the budget
// assertion by name.
// ===========================================================================
if (process.argv.includes("--selftest")) {
  quiet = true;
  // THE VERDICT NAMES THE ASSERTIONS, NOT THEIR TAG. Gating on "[budget]" was
  // not enough: four assertions share that tag, so replacing
  // `chk(S.total === k.BOARD_H)` with `chk(true)` left the KB_ACT_Y anchor
  // assertions firing, the tag still present, and this verdict still printing
  // "the column no longer closes on BOARD_H" - a group-level test behind an
  // assertion-level claim, which is the same defect as an assertion that cannot
  // fail. These are the two ids that MUST newly fail; deleting or neutering
  // either one now fails the selftest by name.
  const WANT = ["column-closes:1:reply", "column-closes:2:reply"];
  const base = run();
  const before = new Set(base.msgs), beforeIds = base.ids;
  const delta = 8;
  const was = { 1: K[1].COMPOSE_DRAFT_H, 2: K[2].COMPOSE_DRAFT_H };
  K[1].COMPOSE_DRAFT_H += delta; K[2].COMPOSE_DRAFT_H += delta;
  const hit = run();
  K[1].COMPOSE_DRAFT_H = was[1]; K[2].COMPOSE_DRAFT_H = was[2];
  quiet = false;

  const fresh = hit.msgs.filter(m => !before.has(m));
  const freshIds = [...hit.ids].filter(i => !beforeIds.has(i));
  console.log(`--selftest: pushed COMPOSE_DRAFT_H up by ${delta} on both boards `
            + `(${was[1]} -> ${was[1] + delta} and ${was[2]} -> ${was[2] + delta}) in memory`);
  console.log(`--selftest: ${before.size} failing assertion(s) before the fault, `
            + `${hit.msgs.length} after - ${fresh.length} new`);
  for (const m of fresh) console.log(`  CAUGHT ${m}`);
  const missing = WANT.filter(i => !freshIds.includes(i));
  for (const i of WANT)
    console.log(`  ${missing.includes(i) ? "NOT CAUGHT" : "caught by"} assertion "${i}"`);
  if (!missing.length) {
    console.log(`--selftest PASSES: the fault was caught by the named column-closure `
              + `assertion on both boards (${WANT.join(", ")}), not merely by something `
              + `sharing its [budget] tag`);
    process.exit(0);
  }
  console.log(`--selftest FAILS: assertion(s) ${missing.join(", ")} did NOT newly fail. `
            + `${fresh.length ? `${fresh.length} other assertion(s) did, but the one this `
              + `selftest exists to prove - that the column closes on BOARD_H - is blind to the `
              + `fault or has been neutered.`
            : "Nothing failed at all."}`);
  process.exit(1);
}

// ===========================================================================
console.log("compose surface mock - bound to BOTH board headers\n");
const r = run();
const failed = r.msgs.length;

// The closing summary SORTS the failures; it does not excuse any of them. The
// sorting is STRUCTURAL - run() built `excused` from PENDING by matching
// `board:name` AND both values - so a bind failure this run produced for any
// other reason lands in "unexpected", and so does every [pending] integrity
// failure. Nothing here re-derives the classification from message text.
const waiting = r.msgs.filter(m => r.excused.has(m));
const unexpected = r.msgs.filter(m => !r.excused.has(m));

console.log(`\n${r.n - failed} of ${r.n} assertions passed, ${failed} failed`);
console.log(`  ${waiting.length} waiting on a later task of the compose plan to add or move the constant:`);
console.log(`    names no header defines yet: ${pendingMissing.join(" ") || "(none)"}`);
console.log(`    names still at their pre-compose value: ${pendingStale.join(" ") || "(none)"}`);
console.log(`  ${unexpected.length} UNEXPECTED - this is the number that must be zero:`);
for (const m of unexpected) console.log(`    ${m}`);
if (!failed) console.log("\nEverything binds. The plan's constants have all landed.");
else console.log(`\nEXIT 1. ${waiting.length ? "The bind is doing its job: every name above is printed "
  + "rather than skipped, and each goes green when its task lands. See README.md." : ""}`);
process.exit(failed ? 1 : 0);
