#!/usr/bin/env node
// Certify host/whisper-prompt.txt against whisper.cpp's SILENT prompt limit.
//
//   node host/whisper-prompt-check.mjs            # static checks (no model needed)
//   node host/whisper-prompt-check.mjs --live     # also run the real canary through whisper
//   node host/whisper-prompt-check.mjs --selftest # inject a fault; exit 0 only if CAUGHT
//
// WHY THIS EXISTS. whisper.cpp truncates an initial prompt to the LAST ~223 tokens
// (n_text_ctx/2 - 1) and prints nothing when it does. Over-fill the file and the terms
// at the FRONT stop working, while every term you can still see in the file looks fine.
// There is no error, no warning, and no change in runtime - only slightly worse
// transcripts. That is exactly the kind of failure nobody finds by reading the diff.
//
// THE BUDGET IS MEASURED, NOT GUESSED (2026-09-14, ggml-large-v3-turbo-q5_0):
//   - a canary term placed BEFORE 120 filler words stopped taking effect; the same
//     term placed AFTER them still worked => truncation drops the FRONT.
//   - comma-separated, 42 of a 51-term list fit. Space-separated, only 34 did, so the
//     commas stay.
// The first canary run was WRONG and is worth remembering: the probe term was also
// present inside the list being measured, so the list's own copy satisfied the probe
// and it reported that 120 terms fit. A probe a neighbouring line can satisfy is not
// a probe. CANARY is asserted to be absent from the list below for that reason.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.join(__dirname, "whisper-prompt.txt");

// Measured ceilings. Headroom is deliberate: 43 terms fit at the time of measuring and
// the shipped list is 44 including the canary term restored, so these sit just above
// what was proven to work rather than at a round number somebody invented.
const MAX_TERMS = 46;
const MAX_CHARS = 420;
const CANARY = "NVS"; // a term priming demonstrably flips (NBS -> NVS) on s18

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const live = args.includes("--live");
const fail = [];
const ok = [];

// ---- parse, never transcribe -------------------------------------------------
// Every number below is derived from the file itself. A literal copy of the term list
// on this side would keep passing after somebody edited the real one.
function loadPrompt(text) {
  return text.split("\n").filter((l) => !l.startsWith("#")).join(" ").trim();
}
const raw = fs.readFileSync(PROMPT_FILE, "utf8");
let prompt = loadPrompt(raw);
if (selftest) {
  // Inject the exact fault this checker exists to catch: push it past the budget.
  prompt += " " + Array.from({ length: 120 }, (_, i) => `filler${i}`).join(", ");
}
const terms = prompt.split(",").map((s) => s.trim()).filter((s) => /[A-Za-z0-9]/.test(s));

// ---- 1. the budget -----------------------------------------------------------
if (terms.length > MAX_TERMS)
  fail.push(`TOO MANY TERMS: ${terms.length} > ${MAX_TERMS}. whisper keeps only the LAST ~223 tokens, so the terms at the START of whisper-prompt.txt are being silently dropped. Remove some, or accept that the ones at the top no longer do anything.`);
else ok.push(`term count ${terms.length} <= ${MAX_TERMS}`);

if (prompt.length > MAX_CHARS)
  fail.push(`PROMPT TOO LONG: ${prompt.length} chars > ${MAX_CHARS}. Same silent truncation as above - a few long multi-word terms cost as much as many short ones.`);
else ok.push(`prompt length ${prompt.length} <= ${MAX_CHARS} chars`);

// ---- 2. the canary must not be able to satisfy itself ------------------------
// Guards the mistake that made the first measurement wrong.
if (live) {
  const listHasCanary = terms.filter((t) => t.toUpperCase() === CANARY).length;
  if (listHasCanary && !selftest)
    ok.push(`note: ${CANARY} is in the list; --live prepends a SECOND copy and removes the list's own for the probe`);
}

