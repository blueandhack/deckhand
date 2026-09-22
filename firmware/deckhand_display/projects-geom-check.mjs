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
//
// TASK 6 FIX ROUND 1 added the assertion over deckhand_display.ino's own
// `projsess` absorption in handleLine() (NOT projects.ino - the one place
// this checker reads a second firmware file). The shipped version cleared
// `psessPending = false;` UNCONDITIONALLY, before the `strcmp(k,
// projOpenKey)` staleness check that decides whether the REPLY'S DATA is
// stale. That check protected the data correctly but not the flag: a late,
// stale reply (wrong project) would still force the pending flag false out
// from under a DIFFERENT, genuinely in-flight request for the CURRENT
// project - defeating that request's busy guard and, because
// checkFetchTimeout() returns early on `!pending`, permanently disabling
// its own timeout. That is the exact stuck-forever defect this whole
// mechanism exists to prevent, re-entered through the one door the
// existing assertions did not watch (they bind to projects.ino's
// checkFetchTimeout()/tickProjectsFetch(), never to the CALL SITE in
// handleLine() that decides which branch actually clears the flag) - so a
// regression here was invisible to every assertion in this file, to every
// OTHER geometry checker, and to a screenshot. The new assertion binds to
// the absorption block's own text (extractBlock() below, the same
// throw-rather-than-guess discipline fnBody() uses) and checks the
// STRUCTURE directly: `psessPending = false;` must not appear before the
// `strcmp(...) == 0) {` branch opens, and must appear inside it.
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

