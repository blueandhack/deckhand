#!/usr/bin/env node
// Checks the ccusage failure path.
//   node host/ccusage-check.mjs              - assert every claim
//   node host/ccusage-check.mjs --selftest   - prove these checks have teeth
//
// WHY THIS EXISTS. `readUsage()` gathered its four sources with `Promise.all`,
// so ONE ccusage timeout rejected the whole thing - and ccusage supplies only
// three TOKEN COUNTS. The 5h/7d percentages, the reset countdowns, the Codex
// row, the session list and the clock all come from elsewhere and were fine,
// but the tick threw them away, sent the device nothing, and wrote no tick
// line. The menu bar reads the LAST tick line, so the numbers froze while the
// heartbeat stayed fresh - measured 18 times in one run, clustered after
// wakes and when load average hit 24. That is the documented "healthy process
// doing no useful work" shape, arriving through a 20s child-process timeout.
//
// This is fallback code: it runs only when something else has already broken,
// which is exactly the code that never gets exercised by hand. The restart
// ledger's own bug was the same shape - a fallback nobody had ever watched run.
import { pickTokens, describeChildError, CCUSAGE_TIMEOUT_MS } from "./ccusage.mjs";

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const FRESH = { sessionTokens: 1_000, weekAllTokens: 50_000, weekFableTokens: 7 };
const OLDER = { sessionTokens: 900, weekAllTokens: 49_000, weekFableTokens: 5 };

// ---------------------------------------------------------------------------
// The fallback cases are factored out because --selftest re-runs them against
// the old all-or-nothing behaviour and requires every one to fail.
function fallbackCases(pick) {
  const kept = pick(null, OLDER);
  const never = pick(null, null);
  return [
    ["a ccusage failure keeps the LAST KNOWN token counts",
      kept?.sessionTokens === 900 && kept?.weekAllTokens === 49_000 && kept?.weekFableTokens === 5],
    ["a ccusage failure is marked stale", kept?.stale === true],
    ["a ccusage failure still yields a usable payload", kept != null],
    ["a failure with nothing ever measured says so", never?.everMeasured === false],
    ["a failure with nothing ever measured does not invent a count",
      never?.sessionTokens === 0 && never?.stale === true],
  ];
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  // The old shape: no fallback at all - a failed read took the whole tick with
  // it, so there were no token fields to speak of.
  const legacy = (fresh) => {
    if (!fresh) throw new Error("Command failed: ccusage blocks --active --json");
    return { ...fresh, stale: false, everMeasured: true };
  };
  const guarded = (fresh, last) => {
    try { return legacy(fresh, last); } catch { return null; }
  };
  console.log("selftest: re-running the fallback cases against the OLD all-or-nothing path.");
  console.log("          every one of them MUST fail, or the check is blind to the bug.\n");
  const results = fallbackCases(guarded);
  let caught = 0;
  for (const [name, ok] of results) {
    if (ok) console.log(`  NOT CAUGHT  ${name}`);
    else { console.log(`  caught      ${name}`); caught++; }
  }
  const blind = results.length - caught;
  console.log(
    blind === 0
      ? `\nselftest passed: all ${caught} checks catch the old path`
      : `\nselftest FAILED: ${blind} check(s) pass against the KNOWN-BAD path`
  );
  process.exit(blind === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The happy path must be completely unchanged - this is a fallback, and a
// fallback that alters the normal reading is worse than no fallback.
{
  const v = pickTokens(FRESH, OLDER);
  check("a successful read uses the FRESH numbers", v.sessionTokens === 1_000);
  check("a successful read is not stale", v.stale === false);
  check("a successful read counts as measured", v.everMeasured === true);
  check("a successful read passes the week fields through",
    v.weekAllTokens === 50_000 && v.weekFableTokens === 7);
}
check("a successful read with no history is still fresh",
  pickTokens(FRESH, null).stale === false);

// A genuine zero is a MEASUREMENT and must survive as one - the repo's own
// rule for the Codex row ("`--`, never `0%`") in the other direction.
{
  const zero = { sessionTokens: 0, weekAllTokens: 0, weekFableTokens: 0 };
  const v = pickTokens(zero, OLDER);
  check("a measured ZERO is kept, not treated as a missing read", v.sessionTokens === 0);
  check("a measured zero is not stale", v.stale === false);
}

// ---- THE BUG ---------------------------------------------------------------
for (const [name, ok] of fallbackCases(pickTokens)) check(name, ok);

// Partial failure: ccusage is TWO separate child processes, and one can time
// out while the other succeeds. Losing both because one failed would be the
// same all-or-nothing mistake one level down.
{
  const v = pickTokens({ sessionTokens: 1_000, weekAllTokens: null, weekFableTokens: null }, OLDER);
  check("a half-failed read keeps the half that worked", v.sessionTokens === 1_000);
  check("a half-failed read falls back for the half that did not",
    v.weekAllTokens === 49_000 && v.weekFableTokens === 5);
  check("a half-failed read is marked stale", v.stale === true);
}

// The error message has to name the failure MODE. "Command failed:" with an
// empty stderr is what made 18 identical lines unreadable - a timeout and a
// crash are different problems and looked identical.
{
  const t = describeChildError({ killed: true, signal: "SIGTERM", message: "Command failed" }, 20_000);
  check("a timeout is named as a timeout", /timed out/.test(t) && /20s/.test(t));
  check("a timeout does not read as a crash", !/exited/.test(t));
}
check("a non-zero exit reports its code",
  /exited 1\b/.test(describeChildError({ code: 1, message: "Command failed" }, 20_000)));
check("a spawn failure reports its errno",
  /ENOENT/.test(describeChildError({ code: "ENOENT", message: "spawn ENOENT" }, 20_000)));
check("an unrecognised error still says something",
  describeChildError({ message: "weird" }, 20_000).length > 0);
check("a null error does not throw",
  typeof describeChildError(null, 20_000) === "string");
check("the timeout constant is the one the runner uses", CCUSAGE_TIMEOUT_MS === 20_000);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall ccusage checks passed");
process.exit(failed ? 1 : 0);
