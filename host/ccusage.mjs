// The ccusage failure path: what the tick publishes when the token counts are
// unavailable. Pure and side-effect-free so `ccusage-check.mjs` can exercise it.
//
// WHY THIS IS NOT JUST A try/catch. `readUsage()` gathered four sources with
// `Promise.all`, and ccusage is TWO of them - two child processes supplying
// exactly THREE fields, all token counts. Everything a person actually reads on
// the USAGE tab (the 5h/7d hero percentages, the reset countdowns), plus the
// Codex row, the whole session list and the clock, comes from the OAuth
// snapshot, the statusLine cache and the sessions directory instead. But
// `Promise.all` rejects as a unit, so one 20s ccusage timeout threw ALL of it
// away: the device got no payload and the log got no tick line.
//
// That last part is what made it user-visible. The menu bar reads the most
// recent tick line from the log, so a missing line does not blank the numbers -
// it FREEZES them, at the previous reading, while the heartbeat (written
// earlier in the same tick, before this call) stays fresh and says everything
// is fine. Measured: 18 failures in one run, clustered right after wakes and
// during a stretch where load average hit 24. This is the "healthy process
// doing no useful work" failure this repo has already paid for once, arriving
// through a child-process timeout instead of a missing PATH.
//
// So the rule is: a token count going missing must cost the token count, never
// the tick. Anything still readable gets published.

// execFile kills the child at this deadline, so a slow ccusage cannot pile up
// one orphan per tick. Exported so the runner and the message agree on it.
export const CCUSAGE_TIMEOUT_MS = 20_000;

const FIELDS = ["sessionTokens", "weekAllTokens", "weekFableTokens"];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/// Merge a ccusage reading with the last known good one, field by field.
///
/// FIELD BY FIELD because the two ccusage calls fail INDEPENDENTLY - `blocks`
/// can time out while `weekly` succeeds - and discarding the half that worked
/// would be the same all-or-nothing mistake one level down.
///
/// A measured **0 is kept as a measurement**, never mistaken for a missing
/// read: that is the same distinction the Codex row draws when it shows `--`
/// rather than `0%`, in the other direction.
///
/// `stale` says at least one field is carried over, so the caller can log it
/// once instead of asserting a fresh reading. `everMeasured` is false only when
/// nothing has ever been read, which is the one case where the zeros are not a
/// carried-over value - and it preserves the pre-existing `?? 0` behaviour for
/// a host that has only just started.
export function pickTokens(fresh, last) {
  const out = {};
  let stale = false;
  let everMeasured = false;
  for (const f of FIELDS) {
    if (isNum(fresh?.[f])) {
      out[f] = fresh[f];
      everMeasured = true;
    } else if (isNum(last?.[f])) {
      out[f] = last[f];
      stale = true;
      everMeasured = true;
    } else {
      out[f] = 0;
      stale = true;
    }
  }
  return { ...out, stale, everMeasured };
}

/// Name the failure MODE, because "Command failed: <the whole argv>" with an
/// empty stderr is what made 18 identical log lines unreadable - a timeout, a
/// crash and a missing interpreter are three different problems and all three
/// printed the same sentence. (The missing-interpreter one has bitten here
/// before: ccusage's `#!/usr/bin/env node` shebang under launchd's minimal
/// PATH, which is why it is spawned via `process.execPath` now.)
export function describeChildError(err, timeoutMs = CCUSAGE_TIMEOUT_MS) {
  if (!err) return "failed for no stated reason";
  // execFile's timeout kills the child, so a signal plus `killed` is the
  // deadline rather than a crash.
  if (err.killed && err.signal) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s (killed with ${err.signal})`;
  }
  if (typeof err.code === "string") return `could not start: ${err.code}`;
  if (typeof err.code === "number") return `exited ${err.code}`;
  return err.message || "failed for no stated reason";
}
