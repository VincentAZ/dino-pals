import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of process.argv.slice(2)) {
  const doc = await io.read(`/tmp/dino-polyhaven/${name}/${name}.gltf`);
  const b = getBounds(doc.getRoot().listScenes()[0]);
  console.log(name, 'size', b.max.map((v, i) => (v - b.min[i]).toFixed(1).toString()).join('x'));
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial(); const idx = prim.getIndices(); const pos = prim.getAttribute('POSITION'); const uv = prim.getAttribute('TEXCOORD_0');
    if (!idx) continue;
    const ia = idx.getArray(); const pa = pos.getArray(); const n = ia.length / 3;
    let pairs = 0, area = 0; let umin = 9, umax = -9;
    for (let t = 0; t + 6 <= ia.length && t < 60000; t += 6) { const a = [ia[t], ia[t + 1], ia[t + 2]], c = [ia[t + 3], ia[t + 4], ia[t + 5]]; if (a.filter((v) => c.includes(v)).length >= 2) pairs++; }
    for (let t = 0; t < Math.min(ia.length, 30000); t += 3) {
      const A = ia[t] * 3, B = ia[t + 1] * 3, C = ia[t + 2] * 3;
      const ux = pa[B] - pa[A], uy = pa[B + 1] - pa[A + 1], uz = pa[B + 2] - pa[A + 2], vx = pa[C] - pa[A], vy = pa[C + 1] - pa[A + 1], vz = pa[C + 2] - pa[A + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx; area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
    if (uv) { const ua = uv.getArray(); for (let i = 0; i < Math.min(ua.length, 20000); i += 2) { umin = Math.min(umin, ua[i]); umax = Math.max(umax, ua[i]); } }
    console.log('  ', mat?.getName(), mat?.getAlphaMode(), 'tris', n, 'quadPairs%', Math.round((pairs / Math.min(n / 2, 10000)) * 100), 'avgTriArea', (area / Math.min(n, 10000)).toExponential(2), 'u', umin.toFixed(2), umax.toFixed(2), 'verts', pos.getCount());
  }
}
