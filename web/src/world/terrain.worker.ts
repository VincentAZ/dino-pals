// Web worker: builds terrain chunk geometry, the splat map, the far mesh and
// vegetation placements off the main thread.
import { heightAt, layerWeightsAt, waterAt, riverInfo, slopeAt } from './heightmap.ts';
import { BIOME_IDS, BIOMES, HALF, LAYER_COUNT, biomeWeights, SEA_LEVEL } from './biomes.ts';
import { VEG } from './vegrules.ts';
import { Simplex2, hash2, mulberry32 } from '../util/noise.ts';

export interface ChunkRequest { type: 'chunk'; id: number; cx: number; cz: number; lod: number; size: number; segments: number; withVeg: boolean; vegDensity: number }
export interface SplatRequest { type: 'splat'; id: number; res: number }
export interface FarRequest { type: 'far'; id: number; segments: number }
export type WorkerRequest = ChunkRequest | SplatRequest | FarRequest;

const clusterNoise = new Simplex2(777);
const CLEAR_POINTS: [number, number, number][] = [[0, 0, 17], ...Object.values(BIOMES).map((b) => [b.anchor[0], b.anchor[1], b.id === 'jungle' ? 4.5 : 9] as [number, number, number])];
const BEACH = BIOME_IDS.indexOf('beach');

function buildChunk(req: ChunkRequest) {
  const { cx, cz, size, segments } = req;
  const x0 = cx * size - HALF, z0 = cz * size - HALF;
  const step = size / segments;
  const n = segments + 1;
  // grid with a 1-vertex margin for normals
  const g = new Float32Array((n + 2) * (n + 2));
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) g[(j + 1) * (n + 2) + (i + 1)] = heightAt(x0 + i * step, z0 + j * step);
  const H = (i: number, j: number) => g[(j + 1) * (n + 2) + (i + 1)];
  const skirt = 4 * n; // extra verts for skirts
  const vcount = n * n + skirt;
  const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3);
  let p = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    pos[p * 3] = i * step; pos[p * 3 + 1] = H(i, j); pos[p * 3 + 2] = j * step;
    const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step), dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
    const l = Math.hypot(dx, 1, dz);
    nor[p * 3] = -dx / l; nor[p * 3 + 1] = 1 / l; nor[p * 3 + 2] = -dz / l;
    p++;
  }
  const idx: number[] = [];
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    // alternate diagonal for nicer shading
    if ((i + j) & 1) { idx.push(a, c, b, b, c, d); } else { idx.push(a, c, d, a, d, b); }
  }
  // skirts: duplicate edge verts pushed down
  const drop = 6 + step * 2;
  const addSkirt = (edgeIdx: number[]) => {
    const start = p;
    for (const e of edgeIdx) {
      pos[p * 3] = pos[e * 3]; pos[p * 3 + 1] = pos[e * 3 + 1] - drop; pos[p * 3 + 2] = pos[e * 3 + 2];
      nor[p * 3] = nor[e * 3]; nor[p * 3 + 1] = nor[e * 3 + 1]; nor[p * 3 + 2] = nor[e * 3 + 2];
      p++;
    }
    for (let k = 0; k < edgeIdx.length - 1; k++) {
      const a = edgeIdx[k], b = edgeIdx[k + 1], c = start + k, d = start + k + 1;
      idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings (seen from any side)
    }
  };
  const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
  for (let i = 0; i < n; i++) { top.push(i); bottom.push((n - 1) * n + i); left.push(i * n); right.push(i * n + n - 1); }
  addSkirt(top); addSkirt(bottom); addSkirt(left); addSkirt(right);
  const indices = vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);

  let veg: Record<string, Float32Array> | null = null;
  if (req.withVeg) veg = placeVegetation(cx, cz, size, x0, z0, req.vegDensity);
  return { pos, nor, indices, veg };
}

