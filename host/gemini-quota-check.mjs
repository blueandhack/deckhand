// node host/gemini-quota-check.mjs - Gemini usage (host/gemini-quota.mjs) and its wiring.
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { windowMinutes, summarizeQuota, quotaField, readGeminiQuota, ageQuota, antigravityDeviceUsage, agyCandidates } from "./gemini-quota.mjs";

let failed = 0, ran = 0;
const t = (got, want, what) => {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const NOW = Date.parse("2026-11-08T06:50:00Z");
// The shape MEASURED from the Gemini app's RetrieveUserQuotaSummary (lsVersion 2.28.2).
const bucket = (window, rem, reset) => ({ bucketId: "x", displayName: "x", window, remainingFraction: rem, resetTime: reset });
const body = { response: { groups: [
  { displayName: "Gemini Models", buckets: [bucket("weekly", 0.9, "2026-11-15T06:43:29Z"), bucket("5h", 0.4, "2026-11-08T11:43:29Z")] },
  { displayName: "Claude and GPT models", buckets: [bucket("weekly", 1, "2026-11-15T06:43:29Z"), bucket("5h", 1, "2026-11-08T11:43:29Z")] },
  { displayName: "Gemini 4 Argon", buckets: [bucket("weekly", 0.999072, "2026-11-15T05:02:13Z")] },
  { displayName: "Broken", buckets: [{ window: "5h" }] },
] } };

t(windowMinutes("5h"), 300, "5h is 300 minutes");
t(windowMinutes("weekly"), 10080, "weekly is 10080");
t(windowMinutes("3d"), 4320, "an unforeseen 3d still reads");
t(windowMinutes("monthly"), null, "an unknown window has no length, so no pace");

const q = summarizeQuota(body, NOW);
t(q.map((g) => g.name), ["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"],
  "groups in the app's own order; a group with no readable bucket is dropped");
t(q[0].buckets.map((b) => b.window), ["5h", "weekly"], "a group's 5h bucket comes first, whatever order it arrived in");
t(q[0].buckets.map((b) => b.used), [60, 10], "0.4 remaining is 60% used, 0.9 is 10%");
t(q[2].buckets, [{ window: "weekly", used: 0, resetMin: Math.round((Date.parse("2026-11-15T05:02:13Z") - NOW) / 60000) }],
  "Argon has a weekly bucket only, and 0.999 rounds to 0%");
t(summarizeQuota({ response: {} }, NOW), null, "a changed shape is no reading, not a throw");
t(summarizeQuota({ response: { groups: [{ displayName: "X", buckets: [{ window: "5h" }] }] } }, NOW), null,
  "no number anywhere is no reading - never 0%");

t(quotaField([q[0], q[2]]), `Gemini_Models|5h:60:${q[0].buckets[0].resetMin}|weekly:10:${q[0].buckets[1].resetMin};Gemini_4_Argon|weekly:0:${q[2].buckets[0].resetMin}`,
  "the tick-line form: groups by ';', buckets by '|', no spaces");
t(quotaField([{ name: "A;b|c:d e", buckets: [{ window: "5h", used: 1, resetMin: null }] }]), "Ab_c_d_e|5h:1:?".replace("Ab_c_d_e", "Abcd_e"),
  "separators in a name cannot break the field, and an unknown reset is '?'");

// Aging (review finding: a reset was frozen for 6h after the app closed).
const aged = ageQuota([q[0], q[2]], 30);
t(aged[0].buckets.map((b) => b.resetMin), [q[0].buckets[0].resetMin - 30, q[0].buckets[1].resetMin - 30],
  "a reading 30 minutes old has every reset 30 minutes closer");
t(ageQuota([{ name: "G", buckets: [{ window: "5h", used: 85, resetMin: 20 }, { window: "weekly", used: 9, resetMin: 900 }] }], 30),
  [{ name: "G", buckets: [{ window: "weekly", used: 9, resetMin: 870 }] }],
  "a window whose reset has PASSED is dropped, not shown with its old 85%");
t(ageQuota([{ name: "G", buckets: [{ window: "5h", used: 85, resetMin: 20 }] }], 30), [],
  "and a group with nothing left is dropped");
t(ageQuota([{ name: "G", buckets: [{ window: "5h", used: 1, resetMin: null }] }], 600)[0].buckets[0].resetMin, null,
  "an unknown reset stays unknown and is kept");

// THE LIVENESS CHECK, with teeth: a REAL local server that answers correctly, so the
// only thing that can make a descriptor be skipped is its dead pid. (Review finding:
// the first version pointed at a refused port, so the call failed either way and the
// assertion passed with the pid check deleted.)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-gmq-"));
t(await readGeminiQuota({ root, nowMs: NOW }), null, "no hub descriptor: null");
const daemon = path.join(root, "antigravity", "daemon");
fs.mkdirSync(daemon, { recursive: true });
fs.writeFileSync(path.join(daemon, "hub_1.json"), JSON.stringify({ pid: 999999, httpPort: port, csrfToken: "x" }));
t(await readGeminiQuota({ root, nowMs: NOW }), null, "a descriptor whose process is dead is skipped, though its port answers");
fs.writeFileSync(path.join(daemon, "hub_1.json"), JSON.stringify({ pid: process.pid, httpPort: port, csrfToken: "x" }));
t((await readGeminiQuota({ root, nowMs: NOW }))?.[0]?.name, "Gemini Models", "the same descriptor with a live process is read");
server.close();

// STRUCTURAL: bound to each function's own body, and to the exact expression that
// does the job - a name merely appearing somewhere in the body is not enough.
const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const fn = (re) => src.match(re)?.[0] ?? "";
const readUsage = fn(/async function readUsage\(\) \{[\s\S]*?\n\}\n/);
// Behind the Agents switch since 2026-11-13: an Antigravity that is switched OFF is not
// asked at all (host/agents-check.mjs binds the OFF half).
t(/^\s*if \(agents\.antigravity\) kickGeminiQuota\(\);/m.test(readUsage), true, "readUsage() kicks the Gemini read");
t(/await\s+kickGeminiQuota/.test(readUsage), false, "and never waits on it");
const kick = fn(/function kickGeminiQuota\(\) \{[\s\S]*?\n\}\n/);
t(/if \(geminiQuotaInFlight \|\| Date\.now\(\) - geminiQuotaAskedAt < GEMINI_QUOTA_EVERY_MS\) return;/.test(kick), true,
  "kickGeminiQuota returns while a read is in flight, or one was started under a minute ago");
t(/\.finally\(\(\) => \{ geminiQuotaInFlight = null; \}\)/.test(kick), true,
  "and clears the in-flight flag when the read ends, or one read would block every later one forever");
const line = fn(/function geminiQuotaLine\(\) \{[\s\S]*?\n\}\n/);
t(/Date\.now\(\) - geminiQuota\.at > GEMINI_QUOTA_DROP_MS\) return ""/.test(line), true,
  "geminiQuotaLine drops a reading older than GEMINI_QUOTA_DROP_MS");
