#!/usr/bin/env node
// Exercises reorderSessions()'s ordering without a device. Run with no arguments to
// check the shipped comparator. Run with --selftest to prove the checker has teeth:
// re-runs the longest-waiting cases against the recency comparator this change replaced.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. This runs a JS MIRROR of the comparator,
// so it proves the ALGORITHM - including the millis() wrap case, which is otherwise
// unreachable without waiting 49.7 days for real. It does not execute the C++. Two
// things narrow that gap: urgencyRank's mapping is PARSED out of the sketch rather
// than transcribed here, so a rank that changes in the firmware changes here too;
// and the structural assertions below read the real source text.
import fs from "fs";
import path from "path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");

// ---------- parse, never transcribe ----------
// urgencyRank is the one piece of the key that is a table rather than arithmetic, so
// it is read out of the sketch. A rank renamed or renumbered in the firmware must
// change this checker's expectations with it, not silently disagree.
function parseUrgencyRank(src) {
  const at = src.indexOf("int urgencyRank(");
  if (at < 0) throw new Error("urgencyRank() not found - has it been renamed?");
  const body = src.slice(at, src.indexOf("\n}", at));
  const named = {};
  let stripped = body;
  for (const m of body.matchAll(/strcmp\(status,\s*"(\w+)"\)\s*==\s*0\)\s*return\s+(\d+)/g)) {
    named[m[1]] = Number(m[2]);
    stripped = stripped.replace(m[0], "");
  }
  const d = stripped.match(/return\s+(\d+)\s*;/);
  if (!d) throw new Error("urgencyRank() has no default return");
  if (Object.keys(named).length === 0) throw new Error("urgencyRank() parsed no named statuses");
  return { named, dflt: Number(d[1]) };
}
const RANKS = parseUrgencyRank(SRC);
const rankOf = (status) => (status in RANKS.named ? RANKS.named[status] : RANKS.dflt);

// ---------- the mirror ----------
const U32 = 0x100000000;
// Unsigned-wrap-safe elapsed, exactly what (now - since) does in C with unsigned long.
const elapsed = (now, since) => ((now - since) % U32 + U32) % U32;

// legacy=true reproduces the comparator this change replaces (recency-ranked asking ties).
// Used by --selftest to verify the new longest-waiting rule is actually provable.
function sortsBefore(b, a, now, legacy) {
  const ra = rankOf(a.status), rb = rankOf(b.status);
  if (rb !== ra) return rb < ra;
  if (!legacy && ra === 0) return elapsed(now, b.since) > elapsed(now, a.since);
  return b.actSec > a.actSec;
}

// Mirrors reorderSessions()'s stable insertion sort, break and all.
function order(sessions, now, legacy = false) {
  const ord = sessions.map((_, i) => i);
  for (let i = 1; i < sessions.length; i++) {
    for (let j = i; j > 0; j--) {
      if (!sortsBefore(sessions[ord[j]], sessions[ord[j - 1]], now, legacy)) break;
      const t = ord[j - 1]; ord[j - 1] = ord[j]; ord[j] = t;
    }
  }
  return ord.map((i) => sessions[i].name);
}

// ---------- scenarios ----------
const S = (name, status, { since = 0, actSec = 0 } = {}) => ({ name, status, since, actSec });
let fails = [], count = 0;
function eq(label, got, want) {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(`${label}\n         got  ${g}\n         want ${w}`);
}

// The mapping itself, as parsed.
count++;
if (!(rankOf("asking") < rankOf("waiting") && rankOf("waiting") < rankOf("working")))
  fails.push(`urgencyRank must order asking < waiting < working (parsed ${JSON.stringify(RANKS)})`);

const NOW = 1_000_000;
// THE CHANGE. Two asking rows: the one waiting LONGEST leads.
eq("two asking: the longer wait leads",
   order([S("fresh", "asking", { since: NOW - 5_000 }), S("stale", "asking", { since: NOW - 1_200_000 })], NOW),
   ["stale", "fresh"]);
eq("two asking: order of arrival does not decide it",
   order([S("stale", "asking", { since: NOW - 1_200_000 }), S("fresh", "asking", { since: NOW - 5_000 })], NOW),
   ["stale", "fresh"]);

