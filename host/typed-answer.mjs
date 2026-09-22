// Typed-answer crypto and validation, kept as pure functions so it can be tested
// without a device. See docs/superpowers/specs/2026-08-15-keyboard-answers-design.md.
//
// THIS IS NOW THE ONLY WAY AN ANSWER IS AUTHORED. The voice TEXT form that used to
// sit beside it is gone: a spoken answer is an editable draft and comes back through
// THIS frame (see voice-answer.mjs, and 2026-09-13-voice-draft-design.md).
//
// What that form had and this one cannot is a host-held copy to compare against - it
// opened with pendingVoiceAnswers.get(pid) and re-hashed the transcript the host was
// already holding, so one signature proved both origin AND that a human had read
// exactly those words. A typed answer instead CARRIES the text, and is trusted only
// because the HMAC proves it came from the paired device. That makes this the place
// the host accepts device-authored text, which is why the sanitising below is not
// optional: the signature proves origin, never that the bytes are sensible.
import crypto from "node:crypto";
import { voiceSha, ANSWER_TEXT_MAX_BYTES } from "./voice-answer.mjs";

// Same cap as a spoken answer (ANSWER_TEXT_MAX_BYTES), so one limit covers
// both and the device's fixed buffers are sized once.
export const TYPED_TEXT_MAX_BYTES = ANSWER_TEXT_MAX_BYTES;

// Note the "TYPED" tag: the OTHER surviving form, a message, signs
// "nonce:id12:PROMPT:sha". (A third, "nonce:pid:TEXT:sha", was the voice confirm
// screen's and no longer exists.) Signing a different string for each form is what
// stops a signature minted for one being replayed as the other.
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

// ---- A headless RESUME of a session that is not live ----
//
// SAME KEY, SAME NONCE SHAPE, SAME SANITISING, A THIRD LABEL. RESUME runs
// `claude -p --resume <id> <text>`: it injects device-authored text into a
// conversation and lets Claude act on it, which is the same class of
// consequence PROMPT and TYPED are signed for - it shipped unsigned and
// un-nonced, which meant anything that could write one line to a paired Mac's
// serial port or BLE characteristic could start a headless turn in any session
// on that Mac's disk. The label is what stops a signature minted for one form
// being replayed as another: "RESUME" can never authenticate as "PROMPT", so a
// message the operator signed for a READY session cannot be re-sent as a
// headless turn against a DEAD one (whose live-session guard is the device's,
// and which the host deliberately does not re-derive).
//
// THE NONCE IS THE HOST'S OWN, not a session's. PROMPT signs against a
// per-SESSION nonce published in the tick for exactly the sessions that may be
// messaged; a resumable session is by definition NOT in that list (it ended, or
// it belongs to a project this Mac has never had live), so there is no record
// to hang one off. index.mjs publishes one rolling `rnonce` per host process
// instead and rotates it on every accepted RESUME, which is the same
// single-use, no-replay property consumeSessionNonce() gives the other two.
export function resumeHmac(secret, nonce, id12, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${id12}:RESUME:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Mirrors verifyPrompt exactly, reason string included - see its own note on why
// a rejection has to say WHICH failure it was.
export function verifyResume({ secret, nonce, id12, b64, mac }) {
  if (!secret || !nonce || !id12) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  const text = decodeTypedText(b64);
  if (text === null) return { ok: false, why: "malformed base64" };
  if (!typedTextOk(text)) {
    return { ok: false, why: "text is empty, over the cap, or not printable ASCII" };
  }
  const want = resumeHmac(secret, nonce, id12, voiceSha(text));
  // Equal lengths are guaranteed by the mac regex above, so this cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "", text } : { ok: false, why: "bad hmac" };
}
