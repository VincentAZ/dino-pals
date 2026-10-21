// Grid A* route planning around trees, rocks, water and steep ground, sized per dinosaur.
// Budgeted: terrain is sampled on a coarse lattice, the open set is a binary heap, the search is
// capped, and only a couple of plans run per frame (callers fall back to local steering meanwhile).
import * as THREE from 'three';
import type { Dino, DinoContext } from './dino.ts';
import { bodyOf, landCoarse, obstacleRadius } from './ai_land.ts';
import type { Obstacle } from '../world/obstacles.ts';

const near: Obstacle[] = [];
export const routeStats = { calls: 0, ms: 0, maxMs: 0, deferred: 0, gridMs: 0, searchMs: 0, pullMs: 0, iters: 0, cells: 0 };
let budget = 2;
/** Called once per frame by the spawner. */
export function resetRouteBudget(n = 2): void { budget = n; }

/** Does the straight segment a→b keep the body clear of every obstacle? */
export function lineClear(d: Dino, ctx: DinoContext, ax: number, az: number, bx: number, bz: number, margin = 0.4): boolean {
  const cx = (ax + bx) / 2, cz = (az + bz) / 2; const half = Math.hypot(bx - ax, bz - az) / 2;
  const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez;
  for (const o of ctx.obstacles.near(cx, cz, half + 12, near)) {
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((o.x - ax) * ex + (o.z - az) * ez) / l2)) : 0;
    if (Math.hypot(o.x - ax - ex * t, o.z - az - ez * t) < obstacleRadius(d, o) + margin) return false;
  }
  const steps = Math.ceil(Math.hypot(ex, ez) / 4);
  for (let i = 1; i <= steps; i++) if (!landCoarse(ax + ex * i / steps, az + ez * i / steps)) return false;
  return true;
}

/**
 * Plan a route for this dinosaur from its position to (gx,gz). Returns waypoints (excluding the
 * start, including the goal), null when no route exists inside the search window, or undefined when
 * this frame's planning budget is spent (try again next frame).
 */
export function planRoute(d: Dino, ctx: DinoContext, gx: number, gz: number): THREE.Vector3[] | null | undefined {
  const pos = d.root.position;
  if (lineClear(d, ctx, pos.x, pos.z, gx, gz)) return [new THREE.Vector3(gx, 0, gz)];
  if (budget <= 0) { routeStats.deferred++; return undefined; }
  budget--;
  const t0 = performance.now();
  try { return search(d, ctx, gx, gz); } finally { const ms = performance.now() - t0; routeStats.calls++; routeStats.ms += ms; routeStats.maxMs = Math.max(routeStats.maxMs, ms); }
}

// ---------------------------------------------------------------- binary heap of cell indices keyed by f
let heap = new Int32Array(4096), hn = 0;
let fArr = new Float32Array(1);
function hpush(k: number): void {
  if (hn >= heap.length) { const h2 = new Int32Array(heap.length * 2); h2.set(heap); heap = h2; }
  let i = hn++; heap[i] = k;
  while (i > 0) { const p = (i - 1) >> 1; if (fArr[heap[p]] <= fArr[heap[i]]) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
}
function hpop(): number {
  const top = heap[0]; heap[0] = heap[--hn];
  let i = 0;
  for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hn && fArr[heap[l]] < fArr[heap[m]]) m = l; if (r < hn && fArr[heap[r]] < fArr[heap[m]]) m = r; if (m === i) break; const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; }
  return top;
}

