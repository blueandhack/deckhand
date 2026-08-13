#!/usr/bin/env node
// Claude Code hook for the "deckhand" ESP32 project's SESSIONS tab.
//
// Registered for SessionStart, UserPromptSubmit, PreToolUse, Notification,
// PostToolUse, Stop, and SessionEnd (see ~/.claude/settings.json). Each
// invocation just writes/removes a tiny JSON file per session under
// ~/.claude/deckhand-sessions/ so the host script (../Projects/deckhand/host/index.mjs)
// can list which projects are running and what each is doing right now:
//   - SessionStart / Stop        -> "waiting" (fresh session, or turn just ended)
//   - UserPromptSubmit           -> "working" (a prompt was just submitted)
//   - PreToolUse (AskUserQuestion/ExitPlanMode only, via the settings.json
//     matcher)                  -> "asking" (paused specifically for a
//     question or plan approval)
//   - PermissionRequest          -> "asking" (a permission allow/deny dialog
//     is on screen). This is the signal that works in EVERY surface: the
//     desktop app never fires the Notification hook at all (verified: a
//     desktop session with 650+ tool events and many permission prompts
//     logged zero Notification events), so permission prompts there were
//     invisible until this was added.
//   - Notification, notification_type == "permission_prompt"
//                                -> "asking" (terminal sessions; verified via
//     a captured payload: {"message":"Claude needs your permission",
//     "notification_type":"permission_prompt"} - confirmed real, not guessed)
//   - Notification, any other/missing notification_type
//                                -> "waiting" (covers generic idle nudges;
//     unlike "asking" this can't incorrectly override an already-correct
//     "waiting" status set by Stop, since it's idempotent)
//   - PostToolUse / PostToolUseFailure (any tool)
//                                -> "working" (resumed after the pause; the
//     failure variant also covers a denied permission, which would otherwise
//     leave the status stuck on "asking")
//   - SessionEnd                -> delete the file
//
// IMPORTANT: a PermissionRequest hook that prints JSON to stdout can
// auto-allow/deny the dialog. This script must never write to stdout.
//
// This must never slow down or block a real Claude Code session, so it does
// the minimum file I/O and always exits cleanly even on bad input.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "deckhand-sessions");
const ANSWERS_DIR = path.join(os.homedir(), ".claude", "deckhand-answers");
const DEBUG_LOG = path.join(os.homedir(), ".claude", "deckhand-session-hook-debug.log");
// ROTATED, for the same reason the host's log is: this appends on EVERY hook event,
// and PostToolUse is registered with matcher ".*" - so it is one line per tool call
// across every Claude Code session on the machine, plus the FULL JSON payload of
// every Notification and PermissionRequest. A single real debugging session put 3066
// events in here. Unrotated it grows without bound inside ~/.claude.
// 5MB with one previous generation (.1) matches host/index.mjs, so the repo has one
// rule rather than two - and keeping a generation means the events leading UP TO a
// problem survive the rotation that follows it.
const DEBUG_MAX_BYTES = 5 * 1024 * 1024;
// Written by host/index.mjs every tick; tells us a display is actually
// connected, and whether the user has opted into answering FROM the device.
// Without it we never block waiting for a remote answer.
const HOST_ALIVE = "/tmp/deckhand-host-alive";
// How long the prompt stays answerable from the device. The matching hook
// `timeout` in settings.json must be a few seconds LONGER, or Claude Code
// kills the hook before this elapses.
const REMOTE_WAIT_MS = 90_000;

// Which tool invoked us. Codex's payload is field-identical to Claude Code's and carries
// no agent marker, so the registration says so explicitly rather than the hook guessing
// from a transcript path neither tool guarantees. Defaults to claude, so the existing
// ~/.claude/settings.json registration needs no migration.
const AGENT = (process.argv.find((a) => a.startsWith("--agent=")) ?? "").slice(8) || "claude";

