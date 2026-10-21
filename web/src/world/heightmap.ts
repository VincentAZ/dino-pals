// Procedural island heightfield + ground layer weights. Pure TS (no three).
import { Simplex2, clamp, lerp, smoothstep } from '../util/noise.ts';
import {
  BIOME_IDS, BIOMES, HALF, L, LAKE_CENTER, LAKE_LEVEL, LAKE_RADIUS, LAYER_COUNT, LAGOON_CENTER, SEA_LEVEL,
  SWAMP_POOL_LEVEL, VOLCANO_CENTER, biomeWeights,
} from './biomes.ts';

const n1 = new Simplex2(101);
const n2 = new Simplex2(202);
const n3 = new Simplex2(303);

/** River polyline from the lake outlet to the sea (x,z). Water level is interpolated along it. */
export const RIVER: [number, number][] = [
  [-150, -30], [-110, 90], [-70, 200], [-20, 300], [50, 390], [110, 470], [160, 560],
];
const riverLen: number[] = [0];
for (let i = 1; i < RIVER.length; i++) {
  const dx = RIVER[i][0] - RIVER[i - 1][0], dz = RIVER[i][1] - RIVER[i - 1][1];
  riverLen.push(riverLen[i - 1] + Math.hypot(dx, dz));
}
const RIVER_TOTAL = riverLen[riverLen.length - 1];

/** Distance to the river centreline and the water surface height there. */
export function riverInfo(x: number, z: number): { d: number; y: number; t: number } {
  let best = 1e9, bestT = 0;
  for (let i = 1; i < RIVER.length; i++) {
    const ax = RIVER[i - 1][0], az = RIVER[i - 1][1], bx = RIVER[i][0], bz = RIVER[i][1];
    const abx = bx - ax, abz = bz - az;
    const l2 = abx * abx + abz * abz;
    let t = ((x - ax) * abx + (z - az) * abz) / l2;
    t = clamp(t, 0, 1);
    const px = ax + abx * t, pz = az + abz * t;
    // meander wobble
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bestT = (riverLen[i - 1] + t * (riverLen[i] - riverLen[i - 1])) / RIVER_TOTAL; }
  }
  const wob = n3.fbm(x * 0.02, z * 0.02, 2) * 6;
  const y = lerp(LAKE_LEVEL, SEA_LEVEL - 0.6, Math.pow(bestT, 0.8));
  return { d: Math.max(0, best + wob), y, t: bestT };
}

function islandMask(x: number, z: number): number {
  const r = Math.hypot(x, z) / HALF;
  const ang = Math.atan2(z, x);
  const coast = n1.fbm(Math.cos(ang) * 1.7 + 11, Math.sin(ang) * 1.7 + 5, 3) * 0.17;
  const southness = smoothstep(-0.2, 1, z / Math.max(1, Math.hypot(x, z)));
  const soft = 0.2 + 0.3 * southness; // south coast shelves gently; others are steeper
  const edge = 1.02 + coast;
  return smoothstep(edge, edge - soft, r);
}

const tmpW = new Float32Array(BIOME_IDS.length);

