// Gemini usage, read from the Gemini app's own LOCAL language server.
//
// Gemini.app (and the Antigravity app/IDE) run an `agy --hub` that writes a descriptor
// to ~/.gemini/<store>/daemon/hub_<port>.json: { pid, httpPort, httpsPort, lsVersion,
// csrfToken }. That server answers `RetrieveUserQuotaSummary` - the breakdown the app
// shows its own users - with quota GROUPS, each holding up to two BUCKETS:
//
//   "Gemini Models" (Flash, Pro)      5h + weekly
//   "Claude and GPT models"           5h + weekly
//   "Gemini 4 Argon"                  weekly only ("for paid Pro plans, Argon quota
//                                     is separate")
//
// each bucket { window: "5h"|"weekly", remainingFraction, resetTime }. MEASURED
// 2026-11-08 against lsVersion 2.28.2. An earlier version read `GetUserStatus`'s one
// quotaInfo per MODEL instead; it carried a single window per model (weekly for Argon,
// 5h for the rest) and even DISAGREED with this summary for Argon (0.970 against
// 0.999 remaining in the same minute), so it is not used.
//
// UNDOCUMENTED, so everything here degrades to "no reading": no hub file, a dead pid, a
// refused call, a changed shape - all return null, and the menu simply shows no Gemini
// usage. The call is read-only and goes to 127.0.0.1 only, with the CSRF token the app
// wrote for local clients in the user's own home directory. Nothing is sent elsewhere.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const GEMINI_ROOT = path.join(os.homedir(), ".gemini");
const CALL = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

/// "5h" | "weekly" -> minutes, the two windows the summary names. Anything else is
/// passed through as unknown (no pace can be drawn for it).
export function windowMinutes(w) {
  if (w === "5h") return 300;
  if (w === "weekly") return 10080;
  const m = /^(\d+)([hd])$/.exec(String(w ?? ""));
  return m ? Number(m[1]) * (m[2] === "d" ? 1440 : 60) : null;
}

/// The summary -> [{ name, buckets: [{ window, used, resetMin }] }], groups in the
/// app's own order, each group's buckets 5h first. A bucket without a number is
/// skipped - an absent number is not 0%.
///
/// TWO SPELLINGS of the same breakdown are read: the local server's camelCase
/// (`displayName`, `remainingFraction`, `resetTime`, under `response`) and the CLI's
/// snake_case (`name`, `remaining_fraction`, `reset_time`, under `command.data` in
/// `agy -p /usage --output-format json` - measured 2026-11-11, agy 1.5.6). Same groups,
/// same buckets, same windows; only the field names differ.
export function summarizeQuota(body, nowMs) {
  // The CLI's body ALSO has a `response` - the human table, as a STRING - so `response`
  // is only the server's envelope when it is an object.
  const env = body?.response && typeof body.response === "object" ? body.response : body?.command?.data ?? body;
  const groups = env?.groups;
  if (!Array.isArray(groups)) return null;
  const out = [];
  for (const g of groups) {
    const name = String(g?.displayName ?? g?.name ?? "").trim();
    if (!name || !Array.isArray(g.buckets)) continue;
    const buckets = [];
    for (const b of g.buckets) {
      const rem = Number(b?.remainingFraction ?? b?.remaining_fraction);
      if (!Number.isFinite(rem)) continue;
      const used = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
      const resetMs = Date.parse(b.resetTime ?? b.reset_time ?? "");
      buckets.push({
        window: String(b.window ?? "?"),
        used,
        resetMin: Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 60000)) : null,
      });
    }
    buckets.sort((a, b) => (windowMinutes(a.window) ?? 1e9) - (windowMinutes(b.window) ?? 1e9));
    if (buckets.length) out.push({ name, buckets });
  }
  return out.length ? out : null;
}

/// A reading `ageMin` minutes old, brought up to NOW: every reset moves that much
/// closer, and a window whose reset has PASSED is dropped - its percentage describes a
/// window that no longer exists (Codex's windowExpired rule). A group left with no
/// window is dropped. Without this a reading taken with "resets in 30m" said so for as
/// long as it was kept (6h), and showed a 5h figure for a window long since reset.
/// (Review finding.)
export function ageQuota(groups, ageMin) {
  const out = [];
  for (const g of groups ?? []) {
    const buckets = g.buckets
      .map((b) => ({ ...b, resetMin: b.resetMin == null ? null : b.resetMin - ageMin }))
      .filter((b) => b.resetMin == null || b.resetMin >= 0);
    if (buckets.length) out.push({ ...g, buckets });
  }
  return out;
}

/// The tick-line form, one token with no spaces:
///   gmq=Gemini_Models|5h:0:295|weekly:0:10071;Gemini_4_Argon|weekly:1:9968
/// Groups split on ";", a group's name and buckets on "|", a bucket on ":". Spaces in a
/// name become "_", and the separators themselves are removed from names.
export function quotaField(groups) {
  return groups
    .map((g) => [g.name.replace(/[;|:,]/g, "").replace(/\s+/g, "_"),
                 ...g.buckets.map((b) => `${b.window.replace(/[;|:\s]/g, "")}:${b.used}:${b.resetMin ?? "?"}`)].join("|"))
    .join(";");
}

