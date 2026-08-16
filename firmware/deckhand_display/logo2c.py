#!/usr/bin/env python3
"""Generate DeckhandLogo.h - the Deckhand logo, with its wheel turning - from docs/logo.svg.

    python3 logo2c.py ../../docs/logo.svg > DeckhandLogo.h

The logo is drawn on the standalone (pre-host) screen. Unlike the spark and the Codex
mark, this is the project's actual mark rather than a status glyph, so it keeps its own
colours instead of being tinted - but it is NOT one flat image, because the wheel has to
rotate while the hand holding it stays put.

FOUR LAYERS, and the split comes straight from the SVG's own paint order:

    LOGO_BG    96x96 RGB565   the tile gradient plus the arm and palm BEHIND the wheel
    LOGO_TILE  96x96 2bpp     the rounded-rect silhouette
    LOGO_WHEEL 96x96 2bpp x8  the wheel, rotating - the only thing that moves
    LOGO_FG    96x96 2bpp     the four fingers, which wrap IN FRONT of the rim

At draw time the device starts from LOGO_BG, fades it to the live COLOR_BG through
LOGO_TILE, then lays the wheel and the fingers over it in their own flat colours. Two
reasons it is built this way rather than as 8 pre-composited full-colour frames:
  * 8 full frames would be 147KB against this 41KB, for art on a screen you see rarely.
  * LOGO_TILE is what lets the ROUNDED CORNERS meet whichever theme is live. Baking a
    background into the image would put a hard square of the wrong colour behind the
    mark under one of DARK/LIGHT, and it is a coin flip which.
LOGO_BG is therefore rendered with SQUARE corners on purpose - the gradient runs right
to the edge and LOGO_TILE does the shaping, so the corner anti-aliasing blends against
the real page colour instead of a guess baked in at build time.

THE ROTATION STEP IS 7.5 DEGREES, AND THAT IS FORCED - do not "tidy" it to 45.
The wheel has exact 6-fold symmetry: three spokes drawn as full diameters give six arms,
and the six grips sit at 0/60/.../300. So a 60-degree turn is a NO-OP - 8 frames at 45
degrees would neither loop seamlessly (45 does not divide 60) nor show a full cycle, and
8 at 60 would emit 8 identical frames. 60/FRAMES is the only step that both moves and
closes the loop. The guard at the bottom MEASURES that motion rather than comparing
frames for equality, because at a 60-degree step the frames are visually identical yet
still differ by rasteriser sub-pixel noise - an equality test would never fire.

The hub is punched out as a hole in the wheel mask, so the tile gradient shows through
it. The source paints it #1B5FA6 while the gradient reads about #2F76B8 there; across a
~3px dot that is not a difference anyone can see, and a fifth layer for it would be.

Rasterising needs Google Chrome, which macOS already has - there is no SVG rasteriser in
this toolchain (no rsvg-convert/inkscape/cairosvg/Pillow). Everything renders at 4x and
is box-filtered down, which is where the anti-aliasing comes from.
"""
import re, subprocess, sys, tempfile, struct, zlib, pathlib

FRAMES, SIZE, SCALE = 8, 96, 4
RENDER = SIZE * SCALE
SYMMETRY_DEG = 60          # see the module docstring - not a free parameter
# Measured at this SIZE: the real 7.5-degree step moves at least 0.161 mean absolute
# alpha against frame 0, while a 60-degree (no-op) step measures 0.000 exactly - the
# frames really are byte-identical there. 0.05 therefore sits ~3x under the signal and
# above any rasteriser noise. Re-measure this if SIZE or the art changes: the figure is
# resolution-dependent (it was 0.371 at 64x64), so it is not a constant to copy around.
MIN_MOTION = 0.05
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# The wheel's centre, and the tile's box, in the source's 512x512 user space.
CX, CY = 250, 238
TILE_X, TILE_Y, TILE_W, TILE_R = 16, 16, 480, 118


