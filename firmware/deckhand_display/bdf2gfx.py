#!/usr/bin/env python3
"""Convert a BDF bitmap font to an Adafruit_GFX font header (TFT_eSPI compatible).

Used to (re)generate Cozette6x13.h, the font the device uses for code-block
rendering. To regenerate:

    curl -sSL -o cozette.bdf \\
      https://github.com/slavfox/Cozette/releases/latest/download/cozette.bdf
    python3 bdf2gfx.py cozette.bdf Cozette6x13 13 > Cozette6x13.h

Attribution is read from the BDF's own STARTPROPERTIES block, so a generated
header always carries its own font's copyright. Only printable ASCII
0x20..0x7E is emitted (all the renderer needs).

Self-check the output against its source, and prove the checker has teeth:

    python3 bdf2gfx.py --verify   cozette.bdf Cozette6x13.h
    python3 bdf2gfx.py --selftest cozette.bdf Cozette6x13.h

Each glyph is byte-aligned (padded at its end): TFT_eSPI's drawChar resets its
bit phase per glyph and reads from the MSB of bitmap[bitmapOffset], so a glyph
must start on a byte boundary. Within a glyph, bits are packed row-major
MSB-first with no per-row padding.
"""
import sys, re, os

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

def parse_props(path):
    """Font-level STARTPROPERTIES values (FAMILY_NAME, COPYRIGHT, PIXEL_SIZE, ...).

    Read so a generated header carries its OWN font's attribution: emitting one
    font's glyphs under another's copyright is a licensing defect, not cosmetics.
    The block sits before the first STARTCHAR, so stopping at ENDPROPERTIES is
    both correct and cheap.
    """
    props = {}
    inblock = False
    with open(path, "r", errors="replace") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            if ln.startswith("STARTPROPERTIES"):
                inblock = True
                continue
            if ln.startswith("ENDPROPERTIES"):
                break
            if not inblock:
                continue
            parts = ln.split(None, 1)
            if len(parts) == 2:
                props[parts[0]] = parts[1].strip().strip('"')
    return props

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

