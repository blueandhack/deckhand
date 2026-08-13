# Codex Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Codex thread show NEEDS INPUT on the device and be answered from it, by registering Deckhand's existing session hook with Codex, while keeping the rollout reader as a fallback.

**Architecture:** One hook script registered with both tools (`--agent=codex`, defaulting to `claude`), writing the same session records into `~/.claude/deckhand-sessions/`. The host merges hook-pushed records with rollout-pulled ones by session id, hook wins. No firmware change — the device is already agent-agnostic.

**Tech Stack:** Node 24 ESM (no framework, no bundler), bash installers, plain-node assertion scripts as tests. Codex CLI 0.147.0.

**Spec:** `docs/superpowers/specs/2026-08-13-codex-answering-design.md`

## Global Constraints

- **The hook must never write to stdout except a genuine `emitDecision()`.** A `PermissionRequest` hook's stdout is a decision channel; stray output can auto-allow or auto-deny a real prompt.
- **Hook timeout must exceed `REMOTE_WAIT_MS` (90_000).** Use `timeout: 100` (seconds) in `hooks.json`, matching `settings.json`.
- **Two agent vocabularies, do not mix them.** Session *records* and the `--agent` flag use `claude` / `codex`. The device *payload* uses `cc` / `cx`. The existing mapping `record.agent === "codex" ? "cx" : "cc"` in `host/index.mjs` stays as-is.
- **There is no test framework in this repo.** Tests are plain node scripts that `process.exit(1)` on failure, plus `claude-hooks/test-install-cycle.sh`. Run them directly.
- **Never write into the real `~/.claude` or `~/.codex` from a test.** Sandbox with `HOME=$(mktemp -d)`; node's `os.homedir()` honours `$HOME`.
- **Codex hooks are trust-gated.** Nothing works until the user accepts Codex's TUI prompt; editing `hooks.json` re-triggers it.

---

### Task 1: Fixtures and the `--agent` flag

The hook already maps every Codex event correctly (`SessionStart`→waiting, `UserPromptSubmit`/`PostToolUse`→working, `PermissionRequest`→asking, `SessionEnd`→delete, anything else→waiting). The only gaps are that it cannot say which tool invoked it, and it does not record that in the session file.

**Files:**
- Create: `claude-hooks/fixtures/codex-permission-request.json`
- Create: `claude-hooks/fixtures/codex-session-start.json`
- Create: `claude-hooks/fixtures/codex-session-end.json`
- Create: `claude-hooks/test-codex-hook.mjs`
- Modify: `claude-hooks/deckhand-session-hook.mjs`

**Interfaces:**
- Produces: session records containing `agent: "claude" | "codex"`. Task 2 consumes that field.

- [ ] **Step 1: Save the three captured fixtures verbatim**

These are real payloads from Codex CLI 0.147.0. Do not hand-edit them; their value is being exactly what Codex sends.

`claude-hooks/fixtures/codex-permission-request.json`:
```json
{"session_id":"019ffd75-9626-7a50-b707-4535327815e9","turn_id":"019ffd7b-cbb8-7921-b7d9-1b6d020bf24e","transcript_path":"/Users/yujia/.codex/sessions/2026/08/13/rollout-2026-08-13T16-29-29-019ffd75-9626-7a50-b707-4535327815e9.jsonl","cwd":"/private/tmp","hook_event_name":"PermissionRequest","model":"gpt-5.6-sol","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"curl -sI https://example.com | head -1","description":"Allow the requested read-only network request to example.com?"}}
```

`claude-hooks/fixtures/codex-session-start.json`:
```json
{"session_id":"019ffd75-9626-7a50-b707-4535327815e9","transcript_path":"/Users/yujia/.codex/sessions/2026/08/13/rollout-2026-08-13T16-29-29-019ffd75-9626-7a50-b707-4535327815e9.jsonl","cwd":"/private/tmp","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"default","source":"startup"}
```

`claude-hooks/fixtures/codex-session-end.json`:
```json
{"session_id":"019ffd75-9626-7a50-b707-4535327815e9","transcript_path":"/Users/yujia/.codex/sessions/2026/08/13/rollout-2026-08-13T16-29-29-019ffd75-9626-7a50-b707-4535327815e9.jsonl","cwd":"/private/tmp","hook_event_name":"SessionEnd","reason":"other"}
```

