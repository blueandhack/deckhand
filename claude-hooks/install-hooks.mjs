#!/usr/bin/env node
// Merge Deckhand's statusLine + hooks into ~/.claude/settings.json.
//
//   node install-hooks.mjs            # register
//   node install-hooks.mjs --remove   # un-register (used by uninstall.sh)
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const HOOK = `node ${path.join(CLAUDE_DIR, "deckhand-session-hook.mjs")}`;
const STATUSLINE = `node ${path.join(CLAUDE_DIR, "deckhand-statusline.mjs")}`;

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
if (fs.existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch (e) {
    console.error(`Refusing to touch ${SETTINGS}: it isn't valid JSON (${e.message}).`);
    process.exit(1);
  }
  const backup = `${SETTINGS}.bak-${Date.now()}`;
  fs.copyFileSync(SETTINGS, backup);
  console.log(`Backed up existing settings to ${backup}`);
}

if (REMOVE) {
  // Surgical, not a settings.json restore: you may well have added hooks or changed
  // settings since installing, and those must survive.
  let removed = 0;

  // Only OUR statusLine. If you have since pointed it somewhere else, that's yours.
  if (settings.statusLine?.command === STATUSLINE) {
    delete settings.statusLine;
    console.log("Removed statusLine.");
  } else if (settings.statusLine) {
    console.log("Kept your statusLine (it isn't Deckhand's).");
  }

  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue; // hand-edited into a different shape - leave it
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks ?? []).filter((h) => h.command !== HOOK);
      if (hooks.length !== (g.hooks ?? []).length) removed++;
      // A group whose only hook was ours has nothing left to do - drop the group
      // rather than leaving an empty matcher behind.
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  // Leave the file the shape it had before we ever touched it, so an install/uninstall
  // round trip is a no-op rather than an accumulation of empty containers.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Wrote ${SETTINGS} (${removed} hook entr${removed === 1 ? "y" : "ies"} removed).`);
  console.log("Restart the Claude Code app/CLI so it stops running the hook.");
  process.exit(0);
}

// statusLine: only set it if you don't already have one (yours wins).
if (!settings.statusLine) {
  settings.statusLine = { type: "command", command: STATUSLINE, refreshInterval: 15 };
  console.log("Added statusLine.");
} else {
  console.log("Kept your existing statusLine (Deckhand's is optional - it's only a fallback quota source).");
}

settings.hooks ??= {};
let added = 0;
for (const [event, extra] of Object.entries(HOOK_EVENTS)) {
  settings.hooks[event] ??= [];
  const groups = settings.hooks[event];
  const already = groups.some((g) => (g.hooks ?? []).some((h) => h.command === HOOK));
  if (!already) {
    // timeout must exceed the hook's REMOTE_WAIT_MS (90s) so Claude Code
    // doesn't kill it mid-wait while a prompt is answerable from the device.
    groups.push({ ...extra, hooks: [{ type: "command", command: HOOK, timeout: 100 }] });
    added++;
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(`Wrote ${SETTINGS} (${added} hook event(s) added).`);
console.log("Restart the Claude Code app/CLI (or start a new session) for the hooks to take effect.");
