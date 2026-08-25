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
import { classifyStall } from "./watchdog.mjs";

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

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall watchdog checks passed");
process.exit(failed ? 1 : 0);
