// Run: node host/codex-refresh-check.mjs
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import { shouldRefreshCodex, windowExpired, CODEX_STALE_MS, CODEX_ATTEMPT_MS } from "./codex-refresh.mjs";

let failed = 0;
const t = (got, want, what) => {
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  failed++;
};

const NOW = 1_800_000_000_000; // fixed clock: this decision must never depend on the real one
const base = { ageSec: null, lastAttemptMs: 0, backoffUntilMs: 0, now: NOW, enabled: true };
const HOUR = 3600_000;

// --- the reason this exists at all ---
t(shouldRefreshCodex({ ...base, ageSec: 25 * 3600 }), true, "a reading older than 24h refreshes");
t(shouldRefreshCodex({ ...base, ageSec: 3600 }), false, "a reading an hour old does not");
t(shouldRefreshCodex({ ...base, ageSec: null }), true, "never measured refreshes");

// --- the guards, which exist because a restart must not fire a paid turn ---
// The host restarts often during development; without a PERSISTED attempt stamp every
// restart with a stale reading would spend quota again immediately.
t(
  shouldRefreshCodex({ ...base, ageSec: 25 * 3600, lastAttemptMs: NOW - HOUR }),
  false,
  "stale but attempted an hour ago: the attempt window blocks it"
);
t(
  shouldRefreshCodex({ ...base, ageSec: 25 * 3600, lastAttemptMs: NOW - 7 * HOUR }),
  true,
  "stale and the attempt window has passed"
);
t(
  shouldRefreshCodex({ ...base, ageSec: 25 * 3600, backoffUntilMs: NOW + HOUR }),
  false,
  "a live backoff blocks it even when the attempt window has passed"
);
t(
  shouldRefreshCodex({ ...base, ageSec: 25 * 3600, backoffUntilMs: NOW - HOUR }),
  true,
  "an expired backoff does not block it"
);

// --- the off switch. It spends real quota, so this must be honoured unconditionally ---
t(shouldRefreshCodex({ ...base, ageSec: null, enabled: false }), false, "disabled never refreshes");

// --- a clock that moves backwards must not unlock a paid turn ---
// Persisted stamps outlive reboots, and a system clock correction can put `now` behind
// them. Treating a future stamp as "long ago" would fire a turn on every tick.
t(
  shouldRefreshCodex({ ...base, ageSec: 25 * 3600, lastAttemptMs: NOW + 10 * HOUR }),
  false,
  "an attempt stamp in the future blocks rather than unlocks"
);

// --- corrupt or absent persisted state must fail SAFE, not spend quota in a loop ---
t(shouldRefreshCodex({ ...base, ageSec: 25 * 3600, lastAttemptMs: NaN }), false, "NaN attempt stamp blocks");
t(shouldRefreshCodex({ ...base, ageSec: 25 * 3600, backoffUntilMs: NaN }), true, "NaN backoff is ignored, not fatal");

// --- constants are exported so the caller cannot drift from what is tested here ---
t(CODEX_STALE_MS === 24 * 3600_000, true, "stale threshold is 24h");
t(CODEX_ATTEMPT_MS >= 6 * HOUR, true, "attempts are at least 6h apart");

// --- the expired-window rule: a percentage for a window that already rolled over is
// not a measurement of anything. Same principle as "--" for never-measured.
const nowSec = NOW / 1000;
t(windowExpired({ resets_at: nowSec - 3600 }, NOW), true, "a window whose reset passed is expired");
t(windowExpired({ resets_at: nowSec + 3600 }, NOW), false, "a window still running is not");
t(windowExpired({ resets_at: null }, NOW), false, "no reset time: not expired, we cannot tell");
t(windowExpired(null, NOW), false, "no window at all is not 'expired'");

console.log(failed ? `codex-refresh: ${failed} FAILED` : "codex-refresh: all checks passed");
process.exit(failed ? 1 : 0);
