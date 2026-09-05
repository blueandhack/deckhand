// Post a message INTO a live, interactive Claude Code session.
//
// This replaces the long-standing belief - written down in
// docs/reference/audio-and-voice.md and true when it was written - that there is
// no way to inject a prompt into a running interactive session, so a dictation
// had to be handed to the human via the clipboard or run headlessly by a second
// author. Claude Code exports a per-session Unix domain socket into every
// process it spawns, hooks included:
//
//   CLAUDE_CODE_MESSAGING_SOCKET   /tmp/cc-socks/<pid>.sock
//   CLAUDE_CODE_MESSAGING_TOKEN    32 hex characters
//
// Reading those out of a hook's environment is the ONLY way to learn the path:
// there is no registry, no CLI subcommand, and no derivation from a session id.
// (The number in the filename is the Claude Code process's own pid, but nothing
// here relies on that - claude-hooks/deckhand-session-hook.mjs reads the env and
// publishes both fields on the session record.)
//
// WHO MAY POST: any process that can read the token, regardless of ancestry. A
// launchd-parented process with ppid=1 and no relationship to the session was
// measured posting into it successfully, which is exactly the process shape the
// Deckhand host has (it runs as DeckhandBLE.app). That is why this works at all.
//
// THE MESSAGE ARRIVES ATTRIBUTED TO A PEER SESSION, not as the user's own
// typing. That is inherent to the mechanism and cannot be dressed up: Claude
// sees it as a message queued from outside, the same channel a finished
// background task uses to report back. It lands in the conversation and is read
// mid-turn, which is what was wanted; it is just not indistinguishable from the
// human at the keyboard.
//
// -----------------------------------------------------------------------------
// THE WIRE FORMAT IS NOT PUBLICLY DOCUMENTED, AND GETTING IT WRONG IS SILENT
// -----------------------------------------------------------------------------
// Exactly two newline-terminated JSON lines on one connection:
//
//   {"type":"auth","token":"<token>"}
//   {"type":"user","message":{"role":"user","content":"<text>"}}
//
// The first guess was {"type":"message","text":...}. The socket ACCEPTED that
// frame, the write returned success, the process exited 0 - and the message was
// discarded. Three probes in a row "succeeded" and delivered nothing. There is
// no ack, and no error line for a malformed frame.
//
// So the rule this module is built around: A SUCCESSFUL WRITE IS NOT PROOF OF
// DELIVERY. Delivery is confirmed by reading the session's own transcript, which
// gains a {"type":"queue-operation","operation":"enqueue",...,"content":...}
// record when a message is actually queued. Unconfirmed is reported as a
// failure, by name, so the caller can fall back to the clipboard - CLAUDE.md:
// "every refusal must NAME ITS CAUSE: from the Mac, silence and 'impossible
// here' look identical."
//
// LIMITS, from the documented behaviour of the channel: ~1M characters per
// message, a burst cap, at most 50 queued messages, and the connection is CLOSED
// if a complete line does not arrive within 30 seconds. Deckhand's own cap is 150
// bytes (typed-answer.mjs), so only the connection-lifetime rule realistically
// applies - which is why this opens the socket only when the text is already in
// hand, writes both lines immediately, and ends the connection rather than
// holding it.
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";

// Connect+write. Small because the socket is local and either there or not; a
// long timeout here just delays the clipboard fallback.
export const INBOX_WRITE_TIMEOUT_MS = 3000;
// How long to wait for the transcript to show the enqueue. Measured at well
// under a second on a live session; the budget is generous because the cost of
// being wrong is a false "not delivered" and a duplicate on the clipboard.
export const INBOX_CONFIRM_TIMEOUT_MS = 5000;
export const INBOX_CONFIRM_POLL_MS = 120;

/// The two frames, in order, as strings WITHOUT their newlines.
///
/// Kept as a function rather than inlined at the call site so a checker can
/// assert the shape it certifies by PARSING this, instead of transcribing a
/// copy that would keep passing after the real one regressed.
export function inboxFrames(token, text) {
  return [
    JSON.stringify({ type: "auth", token }),
    JSON.stringify({ type: "user", message: { role: "user", content: text } }),
  ];
}

/// Exactly the bytes that go on the wire: both frames, each newline-terminated.
export function inboxWireBytes(token, text) {
  return Buffer.from(inboxFrames(token, text).map((l) => l + "\n").join(""), "utf8");
}

