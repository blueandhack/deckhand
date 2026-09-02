// Extract an Adafruit-GFX bitmap font header into per-row integers.
// Packing (confirmed from bdf2gfx.py:156-160): a continuous MSB-first bitstream
// per glyph, starting at bit 0 of bitmap[bitmapOffset]. Spleen's glyphs are
// full-cell so w*h/8 is a whole number of bytes and each glyph is byte-aligned,
// but the reader below does NOT rely on that - it walks bits.
import fs from "fs";

export function extract(path, name, wantChars) {
  const src = fs.readFileSync(path, "utf8");
  const bmMatch = src.match(new RegExp(`${name}Bitmaps\\[\\][^{]*\\{([\\s\\S]*?)\\};`));
  const glMatch = src.match(new RegExp(`${name}Glyphs\\[\\][^{]*\\{([\\s\\S]*?)\\};`));
  if (!bmMatch || !glMatch) throw new Error(`could not find tables for ${name}`);
  const bm = bmMatch[1].match(/0x[0-9a-fA-F]{2}/g).map(v => parseInt(v, 16));
  const glyphs = [];
  for (const line of glMatch[1].split("\n")) {
    const m = line.match(/\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/);
    if (m) glyphs.push({ off:+m[1], w:+m[2], h:+m[3], adv:+m[4], dx:+m[5], dy:+m[6] });
  }
  const fontM = src.match(new RegExp(`GFXfont ${name}[^{]*\\{[^}]*?0x([0-9A-Fa-f]{2})\\s*,\\s*0x([0-9A-Fa-f]{2})\\s*,\\s*(\\d+)`));
  const first = parseInt(fontM[1], 16), last = parseInt(fontM[2], 16), yAdv = +fontM[3];

  const out = { w:glyphs[0].w, h:glyphs[0].h, adv:glyphs[0].adv, yAdv, glyphs:{} };
  const codes = wantChars
    ? [...new Set([...wantChars].map(c => c.codePointAt(0)))]
    : Array.from({length:last-first+1}, (_,i)=>first+i);
  for (const cp of codes) {
    if (cp < first || cp > last) throw new Error(`0x${cp.toString(16)} out of range`);
    const g = glyphs[cp - first];
    const rows = [];
    for (let y = 0; y < g.h; y++) {
      let v = 0;
      for (let x = 0; x < g.w; x++) {
        const bit = y * g.w + x;
        const byte = g.off + (bit >> 3);
        const on = byte < bm.length ? (bm[byte] >> (7 - (bit & 7))) & 1 : 0;
        v = v * 2 + on;                     // *2 not <<1: 32-bit rows overflow |0
      }
      rows.push(v);
    }
    out.glyphs[cp] = rows;
  }
  return out;
}
