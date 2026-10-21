// Prints KHR_materials_ior / specular values per dinosaur material (do they change the look vs. standard PBR?).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const f of fs.readdirSync('public/assets/dinos').filter((f) => f.endsWith('.glb'))) {
  const doc = await io.read('public/assets/dinos/' + f);
  for (const m of doc.getRoot().listMaterials()) {
    const ior = m.getExtension('KHR_materials_ior'), sp = m.getExtension('KHR_materials_specular');
    if (!ior && !sp) continue;
    console.log(f, m.getName(), 'ior', ior?.getIOR(), 'spec', sp?.getSpecularFactor(), sp?.getSpecularColorFactor(), 'specTex', !!sp?.getSpecularTexture(), !!sp?.getSpecularColorTexture());
  }
}
