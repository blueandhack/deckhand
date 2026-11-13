// Checks host/claude-tokens.mjs - the incremental reader that replaced ccusage for
// the USAGE tab's three token counts - with no device and no running host.
//   node host/claude-tokens-check.mjs             - every assertion
//   node host/claude-tokens-check.mjs --live      - also over this Mac's own transcripts
//   node host/claude-tokens-check.mjs --selftest  - prove the assertions have teeth
//
// WHAT IT GUARDS, in the order it was paid for (2026-11-13):
//   - the byte scanner (parseUsageBytes) must agree with JSON.parse on every line -
//     it exists only because JSON.parse of whole lines left the host 58-66 MB
//     resident, and a scanner that is cheaper but WRONG would be worse than either;
//   - the read loop must find every record, including in lines longer than a
//     chunk and with "usage" across a chunk seam, WITHOUT copying lines it does not
//     parse (the copying version measured 168 MB with the parser switched off);
//   - the counting rules that were matched against ccusage 20 on real data: the key
//     is message.id (+ requestId when present), the LARGEST copy wins, blocks start
//     at the UTC hour floor and break after 5h from the start or a 5h gap, weeks
//     start Monday local, Fable is claude-...fable... only;
//   - the host no longer spawns ccusage at all.
//
// THE SELFTEST MUTATES THE REAL SOURCE: each fault is a textual edit of
// claude-tokens.mjs (or index.mjs / package.json text), the edited module is
// imported from a scratch directory, and the named assertion must FAIL. An edit
// that no longer applies counts as BLIND, so the selftest cannot go vacuous when
// the source is reworded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "claude-tokens.mjs"), "utf8");
const HOST = fs.readFileSync(path.join(here, "index.mjs"), "utf8");
const PKG = fs.readFileSync(path.join(here, "package.json"), "utf8");
const LIVE = process.argv.includes("--live");
const SELFTEST = process.argv.includes("--selftest");

const ts = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
const line = ({ id = "msg_1", req = "req_1", model = "claude-opus-5-5", at = "2026-11-10T12:00:00.000Z",
  inp = 10, out = 20, cc = 30, cr = 40, content = '[{"type":"text","text":"hi"}]', extra = "" } = {}) =>
  `{"parentUuid":null${extra},"message":{"id":${JSON.stringify(id)},"type":"message","role":"assistant",` +
  `"model":${JSON.stringify(model)},"content":${content},"stop_reason":"end_turn",` +
  `"usage":{"input_tokens":${inp},"output_tokens":${out},"cache_creation_input_tokens":${cc},` +
  `"cache_read_input_tokens":${cr},"server_tool_use":{"web_search_requests":0}}},` +
  (req === null ? "" : `"requestId":${JSON.stringify(req)},`) + `"type":"assistant","timestamp":"${at}"}`;

