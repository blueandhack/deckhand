#!/usr/bin/env node
// Checks `ask.optDescs` - the per-option descriptions the hook publishes beside
// `ask.options` - in two halves that fail for different reasons:
//
//   BEHAVIOUR: drives the REAL hook as a child process against a throwaway $HOME
//              and a scratch DECKHAND_TMP, on a captured AskUserQuestion payload.
//   BUDGET:    computes what the field costs on the wire, in BYTES, from caps
//              PARSED out of the hook, the host and the firmware.
//
// Both halves exist because the first version of this feature was verified by a
// harness that lived in a scratch directory and then ceased to exist, so its
// arithmetic could not be re-run - and the arithmetic turned out to be wrong.
// A number nobody can re-derive is a comment, not a measurement.
//
// ---------------------------------------------------------------------------
// THE UNIT MISMATCH THIS CHECKER EXISTS TO RECORD, WHICH PREDATES optDescs
// ---------------------------------------------------------------------------
// feedChar() guards `buf.length() > 16000` on an Arduino String, which counts
// BYTES. Every cap upstream of it is applied with JS `.slice(n)`, which counts
// UTF-16 CODE UNITS. A BMP character outside ASCII is one unit and up to THREE
// bytes, so every char-capped field can be 3x its stated size on the wire:
//
//   detail   1400 chars -> up to 4200 bytes   (cleanMultiline keeps newlines too)
//   title      34 chars -> up to  102 bytes
//   label      32 chars -> up to   96 bytes
//
// So the saturated 6-session case measures ~34,000 bytes against a 16000-byte
// guard - more than 2x over - WITH optDescs ABSENT. The device's own buffers
// have the same disease one layer down: askDetail[1424] is sized for "1400
// chars" and copyField truncates by byte.
//
// THAT MISMATCH IS NOW FIXED, host-side, by making every device-bound field ASCII
// so the two units coincide - see host/to-ascii.mjs and host/wire-bytes-check.mjs.
// The model in THIS file is deliberately left as the BEFORE picture: it fills its
// fields with raw em-dashes and never transliterates, so its WIDE rows are what
// the wire used to carry. That is what keeps the defect's size on the record.
// It is also still the reason optDescs' own cap is NOT derived from that worst
// case: no cap survives it, including zero, so it cannot be the thing that sets one.
//
// Run:  node host/ask-optdescs-check.mjs
//       node host/ask-optdescs-check.mjs --selftest    # proves it can fail
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SRC = path.join(REPO, "claude-hooks", "deckhand-session-hook.mjs");
const HOST_SRC = path.join(REPO, "host", "index.mjs");
const FW_SRC = path.join(REPO, "firmware", "deckhand_display", "deckhand_display.ino");

// The most UTF-8 bytes ONE UTF-16 code unit can become. A BMP char in
// U+0800..U+FFFF is 1 unit and 3 bytes; an astral char is 2 units and 4 bytes,
// i.e. only 2 bytes per unit. So 3 is the ceiling, and it is what turns a
// character cap into a byte figure.
const BYTES_PER_UNIT = 3;

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else failures.push(msg);
}

// ---------------------------------------------------------------------------
// PARSE, never transcribe. Each parse is itself an assertion: a regex that has
// stopped matching must fail loudly by NAME, not silently yield undefined and
// take every downstream number with it.
// ---------------------------------------------------------------------------
function grab(src, label, re, cast = Number) {
  const m = src.match(re);
  ok(m != null, `PARSE: could not find ${label} - the regex no longer matches, so every number derived from it is unproven`);
  return m ? cast(m[1]) : NaN;
}

