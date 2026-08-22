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
import { consts, PANEL, preflight, textWidth } from "./geom-common.mjs";
preflight();

// --- board constants, parsed from the headers so this cannot drift ---
const B = { 1: consts("board_e32r28t.h"), 2: consts("board_es3c35p.h") };

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
const KNOWN_OVERLAPS = {
  1: ["hero box -> pace bar clear", "pace bar clear -> stats clear",
      "stats clear -> foot clear"],
  2: [],
};

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
  const heroSize = c.CARD_HERO_SIZE;
  const bands = [
    ["pin bar", c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
    ["label", c.CARD_LABEL_Y, c.CARD_LABEL_Y + 12],
    ["hero box", c.CARD_HERO_Y, c.CARD_HERO_Y + c.CARD_HERO_H - 1],
    ["pace bar clear", c.CARD_BAR_Y - 4, c.CARD_BAR_Y + c.BAR_H + 3],
    ["stats clear", c.CARD_STATS_Y - 1, c.CARD_STATS_Y + 13],
    ["foot clear", c.CARD_FOOT_Y - 1, c.CARD_FOOT_Y + 13],
  ];
  for (const [n, a, z] of bands) console.log(`    ${n.padEnd(15)} +${a}..+${z}`);
  const ceil = c.CARD_H - 3;
  const last = Math.max(...bands.map(x => x[2]));
  chk(last <= ceil, `nothing on the card ends past +${ceil} (2px border owns +${c.CARD_H - 2}..+${c.CARD_H - 1}); last band ends +${last}`);
  chk(c.CARD_LABEL_Y + 12 < c.CARD_HERO_Y, `label row +${c.CARD_LABEL_Y}..+${c.CARD_LABEL_Y + 12} clears the hero box starting +${c.CARD_HERO_Y}`);
  chk(c.CARD_PIN_BAR_Y >= 2, `pin bar +${c.CARD_PIN_BAR_Y} is inside the interior (border owns +0..+1)`);
  chk(c.CARD_PIN_BAR_Y + 2 < c.CARD_LABEL_Y, `pin bar clears the icon below it`);
  // hero glyph height
  chk(13 * heroSize <= c.CARD_HERO_H, `hero glyph ${13 * heroSize}px fits the ${c.CARD_HERO_H}px box`);
  chk(textWidth("100%", 4, heroSize) <= c.CARD_W - 2 * c.PAD,
      `hero "100%" = ${textWidth("100%", 4, heroSize)}px inside the ${c.CARD_W - 2 * c.PAD}px lane`);
  // band overlaps
  for (let i = 1; i < bands.length; i++) {
    const gap = bands[i][1] - bands[i - 1][2] - 1;
    const pair = `${bands[i - 1][0]} -> ${bands[i][0]}`;
    chk(gap >= 0, `${pair} gap ${gap} (negative = clear box eats its neighbour)`,
        KNOWN_OVERLAPS[b].includes(pair));
  }
  // --- label row x-wise: label text vs the Mac icon ---
  for (const L of ["SESSION - 5 HOUR WINDOW", "WEEK - 7 DAY, ALL MODELS"]) {
    const end = c.CARD_X + c.PAD + textWidth(L, 1);
    const iconX = c.CARD_X + c.CARD_W - c.PAD - 13;
    chk(end < iconX, `"${L}" ends x=${end}, icon starts x=${iconX}`);
  }
  // --- Codex row bands ---
  const cb = [
    ["text clear", c.CODEX_TEXT_Y - 1, c.CODEX_TEXT_Y + 13],
    ["bar clear", c.CODEX_BAR_Y - 4, c.CODEX_BAR_Y + c.BAR_H + 3],
  ];
  for (const [n, a, z] of cb) console.log(`    codex ${n.padEnd(11)} +${a}..+${z}`);
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
}
console.log(`\n${fail} failures, ${known} known-and-documented board-1 overlaps`);
if (SELFTEST) {
  if (fail === 0) { console.log("SELFTEST FAILED: the checker did not notice a moved row"); process.exit(1); }
  console.log(`selftest ok - the injected fault produced ${fail} failure(s)`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all geometry assertions pass on both boards");
