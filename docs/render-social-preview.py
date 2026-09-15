#!/usr/bin/env python3
"""Render the 1280x640 GitHub social preview card.

    python3 docs/render-social-preview.py            # -> docs/social-preview.png

Upload the result under Settings -> General -> Social preview. GitHub wants
exactly 1280x640; X/Slack/Discord crop that same 2:1 frame, so everything that
must survive a crop sits inside a 72px margin.

THE CARD COMPOSES ASSETS THAT ALREADY EXIST - it draws no device and fakes no
screen. The right-hand side is docs/device-hero.png, which case/render-hero.py
produced from board 2's OpenSCAD model with a real panel capture composited
into it, so the screen on this card is the screen the firmware drew. The only
work done here is lifting that render off its flat #F8F8F8 backdrop (flood fill
from the four corners, then a 1px erode so no light fringe survives onto the
navy). Re-run this after any re-render of the hero: the device is placed by the
cut-out's own bounding box, so a case of different proportions lands correctly
but the file here has to be rebuilt to pick it up.

THE PALETTE IS THE PRODUCT'S, NOT A NEW ONE: the blues are docs/logo.svg's tile
gradient darkened until white type clears 7:1 on it, and ACCENT is the
firmware's own COLOR_ACCENT for the DARK theme (0xFD20 in RGB565 -> #FFA500) -
the same orange the hero's own SESSIONS underline is drawn in, because that
capture is a dark-theme screen too.

Needs Pillow (`python3 -m pip install --user pillow`). That is unlike
case/render-hero.py, which carries its own PNG codec because the OpenSCAD
toolchain had no Pillow - this one needs a text rasterizer, which stdlib
has no answer for at all.
"""
import pathlib
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.exit("needs Pillow: python3 -m pip install --user pillow")

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "social-preview.png"

W, H = 1280, 640
SS = 2  # supersample; everything below is in final pixels and scaled by this

# --- palette ---------------------------------------------------------------
# logo.svg's tile runs #4C9BE0 -> #12508F. White on #12508F is only 5.9:1, so
# the card's field is that gradient walked further down toward black.
BG_TOP = (14, 43, 74)
BG_BOT = (5, 17, 32)
GLOW = (46, 111, 168)      # behind the device, so a dark bezel has something to sit on
CREAM = (251, 244, 233)    # logo.svg's wheel
ACCENT = (255, 165, 0)     # firmware COLOR_ACCENT 0xFD20
BODY = (170, 197, 222)
MUTED = (113, 148, 181)

HN = "/System/Library/Fonts/HelveticaNeue.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"
HN_BOLD, HN_MED, HN_REG = 1, 10, 0
MENLO_REG, MENLO_BOLD = 0, 1


def font(path, index, size):
    return ImageFont.truetype(path, size * SS, index=index)


