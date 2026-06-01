#!/usr/bin/env python3
"""
Generate the HomeDash home-screen / PWA icon set.

The mark is a simple house (home) whose window is a 2x2 dashboard grid with one
warm "highlight" tile, drawn on the app's warm-paper gradient. One source
geometry drives every raster size plus a matching favicon.svg.

Requires: Pillow + numpy  ->  python3 -m pip install Pillow numpy
Run:      python3 scripts/generate-icons.py   (from the repo root or anywhere)
Outputs:  ../icons/*.png, ../icons/favicon.svg, ../favicon.ico
"""

import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ICONS = os.path.join(ROOT, "icons")
os.makedirs(ICONS, exist_ok=True)

# --- Palette (matches the app's warm-paper theme) -------------------------
BG_TL = (249, 244, 236)   # #f9f4ec  cream highlight (top-left)
BG_BR = (231, 217, 197)   # #e7d9c5  warm sand (bottom-right)
HOUSE = (50, 45, 38)      # #322d26  deep espresso
PANE = (247, 241, 233)    # #f7f1e9  lit window / dashboard tile
ACCENT = (200, 127, 78)   # #c87f4e  terracotta highlight tile
SHADOW = (40, 34, 28)     # soft grounding shadow

# --- Geometry, in fractions of the canvas (0..1) --------------------------
ROOF = [(0.500, 0.255), (0.225, 0.477), (0.775, 0.477)]   # apex, base L, base R
BODY = (0.285, 0.450, 0.715, 0.740)                       # x0, y0, x1, y1
BODY_R = 0.045
WIN = (0.345, 0.505, 0.655, 0.685)                        # window-grid block
MULLION = 0.020                                           # gap between tiles
TILE_R = 0.012


def gradient_bg(S):
    """Opaque warm diagonal gradient with a soft top-left glow."""
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    t = (xs + ys) / (2.0 * (S - 1))
    img = (np.array(BG_TL, np.float32) * (1 - t)[..., None]
           + np.array(BG_BR, np.float32) * t[..., None])
    # top-left radial highlight
    r = np.sqrt((xs - 0.22 * S) ** 2 + (ys - 0.10 * S) ** 2) / (0.62 * S)
    glow = np.clip(1 - r, 0, 1) ** 1.6
    img += (255.0 - img) * (glow[..., None] * 0.45)
    # gentle bottom-right vignette for depth
    rv = np.sqrt((xs - 0.92 * S) ** 2 + (ys - 0.95 * S) ** 2) / (0.95 * S)
    img -= img * (np.clip(1 - rv, 0, 1) ** 2)[..., None] * 0.06
    rgb = np.clip(img, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, np.full((S, S), 255, np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def render(size, ss=4):
    """Render the full-bleed icon (house centered within the maskable safe zone)."""
    S = size * ss
    base = gradient_bg(S)

    def pt(p):
        return (p[0] * S, p[1] * S)

    roof = [pt(p) for p in ROOF]
    body = [BODY[0] * S, BODY[1] * S, BODY[2] * S, BODY[3] * S]
    rad = BODY_R * S

    # soft grounding shadow under the house
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.polygon(roof, fill=SHADOW + (255,))
    sd.rounded_rectangle(body, radius=rad, fill=SHADOW + (255,))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.020))
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    layer.alpha_composite(shadow, (0, int(S * 0.013)))
    r, g, b, a = layer.split()
    layer = Image.merge("RGBA", (r, g, b, a.point(lambda v: int(v * 0.22))))
    base.alpha_composite(layer)

    # house body + roof (single solid silhouette)
    d = ImageDraw.Draw(base)
    d.polygon(roof, fill=HOUSE + (255,))
    d.rounded_rectangle(body, radius=rad, fill=HOUSE + (255,))

    # 2x2 dashboard window, one terracotta highlight tile
    pw = ((WIN[2] - WIN[0]) - MULLION) / 2
    ph = ((WIN[3] - WIN[1]) - MULLION) / 2
    tiles = [
        (WIN[0], WIN[1], PANE),
        (WIN[0] + pw + MULLION, WIN[1], ACCENT),
        (WIN[0], WIN[1] + ph + MULLION, PANE),
        (WIN[0] + pw + MULLION, WIN[1] + ph + MULLION, PANE),
    ]
    for tx, ty, col in tiles:
        d.rounded_rectangle(
            [tx * S, ty * S, (tx + pw) * S, (ty + ph) * S],
            radius=TILE_R * S, fill=col + (255,),
        )

    return base.resize((size, size), Image.LANCZOS)