// ---------- volcano ----------
/** Lava channels: bearing (rad, atan2(z, x) around the crater) and length down the slope (m). */
const LAVA_CHANNELS: { a: number; len: number }[] = [
  { a: 1.43, len: 292 }, { a: 1.96, len: 252 }, { a: 3.72, len: 262 }, { a: 5.3, len: 238 }, { a: 0.42, len: 222 },
];
export interface VolcanoInfo { h: number; lava: number; flow: number; dv: number }
const sq = (v: number) => v * v;
/** Shape of the volcano at (x,z): relief (m), molten lava mask, old basalt-flow mask. */
export function volcanoAt(x: number, z: number, out: VolcanoInfo = { h: 0, lava: 0, flow: 0, dv: 0 }): VolcanoInfo {
  const dx = x - VOLCANO_CENTER[0], dz = z - VOLCANO_CENTER[1];
  const dv = Math.hypot(dx, dz); out.dv = dv;
  if (dv > 390) { out.h = 0; out.lava = 0; out.flow = 0; return out; }
  const ang = Math.atan2(dz, dx);
  let h = Math.pow(smoothstep(340, 22, dv), 1.35) * 176;
  // crater bowl with a raised, broken rim
  h -= smoothstep(58, 15, dv) * 50;
  h += Math.exp(-sq((dv - 55) / 9)) * (5 + 3 * n3.noise(ang * 3, 1.7));
  // radial gullies and spurs, warped so they wander like real erosion
  const warp = n2.noise(x * 0.0045, z * 0.0045) * 0.9 + n3.noise(x * 0.013, z * 0.013) * 0.25;
  const env = smoothstep(48, 115, dv) * smoothstep(350, 190, dv);
  const g1 = Math.abs(Math.sin(ang * 11 + warp * 3.4 + dv * 0.006));
  const g3 = Math.abs(Math.sin(ang * 17.3 + warp * 4.1 - dv * 0.004 + 1.3));
  const g2 = Math.abs(Math.sin(ang * 37 + warp * 6 - dv * 0.011));
  const a1 = 0.35 + 0.9 * smoothstep(-0.4, 0.5, n1.noise(ang * 2.3 + 4, dv * 0.006));
  const a3 = 0.3 + 0.8 * smoothstep(-0.3, 0.6, n2.noise(ang * 3.1, dv * 0.008 + 7));
  h += ((Math.pow(Math.min(g1, g3 + 0.25), 0.5) - 0.62) * 9 * a1 + (Math.pow(g3, 0.55) - 0.6) * 5 * a3 + (Math.pow(g2, 0.6) - 0.6) * 3.2) * env;
  // rugged rock at two scales
  const rough = smoothstep(390, 120, dv);
  h += ((n2.ridged(x * 0.022 + 5, z * 0.022, 3) - 0.35) * 7 + (n1.ridged(x * 0.07, z * 0.07, 2) - 0.35) * 1.7) * rough;
  // old lava-flow lobes (radial streaks) on the lower slopes
  const flowN = n1.noise(ang * 5.5 + warp, dv * 0.0045 + 3.1) * 0.7 + n3.noise(ang * 13, dv * 0.012) * 0.3;
  const flow = smoothstep(0.08, 0.32, flowN) * smoothstep(380, 150, dv);
  h += flow * (2.2 + n2.noise(x * 0.04, z * 0.04) * 1.5) * smoothstep(60, 140, dv);
  // lava channels running from the rim, with raised levees either side
  let lava = 0;
  for (const ch of LAVA_CHANNELS) {
    let da = ang - ch.a; if (da > Math.PI) da -= Math.PI * 2; if (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 0.7) continue;
    const along = smoothstep(50, 74, dv) * smoothstep(ch.len, ch.len - 45, dv);
    if (along <= 0) continue;
    const meander = Math.sin(dv * 0.027 + ch.a * 3) * 9 + n3.noise(dv * 0.011, ch.a * 10) * 7;
    const d = Math.abs(da * dv - meander);
    const w = 4.2 + dv * 0.013;
    h += (2.6 * Math.exp(-sq((d - w * 1.1) / 2.8)) - 3.4 * smoothstep(w * 1.2, w * 0.2, d)) * along;
    lava = Math.max(lava, smoothstep(w * 0.95, w * 0.4, d) * along);
  }
  lava = Math.max(lava, smoothstep(27, 15, dv)); // crater lava lake
  out.h = h; out.lava = lava; out.flow = flow;
  return out;
}
const tmpV: VolcanoInfo = { h: 0, lava: 0, flow: 0, dv: 0 };

