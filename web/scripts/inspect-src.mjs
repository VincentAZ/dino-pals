// Prints per-node / per-material triangle counts of cached Poly Haven source glTFs.
//   node scripts/inspect-src.mjs name [name...]
import path from 'node:path';
import os from 'node:os';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const TMP = path.join(os.tmpdir(), 'dino-polyhaven');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of process.argv.slice(2)) {
  const doc = await io.read(path.join(TMP, name, `${name}.gltf`));
  const scene = doc.getRoot().listScenes()[0];
  console.log(`== ${name}: ${scene.listChildren().length} root nodes`);
  const byMat = {};
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const n = (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
    const m = p.getMaterial(); const k = `${m ? m.getName() : '-'} [${m ? m.getAlphaMode() : ''}]`;
    byMat[k] = (byMat[k] || 0) + n;
  }
  for (const [k, v] of Object.entries(byMat)) console.log(`   ${k}: ${v}`);
  for (const c of scene.listChildren().slice(0, 8)) {
    const b = getBounds(c);
    console.log(`   node ${c.getName()} h=${(b.max[1] - b.min[1]).toFixed(2)} w=${Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]).toFixed(2)}`);
  }
}
