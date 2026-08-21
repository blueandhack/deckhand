#!/usr/bin/env python3
"""Generate MacEmoji.h - 13x13 per-Mac icon sprites - from the system emoji font.

    python3 emoji2c.py > MacEmoji.h
    python3 emoji2c.py --verify MacEmoji.h
    python3 emoji2c.py --selftest
    python3 emoji2c.py --preview out.png [MacEmoji.h]

Why this exists: the device's UI font, Cozette6x13, declares its glyph range as
0x20-0x7E - printable ASCII only - so it physically cannot draw an emoji character;
it would render as a blank box. A per-Mac icon is therefore ARTWORK, baked into
flash as a small colour sprite, exactly like the Claude spark and the Codex mark
are art rather than font glyphs.

Reuses codex2c.py's approach rather than inventing a new one: this toolchain has
no SVG/image library at all (no rsvg-convert, inkscape, cairosvg, Pillow), which is
why codex2c.py rasterises through headless Chrome and carries its own PNG reader.
This script does the same, but the source is a literal emoji character rendered
with the system's own colour emoji font (Apple Color Emoji), not an SVG path - and
unlike codex2c's reader, which keeps only luminance (it only ever needed an alpha
MASK), this one keeps colour AND alpha, because an emoji is colourful and its
transparency is what lets it sit on a card, a row, and either theme's background.

Output format, unlike the Claude-spark/Codex-mark 2bpp-alpha-only masks:
  - MAC_EMOJI_RGB[]:   one uint16 RGB565 colour per pixel, 169 (13x13) per icon.
    A fully-transparent pixel's colour is emitted as 0 - it is never drawn (see
    blit2bpp's lut[0] = bg), so its stored colour is irrelevant and zeroing it
    avoids baking in edge-of-glyph colour fringing that nobody will ever see.
  - MAC_EMOJI_ALPHA[]: 2 bits of alpha per pixel, 4 pixels per byte, high bits
    first, row stride (13+3)//4 = 4 bytes/row - the exact packing blit2bpp already
    unpacks with (byte >> (6 - 2*(x&3))) & 3. A later task's draw code reads these
    planes with that same arithmetic; get the packing wrong here and the art comes
    out sheared, which looks like a bad render rather than a bad packer.
  - MAC_EMOJI_NAMES[]: const char* const, same order as the two planes above.
  - macEmojiIndex(name): defined (not just declared) in the header - the Arduino
    build concatenates every .ino into one translation unit, and this header is
    included exactly once (from deckhand_display.ino), so a definition here is
    safe and saves a second file only this sketch would ever include.

13x13 is not an aesthetic choice: a usage card's label row runs y0+6..y0+19, right
up against the hero number's own clear box starting at y0+20, and 13 is also the
UI font's cell height - which is what lets a later surface place an icon at the
same y as neighbouring text with no per-surface centring arithmetic.

Rendering size: emoji are rasterised at 104px (not the 128px a first draft might
reach for) specifically so the box filter down to 13px is an exact, unweighted 8x8
average (104 = 13*8) - 128 does not divide 13 evenly, and a fractional box would
make the "re-render and compare" verifier fragile to rounding rather than a real
correctness check.
"""
import pathlib
import re
import struct
import subprocess
import sys
import tempfile
import zlib

SIZE = 13                    # MAC_EMOJI_SIZE - see the module docstring.
STRIDE = (SIZE + 3) // 4      # bytes per row of packed 2bpp alpha = 4.
RENDER = SIZE * 8             # 104px - see "Rendering size" above.
BOX = RENDER // SIZE          # 8 - the box-filter factor, exact by construction.
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EMOJI_FONT = "Apple Color Emoji"

