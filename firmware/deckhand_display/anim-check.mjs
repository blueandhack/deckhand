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
  ["cubic table steps back", "anim.ino",
   (t) => t.replace(/(EASE_OUT_CUBIC\[33\]\s*=\s*\{\s*0,\s*)93,/, "$1999,"),
   "EASE_OUT_CUBIC never decreases"],
  ["back table has no overshoot", "anim.ino",
   // EVERY entry clamped, not just the peak: the entries beside it (1105, 1104)
   // are an overshoot too, and a fault that leaves them proves nothing.
   (t) => t.replace(/(EASE_OUT_BACK\[33\]\s*=\s*\{)([^}]*)\}/,
                    (m, head, body) => head + body.replace(/\d+/g, (v) => String(Math.min(+v, 1024))) + "}"),
   "EASE_OUT_BACK overshoots by ~8%"],
  ["flag is a const int", "board_es3c35p.h",
   (t) => t.replace(/#define BOARD_HAS_ANIM\s+1/, "const int BOARD_HAS_ANIM = 1;"),
   "board 2: BOARD_HAS_ANIM is a #define"],
  ["anim.ino draws into the framebuffer", "anim.ino",
   (t) => t.replace(/void animSetAlpha\(uint8_t a\) \{/, "void animSetAlpha(uint8_t a) { tft.fillRect(0, 0, 1, 1, 0);"),
   "anim.ino writes nothing into the framebuffer"],
  ["loop forgets animTick", "deckhand_display.ino",
   (t) => t.replace(/#if BOARD_HAS_ANIM\s*\n\s*animTick\(\);\s*\n\s*#endif\s*\n/, ""),
   "loop()'s OWN BODY calls animTick()"],
  ["lift trusts a stale surface", "anim.ino",
   (t) => t.replace(/if \(surfaceMoved \|\| !sameRect\)/, "if (false)"),
   "pressLift()'s OWN BODY re-checks"],
  ["session rect guessed by division", "sessions.ino",
   (t) => t.replace(/(bool sessionsPressRect\([\s\S]*?)sessionRowAtY\(sy\)/, "$1((sy - SESSION_ROW_Y0) / SESSION_SCROLL_STEP)"),
   "sessionsPressRect's OWN BODY"],
  ["action row gap transcribed", "deckhand_display.ino",
   (t) => t.replace(/const int gap = UI_ACT_GAP,/, "const int gap = 8,"),
   "uiActionRow's OWN BODY takes its gap from UI_ACT_GAP"],
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

// ---- (1) easing, (2) flag form, (3) anim.ino draws nothing, loop() ticks it ----
{
  const ANIM_S = strip(readSource("anim.ino"));
  const table = (name) => {
    const m = ANIM_S.match(new RegExp(`${name}\\[33\\]\\s*=\\s*\\{([^}]*)\\}`));
    return m ? m[1].split(",").map((v) => v.trim()).filter((v) => v !== "").map(Number) : [];
  };
  const cub = table("EASE_OUT_CUBIC"), back = table("EASE_OUT_BACK");
  chk(cub.length === 33 && back.length === 33,
      `both easing tables have 33 entries (cubic ${cub.length}, back ${back.length})`);
  chk(cub[0] === 0 && cub[32] === 1024,
      `EASE_OUT_CUBIC starts at 0 and ends at 1024 (${cub[0]}..${cub[32]})`);
  chk(cub.length === 33 && cub.every((v, i) => i === 0 || v >= cub[i - 1]),
      "EASE_OUT_CUBIC never decreases - an ease-out that steps backwards is a visible stutter");
  const peak = back.length ? Math.max(...back) : 0;
  chk(back[0] === 0 && back[32] === 1024,
      `EASE_OUT_BACK starts at 0 and settles at 1024 (${back[0]}..${back[32]})`);
  chk(peak >= 1070 && peak <= 1130,
      `EASE_OUT_BACK overshoots by ~8%: peak ${peak} in [1070, 1130]`);

  for (const [b, file, want] of [["board 1", "board_e32r28t.h", "0"], ["board 2", "board_es3c35p.h", "1"]]) {
    const h = strip(readSource(file));
    const m = h.match(/^\s*#define\s+BOARD_HAS_ANIM\s+(\d+)/m);
    chk(!!m, `${b}: BOARD_HAS_ANIM is a #define - an #if on a const int is silently false`);
    chk(!/const\s+int\s+BOARD_HAS_ANIM/.test(h), `${b}: BOARD_HAS_ANIM is never a const int`);
    chk(m && m[1] === want, `${b}: BOARD_HAS_ANIM is ${want} - the press layer is board 2's alone (spec, Scope)`);
  }

  const DRAW = /\btft\.(fillRect|fillScreen|pushImage|drawPixel|drawString|drawFastHLine|drawFastVLine|drawRect|fillSmooth\w*|drawSmooth\w*|fillTriangle|scrollRect)\(|\bui[A-Z]\w*\(/g;
  const draws = [...ANIM_S.matchAll(DRAW)].map((m) => m[0]);
  chk(draws.length === 0,
      `anim.ino writes nothing into the framebuffer - the press layer is composited at flush time (found: ${draws.join(" ") || "none"})`);

  const MAIN = strip(readSource("deckhand_display.ino"));
  const loopB = fnBody(MAIN, "void loop()", "deckhand_display.ino");
  chk(/#if BOARD_HAS_ANIM\s*\n\s*animTick\(\);\s*\n\s*#endif/.test(loopB),
      "loop()'s OWN BODY calls animTick() under #if BOARD_HAS_ANIM - board 1 never sees the call");
}

// ---- (6) no stale taps; every lit rect comes from its handler's own geometry ----
{
  const ANIM_S = strip(readSource("anim.ino"));
  const liftB = fnBody(ANIM_S, "bool pressLift()", "anim.ino");
  chk(/const bool surfaceMoved = pressSurfaceSig\(\) != pressSig;/.test(liftB) &&
      /pressRectAt\(pressX, pressY, r\)/.test(liftB) &&
      /if \(surfaceMoved \|\| !sameRect\)/.test(liftB),
      "pressLift()'s OWN BODY re-checks the surface and the control under the press point before acting - acting on lift must never act on a control nobody pressed");
  const bind = [
    ["sessions.ino", "bool sessionsPressRect(", [/sessionRowAtY\(sy\)/, /sessionRowYAt\(/, /sessionRowHAt\(/]],
    ["sessions.ino", "bool askPressRect(", [/askOptionsTop\(detailIndex\)/, /ASK_OPT_H \+ ASK_OPT_GAP/]],
    ["projects.ino", "bool projPressRect(", [/projRowAtY\(sy\)/, /psessRowAtY\(sy\)/]],
    ["settings.ino", "bool settingsPressRect(", [/settingsHomeRowY\(i\)/, /CFM_YES_X/]],
    ["compose.ino", "bool composePressRect(", [/composeActX\[i\]/, /UI_ACT_GAP/]],
  ];
  for (const [file, sig, res] of bind) {
    const b = fnBody(strip(readSource(file)), sig, file);
    const name = sig.slice(5, -1);
    chk(res.every((re) => re.test(b)),
        `${name}'s OWN BODY takes its rect from the same helpers its handler hit-tests with - the lit control is the one the tap reaches`);
  }
  const MAIN = strip(readSource("deckhand_display.ino"));
  const rowB = fnBody(MAIN, "int uiActionRow(", "deckhand_display.ino");
  chk(/const int gap = UI_ACT_GAP,/.test(rowB),
      "uiActionRow's OWN BODY takes its gap from UI_ACT_GAP - composePressRect subtracts the same constant, so the lit rect cannot drift off the drawn button");
}

faultChildEpilogue();
console.log(fails ? `\n${fails} assertion(s) FAILED` : "\nanim-check: all assertions pass");
process.exit(fails ? 1 : 0);
