#!/usr/bin/env python3
"""App icon: a battery gauge (green arc, 75% full) around a charge bolt, on near-black.

One set of shapes, written out twice: static/icons/icon.svg (favicon / manifest) and the
PNGs (drawn with Pillow at 4x, then downscaled). Run from the repo root:
    python3 dev/make-icons.py              # writes static/icons/* and the root touch icons
    python3 dev/make-icons.py --preview    # also /tmp/icon-preview.png (sizes on light + dark)
Bump ICON_VERSION when the artwork changes, then update index.html, manifest.webmanifest
and sw.js to the new file names so installed phones pick it up.
"""
import math
import pathlib
import sys
from PIL import Image, ImageDraw, ImageFilter

ICON_VERSION = "v4"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "icons"

# Geometry on a 1024 canvas. The gauge opens at the bottom (270° sweep), so its centre sits
# a little low to centre the whole shape; everything stays inside the maskable safe circle.
N = 1024
CX, CY, R, W = 512, 556, 300, 76          # gauge centre, radius, stroke width
START, SWEEP, FILL = 135, 270, 0.75       # degrees clockwise from 3 o'clock (SVG and Pillow agree)
BOLT = [(13, 2.5), (4.5, 13.5), (11, 13.5), (10, 21.5), (18.5, 10.5), (12, 10.5)]  # the app's 24px bolt
BOLT_SCALE, BOLT_CX, BOLT_CY, BOLT_ROUND = 17, 512, 546, 16

BG_TOP, BG_BOT = (44, 44, 46), (12, 12, 14)  # iOS dark greys, never pure black (keeps an edge on dark wallpapers)
TRACK = (58, 58, 60)
GREEN = (48, 209, 88)                     # the app's dark-mode accent
WHITE = (255, 255, 255)


def bolt_points():
    return [(BOLT_CX + (x - 11.5) * BOLT_SCALE, BOLT_CY + (y - 12) * BOLT_SCALE) for x, y in BOLT]


def arc_point(deg):
    a = math.radians(deg)
    return CX + R * math.cos(a), CY + R * math.sin(a)


def hexc(c):
    return "#%02x%02x%02x" % c


def svg():
    (sx, sy), (tx, ty), (gx, gy) = arc_point(START), arc_point(START + SWEEP), arc_point(START + SWEEP * FILL)
    big = lambda deg: 1 if deg > 180 else 0
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in bolt_points())
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{hexc(BG_TOP)}"/><stop offset="1" stop-color="{hexc(BG_BOT)}"/>
    </linearGradient>
    <radialGradient id="glow" cx="{CX / N}" cy="{CY / N}" r="0.42">
      <stop offset="0" stop-color="{hexc(GREEN)}" stop-opacity="0.16"/><stop offset="1" stop-color="{hexc(GREEN)}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="{N}" height="{N}" fill="url(#bg)"/>
  <rect width="{N}" height="{N}" fill="url(#glow)"/>
  <g fill="none" stroke-width="{W}" stroke-linecap="round">
    <path d="M{sx:.1f} {sy:.1f}A{R} {R} 0 {big(SWEEP)} 1 {tx:.1f} {ty:.1f}" stroke="{hexc(TRACK)}"/>
    <path d="M{sx:.1f} {sy:.1f}A{R} {R} 0 {big(SWEEP * FILL)} 1 {gx:.1f} {gy:.1f}" stroke="{hexc(GREEN)}"/>
  </g>
  <polygon points="{pts}" fill="{hexc(WHITE)}" stroke="{hexc(WHITE)}" stroke-width="{BOLT_ROUND}" stroke-linejoin="round"/>
</svg>
"""


def draw(size=N, k=4):
    """The icon as an RGB image of `size` px (drawn at k× for smooth edges)."""
    S = size * k
    f = S / N
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)))
    glow = Image.new("L", (S, S), 0)
    gr = 0.30 * S
    ImageDraw.Draw(glow).ellipse([CX * f - gr, CY * f - gr, CX * f + gr, CY * f + gr], fill=round(255 * 0.16))
    img.paste(Image.new("RGB", (S, S), GREEN), (0, 0), glow.filter(ImageFilter.GaussianBlur(S * 0.09)))

    o = R + W / 2                                          # Pillow strokes inward from the box edge
    box = [(CX - o) * f, (CY - o) * f, (CX + o) * f, (CY + o) * f]
    for color, end in ((TRACK, START + SWEEP), (GREEN, START + SWEEP * FILL)):
        d.arc(box, START, end, fill=color, width=round(W * f))
        for deg in (START, end):                           # round caps
            x, y = arc_point(deg)
            r = W * f / 2
            d.ellipse([x * f - r, y * f - r, x * f + r, y * f + r], fill=color)
    pts = [(x * f, y * f) for x, y in bolt_points()]
    d.polygon(pts, fill=WHITE)
    d.line(pts + pts[:2], fill=WHITE, width=round(BOLT_ROUND * f), joint="curve")
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg())
    big = draw(1024)
    for px in (120, 152, 167, 180, 192, 512):
        big.resize((px, px), Image.LANCZOS).save(OUT / f"icon-{px}-{ICON_VERSION}.png", optimize=True)
    # Same artwork works as maskable: the shapes sit inside the 80% safe circle.
    big.resize((512, 512), Image.LANCZOS).save(OUT / f"icon-maskable-512-{ICON_VERSION}.png", optimize=True)
    for name in ("apple-touch-icon.png", "apple-touch-icon-precomposed.png"):
        big.resize((180, 180), Image.LANCZOS).save(ROOT / "static" / name, optimize=True)
    big.save(ROOT / "static" / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote", OUT)
    if "--preview" in sys.argv:
        sheet = Image.new("RGB", (1180, 420), (242, 242, 247))
        ImageDraw.Draw(sheet).rectangle([0, 210, 1180, 420], fill=(0, 0, 0))
        x = 20
        for px in (180, 120, 60, 40, 29, 16):
            icon = big.resize((px, px), Image.LANCZOS)
            mask = Image.new("L", (px, px), 0)                 # iOS-style rounded corners for the preview
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=px * 0.2237, fill=255)
            for y in (15, 225):
                sheet.paste(icon, (x, y), mask)
            x += px + 30
        sheet.save("/tmp/icon-preview.png")
        print("preview: /tmp/icon-preview.png")


if __name__ == "__main__":
    main()
