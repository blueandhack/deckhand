// PROJECTS tab geometry checker - board 2 only (PROJECTS is out of scope for
// board 1 by design, docs/superpowers/specs/2026-09-20-sessions-manager-
// design.md, "Out of scope: Board 1"), runs on the Mac, needs no hardware.
//
// LEVEL 1 (the project list) and LEVEL 2 (one project's own sessions) both
// live here, task-5-brief.md's four assertions plus task-6-brief.md's three
// PSESS_* ones (the last row fits above the footer, a row clears the
// fingertip floor, the title lane holds at least 24 characters), each with
// the same "recompute the derived step rather than trust it" anti-
// tautology shape PROJ's own check uses - see the long note on `step`
// below, unchanged in spirit for PSESS_STEP.
//
//   node projects-geom-check.mjs             check board 2
//   node projects-geom-check.mjs --selftest  prove the checker has teeth
//
// FIX ROUND 1 (level 1) added two assertions over the fetch-timeout
// mechanism that replaced an unrecoverable stuck-forever "Loading
// projects..." state reachable by one dropped BLE reply.
//
// TASK 6 EXTENDED THAT MECHANISM TO COVER LEVEL 2 RATHER THAN DUPLICATING
// IT - projects.ino's tickProjectsFetch() now times out BOTH levels' own
// fetches through one shared helper, checkFetchTimeout(), instead of a
// second copy of the timeout arithmetic. The structural assertions below
// were rewritten to match: one binds to checkFetchTimeout()'s OWN body
// (the one place either level's pending flag is actually cleared), and two
// bind to tickProjectsFetch()'s body proving it routes BOTH levels through
// that helper - the second of those two is the one that would have failed,
// by name, had level 2 grown its own separate tick/timeout copy instead of
// reusing this one (CLAUDE.md, this exact task: "reuse the existing
// mechanism rather than duplicating it... if you find yourself writing the
// same condition twice, extract it, because a comment claiming a shared
// predicate that was not shared was a finding on this very file one round
// ago").
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

