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
export function summarizeQuota(body, nowMs) {
  const groups = (body?.response ?? body)?.groups;
  if (!Array.isArray(groups)) return null;
  const out = [];
  for (const g of groups) {
    const name = String(g?.displayName ?? "").trim();
    if (!name || !Array.isArray(g.buckets)) continue;
    const buckets = [];
    for (const b of g.buckets) {
      const rem = Number(b?.remainingFraction);
      if (!Number.isFinite(rem)) continue;
      const used = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
      const resetMs = Date.parse(b.resetTime ?? "");
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
