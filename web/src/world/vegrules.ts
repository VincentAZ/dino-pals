// Which models grow where. Pure TS (used by the terrain worker).
import type { BiomeId } from './biomes.ts';

export type VegKind = 'tree' | 'plant' | 'rock';
export interface VegSpecies {
  id: string;
  kind: VegKind;
  /** max instances per 100x100 chunk at weight 1.0 */
  density: Partial<Record<BiomeId, number>>;
  maxSlope: number;
  /** random scale range, multiplied by baseScale */
  scale: [number, number];
  baseScale: number;
  /** clustering: 0 none .. 1 strong (uses noise to make clearings / groves) */
  cluster: number;
  castShadow: boolean;
  /** render ranges (m): LOD0 up to [0] (0 = never use LOD0), LOD1 up to [1], billboard up to [2] (0 = none) */
  lod: [number, number, number];
  /** minimum spacing from other spaced things */
  spacing: number;
  /** sink into the ground (model units: multiplied by the instance scale) to hide floating roots / rock bases */
  sink: number;
  /** extra sink (m) per unit of slope, so bases stay buried on the downhill side (default 0.5) */
  slopeSink?: number;
  /** may stand in shallow swamp pools */
  inWater?: boolean;
  /** on the volcano, only between these distances (m) from the crater centre and off the flows */
  volcBand?: [number, number];
  /** false: small enough to walk over (no obstacle for the explorer or the dinosaurs) */
  obstacle?: boolean;
  /** density multiplier on the volcano's old lava-flow lobes (a'a rubble) */
  onFlow?: number;
  /** [min, max, radius m]: extra, smaller instances scattered around each placed one (clasts lie in groups) */
  clump?: [number, number, number];
}

const T = (id: string, density: VegSpecies['density'], extra: Partial<VegSpecies> = {}): VegSpecies => ({
  id, kind: 'tree', density, maxSlope: 0.42, scale: [0.85, 1.25], baseScale: 1, cluster: 0.6, castShadow: true, lod: [70, 150, 800], spacing: 6, sink: 0.25, ...extra,
});
const P = (id: string, density: VegSpecies['density'], extra: Partial<VegSpecies> = {}): VegSpecies => ({
  id, kind: 'plant', density, maxSlope: 0.5, scale: [0.8, 1.3], baseScale: 1, cluster: 0.4, castShadow: false, lod: [30, 70, 0], spacing: 0, sink: 0.06, ...extra,
});
const R = (id: string, density: VegSpecies['density'], extra: Partial<VegSpecies> = {}): VegSpecies => ({
  id, kind: 'rock', density, maxSlope: 0.75, scale: [0.7, 1.5], baseScale: 1, cluster: 0.3, castShadow: true, lod: [60, 150, 500], spacing: 3, sink: 0.25, ...extra,
});