# name, emoji character (each forced to emoji presentation with VS16, U+FE0F -
# harmless on glyphs that already default to emoji presentation, and required on
# ones that default to a plain text glyph, e.g. the desktop computer and gear).
ICONS = [
    ("rocket",  "\U0001F680️"),
    ("moon",    "\U0001F319️"),
    ("star",    "⭐️"),
    ("bolt",    "⚡️"),
    ("fire",    "\U0001F525️"),
    ("leaf",    "\U0001F343️"),
    ("wave",    "\U0001F30A️"),
    ("anchor",  "⚓️"),
    ("crab",    "\U0001F980️"),
    ("laptop",  "\U0001F4BB️"),
    ("desktop", "\U0001F5A5️"),
    ("cloud",   "☁️"),
    ("sun",     "☀️"),
    ("cat",     "\U0001F431️"),
    ("apple",   "\U0001F34E️"),
    ("gear",    "⚙️"),
]
assert [n for n, _ in ICONS] == "rocket moon star bolt fire leaf wave anchor crab laptop desktop cloud sun cat apple gear".split()
assert len(ICONS) == 16


def render_char(ch, out_png, tmp):
    """Rasterise one emoji character at RENDERxRENDER on a transparent background."""
    html = tmp / "e.html"
    html.write_text(
        "<!doctype html><html><head><style>"
        f"html,body{{margin:0;padding:0;background:transparent;"
        f"width:{RENDER}px;height:{RENDER}px;overflow:hidden}}"
        f"#e{{width:{RENDER}px;height:{RENDER}px;display:flex;"
        f"align-items:center;justify-content:center;"
        f'font-family:"{EMOJI_FONT}";font-size:{int(RENDER * 0.86)}px;line-height:1}}'
        "</style></head><body><div id=\"e\">" + ch + "</div></body></html>",
        encoding="utf-8",
    )
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", "--default-background-color=00000000",
         f"--screenshot={out_png}", f"--window-size={RENDER},{RENDER}",
         f"file://{html}"],
        check=True, capture_output=True,
    )


