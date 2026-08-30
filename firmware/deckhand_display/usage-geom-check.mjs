// USAGE tab geometry checker - runs on the Mac, needs no hardware.
//
// WHY THIS EXISTS. The USAGE tab's layout is a pile of vertical offsets whose
// real constraint is not where the GLYPHS land but where each field's CLEAR BOX
// lands: drawIfChanged() paints fillRect(fx-1, fy-1, tw+2, th+2) before drawing
// and drawPaceBar() paints fillRect(x-1, y-4, w+2, h+8) to cover its tick's
// overhang, so a row one pixel too low rubs out the card border underneath it -
// which reads as a gap in the outline and NOT as anything that looks like an
// off-by-one. Board 1 shipped exactly that once. With two boards there are two
// sets of those offsets, both derived in their own board header, and re-deriving
// them by hand on every future change is how one of them drifts.
//
// It measures text the way the panel does rather than assuming 6px a character:
// it parses the two GFX font headers and reimplements TFT_eSPI's own rule (every
// character but the LAST is charged xAdvance; the last is charged xOffset + width,
// and those differ for 20 of Cozette's 95 glyphs). THAT IMPLEMENTATION IS ITSELF
// CHECKED FIRST, against the 136 widths text-widths-board2.txt records from the
// real panel - so a wrong measurement fails loudly instead of quietly blessing a
// wrong layout.
//
//   node usage-geom-check.mjs             check both boards
//   node usage-geom-check.mjs --selftest  prove the checker has teeth
//
// The --selftest is the same trick palette-check.mjs and bdf2gfx.py use: it
// nudges one board-2 offset by a single pixel and FAILS if that goes unnoticed.
// A checker nobody has seen reject anything is decoration.
// The textWidth implementation, the header parser and the panel table are shared
// with sessions-geom-check.mjs (geom-common.mjs) - one copy of the measurement
// rule, checked once against the device's own numbers.
import { consts, DIR, lineH, PANEL, preflight, textWidth } from "./geom-common.mjs";
import fs from "fs";
preflight();

// A generic GFXfont glyph-table parser and measurer, for the Spleen faces
// geom-common.mjs's textWidth()/FONTS table has no entry for - that module
// was written before board 2 had its own registry, and Cozette/Terminus are
// still its only fonts. Reused for both Spleen8x16 (board 2's T_BODY/T_META)
// and Spleen32x64 (board 2's T_HERO) rather than one-off copies, so the
// monospace check below is written and proven once.
function parseGfxFont(file) {
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
  const gl = src.slice(src.indexOf("Glyphs[]"));
  const rows = [...gl.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)];
  return rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5] }));
}
// Every Spleen face declares every glyph's xAdvance == width, xOffset == 0 -
// genuinely monospace, unlike Cozette (uniform xAdvance 6, but varying ink
// width/offset - see geom-common.mjs's own last-char rule, which exists
// because of that). Asserted rather than assumed: a regenerated font that
// broke monospacing would otherwise be trusted silently, and every Spleen
// caller below relies on it to skip the last-character special case.
function spleenWidth(glyphs, s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const g = glyphs[s.charCodeAt(i) - 0x20];
    if (!g) continue;
    if (g.xo !== 0 || g.w !== g.xa)
      throw new Error(`spleenWidth(): glyph 0x${(s.charCodeAt(i)).toString(16)} is no longer monospace - this needs the real last-char rule`);
    w += g.xa;
  }
  return w;
}
const SPLEEN8X16 = parseGfxFont("Spleen8x16.h");
const SPLEEN32X64 = parseGfxFont("Spleen32x64.h");
const spleenBodyWidth = (s) => spleenWidth(SPLEEN8X16, s);   // board 2's T_META/T_BODY
const spleenHeroWidth = (s) => spleenWidth(SPLEEN32X64, s);  // board 2's T_HERO

