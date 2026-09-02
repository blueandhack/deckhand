// Headless check of the USAGE v2 mock: it draws every (layout, state, theme)
// combination into field/card METADATA - never a canvas - and asserts the same
// four things the in-browser checker asserts (see usage.js's runChecks): every
// string is inside Spleen's 0x20..0x7E, the declared column sums to exactly
// K.CONTENT_ROWS and the drawn terms reproduce it, no clear box erases an
// earlier field's ink per glyph, and nothing crosses the tab bar or the footer.
//
// AND, SINCE THE MOCK IS COMMITTED AS THE NORMATIVE GEOMETRIC SPEC FOR THE
// SELECTED LAYOUT (B), that its K constants ARE the firmware's. A picture
// drawn from numbers nobody compares to the header is a spec that can go
// silently wrong while still reporting itself trustworthy - the same class of
// defect as an assertion that cannot fail. K is bound name-for-name to
// board_es3c35p.h through the geometry checkers' own consts(), so a header
// change the mock does not follow fails HERE, by name, with both numbers
// printed.
//
// AND, SINCE NO GLYPH ON THIS MOCK IS INVENTED, the font payload is re-verified
// against firmware headers and against the copy already committed under
// settings-redesign/ - not merely trusted because it once matched.
import fs from "node:fs";
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";
import { extract } from "./gfx-extract.mjs";

const D = new URL("./", import.meta.url).pathname;
const FW = new URL("../../../firmware/deckhand_display/", import.meta.url).pathname;

globalThis.document = { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ appendChild(){}, style:{}, getContext:() => null }) };
globalThis.addEventListener = () => {};

const src = fs.readFileSync(D+"spleenfonts.js","utf8") + fs.readFileSync(D+"usage.js","utf8")
  + "\nglobalThis.__X={SPLEEN_FONTS,K,WAS,STATES,LAYOUTS,P,chrome,runChecks};";
new Function(src)();
const { SPLEEN_FONTS, K, WAS, STATES, LAYOUTS, P, chrome, runChecks } = globalThis.__X;

let fail = 0, n = 0;
const chk = (c,m) => { n++; if (!c) { fail++; console.log("  FAIL "+m); } };

// ---- the fonts: re-extracted live, not merely trusted ---------------------
{
  const known = JSON.parse(fs.readFileSync(D+"../settings-redesign/spleenfonts.js","utf8")
    .replace(/^const SPLEEN_FONTS=/,"").replace(/;\s*$/,""));
  let glyphFail = 0, glyphN = 0;
  for (const [mine,ref] of [["Spleen8x16","Spleen8x16"],["Spleen12x24","Spleen12x24"]]) {
    const fresh = extract(`${FW}${mine}.h`, mine);
    chk(fresh.w===known[ref].w && fresh.h===known[ref].h,
      `${mine}: cell ${fresh.w}x${fresh.h} re-extracted, settings-redesign/spleenfonts.js says ${known[ref].w}x${known[ref].h}`);
    for (const cp of Object.keys(known[ref].glyphs)) {
      glyphN++;
      const a = JSON.stringify(fresh.glyphs[cp]), b = JSON.stringify(known[ref].glyphs[cp]);
      if (a!==b) { glyphFail++; if (glyphFail<=5) console.log(`  FAIL ${mine} 0x${(+cp).toString(16)} re-extracted ${a} != settings-redesign ${b}`); }
    }
  }
  n++; if (glyphFail) fail++;
  console.log(`  fonts: ${glyphN-glyphFail}/${glyphN} glyphs re-extracted from Spleen8x16.h/Spleen12x24.h `
    +`match ../settings-redesign/spleenfonts.js`);

  // Spleen32x64 has no third-party reference (README explains why), so this
  // asserts what a hero draws is PRESENT and every row fits its own width -
  // the same sanity check verify.mjs ran before this file existed.
  const hero = extract(`${FW}Spleen32x64.h`, "Spleen32x64", "0123456789%- ");
  const wantCps = [...new Set([..."0123456789%- "].map(c => c.codePointAt(0)))];
  chk(wantCps.every(cp => cp in hero.glyphs), "Spleen32x64: 0-9, %, -, space all present");
  const over = Object.values(hero.glyphs).filter(rows => rows.some(v => v >= Math.pow(2,hero.w)));
  chk(over.length===0, `Spleen32x64: every row fits its declared ${hero.w}px width`);
  // and the committed spleenfonts.js's own copy must agree with a fresh read -
  // the base36 packing is exercised, not merely present.
  for (const cp of wantCps) {
    const a = JSON.stringify(hero.glyphs[cp]), b = JSON.stringify(SPLEEN_FONTS.Spleen32x64.glyphs[String(cp)]);
    chk(a===b, `Spleen32x64 0x${cp.toString(16)}: committed spleenfonts.js matches a fresh extraction`);
  }
}

