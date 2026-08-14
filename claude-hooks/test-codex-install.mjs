#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, "install-codex-hooks.mjs");
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-cxinst-"));
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
const HOOKS = path.join(home, ".codex", "hooks.json");
const run = (args) => execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home } });

// A hook of yours that must survive both install and uninstall.
const mine = { matcher: ".*", hooks: [{ type: "command", command: "node /my/own/hook.mjs" }] };
fs.writeFileSync(HOOKS, JSON.stringify({ hooks: { PostToolUse: [mine] } }, null, 2));

run([]);
let cfg = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
check("registers 6 events", Object.keys(cfg.hooks).sort(),
  ["PermissionRequest", "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
check("PreToolUse NOT registered", cfg.hooks.PreToolUse, undefined);
check("your hook survived", cfg.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === "node /my/own/hook.mjs")), true);
check("timeout exceeds the 90s wait", cfg.hooks.PermissionRequest[0].hooks[0].timeout, 100);
check("passes --agent=codex", cfg.hooks.PermissionRequest[0].hooks[0].command.includes("--agent=codex"), true);
check("a backup was written", fs.readdirSync(path.join(home, ".codex")).some((f) => f.startsWith("hooks.json.bak-")), true);

run([]); // idempotent
cfg = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
check("re-run does not duplicate", cfg.hooks.PermissionRequest.length, 1);

run(["--remove"]);
cfg = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
check("ours removed", cfg.hooks.PermissionRequest, undefined);
check("yours still there after removal",
  cfg.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === "node /my/own/hook.mjs")), true);

// Regression: --remove on a bare .codex with no hooks.json should not create one.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-cxbare-"));
fs.mkdirSync(path.join(bare, ".codex"), { recursive: true });
execFileSync(process.execPath, [SCRIPT, "--remove"], { env: { ...process.env, HOME: bare } });
check("--remove does not create hooks.json", fs.existsSync(path.join(bare, ".codex", "hooks.json")), false);
fs.rmSync(bare, { recursive: true, force: true });

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
