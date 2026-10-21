import sys, glob, os
from PIL import Image, ImageDraw
out = sys.argv[1]
for sp in sys.argv[2:]:
    files = sorted(glob.glob(f"{out}/{sp}_*_0.png"))
    rows = [os.path.basename(f)[len(sp) + 1:-6] for f in files]
    W, H = 480, 360
    sheet = Image.new("RGB", (4 * W, len(rows) * H), (0, 0, 0)); d = ImageDraw.Draw(sheet)
    for r, c in enumerate(rows):
        for k in range(4):
            try: sheet.paste(Image.open(f"{out}/{sp}_{c}_{k}.png").convert("RGB"), (k * W, r * H))
            except Exception as e: pass
        d.text((5, r * H + 5), f"{sp} {c}", fill=(255, 255, 0))
    sheet.thumbnail((1920, 1920)); sheet.save(f"{out}/_sheet_{sp}.jpg", quality=80)
    print(sp, sheet.size)
