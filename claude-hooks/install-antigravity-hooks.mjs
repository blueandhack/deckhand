#!/usr/bin/env node
// Register Deckhand's Antigravity hook in ~/.gemini/config/hooks.json, or remove it.
//
//   node install-antigravity-hooks.mjs                  # register, run by `node`
//   node install-antigravity-hooks.mjs --node <path>    # register, run by <path> (the released app)
//   node install-antigravity-hooks.mjs --remove         # un-register
//
// Antigravity's hooks.json is NOT Claude Code's shape: its top level maps a hook NAME to
// that hook's events (https://antigravity.google/docs/hooks/), so Deckhand owns exactly
// one key, DECKHAND_KEY, and never reads or rewrites anyone else's. The global file is
// what the CLI loads from every workspace; `<workspace>/.agents/hooks.json` is the
// per-project one and is left alone.
//
// THE EVENT LIST IS A SAFETY PROPERTY, NOT A PREFERENCE. PreToolUse is absent on purpose:
// a hook there GATES every tool call - `{}` denied the call and a crash failed it,
// measured on agy 1.5.6 - so registering it would let any Deckhand fault break
// Antigravity. See deckhand-antigravity-hook.mjs's header for the measurements.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookCommand, runnerFromArgv } from "./hook-command.mjs";

export const DECKHAND_KEY = "deckhand";
export const EVENTS = ["SessionStart", "PreInvocation", "PostToolUse", "Stop"];
// Tool events take {matcher, hooks:[...]}; lifecycle events take the handlers directly.
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
// Seconds. The hook writes one small file and exits in ~40ms; this only bounds a hang.
export const TIMEOUT = 10;

// `; true` so the command's exit status is always 0. On the four events above a failing
// hook was measured to be harmless, but Antigravity still reports it - and the most
// likely failure is mundane (the app moved, so its Node did) and not the person's to
// fix mid-session. stderr goes nowhere for the same reason; the hook logs its own.
export function entryFor(command) {
  const handler = { type: "command", command: `${command} 2>/dev/null; true`, timeout: TIMEOUT };
  const entry = {};
  for (const ev of EVENTS) entry[ev] = TOOL_EVENTS.has(ev) ? [{ matcher: "*", hooks: [handler] }] : [handler];
  return entry;
}

// The new file's text, or null for "nothing to change". Pure, so a checker can drive it.
export function nextConfig(original, { command, remove }) {
  let cfg = {};
  if (original.trim()) {
    cfg = JSON.parse(original); // a malformed file throws: the caller refuses to touch it
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("its top level is not an object");
  }
  if (remove) {
    if (!(DECKHAND_KEY in cfg)) return null;
    delete cfg[DECKHAND_KEY];
  } else {
    const want = entryFor(command);
    if (JSON.stringify(cfg[DECKHAND_KEY]) === JSON.stringify(want)) return null;
    cfg[DECKHAND_KEY] = want;
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

function run() {
  const GEMINI_DIR = path.join(os.homedir(), ".gemini");
  const CONFIG_DIR = path.join(GEMINI_DIR, "config");
  const HOOKS = path.join(CONFIG_DIR, "hooks.json");
  const HOOK = path.join(os.homedir(), ".claude", "deckhand-antigravity-hook.mjs");
  const REMOVE = process.argv.includes("--remove");

  if (!fs.existsSync(GEMINI_DIR)) {
    console.log(`No ${GEMINI_DIR} - Antigravity is not installed here, nothing to do.`);
    return 0;
  }
  let command = "";
  if (!REMOVE) {
    try {
      command = hookCommand(runnerFromArgv(process.argv), HOOK);
    } catch (e) {
      console.error(`install-antigravity-hooks: ${e.message}`); // one line: the app shows it to a person
      return 2;
    }
  }
  const original = fs.existsSync(HOOKS) ? fs.readFileSync(HOOKS, "utf8") : "";
  let next;
  try {
    next = nextConfig(original, { command, remove: REMOVE });
  } catch (e) {
    console.error(`Refusing to touch ${HOOKS}: it isn't valid hooks JSON (${e.message}).`);
    return 1;
  }
  if (next === null) {
    console.log(`${HOOKS} already ${REMOVE ? "has no Deckhand hook" : "up to date"} - nothing written.`);
    return 0;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (original) {
    const backup = `${HOOKS}.bak-${Date.now()}`;
    fs.writeFileSync(backup, original);
    console.log(`Backed up existing hooks to ${backup}`);
  }
  // Beside, then renamed over: Antigravity may read this file at any moment.
  fs.writeFileSync(HOOKS + ".deckhand-new", next);
  fs.renameSync(HOOKS + ".deckhand-new", HOOKS);
  console.log(`Wrote ${HOOKS} (${REMOVE ? "Deckhand's hook removed" : `Deckhand's hook on ${EVENTS.join(", ")}`}).`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(run());
}
