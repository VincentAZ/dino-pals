// Micro-benchmark of the analytic heightfield (node --experimental-strip-types).
import { heightAt, waterAt } from '../src/world/heightmap.ts';
let s = 0; const N = 200000;
let t0 = performance.now();
for (let i = 0; i < N; i++) s += heightAt((i % 400) * 1.3 - 200, Math.floor(i / 400) * 1.3 - 200);
console.log('heightAt us', ((performance.now() - t0) * 1000 / N).toFixed(2));
t0 = performance.now();
for (let i = 0; i < N / 10; i++) s += waterAt((i % 400) * 1.3 - 200, Math.floor(i / 400) * 1.3 - 200).level;
console.log('waterAt us', ((performance.now() - t0) * 1000 / (N / 10)).toFixed(2), s > 0);
