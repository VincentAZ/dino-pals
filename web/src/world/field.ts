// The "ground field": a tileable macro-noise texture plus the grass palette per
// ground layer. The terrain shader and the grass blades evaluate the same
// function (GLSL here, mirrored in JS for per-clump colours on the CPU), so the
// grass colour fades seamlessly into the ground colour with distance.
// Pure TS (no three) so the terrain worker can build the noise texture.
import { LAYER_COUNT, L } from './biomes.ts';

export const FIELD_RES = 256;
/** world size (m) of one tile of the field noise at the two scales used */
export const FIELD_SCALE_A = 211; // macro patches
export const FIELD_SCALE_B = 37;  // meso patches

// ---------- tileable gradient noise ----------
function hashI(i: number, j: number, seed: number): number {
  let h = (i * 374761393 + j * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function periodic(x: number, y: number, p: number, seed: number): number {
  const i0 = Math.floor(x), j0 = Math.floor(y);
  const fx = x - i0, fy = y - j0;
  const g = (i: number, j: number, dx: number, dy: number) => { const a = hashI(((i % p) + p) % p, ((j % p) + p) % p, seed) * Math.PI * 2; return Math.cos(a) * dx + Math.sin(a) * dy; };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(i0, j0, fx, fy), n10 = g(i0 + 1, j0, fx - 1, fy), n01 = g(i0, j0 + 1, fx, fy - 1), n11 = g(i0 + 1, j0 + 1, fx - 1, fy - 1);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v; // ~[-0.7, 0.7]
}
function fbmTile(u: number, v: number, periods: number[], seed: number): number {
  let s = 0, a = 1, n = 0;
  for (const p of periods) { s += a * periodic(u * p, v * p, p, seed + p); n += a; a *= 0.55; }
  return s / n;
}

/** RGBA8 tileable fbm noise (each channel a different seed / band). Values centred on 0.5. */
export function buildFieldNoise(res = FIELD_RES): Uint8Array {
  const out = new Uint8Array(res * res * 4);
  const bands = [[4, 8, 16, 32], [3, 6, 12, 24], [8, 16, 32, 64], [5, 10, 20, 40]];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const u = i / res, v = j / res; const o = (j * res + i) * 4;
    for (let c = 0; c < 4; c++) {
      const val = fbmTile(u, v, bands[c], 11 + c * 7) * 1.25 + 0.5;
      out[o + c] = Math.max(0, Math.min(255, Math.round(val * 255)));
    }
  }
  return out;
}

// ---------- grass palette per ground layer (sRGB 0-255) ----------
// coverage = how much of that ground is grown over with grass (0..1)
const PAL: { col: [number, number, number]; cov: number; reed: number; tuft: number; dry: number }[] = Array.from({ length: LAYER_COUNT }, () => ({ col: [120, 120, 80] as [number, number, number], cov: 0, reed: 0, tuft: 0, dry: 0 }));
PAL[L.grass] = { col: [86, 110, 44], cov: 1.0, reed: 0, tuft: 0, dry: 0.55 };
PAL[L.grassRock] = { col: [100, 114, 52], cov: 0.8, reed: 0, tuft: 0.1, dry: 0.7 };
PAL[L.forestFloor] = { col: [62, 88, 36], cov: 0.42, reed: 0, tuft: 0, dry: 0.15 };
PAL[L.leaves] = { col: [86, 100, 42], cov: 0.3, reed: 0.2, tuft: 0, dry: 0.2 };
PAL[L.sand] = { col: [156, 150, 92], cov: 0.014, reed: 0, tuft: 1, dry: 0.6 };
PAL[L.mud] = { col: [92, 104, 48], cov: 0.62, reed: 1, tuft: 0, dry: 0.25 };
PAL[L.redGround] = { col: [176, 150, 84], cov: 0.11, reed: 0, tuft: 1, dry: 0.9 };
PAL[L.riverbed] = { col: [140, 132, 80], cov: 0.06, reed: 0, tuft: 1, dry: 0.5 };
PAL[L.swampMoss] = { col: [80, 96, 44], cov: 0.55, reed: 0.7, tuft: 0, dry: 0.2 };
PAL[L.ash] = { col: [128, 118, 78], cov: 0.05, reed: 0, tuft: 1, dry: 0.95 };
export const DRY_SRGB: [number, number, number] = [160, 142, 86];

const toLin = (c: number) => Math.pow(c / 255, 2.2);
export const GRASS_COL_LIN: [number, number, number][] = PAL.map((p) => [toLin(p.col[0]), toLin(p.col[1]), toLin(p.col[2])]);
export const GRASS_COV = PAL.map((p) => p.cov);
export const GRASS_DRY = PAL.map((p) => p.dry);
export const GRASS_REED = PAL.map((p) => p.reed);
export const GRASS_TUFT = PAL.map((p) => p.tuft);
export const DRY_LIN: [number, number, number] = [toLin(DRY_SRGB[0]), toLin(DRY_SRGB[1]), toLin(DRY_SRGB[2])];

/** GLSL: needs uniforms uField (sampler2D), uGrassCol[], uGrassCov[], uGrassDry[], uDryCol. */
export const FIELD_GLSL = /* glsl */ `
uniform sampler2D uField;
uniform vec3 uGrassCol[${LAYER_COUNT}]; uniform float uGrassCov[${LAYER_COUNT}]; uniform float uGrassDry[${LAYER_COUNT}]; uniform vec3 uDryCol;
// rgb: grass colour (linear), a: coverage 0..1
vec4 grassField(vec2 xz, float w[${LAYER_COUNT}]) {
  vec3 c = vec3(0.0); float cov = 0.0; float dryAmt = 0.0; float cw = 0.0;
  for (int i = 0; i < ${LAYER_COUNT}; i++) { float k = w[i] * uGrassCov[i]; float kc = w[i] * sqrt(uGrassCov[i]); c += kc * uGrassCol[i]; cov += k; dryAmt += kc * uGrassDry[i]; cw += kc; }
  c /= max(cw, 1e-4); dryAmt /= max(cw, 1e-4);
  vec4 nA = texture(uField, xz / ${FIELD_SCALE_A.toFixed(1)});
  vec4 nB = texture(uField, xz / ${FIELD_SCALE_B.toFixed(1)});
  float dry = smoothstep(0.5, 0.78, nA.g * 0.65 + nB.r * 0.35) * dryAmt;
  c = mix(c, uDryCol, dry * 0.75);
  c *= 0.84 + 0.32 * nB.a;
  c = mix(c, c * vec3(1.08, 1.04, 0.72), smoothstep(0.35, 0.75, nA.b) * 0.6);
  cov *= smoothstep(0.12, 0.42, nA.a * 0.55 + nB.g * 0.45);
  // nothing grows on snow, fresh volcanic rock and cinders or bare cliffs; the weathered ash of the volcano's apron takes sparse tufts
  cov *= 1.0 - smoothstep(0.04, 0.3, w[${L.snow}] + w[${L.lavaRock}] + w[${L.cinder}] + w[${L.aa}] + w[${L.ash}] * 0.3 + w[${L.lava}] + w[${L.cliff}] * 0.6 + w[${L.redCliff}] * 0.6);
  return vec4(c, cov);
}`;

// ---------- CPU mirror ----------
export interface FieldSampler { noise: Uint8Array; res: number }
const tmp4a = new Float32Array(4), tmp4b = new Float32Array(4);
/** Bilinear wrap sample of the field noise (0..1 per channel), like GL_REPEAT + LINEAR. */
export function sampleField(f: FieldSampler, u: number, v: number, out: Float32Array): Float32Array {
  const r = f.res;
  const x = u * r - 0.5, y = v * r - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y); const fx = x - x0, fy = y - y0;
  const xi = ((x0 % r) + r) % r, yi = ((y0 % r) + r) % r, xi1 = (xi + 1) % r, yi1 = (yi + 1) % r;
  const d = f.noise;
  for (let c = 0; c < 4; c++) {
    const a = d[(yi * r + xi) * 4 + c], b = d[(yi * r + xi1) * 4 + c], e = d[(yi1 * r + xi) * 4 + c], g = d[(yi1 * r + xi1) * 4 + c];
    out[c] = ((a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + g * fx) * fy) / 255;
  }
  return out;
}
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface FieldResult { r: number; g: number; b: number; cov: number; reed: number; tuft: number; hVar: number }
/** Same as grassField() in GLSL, plus blade-type weights and a height-variation term. */
export function grassFieldAt(f: FieldSampler, x: number, z: number, w: ArrayLike<number>, out: FieldResult): FieldResult {
  let r = 0, g = 0, b = 0, cov = 0, dryAmt = 0, reed = 0, tuft = 0, cw = 0;
  for (let i = 0; i < LAYER_COUNT; i++) {
    const k = w[i] * GRASS_COV[i]; if (k <= 0) continue;
    const kc = w[i] * Math.sqrt(GRASS_COV[i]);
    r += kc * GRASS_COL_LIN[i][0]; g += kc * GRASS_COL_LIN[i][1]; b += kc * GRASS_COL_LIN[i][2]; cov += k; dryAmt += kc * GRASS_DRY[i];
    reed += kc * GRASS_REED[i]; tuft += kc * GRASS_TUFT[i]; cw += kc;
  }
  const inv = 1 / Math.max(cw, 1e-4); r *= inv; g *= inv; b *= inv; dryAmt *= inv; reed *= inv; tuft *= inv;
  const nA = sampleField(f, x / FIELD_SCALE_A, z / FIELD_SCALE_A, tmp4a);
  const nB = sampleField(f, x / FIELD_SCALE_B, z / FIELD_SCALE_B, tmp4b);
  const dry = ss(0.5, 0.78, nA[1] * 0.65 + nB[0] * 0.35) * dryAmt * 0.75;
  r += (DRY_LIN[0] - r) * dry; g += (DRY_LIN[1] - g) * dry; b += (DRY_LIN[2] - b) * dry;
  const br = 0.84 + 0.32 * nB[3]; r *= br; g *= br; b *= br;
  const y = ss(0.35, 0.75, nA[2]) * 0.6; r *= 1 + 0.08 * y; g *= 1 + 0.04 * y; b *= 1 - 0.28 * y;
  cov *= ss(0.12, 0.42, nA[3] * 0.55 + nB[1] * 0.45);
  cov *= 1 - ss(0.04, 0.3, w[L.snow] + w[L.lavaRock] + w[L.cinder] + w[L.aa] + w[L.ash] * 0.3 + w[L.lava] + w[L.cliff] * 0.6 + w[L.redCliff] * 0.6);
  out.r = r; out.g = g; out.b = b; out.cov = cov; out.reed = reed; out.tuft = tuft; out.hVar = nB[0] * 0.6 + nA[1] * 0.4;
  return out;
}