function search(d: Dino, ctx: DinoContext, gx: number, gz: number): THREE.Vector3[] | null {
  const pos = d.root.position;
  const b = bodyOf(d);
  const cell = THREE.MathUtils.clamp(b.r * 1.1, 1.2, 3);
  const pad = 30;
  const minX = Math.min(pos.x, gx) - pad, minZ = Math.min(pos.z, gz) - pad;
  const W = Math.ceil((Math.max(pos.x, gx) + pad - minX) / cell), H = Math.ceil((Math.max(pos.z, gz) + pad - minZ) / cell);
  if (W * H > 140 * 140) return null;
  const N = W * H;
  const tg = performance.now(); routeStats.cells += N;
  const blocked = new Uint8Array(N);
  // terrain (water / steep / out of bounds) from the cached, world-aligned 4 m walkability grid
  for (let j = 0; j < H; j++) { const z = minZ + (j + 0.5) * cell; for (let i = 0; i < W; i++) if (!landCoarse(minX + (i + 0.5) * cell, z)) blocked[j * W + i] = 1; }
  const cx = minX + W * cell / 2, cz = minZ + H * cell / 2;
  for (const o of ctx.obstacles.near(cx, cz, Math.hypot(W, H) * cell / 2 + 10, near)) {
    const R = obstacleRadius(d, o) + 0.3;
    const i0 = Math.max(0, Math.floor((o.x - R - minX) / cell)), i1 = Math.min(W - 1, Math.floor((o.x + R - minX) / cell));
    const j0 = Math.max(0, Math.floor((o.z - R - minZ) / cell)), j1 = Math.min(H - 1, Math.floor((o.z + R - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      if ((x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < R * R) blocked[j * W + i] = 1;
    }
  }
  const si = Math.min(W - 1, Math.max(0, Math.floor((pos.x - minX) / cell))), sj = Math.min(H - 1, Math.max(0, Math.floor((pos.z - minZ) / cell)));
  let ti = Math.min(W - 1, Math.max(0, Math.floor((gx - minX) / cell))), tj = Math.min(H - 1, Math.max(0, Math.floor((gz - minZ) / cell)));
  const start = sj * W + si;
  blocked[start] = 0;
  if (blocked[tj * W + ti]) {
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, tj - 6); j <= Math.min(H - 1, tj + 6); j++) for (let i = Math.max(0, ti - 6); i <= Math.min(W - 1, ti + 6); i++) {
      if (blocked[j * W + i]) continue; const dd = (i - ti) ** 2 + (j - tj) ** 2; if (dd < bd) { bd = dd; best = j * W + i; }
    }
    if (best < 0) return null;
    ti = best % W; tj = Math.floor(best / W);
  }
  const goal = tj * W + ti;
  const ts = performance.now(); routeStats.gridMs += ts - tg;
  const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  if (fArr.length < N) fArr = new Float32Array(N);
  hn = 0;
  const h = (k: number) => { const dx = Math.abs((k % W) - ti), dz = Math.abs(((k / W) | 0) - tj); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
  g[start] = 0; fArr[start] = h(start); hpush(start);
  let found = false, iter = 0;
  while (hn > 0 && iter++ < 9000) {
    const cur = hpop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue; closed[cur] = 1;
    const ci = cur % W, cj = (cur / W) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = nj * W + ni; if (blocked[nk] || closed[nk]) continue;
      if (di && dj && (blocked[cj * W + ni] || blocked[nj * W + ci])) continue;   // no corner cutting
      const ng = g[cur] + (di && dj ? 1.4142 : 1);
      if (ng < g[nk]) { g[nk] = ng; from[nk] = cur; fArr[nk] = ng + h(nk); hpush(nk); }
    }
  }
  const tp = performance.now(); routeStats.searchMs += tp - ts; routeStats.iters += iter;
  if (!found) return null;
  const cells: number[] = []; for (let k = goal; k !== -1; k = from[k]) cells.push(k);
  cells.reverse();
  const pts = cells.map((k) => new THREE.Vector3(minX + ((k % W) + 0.5) * cell, 0, minZ + (((k / W) | 0) + 0.5) * cell));
  pts[pts.length - 1].set(gx, 0, gz);
  // string pulling (bounded): keep only the waypoints needed for clear straight legs
  const out: THREE.Vector3[] = []; let ax = pos.x, az = pos.z, k = 0, checks = 0;
  while (k < pts.length - 1) {
    let far = k + 1;
    for (let m = Math.min(pts.length - 1, k + 40); m > k + 1 && checks < 120; m -= 2) { checks++; if (lineClear(d, ctx, ax, az, pts[m].x, pts[m].z, 0.2)) { far = m; break; } }
    out.push(pts[far]); ax = pts[far].x; az = pts[far].z; k = far;
  }
  if (!out.length || out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  routeStats.pullMs += performance.now() - tp;
  return out;
}
