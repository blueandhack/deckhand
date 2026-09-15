#!/usr/bin/env python3
"""Render the assembled case with a real screenshot on its screen.

    python3 case/render-hero.py --board 2 docs/screenshot-sessions.png docs/device-hero.png
    python3 case/render-hero.py docs/screenshot-sessions-board1.png /tmp/hero-b1.png

Runs OpenSCAD on the board's hero wrapper, finds the magenta screen quad in the
rendered pixels, and draws the screenshot into it. Four things are worth knowing
before changing it:

THERE ARE TWO CASES AND --board PICKS ONE (default 1). It selects the wrapper -
hero.scad or hero-b2.scad - and each of those `include`s its own case file. That is
why the choice is a whole file rather than a -D: `include` takes a literal path.

THE CAPTURE IS CHECKED AGAINST THE BOARD'S OWN PANEL SIZE, parsed out of
firmware/deckhand_display/board_*.h. The quad check further down is on the RENDER
and cannot catch a board 1 capture handed to board 2's case - it would be stretched
into the hole without complaint, and a product shot is where nobody looks twice.
BOARD_W/BOARD_H and win_w/win_h are READ from those files, never transcribed, so a
panel or a window that changes fails here rather than drifting.

THE CAMERA IS STRAIGHT-ON, AND THAT IS FORCED, not a style choice. The window is
recessed behind a chamfer, so at any tilt the case's own front face hides the screen -
measured by sweeping the camera and counting visible screen pixels: 27,360 at
rx=180 (straight on) against at most ~74 anywhere else. A three-quarter view of this
case is necessarily a view of a dark empty slot. Straight-on also means the screen is
an axis-aligned rectangle, so the composite needs no perspective warp.

THE SCREEN IS LOCATED BY COLOUR, NOT BY ARITHMETIC. The wrapper paints the display
pure magenta and this looks for those pixels, so the alignment survives a change to
the camera, the image size, or any case dimension. Re-deriving the projection by hand
would be one more thing to keep in sync, and silently wrong when it drifted.

BOTH WINDOWS ARE ~1% WIDER THAN THEIR PANEL and the composite stretches to fill,
because the window is a hole in a printed part and the panel is a panel: 44x58mm
around 240x320 (0.759 vs 0.750), 50.6x75.0mm around 320x480 (0.675 vs 0.667). It is
under half a pixel per 100, and it is the reason the aspect check has a tolerance
rather than being exact.

Pure stdlib on purpose: this toolchain has no Pillow and no numpy (the same reason
spark2c.py and codex2c.py carry their own PNG code).
"""
import subprocess, sys, zlib, struct, pathlib, os, re

HERE = pathlib.Path(__file__).resolve().parent
FIRMWARE = HERE.parent / "firmware" / "deckhand_display"
# The render size per board, chosen so the screen quad lands at ~1.8x the panel:
# big enough that the bitmap UI stays crisp under a nearest-neighbour upscale,
# small enough that the PNG stays a README asset. The aspect check below is what
# actually guards the geometry, so these numbers can move.
BOARDS = {
    1: {"wrapper": "hero.scad",    "case": "deckhand_case.scad",
        "header": "board_e32r28t.h", "img": (900, 1150)},
    2: {"wrapper": "hero-b2.scad", "case": "deckhand_case_b2.scad",
        "header": "board_es3c35p.h", "img": (968, 1475)},
}


def one_number(path, pattern, what):
    """The single value `pattern` matches in `path`, or exit saying which file lied.

    Requires exactly one match on purpose: a second assignment further down the
    file would make the first one a comment, and silently picking either is how a
    parsed constant goes back to being a transcribed one.
    """
    hits = re.findall(pattern, pathlib.Path(path).read_text(), re.M)
    if len(hits) != 1:
        sys.exit(f"{path}: expected exactly one {what}, found {len(hits)}")
    return float(hits[0])


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
    argv = sys.argv[1:]
    board = 1
    if "--board" in argv:
        i = argv.index("--board")
        board = int(argv[i + 1])
        del argv[i:i + 2]
    if len(argv) != 2 or board not in BOARDS:
        sys.exit(__doc__)
    cfg = BOARDS[board]
    shot, out = argv[0], argv[1]
    raw = HERE / "hero-raw.png"

    # What this board's panel is, from the header that defines it for the firmware.
    panel = (int(one_number(FIRMWARE / cfg["header"], r"^#define BOARD_W\s+(\d+)", "BOARD_W")),
             int(one_number(FIRMWARE / cfg["header"], r"^#define BOARD_H\s+(\d+)", "BOARD_H")))

    img_w, img_h = cfg["img"]
    subprocess.run(
        ["openscad", "-o", str(raw), f"--imgsize={img_w},{img_h}", "--projection=o",
         "--viewall", "--autocenter", "--camera=0,0,0,180,0,0,0",
         "-D", 'part="none"', "--colorscheme=Tomorrow", str(HERE / cfg["wrapper"])],
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

    # The quad must come out at the window's own aspect - read from the case file
    # rather than written here, so moving the window fails the render instead of
    # quietly reshaping the screen. A mismatch means the marker leaked or the camera
    # is not straight-on any more, and the composite would be stretched rather than
    # wrong in an obvious way - so it fails loudly instead.
    scad = HERE / cfg["case"]
    # Both files put the pair on one line ("win_w = 44.0; win_h = 58.0; ..."), so the
    # anchor is start-of-line OR a preceding semicolon - not ^ alone, which finds win_w
    # and then reports win_h missing.
    want = (one_number(scad, r"(?:^|;)\s*win_w\s*=\s*([0-9.]+)", "win_w")
            / one_number(scad, r"(?:^|;)\s*win_h\s*=\s*([0-9.]+)", "win_h"))
    got = qw / qh
    if abs(got - want) > 0.02:
        sys.exit(f"screen quad aspect {got:.3f} != {want:.3f} - camera not straight-on?")

    sw, sh, spx = read_png(shot)
    # The one thing the quad check above cannot see: whether this capture came off
    # THIS board. Both are plausible PNGs of the right shape, and the wrong one is a
    # stretched screen in a product shot rather than an error.
    if (sw, sh) != panel:
        sys.exit(f"{shot} is {sw}x{sh}, but board {board}'s panel is {panel[0]}x{panel[1]} "
                 f"({cfg['header']}) - that is a capture from the other board")
    # Nearest-neighbour on purpose: this is a hand-hinted bitmap UI on a low-DPI panel,
    # and smoothing it would make the render look softer than the real screen does.
    for y in range(y0, y1 + 1):
        sy = min(sh - 1, (y - y0) * sh // qh)
        row, srow = px[y], spx[sy]
        for x in range(x0, x1 + 1):
            if is_key(row[x]):
                row[x] = srow[min(sw - 1, (x - x0) * sw // qw)]

    write_png(out, w, h, px)
    print(f"  {out}: {w}x{h}, board {board} screen {qw}x{qh} at ({x0},{y0}) "
          f"<- {shot} ({sw}x{sh}, {qw / sw:.2f}x)")


if __name__ == "__main__":
    main()
