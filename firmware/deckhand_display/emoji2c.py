#!/usr/bin/env python3
"""Generate the per-Mac icon sprites - one header per board - from the system emoji font.

    python3 emoji2c.py            > MacEmoji.h     # board 1, 13x13 (the default)
    python3 emoji2c.py --size 16  > MacEmoji16.h   # board 2, 16x16
    python3 emoji2c.py --verify MacEmoji.h
    python3 emoji2c.py --verify MacEmoji16.h
    python3 emoji2c.py --selftest [MacEmoji.h]
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
    included exactly once (from deckhand_display.ino), so a definition here
    saves a second file only this sketch would ever include. Emitted `static`
    so a second #include (this sketch or a future one) can never collide with
    it at link time - removing the hazard rather than merely documenting that
    it hasn't happened yet.

THE SIZE IS THE UI BODY FONT'S CELL HEIGHT, and that identity - not an aesthetic
judgement - is what the whole design rests on: an icon's y IS its neighbouring
text's TL_DATUM y, at every draw site, with no centring arithmetic anywhere. So it
is PER-BOARD, because the two boards do not share a font: board 1 draws Cozette
6x13 and gets 13, board 2 draws Spleen 8x16 and gets 16. A single 13 shipped on
board 2 leaves 3px of slack inside every 16px line and sits visibly high.
The tightest site is unchanged in kind by the split - a usage card's label row
starts at y0+CARD_LABEL_Y (6) and must clear the hero number's own box at
y0+CARD_HERO_Y (20 on board 1, 24 on board 2) - so 13 clears board 1's by one row
and 16 clears board 2's by two.

Which header a build gets is decided by the COMPILE TARGET, exactly as board.h
does it: deckhand_display.ino includes MacEmoji.h or MacEmoji16.h behind
BOARD_USES_TFT_ESPI. The two CANNOT both be included - they define the same
MAC_EMOJI_SIZE/STRIDE/COUNT/NAMES - and that is deliberate rather than an
oversight to work around: exactly one size is correct for a given panel.

THE SIXTEEN NAMES ARE THE WIRE FORMAT AND MUST NOT CHANGE. The payload carries a
name, never an index, and host/mac-emoji-check.mjs compares three hand-maintained
copies of the list (the generated header, host/mac-emoji.mjs, and MAC_ICON_NAMES in
mac-app/DeckhandMenuBar.swift). A renamed icon breaks an already-configured Mac
silently on both sides - so a broken icon is fixed by choosing a different
CHARACTER for the same name, which is what SIZE_OVERRIDES below does.

Rendering size: emoji are rasterised at SIZE*8 (104px at 13, 128px at 16)
specifically so the box filter down is an exact, unweighted 8x8 average at any
size - a fixed 104 or 128 would only have that property for one of them, and a
fractional box would make the "re-render and compare" verifier fragile to rounding
rather than a real correctness check.
"""
import pathlib
import re
import struct
import subprocess
import sys
import tempfile
import zlib

# The icon's edge in pixels. PER-BOARD, not a constant, and set by --size:
# MAC_EMOJI_SIZE has to equal the UI body font's CELL HEIGHT, because that identity
# is what lets every draw site place an icon at its neighbouring text's own
# TL_DATUM y with no centring arithmetic. Board 1 draws Cozette 6x13 (13), board 2
# draws Spleen 8x16 (16), so one number cannot serve both - at 13 on board 2 the
# icon leaves 3px of slack in a 16px line and sits optically high at every site.
#
# The default is 13 so an argument-less invocation still emits board 1's header
# byte for byte, which is what keeps that board's binary unchanged by this split.
#
# STRIDE/RENDER/BOX are derived, and set_size() is the ONLY thing that may write
# them: --verify reads MAC_EMOJI_SIZE back out of the header it was handed and
# re-renders at THAT size, so a header can never be checked against the wrong
# geometry (which would fail as thousands of pixel diffs and read like broken art).
SIZE = 13
STRIDE = 4
RENDER = 104
BOX = 8


