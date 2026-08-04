#!/usr/bin/env python3
"""Generate a 256x256 placeholder app icon (.ico) with no third-party deps.

Draws a simple database-cylinder motif on the app's dark background and wraps
a PNG-encoded image in an ICO container (ICO supports PNG entries since Vista).
Replace build/icon.ico with a real icon anytime; see README.
"""
import struct
import zlib
import os

W = H = 256

BG = (30, 30, 46, 255)        # app background #1e1e2e
DISK = (124, 156, 255, 255)   # accent #7c9cff
DISK_HI = (150, 178, 255, 255)
BAND = (76, 175, 143, 255)    # #4caf8f divider


def inside_ellipse(x, y, cx, cy, rx, ry):
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    return dx * dx + dy * dy <= 1.0


def pixel(x, y):
    cx = 128
    rx, ry = 66, 20
    top_y, bot_y = 74, 174
    in_body = (cx - rx) <= x <= (cx + rx) and top_y <= y <= bot_y
    in_top = inside_ellipse(x, y, cx, top_y, rx, ry)
    in_bot = inside_ellipse(x, y, cx, bot_y, rx, ry)
    if in_top:
        return DISK_HI
    if in_body or in_bot:
        # divider bands to suggest stacked disks
        for band in (108, 141):
            if inside_ellipse(x, y, cx, band, rx, ry) and abs(y - band) <= 2:
                return BAND
        return DISK
    return BG


def make_png():
    raw = bytearray()
    for y in range(H):
        raw.append(0)  # filter type 0 (None)
        for x in range(W):
            r, g, b, a = pixel(x, y)
            raw += bytes((r, g, b, a))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return out + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")


def make_ico(png_bytes):
    # ICONDIR
    header = struct.pack("<HHH", 0, 1, 1)
    # ICONDIRENTRY: width/height 0 => 256
    offset = 6 + 16
    entry = struct.pack(
        "<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_bytes), offset
    )
    return header + entry + png_bytes


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    png = make_png()
    ico = make_ico(png)
    ico_path = os.path.join(here, "icon.ico")
    with open(ico_path, "wb") as f:
        f.write(ico)
    # Also drop the PNG next to it (handy for other targets / previews).
    with open(os.path.join(here, "icon.png"), "wb") as f:
        f.write(png)
    print(f"wrote {ico_path} ({len(ico)} bytes), icon.png ({len(png)} bytes)")


if __name__ == "__main__":
    main()
