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
//   INVARIANT  byteLength === length for EVERY string in the payload, asserted
//              structurally at the point of send - no field-name list
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
const FIT_SRC = path.join(REPO, "host", "wire-fit.mjs");
const ASCII_SRC = path.join(REPO, "host", "wire-ascii.mjs");
const VOICE_SRC = path.join(REPO, "host", "voice-answer.mjs");
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

function readCaps(hookSrc, hostSrc, fwSrc, voiceSrc) {
  const _voice = voiceSrc;
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
  // THE CONFIRM SCREEN'S TEXT, and the two halves of getting its fix in the right
  // place. It must be transliterated at the PARK SITE, before voiceSha() runs, and
  // it must NOT be transliterated in the payload builder - doing it there would
  // desync the text the device displays and signs against from the text this host
  // still holds and re-hashes, so every valid answer would be REJECTED.
  c.voiceParkXlate = /text = capUtf8\(toAscii\(text\), VOICE_ANSWER_TEXT_MAX_BYTES\);/.test(hostSrc);
  c.voiceParkBeforeHash =
    hostSrc.indexOf("text = capUtf8(toAscii(text), VOICE_ANSWER_TEXT_MAX_BYTES);") >= 0 &&
    hostSrc.indexOf("text = capUtf8(toAscii(text), VOICE_ANSWER_TEXT_MAX_BYTES);") <
      hostSrc.indexOf("pendingVoiceAnswers.set(pid, { text, sha: voiceSha(text)");
  c.voiceBuilderRaw = /item\.ask\.voiceText = pend\.text;/.test(hostSrc);
  // firmware: the guard the whole budget is measured against
  c.maxSessionsFw = grab(fwSrc, "MAX_SESSIONS (firmware)", /#define MAX_SESSIONS (\d+)/);
  c.lineGuard = grab(fwSrc, "feedChar's line guard (firmware)", /if \(buf\.length\(\) > (\d+)\) buf = "";/);
  // The cap itself lives in host/voice-answer.mjs as ANSWER_TEXT_MAX_BYTES and is
  // re-exported into index.mjs under the VOICE_ prefix; parse the DEFINITION.
  c.voiceAnswerMaxBytes = grab(_voice, "ANSWER_TEXT_MAX_BYTES (host/voice-answer.mjs)",
                               /export const ANSWER_TEXT_MAX_BYTES = (\d+);/);
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
  ["ask.voiceText, at the PARK SITE (Whisper output is the densest non-ASCII source there is)",
   /text = capUtf8\(toAscii\(text\), VOICE_ANSWER_TEXT_MAX_BYTES\);/],
  ["the char/byte invariant is asserted at the point of send", /const wire = asciiFit\(\{/],
  ["and the transliteration runs BEFORE the size fit, or the line measured is not the line written",
   /const wire = asciiFit\(\{[\s\S]{0,1200}?const fitted = fitPayload\(wire\.payload\);/],
  ["the tick line is measured against the device's guard before it is written",
   /const fitted = fitPayload\(wire\.payload\);/],
  ["and what it sheds is LOGGED", /Wire: payload was \$\{fitted\.was\} bytes/],
  ["an invariant violation is LOGGED, and the log line NAMES THE FIELD - `something was wrong` is a message nobody can act on",
   /Wire: NON-ASCII device-bound text[\s\S]{0,300}?\$\{describeOffenders\(wire\.offenders\)\}/],
  ["and it is logged on the EDGE, not per tick - a permanently-broken field would otherwise write a line every 5s and bury the tick lines between them",
   /if \(sig !== lastWireAsciiSig\) \{/],
  ["with an all-clear line, so a fixed field is visible as fixed", /Wire: device-bound text is ASCII again\./],
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

// A DETERMINISTIC FUZZ CORPUS, because a fixed 15-entry list can only prove the
// two copies agree on those 15 entries - a divergence anywhere else slips through,
// and the whole reason the hook's copy exists is that nothing can import it.
// Seeded, so a failure is reproducible rather than a one-in-N ghost. The pools are
// chosen to hit what breaks string handling: the surrogate range on BOTH sides,
// LONE surrogates (which `for..of` yields as-is and normalize() must survive),
// astral code points, combining marks, and the mapped characters themselves.
function fuzzCorpus(n = 5000) {
  let seed = 0x2f76b8;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const mapped = ["—", "–", "…", "“", "”", "‘", "’", "→", "≤", "×", "•", " ", "\u200b", "ß", "æ", "©"];
  const pools = [
    () => String.fromCodePoint(0x20 + Math.floor(rnd() * 95)),                    // ASCII
    () => String.fromCodePoint(0xa0 + Math.floor(rnd() * (0xd800 - 0xa0))),       // BMP under surrogates
    () => String.fromCodePoint(0xe000 + Math.floor(rnd() * (0x10000 - 0xe000))),  // BMP over surrogates
    () => String.fromCodePoint(0x10000 + Math.floor(rnd() * 0x100000)),           // astral
    () => String.fromCharCode(0xd800 + Math.floor(rnd() * 0x400)),                // LONE high surrogate
    () => String.fromCharCode(0xdc00 + Math.floor(rnd() * 0x400)),                // LONE low surrogate
    () => pick(["\u0301", "\u0308", "\u0327"]),                                  // combining marks
    () => pick(mapped),
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = 1 + Math.floor(rnd() * 14);
    for (let j = 0; j < len; j++) s += pick(pools)();
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The saturated tick line, in BYTES, built to the shape host/index.mjs serialises.
// `fill` is what the char-capped fields are made of; `xlate` says whether the
// transliteration runs, which is the difference between BEFORE and AFTER.
// ---------------------------------------------------------------------------
function tickBytes(caps, toAscii, capUtf8, { descCap = null, parkedVoice = false, sessions = null, fill = "ascii", wideSessions = null, xlate = true } = {}) {
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
  // The confirm-screen transcript, built the way handleVoiceAnswer builds it:
  // (optionally) transliterated, then capped in BYTES by capUtf8.
  const parkedVoiceText = capUtf8(
    caps.voiceParkXlate ? toAscii("—".repeat(caps.voiceAnswerMaxBytes)) : "—".repeat(caps.voiceAnswerMaxBytes),
    caps.voiceAnswerMaxBytes,
  );
  const ask = (S) => ({
    pid: "x".repeat(8), kind: "question",
    title: S(caps.titleChars), detail: S(caps.detailChars),
    options: Array.from({ length: caps.maxOptions }, () => S(caps.labelChars)),
    ...(descCap != null ? { optDescs: Array.from({ length: caps.maxOptions }, () => "x".repeat(descCap)) } : {}),
    nonce: "x".repeat(32), voice: true,
    // NOT S(): this field does not take the caps above. It is parked by
    // handleVoiceAnswer under a BYTE cap, so the model has to follow the real
    // path - whether the park site transliterates is PARSED, not assumed. Model
    // it as fixed and a reverted fix is invisible here, which is exactly how this
    // bypass survived the first round.
    ...(parkedVoice ? { voiceText: parkedVoiceText, voiceSha: "x".repeat(16) } : {}),
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
async function main({ hookPath = HOOK_SRC, modPath = MOD_SRC, fitPath = FIT_SRC, hostPath = HOST_SRC, asciiPath = ASCII_SRC, quiet = false } = {}) {
  const hookSrc = fs.readFileSync(hookPath, "utf8");
  const hostSrc = fs.readFileSync(hostPath, "utf8");
  const fwSrc = fs.readFileSync(FW_SRC, "utf8");
  const c = readCaps(hookSrc, hostSrc, fwSrc, fs.readFileSync(VOICE_SRC, "utf8"));
  const bust = `?v=${Date.now()}${Math.random()}`;
  const { toAscii, deviceText } = await import(`${pathToFileURL(modPath).href}${bust}`);
  const { capUtf8 } = await import(`${pathToFileURL(VOICE_SRC).href}${bust}`);
  const { fitPayload, DEVICE_LINE_GUARD_BYTES } = await import(`${pathToFileURL(fitPath).href}${bust}`);
  const { asciiFit, describeOffenders } = await import(`${pathToFileURL(asciiPath).href}${bust}`);

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
  // THE FUZZ SWEEP, counted as one assertion per PROPERTY rather than per string:
  // 5000 passing calls would drown every other number, and the claim really is
  // singular. It names the first offender, because "somewhere in 5000" is not a
  // bug report. Pools deliberately include lone surrogates on both sides, which
  // `for..of` yields as-is and normalize() has to survive.
  {
    const fuzz = fuzzCorpus();
    let badAscii = null, badUnit = null, badIdem = null, badNoop = null;
    for (const str of fuzz) {
      const a = toAscii(str);
      if (badAscii === null && /[^\x00-\x7f]/.test(a)) badAscii = str;
      if (badUnit === null && Buffer.byteLength(a, "utf8") !== a.length) badUnit = str;
      if (badIdem === null && toAscii(a) !== a) badIdem = str;
      if (badNoop === null && !/[^\x00-\x7f]/.test(str) && a !== str) badNoop = str;
    }
    ok(badAscii === null, `FIDELITY (fuzz, ${fuzz.length} strings): non-ASCII survived for ${JSON.stringify(badAscii)}`);
    ok(badUnit === null, `UNITS (fuzz, ${fuzz.length} strings): byteLength !== length for ${JSON.stringify(badUnit)}`);
    ok(badIdem === null, `FIDELITY (fuzz, ${fuzz.length} strings): not idempotent for ${JSON.stringify(badIdem)}`);
    ok(badNoop === null, `FIDELITY (fuzz, ${fuzz.length} strings): pure-ASCII input was altered: ${JSON.stringify(badNoop)}`);
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
  // A FIXED CORPUS CAN ONLY PROVE AGREEMENT ON ITS OWN ENTRIES, so this runs the
  // hand-written one AND the fuzz sweep. The duplication is forced (the hook can
  // import nothing from this repo), which makes this the only thing standing
  // between the two copies and a silent divergence.
  const hookFn = hookToAscii(hookSrc);
  if (hookFn) {
    // EXHAUSTIVE where it is cheap. The fuzz sweep is random, so a divergence on a
    // single rare character - say one entry of the map typo'd - is a coin flip it
    // may not see: measured, a mutated "\u00d8" was MISSED by 5000 fuzz strings
    // alone. So the drift corpus also carries every key of the map (PARSED out of
    // the module, never transcribed), every BMP code point, and a stride through
    // the astral planes. ~70k comparisons, well under a second.
    const mapKeys = [...fs.readFileSync(modPath, "utf8")
      .matchAll(/"((?:\\u[0-9a-fA-F]{4}|[^"\\])+)":\s*"[^"]*"/g)].map((m) => m[1]);
    ok(mapKeys.length > 60,
       `COPIES: parsed only ${mapKeys.length} map keys out of the module - the regex has stopped matching, so the exhaustive half is unproven`);
    const bmp = [];
    for (let cp = 0; cp <= 0xffff; cp++) bmp.push(String.fromCodePoint(cp));
    const astral = [];
    for (let cp = 0x10000; cp <= 0x10ffff; cp += 977) astral.push(String.fromCodePoint(cp));
    const all = [...CORPUS, ...fuzzCorpus(), ...mapKeys, ...bmp, ...astral];
    let drift = 0, first = null;
    for (const s of all) if (hookFn(s) !== toAscii(s)) { if (drift++ === 0) first = s; }
    ok(drift === 0,
       `COPIES: the hook's inline toAscii disagrees with host/to-ascii.mjs on ${drift} of ${all.length} strings, ` +
       `first ${JSON.stringify(first)}: ${JSON.stringify(first == null ? "" : hookFn(first))} vs ` +
       `${JSON.stringify(first == null ? "" : toAscii(first))}`);
  }

  // ---- BUDGET --------------------------------------------------------------
  const B = (o) => tickBytes(c, toAscii, capUtf8, o);
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

  // TRIPWIRE, deliberately asserting that something is STILL over the guard. With
  // optDescs at its cap on all four options of all six sessions the saturated line
  // exceeds it even in pure ASCII - a CAP question, not a unit one, which no
  // amount of transliteration reaches (it is linear in the detail cap: 1400 gives
  // 17861, 1089 breaks even).
  //
  // THE DEVICE IS NO LONGER AT RISK FROM IT: host/wire-fit.mjs measures every line
  // before it is written and sheds until it fits, so this residue now costs a
  // dropped detail and a log line rather than a silent persistent freeze. What
  // this assertion still buys is a future developer knowing the ceiling is real
  // before they add a field to it. If it ever stops holding, re-derive the note
  // rather than deleting it.
  ok(after.wideDescVoice > c.lineGuard,
     `BUDGET: the saturated case WITH optDescs and a parked transcript is expected to remain over the guard ` +
     `(${after.wideDescVoice} vs ${c.lineGuard}) - it is now a pure-ASCII overrun, i.e. a cap question. ` +
     `If it now fits, this tripwire and its reasoning must be re-derived`);

  // ---- VOICETEXT: the confirm screen, and the order its fix has to be in ---
  // This field BYPASSED the transliteration in the first round, and the budget
  // could not see it: capUtf8 caps in BYTES, so 150 bytes is 150 bytes either way.
  // What changed is what the device DRAWS - "Yes - let's go ahead..." arrived as
  // "Yes  lets go ahead", holes exactly where the punctuation was, on the one
  // screen whose entire purpose is proving a human read THESE EXACT WORDS before
  // signing them.
  ok(c.voiceParkXlate,
     "VOICETEXT: the parked transcript must be transliterated at the PARK SITE (handleVoiceAnswer), " +
     "or the confirm screen renders gaps where Whisper's punctuation was");
  ok(c.voiceParkBeforeHash,
     "VOICETEXT: it must happen BEFORE voiceSha() - hashing first would sign text the device never shows");
  ok(c.voiceBuilderRaw,
     "VOICETEXT: the payload builder must assign `item.ask.voiceText = pend.text` UNCHANGED. " +
     "Transliterating there desyncs the signed text from the text this host re-hashes, and every valid answer is then REJECTED");
  {
    const parked = capUtf8(toAscii("Yes — let's go ahead… but don't touch the cache"), c.voiceAnswerMaxBytes);
    ok(!/[^\x00-\x7f]/.test(parked), `VOICETEXT: a real transcript reaches the wire as pure ASCII, got ${JSON.stringify(parked)}`);
    ok(Buffer.byteLength(parked, "utf8") === parked.length,
       "VOICETEXT: and its character count IS its byte count, so the char[204] on the device cannot be overrun");
    ok(parked === "Yes - let's go ahead... but don't touch the cache",
       `VOICETEXT: the punctuation is TRANSLITERATED, not dropped - got ${JSON.stringify(parked)}`);
    // The same string modelled through the wire, which is what the budget uses.
    const wide = capUtf8(c.voiceParkXlate ? toAscii("—".repeat(c.voiceAnswerMaxBytes)) : "—".repeat(c.voiceAnswerMaxBytes),
                         c.voiceAnswerMaxBytes);
    ok(Buffer.byteLength(wide, "utf8") === wide.length,
       `UNITS: ask.voiceText's characters must equal its bytes on the real path (${wide.length} chars, ` +
       `${Buffer.byteLength(wide, "utf8")} bytes) - a byte cap alone leaves the device drawing gaps`);
    ok(wide.length === c.voiceAnswerMaxBytes,
       `UNITS: and the byte cap now yields its full ${c.voiceAnswerMaxBytes} characters, not a third of them`);
  }

  // ---- REFUSAL: the host will not write a line the device cannot receive ---
  // A checker assertion protects a future developer; this protects the DEVICE,
  // including against the stale hook still installed in ~/.claude.
  {
    const fitSrc = fs.readFileSync(fitPath, "utf8");
    ok((fitSrc.match(/for \(let k = 0; k <= sessions\(\)\.length; k\+\+\) \{/g) ?? []).length === 2,
       "REFUSAL: both shedding tiers must be BOUNDED by the session count - this runs inside the 5s tick, " +
       "and a spin here would be worse than the freeze it prevents");
  }
  ok(DEVICE_LINE_GUARD_BYTES === c.lineGuard,
     `REFUSAL: wire-fit.mjs's DEVICE_LINE_GUARD_BYTES (${DEVICE_LINE_GUARD_BYTES}) must equal feedChar's own guard ` +
     `parsed from the firmware (${c.lineGuard})`);
  {
    const mk = (n, opts = {}) => ({
      hostId: "x".repeat(8), hiddenAsking: 0,
      sessions: Array.from({ length: n }, (_, i) => ({
        id: `s${i}`, status: opts.status ?? "asking",
        name: "N".repeat(opts.name ?? 10),
        ...(opts.noAsk ? {} : { ask: {
          pid: `p${i}`, detail: "D".repeat(opts.detail ?? 10),
          ...(opts.descs ? { optDescs: ["z".repeat(opts.descs)] } : {}),
        } }),
      })),
    });
    const small = fitPayload(mk(6, { detail: 1400 }));
    ok(small.dropped.length === 0, "REFUSAL: an ordinary payload is untouched and nothing is logged");
    ok(small.line.endsWith("\n"), "REFUSAL: the line it returns still ends in the newline the device splits on");
    ok(small.bytes === small.was, "REFUSAL: and its size is unchanged");
    ok(JSON.stringify(JSON.parse(small.line)) === JSON.stringify(JSON.parse(JSON.stringify(mk(6, { detail: 1400 })))),
       "REFUSAL: an under-guard payload comes back byte-for-byte identical - the common path must not rewrite anything");
    // Tier 1: the detail is the field that can be 1400 characters.
    const t1 = fitPayload(mk(6, { detail: 4000 }));
    ok(t1.bytes <= c.lineGuard, `REFUSAL (tier 1): oversized details are shed until the line fits, got ${t1.bytes}`);
    ok(t1.dropped.length > 0 && t1.dropped.every((d) => d.startsWith("ask.detail")),
       `REFUSAL (tier 1): and it says exactly what it dropped, got ${JSON.stringify(t1.dropped)}`);
    ok(JSON.parse(t1.line).sessions.every((s) => s.ask.pid),
       "REFUSAL (tier 1): the prompts SURVIVE - only the body they could not fit is gone, so they stay answerable");
    ok(!/[^\x00-\x7f]/.test(t1.line), "REFUSAL: the replacement marker is ASCII, like everything else on this wire");
    // Tier 2: descriptions explain options; the options remain.
    const t2 = fitPayload(mk(6, { detail: 1, descs: 4000 }));
    ok(t2.bytes <= c.lineGuard, `REFUSAL (tier 2): optDescs are shed next, got ${t2.bytes}`);
    ok(t2.dropped.some((d) => d.startsWith("ask.optDescs")), `REFUSAL (tier 2): named in the log, got ${JSON.stringify(t2.dropped)}`);
    // Tier 3 is what makes it TOTAL: nothing droppable but whole sessions.
    const t3 = fitPayload(mk(6, { name: 5000, noAsk: true }));
    ok(t3.bytes <= c.lineGuard, `REFUSAL (tier 3): sessions come off the TAIL until it fits, got ${t3.bytes}`);
    ok(JSON.parse(t3.line).sessions.length < 6, "REFUSAL (tier 3): and the list really did shrink");
    ok(JSON.parse(t3.line).hiddenAsking === 6 - JSON.parse(t3.line).sessions.length,
       "REFUSAL (tier 3): an `asking` row shed this way is counted into hiddenAsking - the field that exists to say what was cut");
    // TOTALITY. One absurd session must still produce a sendable line, or the
    // refusal is merely likely rather than guaranteed.
    const huge = fitPayload({ hiddenAsking: 0, sessions: [{ id: "x", status: "asking", name: "N".repeat(200_000) }] });
    ok(huge.bytes <= c.lineGuard, `REFUSAL: TOTAL - even a 200KB single session yields a sendable line, got ${huge.bytes}`);
    // A detail SHORTER than the replacement marker is never touched: replacing it
    // grows the line, which is the opposite of the job, and logs "dropped 1 bytes"
    // - a line that reads as nonsense. Asserted directly, because the monotonic
    // sweep below cannot see it once a later tier sheds enough to mask the growth.
    {
      const r = fitPayload({ hiddenAsking: 0, sessions: [
        { id: "a", status: "asking", ask: { detail: "d" } },
        { id: "b", status: "asking", name: "N".repeat(20_000) }] });
      ok(!r.dropped.some((d) => d.startsWith("ask.detail")),
         `REFUSAL: a 1-byte detail must never be "dropped" for a 47-byte marker, got ${JSON.stringify(r.dropped)}`);
    }
    // MONOTONIC. Replacing a short detail with the marker would GROW the line,
    // which is the opposite of the job - and would log "dropped 1 bytes".
    for (const d of [0, 1, 10, 46, 47, 48, 100, 1400, 4000]) {
      const r = fitPayload({ hiddenAsking: 0, sessions: [
        { id: "a", status: "asking", ask: { detail: "D".repeat(d) } },
        { id: "b", status: "asking", name: "N".repeat(20_000) }] });
      ok(r.bytes <= r.was, `REFUSAL: fitting must never GROW the line (detail=${d}: ${r.was} -> ${r.bytes})`);
      ok(r.bytes <= c.lineGuard, `REFUSAL: and must always end under the guard (detail=${d}: ${r.bytes})`);
    }
    // The guard is `> 16000`, so exactly 16000 is FINE and must not be touched.
    const pad = (n) => ({ hiddenAsking: 0, sessions: [{ id: "a", status: "asking", ask: { detail: "D".repeat(n) } }] });
    let n = 0;
    while (Buffer.byteLength(JSON.stringify(pad(n)), "utf8") < c.lineGuard) n++;
    const exact = fitPayload(pad(n - (Buffer.byteLength(JSON.stringify(pad(n)), "utf8") - c.lineGuard)));
    ok(exact.dropped.length === 0 && exact.bytes === c.lineGuard,
       `REFUSAL: a line of EXACTLY ${c.lineGuard} bytes is fine - feedChar clears at > guard, not at >= - got ${exact.bytes}, ${exact.dropped.length} drops`);
    // ...and ONE byte over is not. The two together pin the boundary from both
    // sides; either alone is satisfied by an off-by-one in the other direction.
    const over = fitPayload(pad(n - (Buffer.byteLength(JSON.stringify(pad(n)), "utf8") - c.lineGuard) + 1));
    ok(over.was === c.lineGuard + 1 && over.dropped.length > 0 && over.bytes <= c.lineGuard,
       `REFUSAL: ${c.lineGuard + 1} bytes must be shed - was ${over.was}, sent ${over.bytes}, ${over.dropped.length} drops`);
  }


  // ---- INVARIANT: byteLength === length, asserted STRUCTURALLY at the send ----
  //
  // Everything above proves the units coincide for the fields it knows about.
  // This proves the host NOTICES when they stop coinciding for a field nobody
  // thought of - which is the actual failure that happened (ask.voiceText was
  // parked under a BYTE cap, so every size assertion here was satisfied while the
  // text was still full of Whisper's punctuation). A checker that enumerates field
  // names cannot catch the next one: THAT ENUMERATION IS THE BUG.
  {
    const strings = (node, at = "", out = []) => {
      if (typeof node === "string") out.push([at, node]);
      else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${at}[${i}]`, out));
      else if (node && typeof node === "object")
        for (const k of Object.keys(node)) strings(node[k], at ? `${at}.${k}` : k, out);
      return out;
    };
    const allAscii = (o) => strings(o).every(([, v]) => Buffer.byteLength(v, "utf8") === v.length);

    // The common path must cost nothing and rewrite nothing.
    const clean = { hostId: "abc", n: 7, ok: true, z: null,
                    sessions: [{ id: "s1", ask: { detail: "rg -n 'foo' -- .", options: ["Allow", "Deny"] } }] };
    const cr = asciiFit(clean);
    ok(cr.offenders.length === 0, `INVARIANT: an all-ASCII payload has no offenders, got ${JSON.stringify(cr.offenders)}`);
    ok(cr.payload === clean,
       "INVARIANT: and it comes back as the SAME OBJECT - the clean tick must not pay for a copy, and must not be rewritten");

    // THE REGRESSION TEST OF THE REAL BUG. `ask.voiceText` reached the wire
    // untransliterated because it takes a BYTE cap rather than deviceText(), and
    // nothing downstream looked at it. Here it is again, plus a field whose name
    // appears NOWHERE in this repo - if the guard were a list of names, the second
    // one could not possibly be caught, and that is the whole claim being tested.
    const INVENTED = "wireUnitGuardProbeField";
    for (const [label, src] of [["host/index.mjs", hostSrc], ["the hook", hookSrc],
                                ["host/wire-ascii.mjs", fs.readFileSync(asciiPath, "utf8")]]) {
      ok(!src.includes(INVENTED),
         `INVARIANT: the invented field name must appear nowhere in ${label}, or the "structural, not enumerated" claim is vacuous`);
    }
    const tick = {
      hostId: "x".repeat(8), hostTag: "air", remoteAnswer: true, fiveHourPct: 42,
      voice: { seq: 3, state: "done", text: "plain", reply: "also plain" },
      sessions: [
        { id: "s0", name: "deckhand", status: "asking",
          ask: { pid: "p0", detail: "ascii detail", options: ["Yes", "No"],
                 // the field that actually did this, verbatim in shape:
                 voiceText: "Yes — let's go ahead… but don't touch the cache",
                 voiceSha: "0123456789abcdef",
                 // and one that has never existed:
                 [INVENTED]: "café → naïve" } },
        { id: "s1", name: "other", status: "working" },
      ],
    };
    const before = JSON.parse(JSON.stringify(tick));
    const r = asciiFit(tick);
    // FIRST, before anything below dereferences it. A guard that refuses a bad
    // payload would starve the device inside the 5s tick, which is worse than the
    // bytes it objected to - and asserting it here rather than letting a later
    // line crash is deliberate: the selftest counts a fault as caught only when a
    // NAMED assertion fails, so a TypeError would read as a MISS.
    ok(r.payload != null,
       "INVARIANT: the guard always hands back a sendable payload - repair or log, never reject");
    const want = ["sessions[0].ask.voiceText", `sessions[0].ask.${INVENTED}`];
    ok(JSON.stringify(r.offenders.slice().sort()) === JSON.stringify(want.slice().sort()),
       `INVARIANT: both offenders are named by their exact PATH, and nothing else is - want ${JSON.stringify(want)}, got ${JSON.stringify(r.offenders)}`);
    ok(r.offenders.includes(`sessions[0].ask.${INVENTED}`),
       `INVARIANT: A FIELD NAME THIS REPO HAS NEVER SEEN is still caught - the walk is structural, not a list of names`);
    ok(allAscii(r.payload), "INVARIANT: and the payload is REPAIRED, so the device gets drawable, budgetable text rather than invisible gaps");
    ok(JSON.stringify(tick) === JSON.stringify(before),
       "INVARIANT: the input is never mutated - some of these objects are live state the next tick reuses");
    ok(r.payload !== tick && r.payload?.sessions?.[1] === tick.sessions[1],
       "INVARIANT: cloning is LAZY and per level - the clean session is shared, not deep-copied");
    ok(r.payload?.sessions?.[0]?.ask?.voiceText === "Yes - let's go ahead... but don't touch the cache",
       `INVARIANT: repair TRANSLITERATES rather than blanking, got ${JSON.stringify(r.payload?.sessions?.[0]?.ask?.voiceText)}`);
    ok(r.payload?.fiveHourPct === 42 && r.payload?.remoteAnswer === true && r.payload?.voice?.seq === 3,
       "INVARIANT: non-string values cross untouched");
    ok(describeOffenders(r.offenders).includes(INVENTED),
       "INVARIANT: the one-line description NAMES the fields - a message that cannot be acted on is close to no message");
    ok(describeOffenders(["a", "b", "c"], 2) === "a, b (and 1 more)",
       `INVARIANT: and it is capped, with a count for what it elided, got ${JSON.stringify(describeOffenders(["a", "b", "c"], 2))}`);

    // Every shape JSON.stringify can reach: the root, arrays, keys, and toJSON.
    ok(asciiFit("—").offenders[0] === "<root>", "INVARIANT: a bare string root is named rather than reported with an empty path");
    ok(asciiFit({ a: ["ok", "—"] }).offenders[0] === "a[1]", "INVARIANT: array elements are named by index");
    {
      const k = asciiFit({ "café": "v" });
      ok(k.offenders.some((o) => o.includes("[key]")),
         `INVARIANT: a non-ASCII KEY is caught too - keys are on the wire and count against the same 16000 bytes, got ${JSON.stringify(k.offenders)}`);
      ok(allAscii(k.payload) && Object.keys(k.payload).every((kk) => Buffer.byteLength(kk, "utf8") === kk.length),
         "INVARIANT: and the key is repaired");
      const collide = asciiFit({ cafe: "1", "café": "2" });
      ok(Object.keys(collide.payload).length === 2 && collide.offenders.length === 1,
         "INVARIANT: a rename that would COLLIDE is declined - silently dropping a field to tidy a key is worse than the key");
    }
    {
      const j = asciiFit({ w: { toJSON: () => "—dash" } });
      ok(j.offenders.length === 1 && allAscii(JSON.parse(JSON.stringify(j.payload))),
         `INVARIANT: a value hiding behind toJSON() is walked - JSON.stringify would have serialised it, so not walking it is a silent pass, got ${JSON.stringify(j.offenders)}`);
      const jc = { w: { toJSON: () => "plain" } };
      ok(asciiFit(jc).payload === jc, "INVARIANT: a CLEAN toJSON value is left alone, so stringify still does its own thing");
    }

    // TOTALITY. This runs in the 5s poll loop, where this repo has a documented
    // class of "an await that never settled killed the loop forever". A bug in
    // here must cost a log line, never a payload - so it may not throw, may not
    // spin, and must always hand back something sendable.
    {
      const cyc = { a: { b: "ok" } };
      cyc.a.self = cyc;
      const t0 = Date.now();
      const c = asciiFit(cyc);
      ok(Date.now() - t0 < 2000, "INVARIANT: a cyclic payload terminates rather than spinning inside the tick");
      ok(c.offenders.some((o) => o.includes("not checked")),
         `INVARIANT: and the unchecked subtree is NAMED rather than silently passed, got ${JSON.stringify(c.offenders)}`);
      ok(c.payload != null, "INVARIANT: it still hands back a sendable payload - repair or log, never reject");
      for (const weird of [undefined, null, 0, false, [], {}, [[["—"]]]]) {
        let threw = null;
        try { asciiFit(weird); } catch (e) { threw = e; }
        ok(threw === null, `INVARIANT: asciiFit must never throw, ${JSON.stringify(weird)} threw ${threw && threw.message}`);
      }
      ok(asciiFit([[["—"]]]).offenders[0] === "[0][0][0]", "INVARIANT: nested arrays are named by their full index path");
    }

    // The invariant IS "pure ASCII": run the fuzz corpus through a payload and
    // check the two agree, so nobody has to take the equality on trust.
    {
      const fuzz = fuzzCorpus(1500);
      const p = { sessions: fuzz.map((v, i) => ({ id: `f${i}`, name: v })) };
      const rr = asciiFit(p);
      const want = fuzz.map((v, i) => [i, v]).filter(([, v]) => /[^\x00-\x7f]/.test(v)).map(([i]) => `sessions[${i}].name`);
      ok(JSON.stringify(rr.offenders) === JSON.stringify(want),
         `INVARIANT (fuzz, ${fuzz.length} strings): the byteLength===length test flags EXACTLY the non-ASCII strings, ` +
         `${rr.offenders.length} flagged against ${want.length} expected`);
      ok(allAscii(rr.payload), "INVARIANT (fuzz): and every one of them is repaired");
      ok(!/[^\x00-\x7f]/.test(JSON.stringify(rr.payload)),
         "INVARIANT (fuzz): the SERIALISED line is pure ASCII - which is the form the device's byte guard actually counts");
    }

    // PLANTED-PATH SWEEP. A fixed example proves the walk reaches the places the
    // example happens to have. This builds random trees, plants non-ASCII at
    // random leaves, and demands the offender set equal the planted set exactly -
    // no misses (a silent pass) and no extras (a false alarm every 5s).
    {
      let seed = 0x5eed, planted = 0, bad = null;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const build = (depth) => {
        if (depth > 3 || rnd() < 0.3) return "ascii leaf";
        if (rnd() < 0.4) return Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => build(depth + 1));
        const o = {};
        for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) o[`k${i}`] = build(depth + 1);
        return o;
      };
      for (let t = 0; t < 300 && bad === null; t++) {
        const tree = build(0);
        const leaves = strings(tree);
        const want = [];
        const plant = (node, at) => {
          if (typeof node === "string") return rnd() < 0.35 ? (want.push(at || "<root>"), "wide — 中") : node;
          if (Array.isArray(node)) return node.map((v, i) => plant(v, `${at}[${i}]`));
          const o = {};
          for (const k of Object.keys(node)) o[k] = plant(node[k], at ? `${at}.${k}` : k);
          return o;
        };
        const seeded = plant(tree, "");
        planted += want.length;
        const g = asciiFit(seeded);
        if (JSON.stringify(g.offenders.slice().sort()) !== JSON.stringify(want.slice().sort()) || !allAscii(g.payload))
          bad = { want, got: g.offenders, leaves: leaves.length };
      }
      ok(bad === null,
         `INVARIANT (planted sweep, ${planted} plants over 300 random trees): the offender set must EQUAL the planted set - ` +
         `first mismatch want ${JSON.stringify(bad && bad.want)} got ${JSON.stringify(bad && bad.got)}`);
    }
  }

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
  // Every fault goes into a COPY in a temp dir - never a repo file. Four sources
  // can be mutated because the defect this checker exists for has now been found
  // in three of them: the hook, the module, the host's own cap sites, and the
  // refusal. A mutation of the MODULE is mirrored into the hook's inline copy, or
  // the drift guard catches the fault for the wrong reason and everything else
  // passes.
  const SRC = { hook: HOOK_SRC, mod: MOD_SRC, host: HOST_SRC, fit: FIT_SRC, ascii: ASCII_SRC };
  const orig = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, fs.readFileSync(v, "utf8")]));
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
     { mod: (s) => s.replace('  if (pending) out += "?";\n  return out;', '  if (pending) out += "?";\n  return out + "!";') }],
    ["the module leaves a non-ASCII byte through",
     { mod: (s) => s.replace("    pending = true;", "    out += ch;") }],
    ["the hook's inline copy drifts from the module - OUTSIDE the hand-written corpus, so only the fuzz sweep can see it",
     { hook: (s) => s.replace('"Ø": "O",', '"Ø": "0",') }],
    ["deviceText caps BEFORE transliterating, so expansion re-exceeds the cap",
     { mod: (s) => s.replace("  const a = toAscii(s);\n  return max == null ? a : a.slice(0, max);",
                             "  return max == null ? toAscii(s) : toAscii(String(s ?? '').slice(0, max));") }],
    ["the ask DETAIL cap raised past what the guard can hold - the budget half, which no fidelity assertion can see",
     { hook: (s) => s.replace('cleanMultiline(q.question ?? "", 1400)', 'cleanMultiline(q.question ?? "", 1800)') }],
    ["a line written to stdout, which on a PermissionRequest can auto-answer a real dialog",
     { hook: (s) => s.replace(/^function buildAsk\(data\) \{$/m, 'function buildAsk(data) {\n  console.log("");') }],
    ["a host cap site bypasses the transliteration",
     { host: (s) => s.replace(/name: deviceText\(await projectName\(record\.cwd \|\| ""\), (\d+)\)/,
                              'name: (await projectName(record.cwd || "")).slice(0, $1)') }],
    ["ask.voiceText bypasses it at the PARK SITE - the confirm screen draws gaps where the punctuation was",
     { host: (s) => s.replace("text = capUtf8(toAscii(text), VOICE_ANSWER_TEXT_MAX_BYTES);",
                              "text = capUtf8(text, VOICE_ANSWER_TEXT_MAX_BYTES);") }],
    ["ask.voiceText transliterated in the PAYLOAD BUILDER instead - the plausible wrong fix, which desyncs voiceSha and rejects every valid answer",
     { host: (s) => s.replace("text = capUtf8(toAscii(text), VOICE_ANSWER_TEXT_MAX_BYTES);", "text = capUtf8(text, VOICE_ANSWER_TEXT_MAX_BYTES);")
                     .replace("item.ask.voiceText = pend.text;", "item.ask.voiceText = toAscii(pend.text);") }],
    ["the tick line is no longer measured before it is written",
     { host: (s) => s.replace("const fitted = fitPayload(wire.payload);", "const fitted = ((p) => ({ line: JSON.stringify(p) + \"\\n\", bytes: 0, was: 0, dropped: [] }))(wire.payload);") }],
    ["the refusal's guard constant drifts from the firmware's",
     { fit: (s) => s.replace("export const DEVICE_LINE_GUARD_BYTES = 16000;", "export const DEVICE_LINE_GUARD_BYTES = 32000;") }],
    ["the refusal loses its last tier, so it is merely likely rather than TOTAL",
     { fit: (s) => s.replace("  while (sessions().length) {", "  while (false) {") }],
    ["the refusal replaces SHORT details too, so fitting can GROW the line",
     { fit: (s) => s.replace("bytes(d) > DROPPED_BYTES ?", "bytes(d) > 0 ?") }],
    ["the refusal is off by one and lets a guard+1 line through - the exact size at which feedChar clears its buffer",
     { fit: (s) => s.replace("  if (was <= guard) return", "  if (was <= guard + 1) return") }],
    ["the send-time guard checks a LIST OF FIELD NAMES instead of walking - the exact shape of the bug it exists for",
     { ascii: (s) => s.replace('  if (typeof node === "string") {\n    if (isAscii(node)) return node;',
                               '  if (typeof node === "string") {\n    const KNOWN = ["title", "detail", "name", "path", "model", "branch", "prompt", "text", "reply"];\n    if (isAscii(node) || !KNOWN.some((n) => path.endsWith(n))) return node;') }],
    ["the guard LOGS but does not REPAIR, so the device still gets bytes it cannot draw or budget for",
     { ascii: (s) => s.replace('    offenders.push(path || "<root>");\n    return toAscii(node);',
                               '    offenders.push(path || "<root>");\n    return node;') }],
    ["the guard reports that something was wrong but not WHICH FIELD - a message nobody can act on",
     { ascii: (s) => s.replace('offenders.push(path || "<root>");', 'offenders.push("a device-bound field");') }],
    ["the guard does not descend into arrays, so nothing under sessions[] is ever checked",
     { ascii: (s) => s.replace("  if (Array.isArray(node)) {", "  if (Array.isArray(node)) {\n    return node;") }],
    ["the guard ignores toJSON(), so a value JSON.stringify WOULD serialise goes unwalked",
     { ascii: (s) => s.replace('  if (typeof node.toJSON === "function") {', "  if (false) {") }],
    ["the guard mutates the caller's payload in place - some of those objects are live state the next tick reuses",
     { ascii: (s) => s.replace("      if (out === node) out = { ...node };", "      if (out === node) out = node;") }],
    ["the guard loses its depth cap, so a cyclic payload blows the stack instead of naming the subtree it could not check",
     { ascii: (s) => s.replace("const MAX_DEPTH = 24;", "const MAX_DEPTH = Infinity;") }],
    ["the guard REJECTS a bad payload instead of repairing it - inside the 5s tick, refusing to send is the worse failure",
     { ascii: (s) => s.replace('    return { payload: walk(payload, "", offenders, 0), offenders };',
                               '    const fixed = walk(payload, "", offenders, 0);\n    return { payload: offenders.length ? null : fixed, offenders };') }],
    ["the host stops asserting the invariant at the point of send",
     { host: (s) => s.replace("const wire = asciiFit({", "const wire = ((p) => ({ payload: p, offenders: [] }))({") }],
    ["the host fits the RAW payload rather than the repaired one, so the line it measures is not the line it writes",
     { host: (s) => s.replace("const fitted = fitPayload(wire.payload);", "const fitted = fitPayload(rawPayload);") }],
    ["the violation is logged without naming the field",
     { host: (s) => s.replace("${describeOffenders(wire.offenders)}", "${wire.offenders.length} field(s)") }],
    ["the edge gate is gone, so a permanently-broken field writes a log line every 5 seconds",
     { host: (s) => s.replace("if (sig !== lastWireAsciiSig) {", "if (true) {") }],
    ["the all-clear line is gone, so a fixed field is never visible as fixed",
     { host: (s) => s.replace("Wire: device-bound text is ASCII again.", "Wire: ok.") }],
  ];
  let caught = 0, injected = 0;
  for (const [name, f] of faults) {
    const src = {};
    let bad = false;
    for (const k of Object.keys(SRC)) {
      src[k] = f[k] ? f[k](orig[k]) : orig[k];
      if (f[k] && src[k] === orig[k]) bad = true;
    }
    if (bad) { console.log(`  NOT INJECTED (pattern no longer matches): ${name}`); injected++; continue; }
    // Mirror a MODULE fault into the hook's inline copy.
    if (f.mod) {
      const cut = (t) => t.slice(t.indexOf("// Characters that DO have"), t.indexOf("// Transliterate THEN cap"))
        .replace("export function toAscii", "function toAscii").trimEnd();
      const before = cut(orig.mod), after = cut(src.mod);
      if (src.hook.includes(before)) src.hook = src.hook.replace(before, after);
    }
    const paths = {};
    for (const k of Object.keys(SRC)) {
      paths[k] = path.join(box, `${k}-${injected}.mjs`);
      // wire-ascii.mjs imports ./to-ascii.mjs, so its copy has to point at the
      // COPY of the module in this box - otherwise a mod fault would be mutated
      // and then not used, and every ascii assertion would run against the real
      // transliteration while claiming to test the broken one.
      const body = k === "ascii"
        ? src[k].replace('from "./to-ascii.mjs"', `from "./mod-${injected}.mjs"`)
        : src[k];
      fs.writeFileSync(paths[k], body);
    }
    const mark = failures.length;
    pass = 0;
    try {
      await main({ hookPath: paths.hook, modPath: paths.mod, hostPath: paths.host, fitPath: paths.fit, asciiPath: paths.ascii, quiet: true });
    } catch { /* a crash is also a catch */ }
    const found = failures.length > mark;
    // Print WHICH assertion caught it. "caught" alone cannot tell the assertion
    // that exists for a fault from an unrelated crash, and that difference is the
    // whole point of a teeth-proving run.
    console.log(`  ${found ? "caught  " : "MISSED  "} ${name}`);
    if (found) console.log(`             by: ${failures[mark].slice(0, 118)}`);
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
