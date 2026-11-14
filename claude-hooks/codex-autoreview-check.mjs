#!/usr/bin/env node
// Does a Codex approval that Codex's OWN reviewer decides stay off the device?
//
// WHY THIS EXISTS (2026-11-13). In auto mode Codex hands every approval to its
// auto-reviewer, yet still fires PermissionRequest - so the session hook marked the
// row NEEDS INPUT and held Codex 15s per approval waiting for a device tap nobody was
// asked for. The hook now reads `approvals_reviewer` from the LAST `turn_context` in
// the session's rollout (codexReviewer) and, for a known automatic reviewer, writes
// "working", publishes no ask and does not wait.
//
// Every case drives the REAL hook as a child, against a throwaway $HOME and runtime
// dir with a live, connected heartbeat - the state in which a genuine prompt DOES
// publish an ask, so "no ask" can only mean the hook decided not to.
//
//   node claude-hooks/codex-autoreview-check.mjs
//   node claude-hooks/codex-autoreview-check.mjs --selftest   (exits 0 only when every
//                                                               injected fault is caught)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");
const REAL_HOOK = path.join(import.meta.dirname, "deckhand-session-hook.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = (reviewer) =>
  JSON.stringify({
    timestamp: "2026-11-13T20:08:46.000Z",
    type: "turn_context",
    payload: {
      cwd: "/tmp/x",
      approval_policy: "on-request",
      ...(reviewer === undefined ? {} : { approvals_reviewer: reviewer }),
      model: "gpt-5.6-sol",
    },
  });
const filler = (n) =>
  // Non-ASCII on purpose: a chunk edge landing inside a multi-byte character must not
  // corrupt the line the scan is looking for.
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: "response_item", payload: { type: "message", text: `step ${i} - café → ${"x".repeat(200)}` } })
  ).join("\n");

