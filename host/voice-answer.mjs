// Voice-answer crypto, kept as pure functions so it can be tested without a
// device. The device signs a hash of the text it DISPLAYED, so one signature
// proves two things: the paired device authorised this, and this is the text a
// human actually read. See docs/superpowers/specs/2026-08-15-voice-answers-design.md.
import crypto from "node:crypto";

// 16 hex chars is 64 bits. This is an integrity check against a transcript
// being swapped between display and confirmation - not a password - and it
// travels in a line the device also HMACs, so a collision would have to survive
// both.
export function voiceSha(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

export function voiceAnswerHmac(secret, nonce, pid, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${pid}:TEXT:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Caps a string to at most maxBytes of UTF-8, never splitting a codepoint in
// half. Kept here (not inline in index.mjs) so it can be exercised without a
// device: the whole design rests on the signed hash covering exactly the text
// a human read, and a cap that could slice a multi-byte character would leave
// the device holding a truncated/mangled tail while the host had already
// capped (and would hash) the full, untruncated string.
export function capUtf8(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // never split a codepoint
  return buf.subarray(0, end).toString("utf8");
}

// Returns a reason as well as a verdict: a rejected answer must be logged with
// WHY, because the difference between "wrong device" and "text was altered" is
// the difference between a misconfiguration and an attack.
export function verifyVoiceAnswer({ secret, nonce, pid, sha16, mac, text }) {
  if (!secret || !nonce || !pid) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  if (typeof sha16 !== "string" || !/^[0-9a-f]{16}$/.test(sha16)) return { ok: false, why: "malformed sha" };

  // The text must hash to what was signed. This is what stops a transcript
  // being altered between the device showing it and the answer being written.
  if (voiceSha(text) !== sha16) return { ok: false, why: "text does not match the signed hash" };

  const want = voiceAnswerHmac(secret, nonce, pid, sha16);
  // Equal lengths are guaranteed by the regex above, so timingSafeEqual cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "" } : { ok: false, why: "bad hmac" };
}
