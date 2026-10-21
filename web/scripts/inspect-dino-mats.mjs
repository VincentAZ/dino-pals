// Lists non-opaque / extension materials (transmission, blend) in the dinosaur GLBs.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const f of fs.readdirSync('public/assets/dinos').filter((f) => f.endsWith('.glb'))) {
  const doc = await io.read('public/assets/dinos/' + f);
  const out = [];
  for (const m of doc.getRoot().listMaterials()) {
    const ext = m.listExtensions().map((e) => e.extensionName.replace('KHR_materials_', ''));
    const tr = m.getExtension('KHR_materials_transmission');
    if (ext.length || m.getAlphaMode() !== 'OPAQUE') out.push(`${m.getName()}[${m.getAlphaMode()}${m.getDoubleSided() ? ',2s' : ''}${ext.length ? ',' + ext.join('+') : ''}${tr ? ',T=' + tr.getTransmissionFactor() : ''}]`);
  }
  console.log(f.padEnd(26), doc.getRoot().listMaterials().length, 'mats', out.join(' '));
}
if (process.argv[2]) {
  const doc = await io.read('public/assets/dinos/' + process.argv[2] + '.glb');
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial(); const idx = p.getIndices();
    console.log(mesh.getName(), m?.getName(), m?.getAlphaMode(), 'baseAlpha', m?.getBaseColorFactor()[3], 'tris', idx ? idx.getCount() / 3 : 0, 'rough', m?.getRoughnessFactor());
  }
}
