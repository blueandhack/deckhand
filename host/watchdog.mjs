// The poll-loop watchdog's decision: did a promise hang, or was the MACHINE
// asleep? Pure and clock-free so `watchdog-check.mjs` can exercise it.
//
// WHY THIS IS NOT ONE COMPARISON. `Date.now() - lastTickCompleted` cannot tell
// those two apart - both are wall-clock jumping forward with no completed tick -
// so the watchdog used to answer "an await never settled" for every stall, and
// its fire count, the number that is supposed to say whether the supervisor is
// earning its place, counted sleep cycles instead.
//
// MEASURED, not assumed: of the 14 stalls in the one run whose log survives,
// **14 matched a macOS sleep window to within 6 seconds** - reconstructed from
// the tick lines' `cxage` field and cross-checked against `pmset -g log`. None
// was a hang. The three ~901s ones are macOS's scheduled maintenance sleep,
// which its own log names outright ("Entering Sleep state due to 'Idle Sleep'
// ... 900 secs"). The count across the whole ledger is 236, and the pattern
// there - fires concentrated in long overnight runs, near-zero in short ones -
// is consistent with the same cause, though those logs are gone.
//
// THE DISCRIMINATOR NEEDS NO MONOTONIC CLOCK: ask whether the watchdog's OWN
// interval kept running.
//
//   a stuck promise  -> the event loop is alive, so the interval still fires
//                       every POLL_INTERVAL_MS. It is ~5s late, the stall is 30s+.
//   a suspended Mac  -> the interval is frozen too, for as long as the stall.
//
// Those two are 5s against 900s, so any threshold between them works; the stall
// threshold itself is reused rather than inventing a second constant. The
// margin is ~6x, which is what makes an interval merely running late under load
// still read as a hang - treating lateness as sleep would silently disable the
// watchdog on a busy machine, and that is the failure that would actually cost
// something.
//
// KNOWN LIMITATION, stated rather than papered over: an event loop blocked
// SYNCHRONOUSLY (a long CPU-bound stretch, not a pending promise) also freezes
// the interval, so it reads as a suspend. Nothing in this host does that -
// every heavy path is a child process - and the alternative, a monotonic clock,
// is not reliably distinguishable across suspend on Darwin either.

const nonNeg = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/// `lastWatchdogRun` is when this interval last executed, or null on its very
/// first run - which must read as a healthy interval, not as a suspend lasting
/// the whole process uptime.
export function classifyStall({
  now,
  lastTickCompleted,
  lastWatchdogRun,
  thresholdMs,
  intervalMs,
}) {
  const stalledMs = now - lastTickCompleted;
  const timersFrozenMs =
    lastWatchdogRun == null ? 0 : nonNeg(now - lastWatchdogRun);

  if (!(stalledMs >= thresholdMs)) {
    return { verdict: "ok", stalledMs, timersFrozenMs, hung: false };
  }
  // The interval missed at least as much time as the stall threshold, so the
  // timer system was frozen - the loop was not stuck, the machine was away.
  if (timersFrozenMs >= thresholdMs) {
    return { verdict: "suspended", stalledMs, timersFrozenMs, hung: false };
  }
  return { verdict: "hang", stalledMs, timersFrozenMs, hung: true };
}

/// What to print. A suspend must not claim a cause it has not established:
/// that exact sentence ("an await never settled") is what sent a debugging
/// session after the BLE stack for a full round before the sleep log settled it.
///
/// `waitingOn` is describePending()'s text. A HANG names it, because "an await
/// never settled" alone cannot be acted on: the 2026-11-08 22:24 stall coincided
/// with both ccusage runs timing out, and with ccusage already off the tick's path
/// the log could not say which of the tick's other awaits had hung. A suspend
/// ignores it - nothing was stuck, the machine was away.
export function stallMessage(v, waitingOn = "") {
  const s = (ms) => Math.round(ms / 1000);
  if (v.verdict === "suspended") {
    return `Poll loop resumed after ${s(v.stalledMs)}s - the machine was asleep ` +
      `(timers frozen ${s(v.timersFrozenMs)}s), not a hang.`;
  }
  return `Poll loop stalled for ${s(v.stalledMs)}s with timers running normally ` +
    `(interval last ran ${s(v.timersFrozenMs)}s ago) - an await never settled. ` +
    (waitingOn
      ? `Waiting on: ${waitingOn}. `
      // Said rather than left blank: an empty list means the stuck await is one
      // track() does not wrap, which is itself the finding.
      : `No tracked step was pending - the stuck await is not one track() wraps. `) +
    `Restarting it.`;
}

/// Which of the tick's awaits are still outstanding, so a hang can name its step.
/// track() returns a promise that settles exactly as the one it wraps (`finally`
/// passes a rejection through), so wrapping an await changes nothing but this
/// bookkeeping. Entries are per call, not per name: an orphaned chain's stuck step
/// stays listed - with its age - beside the replacement chain's own steps, which
/// is the truth about what the process is still waiting for.
export function makeAwaitTracker(clock = Date.now) {
  const pending = new Map();
  let nextId = 0;
  return {
    track(name, promise) {
      const id = nextId++;
      pending.set(id, { name, since: clock() });
      return Promise.resolve(promise).finally(() => pending.delete(id));
    },
    pending() {
      return [...pending.values()];
    },
  };
}

/// "readSessions:codex 33s, readUsage 33s" - oldest first, because the oldest
/// pending step is the one everything after it is waiting behind. Capped so an
/// accumulation of orphans cannot turn one log line into a wall.
export const PENDING_LIST_CAP = 6;
export function describePending(list, now) {
  const sorted = [...list].sort((a, b) => a.since - b.since);
  const shown = sorted
    .slice(0, PENDING_LIST_CAP)
    .map((p) => `${p.name} ${Math.round(nonNeg(now - p.since) / 1000)}s`);
  const more = sorted.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` (+${more} more)` : "");
}