// Write the two lines and close. Resolves {ok} / {ok:false, why} - it NEVER
// throws, because every caller's alternative is the clipboard, not a crash.
function writeFrames(socketPath, token, text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `timed out after ${INBOX_WRITE_TIMEOUT_MS}ms writing to ${socketPath}` }),
      INBOX_WRITE_TIMEOUT_MS
    );
    let sock;
    try {
      sock = net.createConnection(socketPath);
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, why: `could not open ${socketPath}: ${err.message}` });
      return;
    }
    sock.on("error", (err) => finish({ ok: false, why: `socket error on ${socketPath}: ${err.message}` }));
    sock.on("connect", () => {
      // Both lines in ONE write: the server reads line-delimited frames off the
      // stream, so splitting them buys nothing and only widens the window in
      // which the 30s line timer could matter.
      sock.write(inboxWireBytes(token, text), (err) => {
        if (err) return finish({ ok: false, why: `write failed: ${err.message}` });
        // end() flushes and half-closes. The write callback firing means the
        // bytes left this process - which, per the note at the top, says
        // NOTHING about whether they were understood.
        sock.end(() => finish({ ok: true }));
      });
    });
  });
}

/// Scan a transcript tail for an enqueue of `text`, and COUNT WHAT WAS THERE.
///
/// The counts are not decoration; they are the only way to tell the two failure
/// stories apart when confirmation does not arrive, and they are cheap because
/// this already walks every line.
///
///   enqueues === 0        nothing was queued at all -> the message never
///                         arrived, which is what a malformed frame looks like.
///   enqueues > 0 but
///   withContent === 0     the app IS queueing, but is not recording content on
///                         these records -> the message may well have arrived and
///                         this confirmation rule cannot see it.
///
/// That distinction matters more than it looks. Every confirmed delivery so far
/// has been on a BUSY session, while a real device tap can only target a WAITING
/// one; 2,826 enqueues on disk were checked and 1,785 carry no `content` at all
/// (locally typed, dequeued in the same millisecond), with 238 content-carrying
/// ones dequeued in under 50ms - so content does NOT look queue-delay-conditional.
/// That is an inference, not a measurement of the case that matters. If it is
/// wrong, every device tap logs "NOT delivered", falls back to the clipboard, AND
/// has actually delivered: a duplicate turn plus a false log line. One real tap
/// settles it, and these counts are what make that one tap conclusive.
///
/// `includes` rather than `===` on purpose: the enqueued content is the text
/// this host sent, but the channel is shared with other producers (a finished
/// background task reports through the same queue), and a future Claude Code
/// that wrapped or annotated the content would otherwise turn a real delivery
/// into a false negative plus a duplicate on the clipboard.
export function scanEnqueues(tail, text) {
  let enqueues = 0, withContent = 0, found = false;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== "queue-operation") continue;
    if (rec.operation !== "enqueue") continue;
    enqueues++;
    if (typeof rec.content !== "string") continue;
    withContent++;
    // `text` empty would make includes() true for every content, confirming any
    // enqueue at all - so it is refused here rather than at the top, where it
    // would also suppress the counts this diagnosis needs.
    if (text && rec.content.includes(text)) found = true;
  }
  return { found, enqueues, withContent };
}

/// Does this transcript, from byte offset `from` onward, contain an enqueue of
/// `text`? The boolean face of scanEnqueues, exported so the confirmation rule
/// itself can be tested without a live session.
export function transcriptShowsEnqueue(tail, text) {
  return scanEnqueues(tail, text).found;
}

// Read only what was appended after `from`. A long-running session's transcript
// is tens of megabytes and this runs on every delivery.
async function readTailFrom(transcript, from) {
  let fh;
  try {
    fh = await fsp.open(transcript, "r");
    const { size } = await fh.stat();
    if (size <= from) return "";
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => {});
  }
}