def set_size(n):
    """Set SIZE and re-derive STRIDE/RENDER/BOX from it.

    RENDER = SIZE * 8 keeps the box filter an exact, unweighted 8x8 average for ANY
    size - the property a fixed 104 or 128 would only have for one - so the
    "re-render and compare" verifier stays a real correctness check rather than a
    test of rounding. Both shipping sizes (13, 16) are exact by construction here.
    """
    global SIZE, STRIDE, RENDER, BOX
    if n < 4 or n > 64:
        sys.exit(f"--size {n} is out of range (4..64)")
    SIZE = n
    STRIDE = (SIZE + 3) // 4   # bytes per row of packed 2bpp alpha
    RENDER = SIZE * 8          # see the docstring above
    BOX = RENDER // SIZE       # 8, the box-filter factor, exact by construction
    assert RENDER == BOX * SIZE, "box filter must be exact"
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

# A DIFFERENT CHARACTER FOR THE SAME NAME, per size. The names above are the wire
# format and cannot change (see the docstring), so this is the only lever there is
# for an icon that does not read on the panel - and it is per-size because board 1's
# 13px header is FROZEN: its binary is unchanged by the per-board split, and
# respinning its art would spend that for a judgement that can only be made on a
# board 2 screen. Applied by render_all(); --verify picks the same set up, because it
# re-derives SIZE from the header it was handed before rendering anything.
#
# WHY EACH ONE MOVED. Measured on all four real backdrops (DARK/LIGHT x BG/CARD),
# as CIE Lab dE of the composited ink against the backdrop - not WCAG contrast, which
# is a luminance ratio and therefore calls a perfectly legible yellow star on white a
# failure at 1.9:1. Then looked at on the glass, which is the authority: a keyboard
# glyph beat both of these on every number and was rejected because at 16px it draws
# as a featureless grey bar with no keys - the same way an earlier `robot` read as a
# cupcake in art that had passed its own preview.
#
#   cloud    U+2601 -> U+1F326 (sun behind rain cloud). A white cloud on LIGHT is the
#            one genuine INVISIBILITY in the set: dE90 15.6 with 5% of its ink
#            clearing dE 20 on a LIGHT card, and LIGHT's COLOR_CARD is pure white, so
#            this is every shipping surface rather than only the EMOJITEST screen the
#            old note blamed. Apple's whole cloud family is white, so no cloud glyph
#            fixes it by being darker; 1F326 fixes it by carrying a yellow sun and
#            blue rain, which is HUE the white body does not have. dE90 goes 15.6 ->
#            53.8 on a LIGHT card and 12.2 -> 51.0 on the LIGHT page, and the cloud is
#            still the dominant mass, so the name still describes the picture.
#
#   desktop  U+1F5A5 -> U+1F4FA (television). laptop and desktop are BOTH a black
#            screen over a light base, and they are exactly the two a MacBook and a
#            Mac Studio reach for - so the one case the icons exist for (two Macs side
#            by side) was the one they could not serve. Measured as mean per-pixel dE
#            BETWEEN the two icons on the same backdrop, U+1F5A5 was the least
#            distinct candidate tried, on every backdrop (20.3-22.0). A television
#            was tried in its place and REVERTED: it measured far better (86-96% of
#            ink clearing dE 20 on all four backdrops, against 53% for the monitor
#            on a DARK card) and still left laptop and desktop reading as two dark
#            rectangles, so the number improved and the distinguishability did not.
#            Kept as a record because the measurement is real and the next person
#            will find the same candidate; what it shows is that this particular
#            problem is not a contrast problem.
#
# NOT CHANGED, and this contradicts the older note that grouped it with the two above:
# `anchor` is not a contrast failure at 16px. It measures dE90 65.0 with 93% of its ink
# clearing dE 20 on the DARK page and 90% on a LIGHT card - its problem at 13px was
# STROKE WIDTH in thin line art, which 51% more pixels resolved rather than a colour
# that needed replacing. `laptop` keeps U+1F4BB: it is the unambiguous picture for its
# own name, and the collision is fixed by moving the icon that had an alternative.
# `desktop` REVERTED to U+1F5A5 after looking at the 16px grid on the panel. The
# television measured better and did not solve the actual problem: laptop and
# desktop still both read as dark rectangles, so two Macs side by side are no
# easier to tell apart, and "television" for a desktop Mac is its own small
# confusion. The contrast number improved while the thing it was bought for did
# not - which is the same shape as the keyboard glyph that beat every candidate on
# measurement and drew as a featureless grey bar.
# The honest position is the one the docs already take: the emoji vocabulary has
# no second computer-shaped glyph that reads distinctly at this size, so if two
# Macs sit side by side, pick two of the other fourteen that differ in SHAPE.
SIZE_OVERRIDES = {
    16: {
        "cloud":   "\U0001F326️",
    },
}


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
    over = SIZE_OVERRIDES.get(SIZE, {})
    unknown = set(over) - {n for n, _ in ICONS}
    if unknown:
        sys.exit(f"SIZE_OVERRIDES[{SIZE}] names an icon that does not exist: {sorted(unknown)}")
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        for name, ch in ICONS:
            ch = over.get(name, ch)
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
    out.append(f"// {SIZE}x{SIZE} per-Mac icon sprites, rasterised from the system emoji font")
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
    for i in range(0, len(rgb_all), SIZE):
        out.append("  " + ",".join(str(v) for v in rgb_all[i:i + SIZE]) + ",")
    out.append("};")
    out.append("")
    out.append(f"const uint8_t MAC_EMOJI_ALPHA[MAC_EMOJI_COUNT * {SIZE * STRIDE}] PROGMEM = {{")
    for i in range(0, len(alpha_all), STRIDE):
        out.append("  " + ",".join(str(b) for b in alpha_all[i:i + STRIDE]) + ",")
    out.append("};")
    out.append("")
    out.append("// Linear scan, not a table: called once per payload (16 entries).")
    out.append("// static: this header is included exactly once today (from")
    out.append("// deckhand_display.ino), but a definition with external linkage sitting")
    out.append("// in a header is a multi-TU hazard waiting for a second #include - static")
    out.append("// removes that possibility outright rather than merely documenting it.")
    out.append("static int macEmojiIndex(const char* name) {")
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