- [ ] **Step 2: Write the failing test**

Create `claude-hooks/test-codex-hook.mjs`. It drives the real hook as a subprocess against a throwaway `$HOME`, because that is the only way to exercise the shipping code path.

Note the 3-second kill: on `PermissionRequest` the hook blocks up to 90s waiting for a remote answer when `/tmp/deckhand-host-alive` is fresh (an absolute path `$HOME` cannot sandbox). It writes the record *before* waiting, so sampling then killing is correct.

```javascript
#!/usr/bin/env node
// Drives claude-hooks/deckhand-session-hook.mjs against REAL captured Codex payloads.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "deckhand-session-hook.mjs");
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run the hook with a fixture on stdin, in a sandboxed HOME. Pass `home` to reuse one
// across calls (needed to prove SessionEnd deletes a record an earlier event wrote).
//
// MUST be async with a real timer, not a busy-wait: a spin loop blocks this process's
// event loop, so the child's stdout 'data' events would never be delivered and the
// "stdout empty" assertion would pass for the wrong reason.
async function runHook(fixture, args, home) {
  home ??= fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-test-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const payload = fs.readFileSync(path.join(DIR, "fixtures", fixture), "utf8");
  const p = spawn(process.execPath, [HOOK, ...args], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  p.stdout.on("data", (c) => (stdout += c));
  p.stdin.end(payload);
  await sleep(3000); // the record is written before any remote-answer wait
  p.kill();
  const dir = path.join(home, ".claude", "deckhand-sessions");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const record = files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) : null;
  return { record, stdout, home, fileCount: files.length };
}

console.log("== Codex PermissionRequest, --agent=codex ==");
const perm = await runHook("codex-permission-request.json", ["--agent=codex"]);
check("agent tagged codex", perm.record?.agent, "codex");
check("status asking", perm.record?.status, "asking");
check("ask title", perm.record?.ask?.title, "Allow Bash?");
check("ask detail is the command", perm.record?.ask?.detail, "curl -sI https://example.com | head -1");
check("ask options", perm.record?.ask?.options, ["Allow", "Deny"]);
check("stdout empty (decision channel)", perm.stdout, "");
check("cwd carried", perm.record?.cwd, "/private/tmp");
fs.rmSync(perm.home, { recursive: true, force: true });

console.log("== default agent is claude ==");
const dflt = await runHook("codex-session-start.json", []);
check("agent defaults to claude", dflt.record?.agent, "claude");
fs.rmSync(dflt.home, { recursive: true, force: true });

console.log("== Codex SessionStart, then SessionEnd deletes the record ==");
const start = await runHook("codex-session-start.json", ["--agent=codex"]);
check("status waiting", start.record?.status, "waiting");
check("model carried", start.record?.model, "gpt-5.6-sol");
check("record exists after SessionStart", start.fileCount, 1);
// Same HOME and same session_id, so this must remove the file the line above created -
// this is what stops an ended Codex thread lingering as a ghost row for 20 minutes.
const end = await runHook("codex-session-end.json", ["--agent=codex"], start.home);
check("record deleted by SessionEnd", end.fileCount, 0);
fs.rmSync(start.home, { recursive: true, force: true });

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node claude-hooks/test-codex-hook.mjs`
Expected: FAIL on "agent tagged codex" and "agent defaults to claude" (the record has no `agent` field yet — `undefined` vs `"codex"`). The other checks should already pass, which is the point: the hook already understands Codex.

- [ ] **Step 4: Add the flag and the record field**

In `claude-hooks/deckhand-session-hook.mjs`, after the `REMOTE_WAIT_MS` constant, add:

```javascript
// Which tool invoked us. Codex's payload is field-identical to Claude Code's and carries
// no agent marker, so the registration says so explicitly rather than the hook guessing
// from a transcript path neither tool guarantees. Defaults to claude, so the existing
// ~/.claude/settings.json registration needs no migration.
const AGENT = (process.argv.find((a) => a.startsWith("--agent=")) ?? "").slice(8) || "claude";
```

