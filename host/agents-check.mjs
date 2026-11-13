// The Agents switches (host/agents.mjs) and session liveness (host/session-liveness.mjs).
//
//   node host/agents-check.mjs             - the rules, then the host and hook wiring
//   node host/agents-check.mjs --selftest  - re-run everything against faulted copies of
//                                            the REAL sources; exits 0 only when every
//                                            fault is caught, by name
//
// Two promises are checked here, both made to the user on 2026-11-13:
//   1. a session whose Claude process is still running never disappears, however long
//      it is quiet (it used to be deleted after 20 minutes without a hook event);
//   2. an agent switched OFF is WHOLE off: not polled, not listed, not shown, and its
//      hook does not wait on the display.
// The behavioural half imports the modules FROM THEIR SOURCE TEXT, so --selftest can
// fault that text; the structural half reads index.mjs and the hook, bound to the
// function bodies that must carry each gate.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = {
  agents: readFileSync(path.join(here, "agents.mjs"), "utf8"),
  liveness: readFileSync(path.join(here, "session-liveness.mjs"), "utf8"),
  host: readFileSync(path.join(here, "index.mjs"), "utf8"),
  hook: readFileSync(path.join(here, "..", "claude-hooks", "deckhand-session-hook.mjs"), "utf8"),
};

const importText = (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);