/** Terrain height in metres at world (x,z). Sea level is 0. */
export function heightAt(x: number, z: number): number {
  const mask = islandMask(x, z);
  const base = -30 + 32 * Math.pow(mask, 0.8); // -30 (sea floor) .. +2 (shore)
  if (mask <= 0.001) return base + n1.noise(x * 0.01, z * 0.01) * 1.5;

  const { w } = biomeWeights(x, z, tmpW);
  const bw = (i: number) => w[i];
  // 0 meadow 1 jungle 2 volcano 3 beach 4 swamp 5 snow 6 canyon 7 lake
  const roll = n1.fbm(x * 0.006, z * 0.006, 4);
  const detail = n2.fbm(x * 0.03, z * 0.03, 3);
  let relief = 0;
  // meadow: rolling hills
  relief += bw(0) * (4 + roll * 7 + detail * 0.8);
  // jungle: steeper hills
  relief += bw(1) * (9 + roll * 11 + n2.ridged(x * 0.007, z * 0.007, 2) * 9 + detail * 1.2);
  // volcano: rugged cone with gullies, flow lobes and lava channels
  relief += bw(2) * (6 + roll * 5 + detail) + volcanoAt(x, z, tmpV).h;
  // beach: flat sand, lagoon dip
  {
    const dl = Math.hypot(x - LAGOON_CENTER[0], z - LAGOON_CENTER[1]);
    const lagoon = smoothstep(110, 40, dl) * 6;
    relief += bw(3) * (1.6 + roll * 1.2 + detail * 0.3) - lagoon * Math.max(bw(3), 0.5);
  }
  // swamp: low with pools
  {
    const pools = smoothstep(0.05, -0.35, n3.fbm(x * 0.02 + 50, z * 0.02, 3)) * 3.4;
    relief += bw(4) * (1.7 + roll * 1.1 + detail * 0.35 - pools * 1.25);
  }
  // snow highlands: plateau + ridges
  relief += bw(5) * (48 + roll * 13 + n2.ridged(x * 0.005, z * 0.005, 3) * 16 + detail * 1.2);
  // canyon: red plateau carved by winding canyons
  {
    const chan = n3.ridged(x * 0.006 + 3, z * 0.006, 2);
    const carve = smoothstep(0.66, 0.95, chan) * 30;
    const mesa = smoothstep(0.3, 0.6, n1.noise(x * 0.01 + 9, z * 0.01)) * 12;
    // stepped terraces with near-vertical faces
    const raw = 26 + roll * 6 + mesa - carve;
    const step = 9; const t = raw / step; const ft = t - Math.floor(t);
    const terraced = (Math.floor(t) + smoothstep(0.8, 1.0, ft)) * step;
    relief += bw(6) * (terraced + detail * 0.6);
  }
  // lake region around the water: gentle shore
  relief += bw(7) * (6 + roll * 4 + detail * 0.5);

  let h = base + Math.pow(mask, 1.3) * relief;

  // Lake basin
  {
    const dl = Math.hypot(x - LAKE_CENTER[0], z - LAKE_CENTER[1]);
    const inside = smoothstep(LAKE_RADIUS + 25, LAKE_RADIUS - 30, dl + n1.noise(x * 0.01, z * 0.01) * 18);
    const floor = LAKE_LEVEL - 9 + n2.noise(x * 0.03, z * 0.03) * 1.2;
    h = lerp(h, Math.min(h, floor), inside);
    // keep the shore above water
    const shore = smoothstep(LAKE_RADIUS + 90, LAKE_RADIUS + 20, dl) * (1 - inside);
    h = lerp(h, Math.max(h, LAKE_LEVEL + 1.4 + roll * 2), shore);
  }
  // River valley
  {
    const r = riverInfo(x, z);
    const chan = smoothstep(13, 3.5, r.d);
    const valley = smoothstep(42, 10, r.d);
    h = lerp(h, Math.min(h, r.y + 1.2 + roll * 1.5), valley);
    h = lerp(h, Math.min(h, r.y - 2.2), chan);
  }
  // Make sure the sea near the beach biome is shallow and sandy
  return h;
}

/** Approximate slope (0 flat .. 1 vertical) via finite differences. */
export function slopeAt(x: number, z: number, e = 1.5): number {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const g = Math.hypot(hx, hz) / (2 * e);
  return g / Math.sqrt(1 + g * g);
}

export interface WaterInfo { level: number; kind: 'sea' | 'lake' | 'river' | 'pool' | 'none' }
/** Water surface level at (x,z) if there is water above the terrain there. */
export function waterAt(x: number, z: number): WaterInfo {
  const h = heightAt(x, z);
  if (h < SEA_LEVEL) return { level: SEA_LEVEL, kind: 'sea' };
  const dl = Math.hypot(x - LAKE_CENTER[0], z - LAKE_CENTER[1]);
  if (dl < LAKE_RADIUS + 40 && h < LAKE_LEVEL) return { level: LAKE_LEVEL, kind: 'lake' };
  const r = riverInfo(x, z);
  if (r.d < 20 && h < r.y) return { level: r.y, kind: 'river' };
  const { w } = biomeWeights(x, z, tmpW);
  if (w[4] > 0.35 && h < SWAMP_POOL_LEVEL) return { level: SWAMP_POOL_LEVEL, kind: 'pool' };
  return { level: -Infinity, kind: 'none' };
}

