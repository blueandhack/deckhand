#!/usr/bin/env node
// Register Deckhand's session hook with Codex CLI (0.147.0+), or remove it.
//
//   node install-codex-hooks.mjs                  # register, run by `node`
//   node install-codex-hooks.mjs --node <path>    # register, run by <path> (the released app)
//   node install-codex-hooks.mjs --remove         # un-register either form
//
// Codex's hooks.json is the same shape as Claude Code's settings.json hooks block, and
// its payloads are field-identical - which is why ONE script serves both tools; the
// registration passes --agent=codex so the hook knows which one called it.
//
// Codex hooks are TRUST-GATED: nothing here runs until the user accepts Codex's own
// "Hooks need review" prompt, and editing this file re-triggers it. That is a feature -
// installation cannot be silent - but it means this script's work is not the last step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookCommand, normalizeEvent, removeFromEvent, runnerFromArgv } from "./hook-command.mjs";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const HOOKS = path.join(CODEX_DIR, "hooks.json");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const HOOK_NAME = "deckhand-session-hook.mjs";
let CMD;
try {
  CMD = hookCommand(runnerFromArgv(process.argv), path.join(CLAUDE_DIR, HOOK_NAME), "--agent=codex");
} catch (e) {
  console.error(`install-codex-hooks: ${e.message}`); // one line: the app shows this to a person
  process.exit(2);
}
// timeout is SECONDS and must exceed the hook's own REMOTE_WAIT_MS (90s), or Codex
// kills it mid-wait and the device's buttons stop working halfway through a prompt.
const TIMEOUT = 100;
const REMOVE = process.argv.includes("--remove");

// PreToolUse is deliberately absent: on Codex it fires for EVERY tool call, and unlike
// Claude Code there is no AskUserQuestion/ExitPlanMode to match on, so it would spawn a
// node process per call for nothing. PermissionRequest + PostToolUse already cover it.
const EVENTS = {
  SessionStart: {},
  UserPromptSubmit: {},
  PermissionRequest: { matcher: ".*" },
  PostToolUse: { matcher: ".*" },
  Stop: {},
  SessionEnd: {},
};

if (!fs.existsSync(CODEX_DIR)) {
  console.log(`No ${CODEX_DIR} - Codex is not installed here, nothing to do.`);
  process.exit(0);
}

if (REMOVE && !fs.existsSync(HOOKS)) {
  console.log(`No ${HOOKS} - nothing to un-register.`);
  process.exit(0);
}

let cfg = {};
let original = "";
if (fs.existsSync(HOOKS)) {
  original = fs.readFileSync(HOOKS, "utf8");
  try {
    cfg = JSON.parse(original);
  } catch (e) {
    console.error(`Refusing to touch ${HOOKS}: it isn't valid JSON (${e.message}).`);
    process.exit(1);
  }
}
cfg.hooks ??= {};

// Write - and back up - only on a real change, for the reason install-hooks.mjs gives.
// That matters MORE here: every edit to hooks.json makes Codex ask you to trust the
// hooks again, so a no-op rewrite would cost a prompt, not just a backup file.
function save(summary) {
  const next = JSON.stringify(cfg, null, 2) + "\n";
  if (next === original) {
    console.log(`${HOOKS} already up to date - nothing written.`);
    return false;
  }
  if (original) {
    const backup = `${HOOKS}.bak-${Date.now()}`;
    fs.writeFileSync(backup, original);
    console.log(`Backed up existing hooks to ${backup}`);
  }
  fs.writeFileSync(HOOKS, next);
  console.log(`Wrote ${HOOKS} (${summary}).`);
  return true;
}

if (REMOVE) {
  let removed = 0;
  for (const event of Object.keys(cfg.hooks)) {
    const groups = cfg.hooks[event];
    if (!Array.isArray(groups)) continue;
    removed += removeFromEvent(groups, HOOK_NAME);
    if (!groups.length) delete cfg.hooks[event];
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  save(`${removed} hook entr${removed === 1 ? "y" : "ies"} removed`);
  process.exit(0);
}

let touched = 0;
for (const [event, extra] of Object.entries(EVENTS)) {
  if (cfg.hooks[event] !== undefined && !Array.isArray(cfg.hooks[event])) continue;
  cfg.hooks[event] ??= [];
  if (normalizeEvent(cfg.hooks[event], HOOK_NAME, CMD, TIMEOUT, extra)) touched++;
}
if (save(`${touched} hook event(s) added or updated`)) {
  console.log("NEXT: start Codex once and choose 'Trust all and continue' on its hooks");
  console.log("review prompt - hooks do not run until you do, and editing them re-asks.");
}