def _header_tables(src):
    """Pull the bitmap bytes, glyph table and yAdvance back out of a generated header."""
    def section(tag):
        return src.split(f"{tag}[] PROGMEM")[1].split("};")[0]
    bm = [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", section("Bitmaps"))]
    tbl = [tuple(int(v) for v in t) for t in re.findall(
        r"\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\}",
        section("Glyphs"))]
    m = re.search(r"0x[0-9A-Fa-f]{2},\s*0x[0-9A-Fa-f]{2},\s*(\d+)\s*\}", src)
    return bm, tbl, (int(m.group(1)) if m else None)


def verify(bdf_path, header_path):
    """Decode a generated header and compare it glyph-for-glyph with its source BDF.

    Returns a list of problems; empty means the header is faithful. This exists
    because bdf2gfx.py had only ever been run against Cozette, whose glyphs are
    tightly cropped; a font with a uniform full-cell BBX exercises packing paths
    that had never run.
    """
    glyphs = parse_bdf(bdf_path)
    props = parse_props(bdf_path)
    src = open(header_path).read()
    bm, tbl, yadv = _header_tables(src)
    problems = []

    expected_count = LAST - FIRST + 1
    if len(tbl) != expected_count:
        problems.append(f"glyph table has {len(tbl)} entries, expected {expected_count}")

    if yadv is None:
        problems.append("no yAdvance found in the GFXfont initialiser")
    elif "FONT_ASCENT" in props and "FONT_DESCENT" in props:
        want = int(props["FONT_ASCENT"]) + int(props["FONT_DESCENT"])
        if yadv != want:
            problems.append(f"yAdvance {yadv} != FONT_ASCENT+FONT_DESCENT {want}")

    for i, code in enumerate(range(FIRST, LAST + 1)):
        if i >= len(tbl):
            break
        off, w, h, adv, xo, yo = tbl[i]
        g = glyphs.get(code)
        if g is None:
            continue
        (sw, sh, sxo, syo), dw, rows = g
        want = (sw, sh, dw if dw is not None else 6, sxo, -(syo + sh))
        if (w, h, adv, xo, yo) != want:
            problems.append(f"0x{code:02X} {chr(code)!r}: metrics {(w, h, adv, xo, yo)} != {want}")
            continue
        expect = glyph_bits((sw, sh, sxo, syo), rows)
        got = []
        bit = off * 8
        truncated = False
        for _ in range(w * h):
            if (bit >> 3) >= len(bm):
                problems.append(f"0x{code:02X} {chr(code)!r}: bitmap truncated")
                truncated = True
                break
            got.append((bm[bit >> 3] >> (7 - (bit & 7))) & 1)
            bit += 1
        if not truncated and got != expect:
            problems.append(f"0x{code:02X} {chr(code)!r}: bitmap differs")
    return problems

def selftest(bdf_path, header_path):
    """Prove --verify has teeth: a one-byte corruption MUST be caught.

    Mirrors palette-check.mjs --selftest. A checker that cannot fail is not a
    check. 'A' is corrupted specifically because it is guaranteed to have inked
    pixels that verify() actually reads - flipping a byte inside a blank glyph
    would go undetected for legitimate reasons and make this test lie.
    """
    clean = verify(bdf_path, header_path)
    if clean:
        return ["header does not verify before tampering: " + "; ".join(clean[:3])]

    src = open(header_path).read()
    bm, tbl, _ = _header_tables(src)
    off = tbl[0x41 - FIRST][0]          # 'A'
    if off >= len(bm):
        return ["cannot corrupt 'A': offset past the end of the bitmap"]
    bm[off] ^= 0xFF

    head, rest = src.split("Bitmaps[] PROGMEM = {", 1)
    _body, tail = rest.split("};", 1)
    lines = ["  " + ", ".join(f"0x{b:02X}" for b in bm[i:i + 16]) + ","
             for i in range(0, len(bm), 16)]
    tampered = head + "Bitmaps[] PROGMEM = {\n" + "\n".join(lines) + "\n};" + tail

    tmp = header_path + ".selftest"
    with open(tmp, "w") as f:
        f.write(tampered)
    try:
        caught = verify(bdf_path, tmp)
    finally:
        os.remove(tmp)

    if not caught:
        return ["a corrupted bitmap byte was NOT caught - the checker has no teeth"]
    return []

def main():
    bdf = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "Cozette6x13"
    yadv = int(sys.argv[3]) if len(sys.argv) > 3 else 13
    glyphs = parse_bdf(bdf)
    props = parse_props(bdf)

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
    family = props.get("FAMILY_NAME", name)
    weight = props.get("WEIGHT_NAME", "")
    pixsz = props.get("PIXEL_SIZE", str(yadv))
    copyr = props.get("COPYRIGHT", "see the source font's own licence")
    face = f"{family} {pixsz}px" + (f" {weight}" if weight and weight != "Medium" else "")
    out.append(f"// {face} - Adafruit_GFX font, printable ASCII 0x20-0x7E only.")
    out.append(f"// Generated from {os.path.basename(bdf)} by bdf2gfx.py - do not edit by hand.")
    out.append(f"// {copyr}")
    out.append("// Licence: firmware/deckhand_display/licenses/ has the full text.")
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

def _run_check(kind, bdf_path, header_path):
    problems = (verify if kind == "--verify" else selftest)(bdf_path, header_path)
    label = os.path.basename(header_path)
    if problems:
        print(f"FAIL {label}: {len(problems)} problem(s)")
        for p in problems[:20]:
            print("  " + p)
        if len(problems) > 20:
            print(f"  ... and {len(problems) - 20} more")
        return 1
    word = "matches its BDF" if kind == "--verify" else "selftest passed (corruption caught)"
    print(f"PASS {label}: {word}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] in ("--verify", "--selftest"):
        sys.exit(_run_check(sys.argv[1], sys.argv[2], sys.argv[3]))
    main()