// The only writer for DEBUG_LOG. Entirely best-effort: this is a debug trail, and a
// hook that throws while trying to log would be far worse than a missing line.
//
// Unlike the host, this process is SHORT-LIVED - one invocation per event - so it
// cannot track its own size in memory the way host/index.mjs does; it has to ask.
// statSync is a single cheap syscall next to the readFileSync/writeFileSync this hook
// already does per event, and it happens BEFORE the append so the file can never sit
// over the cap.
//
// Concurrent invocations (several sessions at once) can both decide to rotate. That
// races, but harmlessly: renameSync is atomic, so the worst case is one extra
// generation boundary, never a corrupt line or a thrown exception. Never a reason to
// take a lock in a hook on the critical path of every tool call.
//
// NOTE: nothing here may ever reach stdout. A PermissionRequest hook's stdout is a
// decision channel, and stray output there can auto-allow or auto-deny the dialog.
function dlog(text) {
  try {
    let size = 0;
    try {
      size = fs.statSync(DEBUG_LOG).size;
    } catch {
      // no log yet - nothing to rotate
    }
    if (size >= DEBUG_MAX_BYTES) fs.renameSync(DEBUG_LOG, `${DEBUG_LOG}.1`);
    fs.appendFileSync(DEBUG_LOG, text);
  } catch {
    // debug trail is best-effort only, and must never break the session
  }
}

// WHICH EVENT WE BLOCK ON - measured, not assumed. This is the whole trick.
//
// Both surfaces can be live at once, but only on the right event. Measured from
// 3066 real hook events in ~/.claude/deckhand-session-hook-debug.log:
//
//   PermissionRequest - Claude Code shows its dialog WHILE this hook runs. 310
//     samples resolved in a smooth 2-60s human-response curve with NO spike at
//     the 90s timeout, which is only possible if the dialog was on screen the
//     whole time. So blocking here costs the Mac nothing: the Mac dialog and the
//     device's buttons race, and the first one to answer wins. THIS is where we
//     wait.
//   PreToolUse (AskUserQuestion / ExitPlanMode) - the TOOL draws the dialog, and
//     it doesn't run until this process exits, so nothing is on screen while we
//     wait. Measured: three AskUserQuestion prompts sat at exactly 90.1s, the
//     full timeout, answerable nowhere but the device. Blocking here is pure
//     dead delay. We NEVER wait on this event - we only publish the ask so the
//     device can start displaying the question immediately.
//
// A question fires BOTH events (PreToolUse first, then PermissionRequest ~0ms
// later), and the PermissionRequest payload carries the full question with its
// real option labels - verified against a captured payload. So a question is
// answerable from the device via its PermissionRequest, with the Mac's own
// dialog visible the entire time. Nothing is given up.
//
// `remoteAnswer` (default ON) is just an off switch: with it off we never block,
// and the device becomes a read-only mirror.

// The device font can't render control bytes (newlines, tabs) - they show as
// garbage glyphs - so flatten them to spaces. Commands lose their line breaks
// but read cleanly; nothing renders as mojibake.
function clean(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control bytes (newlines/tabs) -> space
    .replace(/ {2,}/g, " ")                    // collapse runs
    .trim()
    .slice(0, max);
}

