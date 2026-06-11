#!/usr/bin/env python3
"""Generate 196x196 Stream Deck key icons for the Chrome profile launchers.

Draws an original four-color browser-circle motif (not the trademarked asset)
at 4x resolution, then downscales with Lanczos for crisp edges.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 196
SS = 4  # supersample factor
S = SIZE * SS

RED = "#ea4335"
YELLOW = "#fbbc05"
GREEN = "#34a853"
BLUE = "#4285f4"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
]


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, px)
        except OSError:
            continue
    return ImageFont.load_default(px)


def draw_browser_circle(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int) -> None:
    """Original rendition of a four-color browser circle: three pie wedges,
    white ring, blue core."""
    box = (cx - r, cy - r, cx + r, cy + r)
    # PIL angles: 0 deg at 3 o'clock, clockwise (y axis points down)
    draw.pieslice(box, 210, 330, fill=RED)      # top wedge
    draw.pieslice(box, 330, 90, fill=GREEN)     # lower-right wedge
    draw.pieslice(box, 90, 210, fill=YELLOW)    # lower-left wedge
    ring = int(r * 0.46)
    draw.ellipse((cx - ring, cy - ring, cx + ring, cy + ring), fill="white")
    core = int(r * 0.34)
    draw.ellipse((cx - core, cy - core, cx + core, cy + core), fill=BLUE)


def make_icon(name: str, initial: str, accent: str, out: Path) -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # dark rounded-rect card so the key reads well on a dark deck
    pad = 4 * SS
    d.rounded_rectangle(
        (pad, pad, S - pad, S - pad),
        radius=32 * SS,
        fill="#17171f",
        outline=accent,
        width=3 * SS,
    )

    # browser circle, nudged up to leave room for the label
    cx, cy, r = S // 2, int(S * 0.42), int(S * 0.27)
    # accent halo ring around the motif ties it to the profile color
    halo = r + 7 * SS
    d.ellipse((cx - halo, cy - halo, cx + halo, cy + halo), outline=accent, width=4 * SS)
    draw_browser_circle(d, cx, cy, r)

    # initial badge, bottom-right of the motif
    br = int(r * 0.42)
    bx, by = cx + r, cy + r
    d.ellipse((bx - br, by - br, bx + br, by + br), fill=accent, outline="#17171f", width=3 * SS)
    f_badge = load_font(int(br * 1.2))
    d.text((bx, by), initial, font=f_badge, fill="white", anchor="mm")

    # profile name label
    f_label = load_font(26 * SS)
    d.text((S // 2, int(S * 0.82)), name, font=f_label, fill=accent, anchor="mm")

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    img.save(out)
    print(f"wrote {out} ({img.size[0]}x{img.size[1]})")


def main() -> None:
    icons = Path(__file__).resolve().parent.parent / "icons"
    icons.mkdir(exist_ok=True)
    make_icon("Chaiwut", "C", "#a855f7", icons / "chrome-chaiwut.png")
    make_icon("IBMDT", "I", "#3b82f6", icons / "chrome-ibmdt.png")


if __name__ == "__main__":
    main()
