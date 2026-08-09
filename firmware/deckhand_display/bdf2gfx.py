#!/usr/bin/env python3
"""Convert a BDF bitmap font to an Adafruit_GFX font header (TFT_eSPI compatible).

Used to (re)generate Cozette6x13.h, the font the device uses for code-block
rendering. To regenerate:

    curl -sSL -o cozette.bdf \\
      https://github.com/slavfox/Cozette/releases/latest/download/cozette.bdf
    python3 bdf2gfx.py cozette.bdf Cozette6x13 13 > Cozette6x13.h

Cozette is (c) Ines / the.moonwit.ch, MIT/OFL licensed. Only printable ASCII
0x20..0x7E is emitted (all the code renderer needs), keeping the header ~1KB.

Each glyph is byte-aligned (padded at its end): TFT_eSPI's drawChar resets its
bit phase per glyph and reads from the MSB of bitmap[bitmapOffset], so a glyph
must start on a byte boundary. Within a glyph, bits are packed row-major
MSB-first with no per-row padding.
"""
import sys, re

FIRST, LAST = 0x20, 0x7E

def parse_bdf(path):
    glyphs = {}
    with open(path, "r", errors="replace") as f:
        lines = f.read().splitlines()
    i = 0
    n = len(lines)
    while i < n:
        if lines[i].startswith("STARTCHAR"):
            enc = None; bbx = None; dwidth = None; rows = []
            i += 1
            while i < n and not lines[i].startswith("ENDCHAR"):
                ln = lines[i]
                if ln.startswith("ENCODING"):
                    enc = int(ln.split()[1])
                elif ln.startswith("DWIDTH"):
                    dwidth = int(ln.split()[1])
                elif ln.startswith("BBX"):
                    p = ln.split()
                    bbx = (int(p[1]), int(p[2]), int(p[3]), int(p[4]))  # w h xoff yoff
                elif ln == "BITMAP":
                    i += 1
                    while i < n and not lines[i].startswith("ENDCHAR"):
                        rows.append(lines[i].strip())
                        i += 1
                    break
                i += 1
            if enc is not None and bbx is not None:
                glyphs[enc] = (bbx, dwidth, rows)
        i += 1
    return glyphs

def glyph_bits(bbx, rows):
    """Return list of bits (row-major, width bits per row) for the glyph bitmap."""
    w, h, _, _ = bbx
    bits = []
    for r in range(h):
        hexrow = rows[r] if r < len(rows) else ""
        # each row is byte-padded: ceil(w/8) bytes, hex encoded
        rowbytes = bytes.fromhex(hexrow) if hexrow else b""
        for c in range(w):
            byte_i = c // 8
            bit_i = 7 - (c % 8)
            val = 0
            if byte_i < len(rowbytes):
                val = (rowbytes[byte_i] >> bit_i) & 1
            bits.append(val)
    return bits

def main():
    bdf = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "Cozette6x13"
    yadv = int(sys.argv[3]) if len(sys.argv) > 3 else 13
    glyphs = parse_bdf(bdf)

    bitmap = []            # bytes of continuous bitstream
    bit_accum = 0
    bit_count = 0
    def push_bit(b):
        nonlocal bit_accum, bit_count
        bit_accum = (bit_accum << 1) | b
        bit_count += 1
        if bit_count == 8:
            bitmap.append(bit_accum)
            bit_accum = 0; bit_count = 0

    def flush():
        # Pad the partial byte with zeros. The TFT_eSPI/Adafruit decoder resets
        # its bit phase at every glyph and reads from the MSB of bitmap[offset],
        # so each glyph MUST start on a byte boundary.
        nonlocal bit_accum, bit_count
        if bit_count:
            bit_accum <<= (8 - bit_count)
            bitmap.append(bit_accum)
            bit_accum = 0; bit_count = 0

    glyph_table = []
    for code in range(FIRST, LAST + 1):
        g = glyphs.get(code)
        byte_offset = len(bitmap)  # glyphs are byte-aligned, so this is the start
        if g is None:
            # space fallback: zero-size glyph, just an advance
            glyph_table.append((byte_offset, 0, 0, 6, 0, 0))
            continue
        (w, h, xoff, yoff), dwidth, rows = g
        adv = dwidth if dwidth is not None else 6
        yoffset = -(yoff + h)
        for b in glyph_bits((w, h, xoff, yoff), rows):
            push_bit(b)
        flush()  # byte-align before the next glyph
        glyph_table.append((byte_offset, w, h, adv, xoff, yoffset))

    out = []
    out.append("// Cozette 6x13 - Adafruit_GFX font, printable ASCII 0x20-0x7E only.")
    out.append("// Generated from cozette.bdf by bdf2gfx.py. (c) Ines, OFL/MIT.")
    out.append("// Used for the code-block detail/reader rendering (crisp bitmap at this DPI).")
    out.append("#pragma once")
    out.append("#include <Arduino.h>")
    out.append("")
    out.append(f"const uint8_t {name}Bitmaps[] PROGMEM = {{")
    for i in range(0, len(bitmap), 16):
        chunk = ", ".join(f"0x{b:02X}" for b in bitmap[i:i+16])
        out.append("  " + chunk + ",")
    out.append("};")
    out.append("")
    out.append(f"const GFXglyph {name}Glyphs[] PROGMEM = {{")
    for code, (off, w, h, adv, xo, yo) in zip(range(FIRST, LAST + 1), glyph_table):
        ch = chr(code) if code != 0x5C else "backslash"
        out.append(f"  {{ {off:5d}, {w:2d}, {h:2d}, {adv:2d}, {xo:3d}, {yo:3d} }},  // 0x{code:02X} '{ch if code not in (0x20,) else 'space'}'")
    out.append("};")
    out.append("")
    out.append(f"const GFXfont {name} PROGMEM = {{")
    out.append(f"  (uint8_t  *){name}Bitmaps,")
    out.append(f"  (GFXglyph *){name}Glyphs,")
    out.append(f"  0x{FIRST:02X}, 0x{LAST:02X}, {yadv} }};")
    out.append("")
    sys.stdout.write("\n".join(out))
    sys.stderr.write(f"glyphs={LAST-FIRST+1} bitmap_bytes={len(bitmap)} table_bytes={len(glyph_table)*7}\n")

if __name__ == "__main__":
    main()
