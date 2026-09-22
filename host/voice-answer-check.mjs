#!/usr/bin/env node
// Checks for the answer crypto - spoken AND typed. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a remote answer is allowed to reach Claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { voiceSha, capUtf8 } from "./voice-answer.mjs";
import {
  TYPED_TEXT_MAX_BYTES,
  typedAnswerHmac,
  decodeTypedText,
  verifyTypedAnswer,
  promptHmac,
  verifyPrompt,
  resumeHmac,
  verifyResume,
} from "./typed-answer.mjs";

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const secret = "0123456789abcdef0123456789abcdef";
const nonce = "a1b2c3d4e5f60718";
const pid = "54321";
const text = "use the second approach, but keep the existing tests";
const sha = voiceSha(text);
// THE TEXT FORM IS GONE, and with it nine of this file's assertions. It signed
// "nonce:pid:TEXT:<sha16>" over a transcript the HOST was holding, which is what
// let one signature prove both that the paired device authorised the answer and
// that a human had read exactly those words. A spoken answer is now an editable
// draft and comes back through the TYPED form below, so the second claim is not
// available to make and the frame was removed rather than left as a weaker second
// way to author an answer. What the two surviving forms still need from
// voice-answer.mjs is asserted here: the digest they HMAC over, and the cap.
check("sha is 16 hex chars", /^[0-9a-f]{16}$/.test(sha));
check("the sha is over the EXACT string - a trailing space is a different answer",
  voiceSha("yes") !== voiceSha("yes "));

// capUtf8 must never split a multi-byte codepoint, even when the byte budget
// lands mid-character - an em-dash is 3 bytes, so a cap of "N + 1 byte into
// the next em-dash" is exactly the case that would otherwise emit a mangled
// tail. This is the guard behind Finding 2/3: the device signs a hash of
// whatever the host sends, so a split codepoint there would be a display
// truncation the host's hash doesn't reflect.
{
  const emdashes = "—".repeat(60); // 180 bytes, all 3-byte UTF-8 sequences
  const capped = capUtf8(emdashes, 151); // 151 = 50 whole em-dashes + 1 stray byte
  const buf = Buffer.from(capped, "utf8");
  check("capUtf8 never splits a codepoint (round-trips clean)",
    buf.toString("utf8").length === capped.length && !capped.includes("�"));
  check("capUtf8 shortens input that exceeds the byte budget",
    buf.length <= 151 && capped.length < emdashes.length);
  check("capUtf8 backs off to the last whole codepoint boundary",
    buf.length === 150); // 151 falls 1 byte into em-dash #51, so it must back off to 150
  check("capUtf8 leaves a string under the budget untouched",
    capUtf8("short", 150) === "short");
}

