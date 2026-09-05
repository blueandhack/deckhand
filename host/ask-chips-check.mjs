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
// constant it certifies, never transcribe it. So until Task 9 lands, the
// PARSE assertion fails with "askChips[N][M] - Task 9 adds it", and the two
// size assertions that depend on it fail as NaN comparisons. That is the
// correct state for this task: the binding is proven by the fact that it can
// fail, not stubbed past.
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
// brief). Kept VERBATIM from the brief for traceability, with one documented
// correction below.
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

// DISCREPANCY FOUND WHILE VERIFYING (not assumed — measured with
// Buffer.byteLength): the brief's case 3 path is
// "/Users/yujia/projects/deckhand/build", which is 36 BYTES, not <= 32.
// CHIP_BYTES=32 is not a number this checker can bend to fit one example —
// it mirrors the firmware's askOpts[4][34] cap (34 = 32 usable chars + NUL),
// which Task 9's askChips buffer is sized from. A cap that let this one
// example through would let a genuinely oversized chip overrun that buffer.
// So the CORRECT output for this exact input is [] (the only candidate is
// the oversized path, and it is dropped) — verified by literally disabling
// the byte-cap drop below and confirming the path reappears (see "cap has
// teeth" section). Rule 3 (paths) is independently exercised, well under the
// cap, by case 1's "firmware/deckhand_display" (25 bytes).
const EXPECTED_OVERRIDES = new Map([
  [2, { expected: [], why: "the listed path is 36 bytes, over CHIP_BYTES=32 - correctly dropped, not returned" }],
]);

for (const [i, [input, want]] of BRIEF_CASES.entries()) {
  const override = EXPECTED_OVERRIDES.get(i);
  const expected = override ? override.expected : want;
  const got = askChips(input, []);
  const label = override
    ? `case ${i} ${JSON.stringify(input)} -> ${JSON.stringify(expected)} (${override.why})`
    : `case ${i} ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`;
  ok(JSON.stringify(got) === JSON.stringify(expected),
     `FLAGS/PATHS/BACKTICKS: ${label}, got ${JSON.stringify(got)}`);
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
  const longPath = "/" + "a".repeat(40);
  ok(Buffer.byteLength(longPath, "utf8") > CHIP_BYTES, "PARSE SANITY: the constructed long path really is over CHIP_BYTES");
  const got = askChips(`Check -x or ${longPath} and stop`, []);
  ok(JSON.stringify(got) === JSON.stringify(["-x"]),
     `CHIP_BYTES drop: an over-length path (${Buffer.byteLength(longPath, "utf8")} bytes) is dropped, only "-x" remains, got ${JSON.stringify(got)}`);
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

// Empty result is a valid result, not a crash and not a placeholder.
ok(Array.isArray(askChips("", [])) && askChips("", []).length === 0, "EMPTY: empty detail yields []");
ok(Array.isArray(askChips(undefined, [])) && askChips(undefined, []).length === 0, "EMPTY: undefined detail yields [], not a throw");

// ---------------------------------------------------------------------------
// STEP 2: extraction runs AFTER toAscii, so the byte cap is exact.
// ---------------------------------------------------------------------------
{
  const chips = askChips(toAscii("Run `café --wîde` now"), []);
  ok(chips.length > 0, "ORDERING SANITY: the café/wîde case actually produces chips to check");
  for (const c of chips) {
    ok(Buffer.byteLength(c, "utf8") === c.length,
       `ORDERING: chip ${JSON.stringify(c)} is ASCII, so its byte cap is its character cap`);
  }
}

// Structural half of the ordering rule, in the same shape
// host/wire-bytes-check.mjs uses at :100-103 (nested-call composition proves
// the transliteration is the INNERMOST call, i.e. runs first): this file's
// own call sites must compose `askChips(toAscii(...), ...)`, never the other
// way round.
ok(/askChips\(toAscii\(/.test(SELF_SRC),
   "ORDERING (structural): this checker's own call sites compose askChips(toAscii(...)), the same shape wire-bytes-check.mjs binds the voice path to");

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
ok(!/toAscii/.test(stripComments(MOD_SRC)),
   "ORDERING (purity): ask-chips.mjs does not call toAscii itself outside its own comments - the ordering is the CALLER's responsibility, asserted rather than assumed");

// ---------------------------------------------------------------------------
// STEP 3: PARSE the firmware's buffer, do not restate 32. EXPECTED TO FAIL
// until Task 9 adds the field - see the file header.
// ---------------------------------------------------------------------------
{
  const dims = FW_SRC.match(/char askChips\[(\d+)\]\[(\d+)\];/);
  ok(dims != null, "PENDING TASK 9: SessionInfo declares askChips[N][M] in firmware/deckhand_display/deckhand_display.ino");
  ok(dims && +dims[1] >= CHIP_MAX, `PENDING TASK 9: askChips holds >= CHIP_MAX (${CHIP_MAX}) chips - dims[1]=${dims ? dims[1] : "n/a"}`);
  ok(dims && +dims[2] >= CHIP_BYTES + 1, `PENDING TASK 9: askChips[][>=${CHIP_BYTES + 1}] holds CHIP_BYTES (${CHIP_BYTES}) bytes plus a NUL - dims[2]=${dims ? dims[2] : "n/a"}`);
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

  ok(bad.CHIP_MAX === 9, "selftest sanity: the mutated module really does report CHIP_MAX=9");

  const r = checkCap(bad.askChips, "MUTATED module, CHIP_MAX=9");
  const caught = !r.passed;
  console.log(caught
    ? `selftest passed: the cap assertion ("${r.label}") FAILS by name against the CHIP_MAX=9 module - got ${JSON.stringify(r.got)}, expected ${JSON.stringify(CAP_EXPECTED)}`
    : `selftest FAILED: raising CHIP_MAX to 9 did not make the cap assertion fail - it is blind to this bug`);
  process.exit(caught ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  process.exit(realFailures.length ? 1 : 0);
}
