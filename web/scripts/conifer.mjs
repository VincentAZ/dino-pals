// Conifers from Poly Haven's fully modelled trees (every needle is geometry:
// ~0.8 M needles per fir, ~0.5 M per pine). The needles are clustered into
// the sprays / tufts they form on the real branches (weighted k-means), each
// cluster becomes a card in its own best-fit plane (pines: a crossed pair
// along the twig axis), and the cards are textured from a sprite atlas that is
// rendered from real needle clusters of the same tree with a small software
// rasterizer: albedo with in-spray occlusion, alpha coverage and a tangent-space
// normal map of the individual needles. Crown lighting comes from a needle
// density grid: every card / bark vertex gets sky occlusion (COLOR_0) and a
// bent normal (the mean unoccluded direction), so the crown shades as a volume
// and the inside of the tree is dark. Trunk and limbs are the real bark meshes,
// simplified. LOD1 uses coarser clusters with their own (denser) sprites.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Document, getBounds } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Raster, sampler } from './raster.mjs';

const lin = (c) => Math.pow(c, 2.2);
const srgb8 = (c) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, c), 1 / 2.2) * 255)));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- geometry input
/** Primitive -> plain arrays in tree space (node translation and `origin` removed, UV transform baked). */
function readPrim(prim, nodeT, origin) {
  const posA = prim.getAttribute('POSITION').getArray(); const n = posA.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = posA[i * 3 + k] + nodeT[k] - origin[k];
  const norA = prim.getAttribute('NORMAL')?.getArray();
  const nor = norA ? Float32Array.from(norA) : null;
  const uvAcc = prim.getAttribute('TEXCOORD_0');
  let uv = null;
  if (uvAcc) {
    uv = Float32Array.from(uvAcc.getArray());
    const tr = prim.getMaterial()?.getBaseColorTextureInfo()?.getExtension('KHR_texture_transform');
    if (tr) { const o = tr.getOffset(), s = tr.getScale(); for (let i = 0; i < n; i++) { uv[i * 2] = uv[i * 2] * s[0] + o[0]; uv[i * 2 + 1] = uv[i * 2 + 1] * s[1] + o[1]; } }
  }
  const idx = Uint32Array.from(prim.getIndices().getArray());
  return { pos, nor, uv, idx, mat: prim.getMaterial() };
}

/** Connected components of a triangle list: { compOfTri, start, order, count }. */
function components(idx, nv) {
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); if (b !== a) parent[b] = a; const r = find(a); if (c !== r) parent[find(c)] = r; }
  const nt = idx.length / 3; const id = new Int32Array(nv).fill(-1); const compOfTri = new Int32Array(nt); let count = 0;
  for (let t = 0; t < nt; t++) { const r = find(idx[t * 3]); if (id[r] < 0) id[r] = count++; compOfTri[t] = id[r]; }
  const start = new Int32Array(count + 1); for (let t = 0; t < nt; t++) start[compOfTri[t] + 1]++;
  for (let c = 0; c < count; c++) start[c + 1] += start[c];
  const fill = start.slice(0, count); const order = new Int32Array(nt);
  for (let t = 0; t < nt; t++) order[fill[compOfTri[t]]++] = t;
  return { compOfTri, start, order, count };
}

/** Twig geometry -> clustering elements: whole needles, and single triangles of twig wood. */
function twigElements(tw) {
  const { pos, idx } = tw; const nv = pos.length / 3;
  const cc = components(idx, nv);
  const ex = [], ey = [], ez = [], ew = [], tStart = [], tCount = [], tris = [];
  let needles = 0;
  for (let c = 0; c < cc.count; c++) {
    const s = cc.start[c], e = cc.start[c + 1];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9, mx = 0, my = 0, mz = 0;
    for (let k = s; k < e; k++) { const t = cc.order[k]; for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]; mx += x; my += y; mz += z; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; } }
    const n3 = (e - s) * 3; const ext = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (ext < 0.24) { // a needle (4-200 triangles depending on the model)
      ex.push(mx / n3); ey.push(my / n3); ez.push(mz / n3); ew.push(1); tStart.push(tris.length); tCount.push(e - s);
      for (let k = s; k < e; k++) tris.push(cc.order[k]);
      needles++;
    } else {
      // twig wood: every triangle is its own element, so it joins the spray around it
      for (let k = s; k < e; k++) {
        const t = cc.order[k]; let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; }
        ex.push(cx / 3); ey.push(cy / 3); ez.push(cz / 3); ew.push(0.2); tStart.push(tris.length); tCount.push(1); tris.push(t);
      }
    }
  }
  return { x: Float32Array.from(ex), y: Float32Array.from(ey), z: Float32Array.from(ez), w: Float32Array.from(ew), tStart: Int32Array.from(tStart), tCount: Int32Array.from(tCount), tris: Int32Array.from(tris), n: ex.length, needles };
}