// ONE ANCHOR TO A MATCHING SECOND ANCHOR, both required - fnBody()'s own
// "throw rather than guess" discipline, for a block that is not a whole
// function (handleLine() is thousands of lines and binding to ALL of it
// would satisfy "a rule a neighbouring line can satisfy is not a rule" in
// exactly the way CLAUDE.md warns against: almost anything in that
// function would make a regex "pass"). THROWS if either anchor is missing,
// rather than silently returning empty text that would let a caller read
// an assertion as vacuously true.
function extractBlock(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`extractBlock: start marker not found for ${label}`);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error(`extractBlock: end marker not found for ${label}`);
  return src.slice(a, b + endMarker.length);
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
// `projSrc`/`mainSrc` are projects.ino's/deckhand_display.ino's text with
// comments stripped (real, unless --selftest's structural faults below are
// overriding one of them) - passed in rather than read here so the SAME
// checkAll() serves both the ordinary run and every faulted one, which is
// what makes "does reverting the fix make this fail, by name" a real
// question rather than a rhetorical one.
function checkAll(c, projSrc, mainSrc) {
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

  // ---- the rail (both levels reuse these three - board_es3c35p.h's own
  // note beside PROJ_RAIL_X: PSESS_ROW_X/W alias PROJ_ROW_X/W, so one rail
  // geometry serves both lists rather than a second that could drift) ----
  assert(fails, "the rail does not overlap the rows",
    c.PROJ_RAIL_X >= c.PROJ_ROW_X + c.PROJ_ROW_W,
    `PROJ_RAIL_X(${c.PROJ_RAIL_X}) < PROJ_ROW_X(${c.PROJ_ROW_X}) + PROJ_ROW_W(${c.PROJ_ROW_W}) = ` +
    `${c.PROJ_ROW_X + c.PROJ_ROW_W} - the rail would be drawn on top of a row's own right edge`);

  assert(fails, "the rail fits on the panel",
    c.PROJ_RAIL_X + c.PROJ_RAIL_W <= c.BOARD_W,
    `PROJ_RAIL_X(${c.PROJ_RAIL_X}) + PROJ_RAIL_W(${c.PROJ_RAIL_W}) = ` +
    `${c.PROJ_RAIL_X + c.PROJ_RAIL_W} > BOARD_W(${c.BOARD_W}) - the rail would be drawn ` +
    `off the right edge of the panel`);

  assert(fails, "the rail's thumb has a stated minimum",
    c.PROJ_RAIL_MIN_THUMB > 0,
    `PROJ_RAIL_MIN_THUMB(${c.PROJ_RAIL_MIN_THUMB}) is not a positive floor - a very long list ` +
    `would shrink the thumb to nothing, which is ungrabbable rather than merely small`);

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

  // ---- THE PROJECT KEY BUFFER ----
  //
  // A project key is a real filesystem path with its separators rewritten, so
  // NOTHING caps its length: not the host, not the wire, not the device. It
  // shipped at 64 bytes against a measured worst case of 80 - four of this
  // Mac's sixteen projects were truncated at 63 characters, and copyField()
  // truncates SILENTLY, so the row still listed (its name comes from the
  // transcript's cwd, not the key) and only the tap failed, as "No sessions
  // found" for a project that had just claimed N.
  //
  // THREE SEPARATELY PARSED CONSTANTS, never one compared against its own
  // definition ("X >= Y where X is declared = Y always holds", CLAUDE.md): the
  // header states what was MEASURED, what headroom is wanted, and what the
  // buffer IS, and this asserts the relation between them. Shrinking the buffer
  // back - or raising the measured worst case past it after a deeper worktree
  // appears - fails here, by name.
  assert(fails, "the project key buffer holds the measured worst case with headroom",
    c.PROJ_KEY_MAX >= c.PROJ_KEY_MEASURED_MAX + c.PROJ_KEY_HEADROOM,
    `PROJ_KEY_MAX(${c.PROJ_KEY_MAX}) is under PROJ_KEY_MEASURED_MAX(${c.PROJ_KEY_MEASURED_MAX}) + ` +
    `PROJ_KEY_HEADROOM(${c.PROJ_KEY_HEADROOM}) = ${c.PROJ_KEY_MEASURED_MAX + c.PROJ_KEY_HEADROOM} - ` +
    `a key past the buffer is truncated by copyField() with no warning, listed correctly at ` +
    `level 1, and then asks the host for a directory that does not exist`);

  // ONE CONSTANT, THREE DECLARATIONS - ProjInfo.key (the stored key), the
  // extern (deckhand_display.ino's view of it) and projOpenKey (the COPY level 2
  // compares every reply against). The two used to be independent literals that
  // happened to agree; if they ever stop agreeing, the staleness strcmp compares
  // a full key against a shorter copy of itself and discards every reply as
  // stale - a level 2 that loads forever. Bound to the DECLARATIONS themselves,
  // so a literal reintroduced anywhere in the trio fails by name.
  assert(fails, "ProjInfo.key, its extern and projOpenKey are all sized from PROJ_KEY_MAX",
    /char key\[PROJ_KEY_MAX\]/.test(mainSrc) &&
      /extern char projOpenKey\[PROJ_KEY_MAX\]/.test(mainSrc) &&
      /char projOpenKey\[PROJ_KEY_MAX\] = ""/.test(projSrc),
    "one of ProjInfo.key / extern projOpenKey / projOpenKey's definition is sized by a " +
    "literal rather than by PROJ_KEY_MAX - the three hold the SAME string and a " +
    "disagreement truncates a copy of a key that was already checked to fit");

  // The wire line that CARRIES the key must be sized from the same constant:
  // a request buffer that fits yesterday's key length truncates on the way OUT
  // instead of on the way in, which is the identical defect one step later.
  {
    const reqBody = fnBody(projSrc, "void requestProjSessions(const char* key) {", "projects.ino");
    assert(fails, "requestProjSessions() sizes its wire buffers from PROJ_KEY_MAX",
      (reqBody.match(/char m\[PROJ_KEY_MAX \+ \d+\]/g) || []).length === 2,
      "requestProjSessions() does not size BOTH of its line buffers (the busy report and the " +
      "PROJSESS request itself) from PROJ_KEY_MAX - at `char m[80]` an 80-character key loses " +
      "its tail on the wire, which is the truncation PROJ_KEY_MAX exists to prevent, moved " +
      "one step downstream");
  }

  // ---- fix round 1: the stale-reply guard must protect the PENDING FLAG,
  // not only the DATA ----
  //
  // Bound to the `projsess` absorption block in deckhand_display.ino's
  // handleLine() - extractBlock() THROWS if either anchor is missing, so a
  // renamed/restructured block fails this loudly rather than silently
  // reading something else nearby. The end anchor is the `#endif` that
  // already closes this block today (verified against the real file, not
  // assumed) - it is unique enough in this narrow a window that a false
  // match would require another `#if BOARD_HAS_PROJECTS` region to open
  // and close entirely between the two anchors, which nothing here does.
  let projsessBlock = "";
  try {
    projsessBlock = extractBlock(
      mainSrc,
      'JsonObject projsess = doc["projsess"];',
      "\n#endif\n",
      "deckhand_display.ino's `projsess` absorption");
  } catch (e) {
    fails.push("psessPending is cleared only inside the key-matched branch");
    console.log(`  FAIL  psessPending is cleared only inside the key-matched branch: ${e.message}`);
  }
  if (projsessBlock) {
    // THE BRANCH ITSELF must exist and `psessPending = false;` must sit
    // STRICTLY AFTER where it opens - never before it (the shipped bug:
    // clearing the flag unconditionally, ahead of the check that decides
    // whether this reply's DATA is even current). Locating the branch by
    // its own opening line, not merely searching for the assignment
    // anywhere in the block, is what makes this a structural check on
    // WHERE the clear happens rather than merely THAT it happens somewhere
    // - "a rule a neighbouring line can satisfy is not a rule" applied to
    // this task's own regression.
    const branchOpen = "strcmp(k, projOpenKey) == 0) {";
    const branchAt = projsessBlock.indexOf(branchOpen);
    const beforeBranch = branchAt >= 0 ? projsessBlock.slice(0, branchAt) : projsessBlock;
    const insideAndAfter = branchAt >= 0 ? projsessBlock.slice(branchAt) : "";
    assert(fails, "psessPending is cleared only inside the key-matched branch",
      branchAt >= 0 &&
        !/psessPending\s*=\s*false;/.test(beforeBranch) &&
        /psessPending\s*=\s*false;/.test(insideAndAfter),
      branchAt < 0
        ? "could not locate the `strcmp(k, projOpenKey) == 0)` branch at all inside the " +
          "`projsess` absorption block"
        : /psessPending\s*=\s*false;/.test(beforeBranch)
        ? "`psessPending = false;` appears BEFORE the key-matched branch opens - a stale " +
          "reply (wrong key, correctly DISCARDED as data) would still clear the pending flag " +
          "for a DIFFERENT, currently in-flight request, defeating its busy guard and " +
          "permanently disabling its own timeout (checkFetchTimeout() returns early on " +
          "`!pending`) - the exact stuck-forever defect this mechanism exists to prevent"
        : "`psessPending = false;` does not appear anywhere inside the key-matched branch - " +
          "a fresh, CURRENT reply would never clear the flag it set, leaving every later " +
          "request for this level refused as \"busy\" forever");
  }

  // ---- tab-switch fix: PROJECTS must force its own cache-bust guard stale,
  // not rely on a level change ----
  //
  // Bound to switchTab()'s OWN BODY in deckhand_display.ino (fnBody() THROWS
  // if the signature moves, rather than silently reading the wrong text
  // nearby) - never to the file at large, per "a rule a neighbouring line
  // can satisfy is not a rule" (CLAUDE.md). switchTab()'s PROJECTS arm
  // always resets `projLevel = 0;`, and renderProjectsTab()'s own repaint is
  // gated on `projLevelPainted != projLevel` (projects.ino) - a guard fed
  // by state THIS function also owns. Switching SESSIONS -> PROJECTS ->
  // SESSIONS -> PROJECTS leaves both projLevel and projLevelPainted at 0
  // across the second switch, so that guard sees no change and busts
  // NOTHING onto a content area switchTab() just fillRect()'d blank - no
  // rows, no loading/failed/empty state, nothing on the glass. The fix
  // (exitScrollback()'s own idiom, projLevelPainted = -1, immediately after
  // the fillRect that invalidates it) makes every tab-in touch to PROJECTS
  // read as never-painted, exactly like the very first entry.
  let switchTabBody = "";
  try {
    switchTabBody = fnBody(mainSrc, "void switchTab(Tab newTab) {", "deckhand_display.ino");
  } catch (e) {
    fails.push("switchTab()'s PROJECTS arm forces projLevelPainted stale");
    console.log(`  FAIL  switchTab()'s PROJECTS arm forces projLevelPainted stale: ${e.message}`);
  }
  if (switchTabBody) {
    // Locate the PROJECTS arm the same way the psessPending check locates
    // ITS branch: by the line that opens it, not by searching the whole
    // function - `projLevelPainted = -1;` written ANYWHERE else in
    // switchTab() (e.g. left over in the USAGE or SESSIONS arm) must not
    // satisfy this.
    const armOpen = "} else if (currentTab == TAB_PROJECTS) {";
    const armAt = switchTabBody.indexOf(armOpen);
    // The arm ends at the next "} else {" (SETTINGS' own arm) - both are
    // real, present lines in the function today.
    const armEnd = armAt >= 0 ? switchTabBody.indexOf("} else {", armAt) : -1;
    const armBody = armAt >= 0 && armEnd > armAt ? switchTabBody.slice(armAt, armEnd) : "";
    assert(fails, "switchTab()'s PROJECTS arm forces projLevelPainted stale",
      armAt >= 0 && armEnd > armAt && /projLevelPainted\s*=\s*-1;/.test(armBody),
      armAt < 0 || armEnd <= armAt
        ? "could not locate the PROJECTS arm inside switchTab()'s body at all"
        : "no `projLevelPainted = -1;` inside switchTab()'s PROJECTS arm - renderProjectsTab()'s " +
          "own repaint is gated on `projLevelPainted != projLevel`, and this arm always resets " +
          "projLevel to 0, so a SECOND tab-in (SESSIONS -> PROJECTS -> SESSIONS -> PROJECTS) " +
          "leaves both already at 0: the guard sees no change, busts no cache, and paints " +
          "NOTHING onto the content area this same function just cleared - a blank PROJECTS " +
          "tab with no rows, no loading/failed/empty state, and a live footer clock");
  }

  return fails;
}

