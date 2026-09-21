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
import { consts } from "./geom-common.mjs";

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
function checkAll(c) {
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

  return fails;
}

function loadConsts() {
  return consts("board_es3c35p.h");
}

function main() {
  const selftest = process.argv.includes("--selftest");

  if (!selftest) {
    console.log("PROJECTS geometry (board 2):");
    const fails = checkAll(loadConsts());
    console.log(fails.length ? `${fails.length} FAILED` : "all assertions passed");
    process.exit(fails.length ? 1 : 0);
  }

  // --selftest: two faults, each a POST-PARSE override of PROJ_ROW_H alone -
  // simulating a source edit to that one constant with PROJ_ROWS (a separate
  // declaration) left as the real header states it, which is what the long
  // note above checkAll() explains is the only way to make the footer check
  // fail at all. Each fault must break the ONE assertion the brief names, BY
  // THAT ASSERTION'S NAME - not merely "something failed" - or the checker
  // has no teeth.
  let ok = true;
  const faults = [
    ["PROJ_ROW_H bumped to 60 (a taller row than PROJ_ROWS was sized for)",
      60, "the last project row fits above the footer"],
    ["PROJ_ROW_H dropped to 30 (under this board's TAP_MIN)",
      30, "a project row is at least a fingertip"],
  ];
  for (const [label, rowH, want] of faults) {
    console.log(`selftest: ${label}`);
    const c = { ...loadConsts(), PROJ_ROW_H: rowH };
    const fails = checkAll(c);
    if (fails.includes(want)) {
      console.log(`  caught  ${want}`);
    } else {
      console.log(`  MISSED  expected "${want}" to fail, by name, and it did not`);
      ok = false;
    }
  }
  console.log(ok ? "selftest: both faults caught by name" : "selftest: FAILED");
  process.exit(ok ? 0 : 1);
}

main();