/** Bilinear sample of the LAYER_COUNT-channel splat map (planes of RGBA8), like LINEAR + CLAMP. */
export function sampleSplat(data: Uint8Array, res: number, u: number, v: number, out: Float32Array): Float32Array {
  const x = Math.min(res - 1, Math.max(0, u * res - 0.5)), y = Math.min(res - 1, Math.max(0, v * res - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y); const fx = x - x0, fy = y - y0;
  const x1 = Math.min(res - 1, x0 + 1), y1 = Math.min(res - 1, y0 + 1);
  const plane = res * res * 4;
  for (let l = 0; l < LAYER_COUNT; l++) {
    const p = (l >> 2) * plane, c = l & 3;
    const a = data[p + (y0 * res + x0) * 4 + c], b = data[p + (y0 * res + x1) * 4 + c], e = data[p + (y1 * res + x0) * 4 + c], g = data[p + (y1 * res + x1) * 4 + c];
    out[l] = ((a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + g * fx) * fy) / 255;
  }
  return out;
}

/** The terrain shader's steep-slope rock override (slope = 1 - normal.y): grey cliff rock,
 *  red layered sandstone in the canyon, basalt on the volcano. Mirrors STEEP_GLSL. */
export function applySteep(w: Float32Array, slope: number): void {
  const steep = ss(0.36, 0.6, slope);
  const cliffW = steep * (1 - Math.min(1, w[L.lavaRock] + w[L.cliff] + w[L.redCliff] + w[L.lava]));
  if (cliffW <= 0) return;
  const rv = ss(0.2, 0.5, w[L.lavaRock] + w[L.ash] + w[L.lava] + w[L.cinder] + w[L.aa]), rc = ss(0.2, 0.5, w[L.redGround] + w[L.redCliff]) * (1 - rv);
  for (let i = 0; i < LAYER_COUNT; i++) w[i] *= 1 - cliffW;
  w[L.lavaRock] += cliffW * rv; w[L.redCliff] += cliffW * rc; w[L.cliff] += cliffW * (1 - rv - rc);
}
export const STEEP_GLSL = /* glsl */ `
void applySteep(inout float w[${LAYER_COUNT}], float slope) {
  float steep = smoothstep(0.36, 0.6, slope);
  float cliffW = steep * (1.0 - min(1.0, w[${L.lavaRock}] + w[${L.cliff}] + w[${L.redCliff}] + w[${L.lava}]));
  if (cliffW <= 0.0) return;
  float rv = smoothstep(0.2, 0.5, w[${L.lavaRock}] + w[${L.ash}] + w[${L.lava}] + w[${L.cinder}] + w[${L.aa}]);
  float rc = smoothstep(0.2, 0.5, w[${L.redGround}] + w[${L.redCliff}]) * (1.0 - rv);
  for (int i = 0; i < ${LAYER_COUNT}; i++) w[i] *= 1.0 - cliffW;
  w[${L.lavaRock}] += cliffW * rv; w[${L.redCliff}] += cliffW * rc; w[${L.cliff}] += cliffW * (1.0 - rv - rc);
}`;