async function suite(mod, check, hostSrc, pkgSrc) {
  const { parseUsageLine, parseUsageBytes, summarize, dedupe, weekStartMs, makeClaudeTokens, CHUNK, BLOCK_MS } = mod;
  const both = (l) => {
    const b = Buffer.from(l);
    return { ref: parseUsageLine(l), scan: parseUsageBytes(b, 0, b.length) };
  };

  // ---- 1. the scanner equals JSON.parse ----
  const awkward = {
    "an ordinary reply": line(),
    "escaped quotes and a fake usage key inside a string": line({
      content: JSON.stringify([{ type: "text", text: 'say \\"usage\\":{"input_tokens":999} and "usage":{"x":1} \\\\' }]) }),
    "a lone escaped quote followed by brackets, inside a string": line({
      content: JSON.stringify([{ type: "text", text: 'x" ] } { [ "' }]) }),
    "two message keys - the last wins, as in JSON.parse": line().replace('"message":{', '"message":{"id":"first","usage":{"input_tokens":1,"output_tokens":1}},"message":{'),
    "two message keys, the last without usage": line().replace(/,"type":"assistant"/, ',"message":{"id":"z"},"type":"assistant"'),
    "a nested usage object inside tool input, before the real one": line({
      content: '[{"type":"tool_use","name":"x","input":{"usage":{"input_tokens":5,"output_tokens":5},"n":[1,{"a":"}"}]}}]' }),
    "unicode and escapes in the model": line({ model: "claude-fable-5-2é\\n" }),
    "a reply with no requestId": line({ req: null }),
    "whitespace between tokens": line().replace(/,"usage":/, ' ,\n "usage" : ').replace(/:\{"input_tokens"/, ': { "input_tokens"'),
    "a user line whose toolUseResult carries usage": `{"type":"user","message":{"role":"user","content":"x"},"toolUseResult":{"usage":{"input_tokens":7,"output_tokens":7}},"timestamp":"2026-11-10T12:00:00.000Z"}`,
    "a truncated line": line().slice(0, -9),
    "trailing garbage after the object": line() + "x",
    "usage that is not an object": line().replace(/"usage":\{[^}]*\{[^}]*\}\}/, '"usage":"none"'),
  };
  for (const [name, l] of Object.entries(awkward)) {
    const { ref, scan } = both(l);
    check(`scanner = JSON.parse: ${name}`, scan, ref);
  }
  check("an ordinary reply counts all four token kinds", both(line()).ref?.tok, 100);
  check("a toolUseResult's usage is not a record", both(awkward["a user line whose toolUseResult carries usage"]).scan, null);

  // ---- 2. the read loop, against a brute-force read, on lines that cross chunks ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tokens-check-"));
  try {
    const proj = path.join(dir, "-Users-x-proj", "sess", "subagents");
    fs.mkdirSync(proj, { recursive: true });
    const f1 = path.join(dir, "-Users-x-proj", "a.jsonl");
    const f2 = path.join(proj, "agent-1.jsonl");
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const at = (h) => new Date(now - h * 3600_000).toISOString();
    // A usage line whose `"usage"` key starts 3 bytes before the first chunk seam,
    // so it is split across two reads.
    const pre = `{"parentUuid":null,"message":{"id":"seam","type":"message","role":"assistant","model":"claude-opus-5-5","content":"`;
    const pad = "y".repeat(CHUNK - 3 - (pre.length + 2));
    const seam = pre + pad + `","usage":{"input_tokens":1,"output_tokens":1}},"requestId":"r","type":"assistant","timestamp":"${at(1)}"}`;
    const hugeNoUsage = `{"type":"user","message":{"role":"user","content":"${"z".repeat(3 * CHUNK)}"},"timestamp":"${at(1)}"}`;
    const hugeUsage = line({ id: "big", at: at(2), content: JSON.stringify([{ type: "text", text: "w".repeat(2 * CHUNK) }]) });
    const lines1 = [line({ id: "a", at: at(3) }), hugeNoUsage, seam, hugeUsage, line({ id: "b", at: at(0.5) })];
    fs.writeFileSync(f1, lines1.join("\n") + "\n");
    const half = line({ id: "late", at: at(0.2) });
    fs.writeFileSync(f2, line({ id: "c", at: at(4) }) + "\n" + half.slice(0, 40)); // still being written
    const brute = (files) => files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").map(parseUsageLine).filter(Boolean));
    const key = (rs) => rs.map((r) => `${r.ts}|${r.tok}|${r.h}`).sort();
    const r = makeClaudeTokens({ root: dir, now: () => now });
    await r.read();
    check("reader = brute force: long lines, a seam, a half-written line",
      key(r.records()), key(brute([f1, f2])));
    check("the record whose usage key crosses the chunk seam is found",
      r.records().some((x) => x.tok === 2), true);
    fs.appendFileSync(f2, half.slice(40) + "\n");
    await r.read();
    check("a line finished later is read on the next call", key(r.records()), key(brute([f1, f2])));
    fs.writeFileSync(f2, line({ id: "d", at: at(1) }) + "\n"); // rewritten shorter
    await r.read();
    check("a rewritten file is read again from the start", key(r.records()), key(brute([f1, f2])));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3. the counting rules ----
  const rec = (iso, tok, h = null, fable = false) => ({ ts: Date.parse(iso), tok, h, fable });
  const z = (hh, mm = 0) => `2026-11-12T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;
  check("the 5h block starts at the UTC hour floor and holds 5h from there",
    summarize([rec(z(8, 40), 1), rec(z(12, 50), 2)], Date.parse(z(12, 55))).sessionTokens, 3);
  check("a record past start+5h starts a new block",
    summarize([rec(z(8, 40), 1), rec(z(13, 10), 2)], Date.parse(z(13, 30))).sessionTokens, 2);
  check("a gap over 5h starts a new block",
    summarize([rec(z(1), 1), rec(z(6, 30), 2)], Date.parse(z(7))).sessionTokens, 2);
  check("no block is active 5h after its last record",
    summarize([rec(z(1), 1)], Date.parse(z(6, 1))).sessionTokens, 0);
  check("BLOCK_MS is five hours", BLOCK_MS, 5 * 3600_000);
  check("the week starts Monday 00:00 local",
    weekStartMs(new Date(2026, 10, 13, 15).getTime()), new Date(2026, 10, 9).getTime());
  check("a Sunday belongs to the week that began the Monday before",
    weekStartMs(new Date(2026, 10, 15, 23).getTime()), new Date(2026, 10, 9).getTime());
  check("the week across the November clock change starts Monday 00:00 local",
    weekStartMs(new Date(2026, 10, 3, 10).getTime()), new Date(2026, 10, 2).getTime());
  const wk = summarize([rec(ts(2026, 10, 8, 23), 5), rec(ts(2026, 10, 9, 1), 7), rec(ts(2026, 10, 10), 11, null, true)],
    new Date(2026, 10, 10, 12).getTime());
  check("only the current week is counted, Fable separately", [wk.weekAllTokens, wk.weekFableTokens], [18, 11]);
  check("Fable is claude-...fable..., not any name containing fable",
    [both(line({ model: "claude-fable-5-2" })).ref.fable,
     both(line({ model: "hf.co/DavidAU/Qwen3.5-9B-The-Defiant-Fable-GGUF:Q8_0" })).ref.fable], [true, false]);
  const copies = [rec(z(9), 10, 1), rec(z(9, 1), 30, 1), rec(z(9, 2), 20, 1), rec(z(9, 3), 4, null), rec(z(9, 4), 4, null)];
  check("dedupe: the LARGEST copy of a key wins; unkeyed records all count",
    dedupe(copies).map((x) => x.tok), [30, 4, 4]);
  // Not `h === h` of two such lines: two nulls are equal too, which made the first
  // version of this assertion unable to fail (the selftest found it).
  check("a reply without requestId is still keyed on its message id",
    [both(line({ req: null, id: "m" })).ref.h !== null,
     both(line({ req: null, id: "m" })).ref.h === both(line({ req: null, id: "m", out: 99 })).ref.h], [true, true]);
  check("a requestId distinguishes otherwise-equal message ids",
    both(line({ id: "m", req: "1" })).ref.h === both(line({ id: "m", req: "2" })).ref.h, false);

  // ---- 4. the host side ----
  const body = (name) => {
    const at = hostSrc.indexOf(`function ${name}(`);
    return at < 0 ? "" : hostSrc.slice(at, hostSrc.indexOf("\n}", at));
  };
  check("the host never spawns ccusage", /ccusage[\/"'].*cli\.js|CCUSAGE_JS|runCcusage\(/.test(hostSrc), false);
  check("kickTokens reads through the incremental reader", /claudeTokens\s*\.\s*read\(\)/.test(body("kickTokens")), true);
  check("ccusage is not a host dependency", /"ccusage"\s*:/.test(pkgSrc), false);
}

async function run(mod, hostSrc, pkgSrc, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try { await suite(mod, check, hostSrc, pkgSrc); }
  catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.stack}`); }
  return { pass, failures };
}

