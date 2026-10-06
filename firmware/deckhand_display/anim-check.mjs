#!/usr/bin/env node
// anim-check.mjs - board 2's animation core and press feedback (piece 1 of 3).
// docs/superpowers/specs/2026-10-05-board2-anim-core-tap-feedback-design.md, Section 3.
//
// Every assertion reads the firmware's OWN text and transcribes nothing, and each is
// bound to a FUNCTION BODY rather than to a file, so a neighbouring line cannot
// satisfy it. --selftest re-execs this file once per source fault (geom-common's
// sweepSourceFaults) and passes only if every fault is caught BY the assertion it
// was written for.
import { readSource, fnBody, setSourceFault, SOURCE_FAULT_INDEX, faultChildEpilogue,
         sweepSourceFaults } from "./geom-common.mjs";

// [name, file, mutate, expect] - `expect` is a substring of the assertion that must
// catch it. Mutations are functions over the file's text, never transcribed lines.
const FAULTS = [
  ["flush forgets the overlay", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::flush\(\)[\s\S]*?)overlayCovers\(/, "$1overlayGone("),
   "flush()'s OWN BODY composites the press layer"],
  ["readRect forgets the overlay", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::readRect\([\s\S]*?)overlayCovers\(/, "$1overlayGone("),
   "readRect()'s OWN BODY applies the press layer"],
  ["markDirty without the watch", "panel_shim.cpp",
   (t) => t.replace(/_watchHit = true;/, ";"),
   "markDirty()'s OWN BODY runs the watch test"],
  ["setOverlay trips the watch", "panel_shim.cpp",
   (t) => t.replace(/(void PanelShim::setOverlay\([\s\S]*?)extendDirty\(/, "$1markDirty("),
   "setOverlay's OWN BODY marks through extendDirty"],
];

if (SOURCE_FAULT_INDEX >= 0) {
  const f = FAULTS[SOURCE_FAULT_INDEX];
  setSourceFault(f[1], f[2]);
}
if (process.argv.includes("--selftest")) {
  process.exit(sweepSourceFaults(import.meta.url, FAULTS) ? 0 : 1);
}

let fails = 0;
function chk(ok, msg) {
  if (ok) console.log(`  ok   ${msg}`);
  else { fails++; console.log(`  FAIL ${msg}`); }
}
const strip = (s) => s.replace(/^[ \t]*\/\/.*$/gm, "");

// ---- (3)/(4) the flush-time overlay and the watch: panel_shim.cpp ----
{
  const SHIM = strip(readSource("panel_shim.cpp"));
  const flushB = fnBody(SHIM, "void PanelShim::flush()", "panel_shim.cpp");
  chk(/overlayCovers\(/.test(flushB) && /_ovTint/.test(flushB),
      "flush()'s OWN BODY composites the press layer on the way out - the tint never lives in the framebuffer");
  const rrB = fnBody(SHIM, "void PanelShim::readRect(", "panel_shim.cpp");
  chk(/overlayCovers\(/.test(rrB),
      "readRect()'s OWN BODY applies the press layer, so SCREENSHOT shows what was pushed to the glass");
  const mdB = fnBody(SHIM, "void PanelShim::markDirty(", "panel_shim.cpp");
  chk(/_watchHit = true;/.test(mdB),
      "markDirty()'s OWN BODY runs the watch test - every primitive that dirties a rect can trip it");
  for (const sig of ["void PanelShim::setOverlay(", "void PanelShim::clearOverlay("]) {
    const b = fnBody(SHIM, sig, "panel_shim.cpp");
    const name = sig.slice("void PanelShim::".length, -1);
    chk(/extendDirty\(/.test(b) && !/markDirty\(/.test(b),
        `${name}'s OWN BODY marks through extendDirty, not markDirty - the overlay is not content and must not trip the watch`);
  }
}

faultChildEpilogue();
console.log(fails ? `\n${fails} assertion(s) FAILED` : "\nanim-check: all assertions pass");
process.exit(fails ? 1 : 0);
