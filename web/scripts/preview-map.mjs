// Renders a top-down preview of the procedural island (heights + biomes) to PNG.
//   node --experimental-strip-types scripts/preview-map.mjs out.png
import sharp from 'sharp';
import { heightAt, layerWeightsAt, waterAt } from '../src/world/heightmap.ts';
import { HALF, LAYER_COUNT } from '../src/world/biomes.ts';
const N = 512; const buf = Buffer.alloc(N * N * 3);
const LAYER_COLORS = [[90,150,50],[120,140,70],[70,60,30],[110,80,40],[230,210,160],[190,170,130],[80,60,40],[180,80,40],[40,35,35],[150,140,120],[240,245,250],[120,115,110]];
const w = new Float32Array(LAYER_COUNT);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = (i / N - 0.5) * 2 * HALF, z = (j / N - 0.5) * 2 * HALF;
  const h = heightAt(x, z);
  const wi = waterAt(x, z);
  let r, g, b;
  if (wi.kind !== 'none') { const d = Math.min(1, (wi.level - h) / 12); r = 40 * (1 - d) + 10; g = 120 * (1 - d) + 40; b = 180 * (1 - d) + 80; }
  else { layerWeightsAt(x, z, w); r = g = b = 0; for (let k = 0; k < LAYER_COUNT; k++) { r += w[k] * LAYER_COLORS[k][0]; g += w[k] * LAYER_COLORS[k][1]; b += w[k] * LAYER_COLORS[k][2]; }
    const shade = 0.6 + 0.4 * Math.min(1, Math.max(0, (heightAt(x - 3, z - 3) - h) * 0.15 + 0.5)); r *= shade; g *= shade; b *= shade; }
  const o = (j * N + i) * 3; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
}
await sharp(buf, { raw: { width: N, height: N, channels: 3 } }).png().toFile(process.argv[2] || 'map.png');
let mn = 1e9, mx = -1e9; for (let j = 0; j < N; j += 4) for (let i = 0; i < N; i += 4) { const h = heightAt((i / N - 0.5) * 2 * HALF, (j / N - 0.5) * 2 * HALF); mn = Math.min(mn, h); mx = Math.max(mx, h); }
console.log('height range', mn.toFixed(1), mx.toFixed(1));
