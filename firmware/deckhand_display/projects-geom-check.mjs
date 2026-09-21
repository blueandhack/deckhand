// PROJECTS tab geometry checker (level 1, the project list) - runs on the
// Mac, needs no hardware. Board 2 only: PROJECTS is out of scope for board 1
// by design (docs/superpowers/specs/2026-09-20-sessions-manager-design.md,
// "Out of scope: Board 1"), so there is nothing of this shape to check there.
//
// Modelled on sessions-geom-check.mjs, but far smaller: a project row has no
// ladder, no band card, no ask - one name, one line of metadata, one height
// for every position. So this file asserts the four things task-5-brief.md
// names (the last row fits above the footer, a row clears the fingertip
// floor, the name lane cannot overrun the meta lane, PROJ_SLOTS covers what
// the host may send) plus three narrower ones that pin PROJ_STEP/PROJ_ROWS/
// PROJ_AVAIL to the exact expressions the header derives them by - added
// because the first assertion is otherwise TAUTOLOGICAL (see the long note
// on `step` below) and CLAUDE.md is explicit that an assertion which cannot
// fail is a defect in its own right.
//
//   node projects-geom-check.mjs             check board 2
//   node projects-geom-check.mjs --selftest  prove the checker has teeth
//
// FIX ROUND 1 added two more assertions, over the fetch-timeout mechanism
// (board_es3c35p.h's PROJ_FETCH_TIMEOUT_MS/_BLE_MS, projects.ino's
// tickProjectsFetch()) that replaced an unrecoverable stuck-forever
// "Loading projects..." state reachable by one dropped BLE reply. One reads
// the parsed constants (BLE's own allowance must be longer than USB's - the
// same relationship SCROLL_FETCH_TIMEOUT_BLE_MS/_MS holds, mirrored rather
// than reinvented); the other is STRUCTURAL, bound to tickProjectsFetch()'s
// own function body (never to the file at large - "a rule a neighbouring
// line can satisfy is not a rule", CLAUDE.md) via geom-common's fnBody(),
// which throws rather than reading someone else's line if the function
// cannot be found at all.
import { consts, fnBody, stripComments, DIR } from "./geom-common.mjs";
import fs from "fs";

