// Hillshaded top view of the volcano (800 x 800 m around the crater) with lava in red.
//   node scripts/preview-volcano.mjs out.png
import sharp from 'sharp';
import { heightAt, volcanoAt } from '../src/world/heightmap.ts';
import { VOLCANO_CENTER } from '../src/world/biomes.ts';
const N = 800, S = 800;
const buf = Buffer.alloc(N * N * 3);
const H = new Float32Array((N + 1) * (N + 1));
for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H[j * (N + 1) + i] = heightAt(VOLCANO_CENTER[0] + (i / N - 0.5) * S, VOLCANO_CENTER[1] + (j / N - 0.5) * S);
const L = [-0.6, 0.55, -0.58]; const ll = Math.hypot(...L);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const e = S / N;
  const hx = (H[j * (N + 1) + i + 1] - H[j * (N + 1) + i]) / e, hz = (H[(j + 1) * (N + 1) + i] - H[j * (N + 1) + i]) / e;
  const n = [-hx, 1, -hz]; const nl = Math.hypot(...n);
  const sh = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / (nl * ll));
  const x = VOLCANO_CENTER[0] + (i / N - 0.5) * S, z = VOLCANO_CENTER[1] + (j / N - 0.5) * S;
  const v = volcanoAt(x, z);
  const g = 40 + 200 * sh;
  const o = (j * N + i) * 3;
  buf[o] = Math.min(255, g + v.lava * 200); buf[o + 1] = g * (1 - v.lava * 0.6) - v.flow * 25; buf[o + 2] = g * (1 - v.lava * 0.9) - v.flow * 25;
}
await sharp(buf, { raw: { width: N, height: N, channels: 3 } }).png().toFile(process.argv[2] || 'volcano.png');
console.log('ok', H.reduce((a, b) => Math.max(a, b), -1e9).toFixed(1));
