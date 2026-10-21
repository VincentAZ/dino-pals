import sharp from 'sharp';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const svg = await fs.readFile(new URL('../public/favicon.svg', import.meta.url));
await fs.mkdir(new URL('../public/icons', import.meta.url), { recursive: true });
for (const s of [180, 192, 512]) await sharp(svg, { density: 400 }).resize(s, s).png().toFile(p(`../public/icons/icon-${s}.png`));
// maskable: pad by 10% on a solid background
const inner = await sharp(svg, { density: 400 }).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#7cc4f0' } }).composite([{ input: inner, left: 51, top: 51 }]).png().toFile(p('../public/icons/icon-512-maskable.png'));
console.log('icons ok');
