// Run: node host/account-id-check.mjs [--selftest]
// Imports nothing that touches CoreBluetooth, so plain node is safe here.
import fs from "fs";
import { accountKey } from "./account-id.mjs";

const SELFTEST = process.argv.includes("--selftest");
const UUID = "3f1c9a2e-7b44-4c1d-9e0a-5d2b8f6a1c33";

function run(fn) {
  let failed = 0;
  const eq = (got, want, what) => {
    if (got === want) return;
    if (!SELFTEST) console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    failed++;
  };
  const k = fn({ oauthAccount: { accountUuid: UUID, emailAddress: "a@b.c" } });
  eq(/^[0-9a-f]{8}$/.test(k), true, "8 lowercase hex chars");
  eq(fn({ oauthAccount: { accountUuid: UUID } }), k, "deterministic");
  eq(fn({ oauthAccount: { accountUuid: UUID.toUpperCase() } }) === k, false,
     "the UUID is hashed as-is, so a case change is a different input (no silent normalising)");
  eq(fn({ oauthAccount: { accountUuid: "other" } }) === k, false, "different accounts differ");
  eq(fn(null), "", "null file");
  eq(fn({}), "", "no oauthAccount");
  eq(fn({ oauthAccount: {} }), "", "no accountUuid");
  eq(fn({ oauthAccount: { accountUuid: "" } }), "", "empty accountUuid");
  eq(fn({ oauthAccount: { accountUuid: 42 } }), "", "non-string accountUuid");
  // NO PLAINTEXT LEAK: no 8-char slice of the UUID's own hex may appear verbatim.
  // A hash prefix shares short runs by chance; 8 contiguous chars would mean a slice.
  const hex = UUID.replace(/-/g, "");
  let leak = false;
  for (let i = 0; i + 8 <= hex.length; i++) if (k.includes(hex.slice(i, i + 8))) leak = true;
  eq(leak, false, "no 8-char slice of the raw UUID");
  return failed;
}

// Structural half: reads index.mjs's own text, one NAMED assertion per property.
function structuralFailures(srcText) {
  const src = srcText.replace(/\/\/.*$/gm, "");
  const bad = [];
  // The payload object literal is the line that publishes hostTag.
  const payloadLine = src.split("\n").find((l) => /\.\.\.usage,\s*hostId,\s*hostTag/.test(l)) || "";
  if (!/\.\.\.\(acctKey \? \{ acct: acctKey \} : \{\}\)/.test(payloadLine)) bad.push("payload-publishes-acctKey");
  // acctKey is only ever cleared or assigned from accountKey(): never a literal or a raw field.
  const assigns = [...src.matchAll(/\bacctKey\s*=(?!=)\s*([^;]*)/g)].map((m) => m[1].trim());
  if (!assigns.some((a) => a.startsWith("accountKey(")) ||
      !assigns.every((a) => a === '""' || a.startsWith("accountKey("))) bad.push("acctKey-only-from-accountKey");
  // The raw identity appears nowhere in the host, wire or log.
  if (/accountUuid/.test(src)) bad.push("no-raw-accountUuid-in-index");
  // THE FIRST TICK WAITS FOR THE KEY. An unawaited read races the first tick, whose
  // payload then carries no acct and is a DIFFERENT account ('@hostId') on board 2 for
  // one tick. Bound to the top-level startup lines (column 0), not to the file.
  const topLevel = src.split("\n").filter((l) => /^\S/.test(l)).map((l) => l.trim());
  if (!topLevel.includes("refreshAccountKey().finally(tick);") ||
      topLevel.some((l) => /^tick\(\s*\)\s*;/.test(l) || /^refreshAccountKey\(\s*\)\s*;/.test(l)))
    bad.push("first-tick-awaits-acctKey");
  // A POLL RE-READS THE KEY beside the token, AWAITED, after the early returns (a
  // skipped poll must not relabel the cached quota) and before the fetch.
  const at = src.indexOf("async function pollOauthUsage() {");
  let body = "";
  if (at >= 0) {
    let d = 0;
    for (let i = src.indexOf("{", at); i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}" && --d === 0) { body = src.slice(at, i + 1); break; }
    }
  }
  const refAt = body.search(/\bawait\s+refreshAccountKey\(\s*\)\s*;/);
  const tokAt = body.indexOf("getFreshAccessToken(");
  const lastRetBefore = tokAt >= 0 ? body.slice(0, tokAt).lastIndexOf("return;") : -1;
  if (!(refAt >= 0 && tokAt > refAt && refAt > lastRetBefore && lastRetBefore >= 0))
    bad.push("poll-rereads-acctKey-before-fetch");
  return bad;
}

if (SELFTEST) {
  // THE FAULT: a key that is just the UUID's first 8 hex chars, which passes every
  // shape test and leaks the identity. The checker must catch it by name.
  const leaky = (j) => String(j?.oauthAccount?.accountUuid || "").replace(/-/g, "").slice(0, 8);
  const caught = run(leaky) > 0;
  const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  let ok = caught;
  if (!caught) console.error("UNCAUGHT mirror fault: leaky key");
  if (structuralFailures(src).length) { ok = false; console.error("selftest baseline: real index.mjs already fails structurally"); }
  const faults = [
    ["payload-publishes-acctKey", (t) => t.replace("...(acctKey ? { acct: acctKey } : {}), ", "")],
    ["no-raw-accountUuid-in-index", (t) => t.replace("...usage, hostId, hostTag, ", "...usage, hostId, hostTag, accountUuid, ")],
    ["acctKey-only-from-accountKey", (t) => t.replace("acctKey = accountKey(", "acctKey = String(")],
    ["first-tick-awaits-acctKey", (t) => t.replace("refreshAccountKey().finally(tick);", "refreshAccountKey();\ntick();")],
    ["poll-rereads-acctKey-before-fetch", (t) => t.replace("    await refreshAccountKey();\n", "")],
    ["poll-rereads-acctKey-before-fetch", (t) => t.replace("    await refreshAccountKey();\n", "    refreshAccountKey();\n")],
    ["poll-rereads-acctKey-before-fetch", (t) => {
      // moved ABOVE the back-off's early return: a skipped poll would relabel cached quota
      const x = t.replace("    await refreshAccountKey();\n", "");
      return x.replace("async function pollOauthUsage() {\n", "async function pollOauthUsage() {\n  await refreshAccountKey();\n");
    }],
  ];
  for (const [name, mutate] of faults) {
    const mutated = mutate(src);
    const got = mutated === src ? ["(mutation did not apply)"] : structuralFailures(mutated);
    if (!got.includes(name)) { ok = false; console.error(`UNCAUGHT structural fault, wanted ${name}, got [${got}]`); }
  }
  console.log(ok ? "account-id --selftest: faults caught - PASS" : "account-id --selftest: a fault went UNCAUGHT - FAIL");
  process.exit(ok ? 0 : 1);
}

const mirrorFailed = run(accountKey);
const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const structBad = structuralFailures(src);
const structFailed = structBad.length ? 1 : 0;
if (structFailed) console.error(`FAIL structural: ${structBad.join(", ")}`);
console.log(`account-id: mirror ${mirrorFailed ? "FAILED" : "ok"}, structural ${structFailed ? "FAILED" : "ok"}`);
process.exit(mirrorFailed || structFailed ? 1 : 0);