function assert(fails, name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}: ${detail}`);
    fails.push(name);
  }
}

// `c` is the header's own parsed constants, OPTIONALLY with PROJ_ROW_H
// overridden by --selftest. Every other assertion below reads `c` exactly as
// consts() parsed it from board_es3c35p.h; only the "last row fits" check
// recomputes its own PROJ_STEP from PROJ_ROW_H + PROJ_ROW_GAP rather than
// trusting c.PROJ_STEP, and that is deliberate, not an inconsistency:
//
// PROJ_ROWS is declared in the header as
// `(PROJ_AVAIL + PROJ_ROW_GAP) / PROJ_STEP` - a floor division - and floor
// division has a property that makes "PROJ_ROW_Y0 + PROJ_ROWS * PROJ_STEP -
// PROJ_ROW_GAP <= BOARD_H - FOOTER_H" hold for ANY value of PROJ_STEP, because
// PROJ_ROWS always shrinks to keep PROJ_ROWS * PROJ_STEP <= PROJ_AVAIL +
// PROJ_ROW_GAP by construction. Editing PROJ_ROW_H in the real header and
// letting PROJ_STEP/PROJ_ROWS RE-DERIVE from it (which is what actually
// happens on a real edit) can therefore never overrun the footer - the
// assertion as literally written would be the "X >= Y where X is declared
// = Y" defect CLAUDE.md names, if PROJ_STEP were taken from the already-
// re-derived c.PROJ_STEP.
//
// What CAN drift, and has ("the group set has already been re-cut three
// times on this branch" - CLAUDE.md, of a different constant) is PROJ_ROW_H
// changing while PROJ_ROWS - a SEPARATE declaration - is not correspondingly
// revisited. So the check recomputes PROJ_STEP from the two more primitive
// terms and pairs it with PROJ_ROWS AS DECLARED, which is exactly the
// combination a source edit to PROJ_ROW_H alone would produce before anyone
// touched PROJ_ROWS - and exactly what --selftest's first fault injects.
// `projSrc` is projects.ino's text with comments stripped (real, unless
// --selftest's structural fault below is overriding it) - passed in rather
// than read here so the SAME checkAll() serves both the ordinary run and the
// faulted one, which is what makes "does reverting the fix make this fail,
// by name" a real question rather than a rhetorical one.
function checkAll(c, projSrc) {
  const fails = [];

  const step = c.PROJ_ROW_H + c.PROJ_ROW_GAP;
  const lastRowBottom = c.PROJ_ROW_Y0 + c.PROJ_ROWS * step - c.PROJ_ROW_GAP;
  assert(fails, "the last project row fits above the footer",
    lastRowBottom <= c.BOARD_H - c.FOOTER_H,
    `${lastRowBottom} > ${c.BOARD_H - c.FOOTER_H}`);

  assert(fails, "a project row is at least a fingertip",
    c.PROJ_ROW_H >= c.TAP_MIN,
    `${c.PROJ_ROW_H} < ${c.TAP_MIN}`);

  const nameLaneW = c.PROJ_NAME_CHARS * c.TEXT_ADV;
  const budget = c.PROJ_ROW_W - 2 * c.PROJ_PAD;
  assert(fails, "the name lane cannot overrun the count and time",
    nameLaneW + c.PROJ_META_W <= budget,
    `${nameLaneW} (name) + ${c.PROJ_META_W} (meta) = ${nameLaneW + c.PROJ_META_W} > ${budget}`);

  assert(fails, "PROJ_SLOTS covers what the host may send",
    c.PROJ_SLOTS >= 16,
    `${c.PROJ_SLOTS} < 16`);

  // The three narrower checks the long header note above promises: each
  // binds one of the header's OWN derivations to the primitive terms it is
  // supposed to be built from, independently of the fault-injection path
  // above - so a header edit that changes one of these formulas without
  // meaning to fails here BY NAME, rather than only showing up (or not) in
  // the footer check's own tautology.
  assert(fails, "PROJ_STEP is PROJ_ROW_H + PROJ_ROW_GAP",
    c.PROJ_STEP === c.PROJ_ROW_H + c.PROJ_ROW_GAP,
    `${c.PROJ_STEP} != ${c.PROJ_ROW_H} + ${c.PROJ_ROW_GAP}`);
  assert(fails, "PROJ_AVAIL is BOARD_H - FOOTER_H - PROJ_ROW_Y0",
    c.PROJ_AVAIL === c.BOARD_H - c.FOOTER_H - c.PROJ_ROW_Y0,
    `${c.PROJ_AVAIL} != ${c.BOARD_H} - ${c.FOOTER_H} - ${c.PROJ_ROW_Y0}`);
  assert(fails, "PROJ_ROWS is floor((PROJ_AVAIL + PROJ_ROW_GAP) / PROJ_STEP)",
    c.PROJ_ROWS === Math.floor((c.PROJ_AVAIL + c.PROJ_ROW_GAP) / c.PROJ_STEP),
    `${c.PROJ_ROWS} != floor((${c.PROJ_AVAIL} + ${c.PROJ_ROW_GAP}) / ${c.PROJ_STEP})`);

  // ---- fetch timeout (fix round 1: a lost reply must not hang forever) ----
  assert(fails, "PROJECTS' BLE fetch timeout is longer than its USB one",
    c.PROJ_FETCH_TIMEOUT_BLE_MS > c.PROJ_FETCH_TIMEOUT_MS,
    `BLE ${c.PROJ_FETCH_TIMEOUT_BLE_MS}ms <= USB ${c.PROJ_FETCH_TIMEOUT_MS}ms - BLE's 20-byte ` +
    `notifies are the slower, less reliable pipe and need the longer allowance ` +
    `(SCROLL_FETCH_TIMEOUT_BLE_MS/_MS's own relationship)`);

  // STRUCTURAL, bound to the function's own BODY. fnBody() THROWS if the
  // signature is not found at all - a renamed or deleted tickProjectsFetch()
  // fails this assertion loudly (via the catch below) rather than silently
  // reading whichever OTHER function happens to sit nearby, which is exactly
  // the class of vacuous pass CLAUDE.md's "bind to a function body, not the
  // file" rule exists to rule out. requestProjects() ALSO touches
  // projectsPending (setting it true) - a check that merely grepped the
  // whole file for `projectsPending = false;` would still pass if
  // tickProjectsFetch() itself never cleared it, as long as SOME other
  // function happened to.
  let tickBody = "";
  try {
    tickBody = fnBody(projSrc, "void tickProjectsFetch() {", "projects.ino");
  } catch (e) {
    fails.push("tickProjectsFetch() clears projectsPending on timeout");
    fails.push("tickProjectsFetch() sets projectsFetchFailed on timeout");
    console.log(`  FAIL  tickProjectsFetch() clears projectsPending on timeout: ${e.message}`);
    console.log(`  FAIL  tickProjectsFetch() sets projectsFetchFailed on timeout: ${e.message}`);
  }
  if (tickBody) {
    assert(fails, "tickProjectsFetch() clears projectsPending on timeout",
      /projectsPending\s*=\s*false;/.test(tickBody),
      "no `projectsPending = false;` inside tickProjectsFetch()'s own body - a fetch that " +
      "times out would leave every LATER request refused as \"busy\" forever");
    assert(fails, "tickProjectsFetch() sets projectsFetchFailed on timeout",
      /projectsFetchFailed\s*=\s*true;/.test(tickBody),
      "no `projectsFetchFailed = true;` inside tickProjectsFetch()'s own body - the tab " +
      "would silently keep showing \"Loading projects...\" with nothing that ever explains it");
  }

  return fails;
}

// projects.ino's real text, comments stripped - read once, reused by the
// ordinary run. --selftest's structural fault below reads and mutates its
// own copy rather than this one, so the two never interfere.
function loadProjSrc() {
  return stripComments("projects.ino");
}

function loadConsts() {
  return consts("board_es3c35p.h");
}

