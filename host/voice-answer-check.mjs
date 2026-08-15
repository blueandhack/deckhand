#!/usr/bin/env node
// Checks for the voice-answer crypto. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a spoken answer is allowed to reach Claude.
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer, capUtf8 } from "./voice-answer.mjs";

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
const mac = voiceAnswerHmac(secret, nonce, pid, sha);

check("a valid answer is accepted",
  verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac, text }).ok);

check("tampered TEXT is rejected (sha no longer matches)",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac, text: text + " and delete the repo" }).ok);

check("a tampered SHA is rejected (hmac no longer matches)",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: voiceSha("something else"), mac, text }).ok);

check("a wrong nonce is rejected",
  !verifyVoiceAnswer({ secret, nonce: "ffffffffffffffff", pid, sha16: sha, mac, text }).ok);

check("a wrong pid is rejected",
  !verifyVoiceAnswer({ secret, nonce, pid: "99999", sha16: sha, mac, text }).ok);

check("a different device's secret is rejected",
  !verifyVoiceAnswer({ secret: "ffffffffffffffffffffffffffffffff", nonce, pid, sha16: sha, mac, text }).ok);

check("a missing mac is rejected",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac: "", text }).ok);

check("a mac of the wrong length is rejected without throwing",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac: "abc", text }).ok);

check("the sha is over the EXACT string (trailing space matters)",
  voiceSha(text) !== voiceSha(text + " "));

check("hmac is 16 hex chars", /^[0-9a-f]{16}$/.test(mac));
check("sha is 16 hex chars", /^[0-9a-f]{16}$/.test(sha));

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

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
