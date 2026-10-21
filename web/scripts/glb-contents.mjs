// What takes the bytes in a GLB: textures (mime, pixels, bytes) and per-node triangle counts.
//   node scripts/glb-contents.mjs file.glb [...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) {
  const size = (await fs.stat(f)).size; const doc = await io.read(f);
  let tex = 0;
  console.log(`${path.basename(f)}: ${(size / 1024).toFixed(0)} KB`);
  for (const t of doc.getRoot().listTextures()) {
    const b = t.getImage()?.byteLength ?? 0; tex += b;
    console.log(`   tex ${(t.getURI() || t.getName()).padEnd(44)} ${t.getMimeType().padEnd(11)} ${(t.getSize() ?? ['?', '?']).join('x').padEnd(10)} ${(b / 1024).toFixed(0)} KB`);
  }
  console.log(`   textures ${(tex / 1024).toFixed(0)} KB, geometry+json ~${((size - tex) / 1024).toFixed(0)} KB`);
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh(); if (!m) continue;
    const parts = m.listPrimitives().map((p) => `${p.getMaterial()?.getName()}:${(p.getIndices()?.getCount() ?? 0) / 3}`);
    console.log(`   ${n.getName().padEnd(10)} ${parts.join('  ')}`);
  }
}
