// Grid A* route planning around trees, rocks, water and steep ground, sized per dinosaur.
import * as THREE from 'three';
import type { Dino, DinoContext } from './dino.ts';
import { bodyOf, landOk, obstacleRadius } from './ai_land.ts';
import type { Obstacle } from '../world/obstacles.ts';

const near: Obstacle[] = [];

/** Does the straight segment a→b keep the body clear of every obstacle? */
export function lineClear(d: Dino, ctx: DinoContext, ax: number, az: number, bx: number, bz: number, margin = 0.4): boolean {
  const cx = (ax + bx) / 2, cz = (az + bz) / 2; const half = Math.hypot(bx - ax, bz - az) / 2;
  const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez;
  for (const o of ctx.obstacles.near(cx, cz, half + 12, near)) {
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((o.x - ax) * ex + (o.z - az) * ez) / l2)) : 0;
    if (Math.hypot(o.x - ax - ex * t, o.z - az - ez * t) < obstacleRadius(d, o) + margin) return false;
  }
  const steps = Math.ceil(Math.hypot(ex, ez) / 3);
  for (let i = 1; i <= steps; i++) if (!landOk(ax + ex * i / steps, az + ez * i / steps)) return false;
  return true;
}

/**
 * Plan a route for this dinosaur from its position to (gx,gz). Returns waypoints (excluding the
 * start, including the goal) or null when the goal cannot be reached inside the search window.
 */
export function planRoute(d: Dino, ctx: DinoContext, gx: number, gz: number): THREE.Vector3[] | null {
  const pos = d.root.position;
  if (lineClear(d, ctx, pos.x, pos.z, gx, gz)) return [new THREE.Vector3(gx, 0, gz)];
  const b = bodyOf(d);
  const cell = THREE.MathUtils.clamp(b.r * 0.9, 1, 2.5);
  const minX = Math.min(pos.x, gx) - 35, minZ = Math.min(pos.z, gz) - 35;
  const W = Math.ceil((Math.max(pos.x, gx) + 35 - minX) / cell), H = Math.ceil((Math.max(pos.z, gz) + 35 - minZ) / cell);
  if (W * H > 160 * 160) return null;
  const blocked = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
    if (!landOk(x, z)) blocked[j * W + i] = 1;
  }
  const cx = minX + W * cell / 2, cz = minZ + H * cell / 2;
  for (const o of ctx.obstacles.near(cx, cz, Math.hypot(W, H) * cell / 2 + 10, near)) {
    const R = obstacleRadius(d, o) + 0.3;
    const i0 = Math.max(0, Math.floor((o.x - R - minX) / cell)), i1 = Math.min(W - 1, Math.floor((o.x + R - minX) / cell));
    const j0 = Math.max(0, Math.floor((o.z - R - minZ) / cell)), j1 = Math.min(H - 1, Math.floor((o.z + R - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      if (Math.hypot(x - o.x, z - o.z) < R) blocked[j * W + i] = 1;
    }
  }
  const si = Math.floor((pos.x - minX) / cell), sj = Math.floor((pos.z - minZ) / cell);
  let ti = Math.floor((gx - minX) / cell), tj = Math.floor((gz - minZ) / cell);
  const start = sj * W + si;
  blocked[start] = 0;
  // goal inside an obstacle → nearest free cell
  if (blocked[tj * W + ti]) {
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, tj - 6); j <= Math.min(H - 1, tj + 6); j++) for (let i = Math.max(0, ti - 6); i <= Math.min(W - 1, ti + 6); i++) {
      if (blocked[j * W + i]) continue; const dd = (i - ti) ** 2 + (j - tj) ** 2; if (dd < bd) { bd = dd; best = j * W + i; }
    }
    if (best < 0) return null;
    ti = best % W; tj = Math.floor(best / W);
  }
  const goal = tj * W + ti;
  const g = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1);
  const open: number[] = [start]; const f = new Float32Array(W * H).fill(Infinity);
  const h = (k: number) => Math.hypot((k % W) - ti, Math.floor(k / W) - tj);
  g[start] = 0; f[start] = h(start);
  const closed = new Uint8Array(W * H);
  let found = false, iter = 0;
  while (open.length && iter++ < 40000) {
    let bi = 0; for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
    const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue; closed[cur] = 1;
    const ci = cur % W, cj = Math.floor(cur / W);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = nj * W + ni; if (blocked[nk] || closed[nk]) continue;
      if (di && dj && (blocked[cj * W + ni] || blocked[nj * W + ci])) continue;   // no corner cutting
      const ng = g[cur] + (di && dj ? 1.4142 : 1);
      if (ng < g[nk]) { g[nk] = ng; from[nk] = cur; f[nk] = ng + h(nk); open.push(nk); }
    }
  }
  if (!found) return null;
  const cells: number[] = []; for (let k = goal; k !== -1; k = from[k]) cells.push(k);
  cells.reverse();
  const pts = cells.map((k) => new THREE.Vector3(minX + ((k % W) + 0.5) * cell, 0, minZ + (Math.floor(k / W) + 0.5) * cell));
  pts[pts.length - 1].set(gx, 0, gz);
  // string pulling: keep only the waypoints needed for clear straight legs
  const out: THREE.Vector3[] = []; let ax = pos.x, az = pos.z, k = 0;
  while (k < pts.length - 1) {
    let far = k;
    for (let m = pts.length - 1; m > k; m--) if (lineClear(d, ctx, ax, az, pts[m].x, pts[m].z, 0.2)) { far = m; break; }
    if (far === k) far = k + 1;
    out.push(pts[far]); ax = pts[far].x; az = pts[far].z; k = far;
  }
  if (!out.length || out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}
