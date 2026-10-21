// Prints the V0_LOD0 footprint (width, height) of each env GLB.
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const dir = process.argv[2];
for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.glb'))) {
  const doc = await io.read(path.join(dir, f));
  const scene = doc.getRoot().listScenes()[0];
  const n = scene.listChildren().find((c) => /V0_LOD0|^LOD0$/.test(c.getName())) ?? scene.listChildren()[0];
  const b = getBounds(n);
  console.log(f.replace('.glb', '').padEnd(26), 'w', Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]).toFixed(2), 'h', (b.max[1] - b.min[1]).toFixed(2));
}
