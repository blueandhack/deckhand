#!/usr/bin/env node
// Merge Deckhand's statusLine + hooks into ~/.claude/settings.json.
//
// Safe to run repeatedly: it backs up the existing settings.json, preserves
// everything already there (other hooks, permissions, theme, ...), and only
// adds Deckhand's own command where it isn't already present. It does NOT
// remove any hook you have - Deckhand's entries are appended per event.
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
    groups.push({ ...extra, hooks: [{ type: "command", command: HOOK }] });
    added++;
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(`Wrote ${SETTINGS} (${added} hook event(s) added).`);
console.log("Restart the Claude Code app/CLI (or start a new session) for the hooks to take effect.");
