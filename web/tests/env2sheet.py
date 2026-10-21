"""Before / after comparison sheets for tests/env2qa.mjs and tests/envqa.mjs shots.
  python3 tests/env2sheet.py <before-dir> <after-dir> <out.jpg> <view,view,...> [tier] [width]
Each row: BEFORE | AFTER for one view (tier prefix 'high' by default).
"""
import sys, os
from PIL import Image, ImageDraw

before, after, out, views = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(',')
tier = sys.argv[5] if len(sys.argv) > 5 else 'high'
W = int(sys.argv[6]) if len(sys.argv) > 6 else 900
H = round(W * 1640 / 2360)

def tile(path, label):
    im = Image.open(path).convert('RGB').resize((W, H), Image.LANCZOS) if os.path.exists(path) else Image.new('RGB', (W, H), (40, 40, 40))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, len(label) * 7 + 10, 18], fill=(0, 0, 0))
    d.text((5, 3), label, fill=(255, 255, 255))
    return im

sheet = Image.new('RGB', (2 * W + 6, len(views) * (H + 6)), (255, 255, 255))
for i, v in enumerate(views):
    sheet.paste(tile(os.path.join(before, f'{tier}-{v}.png'), f'BEFORE {tier} {v}'), (0, i * (H + 6)))
    sheet.paste(tile(os.path.join(after, f'{tier}-{v}.png'), f'AFTER {tier} {v}'), (W + 6, i * (H + 6)))
sheet.save(out, quality=88)
print(out)
