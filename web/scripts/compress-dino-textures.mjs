// GPU-compress dinosaur + food textures (KTX2 / Basis) so they stay compressed in GPU memory on the iPad
// (ASTC / ETC2 there, BC on desktops) instead of expanding to 4 bytes per pixel.
//   colour + roughness/AO: ETC1S (colour as sRGB), normal maps: UASTC + RDO + zstd (ETC1S ruins normals)
//   dead KHR_materials_specular / ior data (Blender "Specular 0") is stripped: the app renders plain PBR
//   textures used only by tiny parts (< 3% of the model's triangles: eyes, claws, teeth) drop to 256 px
// Geometry is re-encoded with the pipeline's exact Draco settings.
//   node scripts/compress-dino-textures.mjs <in-dir> <out-dir> [name ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression, KHRMaterialsSpecular, KHRMaterialsIOR } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { ktx2 } from 'ktx2-encoder/gltf-transform';

const [inDir, outDir, ...only] = process.argv.slice(2);
if (!inDir || !outDir) { console.error('usage: compress-dino-textures.mjs <in-dir> <out-dir> [name ...]'); process.exit(1); }
await fs.mkdir(outDir, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
});
const imageDecoder = async (buf) => { const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data: new Uint8Array(data) }; };
const common = { isKTX2File: true, generateMipmap: true, imageDecoder };

const files = (await fs.readdir(inDir)).filter((f) => f.endsWith('.glb') && (!only.length || only.includes(path.basename(f, '.glb'))));
for (const f of files) {
  const src = path.join(inDir, f); const before = (await fs.stat(src)).size;
  const doc = await io.read(src); const root = doc.getRoot();
  if (root.listTextures().some((t) => t.getMimeType() === 'image/ktx2')) { console.log('skip (already KTX2)', f); await fs.copyFile(src, path.join(outDir, f)); continue; }
  // 1. strip dead specular / ior extensions, then orphaned textures
  for (const m of root.listMaterials()) { m.setExtension('KHR_materials_specular', null); m.setExtension('KHR_materials_ior', null); }
  for (const e of root.listExtensionsUsed()) if (e.extensionName === KHRMaterialsSpecular.EXTENSION_NAME || e.extensionName === KHRMaterialsIOR.EXTENSION_NAME) e.dispose();
  await doc.transform(prune({ propertyTypes: ['Texture', 'Accessor'], keepAttributes: true }));
  // 2. tiny parts get small textures
  const tris = new Map(); let total = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) { const n = p.getIndices() ? p.getIndices().getCount() / 3 : 0; total += n; const m = p.getMaterial(); if (m) tris.set(m, (tris.get(m) ?? 0) + n); }
  for (const t of root.listTextures()) {
    let share = 0; for (const p of t.listParents()) if (p.propertyType === 'Material') share = Math.max(share, (tris.get(p) ?? 0) / Math.max(1, total));
    const [w] = t.getSize() ?? [0];
    const cap = f === 'food.glb' ? 512 : 1024;   // the food pile is ~2 m across on screen
    if (share >= 0.03 && w > cap) { t.setImage(new Uint8Array(await sharp(Buffer.from(t.getImage())).resize(cap, cap, { fit: 'fill' }).png().toBuffer())); t.setMimeType('image/png'); }
    if (share < 0.03 && w > 256) { t.setImage(new Uint8Array(await sharp(Buffer.from(t.getImage())).resize(256, 256, { fit: 'fill' }).png().toBuffer())); t.setMimeType('image/png'); }
  }
  // 3. KTX2
  await doc.transform(ktx2({ ...common, slots: /^(baseColorTexture|emissiveTexture)$/, isUASTC: false, qualityLevel: 230, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true }));
  await doc.transform(ktx2({ ...common, slots: /^normalTexture$/, isUASTC: true, uastcLDRQualityLevel: 2, enableRDO: true, rdoQualityLevel: 1.5, needSupercompression: true, isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false }));
  await doc.transform(ktx2({ ...common, slots: /^(metallicRoughnessTexture|occlusionTexture)$/, isUASTC: false, qualityLevel: 200, compressionLevel: 2, isPerceptual: false, isSetKTX2SRGBTransferFunc: false }));
  // 4. same Draco settings as blender/postprocess.sh
  const draco = root.listExtensionsUsed().find((e) => e.extensionName === KHRDracoMeshCompression.EXTENSION_NAME) ?? doc.createExtension(KHRDracoMeshCompression);
  draco.setRequired(true).setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER, quantizationBits: { POSITION: 14, NORMAL: 10, TEX_COORD: 12, COLOR: 8, GENERIC: 12 } });
  const bin = await io.writeBinary(doc);
  await fs.writeFile(path.join(outDir, f), bin);
  const gpu = root.listTextures().reduce((s, t) => { const [w, h] = t.getSize() ?? [0, 0]; return s + w * h * 1.33; }, 0);
  console.log(f.padEnd(26), (before / 1048576).toFixed(2), '->', (bin.byteLength / 1048576).toFixed(2), 'MB', `textures ${root.listTextures().length}`, `~gpu ${(gpu / 1048576).toFixed(0)} MB (1 B/px)`);
}