function placeVegetation(cx: number, cz: number, size: number, x0: number, z0: number, densityMul: number) {
  const out: Record<string, Float32Array> = {};
  const bw = new Float32Array(BIOME_IDS.length);
  const treeSpots: number[] = []; // x,z,spacing for spacing checks
  for (let s = 0; s < VEG.length; s++) {
    const sp = VEG[s];
    let maxD = 0;
    for (const v of Object.values(sp.density)) maxD = Math.max(maxD, v ?? 0);
    const rnd = mulberry32((hash2(cx, cz, 91 + s) * 1e9) | 0);
    const K = Math.ceil(maxD * densityMul * 1.15);
    const items: number[] = [];
    for (let k = 0; k < K; k++) {
      const x = x0 + rnd() * size, z = z0 + rnd() * size;
      biomeWeights(x, z, bw);
      let rate = 0;
      // a biome only contributes where it actually dominates (no broadleaf bleed into the snow etc.)
      for (let b = 0; b < BIOME_IDS.length; b++) { const d = sp.density[BIOME_IDS[b]]; if (d) { const wb = bw[b]; const k = Math.min(1, Math.max(0, (wb - 0.18) / 0.22)); rate += wb * d * (k * k * (3 - 2 * k)); } }
      const h0 = heightAt(x, z);
      // beach trees/rocks keep to the shore band
      if (sp.density.beach && bw[BEACH] > 0.3 && sp.kind !== 'plant') rate *= Math.min(1, Math.max(0, (7.5 - h0) / 4.5));
      let accept = rate / maxD;
      if (sp.cluster > 0) {
        const c = clusterNoise.noise(x * 0.02 + s * 3.1, z * 0.02) * 0.5 + 0.5;
        accept *= (1 - sp.cluster) + sp.cluster * (c * c * 2.2);
      }
      if (rnd() > accept) continue;
      const h = h0;
      const wi = waterAt(x, z);
      const inPool = wi.kind === 'pool' && wi.level - h < 0.9 && sp.inWater;
      if ((wi.kind !== 'none' && !inPool) || h < SEA_LEVEL + 0.4) continue;
      if (sp.kind !== 'plant') {
        let clear = false;
        for (const [cx0, cz0, cr] of CLEAR_POINTS) if (Math.hypot(x - cx0, z - cz0) < cr) { clear = true; break; }
        // keep the opening tableau unobstructed: no tree in the front 120° arc (camera looks towards -z) within 35 m
        if (!clear && sp.kind === 'tree') { const d0 = Math.hypot(x, z); if (d0 < 35 && d0 > 0 && (-z) / d0 > 0.5) clear = true; }
        if (clear) continue;
      }
      if (sp.kind !== 'rock' && riverInfo(x, z).d < 9) continue;
      const slope = slopeAt(x, z, 1.5);
      if (slope > sp.maxSlope) continue;
      if (sp.spacing > 0) {
        let ok = true;
        for (let t = 0; t < treeSpots.length; t += 3) {
          const dd = Math.hypot(treeSpots[t] - x, treeSpots[t + 1] - z);
          if (dd < Math.max(sp.spacing, treeSpots[t + 2])) { ok = false; break; }
        }
        if (!ok) continue;
        treeSpots.push(x, z, sp.spacing);
      }
      const scale = sp.baseScale * (sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0]));
      const rot = rnd() * Math.PI * 2;
      const y = h - sp.sink * scale - slope * 0.5;
      items.push(x, y, z, rot, scale, rnd());
    }
    if (items.length) out[sp.id] = new Float32Array(items);
  }
  return out;
}

function buildSplat(res: number) {
  const planes = Math.ceil(LAYER_COUNT / 4);
  const data = new Uint8Array(res * res * 4 * planes);
  const w = new Float32Array(LAYER_COUNT);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const x = ((i + 0.5) / res - 0.5) * 2 * HALF, z = ((j + 0.5) / res - 0.5) * 2 * HALF;
    layerWeightsAt(x, z, w);
    for (let l = 0; l < LAYER_COUNT; l++) {
      const plane = l >> 2, ch = l & 3;
      data[plane * res * res * 4 + (j * res + i) * 4 + ch] = Math.round(w[l] * 255);
    }
  }
  return { data, planes };
}

function buildFar(segments: number) {
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3);
  const step = (2 * HALF * 1.6) / segments; // extend beyond the island into the sea
  const x0 = -HALF * 1.6, z0 = -HALF * 1.6;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = heightAt(x0 + i * step, z0 + j * step) - 1.2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = j * n + i;
    pos[p * 3] = x0 + i * step; pos[p * 3 + 1] = H[p]; pos[p * 3 + 2] = z0 + j * step;
    const hl = H[j * n + Math.max(0, i - 1)], hr = H[j * n + Math.min(n - 1, i + 1)];
    const hu = H[Math.max(0, j - 1) * n + i], hd = H[Math.min(n - 1, j + 1) * n + i];
    const dx = (hr - hl) / (2 * step), dz = (hd - hu) / (2 * step);
    const l = Math.hypot(dx, 1, dz);
    nor[p * 3] = -dx / l; nor[p * 3 + 1] = 1 / l; nor[p * 3 + 2] = -dz / l;
  }
  const idx: number[] = [];
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // heightmap texture for water foam (R = height encoded)
  const hres = 256; const hm = new Float32Array(hres * hres);
  for (let j = 0; j < hres; j++) for (let i = 0; i < hres; i++) hm[j * hres + i] = heightAt(((i + 0.5) / hres - 0.5) * 2 * HALF, ((j + 0.5) / hres - 0.5) * 2 * HALF);
  return { pos, nor, indices: new Uint32Array(idx), hm, hres };
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'chunk') {
    const r = buildChunk(req);
    const transfer: ArrayBuffer[] = [r.pos.buffer as ArrayBuffer, r.nor.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer];
    if (r.veg) for (const v of Object.values(r.veg)) transfer.push(v.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id: req.id, ...r }, transfer);
  } else if (req.type === 'splat') {
    const r = buildSplat(req.res);
    (self as unknown as Worker).postMessage({ id: req.id, ...r }, [r.data.buffer as ArrayBuffer]);
  } else if (req.type === 'far') {
    const r = buildFar(req.segments);
    (self as unknown as Worker).postMessage({ id: req.id, ...r }, [r.pos.buffer as ArrayBuffer, r.nor.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer, r.hm.buffer as ArrayBuffer]);
  }
};