// ---- typed answers ----------------------------------------------------------
// The typed form carries the TEXT rather than a hash of a transcript the host
// already holds, so these cover decoding and sanitising as well as the crypto.
{
  const b64of = (s) => Buffer.from(s, "utf8").toString("base64");
  const tText = "use the second approach, but keep the existing tests";
  const tB64 = b64of(tText);
  const tMac = typedAnswerHmac(secret, nonce, pid, voiceSha(tText));

  check("a valid typed answer is accepted",
    verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: tMac }).ok);

  check("a valid typed answer returns the decoded text",
    verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: tMac }).text === tText);

  check("tampered typed TEXT is rejected (hmac covers its hash)",
    !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(tText + " and delete the repo"), mac: tMac }).ok);

  check("a wrong nonce is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce: "ffffffffffffffff", pid, b64: tB64, mac: tMac }).ok);

  check("a wrong pid is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid: "99999", b64: tB64, mac: tMac }).ok);

  check("a wrong device secret is rejected for a typed answer",
    !verifyTypedAnswer({ secret: "f".repeat(32), nonce, pid, b64: tB64, mac: tMac }).ok);

  check("a malformed mac is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: "nothex" }).ok);

  check("malformed base64 is rejected",
    !verifyTypedAnswer({ secret, nonce, pid, b64: "not!valid!base64", mac: tMac }).ok);

  // Buffer.from(.., "base64") SILENTLY IGNORES junk, so a payload with rubbish
  // in it would otherwise decode to something plausible and be signed against.
  // NOTE: this case alone doesn't exercise the re-encode-and-compare guard - the
  // "!" characters fail the alphabet regex first. It's kept for the "rubbish
  // outside the alphabet" case, but the two checks below are what actually
  // reach and depend on the compare line.
  check("base64 with ignorable junk is rejected, not silently reinterpreted",
    decodeTypedText(tB64.slice(0, -4) + "!!!!") === null);

  // Both of these pass the alphabet regex - every character is valid base64 -
  // so ONLY the re-encode-and-compare line catches them. Deleting that line
  // must fail these two specifically (proven in Step 5 of the fix report).
  check("valid-alphabet base64 that Buffer.from would silently truncate is rejected",
    decodeTypedText("YWJjZA") === null); // unpadded, non-multiple-of-4: decodes to
                                         // "abcd", re-encodes to "YWJjZA==" - only the
                                         // compare notices the missing padding.

  // NOTE: an interior-whitespace/newline variant (e.g. "YWJj ZA==") was
  // considered here too, but whitespace is outside [A-Za-z0-9+/] so the
  // alphabet regex rejects it BEFORE the compare line runs - it wouldn't
  // actually exercise the guard this fix is for. This case does: every
  // character is in-alphabet and the padding count is correct, but the last
  // character carries non-canonical padding bits Buffer.from silently drops.
  check("valid-alphabet base64 with non-canonical padding bits is rejected",
    decodeTypedText("YWJjZB==") === null); // decodes to "abcd" (same bytes as
                                           // "YWJjZA=="), so ONLY the compare
                                           // notices the input wasn't canonical.

  // The device can only produce printable ASCII; a control byte means the frame
  // did not come from our firmware, and it is headed for a hook decision message.
  {
    const bad = "hello\x07world";   // BEL as an ESCAPE: a raw control byte in
                                     // this file could be stripped in transit, and a
                                     // stripped one turns the check into a silent no-op
    check("control bytes are rejected",
      !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(bad),
                           mac: typedAnswerHmac(secret, nonce, pid, voiceSha(bad)) }).ok);
  }

  check("empty text is rejected",
    !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(""),
                         mac: typedAnswerHmac(secret, nonce, pid, voiceSha("")) }).ok);

  {
    const over = "x".repeat(TYPED_TEXT_MAX_BYTES + 1);
    check("text over the byte cap is rejected",
      !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(over),
                           mac: typedAnswerHmac(secret, nonce, pid, voiceSha(over)) }).ok);
  }

  check("text exactly at the byte cap is accepted",
    (() => {
      const at = "y".repeat(TYPED_TEXT_MAX_BYTES);
      return verifyTypedAnswer({ secret, nonce, pid, b64: b64of(at),
                                 mac: typedAnswerHmac(secret, nonce, pid, voiceSha(at)) }).ok;
    })());

  // The live forms sign DIFFERENT strings ("...:TYPED:..." vs "...:PROMPT:..."),
  // so a signature minted for one must not authenticate the other. This used to be
  // stated against the TEXT form; with that gone, PROMPT is the other signature
  // over the same digest and carries the same protection.
  check("a PROMPT-form mac does not authenticate a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid, b64: tB64,
                         mac: promptHmac(secret, nonce, pid, voiceSha(tText)) }).ok);
}