def round_corners(img, frac=0.20):
    """Transparent rounded corners (for browser favicons)."""
    S = img.size[0]
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1],
                                           radius=int(S * frac), fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def save_png(img, name, opaque=False):
    path = os.path.join(ICONS, name)
    (img.convert("RGB") if opaque else img).save(path, "PNG", optimize=True)
    print("wrote", os.path.relpath(path, ROOT), img.size)


# --- PWA / maskable icons (opaque, full-bleed squares) --------------------
save_png(render(512), "icon-512.png", opaque=True)
save_png(render(192), "icon-192.png", opaque=True)
save_png(render(512), "maskable-512.png", opaque=True)
save_png(render(192), "maskable-192.png", opaque=True)

# --- Apple touch icon (opaque square; iOS rounds the corners) -------------
save_png(render(180), "apple-touch-icon.png", opaque=True)

# --- Browser favicons (rounded corners) -----------------------------------
save_png(round_corners(render(32)), "favicon-32.png")
save_png(round_corners(render(16)), "favicon-16.png")

ico = round_corners(render(48))
ico.save(os.path.join(ROOT, "favicon.ico"),
         sizes=[(48, 48), (32, 32), (16, 16)])
print("wrote favicon.ico")


# --- Vector favicon (matches the raster mark) -----------------------------
def f(v):
    return round(v * 100, 2)


def rect_svg(x0, y0, x1, y1, r, fill):
    return (f'  <rect x="{f(x0)}" y="{f(y0)}" width="{f(x1 - x0)}" '
            f'height="{f(y1 - y0)}" rx="{f(r)}" ry="{f(r)}" fill="{fill}"/>')


pw = ((WIN[2] - WIN[0]) - MULLION) / 2
ph = ((WIN[3] - WIN[1]) - MULLION) / 2
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="HomeDash">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f9f4ec"/>
      <stop offset="1" stop-color="#e7d9c5"/>
    </linearGradient>
    <clipPath id="r"><rect x="0" y="0" width="100" height="100" rx="20" ry="20"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="100" height="100" fill="url(#bg)"/>
    <polygon points="{f(ROOF[0][0])},{f(ROOF[0][1])} {f(ROOF[1][0])},{f(ROOF[1][1])} {f(ROOF[2][0])},{f(ROOF[2][1])}" fill="#322d26"/>
{rect_svg(BODY[0], BODY[1], BODY[2], BODY[3], BODY_R, "#322d26")}
{rect_svg(WIN[0], WIN[1], WIN[0] + pw, WIN[1] + ph, TILE_R, "#f7f1e9")}
{rect_svg(WIN[0] + pw + MULLION, WIN[1], WIN[0] + 2 * pw + MULLION, WIN[1] + ph, TILE_R, "#c87f4e")}
{rect_svg(WIN[0], WIN[1] + ph + MULLION, WIN[0] + pw, WIN[1] + 2 * ph + MULLION, TILE_R, "#f7f1e9")}
{rect_svg(WIN[0] + pw + MULLION, WIN[1] + ph + MULLION, WIN[0] + 2 * pw + MULLION, WIN[1] + 2 * ph + MULLION, TILE_R, "#f7f1e9")}
  </g>
</svg>
"""
with open(os.path.join(ICONS, "favicon.svg"), "w") as fh:
    fh.write(svg)
print("wrote icons/favicon.svg")
