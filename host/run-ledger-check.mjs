#!/usr/bin/env node
// Checks the restart ledger's arithmetic.
//   node host/run-ledger-check.mjs              - assert every claim
//   node host/run-ledger-check.mjs --selftest   - prove these checks have teeth
//
// This exists because the ledger's headline number - "runs that HUNG before
// dying" - was WRONG for every entry it ever produced, and nothing caught it.
// `lastTick = beat?.at || prev.startedAt` silently turns "the heartbeat is
// gone" into "the run ticked once at startup and then hung for its whole
// life", and since the heartbeat lives in /tmp, macOS clearing /tmp at boot
// made that misfire on EVERY reboot. Four of four recorded stalls were this.
//
// So the cases below are mostly REJECT cases, like voice-answer-check.mjs: the
// ledger's job is to tell a hang apart from a clean stop, and a metric that
// cannot say "I don't know" will always answer with the scarier option.
import { describePrevRun, formatRunStartLine } from "./run-ledger.mjs";

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const MIN = 60_000;
const HOUR = 3600_000;
const T0 = 1787000000000; // an arbitrary fixed epoch; nothing here uses the clock

// ---------------------------------------------------------------------------
// The missing-heartbeat cases are factored out because --selftest re-runs them
// against the OLD arithmetic and requires them to fail. A check that has never
// been seen to fail is a decoration, which is the whole reason this file exists.
//
// The numbers are the real Aug 23->24 reboot on this machine: the host ran
// overnight, the Mac rebooted at 06:06:33, /tmp was cleared, and the next start
// found no heartbeat. The ledger said "previous run 0s, STALLED 6.8h" and
// counted it as a hang. The run was fine; the EVIDENCE was gone.
const REBOOT = {
  startedAt: new Date("2026-08-24T06:16:02.504Z").getTime(),
  endedAt: new Date("2026-08-24T13:06:33.000Z").getTime(),
};

