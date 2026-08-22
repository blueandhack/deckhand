// Run: node host/mac-emoji-check.mjs
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacEmoji, MAC_EMOJI_NAMES } from "./mac-emoji.mjs";

let failed = 0;
const eq = (got, want, what) => {
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  failed++;
};

eq(MAC_EMOJI_NAMES.length, 16, "sixteen names");
eq(MAC_EMOJI_NAMES[0], "rocket", "first name is rocket, matching the header's order");

// The env var is the provisioning path and must win: a deliberately-set plist value
// cannot be silently overridden by a stray click in the menu bar.
eq(resolveMacEmoji({ env: "moon", file: "star" }), "moon", "env beats file");
eq(resolveMacEmoji({ env: "", file: "star" }), "star", "file used when env is unset");
eq(resolveMacEmoji({ env: "", file: "" }), "", "nothing set yields nothing");

// An unknown name must resolve to "" so the device falls back to the TEXT tag. Sending
// it through would leave the device with no icon and no text.
eq(resolveMacEmoji({ env: "banana", file: "" }), "", "unknown name is rejected");
eq(resolveMacEmoji({ env: "banana", file: "moon" }), "moon", "a bad env falls through to a good file");

eq(resolveMacEmoji({ env: "ROCKET", file: "" }), "rocket", "case-insensitive");
eq(resolveMacEmoji({ env: "  moon \n", file: "" }), "moon", "whitespace trimmed");
eq(resolveMacEmoji({ env: null, file: undefined }), "", "null and undefined are safe");
// The emoji CHARACTER is never a valid value: only names cross the wire.
eq(resolveMacEmoji({ env: "\u{1F680}", file: "" }), "", "an emoji character is not a name");

// ---------------------------------------------------------------------------
// The THREE name tables must agree, and nothing else in this repo notices when
// they don't. The list exists three times in three languages: the generated C
// header (canonical - the device can only draw what is in it), this directory's
// JS module (the only Mac-side validator), and the Swift menu bar's display
// order. A name present on the Mac and absent from the header resolves fine on
// the host, crosses the wire, and then shows as NO ICON AT ALL on the device -
// no error on either side. A name in the header that Swift never lists is
// simply unpickable. Both failures are silent, which is why this is a check
// and not a comment asking people to be careful.
//
// Parsed out of the file TEXT rather than imported: two of the three are a C
// header and a Swift source that this process cannot load, and reading all
// three the same way keeps one failure message shape for all of them.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// Pull the bracketed initialiser that follows `marker`, then take every
// double-quoted token inside it. Comments BEFORE the list are excluded by
// anchoring on the marker (mac-emoji.mjs's own comment mentions "robot", the
// name that was dropped for reading as a cupcake at 13px - a laxer regex would
// pick that up and report a phantom divergence).
function namesFrom(rel, marker, open, close) {
  const text = readFileSync(path.join(REPO, rel), "utf8");
  const at = text.indexOf(marker);
  if (at < 0) return { rel, err: `could not find ${marker}` };
  const start = text.indexOf(open, at);
  const end = text.indexOf(close, start);
  if (start < 0 || end < 0) return { rel, err: `could not find the ${open}...${close} list after ${marker}` };
  const names = [...text.slice(start, end).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (!names.length) return { rel, err: `found ${marker} but no quoted names in it` };
  return { rel, names };
}

const tables = [
  namesFrom("firmware/deckhand_display/MacEmoji.h", "MAC_EMOJI_NAMES[MAC_EMOJI_COUNT]", "{", "}"),
  namesFrom("host/mac-emoji.mjs", "export const MAC_EMOJI_NAMES", "[", "]"),
  namesFrom("mac-app/DeckhandMenuBar.swift", "let MAC_ICON_NAMES", "[", "]"),
];
const canonical = tables[0];

for (const t of tables) {
  if (t.err) {
    console.error(`FAIL ${t.rel}: ${t.err} - the parser, not the list, may be what broke`);
    failed++;
  }
}

// The JS table is the one this process CAN load, so compare the parsed form
// against the imported one. If they differ, the regex above is reading
// something stale and every other comparison here is worthless - a broken
// parser must fail loudly rather than pass three empty lists against each other.
if (!tables[1].err) {
  eq(tables[1].names.join(","), MAC_EMOJI_NAMES.join(","),
     "the parsed host/mac-emoji.mjs list matches the imported one (parser sanity)");
}

if (!canonical.err) {
  eq(canonical.names.length, 16, "MacEmoji.h lists sixteen names");
  for (const t of tables.slice(1)) {
    if (t.err) continue;
    if (t.names.join(",") === canonical.names.join(",")) continue;
    // Say WHICH file disagrees and HOW, both directions: a name the device
    // cannot draw is the dangerous half (no icon, no error), a name the device
    // has but this file omits is merely unreachable.
    const missing = canonical.names.filter((n) => !t.names.includes(n));
    const extra = t.names.filter((n) => !canonical.names.includes(n));
    const detail = [];
    if (extra.length) detail.push(`has names MacEmoji.h does not: ${extra.join(", ")} (these would show as NO icon on the device)`);
    if (missing.length) detail.push(`is missing names MacEmoji.h has: ${missing.join(", ")} (unreachable from this file)`);
    // Order-only divergence is NOT itself a display bug - the wire carries the
    // name, never an index - so say so rather than implying a broken icon. It
    // still fails: the three lists are hand transcriptions of one another, an
    // order that has drifted means one was edited without the others, and a
    // set-only comparison is the assertion that rots (it would pass a list
    // nobody re-transcribed right up until the day a name changed with it).
    if (!detail.length)
      detail.push(`lists the same sixteen names in a different ORDER (not a display bug on its own - the wire carries the name, not an index - but one list was edited without the other): ${t.names.join(",")} vs ${canonical.names.join(",")}`);
    console.error(`FAIL ${t.rel} disagrees with firmware/deckhand_display/MacEmoji.h: ${detail.join("; ")}`);
    failed++;
  }
}

console.log(failed ? `mac-emoji: ${failed} FAILED` : "mac-emoji: all checks passed");
process.exit(failed ? 1 : 0);