// `c` is the header's own parsed constants, OPTIONALLY with PROJ_ROW_H/
// PSESS_ROW_H/PSESS_PAD overridden by --selftest. Every other assertion
// below reads `c` exactly as consts() parsed it from board_es3c35p.h; only
// the "last row fits" checks recompute their own STEP from ROW_H + ROW_GAP
// rather than trusting c.PROJ_STEP/c.PSESS_STEP, and that is deliberate,
// not an inconsistency:
//
// PROJ_ROWS (and PSESS_ROWS the identical way) is declared in the header as
// `(AVAIL + ROW_GAP) / STEP` - a floor division - and floor division has a
// property that makes "ROW_Y0 + ROWS * STEP - ROW_GAP <= BOARD_H -
// FOOTER_H" hold for ANY value of STEP, because ROWS always shrinks to
// keep ROWS * STEP <= AVAIL + ROW_GAP by construction. Editing ROW_H in the
// real header and letting STEP/ROWS RE-DERIVE from it (which is what
// actually happens on a real edit) can therefore never overrun the footer -
// the assertion as literally written would be the "X >= Y where X is
// declared = Y" defect CLAUDE.md names, if STEP were taken from the
// already-re-derived c.PROJ_STEP/c.PSESS_STEP.
//
// What CAN drift, and has ("the group set has already been re-cut three
// times on this branch" - CLAUDE.md, of a different constant) is ROW_H
// changing while ROWS - a SEPARATE declaration - is not correspondingly
// revisited. So the check recomputes STEP from the two more primitive
// terms and pairs it with ROWS AS DECLARED, which is exactly the
// combination a source edit to ROW_H alone would produce before anyone
// touched ROWS - and exactly what --selftest's const faults inject.
// `projSrc` is projects.ino's text with comments stripped (real, unless
// --selftest's structural fault below is overriding it) - passed in rather
// than read here so the SAME checkAll() serves both the ordinary run and the
// faulted one, which is what makes "does reverting the fix make this fail,
// by name" a real question rather than a rhetorical one.
function checkAll(c, projSrc) {
  const fails = [];

  // ---- Level 1: the project list ----
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

  // ---- Level 2: one project's sessions (task-6-brief.md's own three) ----
  const stepP = c.PSESS_ROW_H + c.PSESS_ROW_GAP;
  const lastRowBottomP = c.PSESS_ROW_Y0 + c.PSESS_ROWS * stepP - c.PSESS_ROW_GAP;
  assert(fails, "the last session row fits above the footer",
    lastRowBottomP <= c.BOARD_H - c.FOOTER_H,
    `${lastRowBottomP} > ${c.BOARD_H - c.FOOTER_H}`);

  assert(fails, "a session row is at least a fingertip",
    c.PSESS_ROW_H >= c.TAP_MIN,
    `${c.PSESS_ROW_H} < ${c.TAP_MIN}`);

  // NOT tied to a PSESS_NAME_CHARS constant - there isn't one. The task's
  // own spec states the promise as a literal ("title lane >= 24
  // characters"), the same shape PROJ_SLOTS' own ">= 16" assertion above
  // takes its literal from the design doc's measured project count rather
  // than a header constant - so this computes the real available width
  // from PSESS_ROW_W/PSESS_PAD/TEXT_ADV (all parsed) and compares it
  // against that literal directly.
  const psessTitleChars = Math.floor((c.PSESS_ROW_W - 2 * c.PSESS_PAD) / c.TEXT_ADV);
  assert(fails, "the title lane holds at least 24 characters",
    psessTitleChars >= 24,
    `${psessTitleChars} < 24 (PSESS_ROW_W ${c.PSESS_ROW_W} - 2*PSESS_PAD ${c.PSESS_PAD} = ` +
    `${c.PSESS_ROW_W - 2 * c.PSESS_PAD}, / TEXT_ADV ${c.TEXT_ADV})`);

  // The three narrower derivation checks, PROJ's own three mirrored over
  // PSESS_* - see the long header note above for why these exist alongside
  // (not instead of) the footer check.
  assert(fails, "PSESS_STEP is PSESS_ROW_H + PSESS_ROW_GAP",
    c.PSESS_STEP === c.PSESS_ROW_H + c.PSESS_ROW_GAP,
    `${c.PSESS_STEP} != ${c.PSESS_ROW_H} + ${c.PSESS_ROW_GAP}`);
  assert(fails, "PSESS_AVAIL is BOARD_H - FOOTER_H - PSESS_ROW_Y0",
    c.PSESS_AVAIL === c.BOARD_H - c.FOOTER_H - c.PSESS_ROW_Y0,
    `${c.PSESS_AVAIL} != ${c.BOARD_H} - ${c.FOOTER_H} - ${c.PSESS_ROW_Y0}`);
  assert(fails, "PSESS_ROWS is floor((PSESS_AVAIL + PSESS_ROW_GAP) / PSESS_STEP)",
    c.PSESS_ROWS === Math.floor((c.PSESS_AVAIL + c.PSESS_ROW_GAP) / c.PSESS_STEP),
    `${c.PSESS_ROWS} != floor((${c.PSESS_AVAIL} + ${c.PSESS_ROW_GAP}) / ${c.PSESS_STEP})`);

  assert(fails, "PSESS_SLOTS covers the largest project measured on this Mac",
    c.PSESS_SLOTS >= 22,
    `${c.PSESS_SLOTS} < 22`);

  // ---- fetch timeout, extended to level 2 (task 6) ----
  //
  // STRUCTURAL, bound to REAL function bodies - never to the file at large
  // ("a rule a neighbouring line can satisfy is not a rule", CLAUDE.md) -
  // via geom-common's fnBody(), which THROWS if a signature is not found at
  // all, so a renamed or deleted function fails these loudly rather than
  // silently reading whichever other line happens to match nearby.
  let helperBody = "";
  try {
    helperBody = fnBody(
      projSrc,
      "bool checkFetchTimeout(bool& pending, unsigned long start, const char* label) {",
      "projects.ino");
  } catch (e) {
    fails.push("checkFetchTimeout() clears its own pending flag on timeout");
    console.log(`  FAIL  checkFetchTimeout() clears its own pending flag on timeout: ${e.message}`);
  }
  if (helperBody) {
    assert(fails, "checkFetchTimeout() clears its own pending flag on timeout",
      /pending\s*=\s*false;/.test(helperBody),
      "no `pending = false;` inside checkFetchTimeout()'s own body - a fetch that times out " +
      "on EITHER level would leave every LATER request for that level refused as \"busy\" forever, " +
      "since both levels' requests route through this one helper");
  }

  let tickBody = "";
  try {
    tickBody = fnBody(projSrc, "void tickProjectsFetch() {", "projects.ino");
  } catch (e) {
    fails.push("tickProjectsFetch() covers level 1's PROJECTS fetch");
    fails.push("tickProjectsFetch() covers level 2's PROJSESS fetch too, not a separate duplicated tick");
    console.log(`  FAIL  tickProjectsFetch() covers level 1's PROJECTS fetch: ${e.message}`);
    console.log(`  FAIL  tickProjectsFetch() covers level 2's PROJSESS fetch too, not a separate duplicated tick: ${e.message}`);
  }
  if (tickBody) {
    // requestProjects() ALSO touches projectsPending (setting it true) - a
    // check that merely grepped the whole file for the failure flag would
    // still pass if tickProjectsFetch() itself never routed level 1's own
    // fetch through the shared helper at all, as long as SOME other
    // function happened to set it. Binding to checkFetchTimeout(projectsPending
    // proves the ROUTING, not merely the flag's eventual value.
    assert(fails, "tickProjectsFetch() covers level 1's PROJECTS fetch",
      /checkFetchTimeout\(projectsPending/.test(tickBody) && /projectsFetchFailed\s*=\s*true;/.test(tickBody),
      "tickProjectsFetch() no longer routes PROJECTS' own fetch through checkFetchTimeout() and " +
      "sets projectsFetchFailed on timeout - level 1's fix-round-1 guarantee regressed");
    // THE KEY NEW ASSERTION FOR THIS TASK: proves level 2 REUSES the same
    // helper rather than growing a second, independently-tunable copy of
    // the timeout arithmetic (or, worse, no timeout discipline at all,
    // which is the defect this whole mechanism exists to prevent). Revert
    // this task's extension of tickProjectsFetch() - drop the psessPending
    // arm - and this fails BY NAME while every other assertion in this
    // file stays green, which is exactly "does reverting the fix make
    // this fail, by name" (CLAUDE.md).
    assert(fails, "tickProjectsFetch() covers level 2's PROJSESS fetch too, not a separate duplicated tick",
      /checkFetchTimeout\(psessPending/.test(tickBody) && /psessFetchFailed\s*=\s*true;/.test(tickBody),
      "tickProjectsFetch() does not also route PROJSESS' own fetch through checkFetchTimeout() - " +
      "level 2's own reply can be lost the same way level 1's can and nothing here reports it, " +
      "or level 2 grew its OWN separate tick/timeout instead of reusing this one (CLAUDE.md: " +
      "\"reuse the existing mechanism rather than duplicating it\")");
  }

  return fails;
}

// projects.ino's real text, comments stripped - read once, reused by the
// ordinary run. --selftest's structural faults below read and mutate their
// own copy rather than this one, so the two never interfere.
function loadProjSrc() {
  return stripComments("projects.ino");
}

function loadConsts() {
  return consts("board_es3c35p.h");
}

// A MUTATED copy of projects.ino's text, comments stripped, for the
// structural faults below - reads the file itself (not through geom-common's
// read(), whose own fault machinery this checker deliberately does not use;
// a plain in-process string replace is enough when the fault is a literal
// text removal). Each fault throws if its own anchor text is not found
// exactly once, rather than silently matching nothing (or the wrong thing).
function faultedProjSrc(pattern, replacement, label) {
  const raw = fs.readFileSync(`${DIR}/projects.ino`, "utf8");
  const mutated = raw.replace(pattern, replacement);
  if (mutated === raw) throw new Error(`fault "${label}" did not match anything - the anchor text moved or was renamed`);
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

  // Const faults, each a POST-PARSE override of one constant alone -
  // simulating a source edit to that one term with its own ROWS (a
  // separate declaration) left as the real header states it, which is what
  // the long note above checkAll() explains is the only way to make a
  // footer check fail at all. Each fault must break the ONE assertion the
  // brief names, BY THAT ASSERTION'S NAME - not merely "something failed" -
  // or the checker has no teeth.
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
    // Task 6: the SAME two shapes, over PSESS_ROW_H - proves level 2's own
    // footer/fingertip checks have real teeth, independently of level 1's.
    ["PSESS_ROW_H bumped to 60 (a taller row than PSESS_ROWS was sized for)",
      { PSESS_ROW_H: 60 }, "the last session row fits above the footer"],
    ["PSESS_ROW_H dropped to 30 (under this board's TAP_MIN)",
      { PSESS_ROW_H: 30 }, "a session row is at least a fingertip"],
    // Task 6: PSESS_PAD widened enough to push the title lane under 24
    // characters - (296 - 2*60) / 8 = 22 < 24 - proving the new lane-width
    // assertion is a real computation over the parsed constants and not a
    // check that always happens to pass at today's numbers.
    ["PSESS_PAD widened to 60 (crowds the title lane under 24 characters)",
      { PSESS_PAD: 60 }, "the title lane holds at least 24 characters"],
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

  // Structural faults - real constants (unfaulted), mutated SOURCE. The two
  // fault mechanisms (const overrides above, source mutations here) are
  // independent, so each proves its own assertion on its own.
  const structuralFaults = [
    // Fix round 1's original regression, relocated: the one line that makes
    // a retry possible after a timeout now lives in checkFetchTimeout()
    // (shared by both levels) rather than in tickProjectsFetch() itself,
    // so the fault has to target the NEW location to still mean anything -
    // a fault still aimed at the old text would silently match nothing
    // (faultedProjSrc() throws rather than let that pass as "caught").
    [/  pending = false;\n/, "",
      "checkFetchTimeout() loses `pending = false;` (fix round 1's original bug, relocated)",
      "checkFetchTimeout() clears its own pending flag on timeout"],
    // Task 6's own regression to guard against: level 2 stops being routed
    // through the shared helper at all (as if it had grown its own separate,
    // un-timed-out fetch, or a duplicated tick nobody wired up correctly).
    [/\n  if \(checkFetchTimeout\(psessPending, psessFetchStart, "PROJSESS"\)\) \{\n    psessFetchFailed = true;\n    if \(currentTab == TAB_PROJECTS\) renderProjectsTab\(\);\n  \}\n/, "\n",
      "tickProjectsFetch() loses its level-2 (PROJSESS) arm entirely",
      "tickProjectsFetch() covers level 2's PROJSESS fetch too, not a separate duplicated tick"],
  ];
  for (const [pattern, replacement, label, want] of structuralFaults) {
    console.log(`selftest: ${label}`);
    let fails;
    try {
      fails = checkAll(loadConsts(), faultedProjSrc(pattern, replacement, label));
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
