// Run: node host/host-tag-check.mjs
// Imports nothing that touches CoreBluetooth, so plain node is safe here.
import { macTag, resolveMacTag } from "./host-tag.mjs";

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

// resolveMacTag(): the ORDER, and the cap on every source. The person's own name
// (the menu-bar's "Mac Name...") exists because the hostname guess collides: two
// MacBook Pros both read "pro", which is this repo's own two-Mac rig.
const R = (o) => JSON.stringify(resolveMacTag(o));
eq(R({ hostname: "Yujias-MacBook-Pro" }), JSON.stringify({ tag: "pro", source: "auto" }), "no name: the hostname's guess, marked auto");
eq(R({ hostname: "Yujias-MacBook-Pro", file: "home\n" }), JSON.stringify({ tag: "home", source: "name" }), "a name beats the hostname (file's newline stripped)");
eq(R({ hostname: "Yujias-MacBook-Pro", env: "work", file: "home" }), JSON.stringify({ tag: "work", source: "env" }), "DECKHAND_MAC_TAG beats the name, as it always beat the hostname");
eq(R({ hostname: "Yujias-MacBook-Pro", env: "!!", file: "home" }), JSON.stringify({ tag: "home", source: "name" }), "an env that sanitises to nothing pins nothing");
eq(R({ hostname: "Yujias-MacBook-Pro", file: "  " }), JSON.stringify({ tag: "pro", source: "auto" }), "a blank name file is no name");
for (const src of [{ env: "Longer Than Six" }, { file: "Longer Than Six" }, { hostname: "a-Longerthansix" }])
  eq(resolveMacTag(src).tag.length <= 6, true, `capped at 6 from ${Object.keys(src)[0]}`);
eq(resolveMacTag({ file: "Home Mac" }).tag, "homema", "a name is sanitised as a WHOLE, never split like a hostname");

console.log(failed ? `host-tag: ${failed} FAILED` : "host-tag: all checks passed");
process.exit(failed ? 1 : 0);