// Like clean(), but for the detail field, which the device now renders as a
// code block when it contains newlines - so KEEP '\n' as a hard line break.
// Tabs become spaces; other control bytes and code-fence lines are stripped;
// blank-line runs collapse so a snippet stays compact on the small screen.
// Per-line leading whitespace is preserved (indentation reads as code).
function cleanMultiline(s, max) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")                    // normalize newlines
    .replace(/\t/g, "  ")                         // tabs -> 2 spaces
    .replace(/^\`\`\`.*$/gm, "")             // drop \`\`\` fence lines
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ") // controls except \n
    .replace(/[ ]+$/gm, "")                        // trailing spaces per line
    .replace(/\n{3,}/g, "\n\n")                 // collapse blank-line runs
    .replace(/^\n+/, "")                          // strip leading blank lines
    .trimEnd()
    .slice(0, max);
}

// `display`  - a device is connected right now, so an ask is worth publishing.
// `answerable` - the device is allowed to decide prompts. Only ever acted on for
//              PermissionRequest, where the Mac's dialog stays visible anyway.
function remoteState() {
  try {
    const st = fs.statSync(HOST_ALIVE);
    if (Date.now() - st.mtimeMs > 15_000) return { display: false, answerable: false };
    const hb = JSON.parse(fs.readFileSync(HOST_ALIVE, "utf8"));
    return {
      display: hb.connected === true,
      // Absent (older host) means ON: waiting on a PermissionRequest doesn't
      // cost the Mac its dialog, so the useful default is to allow it.
      answerable: hb.connected === true && hb.remoteAnswer !== false,
    };
  } catch {
    return { display: false, answerable: false };
  }
}

// Extract "what is being asked" from the hook payload, for the device to
// display. pid ties a device answer back to this exact prompt.
// NOTE the order: the TOOL is checked before the event. A question or a plan
// approval raises a PermissionRequest too, and that payload carries the real
// question and its option labels - so it must build the question/plan ask, not a
// generic "Allow AskUserQuestion?" with Allow/Deny. Getting this backwards is
// what would make the device offer two meaningless buttons for a 4-way question.
function buildAsk(data) {
  const pid = Math.random().toString(36).slice(2, 10);
  if (data.tool_name === "AskUserQuestion") {
    const q = data.tool_input?.questions?.[0] ?? {};
    const opts = (q.options ?? []).slice(0, 4).map((o) => clean(o?.label ?? o, 32));
    return {
      pid,
      kind: "question",
      title: clean(q.header ?? "Question", 34),
      detail: cleanMultiline(q.question ?? "", 1400),
      options: opts.length ? opts : ["OK"],
    };
  }
  if (data.tool_name === "ExitPlanMode") {
    return {
      pid,
      kind: "plan",
      title: "Approve plan?",
      detail: cleanMultiline(data.tool_input?.plan ?? "", 1400),
      options: ["Approve", "Keep planning"],
    };
  }
  if (data.hook_event_name === "PermissionRequest") {
    const ti = data.tool_input ?? {};
    const detail = ti.command ?? ti.description ?? ti.file_path ?? ti.url ?? JSON.stringify(ti);
    return {
      pid,
      kind: "perm",
      title: clean(`Allow ${data.tool_name ?? "tool"}?`, 34),
      detail: cleanMultiline(detail, 1400),
      options: ["Allow", "Deny"],
    };
  }
  return null;
}

// Poll for the answer file the host writes when the device user taps an
// option. A stale answer for a different prompt is deleted, not honored.
//
// Also watches for the Mac winning the race. Because the Mac's dialog is on
// screen the whole time we wait, it usually answers first - and when it does,
// the next event for this session (PostToolUse -> "working") rewrites the record
// without our `ask`. Spotting that lets us exit in ~1s instead of holding a node
// process for the full 90s on every single prompt.
async function waitForRemoteAnswer(sessionId, pid, timeoutMs, sessionFile) {
  const answerPath = path.join(ANSWERS_DIR, `${sessionId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const a = JSON.parse(fs.readFileSync(answerPath, "utf8"));
      fs.rmSync(answerPath, { force: true });
      if (a.pid === pid) return a;
    } catch {
      // no answer yet
    }
    // Answered on the Mac (or the session ended): our ask is gone, stop waiting.
    try {
      const cur = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (!cur.ask || cur.ask.pid !== pid) return null;
    } catch {
      return null; // file gone - SessionEnd
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// The ONLY place this script may write to stdout: a real decision, in the
// hook's decision-JSON dialect for the event that asked.
//
// We only ever block on PermissionRequest, so that's the dialect that matters;
// the PreToolUse branch is kept for safety in case a future change waits there
// again. Note `kind` (what is being asked) is independent of the event dialect:
// a QUESTION can arrive as a PermissionRequest, and then the answer has to ride
// out as a deny whose message carries the chosen option, because there is no
// native channel for handing Claude a selected answer.
function emitDecision(data, ask, answer) {
  const chose = answer.label || `option ${answer.idx + 1}`;
  const carriedAnswer =
    `The user answered this from their Deckhand display. ` +
    `Their answer: "${chose}". ` +
    `Treat this as the user's response and continue; do not re-ask.`;

  let out;
  if (data.hook_event_name === "PermissionRequest") {
    let decision;
    if (ask.kind === "question") {
      decision = { behavior: "deny", message: carriedAnswer };
    } else if (answer.idx === 0) {
      decision = { behavior: "allow" };
    } else {
      decision = {
        behavior: "deny",
        message:
          ask.kind === "plan"
            ? "The user chose to keep planning (answered from the Deckhand display)."
            : "Denied by the user from the Deckhand display.",
      };
    }
    out = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  } else if (ask.kind === "plan") {
    out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: answer.idx === 0 ? "allow" : "deny",
        ...(answer.idx === 0
          ? {}
          : { permissionDecisionReason: "The user chose to keep planning (answered from the Deckhand display)." }),
      },
    };
  } else {
    out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: carriedAnswer,
      },
    };
  }
  process.stdout.write(JSON.stringify(out));
}

