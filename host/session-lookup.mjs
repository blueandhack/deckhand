// The device only ever knows a session's first 12 characters - that is all the
// payload carries, and all it can send back when asking for history or aiming a
// dictation or a typed message at a session.
//
// Resolving that to a real id lives in its own module so it can be TESTED. The
// inline version this replaced was `files.find(f => f.startsWith(target))`, which
// takes the FIRST of several matches: a message delivered into whichever session
// happened to sort first is the worst shape of failure available here, because it
// looks like success. Ambiguity is refused instead.
export function resolveSessionId(filenames, id12) {
  if (!id12) return { ok: false, reason: "empty" };
  const ids = filenames
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((id) => id.startsWith(id12));
  if (ids.length === 0) return { ok: false, reason: "none" };
  if (ids.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, id: ids[0] };
}