// rollout: array of lines (or null for no file at all). existing: a record already on
// disk before the event. agent: the --agent= the registration passes.
async function drive(hookPath, { rollout, existing, agent = "codex" }) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-codexauto-"));
  try {
    const HOME = path.join(box, "home");
    const TMP = path.join(box, "tmp");
    const sessDir = path.join(HOME, ".claude", "deckhand-sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(path.join(HOME, ".claude", "deckhand-answers"), { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(TMP, "host-alive"), JSON.stringify({ at: Date.now(), connected: true, remoteAnswer: true }));
    // Claude Code's wait is configurable; bound it so the claude-agent case cannot hang.
    fs.writeFileSync(path.join(HOME, ".claude", "deckhand-remote-wait"), "2");

    const sid = "01a1d83e-55b0-7cc2-94bf-388933b729da";
    const recFile = path.join(sessDir, `${sid}.json`);
    if (existing) fs.writeFileSync(recFile, JSON.stringify(existing));
    const transcript = path.join(box, "rollout.jsonl");
    if (rollout) fs.writeFileSync(transcript, rollout.join("\n") + "\n");

    const args = [hookPath, ...(agent ? [`--agent=${agent}`] : [])];
    const child = spawn(process.execPath, args, { env: { ...process.env, HOME, DECKHAND_TMP: TMP }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});
    const exitP = new Promise((r) => child.on("exit", () => r(true)));
    child.stdin.end(JSON.stringify({
      session_id: sid,
      turn_id: "01a1d868-53e3-7171-8f24-9e536ed266c7",
      transcript_path: transcript,
      cwd: "/tmp/x",
      hook_event_name: "PermissionRequest",
      model: "gpt-5.6-sol",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }));

    // Either it exits (the auto-review path never waits) or it publishes an ask and
    // sits in its wait - which is all a "genuine prompt" case needs to see.
    let sawAsk = null;
    const deadline = Date.now() + 5000;
    let exited = false;
    while (Date.now() < deadline) {
      exited = await Promise.race([exitP, sleep(50).then(() => false)]);
      try {
        const r = JSON.parse(fs.readFileSync(recFile, "utf8"));
        // Only an ask THIS event published: a record written before it (the stale-ask
        // case) already holds one, and reading that back is not the hook asking.
        if (r.ask && r.ask.pid !== existing?.ask?.pid && !sawAsk) sawAsk = r;
      } catch {}
      if (exited || sawAsk) break;
    }
    if (!exited) child.kill("SIGKILL");
    let final = null;
    try { final = JSON.parse(fs.readFileSync(recFile, "utf8")); } catch {}
    return { exited, sawAsk, final, stdout };
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

async function suite(hookPath) {
  const fails = [];
  let pass = 0;
  const ok = (c, what) => (c ? pass++ : fails.push(what));
  const auto = (r) => r.exited && !r.sawAsk && r.final?.status === "working" && !r.final?.ask && r.stdout === "";
  const asked = (r) => !!r.sawAsk && r.sawAsk.status === "asking";

  const a = await drive(hookPath, { rollout: [ctx("auto_review"), filler(3)] });
  ok(auto(a), `auto_review: exits at once, status "working", no ask, nothing on stdout (got exited=${a.exited} ask=${!!a.sawAsk} status=${a.final?.status})`);

  const u = await drive(hookPath, { rollout: [ctx("user"), filler(3)] });
  ok(asked(u), "reviewer \"user\": the person IS being asked - an ask is published, status \"asking\" (vacuity guard for every case above)");

  const lastUser = await drive(hookPath, { rollout: [ctx("auto_review"), filler(3), ctx("user"), filler(3)] });
  ok(asked(lastUser), "the LAST turn_context wins: switched from auto to user mid-session -> asked");
  const lastAuto = await drive(hookPath, { rollout: [ctx("user"), filler(3), ctx("auto_review"), filler(3)] });
  ok(auto(lastAuto), "the LAST turn_context wins: switched from user to auto mid-session -> not asked");

  // ~1.2MB of lines after the turn_context: several chunks back, across multi-byte edges.
  const far = await drive(hookPath, { rollout: [ctx("user"), ctx("auto_review"), filler(5000)] });
  ok(auto(far), "a turn_context several chunks back (a long turn) is still found");

  const unknown = await drive(hookPath, { rollout: [ctx("something_new"), filler(3)] });
  ok(asked(unknown), "an unseen reviewer value keeps the ask - never hide a real question");
  const missingField = await drive(hookPath, { rollout: [ctx(undefined), filler(3)] });
  ok(asked(missingField), "a turn_context with no approvals_reviewer keeps the ask");
  const noFile = await drive(hookPath, { rollout: null });
  ok(asked(noFile), "an unreadable rollout keeps the ask");

  const claude = await drive(hookPath, { rollout: [ctx("auto_review"), filler(3)], agent: null });
  ok(asked(claude), "Claude Code is untouched: only a Codex registration reads the reviewer");

  const stale = await drive(hookPath, {
    rollout: [ctx("auto_review"), filler(3)],
    existing: { cwd: "/tmp/x", status: "asking", agent: "codex", updated_at: Date.now(), ask: { pid: "old12345", kind: "perm", answerable: true } },
  });
  ok(auto(stale), "an auto-reviewed request clears a stale ask rather than carrying it forward");

  return { pass, fails };
}

if (!SELFTEST) {
  const r = await suite(REAL_HOOK);
  for (const f of r.fails) console.log(`FAIL  ${f}`);
  if (r.fails.length) {
    console.log(`\n${r.fails.length} failed, ${r.pass} passed`);
    process.exit(1);
  }
  console.log(`ok  ${r.pass} assertions pass`);
} else {
  const src = fs.readFileSync(REAL_HOOK, "utf8");
  const faults = [
    ["the ask is still published for an auto-reviewed request",
      (s) => s.replace('data.hook_event_name === "PermissionRequest" && !autoReviewed;', 'data.hook_event_name === "PermissionRequest";'), /auto_review: exits at once/],
    ["status left as \"asking\"",
      (s) => s.replace(/\n\s*status = "working";\n(\s*dlog\("  codex auto-review)/, "\n$1"), /auto_review: exits at once/],
    ["the FIRST turn_context is read, not the last",
      (s) => s.replace("for (let i = lines.length - 1; i >= 0; i--) {\n        if (!lines[i].includes('\"turn_context\"'))", "for (let i = 0; i < lines.length; i++) {\n        if (!lines[i].includes('\"turn_context\"'))"), /LAST turn_context wins/],
    ["the backward scan stops after one chunk",
      (s) => s.replace(/\n(\s*)end = start;\n(\s*)\}\n(\s*)return null;/, "\n$1end = 0;\n$2}\n$3return null;"), /several chunks back/],
    ["any reviewer value counts as automatic",
      (s) => s.replace("CODEX_AUTO_REVIEWERS.has(codexReviewer(data.transcript_path))", "codexReviewer(data.transcript_path) !== \"user\""), /unseen reviewer value|no approvals_reviewer|unreadable rollout/],
    ["the gate is not limited to Codex",
      (s) => s.replace(/AGENT === "codex" &&\n(\s*)data\.hook_event_name === "PermissionRequest" &&\n(\s*)CODEX_AUTO/, 'data.hook_event_name === "PermissionRequest" &&\n$2CODEX_AUTO'), /Claude Code is untouched/],
    ["a stale ask is carried forward",
      (s) => s.replace("const definesAsk = isPermEvent || isPreAsk || autoReviewed;", "const definesAsk = isPermEvent || isPreAsk;"), /clears a stale ask/],
  ];
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-codexauto-self-"));
  let caught = 0;
  try {
    for (const [i, [name, mutate, wanted]] of faults.entries()) {
      const patched = mutate(src);
      if (patched === src) { console.log(`FAIL  could not inject: ${name} (the anchor moved)`); continue; }
      const p = path.join(box, `hook-${i}.mjs`);
      fs.writeFileSync(p, patched);
      const r = await suite(p);
      const hit = r.fails.some((f) => wanted.test(f));
      console.log(`  ${hit ? "caught" : "MISSED"}  ${name}`);
      if (hit) caught++;
    }
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
  console.log(`selftest: ${caught}/${faults.length} faults caught`);
  process.exit(caught === faults.length ? 0 : 1);
}
