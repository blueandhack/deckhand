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