// T_META/T_BODY text (font id 1 or 2 - identical face on both boards),
// measured with whichever font the DEVICE actually draws it in: Cozette via
// geom-common.mjs's textWidth() on board 1, Spleen8x16 on board 2. This is
// the fix for the Codex-row lane bug's root cause - every "6px a character"
// assumption in this file predates board 2 having its own registry, and
// board 2 draws this face at 8px, not 6.
function bodyTextWidth(b, s) { return b === 1 ? textWidth(s, 2) : spleenBodyWidth(s); }
// The real per-board advance, MEASURED rather than named as a bare 6 or 8:
// textWidth("AA") - textWidth("A") is exactly one glyph's xAdvance, because
// only the LAST character in a string gets the xOffset+width treatment (see
// geom-common.mjs's own rule) - so the difference of two same-character
// strings cancels that out and leaves the plain advance, for either font,
// without reaching into either parser's internals to read it out directly.
function bodyAdvance(b) { return bodyTextWidth(b, "AA") - bodyTextWidth(b, "A"); }
// The same per-board split for T_HERO, which the WAITING SCREEN's wordmark uses
// (drawWaitingScreen calls setUIFont(T_HERO) with no CARD_HERO_SIZE override on
// either board, so this is the registry face at its registry size on both).
// Board 1: Cozette 12x26. Board 2: Spleen 32x64.
function heroTextWidth(b, s) { return b === 1 ? textWidth(s, 4) : spleenHeroWidth(s); }