async function liveHubs(root) {
  const hubs = [];
  let stores = [];
  try { stores = await fs.readdir(root); } catch { return hubs; }
  for (const store of stores) {
    const dir = path.join(root, store, "daemon");
    let names = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names.filter((n) => /^hub_\d+\.json$/.test(n))) {
      try {
        const file = path.join(dir, n);
        const d = JSON.parse(await fs.readFile(file, "utf8"));
        if (!d?.httpPort || !d?.csrfToken) continue;
        // A descriptor outlives a crashed hub; signal 0 asks "is it alive" and sends nothing.
        if (d.pid) { try { process.kill(d.pid, 0); } catch { continue; } }
        const { mtimeMs } = await fs.stat(file);
        hubs.push({ ...d, mtimeMs });
      } catch { /* unreadable or half-written: skip it */ }
    }
  }
  return hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/// Ask the newest live hub. Resolves to the group list, or null - never throws.
export async function readGeminiQuota({ root = GEMINI_ROOT, nowMs = Date.now(), timeoutMs = 3000 } = {}) {
  for (const hub of await liveHubs(root)) {
    try {
      const res = await fetch(`http://127.0.0.1:${hub.httpPort}${CALL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": hub.csrfToken },
        body: JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const groups = summarizeQuota(await res.json(), nowMs);
      if (groups) return groups;
    } catch { /* refused, timed out, or not JSON: try the next hub */ }
  }
  return null;
}

// THE DEVICE'S ONE ANTIGRAVITY FIGURE, shaped like Codex's (cxPct/cxResetMin/cxWin/
// cxAgeSec) so the firmware's strip renderer reads both the same way.
//
// WHICH window: the MOST-USED one among the Gemini groups, not a fixed group. Measured
// 2026-11-11 on this Mac: "Gemini Models" read 0% on both windows while "Gemini 4 Argon"
// read 35% of its week - and the sessions here run gemini-4-argon-medium. A fixed
// "Gemini Models" figure would have shown 0% for a limit a third spent. The "Claude and
// GPT models" group is left out: those are other vendors' models served through
// Antigravity, and the device's CLAUDE cards already mean the person's own Claude
// quota. A tie goes to the SHORTER window, the one that runs out first.
export function antigravityDeviceUsage(groups, ageSec) {
  let best = null;
  for (const g of groups ?? []) {
    if (/claude|gpt/i.test(g.name)) continue;
    for (const b of g.buckets) {
      const win = b.window === "5h" ? 300 : b.window === "weekly" ? 10080 : null;
      if (!best || b.used > best.used || (b.used === best.used && (win ?? 1e9) < (best.win ?? 1e9))) {
        best = { used: b.used, resetMin: b.resetMin, win };
      }
    }
  }
  if (!best) return {};
  return { agPct: best.used, agResetMin: best.resetMin ?? null, agWin: best.win, agAgeSec: ageSec };
}

// ---- the CLI's own /usage, for when no app is running a hub ----
//
// `agy -p /usage --output-format json` prints the same breakdown with NO model turn:
// measured 2026-11-11 on agy 1.5.6, `num_turns: 0`, every token count 0, ~3.6s wall and
// ~0.3s of CPU, and no conversation left behind (the CLI's brain/ directory count was
// unchanged). It authenticates as the CLI does - the person's own sign-in - so this
// works with only a terminal agy and no Antigravity app. It is a process spawn rather
// than a 35ms local call, so the host asks it far less often than it asks a hub.
//
// Where agy lives: the installer puts it in ~/.local/bin, which is not on launchd's
// PATH, so the usual places are tried before PATH.
export function agyCandidates(env = process.env, home = os.homedir()) {
  const out = [path.join(home, ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];
  for (const d of String(env.PATH ?? "").split(":")) if (d) out.push(path.join(d, "agy"));
  return [...new Set(out)];
}

export async function findAgy(candidates = agyCandidates()) {
  for (const c of candidates) {
    try { await fs.access(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

/// Run `agy -p /usage` and summarise it. Resolves to the group list, or null - never
/// throws. Run from the temp directory, so no workspace's own .agents/ config (its
/// hooks, its MCP servers) is loaded for a command that needs none of it.
export async function readGeminiQuotaFromCli({ agy, nowMs = Date.now(), timeoutMs = 30000 } = {}) {
  const bin = agy ?? (await findAgy());
  if (!bin) return null;
  return new Promise((resolve) => {
    execFile(bin, ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"],
      { cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const body = JSON.parse(String(stdout).trim().split("\n").filter(Boolean).pop() ?? "");
          resolve(body?.status === "SUCCESS" ? summarizeQuota(body, nowMs) : null);
        } catch { resolve(null); }
      });
  });
}
