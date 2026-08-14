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
  // The hook only builds/publishes an `ask` (and only then can it wait or write
  // to stdout) when it sees a fresh, connected heartbeat - normally written by
  // host/index.mjs every tick at /tmp/deckhand-host-alive. Running this test on
  // a machine with no Deckhand host live would otherwise fail every ask-shaped
  // assertion for a reason that has nothing to do with the hook logic under
  // test, AND silently turn "stdout empty (decision channel)" - the most
  // security-relevant assertion here - vacuous: with no ask ever built, the
  // hook exits before reaching any code path that could write to stdout, so
  // that check would pass even if emitDecision() were broken. DECKHAND_TMP
  // (the same seam uninstall.sh uses as $DECK_TMP) points the hook at a fake
  // heartbeat scoped to this sandbox HOME instead, so the test is deterministic
  // and the stdout assertion actually exercises the code it claims to.
  const tmp = path.join(home, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "deckhand-host-alive"),
    JSON.stringify({ connected: true, remoteAnswer: true, at: Date.now() })
  );
  const p = spawn(process.execPath, [HOOK, ...args], {
    env: { ...process.env, HOME: home, DECKHAND_TMP: tmp },
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
