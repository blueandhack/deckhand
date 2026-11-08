#!/usr/bin/env node
// Checks the Gemini (Antigravity) session reader, and that its rows reach the MENU
// and never the DEVICE.
//   node host/gemini-sessions-check.mjs              - assert every claim
//   node host/gemini-sessions-check.mjs --selftest   - prove the structural half has teeth
//
// Two halves, reported separately, because a mirror binds nothing:
//   BEHAVIOUR runs the real shapeAntigravityRow()/readAntigravitySessions() over the
//     rows MEASURED on 2026-10-31 (see gemini-sessions.mjs) - the copy in another
//     store, the zero-time first sample, the subagent, RUNNING -> IDLE.
//   STRUCTURE reads host/index.mjs's own text, bound to FUNCTION BODIES: Gemini must
//     not join the records the device's list is built from, the menu's list must
//     include it, and the tick's log line must print the menu's list. The firmware
//     draws any agent that is not "cx" as CLAUDE, so a Gemini row on the wire is a
//     mislabelled row on the glass.
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  shapeAntigravityRow,
  readAntigravitySessions,
  parseAgTime,
  agCwd,
  ANTIGRAVITY_STORES,
} from "./gemini-sessions.mjs";

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
};

const STALE = 20 * 60 * 1000;
const NOW = Date.parse("2026-11-01T05:39:00Z"); // fixed: nothing here uses the real clock
const APP = ANTIGRAVITY_STORES.find((s) => s.dir === "antigravity");
const CLI = ANTIGRAVITY_STORES.find((s) => s.dir === "antigravity-cli");

// Rows as measured, trimmed to the columns read. The CLI store's turn, sampled live:
const base = {
  conversation_id: "57bca724-0000-0000-0000-000000000000",
  title: "",
  workspace_uris: '["file:///Users/yoga/Projects/My%20Proj"]',
  killed: 0,
  parent_conversation_id: "",
  app_data_dir: "antigravity-cli",
  last_user_input_time: "0001-01-01 00:00:00+00:00",
};
const firstSample = { ...base, status: "CASCADE_RUN_STATUS_RUNNING", not_fully_idle: 1, last_modified_time: "0001-01-01 00:00:00+00:00" };
const running = { ...firstSample, last_modified_time: "2026-11-01 05:38:54.75101+00:00" };
const idle = { ...running, status: "CASCADE_RUN_STATUS_IDLE", not_fully_idle: 0, last_modified_time: "2026-11-01 05:38:58.250285+00:00" };
// The app's conversation as the CLI's store listed it: a COPY, empty status.
const copy = { ...idle, conversation_id: "92137089-93bf", status: "", app_data_dir: "antigravity" };
const subagent = { ...idle, conversation_id: "4c175c00", parent_conversation_id: "92137089-93bf", app_data_dir: "antigravity" };

console.log("BEHAVIOUR (the real functions, over measured rows)");
check("the zero time is unknown, not year 1", parseAgTime("0001-01-01 00:00:00+00:00") === 0);
check("a real time parses to its instant", parseAgTime("2026-11-01 05:38:58.250285+00:00") === Date.parse("2026-11-01T05:38:58.250Z"));
check("the zero-time FIRST sample is skipped this tick", shapeAntigravityRow(firstSample, CLI, NOW, STALE) === null);
check("RUNNING is working", shapeAntigravityRow(running, CLI, NOW, STALE)?.status === "working");
check("IDLE is waiting", shapeAntigravityRow(idle, CLI, NOW, STALE)?.status === "waiting");
check("not_fully_idle alone is working", shapeAntigravityRow({ ...idle, not_fully_idle: 1 }, CLI, NOW, STALE)?.status === "working");
check("a COPY of another store's conversation is not reported by this store", shapeAntigravityRow(copy, CLI, NOW, STALE) === null);
check("... and IS reported by the store that owns it", shapeAntigravityRow(copy, APP, NOW, STALE)?.id === "92137089-93bf");
check("a subagent is never a row", shapeAntigravityRow(subagent, APP, NOW, STALE) === null);
check("a killed conversation is never a row", shapeAntigravityRow({ ...idle, killed: 1 }, CLI, NOW, STALE) === null);
check("past SESSION_STALE_MS it drops", shapeAntigravityRow(idle, CLI, NOW + STALE + 60_000, STALE) === null);
check("the cwd is the decoded first workspace", agCwd(base.workspace_uris) === "/Users/yoga/Projects/My Proj");
check("no workspace is an empty cwd, not a throw", agCwd("[]") === "" && agCwd("not json") === "");
check("the app's store names the app to activate", shapeAntigravityRow(copy, APP, NOW, STALE)?.app === "com.google.antigravity");
check("the CLI names no app (its terminal is unrecorded)", shapeAntigravityRow(idle, CLI, NOW, STALE)?.app === "");
check("the agent is gemini", shapeAntigravityRow(idle, CLI, NOW, STALE)?.agent === "gemini");

