// Run: node host/codex-refresh-check.mjs
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import fs from "node:fs";
import { shouldRefreshCodex, windowExpired, rateLimitsHaveWindow, CODEX_STALE_MS, CODEX_ATTEMPT_MS } from "./codex-refresh.mjs";

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

// --- a windowless event is not a reading. The exact event Codex wrote one second after
// the 5h window reached 100% (2026-11-07 04:50:08), which used to blank the figure.
const premium = { limit_id: "premium", limit_name: null, primary: null, secondary: null,
  credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "plus", rate_limit_reached_type: null };
const codex100 = { limit_id: "codex", primary: { used_percent: 100.0, window_minutes: 300, resets_at: nowSec + 600 }, secondary: null };
t(rateLimitsHaveWindow(premium), false, "the premium event with no windows is not a reading");
t(rateLimitsHaveWindow(codex100), true, "the codex event at 100% is");
t(rateLimitsHaveWindow({ primary: null, secondary: { used_percent: 3 } }), true, "a secondary-only window counts");
t(rateLimitsHaveWindow({ primary: { used_percent: null } }), false, "a window with no percentage does not");
t(rateLimitsHaveWindow(null), false, "nothing is not a reading");

// STRUCTURAL: the rule above binds nothing unless the harvest actually calls it. Bound
// to readCodexRollout's own body, not the file - a neighbouring line cannot satisfy it.
{
  const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const m = src.match(/async function readCodexRollout\([\s\S]*?\n\}\n/);
  t(!!m, true, "readCodexRollout found in index.mjs");
  const body = m ? m[0] : "";
  t(/token_count"\s*&&\s*rateLimitsHaveWindow\(p\.rate_limits\)/.test(body), true,
    "readCodexRollout harvests rate_limits ONLY through rateLimitsHaveWindow()");
  t(/out\.rateLimits\s*=\s*p\.rate_limits/.test(body.replace(/rateLimitsHaveWindow\(p\.rate_limits\)\)\s*out\.rateLimits\s*=\s*p\.rate_limits/, "")),
    false, "and nowhere else in it assigns rateLimits unguarded");
}

console.log(failed ? `codex-refresh: ${failed} FAILED` : "codex-refresh: all checks passed");
process.exit(failed ? 1 : 0);
