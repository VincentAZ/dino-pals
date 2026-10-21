// Biome layout of the island and the mapping from world position to biome
// weights / ground-texture layers. Pure TS (no three) for node previews.
import { Simplex2, clamp, smoothstep } from '../util/noise.ts';

export type BiomeId = 'meadow' | 'jungle' | 'volcano' | 'beach' | 'swamp' | 'snow' | 'canyon' | 'lake';
export const BIOME_IDS: BiomeId[] = ['meadow', 'jungle', 'volcano', 'beach', 'swamp', 'snow', 'canyon', 'lake'];

export interface BiomeDef {
  id: BiomeId;
  center: [number, number];
  radius: number;
  /** teleport / spawn anchor (may differ from center, e.g. lake shore) */
  anchor: [number, number];
  /** what the camera faces after a teleport */
  focus: [number, number];
  fog: [number, number, number];
  fogDensityMul: number;
}

// World: 1500 m square centred at origin; -z is north.
export const WORLD_SIZE = 1500;
export const HALF = WORLD_SIZE / 2;
export const SEA_LEVEL = 0;
export const LAKE_LEVEL = 4.0;
export const SWAMP_POOL_LEVEL = 1.2;
export const LAKE_CENTER: [number, number] = [-240, -110];
export const LAKE_RADIUS = 125;
export const VOLCANO_CENTER: [number, number] = [20, -520];
export const LAGOON_CENTER: [number, number] = [260, 560];

export const BIOMES: Record<BiomeId, BiomeDef> = {
  meadow: { id: 'meadow', center: [0, 0], radius: 260, anchor: [0, 0], focus: [0, -40], fog: [1, 1, 1], fogDensityMul: 1 },
  jungle: { id: 'jungle', center: [400, -380], radius: 260, anchor: [350, -347], focus: [400, -380], fog: [0.88, 1.0, 0.85], fogDensityMul: 1.0 },
  volcano: { id: 'volcano', center: VOLCANO_CENTER, radius: 280, anchor: [244, -334], focus: VOLCANO_CENTER, fog: [1.05, 0.78, 0.6], fogDensityMul: 1.4 },
  beach: { id: 'beach', center: [190, 500], radius: 300, anchor: [120, 404], focus: [230, 470], fog: [1, 1, 1], fogDensityMul: 0.8 },
  swamp: { id: 'swamp', center: [-520, 120], radius: 240, anchor: [-476, 247], focus: [-520, 120], fog: [0.84, 0.92, 0.8], fogDensityMul: 1.5 },
  snow: { id: 'snow', center: [-410, -430], radius: 260, anchor: [-523, -401], focus: [-410, -430], fog: [1.0, 1.02, 1.08], fogDensityMul: 1.4 },
  canyon: { id: 'canyon', center: [540, 40], radius: 260, anchor: [448, 74], focus: [540, 40], fog: [1.12, 0.86, 0.7], fogDensityMul: 1.0 },
  lake: { id: 'lake', center: LAKE_CENTER, radius: LAKE_RADIUS + 60, anchor: [-102, -90], focus: LAKE_CENTER, fog: [1, 1, 1], fogDensityMul: 1 },
};

/** Ground texture layers (index = layer in the diffuse/normal texture arrays). */
export const GROUND_LAYERS = [
  'grass_ground', 'aerial_grass_rock', 'forest_floor', 'forest_leaves_02', 'coast_sand_01', 'damp_beach_sand',
  'brown_mud', 'cracked_red_ground', 'dark_rock', 'dry_riverbed_rock', 'snow_02', 'aerial_rocks_02',
] as const;
export const L = {
  grass: 0, grassRock: 1, forestFloor: 2, leaves: 3, sand: 4, wetSand: 5, mud: 6, redGround: 7, lavaRock: 8,
  riverbed: 9, snow: 10, cliff: 11,
} as const;
export const LAYER_COUNT = GROUND_LAYERS.length;
/** tiling period in metres for each layer */
export const LAYER_TILE = [3.5, 5, 3, 3, 4, 4, 3.5, 5, 4, 4, 7, 8];
/** roughness per layer */
export const LAYER_ROUGH = [0.95, 0.92, 0.95, 0.95, 0.9, 0.65, 0.8, 0.92, 0.88, 0.88, 0.88, 0.95];
/** colour tint per layer (greener grass, darker mossy forest floor, warmer sand...) */
export const LAYER_TINT: [number, number, number][] = [[0.82, 1.0, 0.72], [0.85, 1.0, 0.8], [0.5, 0.64, 0.42], [0.62, 0.72, 0.48], [1.05, 1.0, 0.92], [0.95, 0.95, 0.9], [0.6, 0.6, 0.5], [1.08, 0.92, 0.82], [0.9, 0.9, 0.9], [0.95, 0.95, 0.92], [1.0, 1.0, 1.04], [0.95, 0.95, 0.95]];

const bn = new Simplex2(4242);

export interface BiomeWeights { w: Float32Array; dominant: BiomeId; }

/** Soft biome weights at a position (sums to 1). Borders are wobbled with noise. */
export function biomeWeights(x: number, z: number, out?: Float32Array): BiomeWeights {
  const w = out ?? new Float32Array(BIOME_IDS.length);
  const wob = 55;
  const nx = x + bn.fbm(x * 0.0035 + 7.1, z * 0.0035, 3) * wob;
  const nz = z + bn.fbm(x * 0.0035, z * 0.0035 + 3.3, 3) * wob;
  let sum = 0;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    const b = BIOMES[BIOME_IDS[i]];
    const dx = nx - b.center[0], dz = nz - b.center[1];
    const d = Math.sqrt(dx * dx + dz * dz) / b.radius;
    let v = Math.exp(-d * d * 2.2);
    if (b.id === 'meadow') v = Math.max(v, 0.08); // default biome everywhere
    if (b.id === 'lake') v = smoothstep(1.0, 0.55, d) * 1.5;
    w[i] = v; sum += v;
  }
  // the volcano biome is the cone itself, whatever the radial falloff says
  const dv = Math.hypot(x - VOLCANO_CENTER[0], z - VOLCANO_CENTER[1]);
  const cone = smoothstep(370, 240, dv);
  if (cone > 0) { const target = Math.max(w[2] / sum, cone); const rest = 1 - target; const otherSum = sum - w[2]; for (let i = 0; i < w.length; i++) w[i] = i === 2 ? target : (otherSum > 0 ? (w[i] / otherSum) * rest : 0); sum = 1; }
  let best = 0;
  for (let i = 0; i < w.length; i++) { w[i] /= sum; if (w[i] > w[best]) best = i; }
  return { w, dominant: BIOME_IDS[best] };
}

export function biomeIndex(id: BiomeId): number { return BIOME_IDS.indexOf(id); }

export function nearestBiome(x: number, z: number): BiomeId {
  return biomeWeights(x, z).dominant;
}

export const clamp01 = (v: number) => clamp(v, 0, 1);
