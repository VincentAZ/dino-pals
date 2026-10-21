// Keeps only the credits of environment assets that are actually shipped
// (GLBs in public/assets/env and the ground texture sets).
import fs from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV = path.join(ROOT, 'public', 'assets', 'env');
const file = path.join(ENV, 'credits.json');
const credits = JSON.parse(await fs.readFile(file, 'utf8'));
const shipped = new Set();
for (const f of await fs.readdir(ENV)) if (f.endsWith('.glb')) shipped.add(f.replace('.glb', ''));
for (const f of await fs.readdir(path.join(ENV, 'ground'))) shipped.add(f.replace(/_(a|b)_\d+\.webp$/, ''));
const before = Object.keys(credits.assets).length;
credits.assets = Object.fromEntries(Object.entries(credits.assets).filter(([k]) => shipped.has(k)));
await fs.writeFile(file, JSON.stringify(credits, null, 2));
console.log(`credits: ${before} -> ${Object.keys(credits.assets).length}`, [...shipped].filter((k) => !credits.assets[k]));
