import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of process.argv.slice(2)) {
  const doc = await io.read(`/tmp/dino-polyhaven/${name}/${name}.gltf`);
  for (const mat of doc.getRoot().listMaterials()) {
    if (mat.getAlphaMode() === 'OPAQUE') continue;
    const t = mat.getBaseColorTexture();
    const meta = t ? await sharp(Buffer.from(t.getImage())).metadata() : null;
    console.log(name, mat.getName(), t?.getMimeType(), t?.getURI(), meta && `${meta.width}x${meta.height} ch=${meta.channels} alpha=${meta.hasAlpha}`, 'cutoff', mat.getAlphaCutoff(), 'ds', mat.getDoubleSided());
  }
}