// ---- 3. both readers must actually read the file -----------------------------
// Bound to the reading expression, not to the filename appearing somewhere in the file:
// a comment mentioning whisper-prompt.txt must not satisfy this.
const idx = fs.readFileSync(path.join(__dirname, "index.mjs"), "utf8");
if (!/readFileSync\(WHISPER_PROMPT_FILE,\s*"utf8"\)/.test(idx))
  fail.push(`host/index.mjs no longer READS whisper-prompt.txt (expected readFileSync(WHISPER_PROMPT_FILE, "utf8")). If the list was re-inlined as a literal there, the two copies can drift again - which is the bug this file was created to end.`);
else ok.push("host/index.mjs reads whisper-prompt.txt");

const sh = fs.readFileSync(path.join(__dirname, "mic-stt.sh"), "utf8");
if (!/grep -v '\^#' whisper-prompt\.txt/.test(sh))
  fail.push(`host/mic-stt.sh no longer READS whisper-prompt.txt. It used to hold a second copy of the literal; if it holds one again, a term added for dictation will never reach the CLI and the difference shows up only as "the CLI heard it wrong".`);
else ok.push("host/mic-stt.sh reads whisper-prompt.txt");

// ---- 4. the two readers must produce the SAME string -------------------------
// Node filters '#' lines and joins with a space; the shell does the same with grep/tr.
// If they ever disagree, priming differs between the device and the CLI.
if (!selftest) {
  const viaShell = execFileSync("sh", ["-c",
    `grep -v '^#' ${JSON.stringify(PROMPT_FILE)} | tr '\\n' ' ' | sed 's/  */ /g;s/^ //;s/ $//'`],
    { encoding: "utf8" }).trim();
  if (viaShell !== loadPrompt(raw))
    fail.push(`THE TWO READERS DISAGREE. node produced ${loadPrompt(raw).length} chars, sh produced ${viaShell.length}. The device and mic-stt.sh would prime differently.`);
  else ok.push("node and sh read whisper-prompt.txt identically");
}

// ---- 5. optional: ask the real model ----------------------------------------
// The static checks above bound the SIZE. Only this one observes the EFFECT, and an
// instrument that cannot observe the thing it is pointed at is worse than none.
if (live) {
  const model = process.env.WHISPER_MODEL ||
    path.join(process.env.HOME, ".cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin");
  const bin = process.env.WHISPER_BIN || "/opt/homebrew/bin/whisper-cli";
  if (!fs.existsSync(model) || !fs.existsSync(bin)) {
    ok.push("--live skipped: whisper binary or model not installed");
  } else {
    const tmp = fs.mkdtempSync("/tmp/wpc-");
    const wav = path.join(tmp, "probe.wav");
    execFileSync("say", ["-v", "Samantha", "-o", wav, "--file-format=WAVE",
      "--data-format=LEI16@16000",
      "The firmware writes N V S keys over the U A R T at one fifteen two hundred baud."]);
    // The probe term must NOT be in the list under test, or the list satisfies the probe.
    const without = terms.filter((t) => t.toUpperCase() !== CANARY).join(", ");
    const say = (p) => execFileSync(bin, ["-m", model, "-nt", "-np", "-l", "en",
      "--prompt", p, "--carry-initial-prompt", "-f", wav],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\s+/g, " ").trim();
    const withCanary = say(`${CANARY}, ${without}.`);
    const heard = new RegExp(CANARY, "i").test(withCanary);
    if (!heard)
      fail.push(`LIVE CANARY LOST: "${CANARY}" prepended to the shipped list stopped taking effect (got: ${JSON.stringify(withCanary)}). The list is at or over whisper's prompt limit, so its leading terms are dead weight.`);
    else ok.push(`live canary: "${CANARY}" at the front of the list still takes effect`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- report ------------------------------------------------------------------
for (const o of ok) console.log(`  ok    ${o}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
if (selftest) {
  const caught = fail.some((f) => f.startsWith("TOO MANY TERMS") || f.startsWith("PROMPT TOO LONG"));
  console.log(caught
    ? "\nselftest: the injected over-length prompt WAS caught."
    : "\nselftest: FAULT NOT CAUGHT - this checker cannot fail and is a defect.");
  process.exit(caught ? 0 : 1);
}
console.log(fail.length ? `\n${fail.length} problem(s).` : `\nwhisper-prompt.txt OK - ${terms.length} terms, ${prompt.length} chars.`);
process.exit(fail.length ? 1 : 0);