function writeRecord(filePath, record) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, filePath);
}

try {
  let input = "";
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", async () => {
    try {
      const data = JSON.parse(input);
      const sessionId = data.session_id;

      dlog(
        `${new Date().toISOString()} event=${data.hook_event_name} tool=${data.tool_name ?? ""} session=${sessionId ?? ""}\n`
      );
      // Full payload for the two "user is being asked something" events,
      // so payload shape differences across surfaces stay diagnosable.
      if (data.hook_event_name === "Notification" || data.hook_event_name === "PermissionRequest") {
        dlog(`  full payload: ${JSON.stringify(data)}\n`);
      }

      if (!sessionId) return;

      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);

      if (data.hook_event_name === "SessionEnd") {
        fs.rmSync(filePath, { force: true });
        return;
      }

      // Merge with any existing record so fields only some events carry
      // (e.g. "model" is only ever present on SessionStart) aren't lost.
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        // no existing record, that's fine
      }

      let status = "waiting";
      if (
        data.hook_event_name === "UserPromptSubmit" ||
        data.hook_event_name === "PostToolUse" ||
        data.hook_event_name === "PostToolUseFailure"
      ) {
        status = "working";
      } else if (
        data.hook_event_name === "PreToolUse" ||
        data.hook_event_name === "PermissionRequest" ||
        (data.hook_event_name === "Notification" && data.notification_type === "permission_prompt")
      ) {
        status = "asking";
      }
      // Publish the prompt for the device to show - but only bother when a
      // display is actually connected.
      const isPermEvent = data.hook_event_name === "PermissionRequest";
      const isPreAsk =
        data.hook_event_name === "PreToolUse" &&
        (data.tool_name === "AskUserQuestion" || data.tool_name === "ExitPlanMode");
      const remote = isPermEvent || isPreAsk ? remoteState() : { display: false, answerable: false };
      const ask = remote.display ? buildAsk(data) : null;
      // Answerable ONLY on PermissionRequest (see the note at the top): that's
      // the event whose dialog stays on screen while we wait, so a tap here
      // races the Mac instead of replacing it. A PreToolUse ask is published for
      // display only - the device renders those options as a read-only list, and
      // the matching PermissionRequest arrives moments later with real buttons.
      if (ask) ask.answerable = isPermEvent && remote.answerable;

      const record = {
        cwd: data.cwd ?? existing.cwd ?? "",
        model: data.model ?? existing.model ?? "",
        // Most hook events don't carry the model (desktop-app sessions never
        // do), but the transcript path is in every payload and each assistant
        // message in it records its model - the host reads it from there.
        transcript: data.transcript_path ?? existing.transcript ?? "",
        status,
        agent: AGENT,
        updated_at: Date.now(),
        ...(ask ? { ask } : {}),
      };
      writeRecord(filePath, record);

      // A display-only ask stops here: we exit at once so nothing is delayed.
      // Its `ask` is cleared by the next event for this session (PostToolUse /
      // PostToolUseFailure -> "working"), or replaced moments later by the
      // answerable PermissionRequest for the same prompt.
      if (ask && ask.answerable) {
        // Wait for a device tap, bounded well under the hook timeout. The Mac's
        // dialog is on screen throughout, so this is a race, not an intercept:
        // whichever surface answers first wins, and if the Mac wins we bail out
        // early rather than idling here.
        const answer = await waitForRemoteAnswer(sessionId, ask.pid, REMOTE_WAIT_MS, filePath);
        // Window over: stop offering buttons. Re-read current state rather
        // than rewriting our stale `record` - another event (e.g. PostToolUse
        // when the user answered on the Mac) may have updated status meanwhile,
        // and we must not clobber it back to "asking".
        try {
          const cur = JSON.parse(fs.readFileSync(filePath, "utf8"));
          if (cur.ask && cur.ask.pid === ask.pid) {
            delete cur.ask;
            cur.updated_at = Date.now();
            writeRecord(filePath, cur);
          }
        } catch {
          // file gone (SessionEnd) or unreadable - nothing to strip
        }
        if (answer) {
          dlog(`  remote answer: pid=${ask.pid} idx=${answer.idx} label=${answer.label ?? ""}\n`);
          emitDecision(data, ask, answer);
        }
      }
    } catch {
      // never let a malformed event break the hook
    }
  });
} catch {
  // never let this hook block or crash the session
}