function missingHeartbeatCases(impl) {
  const prev = {
    startNumber: 182,
    startedAt: REBOOT.startedAt,
    endedAt: REBOOT.endedAt,
    endReason: "SIGTERM",
    watchdogFires: 5,
  };
  const d = impl.describePrevRun(prev, null); // /tmp cleared -> no heartbeat at all
  const line = impl.formatRunStartLine({ n: 183, prev, beat: null, at: REBOOT.endedAt + 61_000 });
  const cases = [
    ["a MISSING heartbeat is not a hang", d.hung === false],
    ["a MISSING heartbeat does not claim a stall", !/STALLED/.test(line)],
    ["a MISSING heartbeat is reported as unknown, not as zero",
      d.tickKnown === false && /last tick unknown/.test(line)],
    ["a MISSING heartbeat still reports the run's real LIFETIME (6.8h, not 0s)",
      Math.abs(d.lifetimeMs - 6.84 * HOUR) < 0.05 * HOUR && /previous run 6\.8h/.test(line)],
  ];
  // Malformed heartbeats must read as ABSENT too, never coerced: `at: 0` would
  // date the last tick to 1970 and report a 56-year stall, and a string would
  // poison every subtraction into NaN.
  for (const [label, beat] of [
    ["an empty heartbeat object", {}],
    ["a heartbeat with a null at", { at: null }],
    ["a heartbeat with a string at", { at: "nope" }],
    ["a heartbeat with NaN", { at: NaN }],
    ["a heartbeat with at=0", { at: 0 }],
  ]) {
    const m = impl.describePrevRun(prev, beat);
    cases.push([`${label} reads as unknown, not as a stall`,
      m.tickKnown === false && m.hung === false]);
  }
  return cases;
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  // The arithmetic as it shipped for 182 entries, verbatim from index.mjs.
  const legacy = {
    describePrevRun(prev, beat) {
      const lastTick = beat?.at || prev.startedAt;
      const ranMs = Math.max(0, lastTick - prev.startedAt);
      const stalledMs = prev.endedAt ? Math.max(0, prev.endedAt - lastTick) : 0;
      return {
        ranMs, stalledMs,
        lifetimeMs: prev.endedAt ? prev.endedAt - prev.startedAt : null,
        tickKnown: true, neverTicked: false, hung: stalledMs > 30_000,
      };
    },
    formatRunStartLine({ n, prev, beat, at }) {
      const d = legacy.describePrevRun(prev, beat);
      const h = (ms) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h`
                       : ms >= 60_000 ? `${(ms / 60_000).toFixed(0)}m`
                       : `${(ms / 1000).toFixed(0)}s`);
      return `${new Date(at).toISOString()} start #${n} | previous run ${h(d.ranMs)}` +
        `${d.stalledMs > 30_000 ? `, STALLED ${h(d.stalledMs)} before it ended` : ""}` +
        `, watchdog fires ${prev.watchdogFires || 0}, ended: ${ended(prev)}\n`;
    },
  };
  const ended = (prev) => prev.endReason || "died without recording a reason";

  console.log("selftest: re-running the missing-heartbeat checks against the OLD arithmetic.");
  console.log("          every one of them MUST fail, or the check is blind to the bug.\n");
  const results = missingHeartbeatCases(legacy);
  let caught = 0;
  for (const [name, ok] of results) {
    if (ok) console.log(`  NOT CAUGHT  ${name}`);
    else { console.log(`  caught      ${name}`); caught++; }
  }
  const blind = results.length - caught;
  console.log(
    blind === 0
      ? `\nselftest passed: all ${caught} checks catch the old arithmetic`
      : `\nselftest FAILED: ${blind} check(s) pass against the KNOWN-BAD arithmetic`
  );
  process.exit(blind === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// A run that ticked all the way to a clean SIGTERM.
const healthy = {
  prev: { startNumber: 7, startedAt: T0, endedAt: T0 + 3 * HOUR, endReason: "SIGTERM", watchdogFires: 0 },
  beat: { at: T0 + 3 * HOUR - 4000 }, // last tick 4s before the stop
};

{
  const d = describePrevRun(healthy.prev, healthy.beat);
  check("a healthy run reports its duration", Math.round(d.ranMs / HOUR) === 3);
  check("a healthy run reports no stall", d.stalledMs < 30_000);
  check("a healthy run knows when it last ticked", d.tickKnown === true);
}

// The failure the ledger exists to catch: alive, but the poll loop was dead.
{
  const prev = { startNumber: 8, startedAt: T0, endedAt: T0 + 5 * HOUR, endReason: "SIGTERM", watchdogFires: 3 };
  const beat = { at: T0 + 20 * MIN }; // stopped ticking 20 minutes in
  const d = describePrevRun(prev, beat);
  check("a HUNG run reports the stall", d.stalledMs > 4 * HOUR);
  check("a HUNG run reports how long it ran before hanging", Math.round(d.ranMs / MIN) === 20);
  check("a HUNG run is a hang", d.hung === true);
  check("a HUNG run's line says STALLED", /STALLED/.test(formatRunStartLine({ n: 9, prev, beat, at: T0 })));
}

// ---- THE BUG ----------------------------------------------------------------
for (const [name, ok] of missingHeartbeatCases({ describePrevRun, formatRunStartLine })) check(name, ok);

{
  const prev = {
    startNumber: 182, startedAt: REBOOT.startedAt, endedAt: REBOOT.endedAt,
    endReason: "SIGTERM", watchdogFires: 5,
  };
  const line = formatRunStartLine({ n: 183, prev, beat: null, at: REBOOT.endedAt + 61_000 });
  check("the reboot line still carries the watchdog count and end reason",
    /watchdog fires 5/.test(line) && /ended: SIGTERM/.test(line));
}

// A heartbeat file that survived but was never touched by the previous run is a
// DIFFERENT claim from a missing one: it proves the run never completed a single
// tick. That one really is a hang, and must still be reported as one.
{
  const prev = { startNumber: 20, startedAt: T0, endedAt: T0 + 2 * HOUR, endReason: "SIGTERM", watchdogFires: 9 };
  const beat = { at: T0 - 5 * MIN }; // written by the run BEFORE prev
  const d = describePrevRun(prev, beat);
  check("a heartbeat older than the run means it never ticked", d.neverTicked === true);
  check("a run that never ticked IS a hang", d.hung === true);
  check("a run that never ticked stalled for its whole life",
    Math.abs(d.stalledMs - 2 * HOUR) < 1000);
  check("a run that never ticked reports 0s of ticking", d.ranMs === 0);
}

// A run that never ticked but only lived a moment is a fast stop, not a hang -
// the threshold is the watchdog's own, so anything it would not have fired on
// must not be called a stall here either.
{
  const prev = { startNumber: 21, startedAt: T0, endedAt: T0 + 5000, endReason: "SIGTERM" };
  check("a never-ticked run shorter than the watchdog threshold is not a hang",
    describePrevRun(prev, { at: T0 - MIN }).hung === false);
}

// Defensive: a heartbeat newer than the recorded end (clock skew, or a
// concurrent run) must not produce a negative stall or a duration past the end.
{
  const prev = { startNumber: 30, startedAt: T0, endedAt: T0 + HOUR, endReason: "SIGTERM" };
  const d = describePrevRun(prev, { at: T0 + 3 * HOUR });
  check("a heartbeat past the end never yields a negative stall", d.stalledMs >= 0);
  check("a heartbeat past the end never yields a duration past the end", d.ranMs <= HOUR);
}

// A run that died without recording an end has no end timestamp, so its
// lifetime is unknowable too. It must say so rather than pick a number.
{
  const prev = { startNumber: 40, startedAt: T0, watchdogFires: 0 }; // no endedAt, no endReason
  const line = formatRunStartLine({ n: 41, prev, beat: null, at: T0 + HOUR });
  check("no end timestamp AND no heartbeat reports an unknown duration",
    /previous run unknown/.test(line));
  check("an unrecorded death still says so", /died without recording a reason/.test(line));
  check("an unrecorded death with no heartbeat claims no stall", !/STALLED/.test(line));
}

// The service script parses these lines with a regex and skips what it cannot
// read, so the durations it graphs must stay in the shape it expects.
{
  const line = formatRunStartLine({ ...healthy, n: 8, at: T0 + 3 * HOUR });
  check("the line keeps the shape deckhand-service.sh parses",
    /^\S+ start #8 \| previous run [\d.]+[hms]/.test(line));
  check("the line ends with a newline", line.endsWith("\n"));
  check("an unknown duration is NOT parseable as a number (so stats skip it)",
    !/previous run ([\d.]+)([hms])/.test(
      formatRunStartLine({ n: 42, prev: { startNumber: 41, startedAt: T0 }, beat: null, at: T0 })));
}

// Machine sleeps are counted apart from hangs (see host/watchdog.mjs), so the
// ledger has to carry both or the split is invisible where it is read.
{
  const prev = {
    startNumber: 60, startedAt: T0, endedAt: T0 + 8 * HOUR,
    endReason: "SIGTERM", watchdogFires: 0, suspendResumes: 14,
  };
  const line = formatRunStartLine({ n: 61, prev, beat: { at: T0 + 8 * HOUR }, at: T0 });
  check("a run's machine sleeps are reported", /14 sleep resumes/.test(line));
  check("sleeps do not inflate the watchdog fire count", /watchdog fires 0/.test(line));
}
{
  // Every entry written before this field existed must read unchanged, the
  // same backward-compatibility rule the wire protocol's optional tokens use.
  const prev = { startNumber: 62, startedAt: T0, endedAt: T0 + HOUR, endReason: "SIGTERM", watchdogFires: 2 };
  const line = formatRunStartLine({ n: 63, prev, beat: { at: T0 + HOUR }, at: T0 });
  check("a record with no suspend count says nothing about sleeps", !/sleep resumes/.test(line));
  check("zero sleeps are not printed",
    !/sleep resumes/.test(formatRunStartLine({ n: 64, prev: { ...prev, suspendResumes: 0 }, beat: { at: T0 + HOUR }, at: T0 })));
}

// A stall shorter than the watchdog's own threshold is just a slow last tick.
{
  const prev = { startNumber: 50, startedAt: T0, endedAt: T0 + HOUR, endReason: "SIGTERM" };
  check("a sub-threshold gap is not called a stall",
    !/STALLED/.test(formatRunStartLine({ n: 51, prev, beat: { at: T0 + HOUR - 10_000 }, at: T0 })));
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall run-ledger checks passed");
process.exit(failed ? 1 : 0);