def extract(svg):
    """Pull the pieces out of the real logo, so this can never drift from it."""
    out = {}
    defs = re.findall(r'<rect id="(?:spoke|grip|finger)"[^>]*/>', svg)
    if len(defs) != 3:
        sys.exit(f"expected the spoke/grip/finger defs, found {len(defs)}")
    out["defs"] = "".join(defs)
    for key, pat in (("grad",  r'<linearGradient id="tile".*?</linearGradient>'),
                     ("arm",   r'<g fill="#E89A6B">.*?</g>'),
                     ("wheel", r'<g fill="#FBF4E9">.*?</g>'),
                     ("fg",    r'<g fill="#F8BE92">.*?</g>')):
        m = re.search(pat, svg, re.S)
        if not m:
            sys.exit(f"could not find the {key} layer in the logo")
        out[key] = m.group(0)
    # The flat colours ride along from the source rather than being retyped here.
    out["cream"] = re.search(r'<g fill="(#[0-9A-Fa-f]{6})">\s*<use href="#spoke"', svg).group(1)
    out["flesh"] = re.search(r'<g fill="(#[0-9A-Fa-f]{6})">\s*<use href="#finger"', svg).group(1)
    return out


def shoot(inner, out_png, tmp, tag, defs=""):
    vb = f"{TILE_X} {TILE_Y} {TILE_W} {TILE_W}"
    html = tmp / f"{tag}.html"
    html.write_text(
        '<!doctype html><html><body style="margin:0;background:#000">'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{RENDER}" height="{RENDER}" '
        f'viewBox="{vb}"><defs>{defs}</defs>{inner}</svg></body></html>'
    )
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--screenshot={out_png}",
         f"--window-size={RENDER},{RENDER}", f"file://{html}"],
        check=True, capture_output=True,
    )


def read_png(path):
    """Minimal 8-bit RGB/RGBA non-interlaced PNG reader -> rows of (r,g,b)."""
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
        rows.append([tuple(line[x * nch + k] for k in range(3)) for x in range(w)])
    return rows