/** Ground layer weights (LAYER_COUNT floats, sum to 1) for the splat map. */
export function layerWeightsAt(x: number, z: number, out?: Float32Array): Float32Array {
  const o = out ?? new Float32Array(LAYER_COUNT);
  o.fill(0);
  const h = heightAt(x, z);
  const slope = slopeAt(x, z, 2.5);
  const { w } = biomeWeights(x, z, tmpW);
  const varn = n3.fbm(x * 0.015 + 100, z * 0.015, 3) * 0.5 + 0.5; // patchiness
  // base per biome
  o[L.grass] += w[0] * (0.75 - varn * 0.3) + w[7] * 0.5;
  o[L.grassRock] += w[0] * (0.25 + varn * 0.3) + w[7] * 0.3 + w[1] * 0.1;
  o[L.forestFloor] += w[1] * (0.62 + varn * 0.15);
  o[L.leaves] += w[1] * (0.2 - varn * 0.12) + w[4] * 0.25;
  o[L.grass] += w[1] * 0.12;
  o[L.sand] += w[3] * 0.85;
  o[L.wetSand] += w[3] * 0.15;
  o[L.mud] += w[4] * (0.38 + varn * 0.15) + w[7] * 0.2;
  o[L.swampMoss] += w[4] * (0.42 - varn * 0.15);
  o[L.grass] += w[4] * 0.1;
  o[L.redGround] += w[6] * (0.7 + varn * 0.2);
  o[L.riverbed] += w[6] * (0.3 - varn * 0.2);
  const vol = volcanoAt(x, z, tmpV);
  o[L.ash] += w[2] * 1.4 * (0.8 - vol.flow * 0.6);
  o[L.lavaRock] += w[2] * 1.4 * (0.2 + vol.flow * 0.6);
  o[L.snow] += w[5] * 0.8;
  o[L.cliff] += w[5] * 0.2;
  // height rules: shoreline sand, snow caps, lava near crater
  const shore = smoothstep(3.2, 0.6, h);
  const wet = smoothstep(1.2, -3, h);
  for (let i = 0; i < LAYER_COUNT; i++) o[i] *= 1 - shore;
  // swamp banks are mud and moss, not beach sand
  const sw = smoothstep(0.25, 0.55, w[4]);
  o[L.sand] += shore * (1 - wet) * (1 - sw);
  o[L.wetSand] += shore * wet * (1 - sw);
  o[L.mud] += shore * sw * 0.7; o[L.swampMoss] += shore * sw * 0.3;
  const snowCap = smoothstep(95, 125, h) * (1 - w[2]);
  for (let i = 0; i < LAYER_COUNT; i++) o[i] *= 1 - snowCap;
  o[L.snow] += snowCap;
  // river bed
  const r = riverInfo(x, z);
  const bed = smoothstep(16, 5, r.d) * (1 - w[2]);
  for (let i = 0; i < LAYER_COUNT; i++) o[i] *= 1 - bed;
  o[L.riverbed] += bed * 0.7; o[L.wetSand] += bed * 0.3;
  // slope -> cliff rock (strong), volcano slopes stay dark rock
  const steep = smoothstep(0.42, 0.7, slope);
  const cliffLayer = w[2] > 0.45 ? L.lavaRock : w[6] > 0.4 ? L.redCliff : L.cliff;
  for (let i = 0; i < LAYER_COUNT; i++) o[i] *= 1 - steep;
  o[cliffLayer] += steep;
  // molten lava in the channels and the crater
  if (vol.lava > 0) { for (let i = 0; i < LAYER_COUNT; i++) o[i] *= 1 - vol.lava; o[L.lava] += vol.lava; }
  let s = 0;
  for (let i = 0; i < LAYER_COUNT; i++) s += o[i];
  for (let i = 0; i < LAYER_COUNT; i++) o[i] /= s || 1;
  return o;
}

export { BIOMES };
