// ---------------------------------------------------------------------------
// Headless check of the STATUS BAND CARD mock, BOTH BOARDS. It draws all four
// pictures into op lists and asserts the things every mock in this directory
// asserts - no string leaves the fonts' 0x20..0x7E, nothing lands off the panel,
// nothing lands outside the card it belongs to - plus the three this design turns
// on:
//
//   1. K IS THE FIRMWARE'S. Every constant this mock draws from is asserted
//      name-for-name against its own board header, through the geometry checkers'
//      own consts() parser. A picture drawn from numbers nobody compares to the
//      header is a spec that can go silently wrong while reporting itself green -
//      the same class of defect as an assertion that cannot fail.
//   2. THE BLOCKS SUM TO THE CARD. The body is a running cursor over the
//      SESSION_BAND_* blocks and SESSION_EXP_MAX_H is their SUM, so the labelled
//      column this page renders has to add up to the card it is drawn beside. That
//      is the whole claim the picture exists to make.
//   3. THE BAND'S CONTENTS FIT ACROSS, per board, at the word each board actually
//      draws. This is the arithmetic board 1 fails at labelForStatus()'s full
//      phrase and passes at shortLabelForStatus()'s, and the mock must land on the
//      same form the firmware's own measurement does or it is drawing a card the
//      device cannot.
//
//   node docs/design/sessions-band-board1/check.mjs             -> 0 failures
//   node docs/design/sessions-band-board1/check.mjs --selftest  -> exits 0 iff a fault is caught
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { consts } from "../../../firmware/deckhand_display/geom-common.mjs";

const DIR = new URL("./", import.meta.url).pathname;
const FW = DIR + "../../../firmware/deckhand_display/";

globalThis.document = { getElementById: () => null, querySelectorAll: () => [],
                        createElement: () => ({ appendChild(){}, style:{}, getContext: () => null }) };
globalThis.addEventListener = () => {};
new Function(fs.readFileSync(DIR + "band.js", "utf8"))();
const X = globalThis.__X;
if (!X) { console.log("FATAL: band.js did not publish globalThis.__X"); process.exit(1); }
const { SCREENS, K, ADV, CELL, BAD_CHARS, P, SPARK_SIZE, BAND_WORD, contentBottom } = X;

const HEADER = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };
const H = { 1: consts(HEADER[1]), 2: consts(HEADER[2]) };

const SELFTEST = process.argv.includes("--selftest");
let fail = 0, total = 0;
function chk(cond, msg) {
  total++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) fail++;
}
if (SELFTEST) {
  // Board 1's bottom pad, moved by one. It is the smallest block in the stack and
  // the one a reader would most readily call cosmetic, so it is the honest test of
  // whether this file's arithmetic actually closes: it must break the bind to the
  // header AND the blocks-sum-to-the-card assertion, not merely one of them.
  K[1].SESSION_BAND_BOTTOM_PAD += 1;
  console.log("--selftest: board 1's SESSION_BAND_BOTTOM_PAD raised 1px in the mock only; " +
              "the header bind AND the block sum MUST both fail");
}

// ---- 1. every K name IS the header's ----
// Names the mock owns and no header does are listed rather than skipped silently:
// a name that could be satisfied by ABSENCE is an assertion that cannot fail.
for (const b of [1, 2]) {
  const missing = [], wrong = [];
  for (const [name, v] of Object.entries(K[b])) {
    if (H[b][name] === undefined) { missing.push(name); continue; }
    if (H[b][name] !== v) wrong.push(`${name} mock ${v} != header ${H[b][name]}`);
  }
  chk(missing.length === 0,
      `board ${b}: every one of the ${Object.keys(K[b]).length} constants this mock draws from ` +
      `exists in ${HEADER[b]}${missing.length ? ` - MISSING ${missing.join(", ")}` : ""}`);
  chk(wrong.length === 0,
      `board ${b}: and each holds the header's own value${wrong.length ? ` - ${wrong.join("; ")}` : ""}`);
}