def down_rgb565(rows):
    """Box-filter to SIZE and pack RGB565, big-endian in a uint16 per pixel."""
    k, out = SCALE, []
    for y in range(SIZE):
        for x in range(SIZE):
            r = g = b = 0
            for dy in range(k):
                for dx in range(k):
                    p = rows[y * k + dy][x * k + dx]
                    r += p[0]; g += p[1]; b += p[2]
            n = k * k
            r, g, b = r // n, g // n, b // n
            out.append(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
    return out


def down_2bpp(rows):
    """Box-filter luminance to SIZE, quantise to 2 bits, 4 px per byte, MSB first."""
    k, stride = SCALE, SIZE // 4
    out = bytearray(SIZE * stride)
    for y in range(SIZE):
        for x in range(SIZE):
            s = sum(rows[y * k + dy][x * k + dx][0] for dy in range(k) for dx in range(k))
            v = min(3, (s // (k * k)) * 4 // 256)
            out[y * stride + (x >> 2)] |= v << (6 - 2 * (x & 3))
    return out


def hex565(h):
    r, g, b = int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def emit_bytes(name, decl, data):
    print(f"const uint8_t {name}{decl} PROGMEM = {{")
    print("  " + ",".join(str(b) for b in data))
    print("};")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    L = extract(pathlib.Path(sys.argv[1]).read_text())
    stride = SIZE // 4
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        # 1. Background: SQUARE gradient (LOGO_TILE does the shaping) plus arm and palm.
        shoot(f'<defs>{L["grad"]}</defs>'
              f'<rect x="{TILE_X}" y="{TILE_Y}" width="{TILE_W}" height="{TILE_W}" '
              f'fill="url(#tile)"/>{L["arm"]}', tmp / "bg.png", tmp, "bg")
        bg = down_rgb565(read_png(tmp / "bg.png"))
        # 2. The rounded-rect silhouette, for the corners against the live background.
        shoot(f'<rect x="{TILE_X}" y="{TILE_Y}" width="{TILE_W}" height="{TILE_W}" '
              f'rx="{TILE_R}" fill="#fff"/>', tmp / "tile.png", tmp, "tile")
        tile = down_2bpp(read_png(tmp / "tile.png"))
        # 3. The wheel, rotating, white with the hub punched back out as a hole.
        wheel = []
        for i in range(FRAMES):
            ang = i * SYMMETRY_DEG / FRAMES
            body = L["wheel"].replace("#FBF4E9", "#fff")
            shoot(f'<g transform="rotate({ang} {CX} {CY})">{body}'
                  f'<circle cx="{CX}" cy="{CY}" r="14" fill="#000"/></g>',
                  tmp / f"w{i}.png", tmp, f"w{i}", L["defs"])
            wheel.append(down_2bpp(read_png(tmp / f"w{i}.png")))
        # 4. The fingers, in front of the rim.
        shoot(L["fg"].replace(L["flesh"], "#fff"), tmp / "fg.png", tmp, "fg", L["defs"])
        fg = down_2bpp(read_png(tmp / "fg.png"))

    # A static cycle is a silent failure: a dead-still wheel on a waiting screen reads
    # as a hung device, which is the one thing this animation exists to rule out. This
    # measures motion rather than testing equality - see the module docstring.
    def motion(a, b):
        ua = [(x >> s) & 3 for x in a for s in (6, 4, 2, 0)]
        ub = [(x >> s) & 3 for x in b for s in (6, 4, 2, 0)]
        return sum(abs(p - q) for p, q in zip(ua, ub)) / len(ua)
    worst = min(motion(wheel[0], f) for f in wheel[1:])
    if worst < MIN_MOTION:
        sys.exit(f"the rotation step is a visual no-op (motion {worst:.4f} < {MIN_MOTION}) - "
                 f"check SYMMETRY_DEG against the wheel's actual symmetry")

    print("// Generated by logo2c.py from docs/logo.svg - do not edit by hand.")
    print(f"// The Deckhand logo at {SIZE}x{SIZE}, in four layers so the wheel can turn while")
    print("// the hand holding it stays put, and so the rounded corners meet the live theme:")
    print("//   LOGO_BG    RGB565  tile gradient + the arm and palm behind the wheel")
    print("//   LOGO_TILE  2bpp    rounded-rect silhouette (corners -> the page colour)")
    print(f"//   LOGO_WHEEL 2bpp    the wheel, {FRAMES} frames, {SYMMETRY_DEG}/{FRAMES} degrees apart")
    print("//   LOGO_FG    2bpp    the four fingers, in front of the rim")
    print("#pragma once")
    print("#include <pgmspace.h>")
    print(f"#define LOGO_FRAMES {FRAMES}")
    print(f"#define LOGO_SIZE   {SIZE}")
    print(f"#define LOGO_STRIDE {stride}")
    print(f"#define LOGO_CREAM  0x{hex565(L['cream']):04X}   // {L['cream']}")
    print(f"#define LOGO_FLESH  0x{hex565(L['flesh']):04X}   // {L['flesh']}")
    print(f"const uint16_t LOGO_BG[{SIZE}*{SIZE}] PROGMEM = {{")
    print("  " + ",".join(f"0x{v:04X}" for v in bg))
    print("};")
    emit_bytes("LOGO_TILE", f"[{SIZE}*{stride}]", tile)
    print(f"const uint8_t LOGO_WHEEL[{FRAMES}][{SIZE}*{stride}] PROGMEM = {{")
    for f in wheel:
        print("  {" + ",".join(str(b) for b in f) + "},")
    print("};")
    emit_bytes("LOGO_FG", f"[{SIZE}*{stride}]", fg)


if __name__ == "__main__":
    main()
