// Dumps the textures of a GLB as PNGs into a directory.
//   node scripts/glb-textures.mjs file.glb outdir
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const [file, out] = process.argv.slice(2);
await fs.mkdir(out, { recursive: true });
const doc = await io.read(file);
let i = 0;
for (const t of doc.getRoot().listTextures()) {
  const name = (t.getURI() || t.getName() || `tex${i}`).replace(/[^a-z0-9_.-]/gi, '_').replace(/\.\w+$/, '');
  await sharp(Buffer.from(t.getImage())).png().toFile(path.join(out, `${i++}_${name}.png`));
  console.log(name);
}