// ---------------------------------------------------------------- clustering
const vkey = (gx, gy, gz) => ((gx + 1024) * 2048 + (gy + 1024)) * 2048 + (gz + 1024);
function voxelSeeds(E, cell, minW) {
  const m = new Map();
  for (let i = 0; i < E.n; i++) {
    const k = vkey(Math.floor(E.x[i] / cell), Math.floor(E.y[i] / cell), Math.floor(E.z[i] / cell));
    let s = m.get(k); if (!s) { s = [0, 0, 0, 0]; m.set(k, s); }
    const w = E.w[i]; s[0] += E.x[i] * w; s[1] += E.y[i] * w; s[2] += E.z[i] * w; s[3] += w;
  }
  const out = []; for (const s of m.values()) if (s[3] >= minW) out.push([s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
  return out;
}

/** Weighted k-means of the elements seeded on a voxel grid (cell grows until <= maxK clusters). */
function cluster(E, cell, maxK, minW) {
  let seeds = voxelSeeds(E, cell, minW);
  for (let it = 0; it < 40 && seeds.length > maxK; it++) { cell *= 1.06; seeds = voxelSeeds(E, cell, minW); }
  let C = seeds; const assign = new Int32Array(E.n);
  // elements grouped by voxel: candidate centres are looked up once per voxel
  const vox = new Map();
  for (let i = 0; i < E.n; i++) {
    const gx = Math.floor(E.x[i] / cell), gy = Math.floor(E.y[i] / cell), gz = Math.floor(E.z[i] / cell);
    const k = vkey(gx, gy, gz); let v = vox.get(k); if (!v) { v = { gx, gy, gz, el: [] }; vox.set(k, v); } v.el.push(i);
  }
  for (let iter = 0; iter < 6; iter++) {
    const grid = new Map();
    C.forEach((c, i) => { const k = vkey(Math.floor(c[0] / cell), Math.floor(c[1] / cell), Math.floor(c[2] / cell)); let l = grid.get(k); if (!l) { l = []; grid.set(k, l); } l.push(i); });
    for (const v of vox.values()) {
      let cand = [];
      for (let r = 1; r <= 4 && !cand.length; r++) {
        for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) { const l = grid.get(vkey(v.gx + a, v.gy + b, v.gz + c)); if (l) cand.push(...l); }
      }
      if (!cand.length) cand = C.map((_, j) => j);
      for (const i of v.el) {
        let best = -1, bd = Infinity;
        for (const j of cand) { const d = (C[j][0] - E.x[i]) ** 2 + (C[j][1] - E.y[i]) ** 2 + (C[j][2] - E.z[i]) ** 2; if (d < bd) { bd = d; best = j; } }
        assign[i] = best;
      }
    }
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < E.n; i++) { const a = acc[assign[i]]; const w = E.w[i]; a[0] += E.x[i] * w; a[1] += E.y[i] * w; a[2] += E.z[i] * w; a[3] += w; }
    // clusters that lost (almost) everything disappear; their elements move on the next pass
    const keep = []; const remap = new Int32Array(C.length).fill(-1);
    acc.forEach((a, j) => { if (a[3] >= minW * 0.5) { remap[j] = keep.length; keep.push([a[0] / a[3], a[1] / a[3], a[2] / a[3]]); } });
    if (iter === 5) { // final: hand orphans to the nearest kept centre
      for (let i = 0; i < E.n; i++) {
        let r = remap[assign[i]];
        if (r < 0) { let bd = Infinity; keep.forEach((c, j) => { const d = (c[0] - E.x[i]) ** 2 + (c[1] - E.y[i]) ** 2 + (c[2] - E.z[i]) ** 2; if (d < bd) { bd = d; r = j; } }); }
        assign[i] = r;
      }
    }
    C = keep;
  }
  const members = C.map(() => []);
  for (let i = 0; i < E.n; i++) members[assign[i]].push(i);
  return { centers: C, members, cell };
}

// ---------------------------------------------------------------- PCA
function eig3(a) { // symmetric 3x3 Jacobi; returns {vals, vecs (columns)}
  const A = [[a[0], a[1], a[2]], [a[1], a[3], a[4]], [a[2], a[4], a[5]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]); if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const vals = [A[0][0], A[1][1], A[2][2]];
  const ord = [0, 1, 2].sort((i, j) => vals[j] - vals[i]);
  return { vals: ord.map((i) => vals[i]), vecs: ord.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Frame + extents of a cluster from its triangles' vertices. e1 points away from the trunk (spray tip), n up / outward. */
function frameOf(tw, E, mem) {
  const { pos, idx } = tw; let n = 0; const m = [0, 0, 0];
  for (const i of mem) for (let k = 0; k < E.tCount[i]; k++) { const t = E.tris[E.tStart[i] + k]; for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; m[0] += pos[v * 3]; m[1] += pos[v * 3 + 1]; m[2] += pos[v * 3 + 2]; n++; } }
  m[0] /= n; m[1] /= n; m[2] /= n;
  const c = [0, 0, 0, 0, 0, 0];
  for (const i of mem) for (let k = 0; k < E.tCount[i]; k++) { const t = E.tris[E.tStart[i] + k]; for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; const dx = pos[v * 3] - m[0], dy = pos[v * 3 + 1] - m[1], dz = pos[v * 3 + 2] - m[2]; c[0] += dx * dx; c[1] += dx * dy; c[2] += dx * dz; c[3] += dy * dy; c[4] += dy * dz; c[5] += dz * dz; } }
  const { vals, vecs } = eig3(c.map((v) => v / n));
  let e1 = vecs[0], nn = vecs[2];
  const radial = norm([m[0], 0, m[2]]);
  if (dot(e1, radial) < 0 || (Math.abs(dot(e1, radial)) < 0.2 && e1[1] < 0)) e1 = e1.map((v) => -v);
  if (nn[1] < 0 || (Math.abs(nn[1]) < 0.25 && dot(nn, radial) < 0)) nn = nn.map((v) => -v);
  const e2 = norm(cross(nn, e1));
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9, w0 = 1e9, w1 = -1e9;
  for (const i of mem) for (let k = 0; k < E.tCount[i]; k++) { const t = E.tris[E.tStart[i] + k]; for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; const d = [pos[v * 3] - m[0], pos[v * 3 + 1] - m[1], pos[v * 3 + 2] - m[2]]; const a = dot(d, e1), b = dot(d, e2), w = dot(d, nn); if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < v0) v0 = b; if (b > v1) v1 = b; if (w < w0) w0 = w; if (w > w1) w1 = w; } }
  let weight = 0, needles = 0; for (const i of mem) { weight += E.w[i]; if (E.w[i] >= 1) needles++; }
  return { c: m, e1, e2, n: nn, u0, u1, v0, v1, w0, w1, vals, weight, needles, mem };
}

// ---------------------------------------------------------------- sprite bake
/**
 * Renders a cluster's needles looking along -axes.z into a sprite: linear albedo
 * (with in-spray occlusion), alpha coverage, tangent-space normal (x = +u, y = image up).
 */
