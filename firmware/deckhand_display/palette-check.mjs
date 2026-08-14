#!/usr/bin/env node
// Validates the device's colour palettes. Run with no arguments to check the shipped
// themes; run with --selftest to prove the checks can actually fail.
//
// Two properties matter, and contrast alone is not enough. The first LIGHT candidate for
// this feature had BETTER contrast than DARK and still failed, because its three status
// colours sat at nearly one lightness - in greyscale they were indistinguishable. So this
// checks separability too, under a deuteranope approximation and by luminance.
//
// The device also encodes status by SHAPE, independently of colour. That is what makes a
// palette merely bad rather than unusable if it regresses - but the colour half should
// still work for people who can see it.

const to888 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
const from888 = (r, g, b) =>
  ((Math.round(r / 255 * 31) << 11) | (Math.round(g / 255 * 63) << 5) | Math.round(b / 255 * 31)) >>> 0;
const hex = (c) => "0x" + c.toString(16).toUpperCase().padStart(4, "0");
const css = (c) => "#" + to888(c).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => { const [r, g, b] = to888(c); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Brettel-style deuteranope approximation - coarse, but enough to catch collisions.
const deuter = (c) => {
  const [r, g, b] = to888(c);
  return from888(Math.min(255, 0.625 * r + 0.375 * g), Math.min(255, 0.700 * g + 0.300 * r),
                 Math.min(255, 0.300 * g + 0.700 * b));
};
const dist = (a, b) => {
  const [A, B] = [to888(a), to888(b)];
  return Math.round(Math.sqrt(A.reduce((s, v, i) => s + (v - B[i]) ** 2, 0)));
};

// THESE ARE THE SHIPPED VALUES. firmware/deckhand_display/deckhand_display.ino's THEMES[]
// table must match them exactly.
export const THEMES = [
  { name: "DARK",
    bg: 0x0000, card: 0x18C4, label: 0x8410, value: 0xFFFF, accent: 0xFD20,
    good: 0x0396, warn: 0xE4E0, bad: 0xCBD4, unknown: 0x7BEF },
  { name: "LIGHT",
    bg: 0xEF5C, card: 0xFFFF, label: 0x62CA, value: 0x18C3, accent: 0xB240,
    good: 0x12F4, warn: 0xB3A0, bad: 0x6887, unknown: 0x8C30 },
];

// Thresholds. TEXT_MIN is 3.0 not 4.5 on purpose: DARK ships at 3.38 for good-on-card and
// LIGHT at 3.80 for warn-on-card, both of which are pill fills and bar segments rather
// than body text. Raising this to 4.5 would fail the palette we deliberately chose.
const TEXT_MIN = 3.0;
const DEUTER_MIN = 40;   // below this two status colours look alike to a deuteranope
const LUM_MIN = 6;       // percent; below this they merge in greyscale

const PAIRS = [["value", "bg"], ["value", "card"], ["label", "bg"], ["label", "card"],
               ["accent", "bg"], ["accent", "card"], ["good", "card"], ["warn", "card"],
               ["bad", "card"]];

function check(theme, quiet = false) {
  const fails = [];
  if (!quiet) {
    console.log(`\n=== ${theme.name} ===`);
    for (const k of ["bg", "card", "label", "value", "accent", "good", "warn", "bad", "unknown"])
      console.log(`  ${k.padEnd(8)} ${hex(theme[k])}  ${css(theme[k])}`);
  }
  for (const [fg, bg] of PAIRS) {
    const r = contrast(theme[fg], theme[bg]);
    if (!quiet) console.log(`  contrast ${fg}/${bg}: ${r.toFixed(2)}${r < TEXT_MIN ? "  FAIL" : ""}`);
    if (r < TEXT_MIN) fails.push(`${theme.name}: ${fg} on ${bg} contrast ${r.toFixed(2)} < ${TEXT_MIN}`);
  }
  for (const [a, b] of [["good", "warn"], ["good", "bad"], ["warn", "bad"]]) {
    const d = dist(deuter(theme[a]), deuter(theme[b]));
    const l = Math.round(Math.abs(lum(theme[a]) - lum(theme[b])) * 100);
    if (!quiet) console.log(`  status ${a}/${b}: deuteranope ${d}, luminance gap ${l}%` +
                            `${d < DEUTER_MIN && l < LUM_MIN ? "  FAIL" : ""}`);
    // Either separator is enough: distinct hue for those who see it, distinct lightness
    // for those who do not.
    if (d < DEUTER_MIN && l < LUM_MIN)
      fails.push(`${theme.name}: ${a}/${b} indistinguishable (deuteranope ${d}, luminance ${l}%)`);
  }
  return fails;
}

if (process.argv.includes("--selftest")) {
  // A palette that must be rejected: grey text on grey, and three status colours that are
  // the same hue at the same lightness.
  const bad = { name: "SELFTEST-BAD", bg: 0x8410, card: 0x8410, label: 0x8410, value: 0x8410,
                accent: 0x8410, good: 0x07E0, warn: 0x07E0, bad: 0x07E0, unknown: 0x8410 };
  const fails = check(bad, true);
  if (fails.length === 0) {
    console.error("SELFTEST FAILED: the checker accepted a deliberately broken palette.");
    process.exit(1);
  }
  console.log(`selftest ok - rejected the bad palette with ${fails.length} finding(s)`);
  process.exit(0);
}

let all = [];
for (const t of THEMES) all = all.concat(check(t));
console.log("");
if (all.length) {
  for (const f of all) console.error("  FAIL " + f);
  process.exit(1);
}
console.log(`Both palettes pass (${THEMES.length} themes, ${PAIRS.length} contrast pairs, 3 status pairs each).`);