// The reader: one store throwing (absent) must not cost the others, and an owned
// row seen from two stores is reported once.
const dbs = {
  antigravity: [copy, subagent],
  "antigravity-cli": [idle, copy],
};
const openDb = (file) => {
  const dir = path.basename(path.dirname(file));
  if (!dbs[dir]) throw new Error("ENOENT");
  return { prepare: () => ({ all: () => dbs[dir] }), close() {} };
};
const read = readAntigravitySessions({ root: "/x", now: NOW, staleMs: STALE, openDb });
check("an absent store costs nothing; two rows survive of four", read.length === 2);
check("each conversation is reported exactly once", new Set(read.map((r) => r.id)).size === read.length);

// ---------------------------------------------------------------------------
console.log("STRUCTURE (host/index.mjs's own text)");
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, "index.mjs"), "utf8");

// The body of a top-level function, by brace matching from its declaration.
function body(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

function structural(src) {
  const out = [];
  const rs = body(src, "async function readSessions(");
  const ru = body(src, "async function readUsage(");
  const tk = body(src, "async function tick(");
  out.push(["readSessions, readUsage and tick were all found", !!(rs && ru && tk)]);
  if (!rs || !ru || !tk) return out;
  const mergeLine = rs.match(/mergeById\(([^;]*)\);/)?.[1] ?? "";
  out.push(["the DEVICE's records are merged from Codex and the hook only", mergeLine !== "" && !/gemini/i.test(mergeLine)]);
  const beforeTop = rs.slice(0, rs.indexOf("const top ="));
  out.push(["no Gemini read happens before the device's `top` is cut", rs.includes("const top =") && !/readGeminiSessions\(/.test(beforeTop)]);
  out.push(["the menu's list does read Gemini", /readGeminiSessions\(\)/.test(rs.slice(rs.indexOf("const top =")))]);
  out.push(["readSessions returns the menu's list", /menu:\s*\{\s*list:/.test(rs)]);
  out.push(["readUsage hands the menu's list to the log line", /menuSessions\s*=\s*sessions\.menu/.test(ru)]);
  out.push(["the device's `sessions` field is still the device's list", /sessions:\s*sessions\.list,/.test(ru)]);
  out.push(["the tick's log line prints the MENU's list", /sessions\(\$\{menuSessions\.total\}\)=\$\{JSON\.stringify\(menuSessions\.list\)\}/.test(tk)]);
  const gm = body(src, "async function buildGeminiMenuItem(");
  out.push(["a Gemini menu row carries no nonce, ask or prompt", !!gm && !/pnonce|nonceFor|ask|prompt/.test(gm)]);
  out.push(["a Gemini menu row is tagged gm", !!gm && /agent:\s*"gm"/.test(gm)]);
  return out;
}

for (const [name, ok] of structural(SRC)) check(name, ok);

if (process.argv.includes("--selftest")) {
  // Each fault reverts ONE guarantee; the named check must fail on it.
  const faults = [
    ["gemini merged into the device's records", (s) => s.replace("mergeById(await readCodexSessions(), records)", "mergeById([...readGeminiSessions(), ...await readCodexSessions()], records)"), "the DEVICE's records are merged from Codex and the hook only"],
    ["log line back on the device's list", (s) => s.replace("sessions(${menuSessions.total})=${JSON.stringify(menuSessions.list)}", "sessions(${usage.sessionsTotal})=${JSON.stringify(usage.sessions)}"), "the tick's log line prints the MENU's list"],
    ["menu list never set", (s) => s.replace(/menuSessions\s*=\s*sessions\.menu/, "menuSessionsX = sessions.menu"), "readUsage hands the menu's list to the log line"],
    ["device field swapped to the menu's list", (s) => s.replace("sessions: sessions.list,", "sessions: sessions.menu.list,"), "the device's `sessions` field is still the device's list"],
    ["a nonce on a Gemini row", (s) => s.replace('agent: "gm",', 'agent: "gm", pnonce: nonceForSession(record.id),'), "a Gemini menu row carries no nonce, ask or prompt"],
  ];
  let blind = 0;
  console.log("SELFTEST");
  for (const [what, mutate, claim] of faults) {
    const mutated = mutate(SRC);
    if (mutated === SRC) {
      console.log(`  BLIND ${what}: the mutation did not apply, so it proves nothing`);
      blind++;
      continue;
    }
    const hit = structural(mutated).find(([n]) => n === claim);
    if (hit && !hit[1]) console.log(`  caught ${what} -> "${claim}"`);
    else {
      console.log(`  BLIND ${what}: "${claim}" still passes`);
      blind++;
    }
  }
  console.log(blind === 0 ? `selftest passed: all ${faults.length} faults caught` : `selftest FAILED: ${blind} blind`);
  process.exit(blind === 0 && failed === 0 ? 0 : 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