// A MUTATED copy of projects.ino's text, comments stripped, for the
// structural fault below - reads the file itself (not through geom-common's
// read(), whose own fault machinery this checker deliberately does not use;
// see the header note on why a plain in-process string replace is enough
// when the fault is a numeric override, and is extended here to a literal
// text removal for the one structural fault that needs it). The negative
// lookbehind excludes `bool projectsPending = false;` (the declaration,
// line ~28) - there is exactly one OTHER occurrence, the assignment inside
// tickProjectsFetch(), which is the one this fault removes.
function faultedProjSrcNoPendingClear() {
  const raw = fs.readFileSync(`${DIR}/projects.ino`, "utf8");
  const mutated = raw.replace(/(?<!bool )projectsPending = false;\n/, "");
  if (mutated === raw) throw new Error("fault did not match anything - the line moved or was renamed");
  return mutated.replace(/^[ \t]*\/\/.*$/gm, ""); // stripComments()'s own transform
}

function main() {
  const selftest = process.argv.includes("--selftest");

  if (!selftest) {
    console.log("PROJECTS geometry (board 2):");
    const fails = checkAll(loadConsts(), loadProjSrc());
    console.log(fails.length ? `${fails.length} FAILED` : "all assertions passed");
    process.exit(fails.length ? 1 : 0);
  }

  let ok = true;

  // Two faults, each a POST-PARSE override of PROJ_ROW_H alone - simulating
  // a source edit to that one constant with PROJ_ROWS (a separate
  // declaration) left as the real header states it, which is what the long
  // note above checkAll() explains is the only way to make the footer check
  // fail at all. Each fault must break the ONE assertion the brief names, BY
  // THAT ASSERTION'S NAME - not merely "something failed" - or the checker
  // has no teeth.
  const constFaults = [
    ["PROJ_ROW_H bumped to 60 (a taller row than PROJ_ROWS was sized for)",
      { PROJ_ROW_H: 60 }, "the last project row fits above the footer"],
    ["PROJ_ROW_H dropped to 30 (under this board's TAP_MIN)",
      { PROJ_ROW_H: 30 }, "a project row is at least a fingertip"],
    // Fix round 1: BLE's own timeout dropped to (incorrectly) equal USB's -
    // proves the relational assertion actually compares the two rather than
    // merely checking each is positive, which any real declared value would
    // pass regardless of which board's own number it was. DERIVED from the
    // real parsed PROJ_FETCH_TIMEOUT_MS (a function, not a literal object
    // like the two faults above) rather than a transcribed number: fix
    // round 2 lowered PROJ_FETCH_TIMEOUT_MS from 20000 to 8000, and a fault
    // still reading "20000" here would have gone on "passing" - i.e. NOT
    // triggering the assertion at all, a MISSED result this checker itself
    // caught the moment the header changed underneath it. This is exactly
    // "a checker must parse the constant it certifies, never transcribe it"
    // (CLAUDE.md), applied to the fault's own target value, not only to the
    // assertion being tested.
    ["PROJ_FETCH_TIMEOUT_BLE_MS dropped to equal PROJ_FETCH_TIMEOUT_MS",
      (c) => ({ PROJ_FETCH_TIMEOUT_BLE_MS: c.PROJ_FETCH_TIMEOUT_MS }),
      "PROJECTS' BLE fetch timeout is longer than its USB one"],
  ];
  const projSrc = loadProjSrc();
  for (const [label, override, want] of constFaults) {
    console.log(`selftest: ${label}`);
    const base = loadConsts();
    const applied = typeof override === "function" ? override(base) : override;
    const c = { ...base, ...applied };
    const fails = checkAll(c, projSrc);
    if (fails.includes(want)) {
      console.log(`  caught  ${want}`);
    } else {
      console.log(`  MISSED  expected "${want}" to fail, by name, and it did not`);
      ok = false;
    }
  }

  // STRUCTURAL fault (fix round 1): tickProjectsFetch() loses the one line
  // that makes a retry possible after a timeout - the exact regression this
  // whole fix round exists to prevent from ever shipping silently again.
  // Real constants (unfaulted), mutated SOURCE - the two fault mechanisms
  // are independent and this proves the structural assertion on its own.
  {
    const label = "tickProjectsFetch() loses `projectsPending = false;` " +
                  "(the exact bug this fix round was filed to prevent)";
    const want = "tickProjectsFetch() clears projectsPending on timeout";
    console.log(`selftest: ${label}`);
    let fails;
    try {
      fails = checkAll(loadConsts(), faultedProjSrcNoPendingClear());
    } catch (e) {
      console.log(`  MISSED  fault injection itself failed: ${e.message}`);
      ok = false;
      fails = [];
    }
    if (fails.includes(want)) {
      console.log(`  caught  ${want}`);
    } else {
      console.log(`  MISSED  expected "${want}" to fail, by name, and it did not`);
      ok = false;
    }
  }

  console.log(ok ? "selftest: all faults caught by name" : "selftest: FAILED");
  process.exit(ok ? 0 : 1);
}

main();
