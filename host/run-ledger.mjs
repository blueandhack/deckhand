// Restart-ledger arithmetic: turning two timestamps and a heartbeat into the
// one sentence `deckhand-service.sh status` reports per host start.
//
// This lives in its own module, with no fs and no clock, for the same reason
// `capUtf8` does: so `run-ledger-check.mjs` can exercise it. It used to be
// inline in index.mjs and was wrong in a way nobody could have noticed there.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a run's DURATION and its LAST TICK are
// two separate facts with two separate sources, and either can be missing on
// its own. The duration comes from the run-state file (`startedAt`/`endedAt`),
// which lives under `~/.claude` and survives anything. The last tick comes from
// the heartbeat, which lives in the runtime dir under **/tmp** - and macOS
// clears /tmp at boot. So "no heartbeat" is the NORMAL state after a reboot and
// says nothing whatsoever about whether the run was healthy.
//
// The old code was `lastTick = beat?.at || prev.startedAt`, which collapsed
// that distinction: a missing heartbeat became "last ticked at startup", i.e.
// "ran 0s, then hung for its entire life". Every one of the four stalls this
// ledger ever recorded was that fallback firing, two of them on reboots
// (Aug 18 21:39 and Aug 24 06:06) - and the ledger's headline number is
// literally "runs that HUNG before dying", so the single metric it exists to
// produce was the one that was wrong. A measurement that cannot say "I don't
// know" will always answer with the scarier option instead.
//
// Hence three outcomes rather than one, and `hung` is the only one that counts
// against the watchdog:
//
//   heartbeat inside the run's life  -> ranMs + stalledMs, both real
//   heartbeat OLDER than the start   -> the run never completed a tick. This is
//                                       a genuine hang: the file was there to
//                                       be written and never was.
//   heartbeat absent or unusable     -> last tick UNKNOWN. Report the lifetime,
//                                       claim no stall, count no hang.

// The watchdog restarts the poll chain after this long without a completed
// tick, so a shorter gap is a slow tick rather than a stall worth a line.
// Keep in step with TICK_WATCHDOG_MS in index.mjs.
export const STALL_REPORT_MS = 30_000;

const isStamp = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/// Describe the previous run from its run-state record and whatever heartbeat
/// was left behind. `beat` may be null (no file, or unparseable JSON).
///
/// `ranMs` and `stalledMs` are **null when unknowable** rather than 0 - a 0
/// there is what started all this, since it reads as a real measurement.
export function describePrevRun(prev, beat) {
  const startedAt = isStamp(prev?.startedAt) ? prev.startedAt : null;
  const endedAt = isStamp(prev?.endedAt) ? prev.endedAt : null;
  const lifetimeMs =
    startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null;

  // A malformed `at` must read as ABSENT, never coerced: `at: 0` would date the
  // last tick to 1970 and report a 56-year stall, and a string would poison
  // every subtraction downstream into NaN.
  const tick = isStamp(beat?.at) ? beat.at : null;

  if (startedAt === null || tick === null) {
    return {
      ranMs: null,
      stalledMs: null,
      lifetimeMs,
      tickKnown: false,
      neverTicked: false,
      hung: false,
    };
  }

  if (tick < startedAt) {
    // The heartbeat belongs to an EARLIER run, so this one never completed a
    // tick of its own. Unlike an absent file, that is positive evidence.
    return {
      ranMs: 0,
      stalledMs: lifetimeMs,
      lifetimeMs,
      tickKnown: true,
      neverTicked: true,
      hung: lifetimeMs !== null && lifetimeMs > STALL_REPORT_MS,
    };
  }

  // Clamp forward skew (a concurrent run, or the clock moving) so neither
  // number can come out negative or reach past the recorded end.
  const lastTick = endedAt !== null ? Math.min(tick, endedAt) : tick;
  const ranMs = Math.max(0, lastTick - startedAt);
  const stalledMs = endedAt !== null ? Math.max(0, endedAt - lastTick) : null;
  return {
    ranMs,
    stalledMs,
    lifetimeMs,
    tickKnown: true,
    neverTicked: false,
    hung: stalledMs !== null && stalledMs > STALL_REPORT_MS,
  };
}

export const humanMs = (ms) =>
  ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h`
  : ms >= 60_000 ? `${(ms / 60_000).toFixed(0)}m`
  : `${(ms / 1000).toFixed(0)}s`;

/// The ledger line for a new start, describing the run that just ended.
///
/// The duration keeps the `<number><h|m|s>` shape `deckhand-service.sh` greps
/// for, so its longest/shortest stats keep working; an unknown duration is
/// deliberately written as a WORD so that same regex skips the entry instead of
/// folding a made-up number into the stats.
export function formatRunStartLine({ n, prev, beat, at }) {
  const d = describePrevRun(prev, beat);
  const ended = prev.endReason || "died without recording a reason";

  let duration;
  let note = "";
  if (d.tickKnown) {
    duration = humanMs(d.ranMs);
  } else if (d.lifetimeMs !== null) {
    // We know how long it LIVED - only when it last ticked is missing.
    duration = humanMs(d.lifetimeMs);
    note = ", last tick unknown (no heartbeat left behind - /tmp cleared?)";
  } else {
    duration = "unknown";
    note = ", last tick unknown (no heartbeat left behind)";
  }

  const stall = d.hung ? `, STALLED ${humanMs(d.stalledMs)} before it ended` : "";
  // Machine sleeps are counted apart from hangs (host/watchdog.mjs): a suspend
  // freezes the poll loop exactly like a stuck await does, and folding the two
  // together is what made 236 "watchdog fires" look like 236 near-misses.
  // Omitted at zero, and absent from records written before the field existed,
  // so every earlier entry reads unchanged.
  const slept = prev.suspendResumes ? `, ${prev.suspendResumes} sleep resumes` : "";
  return (
    `${new Date(at).toISOString()} start #${n} | previous run ${duration}` +
    `${stall}${note}, watchdog fires ${prev.watchdogFires || 0}${slept}, ended: ${ended}\n`
  );
}
