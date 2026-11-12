// Antigravity sessions, read out of Google Antigravity's own conversation index.
//
// Antigravity is the `agy` CLI, the Antigravity/Gemini app and the IDE - not the
// retired Gemini CLI, and nothing here reads ~/.gemini/tmp. This is the PULL half:
// every tick reads each store's `conversation_summaries.db`, a SQLite table
// Antigravity itself keeps one row per conversation in. The PUSH half is
// claude-hooks/deckhand-antigravity-hook.mjs, merged with this by id in readSessions().
//
// MEASURED, 2026-10-31, against agy 1.4.8 (one `agy -p` turn sampled every 300ms):
//   - the row is updated LIVE: status RUNNING with not_fully_idle=1 while the turn
//     ran, IDLE with not_fully_idle=0 ~3s later, last_modified_time moving with it.
//     So, unlike Codex's session_index.jsonl, this index does NOT lag its thread and
//     no per-conversation file needs to be statted.
//   - a brand-new row's FIRST sample carries the zero time "0001-01-01 ..." in
//     last_modified_time; one sample later it is real. A zero time is "unknown",
//     never year 1, so such a row is skipped for that one tick rather than aged out.
//   - a store can hold a COPY of another store's conversation: the CLI's index
//     listed the app's conversation with an empty status. `app_data_dir` names the
//     store that OWNS a row, so only owned rows are read, which is also the dedupe.
//
// NOT MEASURED: there is no "asking". CASCADE_RUN_STATUS has IDLE, RUNNING, BUSY,
// CANCELING and UNSPECIFIED (from the agy binary's own strings) and nothing for a
// pending approval, so a conversation waiting on a permission prompt most likely
// reads as working. Same honesty as Codex: never claim a prompt we cannot see.
import os from "node:os";
import path from "node:path";

export const ANTIGRAVITY_ROOT = path.join(os.homedir(), ".gemini");

// Each store is a directory under ~/.gemini, named exactly as rows' `app_data_dir`
// names it. `app` is the bundle id the menu bar activates on a click: the app's
// own stores name their app; the CLI runs in some terminal nobody recorded, so it
// has none and a click reveals the folder instead (the menu's existing fallback).
// Directory -> app was read off this machine (`~/.gemini/antigravity`'s log is a
// language server talking to the app's host bridge, the CLI writes antigravity-cli,
// and /Applications/Antigravity IDE.app is com.google.antigravity-ide).
export const ANTIGRAVITY_STORES = [
  { dir: "antigravity", app: "com.google.antigravity" },
  { dir: "antigravity-ide", app: "com.google.antigravity-ide" },
  { dir: "antigravity-cli", app: "" },
];

const WORKING = new Set(["CASCADE_RUN_STATUS_RUNNING", "CASCADE_RUN_STATUS_BUSY", "CASCADE_RUN_STATUS_CANCELING"]);

// "2026-10-31 07:58:41.99692+00:00" -> epoch ms. 0 for the zero time, empty, or junk.
export function parseAgTime(s) {
  if (typeof s !== "string" || !s || s.startsWith("0001-")) return 0;
  const ms = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// not_fully_idle counts as working on its own: it was 1 for the whole measured turn
// and is the flag that says something is still running even if status lags it.
export function agStatus(row) {
  return WORKING.has(row.status) || Number(row.not_fully_idle) === 1 ? "working" : "waiting";
}

// file:///Users/x/My%20Proj -> /Users/x/My Proj. The first workspace wins; a
// conversation with none has no folder to name or open.
export function agCwd(workspaceUris) {
  let uris;
  try {
    uris = JSON.parse(workspaceUris || "[]");
  } catch {
    return "";
  }
  const first = Array.isArray(uris) ? uris.find((u) => typeof u === "string" && u.startsWith("file://")) : null;
  if (!first) return "";
  try {
    return decodeURIComponent(new URL(first).pathname);
  } catch {
    return "";
  }
}

// One summaries row -> one session record in the shape readSessions() ranks, or
// null when the row is not a live, top-level conversation this store owns.
export function shapeAntigravityRow(row, store, now, staleMs) {
  if (!row || row.app_data_dir !== store.dir) return null; // a copy; its owner reports it
  if (row.parent_conversation_id) return null; // a subagent, not something you wait on
  if (Number(row.killed) === 1) return null;
  const at = Math.max(parseAgTime(row.last_modified_time), parseAgTime(row.last_user_input_time));
  if (!at || now - at > staleMs) return null;
  return {
    id: String(row.conversation_id || ""),
    cwd: agCwd(row.workspace_uris),
    status: agStatus(row),
    title: row.title || "",
    updated_at: at,
    agent: "antigravity",
    // The same {id, entry} shape the hooks stamp, so one builder reads both.
    ...(store.app ? { app: { id: store.app, entry: "" } } : {}),
  };
}

const COLUMNS =
  "conversation_id, title, last_modified_time, last_user_input_time, workspace_uris, " +
  "status, not_fully_idle, killed, parent_conversation_id, app_data_dir";

// `openDb(file)` returns something with prepare(sql).all(), or throws. Injected so
// the checker can drive this without SQLite; the host passes node:sqlite.
//
// The result is the list of live top-level conversations, carrying one extra property,
// `children`: the ids of every SUBAGENT conversation seen. The hook's payload cannot tell
// a subagent from its parent, so readSessions() uses this to drop a pushed subagent
// record the same way shapeAntigravityRow() drops a pulled one.
export function readAntigravitySessions({ root = ANTIGRAVITY_ROOT, now = Date.now(), staleMs, openDb }) {
  const out = new Map();
  const children = new Set();
  for (const store of ANTIGRAVITY_STORES) {
    let db;
    try {
      db = openDb(path.join(root, store.dir, "conversation_summaries.db"));
      for (const row of db.prepare(`SELECT ${COLUMNS} FROM conversation_summaries`).all()) {
        if (row?.parent_conversation_id && row.conversation_id) children.add(String(row.conversation_id));
        const rec = shapeAntigravityRow(row, store, now, staleMs);
        if (rec && rec.id) out.set(rec.id, rec);
      }
    } catch {
      // store absent (that app was never installed), or a schema this cannot read
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return Object.assign([...out.values()], { children });
}
