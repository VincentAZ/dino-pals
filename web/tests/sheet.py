import sys, glob
from PIL import Image
prefix, out, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 4
files = sorted(glob.glob(prefix + "_*.png"))
n = len(files); rows = (n + cols - 1) // cols
W, H = 590, 410
crop = None
s = Image.new("RGB", (cols * W, rows * H))
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").resize((W, H))
    s.paste(im, ((i % cols) * W, (i // cols) * H))
s.save(out, quality=85); print(out, s.size, n)
