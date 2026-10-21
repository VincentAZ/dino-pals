// Decode the KTX2 textures inside a GLB (or a .ktx2 file) to PNG with the app's own Basis
// transcoder, to inspect GPU-compression artefacts.
//   node scripts/ktx2-decode.mjs file.glb|file.ktx2 outdir [level]
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const [file, outDir, levelArg] = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const code = await fs.readFile(path.join(ROOT, 'public/basis/basis_transcoder.js'), 'utf8');
const ctx = { module: {}, exports: {}, console, WebAssembly, performance, TextDecoder, setTimeout, clearTimeout };
vm.createContext(ctx); vm.runInContext(code + '\nthis.BASIS = BASIS;', ctx);
const wasmBinary = await fs.readFile(path.join(ROOT, 'public/basis/basis_transcoder.wasm'));
const B = await ctx.BASIS({ wasmBinary });
B.initializeBasis();
await fs.mkdir(outDir, { recursive: true });
const level = +(levelArg ?? 0);
const items = [];
if (file.endsWith('.ktx2')) items.push([path.basename(file, '.ktx2'), await fs.readFile(file)]);
else {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(file);
  for (const t of doc.getRoot().listTextures()) if (t.getMimeType() === 'image/ktx2') items.push([(t.getURI() || t.getName()).replace(/\.[a-z]+$/, ''), t.getImage()]);
}
for (const [name, data] of items) {
  const k = new B.KTX2File(new Uint8Array(data));
  if (!k.isValid()) { console.log(name, 'invalid'); continue; }
  k.startTranscoding();
  const info = k.getImageLevelInfo(level, 0, 0);
  const fmt = 13; // cTFRGBA32
  const size = k.getImageTranscodedSizeInBytes(level, 0, 0, fmt);
  const dst = new Uint8Array(size);
  k.transcodeImage(dst, level, 0, 0, fmt, 0, -1, -1);
  const w = info.origWidth, h = info.origHeight;
  await sharp(Buffer.from(dst), { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(outDir, `${name}_L${level}.png`));
  console.log(name, `${w}x${h}`, k.isUASTC() ? 'UASTC' : 'ETC1S', k.getHasAlpha() ? 'alpha' : '');
  k.close(); k.delete();
}
