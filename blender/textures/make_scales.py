"""Tileable reptile-scale normal map (512²) from wrapped Worley noise: domed scales, grooves between."""
import sys, numpy as np
argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]; N = 512; CELLS = 22
rng = np.random.default_rng(3)
# jittered, slightly row-offset grid of seeds (scales are arranged in loose rows)
pts = []
for j in range(CELLS):
    for i in range(CELLS):
        pts.append(((i + 0.5 * (j % 2) + rng.uniform(-0.3, 0.3)) / CELLS % 1.0, (j + rng.uniform(-0.3, 0.3)) / CELLS % 1.0))
pts = np.array(pts); hv = rng.uniform(0.7, 1.0, len(pts))
y, x = np.mgrid[0:N, 0:N] / N
F1 = np.full((N, N), 9.0); F2 = np.full((N, N), 9.0); ID = np.zeros((N, N), int)
for k, (px, py) in enumerate(pts):
    dx = np.abs(x - px); dx = np.minimum(dx, 1 - dx)
    dy = np.abs(y - py); dy = np.minimum(dy, 1 - dy)
    d = np.sqrt(dx * dx + dy * dy)
    closer = d < F1
    F2 = np.where(closer, F1, np.minimum(F2, d)); ID = np.where(closer, k, ID); F1 = np.where(closer, d, F1)
edge = (F2 - F1) * CELLS            # 0 on the groove between two scales
dome = np.clip(edge / 0.45, 0, 1) ** 0.6 * (1 - 0.35 * (F1 * CELLS) ** 2)
h = dome * hv[ID]
# fine pebbling
fine = rng.normal(0, 1, (N // 4, N // 4)); fine = np.kron(fine, np.ones((4, 4)))
for _ in range(2): fine = (fine + np.roll(fine, 1, 0) + np.roll(fine, -1, 0) + np.roll(fine, 1, 1) + np.roll(fine, -1, 1)) / 5
h = h + 0.06 * fine
gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * N / 2 / CELLS * 0.28
gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * N / 2 / CELLS * 0.28
nx, ny, nz = -gx, gy, np.ones_like(h)   # OpenGL (+Y up) convention
l = np.sqrt(nx * nx + ny * ny + nz * nz); nx, ny, nz = nx / l, ny / l, nz / l
img = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5, np.ones_like(h)], -1)
import bpy
im = bpy.data.images.new("scales", N, N, alpha=False, float_buffer=False)
im.colorspace_settings.name = 'Non-Color'
im.pixels.foreach_set(img[::-1].astype(np.float32).ravel())
im.filepath_raw = OUT; im.file_format = 'PNG'; im.save()
print("SCALES written", OUT, "mean nz", float(nz.mean()))