export const VEG: VegSpecies[] = [
  // trees (island trees are ~3-5 m, jacaranda/pine/fir ~18 m)
  T('island_tree_01', { jungle: 80, meadow: 2.5, beach: 22, lake: 3 }, { scale: [1.7, 2.6], lod: [24, 58, 800], spacing: 3.5, cluster: 0.15 }),
  T('island_tree_02', { jungle: 70, meadow: 2.0, beach: 18, lake: 2.5 }, { scale: [1.7, 2.6], lod: [24, 58, 800], spacing: 3.5, cluster: 0.15 }),
  T('island_tree_03', { jungle: 50, meadow: 0.8, beach: 4 }, { scale: [1.6, 2.5], lod: [24, 58, 800], spacing: 3.5, cluster: 0.15 }),
  T('jacaranda_tree', { meadow: 2.4, lake: 2.6, jungle: 9 }, { scale: [0.7, 1.1], spacing: 12, lod: [60, 150, 900] }),
  T('tree_small_02', { meadow: 4, lake: 4, jungle: 16, swamp: 1.5 }, { scale: [1.1, 1.8], lod: [30, 80, 700], spacing: 3.5, cluster: 0.2 }),
  T('fir_tree_01', { snow: 20, meadow: 0.3 }, { scale: [0.7, 1.15], maxSlope: 0.5, lod: [55, 150, 900], spacing: 7, sink: 0.3 }),
  T('pine_tree_01', { snow: 14, jungle: 1.5, meadow: 0.4 }, { scale: [0.7, 1.15], maxSlope: 0.5, lod: [50, 150, 900], spacing: 7, sink: 0.3 }),
  T('dead_quiver_trunk', { swamp: 16, volcano: 3, canyon: 1.2 }, { scale: [1.4, 2.4], cluster: 0.3, lod: [70, 150, 700], spacing: 5, sink: 0.4, inWater: true }),
  T('quiver_tree_01', { canyon: 5, beach: 0.5 }, { scale: [1.2, 2.0], cluster: 0.3, lod: [60, 130, 600], spacing: 8, sink: 0.2 }),
  // plants
  P('fern_02', { jungle: 280, swamp: 110, lake: 12, volcano: 55 }, { baseScale: 1.4, scale: [0.8, 1.4], cluster: 0.2, lod: [16, 38, 0], volcBand: [205, 400] }),
  P('shrub_01', { meadow: 8, jungle: 16, beach: 5, lake: 6 }, { lod: [24, 60, 0], sink: 0.1 }),
  P('shrub_02', { meadow: 6, canyon: 12, jungle: 6 }, { lod: [40, 110, 0], sink: 0.15 }),
  P('shrub_03', { meadow: 7, jungle: 18, beach: 4, swamp: 5 }, { lod: [35, 90, 0], sink: 0.1 }),
  P('shrub_04', { meadow: 6, canyon: 8, snow: 3, volcano: 9 }, { lod: [35, 90, 0], sink: 0.1, volcBand: [235, 400] }),
  P('searsia_lucida', { canyon: 12, beach: 4 }, { lod: [40, 110, 0], sink: 0.1 }),
  P('pine_sapling_medium', { snow: 18, meadow: 0.5 }, { lod: [40, 110, 0], sink: 0.1, cluster: 0.5 }),
  P('nettle_plant', { meadow: 10, jungle: 24, swamp: 16 }, { baseScale: 1.6, cluster: 0.5, lod: [30, 70, 0] }),
  P('weed_plant_02', { meadow: 16, jungle: 16, swamp: 20, lake: 16 }, { baseScale: 1.4, lod: [30, 70, 0] }),
  P('wild_rooibos_bush', { canyon: 14, beach: 6, meadow: 2, volcano: 9 }, { lod: [35, 90, 0], sink: 0.1, volcBand: [225, 400] }),
  P('flower_gazania', { meadow: 22, lake: 10 }, { baseScale: 1.4, cluster: 0.8, lod: [16, 34, 0], sink: 0.03 }),
  P('flower_ursinia', { meadow: 22, canyon: 5 }, { baseScale: 1.4, cluster: 0.8, lod: [16, 34, 0], sink: 0.03 }),
  // rocks (rock_07/09/moon are pebbles in the source: scaled up to boulders, so their sink is in pebble units:
  // the old 0.25 buried them completely - 0.14 / 0.03 / 0.06 tall models)
  R('boulder_01', { meadow: 1.5, jungle: 2, canyon: 4, snow: 3, lake: 1 }, { baseScale: 1.6, scale: [0.6, 1.6], spacing: 4 }),
  R('rock_07', { meadow: 2.5, jungle: 3, canyon: 7, snow: 5, volcano: 4 }, { baseScale: 7, scale: [0.5, 1.6], lod: [50, 140, 0], sink: 0.035, slopeSink: 0.25 }),
  R('rock_09', { meadow: 2.5, canyon: 7, snow: 5, beach: 12 }, { baseScale: 12, scale: [0.5, 1.6], lod: [50, 140, 0], sink: 0.008, slopeSink: 0.15 }),
  R('rock_moss_set_01', { jungle: 7, swamp: 7, lake: 4, meadow: 1 }, { scale: [0.8, 1.4], lod: [50, 150, 0], sink: 0.2 }),
  R('namaqualand_boulder_02', { canyon: 9, beach: 9 }, { scale: [0.8, 2.0], cluster: 0.4, spacing: 4, lod: [60, 170, 0] }),
  R('moon_rock_03', { snow: 2 }, { baseScale: 14, scale: [0.5, 1.8], maxSlope: 0.8, lod: [50, 150, 0], sink: 0.014, slopeSink: 0.25 }),
  R('rock_face_01', { volcano: 4, snow: 4, canyon: 3 }, { scale: [0.9, 1.8], maxSlope: 0.9, spacing: 8, sink: 0.6, lod: [80, 180, 600] }),
  R('tree_stump_01', { meadow: 1.5, jungle: 3, snow: 2, swamp: 2 }, { scale: [0.8, 1.3], lod: [50, 110, 0], sink: 0.1 }),
  R('dead_tree_trunk', { swamp: 5, jungle: 2, meadow: 0.8, snow: 1 }, { scale: [0.9, 1.4], lod: [50, 120, 0], sink: 0.1, maxSlope: 0.4, inWater: true }),
  R('dead_tree_trunk_02', { swamp: 4, jungle: 2, meadow: 0.5 }, { scale: [0.9, 1.4], lod: [50, 120, 0], sink: 0.15, maxSlope: 0.4, inWater: true }),
  // ---- added after the original list: a species' placement seed is its index here, so new species go last
  // and the rest of the world keeps its layout
  // young firs (6-9 m) with branches down to knee height, in thickets
  T('fir_sapling_medium', { snow: 16 }, { scale: [0.75, 1.2], maxSlope: 0.5, lod: [50, 120, 700], spacing: 4, sink: 0.12, cluster: 0.55 }),
  // volcanic scatter: basalt blocks, rusty scoria, bombs near the crater and a carpet of small clasts underfoot
  R('volcanic_rock_a', { volcano: 80 }, { baseScale: 9, scale: [0.4, 1.6], maxSlope: 0.8, cluster: 0.45, spacing: 1.0, lod: [32, 80, 0], sink: 0.012, slopeSink: 0.2, onFlow: 2.4 }),
  R('volcanic_rock_b', { volcano: 70 }, { baseScale: 8, scale: [0.4, 1.5], maxSlope: 0.8, cluster: 0.45, spacing: 1.0, lod: [32, 80, 0], sink: 0.012, slopeSink: 0.2, onFlow: 1.6 }),
  R('volcanic_boulder', { volcano: 5 }, { baseScale: 11, scale: [0.6, 1.4], maxSlope: 0.6, cluster: 0.3, spacing: 6, lod: [80, 170, 0], sink: 0.045, slopeSink: 0.4 }),
  R('volcanic_pebbles', { volcano: 360 }, { baseScale: 3.2, scale: [0.5, 1.7], maxSlope: 0.75, cluster: 0.6, spacing: 0, castShadow: false, lod: [20, 40, 0], sink: 0.015, slopeSink: 0.06, obstacle: false, onFlow: 1.5, clump: [0, 3, 1.4] }),
];
export const VEG_BY_ID: Record<string, VegSpecies> = Object.fromEntries(VEG.map((v) => [v.id, v]));

