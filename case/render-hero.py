#!/usr/bin/env python3
"""Render the assembled case with a real screenshot on its screen.

    python3 case/render-hero.py docs/screenshot-sessions.png docs/device-hero.png

Runs OpenSCAD on hero.scad, finds the magenta screen quad in the rendered pixels,
and draws the screenshot into it. Two things are worth knowing before changing it:

THE CAMERA IS STRAIGHT-ON, AND THAT IS FORCED, not a style choice. The window is
recessed behind a chamfer, so at any tilt the case's own front face hides the screen -
measured by sweeping the camera and counting visible screen pixels: 27,360 at
rx=180 (straight on) against at most ~74 anywhere else. A three-quarter view of this
case is necessarily a view of a dark empty slot. Straight-on also means the screen is
an axis-aligned rectangle, so the composite needs no perspective warp.

THE SCREEN IS LOCATED BY COLOUR, NOT BY ARITHMETIC. hero.scad paints the display
pure magenta and this looks for those pixels, so the alignment survives a change to
the camera, the image size, or any case dimension. Re-deriving the projection by hand
would be one more thing to keep in sync, and silently wrong when it drifted.

Pure stdlib on purpose: this toolchain has no Pillow and no numpy (the same reason
spark2c.py and codex2c.py carry their own PNG code).
"""
import subprocess, sys, zlib, struct, pathlib, os

HERE = pathlib.Path(__file__).resolve().parent
# 900x1150 puts the screen quad at ~434x573 for a 240x320 panel - a ~1.8x upscale,
# which keeps the bitmap UI crisp without the file getting large. The aspect check
# below is what actually guards this, so the numbers can move.
IMG_W, IMG_H = 900, 1150


def read_png(path):
    """Minimal 8-bit RGB/RGBA non-interlaced PNG reader -> (w, h, rows of (r,g,b))."""
    d = pathlib.Path(path).read_bytes()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    pos, idat, nch = 8, b"", 3
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ, body = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, bitd, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            assert bitd == 8 and inter == 0 and ctype in (2, 6), f"{path}: unsupported PNG"
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
        rows.append([tuple(line[x * nch:x * nch + 3]) for x in range(w)])
    return w, h, rows


def write_png(path, w, h, rows):
    raw = bytearray()
    for r in rows:
        raw.append(0)
        for px in r:
            raw += bytes(px)
    def chunk(t, d):
        import binascii
        body = t + d
        return struct.pack(">I", len(d)) + body + struct.pack(">I", binascii.crc32(body) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    pathlib.Path(path).write_bytes(png)


def is_key(p):
    """The magenta screen marker, tolerant of the renderer's shading."""
    return p[0] > 170 and p[2] > 170 and p[1] < 90


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    shot, out = sys.argv[1], sys.argv[2]
    raw = HERE / "hero-raw.png"

    subprocess.run(
        ["openscad", "-o", str(raw), f"--imgsize={IMG_W},{IMG_H}", "--projection=o",
         "--viewall", "--autocenter", "--camera=0,0,0,180,0,0,0",
         "-D", 'part="none"', "--colorscheme=Tomorrow", str(HERE / "hero.scad")],
        check=True, capture_output=True,
    )
    w, h, px = read_png(raw)
    os.remove(raw)

    xs = [x for r in px for x, p in enumerate(r) if is_key(p)]
    ys = [y for y, r in enumerate(px) for p in r if is_key(p)]
    if not xs:
        sys.exit("no screen found in the render - did the camera or hero.scad change?")
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    qw, qh = x1 - x0 + 1, y1 - y0 + 1

    # The active area is 44x58mm showing a 240x320 panel, so the quad must come out
    # at that aspect. A mismatch means the marker leaked or the camera is not
    # straight-on any more, and the composite would be stretched rather than wrong in
    # an obvious way - so it fails loudly instead.
    want = 44 / 58
    got = qw / qh
    if abs(got - want) > 0.02:
        sys.exit(f"screen quad aspect {got:.3f} != {want:.3f} - camera not straight-on?")

    sw, sh, spx = read_png(shot)
    # Nearest-neighbour on purpose: this is a hand-hinted bitmap UI on a low-DPI panel,
    # and smoothing it would make the render look softer than the real screen does.
    for y in range(y0, y1 + 1):
        sy = min(sh - 1, (y - y0) * sh // qh)
        row, srow = px[y], spx[sy]
        for x in range(x0, x1 + 1):
            if is_key(row[x]):
                row[x] = srow[min(sw - 1, (x - x0) * sw // qw)]

    write_png(out, w, h, px)
    print(f"  {out}: {w}x{h}, screen {qw}x{qh} at ({x0},{y0}) <- {shot} ({sw}x{sh})")


if __name__ == "__main__":
    main()