function bakeSprite(tw, E, f, view, density, tex, opt) {
  const SS = 3;
  const ax = view.x, ay = view.y, az = view.z; // sprite x (right), y (up), z (towards viewer)
  const [a0, a1] = view.ur, [b0, b1] = view.vr;
  const W = Math.max(4, Math.round((a1 - a0) * density)), H = Math.max(4, Math.round((b1 - b0) * density));
  const R = new Raster(W * SS, H * SS, 7);
  const { pos, nor, uv, idx } = tw; const c = f.c;
  const sx = (W * SS) / (a1 - a0), sy = (H * SS) / (b1 - b0);
  const t4 = [0, 0, 0, 0], t1 = [0], out = new Float32Array(7);
  for (const i of f.mem) for (let k = 0; k < E.tCount[i]; k++) {
    const t = E.tris[E.tStart[i] + k]; const vi = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const P = vi.map((v) => { const d = [pos[v * 3] - c[0], pos[v * 3 + 1] - c[1], pos[v * 3 + 2] - c[2]]; return [(dot(d, ax) - a0) * sx, (b1 - dot(d, ay)) * sy, dot(d, az)]; });
    R.tri(P[0][0], P[0][1], P[0][2], P[1][0], P[1][1], P[1][2], P[2][0], P[2][1], P[2][2], (w0, w1, w2, o) => {
      const u = uv[vi[0] * 2] * w0 + uv[vi[1] * 2] * w1 + uv[vi[2] * 2] * w2;
      const v = uv[vi[0] * 2 + 1] * w0 + uv[vi[1] * 2 + 1] * w1 + uv[vi[2] * 2 + 1] * w2;
      if (tex.alpha) { tex.alpha(u, v, t1); if (t1[0] < 0.5) return false; }
      tex.diff(u, v, t4);
      let nx = nor[vi[0] * 3] * w0 + nor[vi[1] * 3] * w1 + nor[vi[2] * 3] * w2;
      let ny = nor[vi[0] * 3 + 1] * w0 + nor[vi[1] * 3 + 1] * w1 + nor[vi[2] * 3 + 1] * w2;
      let nz = nor[vi[0] * 3 + 2] * w0 + nor[vi[1] * 3 + 2] * w1 + nor[vi[2] * 3 + 2] * w2;
      const N = [nx, ny, nz]; let lx = dot(N, ax), ly = dot(N, ay), lz = dot(N, az);
      if (lz < 0) { lx = -lx; ly = -ly; lz = -lz; }
      const l = Math.hypot(lx, ly, lz) || 1;
      const g = opt.grade; let r = lin(t4[0]), gg = lin(t4[1]), bb = lin(t4[2]);
      if (g) { const y = 0.2126 * r + 0.7152 * gg + 0.0722 * bb; r = (y + (r - y) * g.sat) * g.mul[0]; gg = (y + (gg - y) * g.sat) * g.mul[1]; bb = (y + (bb - y) * g.sat) * g.mul[2]; }
      o[0] = Math.max(0, r); o[1] = Math.max(0, gg); o[2] = Math.max(0, bb); o[3] = lx / l; o[4] = ly / l; o[5] = lz / l; o[6] = P[0][2] * w0 + P[1][2] * w1 + P[2][2] * w2;
    }, out);
  }
  // downsample
  const alb = new Float32Array(W * H * 3), cov = new Float32Array(W * H), nrm = new Float32Array(W * H * 3), dep = new Float32Array(W * H).fill(-1e9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0; const a = [0, 0, 0], nn = [0, 0, 0]; let d = -1e9;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const p = (y * SS + j) * W * SS + x * SS + i; if (!R.cov[p]) continue; n++;
      const o = p * 7; a[0] += R.buf[o]; a[1] += R.buf[o + 1]; a[2] += R.buf[o + 2]; nn[0] += R.buf[o + 3]; nn[1] += R.buf[o + 4]; nn[2] += R.buf[o + 5]; d = Math.max(d, R.buf[o + 6]);
    }
    const q = y * W + x; cov[q] = n / (SS * SS);
    if (n) { alb[q * 3] = a[0] / n; alb[q * 3 + 1] = a[1] / n; alb[q * 3 + 2] = a[2] / n; const nl = norm(nn); nrm[q * 3] = nl[0]; nrm[q * 3 + 1] = nl[1]; nrm[q * 3 + 2] = nl[2]; dep[q] = d; }
  }
  // in-spray occlusion: needles below the local top of the stack are darker
  const r = Math.max(2, Math.round(0.035 * density)); const top = new Float32Array(W * H).fill(-1e9);
  const tmp = new Float32Array(W * H).fill(-1e9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = -1e9; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) m = Math.max(m, dep[y * W + xx]); } tmp[y * W + x] = m; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = -1e9; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) m = Math.max(m, tmp[yy * W + x]); } top[y * W + x] = m; }
  const thick = opt.aoThick ?? 0.05;
  for (let q = 0; q < W * H; q++) if (cov[q] > 0) { const occ = Math.min(1, Math.max(0, (top[q] - dep[q]) / thick)); const k = 1 - (opt.aoDepth ?? 0.45) * occ; alb[q * 3] *= k; alb[q * 3 + 1] *= k; alb[q * 3 + 2] *= k; }
  return { W, H, alb, cov, nrm };
}

/**
 * Coverage-preserving alpha test (Castano 2010): per mip level, the alpha scale at which the
 * 0.5 test keeps the level-0 coverage. Thin needles would otherwise either vanish in the
 * distance or (with a generic boost) merge into solid blobs.
 */
