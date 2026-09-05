#!/usr/bin/env node
// Checks host/ask-chips.mjs — the token-extraction rules, the ordering that
// makes the byte cap exact, and (once Task 9 lands) the firmware buffer this
// host module is sized for.
//
// Run:  node host/ask-chips-check.mjs
//       node host/ask-chips-check.mjs --selftest    # proves the cap has teeth
//
// THREE ASSERTIONS BELOW ARE EXPECTED TO FAIL, BY NAME, RIGHT NOW. This
// checker parses SessionInfo.askChips's dimensions out of
// firmware/deckhand_display/deckhand_display.ino the way
// host/ask-optdescs-check.mjs:88 parses askDetail's — but Task 9 is the task
// that adds that field, and this repo's rule is that a checker must parse the
// constant it certifies, never transcribe it. So until Task 9 lands, all
// three fail, tagged "PENDING TASK 9". That tag is gated on the parse itself
// failing (dims == null) - NOT applied unconditionally to these three
// messages - so it self-retires the instant Task 9 declares the field: if
// the declared buffer is undersized, the size assertions fail as ORDINARY,
// unlabelled failures instead of being excused as still-pending. That is the
// correct state for this task: the binding is proven by the fact that it can
// fail, not stubbed past, and it stays provable after Task 9 lands too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askChips, CHIP_MAX, CHIP_BYTES } from "./ask-chips.mjs";
import { toAscii } from "./to-ascii.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SELF_SRC = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const MOD_SRC = fs.readFileSync(path.join(HERE, "ask-chips.mjs"), "utf8");
const FW_SRC = fs.readFileSync(path.join(REPO, "firmware", "deckhand_display", "deckhand_display.ino"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// ---------------------------------------------------------------------------
// STEP 1: the cases the spec names (docs/superpowers/specs/2026-09-04-compose-
// surface-design.md, "The token chips: host, wire, firmware", and this task's
// brief). Kept VERBATIM from the brief, and now correct on their own terms:
// CHIP_BYTES was raised from 32 to 48 (commit ddd03f9) specifically BECAUSE
// case 2 below ("/Users/yujia/projects/deckhand/build", 36 bytes) failed
// under 32 — this checker caught that as a documented override rather than
// quietly editing the expectation, which is what made the defect visible.
// Now that CHIP_BYTES covers it, the override is gone; the cap itself is
// still exercised below, by a token that is over 48 bytes.
// ---------------------------------------------------------------------------
const BRIEF_CASES = [
  ["arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/deckhand_display",
   ["--fqbn", "firmware/deckhand_display"]],
  ["Run `npm test -- --watch` in packages/core?",
   ["npm test -- --watch", "--watch", "packages/core"]],
  ["Delete /Users/yujia/projects/deckhand/build and retry?",
   ["/Users/yujia/projects/deckhand/build"]],
  ["Use -f or --force?", ["-f", "--force"]],
  ["No tokens here at all", []],
];

for (const [i, [input, want]] of BRIEF_CASES.entries()) {
  const got = askChips(input, []);
  ok(JSON.stringify(got) === JSON.stringify(want),
     `FLAGS/PATHS/BACKTICKS: case ${i} ${JSON.stringify(input)} -> ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
// Rule 4 (quoted spans) has no case above that needs it alone - add one, plus
// a case proving a token that TWO rules would both match (a quoted flag)
// still appears exactly once, at its first-appearance position.
// ---------------------------------------------------------------------------
ok(JSON.stringify(askChips('Rename the file to "final_report.pdf"?', [])) === JSON.stringify(["final_report.pdf"]),
   'QUOTES: a plain quoted span with no flag/path shape is still a chip');

{
  const got = askChips("Try '--force' now", []);
  ok(JSON.stringify(got) === JSON.stringify(["--force"]),
     `DEDUPE (two rules, one token): "Try '--force' now" -> ["--force"] exactly once, got ${JSON.stringify(got)}`);
}

// Ask text is prose written by Claude, and single quotes are the one
// delimiter English also uses as a letter - contractions and possessives.
// Naively pairing "the nearest two apostrophes" reads "it's" as an opening
// delimiter and "don't" as the closing one, capturing "s fine, don" as a
// chip: a garbage token that occupies one of four scarce slots and reads as
// noise you must look past to reach TYPE. There is no genuine quoted span in
// this sentence at all, so the correct result is [].
{
  const input = "...it's fine, don't you think?";
  const got = askChips(input, []);
  ok(JSON.stringify(got) === JSON.stringify([]),
     `QUOTES (no contraction garbage): ${JSON.stringify(input)} -> [], got ${JSON.stringify(got)}`);
}

// A case where PURE RULE-ORDER concatenation (rule 1 backticks, then rule 2
// flags, then rule 3 paths, then rule 4 quotes) would disagree with TRUE
// POSITIONAL first-appearance order: the flag here sits BEFORE the backtick
// span in the text, so a concatenate-then-dedupe implementation (no
// positional sort) would still emit the backtick match first. This is the
// case that actually distinguishes "sorted by position" from "grouped by
// rule" - the five cases above all happen to agree on both orderings.
{
  const input = "Use --force with `npm test`";
  const got = askChips(input, []);
  ok(JSON.stringify(got) === JSON.stringify(["--force", "npm test"]),
     `ORDERING (position, not rule-order): ${JSON.stringify(input)} -> ["--force","npm test"], got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
// CHIP_MAX: more than four candidates, only the first four (by position) come
// back. This exact case is re-run under --selftest against a module with
// CHIP_MAX raised to 9 - see below.
// ---------------------------------------------------------------------------
const CAP_INPUT = "-a -b -c -d -e";
const CAP_EXPECTED = ["-a", "-b", "-c", "-d"]; // literal 4, not re-derived from CHIP_MAX
function checkCap(fn, label) {
  const got = fn(CAP_INPUT, []);
  return {
    label: `CHIP_MAX cap: "${CAP_INPUT}" yields exactly 4 chips (${label})`,
    passed: JSON.stringify(got) === JSON.stringify(CAP_EXPECTED),
    got,
  };
}
{
  const r = checkCap(askChips, "real module");
  ok(r.passed, `${r.label}, got ${JSON.stringify(r.got)}`);
}

// ---------------------------------------------------------------------------
// CHIP_BYTES: an over-length path is dropped even when a valid short flag
// sits right beside it - the drop does not consume one of the four slots.
// ---------------------------------------------------------------------------
{
  // A real, 59-byte docs path (docs/superpowers/specs/2026-09-04-compose-
  // surface-design.md) - the exact example the coordinator measured as the
  // one path CHIP_BYTES=48 does NOT cover. Not constructed: this is a real
  // file in this repo.
  const longPath = "docs/superpowers/specs/2026-09-04-compose-surface-design.md";
  ok(Buffer.byteLength(longPath, "utf8") > CHIP_BYTES, "PARSE SANITY: the docs path really is over CHIP_BYTES");
  const got = askChips(`Check -x or ${longPath} and stop`, []);
  ok(JSON.stringify(got) === JSON.stringify(["-x"]),
     `CHIP_BYTES drop: an over-length path (${Buffer.byteLength(longPath, "utf8")} bytes, over CHIP_BYTES=${CHIP_BYTES}) is dropped, only "-x" remains, got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
// opts: a chip that exactly restates an existing option label is redundant
// with the button already on screen, and is suppressed.
// ---------------------------------------------------------------------------
{
  const got = askChips("Use -f or --force?", ["-f"]);
  ok(JSON.stringify(got) === JSON.stringify(["--force"]),
     `OPTS SUPPRESSION: a chip matching an existing option label ("-f") is dropped, got ${JSON.stringify(got)}`);
  ok(JSON.stringify(askChips("Use -f or --force?")) === JSON.stringify(["-f", "--force"]),
     "opts defaults to [] when omitted entirely");
}

// opts is trimmed before comparison (`.trim().toLowerCase()`); a chip
// candidate must be trimmed the same way or a quoted span that happens to
// carry the delimiter's own whitespace ("Allow " with a trailing space,
// captured verbatim by DQUOTE_RE) escapes suppression by a whitespace
// technicality and duplicates a button already on screen.
{
  const got = askChips('Say "Allow " now', ["Allow"]);
  ok(JSON.stringify(got) === JSON.stringify([]),
     `OPTS SUPPRESSION (whitespace): a chip matching an option label except for surrounding whitespace ("Allow ") is still suppressed, got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
// A real ask shape, sampled from claude-hooks/fixtures/codex-permission-
// request.json's tool_input.command - see the task report for why this
// stands in for a live corpus (none was available on this machine).
// ---------------------------------------------------------------------------
{
  const detail = "curl -sI https://example.com | head -1"; // ti.command, verbatim
  const got = askChips(detail, ["Allow", "Deny"]);
  ok(JSON.stringify(got) === JSON.stringify(["-sI", "https://example.com"]),
     `REAL-SHAPE (perm fixture): ${JSON.stringify(detail)} -> ${JSON.stringify(got)}`);
}

// Empty result is a valid result, not a crash and not a placeholder. Call
// once per input and reuse the result - the previous version called
// askChips twice per assertion (once inside Array.isArray(...), again for
// .length), doubling the work for no reason and risking the two calls
// silently diverging if the function were ever not pure.
{
  const gotEmpty = askChips("", []);
  ok(Array.isArray(gotEmpty) && gotEmpty.length === 0, "EMPTY: empty detail yields []");
}
{
  const gotUndef = askChips(undefined, []);
  ok(Array.isArray(gotUndef) && gotUndef.length === 0, "EMPTY: undefined detail yields [], not a throw");
}

// ---------------------------------------------------------------------------
// STEP 2: extraction runs AFTER toAscii, so the byte cap is exact.
//
// The two statements below are real, sequential, and executed - not a
// presence check on one combined pattern. There is no production call site
// yet (Task 9 wires this into host/index.mjs); the only real call site that
// exists today is this checker's own invocation, so that is what is bound.
// ---------------------------------------------------------------------------
const ORDER_XLATE_STMT = 'const orderedAscii = toAscii("Run `café --wîde` now");';
const ORDER_CHIPS_STMT = "const orderedChips = askChips(orderedAscii, []);";

const orderedAscii = toAscii("Run `café --wîde` now");
const orderedChips = askChips(orderedAscii, []);
ok(orderedChips.length > 0, "ORDERING SANITY: the café/wîde case actually produces chips to check");
for (const c of orderedChips) {
  ok(Buffer.byteLength(c, "utf8") === c.length,
     `ORDERING: chip ${JSON.stringify(c)} is ASCII, so its byte cap is its character cap`);
}

// Structural half of the ordering rule, as a genuine INDEX COMPARISON of two
// separate statements - the shape host/wire-bytes-check.mjs uses at :100-103
// (comparing the index of the voice path's transliterate-and-cap line
// against the index of the line that later parks and hashes it). A single
// combined regex like /askChips\(toAscii\(/ is a PRESENCE check: it is
// satisfied the instant that substring exists ANYWHERE in this file,
// including inside a comment, and says nothing about the order of two
// things relative to each other. This instead locates the two real
// statements just executed above and compares their positions in this
// file's own source.
// lastIndexOf, not indexOf: ORDER_XLATE_STMT/ORDER_CHIPS_STMT above are
// THEMSELVES string literals containing this exact text, so a plain indexOf
// would match its own constant declaration (always in the same order,
// regardless of what the REAL executed statements below do) rather than the
// real statements. The LAST occurrence of each is always the executed one.
function orderingHolds(src) {
  const xlateIdx = src.lastIndexOf(ORDER_XLATE_STMT);
  const chipsIdx = src.lastIndexOf(ORDER_CHIPS_STMT);
  return xlateIdx >= 0 && chipsIdx >= 0 && xlateIdx < chipsIdx;
}
ok(SELF_SRC.includes(ORDER_XLATE_STMT), "PARSE SANITY: the toAscii statement text is findable in this checker's own source");
ok(SELF_SRC.includes(ORDER_CHIPS_STMT), "PARSE SANITY: the askChips statement text is findable in this checker's own source");
ok(orderingHolds(SELF_SRC),
   "ORDERING (structural, index comparison): this checker's own toAscii(...) statement's INDEX is lower than the askChips(...) statement's INDEX that consumes its result");

// The module itself must stay pure: it is the CALLER's job to transliterate
// first, exactly once. If askChips.mjs ever calls toAscii internally, a
// caller that already transliterated would double-run it, and one that
// didn't would be silently "fixed" here - hiding the ordering bug this whole
// rule exists to prevent, rather than surfacing it. Comments are stripped
// first: this module's own documentation talks ABOUT toAscii (it must, to
// explain the calling convention) without ever CALLING it, and a check that
// didn't tell those apart would fail on its own doc comments.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const strippedMod = stripComments(MOD_SRC);
// Positive anchors FIRST: a negative test (`!/toAscii/.test(...)`) passes
// vacuously on an empty or accidentally-emptied string, exactly the
// `!/re/.test("")` trap this plan's rules name. Prove the read and the strip
// both actually produced real content, and that a KNOWN real declaration
// survived the strip, before trusting the negative result.
ok(MOD_SRC.length > 0, "PARSE SANITY: ask-chips.mjs was read and is non-empty");
ok(strippedMod.length > 0, "PARSE SANITY: stripComments left non-trivial code behind (did not eat the whole file)");
ok(/export function askChips/.test(strippedMod),
   "PARSE SANITY: stripComments left askChips's real declaration intact - the negative test below is not passing vacuously");
ok(!/toAscii/.test(strippedMod),
   "ORDERING (purity): ask-chips.mjs does not call toAscii itself outside its own comments - the ordering is the CALLER's responsibility, asserted rather than assumed");

// ---------------------------------------------------------------------------
// STEP 3: PARSE the firmware's buffer, do not restate 32/48. EXPECTED TO FAIL
// until Task 9 adds the field - see the file header.
//
// The "PENDING TASK 9" label is gated on `dims == null` (the field does not
// exist yet), NOT applied unconditionally to these three messages. That
// distinction is the whole point: once Task 9 declares `askChips[N][M]`,
// `dims` parses successfully, and the label disappears on its own - so if
// the declared buffer is undersized (e.g. `[4][34]` instead of `[4][50]`),
// assertions 2 and 3 fail as ORDINARY, unlabelled failures and the checker
// exits 1. A prefix applied unconditionally to these three messages would
// have kept excusing a wrong buffer forever, which is exactly the bug this
// gating fixes.
// ---------------------------------------------------------------------------
{
  const dims = FW_SRC.match(/char askChips\[(\d+)\]\[(\d+)\];/);
  const tag = (msg) => (dims == null ? "PENDING TASK 9: " : "") + msg;
  ok(dims != null, tag("SessionInfo declares askChips[N][M] in firmware/deckhand_display/deckhand_display.ino"));
  ok(dims != null && +dims[1] >= CHIP_MAX,
     tag(`askChips holds >= CHIP_MAX (${CHIP_MAX}) chips - dims[1]=${dims ? dims[1] : "n/a"}`));
  ok(dims != null && +dims[2] >= CHIP_BYTES + 1,
     tag(`askChips[][>=${CHIP_BYTES + 1}] holds CHIP_BYTES (${CHIP_BYTES}) bytes plus a NUL - dims[2]=${dims ? dims[2] : "n/a"}`));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const PENDING_PREFIX = "PENDING TASK 9:";
const pendingFailures = failures.filter((f) => f.startsWith(PENDING_PREFIX));
const realFailures = failures.filter((f) => !f.startsWith(PENDING_PREFIX));

console.log(`ask-chips: ${pass} passed, ${failures.length} failed (${pendingFailures.length} expected-pending on Task 9, ${realFailures.length} unexpected)`);
for (const f of realFailures) console.log(`  FAIL ${f}`);
for (const f of pendingFailures) console.log(`  ${f}`);

// ---------------------------------------------------------------------------
// --selftest: inject the fault the brief names - raise CHIP_MAX to 9 - into
// an ACTUAL copy of the module (not a hand-written mirror: a mirror proves
// the algorithm and binds nothing, per this repo's own rule), and confirm
// the cap assertion is the one that catches it, by name.
//
// The catching assertion must NOT compare against the mutated module's own
// (also mutated) CHIP_MAX - that would be circular and could never fail. It
// compares against the literal 4 chips CAP_EXPECTED already asserts above,
// which is the real, external expectation this repo actually wants.
//
// A previous version stopped there and gated success ONLY on `caught`. Two
// defects followed from that:
//   - a real, unrelated failure from the base run above (STEP 1-3) was
//     printed in the Report section but never affected `--selftest`'s exit
//     code, so `--selftest` could exit 0 while genuine bugs sat unaddressed.
//   - "the cap assertion, and only it, must catch this" was asserted in a
//     console.log and never tested: nothing re-ran the OTHER assertions
//     against the mutated module to confirm the fault stayed confined to the
//     cap. A prior sanity check here (`bad.CHIP_MAX === 9`) could not
//     independently fail anyway - the `mutated === MOD_SRC` guard above it
//     already proves a replacement landed, and "export const CHIP_MAX = 4;"
//     appears exactly once in ask-chips.mjs, so reaching this point already
//     guarantees bad.CHIP_MAX is 9. It has been replaced with checks that
//     can actually fail on their own.
// Both are fixed below: the exit code now depends on the base run's real
// failures too, and on the mutated module's BEHAVIOUR staying identical to
// the real module everywhere BRIEF_CASES exercises it except the cap.
// ---------------------------------------------------------------------------
async function selftest() {
  console.log("\nselftest: raising CHIP_MAX to 9 in a mutated copy of ask-chips.mjs.");
  console.log("          the cap assertion, and only it, must catch this - by name.\n");

  const mutated = MOD_SRC.replace(
    "export const CHIP_MAX = 4;",
    "export const CHIP_MAX = 9; // FAULT INJECTED by ask-chips-check.mjs --selftest",
  );
  if (mutated === MOD_SRC) {
    console.log("selftest FAILED: could not find \"export const CHIP_MAX = 4;\" to mutate - the injection itself is broken");
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-chips-selftest-"));
  const tmpFile = path.join(tmpDir, "ask-chips.mjs");
  fs.writeFileSync(tmpFile, mutated);
  let bad;
  try {
    bad = await import(pathToFileURL(tmpFile).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const r = checkCap(bad.askChips, "MUTATED module, CHIP_MAX=9");
  const caught = !r.passed;
  console.log(caught
    ? `selftest passed: the cap assertion ("${r.label}") FAILS by name against the CHIP_MAX=9 module - got ${JSON.stringify(r.got)}, expected ${JSON.stringify(CAP_EXPECTED)}`
    : `selftest FAILED: raising CHIP_MAX to 9 did not make the cap assertion fail - it is blind to this bug`);

  // "and only it": CHIP_BYTES must not have moved (the replace targets only
  // the CHIP_MAX declaration's own line), and every BRIEF_CASES input - none
  // of which depends on CHIP_MAX - must still produce its real-module answer
  // under the mutated module. If either check fires, the fault leaked beyond
  // the cap and the console.log claim above was false.
  let isolated = true;
  if (bad.CHIP_BYTES !== CHIP_BYTES) {
    isolated = false;
    console.log(`selftest FAILED: "and only it" is false - CHIP_BYTES moved too (${CHIP_BYTES} -> ${bad.CHIP_BYTES}), the fault is not confined to the cap`);
  }
  for (const [i, [input, want]] of BRIEF_CASES.entries()) {
    const got = bad.askChips(input, []);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      isolated = false;
      console.log(`selftest FAILED: "and only it" is false - BRIEF_CASES[${i}] ${JSON.stringify(input)} diverged under the mutation: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  if (isolated) {
    console.log('selftest passed: "and only it" holds - CHIP_BYTES and every BRIEF_CASES input are unaffected by the CHIP_MAX=9 mutation');
  }

  // The base run above (STEP 1-3) may have left real, non-pending failures
  // on the table - those are genuine bugs unrelated to this fault injection
  // and must not be masked just because the injected fault was caught.
  if (realFailures.length) {
    console.log(`selftest FAILED: ${realFailures.length} unexpected failure(s) from the base run are being ignored:`);
    for (const f of realFailures) console.log(`  FAIL ${f}`);
  }

  process.exit(caught && isolated && realFailures.length === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  process.exit(realFailures.length ? 1 : 0);
}