t(/ageQuota\(geminiQuota\.list,/.test(line) && /quotaField\(groups\)/.test(line), true,
  "and prints the reading AGED to now, not as it was fetched");
t(/geminiQuotaLine\(\)\s*\+/.test(fn(/async function tick\([\s\S]*?\n\}\n/)), true,
  "tick() prints geminiQuotaLine() on the tick line");

// ---- the CLI's /usage (agy 1.5.6, 2026-11-11) and the device's one figure ----
// The body as `agy -p /usage --output-format json` printed it, trimmed: its `response`
// is the human TABLE as a string, and the breakdown sits under command.data in
// snake_case. Reading `response` first was a real bug in the first draft (null).
const cliBody = {
  conversation_id: "", status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t100%\t...",
  num_turns: 0,
  command: { name: "usage", data: { groups: [
    { name: "Gemini Models", buckets: [
      { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.998203456401825, reset_time: "2026-11-15T20:07:34Z" },
      { id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-11-12T08:47:17Z" } ] },
    { name: "Claude and GPT models", buckets: [
      { id: "3p-weekly", window: "weekly", remaining_fraction: 0.1, reset_time: "2026-11-19T03:47:17Z" } ] },
    { name: "Gemini 4 Argon", buckets: [
      { id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 0.6654009222984314, reset_time: "2026-11-15T05:02:13Z" } ] } ] } },
};
const CLI_NOW = Date.parse("2026-11-12T03:47:17Z");
const cq = summarizeQuota(cliBody, CLI_NOW);
t(cq?.map((g) => g.name).join("|"), "Gemini Models|Claude and GPT models|Gemini 4 Argon", "the CLI's snake_case body parses to the same groups");
t(cq?.[2].buckets[0].used, 33, "remaining_fraction 0.665 is 33% used");
t(cq?.[0].buckets.map((b) => b.window).join(","), "5h,weekly", "with 5h first, as the server's are");
// The device's figure: the MOST-USED Gemini window. Measured: Gemini Models at 0%,
// Argon at 33-35% - the figure that is a third spent is the one to show.
const dev = antigravityDeviceUsage(cq, 42);
t(dev.agPct, 33, "the device gets Argon's 33%, not Gemini Models' 0%");
t(dev.agWin, 10080, "... with Argon's window, weekly = 10080 minutes");
t(dev.agAgeSec, 42, "... and the reading's age");
t(antigravityDeviceUsage([{ name: "Claude and GPT models", buckets: [{ window: "5h", used: 99, resetMin: 1 }] }], 1).agPct, undefined,
  "the Claude/GPT group is never the device's figure, however used");
t(antigravityDeviceUsage([{ name: "Gemini Models", buckets: [{ window: "weekly", used: 5, resetMin: 9 }, { window: "5h", used: 5, resetMin: 1 }] }], 1).agWin, 300,
  "a tie goes to the SHORTER window, the one that runs out first");
t(JSON.stringify(antigravityDeviceUsage(null, 1)), "{}", "no reading sends no ag fields at all (the strip hides)");
t(agyCandidates({ PATH: "/usr/bin" }, "/H")[0], "/H/.local/bin/agy", "agy is looked for where its installer puts it first (not on launchd's PATH)");

console.log(failed ? `gemini-quota: ${failed} of ${ran} FAILED` : `gemini-quota: all ${ran} checks passed`);
process.exit(failed ? 1 : 0);
