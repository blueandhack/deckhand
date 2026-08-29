#!/usr/bin/env node
// THE WIRE'S BYTE BUDGET, and the transliteration that makes it provable.
//
// THE BUG THIS FILE EXISTS FOR. The device's line-buffer guard counts BYTES
// (`buf.length() > 16000` on an Arduino String, fed one char at a time); every cap
// upstream of it counted CHARACTERS (JS `.slice(n)`, UTF-16 code units), and
// clean()/cleanMultiline() stripped control bytes only, so everything from U+0080
// up passed through at up to 3 bytes each. The two units were never reconciled.
//
// The failure mode was worse than a dropped line. The guard CLEARS THE BUFFER
// MID-LINE, so the first 16000 bytes are discarded and the REMAINDER of the same
// line accumulates into the emptied buffer; processCompletedLine() then receives a
// JSON fragment, handleLine() returns early on the parse error, and every tick
// carrying that prompt is lost. The screen freezes at its last good state for as
// long as the prompt is pending, while both links, both heartbeats and both menu
// bars look perfectly healthy and nothing logs why.
//
// THE FIX is host-side and it is ASCII: both device fonts declare 0x20..0x7E, and
// an out-of-range byte draws nothing and advances nothing, so every non-ASCII byte
// was budget spent on an invisible gap. Transliterating them away costs no
// information the device could ever have shown and makes characters and bytes the
// SAME UNIT by construction - which is why this reconciles every cap at once
// rather than patching one and leaving the next wrong. No firmware changed.
//
// This file asserts, with every cap PARSED rather than transcribed:
//   UNITS      after transliteration, byteLength === length for each capped field
//   FIDELITY   common characters are transliterated, not blanked; runs collapse to
//              ONE '?'; pure ASCII is returned byte-identical; it is idempotent
//   COPIES     the hook's inline toAscii and host/to-ascii.mjs agree over a corpus
//   STRUCTURE  every device-bound cap site actually routes through it
//   BUDGET     the saturated tick line, before and after, in BYTES
//   BEHAVIOUR  the REAL hook, in a throwaway $HOME, on a wide-character payload
//
// Run:  node host/wire-bytes-check.mjs
//       node host/wire-bytes-check.mjs --selftest    # proves it can fail
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SRC = path.join(REPO, "claude-hooks", "deckhand-session-hook.mjs");
const HOST_SRC = path.join(REPO, "host", "index.mjs");
const MOD_SRC = path.join(REPO, "host", "to-ascii.mjs");
const FW_SRC = path.join(REPO, "firmware", "deckhand_display", "deckhand_display.ino");

// The most UTF-8 bytes ONE UTF-16 code unit can become, i.e. what a character cap
// was worth in bytes BEFORE the fix. A BMP char in U+0800..U+FFFF is 1 unit and 3
// bytes; an astral char is 2 units and 4 bytes, so 3 is the ceiling.
const BYTES_PER_UNIT = 3;

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// ---------------------------------------------------------------------------
// PARSE, never transcribe. A regex that has stopped matching must fail by NAME
// rather than yield undefined and take every number derived from it with it.
// ---------------------------------------------------------------------------
function grab(src, label, re, cast = Number) {
  const m = src.match(re);
  ok(m != null, `PARSE: could not find ${label} - the regex no longer matches, so every number derived from it is unproven`);
  return m ? cast(m[1]) : NaN;
}