function coverageScales(rgba, W, H, levels = 9) {
  let a = new Float32Array(W * H); for (let i = 0; i < W * H; i++) a[i] = rgba[i * 4 + 3] / 255;
  const cov = (arr, s) => { let n = 0; for (const v of arr) if (v * s >= 0.5) n++; return n; };
  const c0 = cov(a, 1) / a.length; const out = [1];
  let w = W, h = H;
  for (let l = 1; l < levels; l++) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1); const b = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) b[y * nw + x] = (a[(2 * y) * w + 2 * x] + a[(2 * y) * w + Math.min(w - 1, 2 * x + 1)] + a[Math.min(h - 1, 2 * y + 1) * w + 2 * x] + a[Math.min(h - 1, 2 * y + 1) * w + Math.min(w - 1, 2 * x + 1)]) / 4;
    a = b; w = nw; h = nh;
    let lo = 0.5, hi = 6; for (let it = 0; it < 28; it++) { const m = (lo + hi) / 2; if (cov(a, m) / a.length < c0) lo = m; else hi = m; }
    out.push(Math.max(out[out.length - 1], +((lo + hi) / 2).toFixed(3)));
  }
  return out;
}

/** Shelf-pack rects (w,h) into an atlas of size AW x AH with padding; returns positions or null. */
function shelfPack(rects, AW, AH, pad) {
  const order = rects.map((r, i) => i).sort((a, b) => rects[b].h - rects[a].h);
  const out = new Array(rects.length); let x = pad, y = pad, rowH = 0;
  for (const i of order) {
    const r = rects[i];
    if (x + r.w + pad > AW) { x = pad; y += rowH + pad; rowH = 0; }
    if (r.w + 2 * pad > AW || y + r.h + pad > AH) return null;
    out[i] = { x, y }; x += r.w + pad; rowH = Math.max(rowH, r.h);
  }
  return out;
}

// ---------------------------------------------------------------- crown light (density grid)
const DIRS = (() => { const n = 64, out = []; const ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - (i + 0.5) / n * 2; const r = Math.sqrt(1 - y * y); out.push([Math.cos(ga * i) * r, y, Math.sin(ga * i) * r]); } return out; })();

function densityGrid(E, bounds, cell) {
  const nx = Math.ceil((bounds.max[0] - bounds.min[0]) / cell) + 4, ny = Math.ceil((bounds.max[1] - bounds.min[1]) / cell) + 4, nz = Math.ceil((bounds.max[2] - bounds.min[2]) / cell) + 4;
  const ox = bounds.min[0] - 2 * cell, oy = bounds.min[1] - 2 * cell, oz = bounds.min[2] - 2 * cell;
  const g = new Float32Array(nx * ny * nz);
  for (let i = 0; i < E.n; i++) {
    const x = Math.floor((E.x[i] - ox) / cell), y = Math.floor((E.y[i] - oy) / cell), z = Math.floor((E.z[i] - oz) / cell);
    if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) g[(y * nz + z) * nx + x] += E.w[i];
  }
  return { g, nx, ny, nz, ox, oy, oz, cell };
}
function addWood(G, wood, weight) {
  for (const p of wood) for (let t = 0; t < p.idx.length; t += 3) {
    const v = p.idx[t]; const x = Math.floor((p.pos[v * 3] - G.ox) / G.cell), y = Math.floor((p.pos[v * 3 + 1] - G.oy) / G.cell), z = Math.floor((p.pos[v * 3 + 2] - G.oz) / G.cell);
    if (x >= 0 && y >= 0 && z >= 0 && x < G.nx && y < G.ny && z < G.nz) G.g[(y * G.nz + z) * G.nx + x] += weight;
  }
}
/**
 * Visibility of the sky / sun from p through the needle density, over the whole sphere:
 * L1 spherical harmonics (V(d) ~ c0 + c1.d, so the shader gets the crown's self-shadowing
 * for any sun direction) plus the bent normal (mean unoccluded direction, upper-weighted).
 */
function crownLight(G, p, sigma, skip = 0.12) {
  let c0 = 0; const c1 = [0, 0, 0], b = [0, 0, 0];
  const step = G.cell * 0.8;
  for (const d of DIRS) {
    let tau = 0;
    for (let s = skip; s < 7; s += step) {
      const x = Math.floor((p[0] + d[0] * s - G.ox) / G.cell), y = Math.floor((p[1] + d[1] * s - G.oy) / G.cell), z = Math.floor((p[2] + d[2] * s - G.oz) / G.cell);
      if (x < 0 || y < 0 || z < 0 || x >= G.nx || y >= G.ny || z >= G.nz) break;
      tau += G.g[(y * G.nz + z) * G.nx + x] * sigma * step;
      if (tau > 6) break;
    }
    const T = Math.exp(-tau);
    c0 += T; for (let k = 0; k < 3; k++) c1[k] += T * d[k];
    const w = Math.max(0, 0.3 + 0.7 * d[1]); for (let k = 0; k < 3; k++) b[k] += d[k] * T * w;
  }
  const n = DIRS.length; c0 /= n; for (let k = 0; k < 3; k++) c1[k] *= 3 / n;
  return { c0, c1, sky: Math.min(1, Math.max(0, c0 + (2 / 3) * c1[1])), bent: norm(b) };
}
/** COLOR_0 for the shader's crown light: r = c0, gba = c1 * 0.5 + 0.5 (see vegetation.ts CROWN_LIGHT). */
const shColour = (L) => [L.c0, Math.min(1, Math.max(0, L.c1[0] * 0.5 + 0.5)), Math.min(1, Math.max(0, L.c1[1] * 0.5 + 0.5)), Math.min(1, Math.max(0, L.c1[2] * 0.5 + 0.5))];