// ---- PROMPT form: typed text sent to a READY session ----
// Nothing is waiting on this one - there is no pending prompt and so no pid, so it
// signs against a per-SESSION nonce and the session's own id.
{
  const pNonce = "feedfacecafebeef";
  const id12 = "abc123456789";
  const pText = "run the failing tests and summarise what broke";
  const pB64 = Buffer.from(pText, "utf8").toString("base64");
  const pSha = voiceSha(pText);
  const pMac = promptHmac(secret, pNonce, id12, pSha);

  check("PROMPT: a valid frame is accepted",
    verifyPrompt({ secret, nonce: pNonce, id12, b64: pB64, mac: pMac }).ok);
  check("PROMPT: the accepted text is returned verbatim",
    verifyPrompt({ secret, nonce: pNonce, id12, b64: pB64, mac: pMac }).text === pText);
  check("PROMPT: altered text is rejected",
    !verifyPrompt({ secret, nonce: pNonce, id12,
      b64: Buffer.from(pText + "!", "utf8").toString("base64"), mac: pMac }).ok);
  check("PROMPT: a forged mac is rejected",
    !verifyPrompt({ secret, nonce: pNonce, id12, b64: pB64, mac: "0".repeat(16) }).ok);
  check("PROMPT: another session's nonce is rejected",
    !verifyPrompt({ secret, nonce: "0123456789abcdef", id12, b64: pB64, mac: pMac }).ok);
  check("PROMPT: another session's id is rejected",
    !verifyPrompt({ secret, nonce: pNonce, id12: "def123456789", b64: pB64, mac: pMac }).ok);
  check("PROMPT: non-ASCII text is rejected before it can be signed for",
    !verifyPrompt({ secret, nonce: pNonce, id12,
      b64: Buffer.from("h\u00e9llo", "utf8").toString("base64"), mac: pMac }).ok);
  check("PROMPT: over the byte cap is rejected",
    !verifyPrompt({ secret, nonce: pNonce, id12,
      b64: Buffer.from("x".repeat(TYPED_TEXT_MAX_BYTES + 1), "utf8").toString("base64"),
      mac: pMac }).ok);
  check("PROMPT: missing pairing state is rejected, not skipped",
    !verifyPrompt({ secret: "", nonce: pNonce, id12, b64: pB64, mac: pMac }).ok);

  // THE CROSS-FORM CHECK, and the entire reason the label sits inside the signed
  // string: a signature minted to ANSWER a question must not be able to SEND a
  // message that starts work, even though both sign a 16-hex hash of their text
  // with the same key and nonce.
  const answerMac = typedAnswerHmac(secret, pNonce, id12, pSha);
  check("PROMPT: a TYPED answer's signature cannot authenticate a PROMPT",
    !verifyPrompt({ secret, nonce: pNonce, id12, b64: pB64, mac: answerMac }).ok);
  check("TYPED: a PROMPT signature cannot authenticate an answer",
    !verifyTypedAnswer({ secret, nonce: pNonce, pid: id12, b64: pB64, mac: pMac }).ok);

  // ---- RESUME form: a headless turn against a session that is NOT live ----
  // The same shape as PROMPT, over the host's own rolling nonce rather than a
  // per-session one (a resumable session is not in the live list, so nothing
  // publishes a nonce for it). It shipped UNSIGNED - `RESUME <id> <plaintext>`,
  // run by anything that could put a line on the wire - which is why the
  // cross-form assertions below matter as much as the happy path: the whole
  // point of the third label is that the other two signatures cannot reach it.
  const rMac = resumeHmac(secret, pNonce, id12, pSha);
  check("RESUME: a valid frame is accepted",
    verifyResume({ secret, nonce: pNonce, id12, b64: pB64, mac: rMac }).ok);
  check("RESUME: the accepted text is returned verbatim",
    verifyResume({ secret, nonce: pNonce, id12, b64: pB64, mac: rMac }).text === pText);
  check("RESUME: altered text is rejected",
    !verifyResume({ secret, nonce: pNonce, id12,
                    b64: Buffer.from(pText + "!", "utf8").toString("base64"), mac: rMac }).ok);
  check("RESUME: a forged mac is rejected",
    !verifyResume({ secret, nonce: pNonce, id12, b64: pB64, mac: "0".repeat(16) }).ok);
  check("RESUME: a rotated (stale) nonce is rejected - no replay of the same frame",
    !verifyResume({ secret, nonce: "0123456789abcdef", id12, b64: pB64, mac: rMac }).ok);
  check("RESUME: another session's id is rejected",
    !verifyResume({ secret, nonce: pNonce, id12: "def123456789", b64: pB64, mac: rMac }).ok);
  check("RESUME: another device's key is rejected",
    !verifyResume({ secret: "f".repeat(32), nonce: pNonce, id12, b64: pB64, mac: rMac }).ok);
  check("RESUME: non-ASCII text is rejected before it can be signed for",
    !verifyResume({ secret, nonce: pNonce, id12,
                    b64: Buffer.from("héllo", "utf8").toString("base64"),
                    mac: resumeHmac(secret, pNonce, id12, voiceSha("héllo")) }).ok);
  check("RESUME: over the byte cap is rejected",
    !verifyResume({ secret, nonce: pNonce, id12,
                    b64: Buffer.from("x".repeat(TYPED_TEXT_MAX_BYTES + 1), "utf8").toString("base64"),
                    mac: resumeHmac(secret, pNonce, id12, voiceSha("x".repeat(TYPED_TEXT_MAX_BYTES + 1))) }).ok);
  check("RESUME: missing pairing state is rejected, not skipped",
    !verifyResume({ secret: "", nonce: pNonce, id12, b64: pB64, mac: rMac }).ok);
  check("RESUME: missing nonce state is rejected, not skipped",
    !verifyResume({ secret, nonce: "", id12, b64: pB64, mac: rMac }).ok);
  // THE THREE-WAY CROSS-FORM CHECK. A signature minted to answer a question or
  // to message a READY session must not be able to start a HEADLESS turn in a
  // dead one, and vice versa - which is exactly what one shared label would
  // allow, since all three sign a 16-hex hash of their text with the same key.
  check("RESUME: a PROMPT signature cannot authenticate a resume",
    !verifyResume({ secret, nonce: pNonce, id12, b64: pB64, mac: pMac }).ok);
  check("RESUME: a TYPED answer's signature cannot authenticate a resume",
    !verifyResume({ secret, nonce: pNonce, id12, b64: pB64, mac: answerMac }).ok);
  check("PROMPT: a RESUME signature cannot authenticate a message to a READY session",
    !verifyPrompt({ secret, nonce: pNonce, id12, b64: pB64, mac: rMac }).ok);
  check("TYPED: a RESUME signature cannot authenticate an answer",
    !verifyTypedAnswer({ secret, nonce: pNonce, pid: id12, b64: pB64, mac: rMac }).ok);
}

