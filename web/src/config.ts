// Tunables shared across the engine. Quality tiers are applied at runtime.
export const VERSION = '0.1.0';
export const CHUNK_SIZE = 100;
export const CHUNKS_PER_SIDE = 15;
export const CHUNK_LOAD_RADIUS = 450;
export const CHUNK_LOD_DIST = [160, 320]; // < [0] → LOD0, < [1] → LOD1, else LOD2
export const CHUNK_SEGMENTS = [64, 32, 16];
export const EYE_HEIGHT = 1.2;
export const DAY_LENGTH_SEC = 8 * 60;
export const MAX_ANIMATED_DINOS = 12;
export const DINO_SLEEP_DIST = 260;

export interface Quality {
  tier: 'high' | 'low';
  pixelRatio: number;
  shadowMap: number;
  groundTex: 1024 | 512;
  vegDensity: number;
  particleMul: number;
  anisotropy: number;
  shadows: boolean;
}
export const QUALITY_HIGH: Quality = { tier: 'high', pixelRatio: 1.5, shadowMap: 2048, groundTex: 1024, vegDensity: 1, particleMul: 1, anisotropy: 4, shadows: true };
export const QUALITY_LOW: Quality = { tier: 'low', pixelRatio: 1.0, shadowMap: 1024, groundTex: 512, vegDensity: 0.55, particleMul: 0.5, anisotropy: 2, shadows: true };
export let quality: Quality = { ...QUALITY_HIGH };
export function setQuality(q: Quality): void { quality = q; }
