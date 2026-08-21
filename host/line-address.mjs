// BLECharacteristic::notify() sends to EVERY connected peer - there is no
// single-peer notify in that API - so with two Macs on one device each of them
// sees the other's answers. Without this filter the wrong Mac logs an
// authentication failure on every answer, which is the "trains you to ignore
// the line that matters" problem the duplicate-PROMPT dedup already exists for.
//
// Absence means BROADCAST, deliberately: BATT/HELLO are for everyone, and older
// firmware stamps nothing. An unparseable address also reads as broadcast -
// wrongly dropping an answer strands a blocked prompt, which is far worse than
// logging one line twice.
const ADDR = /\sto=([0-9a-fA-F]{1,16})$/;

export function lineTargetsUs(line, myHostId) {
  if (!myHostId) return true;
  const m = ADDR.exec(String(line || "").trimEnd());
  if (!m) return true;
  return m[1].toLowerCase() === String(myHostId).toLowerCase();
}

// Removes a trailing " to=<hex>" address token, if present, so every parser
// downstream of handleDeviceLine sees the line exactly as it looked before
// this feature existed. Every one of those parsers - ANSWER's positional
// destructuring, HISTORY's split, handleTypedPrompt's `parts.length !== 4` -
// predates addressing and was never taught about an extra trailing token;
// handleTypedPrompt's strict length check is what actually broke (every
// typed PROMPT was rejected as "malformed frame"), and the fix is to strip
// the address ONCE, centrally, so no future positional parser can be broken
// by it the same way. Shares ADDR with lineTargetsUs (not a second copy of
// the pattern) so the two can never disagree about what counts as an address.
export function stripAddress(line) {
  const s = String(line || "");
  const trimmed = s.trimEnd();
  const m = ADDR.exec(trimmed);
  if (!m) return s;
  return trimmed.slice(0, m.index);
}
