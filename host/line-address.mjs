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
