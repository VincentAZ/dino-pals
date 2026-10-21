// Converts the base-colour textures of env GLBs to Basis/KTX2 (ETC1S, sRGB,
// mipmapped) so they stay GPU-compressed (ASTC / ETC2 / BC7) at runtime;
// normal maps stay WebP. Used by fetch-env.mjs and runnable on its own:
//   node scripts/ktx2-env.mjs [file.glb ...]   (default: every public/assets/env/*.glb)
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { ktx2 } from 'ktx2-encoder/gltf-transform';

const imageDecoder = async (buf) => { const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data: new Uint8Array(data) }; };

/** In-place: base-colour textures -> KTX2 ETC1S. */
export async function colourToKtx2(doc) {
  await doc.transform(ktx2({
    slots: /baseColorTexture/, isUASTC: false, qualityLevel: 200, compressionLevel: 2, generateMipmap: true,
    isKTX2File: true, isPerceptual: true, isSetKTX2SRGBTransferFunc: true, imageDecoder,
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const dir = path.join(ROOT, 'public', 'assets', 'env');
  const files = process.argv.slice(2).length ? process.argv.slice(2) : (await fs.readdir(dir)).filter((f) => f.endsWith('.glb')).map((f) => path.join(dir, f));
  await MeshoptDecoder.ready; await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  for (const f of files) {
    const before = (await fs.stat(f)).size;
    const doc = await io.read(f);
    if (doc.getRoot().listTextures().every((t) => t.getMimeType() === 'image/ktx2' || !t.listParents().length)) { console.log('skip', path.basename(f)); continue; }
    await colourToKtx2(doc);
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const bin = await io.writeBinary(doc);
    await fs.writeFile(f, bin);
    console.log(path.basename(f).padEnd(30), (before / 1024).toFixed(0), '->', (bin.byteLength / 1024).toFixed(0), 'KB');
  }
}