def rounded_mask(size, radius):
    """Antialiased rounded-rect mask, drawn 4x and downsampled."""
    w, h = size
    m = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=radius * 4, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def cut_out(path):
    """Lift the hero render off its flat backdrop -> RGBA with a clean alpha.

    Flood fill from the corners rather than keying the colour everywhere: the
    panel's own paper is a near-white cream and would key out with it.
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size
    probe = im.copy()
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(probe, xy, (255, 0, 255), thresh=34)
    px = probe.load()
    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == (255, 0, 255):
                ap[x, y] = 0
    # Erode 1px: the fill stops just short of the antialiased rim, and that rim
    # is backdrop-coloured - left in, it draws a light outline around the case.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    return out.crop(alpha.getbbox())


def logo_tile(path, px):
    """docs/logo.png with its white corners replaced by transparency."""
    im = Image.open(path).convert("RGB")
    bbox = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).getbbox()
    tile = im.crop(bbox).convert("RGBA")
    tile = tile.resize((px, px), Image.LANCZOS)
    tile.putalpha(rounded_mask((px, px), round(px * 118 / 480)))  # logo.svg's rx, to scale
    return tile


def background():
    """Vertical gradient, then a radial glow where the device will stand."""
    bg = Image.new("RGB", (1, H * SS))
    g = bg.load()
    for y in range(H * SS):
        t = y / (H * SS - 1)
        g[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT))
    bg = bg.resize((W * SS, H * SS))

    cx, cy, r = 1005 * SS, 320 * SS, 410 * SS
    small = 160  # the glow is smooth; build it small and let the upscale blur it
    halo = Image.new("L", (small, small), 0)
    hp = halo.load()
    for y in range(small):
        for x in range(small):
            d = (((x - small / 2) ** 2 + (y - small / 2) ** 2) ** 0.5) / (small / 2)
            hp[x, y] = 0 if d >= 1 else round(255 * (1 - d) ** 2.2 * 0.5)
    halo = halo.resize((r * 2, r * 2), Image.BICUBIC)
    bg.paste(Image.new("RGB", halo.size, GLOW), (cx - r, cy - r), halo)
    return bg


def shadow(alpha, blur, spread):
    """A soft dark plate from an alpha mask, sized to take the blur."""
    pad = blur * 3
    m = Image.new("L", (alpha.width + pad * 2, alpha.height + pad * 2), 0)
    m.paste(alpha, (pad, pad))
    if spread:
        m = m.filter(ImageFilter.MaxFilter(spread * 2 + 1))
    return m.filter(ImageFilter.GaussianBlur(blur)), pad


def main():
    card = background()
    d = ImageDraw.Draw(card)

    def text(xy, s, f, fill, anchor="la"):
        d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=fill, anchor=anchor)

    def width(s, f):
        return d.textlength(s, font=f) / SS

    # --- the device ---------------------------------------------------------
    dev = cut_out(HERE / "device-hero.png")
    dev_h = 552 * SS
    dev = dev.resize((round(dev.width * dev_h / dev.height), dev_h), Image.LANCZOS)
    dx, dy = 1005 * SS - dev.width // 2, 44 * SS
    sh, pad = shadow(dev.getchannel("A"), 26 * SS, 2 * SS)
    card.paste(Image.new("RGB", sh.size, (2, 8, 16)), (dx - pad, dy - pad + 14 * SS), sh)
    card.paste(dev, (dx, dy), dev)

    # --- lockup -------------------------------------------------------------
    tile_px, tile_x, tile_y = 88, 84, 112
    tile = logo_tile(HERE / "logo.png", tile_px * SS)
    sh, pad = shadow(tile.getchannel("A"), 14 * SS, 0)
    card.paste(Image.new("RGB", sh.size, (2, 8, 16)),
               (tile_x * SS - pad, tile_y * SS - pad + 8 * SS), sh)
    card.paste(tile, (tile_x * SS, tile_y * SS), tile)

    f_word = font(HN, HN_BOLD, 62)
    text((tile_x + tile_px + 26, tile_y + tile_px // 2), "Deckhand", f_word, CREAM, anchor="lm")

    # --- copy ---------------------------------------------------------------
    text((84, 252), "A desk display and remote for Claude Code",
         font(HN, HN_MED, 30), (233, 241, 249))
    f_body = font(HN, HN_REG, 21)
    for i, line in enumerate([
        "Live plan usage and per-project session status - and the",
        "permission prompts, questions and plan approvals answered",
        "from across the room, by tap or by voice.",
    ]):
        text((84, 306 + i * 30), line, f_body, BODY)

    # --- the tab bar, as the device draws it --------------------------------
    f_tab = font(MENLO, MENLO_BOLD, 19)
    x, tab_y = 84, 432
    for name in ["USAGE", "SESSIONS", "SETTINGS"]:
        live = name == "SESSIONS"  # the tab the hero capture is sitting on
        text((x, tab_y), name, f_tab, CREAM if live else MUTED)
        w = width(name, f_tab)
        if live:
            d.rounded_rectangle([x * SS, (tab_y + 27) * SS, (x + w) * SS, (tab_y + 30) * SS],
                                radius=2 * SS, fill=ACCENT)
        x += w + 34

    # --- footer -------------------------------------------------------------
    f_foot = font(MENLO, MENLO_REG, 16)
    text((84, 512), "ESP32 and ESP32-S3: two boards, one source tree", f_foot, MUTED)
    text((84, 540), "github.com/blueandhack/deckhand", f_foot, (137, 176, 211))
    dot = width("github.com/blueandhack/deckhand", f_foot) + 84 + 16
    text((dot, 540), "-  MIT", f_foot, MUTED)

    card.resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print(f"{OUT.relative_to(HERE.parent)}  {W}x{H}  {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
