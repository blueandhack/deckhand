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
