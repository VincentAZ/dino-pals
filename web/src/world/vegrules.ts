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
  /** sink into the ground (m) to hide floating roots on slopes */
  sink: number;
  /** may stand in shallow swamp pools */
  inWater?: boolean;
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
  T('island_tree_01', { jungle: 80, meadow: 2.5, beach: 22, lake: 3 }, { scale: [1.7, 2.6], lod: [35, 110, 800], spacing: 3.5, cluster: 0.15 }),
  T('island_tree_02', { jungle: 70, meadow: 2.0, beach: 18, lake: 2.5 }, { scale: [1.7, 2.6], lod: [35, 110, 800], spacing: 3.5, cluster: 0.15 }),
  T('island_tree_03', { jungle: 50, meadow: 0.8, beach: 4 }, { scale: [1.6, 2.5], lod: [35, 110, 800], spacing: 3.5, cluster: 0.15 }),
  T('jacaranda_tree', { meadow: 2.4, lake: 2.6, jungle: 9 }, { scale: [0.7, 1.1], spacing: 12, lod: [70, 150, 900] }),
  T('tree_small_02', { meadow: 4, lake: 4, jungle: 16, swamp: 1.5 }, { scale: [1.1, 1.8], lod: [40, 110, 700], spacing: 3.5, cluster: 0.2 }),
  T('fir_tree_01', { snow: 20, meadow: 0.3 }, { scale: [0.7, 1.15], maxSlope: 0.5, lod: [70, 150, 900], spacing: 7, sink: 0.3 }),
  T('pine_tree_01', { snow: 14, jungle: 1.5, meadow: 0.4 }, { scale: [0.7, 1.15], maxSlope: 0.5, lod: [70, 150, 900], spacing: 7, sink: 0.3 }),
  T('dead_quiver_trunk', { swamp: 16, volcano: 3, canyon: 1.2 }, { scale: [1.4, 2.4], cluster: 0.3, lod: [70, 150, 700], spacing: 5, sink: 0.4, inWater: true }),
  T('quiver_tree_01', { canyon: 5, beach: 0.5 }, { scale: [1.2, 2.0], cluster: 0.3, lod: [60, 130, 600], spacing: 8, sink: 0.2 }),
  // plants
  P('fern_02', { jungle: 380, swamp: 110, lake: 12 }, { baseScale: 1.4, scale: [0.8, 1.4], cluster: 0.2, lod: [30, 65, 0] }),
  P('shrub_01', { meadow: 8, jungle: 24, beach: 5, lake: 6 }, { lod: [35, 90, 0], sink: 0.1 }),
  P('shrub_02', { meadow: 6, canyon: 12, jungle: 6 }, { lod: [40, 110, 0], sink: 0.15 }),
  P('shrub_03', { meadow: 7, jungle: 18, beach: 4, swamp: 5 }, { lod: [35, 90, 0], sink: 0.1 }),
  P('shrub_04', { meadow: 6, canyon: 8, snow: 3 }, { lod: [35, 90, 0], sink: 0.1 }),
  P('searsia_lucida', { canyon: 12, beach: 4 }, { lod: [40, 110, 0], sink: 0.1 }),
  P('pine_sapling_medium', { snow: 18, meadow: 0.5 }, { lod: [40, 110, 0], sink: 0.1, cluster: 0.5 }),
  P('grass_medium_01', { meadow: 200, lake: 110, jungle: 50, beach: 15, swamp: 35 }, { baseScale: 3.2, scale: [0.8, 1.4], cluster: 0.3, lod: [0, 55, 0], sink: 0.05 }),
  P('grass_bermuda_01', { meadow: 150, lake: 70, canyon: 15, beach: 35 }, { baseScale: 2.2, scale: [0.8, 1.4], cluster: 0.3, lod: [0, 50, 0], sink: 0.05 }),
  P('nettle_plant', { meadow: 10, jungle: 24, swamp: 16 }, { baseScale: 1.6, cluster: 0.5, lod: [30, 70, 0] }),
  P('weed_plant_02', { meadow: 16, jungle: 16, swamp: 20, lake: 16 }, { baseScale: 1.4, lod: [30, 70, 0] }),
  P('wild_rooibos_bush', { canyon: 14, beach: 6, meadow: 2 }, { lod: [35, 90, 0], sink: 0.1 }),
  P('flower_gazania', { meadow: 35, lake: 12 }, { baseScale: 1.4, cluster: 0.8, lod: [25, 55, 0], sink: 0.03 }),
  P('flower_ursinia', { meadow: 35, canyon: 5 }, { baseScale: 1.4, cluster: 0.8, lod: [25, 55, 0], sink: 0.03 }),
  // rocks (rock_07/09/moon are pebbles in the source: scaled up to boulders)
  R('boulder_01', { meadow: 1.5, jungle: 2, canyon: 4, snow: 3, lake: 1 }, { baseScale: 1.6, scale: [0.6, 1.6], spacing: 4 }),
  R('rock_07', { meadow: 2.5, jungle: 3, canyon: 7, snow: 5, volcano: 4 }, { baseScale: 7, scale: [0.5, 1.6], lod: [50, 140, 0] }),
  R('rock_09', { meadow: 2.5, canyon: 7, snow: 5, beach: 12 }, { baseScale: 12, scale: [0.5, 1.6], lod: [50, 140, 0] }),
  R('rock_moss_set_01', { jungle: 7, swamp: 7, lake: 4, meadow: 1 }, { scale: [0.8, 1.4], lod: [50, 150, 0], sink: 0.2 }),
  R('namaqualand_boulder_02', { canyon: 9, beach: 9 }, { scale: [0.8, 2.0], cluster: 0.4, spacing: 4, lod: [60, 170, 0] }),
  R('moon_rock_03', { volcano: 20, snow: 2 }, { baseScale: 14, scale: [0.5, 1.8], maxSlope: 0.8, lod: [50, 150, 0] }),
  R('rock_face_01', { volcano: 4, snow: 4, canyon: 3 }, { scale: [0.9, 1.8], maxSlope: 0.9, spacing: 8, sink: 0.6, lod: [80, 180, 600] }),
  R('tree_stump_01', { meadow: 1.5, jungle: 3, snow: 2, swamp: 2 }, { scale: [0.8, 1.3], lod: [50, 110, 0], sink: 0.1 }),
  R('dead_tree_trunk', { swamp: 5, jungle: 2, meadow: 0.8, snow: 1 }, { scale: [0.9, 1.4], lod: [50, 120, 0], sink: 0.1, maxSlope: 0.4, inWater: true }),
  R('dead_tree_trunk_02', { swamp: 4, jungle: 2, meadow: 0.5 }, { scale: [0.9, 1.4], lod: [50, 120, 0], sink: 0.15, maxSlope: 0.4, inWater: true }),
];
export const VEG_BY_ID: Record<string, VegSpecies> = Object.fromEntries(VEG.map((v) => [v.id, v]));
