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
import { cacheSizes, consts, DIR, evalInt, fnBody, lineH, PANEL, preflight,
         splitArgs, stripComments, textWidth } from "./geom-common.mjs";
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
// The NOW card's own bands need T_META (index 1, the label row's cell height -
// board 2's is 16, distinct from board 1's 13 which happens to equal BODY_H
// there too) - parsed the identical way BODY_H/HERO_H_NATIVE are, never
// transcribed as 13/16. (T_HEAD's cellH is NOT here: no board-2 NOW-card field
// draws at T_HEAD, and an unread derivation is one more thing to keep true for
// nothing - Task 8 can add it back when its 24px number actually needs it.)
const META_H = { 1: UI_FONTS[1][1].cellH, 2: UI_FONTS[2][1].cellH };  // T_META
// Index 3 is T_HEAD - the WEEK card's own number, deliberately NOT a hero: 18 on
// board 1 (Terminus10x18b), 24 on board 2 (Spleen12x24). Parsed the same way as
// BODY_H/HERO_H_NATIVE/META_H, never transcribed as 18/24 - dropped in Task 7 as
// an unread derivation, re-added here now the WEEK card's number needs it.
const HEAD_H = { 1: UI_FONTS[1][3].cellH, 2: UI_FONTS[2][3].cellH };  // T_HEAD

