#!/usr/bin/env node
// Checks for the answer crypto - spoken AND typed. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a remote answer is allowed to reach Claude.
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer, capUtf8 } from "./voice-answer.mjs";
import { TYPED_TEXT_MAX_BYTES, typedAnswerHmac, decodeTypedText, verifyTypedAnswer } from "./typed-answer.mjs";

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

  // The two forms sign DIFFERENT strings ("...:TEXT:..." vs "...:TYPED:..."), so a
  // signature minted for one must not authenticate the other.
  check("a voice-form mac does not authenticate a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid, b64: tB64,
                         mac: voiceAnswerHmac(secret, nonce, pid, voiceSha(tText)) }).ok);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
