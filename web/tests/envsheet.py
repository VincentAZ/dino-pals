"""Contact sheets for tests/envqa.mjs output.
  python3 tests/envsheet.py <tag-dir> <out.jpg> [tier] [view,view,...] [cols]
  python3 tests/envsheet.py --compare <before-dir> <after-dir> <out.jpg> [tier] [views]
"""
import sys, os
from PIL import Image, ImageDraw

W, H = 708, 492

def tile(path, label):
    im = Image.open(path).convert('RGB').resize((W, H)) if os.path.exists(path) else Image.new('RGB', (W, H), (40, 40, 40))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, len(label) * 7 + 8, 16], fill=(0, 0, 0))
    d.text((4, 2), label, fill=(255, 255, 255))
    return im

args = sys.argv[1:]
if args and args[0] == '--compare':
    before, after, out = args[1], args[2], args[3]
    tier = args[4] if len(args) > 4 else 'high'
    views = args[5].split(',') if len(args) > 5 else ['start', 'grass', 'jungle', 'volcano-meadow', 'swamp', 'canyon']
    s = Image.new('RGB', (2 * W, len(views) * H))
    for i, v in enumerate(views):
        s.paste(tile(os.path.join(before, f'{tier}-{v}.png'), f'BEFORE {tier} {v}'), (0, i * H))
        s.paste(tile(os.path.join(after, f'{tier}-{v}.png'), f'AFTER {tier} {v}'), (W, i * H))
    s.save(out, quality=86)
else:
    d, out = args[0], args[1]
    tier = args[2] if len(args) > 2 else 'high'
    views = args[3].split(',') if len(args) > 3 and args[3] else sorted(f[len(tier) + 1:-4] for f in os.listdir(d) if f.startswith(tier + '-') and f.endswith('.png'))
    cols = int(args[4]) if len(args) > 4 else 3
    rows = (len(views) + cols - 1) // cols
    s = Image.new('RGB', (cols * W, rows * H))
    for i, v in enumerate(views):
        s.paste(tile(os.path.join(d, f'{tier}-{v}.png'), f'{tier} {v}'), ((i % cols) * W, (i // cols) * H))
    s.save(out, quality=86)
print(out)