// LOGO_SIZE is a #define rather than a const int, so it is read from the art
// header the same way settings-geom-check.mjs reads KB_MAX_BYTES out of the host -
// from the file that owns it, not from a number copied over here.
const LOGO_SIZE = +fs.readFileSync(`${DIR}/DeckhandLogo.h`, "utf8").match(/#define\s+LOGO_SIZE\s+(\d+)/)[1];

// Change-only cache sizes, PARSED from deckhand_display.ino - the same helper
// sessions-geom-check.mjs and settings-geom-check.mjs already bind theirs
// through. The USAGE tab's caches (v1 AND v2, since v2 reuses v1's) had no
// such assertion at all until this task.
const CACHE = cacheSizes("deckhand_display.ino");

// One parsed call argument, resolved against a board's own constant table -
// the same trick settings-geom-check.mjs's spineArg() uses for the severity
// spine's uiFillRound() arguments. evalInt() itself only parses NUMBERS, so an
// identifier like "CARD_HERO_W" has to be substituted first; a token that
// resolves to nothing THROWS rather than silently reading as 0, which is what
// makes a rewritten draw call fail loudly instead of comparing NaN to a number
// and reporting green by accident.
function drawArg(c, expr) {
  const e = expr.replace(/[A-Za-z_][A-Za-z_0-9]*/g, (t) => {
    if (t in c) return String(c[t]);
    throw new Error(`drawArg(): "${expr}" names "${t}", which is not a known board constant`);
  });
  return evalInt(e);
}

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

// A CAPABILITY FLAG MUST BE A #define, NEVER A const int. `#if FOO` on a C++
// const int evaluates an undefined identifier as 0, silently and without a -Wall
// warning, so every guarded arm takes the wrong branch while this checker - which
// parses BOTH forms and cannot tell them apart - reports green. consts() is
// therefore structurally unable to catch it, so the check has to read the raw text.
for (const [b, hdr] of [[1, "board_e32r28t.h"], [2, "board_es3c35p.h"]]) {
  const raw = fs.readFileSync(`${DIR}/${hdr}`, "utf8");
  const bad = [...raw.matchAll(/^\s*const\s+int\s+(BOARD_[A-Z0-9_]+)\s*=/gm)].map(m => m[1]);
  chk(bad.length === 0,
      bad.length ? `board ${b}: ${bad.join(", ")} declared as const int - a capability flag `
                 + `must be #define or every #if on it is silently false`
                 : `board ${b}: every BOARD_* capability flag is a #define`);
  chk(/^\s*#define\s+BOARD_USAGE_V2\s+[01]\s*$/m.test(raw),
      `board ${b}: BOARD_USAGE_V2 is #define'd`);
}

for (const b of [1, 2]) {
  const c = B[b], [W, H] = PANEL[b];
  console.log(`\n=== board ${b} (${W}x${H}) ===`);
  const contentBottom = H - c.FOOTER_H;
  const content = contentBottom - c.CONTENT_Y;
  console.log(`content area ${c.CONTENT_Y}..${contentBottom} = ${content}px`);
  chk(c.CARD_X + c.CARD_W + c.CARD_X === W, `card spans the width: ${c.CARD_X}+${c.CARD_W}+${c.CARD_X} = ${W}`);
  // column
  // (a) THE POSITIONS ARE BOUND TO THE GAPS AND HEIGHTS. What this catches is a
  // HARDCODED position and a DRIFTED gap, on both boards, plus a height change on
  // board 1 - whose CARD1_Y/CARD2_Y/CODEX_Y are literals (38/146/254). It does NOT
  // catch a height change on board 2, whose positions are live formulas of CARD_H
  // that consts() re-evaluates, so both sides of the comparison move together.
  // Board 2's V2 heights (NOW_CARD_H/WEEK_CARD_H) are guarded by the declared-sum
  // assertion below. Its still-live v1 CARD_H is guarded by nothing here until the
  // task that swaps the column over; that gap is pre-existing, not introduced here.
  // (`air > 0` alone passed when FOOTER_H moved 18 -> 20 and the real air went
  // 8 -> 6 - exactly the drift it existed to catch.)
  const gap = b === 2 ? c.SP_2 : 4;
  const y1 = c.CONTENT_Y + gap;
  const y2 = y1 + c.CARD_H + gap;
  const y3 = y2 + c.CARD_H + gap;
  chk(c.CARD1_Y === y1, `CARD1_Y ${c.CARD1_Y} == CONTENT_Y + gap (${y1})`);
  chk(c.CARD2_Y === y2, `CARD2_Y ${c.CARD2_Y} == CARD1_Y + CARD_H + gap (${y2})`);
  chk(c.CODEX_Y === y3, `CODEX_Y ${c.CODEX_Y} == CARD2_Y + CARD_H + gap (${y3})`);
  const colEnd = c.CODEX_Y + c.CODEX_H;
  const air = contentBottom - colEnd;
  chk(air > 0, `column ends at ${colEnd}, ${air}px of air (never flush on the footer)`);

  // (b) THE v2 COLUMN SUMS EXACTLY, from the declared heights and gaps - not
  // from any position, so this one can and must fail on a height change.
  // Nothing draws this column yet; Task 9 is what moves the card positions
  // onto it.
  if (b === 2) {
    const v2 = [c.SP_2, c.NOW_CARD_H, c.SP_2, c.WEEK_CARD_H, c.SP_2, c.CODEX_H, c.SP_2];
    const sum = v2.reduce((a, x) => a + x, 0);
    chk(sum === content,
        `v2 column ${v2.join(" + ")} = ${sum}, must be exactly ${content} `
      + `(BOARD_H ${H} - TAB_BAR_H ${c.TAB_BAR_H} - FOOTER_H ${c.FOOTER_H})`);
  }

  // Board 1's column, summed from its DECLARED terms. Its gaps are literal 4s in
  // the header rather than named constants, so they are stated here; the HEIGHTS
  // come from the header, which is what makes this fail on a CARD_H change.
  if (b === 1) {
    const v1 = [4, c.CARD_H, 4, c.CARD_H, 4, c.CODEX_H, 4];
    const sum = v1.reduce((a, x) => a + x, 0);
    chk(sum === content,
        `board 1 column ${v1.join(" + ")} = ${sum}, must be exactly ${content}`);
  }

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
  // THE LANE IS BOUNDED BY ITS NEIGHBOUR'S CLEAR BOX, AND THAT BOX MOVES WITH
  // CONTENT. padLeftTo() only ever GROWS a short string - it returns early
  // when the string is already longer than the pad width - so
  // CODEX_RIGHT_CHARS is a floor on that field, never a ceiling, and a lane
  // derived FROM it (the old formula: rightW = CODEX_RIGHT_CHARS * charW) is
  // wrong whenever real content exceeds it. Derive from the field's real
  // worst-case content instead. Both boards format this field identically.
  const worst = "100%  23h 59m left".length;          // no wall-clock suffix
  // The reverse must ALSO hold, or this derivation is decorative rather than
  // load-bearing: if CODEX_RIGHT_CHARS were ever raised back past `worst`,
  // padLeftTo() would pad PAST the worst case this lane assumes and
  // re-widen the real clear box - the identical bug this commit fixes,
  // reappearing through the pad width instead of through the wall clock.
  chk(c.CODEX_RIGHT_CHARS <= worst,
      `CODEX_RIGHT_CHARS (${c.CODEX_RIGHT_CHARS}) <= the right field's own worst `
    + `case (${worst} chars) - padLeftTo() pads UP TO CODEX_RIGHT_CHARS, so a `
    + `wider pad target re-widens the real clear box past what the lane below assumes`);
  const rightX = c.CARD_X + c.CARD_W - c.PAD;
  const rightW = worst * charW;
  const clearFrom = rightX - rightW - 1;
  const labelX = c.CARD_X + c.PAD;
  const lane = Math.floor((clearFrom - labelX) / charW);
  chk(lane === c.CODEX_LANE_CHARS,
      `codex lane: right field's worst case (${worst} chars) at ${rightX} spans ${rightX - rightW}..${rightX}, clears from ${clearFrom}; label at ${labelX}; (${clearFrom}-${labelX})/${charW} = ${((clearFrom - labelX) / charW).toFixed(2)} -> ${lane}, header says ${c.CODEX_LANE_CHARS}`);
  // and the longest label the row can actually emit must fit in it
  const longest = "CODEX  7d".length;
  chk(longest <= lane, `the widest Codex label (${longest} chars) fits the ${lane}-char lane`);
  chk(c.CODEX_LANE_CACHE >= c.CODEX_LANE_CHARS + 1,
      `lane cache ${c.CODEX_LANE_CACHE} holds ${c.CODEX_LANE_CHARS} chars + NUL`);
  // ONE buffer serves BOTH fields, and the larger one was never checked against it.
  // usage.ino declares `char buf[CODEX_LANE_CACHE]` once and both drawIfChanged
  // calls pass CODEX_LANE_CACHE as the cacheSize - the left field padded to
  // CODEX_LANE_CHARS, the RIGHT one padded to CODEX_RIGHT_CHARS. Checking only
  // the smaller of the two is exactly the "a cache shorter than the string it
  // stores silently stops noticing changes" trap this repo has paid for
  // repeatedly. (docs/board-1-known-defects.md #12, "CODEX_RIGHT_CHARS can be
  // exceeded by its own content", is fixed by the CODEX_RIGHT_CHARS <= worst
  // assertion above and its entry is marked RESOLVED in this commit - the
  // buffer-size margin checked here was never the defect; the pad-width-as-
  // ceiling assumption was.)
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

  // --- the NOW card (board 2 only): the 64px hero's own clear box, and the
  // two fact lines living in the 132px beside it that v1's full-lane hero used
  // to erase on every repaint ---
  if (b === 2) {
    const laneX0 = c.CARD_X + c.PAD, laneX1 = c.CARD_X + c.CARD_W - c.PAD;
    // THE HERO'S CLEAR BOX MUST NOT REACH THE SIDE LANE. drawBigNumber clears
    // the box it is handed; hand it the full lane again and it erases both
    // fact lines on every value change, which is the defect CARD_HERO_W
    // exists to prevent.
    chk(laneX0 + c.CARD_HERO_W < c.SIDE_X0,
        `hero box ends at ${laneX0 + c.CARD_HERO_W - 1}, side lane starts at ${c.SIDE_X0}`);
    // ...and it must still hold the widest number the card can draw.
    // heroTextWidth() is this checker's own measurer over the parsed
    // Spleen32x64 glyph table - do not multiply a transcribed advance.
    const heroInk = heroTextWidth(b, "100%");
    chk(heroInk <= c.CARD_HERO_W, `"100%" inks ${heroInk}px inside CARD_HERO_W ${c.CARD_HERO_W}`);
    // The side lane's character budget, DERIVED and bound to the constant the
    // draw site actually names (SIDE_CHARS) rather than a bare literal 15 -
    // a drift in SIDE_CHARS's own derivation must fail here too, not just
    // agree with whatever it currently says.
    const sideChars = Math.floor((laneX1 - c.SIDE_X0) / c.TEXT_ADV);
    chk(sideChars === c.SIDE_CHARS,
        `side lane is ${sideChars} characters, header's SIDE_CHARS says ${c.SIDE_CHARS}`);

    // The NOW card's bands, as CLEARED extents, disjoint and inside the
    // ceiling. META_H comes from the PARSED UI_FONTS[] table, beside BODY_H
    // and HERO_H_NATIVE this checker already derives that way.
    const meta = META_H[b];
    const bands = [
      ["pin",   c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label", c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      ["hero",  c.NOW_HERO_Y,     c.NOW_HERO_Y + c.CARD_HERO_H - 1],
      ["bar",   c.NOW_BAR_Y - 4,  c.NOW_BAR_Y + c.BAR_H + 3],
      ["spark", c.NOW_SPARK_Y - 1, c.NOW_SPARK_Y + c.NOW_SPARK_H],
      ["meta",  c.NOW_META_Y - 1, c.NOW_META_Y + meta],
    ];
    for (let i = 1; i < bands.length; i++)
      chk(bands[i][1] >= bands[i][2] || bands[i][1] > bands[i - 1][2],
          `NOW band ${bands[i - 1][0]} -> ${bands[i][0]}: gap ${bands[i][1] - bands[i - 1][2] - 1}`);
    const last = bands[bands.length - 1][2];
    chk(last <= c.NOW_CARD_H - 3,
        `NOW last clear ends +${last}, ceiling +${c.NOW_CARD_H - 3} `
      + `(${c.NOW_CARD_H - 3 - last} rows clear of the 2px border)`);

    // The two side facts sit inside the hero's vertical band and beside it.
    for (const [n, y] of [[1, c.NOW_SIDE_Y], [2, c.NOW_SIDE_Y + c.NOW_SIDE_STEP]]) {
      chk(y - 1 >= c.NOW_HERO_Y && y + meta <= c.NOW_HERO_Y + c.CARD_HERO_H - 1,
          `NOW side fact ${n} clear +${y - 1}..+${y + meta} inside the hero band`);
    }

    // The draw site's own arguments, PARSED - not a restatement of the
    // constants. A comment claiming the hero is handed CARD_HERO_W is not a
    // constraint; the settings branch learned that when a reviewer rewrote a
    // draw call and every checker still passed. drawArg() resolves each token
    // through the board's own constant table.
    const body = fnBody(stripComments("usage.ino"), "void renderNowCard(", "usage.ino");
    const hero = body.match(/drawBigNumber\(([^;]*)\)\s*;/);
    chk(!!hero, "renderNowCard calls drawBigNumber");
    if (hero) {
      const args = splitArgs(hero[1]);
      const got = drawArg(c, args[5]);
      chk(got === c.CARD_HERO_W,
          `drawBigNumber is handed CARD_HERO_W (${c.CARD_HERO_W}), not the full lane `
        + `- got ${got}`);
    }

    // THE SPARK'S CACHE KEY MUST FOLD IN THE TINT, not just usageRingHash()'s
    // samples. A stale flip or a colorForPct band crossing changes fg while the
    // ring content is unchanged, and a signature blind to that would keep a
    // bright spark beside a dimmed hero for up to USAGE_RING_STEP_MIN minutes -
    // the same trap CLAUDE.md records for drawPaceBar's (pct, tick)-blind key
    // and for battTextColorCache. Scoped to the text between the hash call and
    // the cache check, so this cannot be satisfied by `fg` merely appearing
    // somewhere else in the function (the signature, or a later drawFastHLine).
    const spark = fnBody(stripComments("usage.ino"), "void drawUsageSpark(", "usage.ino");
    const hashAt = spark.indexOf("usageRingHash()");
    chk(hashAt >= 0, "drawUsageSpark calls usageRingHash()");
    const guardAt = spark.indexOf("if (sig == *cache)", hashAt);
    chk(hashAt >= 0 && guardAt > hashAt,
        "drawUsageSpark checks the signature against *cache after computing it");
    if (hashAt >= 0 && guardAt > hashAt) {
      const between = spark.slice(hashAt, guardAt);
      chk(/\bfg\b/.test(between),
          "drawUsageSpark's cache key mixes fg (the tint) in between usageRingHash() "
        + "and the cache check");
    }

    // THE SPARK'S COLUMN WIDTH HAS A FLOOR. drawUsageSpark's cw = w / SLOTS is an
    // integer divide with no guard - past ~130 slots the caps go zero-width and
    // every fillRect no-ops silently, degrading to a bare baseline with nothing
    // reporting it. At today's 31 slots this has 6px of margin (8 - 2).
    const sparkW = c.CARD_W - 2 * c.PAD;
    const sparkCw = Math.floor(sparkW / c.USAGE_RING_SLOTS);
    chk(sparkCw >= 2,
        `spark column ${sparkCw}px (${sparkW}px / ${c.USAGE_RING_SLOTS} slots) is >= 2px`);

    // EVERY change-only cache must hold its own padded string plus its NUL, with
    // headroom rather than an exact fit - "a buffer exactly as long as its
    // string is this repo's oldest silent bug". drawIfChanged compares only
    // cacheSize bytes, so a short cache stops noticing changes past that point
    // and the field freezes - silently. The pad widths are PARSED out of
    // renderNowCard's own pad-then-drawIfChanged call pairs, not transcribed: a
    // transcribed width only checks the checker's OWN belief about the source,
    // and a pre-flight audit found exactly that - reverting the real pad width
    // left this loop green while resetAt1Cache was filled exactly.
    const padCalls = [...body.matchAll(
      /pad(?:Left)?To\(buf,\s*sizeof\(buf\),\s*([^)]+)\)\s*;[\s\S]{0,400}?drawIfChanged\(\s*(\w+)/g)];
    const pads = {};
    for (const m of padCalls) pads[m[2]] = drawArg(c, m[1]);
    chk(Object.keys(pads).length > 0,
        "renderNowCard's pad-then-drawIfChanged parse found at least one cache "
      + "(an empty result must fail loudly, not pass vacuously)");
    for (const [cache, what] of [
      ["right1Cache",   "NOW meta left, tokens"],
      ["resetAt1Cache", "NOW meta right, spark caption / staleness"],
      ["left1Cache",    "NOW side line 2, reset countdown"],
      ["burn1Cache",    "NOW side line 1, burn verdict"],
    ]) {
      chk(pads[cache] !== undefined,
          `renderNowCard's pad-then-drawIfChanged parse found a pad width for ${cache}`);
      chk(CACHE[cache] !== undefined, `${cache} is declared where cacheSizes() can parse it`);
      if (pads[cache] === undefined || CACHE[cache] === undefined) continue;
      // Strict > , not >=: a cache filled EXACTLY (headroom 0) is not an
      // overflow today, but it silently truncates the moment the field's
      // widest string grows by one character - which is precisely the
      // pre-flight audit's finding. >= would pass that case; only > catches it.
      chk(CACHE[cache] > pads[cache] + 1,
          `${cache}[${CACHE[cache]}] holds its ${pads[cache]}-char padded string + NUL `
        + `(${what}) with ${CACHE[cache] - pads[cache] - 1} bytes of real headroom`);
    }

    // --- the WEEK card (board 2 only): SECONDARY, so a T_HEAD number rather
    // than a 64px hero - that size contrast against NOW's hero IS the hierarchy
    // this redesign exists for. Fable moves INTO this card as a real labelled
    // bar, sharing the 7-day window/tick with the percentage above it.
    const head = HEAD_H[b];        // parsed T_HEAD cellH: 18 on board 1, 24 on board 2
    const wb = [
      ["pin",    c.CARD_PIN_BAR_Y, c.CARD_PIN_BAR_Y + 2],
      ["label",  c.CARD_LABEL_Y,   c.CARD_LABEL_Y + meta - 1],
      // the number and the burn line share one row: union of the two clear boxes
      ["numrow", Math.min(c.WEEK_NUM_Y - 1, c.WEEK_BURN_Y - 1),
                 Math.max(c.WEEK_NUM_Y + head, c.WEEK_BURN_Y + meta)],
      ["allbar", c.WEEK_BAR_Y - 4,   c.WEEK_BAR_Y + c.BAR_H + 3],
      ["meta",   c.WEEK_META_Y - 1,  c.WEEK_META_Y + meta],
      ["fable",  c.WEEK_FABLE_Y - 1, c.WEEK_FABLE_Y + meta],
      ["fbar",   c.WEEK_FABLE_BAR_Y - 4, c.WEEK_FABLE_BAR_Y + c.BAR_H + 3],
    ];
    for (let i = 1; i < wb.length; i++)
      chk(wb[i][1] > wb[i - 1][2],
          `WEEK band ${wb[i - 1][0]} -> ${wb[i][0]}: gap ${wb[i][1] - wb[i - 1][2] - 1} (must be >= 0)`);
    const wlast = wb[wb.length - 1][2];
    chk(wlast <= c.WEEK_CARD_H - 3,
        `WEEK last clear ends +${wlast}, ceiling +${c.WEEK_CARD_H - 3} `
      + `(${c.WEEK_CARD_H - 3 - wlast} rows clear)`);

    // THE SECONDARY NUMBER MUST BE SMALLER THAN THE PRIMARY'S. That contrast is
    // the hierarchy this redesign exists for, so it is asserted rather than left
    // to whoever next edits a font id.
    chk(HEAD_H[b] < c.CARD_HERO_H,
        `WEEK's number (${HEAD_H[b]}px) is smaller than NOW's hero `
      + `(${c.CARD_HERO_H}px), which is what carries the hierarchy`);

    // The draw site's own font id, PARSED - the static HEAD_H < CARD_HERO_H fact
    // above says nothing about which font renderWeekCard actually HANDS
    // drawIfChanged, and a rewrite that quietly drew the number at T_HERO would
    // leave that fact true while erasing the contrast on the glass. Bound to
    // font id 3 (T_HEAD) at the pct2Cache call specifically.
    const wbody = fnBody(stripComments("usage.ino"), "void renderWeekCard(", "usage.ino");
    const numDraw = wbody.match(/drawIfChanged\(\s*pct2Cache[\s\S]*?\)\s*;/);
    chk(!!numDraw, "renderWeekCard draws pct2Cache via drawIfChanged");
    if (numDraw) {
      const dargs = splitArgs(numDraw[0].slice(numDraw[0].indexOf("(") + 1, numDraw[0].lastIndexOf(")")));
      chk(dargs[5].trim() === "3",
          `renderWeekCard's number is drawn with font id ${dargs[5].trim()}, expected 3 (T_HEAD) `
        + `- T_HERO there would erase the size contrast this card exists for`);
    }

    // EVERY change-only cache this card writes must hold its own padded string
    // plus its NUL, with real headroom - the same audit renderNowCard's fields
    // get above, extended over this card's six fields (four reused from v1's
    // caches, burn2Cache and fable2Cache new/newly-used here).
    const wpadCalls = [...wbody.matchAll(
      /pad(?:Left)?To\(buf,\s*sizeof\(buf\),\s*([^)]+)\)\s*;[\s\S]{0,400}?drawIfChanged\(\s*(\w+)/g)];
    const wpads = {};
    for (const m of wpadCalls) wpads[m[2]] = drawArg(c, m[1]);
    chk(Object.keys(wpads).length > 0,
        "renderWeekCard's pad-then-drawIfChanged parse found at least one cache "
      + "(an empty result must fail loudly, not pass vacuously)");
    for (const [cache, what] of [
      ["pct2Cache",   "WEEK number"],
      ["left2Cache",  "WEEK meta left, tokens"],
      ["right2Cache", "WEEK meta right, reset time / staleness"],
      ["burn2Cache",  "WEEK burn verdict"],
      ["fable1Cache", "WEEK Fable label"],
      ["fable2Cache", "WEEK Fable tokens"],
    ]) {
      chk(wpads[cache] !== undefined,
          `renderWeekCard's pad-then-drawIfChanged parse found a pad width for ${cache}`);
      chk(CACHE[cache] !== undefined, `${cache} is declared where cacheSizes() can parse it`);
      if (wpads[cache] === undefined || CACHE[cache] === undefined) continue;
      chk(CACHE[cache] > wpads[cache] + 1,
          `${cache}[${CACHE[cache]}] holds its ${wpads[cache]}-char padded string + NUL `
        + `(${what}) with ${CACHE[cache] - wpads[cache] - 1} bytes of real headroom`);
    }
  }
}

// ---- padding helper vs datum, read out of the source -----------------------
// padTo() pads on the RIGHT and padLeftTo() on the left, so a TR_DATUM field
// padded with padTo puts its spaces between the glyphs and the anchor and is
// inset by (width - len) * advance - i.e. it is not right-aligned at all, and
// its apparent position moves with its content. Asserted over the source rather
// than over a constant, since no constant is wrong here.
{
  const body = fnBody(stripComments("deckhand_display.ino"), "void renderCard(",
                      "deckhand_display.ino");
  // every drawIfChanged in renderCard that passes TR_DATUM, with the pad call
  // that immediately precedes it
  const calls = [...body.matchAll(/pad(Left)?To\([^;]*;\s*drawIfChanged\([^;]*TR_DATUM[^;]*;/g)];
  chk(calls.length >= 2,
      `renderCard has ${calls.length} padded TR_DATUM fields to check (expected >= 2)`);
  const wrong = calls.filter(m => !m[1]);        // matched padTo, not padLeftTo
  chk(wrong.length === 0,
      wrong.length ? `${wrong.length} TR_DATUM field(s) in renderCard are padded with `
                   + `padTo (pad RIGHT), so they are inset by the padding and float `
                   + `with their content: ${wrong[0][0].slice(0, 60).replace(/\s+/g, " ")}`
                   : `every padded TR_DATUM field in renderCard uses padLeftTo`);
}

// THE CODE CHANGE NEEDS AN ASSERTION TOO, not just the constants that bound it.
// `worst` above is a transcribed literal and this checker never reads usage.ino,
// so restoring the wall-clock suffix - the bug Task 1 fixed - would leave every
// assertion green while the real clear box moved 16px left and the label lost its
// tail again. Parse the draw site instead, the way settings-geom-check.mjs parses
// drawSeverityAction's own arguments.
{
  const row = fnBody(stripComments("usage.ino"), "void renderCodexRow(", "usage.ino");
  // The WHOLE argument list, not the first string literal: C concatenates
  // adjacent literals, so `"%d%%  %s"  "  %02ld:%02ld"` reads as one format and
  // a first-literal regex cannot see the half that matters. Balanced to the
  // closing paren so a nested call in the args does not truncate the match.
  const calls = [...row.matchAll(/snprintf\(buf,\s*sizeof\(buf\),([\s\S]*?)\);/g)].map(m => m[1]);
  const right = calls.filter(a => a.includes("%d%%"));
  chk(right.length >= 2,
      `renderCodexRow's right field has ${right.length} percentage branches (expected >= 2)`);
  const clock = right.filter(a => /%02ld:%02ld/.test(a));
  chk(clock.length === 0,
      clock.length ? `a right-field branch carries a wall-clock suffix again - that field's width `
                   + `bounds CODEX_LANE_CHARS, so this silently moves the real clear box left: `
                   + clock[0].trim().slice(0, 70)
                   : `no right-field branch carries a wall-clock suffix, so the lane derivation holds`);
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