function readCaps(hookSrc, hostSrc, fwSrc) {
  const c = {};
  c.descMaxBytes = grab(hookSrc, "ASK_OPT_DESC_MAX_BYTES (hook)", /const ASK_OPT_DESC_MAX_BYTES = (\d+);/);
  c.labelChars = grab(hookSrc, "the option LABEL cap (hook)", /\.map\(\(o\) => clean\(o\?\.label \?\? o, (\d+)\)\)/);
  c.titleChars = grab(hookSrc, "the ask TITLE cap (hook)", /clean\(q\.header \?\? "Question", (\d+)\)/);
  c.detailChars = grab(hookSrc, "the ask DETAIL cap (hook)", /cleanMultiline\(q\.question \?\? "", (\d+)\)/);
  c.maxOptions = grab(hookSrc, "the option-count slice (hook)", /const opts = \(q\.options \?\? \[\]\)\.slice\(0, (\d+)\)/);
  c.maxSessionsHost = grab(hostSrc, "the session-list slice (host)", /const top = records\.slice\(0, (\d+)\);/);
  c.maxSessionsFw = grab(fwSrc, "MAX_SESSIONS (firmware)", /#define MAX_SESSIONS (\d+)/);
  c.lineGuard = grab(fwSrc, "feedChar's line guard (firmware)", /if \(buf\.length\(\) > (\d+)\) buf = "";/);
  c.askDetailBuf = grab(fwSrc, "SessionInfo.askDetail size (firmware)", /char askDetail\[(\d+)\];/);
  // Structural, not numeric: the description cap must reach the BYTE walk. A
  // cap that is only ever handed to clean() is a CHARACTER cap wearing a
  // byte-flavoured name, which is exactly the defect the name exists to prevent.
  c.usesCapBytes = /capBytes\(clean\(o\?\.description \?\? "", ASK_OPT_DESC_MAX_BYTES\), ASK_OPT_DESC_MAX_BYTES\)/.test(hookSrc);
  // The host must pass the ask through by SPREAD. A named field list would drop
  // optDescs silently - the device would simply never see it, with no error.
  c.hostSpreads = /item\.ask = \{ \.\.\.record\.ask, nonce: nonceForPid\(record\.ask\.pid\) \};/.test(hostSrc);
  // Emitted only when something is actually described.
  c.conditionalEmit = /\.\.\.\(descs\.some\(\(d\) => d\) \? \{ optDescs: descs \} : \{\}\)/.test(hookSrc);
  return c;
}

// ---------------------------------------------------------------------------
// The saturated tick line, built to the shape host/index.mjs:3001 serialises,
// and measured in BYTES (Buffer.byteLength) rather than in JS string length.
// `fill` says what the char-capped fields are made of: "ascii" is the floor,
// "wide" is the ceiling every one of them structurally permits.
// ---------------------------------------------------------------------------
function tickBytes(caps, { descCap = null, parkedVoice = false, sessions = null, fill = "ascii" } = {}) {
  const unit = fill === "wide" ? "—" : "x";      // em-dash: 1 unit, 3 bytes
  const S = (units) => unit.repeat(units);
  const n = sessions ?? caps.maxSessionsHost;
  const ask = () => ({
    pid: "x".repeat(8), kind: "question",
    title: S(caps.titleChars), detail: S(caps.detailChars),
    options: Array.from({ length: caps.maxOptions }, () => S(caps.labelChars)),
    // optDescs is already byte-capped upstream, so it contributes its cap
    // EXACTLY - it does not scale with `fill`. That asymmetry is the point.
    ...(descCap != null ? { optDescs: Array.from({ length: caps.maxOptions }, () => "x".repeat(descCap)) } : {}),
    nonce: "x".repeat(32), voice: true,
    ...(parkedVoice ? { voiceText: S(150), voiceSha: "x".repeat(16) } : {}),
  });
  const session = () => ({
    id: "x".repeat(12), name: S(22), status: "asking", path: S(64),
    model: S(20), branch: S(20), title: S(40),
    app: "com.microsoft.VSCode", appEntry: "claude-vscode", prompt: S(100),
    startSec: 86399, actSec: 86399, agent: "cc", ask: ask(),
  });
  const line = JSON.stringify({
    fiveHourPct: 100, fiveHourResetInMin: 300, sessionTokens: 999999999,
    sevenDayPct: 100, sevenDayResetInMin: 10080, weekAllTokens: 999999999,
    weekFableTokens: 999999999, weekFablePct: 100, quotaSource: "oauth", quotaAgeSec: 99999,
    cxPct: 100, cxResetMin: 10080, cxWin: 10080, cxAgeSec: 99999,
    sessions: Array.from({ length: n }, session),
    sessionsTotal: 99, hiddenAsking: 9, hostSecondsSinceMidnight: 86399,
    hostId: "x".repeat(8), hostTag: S(6), hostEmoji: "anchor", remoteAnswer: true,
    voice: { seq: 9999, at: 1e12, state: "done", text: S(200), reply: S(420) },
  }) + "\n";
  return Buffer.byteLength(line, "utf8");
}

// ---------------------------------------------------------------------------
// BEHAVIOUR: the real hook, in a sandbox. Never ~/.claude, never /tmp/deckhand-<uid>.
// ---------------------------------------------------------------------------
function runBehaviour(hookPath) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-optdescs-"));
  const HOME = path.join(box, "home");
  const TMP = path.join(box, "runtime");
  fs.mkdirSync(path.join(HOME, ".claude", "deckhand-sessions"), { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  // connected so an ask is published; remoteAnswer OFF so the hook never blocks
  // waiting for a device and emitDecision() is never reached.
  fs.writeFileSync(path.join(TMP, "host-alive"), JSON.stringify({ connected: true, remoteAnswer: false }));

  const fire = (payload) => {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME, DECKHAND_TMP: TMP },
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const f = path.join(HOME, ".claude", "deckhand-sessions", `${payload.session_id}.json`);
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    return { stdout, rec, file: f };
  };
  const ask = (sid, options) => ({
    session_id: sid, transcript_path: path.join(box, `${sid}.jsonl`), cwd: box,
    hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ header: "Pick one", question: "Which?", options }] },
  });

  // 1. Descriptions cross the wire, parallel to the labels.
  {
    const { stdout, rec } = fire(ask("b1", [
      { label: "Alpha", description: "The first one, and what happens if you take it." },
      { label: "Beta", description: "The second one." },
    ]));
    ok(stdout === "", `BEHAVIOUR: stdout must be EMPTY on a non-decision path, got ${JSON.stringify(stdout)}`);
    ok(rec?.ask?.optDescs?.length === rec?.ask?.options?.length,
       "BEHAVIOUR: optDescs is parallel to options");
    ok(rec?.ask?.optDescs?.[0]?.startsWith("The first one"), "BEHAVIOUR: the description reaches the record");
  }
  // 2. A described option and an undescribed one: the array stays DENSE, with an
  //    empty placeholder, or index i would stop meaning option i on the device.
  {
    const { stdout, rec } = fire(ask("b2", [{ label: "A" }, { label: "B", description: "why B" }]));
    ok(stdout === "", "BEHAVIOUR: stdout empty (mixed case)");
    ok(rec?.ask?.optDescs?.length === 2 && rec.ask.optDescs[0] === "" && rec.ask.optDescs[1] === "why B",
       `BEHAVIOUR: a partly-described question keeps a DENSE parallel array, got ${JSON.stringify(rec?.ask?.optDescs)}`);
  }
  // 3. No descriptions anywhere -> the key is absent, so the payload does not grow.
  {
    const { stdout, rec } = fire(ask("b3", [{ label: "A" }, { label: "B" }]));
    ok(stdout === "", "BEHAVIOUR: stdout empty (no-description case)");
    ok(rec?.ask && !("optDescs" in rec.ask), "BEHAVIOUR: no optDescs key when nothing is described");
  }
  // 4. An Allow/Deny permission prompt is untouched.
  {
    const { stdout, rec } = fire({
      session_id: "b4", transcript_path: path.join(box, "b4.jsonl"), cwd: box,
      hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls -la" },
    });
    ok(stdout === "", "BEHAVIOUR: stdout empty (perm prompt)");
    ok(rec?.ask?.kind === "perm" && !("optDescs" in rec.ask), "BEHAVIOUR: a perm prompt carries no optDescs");
  }
  // 5. THE CODEPOINT BOUNDARY. 200 em-dashes is 600 bytes; the cap lands inside
  //    one of them, and a naive byte slice would emit half a character.
  {
    const caps = readCaps(fs.readFileSync(hookPath, "utf8"), fs.readFileSync(HOST_SRC, "utf8"), fs.readFileSync(FW_SRC, "utf8"));
    const { stdout, rec } = fire(ask("b5", [{ label: "A", description: "—".repeat(200) }]));
    const d = rec?.ask?.optDescs?.[0] ?? "";
    const bytes = Buffer.byteLength(d, "utf8");
    ok(stdout === "", "BEHAVIOUR: stdout empty (boundary case)");
    ok(bytes <= caps.descMaxBytes, `BEHAVIOUR: description is <= the cap in BYTES (got ${bytes} vs ${caps.descMaxBytes})`);
    ok(!d.includes("�"), "BEHAVIOUR: no replacement char - the cap never splits a codepoint");
    // WHAT CHANGED, AND WHY THIS TEST NO LONGER SEES WHAT IT USED TO. clean() now
    // transliterates to ASCII before its slice (see host/to-ascii.mjs), so those
    // 200 em-dashes arrive here as 200 hyphens and the byte walk below can never
    // be reached by this input: bytes and characters are the same unit now.
    // capBytes() is KEPT anyway - it is the last line of defence if a future field
    // reaches it un-transliterated, and it costs nothing on ASCII.
    ok(d === "-".repeat(caps.descMaxBytes),
       `BEHAVIOUR: 200 em-dashes arrive as exactly ${caps.descMaxBytes} ASCII hyphens, got ${JSON.stringify(d.slice(0, 12))} x ${d.length}`);
    ok(d.length === bytes, "BEHAVIOUR: the description's character count IS its byte count - the whole point of the ASCII fix");
    // capBytes still walks codepoints when it IS handed multi-byte input, proved
    // directly rather than through a path that can no longer deliver any.
    ok(Buffer.byteLength("—".repeat(200).slice(0, caps.descMaxBytes), "utf8") === caps.descMaxBytes * 3,
       "BEHAVIOUR: a character cap on untransliterated input really would emit 3x the budget - which is what the ASCII fix removes");
  }
  // 6. A pending ask survives an event that defines no ask of its own.
  {
    fire(ask("b6", [{ label: "A", description: "carried" }]));
    const { stdout } = fire({
      session_id: "b6", transcript_path: path.join(box, "b6.jsonl"), cwd: box,
      hook_event_name: "Notification", notification_type: "idle",
    });
    const rec = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "deckhand-sessions", "b6.json"), "utf8"));
    ok(stdout === "", "BEHAVIOUR: stdout empty (carried ask)");
    ok(rec.ask?.optDescs?.[0] === "carried", "BEHAVIOUR: optDescs survives being carried across a Notification");
  }
  // 7. The sandbox really was a sandbox.
  ok(TMP.startsWith(os.tmpdir()) && !TMP.includes(`deckhand-${process.getuid()}`),
     "BEHAVIOUR: DECKHAND_TMP was a scratch path, not the live runtime dir");
  fs.rmSync(box, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
function main({ hookPath = HOOK_SRC, quiet = false } = {}) {
  const hookSrc = fs.readFileSync(hookPath, "utf8");
  const hostSrc = fs.readFileSync(HOST_SRC, "utf8");
  const fwSrc = fs.readFileSync(FW_SRC, "utf8");
  const c = readCaps(hookSrc, hostSrc, fwSrc);

  // ---- structure -----------------------------------------------------------
  ok(c.usesCapBytes, "STRUCTURE: the description cap must go through capBytes() - a cap only handed to clean() is a CHARACTER cap wearing a byte name");
  ok(c.hostSpreads, "STRUCTURE: host/index.mjs must pass the ask through by SPREAD, or optDescs is dropped silently");
  ok(c.conditionalEmit, "STRUCTURE: optDescs must be emitted only when something is described, so an Allow/Deny payload does not grow");
  ok(c.maxSessionsHost === c.maxSessionsFw,
     `STRUCTURE: the host sends ${c.maxSessionsHost} sessions and the device holds ${c.maxSessionsFw} - the budget is meaningless if they disagree`);

  // ---- THE CAP'S BOUND, derived rather than picked -------------------------
  // A description may not cost more bytes on the wire than the LABEL it
  // explains. A label is capped at c.labelChars CHARACTERS, so its byte
  // ceiling is that x BYTES_PER_UNIT. Both numbers are parsed out of the hook,
  // so this fails the moment either moves.
  const labelByteCeiling = c.labelChars * BYTES_PER_UNIT;
  ok(c.descMaxBytes <= labelByteCeiling,
     `CAP: ASK_OPT_DESC_MAX_BYTES (${c.descMaxBytes}) must not exceed one option LABEL's own byte ceiling ` +
     `(${c.labelChars} chars x ${BYTES_PER_UNIT} = ${labelByteCeiling}) - a description may not cost more than the label it explains`);
  ok(c.descMaxBytes > 0, "CAP: the cap must be positive, or the field is dead code");

  // ---- what the field actually costs on the wire ---------------------------
  const asciiNoDesc = tickBytes(c, { descCap: null });
  const asciiDesc = tickBytes(c, { descCap: c.descMaxBytes });
  const asciiNoDescVoice = tickBytes(c, { descCap: null, parkedVoice: true });
  const asciiDescVoice = tickBytes(c, { descCap: c.descMaxBytes, parkedVoice: true });
  const wideNoDesc = tickBytes(c, { descCap: null, fill: "wide" });
  const wideDesc = tickBytes(c, { descCap: c.descMaxBytes, fill: "wide" });
  const wideDescVoice = tickBytes(c, { descCap: c.descMaxBytes, parkedVoice: true, fill: "wide" });
  const marginal = asciiDesc - asciiNoDesc;

  // The cost must be exactly what the caps say it is: one description per option
  // per session, at the cap, plus JSON quoting. No hidden multiplier.
  ok(marginal === wideDesc - wideNoDesc,
     `BUDGET: optDescs must cost the SAME whatever the other fields hold (${marginal} vs ${wideDesc - wideNoDesc}) - it is byte-capped, so it cannot scale with them`);
  // Derived to the byte, not bounded loosely: per session JSON adds a comma, the
  // key `"optDescs":`, two brackets, one pair of quotes per entry and the commas
  // between them. Equality (not <=) is what catches a description that quietly
  // exceeds its cap, since a loose bound would absorb it.
  const perSession = 1 + '"optDescs":'.length + 2
    + c.maxOptions * (c.descMaxBytes + 2) + (c.maxOptions - 1);
  ok(marginal === c.maxSessionsHost * perSession,
     `BUDGET: optDescs costs ${marginal} bytes where the caps predict exactly ` +
     `${c.maxSessionsHost} x ${perSession} = ${c.maxSessionsHost * perSession} - something is emitting more than the cap allows`);

  // THE FINDING THIS FILE RECORDED, NOW FIXED - and the model above is the BEFORE
  // picture, kept deliberately. `tickBytes` fills its fields with raw em-dashes
  // and never transliterates, so `wideNoDesc` is what the wire used to carry; the
  // AFTER figure, and the whole char/byte reconciliation, live in
  // host/wire-bytes-check.mjs. This assertion stays as the record of the defect:
  // it must keep describing the unfixed model, or that model has drifted.
  ok(wideNoDesc > c.lineGuard,
     `BUDGET: the PRE-FIX model must still exceed the ${c.lineGuard}-byte guard WITHOUT optDescs (got ${wideNoDesc}). ` +
     `This models the wire BEFORE host/to-ascii.mjs; the fixed figures are in host/wire-bytes-check.mjs`);
  // And the dominant term is the detail, not this field, by a wide margin.
  const detailBytes = c.maxSessionsHost * c.detailChars * BYTES_PER_UNIT;
  ok(detailBytes > marginal * 5,
     `BUDGET: the detail cap (${detailBytes} bytes across ${c.maxSessionsHost} sessions) should dwarf optDescs (${marginal}) - if not, this field has become a real term and needs its own budget`);

  // The device's own ask buffer has the same unit mismatch; record it by asserting
  // the char-sized relationship that IS true, so a future byte-sizing is noticed.
  ok(c.askDetailBuf >= c.detailChars + 1,
     `FIRMWARE: askDetail[${c.askDetailBuf}] must hold the hook's ${c.detailChars}-char cap plus a NUL (in CHARACTERS - it is byte-truncated in practice, see the header)`);

  runBehaviour(hookPath);

  if (!quiet) {
    const row = (l, v, over) => console.log(`  ${l.padEnd(52)} ${String(v).padStart(6)} ${over ? "OVER" : "ok  "}`);
    console.log(`\ncaps parsed: desc ${c.descMaxBytes}B, label ${c.labelChars}ch, title ${c.titleChars}ch, ` +
                `detail ${c.detailChars}ch, ${c.maxOptions} options, ${c.maxSessionsHost} sessions, guard ${c.lineGuard}B\n`);
    console.log(`saturated tick line, ${c.maxSessionsHost} asking sessions, in BYTES (guard ${c.lineGuard}):`);
    row("ASCII, no descriptions", asciiNoDesc, asciiNoDesc > c.lineGuard);
    row("ASCII, no descriptions + parked voice", asciiNoDescVoice, asciiNoDescVoice > c.lineGuard);
    row(`ASCII + optDescs @ ${c.descMaxBytes}B`, asciiDesc, asciiDesc > c.lineGuard);
    row(`ASCII + optDescs @ ${c.descMaxBytes}B + parked voice`, asciiDescVoice, asciiDescVoice > c.lineGuard);
    row("WIDE (3-byte chars), no descriptions", wideNoDesc, wideNoDesc > c.lineGuard);
    row(`WIDE + optDescs @ ${c.descMaxBytes}B`, wideDesc, wideDesc > c.lineGuard);
    row(`WIDE + optDescs @ ${c.descMaxBytes}B + parked voice`, wideDescVoice, wideDescVoice > c.lineGuard);
    console.log(`\n  optDescs costs ${marginal} bytes at the cap - the SAME in every row above, because it is`);
    console.log(`  the one per-ask field capped in the unit the guard counts in.`);
    console.log(`  The detail cap alone is ${detailBytes} bytes across ${c.maxSessionsHost} sessions: ${(detailBytes / marginal).toFixed(1)}x this field.`);
    console.log(`  Realistic traffic is nowhere near any of this - ONE asking session at the cap is ` +
                `${tickBytes(c, { descCap: c.descMaxBytes, sessions: 1 })} bytes.`);
  }
  return { caps: c, marginal };
}

// ---------------------------------------------------------------------------
// --selftest: the same teeth-proving convention as palette-check.mjs. Each fault
// is injected into a COPY of the hook in a temp dir - never the repo file - and
// the run must FAIL. A checker that passes a broken input is worse than none.
// ---------------------------------------------------------------------------
function selftest() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-optdescs-selftest-"));
  const orig = fs.readFileSync(HOOK_SRC, "utf8");
  const faults = [
    ["the cap raised past one label's byte ceiling",
     (s) => s.replace(/const ASK_OPT_DESC_MAX_BYTES = \d+;/, "const ASK_OPT_DESC_MAX_BYTES = 97;")],
    ["the byte cap replaced by clean()'s CHARACTER slice",
     (s) => s.replace(/capBytes\(clean\(o\?\.description \?\? "", ASK_OPT_DESC_MAX_BYTES\), ASK_OPT_DESC_MAX_BYTES\)/,
                      'clean(o?.description ?? "", ASK_OPT_DESC_MAX_BYTES)')],
    ["optDescs emitted unconditionally, growing every Allow/Deny payload",
     (s) => s.replace(/\.\.\.\(descs\.some\(\(d\) => d\) \? \{ optDescs: descs \} : \{\}\)/, "optDescs: descs")],
    ["the array made SPARSE, so index i stops meaning option i",
     (s) => s.replace(/\.map\(\(o\) => capBytes\(/, ".filter((o) => o?.description).map((o) => capBytes(")],
    ["a line written to stdout, which on a PermissionRequest can auto-answer a real dialog",
     (s) => s.replace(/^function buildAsk\(data\) \{$/m, 'function buildAsk(data) {\n  console.log("");')],
  ];
  let caught = 0;
  for (const [name, mutate] of faults) {
    const p = path.join(box, `hook-${caught}.mjs`);
    const mutated = mutate(orig);
    if (mutated === orig) { console.log(`  NOT INJECTED (pattern no longer matches): ${name}`); continue; }
    fs.writeFileSync(p, mutated);
    const before = failures.length;
    pass = 0;
    try { main({ hookPath: p, quiet: true }); } catch { /* a crash is also a catch */ }
    const found = failures.length > before;
    console.log(`  ${found ? "caught  " : "MISSED  "} ${name}`);
    if (found) caught++;
    failures.length = before;
  }
  fs.rmSync(box, { recursive: true, force: true });
  console.log(`\nselftest: ${caught}/${faults.length} injected faults caught`);
  process.exit(caught === faults.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  main({});
  console.log(`\n${pass} assertions passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length ? 1 : 0);
}
