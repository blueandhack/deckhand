#!/usr/bin/env node
// Checks the SESSION INBOX - posting a typed message into a LIVE Claude Code
// conversation over its own messaging socket, instead of copying it to the Mac's
// clipboard for the human to paste.
//
// Run:  node host/session-inbox-check.mjs
//       node host/session-inbox-check.mjs --selftest    # proves it can fail
//
// -----------------------------------------------------------------------------
// WHY THIS CHECKER EXISTS, WHICH IS ALSO WHY IT IS SHAPED THE WAY IT IS
// -----------------------------------------------------------------------------
// The wire format is not publicly documented. The first attempt at it was
//
//     {"type":"message","text":"..."}
//
// and it is WRONG. The socket accepted it, the write callback reported success,
// the process exited 0 - and the message was discarded. Re-measured on a live
// session while this checker was written: the bad frame's write returned
// "none (SUCCESS)" and the transcript gained no enqueue of that text. There is no
// ack and no error line, so there is no runtime signal at all. The ONLY thing
// standing between that mistake and a silently dead feature is a test that reads
// the frame the code actually builds and fails by NAME when its shape moves.
//
// So the file has three halves, and they fail for different reasons:
//
//   FRAME     - reads inboxFrames' BODY out of the source, and checks the frames
//               the exported function returns against what that body declares.
//               Nothing here transcribes the shape: the checker has no literal
//               copy of it, so it cannot keep passing over a reverted one.
//   CONFIRM   - the "a successful write is not proof of delivery" rule:
//               transcriptShowsEnqueue must accept only a real enqueue carrying
//               the text, and postToSessionInbox must take its transcript offset
//               BEFORE writing.
//   WIRING    - the host actually reaching for the inbox ahead of the clipboard,
//               falling through on failure, naming the cause; and the hook
//               publishing the socket and token at all. The hook half is
//               BEHAVIOURAL: it drives the real hook as a child process against a
//               throwaway $HOME, because a regex over the hook would keep passing
//               against a file that no longer runs.
//
// Every assertion is bound to a FUNCTION BODY rather than to a file, so a copy of
// the expression living next door cannot satisfy it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX_SRC = path.join(REPO, "host", "session-inbox.mjs");
const HOST_SRC = path.join(REPO, "host", "index.mjs");
const HOOK_SRC = path.join(REPO, "claude-hooks", "deckhand-session-hook.mjs");

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else failures.push(msg);
}

// ---------------------------------------------------------------------------
// Bind to a function BODY, not to the file. `pairWindowOpen()` gutted to
// `return true` once passed 70 assertions because a copy of the expression it
// was checked against lived in a neighbouring function.
//
// Brace-counting from the `{` that opens the body. The sources here are plain
// JS with no #if arms, which is what makes that safe (CLAUDE.md's note about
// brace-counting tools applies to the firmware, not to this).
// ---------------------------------------------------------------------------
function bodyOf(src, header, label) {
  const at = src.indexOf(header);
  ok(at >= 0, `PARSE: could not find ${label} - every assertion bound to its body is unproven`);
  if (at < 0) return "";
  let i = src.indexOf("{", at);
  if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  ok(false, `PARSE: ${label}'s body is unbalanced - refusing to assert over a partial read`);
  return "";
}

// The frame shape, read OUT OF the source rather than written down here. Each
// JSON.stringify({...}) argument inside inboxFrames' body is evaluated in an
// isolated scope where `token` and `text` are known sentinels, so what comes
// back is the literal object the code will send - with no copy of it in this file.
function declaredFrames(body, token, text) {
  const outs = [];
  const re = /JSON\.stringify\(([\s\S]*?)\),\n/g;
  let m;
  while ((m = re.exec(body))) {
    try {
      outs.push(new Function("token", "text", `return (${m[1]});`)(token, text));
    } catch (e) {
      ok(false, `PARSE: an argument to JSON.stringify inside inboxFrames could not be evaluated (${e.message})`);
    }
  }
  return outs;
}

