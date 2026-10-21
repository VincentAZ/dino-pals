"""Dino Pals — volumetric auto-rigging (v2).

The mesh is voxelised into a solid occupancy grid. From that solid we derive:
  * the spine as the medial axis of the body (centre of the largest inscribed circle in every
    cross-section along the body), so plates, sails and legs cannot drag it out of the torso;
  * each leg by tracing its cross-section upward from the ground until it merges with the body,
    then fitting ankle / knee joints to that centre line;
  * the mouth line (gap between upper and lower jaw, or a proportional fallback);
  * skin weights from geodesic distances *through the solid*, so a vertex on one leg can never be
    influenced by the other leg or the belly across empty space.

All coordinates are Blender object space (Z up, head towards -Y, metres). Pure numpy.
"""
import math
import numpy as np


# ------------------------------------------------------------------ grid helpers
class Grid:
    def __init__(self, mn, mx, vox, pad=3):
        self.vox = float(vox)
        self.pad = pad
        self.org = np.asarray(mn, np.float64) - pad * vox
        self.shape = tuple(int(n) for n in (np.ceil((np.asarray(mx) - np.asarray(mn)) / vox).astype(int) + 2 * pad + 1))

    def idx(self, P):
        I = np.floor((np.asarray(P, np.float64) - self.org) / self.vox).astype(np.int64)
        for a in range(3):
            np.clip(I[..., a], 0, self.shape[a] - 1, out=I[..., a])
        return I

    def pos(self, I):
        return self.org + (np.asarray(I, np.float64) + 0.5) * self.vox


def dilate6(a):
    b = a.copy()
    b[1:] |= a[:-1]; b[:-1] |= a[1:]
    b[:, 1:] |= a[:, :-1]; b[:, :-1] |= a[:, 1:]
    b[:, :, 1:] |= a[:, :, :-1]; b[:, :, :-1] |= a[:, :, 1:]
    return b


def dilate26(a):
    b = a.copy()
    b[1:] |= a[:-1]; b[:-1] |= a[1:]
    c = b.copy()
    c[:, 1:] |= b[:, :-1]; c[:, :-1] |= b[:, 1:]
    d = c.copy()
    d[:, :, 1:] |= c[:, :, :-1]; d[:, :, :-1] |= c[:, :, 1:]
    return d


