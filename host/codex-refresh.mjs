// When to spend a Codex turn to refresh the Codex usage figure, and when a figure has
// stopped meaning anything.
//
// Codex has no usage endpoint to poll - unlike the Claude side, which asks OAuth every
// 5 minutes - so the only source is `token_count.rate_limits` inside a Codex CLI rollout
// file. Nothing writes one unless Codex CLI actually runs, which means using only the
// ChatGPT app leaves the figure frozen forever: measured here at ~24h stale, for a 7-day
// window that had already rolled over.
//
// So a refresh costs a real (tiny) model turn against the user's own quota. That is why
// the decision lives in its own pure function with tests: everything about it is a guard
// against spending that quota more often than intended.
export const CODEX_STALE_MS = 24 * 3600_000; // refresh a reading older than this
export const CODEX_ATTEMPT_MS = 6 * 3600_000; // minimum gap between ATTEMPTS, persisted
export const CODEX_BACKOFF_MS = 6 * 3600_000; // after a failure, wait this long

// A finite, non-future timestamp. Persisted stamps outlive reboots and a clock
// correction can put `now` behind them, so a stamp in the future must read as "just
// now" (blocking) rather than as "long ago" (firing a paid turn on every tick). NaN -
// a corrupt or half-written state file - is treated the same way, deliberately: the
// safe direction for a guard that gates spending is to hold.
function agoMs(stamp, now) {
  if (!Number.isFinite(stamp) || stamp <= 0) return Infinity;
  return now - stamp; // negative when the stamp is in the future
}

export function shouldRefreshCodex({ ageSec, lastAttemptMs, backoffUntilMs, now, enabled }) {
  if (!enabled) return false;
  // `null` age = no rate_limits has EVER been seen, which is exactly the case this
  // feature exists for (Codex installed, but only the app has been used).
  const stale = ageSec == null || ageSec * 1000 > CODEX_STALE_MS;
  if (!stale) return false;
  // A corrupt attempt stamp (NaN) yields Infinity -> "long ago" -> would fire. Guard it
  // explicitly instead: unreadable state must not authorise spending.
  if (!Number.isFinite(lastAttemptMs)) return false;
  const since = agoMs(lastAttemptMs, now);
  if (since < CODEX_ATTEMPT_MS) return false;
  // A backoff we cannot read is ignored rather than fatal: the attempt window above
  // already bounds how often we can try, so the worst case is one turn per 6h.
  if (Number.isFinite(backoffUntilMs) && backoffUntilMs > now) return false;
  return true;
}

// Does this `rate_limits` event carry a reading at all? Codex writes events for MORE
// THAN ONE LIMIT into the same rollout, keyed by `limit_id`, and not every one has a
// window. MEASURED 2026-11-07: the 5-hour `codex` window reached 100% at 04:50:07, and
// one second later Codex wrote a `limit_id: "premium"` event whose primary and secondary
// were both null - 13 such events in the last 30 days, none with a window. The host kept
// "the newest event", so that empty one REPLACED the 100% reading and the Codex figure
// vanished from the menu bar and the device at exactly the moment it mattered most.
// A windowless event is not a measurement of anything; it must never replace one.
export function rateLimitsHaveWindow(rl) {
  if (!rl || typeof rl !== "object") return false;
  const has = (w) => !!w && typeof w === "object" && typeof w.used_percent === "number";
  return has(rl.primary) || has(rl.secondary);
}

// A percentage for a window that has already reset is not a measurement of the current
// window - it describes one that no longer exists. The repo's rule is that "--" means
// never measured, because 0% is a measurement and never-measured is not; a reading whose
// window rolled over belongs on the same side of that line.
export function windowExpired(win, now) {
  if (!win || typeof win !== "object") return false;
  const resets = win.resets_at;
  if (!Number.isFinite(resets) || resets <= 0) return false; // no reset time: cannot tell
  return resets * 1000 <= now;
}
