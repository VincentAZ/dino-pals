// Foliage from the real leaves of a Poly Haven tree/bush: every modelled leaf
// (a curved 20-30 triangle mesh) becomes one flat textured quad fitted to it
// (least-squares affine map UV -> position), a subset of those quads is kept
// (outer leaves preferred, they make the silhouette) and enlarged to keep the
// crown's coverage. Normals are bent towards the crown ellipsoid's outward
// direction and a crown ambient-occlusion term is baked into COLOR_0, so the
// crown shades as a volume, not as a pile of flat cards.

/** Union-find connected components of a primitive's triangles. */
function components(idx, nv) {
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); if (b !== a) parent[b] = a; if (c !== a) parent[find(c)] = a; }
  const comps = new Map();
  for (let t = 0; t < idx.length; t += 3) { const r = find(idx[t]); let c = comps.get(r); if (!c) { c = []; comps.set(r, c); } c.push(t); }
  return [...comps.values()];
}

/** Extract one quad per leaf. Returns [{c, corners[4], uv[4], n}] */
export function extractLeaves(prim) {
  const idx = prim.getIndices().getArray(); const pos = prim.getAttribute('POSITION').getArray();
  const uvA = prim.getAttribute('TEXCOORD_0'); if (!uvA) return [];
  const uv = uvA.getArray(); const norA = prim.getAttribute('NORMAL'); const nor = norA ? norA.getArray() : null;
  const out = [];
  for (const tris of components(idx, pos.length / 3)) {
    const vs = new Set(); for (const t of tris) { vs.add(idx[t]); vs.add(idx[t + 1]); vs.add(idx[t + 2]); }
    let mu = 0, mv = 0; const mp = [0, 0, 0]; let umin = 9, umax = -9, vmin = 9, vmax = -9; const mn = [0, 0, 0];
    for (const v of vs) {
      const u = uv[v * 2], w = uv[v * 2 + 1]; mu += u; mv += w; for (let k = 0; k < 3; k++) mp[k] += pos[v * 3 + k];
      if (nor) for (let k = 0; k < 3; k++) mn[k] += nor[v * 3 + k];
      umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, w); vmax = Math.max(vmax, w);
    }
    const n = vs.size; mu /= n; mv /= n; for (let k = 0; k < 3; k++) mp[k] /= n;
    let suu = 0, suv = 0, svv = 0; const sup = [0, 0, 0], svp = [0, 0, 0];
    for (const v of vs) {
      const du = uv[v * 2] - mu, dv = uv[v * 2 + 1] - mv;
      suu += du * du; suv += du * dv; svv += dv * dv;
      for (let k = 0; k < 3; k++) { const dp = pos[v * 3 + k] - mp[k]; sup[k] += du * dp; svp[k] += dv * dp; }
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-14 || umax - umin < 1e-4 || vmax - vmin < 1e-4) continue;
    const A = [0, 0, 0], B = [0, 0, 0];
    for (let k = 0; k < 3; k++) { A[k] = (svv * sup[k] - suv * svp[k]) / det; B[k] = (suu * svp[k] - suv * sup[k]) / det; }
    const P = (u, w) => [mp[0] + A[0] * (u - mu) + B[0] * (w - mv), mp[1] + A[1] * (u - mu) + B[1] * (w - mv), mp[2] + A[2] * (u - mu) + B[2] * (w - mv)];
    const corners = [P(umin, vmin), P(umax, vmin), P(umax, vmax), P(umin, vmax)];
    const c = [0, 0, 0]; for (const q of corners) for (let k = 0; k < 3; k++) c[k] += q[k] / 4;
    let nn = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
    const l = Math.hypot(...nn) || 1; nn = nn.map((x) => x / l);
    if (nor && nn[0] * mn[0] + nn[1] * mn[1] + nn[2] * mn[2] < 0) nn = nn.map((x) => -x);
    // reject degenerate fits (a leaf blown up to a huge quad)
    const ext = Math.max(Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]), Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1], corners[3][2] - corners[0][2]));
    out.push({ c, corners, uv: [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]], n: nn, ext, tris: tris.length });
  }
  // drop fits far larger than the typical leaf (merged / odd components)
  const exts = out.map((o) => o.ext).sort((a, b) => a - b); const med = exts[Math.floor(exts.length / 2)] || 1;
  return out.filter((o) => o.ext < med * 4);
}

