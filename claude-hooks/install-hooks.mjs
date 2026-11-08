#!/usr/bin/env node
// Merge Deckhand's statusLine + hooks into ~/.claude/settings.json.
//
//   node install-hooks.mjs                  # register, run by `node` (install.sh)
//   node install-hooks.mjs --node <path>    # register, run by <path> (the released app)
//   node install-hooks.mjs --remove         # un-register either form (uninstall.sh, the app)
//
// Safe to run repeatedly: it backs up the existing settings.json, preserves
// everything already there (other hooks, permissions, theme, ...), and only
// adds Deckhand's own command where it isn't already present. It does NOT
// remove any hook you have - Deckhand's entries are appended per event.
//
// --remove lives HERE rather than in a separate uninstall script for one reason:
// surgical removal has to match exactly what was added, so it must share the HOOK /
// STATUSLINE command strings below. Duplicating those constants in a second file is
// precisely how the two drift apart and an uninstall silently leaves a dead hook
// behind - which would make every Claude Code event spawn a node process that errors.
// The matching itself now lives in hook-command.mjs, shared with the Codex installer,
// and goes by the SCRIPT a command runs rather than the exact string - see there.
//
// It only writes (and only backs up) when something actually changes: the released
// app re-runs it after every update, and a backup per no-op run would bury the one
// backup that matters, the one taken before the first change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookCommand, isDeckhandCommand, normalizeEvent, removeFromEvent, runnerFromArgv } from "./hook-command.mjs";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const HOOK_NAME = "deckhand-session-hook.mjs";
const STATUSLINE_NAME = "deckhand-statusline.mjs";
// A bad --node is reported in one line, not as a stack trace: the app shows this
// output to a person.
let HOOK, STATUSLINE;
try {
  const runner = runnerFromArgv(process.argv);
  HOOK = hookCommand(runner, path.join(CLAUDE_DIR, HOOK_NAME));
  STATUSLINE = hookCommand(runner, path.join(CLAUDE_DIR, STATUSLINE_NAME));
} catch (e) {
  console.error(`install-hooks: ${e.message}`);
  process.exit(2);
}
// MUST stay larger than the hook's REMOTE_WAIT_MS, which defaults to "forever" (24h
// minus a minute). Claude Code kills a hook that outlives this, and a killed
// PermissionRequest hook is an untested state - so the hook is written to always
// self-exit first, and these two numbers are a PAIR. Raising the wait without
// raising this silently reintroduces the kill.
const HOOK_TIMEOUT = 86_400;

// event -> extra fields on the hook group (matcher, where applicable)
const HOOK_EVENTS = {
  SessionStart: { matcher: ".*" },
  SessionEnd: { matcher: ".*" },
  UserPromptSubmit: {},
  PreToolUse: { matcher: "AskUserQuestion|ExitPlanMode" },
  PostToolUse: { matcher: ".*" },
  PostToolUseFailure: { matcher: ".*" },
  PermissionRequest: { matcher: ".*" },
  Notification: {},
  Stop: {},
};

const REMOVE = process.argv.includes("--remove");

// Nothing registered means nothing to un-register - and creating a settings.json just
// to delete keys from it would be absurd.
if (REMOVE && !fs.existsSync(SETTINGS)) {
  console.log(`No ${SETTINGS} - nothing to un-register.`);
  process.exit(0);
}

fs.mkdirSync(CLAUDE_DIR, { recursive: true });

let settings = {};
let original = "";
if (fs.existsSync(SETTINGS)) {
  original = fs.readFileSync(SETTINGS, "utf8");
  try {
    settings = JSON.parse(original);
  } catch (e) {
    console.error(`Refusing to touch ${SETTINGS}: it isn't valid JSON (${e.message}).`);
    process.exit(1);
  }
}

// Back up and write only on a real change. Compared as the text we WOULD write, so a
// file that differs only in formatting is rewritten once, not on every run.
function save(summary) {
  const next = JSON.stringify(settings, null, 2) + "\n";
  if (next === original) {
    console.log(`${SETTINGS} already up to date - nothing written.`);
    return;
  }
  if (original) {
    const backup = `${SETTINGS}.bak-${Date.now()}`;
    fs.writeFileSync(backup, original);
    console.log(`Backed up existing settings to ${backup}`);
  }
  fs.writeFileSync(SETTINGS, next);
  console.log(`Wrote ${SETTINGS} (${summary}).`);
}

if (REMOVE) {
  // Surgical, not a settings.json restore: you may well have added hooks or changed
  // settings since installing, and those must survive.
  let removed = 0;

  // Only OUR statusLine, in either form. If you have since pointed it somewhere
  // else, that's yours.
  if (isDeckhandCommand(settings.statusLine?.command, STATUSLINE_NAME)) {
    delete settings.statusLine;
    console.log("Removed statusLine.");
  } else if (settings.statusLine) {
    console.log("Kept your statusLine (it isn't Deckhand's).");
  }

  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue; // hand-edited into a different shape - leave it
    removed += removeFromEvent(groups, HOOK_NAME);
    if (!groups.length) delete settings.hooks[event];
  }
  // Leave the file the shape it had before we ever touched it, so an install/uninstall
  // round trip is a no-op rather than an accumulation of empty containers.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  save(`${removed} hook entr${removed === 1 ? "y" : "ies"} removed`);
  console.log("Restart the Claude Code app/CLI so it stops running the hook.");
  process.exit(0);
}

// statusLine: set it if you have none, update it if it is OURS in another form
// (the from-source install moving to the released app), and otherwise leave yours.
if (!settings.statusLine) {
  settings.statusLine = { type: "command", command: STATUSLINE, refreshInterval: 15 };
  console.log("Added statusLine.");
} else if (isDeckhandCommand(settings.statusLine.command, STATUSLINE_NAME)) {
  if (settings.statusLine.command !== STATUSLINE) {
    settings.statusLine = { ...settings.statusLine, command: STATUSLINE };
    console.log("Updated Deckhand's statusLine to the new runner.");
  }
} else {
  console.log("Kept your existing statusLine (Deckhand's is optional - it's only a fallback quota source).");
}

settings.hooks ??= {};
let touched = 0;
for (const [event, extra] of Object.entries(HOOK_EVENTS)) {
  if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) {
    console.log(`Left ${event} alone: it isn't a list (hand-edited?).`);
    continue;
  }
  settings.hooks[event] ??= [];
  if (normalizeEvent(settings.hooks[event], HOOK_NAME, HOOK, HOOK_TIMEOUT, extra)) touched++;
}

save(`${touched} hook event(s) added or updated`);
console.log("Restart the Claude Code app/CLI (or start a new session) for the hooks to take effect.");
