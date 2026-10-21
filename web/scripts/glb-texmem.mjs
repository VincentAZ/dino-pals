// GPU memory estimate (RGBA8 + mips) of the textures inside GLB files.
//   node scripts/glb-texmem.mjs dir-or-files...
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'draco3d.decoder': await draco3d.createDecoderModule() });
await MeshoptDecoder.ready;
const files = [];
for (const a of process.argv.slice(2)) {
  const st = await fs.stat(a);
  if (st.isDirectory()) { for (const f of await fs.readdir(a)) if (f.endsWith('.glb')) files.push(path.join(a, f)); } else files.push(a);
}
let total = 0;
for (const f of files) {
  const doc = await io.read(f);
  let mb = 0; const dims = [];
  for (const t of doc.getRoot().listTextures()) {
    const m = await sharp(Buffer.from(t.getImage())).metadata();
    mb += (m.width * m.height * 4 * 4) / 3 / 1048576; dims.push(`${m.width}`);
  }
  total += mb;
  console.log(path.basename(f).padEnd(32), mb.toFixed(1).padStart(6), 'MB', dims.join(','));
}
console.log('TOTAL', total.toFixed(1), 'MB');
