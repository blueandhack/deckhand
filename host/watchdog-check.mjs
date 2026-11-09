#!/usr/bin/env node
// Checks the poll-loop watchdog's sleep-vs-hang discrimination.
//   node host/watchdog-check.mjs              - assert every claim
//   node host/watchdog-check.mjs --selftest   - prove these checks have teeth
//
// WHY THIS EXISTS. The watchdog fired 236 times across the ledger and every
// one of them logged "an await never settled". In the one run whose log
// survives, ALL FOURTEEN matched a macOS sleep window to within 6 seconds -
// reconstructed from the tick lines' `cxage` field and cross-checked against
// `pmset -g log`. Zero were hangs. The three ~901s ones are macOS's scheduled
// 900-second maintenance sleep, which its own log names: "Entering Sleep state
// due to 'Idle Sleep' ... 900 secs".
//
// The cause is that `Date.now() - lastTickCompleted` cannot tell "a promise
// never settled" from "the machine was suspended": both are wall-clock jumping
// forward with no completed tick. So the watchdog answered with the alarming
// one, and its count - the number that is supposed to say whether the
// supervisor is earning its place - counted sleep cycles instead. Same disease
// as the ledger's STALLED column, which is why both now have a check.
//
// The discriminator needs no monotonic clock: watch whether the WATCHDOG'S OWN
// INTERVAL kept running. A stuck promise leaves the event loop alive, so the
// interval still fires every POLL_INTERVAL_MS; a suspended machine freezes the
// interval too, for as long as the stall itself.
import { readFileSync } from "node:fs";
import { classifyStall, stallMessage, makeAwaitTracker, describePending, PENDING_LIST_CAP } from "./watchdog.mjs";

// ---------------------------------------------------------------------------
// NAMING THE STUCK STEP (2026-11-08). A real hang at 22:24 logged only "an await
// never settled": with ccusage already off the tick's path, nothing said WHICH
// await. Every await on the tick's path now goes through track(), and the hang
// line names whatever is still pending. The structural half below reads
// host/index.mjs itself and fails, BY FUNCTION AND LINE, on any await in the
// tick's path that bypasses track() - a step added later without it would hang
// as anonymously as the one this was written for.
const TRACKED_FUNCTIONS = ["async function tick(", "async function readUsage(", "async function readSessions("];

/// The text between a function's opening brace and its matching close.
function fnBody(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { text: src.slice(open + 1, i), offset: open + 1 };
  }
  return null;
}

/// Blank out comments and string/template literals (same length, so offsets
/// survive) - an `await` in a comment is not an await.
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

/// Nested async functions (arrow or not) are blanked: their awaits run inside a
/// promise the OUTER function awaits, so the outer track() is what names them.
function stripNestedAsync(text) {
  let out = text;
  const re = /\basync\b/g;
  let m;
  while ((m = re.exec(out))) {
    let i = m.index + 5;
    // find the body start: `=> {`, `=> (`, `=> expr`, or a function's `{`
    const arrow = out.indexOf("=>", i);
    const brace = out.indexOf("{", i);
    let start = arrow >= 0 && (brace < 0 || arrow < brace) ? arrow + 2 : brace;
    while (/\s/.test(out[start])) start++;
    const opener = out[start];
    const closer = opener === "{" ? "}" : opener === "(" ? ")" : null;
    let end;
    if (closer) {
      let depth = 0;
      for (end = start; end < out.length; end++) {
        if (out[end] === opener) depth++;
        else if (out[end] === closer && --depth === 0) break;
      }
    } else {
      end = out.slice(start).search(/[,)\n]/) + start - 1;
    }
    out = out.slice(0, m.index) + " ".repeat(end + 1 - m.index) + out.slice(end + 1);
  }
  return out;
}

