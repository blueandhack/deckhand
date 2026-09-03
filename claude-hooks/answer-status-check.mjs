#!/usr/bin/env node
// Does a remote answer put the session back to "working"?
//
// WHY THIS EXISTS. The hook clears the `ask` when its wait returns, but it used
// to leave `status` alone - so a question answered ON THE DEVICE left the record
// as `status:"asking"` with no ask object to answer. Nothing recomputes status
// after that: a device answer resolves a question as a DENY, and a denied
// AskUserQuestion fires NEITHER PostToolUse NOR PostToolUseFailure (measured -
// 623 PostToolUseFailure events in a 3.8MB log, every one of them Bash/Read/
// Monitor/Agent, never AskUserQuestion). So the row kept saying NEEDS INPUT
// until some unrelated later event happened to rewrite the record: measured at
// 75s and 2m41s on two real answers.
//
// THE FIX IS CONDITIONAL, AND THAT IS THE WHOLE SUBTLETY. The wait has two null
// exits. If the Mac answered, `cur.ask` no longer matches and we never enter the
// block. But a genuine TIMEOUT leaves our ask still pending with the Mac's
// dialog still on screen - so the session really is still asking, and forcing
// "working" there would be a lie in the one direction the user cannot detect.
// Hence assertions 4 and 5 as a PAIR: answered -> working, timed out -> asking.
// A fix that sets status unconditionally passes 4 and fails 5.
//
//   node claude-hooks/answer-status-check.mjs
//   node claude-hooks/answer-status-check.mjs --selftest
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");
const REAL_HOOK = path.join(import.meta.dirname, "deckhand-session-hook.mjs");

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; return true; }
  fails.push(what);
  return false;
}

