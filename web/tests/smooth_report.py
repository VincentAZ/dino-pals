# Top motion events from tests/shots/smooth.json (written by tests/smooth.mjs): jolts and side slides
# with what pushed the body at that frame.
import json, math, os, sys
d = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots', 'smooth.json')))
dt = 1 / 30
ev = []
for id, arr in d.items():
    for i in range(2, len(arr)):
        if arr[i][0] - arr[i - 2][0] > 2.5 * dt: continue
        r, p, q = arr[i], arr[i - 1], arr[i - 2]
        ax = (r[1] - 2 * p[1] + q[1]) / dt / dt; az = (r[2] - 2 * p[2] + q[2]) / dt / dt
        dx, dz = r[1] - p[1], r[2] - p[2]; c, s = math.cos(r[3]), math.sin(r[3])
        side = abs(dx * c - dz * s) / dt
        ev.append((max(math.hypot(ax, az) / 8, side / 0.8), id, i, math.hypot(ax, az), side))
ev.sort(reverse=True)
seen = {}
for sc, id, i, acc, side in ev:
    if seen.get(id, 0) >= 2 or sc < 1: continue
    seen[id] = seen.get(id, 0) + 1
    arr = d[id]; r = arr[i]
    print(f"{id:24s} t={r[0]:6.2f} acc={acc:5.1f} side={side:4.2f} state={arr[i-1][7]}->{r[7]} tree={r[14]:.3f} dino={r[15]:.3f} {r[16]:22s} target={r[17]} food={r[18]} follow={r[19]} baby={r[20]}")
    if len(sys.argv) > 1:
        for j in range(max(1, i - 3), min(len(arr), i + 3)):
            a, b = arr[j], arr[j - 1]; ddx, ddz = a[1] - b[1], a[2] - b[2]; cc, ss = math.cos(a[3]), math.sin(a[3])
            print(f"     t={a[0]:6.2f} fwd={(ddx*ss+ddz*cc)/dt:5.2f} side={(ddx*cc-ddz*ss)/dt:5.2f} hdg={a[3]:6.3f} {a[7]} tree={a[14]:.3f} dino={a[15]:.3f}")