/// `await Promise.all([a, b, c])` is tracked when EVERY top-level element of the
/// array is itself a track(...) call - each step is then named on its own.
function allElementsTracked(text, at) {
  const head = /^await\s*Promise\.all\(\s*\[/.exec(text.slice(at));
  if (!head) return false;
  let depth = 0, start = at + head[0].length, elems = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) { elems.push(text.slice(start, i)); break; }
      depth--;
    } else if (c === "," && depth === 0) { elems.push(text.slice(start, i)); start = i + 1; }
  }
  elems = elems.map((e) => e.trim()).filter(Boolean);
  return elems.length > 0 && elems.every((e) => /^track\(/.test(e));
}

/// Every await in the tracked functions' own bodies that is not `await track(`.
function untrackedAwaits(src) {
  const found = [];
  for (const sig of TRACKED_FUNCTIONS) {
    const body = fnBody(src, sig);
    if (!body) { found.push(`${sig} not found in host/index.mjs`); continue; }
    const text = stripNestedAsync(code(body.text));
    for (const m of text.matchAll(/\bawait\b(?!\s*track\()/g)) {
      if (allElementsTracked(text, m.index)) continue;
      const line = src.slice(0, body.offset + m.index).split("\n").length;
      found.push(`${sig.replace("async function ", "").replace("(", "()")} line ${line}`);
    }
  }
  return found;
}

/// How many tracked awaits each function has - the structural check must not
/// pass vacuously over a body that has none at all.
function trackedCount(src, sig) {
  const body = fnBody(src, sig);
  return body ? [...stripNestedAsync(code(body.text)).matchAll(/\bawait\s*track\(/g)].length : 0;
}

const INDEX_SRC = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const NOW = 1787600000000;
const INTERVAL = 5_000;   // POLL_INTERVAL_MS
const THRESHOLD = 30_000; // TICK_WATCHDOG_MS
const base = { now: NOW, intervalMs: INTERVAL, thresholdMs: THRESHOLD };

/// A stall of `stalledMs` during which the interval last ran `frozenMs` ago.
const at = (stalledMs, frozenMs) =>
  classifyStall({ ...base, lastTickCompleted: NOW - stalledMs, lastWatchdogRun: NOW - frozenMs });

// ---------------------------------------------------------------------------
// The sleep cases are factored out because --selftest re-runs them against the
// OLD always-a-hang logic and requires every one to fail.
//
// The numbers are real: measured stalls from the Aug 24 run, each matched to a
// macOS sleep window. During sleep the interval cannot run either, so the time
// since its last run is the length of the sleep.
const REAL_SLEEPS = [
  ["a 900s maintenance sleep", 901_000],
  ["a 52s sleep", 53_000],
  ["a 310s sleep", 312_000],
  ["a 1031s sleep", 1_030_000],
  ["a 94s sleep", 93_000],
];

function sleepCases(classify) {
  const cases = [];
  for (const [label, ms] of REAL_SLEEPS) {
    // Timers were frozen for the whole sleep: the interval is as late as the stall.
    const v = classify({ ...base, lastTickCompleted: NOW - ms, lastWatchdogRun: NOW - ms });
    cases.push([`${label} is diagnosed as SUSPENDED, not a hang`, v.verdict === "suspended"]);
    cases.push([`${label} is not counted as a watchdog fire`, v.hung === false]);
  }
  return cases;
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  // The logic as it shipped: any stall past the threshold is a hang.
  const legacy = ({ now, lastTickCompleted, thresholdMs }) => {
    const stalledMs = now - lastTickCompleted;
    return stalledMs < thresholdMs
      ? { verdict: "ok", stalledMs, hung: false }
      : { verdict: "hang", stalledMs, hung: true };
  };
  console.log("selftest: re-running the sleep cases against the OLD always-a-hang logic.");
  console.log("          every one of them MUST fail, or the check is blind to the bug.\n");
  const results = sleepCases(legacy);
  let caught = 0;
  for (const [name, ok] of results) {
    if (ok) console.log(`  NOT CAUGHT  ${name}`);
    else { console.log(`  caught      ${name}`); caught++; }
  }
  // Every tracked await, un-wrapped one at a time, must be reported by name.
  console.log("\nselftest: un-wrapping each tracked await in host/index.mjs in turn.");
  // Compared against the REAL file's own count, so a baseline that already
  // fails cannot make every mutation look caught.
  const baseline = untrackedAwaits(INDEX_SRC).length;
  const sites = [
    ...[...INDEX_SRC.matchAll(/await track\(\s*"([^"]+)",\s*/g)].map((m) => ({ m, keep: "await (" })),
    // An element of a tracked Promise.all, un-wrapped on its own.
    ...[...INDEX_SRC.matchAll(/^\s+track\("([^"]+)",\s*/gm)].map((m) => ({ m, keep: m[0].match(/^\s+/)[0] + "(" })),
  ];
  for (const { m, keep } of sites) {
    const mutated = INDEX_SRC.slice(0, m.index) + keep + INDEX_SRC.slice(m.index + m[0].length);
    const name = `un-wrapping track("${m[1]}") at offset ${m.index} is caught`;
    const hit = untrackedAwaits(mutated).length > baseline;
    results.push([name, !hit]);
    if (hit) { console.log(`  caught      ${name}`); caught++; }
    else console.log(`  NOT CAUGHT  ${name}`);
  }
  // And a hang line that drops the pending list.
  const legacyMsg = (v) => `Poll loop stalled - an await never settled. Restarting it.`;
  const named = legacyMsg({ verdict: "hang", stalledMs: 35_000, timersFrozenMs: 5_000 }).includes("readSessions:codex");
  results.push(["the old hang message names no step", named]);
  if (!named) { console.log("  caught      the old hang message names no step"); caught++; }
  else console.log("  NOT CAUGHT  the old hang message names no step");
  const blind = results.length - caught;
  console.log(
    blind === 0
      ? `\nselftest passed: all ${caught} checks catch the old logic`
      : `\nselftest FAILED: ${blind} check(s) pass against the KNOWN-BAD logic`
  );
  process.exit(blind === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Nothing wrong: the loop is ticking.
check("a fresh tick is not a stall", at(1_000, 1_000).verdict === "ok");
check("a stall just under the threshold is not reported", at(29_999, 4_000).verdict === "ok");
check("an OK verdict is never a fire", at(1_000, 1_000).hung === false);

// A GENUINE hang: the promise never settled, but the event loop is alive, so
// the watchdog's own interval has been firing on schedule throughout.
check("a stall with a HEALTHY interval is a hang", at(35_000, 5_000).verdict === "hang");
check("a hang counts as a watchdog fire", at(35_000, 5_000).hung === true);
check("a long stall with a healthy interval is still a hang", at(900_000, 5_100).verdict === "hang");
check("a hang reports how long the loop was stalled", at(35_000, 5_000).stalledMs === 35_000);

// The interval being a little late is normal under load and must not be read
// as a suspend - that would silently disable the watchdog on a busy machine,
// which is the failure mode that matters most here.
check("an interval running slightly late is still a hang", at(35_000, 12_000).verdict === "hang");
check("an interval late by just under the threshold is still a hang",
  at(60_000, 29_999).verdict === "hang");

// ---- THE BUG ---------------------------------------------------------------
for (const [name, ok] of sleepCases(classifyStall)) check(name, ok);

check("a suspend reports how long the timers were frozen",
  at(901_000, 901_000).timersFrozenMs === 901_000);
check("a suspend still reports the stall length",
  at(901_000, 901_000).stalledMs === 901_000);
check("the boundary case - timers frozen exactly the threshold - reads as suspended",
  at(60_000, 30_000).verdict === "suspended");

// A suspend must still be distinguishable in the log from a hang, because the
// old message asserted a cause it had not established and that is what sent
// this investigation after the BLE stack for a whole round.
check("a hang and a suspend do not share a verdict",
  at(35_000, 5_000).verdict !== at(901_000, 901_000).verdict);

// Defensive: clocks are not guaranteed monotonic across a suspend, and a
// negative interval must not flip the verdict or throw.
check("a lastWatchdogRun in the future does not throw",
  typeof at(35_000, -1_000).verdict === "string");
check("a lastWatchdogRun in the future reads as a healthy interval (a hang)",
  at(35_000, -1_000).verdict === "hang");
check("a negative stall is not a hang", at(-5_000, 1_000).verdict === "ok");

// The very first watchdog run has no previous run to compare against. It must
// not report a suspend for the process's whole uptime.
check("a null lastWatchdogRun is not treated as a suspend",
  classifyStall({ ...base, lastTickCompleted: NOW - 35_000, lastWatchdogRun: null }).verdict === "hang");

// ---- naming the stuck step --------------------------------------------------
{
  let t = 1_000;
  const tracker = makeAwaitTracker(() => t);
  let release;
  const stuck = tracker.track("readSessions:codex", new Promise((r) => { release = r; }));
  t = 2_000;
  const done = tracker.track("heartbeat", Promise.resolve(7));
  check("a tracked promise settles with the wrapped value", (await done) === 7);
  check("a settled step leaves the pending list",
    tracker.pending().map((p) => p.name).join() === "readSessions:codex");
  const rejected = tracker.track("readUsage", Promise.reject(new Error("boom")));
  const err = await rejected.catch((e) => e);
  check("a tracked rejection passes through unchanged", err instanceof Error && err.message === "boom");
  check("a rejected step leaves the pending list too", tracker.pending().length === 1);
  const text = describePending(tracker.pending(), 35_000);
  check("the pending list names the step and its age", text === "readSessions:codex 34s");
  const msg = stallMessage({ verdict: "hang", stalledMs: 35_000, timersFrozenMs: 5_000 }, text);
  check("a hang names what it is waiting on", msg.includes("Waiting on: readSessions:codex 34s."));
  check("a hang still says an await never settled", msg.includes("an await never settled"));
  check("a hang with nothing tracked says so rather than staying silent",
    stallMessage({ verdict: "hang", stalledMs: 35_000, timersFrozenMs: 5_000 }, "").includes("No tracked step"));
  check("a suspend does not claim a stuck step",
    !stallMessage({ verdict: "suspended", stalledMs: 901_000, timersFrozenMs: 901_000 }, text).includes("Waiting on"));
  release();
  await stuck;
  check("a released step leaves the pending list", tracker.pending().length === 0);
  const many = Array.from({ length: PENDING_LIST_CAP + 3 }, (_, i) => ({ name: `s${i}`, since: 9_000 - i }));
  const capped = describePending(many, 10_000);
  check("the pending list is capped and counts what it dropped",
    capped.split(", ").length === PENDING_LIST_CAP && capped.endsWith("(+3 more)"));
  check("the oldest pending step is listed first", capped.startsWith(`s${PENDING_LIST_CAP + 2} `));
}

// ---- STRUCTURAL: host/index.mjs itself -------------------------------------
{
  const missing = untrackedAwaits(INDEX_SRC);
  check(`every await on the tick's path goes through track()${missing.length ? ` - NOT: ${missing.join("; ")}` : ""}`,
    missing.length === 0);
  for (const sig of TRACKED_FUNCTIONS) {
    check(`${sig.replace("async function ", "").replace("(", "()")} has tracked awaits (the check is not vacuous)`,
      trackedCount(INDEX_SRC, sig) > 0);
  }
  const calls = [...INDEX_SRC.matchAll(/\bstallMessage\(/g)].length;
  const named = [...INDEX_SRC.matchAll(/\bstallMessage\(verdict, describePending\(tickAwaits\.pending\(\), now\)\)/g)].length;
  check("every stallMessage call passes the tick's pending steps", calls > 0 && calls === named);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall watchdog checks passed");
process.exit(failed ? 1 : 0);
