// Bytes of the environment data the app downloads: every vegetation GLB (+ needle atlases) is queued
// at start-up, the 512 ground layers load before the world shows; the 1024 KTX2 layers stream in
// afterwards on the high tier only.  node scripts/env-bytes.mjs [web-dir]
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const ENV = path.join(ROOT, 'public', 'assets', 'env');
const size = async (f) => (await fs.stat(f)).size;
let veg = 0, ground = 0, lazy = 0;
for (const f of await fs.readdir(ENV)) if (/\.(glb|ktx2)$/.test(f)) veg += await size(path.join(ENV, f));
for (const f of await fs.readdir(path.join(ENV, 'ground'))) {
  const s = await size(path.join(ENV, 'ground', f));
  if (f.endsWith('.ktx2')) lazy += s; else ground += s;
}
const mb = (b) => +(b / 1048576).toFixed(2);
console.log(JSON.stringify({ root: ROOT, vegetationMB: mb(veg), ground512MB: mb(ground), envMB: mb(veg + ground), lazyKtx2HighMB: mb(lazy) }));
