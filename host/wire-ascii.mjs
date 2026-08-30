// THE CHAR/BYTE INVARIANT, ASSERTED AT THE POINT OF SEND.
//
// WHY THIS EXISTS, given host/to-ascii.mjs already fixed the units.
//
// feedChar() guards `buf.length() > 16000` on an Arduino String, which counts
// BYTES. Every host-side cap counts CHARACTERS (`.slice(n)`, UTF-16 code units).
// host/to-ascii.mjs reconciles the two by making device-bound text ASCII, so for
// every field that routes through it the two units COINCIDE - and after that,
// host/wire-fit.mjs measures the line and refuses to write an over-guard one.
//
// But the units coincide BY ACCIDENT OF THE TRANSLITERATION, not by declaration.
// Nothing structural stops a NEW field - or an old one on a path that skips
// deviceText() - from re-introducing the mismatch, and that is not hypothetical:
// `ask.voiceText` did exactly that. It is parked by handleVoiceAnswer under a
// BYTE cap (capUtf8), so every size assertion in the repo was satisfied while the
// text itself was still full of Whisper's curly quotes and em-dashes; it was
// caught only because a reviewer went looking. A checker that enumerates the
// field names it knows about cannot catch the next one, because THAT ENUMERATION
// IS THE BUG: the field nobody remembered to add to the list is precisely the
// field that skipped the transliteration.
//
// So this walks the payload STRUCTURALLY - every string reachable by anything
// JSON.stringify would emit, whatever it is called - and asserts the invariant
// the guard is actually written in:
//
//     Buffer.byteLength(s, "utf8") === s.length
//
// which for a JS string is exactly "pure ASCII": any code unit at or above 0x80
// costs at least two bytes, and a surrogate pair costs four for two units, so the
// equality can hold only when every unit is under 0x80.
//
// REPAIR *AND* LOG, and the reasoning for doing both rather than either.
//
//   Repairing alone would guarantee the device always gets drawable, budgetable
//   text - and would hide the upstream bug for as long as nobody looked, which is
//   how ask.voiceText survived for weeks.
//   Logging alone would preserve the evidence and ship the bad bytes once: on the
//   glass that is an invisible gap (both device fonts declare 0x20..0x7E, so an
//   out-of-range byte draws nothing and advances nothing), and in the budget it is
//   up to 3x the bytes a character cap claimed.
//   Neither half is optional, so this does both: the payload is repaired so the
//   device is safe, and the offending FIELD PATH is returned so the caller can say
//   which one it was. "Something was wrong" is a message nobody can act on, which
//   is the "healthy process doing no useful work" shape this repo has documented
//   repeatedly.
//
// WHAT REPAIRING COSTS, stated rather than glossed. There is exactly one field
// where a boundary repair is not free: `ask.voiceText`. The device signs
// HMAC(secret, "nonce:pid:TEXT:<sha16>") using the `voiceSha` the host SENT
// (sessions.ino builds that string from s.askVoiceSha verbatim - it does not
// re-hash what it displays), and the host verifies by re-hashing the transcript
// it still holds. So repairing here does not reject the answer: it delivers the
// PARKED text while the human read the repaired one. That divergence is exactly
// the transliteration - same words, ASCII punctuation - and it can only arise once
// the park site is ALREADY broken. The alternative, shipping it unrepaired, puts
// holes where every mark was on the one screen whose entire job is proving a human
// read those exact words, and truncates by BYTE into the device's char[204],
// possibly mid-codepoint. Repair is the lesser failure, and the log line names the
// field so the real bug is fixed rather than lived with.
//
// NOT A REPLACEMENT FOR THE CAP SITES. deviceText() still transliterates before it
// caps, because capping first lets an expansion ("..." from one ellipsis) grow back
// past the cap. This is a backstop, and a backstop that fires is a bug report.
//
// PURE: no fs, no clock, no I/O, no state - the same reason run-ledger.mjs,
// watchdog.mjs and wire-fit.mjs are, so host/wire-bytes-check.mjs can exercise
// every branch without a device or a tick. The EDGE-logging state lives in the
// caller, so a repeat offender does not write a line every 5 seconds and bury the
// tick lines it sits between.
import { toAscii } from "./to-ascii.mjs";