// ---------------------------------------------------------------- wood
function simplifyWood(p, targetTris, minCompExt = 0) {
  let idx = p.idx;
  if (minCompExt > 0) { // drop thin twiglets entirely (they are in the needle sprites)
    const cc = components(idx, p.pos.length / 3); const keep = [];
    for (let c = 0; c < cc.count; c++) {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let k = cc.start[c]; k < cc.start[c + 1]; k++) { const t = cc.order[k]; for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j]; x0 = Math.min(x0, p.pos[v * 3]); x1 = Math.max(x1, p.pos[v * 3]); y0 = Math.min(y0, p.pos[v * 3 + 1]); y1 = Math.max(y1, p.pos[v * 3 + 1]); z0 = Math.min(z0, p.pos[v * 3 + 2]); z1 = Math.max(z1, p.pos[v * 3 + 2]); } }
      if (Math.hypot(x1 - x0, y1 - y0, z1 - z0) >= minCompExt) for (let k = cc.start[c]; k < cc.start[c + 1]; k++) { const t = cc.order[k]; keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]); }
    }
    idx = Uint32Array.from(keep);
  }
  if (idx.length / 3 > targetTris) {
    for (const err of [0.01, 0.03, 0.08, 0.2]) {
      const [r] = MeshoptSimplifier.simplify(idx, p.pos, 3, Math.floor(targetTris) * 3, err, []);
      idx = Uint32Array.from(r); if (idx.length / 3 <= targetTris * 1.1) break;
    }
    if (idx.length / 3 > targetTris * 1.1) { const [r] = MeshoptSimplifier.simplifySloppy(idx, p.pos, 3, null, Math.floor(targetTris) * 3, 0.5); idx = Uint32Array.from(r); }
  }
  return compact({ ...p, idx });
}
/** Drop unreferenced vertices. */
function compact(p) {
  const nv = p.pos.length / 3; const map = new Int32Array(nv).fill(-1); let n = 0;
  for (const v of p.idx) if (map[v] < 0) map[v] = n++;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let v = 0; v < nv; v++) { const m = map[v]; if (m < 0) continue; for (let k = 0; k < 3; k++) { pos[m * 3 + k] = p.pos[v * 3 + k]; nor[m * 3 + k] = p.nor ? p.nor[v * 3 + k] : 0; } if (p.uv) { uv[m * 2] = p.uv[v * 2]; uv[m * 2 + 1] = p.uv[v * 2 + 1]; } }
  return { ...p, pos, nor, uv, idx: Uint32Array.from(p.idx, (v) => map[v]) };
}
/** Cylindrical UVs for a trunk shipped without any (fir_tree_01 variant c). */
function trunkUV(p, around = 5, vScale = 6.2) {
  const nt = p.idx.length / 3; const pos = new Float32Array(nt * 9), nor = new Float32Array(nt * 9), uv = new Float32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    const us = [];
    for (let j = 0; j < 3; j++) { const v = p.idx[t * 3 + j]; for (let k = 0; k < 3; k++) { pos[(t * 3 + j) * 3 + k] = p.pos[v * 3 + k]; nor[(t * 3 + j) * 3 + k] = p.nor[v * 3 + k]; } us.push((Math.atan2(p.pos[v * 3 + 2], p.pos[v * 3]) / (2 * Math.PI) + 0.5) * around); uv[(t * 3 + j) * 2 + 1] = p.pos[v * 3 + 1] / vScale; }
    const mx = Math.max(...us); for (let j = 0; j < 3; j++) { if (mx - us[j] > around / 2) us[j] += around; uv[(t * 3 + j) * 2] = us[j]; }
  }
  return { ...p, pos, nor, uv, idx: Uint32Array.from({ length: nt * 3 }, (_, i) => i) };
}