/// Deliver `text` into the live session described by a Deckhand session record.
///
/// `record` is the parsed ~/.claude/deckhand-sessions/<id>.json: this needs its
/// `inbox` ({socket, token}, written by the hook) and its `transcript`.
///
/// Returns {ok:true, ms} or {ok:false, why, wrote} - `wrote` distinguishing
/// "never reached the socket" from "written but unconfirmed", which are
/// different problems and must not read the same in the log.
export async function postToSessionInbox(record, text, now = Date.now) {
  const started = now();
  const socketPath = record?.inbox?.socket;
  const token = record?.inbox?.token;
  if (!socketPath || !token) {
    return {
      ok: false,
      wrote: false,
      why: "the session record carries no messaging socket (it predates the hook change, or this Claude Code does not export CLAUDE_CODE_MESSAGING_SOCKET)",
    };
  }
  // TYPE-CHECK BEFORE TOUCHING fs. The record is a JSON file on disk that another
  // process writes and that can be truncated mid-write, so its fields are not
  // guaranteed to be strings - and `fs.existsSync` with a non-string argument is
  // DEPRECATED (Node DEP0187, which emits a warning today and is documented to
  // become a throw). A throw here would escape into the caller and take the
  // clipboard fallback with it: worse than the behaviour this replaced, which at
  // least always delivered something. Refused by name instead.
  //
  // Checked in ONE place, before any of them is used, and NAMING THE BAD FIELD:
  // the transcript's type has to be settled here rather than at its own check
  // further down, or a numeric transcript is reported as "the session exited"
  // and sends a reader hunting an entirely different thing.
  const bad = [];
  if (typeof socketPath !== "string") bad.push(`socket is ${typeof socketPath}`);
  if (typeof token !== "string") bad.push(`token is ${typeof token}`);
  if (typeof text !== "string") bad.push(`text is ${typeof text}`);
  // An ABSENT transcript is a different (and expected) case - see below - so
  // only a present-but-wrong-typed one is malformed.
  const tx = record?.transcript;
  if (tx !== undefined && tx !== null && typeof tx !== "string") bad.push(`transcript is ${typeof tx}`);
  if (bad.length) {
    return {
      ok: false,
      wrote: false,
      why: `the session record is malformed (${bad.join(", ")}) - these must be strings`,
    };
  }
  // Cheap and specific: an exited session leaves its record behind for a moment
  // but its socket is gone, and "no such file" is a much better log line than a
  // generic ECONNREFUSED.
  if (!fs.existsSync(socketPath)) {
    return { ok: false, wrote: false, why: `the messaging socket ${socketPath} is gone (the session exited)` };
  }
  const transcript = record?.transcript;
  if (typeof transcript !== "string" || !transcript || !fs.existsSync(transcript)) {
    // Refuse rather than write blind. Without the transcript there is no way to
    // tell delivery from the silent-discard failure at the top of this file, and
    // an unverifiable send is exactly what this module exists not to do.
    return {
      ok: false,
      wrote: false,
      why: `no readable transcript for this session (${transcript || "no path on the record"}), so delivery could not be confirmed`,
    };
  }
  // Offset BEFORE the write, so an older enqueue of the same text - a retry, or
  // the same message sent twice - cannot be mistaken for this one.
  let from = 0;
  try { from = (await fsp.stat(transcript)).size; } catch {}

  const w = await writeFrames(socketPath, token, text);
  if (!w.ok) return { ok: false, wrote: false, why: w.why };

  const deadline = now() + INBOX_CONFIRM_TIMEOUT_MS;
  let scan = { found: false, enqueues: 0, withContent: 0 };
  let grew = 0;
  for (;;) {
    const tail = await readTailFrom(transcript, from);
    grew = Buffer.byteLength(tail, "utf8");
    scan = scanEnqueues(tail, text);
    if (scan.found) return { ok: true, wrote: true, ms: now() - started };
    if (now() >= deadline) break;
    await new Promise((r) => setTimeout(r, INBOX_CONFIRM_POLL_MS));
  }
  // EVERYTHING NEEDED TO TELL THE TWO STORIES APART, in one line, because the
  // tap that would settle it happens once and away from the Mac. "never arrived"
  // is enqueues=0; "arrived but I could not see it" is enqueues>0 withContent=0.
  // Without these numbers both read as the same bare "not delivered", and the
  // second one is a duplicate turn plus a false log line - see scanEnqueues.
  return {
    ok: false,
    wrote: true,
    scan,
    why:
      `written to ${socketPath} but no enqueue carrying this text appeared within ${INBOX_CONFIRM_TIMEOUT_MS}ms ` +
      `- treat as NOT delivered (a malformed frame is accepted and discarded silently). ` +
      `Diagnosis: from offset ${from} the transcript grew ${grew} bytes holding ${scan.enqueues} enqueue(s), ` +
      `${scan.withContent} with content. ` +
      (scan.enqueues === 0
        ? "0 enqueues means it NEVER ARRIVED - suspect the frame or the token."
        : scan.withContent === 0
          ? "enqueues WITHOUT content means it may well have arrived and this rule cannot see it - suspect the confirmation, not the send, and expect a duplicate turn."
          : "content-carrying enqueues are present but none matched - suspect the text being altered in flight."),
  };
}