// A captured-shape AskUserQuestion PermissionRequest. The `questions[0]` block is
// what makes buildAsk yield a real 2-option question rather than "Allow ...?".
function payload(sid) {
  return {
    session_id: sid,
    cwd: process.cwd(),
    hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion",
    permission_mode: "default",
    transcript_path: "/nonexistent/rollout.jsonl",
    tool_input: {
      questions: [{
        question: "Pick one?",
        header: "Pick",
        multiSelect: false,
        options: [
          { label: "First", description: "the first option" },
          { label: "Second", description: "the second option" },
        ],
      }],
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drive the REAL hook as a child against a throwaway $HOME, learn the pid it
// published, then optionally answer it the way the host's ANSWER path would.
// Returns the final record plus what we observed mid-flight.
async function drive(hookPath, { answer, waitSecs }) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-answerstatus-"));
  try {
    const HOME = path.join(box, "home");
    const TMP = path.join(box, "tmp");
    const sessDir = path.join(HOME, ".claude", "deckhand-sessions");
    const ansDir = path.join(HOME, ".claude", "deckhand-answers");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(ansDir, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });

    // The hook waits ONLY when the heartbeat is fresh, says connected, and does
    // not say remoteAnswer:false. A stale one publishes no ask at all, so
    // "never created" would be indistinguishable from "stripped" - the exact
    // false negative that cost real time on the Notification bug.
    fs.writeFileSync(path.join(TMP, "host-alive"),
      JSON.stringify({ at: Date.now(), connected: true, remoteAnswer: true }));
    // Bound the wait; the shipped default is effectively unlimited.
    fs.writeFileSync(path.join(HOME, ".claude", "deckhand-remote-wait"), String(waitSecs));

    const sid = "aa11bb22-cc33-dd44-ee55-ff6677889900";
    const recFile = path.join(sessDir, `${sid}.json`);

    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, HOME, DECKHAND_TMP: TMP },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});
    child.stdin.end(JSON.stringify(payload(sid)));

    // Wait for the ask to appear so we can read the random pid.
    let askPid = null, askStatus = null;
    for (let i = 0; i < 100 && askPid === null; i++) {
      await sleep(50);
      try {
        const r = JSON.parse(fs.readFileSync(recFile, "utf8"));
        if (r.ask && r.ask.pid) { askPid = r.ask.pid; askStatus = r.status; }
      } catch { /* not written yet */ }
    }

    if (answer && askPid) {
      fs.writeFileSync(path.join(ansDir, `${sid}.json`),
        JSON.stringify({ pid: askPid, idx: 0, label: "First" }));
    }

    // Hard cap so a hang cannot wedge the check.
    const exited = await Promise.race([
      new Promise((r) => child.on("exit", () => r(true))),
      sleep((waitSecs + 12) * 1000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");

    let final = null;
    try { final = JSON.parse(fs.readFileSync(recFile, "utf8")); } catch {}
    return { askPid, askStatus, final, stdout, exited, tmpWasScratch: TMP.startsWith(os.tmpdir()) };
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

async function suite(hookPath) {
  pass = 0; fails.length = 0;

  // ---- the answered path -------------------------------------------------
  const a = await drive(hookPath, { answer: true, waitSecs: 20 });

  ok(a.tmpWasScratch, "SAFETY: DECKHAND_TMP was a scratch path, not the live runtime dir");
  ok(a.exited, "the hook exited on its own rather than being killed");
  // Vacuity guard: everything below is meaningless if no ask was ever published.
  const published = ok(a.askPid !== null,
    "an ask WAS published (heartbeat live) - without this every later assertion is vacuous");
  ok(a.askStatus === "asking",
    `the published record is status:"asking" (got ${JSON.stringify(a.askStatus)})`);

  if (published) {
    ok(a.final && !a.final.ask,
      "answered: the ask object is stripped once the answer arrives");
    // THE BUG. This is the assertion that failed before the fix.
    ok(a.final && a.final.status === "working",
      `answered: status returns to "working" rather than being left as "asking" ` +
      `(got ${JSON.stringify(a.final && a.final.status)})`);
    ok(/"behavior"\s*:\s*"deny"/.test(a.stdout) || /hookSpecificOutput/.test(a.stdout),
      "answered: a decision really was emitted on stdout");
  }

  // ---- the TIMEOUT path, which must NOT be forced to working -------------
  const t = await drive(hookPath, { answer: false, waitSecs: 1 });
  ok(t.exited, "timeout: the hook exited on its own");
  if (t.askPid !== null) {
    ok(t.final && !t.final.ask,
      "timeout: the ask object is still stripped (the buttons are withdrawn)");
    ok(t.final && t.final.status === "asking",
      `timeout: status STAYS "asking" - the Mac's dialog is still open, so ` +
      `forcing "working" would be a lie (got ${JSON.stringify(t.final && t.final.status)})`);
    ok(!/"behavior"/.test(t.stdout),
      "timeout: NOTHING is written to stdout - a stray decision would auto-answer the dialog");
  }
  return { pass, fails: [...fails] };
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
  // Re-inject the shipped-for-months behaviour: clear the ask, leave status be.
  // Exit 0 ONLY if the answered-path status assertion actually catches it.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-answerstatus-self-"));
  try {
    const src = fs.readFileSync(REAL_HOOK, "utf8");
    const faults = [
      ["status left as \"asking\" (the original bug)",
       (s) => s.replace(/\n\s*if \(answer\) cur\.status = "working";/, ""),
       /status returns to "working"/],
      ["status forced unconditionally (the plausible WRONG fix)",
       (s) => s.replace(/if \(answer\) cur\.status = "working";/, 'cur.status = "working";'),
       /status STAYS "asking"/],
    ];
    let caught = 0;
    for (const [name, mutate, wanted] of faults) {
      const patched = mutate(src);
      if (patched === src) {
        console.log(`FAIL  could not inject: ${name} (the anchor moved)`);
        continue;
      }
      const p = path.join(box, `hook-${caught}.mjs`);
      fs.writeFileSync(p, patched);
      const r = await suite(p);
      const hit = r.fails.find((f) => wanted.test(f));
      if (hit) { caught++; console.log(`ok    caught: ${name}\n        by: ${hit}`); }
      else console.log(`FAIL  NOT caught: ${name}`);
    }
    if (caught !== faults.length) {
      console.log(`\nselftest FAILED: ${caught}/${faults.length} faults caught`);
      process.exit(1);
    }
    console.log(`\nselftest ok: ${caught}/${caught} injected faults caught`);
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}
