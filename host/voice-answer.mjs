// Shared answer-text primitives, kept as pure functions so they can be tested
// without a device.
//
// THIS FILE NO LONGER OWNS A WIRE FORM. It used to carry the voice-only
// "nonce:pid:TEXT:<sha16>" signature, whose point was that the device signed a hash
// of text the HOST was holding - one signature proving both that the paired device
// authorised the answer and that a human had read exactly those words. A spoken
// answer is now an editable draft (2026-09-13-voice-draft-design.md), which cannot
// make the second claim by construction, so the form was removed rather than left
// beside typed-answer.mjs as a second, weaker way to author an answer.
// What survives is what both remaining forms need: the byte cap, the hash they
// sign, and a UTF-8-safe truncation.
import crypto from "node:crypto";

// The cap on a remote answer's text, in BYTES (not characters - the device stores
// it in fixed char buffers and truncates by byte). Defined HERE, once, because
// both answer forms and index.mjs's transcript path all size themselves from it;
// a second copy that drifted would let the host accept text the device cannot hold.
export const ANSWER_TEXT_MAX_BYTES = 150;

// 16 hex chars is 64 bits. Not a password: it is the digest both remaining wire
// forms HMAC over (TYPED and PROMPT) instead of signing the text itself, so a
// collision would have to survive the HMAC as well.
export function voiceSha(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

// Caps a string to at most maxBytes of UTF-8, never splitting a codepoint in
// half. Kept here (not inline in index.mjs) so it can be exercised without a
// device. A cap that could slice a multi-byte character would hand the device a
// mangled tail - and since the device's text now comes BACK through typedTextOk(),
// which admits printable ASCII only, a split codepoint is a rejected answer.
export function capUtf8(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // never split a codepoint
  return buf.subarray(0, end).toString("utf8");
}
