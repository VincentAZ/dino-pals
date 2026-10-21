// Leaf structure stats of a cached Poly Haven source: connected components of the
// alpha/leaf primitives (tris per leaf, leaf size, UV extent).
//   node scripts/inspect-leaves.mjs name
import path from 'node:path';
import os from 'node:os';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const TMP = path.join(os.tmpdir(), 'dino-polyhaven');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const name = process.argv[2];
const doc = await io.read(path.join(TMP, name, `${name}.gltf`));
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const m = p.getMaterial(); if (!m) continue;
  const idx = p.getIndices().getArray(); const pos = p.getAttribute('POSITION').getArray(); const uv = p.getAttribute('TEXCOORD_0')?.getArray();
  const nv = pos.length / 3;
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); parent[b] = a; parent[c] = a; }
  const comp = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]); let c = comp.get(r); if (!c) { c = { tris: 0, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], umin: [9, 9], umax: [-9, -9] }; comp.set(r, c); }
    c.tris++;
    for (let k = 0; k < 3; k++) { const v = idx[t + k]; for (let d = 0; d < 3; d++) { c.min[d] = Math.min(c.min[d], pos[v * 3 + d]); c.max[d] = Math.max(c.max[d], pos[v * 3 + d]); } if (uv) for (let d = 0; d < 2; d++) { c.umin[d] = Math.min(c.umin[d], uv[v * 2 + d]); c.umax[d] = Math.max(c.umax[d], uv[v * 2 + d]); } }
  }
  const list = [...comp.values()];
  const tris = list.map((c) => c.tris).sort((a, b) => a - b);
  const size = list.map((c) => Math.max(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2])).sort((a, b) => a - b);
  const uvs = list.map((c) => `${(c.umax[0] - c.umin[0]).toFixed(2)}x${(c.umax[1] - c.umin[1]).toFixed(2)}`);
  const uvCount = {}; for (const u of uvs) uvCount[u] = (uvCount[u] || 0) + 1;
  const topUv = Object.entries(uvCount).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const q = (arr, f) => arr[Math.floor(arr.length * f)];
  console.log(`${m.getName()} [${m.getAlphaMode()}] tris=${idx.length / 3} comps=${list.length} tris/comp p10=${q(tris, 0.1)} p50=${q(tris, 0.5)} p90=${q(tris, 0.9)} size p10=${q(size, 0.1).toFixed(3)} p50=${q(size, 0.5).toFixed(3)} p90=${q(size, 0.9).toFixed(3)} uv=${JSON.stringify(topUv)}`);
}