Then in the `record` object literal (the one containing `cwd`, `model`, `transcript`, `status`, `updated_at`), add `agent: AGENT,` immediately after `status,`.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node claude-hooks/test-codex-hook.mjs`
Expected: `== 12 passed, 0 failed ==`

- [ ] **Step 6: Confirm the Claude Code path is unchanged**

Run: `./claude-hooks/test-install-cycle.sh`
Expected: `== 33 passed, 0 failed ==`

- [ ] **Step 7: Commit**

```bash
git add claude-hooks/fixtures claude-hooks/test-codex-hook.mjs claude-hooks/deckhand-session-hook.mjs
git commit -m "Teach the session hook which tool invoked it"
```

---

### Task 2: Merge hook records with rollout records

**Files:**
- Create: `host/sessions-merge.mjs`
- Create: `host/test-sessions-merge.mjs`
- Modify: `host/index.mjs` (the `agent: "claude"` push at ~line 1079, and after the `readCodexSessions()` push)

**Interfaces:**
- Consumes: records carrying `agent` from Task 1.
- Produces: `mergeById(pull, hook)` → `Array` — exported from `host/sessions-merge.mjs`, used by `readSessions()`.

- [ ] **Step 1: Write the failing test**

Create `host/test-sessions-merge.mjs`. The subtle case is the id mismatch: `readCodexSessions()` already truncates (`id: f.id.slice(0, 12)`) while hook records keep the full uuid, so merging on the raw string would never match and every Codex thread would appear twice.

```javascript
#!/usr/bin/env node
import { mergeById } from "./sessions-merge.mjs";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const FULL = "019ffd75-9626-7a50-b707-4535327815e9";
const SHORT = FULL.slice(0, 12); // what readCodexSessions() produces

// The same Codex thread from both sources.
const pull = [{ id: SHORT, agent: "codex", status: "waiting", cwd: "/private/tmp", updated_at: 100 }];
const hook = [{ id: FULL, agent: "codex", status: "asking", cwd: "/private/tmp", updated_at: 200, ask: { pid: "p1" } }];

const merged = mergeById(pull, hook);
check("one row, not two", merged.length, 1);
check("hook record wins", merged[0].status, "asking");
check("ask survives", merged[0].ask?.pid, "p1");
check("full id kept for the host to truncate later", merged[0].id, FULL);

// A thread only the pull knows about (hooks not trusted yet) must survive.
const pullOnly = mergeById(
  [{ id: "aaaaaaaaaaaa", agent: "codex", status: "working", updated_at: 1 }],
  []
);
check("pull-only thread survives", pullOnly.length, 1);
check("pull-only keeps its status", pullOnly[0].status, "working");

// Claude records pass through untouched.
const claude = mergeById([], [{ id: "bbbbbbbb-bbbb", agent: "claude", status: "working", updated_at: 5 }]);
check("claude record passes through", claude.length, 1);
check("claude agent preserved", claude[0].agent, "claude");

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node host/test-sessions-merge.mjs`
Expected: FAIL — `Cannot find module './sessions-merge.mjs'`

- [ ] **Step 3: Write the module**

Create `host/sessions-merge.mjs`:

```javascript
// Merging the two sources of session state.
//
// Codex now arrives BOTH ways: pushed by the hook (rich, includes `ask`) and pulled from
// its rollout file (a fallback, for threads whose trust prompt has not been accepted).
// Without this merge the same thread occupies two of the six rows.
//
// The key has to be NORMALISED. readCodexSessions() already truncates its id to 12 chars
// while a hook record carries the full uuid, so matching on the raw string would never
// hit and the dedupe would silently do nothing - which looks exactly like the bug it is
// meant to fix. 12 is the device's own key length, so it cannot merge two threads the
// device would show separately.
const key = (r) => String(r?.id ?? "").slice(0, 12);

