import sys, glob
from PIL import Image
prefix, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
crop = [float(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else [0.12, 0.18, 0.88, 0.82]
files = sorted(glob.glob(prefix + "_*.png"))[:n]
cols = 4; rows = (len(files) + cols - 1) // cols
W, H = 560, 380
s = Image.new("RGB", (cols * W, rows * H))
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB"); w, h = im.size
    c = im.crop((int(w * crop[0]), int(h * crop[1]), int(w * crop[2]), int(h * crop[3]))).resize((W, H))
    s.paste(c, ((i % cols) * W, (i // cols) * H))
s.save(out, quality=86)
