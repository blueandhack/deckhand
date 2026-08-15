#!/usr/bin/env node
// Checks for the voice-answer crypto. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a spoken answer is allowed to reach Claude.
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer } from "./voice-answer.mjs";

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

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
