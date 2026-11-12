#!/usr/bin/env node
// Checks Deckhand's Antigravity hook and its installer.
//   node claude-hooks/antigravity-hook-check.mjs              - assert every claim
//   node claude-hooks/antigravity-hook-check.mjs --selftest   - prove the safety half has teeth
//
// THE SAFETY HALF IS THE POINT. Measured on agy 1.5.6 (deckhand-antigravity-hook.mjs's
// header): a PreToolUse hook GATES every tool call - `{}` on stdout denied the call, a
// crash failed it - so the installer must never register that event, and the hook must
// never print anything. Both are asserted against the real code: the installer's own
// exported EVENTS and entryFor(), and the hook run as a child process.
//
// BEHAVIOUR runs the hook's exported functions over the payloads captured from real
// agy turns (field names as measured: conversationId, hookEventName, cwd, modelName,
// lastUserInput, artifactDirectoryPath, fullyIdle). The child-process half runs the
// REAL hook against a throwaway $HOME, so nothing here touches ~/.claude.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeOf, statusFor, buildRecord, oneLine } from "./deckhand-antigravity-hook.mjs";
import { EVENTS, entryFor, nextConfig, DECKHAND_KEY } from "./install-antigravity-hooks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

// ---- the safety claims, as a function so the selftest can re-run them on a fault ----
function safety(events, entry) {
  const out = [];
  out.push(["PreToolUse is NOT registered (a hook there gates, and can break, every tool call)", !events.includes("PreToolUse")]);
  out.push(["every registered event is one measured harmless on failure",
    events.every((e) => ["SessionStart", "PreInvocation", "PostToolUse", "Stop"].includes(e))]);
  const handlers = Object.values(entry).flatMap((arr) => arr.flatMap((g) => g.hooks ?? [g]));
  out.push(["every command ends `; true`, so its exit status is always 0", handlers.length > 0 && handlers.every((h) => /; true$/.test(h.command))]);
  out.push(["every command sends stderr nowhere", handlers.every((h) => /2>\/dev\/null; true$/.test(h.command))]);
  out.push(["every handler carries a timeout", handlers.every((h) => Number.isInteger(h.timeout) && h.timeout > 0)]);
  out.push(["PostToolUse uses the tool-event shape {matcher, hooks}", Array.isArray(entry.PostToolUse) && entry.PostToolUse[0]?.matcher === "*" && Array.isArray(entry.PostToolUse[0]?.hooks)]);
  return out;
}

console.log("SAFETY (the installer's own EVENTS and entryFor)");
const ENTRY = entryFor('"/x/node" "/x/deckhand-antigravity-hook.mjs"');
for (const [n, ok] of safety(EVENTS, ENTRY)) check(n, ok);

console.log("BEHAVIOUR (the hook's functions, over captured payloads)");
const CONV = "54f832c4-63d2-4c1a-b678-3bfa4cd5f7b9";
const base = {
  conversationId: CONV, cwd: "/Users/x/proj", workspacePaths: ["/Users/x/proj"],
  modelName: "gemini-4-argon-medium", lastUserInput: "list\n\nthis   directory",
  artifactDirectoryPath: `/Users/x/.gemini/antigravity-cli/brain/${CONV}`,
  transcriptPath: `/Users/x/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`,
};
check("storeOf names the CLI's store", storeOf(base.artifactDirectoryPath) === "antigravity-cli");
check("storeOf names the app's store", storeOf(`/Users/x/.gemini/antigravity/brain/${CONV}`) === "antigravity");
check("storeOf refuses a directory that is not a known store", storeOf(`/Users/x/.gemini/elsewhere/brain/${CONV}`) === "");
for (const ev of ["SessionStart", "PreInvocation", "PostInvocation", "PostToolUse"])
  check(`${ev} is working`, statusFor({ hookEventName: ev }) === "working");
check("Stop with fullyIdle true is waiting", statusFor({ hookEventName: "Stop", fullyIdle: true }) === "waiting");
check("Stop with fullyIdle false is still working (background tasks)", statusFor({ hookEventName: "Stop", fullyIdle: false }) === "working");
check("PreToolUse is not interpreted (it is never registered)", statusFor({ hookEventName: "PreToolUse" }) === null);
check("an unknown event writes nothing", buildRecord({ hookEventName: "Mystery" }, {}, 1) === null);
const rec = buildRecord({ ...base, hookEventName: "PreInvocation" }, {}, 42);
check("the record is the antigravity agent, working", rec.agent === "antigravity" && rec.status === "working");
check("the record carries cwd, model, prompt (one line) and transcript",
      rec.cwd === "/Users/x/proj" && rec.model === "gemini-4-argon-medium" && rec.prompt === "list this directory" && rec.transcript === base.transcriptPath);