/** Crown ellipsoid from leaf centres (robust: 2nd..98th percentile per axis). */
export function crownOf(leaves) {
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  const c = [0, 0, 0], r = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    const a = leaves.map((l) => l.c[k]).sort((x, y) => x - y);
    const lo = q(a, 0.02), hi = q(a, 0.98); c[k] = (lo + hi) / 2; r[k] = Math.max(0.05, (hi - lo) / 2);
  }
  const ys = leaves.map((l) => l.c[1]).sort((x, y) => x - y);
  return { c, r, ymin: q(ys, 0.01), ymax: q(ys, 0.99) };
}

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Weighted subset (outer leaves preferred) of `count` leaves. */
export function pickLeaves(leaves, crown, count, rnd, outerBias = 1.0) {
  if (count >= leaves.length) return leaves.slice();
  const keyed = leaves.map((l) => {
    const e = Math.hypot((l.c[0] - crown.c[0]) / crown.r[0], (l.c[1] - crown.c[1]) / crown.r[1], (l.c[2] - crown.c[2]) / crown.r[2]);
    const w = 0.2 + Math.pow(Math.min(1.3, e), 2) * outerBias;
    return { l, k: Math.pow(rnd(), 1 / w) };
  });
  keyed.sort((a, b) => b.k - a.k);
  return keyed.slice(0, count).map((x) => x.l);
}

/** Rewrite `prim` as quads for the chosen leaves, enlarged by `scale`. */
export function writeLeafQuads(doc, prim, chosen, crown, scale, opts = {}) {
  const bend = opts.bend ?? 0.65, aoMin = opts.aoMin ?? 0.38;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let v = 0;
  for (const l of chosen) {
    const rel = [(l.c[0] - crown.c[0]) / crown.r[0], (l.c[1] - crown.c[1]) / crown.r[1], (l.c[2] - crown.c[2]) / crown.r[2]];
    const e = Math.hypot(...rel);
    let g = [rel[0] / crown.r[0], rel[1] / crown.r[1] + 0.25 / crown.r[1], rel[2] / crown.r[2]];
    const gl = Math.hypot(...g) || 1; g = g.map((x) => x / gl);
    let ln = l.n; if (ln[0] * g[0] + ln[1] * g[1] + ln[2] * g[2] < 0) ln = ln.map((x) => -x);
    let n = [ln[0] * (1 - bend) + g[0] * bend, ln[1] * (1 - bend) + g[1] * bend, ln[2] * (1 - bend) + g[2] * bend];
    const nl = Math.hypot(...n) || 1; n = n.map((x) => x / nl);
    const hy = (l.c[1] - crown.ymin) / Math.max(0.01, crown.ymax - crown.ymin);
    const ao = Math.min(1, (aoMin + (1 - aoMin) * ss(0.15, 1.0, e)) * (0.72 + 0.28 * ss(0.0, 0.85, hy)));
    for (let k = 0; k < 4; k++) {
      const q = l.corners[k];
      pos.push(l.c[0] + (q[0] - l.c[0]) * scale, l.c[1] + (q[1] - l.c[1]) * scale, l.c[2] + (q[2] - l.c[2]) * scale);
      nor.push(n[0], n[1], n[2]); uv.push(l.uv[k][0], l.uv[k][1]); col.push(ao, ao, ao);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const mk = (arr, type) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  for (const sem of prim.listSemantics()) { const old = prim.getAttribute(sem); prim.setAttribute(sem, null); if (old && !old.listParents().some((p) => p !== doc.getRoot())) old.dispose(); }
  const oldIdx = prim.getIndices(); prim.setIndices(mk(v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 'SCALAR'));
  if (oldIdx && !oldIdx.listParents().some((p) => p !== doc.getRoot())) oldIdx.dispose();
  prim.setAttribute('POSITION', mk(new Float32Array(pos), 'VEC3')).setAttribute('NORMAL', mk(new Float32Array(nor), 'VEC3'))
    .setAttribute('TEXCOORD_0', mk(new Float32Array(uv), 'VEC2')).setAttribute('COLOR_0', mk(new Float32Array(col), 'VEC3'));
  return chosen.length;
}

/** Keep only the larger branch components (limbs), up to `maxTris` source triangles. */
export function keepLimbs(prim, maxTris) {
  const idx = prim.getIndices().getArray(); const pos = prim.getAttribute('POSITION').getArray();
  if (idx.length / 3 <= maxTris) return idx.length / 3;
  const comps = components(idx, pos.length / 3).map((tris) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const t of tris) for (let k = 0; k < 3; k++) { const v = idx[t + k]; x0 = Math.min(x0, pos[v * 3]); x1 = Math.max(x1, pos[v * 3]); y0 = Math.min(y0, pos[v * 3 + 1]); y1 = Math.max(y1, pos[v * 3 + 1]); z0 = Math.min(z0, pos[v * 3 + 2]); z1 = Math.max(z1, pos[v * 3 + 2]); }
    return { tris, size: Math.hypot(x1 - x0, y1 - y0, z1 - z0) };
  }).sort((a, b) => b.size - a.size);
  const out = []; let n = 0;
  for (const c of comps) { if (n + c.tris.length > maxTris && n > 0) continue; for (const t of c.tris) out.push(idx[t], idx[t + 1], idx[t + 2]); n += c.tris.length; }
  const acc = prim.getIndices(); acc.setArray(pos.length / 3 > 65535 ? new Uint32Array(out) : new Uint16Array(out));
  return n;
}