# ------------------------------------------------------------------ voxelisation
def voxelize(V, T, vox, close=1):
    """Surface-sample every triangle into the grid, close small cracks, flood the outside from the
    border; everything not reachable from outside is solid."""
    g = Grid(V.min(0), V.max(0), vox)
    surf = np.zeros(g.shape, bool)
    A, B, C = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    emax = np.maximum(np.maximum(np.linalg.norm(B - A, axis=1), np.linalg.norm(C - B, axis=1)), np.linalg.norm(A - C, axis=1))
    k = np.clip(np.ceil(emax / (0.45 * vox)).astype(int), 1, 40)
    for kk in np.unique(k):
        sel = np.where(k == kk)[0]
        u, v = np.meshgrid(np.arange(kk + 1), np.arange(kk + 1), indexing='ij')
        m = (u + v) <= kk
        u = (u[m] / kk)[None, :, None]; v = (v[m] / kk)[None, :, None]; w = 1 - u - v
        step = max(1, int(4e6 // max(1, u.shape[1])))
        for s in range(0, len(sel), step):
            ss = sel[s:s + step]
            P = A[ss, None, :] * w + B[ss, None, :] * u + C[ss, None, :] * v
            I = g.idx(P.reshape(-1, 3))
            surf[I[:, 0], I[:, 1], I[:, 2]] = True
    shell = surf
    for _ in range(close):
        shell = dilate6(shell)
    free = ~shell
    ext = np.zeros(g.shape, bool)
    ext[0] = ext[-1] = True; ext[:, 0] = ext[:, -1] = True; ext[:, :, 0] = ext[:, :, -1] = True
    ext &= free
    n = ext.sum()
    while True:
        ext = dilate6(ext) & free
        m = ext.sum()
        if m == n:
            break
        n = m
    solid = ~ext
    # undo the closing dilation on the outside (keeps silhouettes honest), but never remove the original surface
    for _ in range(close):
        er = solid.copy()
        er[1:] &= solid[:-1]; er[:-1] &= solid[1:]
        er[:, 1:] &= solid[:, :-1]; er[:, :-1] &= solid[:, 1:]
        er[:, :, 1:] &= solid[:, :, :-1]; er[:, :, :-1] &= solid[:, :, 1:]
        solid = er | surf
    return g, solid, surf


# ------------------------------------------------------------------ cross-section distance (per Y slice)
def slice_dt(solid):
    """Chamfer distance to the outside inside every XZ cross-section (alternating 4/8 neighbourhoods
    ≈ octagonal metric). Returns int16 grid."""
    d = np.zeros(solid.shape, np.int16)
    cur = solid.copy()
    it = 0
    while cur.any():
        d += cur
        e = cur.copy()
        e[1:] &= cur[:-1]; e[:-1] &= cur[1:]
        e[:, :, 1:] &= cur[:, :, :-1]; e[:, :, :-1] &= cur[:, :, 1:]
        if it % 2 == 1:   # diagonal erosion on odd steps
            e[1:, :, 1:] &= cur[:-1, :, :-1]; e[:-1, :, :-1] &= cur[1:, :, 1:]
            e[1:, :, :-1] &= cur[:-1, :, 1:]; e[:-1, :, 1:] &= cur[1:, :, :-1]
        e[0] = False; e[-1] = False; e[:, :, 0] = False; e[:, :, -1] = False
        cur = e
        it += 1
    return d


def spine_curve(g, solid, dt):
    """Medial centre of each Y cross-section, tracked with continuity from the thickest slice.
    Returns dict j -> (x, y, z, radius_m)."""
    ny = g.shape[1]
    rmax = dt.max(axis=(0, 2))
    occ = np.where(rmax > 0)[0]
    j0 = int(occ[np.argmax(rmax[occ])])
    out = {}

    def centre(j, prev):
        S = dt[:, j, :].astype(np.float64)
        if S.max() <= 0:
            return None
        if prev is not None:
            xi, zi = np.indices(S.shape)
            dist = np.hypot(xi - prev[0], zi - prev[1])
            score = S - 0.12 * dist
            score[S <= 0] = -1e9
            # never jump to a disconnected blob far away
            score[dist > max(6.0, 2.5 * S.max())] = -1e9
            if score.max() < -1e8:
                return None
            ai, ak = np.unravel_index(np.argmax(score), S.shape)
        else:
            ai, ak = np.unravel_index(np.argmax(S), S.shape)
        loc = S[ai, ak]
        x0, x1 = max(0, ai - 3), min(S.shape[0], ai + 4)
        z0, z1 = max(0, ak - 3), min(S.shape[1], ak + 4)
        W = S[x0:x1, z0:z1]
        W = np.where(W >= loc - 0.6, W, 0)
        xi, zi = np.indices(W.shape)
        cx = (xi * W).sum() / W.sum() + x0; cz = (zi * W).sum() / W.sum() + z0
        return (cx, cz, loc)

    c = centre(j0, None)
    out[j0] = c
    for direction in (-1, 1):
        prev = (c[0], c[1])
        j = j0 + direction
        while 0 <= j < ny:
            cc = centre(j, prev)
            if cc is None:
                break
            out[j] = cc; prev = (cc[0], cc[1]); j += direction
    js = sorted(out)
    P = np.array([[out[j][0], j, out[j][1]] for j in js], np.float64)
    R = np.array([out[j][2] for j in js], np.float64)
    # smooth (moving average, shrinking window at the ends)
    Ps = P.copy()
    for i in range(len(P)):
        a, b = max(0, i - 3), min(len(P), i + 4)
        Ps[i, [0, 2]] = P[a:b, [0, 2]].mean(0)
    world = g.org + (Ps + 0.5) * g.vox
    return world, R * g.vox


def curve_at(curve, y):
    """Interpolate the spine curve (sorted by y) at y."""
    ys = curve[:, 1]
    return np.array([np.interp(y, ys, curve[:, 0]), y, np.interp(y, ys, curve[:, 2])])


def resample_polyline(P, n):
    """n+1 points equally spaced by arc length along polyline P."""
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n + 1)
    return np.stack([np.interp(t, s, P[:, k]) for k in range(3)], 1)


def curve_between(curve, y0, y1, n):
    """Spine curve section from y0 to y1 (either order), resampled into n segments."""
    lo, hi = min(y0, y1), max(y0, y1)
    ys = curve[:, 1]
    inner = curve[(ys > lo) & (ys < hi)]
    P = np.vstack([curve_at(curve, lo)[None], inner, curve_at(curve, hi)[None]])
    if y0 > y1:
        P = P[::-1]
    return resample_polyline(P, n)


# ------------------------------------------------------------------ legs
def _components2d(mask):
    """Connected components (8-neighbourhood) of a small 2D boolean mask → list of index arrays."""
    lab = np.zeros(mask.shape, np.int32)
    comps = []
    pts = np.argwhere(mask)
    for p in pts:
        if lab[p[0], p[1]]:
            continue
        cid = len(comps) + 1
        stack = [tuple(p)]; lab[p[0], p[1]] = cid; members = []
        while stack:
            a, b = stack.pop(); members.append((a, b))
            for da in (-1, 0, 1):
                for db in (-1, 0, 1):
                    na, nb = a + da, b + db
                    if 0 <= na < mask.shape[0] and 0 <= nb < mask.shape[1] and mask[na, nb] and not lab[na, nb]:
                        lab[na, nb] = cid; stack.append((na, nb))
        comps.append(np.array(members))
    return comps


def find_feet(g, solid, ground_z, height, min_area_frac=0.0006):
    """Ground-contact blobs a few cm above the ground."""
    kg = int(g.idx(np.array([0, 0, ground_z + max(0.03 * height, 1.5 * g.vox)]))[2])
    S = solid[:, :, kg]
    comps = _components2d(S)
    tot = solid[:, :, kg:].sum(axis=2).astype(bool).sum()
    feet = [c for c in comps if len(c) >= max(4, min_area_frac * tot)]
    return kg, feet


def trace_leg(g, solid, kg, comp, k_max):
    """Track a leg cross-section upward. Returns list of (x, y, z) centroids (world) and stop reason."""
    c = comp.mean(0).astype(np.float64)
    r = math.sqrt(len(comp) / math.pi)
    pts = [(c[0], c[1], kg, len(comp))]
    areas = [len(comp)]
    full = 0
    xi, yi = np.indices(solid.shape[:2])
    for k in range(kg + 1, k_max):
        R = max(2.0, 1.6 * r + 1.0)
        disk = (xi - c[0]) ** 2 + (yi - c[1]) ** 2 <= R * R
        cells = solid[:, :, k] & disk
        n = int(cells.sum())
        if n == 0:
            break
        fill = n / max(1.0, disk.sum())
        med = float(np.median(areas[-6:]))
        if (fill > 0.78) or (n > 2.2 * med and len(areas) > 4):
            full += 1
            if full >= 2:
                break
        else:
            full = 0
        w = np.argwhere(cells)
        c = w.mean(0).astype(np.float64); r = math.sqrt(n / math.pi)
        pts.append((c[0], c[1], k, n)); areas.append(n)
    P = np.array([[p[0], p[1], p[2]] for p in pts], np.float64)
    if full >= 2 and len(P) > 3:
        P = P[:-2]
    world = g.org + (P + 0.5) * g.vox
    return world, np.array([p[3] for p in pts], np.float64) * g.vox * g.vox


def fit_leg(P, hip, ground_z):
    """Fit ankle (a) and knee (b) on the centre line P (ascending z) with the hip appended.
    Minimises squared distance of the line points to the 3-segment polyline foot→ankle→knee→hip."""
    Q = np.vstack([P, hip[None]])
    n = len(Q)
    legH = hip[2] - ground_z

    def seg_err(i, j):
        A, B = Q[i], Q[j]
        if j - i < 2:
            return 0.0
        X = Q[i + 1:j]
        AB = B - A; L2 = AB @ AB + 1e-12
        t = np.clip(((X - A) @ AB) / L2, 0, 1)
        D = X - (A + t[:, None] * AB)
        return float((D * D).sum())

    best = None
    for a in range(1, n - 2):
        za = (Q[a, 2] - ground_z) / legH
        if za < 0.05 or za > 0.45:
            continue
        for b in range(a + 1, n - 1):
            zb = (Q[b, 2] - ground_z) / legH
            if zb < 0.28 or zb > 0.88 or zb - za < 0.12:
                continue
            e = seg_err(0, a) + seg_err(a, b) + seg_err(b, n - 1)
            if best is None or e < best[0]:
                best = (e, a, b)
    if best is None:   # straight column (sauropod) → proportional joints
        ank = hip + (P[0] - hip) * 0.88
        kne = hip + (P[0] - hip) * 0.48
        return ank, kne
    return Q[best[1]].copy(), Q[best[2]].copy()


def toe_tip(g, solid, kg, comp, ankle_world, leg_h, ground_z):
    """Ground contact of this foot → (ball, toe) world points. The toe is the front-most contact
    (head is -Y); the ball is the rear end of the contact (where a digitigrade metatarsus meets the
    toes), never behind the ankle."""
    k0 = max(0, kg - 3)
    S = solid[:, :, k0:kg + 1].any(axis=2)
    comps = _components2d(S)
    cset = set(map(tuple, comp.tolist()))
    best, ov = None, 0
    for c in comps:
        o = sum(1 for p in map(tuple, c.tolist()) if p in cset)
        if o > ov: best, ov = c, o
    if best is None:
        return None, None
    ax, ay = g.idx(ankle_world)[:2]
    reach = 0.45 * leg_h / g.vox
    pts = best[(best[:, 0] - ax) ** 2 + (best[:, 1] - ay) ** 2 <= reach * reach]
    if len(pts) == 0:
        return None, None
    jf = pts[:, 1].min()
    front = pts[pts[:, 1] <= jf + 1]
    toe = g.org + (np.array([front[:, 0].mean(), jf, 0]) + 0.5) * g.vox
    jb = min(pts[:, 1].max(), ay + 1)
    back = pts[pts[:, 1] >= jb - 1]
    ball = g.org + (np.array([back[:, 0].mean(), jb, 0]) + 0.5) * g.vox
    toe[2] = ball[2] = ground_z + 0.4 * g.vox
    # ball sits 30–75 % of the way from the toe tip back to the ankle's ground projection
    span = np.array([ankle_world[0], ankle_world[1]]) - toe[:2]
    tb = ball[:2] - toe[:2]
    f = np.clip((tb @ span) / max(1e-9, span @ span), 0.3, 0.75)
    ball[:2] = toe[:2] + span * f
    return ball, toe


def find_raised_foot(g, solid, side, xc, y_lo, y_hi, z_hi, min_cells=4):
    """Lowest solid blob on one side of the body (side=-1 left, +1 right) inside a y window, below z_hi.
    Used when a foot does not touch the ground (posed models). Returns (k_level, comp) or (None, None)."""
    i_c = g.idx(np.array([xc, 0, 0]))[0]
    j0, j1 = g.idx(np.array([0, y_lo, 0]))[1], g.idx(np.array([0, y_hi, 0]))[1]
    k_hi = g.idx(np.array([0, 0, z_hi]))[2]
    region = np.zeros(solid.shape[:2], bool)
    if side < 0: region[:max(0, i_c - 1), j0:j1 + 1] = True
    else: region[i_c + 2:, j0:j1 + 1] = True
    for k in range(0, k_hi):
        S = solid[:, :, k] & region
        if S.sum() >= min_cells:
            comps = [c for c in _components2d(S) if len(c) >= min_cells]
            if comps:
                kk = min(k + 2, solid.shape[2] - 1)
                S2 = solid[:, :, kk] & region
                comps2 = [c for c in _components2d(S2) if len(c) >= min_cells]
                return kk, max(comps2 or comps, key=len)
    return None, None


# ------------------------------------------------------------------ mouth line
def mouth_line(g, solid, curve, y_hinge, y_snout, jaw_h=0.4):
    """z of the mouth line as a function of y over the head: gap centres where the mouth is open,
    proportional height otherwise. Returns (ys, zs) sampled along the head."""
    j0, j1 = sorted([int(g.idx(np.array([0, y_hinge, 0]))[1]), int(g.idx(np.array([0, y_snout, 0]))[1])])
    ys, zs, gaps = [], [], []
    for j in range(j0, j1 + 1):
        c = curve_at(curve, g.pos(np.array([0, j, 0]))[1])
        ci = g.idx(c)
        col = solid[max(0, ci[0] - 1):ci[0] + 2, j, :].any(axis=0)
        ks = np.where(col)[0]
        if len(ks) < 3:
            continue
        lo, hi = ks.min(), ks.max()
        # largest interior gap
        best_gap = None
        run = None
        for k in range(lo, hi + 1):
            if not col[k]:
                run = (run[0], k) if run else (k, k)
            elif run:
                if best_gap is None or run[1] - run[0] > best_gap[1] - best_gap[0]:
                    best_gap = run
                run = None
        z_lo = g.pos(np.array([0, 0, lo]))[2]; z_hi = g.pos(np.array([0, 0, hi]))[2]
        y = g.pos(np.array([0, j, 0]))[1]
        if best_gap and best_gap[1] - best_gap[0] >= 1:
            zs.append(g.pos(np.array([0, 0, (best_gap[0] + best_gap[1]) / 2]))[2]); gaps.append(True)
        else:
            zs.append(z_lo + jaw_h * (z_hi - z_lo)); gaps.append(False)
        ys.append(y)
    ys, zs = np.array(ys), np.array(zs)
    if len(ys) >= 4:
        # robust straight line through the samples (mouth lines are close to straight)
        A = np.vstack([ys, np.ones_like(ys)]).T
        coef, *_ = np.linalg.lstsq(A, zs, rcond=None)
        zs = A @ coef
    return ys, zs, (np.mean(gaps) if gaps else 0.0)


# ------------------------------------------------------------------ geodesic skin weights
def segment_seeds(g, solid, a, b, zmax=None):
    n = max(2, int(np.linalg.norm(b - a) / (0.5 * g.vox)) + 1)
    P = a[None] + (b - a)[None] * np.linspace(0, 1, n)[:, None]
    if zmax is not None:
        keep = P[:, 2] <= zmax
        if keep.sum() < max(2, 0.3 * n):   # mostly buried: keep the lowest 30 %
            keep = np.zeros(n, bool); keep[np.argsort(P[:, 2])[:max(2, int(0.3 * n))]] = True
        P = P[keep]
    I = g.idx(P)
    seeds = np.zeros(solid.shape, bool)
    seeds[I[:, 0], I[:, 1], I[:, 2]] = True
    seeds = dilate6(seeds) & solid
    if not seeds.any():
        sol = np.argwhere(solid)
        m = g.idx((a + b) / 2)
        k = np.argmin(((sol - m) ** 2).sum(1))
        seeds[tuple(sol[k])] = True
    return seeds


def geodesic(solid, seeds, max_steps):
    dist = np.full(solid.shape, 30000, np.int16)
    front = seeds.copy()
    dist[front] = 0
    visited = front.copy()
    for step in range(1, max_steps + 1):
        nb = (dilate26(front) if step % 2 == 0 else dilate6(front)) & solid & ~visited
        if not nb.any():
            break
        dist[nb] = step
        visited |= nb
        front = nb
    return dist


def nearest_solid_index(g, solid, I, max_r=6):
    """For voxel indices I (n,3) return indices of the nearest solid voxel (searching a cube)."""
    out = I.copy()
    bad = ~solid[I[:, 0], I[:, 1], I[:, 2]]
    if not bad.any():
        return out
    offs = np.array([(a, b, c) for a in range(-max_r, max_r + 1) for b in range(-max_r, max_r + 1) for c in range(-max_r, max_r + 1)])
    offs = offs[np.argsort((offs ** 2).sum(1))]
    rem = np.where(bad)[0]
    for o in offs:
        if len(rem) == 0:
            break
        J = I[rem] + o
        ok = np.all((J >= 0) & (J < np.array(solid.shape)), axis=1)
        hit = np.zeros(len(rem), bool)
        hit[ok] = solid[J[ok, 0], J[ok, 1], J[ok, 2]]
        out[rem[hit]] = J[hit]
        rem = rem[~hit]
    return out


def skin_weights(g, solid, V, bones, blend_vox, max_steps, influences=4):
    """bones: list of (name, head, tail). Returns (names, W (nverts x nbones))."""
    I = nearest_solid_index(g, solid, g.idx(V))
    D = np.zeros((len(V), len(bones)), np.float32)
    for bi, bone in enumerate(bones):
        name, a, b = bone[0], bone[1], bone[2]
        zmax = bone[3] if len(bone) > 3 else None
        dist = geodesic(solid, segment_seeds(g, solid, np.asarray(a), np.asarray(b), zmax), max_steps)
        D[:, bi] = dist[I[:, 0], I[:, 1], I[:, 2]]
    dmin = D.min(1, keepdims=True)
    bw = np.array([blend_vox * (b[4] if len(b) > 4 and b[4] else 1.0) for b in bones], np.float32)[None, :]
    W = np.exp(-((D - dmin) / bw) ** 2)
    W[D >= 29999] = 0
    # keep the strongest influences only
    if W.shape[1] > influences:
        thr = -np.sort(-W, axis=1)[:, influences - 1:influences]
        W[W < thr] = 0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    return [b[0] for b in bones], W