// Hook records win: they are push-fresh and are the only ones carrying `ask`.
export function mergeById(pull, hook) {
  const out = new Map();
  for (const r of pull) if (r) out.set(key(r), r);
  for (const r of hook) if (r) out.set(key(r), r);
  return [...out.values()];
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node host/test-sessions-merge.mjs`
Expected: `== 8 passed, 0 failed ==`

- [ ] **Step 5: Wire it into the host**

In `host/index.mjs`:

1. Add the import beside the other local imports at the top:
```javascript
import { mergeById } from "./sessions-merge.mjs";
```

2. Honour the record's own agent. Replace:
```javascript
      records.push({ ...record, id: path.basename(file, ".json"), agent: "claude" });
```
with:
```javascript
      // The record says which tool wrote it (the hook stamps it). Only fall back to
      // "claude" for records written before that field existed.
      records.push({
        ...record,
        id: path.basename(file, ".json"),
        agent: record.agent === "codex" ? "codex" : "claude",
      });
```

3. Replace the unconditional push of Codex rollout records:
```javascript
  records.push(...(await readCodexSessions()));
```
with a merge, so a hook-pushed thread and its rollout collapse into one row:
```javascript
  // Codex arrives from both directions now; the hook record wins where both exist.
  const merged = mergeById(await readCodexSessions(), records);
  records.length = 0;
  records.push(...merged);
```

- [ ] **Step 6: Verify the host still parses and runs**

Run: `node --check host/index.mjs`
Expected: no output (syntax OK)

Then confirm the live host still ticks, since this touches its hot path:
```bash
pkill -f 'DeckhandBLE.app/Contents/MacOS/Deckhand' || true
sleep 2
rm -f /tmp/deckhand-host.log
open host/DeckhandBLE.app --args "$(pwd)/host/index.mjs"
sleep 12
grep -c 'sessions(' /tmp/deckhand-host.log
```
Expected: a non-zero count, i.e. at least one tick line with a session list.

- [ ] **Step 7: Commit**

```bash
git add host/sessions-merge.mjs host/test-sessions-merge.mjs host/index.mjs
git commit -m "Merge hook-pushed and rollout-pulled Codex sessions by id"
```

---

### Task 3: Register and unregister Codex hooks

**Files:**
- Create: `claude-hooks/install-codex-hooks.mjs`
- Create: `claude-hooks/codex-hooks.snippet.json`
- Create: `claude-hooks/test-codex-install.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `node claude-hooks/install-codex-hooks.mjs [--remove]`, which Task 4 calls from `install.sh` / `uninstall.sh`.

- [ ] **Step 1: Write the failing test**

Create `claude-hooks/test-codex-install.mjs`:

```javascript
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

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node claude-hooks/test-codex-install.mjs`
Expected: FAIL — cannot find `install-codex-hooks.mjs`

- [ ] **Step 3: Write the installer**

Create `claude-hooks/install-codex-hooks.mjs`:

```javascript
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
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node claude-hooks/test-codex-install.mjs`
Expected: `== 9 passed, 0 failed ==`

- [ ] **Step 5: Write the reference snippet**

Create `claude-hooks/codex-hooks.snippet.json` — reference only, mirroring `settings.snippet.json`'s role:

```json
{
  "_comment": "Reference only. Run `node claude-hooks/install-codex-hooks.mjs` to merge this into ~/.codex/hooks.json safely (it backs up, dedupes, and substitutes your real home path). Codex will ask you to trust the hooks on next launch. $HOME below is a placeholder.",
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }],
    "PermissionRequest": [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }],
    "PostToolUse": [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node $HOME/.claude/deckhand-session-hook.mjs --agent=codex", "timeout": 100 }] }]
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add claude-hooks/install-codex-hooks.mjs claude-hooks/codex-hooks.snippet.json claude-hooks/test-codex-install.mjs
git commit -m "Add a Codex hooks registrar, with surgical removal"
```

---

### Task 4: Wire into install, uninstall and backup

**Files:**
- Modify: `install.sh`
- Modify: `uninstall.sh`
- Modify: `claude-hooks/deckhand-backup.mjs`
- Modify: `claude-hooks/test-install-cycle.sh`

**Interfaces:**
- Consumes: `install-codex-hooks.mjs` from Task 3.

- [ ] **Step 1: Add the failing assertions**

In `claude-hooks/test-install-cycle.sh`, immediately before the line `echo "== 5. --purge removes the keys =="`, insert:

```bash
echo "== 4c. Codex hooks are registered and removed =="
mkdir -p "$T/.codex"
node "$REPO/claude-hooks/install-codex-hooks.mjs" >/dev/null
check "codex hooks.json created" "$([ -f "$T/.codex/hooks.json" ] && echo yes || echo no)" "yes"
check "PermissionRequest registered" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.codex/hooks.json","utf8"));console.log(c.hooks.PermissionRequest?1:0)')" "1"
node "$REPO/claude-hooks/install-codex-hooks.mjs" --remove >/dev/null
check "codex hooks removed" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.codex/hooks.json","utf8"));console.log(c.hooks?.PermissionRequest?1:0)')" "0"
```

- [ ] **Step 2: Run it to confirm the new assertions fail**

Run: `./claude-hooks/test-install-cycle.sh`
Expected: the three new checks FAIL only if Task 3 is missing; if Task 3 is done they PASS, and the run reports `== 36 passed, 0 failed ==`. Either way the total must rise from 33 to 36.

- [ ] **Step 3: Call the registrar from install.sh**

In `install.sh`, after the `[3/5] Registering hooks in settings.json` block and before `[4/5]`, renumbering the remaining steps to `[5/6]` and `[6/6]`, insert:

```bash
echo "[4/6] Registering Codex hooks (only if Codex is installed)"
node "$REPO/claude-hooks/install-codex-hooks.mjs"
```

Then in the closing heredoc, after the "Restart Claude Code" guidance, add:

```
If you use Codex: start it once and choose "Trust all and continue" on the
hooks review prompt. Codex hooks do not run until trusted, and changing them
asks again. Until then Deckhand still shows Codex threads, just read-only.
```

- [ ] **Step 4: Call the removal from uninstall.sh**

In `uninstall.sh`, after the `[2/4] Un-registering from settings.json` block, insert (renumbering the following steps to `[4/5]` and `[5/5]`, and changing `[1/4]`/`[2/4]` to `[1/5]`/`[2/5]`):

```bash
echo "[3/5] Un-registering Codex hooks"
if [ "$DRY" = 1 ]; then
  echo "  \$ node $REPO/claude-hooks/install-codex-hooks.mjs --remove"
else
  node "$REPO/claude-hooks/install-codex-hooks.mjs" --remove
fi
```

Also add to the "Will remove:" list, after the `settings.json` line:
```bash
echo "  - Deckhand's entries in ~/.codex/hooks.json (if Codex is installed)"
```

- [ ] **Step 5: Add hooks.json to the backup set**

In `claude-hooks/deckhand-backup.mjs`, in the `FILES` array immediately before the `.codex/config.toml` entry, add:

```javascript
  { rel: ".codex/hooks.json",                 need: false, repo: null,
    why: "Codex hook registration; without it Codex threads are read-only on the device" },
```

- [ ] **Step 6: Run everything**

```bash
./claude-hooks/test-install-cycle.sh
node claude-hooks/test-codex-hook.mjs
node claude-hooks/test-codex-install.mjs
node host/test-sessions-merge.mjs
bash -n install.sh && bash -n uninstall.sh
```
Expected: `36 passed`, `12 passed`, `9 passed`, `8 passed`, and no syntax errors.

- [ ] **Step 7: Commit**

```bash
git add install.sh uninstall.sh claude-hooks/deckhand-backup.mjs claude-hooks/test-install-cycle.sh
git commit -m "Install, uninstall and back up the Codex hook registration"
```

---

### Task 5: Resolve the timeout question, then document

Risk 2 in the spec is the one thing that can invalidate the design, and it cannot be tested with a fixture. Do this before writing the docs, because the answer changes what they say.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (regenerate — see step 4)
- Modify: `README.md`

- [ ] **Step 1: Find out what Codex does with a hook that times out**

Temporarily set the `PermissionRequest` timeout to `5` in `~/.codex/hooks.json`, make the hook sleep past it, and watch what Codex does. Concretely:

```bash
cp ~/.codex/hooks.json /tmp/hooks-backup.json
node -e '
const fs=require("fs"),p=process.env.HOME+"/.codex/hooks.json";
const c=JSON.parse(fs.readFileSync(p,"utf8"));
for (const g of c.hooks.PermissionRequest) for (const h of g.hooks) h.timeout=5;
fs.writeFileSync(p, JSON.stringify(c,null,2));'
```

Then start Codex interactively (`cd /tmp && codex`), accept the re-triggered trust prompt, and ask it to run `curl -sI https://example.com | head -1` with the Deckhand host **stopped** (so the hook waits the full 90s and is killed at 5s).

Record which happens:
- **Codex shows its own approval prompt** — expiry falls through, like Claude Code. The 90s wait is safe; no change needed.
- **Codex denies the command** — expiry is a denial. The wait must be cut for Codex (e.g. 10s) or removed, and the spec's Risk 2 becomes a design change, not a footnote. **Stop and report this rather than proceeding.**

Restore afterwards: `cp /tmp/hooks-backup.json ~/.codex/hooks.json`

- [ ] **Step 2: Record the answer in the spec**

Append the observed behaviour to the "Risks and open questions" section of `docs/superpowers/specs/2026-08-13-codex-answering-design.md`, replacing item 2's "UNKNOWN" with what actually happened and the date.

- [ ] **Step 3: Update CLAUDE.md**

In the Codex section, replace the paragraph beginning "The rest of this section describes the PULL path, which is what ships today" with a description of the shipped push path: which events are registered, the `--agent=codex` flag, the merge-by-id rule and why the key is normalised to 12 characters, the trust gate, and the timeout finding from Step 1. Also update the bullet that reads "A Codex row can only ever be `working` or `waiting`" — it is no longer true once this ships; say that a Codex row can now show NEEDS INPUT and be answered, with the pull fallback covering untrusted installs.

- [ ] **Step 4: Regenerate AGENTS.md**

AGENTS.md is a verbatim copy of CLAUDE.md below an 11-line header. Never hand-edit it:

```bash
{ head -n 11 AGENTS.md; tail -n +4 CLAUDE.md; } > AGENTS.md.new && mv AGENTS.md.new AGENTS.md
diff <(tail -n +4 CLAUDE.md) <(tail -n +12 AGENTS.md) && echo IDENTICAL
```
Expected: `IDENTICAL`

- [ ] **Step 5: Update the README**

In the "Codex support" section, replace the paragraph starting "**A Codex row can only ever be WORKING or READY today**" with the shipped behaviour: Codex threads now push their state and can be answered from the device, ended threads disappear immediately, and the rollout reader remains as a fallback until Codex's hook trust prompt is accepted. Add the one-line install instruction (`./install.sh` registers it; accept "Trust all and continue" in Codex).

- [ ] **Step 6: Full verification**

```bash
./claude-hooks/test-install-cycle.sh
node claude-hooks/test-codex-hook.mjs
node claude-hooks/test-codex-install.mjs
node host/test-sessions-merge.mjs
```
Expected: all green.

Then a real end-to-end check: with the host running and the device connected, start Codex, ask it to run `curl -sI https://example.com | head -1`, and confirm the device shows a **NEEDS INPUT** row for the Codex session and that tapping **Deny** blocks the command.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md docs/superpowers/specs/2026-08-13-codex-answering-design.md
git commit -m "Document Codex answering, and record the hook-timeout finding"
```

---

## Notes for the executor

- **The capture rig may still be installed** at `~/.codex/hooks.json`, `~/.codex/hooks/hooks.json` and `~/.codex/deckhand-capture.sh` from the investigation. Remove those before Task 3 so the registrar starts from a clean file: `rm -f ~/.codex/hooks/hooks.json ~/.codex/deckhand-capture.sh ~/.codex/deckhand-deny-once`. Leave `~/.codex/hooks.json` — Task 3's test proves the registrar merges into an existing file, and the real one will be backed up automatically.
- **Do not add `PreToolUse` to the Codex registration** even though the Claude side has it. See the comment in the registrar.
- **The device needs no reflash.** If you find yourself editing `firmware/`, something has gone wrong.