// Rank still dominates the tie-break.
eq("asking outranks waiting outranks working, whatever the times",
   order([S("w", "working", { actSec: 86_000 }), S("r", "waiting", { actSec: 86_000 }),
          S("a", "asking", { since: NOW - 1_000 })], NOW),
   ["a", "r", "w"]);

// Unchanged behaviour for the other two ranks.
eq("two waiting: most RECENT leads (unchanged)",
   order([S("old", "waiting", { actSec: 100 }), S("new", "waiting", { actSec: 900 })], NOW),
   ["new", "old"]);
eq("two working: most RECENT leads (unchanged)",
   order([S("old", "working", { actSec: 100 }), S("new", "working", { actSec: 900 })], NOW),
   ["new", "old"]);
eq("actSec -1 (not today) sorts LAST within its rank",
   order([S("yesterday", "waiting", { actSec: -1 }), S("today", "waiting", { actSec: 5 })], NOW),
   ["today", "yesterday"]);

// The wrap. Unreachable on hardware without a 49.7-day uptime.
const NEAR = U32 - 10_000;          // 10s before millis() wraps
eq("millis() wrap: a wait that spans the wrap still reads as the longer one",
   order([S("after", "asking", { since: (NEAR + 9_000) % U32 }),   // waited ~6s
          S("across", "asking", { since: NEAR - 600_000 })], 5_000),  // waited ~10m
   ["across", "after"]);

// Stability: equal keys keep arrival order, which is the host's own urgency sort.
eq("equal keys keep arrival order (stable sort)",
   order([S("first", "working", { actSec: 500 }), S("second", "working", { actSec: 500 })], NOW),
   ["first", "second"]);

// Everything above this line runs a JS MIRROR of the comparator: it proves the
// algorithm, not the sketch. Only the structural assertions below read the real
// source text, so the count is split in the final report rather than lumped
// together as one undifferentiated "N assertions pass".
const MIRROR_COUNT = count;

// ---------- selftest ----------
// The same teeth-proving convention as palette-check.mjs --selftest: re-run the
// ordering scenarios against the comparator this change REPLACED, and exit 0 only
// when the longest-waiting cases FAIL against it. A checker that passes against
// both the old and the new rule is not testing the rule.
if (process.argv.includes("--selftest")) {
  const legacyCases = [
    ["two asking: the longer wait leads",
      () => order([S("fresh", "asking", { since: NOW - 5_000 }),
                   S("stale", "asking", { since: NOW - 1_200_000 })], NOW, true),
      ["stale", "fresh"]],
    // actSec differs here (100/900) even though the main-scenario case of the same
    // name does not: the legacy comparator's tie-break reads actSec, so with no
    // difference in actSec this case would pass under BOTH rules and prove nothing.
    ["two asking: order of arrival does not decide it",
      () => order([S("stale", "asking", { since: NOW - 1_200_000, actSec: 100 }),
                   S("fresh", "asking", { since: NOW - 5_000, actSec: 900 })], NOW, true),
      ["stale", "fresh"]],
    ["millis() wrap: a wait that spans the wrap still reads as the longer one",
      () => order([S("after", "asking", { since: (NEAR + 9_000) % U32 }),
                   S("across", "asking", { since: NEAR - 600_000 })], 5_000, true),
      ["across", "after"]],
  ];
  const blind = legacyCases.filter(([, run, want]) =>
    JSON.stringify(run()) === JSON.stringify(want));
  if (blind.length) {
    console.error("");
    for (const [label] of blind)
      console.error("  SELFTEST FAILED: this case passes against the OLD comparator too - " + label);
    console.error(`\n${blind.length} of ${legacyCases.length} cases cannot tell the two rules apart.`);
    process.exit(1);
  }
  console.log(`selftest ok - all ${legacyCases.length} cases reject the old recency-ranked comparator`);
  process.exit(0);
}

// ---------- structural assertions on the real source ----------
// Text-matched deliberately, and safe to match here: unlike the panel_shim case this
// repo documents, none of these lines sits behind an #if, so nothing can delete the
// line the regex just found.
function structural(label, ok) { count++; if (!ok) fails.push(label); }
// Strip `//` line comments before scanning a body for a real call - sessionSortsBefore's
// own body TALKS ABOUT millis() in a comment ("millis() wraps at ~49.7 days") without
// calling it, and a naive substring/regex test over the raw body would count that
// prose as a clock read.
const stripLineComments = (s) => s.replace(/\/\/[^\n]*/g, "");

