// Run: node host/mac-emoji-check.mjs
// Imports nothing that reaches CoreBluetooth, so plain node is safe here.
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

console.log(failed ? `mac-emoji: ${failed} FAILED` : "mac-emoji: all checks passed");
process.exit(failed ? 1 : 0);
