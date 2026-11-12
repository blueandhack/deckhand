#!/usr/bin/env node
// Deckhand's Antigravity hook: one record per conversation in
// ~/.claude/deckhand-sessions/<conversationId>.json, read by host/index.mjs on its tick.
//
// Registered by install-antigravity-hooks.mjs in ~/.gemini/config/hooks.json for
// SessionStart, PreInvocation, PostToolUse and Stop - and NEVER PreToolUse. Measured
// 2026-11-11 against agy 1.5.6 by registering capture hooks in a throwaway workspace
// (docs/reference/gemini.md, "Hooks"):
//
//   - A PreToolUse hook GATES the tool. `{}` on stdout was read as a missing decision
//     and DENIED the call ("tool call denied by pre-tool hook"), and a hook that
//     exited 1 FAILED the call ("JSON hook ... failed: exit status 1"). So a hook on
//     that event turns any Deckhand fault - a moved Node after an uninstall, a full
//     disk - into every Antigravity tool call breaking. The other four events were
//     run with the hook crashing, printing nothing, and pointing at a Node that does
//     not exist: the turn completed correctly every time.
//   - There is no event while Antigravity's approval prompt is on screen. PreToolUse
//     runs BEFORE it and the prompt only appears after the hook returns; during the
//     prompt the conversation index says RUNNING and the transcript's last step says
//     DONE. So this hook never claims "asking" - a prompt we cannot see is not one we
//     may report - and never answers anything.
//
// It writes NOTHING to stdout. The events it is registered on take an optional
// injectSteps/decision, and absent is the documented "carry on"; anything printed by
// accident could become one. It always exits 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "deckhand-sessions");
const DEBUG_LOG = path.join(os.homedir(), ".claude", "deckhand-antigravity-hook-debug.log");
const DEBUG_MAX_BYTES = 2 * 1024 * 1024;

// Which Antigravity surface ran the conversation, from the directory its artifacts
// live under (`<app_data_dir>/brain/<id>`): the same three stores
// host/gemini-sessions.mjs reads, and the same bundle ids it activates on a click.
const STORES = {
  "antigravity": "com.google.antigravity",
  "antigravity-ide": "com.google.antigravity-ide",
  "antigravity-cli": "",
};
export function storeOf(artifactDir) {
  const m = /\/\.gemini\/([^/]+)\/brain\//.exec(String(artifactDir ?? "") + "/");
  return m && m[1] in STORES ? m[1] : "";
}

// The status an event implies. Working from the first event of a turn to its Stop;
// Stop is "waiting" only when Antigravity says EVERYTHING is idle - `fullyIdle` is
// false while background tasks the turn started are still running, and those are
// still work.
export function statusFor(data) {
  switch (data?.hookEventName) {
    case "SessionStart":
    case "PreInvocation":
    case "PostInvocation":
    case "PostToolUse":
      return "working";
    case "Stop":
      return data.fullyIdle === false ? "working" : "waiting";
    default:
      return null; // an event this hook does not interpret: write nothing
  }
}

// One line, printable ASCII-ish, capped. The host transliterates again for the device
// (to-ascii.mjs); this only keeps a pasted multi-line prompt from bloating the record.
export function oneLine(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// The record for this event, merged onto the existing one so a field only some events
// carry (the model, the prompt) survives the events that do not.
export function buildRecord(data, existing, now) {
  const status = statusFor(data);
  if (!status) return null;
  const store = storeOf(data.artifactDirectoryPath) || existing.store || "";
  const cwd = data.cwd || (Array.isArray(data.workspacePaths) && data.workspacePaths[0]) || existing.cwd || "";
  const prompt = data.lastUserInput ? oneLine(data.lastUserInput, 400) : existing.prompt || "";
  return {
    cwd,
    model: data.modelName || existing.model || "",
    transcript: data.transcriptPath || existing.transcript || "",
    prompt,
    store,
    ...(STORES[store] ? { app: { id: STORES[store], entry: "" } } : existing.app ? { app: existing.app } : {}),
    status,
    agent: "antigravity",
    updated_at: now,
  };
}

function dlog(text) {
  try {
    try {
      if (fs.statSync(DEBUG_LOG).size > DEBUG_MAX_BYTES) fs.renameSync(DEBUG_LOG, DEBUG_LOG + ".1");
    } catch {}
    fs.appendFileSync(DEBUG_LOG, text);
  } catch {}
}

function writeRecord(filePath, record) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, filePath);
}

// A conversation id becomes a FILENAME, so only a uuid-shaped one is accepted - a
// payload naming "../x" must not write outside the sessions directory.
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function main(input) {
  const data = JSON.parse(input);
  const id = data.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || "";
  // Before the first log line: the log lives in ~/.claude too, and on a first-ever
  // event neither exists yet - measured, SessionStart's line was the one lost.
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  dlog(`${new Date().toISOString()} event=${data.hookEventName ?? "?"} conv=${id}` +
       (data.hookEventName === "Stop" ? ` reason=${data.terminationReason ?? ""} idle=${data.fullyIdle}` : "") + "\n");
  if (!ID_RE.test(id)) return;
  const filePath = path.join(SESSIONS_DIR, `${id}.json`);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  // Never overwrite another agent's record that happens to share an id.
  if (existing.agent && existing.agent !== "antigravity") return;
  const record = buildRecord(data, existing, Date.now());
  if (record) writeRecord(filePath, record);
}

// Run only as a hook, not when a checker imports this file for its functions. Real
// paths on both sides: a URL against a raw argv path misses one with a space in it.
function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? ""); }
  catch { return false; }
}
if (isMain()) {
  try {
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      try { main(input); } catch (e) { dlog(`  error: ${e?.message ?? e}\n`); }
      process.exitCode = 0;
    });
  } catch {}
}
