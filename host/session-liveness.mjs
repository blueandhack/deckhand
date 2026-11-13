// IS THIS SESSION STILL THERE? What readSessions() decides for every hook record,
// every tick.
//
// THE BUG THIS ANSWERS (2026-11-13): a session's record was deleted after 20 minutes
// with no hook event (SESSION_STALE_MS), on the guess that its terminal had closed
// without SessionEnd. But no hook fires while Claude waits on a long background task,
// or while a session sits open and idle, so live sessions vanished from the device and
// the menu bar's counts. Measured on this Mac: seven Claude processes running, two
// records left.
//
// A CLAUDE SESSION CAN BE ASKED DIRECTLY. Its record carries `inbox.socket`,
// `/tmp/cc-socks/<pid>.sock`, where <pid> is the Claude Code process itself (the hook
// inherits the path from it - see messagingInbox() in the session hook). Measured: every
// socket in that directory belonged to a live `claude` process - Claude Code removes its
// socket when it exits. So:
//   - the socket exists AND its pid is alive -> the session is open: KEEP, however long
//     it has been quiet;
//   - its pid is gone -> the session is over, whether or not SessionEnd ever arrived:
//     END it now (a ghost row for SESSION_ENDED_GRACE_MS, like a clean SessionEnd),
//     rather than leaving a dead session up for twenty minutes;
//   - alive but no socket (Claude removed it on its way out, or the pid was reused) ->
//     no evidence either way: the old age rule.
// A record with no socket (Codex, Antigravity, an older Claude Code) keeps the old
// age rule unchanged.

export function socketPid(record) {
  const s = record?.inbox?.socket;
  if (typeof s !== "string") return null;
  const m = /\/(\d+)\.sock$/.exec(s);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

// process.kill(pid, 0) sends nothing; it only asks whether the pid exists. EPERM means
// it exists and belongs to someone else - still alive.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// "keep" | "remove" | "end". Pure: the two probes are injected so the checker can
// drive every branch without a real process.
export function sessionFate(record, { now, staleMs, endedGraceMs, isAlive, exists }) {
  if (record.status === "ended") {
    return now - (record.ended_at ?? record.updated_at) > endedGraceMs ? "remove" : "keep";
  }
  const pid = socketPid(record);
  if (pid !== null) {
    const alive = isAlive(pid);
    if (!alive) return "end";
    if (exists(record.inbox.socket)) return "keep";
  }
  return now - record.updated_at > staleMs ? "remove" : "keep";
}
