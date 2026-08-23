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

// BOARD 2's T_BODY/T_META/T_HERO cell heights, from the interface the font-
// registry task (Task 2) produced and this task consumes verbatim:
// uiLineH(T_BODY) == 16, uiLineH(T_HERO) == 64. geom-common.mjs's font table
// predates that swap - it still only knows Cozette/Terminus, one shared table
// for both boards - so it cannot be asked for board 2's numbers; they are
// named here instead of re-derived, the same way this file already treats
// LOGO_SIZE as an external fact to read rather than compute.
const BODY_H = { 1: 13, 2: 16 };

// BOARD 2's hero, measured (not counted) from Spleen32x64.h directly, because
// geom-common.mjs's textWidth() has no entry for that font (it was written
// before board 2 had its own registry and this task's hero is its only
// caller). Spleen is perfectly monospace - every one of its 95 glyphs
// declares xAdvance == width and xOffset 0, verified below - so the same
// "last character is xOffset+width, every other is xAdvance" rule
// textWidth() applies degenerates to one number per glyph either way; this
// still parses the real glyph table rather than hardcoding 32, so a
// regenerated font that broke monospacing would be caught here rather than
// silently trusted.
function parseSpleen32x64() {
  const src = fs.readFileSync(`${DIR}/Spleen32x64.h`, "utf8");
  const gl = src.slice(src.indexOf("Glyphs[]"));
  const rows = [...gl.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)];
  return rows.map(m => ({ w: +m[2], h: +m[3], xa: +m[4], xo: +m[5] }));
}
const SPLEEN32X64 = parseSpleen32x64();
for (const g of SPLEEN32X64)
  if (g.xo !== 0 || g.w !== g.xa) throw new Error("Spleen32x64 is no longer monospace - spleenHeroWidth() needs the real last-char rule");
function spleenHeroWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const g = SPLEEN32X64[s.charCodeAt(i) - 0x20];
    if (!g) continue;
    w += (i === s.length - 1) ? (g.xo + g.w) : g.xa;
  }
  return w;
}

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
let known = 0;
function chk(cond, msg, allow) {
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
  const heroGlyphH = b === 1 ? 13 * heroSize : 64;
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
  for (const L of ["SESSION - 5 HOUR WINDOW", "WEEK - 7 DAY, ALL MODELS"]) {
    const end = c.CARD_X + c.PAD + textWidth(L, 1);
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
  // --- the label lane, re-derived exactly as the header claims ---
  const rightX = c.CARD_X + c.CARD_W - c.PAD;
  const rightW = c.CODEX_RIGHT_CHARS * 6;
  const clearFrom = rightX - rightW - 1;
  const labelX = c.CARD_X + c.PAD;
  const lane = Math.floor((clearFrom - labelX) / 6);
  chk(lane === c.CODEX_LANE_CHARS,
      `codex lane: right field at ${rightX} spans ${rightX - rightW}..${rightX}, clears from ${clearFrom}; label at ${labelX}; (${clearFrom}-${labelX})/6 = ${((clearFrom - labelX) / 6).toFixed(2)} -> ${lane}, header says ${c.CODEX_LANE_CHARS}`);
  chk(c.CODEX_LANE_CACHE >= c.CODEX_LANE_CHARS + 1,
      `lane cache ${c.CODEX_LANE_CACHE} holds ${c.CODEX_LANE_CHARS} chars + NUL`);
  // codex icon slot
  const iconEnd = labelX + textWidth("CX", 2) + 4 + 13;
  chk(iconEnd < clearFrom, `codex icon ends x=${iconEnd}, right field clears from ${clearFrom}`);
  // --- footer lanes ---
  const y = 0;
  const clockEnd = 10 + textWidth("12:34:56", 1);
  const battEnd = c.FOOTER_BATT_TEXT_X + textWidth("100%", 1);
  const freshStart = W - 10 - textWidth("stale 999m ", 1);
  chk(clockEnd < c.FOOTER_BATT_X, `footer: clock ends ${clockEnd} < battery glyph ${c.FOOTER_BATT_X}`);
  chk(c.FOOTER_BATT_X + 21 <= c.FOOTER_BATT_TEXT_X, `footer: glyph box ${c.FOOTER_BATT_X}..${c.FOOTER_BATT_X + 20} clears text at ${c.FOOTER_BATT_TEXT_X}`);
  chk(battEnd < freshStart, `footer: battery text ends ${battEnd} < freshness starts ${freshStart}`);
  chk(4 + 13 <= c.FOOTER_H, `footer band ${c.FOOTER_H} holds a 13px line at +4`);
  // --- tab bar ---
  const tabW = Math.floor((W - c.TAB_REC_W) / 3);
  chk(textWidth("SESSIONS", 1) < tabW - 16, `tab label "SESSIONS" ${textWidth("SESSIONS", 1)}px inside a ${tabW}px tab`);
  const grp = 6 + 3 + textWidth("REC", 1);
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
  const wait = [
    ["logo", c.WAIT_LOGO_Y, c.WAIT_LOGO_Y + LOGO_SIZE - 1],
    ["wordmark", c.WAIT_NAME_Y, c.WAIT_NAME_Y + lineH(4) - 1],
    ["device id", c.WAIT_ID_Y, c.WAIT_ID_Y + lineH(1) - 1],
    ["message 1", c.WAIT_MSG_Y, c.WAIT_MSG_Y + lineH(2) - 1],
    ["message 2", c.WAIT_MSG2_Y, c.WAIT_MSG2_Y + lineH(2) - 1],
    ["command panel", c.WAIT_CMD_Y, c.WAIT_CMD_Y + c.WAIT_CMD_H - 1],
  ];
  for (const [n, a, z] of wait) console.log(`    wait ${n.padEnd(14)} ${a}..${z}`);
  chk(wait[0][1] >= c.CONTENT_Y, `waiting screen starts ${wait[0][1]} at or below CONTENT_Y ${c.CONTENT_Y}`);
  for (let i = 1; i < wait.length; i++) {
    const gap = wait[i][1] - wait[i - 1][2] - 1;
    // BOARD 2 FAILS THE FIRST OF THESE, and it is a real defect rather than a
    // checker artefact: WAIT_LOGO_Y follows CONTENT_Y (44 -> 56) while every
    // offset below it - WAIT_NAME_Y, WAIT_ID_Y, WAIT_MSG_Y, WAIT_MSG2_Y,
    // WAIT_CMD_Y - is still board 1's literal, so the column below the logo was
    // never re-derived for the taller panel. The logo therefore ends at 151
    // against a wordmark box starting at 148 and loses its bottom 4 rows, and the
    // whole column stops at 284 of a 462px content area. The header's own comment
    // says "the 96px logo sets everything below it", which is the fix:
    // WAIT_NAME_Y = WAIT_LOGO_Y + LOGO_SIZE + 8 (160 on board 2, unchanged 148 on
    // board 1) with the rest of the column following it down.
    chk(gap >= 0, `wait: ${wait[i - 1][0]} -> ${wait[i][0]} gap ${gap} (negative = the later draw erases the earlier)`);
  }
  chk(wait[wait.length - 1][2] < contentBottom,
      `waiting column ends ${wait[wait.length - 1][2]}, inside contentBottom ${contentBottom} (${contentBottom - 1 - wait[wait.length - 1][2]}px spare)`);
  chk(lineH(1) + 4 <= c.WAIT_CMD_H, `command panel ${c.WAIT_CMD_H}px holds a ${lineH(1)}px line with 2px top and bottom`);
  // The real strings, from waitingMessage(): the widest of each kind.
  for (const t of ["open DeckhandBLE.app", "./install.sh"])
    chk(textWidth(t, 1) <= c.CARD_W - 8, `command "${t}" ${textWidth(t, 1)}px inside the ${c.CARD_W - 8}px panel lane`);
  for (const t of ["Waiting for the first update", "Connect USB to your Mac", "Start Deckhand on"])
    chk(textWidth(t, 2) < W - 8, `waiting line "${t}" ${textWidth(t, 2)}px inside the ${W}px panel`);
  chk(textWidth("DECKHAND", 4) < W - 8, `wordmark ${textWidth("DECKHAND", 4)}px inside the ${W}px panel`);
}
console.log(`\n${fail} failures, ${known} known-and-documented board-1 overlaps`);
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
