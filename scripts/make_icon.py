#!/usr/bin/env python3
"""Reshape the qwry logo into a macOS-template app icon master (1024²).

Apple grid: a rounded "squircle" content square (824²) centered in a 1024 canvas
with margin for a soft drop shadow; the glyph sits padded inside. Source is the
transparent SVG (rendered to PNG by rsvg-convert) — clean alpha, no black-key.
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SRC = "/tmp/qwry_glyph.png"  # rsvg-convert -w 1024 logo_transparent.svg
OUT = os.path.expanduser("~/projects/qwry/icon-master.png")

S = 1024              # full canvas
SQ = 824              # rounded content square (Apple template)
MARGIN = (S - SQ) // 2
RADIUS = 185          # ~22.5% corner radius
GLYPH_FRAC = 0.66     # glyph occupies this fraction of the square's long side

# transparent glyph → crop to its visible bounds directly
glyph = Image.open(SRC).convert("RGBA")
glyph = glyph.crop(glyph.getbbox())
gw, gh = glyph.size
scale = (SQ * GLYPH_FRAC) / max(gw, gh)
glyph = glyph.resize((max(1, round(gw * scale)), max(1, round(gh * scale))), Image.LANCZOS)

# charcoal vertical gradient, masked to a rounded square
top, bot = (30, 30, 37), (12, 12, 16)
bg = Image.new("RGBA", (SQ, SQ))
bd = ImageDraw.Draw(bg)
for y in range(SQ):
    t = y / (SQ - 1)
    bd.line([(0, y), (SQ, y)], fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
mask = Image.new("L", (SQ, SQ), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SQ - 1, SQ - 1], radius=RADIUS, fill=255)
square = Image.composite(bg, Image.new("RGBA", (SQ, SQ), (0, 0, 0, 0)), mask)

# center the glyph (nudge up slightly for optical balance)
gx = (SQ - glyph.size[0]) // 2
gy = (SQ - glyph.size[1]) // 2 - 8
square.alpha_composite(glyph, (gx, gy))

# soft drop shadow under the square
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [MARGIN, MARGIN + 14, MARGIN + SQ, MARGIN + SQ + 14], radius=RADIUS, fill=(0, 0, 0, 130)
)
shadow = shadow.filter(ImageFilter.GaussianBlur(20))

canvas = Image.alpha_composite(Image.new("RGBA", (S, S), (0, 0, 0, 0)), shadow)
canvas.alpha_composite(square, (MARGIN, MARGIN))
canvas.save(OUT)
print("wrote", OUT, canvas.size)