// ---- STRUCTURAL: the crypto above binds NOTHING unless index.mjs uses it ----
// A MIRROR PROVES THE ALGORITHM AND BINDS NOTHING (CLAUDE.md): every assertion
// above would still pass with host/index.mjs's RESUME handler running `claude -p
// --resume` on an unverified plaintext line, which is precisely what it did.
// These read index.mjs's own text, bound to the RESUME handler's own body.
{
  const HOST = fs.readFileSync(
    path.join(path.dirname(url.fileURLToPath(import.meta.url)), "index.mjs"), "utf8");
  const at = HOST.indexOf('if (line.startsWith("RESUME ")) {');
  const body = at < 0 ? "" : HOST.slice(at, HOST.indexOf('\n  // Audio first', at));
  check("RESUME: the handler is findable in index.mjs (not renamed out from under this)",
    at >= 0 && body.length > 200);
  check("RESUME: the handler verifies through verifyResume() before doing anything",
    /verifyResume\(\{[^}]*secret[^}]*nonce[^}]*\}\)/.test(body));
  check("RESUME: a failed verification returns without running claude",
    /if \(!v\.ok\) \{[\s\S]*?return;/.test(body) &&
      body.indexOf("if (!v.ok)") < body.indexOf("execFile("));
  check("RESUME: the text that is run is the VERIFIED text, never a wire token",
    /const text = v\.text;/.test(body) && !/rest\.slice\(sp \+ 1\)/.test(body));
  check("RESUME: the nonce is consumed (rotated) on acceptance - no replay",
    /rotateResumeNonce\(\);/.test(body));
  check("RESUME: the host publishes the nonce the device signs against",
    /rnonce: resumeNonce\(\)/.test(HOST));
}

