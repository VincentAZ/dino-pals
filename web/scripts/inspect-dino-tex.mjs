// Per-dinosaur texture inventory: slot, size, format, bytes, and which material/primitive uses it.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
let gpuTotal = 0;
for (const f of (process.argv[2] ? [process.argv[2] + '.glb'] : fs.readdirSync('public/assets/dinos').filter((f) => f.endsWith('.glb')))) {
  const doc = await io.read('public/assets/dinos/' + f);
  const root = doc.getRoot(); let gpu = 0; const rows = [];
  for (const t of root.listTextures()) {
    const size = t.getSize() || [0, 0];
    const slots = new Set(); const mats = new Set();
    for (const p of t.listParents()) { if (p.propertyType === 'Material') { mats.add(p.getName()); for (const [k, v] of Object.entries({ base: p.getBaseColorTexture(), normal: p.getNormalTexture(), mr: p.getMetallicRoughnessTexture(), occ: p.getOcclusionTexture(), emis: p.getEmissiveTexture() })) if (v === t) slots.add(k); } else if (p.propertyType !== 'Root') { mats.add(p.propertyType); slots.add('ext'); } }
    const g = size[0] * size[1] * 4 * 1.33; gpu += g;
    rows.push(`   ${[...slots].join('+').padEnd(10)} ${size.join('x').padEnd(10)} ${t.getMimeType().padEnd(11)} ${(t.getImage().byteLength / 1024).toFixed(0).padStart(5)} KB  ${[...mats].join(',')}`);
  }
  // triangles per material
  const tris = {}; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { const n = p.getMaterial()?.getName() ?? '-'; tris[n] = (tris[n] ?? 0) + (p.getIndices() ? p.getIndices().getCount() / 3 : 0); }
  gpuTotal += gpu;
  console.log(f, `textures ${root.listTextures().length}`, `gpu ${(gpu / 1048576).toFixed(0)} MB`, 'tris/mat', JSON.stringify(tris));
  for (const r of rows) console.log(r);
}
console.log('total uncompressed GPU', (gpuTotal / 1048576).toFixed(0), 'MB');