check("the CLI store has no app to activate", rec.store === "antigravity-cli" && rec.app === undefined);
const appRec = buildRecord({ ...base, hookEventName: "PreInvocation", artifactDirectoryPath: `/Users/x/.gemini/antigravity/brain/${CONV}` }, {}, 1);
check("the app store activates com.google.antigravity", appRec.app?.id === "com.google.antigravity");
const later = buildRecord({ hookEventName: "PostToolUse", conversationId: CONV }, rec, 99);
check("a later event without model or prompt keeps the earlier ones", later.model === rec.model && later.prompt === rec.prompt && later.cwd === rec.cwd);
check("oneLine caps with three ASCII dots, never U+2026", oneLine("x".repeat(50), 10) === "xxxxxxx...");

console.log("INSTALLER (nextConfig, pure)");
const cmd = '"/x/node" "/x/deckhand-antigravity-hook.mjs"';
const first = nextConfig("", { command: cmd, remove: false });
check("installs into an empty file under the deckhand key only", Object.keys(JSON.parse(first)).join() === DECKHAND_KEY);
check("a second install is a no-op (null: nothing written, nothing backed up)", nextConfig(first, { command: cmd, remove: false }) === null);
const theirs = JSON.stringify({ "my-linter": { PostToolUse: [{ matcher: "*", hooks: [{ command: "lint" }] }] } });
const merged = JSON.parse(nextConfig(theirs, { command: cmd, remove: false }));
check("someone else's hook is left exactly as it was", JSON.stringify(merged["my-linter"]) === JSON.stringify(JSON.parse(theirs)["my-linter"]));
const removed = JSON.parse(nextConfig(JSON.stringify(merged), { command: cmd, remove: true }));
check("remove takes out only the deckhand key", !(DECKHAND_KEY in removed) && "my-linter" in removed);
check("removing from a file without it is a no-op", nextConfig(theirs, { command: cmd, remove: true }) === null);
let threw = false;
try { nextConfig("{not json", { command: cmd, remove: false }); } catch { threw = true; }
check("a malformed file is refused, never rewritten", threw);

console.log("CHILD (the real hook, throwaway $HOME)");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agyhook-"));
  const run = (payload) => spawnSync(process.execPath, [path.join(here, "deckhand-antigravity-hook.mjs")],
    { input: JSON.stringify(payload), env: { ...process.env, HOME: home }, encoding: "utf8" });
  const r1 = run({ ...base, hookEventName: "PreInvocation" });
  const file = path.join(home, ".claude", "deckhand-sessions", `${CONV}.json`);
  check("exit 0", r1.status === 0);
  check("stdout is EMPTY (anything printed could become a decision)", r1.stdout === "");
  check("the record was written", fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).status === "working");
  run({ conversationId: CONV, hookEventName: "Stop", fullyIdle: true });
  check("Stop (fully idle) turns it to waiting", JSON.parse(fs.readFileSync(file, "utf8")).status === "waiting");
  const bad = run({ conversationId: "../../etc/x", hookEventName: "PreInvocation" });
  check("a path-shaped conversation id writes nothing outside the sessions dir",
        bad.status === 0 && !fs.existsSync(path.join(home, "etc")) && fs.readdirSync(path.join(home, ".claude", "deckhand-sessions")).length === 1);
  const junk = spawnSync(process.execPath, [path.join(here, "deckhand-antigravity-hook.mjs")], { input: "not json", env: { ...process.env, HOME: home }, encoding: "utf8" });
  check("malformed stdin: exit 0, nothing printed", junk.status === 0 && junk.stdout === "");
  fs.writeFileSync(path.join(home, ".claude", "deckhand-sessions", "aaaaaaaa-1111.json"), JSON.stringify({ agent: "claude", status: "asking" }));
  run({ conversationId: "aaaaaaaa-1111", hookEventName: "PreInvocation" });
  check("never overwrites another agent's record that shares an id",
        JSON.parse(fs.readFileSync(path.join(home, ".claude", "deckhand-sessions", "aaaaaaaa-1111.json"), "utf8")).agent === "claude");
  fs.rmSync(home, { recursive: true, force: true });
}

if (process.argv.includes("--selftest")) {
  console.log("SELFTEST (each fault must fail its named safety claim)");
  const faults = [
    ["PreToolUse registered", [...EVENTS, "PreToolUse"], ENTRY, "PreToolUse is NOT registered"],
    ["an exit status that can be non-zero", EVENTS, { ...ENTRY, Stop: [{ type: "command", command: "node hook.mjs", timeout: 10 }] }, "every command ends `; true`"],
    ["PostToolUse in the lifecycle shape", EVENTS, { ...ENTRY, PostToolUse: ENTRY.Stop }, "PostToolUse uses the tool-event shape"],
  ];
  let blind = 0;
  for (const [what, ev, en, claim] of faults) {
    const hit = safety(ev, en).find(([n]) => n.startsWith(claim));
    if (hit && !hit[1]) console.log(`  caught ${what} -> "${hit[0]}"`);
    else { console.log(`  BLIND ${what}`); blind++; }
  }
  console.log(blind ? `selftest FAILED: ${blind} blind` : `selftest passed: all ${faults.length} faults caught`);
  process.exit(blind || failed ? 1 : 0);
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