// --live: this Mac's own transcripts. The scanner must equal JSON.parse on every
// line with "usage", and the reader must equal a brute-force read of every file.
async function live(mod) {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) { console.log("  live: no ~/.claude/projects here - skipped"); return 0; }
  const now = Date.now();
  const settled = now - 120_000;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".jsonl") && fs.statSync(f).mtimeMs >= now - mod.RETAIN_MS) files.push(f); } };
  walk(root);
  let lines = 0, bad = 0;
  const ref = [];
  for (const f of files) {
    const b = fs.readFileSync(f);
    let s = 0;
    for (let nl = b.indexOf(10); nl !== -1; s = nl + 1, nl = b.indexOf(10, s)) {
      if (b.indexOf('"usage"', s) === -1 || b.indexOf('"usage"', s) > nl) continue;
      lines++;
      const a = mod.parseUsageLine(b.toString("utf8", s, nl));
      if (JSON.stringify(a) !== JSON.stringify(mod.parseUsageBytes(b, s, nl))) bad++;
      if (a && a.ts >= now - mod.RETAIN_MS && a.ts < settled) ref.push(`${a.ts}|${a.tok}|${a.h}`);
    }
  }
  const r = mod.makeClaudeTokens({ root, now: () => now });
  await r.read();
  // Only records SETTLED before this check began, on both sides: transcripts are
  // live, and a line appended between the two reads (this very session writes
  // them) made the first version of this comparison fail ~1 run in 4. "Before
  // now" was not enough (still ~1 in 5): a line's timestamp can precede its write.
  const mine = r.records().filter((x) => x.ts < settled).map((x) => `${x.ts}|${x.tok}|${x.h}`).sort();
  ref.sort();
  const same = mine.length === ref.length && mine.every((k, i) => k === ref[i]);
  console.log(`  ${bad ? "FAIL" : "PASS"}  live: scanner = JSON.parse on all ${lines} usage lines (${bad} differ)`);
  console.log(`  ${same ? "PASS" : "FAIL"}  live: reader = brute force over ${files.length} files (${mine.length} vs ${ref.length} records)`);
  return (bad ? 1 : 0) + (same ? 0 : 1);
}