// Parse UI_FONTS[] straight out of deckhand_display.ino's #if/#else pair,
// rather than hand-copying its cell heights into a literal table here - a
// bare {1:13, 2:16} object drifts silently the moment a font changes and
// nobody updates this file to match, which is exactly the defect class a
// checker exists to catch, not commit. LOGO_SIZE (above) is read from its
// header for the identical reason.
function parseUiFonts() {
  const src = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");
  // "#if BOARD_USES_TFT_ESPI" appears four times in this file (the tft
  // object itself, UI_FONTS[], and two more later on) - so this takes the
  // LAST such guard at or before UI_FONTS[] = {, not the first one in the
  // file, which belongs to an unrelated #if/#else a long way upstream.
  const fontsAt = src.indexOf("UI_FONTS[] = {");
  if (fontsAt < 0) throw new Error("parseUiFonts(): UI_FONTS[] = { not found at all");
  let ifStart = -1, idx = -1;
  while ((idx = src.indexOf("#if BOARD_USES_TFT_ESPI", idx + 1)) >= 0 && idx < fontsAt) ifStart = idx;
  const ifEnd = src.indexOf("#endif", ifStart);
  if (ifStart < 0 || ifEnd < 0 || ifEnd < fontsAt) throw new Error("parseUiFonts(): couldn't find the #if BOARD_USES_TFT_ESPI / #endif pair around UI_FONTS[]");
  const arms = src.slice(ifStart, ifEnd).split(/\n#else\b/);
  if (arms.length !== 2) throw new Error(`parseUiFonts(): expected exactly one #else inside that block, found ${arms.length - 1}`);
  const rowsOf = (arm) => {
    const at = arm.indexOf("UI_FONTS[] = {");
    if (at < 0) throw new Error("parseUiFonts(): UI_FONTS[] not found in one arm of the #if/#else");
    const body = arm.slice(at, arm.indexOf("};", at));
    const rows = [...body.matchAll(/\{\s*&\w+\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)].map(m => ({ size: +m[1], cellH: +m[2] }));
    if (rows.length !== 5) throw new Error(`parseUiFonts(): expected 5 UI_FONTS rows (indices 0..4), found ${rows.length}`);
    return rows;
  };
  return { 1: rowsOf(arms[0]), 2: rowsOf(arms[1]) };
}
const UI_FONTS = parseUiFonts();
// Index 2 is T_BODY (deckhand_display.ino: "const uint8_t T_BODY = 2"), and
// uiFontIdx() maps a font id straight onto its own array index - both boards'
// T_META (index 1) and T_BODY (index 2) rows are identical today, so either
// index would read the same cellH, but 2 is named to match what
// renderCodexRow() and the stats/foot rows actually pass as their font id.
const BODY_H = { 1: UI_FONTS[1][2].cellH, 2: UI_FONTS[2][2].cellH };
// Index 4 is T_HERO. Board 2's hero draws at this native cellH with no
// override (see drawBigNumber() in deckhand_display.ino) - board 1's does
// NOT, since its #if BOARD_USES_TFT_ESPI arm overrides tft.setTextSize() up
// one more mechanical step past its own registry entry (CARD_HERO_SIZE, 3,
// against the registry's size 2). So only board 2's parsed value is used
// directly below; board 1 keeps its own heroSize-based figure.
const HERO_H_NATIVE = { 1: UI_FONTS[1][4].cellH, 2: UI_FONTS[2][4].cellH };

// LOGO_SIZE is a #define rather than a const int, so it is read from the art
// header the same way settings-geom-check.mjs reads KB_MAX_BYTES out of the host -
// from the file that owns it, not from a number copied over here.
const LOGO_SIZE = +fs.readFileSync(`${DIR}/DeckhandLogo.h`, "utf8").match(/#define\s+LOGO_SIZE\s+(\d+)/)[1];

// --- board constants, parsed from the real source so this cannot drift ---
// The board header FIRST, then deckhand_display.ino seeded with it - the order the
// compiler sees, and the same order the two sibling checkers use. This file read the
// header ALONE until the waiting-screen assertions were added: every USAGE-tab
// offset is a header constant, but the WAIT_* column is derived in the .ino, and a
// checker that never parses that file cannot see it. No header constant is
// redefined there, so nothing this file already asserted moved.
const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };
const B = {};
for (const b of [1, 2]) B[b] = consts("deckhand_display.ino", consts(HDR[b]));

// BOARD 1'S CARD IS PACKED WITH NO SLACK AT ALL, and three of its bands' clear
// boxes therefore overlap their neighbour's. They are harmless in themselves -
// every one is inside the card and the later draw simply repaints over the
// earlier - with ONE known consequence, recorded here and in
// board_e32r28t.h: the stats row's clear reaches 3 rows into the pace bar's
// tick overhang, so a changing token count shaves the bottom of the tick until
// the bar next repaints. It is NOT fixed, deliberately: board 1's binary is held
// byte-identical across this port, and hiding a board-1 behaviour change inside a
// board-2 diff is worse than a 3px cosmetic artefact. Board 2's derivation leaves
// every band disjoint by 8px, so this list must stay board-1-only - a board-2
// entry appearing here means a layout change gave up the clearance rather than
// keeping it.
//
// THE TOLERATED GAP IS THE EXACT DOCUMENTED ONE, NOT "ANY OVERLAP", and it was a
// list of pair names until geom-sweep.mjs pointed out what that cost: a name-keyed
// allowance is magnitude-blind, so CARD_BAR_Y could move 16px in either direction
// on board 1 and the only assertions that noticed were these three, which tolerated
// whatever number came out. An allowance that absorbs an arbitrary amount of
// movement is not a documented shortfall, it is a hole with a comment over it.
// Keyed by the gap itself, a perturbed offset produces a different gap and fails.
const KNOWN_OVERLAPS = {
  1: {
    "hero box -> pace bar clear": -2,
    "pace bar clear -> stats clear": -3,
    "stats clear -> foot clear": -1,
  },
  2: {},
};

// ZERO, and it has to be kept that way DELIBERATELY - this is the number the
// selftest measures its own teeth against. An injected fault must produce MORE
// failures than already stand, or a blind checker passes its own selftest on the
// back of a pre-existing one. So a real failure left standing here silently
// weakens the selftest as well as reporting itself, and raising this number is
// never the way to make the suite green.
//
// It was briefly 1. The waiting-screen assertions below were added by
// geom-sweep.mjs's fault-injection pass - which perturbs every parsed constant
// and reports the ones no assertion reads - and they immediately found that the
// seven WAIT_* offsets were read by nothing at all. On board 2 that had let a
// real defect through: WAIT_LOGO_Y follows CONTENT_Y while the five offsets below
// it were board 1 literals, so the 96px logo ended at row 151 against a wordmark
// whose OPAQUE drawString box starts at 148 and the mark lost its bottom 4 rows.
// The whole column is now derived from its anchor in deckhand_display.ino and
// board 1's values are reproduced exactly, so this is back to 0.
// Worth keeping the story: the defect was invisible to every instrument the port
// had - a screenshot reads the same framebuffer, and no assertion mentioned the
// constants - which is the argument for the sweep existing at all.
const BASELINE_FAILURES = 0;
const SELFTEST = process.argv.includes("--selftest");
let fail = 0;
let known = 0, total = 0;
function chk(cond, msg, allow) {
  total++;
  if (!cond && allow) { known++; console.log(` known  ${msg}`); return; }
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) fail++;
}

if (SELFTEST) {
  // 8px lower and the foot row's clear box lands on the card's 2px border - the
  // exact defect board 1 shipped once. 8 rather than 1 because the real layout
  // leaves 7 rows of slack below the foot row deliberately, so a 1px nudge is
  // WITHIN spec and must not fail; 8 is the first offset that actually breaches
  // the ceiling. If this passes, the checker is blind.
  B[2].CARD_FOOT_Y += 8;
  console.log("--selftest: board 2's CARD_FOOT_Y pushed 8px down; the ceiling assertion MUST fail");
}

for (const b of [1, 2]) {
  const c = B[b], [W, H] = PANEL[b];
  console.log(`\n=== board ${b} (${W}x${H}) ===`);
  const contentBottom = H - c.FOOTER_H;
  const content = contentBottom - c.CONTENT_Y;
  console.log(`content area ${c.CONTENT_Y}..${contentBottom} = ${content}px`);
  chk(c.CARD_X + c.CARD_W + c.CARD_X === W, `card spans the width: ${c.CARD_X}+${c.CARD_W}+${c.CARD_X} = ${W}`);
  // column
  const colEnd = c.CODEX_Y + c.CODEX_H;
  const air = contentBottom - colEnd;
  chk(air > 0, `column ends at ${colEnd}, ${air}px of air above the footer (must be > 0)`);
  chk(c.CARD1_Y >= c.CONTENT_Y, `card1 starts at ${c.CARD1_Y} >= CONTENT_Y ${c.CONTENT_Y}`);
  chk(c.CARD2_Y >= c.CARD1_Y + c.CARD_H, `gap card1->card2 = ${c.CARD2_Y - (c.CARD1_Y + c.CARD_H)}`);
  chk(c.CODEX_Y >= c.CARD2_Y + c.CARD_H, `gap card2->codex = ${c.CODEX_Y - (c.CARD2_Y + c.CARD_H)}`);

  // --- bands inside a Claude card, as CLEAR boxes ---
  const heroSize = c.CARD_HERO_SIZE;              // board 1 only - undefined on board 2
  const bodyH = BODY_H[b];                        // T_BODY/T_META cell height, this board
  // Native height of the hero glyph itself (not CARD_HERO_H, the box it sits
  // in): board 1 is Cozette pushed to CARD_HERO_SIZE, board 2 is the flat 64
  // Task 2's interface promises (uiLineH(T_HERO) == 64, no size multiplier).
  const heroGlyphH = b === 1 ? 13 * heroSize : HERO_H_NATIVE[2];
  const heroWidth = b === 1 ? textWidth("100%", 4, heroSize) : spleenHeroWidth("100%");
  const bands = [
    ["pin bar", c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
    ["label", c.CARD_LABEL_Y, c.CARD_LABEL_Y + bodyH - 1],
    ["hero box", c.CARD_HERO_Y, c.CARD_HERO_Y + c.CARD_HERO_H - 1],
    ["pace bar clear", c.CARD_BAR_Y - 4, c.CARD_BAR_Y + c.BAR_H + 3],
    ["stats clear", c.CARD_STATS_Y - 1, c.CARD_STATS_Y + bodyH],
    ["foot clear", c.CARD_FOOT_Y - 1, c.CARD_FOOT_Y + bodyH],
  ];
  for (const [n, a, z] of bands) console.log(`    ${n.padEnd(15)} +${a}..+${z}`);
  const ceil = c.CARD_H - 3;
  const last = Math.max(...bands.map(x => x[2]));
  // Every card field's clear box must end at or before the ceiling - this is
  // already a whole-list check (bands.map), so it covers the hero, the pace
  // bar and the stats/foot rows in one assertion rather than one apiece.
  chk(last <= ceil, `nothing on the card ends past +${ceil} (2px border owns +${c.CARD_H - 2}..+${c.CARD_H - 1}); last band ends +${last}`);
  chk(c.CARD_LABEL_Y + bodyH - 1 < c.CARD_HERO_Y, `label row +${c.CARD_LABEL_Y}..+${c.CARD_LABEL_Y + bodyH - 1} clears the hero box starting +${c.CARD_HERO_Y}`);
  chk(c.CARD_PIN_BAR_Y >= 2, `pin bar +${c.CARD_PIN_BAR_Y} is inside the interior (border owns +0..+1)`);
  chk(c.CARD_PIN_BAR_Y + 2 < c.CARD_LABEL_Y, `pin bar clears the icon below it`);
  // hero glyph height, and its box against its two neighbours by name (the
  // band-overlap loop below also catches this generically, but the hero is
  // the one board-2 element whose size changed in this task, so it gets its
  // own named assertions rather than resting entirely on the generic sweep)
  chk(heroGlyphH <= c.CARD_HERO_H, `hero glyph ${heroGlyphH}px fits the ${c.CARD_HERO_H}px box`);
  // Board 1 ONLY: the general band-overlap loop below already covers this
  // pair for both boards, tolerating board 1's documented, pre-existing
  // "hero box -> pace bar clear" overlap (KNOWN_OVERLAPS[1]) via `allow`. This
  // is a plain hard assertion, so it is scoped to board 2 - the board this
  // task's native hero actually changed - rather than re-litigating a board-1
  // shortfall this task did not touch.
  if (b === 2) chk(c.CARD_HERO_Y + c.CARD_HERO_H - 1 < c.CARD_BAR_Y - 4,
      `hero box (ending +${c.CARD_HERO_Y + c.CARD_HERO_H - 1}) clears the pace bar's clear (starting +${c.CARD_BAR_Y - 4})`);
  chk(heroWidth <= c.CARD_W - 2 * c.PAD,
      `hero "100%" = ${heroWidth}px inside the ${c.CARD_W - 2 * c.PAD}px lane`);
  // band overlaps
  for (let i = 1; i < bands.length; i++) {
    const gap = bands[i][1] - bands[i - 1][2] - 1;
    const pair = `${bands[i - 1][0]} -> ${bands[i][0]}`;
    chk(gap >= 0, `${pair} gap ${gap} (negative = clear box eats its neighbour)`,
        KNOWN_OVERLAPS[b][pair] === gap);
  }
  // --- label row x-wise: label text vs the Mac icon ---
  // bodyTextWidth(), not textWidth(L, 1): this label is T_META, the same
  // face the Codex row's lane bug was in, and it was making the identical
  // Cozette-only assumption for board 2's real Spleen8x16 text. Hand-checked
  // before this fix: it never actually overflowed (222px real end against a
  // 277px icon start on board 2), so this was a checker inaccuracy, not
  // device corruption - fixed anyway since the infrastructure is now here.
  for (const L of ["SESSION - 5 HOUR WINDOW", "WEEK - 7 DAY, ALL MODELS"]) {
    const end = c.CARD_X + c.PAD + bodyTextWidth(b, L);
    const iconX = c.CARD_X + c.CARD_W - c.PAD - 13;
    chk(end < iconX, `"${L}" ends x=${end}, icon starts x=${iconX}`);
  }
  // --- Codex row bands ---
  const cb = [
    ["text clear", c.CODEX_TEXT_Y - 1, c.CODEX_TEXT_Y + bodyH],
    ["bar clear", c.CODEX_BAR_Y - 4, c.CODEX_BAR_Y + c.BAR_H + 3],
  ];
  for (const [n, a, z] of cb) console.log(`    codex ${n.padEnd(11)} +${a}..+${z}`);
  // text and bar must share no row, and the row must end at or before +53
  // (CODEX_H 56's 2px border owns +54..+55) - both already asserted, but
  // named explicitly since this is the pair the brief calls out by number.
  chk(cb[0][2] < cb[1][1], `codex text clear ends +${cb[0][2]} before bar clear starts +${cb[1][1]}`);
  chk(cb[1][2] <= c.CODEX_H - 3, `codex content ends +${cb[1][2]} <= +${c.CODEX_H - 3} (border owns +${c.CODEX_H - 2}..+${c.CODEX_H - 1})`);
  chk(cb[0][1] >= 2, `codex text clear starts +${cb[0][1]} inside the interior`);
  // --- the label lane, re-derived from a MEASURED per-board advance ---
  // THIS is where the lane overlap lived: both fields draw in font id 2
  // (T_BODY), Cozette on board 1 (uniform 6px xAdvance) and Spleen8x16 on
  // board 2 (uniform 8px, genuinely monospace - unlike Cozette, whose ink
  // widths vary even though its xAdvance doesn't). The header's own /6
  // formula was carried over unchanged into board 2's derivation, which is
  // exactly the "counted, not measured" bug this checker exists to catch and
  // instead blessed - bodyAdvance() below measures it instead of assuming it.
  const charW = bodyAdvance(b);
  const rightX = c.CARD_X + c.CARD_W - c.PAD;
  const rightW = c.CODEX_RIGHT_CHARS * charW;
  const clearFrom = rightX - rightW - 1;
  const labelX = c.CARD_X + c.PAD;
  const lane = Math.floor((clearFrom - labelX) / charW);
  chk(lane === c.CODEX_LANE_CHARS,
      `codex lane: right field at ${rightX} spans ${rightX - rightW}..${rightX}, clears from ${clearFrom}; label at ${labelX}; (${clearFrom}-${labelX})/${charW} = ${((clearFrom - labelX) / charW).toFixed(2)} -> ${lane}, header says ${c.CODEX_LANE_CHARS}`);
  chk(c.CODEX_LANE_CACHE >= c.CODEX_LANE_CHARS + 1,
      `lane cache ${c.CODEX_LANE_CACHE} holds ${c.CODEX_LANE_CHARS} chars + NUL`);
  // ONE buffer serves BOTH fields, and the larger one was never checked against it.
  // usage.ino declares `char buf[CODEX_LANE_CACHE]` once and both drawIfChanged
  // calls pass CODEX_LANE_CACHE as the cacheSize - the left field padded to
  // CODEX_LANE_CHARS, the RIGHT one padded to CODEX_RIGHT_CHARS, which is nearly
  // twice as long. Checking only the smaller of the two is exactly the "a cache
  // shorter than the string it stores silently stops noticing changes" trap this
  // repo has paid for repeatedly; board 1 passes by 3 (24 against 21), which is
  // margin nobody had asserted. NOTE this is the BUFFER-SIZE assertion only -
  // whether CODEX_RIGHT_CHARS is wide enough for its own CONTENT is a separate,
  // known defect (docs/board-1-known-defects.md #12) and is not what this checks.
  chk(c.CODEX_LANE_CACHE >= c.CODEX_RIGHT_CHARS + 1,
      `lane cache ${c.CODEX_LANE_CACHE} also holds the RIGHT field's ${c.CODEX_RIGHT_CHARS} chars + NUL (one buf serves both)`);
  // The label field is padded to CODEX_LANE_CHARS on every tick (padTo(), so
  // its own clear box is stable) - so THAT width, measured for real rather
  // than assumed as charW * CODEX_LANE_CHARS, is what must clear the right
  // field's own clear-from edge. A space string measures very slightly under
  // the naive count (the space glyph's last-character ink is narrower than
  // its advance), which only makes this margin more conservative, not less.
  const labelPaddedW = bodyTextWidth(b, " ".repeat(c.CODEX_LANE_CHARS));
  chk(labelX + labelPaddedW <= clearFrom,
      `codex label's padded width ${labelPaddedW}px (${c.CODEX_LANE_CHARS} chars) ends x=${labelX + labelPaddedW}, right field clears from ${clearFrom}`);
  // And against the ACTUAL longest strings renderCodexRow() can draw, not the
  // abstract padded-space case above - padTo() only ADDS trailing spaces, it
  // never truncates (see its own comment in deckhand_display.ino), so a
  // content string that is itself longer than CODEX_LANE_CHARS would sail
  // straight past the check above with nothing to catch it. These are every
  // snprintf template in renderCodexRow()'s label branches, at their longest
  // real arguments (a 2-digit hour count, and "studio" - the exact 6-
  // character worst case MULTITEST injects and macTag() can otherwise emit).
  for (const s of ["CODEX  23h", "CODEX  7d", "CX studio", "CX    23h"]) {
    const w = bodyTextWidth(b, s);
    chk(labelX + w <= clearFrom, `codex label "${s}" (${w}px) ends x=${labelX + w}, right field clears from ${clearFrom}`);
  }
  // codex icon slot
  const iconEnd = labelX + bodyTextWidth(b, "CX") + 4 + 13;
  chk(iconEnd < clearFrom, `codex icon ends x=${iconEnd}, right field clears from ${clearFrom}`);
  // --- footer lanes ---
  const y = 0;
  // bodyTextWidth(b, ...), NOT textWidth(s, 1). These three lanes were the last
  // board-agnostic measurements in this file: the footer draws font 1, which on
  // board 2 is Spleen 8x16, so every number here was understated by a third - the
  // clock reported 58px against a real 74. Nothing was actually overlapping (each
  // longest string was hand-verified), but a checker measuring the wrong face is
  // the exact drift these files exist to prevent, and the true margins are much
  // tighter than the old ones claimed: battery-to-freshness is 31px on board 2, not
  // 53. The same substitution follows for the tab bar and the waiting screen below.
  const clockEnd = 10 + bodyTextWidth(b, "12:34:56");
  const battEnd = c.FOOTER_BATT_TEXT_X + bodyTextWidth(b, "100%");
  const freshStart = W - 10 - bodyTextWidth(b, "stale 999m ");
  chk(clockEnd < c.FOOTER_BATT_X, `footer: clock ends ${clockEnd} < battery glyph ${c.FOOTER_BATT_X}`);
  chk(c.FOOTER_BATT_X + 21 <= c.FOOTER_BATT_TEXT_X, `footer: glyph box ${c.FOOTER_BATT_X}..${c.FOOTER_BATT_X + 20} clears text at ${c.FOOTER_BATT_TEXT_X}`);
  chk(battEnd < freshStart, `footer: battery text ends ${battEnd} < freshness starts ${freshStart}`);
  // BODY_H[b], not a literal 13: board 2's cell is 16 in a 20px band, so the band
  // is EXACTLY full at the +4 the draw uses - zero slack, where the literal
  // reported 7px of it.
  chk(4 + BODY_H[b] <= c.FOOTER_H,
      `footer band ${c.FOOTER_H} holds a ${BODY_H[b]}px line at +4`);
  // --- tab bar ---
  const tabW = Math.floor((W - c.TAB_REC_W) / 3);
  chk(bodyTextWidth(b, "SESSIONS") < tabW - 16,
      `tab label "SESSIONS" ${bodyTextWidth(b, "SESSIONS")}px inside a ${tabW}px tab`);
  const grp = 6 + 3 + bodyTextWidth(b, "REC");
  chk(grp <= c.TAB_REC_W, `REC group ${grp}px inside the ${c.TAB_REC_W}px slot`);

  // --- the STANDALONE WAITING SCREEN, which lives on this tab ---
  //
  // WHY IT IS CHECKED HERE. renderUsageTab bails on !everReceived and
  // drawWaitingScreen owns the content area instead, so this surface is the USAGE
  // tab's other half - and it is the FIRST thing anyone sees. Nothing measured it
  // until geom-sweep.mjs reported all seven WAIT_* offsets as read by no checker
  // at all.
  //
  // Every band is a TC_DATUM top plus a registry cell height, which on this
  // hardware is exactly what gets painted: board 2's drawString fills ONE opaque
  // box for the whole string before any glyph, from the y given down by
  // (ascent + descent) * size - so an overlapping band does not merely crowd its
  // neighbour, it ERASES it. The logo is 96px on both boards and is drawn FIRST,
  // so the wordmark below it wins any overlap.
  // The two named cell heights the column is DERIVED from, pinned against the
  // parsed UI_FONTS[] table. uiLineH() is not a constant expression, so the board
  // headers cannot static_assert this themselves - which makes it this checker's
  // job, and it is what stops a font swap silently moving five offsets.
  chk(c.HERO_LINE_H === UI_FONTS[b][4].cellH,
      `HERO_LINE_H ${c.HERO_LINE_H} is uiLineH(T_HERO)`);
  chk(c.CODE_LINE_H === BODY_H[b], `CODE_LINE_H ${c.CODE_LINE_H} is uiLineH(T_BODY)`);
  const wait = [
    ["logo", c.WAIT_LOGO_Y, c.WAIT_LOGO_Y + LOGO_SIZE - 1],
    ["wordmark", c.WAIT_NAME_Y, c.WAIT_NAME_Y + UI_FONTS[b][4].cellH - 1],
    ["device id", c.WAIT_ID_Y, c.WAIT_ID_Y + BODY_H[b] - 1],
    ["message 1", c.WAIT_MSG_Y, c.WAIT_MSG_Y + BODY_H[b] - 1],
    ["message 2", c.WAIT_MSG2_Y, c.WAIT_MSG2_Y + BODY_H[b] - 1],
    ["command panel", c.WAIT_CMD_Y, c.WAIT_CMD_Y + c.WAIT_CMD_H - 1],
  ];
  for (const [n, a, z] of wait) console.log(`    wait ${n.padEnd(14)} ${a}..${z}`);
  chk(wait[0][1] >= c.CONTENT_Y, `waiting screen starts ${wait[0][1]} at or below CONTENT_Y ${c.CONTENT_Y}`);
  for (let i = 1; i < wait.length; i++) {
    const gap = wait[i][1] - wait[i - 1][2] - 1;
    // THIS ASSERTION HAS NOW CAUGHT BOARD 2 TWICE, both times a real defect and
    // both times invisible to a reading of the source. First: WAIT_LOGO_Y followed
    // CONTENT_Y (44 -> 56) while the five offsets below it were board 1 literals,
    // so the logo ended at 151 against a wordmark box starting at 148. Fixed by
    // deriving them from the anchor. Second, found once this file started measuring
    // cell heights PER BOARD rather than through geom-common's Cozette-only
    // lineH(): the gaps between those derived offsets were themselves Cozette cells
    // plus air (32 = 26 + 6), so board 2's 64px T_HERO wordmark ran 160..223 over a
    // device name at 192 and a message line at 220. Fixed by deriving each gap from
    // HERO_LINE_H / CODE_LINE_H. A checker measuring the wrong face agrees with the
    // defect instead of catching it, which is why the substitution above matters
    // more than the pixel counts it changed.
    chk(gap >= 0, `wait: ${wait[i - 1][0]} -> ${wait[i][0]} gap ${gap} (negative = the later draw erases the earlier)`);
  }
  chk(wait[wait.length - 1][2] < contentBottom,
      `waiting column ends ${wait[wait.length - 1][2]}, inside contentBottom ${contentBottom} (${contentBottom - 1 - wait[wait.length - 1][2]}px spare)`);
  chk(BODY_H[b] + 4 <= c.WAIT_CMD_H,
      `command panel ${c.WAIT_CMD_H}px holds a ${BODY_H[b]}px line with 2px top and bottom`);
  // The real strings, from waitingMessage(): the widest of each kind.
  for (const t of ["open DeckhandBLE.app", "./install.sh"])
    chk(bodyTextWidth(b, t) <= c.CARD_W - 8,
        `command "${t}" ${bodyTextWidth(b, t)}px inside the ${c.CARD_W - 8}px panel lane`);
  for (const t of ["Waiting for the first update", "Connect USB to your Mac", "Start Deckhand on"])
    chk(bodyTextWidth(b, t) < W - 8, `waiting line "${t}" ${bodyTextWidth(b, t)}px inside the ${W}px panel`);
  chk(heroTextWidth(b, "DECKHAND") < W - 8,
      `wordmark ${heroTextWidth(b, "DECKHAND")}px inside the ${W}px panel`);
}
console.log(`\n${total} assertions, ${fail} failures, ${known} known-and-documented board-1 overlaps`);
if (SELFTEST) {
  if (fail <= BASELINE_FAILURES) {
    console.log(`SELFTEST FAILED: the checker did not notice a moved row ` +
                `(${fail} failure(s), and ${BASELINE_FAILURES} already stand without any fault injected)`);
    process.exit(1);
  }
  console.log(`selftest ok - the injected fault produced ${fail} failure(s)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all geometry assertions pass on both boards");
