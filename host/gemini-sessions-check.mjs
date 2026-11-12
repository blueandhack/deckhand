#!/usr/bin/env node
// Checks the Antigravity session reader, and how its rows reach the device and the menu.
//   node host/gemini-sessions-check.mjs              - assert every claim
//   node host/gemini-sessions-check.mjs --selftest   - prove the structural half has teeth
//
// Two halves, reported separately, because a mirror binds nothing:
//   BEHAVIOUR runs the real shapeAntigravityRow()/readAntigravitySessions() over the
//     rows MEASURED on 2026-10-31 (see gemini-sessions.mjs) - the copy in another
//     store, the zero-time first sample, the subagent, RUNNING -> IDLE.
//   STRUCTURE reads host/index.mjs's own text, bound to FUNCTION BODIES: Antigravity
//     joins the device's records (the firmware knows "ag" now), a pushed SUBAGENT
//     record is dropped, an Antigravity row never gets a message credential and a
//     message aimed at one is refused on arrival, and its transcript is never handed
//     to the Claude-format history reader.
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeAntigravity } from "./sessions-merge.mjs";
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
check("the app's store names the app to activate, in the hooks' {id} shape", shapeAntigravityRow(copy, APP, NOW, STALE)?.app?.id === "com.google.antigravity");
check("the CLI names no app (its terminal is unrecorded)", shapeAntigravityRow(idle, CLI, NOW, STALE)?.app === undefined);
check("the agent is antigravity", shapeAntigravityRow(idle, CLI, NOW, STALE)?.agent === "antigravity");

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
// The merge, over the MEASURED case: the hook's last word was Stop with fullyIdle=false
// ("working"), and the index cleared not_fully_idle 34s later with no hook event at all.
{
  const hookRec = { id: "54f832c4-63d2-4c1a", status: "working", model: "gemini-4-argon-medium", prompt: "list this directory", updated_at: 1000, agent: "antigravity" };
  const pullRec = { id: "54f832c4-63d2-4c1a", status: "waiting", title: "List files", updated_at: 1034, agent: "antigravity" };
  const [m] = mergeAntigravity([pullRec], [hookRec]);
  check("the index's LIVE status wins over a hook record stuck on working", m.status === "waiting");
  check("... and the hook still supplies the model and the prompt", m.model === "gemini-4-argon-medium" && m.prompt === "list this directory");
  check("... the later timestamp of the two is kept", m.updated_at === 1034);
  check("... and the index's title fills a hook record that has none", m.title === "List files");
  const solo = mergeAntigravity([], [hookRec]);
  check("a hook record the index has no row for stands on its own", solo.length === 1 && solo[0].status === "working");
  check("one conversation from both sources is one row", mergeAntigravity([pullRec], [hookRec]).length === 1);
}
check("the subagent's id is in `children`, for the hook records' filter", read.children instanceof Set && read.children.has("4c175c00") && !read.children.has("92137089-93bf"));

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
  const bs = body(src, "async function buildSessionItem(");
  const tp = body(src, "async function handleTypedPrompt(");
  const dt = body(src, "async function deliverTextToSession(");
  const wa = body(src, "export function wireAgent(");
  const md = body(src, "export function msgDeliverable(");
  out.push(["every function bound below was found", !!(rs && ru && tk && bs && tp && dt && wa && md)]);
  if (!(rs && ru && tk && bs && tp && dt && wa && md)) return out;
  const topAt = rs.indexOf("const top =");
  const beforeTop = rs.slice(0, topAt);
  out.push(["Antigravity joins the device's records BEFORE `top` is cut", topAt > 0 && /readGeminiSessions\(\)/.test(beforeTop) && /mergeAntigravity\(ag, agHook\)/.test(beforeTop)]);
  out.push(["a pushed SUBAGENT record is dropped by the index's `children`", /agChildren\.has\(r\.id\)/.test(beforeTop)]);
  out.push(["the record loop keeps the antigravity agent", /record\.agent === "antigravity" \? record\.agent/.test(rs)]);
  out.push(["readUsage hands the menu's list to the log line", /menuSessions\s*=\s*sessions\.menu/.test(ru)]);
  out.push(["the device's `sessions` field is still the device's list", /sessions:\s*sessions\.list,/.test(ru)]);
  out.push(["the tick's log line prints the MENU's list", /sessions\(\$\{menuSessions\.total\}\)=\$\{JSON\.stringify\(menuSessions\.list\)\}/.test(tk)]);
  out.push(["wireAgent sends antigravity as ag", /agent === "antigravity" \? "ag"/.test(wa)]);
  out.push(["both builders send wireAgent(), not a two-way cx/cc test", (rs.match(/agent: wireAgent\(record\.agent\)/g) ?? []).length === 1 && /agent: wireAgent\(record\.agent\)/.test(bs) && !/agent: record\.agent === "codex" \? "cx" : "cc"/.test(src)]);
  out.push(["msgDeliverable refuses antigravity", /record\?\.agent !== "antigravity"/.test(md)]);
  out.push(["the message credential is gated on msgDeliverable", /item\.pnonce = nonceForSession/.test(bs) && /msgDeliverable\(record\)\) item\.pnonce/.test(bs)]);
  out.push(["a typed message to Antigravity is refused on arrival", /if \(!msgDeliverable\(record\)\)/.test(tp)]);
  out.push(["a spoken/delivered message to Antigravity is refused on arrival", /!msgDeliverable\(record\)/.test(dt)]);
  out.push(["an Antigravity transcript is never registered for history", /record\.transcript && record\.agent !== "antigravity"\) transcriptById\.set/.test(bs) && /r\.agent !== "antigravity"\) transcriptById\.set/.test(rs)]);
  return out;
}