// ---- the mock against the header -------------------------------------------
// consts() is the parser the three geometry checkers use, so this reads the
// same values they certify rather than a second transcription of the header.
{
  const H = consts("deckhand_display.ino", consts("board_es3c35p.h"));
  // MAC_EMOJI_SIZE is a #define in an ART HEADER geom-common's consts() does not
  // parse for this file (only DeckhandLogo.h is in its ART_HEADERS list) - read
  // it directly, the same way sessions-geom-check.mjs already does per board.
  const mm = fs.readFileSync(`${FW}MacEmoji16.h`,"utf8").match(/#define\s+MAC_EMOJI_SIZE\s+(\d+)/);
  if (mm) H.MAC_EMOJI_SIZE = +mm[1];

  // Names with no header counterpart at all: the mock derives them (the same
  // way the device would, if it named them), so the DERIVATION is asserted
  // rather than a number - the same treatment settings-redesign/check.mjs
  // gives contentBottom().
  const DERIVED = new Set(["contentBottom","CONTENT_ROWS","LANE_X0","LANE_X1","LANE_W"]);
  let bound = 0;
  for (const [name,val] of Object.entries(K)) {
    if (DERIVED.has(name)) continue;
    if (!(name in H)) {
      chk(false, `K.${name} is not a constant board_es3c35p.h defines - either it is `
                +`misnamed, or it belongs in WAS with the panel it describes`);
      continue;
    }
    bound++;
    chk(H[name]===val, `K.${name} is ${val}, the firmware says ${H[name]}`);
  }
  chk(K.contentBottom===H.BOARD_H-H.FOOTER_H, `contentBottom ${K.contentBottom} == BOARD_H - FOOTER_H (${H.BOARD_H-H.FOOTER_H})`);
  chk(K.CONTENT_ROWS===K.contentBottom-H.CONTENT_Y, `CONTENT_ROWS ${K.CONTENT_ROWS} == contentBottom - CONTENT_Y (${K.contentBottom-H.CONTENT_Y})`);
  chk(K.LANE_X0===H.CARD_X+H.PAD, `LANE_X0 ${K.LANE_X0} == CARD_X + PAD (${H.CARD_X+H.PAD})`);
  chk(K.LANE_X1===H.CARD_X+H.CARD_W-H.PAD, `LANE_X1 ${K.LANE_X1} == CARD_X + CARD_W - PAD (${H.CARD_X+H.CARD_W-H.PAD})`);
  chk(K.LANE_W===K.LANE_X1-K.LANE_X0, `LANE_W ${K.LANE_W} == LANE_X1 - LANE_X0`);
  console.log(`  header bind: ${bound} of ${Object.keys(K).length-DERIVED.size} mock constants `
             +`checked against board_es3c35p.h, ${Object.keys(WAS).length} in WAS (the replaced panel)`);

  // WAS is the REPLACED panel's geometry and is deliberately unbound - a
  // before picture that tracked the header would stop being a before picture
  // the moment the header moved. Sharing a name with K is expected (the
  // redesign kept the name and moved the value); what must not happen is a
  // WAS entry that RECORDS NOTHING - one whose value the header (or K)
  // already gives, which is a duplicate free to drift and is how a live
  // constant gets parked out of the bind.
  for (const [name,val] of Object.entries(WAS)) {
    if (name in K) chk(WAS[name]!==K[name], `WAS.${name} is ${val}, the same as K.${name} - it records nothing and belongs in K`);
    else chk(!(name in H), `WAS.${name} is still a live constant (header says ${H[name]}) - it belongs in K`);
  }
}

// ---- the picture ------------------------------------------------------------
// Same assertions the in-browser checker makes (runChecks, in usage.js) -
// they live here too so the gate does not need a browser. Swept across every
// state and both themes, since a layout that only works at one selection is
// not a layout - and none of runChecks' four claims is colour-dependent, so
// LIGHT reproducing DARK's pass/fail set is itself an assertion.
{
  let darkTotal = 0, darkFail = 0, darkKnown = 0;
  for (const [sname, d] of Object.entries(STATES)) {
    let stateOk = 0, stateFail = 0, stateKnown = 0;
    for (const L of LAYOUTS) {
      const p = new P("DARK");
      chrome(p, d); L.draw(p, d);
      chk(p.ops.length>0 && typeof p.ops[0][0]==="string", `${L.title}/${sname}: op list populated with no canvas present`);
      const results = runChecks(L, p, d);
      for (const r of results) {
        n++; darkTotal++;
        if (r.ok) { stateOk++; }
        else if (r.known) { stateKnown++; darkKnown++; console.log(`  KNOWN  [${L.title}/${sname}] ${r.msg} (known defect in the baseline)`); }
        else { fail++; darkFail++; stateFail++; console.log(`  FAIL   [${L.title}/${sname}] ${r.msg}`); }
      }
    }
    console.log(`  state "${sname}": ${stateOk} pass${stateKnown?`, ${stateKnown} known defect(s) in the baseline`:""}${stateFail?`, ${stateFail} FAILING`:""}`);
  }
  console.log(`  picture (DARK, all states): ${darkTotal-darkFail} of ${darkTotal} pass, ${darkKnown} known-defect rows in the baseline`);

  // LIGHT: same claims, different theme. runChecks tests no colour, so a
  // divergence here would mean a draw call is theme-conditional in a way that
  // moves geometry - which would be its own bug.
  let lightTotal = 0, lightFail = 0;
  for (const [sname, d] of Object.entries(STATES)) for (const L of LAYOUTS) {
    const p = new P("LIGHT");
    chrome(p, d); L.draw(p, d);
    const results = runChecks(L, p, d);
    for (const r of results) { n++; lightTotal++; if (!r.ok && !r.known) { fail++; lightFail++; console.log(`  FAIL   [LIGHT ${L.title}/${sname}] ${r.msg}`); } }
  }
  chk(lightTotal===darkTotal, `LIGHT ran the same ${darkTotal} assertions DARK did (got ${lightTotal})`);
  console.log(`  picture (LIGHT, all states): ${lightTotal-lightFail} of ${lightTotal} pass`);
}

console.log(`\n${n-fail} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