// The body of the first function whose declaration starts with `header`, by brace
// matching. "" when absent, so every structural assertion also asserts it was found.
function bodyOf(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return "";
  const open = src.indexOf("{", at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

async function runChecks(src, { quiet = false } = {}) {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
    if (!quiet) console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  };

  // ---------------- the switches file ----------------
  const A = await importText(src.agents);
  const all = (o) => o.claude === true && o.codex === true && o.antigravity === true;
  check("no file / unparseable file means ALL ON (every Deckhand before this one)",
    all(A.parseAgents("")) && all(A.parseAgents("{not json")) && all(A.parseAgents("[]")) && all(A.parseAgents("null")));
  const p = A.parseAgents('{"codex":false}');
  check("an explicit false switches exactly that agent off", p.codex === false && p.claude === true && p.antigravity === true);
  const q = A.parseAgents('{"claude":"no","antigravity":0,"codex":null,"gpt":false}');
  check("only a literal false is off - a non-boolean or a future key cannot switch one off", all(q));
  check("agentOf: codex and antigravity are themselves, anything else is claude",
    A.agentOf({ agent: "codex" }) === "codex" && A.agentOf({ agent: "antigravity" }) === "antigravity" &&
    A.agentOf({}) === "claude" && A.agentOf({ agent: "claude" }) === "claude" && A.agentOf(null) === "claude");

  // The reader re-parses on change and falls back to all-on when the file goes away.
  const dir = mkdtempSync(path.join(os.tmpdir(), "deckhand-agents-"));
  try {
    const file = path.join(dir, "a.json");
    const cur = A.makeAgentSwitches(file);
    const r0 = cur();
    writeFileSync(file, '{"antigravity":false}');
    const r1 = cur();
    writeFileSync(file, '{"antigravity":false,"claude":false}');
    const r2 = cur();
    rmSync(file);
    const r3 = cur();
    check("the reader follows the file: absent -> on, written -> off, rewritten -> off, removed -> on",
      all(r0) && r1.antigravity === false && r1.claude === true && r2.claude === false && all(r3));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ---------------- session liveness ----------------
  const L = await importText(src.liveness);
  const NOW = 1_800_000_000_000, MIN = 60_000;
  const opts = (alive, exists) => ({
    now: NOW, staleMs: 20 * MIN, endedGraceMs: 2 * MIN,
    isAlive: () => alive, exists: () => exists,
  });
  const claude = (ageMin, extra = {}) => ({
    status: "waiting", updated_at: NOW - ageMin * MIN, inbox: { socket: "/tmp/cc-socks/4242.sock", token: "t" }, ...extra,
  });
  check("socketPid reads the Claude process out of the inbox socket path",
    L.socketPid(claude(0)) === 4242 && L.socketPid({}) === null &&
    L.socketPid({ inbox: { socket: "/tmp/x.sock" } }) === null && L.socketPid({ inbox: { socket: "/tmp/cc-socks/1.sock" } }) === null);
  check("THE BUG: a session quiet for 3 HOURS whose process is alive is KEPT",
    L.sessionFate(claude(180), opts(true, true)) === "keep");
  check("... and a working one quiet for a day, too (a long background task)",
    L.sessionFate(claude(24 * 60, { status: "working" }), opts(true, true)) === "keep");
  check("a session whose process is GONE is ended at once, even if it updated a minute ago",
    L.sessionFate(claude(1), opts(false, true)) === "end");
  check("alive but its socket is gone (exiting, or a reused pid): the age rule decides",
    L.sessionFate(claude(30), opts(true, false)) === "remove" && L.sessionFate(claude(5), opts(true, false)) === "keep");
  check("no socket at all (Codex, Antigravity, older Claude Code): the 20-minute rule is unchanged",
    L.sessionFate({ status: "waiting", updated_at: NOW - 21 * MIN }, opts(true, true)) === "remove" &&
    L.sessionFate({ status: "waiting", updated_at: NOW - 19 * MIN }, opts(true, true)) === "keep");
  check("an ENDED record keeps its 2-minute ghost row and is then removed, alive or not",
    L.sessionFate(claude(0, { status: "ended", ended_at: NOW - MIN }), opts(true, true)) === "keep" &&
    L.sessionFate(claude(0, { status: "ended", ended_at: NOW - 3 * MIN }), opts(true, true)) === "remove");
  check("pidAlive: this process is alive, a pid that cannot exist is not",
    L.pidAlive(process.pid) === true && L.pidAlive(2 ** 30) === false);

  // ---------------- host wiring ----------------
  const h = src.host;
  const rs = bodyOf(h, "async function readSessions(");
  const ru = bodyOf(h, "async function readUsage(");
  const po = bodyOf(h, "async function pollOauthUsage(");
  const tk = bodyOf(h, "async function tick(");
  check("readSessions, readUsage, pollOauthUsage and tick were all found",
    rs.length > 200 && ru.length > 200 && po.length > 200 && tk.length > 200);
  check("readSessions decides each record with sessionFate (live process outranks the clock)",
    /sessionFate\(record,/.test(rs) && /isAlive:\s*pidAlive/.test(rs) && /fate === "end"/.test(rs));
  check("readSessions no longer deletes on age alone",
    !/Date\.now\(\) - record\.updated_at > SESSION_STALE_MS/.test(rs));
  check("readSessions filters every record by its agent's switch",
    /agents\[agentOf\(r\)\] !== false/.test(rs));
  check("Codex OFF: the rollout walk is not run", /agents\.codex \? await track\("readSessions:codex", readCodexSessions\(\)\)/.test(rs));
  check("Antigravity OFF: its index is not queried", /if \(agents\.antigravity\) \{[^}]*readGeminiSessions\(\)/.test(rs));
  check("Antigravity OFF: its quota (app server, agy CLI) is not asked", /if \(agents\.antigravity\) kickGeminiQuota\(\)/.test(ru) &&
    (ru.match(/kickGeminiQuota\(\)/g) || []).length === 1);
  check("Claude OFF: no token read, no rate-limit read", /if \(agents\.claude\) \{\s*const tokensRun = kickTokens\(\)/.test(ru) &&
    /track\("readRateLimits", agents\.claude \? readRateLimits\(\) : Promise\.resolve\(\{\}\)\)/.test(ru));
  check("Claude OFF: the OAuth figure is not published", /const useOauth = agents\.claude &&/.test(ru));
  check("Codex / Antigravity OFF: their usage is not published",
    /agents\.codex \? codexUsage\(\) : \{\}/.test(ru) && /agents\.antigravity \? antigravityUsageForDevice\(\) : \{\}/.test(ru));
  check("Claude OFF: the OAuth poll returns before any network call",
    /^\{\s*(\/\/[^\n]*\n\s*)*if \(!agentSwitches\(\)\.claude\) \{\s*setTimeout\(pollOauthUsage/.test(po));
  check("Codex OFF: no refresh turn is spent", /if \(agentSwitches\(\)\.codex\) maybeRefreshCodexUsage\(\)/.test(tk) &&
    (h.match(/maybeRefreshCodexUsage\(\)\./g) || []).length === 1);
  check("the heartbeat carries the switches (what the hook reads)", /agents: agentSwitches\(\)/.test(tk));
  const na = bodyOf(h, "function noteAgents(");
  check("switching an agent off drops its cached readings",
    /if \(!agents\.codex\) \{ codexRateLimits = null;/.test(na) && /if \(!agents\.antigravity\) \{ geminiQuota = null;/.test(na));
  check("switching Antigravity off resets its ask stamps, so switching it on asks at once",
    /geminiQuotaAskedAt = 0; geminiQuotaCliAskedAt = 0;/.test(na));

  // ---------------- the hook ----------------
  const rsHook = bodyOf(src.hook, "function remoteState(");
  check("the hook never publishes or waits for an agent that is OFF",
    /if \(hb\.agents && hb\.agents\[AGENT\] === false\) return \{ display: false, answerable: false \}/.test(rsHook));

  return failures;
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  const swap = (key, from, to) => {
    if (!SRC[key].includes(from)) throw new Error(`selftest fault does not apply to ${key}: ${from}`);
    return { ...SRC, [key]: SRC[key].replace(from, to) };
  };
  const faults = [
    ["the age rule reinstated over a live process",
      swap("liveness", 'if (exists(record.inbox.socket)) return "keep";', ""), "THE BUG"],
    ["a dead process left to the clock",
      swap("liveness", 'if (!alive) return "end";', ""), "process is GONE"],
    ["ended rows never retired",
      swap("liveness", '> endedGraceMs ? "remove" : "keep"', '> endedGraceMs ? "keep" : "keep"'), "ENDED record"],
    ["a non-boolean read as off",
      swap("agents", "out[k] = o[k] !== false;", "out[k] = o[k] === true;"), "only a literal false"],
    ["a malformed file switches everything off",
      swap("agents", "if (!o || typeof o !== \"object\" || Array.isArray(o)) return { ...ALL_ON };",
        "if (!o || typeof o !== \"object\" || Array.isArray(o)) return { claude: false, codex: false, antigravity: false };"), "no file"],
    ["the reader caches forever",
      swap("agents", "if (key === seen) return value;", "if (seen !== null) return value;"), "the reader follows"],
    ["host: age-only deletion restored",
      swap("host", 'if (fate === "remove") {', 'if (fate === "remove" || Date.now() - record.updated_at > SESSION_STALE_MS) {'), "no longer deletes"],
    ["host: sessions not filtered by agent",
      swap("host", "records.push(...withAg.filter((r) => agents[agentOf(r)] !== false));", "records.push(...withAg);"), "filters every record"],
    ["host: agy asked while off",
      swap("host", "if (agents.antigravity) kickGeminiQuota();", "kickGeminiQuota();"), "Antigravity OFF: its quota"],
    ["host: tokens read while off",
      swap("host", "if (agents.claude) {\n    const tokensRun = kickTokens();", "{\n    const tokensRun = kickTokens();"), "Claude OFF: no token read"],
    ["host: OAuth polled while off",
      swap("host", "if (!agentSwitches().claude) {\n    setTimeout(pollOauthUsage", "if (false) {\n    setTimeout(pollOauthUsage"), "OAuth poll returns"],
    ["host: Codex refresh turn while off",
      swap("host", "if (agentSwitches().codex) maybeRefreshCodexUsage()", "maybeRefreshCodexUsage()"), "no refresh turn"],
    ["host: Codex usage published while off",
      swap("host", "...(agents.codex ? codexUsage() : {}),", "...codexUsage(),"), "usage is not published"],
    ["host: Codex rollouts walked while off",
      swap("host", 'agents.codex ? await track("readSessions:codex", readCodexSessions()) : []', 'await track("readSessions:codex", readCodexSessions())'), "rollout walk"],
    ["host: caches kept on off",
      swap("host", "if (!agents.antigravity) { geminiQuota = null;", "if (!agents.antigravity) { void 0;"), "drops its cached"],
    ["host: re-enabled Antigravity waits out the old stamp",
      swap("host", "geminiQuotaAskedAt = 0; geminiQuotaCliAskedAt = 0;", ""), "asks at once"],
    ["hook: waits on the display for an agent that is off",
      swap("hook", "if (hb.agents && hb.agents[AGENT] === false) return { display: false, answerable: false };", ""), "hook never publishes"],
  ];
  let caught = 0;
  for (const [name, faulted, expect] of faults) {
    const failures = await runChecks(faulted, { quiet: true });
    const hit = failures.some((f) => f.includes(expect));
    console.log(`  ${hit ? "caught" : "MISSED"}  ${name}${hit ? "" : `  (failures: ${failures.join(" | ") || "none"})`}`);
    if (hit) caught++;
  }
  console.log(`\nselftest: ${caught}/${faults.length} faults caught`);
  process.exit(caught === faults.length ? 0 : 1);
}

const failures = await runChecks(SRC);
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall agents/liveness checks pass");
process.exit(failures.length ? 1 : 0);