for (const [name, ok] of structural(SRC)) check(name, ok);

if (process.argv.includes("--selftest")) {
  // Each fault reverts ONE guarantee; the named check must fail on it.
  const faults = [
    ["Antigravity left off the device's records", (s) => s.replace("...mergeAntigravity(ag, agHook)]", "]"), "Antigravity joins the device's records BEFORE `top` is cut"],
    ["subagent filter removed", (s) => s.replace('r.agent === "antigravity" && !agChildren.has(r.id)', 'r.agent === "antigravity"'), "a pushed SUBAGENT record is dropped by the index's `children`"],
    ["record loop folds antigravity into claude", (s) => s.replace('record.agent === "codex" || record.agent === "antigravity" ? record.agent : "claude"', 'record.agent === "codex" ? "codex" : "claude"'), "the record loop keeps the antigravity agent"],
    ["log line back on the device's list", (s) => s.replace("sessions(${menuSessions.total})=${JSON.stringify(menuSessions.list)}", "sessions(${usage.sessionsTotal})=${JSON.stringify(usage.sessions)}"), "the tick's log line prints the MENU's list"],
    ["menu list never set", (s) => s.replace(/menuSessions\s*=\s*sessions\.menu/, "menuSessionsX = sessions.menu"), "readUsage hands the menu's list to the log line"],
    ["device field swapped to the menu's list", (s) => s.replace("sessions: sessions.list,", "sessions: sessions.menu.list,"), "the device's `sessions` field is still the device's list"],
    ["ag sent as cc", (s) => s.replace('agent === "antigravity" ? "ag" : "cc"', 'agent === "antigravity" ? "cc" : "cc"'), "wireAgent sends antigravity as ag"],
    ["lean builder back to cx/cc", (s) => s.replace("      agent: wireAgent(record.agent),", '      agent: record.agent === "codex" ? "cx" : "cc",'), "both builders send wireAgent(), not a two-way cx/cc test"],
    ["msgDeliverable allows everything", (s) => s.replace('return record?.agent !== "antigravity";', "return true;"), "msgDeliverable refuses antigravity"],
    ["pnonce issued regardless", (s) => s.replace("&& msgDeliverable(record)) item.pnonce", ") item.pnonce"), "the message credential is gated on msgDeliverable"],
    ["typed-message refusal removed", (s) => s.replace("  if (!msgDeliverable(record)) {\n    console.error(`Prompt:", "  if (false) {\n    console.error(`Prompt:"), "a typed message to Antigravity is refused on arrival"],
    ["delivery refusal removed", (s) => s.replace("if (sessionId && !msgDeliverable(record)) {", "if (sessionId && false) {"), "a spoken/delivered message to Antigravity is refused on arrival"],
    ["Antigravity transcript registered", (s) => s.replace('if (record.transcript && record.agent !== "antigravity") transcriptById.set', "if (record.transcript) transcriptById.set"), "an Antigravity transcript is never registered for history"],
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
