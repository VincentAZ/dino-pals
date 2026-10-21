// Micro-benchmark of procedural terrain sampling (heightAt / waterAt / slopeAt). Usage: node scripts/bench-terrain.mjs <tmp-out-dir>
import { build } from 'vite';
import path from 'node:path';
const out = process.argv[2];
const WEB = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
await build({ root: WEB, logLevel: 'error', build: { lib: { entry: WEB + '/src/world/heightmap.ts', formats: ['es'], fileName: 'hm' }, outDir: out, emptyOutDir: true, minify: false } });
const hm = await import(path.join(out, 'hm.js'));
const N = 20000; let s = 0; const t0 = performance.now();
for (let i = 0; i < N; i++) s += hm.heightAt((i * 7.3) % 900 - 450, (i * 3.1) % 900 - 450);
const t1 = performance.now();
for (let i = 0; i < N; i++) s += hm.waterAt((i * 7.3) % 900 - 450, (i * 3.1) % 900 - 450).level > 0 ? 1 : 0;
const t2 = performance.now();
for (let i = 0; i < N; i++) s += hm.slopeAt((i * 7.3) % 900 - 450, (i * 3.1) % 900 - 450, 2);
const t3 = performance.now();
console.log('heightAt us', ((t1 - t0) / N * 1000).toFixed(2), 'waterAt us', ((t2 - t1) / N * 1000).toFixed(2), 'slopeAt us', ((t3 - t2) / N * 1000).toFixed(2), s > 0);