def _parse_size(src):
    """The size the header was generated at, read from its own MAC_EMOJI_SIZE.

    --verify must re-render at the size the header actually uses, not at whatever
    the default happens to be: checking a 16px header against a 13px render fails
    as thousands of pixel diffs, which reads like broken art rather than like the
    two numbers disagreeing. Reading it out of the file means the caller cannot get
    it wrong, and it also catches a header whose SIZE and array LENGTHS disagree -
    the length checks below are done against the re-render.
    """
    m = re.search(r'#define\s+MAC_EMOJI_SIZE\s+(\d+)', src)
    if not m:
        sys.exit("could not find #define MAC_EMOJI_SIZE in header")
    return int(m.group(1))


def decode_header(header_path):
    src = pathlib.Path(header_path).read_text()
    set_size(_parse_size(src))
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


def selftest(header_path=None):
    """Prove --verify has teeth: a one-byte corruption in icon 0's alpha MUST be caught.

    Mirrors bdf2gfx.py --selftest and palette-check.mjs --selftest: a checker that
    cannot fail is not a check. Takes a header so either board's can be used as the
    subject - the tampering is size-agnostic (it flips the first alpha byte, which
    exists at every size) and verify() re-derives the geometry from the file.
    """
    header_path = pathlib.Path(header_path or pathlib.Path(__file__).with_name("MacEmoji.h"))
    if not header_path.exists():
        return [f"{header_path.name} does not exist yet - generate it first"]
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
    problems = verify(header_path) if kind == "--verify" else selftest(header_path)
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
        sys.exit(_run_check("--selftest", args[1] if len(args) > 1 else None))
    if args[:1] == ["--preview"]:
        if len(args) < 2:
            sys.exit(__doc__)
        header = args[2] if len(args) > 2 else str(pathlib.Path(__file__).with_name("MacEmoji.h"))
        preview(args[1], header)
        return
    if args[:1] == ["--size"]:
        if len(args) < 2 or not args[1].isdigit():
            sys.exit(__doc__)
        set_size(int(args[1]))
        args = args[2:]
    if args:
        sys.exit(__doc__)
    names, rgb_all, alpha_all = render_all()
    sys.stdout.write(emit_header(names, rgb_all, alpha_all))
    sys.stderr.write(f"size={SIZE} icons={len(names)} "
                     f"rgb_bytes={len(rgb_all) * 2} alpha_bytes={len(alpha_all)}\n")


if __name__ == "__main__":
    main()