if (!SELFTEST) {
  const mod = await import("./claude-tokens.mjs");
  const r = await run(mod, HOST, PKG, false);
  const liveFails = LIVE ? await live(mod) : 0;
  const total = r.failures.length + liveFails;
  console.log(`\n${r.pass} passed, ${total} failed${LIVE ? "" : " (add --live for this Mac's own transcripts)"}`);
  process.exit(total ? 1 : 0);
}

// ---- --selftest: each fault edits the REAL source; the named assertion must fail ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tokens-selftest-"));
let n = 0;
async function mutated(src) {
  const f = path.join(scratch, `m${n++}.mjs`);
  fs.writeFileSync(f, src);
  return import(pathToFileURL(f).href);
}
const faults = [
  ["escapes ignored when finding a string's end", "src", "if ((q - 1 - k) % 2 === 0) return q + 1;", "return q + 1;"],
  ["the first copy wins instead of the largest", "src", "if (!prev || r.tok > prev.tok) byKey.set(r.h, r);", "if (!prev) byKey.set(r.h, r);"],
  ["records are keyed only when requestId exists", "src", 'h: typeof id === "string" ? hash53', 'h: typeof id === "string" && typeof requestId === "string" ? hash53'],
  ["any model containing fable counts as Fable", "src", "const FABLE = /^claude-.*fable/i;", "const FABLE = /fable/i;"],
  ["the week starts on Sunday", "src", "d.setDate(d.getDate() - ((d.getDay() + 6) % 7));", "d.setDate(d.getDate() - d.getDay());"],
  ["the block starts at the first record, not the hour floor", "src", "start = Math.floor(r.ts / 3600_000) * 3600_000;", "start = r.ts;"],
  ["a long line's usage is never parsed", "src", "          if (hasUsage) {", "          if (false) {"],
  ["no overlap at the chunk seam", "src", "const back = USAGE.length - 1;", "const back = 0;"],
  ["the scanner reads the first message key, not the last", "src", "      sawMessage = b[vs] === 123;\n      id = model = usage = undefined;", "      if (sawMessage) return;\n      sawMessage = b[vs] === 123;"],
  ["the scanner accepts trailing garbage", "src", "if (top < 0 || ws(b, top, end) !== end || !sawMessage) return null;", "if (top < 0 || !sawMessage) return null;"],
  ["the host spawns ccusage again", "host", "const claudeTokens = makeClaudeTokens({ root: PROJECTS_DIR });", 'const CCUSAGE_JS = path.join(__dirname, "node_modules", "ccusage", "src", "cli.js");\nconst claudeTokens = makeClaudeTokens({ root: PROJECTS_DIR });'],
  ["kickTokens stops using the reader", "host", "  tokensInFlight = claudeTokens\n    .read()", "  tokensInFlight = Promise.resolve(null)"],
  ["ccusage is a dependency again", "pkg", '"dependencies": {', '"dependencies": {\n    "ccusage": "^20.0.14",'],
];
let caught = 0, blind = 0;
for (const [name, where, from, to] of faults) {
  const text = where === "src" ? SRC : where === "host" ? HOST : PKG;
  if (!text.includes(from)) { blind++; console.log(`  BLIND   ${name}  <- the edit no longer applies`); continue; }
  const edited = text.replace(from, to);
  const mod = where === "src" ? await mutated(edited) : await import("./claude-tokens.mjs");
  const r = await run(mod, where === "host" ? edited : HOST, where === "pkg" ? edited : PKG, true);
  if (r.failures.length) { caught++; console.log(`  caught  ${name}\n            by: ${r.failures[0]}${r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""}`); }
  else console.log(`  MISSED  ${name}  <- no assertion notices this`);
}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nselftest: ${caught}/${faults.length} faults caught${blind ? `, ${blind} blind` : ""}`);
process.exit(caught === faults.length ? 0 : 1);