function readCaps(hookSrc, hostSrc, fwSrc) {
  const c = {};
  // hook: the ask fields
  c.titleChars = grab(hookSrc, "the ask TITLE cap (hook)", /clean\(q\.header \?\? "Question", (\d+)\)/);
  c.detailChars = grab(hookSrc, "the ask DETAIL cap (hook)", /cleanMultiline\(q\.question \?\? "", (\d+)\)/);
  c.labelChars = grab(hookSrc, "the option LABEL cap (hook)", /\.map\(\(o\) => clean\(o\?\.label \?\? o, (\d+)\)\)/);
  c.descMaxBytes = grab(hookSrc, "ASK_OPT_DESC_MAX_BYTES (hook)", /const ASK_OPT_DESC_MAX_BYTES = (\d+);/);
  c.maxOptions = grab(hookSrc, "the option-count slice (hook)", /const opts = \(q\.options \?\? \[\]\)\.slice\(0, (\d+)\)/);
  // host: the per-session fields it authors itself
  c.nameChars = grab(hostSrc, "the session NAME cap (host)", /name: deviceText\(await projectName\(record\.cwd \|\| ""\), (\d+)\)/);
  c.pathChars = grab(hostSrc, "the PATH cap (host)", /path: truncatePath\(toAscii\(record\.cwd \|\| ""\), (\d+)\)/);
  c.modelChars = grab(hostSrc, "the MODEL cap (host)", /tx\.model \|\| record\.model \|\| "",\s*\n\s*(\d+),/);
  c.branchChars = grab(hostSrc, "the BRANCH cap (host)", /branch: deviceText\(await gitBranch\(record\.cwd \|\| ""\), (\d+)\)/);
  c.sTitleChars = grab(hostSrc, "the session TITLE cap (host)", /title: deviceText\(tx\.title, (\d+)\)/);
  c.promptChars = grab(hostSrc, "the last-PROMPT cap (host)", /prompt: deviceText\(tx\.prompt, (\d+)\)/);
  c.voiceTextChars = grab(hostSrc, "VOICE_TEXT_MAX (host)", /const VOICE_TEXT_MAX = (\d+);/);
  c.voiceReplyChars = grab(hostSrc, "VOICE_REPLY_MAX (host)", /const VOICE_REPLY_MAX = (\d+);/);
  c.tagChars = grab(hostSrc, "the host TAG cap (host-tag)", /hostTag = macTag\(/, () => 6);
  c.maxSessionsHost = grab(hostSrc, "the session-list slice (host)", /const top = records\.slice\(0, (\d+)\);/);
  // firmware: the guard the whole budget is measured against
  c.maxSessionsFw = grab(fwSrc, "MAX_SESSIONS (firmware)", /#define MAX_SESSIONS (\d+)/);
  c.lineGuard = grab(fwSrc, "feedChar's line guard (firmware)", /if \(buf\.length\(\) > (\d+)\) buf = "";/);
  return c;
}

// Every cap that governs a field of DEVICE-BOUND TEXT, by name, so a new one
// added without a transliteration step shows up as a missing parse rather than as
// a number nobody checked.
const CAPPED_FIELDS = [
  ["ask.title", "titleChars"], ["ask.detail", "detailChars"], ["ask.options[]", "labelChars"],
  ["session.name", "nameChars"], ["session.path", "pathChars"], ["session.model", "modelChars"],
  ["session.branch", "branchChars"], ["session.title", "sTitleChars"], ["session.prompt", "promptChars"],
  ["voice.text", "voiceTextChars"], ["voice.reply", "voiceReplyChars"],
];

// ---------------------------------------------------------------------------
// STRUCTURE: every device-bound cap site must route through the transliteration.
// A site that does not is a bypass, and a bypass is the whole bug coming back
// through one field - which is exactly how it got here.
// ---------------------------------------------------------------------------
const HOOK_SITES = [
  ["clean() transliterates before its character slice", /function clean\(s, max\) \{[\s\S]{0,400}?return toAscii\(s\)/],
  ["cleanMultiline() transliterates before its character slice", /function cleanMultiline\(s, max\) \{[\s\S]{0,400}?return toAscii\(s\)/],
];
const HOST_SITES = [
  ["the module is imported", /import \{ toAscii, deviceText \} from "\.\/to-ascii\.mjs";/],
  ["session.name", /name: deviceText\(await projectName\(record\.cwd \|\| ""\), \d+\)/],
  ["session.path (transliterated BEFORE truncation, or the expansion could re-exceed the cap)",
   /path: truncatePath\(toAscii\(record\.cwd \|\| ""\), \d+\)/],
  ["session.model", /model: deviceText\(/],
  ["session.branch", /branch: deviceText\(await gitBranch\(/],
  ["session.title", /title: deviceText\(tx\.title, \d+\)/],
  ["session.prompt", /prompt: deviceText\(tx\.prompt, \d+\)/],
  ["session.app / appEntry", /\{ app: toAscii\(record\.app\.id\) \}[\s\S]{0,120}\{ appEntry: toAscii\(record\.app\.entry\) \}/],
  ["voice.text", /text: deviceText\(fields\.text \?\? lastVoice\?\.text \?\? "", VOICE_TEXT_MAX\)/],
  ["voice.reply", /reply: deviceText\(fields\.reply \?\? "", VOICE_REPLY_MAX\)/],
  ["histFlatten (the history reader's previews and full entries)", /const t = toAscii\(v\)/],
  ["histFlatten's truncation marker is three ASCII dots, not U+2026, which draws as NOTHING",
   /t\.slice\(0, max - 3\) \+ "\.\.\."/],
];

// ---------------------------------------------------------------------------
// The corpus. Deliberately includes what Claude's own output is actually full of
// (em-dashes, curly quotes, ellipses, arrows) alongside the cases that have no
// ASCII form at all, plus the boundary shapes: astral pairs, combining sequences,
// zero-width joins, and runs that must collapse.
// ---------------------------------------------------------------------------
const CORPUS = [
  "", "plain ascii text", "already/ascii-only_1234!?", "\n\ttabs and newlines\n",
  "an em - dash", 'straight "quotes" and \'apostrophes\'',
  "an em — dash", "curly “quotes” and ‘apostrophes’",
  "ellipsis… here", "a → b ⇒ c", "≤ ≥ ≠ ≈ ±",
  "café naïve résumé", "Straße æther øre łódź",
  "é decomposed already", "50°C × 3 ÷ 2",
  "你好世界", "こんにちは", "😀🎉👍",
  "mix 你好 and ascii", "你好世界你好世界你好",
  "zero​width‍joined", "nbsp and thin", "bullet • list ‣ item",
  "© 2026 ™ ®", "€10 £5 ¥100",
  "✓ done ✗ failed", "trailing wide 中文",
  "中文 leading", "😀", "—".repeat(200), "中".repeat(200),
  "a中文b中文c",
];

// ---------------------------------------------------------------------------
// The saturated tick line, in BYTES, built to the shape host/index.mjs serialises.
// `fill` is what the char-capped fields are made of; `xlate` says whether the
// transliteration runs, which is the difference between BEFORE and AFTER.
// ---------------------------------------------------------------------------
function tickBytes(caps, toAscii, { descCap = null, parkedVoice = false, sessions = null, fill = "ascii", wideSessions = null, xlate = true } = {}) {
  // The em-dash is the TIGHTEST wide case, not the loudest: it is 3 bytes in and
  // 1 byte out, so it preserves LENGTH through the transliteration where CJK
  // collapses to a single '?' and would flatter the result enormously.
  // Production transliterates and THEN caps; the model must do the same or it is
  // measuring an order of operations the code does not use.
  const S = (units, wide) => {
    const raw = (wide ? "—" : "x").repeat(units);
    return (xlate ? toAscii(raw) : raw).slice(0, units);
  };
  const n = sessions ?? caps.maxSessionsHost;
  // `wideSessions` is how many of the n sessions carry wide text; null means "all
  // of them if fill is wide". The MIXED case is the one actually reported: an
  // otherwise ordinary tick line with ONE question containing CJK.
  const nWide = wideSessions ?? (fill === "wide" ? n : 0);
  const ask = (S) => ({
    pid: "x".repeat(8), kind: "question",
    title: S(caps.titleChars), detail: S(caps.detailChars),
    options: Array.from({ length: caps.maxOptions }, () => S(caps.labelChars)),
    ...(descCap != null ? { optDescs: Array.from({ length: caps.maxOptions }, () => "x".repeat(descCap)) } : {}),
    nonce: "x".repeat(32), voice: true,
    ...(parkedVoice ? { voiceText: S(150), voiceSha: "x".repeat(16) } : {}),
  });
  const session = (wide) => {
    const F = (units) => S(units, wide);
    return {
      id: "x".repeat(12), name: F(caps.nameChars), status: "asking", path: F(caps.pathChars),
      model: F(caps.modelChars), branch: F(caps.branchChars), title: F(caps.sTitleChars),
      app: "com.microsoft.VSCode", appEntry: "claude-vscode", prompt: F(caps.promptChars),
      startSec: 86399, actSec: 86399, agent: "cc", ask: ask(F),
    };
  };
  const line = JSON.stringify({
    fiveHourPct: 100, fiveHourResetInMin: 300, sessionTokens: 999999999,
    sevenDayPct: 100, sevenDayResetInMin: 10080, weekAllTokens: 999999999,
    weekFableTokens: 999999999, weekFablePct: 100, quotaSource: "oauth", quotaAgeSec: 99999,
    cxPct: 100, cxResetMin: 10080, cxWin: 10080, cxAgeSec: 99999,
    sessions: Array.from({ length: n }, (_, i) => session(i < nWide)),
    sessionsTotal: 99, hiddenAsking: 9, hostSecondsSinceMidnight: 86399,
    hostId: "x".repeat(8), hostTag: S(caps.tagChars, nWide > 0), hostEmoji: "anchor", remoteAnswer: true,
    voice: { seq: 9999, at: 1e12, state: "done",
             text: S(caps.voiceTextChars, nWide > 0), reply: S(caps.voiceReplyChars, nWide > 0) },
  }) + "\n";
  return Buffer.byteLength(line, "utf8");
}

// ---------------------------------------------------------------------------
// The hook's inline copy, extracted and run beside the module's. The hook cannot
// import from this repo (install.sh copies that one file into ~/.claude), so the
// duplication is forced - and an unchecked duplicate is how one of them silently
// stops matching the other.
// ---------------------------------------------------------------------------
function hookToAscii(hookSrc) {
  const start = hookSrc.indexOf("const MAP = new Map(");
  const end = hookSrc.indexOf("// The device font can");
  ok(start >= 0 && end > start, "COPIES: could not extract the hook's inline toAscii - the markers around it moved");
  if (start < 0 || end <= start) return null;
  try {
    return new Function(`${hookSrc.slice(start, end)}\nreturn toAscii;`)();
  } catch (e) {
    ok(false, `COPIES: the hook's inline toAscii would not evaluate: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// BEHAVIOUR: the REAL hook as a child process, throwaway $HOME, scratch
// DECKHAND_TMP. Never ~/.claude, never /tmp/deckhand-<uid> - a previous test in
// this repo ate the live host's runtime state.
// ---------------------------------------------------------------------------
function runBehaviour(hookPath, caps) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-wirebytes-"));
  const HOME = path.join(box, "home");
  const TMP = path.join(box, "runtime");
  fs.mkdirSync(path.join(HOME, ".claude", "deckhand-sessions"), { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  // connected, so an ask is published; remoteAnswer OFF so the hook never blocks
  // and emitDecision() - the one legitimate writer to stdout - is never reached.
  fs.writeFileSync(path.join(TMP, "host-alive"), JSON.stringify({ connected: true, remoteAnswer: false }));

  const fire = (payload) => {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME, DECKHAND_TMP: TMP },
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const f = path.join(HOME, ".claude", "deckhand-sessions", `${payload.session_id}.json`);
    return { stdout, rec: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null };
  };
  const ascii = (s) => !/[^\x00-\x7f]/.test(s);

  // 1. THE CASE THAT USED TO BLOW THE GUARD ON ITS OWN: one question whose detail
  //    is CJK at the character cap. Before the fix that single session's tick line
  //    measured 17,893 bytes against a 16,000 guard.
  {
    const { stdout, rec } = fire({
      session_id: "w1", transcript_path: path.join(box, "w1.jsonl"), cwd: box,
      hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
      tool_input: { questions: [{
        header: "選択してください — pick",
        question: "—".repeat(2000) + " 中文",
        options: [
          { label: "はい — yes", description: "これを選ぶと… it proceeds" },
          { label: "Don’t", description: "stops — nothing runs" },
        ],
      }] },
    });
    ok(stdout === "", `BEHAVIOUR: stdout must be EMPTY on a non-decision path, got ${JSON.stringify(stdout)}`);
    const a = rec?.ask;
    ok(a != null, "BEHAVIOUR: the ask was published");
    for (const [name, v] of [["title", a?.title], ["detail", a?.detail],
                             ...(a?.options ?? []).map((o, i) => [`options[${i}]`, o]),
                             ...(a?.optDescs ?? []).map((o, i) => [`optDescs[${i}]`, o])]) {
      ok(typeof v === "string" && ascii(v), `BEHAVIOUR: ask.${name} reached the record as pure ASCII, got ${JSON.stringify(v)}`);
      ok(typeof v === "string" && Buffer.byteLength(v, "utf8") === v.length,
         `BEHAVIOUR: ask.${name} costs exactly its character count in bytes`);
    }
    ok(a?.detail?.length === caps.detailChars,
       `BEHAVIOUR: a 2000-character wide question caps at ${caps.detailChars}, got ${a?.detail?.length}`);
    ok(a?.detail === "-".repeat(caps.detailChars),
       "BEHAVIOUR: 2000 em-dashes became hyphens and were cut at the cap - the cap is exercised, not sidestepped");
    ok(Buffer.byteLength(a?.detail ?? "", "utf8") <= caps.detailChars,
       `BEHAVIOUR: and that cap is now a BYTE cap too - ${Buffer.byteLength(a?.detail ?? "", "utf8")} bytes`);
    ok(a?.title?.includes("-"), `BEHAVIOUR: the em-dash in the header became a hyphen, got ${JSON.stringify(a?.title)}`);
    ok(a?.options?.[1] === "Don't", `BEHAVIOUR: a curly apostrophe became a straight one, got ${JSON.stringify(a?.options?.[1])}`);
    ok(a?.optDescs?.[0]?.includes("..."), `BEHAVIOUR: an ellipsis became three ASCII dots, got ${JSON.stringify(a?.optDescs?.[0])}`);
    ok(a?.optDescs?.[0]?.startsWith("?"),
       `BEHAVIOUR: an unmappable RUN collapsed to a single '?', got ${JSON.stringify(a?.optDescs?.[0])}`);
  }
  // 2. A pure-ASCII prompt is untouched, byte for byte. This is what makes the fix
  //    invisible to every payload that was already fine.
  {
    const cmd = "rg -n 'foo|bar' --glob '!node_modules' -- .";
    const { stdout, rec } = fire({
      session_id: "w2", transcript_path: path.join(box, "w2.jsonl"), cwd: box,
      hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: cmd },
    });
    ok(stdout === "", "BEHAVIOUR: stdout empty (ASCII perm prompt)");
    ok(rec?.ask?.detail === cmd, `BEHAVIOUR: an ASCII command crosses unchanged, got ${JSON.stringify(rec?.ask?.detail)}`);
    ok(rec?.ask?.title === "Allow Bash?", "BEHAVIOUR: an ASCII title crosses unchanged");
  }
  // 3. Newlines survive: cleanMultiline keeps them as hard line breaks, and the
  //    transliteration must not be what flattens a code block.
  {
    const { stdout, rec } = fire({
      session_id: "w3", transcript_path: path.join(box, "w3.jsonl"), cwd: box,
      hook_event_name: "PreToolUse", tool_name: "ExitPlanMode",
      tool_input: { plan: "step one — do it\nstep two — 確認\nstep three" },
    });
    ok(stdout === "", "BEHAVIOUR: stdout empty (plan)");
    ok((rec?.ask?.detail ?? "").split("\n").length === 3,
       `BEHAVIOUR: newlines survive transliteration, got ${JSON.stringify(rec?.ask?.detail)}`);
    ok(ascii(rec?.ask?.detail ?? "x"), "BEHAVIOUR: the plan detail is pure ASCII");
  }
  // 4. The sandbox really was a sandbox.
  ok(TMP.startsWith(os.tmpdir()) && !TMP.includes(`deckhand-${process.getuid()}`),
     "BEHAVIOUR: DECKHAND_TMP was a scratch path, not the live runtime dir");
  fs.rmSync(box, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
async function main({ hookPath = HOOK_SRC, modPath = MOD_SRC, quiet = false } = {}) {
  const hookSrc = fs.readFileSync(hookPath, "utf8");
  const hostSrc = fs.readFileSync(HOST_SRC, "utf8");
  const fwSrc = fs.readFileSync(FW_SRC, "utf8");
  const c = readCaps(hookSrc, hostSrc, fwSrc);
  const { toAscii, deviceText } = await import(`${pathToFileURL(modPath).href}?v=${Date.now()}${Math.random()}`);

  // ---- STRUCTURE: no bypass -----------------------------------------------
  for (const [name, re] of HOOK_SITES) ok(re.test(hookSrc), `STRUCTURE (hook): ${name}`);
  for (const [name, re] of HOST_SITES) ok(re.test(hostSrc), `STRUCTURE (host): ${name}`);
  ok(c.maxSessionsHost === c.maxSessionsFw,
     `STRUCTURE: the host sends ${c.maxSessionsHost} sessions and the device holds ${c.maxSessionsFw} - the budget is meaningless if they disagree`);

  // ---- FIDELITY ------------------------------------------------------------
  for (const s of CORPUS) {
    const a = toAscii(s);
    ok(!/[^\x00-\x7f]/.test(a), `FIDELITY: toAscii(${JSON.stringify(s)}) left a non-ASCII byte: ${JSON.stringify(a)}`);
    ok(Buffer.byteLength(a, "utf8") === a.length,
       `UNITS: byteLength !== length for ${JSON.stringify(s)} -> ${JSON.stringify(a)}`);
    ok(toAscii(a) === a, `FIDELITY: not idempotent for ${JSON.stringify(s)}`);
    if (!/[^\x00-\x7f]/.test(s)) {
      ok(a === s, `FIDELITY: pure-ASCII input must come back UNCHANGED, ${JSON.stringify(s)} -> ${JSON.stringify(a)}`);
      ok(Buffer.compare(Buffer.from(s, "utf8"), Buffer.from(a, "utf8")) === 0,
         `FIDELITY: pure-ASCII input must be byte-identical, not merely equal-looking: ${JSON.stringify(s)}`);
    }
  }
  // The named transliterations, because "replaced with '?'" would satisfy every
  // assertion above while destroying ordinary English prose.
  const MAPPED = [
    ["—", "-", "em-dash"], ["–", "-", "en-dash"],
    ["“", '"', "left curly quote"], ["”", '"', "right curly quote"],
    ["‘", "'", "left curly apostrophe"], ["’", "'", "right curly apostrophe"],
    ["…", "...", "ellipsis"], ["→", "->", "right arrow"], ["⇒", "=>", "double arrow"],
    ["≤", "<=", "less-or-equal"], ["×", "x", "multiplication sign"],
    [" ", " ", "no-break space"], ["​", "", "zero-width space"],
    ["é", "e", "e-acute (NFD, mark dropped)"], ["ß", "ss", "sharp s"],
    ["•", "*", "bullet"],
  ];
  for (const [ch, want, name] of MAPPED)
    ok(toAscii(ch) === want, `FIDELITY: ${name} must transliterate to ${JSON.stringify(want)}, got ${JSON.stringify(toAscii(ch))}`);
  // A RUN collapses to ONE '?': per-character marking turns a CJK sentence into a
  // wall of question marks that is itself unreadable.
  ok(toAscii("中".repeat(50)) === "?", `FIDELITY: 50 unmappable chars must collapse to ONE '?', got ${JSON.stringify(toAscii("中".repeat(50)))}`);
  ok(toAscii("a中文b") === "a?b", `FIDELITY: a run between ASCII collapses to one '?', got ${JSON.stringify(toAscii("a中文b"))}`);
  ok(toAscii("中 a 文") === "? a ?", "FIDELITY: two runs separated by ASCII stay two '?'");
  // Unmappable text is MARKED, never dropped: a vanished sentence is worse than a
  // marked one, and before this fix it vanished on the glass.
  ok(toAscii("😀") === "?", "FIDELITY: an emoji is marked, not dropped");
  // It CAN emit a double quote (from a curly one), which is why it must run BEFORE
  // JSON.stringify and can never be applied to a serialised line.
  ok(toAscii("“x”").includes('"'), "FIDELITY: transliteration can emit '\"' - so it must run before JSON.stringify, never after");

  // ---- deviceText: transliterate THEN cap ---------------------------------
  ok(deviceText("…".repeat(10), 10).length === 10, "UNITS: deviceText caps AFTER expansion, so an ellipsis run cannot grow past its cap");
  ok(Buffer.byteLength(deviceText("—".repeat(100), 10), "utf8") === 10, "UNITS: deviceText's cap is exact in bytes");
  ok(deviceText("abc") === "abc", "UNITS: deviceText with no cap just transliterates");

  // ---- COPIES: the hook's inline toAscii === the module's ------------------
  const hookFn = hookToAscii(hookSrc);
  if (hookFn) {
    let drift = 0;
    for (const s of CORPUS) if (hookFn(s) !== toAscii(s)) {
      if (drift++ === 0) ok(false, `COPIES: the hook's inline toAscii disagrees with host/to-ascii.mjs on ${JSON.stringify(s)}: ` +
                                   `${JSON.stringify(hookFn(s))} vs ${JSON.stringify(toAscii(s))}`);
    }
    ok(drift === 0 || false, drift ? `COPIES: ${drift} of ${CORPUS.length} corpus entries disagree between the two copies` : "");
    if (drift === 0) pass++; // the "no drift" claim itself
  }

  // ---- BUDGET --------------------------------------------------------------
  const B = (o) => tickBytes(c, toAscii, o);
  const before = {
    asciiNoDesc: B({ xlate: false }),
    wideNoDesc: B({ fill: "wide", xlate: false }),
    wideDesc: B({ fill: "wide", descCap: c.descMaxBytes, xlate: false }),
    wideDescVoice: B({ fill: "wide", descCap: c.descMaxBytes, parkedVoice: true, xlate: false }),
    oneWideAsk: B({ wideSessions: 1, xlate: false }),
  };
  const after = {
    asciiNoDesc: B({}),
    wideNoDesc: B({ fill: "wide" }),
    wideDesc: B({ fill: "wide", descCap: c.descMaxBytes }),
    wideDescVoice: B({ fill: "wide", descCap: c.descMaxBytes, parkedVoice: true }),
    oneWideAsk: B({ wideSessions: 1 }),
  };

  // THE RECONCILIATION, which is what the fix actually buys: with every
  // device-bound field ASCII, the WIDE ceiling and the ASCII floor are the SAME
  // LINE. There is no longer a 3x multiplier hiding between the two units.
  ok(after.wideNoDesc === after.asciiNoDesc,
     `BUDGET: after transliteration the WIDE case must measure exactly the ASCII case (${after.wideNoDesc} vs ${after.asciiNoDesc}) - ` +
     `that identity IS the char/byte reconciliation`);
  ok(before.wideNoDesc > c.lineGuard,
     `BUDGET: the historical defect must stay recorded - the pre-fix WIDE case was over the ${c.lineGuard}-byte guard (${before.wideNoDesc})`);
  ok(after.wideNoDesc <= c.lineGuard,
     `BUDGET: the saturated ${c.maxSessionsHost}-session WIDE case must now FIT the ${c.lineGuard}-byte guard, got ${after.wideNoDesc}`);
  // The case the bug was actually reported for: ONE session, one wide question at
  // the detail cap, which blew the guard on its own.
  ok(before.oneWideAsk > c.lineGuard,
     `BUDGET: an otherwise ordinary line carrying ONE wide question used to exceed the guard on its own ` +
     `(${before.oneWideAsk} vs ${c.lineGuard}) - that is the realistic case, not the saturated one`);
  ok(after.oneWideAsk <= c.lineGuard,
     `BUDGET: that same line must now fit, got ${after.oneWideAsk}`);
  // The ASCII floor is unchanged by the fix - no existing payload moved by a byte.
  ok(after.asciiNoDesc === before.asciiNoDesc,
     `BUDGET: an all-ASCII payload must measure the same before and after (${before.asciiNoDesc} vs ${after.asciiNoDesc})`);

  // TRIPWIRE, deliberately asserting that something is STILL WRONG. With optDescs
  // at its cap on all four options of all six sessions, the saturated line is over
  // the guard even in pure ASCII - so that residue is a CAP decision, not a unit
  // one, and no amount of transliteration reaches it. It is far outside realistic
  // traffic (one asking session at the cap is a fraction of the guard), and fixing
  // it means shortening a cap, which changes what the device is shown. If this
  // ever stops holding, the note above has to be re-derived rather than deleted.
  ok(after.wideDescVoice > c.lineGuard,
     `BUDGET: the saturated case WITH optDescs and a parked transcript is expected to remain over the guard ` +
     `(${after.wideDescVoice} vs ${c.lineGuard}) - it is now a pure-ASCII overrun, i.e. a cap question. ` +
     `If it now fits, this tripwire and its reasoning must be re-derived`);

  runBehaviour(hookPath, c);

  if (!quiet) {
    console.log(`\ncaps parsed: title ${c.titleChars}ch, detail ${c.detailChars}ch, label ${c.labelChars}ch, ` +
                `desc ${c.descMaxBytes}B, name ${c.nameChars}, path ${c.pathChars}, model ${c.modelChars}, ` +
                `branch ${c.branchChars}, sTitle ${c.sTitleChars}, prompt ${c.promptChars}, ` +
                `voice ${c.voiceTextChars}/${c.voiceReplyChars}, ${c.maxSessionsHost} sessions, guard ${c.lineGuard}B`);
    console.log(`\ndevice-bound fields whose CHARACTER cap is now also a BYTE cap: ` +
                CAPPED_FIELDS.map(([n, k]) => `${n}=${c[k]}`).join(", "));
    const row = (l, b, a) => console.log(
      `  ${l.padEnd(46)} ${String(b).padStart(6)} ${b > c.lineGuard ? "OVER" : "ok  "}  -> ` +
      `${String(a).padStart(6)} ${a > c.lineGuard ? "OVER" : "ok  "}`);
    console.log(`\nsaturated tick line in BYTES (guard ${c.lineGuard}):        BEFORE        AFTER`);
    row(`${c.maxSessionsHost} sessions, ASCII, no optDescs`, before.asciiNoDesc, after.asciiNoDesc);
    row(`${c.maxSessionsHost} sessions, WIDE, no optDescs`, before.wideNoDesc, after.wideNoDesc);
    row(`${c.maxSessionsHost} sessions, WIDE + optDescs`, before.wideDesc, after.wideDesc);
    row(`${c.maxSessionsHost} sessions, WIDE + optDescs + voice`, before.wideDescVoice, after.wideDescVoice);
    row(`${c.maxSessionsHost} sessions, ONE wide ask (the reported case)`, before.oneWideAsk, after.oneWideAsk);
    console.log(`\n  WIDE fill is the em-dash: 3 bytes in, 1 out, so it preserves LENGTH through the`);
    console.log(`  transliteration. CJK would collapse to one '?' and flatter the result.`);
    console.log(`  After the fix WIDE === ASCII (${after.wideNoDesc} === ${after.asciiNoDesc}): the two units are one unit.`);
  }
  return { caps: c, before, after };
}

// ---------------------------------------------------------------------------
// --selftest: the same teeth-proving convention as palette-check.mjs. Each fault
// goes into a COPY in a temp dir, never the repo file, and the run must FAIL.
// TWELVE vacuous assertions have been caught in this project; assume this is the
// thirteenth until every fault below has been watched to fail BY NAME.
// ---------------------------------------------------------------------------
async function selftest() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-wirebytes-selftest-"));
  const hookOrig = fs.readFileSync(HOOK_SRC, "utf8");
  const modOrig = fs.readFileSync(MOD_SRC, "utf8");
  const faults = [
    ["clean() no longer transliterates (the ask title and option labels go back to characters)",
     { hook: (s) => s.replace(/function clean\(s, max\) \{([\s\S]*?)return toAscii\(s\)/, 'function clean(s, max) {$1return String(s ?? "")') }],
    ["cleanMultiline() no longer transliterates (the 1400-char detail goes back to characters)",
     { hook: (s) => s.replace(/function cleanMultiline\(s, max\) \{([\s\S]*?)return toAscii\(s\)/, 'function cleanMultiline(s, max) {$1return String(s ?? "")') }],
    ["the module marks every unmappable char instead of collapsing the run",
     { mod: (s) => s.replace("    pending = true;", '    out += "?";') }],
    ["the module blanks everything instead of transliterating (prose becomes question marks)",
     { mod: (s) => s.replace("const mapped = MAP.get(ch);", "const mapped = undefined;") }],
    ["the module alters pure-ASCII input",
     { mod: (s) => s.replace("if (!NON_ASCII.test(str)) return str;", 'if (!NON_ASCII.test(str)) return str.replace(/-/g, "_");') }],
    ["the module is no longer idempotent (an ASCII-only violation, so only the idempotence claim can see it)",
     { mod: (s) => s.replace("  if (pending) out += \"?\";\n  return out;", "  if (pending) out += \"?\";\n  return out + \"!\";") }],
    ["the ask DETAIL cap raised past what the guard can hold - the budget half, which no fidelity assertion can see",
     { hook: (s) => s.replace('cleanMultiline(q.question ?? "", 1400)', 'cleanMultiline(q.question ?? "", 1800)') }],
    ["the module leaves a non-ASCII byte through",
     { mod: (s) => s.replace("    pending = true;", "    out += ch;") }],
    ["the hook's inline copy drifts from the module",
     { hook: (s) => s.replace('"—": "-",', '"—": "~",') }],
    ["deviceText caps BEFORE transliterating, so expansion re-exceeds the cap",
     { mod: (s) => s.replace("  const a = toAscii(s);\n  return max == null ? a : a.slice(0, max);",
                             "  return max == null ? toAscii(s) : toAscii(String(s ?? '').slice(0, max));") }],
    ["a host cap site bypasses the transliteration",
     { host: true, hook: (s) => s }],  // handled specially below
    ["a line written to stdout, which on a PermissionRequest can auto-answer a real dialog",
     { hook: (s) => s.replace(/^function buildAsk\(data\) \{$/m, 'function buildAsk(data) {\n  console.log("");') }],
  ];
  let caught = 0, injected = 0;
  for (const [name, f] of faults) {
    if (f.host) {
      // The host file is read by path from the repo, so this fault is proved by
      // temporarily checking a MUTATED COPY of the source text through the same
      // regexes rather than by rewriting index.mjs.
      const mutated = fs.readFileSync(HOST_SRC, "utf8").replace(/name: deviceText\(await projectName\(record\.cwd \|\| ""\), (\d+)\)/,
        'name: (await projectName(record.cwd || "")).slice(0, $1)');
      const bypassed = !HOST_SITES.find(([n]) => n === "session.name")[1].test(mutated);
      console.log(`  ${bypassed ? "caught  " : "MISSED  "} ${name}`);
      injected++; if (bypassed) caught++;
      continue;
    }
    const hookPath = path.join(box, `hook-${injected}.mjs`);
    const modPath = path.join(box, `mod-${injected}.mjs`);
    const hookSrc = f.hook ? f.hook(hookOrig) : hookOrig;
    let modSrc = f.mod ? f.mod(modOrig) : modOrig;
    if ((f.hook && hookSrc === hookOrig) || (f.mod && modSrc === modOrig)) {
      console.log(`  NOT INJECTED (pattern no longer matches): ${name}`);
      injected++;
      continue;
    }
    // The hook carries its own copy of the map, so a MODULE fault must be mirrored
    // into it or the "copies agree" assertion catches the fault for the wrong
    // reason and every other assertion passes.
    let hookOut = hookSrc;
    if (f.mod) {
      const mStart = modOrig.indexOf("// Characters that DO have"), mEnd = modOrig.indexOf("// Transliterate THEN cap");
      const before = modOrig.slice(mStart, mEnd).replace("export function toAscii", "function toAscii").trimEnd();
      const afterM = modSrc.slice(modSrc.indexOf("// Characters that DO have"), modSrc.indexOf("// Transliterate THEN cap"))
        .replace("export function toAscii", "function toAscii").trimEnd();
      if (hookOut.includes(before)) hookOut = hookOut.replace(before, afterM);
    }
    fs.writeFileSync(hookPath, hookOut);
    fs.writeFileSync(modPath, modSrc);
    const mark = failures.length;
    pass = 0;
    try { await main({ hookPath, modPath, quiet: true }); } catch { /* a crash is also a catch */ }
    const found = failures.length > mark;
    // Print WHICH assertion caught it. "caught" alone cannot tell a fault caught
    // by the assertion that exists for it from one caught by an unrelated crash,
    // and that difference is the whole point of a teeth-proving run.
    console.log(`  ${found ? "caught  " : "MISSED  "} ${name}`);
    if (found) console.log(`             by: ${failures[mark].slice(0, 110)}`);
    injected++; if (found) caught++;
    failures.length = mark;
  }
  fs.rmSync(box, { recursive: true, force: true });
  console.log(`\nselftest: ${caught}/${injected} injected faults caught`);
  process.exit(caught === injected && injected === faults.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  await main({});
  console.log(`\n${pass} assertions passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length ? 1 : 0);
}
