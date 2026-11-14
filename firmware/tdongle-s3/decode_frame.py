#!/usr/bin/env python3
"""Decode a base64 RGB565 frame dump from the dongle into a PNG (4x nearest)."""
import base64
import sys

from PIL import Image

W, H = 160, 80


def main(src: str, dst: str) -> None:
    raw = open(src, "rb").read().decode("ascii", "ignore")
    start = raw.index("FBEGIN")
    end = raw.index("FEND", start)
    body = raw[start:end].split("\n", 1)[1]
    data = base64.b64decode(body)
    assert len(data) >= W * H * 2, f"short frame: {len(data)} bytes"

    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            i = (y * W + x) * 2
            v = data[i] | (data[i + 1] << 8)
            r = (v >> 11) & 0x1F
            g = (v >> 5) & 0x3F
            b = v & 0x1F
            px[x, y] = (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)

    img.resize((W * 4, H * 4), Image.NEAREST).save(dst)
    print(f"wrote {dst} ({W}x{H} -> 4x)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
