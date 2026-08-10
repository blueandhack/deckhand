#!/usr/bin/env python3
"""Generate CodexMark.h - the Codex 'working' animation - from the Codex mark SVG.

    python3 codex2c.py codex.svg > CodexMark.h

Same output format as spark2c.py's ClaudeSpark.h: 8 frames, 32x32, 2 bits of ALPHA
per pixel, which the firmware tints with the status colour at draw time. One copy of
the art serves any colour and the device needs no PNG decoder.

How the animation is made, and why:
  * The mark is ONE path with three contours and fill-rule evenodd: an 8-lobed blob,
    a chevron, and an underscore, where the latter two are HOLES in the blob. Split
    into separate paths they stop being holes, so this script draws the blob white and
    then paints the two glyphs BLACK on top - over a black background that reproduces
    the holes exactly, and luminance is then the mask.
  * The BLOB rotates and the glyphs stay upright. Rotating the glyphs too would spin
    the ">_" prompt upside down; leaving them put keeps the mark readable in every
    frame while the lobes carry the motion.
  * 8 frames x 45 degrees = one full turn, so the loop is seamless. 45 is not a no-op
    even though there are 8 lobes: measured, a 45-degree rotation differs from the
    original by 19.5/255 mean absolute luminance, because the lobes are organic rather
    than exactly repeated. (If they ever WERE exact, 45 would render 8 identical frames
    and the step would have to become 45/8.)

Rasterising needs Google Chrome, which macOS already has - there is no SVG rasteriser
in this toolchain (no rsvg-convert/inkscape/cairosvg/Pillow). Frames are rendered at
128px and box-filtered 4x4 down to 32, which is where the anti-aliasing comes from.
"""
import re, subprocess, sys, tempfile, zlib, struct, pathlib

FRAMES, SIZE, RENDER = 8, 32, 128
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def split_contours(svg_text):
    """-> (blob, chevron, underscore) as absolute-start path data."""
    d = re.search(r' d="([^"]+)"', svg_text).group(1)
    parts = re.split(r'(?<=z)(?=m)', d)
    if len(parts) != 3:
        sys.exit(f"expected 3 contours in the mark, found {len(parts)}")
    # Contours 2 and 3 open with a RELATIVE m from the previous contour's start point
    # (z returns there), so each needs converting to an absolute M or it lands nowhere.
    # SVG numbers may run together with no separator at all - "M8.086.457" is TWO
    # numbers, and a naive [\d.]+ swallows both and then fails to parse.
    NUM = r'-?(?:\d+\.\d+|\.\d+|\d+)'
    head = re.compile(rf'([Mm])\s*({NUM})[\s,]*({NUM})')
    m0 = head.match(parts[0])
    ox, oy = float(m0.group(2)), float(m0.group(3))
    out = [parts[0]]
    for part in parts[1:]:
        m = head.match(part)
        ox, oy = ox + float(m.group(2)), oy + float(m.group(3))
        out.append(f"M{ox:.4f} {oy:.4f}" + part[m.end():])
    return out


def render(blob, chev, und, angle, out_png, tmp):
    html = tmp / f"f{angle}.html"
    html.write_text(
        '<!doctype html><html><body style="margin:0;background:#000">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{RENDER}" height="{RENDER}" viewBox="0 0 24 24">'
        f'<g fill-rule="evenodd" clip-rule="evenodd">'
        f'<path fill="#fff" transform="rotate({angle} 12 12)" d="{blob}"/>'
        f'<path fill="#000" d="{chev}"/><path fill="#000" d="{und}"/>'
        "</g></svg></body></html>"
    )
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--screenshot={out_png}",
         f"--window-size={RENDER},{RENDER}", f"file://{html}"],
        check=True, capture_output=True,
    )


def read_png_gray(path):
    """Minimal 8-bit RGB/RGBA non-interlaced PNG reader -> rows of luminance."""
    d = pathlib.Path(path).read_bytes()
    assert d[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, nch = 8, b"", 3
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ, body = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, bitd, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            assert bitd == 8 and inter == 0 and ctype in (2, 6)
            nch = 3 if ctype == 2 else 4
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
    raw, stride = zlib.decompress(idat), w * nch
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(nch, stride): line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b, c = prev[i], (prev[i - nch] if i >= nch else 0)
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        rows.append([line[x * nch] for x in range(w)])
    return w, h, rows


def to_2bpp(rows, w, h):
    """Box-filter down to SIZE and quantise to 2 bits, packed 4 px per byte, MSB first."""
    k = w // SIZE
    stride = SIZE // 4
    out = bytearray(SIZE * stride)
    for y in range(SIZE):
        for x in range(SIZE):
            s = sum(rows[y * k + dy][x * k + dx] for dy in range(k) for dx in range(k))
            v = min(3, (s // (k * k)) * 4 // 256)
            out[y * stride + (x >> 2)] |= v << (6 - 2 * (x & 3))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    blob, chev, und = split_contours(pathlib.Path(sys.argv[1]).read_text())
    frames = []
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        for i in range(FRAMES):
            png = tmp / f"f{i}.png"
            render(blob, chev, und, i * 360 // FRAMES, png, tmp)
            w, h, rows = read_png_gray(png)
            frames.append(to_2bpp(rows, w, h))
    print("// Generated by codex2c.py - do not edit by hand.")
    print("// Codex 'working' animation: 8 frames, 32x32, 2 bits/pixel")
    print("// (alpha only - the firmware tints it with the status colour).")
    print("// The 8-lobed blob rotates a full turn across the cycle; the >_ glyphs stay")
    print("// upright so the mark stays readable in every frame.")
    print("#pragma once")
    print("#include <pgmspace.h>")
    print(f"#define CODEX_FRAMES {FRAMES}")
    print(f"#define CODEX_SIZE   {SIZE}")
    print(f"#define CODEX_STRIDE {SIZE // 4}")
    print(f"const uint8_t CODEX_BITS[{FRAMES}][{SIZE}*{SIZE // 4}] PROGMEM = {{")
    for f in frames:
        print("  {" + ",".join(str(b) for b in f) + "},")
    print("};")


if __name__ == "__main__":
    main()