/**
 * Where the foliage starts, as a fraction of the tree's height (default 1/3). Low-crowned conifers keep
 * branches near the ground (the firs' skirt whorls), so even small animals must walk around them.
 */
export const CROWN_BASE: Record<string, number> = { fir_tree_01: 0.08, fir_sapling_medium: 0.05 };

/** Ground contact-occlusion footprint (crown / rock radius in m at scale 1) for the baked terrain AO. */
export const AO_RADIUS: Record<string, number> = {
  island_tree_01: 2.5, island_tree_02: 2.1, island_tree_03: 1.5, jacaranda_tree: 11, tree_small_02: 2.2,
  fir_tree_01: 3.4, pine_tree_01: 4.2, fir_sapling_medium: 2.2, dead_quiver_trunk: 0.5, quiver_tree_01: 0.8,
  boulder_01: 1.0, rock_07: 0.17, rock_09: 0.08, rock_moss_set_01: 1.6, namaqualand_boulder_02: 1.3, moon_rock_03: 0.06,
  rock_face_01: 2.6, tree_stump_01: 0.8, dead_tree_trunk: 1.2, dead_tree_trunk_02: 1.6,
  volcanic_rock_a: 0.05, volcanic_rock_b: 0.05, volcanic_boulder: 0.13,
};