// ---- the type scale, parsed from UI_FONTS[] rather than trusted ----
// A font swap must fail HERE and not on the glass: every lane, every block and
// every line count in this design is arithmetic on these eight numbers.
{
  const src = fs.readFileSync(FW + "deckhand_display.ino", "utf8");
  const at = src.indexOf("UI_FONTS[] = {");
  let ifStart = -1, idx = -1;
  while ((idx = src.indexOf("#if BOARD_USES_TFT_ESPI", idx + 1)) >= 0 && idx < at) ifStart = idx;
  const arms = src.slice(ifStart, src.indexOf("#endif", ifStart)).split(/\n#else\b/);
  chk(arms.length === 2, "UI_FONTS[] splits into exactly two board arms");
  for (const b of [1, 2]) {
    const arm = arms[b - 1];
    const a = arm.indexOf("UI_FONTS[] = {");
    const rows = [...arm.slice(a, arm.indexOf("};", a))
      .matchAll(/\{\s*&(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)]
      .map((m) => ({ face: m[1], size: +m[2], cellH: +m[3] }));
    chk(rows.length === 5, `board ${b}: UI_FONTS[] declares five rungs`);
    for (const id of [1, 2, 3, 4])
      chk(CELL[b][id] === rows[id].cellH,
          `board ${b}: font ${id} cell ${CELL[b][id]} == UI_FONTS[]'s ${rows[id].cellH} (${rows[id].face})`);
  }
  // TEXT_ADV is the BODY face's advance and the header owns it; the mock's ADV
  // table has to agree with it for the two rungs that share that face.
  for (const b of [1, 2]) {
    chk(ADV[b][2] === H[b].TEXT_ADV,
        `board ${b}: the body rung's advance ${ADV[b][2]} == TEXT_ADV ${H[b].TEXT_ADV}`);
    chk(ADV[b][1] === H[b].TEXT_ADV,
        `board ${b}: T_META shares that advance (one face, both rungs)`);
  }
}
// The mark's own size, PARSED. It is the SAME art on both boards and it does not
// scale, which is the whole reason board 1's band could not also hold the full
// status phrase - so a regenerated mark has to fail here.
{
  const m = fs.readFileSync(FW + "ClaudeSpark.h", "utf8").match(/#define\s+SPARK_SIZE\s+(\d+)/);
  chk(!!m && +m[1] === SPARK_SIZE,
      `the agent mark is ${SPARK_SIZE}x${SPARK_SIZE} (SPARK_SIZE, parsed from ClaudeSpark.h)`);
}

// ---- the two status vocabularies, parsed, and which form each board lands on ----
{
  const src = fs.readFileSync(FW + "deckhand_display.ino", "utf8");
  const words = (sig) => {
    const m = src.match(new RegExp(`const char\\* ${sig}\\(const char\\* status\\) \\{([\\s\\S]*?)\\n\\}`));
    return m ? [...m[1].matchAll(/return\s+"([^"]*)"/g)].map((x) => x[1]) : [];
  };
  const LONG = words("labelForStatus").map((w) => w.toUpperCase());
  const SHORT = words("shortLabelForStatus");
  chk(LONG.length === 3 && SHORT.length === 3,
      `both status vocabularies parse: ${LONG.join("/")} and ${SHORT.join("/")}`);
  for (const b of [1, 2]) {
    const k = K[b];
    // bandDurLeft() - bandMarkX(), term for term, including bandDurLeft's own
    // trailing -1: it names where the duration's CLEAR BOX starts, not where its
    // digits do, and dropping it reports one character more room than the code gives.
    const room = k.SESSION_ROW_W - 2 * k.BORDER_CARD - 2 * k.SESSION_BAND_PAD
               - SPARK_SIZE - k.SESSION_BAND_MARK_GAP - k.SESSION_BAND_DUR_CHARS * k.TEXT_ADV - 1;
    const order = ["working", "asking", "waiting"];
    const drawn = order.map((st, i) =>
      LONG[i].length * ADV[b][3] <= room ? LONG[i] : SHORT[i]);
    for (let i = 0; i < order.length; i++) {
      chk(BAND_WORD[b][order[i]] === drawn[i],
          `board ${b}: the mock draws "${BAND_WORD[b][order[i]]}" for ${order[i]}, which is what ` +
          `a ${room}px word lane at ${ADV[b][3]}px a character leaves ("${drawn[i]}")`);
      chk(BAND_WORD[b][order[i]].length * ADV[b][3] <= room,
          `board ${b}: "${BAND_WORD[b][order[i]]}" inks ${BAND_WORD[b][order[i]].length * ADV[b][3]}px ` +
          `inside that ${room}px lane`);
    }
    chk(new Set(order.map((st) => BAND_WORD[b][st])).size === 3,
        `board ${b}: the band's three words are DISTINCT - it draws no pill and no shape, ` +
        `so this word is its only carrier that is not hue`);
  }
}

// ---- 2. the pictures ----
for (const sc of SCREENS) {
  for (const theme of ["DARK", "LIGHT"]) {
    const b = sc.board, k = K[b];
    const p = new P(b, theme);
    sc.draw(p);
    const tag = `${sc.title} [${theme}]`;

    // nothing off the panel
    let off = null;
    for (const o of p.ops) {
      if (o[0] === "t") {
        const [, s, x, y, f] = o;
        const x2 = x + s.length * ADV[b][f], y2 = y + CELL[b][f];
        if (x < 0 || y < 0 || x2 > k.BOARD_W || y2 > k.BOARD_H)
          off = off || `text "${s}" at ${x},${y}..${x2},${y2}`;
      } else {
        const [, x, y, w, h] = o;
        if (x < 0 || y < 0 || x + w > k.BOARD_W || y + h > k.BOARD_H)
          off = off || `rect ${x},${y} ${w}x${h}`;
      }
    }
    chk(off === null, `${tag}: every op is inside ${k.BOARD_W}x${k.BOARD_H}${off ? ` - ${off}` : ""}`);

    // the list never runs past the content area
    chk(p.avail === contentBottom(k) - k.SESSION_ROW_Y0,
        `${tag}: the list area is ${p.avail}px (contentBottom ${contentBottom(k)} - SESSION_ROW_Y0 ${k.SESSION_ROW_Y0})`);

    if (sc.sessions === 1) {
      // THE BLOCKS ARE THE CARD. This is the assertion the labelled column exists
      // to make legible, and it is made against the blocks the DRAW emitted rather
      // than against the header's own sum written out beside it.
      const sum = p.blocks.reduce((a, x) => a + x.h, 0);
      chk(sum === p.cardH,
          `${tag}: the blocks sum to the card - ` +
          `${p.blocks.map((x) => `${x.name.split(" ")[0]} ${x.h}`).join(" + ")} = ${sum} == ${p.cardH}`);
      chk(p.cardH === k.SESSION_EXP_MAX_H,
          `${tag}: and that is SESSION_EXP_MAX_H (${k.SESSION_EXP_MAX_H}), the cap this card is drawn at`);
      chk(p.cardH <= p.avail,
          `${tag}: the card fits its list area (${p.cardH} of ${p.avail}, ${p.avail - p.cardH}px left OUTSIDE it)`);
      // No block may overlap the next: the cursor's own claim.
      const sorted = [...p.blocks].sort((a, z) => a.y - z.y);
      let bad = null;
      for (let i = 1; i < sorted.length; i++)
        if (sorted[i].y < sorted[i - 1].y + sorted[i - 1].h)
          bad = bad || `${sorted[i - 1].name} -> ${sorted[i].name}`;
      chk(bad === null, `${tag}: no block overlaps the next${bad ? ` - ${bad}` : ""}`);
      // ... and the bottom-anchored rule+path group starts exactly where the body
      // cursor ended. At the cap with full content the two meet, which is what makes
      // this ONE layout rather than two that can drift.
      const anchor = p.blocks.find((x) => x.name.startsWith("rule2"));
      chk(!!anchor && anchor.y === k.SESSION_ROW_Y0 + p.cursorEnd,
          `${tag}: the bottom-anchored rule+path starts at ${anchor ? anchor.y : "?"}, ` +
          `exactly where the body cursor ended (${k.SESSION_ROW_Y0 + p.cursorEnd})`);
      // every body line wraps at the band's own lane, not the ordinary row's
      chk(k.SESSION_BAND_BODY_X === k.SESSION_ROW_X + k.BORDER_CARD + k.SESSION_BAND_PAD,
          `${tag}: the body's left edge IS the band's content edge (${k.SESSION_BAND_BODY_X})`);
      chk(k.SESSION_BAND_BODY_X + k.SESSION_BAND_BODY_LANE ===
            k.SESSION_ROW_X + k.SESSION_ROW_W - k.BORDER_CARD - k.SESSION_BAND_PAD,
          `${tag}: and its lane ends on the band's own right pad edge - one inset, both sides`);
      chk(Math.floor(k.SESSION_BAND_BODY_LANE / k.TEXT_ADV) === 33,
          `${tag}: the body lane is ${Math.floor(k.SESSION_BAND_BODY_LANE / k.TEXT_ADV)} characters ` +
          `- both boards land on 33 from their own width and their own face`);
      // the band holds the mark with its own height
      chk(k.SESSION_BAND_H - k.BORDER_CARD >= SPARK_SIZE,
          `${tag}: the band's ${k.SESSION_BAND_H - k.BORDER_CARD}px interior holds the ` +
          `${SPARK_SIZE}px mark`);
    } else {
      // The spine is a SECOND carrier: it must clear the 32x32 indicator blit, which
      // paints its own background across its whole rect and would erase any ink under it.
      const spineR = k.SESSION_ROW_X + k.BORDER_CARD + k.SESSION_SPINE_W - 1;
      const blitL = k.SESSION_DOT_CX - SPARK_SIZE / 2;
      chk(spineR < blitL,
          `${tag}: the spine's ink ends x=${spineR}, clear of the indicator blit at x=${blitL}`);
      chk(p.rowH >= k.SESSION_ROW_H_MIN && p.rowH <= k.SESSION_ROW_H_MAX,
          `${tag}: three rows of ${p.rowH}px, inside the ladder's [${k.SESSION_ROW_H_MIN}, ${k.SESSION_ROW_H_MAX}]`);
      chk(3 * p.rowH + 2 * k.SESSION_ROW_GAP <= p.avail,
          `${tag}: 3x${p.rowH} + 2 gaps = ${3 * p.rowH + 2 * k.SESSION_ROW_GAP} <= avail ${p.avail}`);
      // AND NO BAND CARD HERE, which is the ladder's own answer at this count and
      // the thing the two pictures are meant to be read against each other for.
      const leftover = p.avail - 2 * (p.rowH + k.SESSION_ROW_GAP);
      chk(leftover < k.SESSION_EXP_MIN_H,
          `${tag}: leftover ${leftover} is under the ${k.SESSION_EXP_MIN_H} floor, so three sessions ` +
          `get three spine rows and no band card`);
    }
  }
}

// ---- 3. ASCII only ----
chk(BAD_CHARS.length === 0,
    `every string is ASCII 0x20..0x7E - the fonts hold nothing else, and an ` +
    `out-of-range codepoint draws nothing AND advances nothing` +
    (BAD_CHARS.length ? ` - ${BAD_CHARS.map(([s, c]) => `${JSON.stringify(c)} in "${s}"`).join(", ")}` : ""));

console.log(`\n${total} assertions, ${fail} failures`);
if (SELFTEST) {
  console.log(fail > 0
    ? `selftest ok - the injected fault produced ${fail} failure(s)`
    : "SELFTEST FAILED - the injected fault was not caught");
  process.exit(fail > 0 ? 0 : 1);
}
process.exit(fail ? 1 : 0);