// ---------------------------------------------------------------- main
/** Twig textures, variants (tallest first, cfg.skip dropped), needle elements and LOD clusters of a source model. */
async function prepareModel(src, dir, cfg) {
  const name = cfg.name;
  const root = src.getRoot(); const scene = root.listScenes()[0];
  // textures of the twig material
  const twigMat = root.listMaterials().find((m) => /twig/.test(m.getName()));
  const diffImg = await sharp(Buffer.from(twigMat.getBaseColorTexture().getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const tex = { diff: sampler(diffImg.data, diffImg.info.width, diffImg.info.height, 4), alpha: null };
  if (twigMat.getAlphaMode() !== 'OPAQUE') {
    const alphaFile = (await fs.readdir(path.join(dir, 'textures'))).find((f) => /twigs?_alpha_1k\.(jpg|png)$/.test(f));
    const a = await sharp(path.join(dir, 'textures', alphaFile)).greyscale().raw().toBuffer({ resolveWithObject: true });
    tex.alpha = sampler(a.data, a.info.width, a.info.height, 1);
  }
  const nodes = scene.listChildren().filter((n) => !(cfg.skip ?? []).includes(n.getName())).map((n) => ({ n, b: getBounds(n) }))
    .sort((x, y) => (y.b.max[1] - y.b.min[1]) - (x.b.max[1] - x.b.min[1])).slice(0, 3);
  const variants = [];
  for (const { n: node, b } of nodes) {
    const T = node.getTranslation();
    const prims = node.getMesh().listPrimitives();
    // origin: trunk base centre (so the trunk stands on the instance position), lowest point
    let bx = 0, bz = 0, bn = 0;
    const woodRx = prims.some((p) => /trunk|bark/.test(p.getMaterial().getName())) ? /trunk|bark/ : /branch/;
    for (const p of prims) {
      if (!woodRx.test(p.getMaterial().getName()) || /dead/.test(p.getMaterial().getName())) continue;
      const a = p.getAttribute('POSITION').getArray();
      for (let i = 0; i < a.length; i += 3) if (a[i + 1] < b.min[1] + 0.3) { bx += a[i] + T[0]; bz += a[i + 2] + T[2]; bn++; }
    }
    const origin = [bx / bn, b.min[1], bz / bn];
    const twigP = prims.find((p) => /twig/.test(p.getMaterial().getName()));
    const tw = readPrim(twigP, T, origin);
    const E = twigElements(tw);
    const wood = prims.filter((p) => p !== twigP).map((p) => readPrim(p, T, origin));
    const bounds = { min: [b.min[0] - origin[0], 0, b.min[2] - origin[2]], max: [b.max[0] - origin[0], b.max[1] - origin[1], b.max[2] - origin[2]] };
    variants.push({ name: node.getName(), tw, E, wood, bounds });
    console.log(`${name} ${node.getName()}: ${E.needles} needles, ${E.n} elements, wood ${wood.map((w) => `${w.mat.getName().replace(name + '_', '')}:${w.idx.length / 3}`).join(' ')}`);
  }
  // clusters per LOD
  for (const va of variants) {
    const scaleK = Math.sqrt(va.E.needles / Math.max(...variants.map((v) => v.E.needles)));
    for (const [lod, cell, maxK] of [[0, cfg.cell0, cfg.max0], [1, cfg.cell1, cfg.max1]]) {
      const cl = cluster(va.E, cell, Math.max(40, Math.round(maxK * scaleK)), cfg.minW ?? 6);
      va[`f${lod}`] = cl.members.filter((m) => m.length).map((m) => frameOf(va.tw, va.E, m)).filter((f) => f.weight >= (cfg.minW ?? 6) * 0.5);
      console.log(`  ${va.name} LOD${lod}: ${va[`f${lod}`].length} clusters (cell ${cl.cell.toFixed(2)} m)`);
    }
  }
  return { variants, tex, cfg };
}

/** Card views of a cluster: its own plane, plus (pine tufts) the plane along the twig through its normal. */
const viewsOf = (mode, f) => {
  const out = [{ kind: 'front', x: f.e1, y: f.e2, z: f.n, ur: [f.u0, f.u1], vr: [f.v0, f.v1] }];
  if (mode === 'cross') out.push({ kind: 'side', x: f.e1, y: f.n, z: f.e2.map((v) => -v), ur: [f.u0, f.u1], vr: [f.w0, f.w1] });
  return out;
};

/** Sprite atlas from real clusters of typical size (every variant). Deterministic for a given model + cfg. */
async function bakeAtlas(model, cfg) {
  const { variants, tex } = model; const name = cfg.name; const rnd = mulberry(cfg.seed ?? 4242);
  const sprites = [];
  for (const lod of [0, 1]) {
    const all = variants.flatMap((va) => va[`f${lod}`].map((f) => ({ f, va })));
    const ws = all.map((x) => x.f.weight).sort((a, b) => a - b);
    const [qlo, qhi] = cfg.spriteQuantiles ?? [0.45, 0.92]; const lo = ws[Math.floor(ws.length * qlo)], hi = ws[Math.min(ws.length - 1, Math.floor(ws.length * qhi))];
    const ratios = all.map((x) => x.f.needles / x.f.weight).sort((a, b) => a - b); const rq = ratios[Math.floor(ratios.length * 0.4)]; // needle-rich sprays, not bare twigs
    const cand = all.filter((x) => x.f.weight >= lo && x.f.weight <= hi && x.f.needles / x.f.weight >= rq && x.f.c[1] > x.va.bounds.max[1] * 0.25);
    // spread over aspect ratios: sort by aspect and take evenly spaced picks
    cand.sort((a, b) => Math.log((a.f.u1 - a.f.u0) / (a.f.v1 - a.f.v0)) - Math.log((b.f.u1 - b.f.u0) / (b.f.v1 - b.f.v0)));
    const K = lod === 0 ? cfg.sprites0 : cfg.sprites1;
    for (let k = 0; k < K; k++) { const x = cand[Math.min(cand.length - 1, Math.floor((k + 0.5 + (rnd() - 0.5) * 0.6) / K * cand.length))]; sprites.push({ lod, ...x }); }
  }
  // fit the densities into the atlas
  const [AW, AH] = cfg.atlas; let d0 = cfg.density0, d1 = cfg.density1; let packed = null; let rects;
  for (let it = 0; it < 60; it++) {
    rects = []; for (const s of sprites) for (const v of viewsOf(cfg.mode, s.f)) { const d = s.lod === 0 ? d0 : d1; rects.push({ w: Math.max(4, Math.round((v.ur[1] - v.ur[0]) * d)), h: Math.max(4, Math.round((v.vr[1] - v.vr[0]) * d)) }); }
    packed = shelfPack(rects, AW, AH, 6); if (packed) break; d0 *= 0.95; d1 *= 0.95;
  }
  if (!packed) throw new Error(`${name}: atlas packing failed`);
  console.log(`  ${name} atlas ${AW}x${AH}: ${rects.length} sprites at ${d0.toFixed(0)} / ${d1.toFixed(0)} px/m`);
  const albA = new Float32Array(AW * AH * 3), alphaA = new Float32Array(AW * AH), nrmA = new Float32Array(AW * AH * 3);
  let ri = 0;
  for (const s of sprites) {
    s.rects = [];
    for (const v of viewsOf(cfg.mode, s.f)) {
      const sp = bakeSprite(s.va.tw, s.va.E, s.f, v, s.lod === 0 ? d0 : d1, tex, cfg);
      const at = packed[ri++]; const W = Math.min(sp.W, rects[ri - 1].w), H = Math.min(sp.H, rects[ri - 1].h);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const q = y * sp.W + x, o = (at.y + y) * AW + at.x + x;
        alphaA[o] = sp.cov[q]; for (let k = 0; k < 3; k++) { albA[o * 3 + k] = sp.alb[q * 3 + k]; nrmA[o * 3 + k] = sp.nrm[q * 3 + k]; }
      }
      // uv rect (half-texel inset) and the world rect it represents
      s.rects.push({ kind: v.kind, u0: (at.x + 0.5) / AW, u1: (at.x + W - 0.5) / AW, v0: (at.y + 0.5) / AH, v1: (at.y + H - 0.5) / AH, aspect: (v.ur[1] - v.ur[0]) / (v.vr[1] - v.vr[0]) });
    }
  }
  // atlas images: alpha sharpened so thin needles survive the 0.5 alpha test; colour bled into the gaps
  const rgba = new Uint8Array(AW * AH * 4), nrgba = new Uint8Array(AW * AH * 4);
  const filled = new Uint8Array(AW * AH);
  for (let i = 0; i < AW * AH; i++) {
    const a = alphaA[i];
    rgba[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, (a - (cfg.alphaLo ?? 0.12)) / (cfg.alphaSpan ?? 0.4))) * 255);
    if (a > 0) { filled[i] = 1; for (let k = 0; k < 3; k++) rgba[i * 4 + k] = srgb8(albA[i * 3 + k]); const nl = norm([nrmA[i * 3], nrmA[i * 3 + 1], nrmA[i * 3 + 2]]); nrgba[i * 4] = Math.round((nl[0] * 0.5 + 0.5) * 255); nrgba[i * 4 + 1] = Math.round((nl[1] * 0.5 + 0.5) * 255); nrgba[i * 4 + 2] = Math.round((nl[2] * 0.5 + 0.5) * 255); }
    nrgba[i * 4 + 3] = 255;
  }
  for (let pass = 0; pass < 24; pass++) { // dilate colour + normal into empty texels
    const src = Uint8Array.from(filled); let changed = 0;
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
      const i = y * AW + x; if (src[i]) continue;
      let n = 0; const c = [0, 0, 0, 0, 0, 0];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= AW || yy >= AH) continue; const j = yy * AW + xx; if (!src[j]) continue; n++; for (let k = 0; k < 3; k++) { c[k] += rgba[j * 4 + k]; c[3 + k] += nrgba[j * 4 + k]; } }
      if (!n) continue; filled[i] = 1; changed++;
      for (let k = 0; k < 3; k++) { rgba[i * 4 + k] = Math.round(c[k] / n); nrgba[i * 4 + k] = Math.round(c[3 + k] / n); }
    }
    if (!changed) break;
  }
  for (let i = 0; i < AW * AH; i++) if (!filled[i]) { rgba[i * 4] = 40; rgba[i * 4 + 1] = 52; rgba[i * 4 + 2] = 30; nrgba[i * 4] = 128; nrgba[i * 4 + 1] = 128; nrgba[i * 4 + 2] = 255; }
  const albedoPng = await sharp(Buffer.from(rgba), { raw: { width: AW, height: AH, channels: 4 } }).png().toBuffer();
  const mipAlphaScale = coverageScales(rgba, AW, AH);
  console.log(`  mip alpha scales ${mipAlphaScale.map((v) => v.toFixed(2)).join(' ')}`);
  const NW = Math.round(AW * (cfg.normalScale ?? 0.5)), NH = Math.round(AH * (cfg.normalScale ?? 0.5));
  const normalPng = await sharp(Buffer.from(nrgba), { raw: { width: AW, height: AH, channels: 4 } }).resize(NW, NH, { kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
  return { name, sprites, albedoPng, normalPng, mipAlphaScale, mode: cfg.mode };
}

/**
 * @param src  gltf-transform Document of the source model
 * @param dir  source folder (textures/)
 * @param cfg  see conifer-config.mjs (+ name)
 * @param atlasFrom  optional { src, dir, cfg }: take the needle sprites from another model (and share its atlas)
 * Returns { doc } with V{i}_LOD0 / V{i}_LOD1 nodes.
 */
export async function buildConifer(src, dir, cfg, atlasFrom = null) {
  const t0 = Date.now();
  const name = cfg.name; const rnd = mulberry((cfg.seed ?? 4242) + 17);
  const model = await prepareModel(src, dir, cfg);
  const variants = model.variants;
  const atlas = atlasFrom ? await bakeAtlas(await prepareModel(atlasFrom.src, atlasFrom.dir, atlasFrom.cfg), atlasFrom.cfg) : await bakeAtlas(model, cfg);
  const { sprites, albedoPng, normalPng, mipAlphaScale } = atlas;
  const views = (f) => viewsOf(cfg.mode, f);

  // ---- output document
  const doc = new Document(); const buffer = doc.createBuffer();
  const outScene = doc.createScene('Scene'); doc.getRoot().setDefaultScene(outScene);
  // the needle atlas ships as its own pair of KTX2 files (needles_<atlas>.ktx2 / _nor.ktx2), shared by every
  // species baked from it; the material only names it (extras.atlas) and the app attaches it at load time
  const atlasName = `needles_${atlas.name}`;
  const needleMat = doc.createMaterial(atlasName)
    .setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(0.72)
    .setExtras({ crownLight: true, mipAlphaScale, atlas: atlasName });
  const woodMats = new Map();
  const woodMat = (srcMat) => {
    const t = srcMat.getBaseColorTexture(); const key = t ? t.getURI() : srcMat.getName();
    if (woodMats.has(key)) return woodMats.get(key);
    const m = doc.createMaterial(`wood_${path.basename(key).replace(/_diff.*$/, '')}`).setMetallicFactor(0).setRoughnessFactor(0.9).setDoubleSided(false).setExtras({ crownLight: true });
    if (t) m.setBaseColorTexture(doc.createTexture(path.basename(t.getURI())).setImage(t.getImage()).setMimeType(t.getMimeType()).setURI(path.basename(t.getURI())));
    const nt = srcMat.getNormalTexture(); if (nt) m.setNormalTexture(doc.createTexture(path.basename(nt.getURI())).setImage(nt.getImage()).setMimeType(nt.getMimeType()).setURI(path.basename(nt.getURI())));
    woodMats.set(key, m); return m;
  };
  const acc = (arr, type) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const addPrim = (mesh, mat, g) => {
    if (!g.idx.length) return;
    const p = doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', acc(g.pos, 'VEC3')).setAttribute('NORMAL', acc(g.nor, 'VEC3')).setAttribute('TEXCOORD_0', acc(g.uv, 'VEC2')).setAttribute('COLOR_0', acc(g.col, 'VEC4'))
      .setIndices(acc(g.pos.length / 3 > 65535 ? Uint32Array.from(g.idx) : Uint16Array.from(g.idx), 'SCALAR'));
    mesh.addPrimitive(p);
  };
  const stats = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const va = variants[vi];
    // crown light from the needle density (+ the wood)
    const G = densityGrid(va.E, va.bounds, cfg.gridCell ?? 0.25);
    addWood(G, va.wood, 0.4);
    const sigma = cfg.sigma ?? 0.012;
    const light = (p) => crownLight(G, p, sigma);
    const skyStats = [];
    for (const lod of [0, 1]) {
      const mesh = doc.createMesh(`V${vi}_LOD${lod}`);
      // needle cards
      const pos = [], nor = [], uv = [], col = [], idx = []; let nv = 0;
      const pool = sprites.filter((s) => s.lod === lod);
      for (const f of va[`f${lod}`]) {
        for (const v of views(f)) {
          const aspect = (v.ur[1] - v.ur[0]) / (v.vr[1] - v.vr[0]);
          const ranked = pool.map((s) => ({ s, r: s.rects.find((q) => q.kind === v.kind) })).sort((a, b) => Math.abs(Math.log(a.r.aspect / aspect)) - Math.abs(Math.log(b.r.aspect / aspect)));
          const pick = ranked[Math.floor(rnd() * Math.min(3, ranked.length))].r;
          const flipV = rnd() < 0.5;
          const cardN = v.z;
          // card corners in the plane through the cluster centre (offset to the middle of its depth)
          const wMid = v.kind === 'front' ? (f.w0 + f.w1) * 0.5 * 0.4 : 0;
          const corner = (a, b) => [f.c[0] + v.x[0] * a + v.y[0] * b + cardN[0] * wMid, f.c[1] + v.x[1] * a + v.y[1] * b + cardN[1] * wMid, f.c[2] + v.x[2] * a + v.y[2] * b + cardN[2] * wMid];
          // cards are a little larger than their cluster: a borrowed sprite is rarely as full as the spray it stands for
          const sc = lod === 0 ? (cfg.cardScale0 ?? 1.12) : (cfg.cardScale1 ?? 1.25);
          const um = (v.ur[0] + v.ur[1]) / 2, uh = (v.ur[1] - v.ur[0]) / 2 * sc, vm = (v.vr[0] + v.vr[1]) / 2, vh = (v.vr[1] - v.vr[0]) / 2 * sc;
          const P = [corner(um - uh, vm + vh), corner(um + uh, vm + vh), corner(um + uh, vm - vh), corner(um - uh, vm - vh)];
          const UV = flipV ? [[pick.u0, pick.v1], [pick.u1, pick.v1], [pick.u1, pick.v0], [pick.u0, pick.v0]] : [[pick.u0, pick.v0], [pick.u1, pick.v0], [pick.u1, pick.v1], [pick.u0, pick.v1]];
          for (let k = 0; k < 4; k++) {
            const L = light(P[k]);
            // bent normal, nudged towards the card plane's facing so neighbouring cards still differ
            let N = L.bent; const s = dot(cardN, N) < 0 ? -1 : 1;
            N = norm([N[0] * 0.8 + cardN[0] * s * 0.2, N[1] * 0.8 + cardN[1] * s * 0.2, N[2] * 0.8 + cardN[2] * s * 0.2]);
            pos.push(...P[k]); nor.push(...N); uv.push(...UV[k]); col.push(...shColour(L)); if (lod === 0) skyStats.push(L.sky);
          }
          idx.push(nv, nv + 1, nv + 2, nv, nv + 2, nv + 3); nv += 4;
        }
      }
      addPrim(mesh, needleMat, { pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), col: Float32Array.from(col), idx });
      let woodTris = 0;
      // wood, grouped by texture
      const groups = new Map();
      for (const w of va.wood) {
        let g = w;
        if (!g.uv) g = trunkUV(g);
        const isTrunk = /trunk/.test(w.mat.getName());
        const budget = isTrunk ? (lod === 0 ? cfg.trunk0 : cfg.trunk1) : (lod === 0 ? cfg.branch0 : cfg.branch1) * (/dead/.test(w.mat.getName()) ? 0.25 : 1);
        g = simplifyWood(g, budget, lod === 1 && !isTrunk ? cfg.twiglet1 ?? 0.8 : (cfg.twiglet0 ?? 0));
        if (!g.idx.length) continue;
        const srcMat = !w.uv && /trunk/.test(w.mat.getName()) ? (variants.flatMap((x) => x.wood).find((x) => /trunk/.test(x.mat.getName()) && x.uv)?.mat ?? w.mat) : w.mat;
        const m = woodMat(srcMat);
        const list = groups.get(m) ?? []; list.push(g); groups.set(m, list);
      }
      for (const [m, list] of groups) {
        const P = [], N = [], U = [], C = [], I = []; let base = 0;
        for (const g of list) {
          const n = g.pos.length / 3;
          for (let i = 0; i < n; i++) {
            const p = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
            const L = light(p);
            P.push(...p); N.push(g.nor[i * 3], g.nor[i * 3 + 1], g.nor[i * 3 + 2]); U.push(g.uv[i * 2], g.uv[i * 2 + 1]);
            C.push(...shColour(L));
          }
          for (const v of g.idx) I.push(v + base); base += n;
        }
        woodTris += I.length / 3;
        addPrim(mesh, m, { pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U), col: Float32Array.from(C), idx: I });
      }
      outScene.addChild(doc.createNode(`V${vi}_LOD${lod}`).setMesh(mesh));
      if (lod === 0) { skyStats.sort((a, b) => a - b); console.log(`  V${vi} card sky visibility p10 ${skyStats[Math.floor(skyStats.length * 0.1)].toFixed(2)} p50 ${skyStats[Math.floor(skyStats.length * 0.5)].toFixed(2)} p90 ${skyStats[Math.floor(skyStats.length * 0.9)].toFixed(2)}`); }
      stats.push(`V${vi}L${lod} ${idx.length / 3}+${woodTris}`);
    }
  }
  console.log(`  ${name}: ${stats.join(', ')} tris (cards+wood), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { doc, albedoPng, normalPng, atlasName, ownAtlas: !atlasFrom, sprites: sprites.length, mipAlphaScale };
}