function main({ inboxPath = INBOX_SRC, hostPath = HOST_SRC, hookPath = HOOK_SRC, quiet = false } = {}) {
  const inboxSrc = fs.readFileSync(inboxPath, "utf8");
  const hostSrc = fs.readFileSync(hostPath, "utf8");

  // =========================================================================
  // FRAME
  // =========================================================================
  const framesBody = bodyOf(inboxSrc, "export function inboxFrames(", "inboxFrames()");
  ok(framesBody.length > 0, "PARSE: inboxFrames has an empty body - every FRAME assertion below would pass vacuously");

  const TOKEN = "0123456789abcdef0123456789abcdef";
  const TEXT = "ship it, but keep the fallback";
  const declared = declaredFrames(framesBody, TOKEN, TEXT);
  ok(declared.length === 2,
     `FRAME: inboxFrames must build exactly TWO frames (auth then user); its body declares ${declared.length}`);

  // What the code DECLARES, asserted on its own terms. These are the four facts
  // the recovered format turns on, and each names the mistake it rules out.
  const [auth, user] = declared;
  ok(auth?.type === "auth",
     `FRAME: the FIRST frame's type must be "auth" - got ${JSON.stringify(auth?.type)}`);
  ok(auth?.token === TOKEN,
     'FRAME: the auth frame must carry the token under the key "token"');
  ok(Object.keys(auth ?? {}).length === 2,
     `FRAME: the auth frame must carry type and token and nothing else - got ${JSON.stringify(Object.keys(auth ?? {}))}`);
  ok(user?.type === "user",
     `FRAME: the SECOND frame's type must be "user" - got ${JSON.stringify(user?.type)}. ` +
     '"message" was the WRONG first guess: the socket accepts it, reports success, and discards it silently');
  ok(user?.message?.role === "user",
     `FRAME: the user frame must nest {message:{role:"user"}} - got ${JSON.stringify(user?.message?.role)}`);
  ok(user?.message?.content === TEXT,
     "FRAME: the text must ride at message.content - the discarded first guess put it at a top-level .text");
  ok(!("text" in (user ?? {})),
     "FRAME: the user frame must NOT carry a top-level .text - that is exactly the frame that is accepted and thrown away");
  ok(Object.keys(user?.message ?? {}).length === 2,
     `FRAME: the user frame's message must carry role and content and nothing else - got ${JSON.stringify(Object.keys(user?.message ?? {}))}`);

  // Behaviour against the source, not against a literal: the exported function
  // must actually emit what its body declares, as JSON, one frame per string.
  return import(`file://${inboxPath}?v=${Date.now()}`).then((mod) => {
    const emitted = mod.inboxFrames(TOKEN, TEXT);
    ok(Array.isArray(emitted) && emitted.length === declared.length,
       "FRAME: inboxFrames returns one string per declared frame");
    for (let i = 0; i < declared.length; i++) {
      let parsed = null;
      try { parsed = JSON.parse(emitted[i] ?? ""); } catch {}
      ok(JSON.stringify(parsed) === JSON.stringify(declared[i]),
         `FRAME: frame ${i} on the wire must equal the object its body declares - got ${emitted[i]}`);
      ok(!(emitted[i] ?? "\n").includes("\n"),
         `FRAME: frame ${i} must not contain a newline - the frames are LINE-delimited, so an embedded one splits the message`);
    }

    // The bytes. Two lines, each newline-terminated, nothing else: the server
    // reads line-delimited frames, and a missing trailing newline leaves the
    // last frame unterminated - which the 30s line timer eventually kills.
    const wire = mod.inboxWireBytes(TOKEN, TEXT).toString("utf8");
    ok(wire === emitted.map((l) => l + "\n").join(""),
       "FRAME: inboxWireBytes is exactly the frames, each newline-terminated");
    ok(wire.endsWith("\n"),
       "FRAME: the wire ends with a newline - an unterminated final frame is never processed");
    ok(wire.split("\n").filter(Boolean).length === 2,
       "FRAME: exactly two lines go on the wire");

    // =======================================================================
    // CONFIRM - "a successful write is not proof of delivery"
    // =======================================================================
    const enq = (o) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: TEXT, ...o });
    ok(mod.transcriptShowsEnqueue(enq({}), TEXT),
       "CONFIRM: a real enqueue carrying the text is accepted");
    ok(!mod.transcriptShowsEnqueue(enq({ operation: "dequeue" }), TEXT),
       "CONFIRM: a DEQUEUE must not count - it is the app taking a message OFF the queue, and one exists for every enqueue");
    ok(!mod.transcriptShowsEnqueue(enq({ type: "user" }), TEXT),
       "CONFIRM: an ordinary transcript record that happens to contain the text must not count");
    ok(!mod.transcriptShowsEnqueue(JSON.stringify({ type: "queue-operation", operation: "enqueue" }), TEXT),
       "CONFIRM: an enqueue with NO content must not count - a task notification is enqueued the same way");
    ok(!mod.transcriptShowsEnqueue(enq({ content: "something else entirely" }), TEXT),
       "CONFIRM: an enqueue of DIFFERENT text must not count");
    ok(!mod.transcriptShowsEnqueue("", TEXT),
       "CONFIRM: an empty tail must not count - the vacuous-pass case");
    ok(!mod.transcriptShowsEnqueue(enq({}), ""),
       "CONFIRM: empty text must never confirm - every content includes(\"\"), so this would confirm ANY enqueue");
    ok(mod.transcriptShowsEnqueue("not json at all\n" + enq({}) + "\n{oops", TEXT),
       "CONFIRM: unparseable lines around it are skipped, not fatal - the transcript's tail can be mid-write");

    // Refusals, each naming its own cause: this is the whole point of the module
    // (CLAUDE.md - from the Mac, silence and "impossible here" look identical).
    const noInbox = mod.postToSessionInbox({ transcript: "/nope" }, TEXT);
    const goneSock = mod.postToSessionInbox(
      { inbox: { socket: path.join(os.tmpdir(), `deckhand-absent-${process.pid}.sock`), token: TOKEN },
        transcript: "/nope" }, TEXT);
    return Promise.all([noInbox, goneSock]).then(([a, b]) => {
      ok(a.ok === false && !a.wrote && /messaging socket/i.test(a.why || ""),
         `REFUSAL: a record with no inbox is refused, naming the missing socket - got ${JSON.stringify(a)}`);
      ok(b.ok === false && !b.wrote && /gone|exited/i.test(b.why || ""),
         `REFUSAL: a socket that no longer exists is refused, naming the exited session - got ${JSON.stringify(b)}`);
      ok(a.why !== b.why,
         "REFUSAL: the two refusals must not read the same - they are different problems with different fixes");

      const postBody = bodyOf(inboxSrc, "export async function postToSessionInbox(", "postToSessionInbox()");
      ok(postBody.length > 0, "PARSE: postToSessionInbox has an empty body");
      // ORDER MATTERS: the offset has to be taken before the write, or a retry of
      // the same text finds the PREVIOUS attempt's enqueue and reports a delivery
      // that did not happen.
      const iStat = postBody.indexOf(".size");
      const iWrite = postBody.indexOf("writeFrames(");
      ok(iStat >= 0 && iWrite >= 0 && iStat < iWrite,
         "CONFIRM: the transcript offset must be taken BEFORE the write, or an older enqueue of the same text is mistaken for this one");
      // Bound to THE return that reports an unconfirmed write, isolated by
      // slicing back to its own `return {`. A looser regex over the whole body
      // passes on a neighbouring refusal's `ok: false` while this one says true -
      // which is precisely the defect, and it would have gone unreported.
      const iUnconf = postBody.indexOf("but no enqueue appeared");
      ok(iUnconf >= 0, "PARSE: could not find the unconfirmed-write return in postToSessionInbox");
      const unconfReturn = iUnconf < 0 ? "" : postBody.slice(postBody.lastIndexOf("return {", iUnconf), iUnconf);
      ok(/\bok:\s*false\b/.test(unconfReturn) && !/\bok:\s*true\b/.test(unconfReturn),
         "CONFIRM: a write that cannot be confirmed must return ok:false - a successful write is not proof of delivery, and this is the one return where saying otherwise is invisible");
      ok(/NOT delivered/.test(postBody),
         "CONFIRM: the unconfirmed-write refusal says outright that it is NOT delivered, so a log reader cannot mistake it for a send");
      ok(!/transcript[\s\S]{0,80}\?\?\s*""/.test(postBody) && /no readable transcript/.test(postBody),
         "CONFIRM: a session with no readable transcript must be REFUSED, never sent blind - there would be no way to tell delivery from a silent discard");

      // =====================================================================
      // WIRING - host
      // =====================================================================
      const delivBody = bodyOf(hostSrc, "async function deliverTextToSession(", "deliverTextToSession()");
      ok(delivBody.length > 0, "PARSE: deliverTextToSession has an empty body - every WIRING assertion would pass vacuously");
      const iInbox = delivBody.indexOf("postToSessionInbox(");
      const iClip = delivBody.indexOf("copyToClipboard(");
      const iDispatch = delivBody.indexOf("CLAUDE_BIN");
      ok(iInbox >= 0, "WIRING: deliverTextToSession must actually call postToSessionInbox - otherwise the module is dead code and every message still goes to the clipboard");
      ok(iInbox >= 0 && iClip >= 0 && iInbox < iClip,
         "WIRING: the inbox must be tried BEFORE the clipboard branch");
      ok(iInbox >= 0 && iDispatch >= 0 && iInbox < iDispatch,
         "WIRING: the inbox must be tried BEFORE the headless dispatch branch");
      ok(/postToSessionInbox\(record,/.test(delivBody),
         "WIRING: the WHOLE session record is handed to the inbox - it needs `inbox` and `transcript`, not just `cwd`");
      ok(/record\s*=\s*JSON\.parse/.test(delivBody),
         "WIRING: the record must be parsed and kept - the version this replaced read only `.cwd` off it and threw the rest away");
      // The fallback must FALL THROUGH. A `return` in the failure arm would turn
      // every one of the four failure modes into a message that vanished.
      const failArm = delivBody.slice(iInbox, iClip);
      ok(/r\.why/.test(failArm),
         "WIRING: the failure log must include the module's own `why` - a generic message makes all four failure modes look alike");
      ok(!/\breturn\b/.test(failArm.slice(failArm.indexOf("console.error"))),
         "WIRING: the inbox failure arm must FALL THROUGH to the clipboard, never return - a returned failure is a message that silently vanished");

      // The escape hatch, both directions. The default matters as much as the
      // override: with the default still "clipboard" the inbox path would be
      // unreachable unless someone opted in, which is not shipping it.
      const dflt = hostSrc.match(/const VOICE_DELIVERY = process\.env\.DECKHAND_VOICE_DELIVERY \|\| "([a-z]+)";/);
      ok(dflt != null, "PARSE: could not find VOICE_DELIVERY's default");
      ok(dflt?.[1] !== "clipboard",
         "WIRING: the DEFAULT must not be \"clipboard\", or the inbox path never runs unless someone opts in");
      ok(dflt?.[1] !== "dispatch",
         "WIRING: the DEFAULT must not be \"dispatch\" - the second-author problem that demoted it has not gone away");
      ok(/if \(VOICE_DELIVERY !== "clipboard"\) \{[\s\S]{0,600}postToSessionInbox\(/.test(delivBody),
         "WIRING: DECKHAND_VOICE_DELIVERY=clipboard must SKIP the socket entirely - it is a working escape hatch and must keep meaning exactly what it meant");
      ok(/if \(VOICE_DELIVERY !== "dispatch"\) \{/.test(delivBody),
         "WIRING: the clipboard branch's own guard is unchanged, so `dispatch` still reaches `claude -p`");

      // =====================================================================
      // WIRING - hook. BEHAVIOURAL: the real hook, as a child, against a
      // throwaway $HOME. A regex over the source would keep passing against a
      // hook that had stopped running.
      // =====================================================================
      const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-inbox-"));
      try {
        const HOME = path.join(box, "home");
        const TMP = path.join(box, "tmp");
        fs.mkdirSync(path.join(HOME, ".claude", "deckhand-sessions"), { recursive: true });
        fs.mkdirSync(TMP, { recursive: true });
        const SOCK = "/tmp/cc-socks/12345.sock";
        const fire = (id, env) => {
          const stdout = execFileSync(process.execPath, [hookPath], {
            input: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: REPO }),
            env: { ...process.env, HOME, DECKHAND_TMP: TMP, ...env },
            encoding: "utf8",
          });
          ok(stdout === "",
             "HOOK: the hook must write NOTHING to stdout - on a PermissionRequest that channel decides a real dialog");
          return JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "deckhand-sessions", `${id}.json`), "utf8"));
        };

        const withBoth = fire("aa", { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN });
        ok(withBoth.inbox?.socket === SOCK,
           `HOOK: CLAUDE_CODE_MESSAGING_SOCKET must be published on the record - got ${JSON.stringify(withBoth.inbox)}. It is the ONLY way to learn the path: there is no registry and no derivation from a session id`);
        ok(withBoth.inbox?.token === TOKEN,
           "HOOK: CLAUDE_CODE_MESSAGING_TOKEN must be published on the record - the socket refuses an unauthenticated connection");

        // Absent variables are the normal case on an older Claude Code, and the
        // hook must degrade to the clipboard rather than publish half a pair.
        const noEnv = { CLAUDE_CODE_MESSAGING_SOCKET: "", CLAUDE_CODE_MESSAGING_TOKEN: "" };
        ok(fire("bb", noEnv).inbox === undefined,
           "HOOK: with neither variable set the key is ABSENT, not an empty stub the host would try to open");
        ok(fire("cc", { ...noEnv, CLAUDE_CODE_MESSAGING_SOCKET: SOCK }).inbox === undefined,
           "HOOK: a socket with no token is unusable and must not be published - half a pair reads as a working inbox and refuses on every send");
        ok(fire("dd", { ...noEnv, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN }).inbox === undefined,
           "HOOK: a token with no socket must not be published, and must not leak the credential onto a record that cannot use it");

        // The record is rebuilt from scratch on every event. Dropping the inbox
        // on an event that inherits no environment would silently demote the
        // whole session back to the clipboard - which looks like it never shipped.
        const carried = execFileSync(process.execPath, [hookPath], {
          input: JSON.stringify({ hook_event_name: "Stop", session_id: "aa", cwd: REPO }),
          env: { ...process.env, HOME, DECKHAND_TMP: TMP, ...noEnv },
          encoding: "utf8",
        });
        ok(carried === "", "HOOK: still nothing on stdout on a later event");
        const after = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "deckhand-sessions", "aa.json"), "utf8"));
        ok(after.inbox?.socket === SOCK && after.inbox?.token === TOKEN,
           "HOOK: a later event that sees no environment must CARRY the inbox forward, not drop it");
      } finally {
        fs.rmSync(box, { recursive: true, force: true });
      }

      if (!quiet) {
        // The credential note, asserted rather than trusted to a reader: the token
        // authorises posting into that session and is written to disk in the clear.
        const hookSrc = fs.readFileSync(hookPath, "utf8");
        const inboxFn = bodyOf(hookSrc, "function messagingInbox(", "messagingInbox()");
        ok(inboxFn.length > 0, "PARSE: messagingInbox has an empty body");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// --selftest. Each fault is injected into a COPY in a temp dir - never the repo
// file - and the run must FAIL. An assertion that cannot fail is a defect.
// ---------------------------------------------------------------------------
async function selftest() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-inbox-selftest-"));
  const origInbox = fs.readFileSync(INBOX_SRC, "utf8");
  const origHost = fs.readFileSync(HOST_SRC, "utf8");
  const origHook = fs.readFileSync(HOOK_SRC, "utf8");

  const faults = [
    // THE fault this checker was written for: the shape that is accepted,
    // reports success, and delivers nothing.
    ["inbox", 'the user frame reverted to the WRONG {"type":"message","text":...} shape',
     (s) => s.replace(/\{ type: "user", message: \{ role: "user", content: text \} \}/,
                      '{ type: "message", text }')],
    ["inbox", "the text moved off message.content to a top-level .text",
     (s) => s.replace(/\{ type: "user", message: \{ role: "user", content: text \} \}/,
                      '{ type: "user", text, message: { role: "user" } }')],
    ["inbox", "the auth frame dropped, so the connection is never authorised",
     (s) => s.replace(/\{ type: "auth", token \}\),\n/, '{ type: "auth" }),\n')],
    ["inbox", "the frames joined WITHOUT newlines, so the server sees one unterminated line",
     (s) => s.replace(/\.map\(\(l\) => l \+ "\\n"\)\.join\(""\)/, '.join("")')],
    ["inbox", "a dequeue accepted as confirmation, so every send confirms itself",
     (s) => s.replace(/if \(rec\.operation !== "enqueue"\) continue;\n/, "")],
    ["inbox", "an enqueue with no content accepted, so a background task's report confirms our send",
     (s) => s.replace(/if \(typeof rec\.content !== "string"\) continue;\n\s*if \(rec\.content\.includes\(text\)\) return true;/,
                      "if (typeof rec.content !== \"string\") return true;\n    if (rec.content.includes(text)) return true;")],
    ["inbox", "empty text confirms anything (includes(\"\") is always true)",
     (s) => s.replace(/if \(!text\) return false;\n/, "")],
    ["inbox", "an unconfirmed write reported as a SUCCESS - the exact defect the socket makes possible",
     (s) => s.replace(/return \{\n    ok: false,\n    wrote: true,\n    why: `written to/,
                      "return {\n    ok: true,\n    wrote: true,\n    why: `written to")],
    ["inbox", "the transcript offset taken AFTER the write, so a retry confirms the previous attempt",
     (s) => s.replace(/  let from = 0;\n  try \{ from = \(await fsp\.stat\(transcript\)\)\.size; \} catch \{\}\n\n  const w = await writeFrames\(socketPath, token, text\);\n  if \(!w\.ok\) return \{ ok: false, wrote: false, why: w\.why \};/,
                      "  const w = await writeFrames(socketPath, token, text);\n  if (!w.ok) return { ok: false, wrote: false, why: w.why };\n  let from = 0;\n  try { from = (await fsp.stat(transcript)).size; } catch {}")],
    ["inbox", "a missing transcript sent blind instead of refused",
     (s) => s.replace(/      why: `no readable transcript[\s\S]*?\n    \};/,
                      "      why: `unused`,\n    };").replace(/  if \(!transcript \|\| !fs\.existsSync\(transcript\)\) \{/, "  if (false) {")],
    ["inbox", "the two distinct refusals collapsed into one indistinguishable message",
     (s) => s.replace(/why: `the messaging socket \$\{socketPath\} is gone \(the session exited\)`/,
                      'why: "the session record carries no messaging socket"')],

    ["host", "the inbox call removed, so every message goes back to the clipboard",
     (s) => s.replace(/const r = await postToSessionInbox\(record, text\);/,
                      "const r = { ok: false, why: \"disabled\" };")],
    // Textually MOVED, not disabled: the ordering assertion is positional, so a
    // fault that only neutered the guard would be caught by a different
    // assertion and leave the ordering one unproven.
    ["host", "the inbox block moved BELOW the clipboard branch, which returns first",
     (s) => {
       const a = s.indexOf('if (VOICE_DELIVERY !== "clipboard") {');
       const b = s.indexOf('if (VOICE_DELIVERY !== "dispatch") {');
       if (a < 0 || b < 0 || a >= b) return s;
       const block = s.slice(a, b);
       const rest = s.slice(b);
       const endClip = rest.indexOf("\n}\n\n") + 4;
       if (endClip < 4) return s;
       return s.slice(0, a) + rest.slice(0, endClip) + block + rest.slice(endClip);
     }],
    ["host", "the failure arm RETURNS instead of falling through, so a failed send vanishes",
     (s) => s.replace(/      `falling back to \$\{VOICE_DELIVERY === "dispatch" \? "a headless claude -p" : "the clipboard"\}\.`\n  \);/,
                      "      `falling back.`\n  );\n  return;")],
    ["host", "the failure logged WITHOUT its cause, so all four failure modes read alike",
     (s) => s.replace(/`\$\{tag\}: session inbox unavailable \(\$\{r\.why\}\)/,
                      "`${tag}: session inbox unavailable")],
    ["host", "the default left at \"clipboard\", so the inbox path is unreachable without opting in",
     (s) => s.replace(/const VOICE_DELIVERY = process\.env\.DECKHAND_VOICE_DELIVERY \|\| "inbox";/,
                      'const VOICE_DELIVERY = process.env.DECKHAND_VOICE_DELIVERY || "clipboard";')],
    ["host", "DECKHAND_VOICE_DELIVERY=clipboard no longer skips the socket - the escape hatch removed",
     (s) => s.replace(/if \(VOICE_DELIVERY !== "clipboard"\) \{\n  const r = await postToSessionInbox/,
                      "if (true) {\n  const r = await postToSessionInbox")],
    ["host", "only .cwd read off the record again, so the inbox is never seen",
     (s) => s.replace(/    record = JSON\.parse\(await fs\.readFile\(path\.join\(SESSIONS_DIR, `\$\{sessionId\}\.json`\), "utf8"\)\);\n    cwd = record\.cwd \|\| undefined;/,
                      '    cwd = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${sessionId}.json`), "utf8")).cwd || undefined;')],

    ["hook", "the inbox never published on the record",
     (s) => s.replace(/\.\.\.\(inbox \? \{ inbox \} : existing\.inbox \? \{ inbox: existing\.inbox \} : \{\}\),/, "")],
    ["hook", "the inbox NOT carried forward, so one environment-less event demotes the session for good",
     (s) => s.replace(/\.\.\.\(inbox \? \{ inbox \} : existing\.inbox \? \{ inbox: existing\.inbox \} : \{\}\),/,
                      "...(inbox ? { inbox } : {}),")],
    ["hook", "half a pair published - a socket with no token reads as a working inbox",
     (s) => s.replace(/if \(!socket \|\| !token\) return null;/, "if (!socket && !token) return null;")],
    ["hook", "the socket read from the wrong variable, so the path is always empty",
     (s) => s.replace(/process\.env\.CLAUDE_CODE_MESSAGING_SOCKET \?\? ""/, 'process.env.CLAUDE_CODE_SOCKET ?? ""')],
    ["hook", "a line written to stdout while gathering the inbox, which can auto-answer a real dialog",
     (s) => s.replace(/^function messagingInbox\(\) \{$/m, 'function messagingInbox() {\n  console.log("");')],
  ];

  let caught = 0, injected = 0;
  for (let i = 0; i < faults.length; i++) {
    const [which, name, mutate] = faults[i];
    const src = which === "inbox" ? origInbox : which === "host" ? origHost : origHook;
    const mutated = mutate(src);
    if (mutated === src) { console.log(`  NOT INJECTED (pattern no longer matches): ${name}`); continue; }
    injected++;
    const p = path.join(box, `${which}-${i}.mjs`);
    fs.writeFileSync(p, mutated);
    const before = failures.length;
    pass = 0;
    try {
      await main({
        inboxPath: which === "inbox" ? p : INBOX_SRC,
        hostPath: which === "host" ? p : HOST_SRC,
        hookPath: which === "hook" ? p : HOOK_SRC,
        quiet: true,
      });
    } catch { /* a crash is also a catch */ }
    const found = failures.length > before;
    // NAME THE CATCHER. "caught" on its own does not say whether the assertion
    // that fired is the one meant to guard this fault - a PARSE regex that
    // stopped matching also "catches" everything, and would hide the fact that
    // the real assertion had gone toothless.
    const by = found ? failures[before].split(" - ")[0] : "";
    console.log(`  ${found ? "caught  " : "MISSED  "} ${name}${found ? `\n            by: ${by}` : ""}`);
    if (found) caught++;
    failures.length = before;
  }
  fs.rmSync(box, { recursive: true, force: true });
  console.log(`\nselftest: ${caught}/${injected} injected faults caught (${faults.length} defined)`);
  process.exit(caught === injected && injected === faults.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  await main({});
  console.log(`\n${pass} assertions passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length ? 1 : 0);
}
