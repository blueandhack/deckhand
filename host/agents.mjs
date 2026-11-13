// WHICH AGENTS DECKHAND WATCHES AT ALL - the Settings window's Agents switches.
//
// One small file, ~/.claude/deckhand-agents.json, `{"claude":true,"codex":false,
// "antigravity":true}`. The MENU-BAR APP WRITES IT and the host READS it every tick,
// so a switch takes effect within one tick whether or not the host was running when
// it was flipped, and survives a host restart without a command having to be
// replayed. (A trigger-file command would have been lost if the host was down, and
// only one command fits in that file at a time.)
//
// OFF MEANS WHOLE OFF. An agent that is off has its usage polling STOPPED (not just
// hidden), its cached readings dropped, and its sessions filtered out of everything
// the host publishes - so it is absent from the menu bar, the menu and the display.
// What each agent's polling costs is the reason this is not a display preference:
// Antigravity's CLI fallback is a 96-176 MB process every five minutes, and Codex's
// refresh is a real model turn.
//
// ABSENT OR MALFORMED MEANS ALL ON - the behaviour of every Deckhand before this
// file existed. A key that is missing or not a boolean is ON too, so a file written
// by a future build with a fourth agent cannot switch one of these three off.

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_KEYS = ["claude", "codex", "antigravity"];
export const AGENTS_FILE = path.join(os.homedir(), ".claude", "deckhand-agents.json");

export const ALL_ON = Object.freeze({ claude: true, codex: true, antigravity: true });

export function parseAgents(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { ...ALL_ON };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ...ALL_ON };
  const out = {};
  for (const k of AGENT_KEYS) out[k] = o[k] !== false;
  return out;
}

// The key a session record belongs to. Anything that is not Codex or Antigravity is
// Claude, which is what a record written before `agent` existed always was - the same
// rule readSessions() applies when it stamps the field.
export function agentOf(record) {
  const a = record?.agent;
  return a === "codex" || a === "antigravity" ? a : "claude";
}

// A reader that re-parses only when the file changes (mtime or size). Called every
// 5s tick, so the steady state is one stat and no read.
export function makeAgentSwitches(file = AGENTS_FILE) {
  let seen = null; // "mtimeMs:size", or "none"
  let value = { ...ALL_ON };
  return function current() {
    let key;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "none";
    }
    if (key === seen) return value;
    seen = key;
    if (key === "none") {
      value = { ...ALL_ON };
    } else {
      try {
        value = parseAgents(readFileSync(file, "utf8"));
      } catch {
        value = { ...ALL_ON };
      }
    }
    return value;
  };
}

// "claude off" for the log, naming only the agents that are off ("" when all on).
export function describeOff(agents) {
  return AGENT_KEYS.filter((k) => agents[k] === false).join(", ");
}