def read_png_rgba(path):
    """Minimal 8-bit RGBA non-interlaced PNG reader -> rows of (r,g,b,a) tuples.

    Extends codex2c.py's read_png_gray: that reader keeps only luminance because
    it only ever needed an alpha mask. This one keeps all four channels, because
    an emoji is colourful and its transparency is the whole point of the plane
    split in MacEmoji.h. Requires an alpha channel (colour type 6) - if Chrome's
    transparent-background flag ever stops working, colour type 2 (no alpha) is
    exactly what would come out, and failing loudly here beats silently treating
    every pixel as opaque.
    """
    d = pathlib.Path(path).read_bytes()
    assert d[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat = 8, b""
    w = h = None
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ, body = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, bitd, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            assert bitd == 8 and inter == 0, "unexpected PNG bit depth/interlacing"
            if ctype != 6:
                sys.exit(f"PNG has no alpha channel (colour type {ctype}) - "
                          "transparent background did not render")
            nch = 4
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
        rows.append([tuple(line[x * nch:x * nch + 4]) for x in range(w)])
    return w, h, rows


def downsample(rows, w, h):
    """Box-filter an exact BOXxBOX average down to SIZExSIZE.

    Colour is alpha-weighted (premultiplied then unpremultiplied) so a
    partially-transparent edge pixel doesn't pick up colour bleeding from the
    fully-transparent background pixels beside it. Returns a flat list of
    (rgb565_or_0, alpha_0_to_3) tuples, row-major, length SIZE*SIZE.
    """
    assert w == RENDER and h == RENDER
    out = []
    for oy in range(SIZE):
        for ox in range(SIZE):
            rs = gs = bs = asum = 0
            for dy in range(BOX):
                row = rows[oy * BOX + dy]
                for dx in range(BOX):
                    r, g, b, a = row[ox * BOX + dx]
                    rs += r * a; gs += g * a; bs += b * a; asum += a
            avg_a = asum // (BOX * BOX)
            qa = min(3, avg_a * 4 // 256)
            if qa == 0:
                out.append((0, 0))
                continue
            r = rs // asum; g = gs // asum; b = bs // asum
            rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            out.append((rgb565, qa))
    return out


def pack_alpha(pixels):
    """2 bits/pixel, 4 px/byte, high bits first - the packing blit2bpp unpacks."""
    out = bytearray(SIZE * STRIDE)
    for i, (_, qa) in enumerate(pixels):
        y, x = divmod(i, SIZE)
        out[y * STRIDE + (x >> 2)] |= qa << (6 - 2 * (x & 3))
    return out


def render_icon(ch, tmp):
    png = tmp / "icon.png"
    render_char(ch, png, tmp)
    w, h, rows = read_png_rgba(png)
    pixels = downsample(rows, w, h)
    rgb = [p[0] for p in pixels]
    alpha = pack_alpha(pixels)
    return rgb, alpha


def render_all():
    """-> (names, [rgb565 per pixel]*COUNT concatenated, [alpha bytes]*COUNT concatenated)."""
    names, rgb_all, alpha_all = [], [], []
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        for name, ch in ICONS:
            rgb, alpha = render_icon(ch, tmp)
            names.append(name)
            rgb_all.extend(rgb)
            alpha_all.extend(alpha)
    return names, rgb_all, alpha_all


def emit_header(names, rgb_all, alpha_all):
    count = len(names)
    assert len(rgb_all) == count * SIZE * SIZE
    assert len(alpha_all) == count * SIZE * STRIDE
    out = []
    out.append("// Generated by emoji2c.py - do not edit by hand.")
    out.append("// 13x13 per-Mac icon sprites, rasterised from the system emoji font")
    out.append("// (Apple Color Emoji) via headless Chrome - see emoji2c.py's docstring")
    out.append("// for why: the device's UI font is ASCII-only, so an icon here is")
    out.append("// artwork, not a character. Colour (RGB565) and alpha (2bpp, packed")
    out.append("// exactly like blit2bpp's other art) are separate planes so one icon")
    out.append("// can sit on a card, a row, and either theme's page background.")
    out.append("#pragma once")
    out.append("#include <Arduino.h>")
    out.append("#include <pgmspace.h>")
    out.append(f"#define MAC_EMOJI_SIZE   {SIZE}")
    out.append(f"#define MAC_EMOJI_COUNT  {count}")
    out.append(f"#define MAC_EMOJI_STRIDE {STRIDE}  // (MAC_EMOJI_SIZE+3)/4, matches blit2bpp")
    out.append("")
    out.append(f"const char* const MAC_EMOJI_NAMES[MAC_EMOJI_COUNT] = {{")
    out.append("  " + ", ".join(f'"{n}"' for n in names))
    out.append("};")
    out.append("")
    out.append(f"const uint16_t MAC_EMOJI_RGB[MAC_EMOJI_COUNT * {SIZE * SIZE}] PROGMEM = {{")
    for i in range(0, len(rgb_all), 13):
        out.append("  " + ",".join(str(v) for v in rgb_all[i:i + 13]) + ",")
    out.append("};")
    out.append("")
    out.append(f"const uint8_t MAC_EMOJI_ALPHA[MAC_EMOJI_COUNT * {SIZE * STRIDE}] PROGMEM = {{")
    for i in range(0, len(alpha_all), STRIDE):
        out.append("  " + ",".join(str(b) for b in alpha_all[i:i + STRIDE]) + ",")
    out.append("};")
    out.append("")
    out.append("// Linear scan, not a table: called once per payload (16 entries).")
    out.append("int macEmojiIndex(const char* name) {")
    out.append("  for (int i = 0; i < MAC_EMOJI_COUNT; i++) {")
    out.append("    if (strcmp(name, MAC_EMOJI_NAMES[i]) == 0) return i;")
    out.append("  }")
    out.append("  return -1;")
    out.append("}")
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# --verify / --selftest
# ---------------------------------------------------------------------------

def _parse_ints(src, array_name):
    m = re.search(re.escape(array_name) + r'\[[^\]]*\][^=]*=\s*\{(.*?)\n\};', src, re.S)
    if not m:
        sys.exit(f"could not find {array_name} in header")
    return [int(tok) for tok in re.findall(r'-?\d+', m.group(1))]


def _parse_names(src):
    m = re.search(r'MAC_EMOJI_NAMES\[[^\]]*\]\s*=\s*\{(.*?)\};', src, re.S)
    if not m:
        sys.exit("could not find MAC_EMOJI_NAMES in header")
    return re.findall(r'"([^"]*)"', m.group(1))


def decode_header(header_path):
    src = pathlib.Path(header_path).read_text()
    names = _parse_names(src)
    rgb = _parse_ints(src, "MAC_EMOJI_RGB")
    alpha = _parse_ints(src, "MAC_EMOJI_ALPHA")
    return names, rgb, alpha


def verify(header_path):
    """Re-render every icon from scratch and diff against the header, byte for byte."""
    problems = []
    names, rgb, alpha = decode_header(header_path)
    want_names, want_rgb, want_alpha = render_all()
    if names != want_names:
        problems.append(f"MAC_EMOJI_NAMES differs: {names!r} != {want_names!r}")
    if len(rgb) != len(want_rgb):
        problems.append(f"MAC_EMOJI_RGB length {len(rgb)} != {len(want_rgb)}")
    if len(alpha) != len(want_alpha):
        problems.append(f"MAC_EMOJI_ALPHA length {len(alpha)} != {len(want_alpha)}")
    n = min(len(rgb), len(want_rgb))
    for i in range(n):
        if rgb[i] != want_rgb[i]:
            icon = i // (SIZE * SIZE)
            problems.append(
                f"MAC_EMOJI_RGB[{i}] (icon {icon}, {want_names[icon] if icon < len(want_names) else '?'}) "
                f"= {rgb[i]} != {want_rgb[i]}")
    n = min(len(alpha), len(want_alpha))
    for i in range(n):
        if alpha[i] != want_alpha[i]:
            icon = i // (SIZE * STRIDE)
            problems.append(
                f"MAC_EMOJI_ALPHA[{i}] (icon {icon}, {want_names[icon] if icon < len(want_names) else '?'}) "
                f"= {alpha[i]} != {want_alpha[i]}")
    return problems


def selftest():
    """Prove --verify has teeth: a one-byte corruption in icon 0's alpha MUST be caught.

    Mirrors bdf2gfx.py --selftest and palette-check.mjs --selftest: a checker that
    cannot fail is not a check.
    """
    header_path = pathlib.Path(__file__).with_name("MacEmoji.h")
    if not header_path.exists():
        return ["MacEmoji.h does not exist yet - generate it first"]
    clean = verify(header_path)
    if clean:
        return ["header does not verify before tampering: " + "; ".join(clean[:3])]

    src = header_path.read_text()
    m = re.search(r'MAC_EMOJI_ALPHA\[[^\]]*\][^=]*=\s*\{\n(.*?)\n\};', src, re.S)
    if not m:
        return ["could not find MAC_EMOJI_ALPHA to corrupt"]
    body = m.group(1)
    lines = body.split("\n")
    first_vals = [int(t) for t in re.findall(r'-?\d+', lines[0])]
    first_vals[0] = (first_vals[0] ^ 0xFF) & 0xFF  # corrupt icon 0's first alpha byte
    lines[0] = "  " + ",".join(str(v) for v in first_vals) + ","
    tampered = src[:m.start(1)] + "\n".join(lines) + src[m.end(1):]

    tmp = str(header_path) + ".selftest"
    pathlib.Path(tmp).write_text(tampered)
    try:
        caught = verify(tmp)
    finally:
        pathlib.Path(tmp).unlink()

    if not caught:
        return ["a corrupted alpha byte was NOT caught - the checker has no teeth"]
    return []


def _run_check(kind, header_path=None):
    problems = verify(header_path) if kind == "--verify" else selftest()
    label = "MacEmoji.h" if header_path is None else pathlib.Path(header_path).name
    if problems:
        print(f"FAIL {label}: {len(problems)} problem(s)")
        for p in problems[:20]:
            print("  " + p)
        if len(problems) > 20:
            print(f"  ... and {len(problems) - 20} more")
        return 1
    word = "matches a fresh render" if kind == "--verify" else "selftest passed (corruption caught)"
    print(f"PASS {label}: {word}")
    return 0


# ---------------------------------------------------------------------------
# --preview
# ---------------------------------------------------------------------------

def _rgb565_to_rgb8(v):
    r5, g6, b5 = (v >> 11) & 0x1F, (v >> 5) & 0x3F, v & 0x1F
    return r5 * 255 // 31, g6 * 255 // 63, b5 * 255 // 31


def _blend(bg, fg, t):
    """Straight-line RGB8 blend towards fg by t/255 - mirrors the firmware's blend565."""
    return tuple(bg[i] + (fg[i] - bg[i]) * t // 255 for i in range(3))


_ALPHA_FRAC = (0, 85, 170, 255)


def _write_png_rgb(path, w, h, rows):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # colour type 2 = RGB
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for (r, g, b) in row:
            raw += bytes((r, g, b))
    idat = zlib.compress(bytes(raw), 9)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", idat) + chunk(b"IEND", b""))
    pathlib.Path(path).write_bytes(data)


def preview(out_path, header_path):
    """4x4 grid, reading in MAC_EMOJI_NAMES order left-to-right/top-to-bottom, each
    cell showing dark-background | light-background swatches side by side. A grid
    keeps the overall image small enough that a viewer won't downscale it and blur
    the nearest-neighbour pixels back into mush - the one thing this preview exists
    to avoid.
    """
    names, rgb, alpha = decode_header(header_path)
    count = len(names)
    cols = 4
    rows = (count + cols - 1) // cols
    scale = 8
    tile = SIZE * scale
    gap = 8
    cell_w = tile * 2 + gap
    cell_h = tile
    w = cell_w * cols + gap * (cols - 1)
    h = cell_h * rows + gap * (rows - 1)
    dark_bg = _rgb565_to_rgb8(0x18C4)   # COLOR_CARD, DARK theme - the usage-card fill.
    light_bg = (255, 255, 255)          # COLOR_CARD, LIGHT theme.

    canvas = [[(40, 40, 40) for _ in range(w)] for _ in range(h)]
    for icon in range(count):
        base_rgb = rgb[icon * SIZE * SIZE:(icon + 1) * SIZE * SIZE]
        base_alpha = alpha[icon * SIZE * STRIDE:(icon + 1) * SIZE * STRIDE]
        gx, gy = icon % cols, icon // cols
        cell_x0 = gx * (cell_w + gap)
        cell_y0 = gy * (cell_h + gap)
        for by, bg in ((0, dark_bg), (1, light_bg)):
            for py in range(SIZE):
                for px in range(SIZE):
                    idx = py * SIZE + px
                    byte = base_alpha[py * STRIDE + (px >> 2)]
                    qa = (byte >> (6 - 2 * (px & 3))) & 3
                    fg = _rgb565_to_rgb8(base_rgb[idx]) if qa else bg
                    col = _blend(bg, fg, _ALPHA_FRAC[qa])
                    ox0 = cell_x0 + by * (tile + gap) + px * scale
                    oy0 = cell_y0 + py * scale
                    for dy in range(scale):
                        row = canvas[oy0 + dy]
                        for dx in range(scale):
                            row[ox0 + dx] = col
    _write_png_rgb(out_path, w, h, canvas)
    print(f"wrote {out_path} ({w}x{h}) - {count} icons in a {cols}x{rows} grid, "
          f"reading order: {', '.join(names)}")


def main():
    args = sys.argv[1:]
    if args[:1] == ["--verify"]:
        header = args[1] if len(args) > 1 else str(pathlib.Path(__file__).with_name("MacEmoji.h"))
        sys.exit(_run_check("--verify", header))
    if args[:1] == ["--selftest"]:
        sys.exit(_run_check("--selftest"))
    if args[:1] == ["--preview"]:
        if len(args) < 2:
            sys.exit(__doc__)
        header = args[2] if len(args) > 2 else str(pathlib.Path(__file__).with_name("MacEmoji.h"))
        preview(args[1], header)
        return
    if args:
        sys.exit(__doc__)
    names, rgb_all, alpha_all = render_all()
    sys.stdout.write(emit_header(names, rgb_all, alpha_all))
    sys.stderr.write(f"icons={len(names)} rgb_bytes={len(rgb_all) * 2} alpha_bytes={len(alpha_all)}\n")


if __name__ == "__main__":
    main()