// projects.ino's/deckhand_display.ino's real text, comments stripped - each
// read once, reused by the ordinary run. --selftest's structural faults
// below read and mutate their own copy rather than these, so the two never
// interfere.
function loadProjSrc() {
  return stripComments("projects.ino");
}

function loadMainSrc() {
  return stripComments("deckhand_display.ino");
}

function loadConsts() {
  return consts("board_es3c35p.h");
}

// A MUTATED copy of ONE firmware file's text, comments stripped, for the
// structural faults below - reads the file itself (not through geom-common's
// read(), whose own fault machinery this checker deliberately does not use;
// a plain in-process string replace is enough when the fault is a literal
// text removal). Each fault throws if its own anchor text is not found
// exactly once, rather than silently matching nothing (or the wrong thing).
// `file` is the firmware source's bare name ("projects.ino" or
// "deckhand_display.ino") - the two fetch-timeout mechanisms this checker
// proves span both files, so this needed generalizing past projects.ino
// alone (it used to be named faultedProjSrc() and take no `file` argument).
function faultedSrc(file, pattern, replacement, label) {
  const raw = fs.readFileSync(`${DIR}/${file}`, "utf8");
  const mutated = raw.replace(pattern, replacement);
  if (mutated === raw) throw new Error(`fault "${label}" did not match anything - the anchor text moved or was renamed`);
  return mutated.replace(/^[ \t]*\/\/.*$/gm, ""); // stripComments()'s own transform
}

