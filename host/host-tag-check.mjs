// Run: node host/host-tag-check.mjs
// Imports nothing that touches CoreBluetooth, so plain node is safe here.
import { macTag } from "./host-tag.mjs";

let failed = 0;
const eq = (got, want, what) => {
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  failed++;
};

// The distinguishing part of an Apple default hostname is the LAST segment:
// two Macs owned by one person differ in "Air" vs "Studio", never in "Yujias".
eq(macTag("Yujias-MacBook-Air.local"), "air", "apple laptop hostname");
eq(macTag("Yujias-Mac-Studio"), "studio", "apple desktop hostname");
eq(macTag("mac-mini.local"), "mini", "two-segment hostname");
eq(macTag("deckhand"), "deckha", "single segment is capped at 6");
eq(macTag("Bob's Mac"), "mac", "spaces split, apostrophe stripped");
eq(macTag(""), "", "no hostname yields no tag");
eq(macTag("Yujias-MacBook-Air", "studio-b"), "studio", "override wins and is capped");
eq(macTag("host", "  "), "host", "blank override falls through");
eq(macTag("Mac-Studio-B"), "b", "a hostname's last segment is taken even when it is one character");
// A tag rides in EVERY payload and is drawn in a measured lane, so an
// over-long value is a layout bug rather than a cosmetic one.
eq(macTag("Yujias-Extremely-Longnamedmachine").length <= 6, true, "always <= 6");

console.log(failed ? `host-tag: ${failed} FAILED` : "host-tag: all checks passed");
process.exit(failed ? 1 : 0);
