// Merging the two sources of session state.
//
// Codex now arrives BOTH ways: pushed by the hook (rich, includes `ask`) and pulled from
// its rollout file (a fallback, for threads whose trust prompt has not been accepted).
// Without this merge the same thread occupies two of the six rows.
//
// The key has to be NORMALISED. readCodexSessions() already truncates its id to 12 chars
// while a hook record carries the full uuid, so matching on the raw string would never
// hit and the dedupe would silently do nothing - which looks exactly like the bug it is
// meant to fix. 12 is the device's own key length, so it cannot merge two threads the
// device would show separately.
const key = (r) => String(r?.id ?? "").slice(0, 12);

// Hook records win: they are push-fresh and are the only ones carrying `ask`.
export function mergeById(pull, hook) {
  const out = new Map();
  for (const r of pull) if (r) out.set(key(r), r);
  for (const r of hook) if (r) out.set(key(r), r);
  return [...out.values()];
}

// ANTIGRAVITY merges FIELD BY FIELD, not record by record, and the reason was measured.
// Its hook has no event for "background work finished": a turn ends with Stop and
// `fullyIdle: false` while tasks it started are still running, and then nothing else
// fires. Measured 2026-11-11 on agy 1.5.6: Stop at 04:45:20 with fullyIdle=false, and the
// conversation index cleared not_fully_idle at 04:45:54 - 34s later, with no hook event at
// all. A hook record winning outright (Codex's rule above) would have said "working" for
// the full 20-minute stale window. So where both exist the INDEX's live status and the
// later timestamp win, and the hook supplies only what the index does not carry: the
// model, the latest prompt and the transcript path. A hook record the index has no row
// for (an unreadable index, a store it does not list) stands on its own.
export function mergeAntigravity(pull, hook) {
  const byKey = new Map();
  for (const r of pull) if (r) byKey.set(key(r), r);
  const out = new Map(byKey);
  for (const h of hook) {
    if (!h) continue;
    const p = byKey.get(key(h));
    out.set(key(h), p
      ? { ...h, status: p.status, updated_at: Math.max(h.updated_at ?? 0, p.updated_at ?? 0),
          title: h.title || p.title || "", ...(h.app || p.app ? { app: h.app ?? p.app } : {}) }
      : h);
  }
  return [...out.values()];
}
