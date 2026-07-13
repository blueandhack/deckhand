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
// Written by host/index.mjs every tick; tells us a display is actually
// connected. Without it we never block waiting for a remote answer.
const HOST_ALIVE = "/tmp/deckhand-host-alive";
// How long the prompt stays answerable from the device. The matching hook
// `timeout` in settings.json must be a few seconds LONGER, or Claude Code
// kills the hook before this elapses.
const REMOTE_WAIT_MS = 90_000;

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

function remoteAvailable() {
  try {
    const st = fs.statSync(HOST_ALIVE);
    if (Date.now() - st.mtimeMs > 15_000) return false;
    return JSON.parse(fs.readFileSync(HOST_ALIVE, "utf8")).connected === true;
  } catch {
    return false;
  }
}

// Extract "what is being asked" from the hook payload, for the device to
// display. pid ties a device answer back to this exact prompt.
function buildAsk(data) {
  const pid = Math.random().toString(36).slice(2, 10);
  if (data.hook_event_name === "PermissionRequest") {
    const ti = data.tool_input ?? {};
    const detail = ti.command ?? ti.description ?? ti.file_path ?? ti.url ?? JSON.stringify(ti);
    return {
      pid,
      kind: "perm",
      title: clean(`Allow ${data.tool_name ?? "tool"}?`, 26),
      detail: clean(detail, 600),
      options: ["Allow", "Deny"],
    };
  }
  if (data.tool_name === "AskUserQuestion") {
    const q = data.tool_input?.questions?.[0] ?? {};
    const opts = (q.options ?? []).slice(0, 4).map((o) => clean(o?.label ?? o, 24));
    return {
      pid,
      kind: "question",
      title: clean(q.header ?? "Question", 26),
      detail: clean(q.question ?? "", 600),
      options: opts.length ? opts : ["OK"],
    };
  }
  if (data.tool_name === "ExitPlanMode") {
    return {
      pid,
      kind: "plan",
      title: "Approve plan?",
      detail: clean(data.tool_input?.plan ?? "", 600),
      options: ["Approve", "Keep planning"],
    };
  }
  return null;
}

// Poll for the answer file the host writes when the device user taps an
// option. A stale answer for a different prompt is deleted, not honored.
async function waitForRemoteAnswer(sessionId, pid, timeoutMs) {
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
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// The ONLY place this script may write to stdout: a real decision, in the
// hook's decision-JSON dialect for the event that asked.
function emitDecision(data, ask, answer) {
  let out;
  if (ask.kind === "perm") {
    out = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          answer.idx === 0
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Denied by the user from the Deckhand display remote." },
      },
    };
  } else if (ask.kind === "plan") {
    out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: answer.idx === 0 ? "allow" : "deny",
        ...(answer.idx === 0
          ? {}
          : { permissionDecisionReason: "The user chose to keep planning (answered from the Deckhand display remote)." }),
      },
    };
  } else {
    // AskUserQuestion has no native remote-answer channel; a deny whose
    // reason carries the chosen option delivers the answer to Claude.
    out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `The user already answered this question from their remote display. ` +
          `Their answer: "${answer.label || `option ${answer.idx + 1}`}". ` +
          `Treat this as the user's response and continue; do not re-ask.`,
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

      try {
        fs.appendFileSync(
          DEBUG_LOG,
          `${new Date().toISOString()} event=${data.hook_event_name} tool=${data.tool_name ?? ""} session=${sessionId ?? ""}\n`
        );
        // Full payload for the two "user is being asked something" events,
        // so payload shape differences across surfaces stay diagnosable.
        if (data.hook_event_name === "Notification" || data.hook_event_name === "PermissionRequest") {
          fs.appendFileSync(DEBUG_LOG, `  full payload: ${JSON.stringify(data)}\n`);
        }
      } catch {
        // debug trail is best-effort only
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
      // For prompts the device can answer, publish the question alongside
      // the status - but only bother when a display is connected.
      const canAsk =
        data.hook_event_name === "PermissionRequest" ||
        (data.hook_event_name === "PreToolUse" &&
          (data.tool_name === "AskUserQuestion" || data.tool_name === "ExitPlanMode"));
      const ask = canAsk && remoteAvailable() ? buildAsk(data) : null;

      const record = {
        cwd: data.cwd ?? existing.cwd ?? "",
        model: data.model ?? existing.model ?? "",
        // Most hook events don't carry the model (desktop-app sessions never
        // do), but the transcript path is in every payload and each assistant
        // message in it records its model - the host reads it from there.
        transcript: data.transcript_path ?? existing.transcript ?? "",
        status,
        updated_at: Date.now(),
        ...(ask ? { ask } : {}),
      };
      writeRecord(filePath, record);

      if (ask) {
        // Block (bounded, under the hook timeout) so a device tap can decide
        // this prompt. No tap -> exit silently and the normal dialog flow
        // continues untouched.
        const answer = await waitForRemoteAnswer(sessionId, ask.pid, REMOTE_WAIT_MS);
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
          try {
            fs.appendFileSync(DEBUG_LOG, `  remote answer: pid=${ask.pid} idx=${answer.idx} label=${answer.label ?? ""}\n`);
          } catch {}
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