function main() {
  const selftest = process.argv.includes("--selftest");

  if (!selftest) {
    console.log("PROJECTS geometry (board 2):");
    const fails = checkAll(loadConsts(), loadProjSrc(), loadMainSrc());
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
    // The rail's own three faults. DERIVED from the parsed row geometry
    // rather than a transcribed offset - the same "a checker must parse the
    // constant it certifies" reasoning the BLE-timeout fault above states at
    // length, applied to the rail's own overlap boundary instead of to a
    // duration.
    ["PROJ_RAIL_X pulled back onto the rows themselves",
      (c) => ({ PROJ_RAIL_X: c.PROJ_ROW_X + c.PROJ_ROW_W - 1 }),
      "the rail does not overlap the rows"],
    ["PROJ_RAIL_X pushed past the panel's right edge",
      (c) => ({ PROJ_RAIL_X: c.BOARD_W - c.PROJ_RAIL_W + 1 }),
      "the rail fits on the panel"],
    ["PROJ_RAIL_MIN_THUMB dropped to zero (no floor at all)",
      { PROJ_RAIL_MIN_THUMB: 0 }, "the rail's thumb has a stated minimum"],
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
    // CRITICAL 2: the buffer shrunk back to the 64 that truncated four of this
    // Mac's sixteen real projects. DERIVED from the parsed measured worst case
    // rather than transcribed as "64", for the reason the BLE-timeout fault
    // above states at length: a fault holding a stale literal stops triggering
    // the moment the header moves, and reports a MISS nobody reads as one.
    ["PROJ_KEY_MAX shrunk under the measured worst case",
      (c) => ({ PROJ_KEY_MAX: c.PROJ_KEY_MEASURED_MAX - 16 }),
      "the project key buffer holds the measured worst case with headroom"],
  ];
  const projSrc = loadProjSrc();
  const mainSrc = loadMainSrc();
  for (const [label, override, want] of constFaults) {
    console.log(`selftest: ${label}`);
    const base = loadConsts();
    const applied = typeof override === "function" ? override(base) : override;
    const c = { ...base, ...applied };
    const fails = checkAll(c, projSrc, mainSrc);
    if (fails.includes(want)) {
      console.log(`  caught  ${want}`);
    } else {
      console.log(`  MISSED  expected "${want}" to fail, by name, and it did not`);
      ok = false;
    }
  }

  // Structural faults - real constants (unfaulted), mutated SOURCE in ONE
  // of the two firmware files (`file` says which; the OTHER file is passed
  // through real/unmutated). The fault mechanisms here are independent of
  // the const overrides above AND of each other, so each proves its own
  // assertion on its own.
  const structuralFaults = [
    // CRITICAL 2's own regression: projOpenKey back to a literal, disagreeing
    // with ProjInfo.key. Must fail by the SIZING assertion's name and nothing
    // else - the key-length arithmetic assertion reads constants, not this text.
    ["projects.ino", /char projOpenKey\[PROJ_KEY_MAX\] = "";/, 'char projOpenKey[64] = "";',
      "projOpenKey re-sized by a literal 64, disagreeing with ProjInfo.key",
      "ProjInfo.key, its extern and projOpenKey are all sized from PROJ_KEY_MAX"],
    // The same defect one step downstream: the request line itself back to the
    // fixed 80 that truncated an 80-character key on the way out.
    ["projects.ino", /char m\[PROJ_KEY_MAX \+ 16\];/, "char m[80];",
      "requestProjSessions()'s PROJSESS line buffer back to a literal 80",
      "requestProjSessions() sizes its wire buffers from PROJ_KEY_MAX"],
    // Fix round 1's original regression, relocated: the one line that makes
    // a retry possible after a timeout now lives in checkFetchTimeout()
    // (shared by both levels) rather than in tickProjectsFetch() itself,
    // so the fault has to target the NEW location to still mean anything -
    // a fault still aimed at the old text would silently match nothing
    // (faultedSrc() throws rather than let that pass as "caught").
    ["projects.ino", /  pending = false;\n/, "",
      "checkFetchTimeout() loses `pending = false;` (fix round 1's original bug, relocated)",
      "checkFetchTimeout() clears its own pending flag on timeout"],
    // Task 6's own regression to guard against: level 2 stops being routed
    // through the shared helper at all (as if it had grown its own separate,
    // un-timed-out fetch, or a duplicated tick nobody wired up correctly).
    ["projects.ino",
      /\n  if \(checkFetchTimeout\(psessPending, psessFetchStart, "PROJSESS"\)\) \{\n    psessFetchFailed = true;\n    if \(currentTab == TAB_PROJECTS\) renderProjectsTab\(\);\n  \}\n/, "\n",
      "tickProjectsFetch() loses its level-2 (PROJSESS) arm entirely",
      "tickProjectsFetch() covers level 2's PROJSESS fetch too, not a separate duplicated tick"],
    // Task 6 FIX ROUND 1's own regression, reproduced exactly: the fix
    // moved `psessPending = false;` from BEFORE the key-matched branch to
    // INSIDE it. This fault moves it back - the precise text this round
    // shipped before the finding, so "does reverting the fix make this
    // fail, by name" is a literal statement here, not a metaphor.
    ["deckhand_display.ino",
      '    if (strcmp(k, projOpenKey) == 0) {\n      psessPending = false;\n',
      '    psessPending = false;\n    if (strcmp(k, projOpenKey) == 0) {\n',
      "psessPending = false; moved back outside the key-matched branch (this round's own shipped bug)",
      "psessPending is cleared only inside the key-matched branch"],
    // The tab-switch blank-PROJECTS bug, reproduced exactly: switchTab()'s
    // PROJECTS arm loses the one line that forces renderProjectsTab()'s
    // level-change guard stale. Without it the guard is fed only by
    // projLevel (always reset to 0 by the very next line), so a second
    // tab-in sees no change and busts nothing.
    ["deckhand_display.ino",
      "    projLevelPainted = -1;\n    requestProjects();",
      "    requestProjects();",
      "switchTab()'s PROJECTS arm loses `projLevelPainted = -1;`",
      "switchTab()'s PROJECTS arm forces projLevelPainted stale"],
  ];
  for (const [file, pattern, replacement, label, want] of structuralFaults) {
    console.log(`selftest: ${label}`);
    let fails;
    try {
      const faultedProjSrc = file === "projects.ino" ? faultedSrc(file, pattern, replacement, label) : projSrc;
      const faultedMainSrc = file === "deckhand_display.ino" ? faultedSrc(file, pattern, replacement, label) : mainSrc;
      fails = checkAll(loadConsts(), faultedProjSrc, faultedMainSrc);
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
