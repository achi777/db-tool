#!/usr/bin/env python3
"""Generate the DBTool application icon.

Renders a database-cylinder mark on the app's dark background at 4x
supersampling and writes:

    build/icon.png   1024x1024 (macOS / Linux targets, previews)
    build/icon.ico   16/24/32/48/64/128/256 (Windows target)

electron-builder picks both up automatically. Requires Pillow:

    python -m pip install Pillow
    python build/make_icon.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter

# --- palette (matches the app's dark theme) --------------------------------
BG_TOP = (42, 47, 74)          # #2a2f4a
BG_BOTTOM = (20, 23, 42)       # #14172a
BODY_TOP = (138, 166, 255)     # #8aa6ff
BODY_BOTTOM = (74, 99, 200)    # #4a63c8
LID_TOP = (176, 197, 255)      # #b0c5ff
LID_BOTTOM = (128, 152, 240)   # #8098f0
BAND = (76, 175, 143)          # #4caf8f  accent
RIM = (208, 222, 255)          # #d0deff  lit top edge

# --- geometry, as fractions of the canvas ----------------------------------
CORNER = 0.225                 # rounded-square radius
CX = 0.500                     # cylinder centre x
RX = 0.295                     # cylinder half-width
RY = 0.102                     # ellipse half-height
TOP_Y = 0.310                  # centre y of the top ellipse
BOT_Y = 0.690                  # centre y of the bottom ellipse
BANDS = (0.438, 0.566)         # centre y of the two divider bands
BAND_W = 0.015                 # band thickness
GROOVE = (12, 18, 46)          # #0c122e  shading above each band
SHADOW_DY = 0.022              # shadow offset
SHADOW_BLUR = 0.028

SS = 4                         # supersampling factor


def _linear_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A vertical two-stop gradient, `size` x `size`."""
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return grad.resize((size, size), Image.NEAREST)


def _cylinder_mask(size: int) -> Image.Image:
    """Silhouette of the whole cylinder (body + both caps)."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    left, right = (CX - RX) * size, (CX + RX) * size
    d.ellipse([left, (BOT_Y - RY) * size, right, (BOT_Y + RY) * size], fill=255)
    d.rectangle([left, TOP_Y * size, right, BOT_Y * size], fill=255)
    d.ellipse([left, (TOP_Y - RY) * size, right, (TOP_Y + RY) * size], fill=255)
    return mask


def render(size: int) -> Image.Image:
    """Render the icon at `size` px, supersampled and downscaled."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded-square background with a vertical gradient.
    bg_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(bg_mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=CORNER * s, fill=255
    )
    img.paste(_linear_gradient(s, BG_TOP, BG_BOTTOM), (0, 0), bg_mask)

    # Soft drop shadow under the cylinder.
    shadow = Image.new("L", (s, s), 0)
    shadow.paste(_cylinder_mask(s), (0, round(SHADOW_DY * s)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR * s))
    shadow = shadow.point(lambda v: int(v * 0.55))
    shadow = Image.composite(shadow, Image.new("L", (s, s), 0), bg_mask)
    img.paste(Image.new("RGB", (s, s), (8, 10, 20)), (0, 0), shadow)

    # Cylinder body (rectangle + bottom cap), vertical gradient.
    body = Image.new("L", (s, s), 0)
    bd = ImageDraw.Draw(body)
    left, right = (CX - RX) * s, (CX + RX) * s
    bd.ellipse([left, (BOT_Y - RY) * s, right, (BOT_Y + RY) * s], fill=255)
    bd.rectangle([left, TOP_Y * s, right, BOT_Y * s], fill=255)
    img.paste(_linear_gradient(s, BODY_TOP, BODY_BOTTOM), (0, 0), body)

    # Divider bands: the front-facing arc of an ellipse at each band height,
    # with a soft groove above it so the disks read as stacked rather than drawn on.
    def arc(cy: float, width: float) -> Image.Image:
        ring = Image.new("L", (s, s), 0)
        ImageDraw.Draw(ring).ellipse(
            [left, (cy - RY) * s, right, (cy + RY) * s],
            outline=255,
            width=max(round(width * s), 1),
        )
        # Keep only the lower (visible) half of the ring, clipped to the body.
        cut = Image.new("L", (s, s), 0)
        ImageDraw.Draw(cut).rectangle([0, cy * s, s, s], fill=255)
        ring = Image.composite(ring, Image.new("L", (s, s), 0), cut)
        return Image.composite(ring, Image.new("L", (s, s), 0), body)

    for cy in BANDS:
        groove = arc(cy - BAND_W * 0.9, BAND_W * 0.8)
        groove = groove.filter(ImageFilter.GaussianBlur(0.004 * s))
        img.paste(
            Image.new("RGB", (s, s), GROOVE), (0, 0), groove.point(lambda v: int(v * 0.42))
        )
        img.paste(Image.new("RGB", (s, s), BAND), (0, 0), arc(cy, BAND_W))

    # Top cap, lighter, with a lit rim.
    lid = Image.new("L", (s, s), 0)
    ImageDraw.Draw(lid).ellipse(
        [left, (TOP_Y - RY) * s, right, (TOP_Y + RY) * s], fill=255
    )
    img.paste(_linear_gradient(s, LID_TOP, LID_BOTTOM), (0, 0), lid)

    rim = Image.new("L", (s, s), 0)
    ImageDraw.Draw(rim).ellipse(
        [left, (TOP_Y - RY) * s, right, (TOP_Y + RY) * s],
        outline=255,
        width=max(round(0.008 * s), 1),
    )
    cut = Image.new("L", (s, s), 0)
    ImageDraw.Draw(cut).rectangle([0, 0, s, TOP_Y * s], fill=255)
    rim = Image.composite(rim, Image.new("L", (s, s), 0), cut)
    img.paste(Image.new("RGB", (s, s), RIM), (0, 0), rim.point(lambda v: int(v * 0.75)))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))

    master = render(1024)
    png_path = os.path.join(here, "icon.png")
    master.save(png_path, format="PNG", optimize=True)

    ico_path = os.path.join(here, "icon.ico")
    master.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print(f"wrote {png_path} ({os.path.getsize(png_path):,} bytes)")
    print(f"wrote {ico_path} ({os.path.getsize(ico_path):,} bytes)")


if __name__ == "__main__":
    main()