// A --selftest, which this file has never had - and it must INJECT A FAULT, not
// restate an assertion. The first version of this block did the latter: five
// "faults" that were verbatim copies of checks 20-150 lines above, so deleting
// every check() in the file still printed "5/5 caught". It tested the library, not
// the checker. This one copies both modules into a temp dir, rewrites one line of
// the copy, imports it, and re-runs the assertions that should now fail.
if (process.argv.includes("--selftest")) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const FAULTS = [
    ["typedTextOk stops rejecting non-printable bytes", "typed-answer.mjs",
      (t) => t.replace("/^[\\x20-\\x7E]+$/.test(text)", "true"),
      (m) => m.typedTextOk("a\x07b") === false],
    ["typedTextOk stops enforcing the byte cap", "typed-answer.mjs",
      (t) => t.replace(/Buffer\.byteLength\(text, "utf8"\) <= TYPED_TEXT_MAX_BYTES/,
                       "true"),
      (m) => m.typedTextOk("x".repeat(200)) === false],
    ["decodeTypedText stops re-encoding to reject non-canonical base64", "typed-answer.mjs",
      (t) => t.replace('if (buf.toString("base64") !== b64) return null;', ""),
      (m) => m.decodeTypedText("YWJjZA") === null],
    // The LABEL is the only thing separating the two live signatures. Swapped, not
    // deleted: deleting it leaves a string that still differs from PROMPT's, so the
    // fault would not express the collision it claims to.
    ["the TYPED label becomes PROMPT, so the two signatures collide",
      "typed-answer.mjs", (t) => t.replace("${nonce}:${pid}:TYPED:${sha16}",
                                           "${nonce}:${pid}:PROMPT:${sha16}"),
      (m) => m.typedAnswerHmac("s".repeat(32), "n", "p", "0".repeat(16))
             !== m.promptHmac("s".repeat(32), "n", "p", "0".repeat(16))],
    // The RESUME label, swapped rather than deleted - the same reasoning the
    // TYPED fault above states: deleting it still leaves a string that differs
    // from PROMPT's, so the fault would not express the collision it claims.
    ["the RESUME label becomes PROMPT, so a message signature can start a headless turn",
      "typed-answer.mjs", (t) => t.replace("${nonce}:${id12}:RESUME:${sha16}",
                                           "${nonce}:${id12}:PROMPT:${sha16}"),
      (m) => m.resumeHmac("s".repeat(32), "n", "i", "0".repeat(16))
             !== m.promptHmac("s".repeat(32), "n", "i", "0".repeat(16))],
    ["capUtf8 stops walking back to a codepoint boundary", "voice-answer.mjs",
      (t) => t.replace(/while \(end > 0 && \(buf\[end\] & 0xc0\) === 0x80\) end--;.*/, ""),
      (m) => Buffer.from(m.capUtf8("\u2014".repeat(60), 151), "utf8").length === 150],
  ];
  let uncaught = 0;
  for (const [name, file, mutate, stillHolds] of FAULTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "va-check-"));
    for (const f of ["voice-answer.mjs", "typed-answer.mjs"]) {
      const src = fs.readFileSync(path.join(here, f), "utf8");
      fs.writeFileSync(path.join(dir, f), f === file ? mutate(src) : src);
    }
    const before = fs.readFileSync(path.join(here, file), "utf8");
    const after = fs.readFileSync(path.join(dir, file), "utf8");
    if (before === after) {
      console.log(`  UNCAUGHT  ${name}  <- THE FAULT DID NOT APPLY (pattern drifted)`);
      uncaught++; continue;
    }
    let held = false;
    try {
      const mod = await import(url.pathToFileURL(path.join(dir, file)).href);
      held = stillHolds(mod);          // true means the assertion would STILL pass
    } catch { held = false; }          // a throw is a catch
    console.log(`  ${held ? "UNCAUGHT" : "caught  "}  ${name}`);
    if (held) uncaught++;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(uncaught ? `\n${uncaught} fault(s) UNCAUGHT`
                       : `\nfaults: ${FAULTS.length}/${FAULTS.length} caught`);
  // `failed` too: a --selftest run that passes its faults while the ordinary
  // assertions are RED must still exit non-zero, or CI reports green over a broken
  // checker. The first version of this block consulted only `uncaught`.
  process.exit(uncaught || failed ? 1 : 0);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
