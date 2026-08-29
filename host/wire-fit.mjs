// THE HOST REFUSES TO SEND A LINE THE DEVICE CANNOT RECEIVE.
//
// feedChar() appends each byte to an Arduino String and, past 16000 BYTES,
// CLEARS THE WHOLE BUFFER MID-LINE. The remainder of that same line then
// accumulates into the emptied buffer, processCompletedLine() gets a JSON
// fragment, handleLine() returns early on the parse error, and every tick
// carrying the offending prompt is lost - so the screen freezes at its last good
// state for as long as that prompt is pending, while both links, both heartbeats
// and both menu bars look perfectly healthy. Nothing on either side logs why.
//
// host/to-ascii.mjs removed the 3x char/byte multiplier that made this reachable
// with ordinary text. THIS file is the part that does not depend on being right
// about every future field: whatever the payload turns out to contain, the host
// measures the line it is about to write and refuses to write an over-guard one.
// It therefore also covers the case nothing else can - a STALE HOOK still
// installed in ~/.claude, emitting untransliterated text until someone runs
// install.sh.
//
// A checker assertion protects a future developer. This protects the device.
//
// PURE: no fs, no clock, no I/O, for the same reason run-ledger.mjs and
// watchdog.mjs are - so host/wire-bytes-check.mjs can exercise every tier of it
// without a device, a transcript or a tick.

// feedChar() guards `buf.length() > 16000`, so a line of exactly 16000 bytes is
// FINE and 16001 is not. The trailing "\n" is NOT part of it: feedChar dispatches
// on '\n' before appending, so the newline never reaches the buffer.
//
// Transcribed here because the host cannot parse the firmware at runtime;
// host/wire-bytes-check.mjs parses the real value out of deckhand_display.ino and
// asserts this constant still equals it, which is the same "parse, never
// transcribe" discipline the geometry checkers use.
export const DEVICE_LINE_GUARD_BYTES = 16000;

// What replaces a dropped detail. The prompt stays on screen and stays
// ANSWERABLE - only the body it could not fit is gone - and it says where to read
// it, the same idiom the read-only ask path already uses. ASCII, obviously, and
// short enough that dropping never makes the line bigger.
const DETAIL_DROPPED = "[too long for the display - read it on your Mac]";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const DROPPED_BYTES = bytes(DETAIL_DROPPED);

// Serialise `payload` and, if the result would overrun the device's line buffer,
// shed the largest things until it fits. Returns { line, bytes, was, dropped }:
// `bytes` is what is being sent, `was` what it would have been, and `dropped` a
// list of human-readable notes for the caller to LOG - a silent truncation would
// be the same class of defect as the freeze it prevents.
//
// The tiers are ordered by what costs least to lose:
//   1. the largest ask.detail, repeatedly. It is the one field that can be 1400
//      characters, and the prompt survives without it.
//   2. optDescs, largest first. Descriptions explain options; the options remain.
//   3. whole sessions off the TAIL. The list arrives urgency-sorted, so the tail
//      is the least urgent, and an `asking` row dropped this way is counted into
//      hiddenAsking - which is exactly the field that exists to say what was cut.
// Tier 3 is what makes this TOTAL rather than merely likely: a payload with no
// sessions is a few hundred bytes, so the loop always terminates under the guard.
export function fitPayload(payload, guard = DEVICE_LINE_GUARD_BYTES) {
  const dropped = [];
  let obj = payload;
  let line = JSON.stringify(obj);
  const was = bytes(line);
  if (was <= guard) return { line: line + "\n", bytes: was, was, dropped };

  // Only clone once we know we have to change something: the overwhelmingly
  // common path must not pay for a deep copy of every tick.
  obj = JSON.parse(line);
  const sessions = () => (Array.isArray(obj.sessions) ? obj.sessions : []);

  const largest = (pick) => {
    let best = -1, bestLen = 0;
    sessions().forEach((s, i) => {
      const v = pick(s);
      const len = v == null ? 0 : bytes(typeof v === "string" ? v : JSON.stringify(v));
      if (len > bestLen) { bestLen = len; best = i; }
    });
    return best;
  };

  // Tier 1. BOUNDED by the session count rather than `for(;;)`: each pass retires
  // one distinct session's detail, so n passes is a termination PROOF. This loop
  // runs inside the 5s tick, and a spin here would be far worse than the freeze it
  // exists to prevent - a bug that made `largest` keep returning the same index
  // hung a fault-injection run for exactly that reason.
  for (let k = 0; k <= sessions().length; k++) {
    line = JSON.stringify(obj);
    if (bytes(line) <= guard) break;
    // Only details LONGER than the marker are candidates: replacing a short one
    // would make the line BIGGER, which is the opposite of the job, and would log
    // a "dropped 1 bytes" line that reads as nonsense.
    const i = largest((s) => {
      const d = s.ask?.detail;
      return typeof d === "string" && d !== DETAIL_DROPPED && bytes(d) > DROPPED_BYTES ? d : null;
    });
    if (i < 0) break;
    const was = bytes(sessions()[i].ask.detail);
    sessions()[i].ask.detail = DETAIL_DROPPED;
    dropped.push(`ask.detail of session ${sessions()[i].id ?? i} (${was} bytes)`);
  }
  // Tier 2, bounded the same way.
  for (let k = 0; k <= sessions().length; k++) {
    line = JSON.stringify(obj);
    if (bytes(line) <= guard) break;
    const i = largest((s) => s.ask?.optDescs ?? null);
    if (i < 0) break;
    const was = bytes(JSON.stringify(sessions()[i].ask.optDescs));
    delete sessions()[i].ask.optDescs;
    dropped.push(`ask.optDescs of session ${sessions()[i].id ?? i} (${was} bytes)`);
  }
  // Tier 3
  while (sessions().length) {
    line = JSON.stringify(obj);
    if (bytes(line) <= guard) break;
    const gone = obj.sessions.pop();
    // hiddenAsking is the device's own "and there were more" counter, so a row
    // shed here has to be added to it rather than simply vanishing.
    if (gone?.status === "asking") obj.hiddenAsking = (obj.hiddenAsking ?? 0) + 1;
    dropped.push(`session ${gone?.id ?? "?"} (${gone?.status ?? "?"}) off the tail`);
  }
  line = JSON.stringify(obj);
  return { line: line + "\n", bytes: bytes(line), was, dropped };
}