// A JSON payload is a tree, not a graph, and JSON.stringify throws on a cycle -
// but this runs BEFORE that stringify, inside the 5s poll loop, so it must
// terminate on its own rather than trust its input. A depth cap does that without
// a visited set. The real payload is 4 deep (sessions[i].ask.options[j]).
const MAX_DEPTH = 24;

// The invariant, spelled the way feedChar's guard is: BYTES.
const isAscii = (s) => Buffer.byteLength(s, "utf8") === s.length;

// Walk `node`, collecting the PATH of every string that violates the invariant,
// and return either `node` itself (nothing wrong, no copy made) or a repaired
// copy. Cloning is lazy and per level, so the overwhelmingly common clean tick
// pays one read-only traversal and allocates nothing - and the caller's objects
// are never mutated, since some of them are live state the next tick reuses.
function walk(node, path, offenders, depth) {
  if (depth > MAX_DEPTH) {
    // Refuse rather than recurse forever. Named like any other offender, because
    // an unchecked subtree is exactly as unproven as a failing one.
    offenders.push(`${path || "<root>"} [deeper than ${MAX_DEPTH} - not checked]`);
    return node;
  }
  if (typeof node === "string") {
    if (isAscii(node)) return node;
    offenders.push(path || "<root>");
    return toAscii(node);
  }
  if (node === null || typeof node !== "object") return node;   // number, boolean, undefined
  // What JSON.stringify would actually serialise. Without this a value hiding
  // behind toJSON() would reach the wire unwalked - a silent pass, which is the
  // one thing this file may not have.
  if (typeof node.toJSON === "function") {
    let raw;
    try { raw = node.toJSON(); } catch { return node; }
    const fixed = walk(raw, path, offenders, depth + 1);
    // Clean: hand back the ORIGINAL, so stringify does its own thing and no
    // payload that was already fine is rewritten. Dirty: hand back the repaired
    // plain value, which is what stringify would have produced anyway.
    return fixed === raw ? node : fixed;
  }
  if (Array.isArray(node)) {
    let out = node;
    for (let i = 0; i < node.length; i++) {
      const v = walk(node[i], `${path}[${i}]`, offenders, depth + 1);
      if (v !== node[i]) {
        if (out === node) out = node.slice();
        out[i] = v;
      }
    }
    return out;
  }
  let out = node;
  for (const k of Object.keys(node)) {
    const kp = path ? `${path}.${k}` : k;
    const v = walk(node[k], kp, offenders, depth + 1);
    // KEYS ARE ON THE WIRE TOO and count against the same 16000 bytes. A
    // non-ASCII key is already useless to the device - ArduinoJson looks up
    // literal ASCII names - so renaming it cannot lose anything a working device
    // was reading, and it stops the bytes being spent. A rename that would
    // COLLIDE is declined instead, because silently dropping a field to tidy a
    // key is worse than the key.
    let k2 = k;
    if (!isAscii(k)) {
      offenders.push(`${kp} [key]`);
      const cand = toAscii(k);
      if (cand && !Object.prototype.hasOwnProperty.call(node, cand)) k2 = cand;
    }
    if (v !== node[k] || k2 !== k) {
      if (out === node) out = { ...node };
      if (k2 !== k) delete out[k];
      out[k2] = v;
    }
  }
  return out;
}

// Assert the invariant over `payload`, repairing what violates it.
//
// Returns { payload, offenders }: `payload` is the original object when nothing
// was wrong (identical reference, not a copy) and a repaired copy otherwise;
// `offenders` is the list of field PATHS for the caller to log.
//
// TOTAL BY CONSTRUCTION: it never throws and never refuses. This runs in the 5s
// poll loop, where this repo has a documented class of "an await that never
// settled killed the loop forever" - so a bug in HERE must cost a log line, never
// a payload. An internal failure hands back the input untouched and says so;
// wire-fit.mjs still measures the real bytes afterwards, so the device's line
// guard is protected either way.
export function asciiFit(payload) {
  const offenders = [];
  try {
    return { payload: walk(payload, "", offenders, 0), offenders };
  } catch (e) {
    return { payload, offenders: [`<walk failed: ${e && e.message}>`] };
  }
}

// One line for the caller to log, naming the FIELDS. Capped, because a payload
// that is wrong everywhere would otherwise write a 16KB log line about it, and
// the count is what says how much was elided.
export function describeOffenders(offenders, max = 8) {
  const shown = offenders.slice(0, max).join(", ");
  return offenders.length > max ? `${shown} (and ${offenders.length - max} more)` : shown;
}