// The parameter names `b` and `a` are pinned here deliberately, not left as `\w+`.
// Assertion 3 below assumes "b" is the earlier-declared parameter and reads the
// tie-break's operand order off THOSE NAMES, so this signature match is what makes
// that assumption true rather than merely convenient. With `\w+` in both slots this
// assertion (and assertion 3) passed just as happily for a signature with the
// parameters swapped or renamed - it proved nothing about which one is "b".
// Strengthened per F4: also reads no clock of its own in its BODY, not merely in
// its signature - a stray `now = millis();` inside the function would otherwise
// pass unnoticed, since the original label claimed that without checking it.
{
  const sigOk = /bool\s+sessionSortsBefore\s*\(\s*const\s+SessionInfo&\s*b\s*,\s*const\s+SessionInfo&\s*a\s*,\s*unsigned\s+long\s+now\s*\)/.test(SRC);
  const defAt = SRC.indexOf("bool sessionSortsBefore(const SessionInfo& b, const SessionInfo& a, unsigned long now) {");
  const endAt = defAt >= 0 ? SRC.indexOf("\n}", defAt) : -1;
  const bodyOk = defAt >= 0 && endAt > defAt && !/millis\(\)/.test(stripLineComments(SRC.slice(defAt, endAt)));
  structural("sessionSortsBefore(b, a, now) takes `now` as an argument and reads no clock of its own in its body",
    sigOk && bodyOk);
}

// Anchored on the DEFINITION ("... reorderSessions() {"), not merely on the name.
// `SRC.indexOf("void reorderSessions(")` also matches a plain forward DECLARATION
// (this file already has one for sessionSortsBefore, at deckhand_display.ino:967,
// the documented Arduino-prototype remedy) - and if reorderSessions() ever grows
// one too, that indexOf finds the declaration first and slices ~200 unrelated
// lines after it instead of the real function body. Those happen to contain
// exactly one millis() today, so the assertion would pass BY COINCIDENCE while
// checking nothing - and a millis() deleted from the real function would go
// unnoticed. The sliced region is also asserted to contain `sessionOrder`, so a
// mis-anchored slice fails LOUDLY (wrong body) rather than passing by luck.
{
  const defAt = SRC.indexOf("void reorderSessions() {");
  const endAt = defAt >= 0 ? SRC.indexOf("\n}", defAt) : -1;
  const body = defAt >= 0 && endAt > defAt ? SRC.slice(defAt, endAt) : "";
  const anchoredRight = defAt >= 0 && endAt > defAt && body.includes("sessionOrder");
  const millisOnce = (stripLineComments(body).match(/millis\(\)/g) || []).length === 1;
  structural("reorderSessions() samples millis() exactly ONCE (a clock that advances mid-sort makes the comparator inconsistent)",
    anchoredRight && millisOnce);
}

// Operands are pinned to `b` then `a`, not `\w+` then `\w+`. The inverted
// comparison `(now - a.statusSinceMillis) > (now - b.statusSinceMillis)` -
// shortest-waiting-first, exactly backwards, the very regression this whole
// change exists to prevent - matched the old `\w+`/`\w+` pattern just as well as
// the correct order, so inverting the two operands in deckhand_display.ino left
// this assertion (and the whole checker) reporting green. See the checker's
// --selftest-adjacent proof in the commit history / final-fix-report.md for the
// before/after run that demonstrates this assertion now catches it.
structural("the asking tie-break compares ELAPSED(b) > ELAPSED(a), not the reverse (b sorts before a when b has waited LONGER)",
  /now\s*-\s*b\.statusSinceMillis\s*\)\s*>\s*\(\s*now\s*-\s*a\.statusSinceMillis/.test(SRC));

// ---------- report ----------
const STRUCTURAL_COUNT = count - MIRROR_COUNT;
if (fails.length) {
  console.error("");
  for (const f of fails) console.error("  FAIL " + f);
  console.error(`\n${fails.length} of ${count} assertions FAILED (${MIRROR_COUNT} mirror + ${STRUCTURAL_COUNT} source)`);
  process.exit(1);
}
console.log(`${MIRROR_COUNT} mirror + ${STRUCTURAL_COUNT} source assertions pass (mirror proves the algorithm only; source binds the sketch)`);
