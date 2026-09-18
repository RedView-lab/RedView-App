"""Crop + magnify regions of the screenshot so the stripe structure is readable."""
import sys
from PIL import Image

src = sys.argv[1]
out = sys.argv[2]
img = Image.open(src).convert("RGB")
w, h = img.size

# (label, box)
crops = [
    ("A-centre", (820, 300, 1080, 420)),
    ("B-haut", (600, 120, 860, 240)),
    ("C-bas", (300, 600, 560, 720)),
    ("D-droite", (1300, 380, 1560, 500)),
]
F = 4
tiles = []
for label, box in crops:
    c = img.crop(box)
    c = c.resize((c.width * F, c.height * F), Image.NEAREST)
    tiles.append((label, c))

gap = 12
tw = max(t.width for _, t in tiles)
th = sum(t.height for _, t in tiles) + gap * (len(tiles) - 1)
canvas = Image.new("RGB", (tw, th), (20, 20, 20))
y = 0
for _, t in tiles:
    canvas.paste(t, (0, y))
    y += t.height + gap
canvas.save(out)
print(f"wrote {out}  {canvas.width}x{canvas.height}  (regions {[c[0] for c in crops]} magnified {F}x, NEAREST)")
