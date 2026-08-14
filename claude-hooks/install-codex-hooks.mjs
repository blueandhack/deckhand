#!/usr/bin/env node
// Register Deckhand's session hook with Codex CLI (0.147.0+), or remove it.
//
//   node install-codex-hooks.mjs            # register
//   node install-codex-hooks.mjs --remove   # un-register
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

const CODEX_DIR = path.join(os.homedir(), ".codex");
const HOOKS = path.join(CODEX_DIR, "hooks.json");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CMD = `node ${path.join(CLAUDE_DIR, "deckhand-session-hook.mjs")} --agent=codex`;
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

let cfg = {};
if (fs.existsSync(HOOKS)) {
  try {
    cfg = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
  } catch (e) {
    console.error(`Refusing to touch ${HOOKS}: it isn't valid JSON (${e.message}).`);
    process.exit(1);
  }
  const backup = `${HOOKS}.bak-${Date.now()}`;
  fs.copyFileSync(HOOKS, backup);
  console.log(`Backed up existing hooks to ${backup}`);
}
cfg.hooks ??= {};

if (REMOVE) {
  let removed = 0;
  for (const event of Object.keys(cfg.hooks)) {
    const groups = cfg.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks ?? []).filter((h) => h.command !== CMD);
      if (hooks.length !== (g.hooks ?? []).length) removed++;
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) cfg.hooks[event] = kept;
    else delete cfg.hooks[event];
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  fs.writeFileSync(HOOKS, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Wrote ${HOOKS} (${removed} hook entr${removed === 1 ? "y" : "ies"} removed).`);
  process.exit(0);
}

let added = 0;
for (const [event, extra] of Object.entries(EVENTS)) {
  cfg.hooks[event] ??= [];
  const already = cfg.hooks[event].some((g) => (g.hooks ?? []).some((h) => h.command === CMD));
  if (already) continue;
  // timeout is SECONDS and must exceed the hook's own REMOTE_WAIT_MS (90s), or Codex
  // kills it mid-wait and the device's buttons stop working halfway through a prompt.
  cfg.hooks[event].push({ ...extra, hooks: [{ type: "command", command: CMD, timeout: 100 }] });
  added++;
}
fs.writeFileSync(HOOKS, JSON.stringify(cfg, null, 2) + "\n");
console.log(`Wrote ${HOOKS} (${added} hook event(s) added).`);
console.log("NEXT: start Codex once and choose 'Trust all and continue' on its hooks");
console.log("review prompt - hooks do not run until you do, and editing them re-asks.");
