// Typed-answer crypto and validation, kept as pure functions so it can be tested
// without a device. See docs/superpowers/specs/2026-08-15-keyboard-answers-design.md.
//
// This differs from the voice path in the one way that matters: the host holds NO
// copy of typed text, so there is nothing to compare against. handleVoiceAnswer
// opens with pendingVoiceAnswers.get(pid) and re-hashes its own copy; a typed
// answer instead CARRIES the text and is trusted only because the HMAC proves it
// came from the paired device. That makes this the first place the host accepts
// device-authored text, which is why the sanitising below is not optional: the
// signature proves origin, never that the bytes are sensible.
import crypto from "node:crypto";
import { voiceSha, ANSWER_TEXT_MAX_BYTES } from "./voice-answer.mjs";

// Same cap as a spoken answer (ANSWER_TEXT_MAX_BYTES), so one limit covers
// both and the device's fixed buffers are sized once.
export const TYPED_TEXT_MAX_BYTES = ANSWER_TEXT_MAX_BYTES;

// Note the "TYPED" tag: the voice form signs "nonce:pid:TEXT:sha". Signing a
// different string for each form is what stops a signature minted for one being
// replayed as the other.
export function typedAnswerHmac(secret, nonce, pid, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${pid}:TYPED:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Printable ASCII plus space. The device's keyboard cannot emit anything else, so
// this is really a test of whether the frame came from our firmware - and the text
// ends up in a JSON answer file the hook feeds to Claude as a decision message,
// where control bytes have no business at all.
export function typedTextOk(text) {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    Buffer.byteLength(text, "utf8") <= TYPED_TEXT_MAX_BYTES &&
    /^[\x20-\x7E]+$/.test(text)
  );
}

// Buffer.from(.., "base64") is LENIENT: it silently skips characters it does not
// recognise, so "abc!!!!" decodes happily to whatever "abc" meant. Re-encoding and
// comparing is what turns that into a rejection instead of a silent
// reinterpretation of a payload we are about to sign against.
export function decodeTypedText(b64) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64") !== b64) return null;
  if (buf.length > TYPED_TEXT_MAX_BYTES) return null;
  return buf.toString("utf8");
}

// Returns a reason as well as a verdict: a rejected answer must be logged with WHY,
// because "wrong device" and "text was altered" are a misconfiguration and an attack.
export function verifyTypedAnswer({ secret, nonce, pid, b64, mac }) {
  if (!secret || !nonce || !pid) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  const text = decodeTypedText(b64);
  if (text === null) return { ok: false, why: "malformed base64" };
  if (!typedTextOk(text)) {
    return { ok: false, why: "text is empty, over the cap, or not printable ASCII" };
  }
  const want = typedAnswerHmac(secret, nonce, pid, voiceSha(text));
  // Equal lengths are guaranteed by the mac regex above, so this cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "", text } : { ok: false, why: "bad hmac" };
}

// ---- A typed message to a READY session ----
//
// Same key, same nonce shape, same sanitising - and a DIFFERENT label, which is the
// only thing separating "answer this question" from "start doing something". A
// READY session has no pending prompt and therefore no pid, so this signs against
// the session's own id and a per-session nonce.
//
// Note the secret is passed straight to createHmac exactly as the other two forms
// do. Hex-decoding it here would keep every check in this file passing while
// silently disagreeing with the device, which computes its HMAC over the stored
// bytes - the failure would only show up as a rejected message on real hardware.
export function promptHmac(secret, nonce, id12, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${id12}:PROMPT:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Mirrors verifyTypedAnswer, including reporting WHY: "wrong device" and "text was
// altered" are a misconfiguration and an attack, and the log has to tell them apart.
export function verifyPrompt({ secret, nonce, id12, b64, mac }) {
  if (!secret || !nonce || !id12) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  const text = decodeTypedText(b64);
  if (text === null) return { ok: false, why: "malformed base64" };
  if (!typedTextOk(text)) {
    return { ok: false, why: "text is empty, over the cap, or not printable ASCII" };
  }
  const want = promptHmac(secret, nonce, id12, voiceSha(text));
  // Equal lengths are guaranteed by the mac regex above, so this cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "", text } : { ok: false, why: "bad hmac" };
}
