// Chunked, LOD'd procedural terrain with a 16-channel splat PBR shader fed by
// two texture arrays per ground layer (A: albedo + height, B: roughness,
// normal, AO). Per pixel the four strongest layers are height-blended; cliff
// layers use biplanar projection on steep ground; a grit detail texture adds
// small stones near the camera; macro noise breaks tiling; swamp mud is wet
// and puddled; volcanic channels hold flowing, glowing lava. Geometry (with
// baked horizon + contact ambient occlusion) is generated in a worker pool.
import * as THREE from 'three';
import { ktx2Loader } from './ktx2.ts';
import { CHUNK_LOAD_RADIUS, CHUNK_LOD_DIST, CHUNK_SEGMENTS, CHUNK_SIZE, CHUNKS_PER_SIDE, quality } from '../config.ts';
import { DETAIL_TEXTURE, GROUND_LAYERS, HALF, L, LAYER_COUNT, LAYER_DETAIL, LAYER_ROUGH, LAYER_TILE, LAYER_TINT, TEX_LAYERS, texLayerOf } from './biomes.ts';
import { heightAt } from './heightmap.ts';
import type { ChunkRequest, FarRequest, SplatRequest } from './terrain.worker.ts';
import { DRY_LIN, FIELD_GLSL, FIELD_RES, GRASS_COL_LIN, GRASS_COV, GRASS_DRY, STEEP_GLSL, type FieldSampler } from './field.ts';

/** CPU-side copies of the ground data the grass needs (filled by Terrain.init). */
export const groundData = {
  splat: null as Uint8Array | null, splatRes: 512,
  field: null as FieldSampler | null, fieldTex: null as THREE.DataTexture | null,
};

type Pending = { resolve: (v: unknown) => void };

export class TerrainWorkers {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private rr = 0;
  constructor(count = 2) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<{ id: number }>) => {
        const p = this.pending.get(ev.data.id);
        if (p) { this.pending.delete(ev.data.id); p.resolve(ev.data); }
      };
      this.workers.push(w);
    }
  }
  request<T>(msg: Omit<ChunkRequest, 'id'> | Omit<SplatRequest, 'id'> | Omit<FarRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    const w = this.workers[this.rr++ % this.workers.length];
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void });
      w.postMessage({ ...msg, id });
    });
  }
  get inFlight(): number { return this.pending.size; }
}

async function decode(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    // no premultiplication: the alpha channels carry data (height, normal.x)
    return await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch { return null; }
}

/** Uploads N images into a 2D array texture straight through GL (keeps alpha-packed data intact). */
async function loadLayerArray(renderer: THREE.WebGLRenderer, urls: string[], size: number, srgb: boolean, aniso: number): Promise<THREE.DataArrayTexture> {
  const bitmaps = await Promise.all(urls.map(decode));
  const tex = new THREE.DataArrayTexture(null, size, size, urls.length);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = aniso;
  tex.source.dataReady = false; // allocate storage only; layers are uploaded below
  tex.needsUpdate = true;
  renderer.initTexture(tex);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const glTex = (renderer.properties.get(tex) as { __webglTexture: WebGLTexture }).__webglTexture;
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, glTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  const grey = new Uint8Array(size * size * 4).fill(128);
  bitmaps.forEach((bm, i) => {
    if (bm && bm.width === size && bm.height === size) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    else gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, grey);
    bm?.close();
  });
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  renderer.state.unbindTexture();
  return tex;
}

/** Loads N KTX2 (Basis) layers and stacks them into one compressed 2D array texture. */
async function loadKtx2Array(renderer: THREE.WebGLRenderer, urls: string[], size: number, aniso: number): Promise<THREE.CompressedArrayTexture | null> {
  const loader = ktx2Loader(renderer);
  try {
    const texs = await Promise.all(urls.map((u) => loader.loadAsync(u)));
    const first = texs[0] as THREE.CompressedTexture;
    if (!texs.every((t) => (t as THREE.CompressedTexture).isCompressedTexture && t.format === first.format && t.mipmaps && t.mipmaps.length === first.mipmaps.length && t.image.width === size)) return null;
    const mipmaps = first.mipmaps.map((m, level) => {
      const parts = texs.map((t) => (t.mipmaps![level] as { data: Uint8Array }).data);
      const data = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let o = 0; for (const p of parts) { data.set(p, o); o += p.byteLength; }
      return { data, width: m.width, height: m.height };
    });
    const arr = new THREE.CompressedArrayTexture(mipmaps as unknown as ImageData[], size, size, urls.length, first.format as THREE.CompressedPixelFormat, first.type);
    arr.colorSpace = first.colorSpace; arr.wrapS = arr.wrapT = THREE.RepeatWrapping;
    arr.minFilter = THREE.LinearMipmapLinearFilter; arr.magFilter = THREE.LinearFilter; arr.generateMipmaps = false; arr.anisotropy = aniso;
    arr.needsUpdate = true;
    for (const t of texs) t.dispose();
    return arr;
  } catch { return null; }
}

async function loadTexture2D(url: string, srgb: boolean, aniso: number): Promise<THREE.Texture> {
  const bm = await decode(url);
  const t = new THREE.Texture(bm ?? undefined);
  t.flipY = false; t.premultiplyAlpha = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = aniso; t.needsUpdate = !!bm;
  return t;
}

/** Mean linear luminance and colour of a texture (decoded through a small canvas). */
async function meanColour(url: string): Promise<[number, number, number]> {
  const bm = await decode(url); if (!bm) return [0.3, 0.3, 0.3];
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const ctx = c.getContext('2d')!; ctx.drawImage(bm, 0, 0, 32, 32); bm.close();
  const d = ctx.getImageData(0, 0, 32, 32).data; let r = 0, g = 0, b = 0;
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  for (let i = 0; i < d.length; i += 4) { r += lin(d[i]); g += lin(d[i + 1]); b += lin(d[i + 2]); }
  const n = d.length / 4; return [r / n, g / n, b / n];
}

function makeNoiseTexture(): THREE.DataTexture {
  const n = 256; const d = new Uint8Array(n * n * 4);
  // cheap tileable value noise via summed sines of hashed phases (sky, water and weather use it)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i / n) * Math.PI * 2, v = (j / n) * Math.PI * 2;
    const a = Math.sin(u * 3 + Math.sin(v * 2) * 1.3) * Math.cos(v * 3 + Math.sin(u * 4) * 1.1);
    const b = Math.sin(u * 7 + Math.cos(v * 5) * 2.1) * Math.sin(v * 6 + Math.cos(u * 3) * 1.7);
    const c = Math.sin(u * 1 + Math.cos(v * 1) * 0.8) * Math.sin(v * 2 + 0.5);
    const o = (j * n + i) * 4;
    d[o] = Math.round((a * 0.6 + b * 0.4) * 0.5 * 255 + 127);
    d[o + 1] = Math.round((c * 0.7 + a * 0.3) * 0.5 * 255 + 127);
    d[o + 2] = Math.round((b * 0.5 + 0.5) * 255);
    d[o + 3] = 255;
  }
  const t = new THREE.DataTexture(d, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

export interface TerrainUniforms {
  uAlb: { value: THREE.DataArrayTexture | THREE.CompressedArrayTexture | null };
  uNrm: { value: THREE.DataArrayTexture | null };
  uDetA: { value: THREE.Texture | null };
  uDetB: { value: THREE.Texture | null };
  uDetAvg: { value: THREE.Vector3 };
  uSplat0: { value: THREE.Texture | null };
  uSplat1: { value: THREE.Texture | null };
  uSplat2: { value: THREE.Texture | null };
  uSplat3: { value: THREE.Texture | null };
  uSplat4: { value: THREE.Texture | null };
  uNoise: { value: THREE.Texture };
  uTile: { value: number[] };
  uRough: { value: number[] };
  uTint: { value: THREE.Vector3[] };
  uDetail: { value: number[] };
  uWorldHalf: { value: number };
  uTime: { value: number };
  uLavaGlow: { value: number };
  /** 0 = full daylight .. 1 = dusk / night: how much the lava lights the ground around it */
  uLavaLight: { value: number };
  uField: { value: THREE.Texture | null };
  uGrassCol: { value: THREE.Vector3[] };
  uGrassCov: { value: number[] };
  uGrassDry: { value: number[] };
  uDryCol: { value: THREE.Vector3 };
  uLayerLum: { value: number[] };
}

const SPLAT_GLSL = /* glsl */ `
varying vec3 vWPos; varying vec3 vWNormal; varying float vAO;
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm;
uniform sampler2D uDetA; uniform sampler2D uDetB; uniform vec3 uDetAvg;
uniform sampler2D uSplat0; uniform sampler2D uSplat1; uniform sampler2D uSplat2; uniform sampler2D uSplat3; uniform sampler2D uSplat4;
uniform float uTile[${LAYER_COUNT}]; uniform float uRough[${LAYER_COUNT}]; uniform vec3 uTint[${LAYER_COUNT}]; uniform float uDetail[${LAYER_COUNT}];
uniform float uLayerLum[${LAYER_COUNT}];
uniform float uWorldHalf; uniform float uTime; uniform float uLavaGlow; uniform float uLavaLight;
${FIELD_GLSL}
${STEEP_GLSL}
vec3 gCol; vec3 gN; float gRough; float gAO; vec3 gEmit;
float lum3(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void splat() {
  vec2 suv = vWPos.xz / (2.0 * uWorldHalf) + 0.5;
  vec4 s0 = texture(uSplat0, suv), s1 = texture(uSplat1, suv), s2 = texture(uSplat2, suv), s3 = texture(uSplat3, suv), s4 = texture(uSplat4, suv);
  float w[${LAYER_COUNT}];
  w[0]=s0.r; w[1]=s0.g; w[2]=s0.b; w[3]=s0.a; w[4]=s1.r; w[5]=s1.g; w[6]=s1.b; w[7]=s1.a;
  w[8]=s2.r; w[9]=s2.g; w[10]=s2.b; w[11]=s2.a; w[12]=s3.r; w[13]=s3.g; w[14]=s3.b; w[15]=s3.a;
  w[16]=s4.r; w[17]=s4.g;
  vec3 Nv = normalize(vWNormal);
  applySteep(w, 1.0 - Nv.y);
  float dCam = distance(vWPos, cameraPosition);
  vec4 mA = texture(uField, vWPos.xz / 211.0), mB = texture(uField, vWPos.xz / 37.0);
  // the four strongest layers
  int ids[4]; float ws[4];
  for (int k = 0; k < 4; k++) { ids[k] = 0; ws[k] = 0.0; }
  for (int i = 0; i < ${LAYER_COUNT}; i++) {
    float v = w[i];
    if (v <= ws[3]) continue;
    if (v > ws[0]) { ws[3] = ws[2]; ids[3] = ids[2]; ws[2] = ws[1]; ids[2] = ids[1]; ws[1] = ws[0]; ids[1] = ids[0]; ws[0] = v; ids[0] = i; }
    else if (v > ws[1]) { ws[3] = ws[2]; ids[3] = ids[2]; ws[2] = ws[1]; ids[2] = ids[1]; ws[1] = v; ids[1] = i; }
    else if (v > ws[2]) { ws[3] = ws[2]; ids[3] = ids[2]; ws[2] = v; ids[2] = i; }
    else { ws[3] = v; ids[3] = i; }
  }
  float steepW = smoothstep(0.28, 0.6, 1.0 - Nv.y);
  vec3 an = abs(Nv); float bx = an.x / (an.x + an.z + 1e-4);
  vec3 Tt = normalize(vec3(1.0, 0.0, 0.0) - Nv * Nv.x);
  vec3 Bt = cross(Nv, Tt);
  float farK = smoothstep(25.0, 180.0, dCam);
  vec4 A[4]; vec4 B[4];
  for (int k = 0; k < 4; k++) {
    A[k] = vec4(0.4, 0.4, 0.4, 0.5); B[k] = vec4(0.9, 0.5, 1.0, 0.5);
    if (ws[k] < 0.01) continue;
    int L = ids[k]; float layer = float(L == ${L.lava} ? ${L.lavaRock} : (L > ${L.lava} ? L - 1 : L)); // lava has no texture of its own
    float tile = uTile[L];
    vec2 uvT = vWPos.xz / tile;
    vec4 a = texture(uAlb, vec3(uvT, layer)); vec4 b = texture(uNrm, vec3(uvT, layer));
    if ((L == 8 || L == 11 || L == 13) && steepW > 0.01) {
      vec2 uvX = vec2(vWPos.z, -vWPos.y) / tile, uvZ = vec2(vWPos.x, -vWPos.y) / tile;
      vec4 aw = mix(texture(uAlb, vec3(uvZ, layer)), texture(uAlb, vec3(uvX, layer)), bx);
      vec4 bw = mix(texture(uNrm, vec3(uvZ, layer)), texture(uNrm, vec3(uvX, layer)), bx);
      a = mix(a, aw, steepW); b = mix(b, bw, steepW);
    }
    // anti-tiling: a rotated, larger-scale second sample
    vec3 af = texture(uAlb, vec3(mat2(0.8, -0.6, 0.6, 0.8) * uvT * 0.21 + 0.37, layer)).rgb;
    a.rgb = mix(a.rgb, af, mix(0.22, 0.6, farK));
    a.rgb *= uTint[L];
    A[k] = a; B[k] = b;
  }
  // height blending: the layer whose texture is locally higher wins (sand settles in the cracks)
  float hb[4]; float mx = 0.0;
  for (int k = 0; k < 4; k++) { hb[k] = ws[k] > 0.01 ? ws[k] + A[k].a * 0.5 : -1.0; mx = max(mx, hb[k]); }
  mx -= 0.2;
  float bsum = 0.0; float bk[4];
  for (int k = 0; k < 4; k++) { bk[k] = max(hb[k] - mx, 0.0); bsum += bk[k]; }
  vec3 col = vec3(0.0); vec2 nd = vec2(0.0); float rough = 0.0, ao = 0.0, det = 0.0, hgt = 0.0, lumRef = 0.0;
  for (int k = 0; k < 4; k++) {
    float b = bk[k] / max(bsum, 1e-4); int L = ids[k];
    col += b * A[k].rgb; nd += b * (vec2(B[k].a, B[k].g) * 2.0 - 1.0);
    rough += b * B[k].r * uRough[L]; ao += b * B[k].b; det += b * uDetail[L]; hgt += b * A[k].a;
    lumRef += b * uLayerLum[L] * lum3(uTint[L]);
  }
  // macro variation against tiling
  float macro = (0.84 + 0.3 * mA.a) * (0.92 + 0.16 * mB.r);
  col *= macro;
  // volcanic ground: oxidised rusty-red scoria patches (strongest on the cinders), lighter ash drifts
  float volc = clamp(w[${L.lavaRock}] + w[${L.ash}] + w[${L.cinder}] + w[${L.aa}], 0.0, 1.0);
  if (volc > 0.01) {
    float rust = smoothstep(0.55, 0.8, mA.r * 0.6 + mB.b * 0.4) * clamp(volc + w[${L.cinder}] * 0.8, 0.0, 1.0);
    col = mix(col, col * vec3(1.75, 1.08, 0.72), rust * 0.55);
    col = mix(col, col * 1.45, smoothstep(0.6, 0.85, mB.g) * w[${L.ash}] * 0.5);
  }
  // grass-covered ground takes the colour of its grass (same field function as the blades),
  // keeping the texture's luminance detail; darker near the camera where it is the shade between blades
  vec4 gf = grassField(vWPos.xz, w);
  float detailL = clamp(lum3(col) / max(lumRef * macro, 1e-3), 0.45, 1.7);
  float nearG = smoothstep(4.0, 26.0, dCam);
  // tussocks and thin patches: brightness at clump scale so distant lawns are not billiard-smooth
  float tuss = texture(uField, vWPos.xz / 6.7 + 0.29).g * 0.6 + texture(uField, vWPos.xz / 2.3 + 0.61).r * 0.4;
  vec3 grassGround = mix(mix(gf.rgb, vec3(0.2, 0.15, 0.07), 0.35) * 0.55, gf.rgb * 0.82 * (0.8 + 0.42 * tuss), nearG) * detailL;
  col = mix(col, grassGround, clamp(gf.a, 0.0, 1.0) * 0.85);
  // grit detail near the camera
  float dK = det * (1.0 - smoothstep(6.0, 26.0, dCam));
  if (dK > 0.01) {
    vec2 duv = vWPos.xz / 0.9;
    vec4 da = texture(uDetA, duv); vec4 db = texture(uDetB, duv);
    col *= mix(vec3(1.0), clamp(da.rgb / uDetAvg, 0.0, 2.2), dK * 0.75);
    nd += (vec2(db.a, db.g) * 2.0 - 1.0) * dK * 0.8;
    ao *= mix(1.0, db.b, dK);
  }
  // volcanic near field: fine scoria lapilli between the larger clasts, in patches (cinder texture at a finer scale)
  float vNear = clamp(w[${L.ash}] + w[${L.cinder}] * 0.8 + w[${L.aa}] * 0.2 + w[${L.lavaRock}] * 0.25, 0.0, 1.0) * (1.0 - smoothstep(5.0, 22.0, dCam));
  if (vNear > 0.01) {
    vec2 vuv = mat2(0.83, -0.56, 0.56, 0.83) * vWPos.xz / 0.62 + 0.13;
    vec4 va = texture(uAlb, vec3(vuv, ${texLayerOf(L.cinder)}.0)); vec4 vb = texture(uNrm, vec3(vuv, ${texLayerOf(L.cinder)}.0));
    float lapilli = vNear * smoothstep(0.42, 0.62, va.a * 0.7 + texture(uField, vWPos.xz / 4.3 + 0.41).g * 0.6 - 0.05);
    float vl = lum3(va.rgb) / max(uLayerLum[${L.cinder}], 1e-3);
    col = mix(col, col * clamp(vl, 0.35, 1.9) * vec3(1.06, 0.96, 0.9), lapilli * 0.75);
    nd += (vec2(vb.a, vb.g) * 2.0 - 1.0) * lapilli * 0.9;
    ao *= mix(1.0, vb.b, lapilli * 0.8);
  }
  vec3 Nw = normalize(Nv + (Tt * nd.x + Bt * nd.y) * (1.0 - farK * 0.75) * 1.15);
  // wet mud and damp sand: darker and glossy; standing water in the low parts of the swamp mud
  float wet = clamp(w[5] * 0.85 + w[6] * 0.95 + w[14] * 0.5, 0.0, 1.0);
  float puddle = clamp(wet * smoothstep(0.45, 0.2, hgt) * (w[6] + w[14] * 0.5) * 1.6, 0.0, 1.0);
  col *= mix(1.0, 0.6, wet);
  rough = mix(rough, 0.32, wet * 0.85);
  rough = mix(rough, 0.05, puddle);
  Nw = normalize(mix(Nw, Nv, puddle));
  col *= mix(1.0, 0.7, puddle);
  gEmit = vec3(0.0);
  // molten lava: flowing crust plates over a hot core, glowing at the edges
  float lv = w[15];
  if (lv > 0.01) {
    vec2 down = -Nv.xz; float dl = length(down); down = dl > 1e-3 ? down / dl : vec2(0.0, 1.0);
    vec2 fuv = vWPos.xz * 0.045;
    float c1 = texture(uField, fuv - down * uTime * 0.012).r;
    float c2 = texture(uField, fuv * 2.7 + down * uTime * 0.021 + 0.31).b;
    float c3 = texture(uField, fuv * 7.0 - down * uTime * 0.034 + 0.77).g;
    float crack = c1 * 0.55 + c2 * 0.3 + c3 * 0.15;
    float crust = smoothstep(0.47, 0.6, crack);
    float core = smoothstep(0.3, 0.9, lv);
    float heat = clamp(core * (1.0 - crust * 0.92) * (0.8 + 0.2 * sin(uTime * 1.3 + crack * 9.0)), 0.0, 1.0);
    vec3 hot = mix(vec3(0.55, 0.03, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.1, 0.55, heat));
    hot = mix(hot, vec3(1.0, 0.8, 0.36), smoothstep(0.62, 1.0, heat));
    gEmit = hot * (heat * 5.5 + 0.4 * smoothstep(0.0, 0.45, lv)) * uLavaGlow;
    col = mix(col, vec3(0.022, 0.018, 0.017), smoothstep(0.15, 0.55, lv));
    rough = mix(rough, 0.55, lv);
    // banks: freshly cooled glassy crust, still glowing in its cracks
    float bank = smoothstep(0.05, 0.18, lv) * (1.0 - smoothstep(0.26, 0.5, lv));
    if (bank > 0.01) {
      float n1 = texture(uField, vWPos.xz / 3.1 + 0.17).g, n2 = texture(uField, vWPos.xz / 1.3 + 0.53).r;
      float cracks = (1.0 - smoothstep(0.0, 0.016, abs(n1 - 0.5))) * 0.8 + (1.0 - smoothstep(0.0, 0.02, abs(n2 - 0.5))) * 0.35 * smoothstep(0.12, 0.3, lv);
      float pulse = 0.75 + 0.25 * sin(uTime * 0.8 + n1 * 11.0);
      gEmit += vec3(1.0, 0.22, 0.02) * cracks * bank * bank * 1.3 * pulse * uLavaGlow;
      col = mix(col, col * 0.55, bank);
      rough = mix(rough, 0.34, bank * 0.8);
    }
  }
  // lava light: molten lava lights the ground around it (orange, falling off over ~40 m). It is a faint
  // tint by day and the main light on the cone at dusk and night, when the dark basalt would otherwise
  // go black. Proximity = a golden-angle ring of taps into the lava channel of the splat map.
  // The whole cone also takes a dim warm glow from the crater and the lit plume once the daylight fades.
  if (volc > 0.01 || lv > 0.01) {
    float px = 1.0 / (2.0 * uWorldHalf), near = 0.0;
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 2.39996 + 0.7;
      float r = i < 4 ? 4.0 : (i < 8 ? 12.0 : (i < 12 ? 30.0 : 60.0));
      float wt = i < 4 ? 0.14 : (i < 8 ? 0.07 : (i < 12 ? 0.04 : 0.025));
      near += texture(uSplat3, suv + vec2(cos(a), sin(a)) * r * px).a * wt;
    }
    near = clamp(near, 0.0, 1.0);
    float local = near * (0.18 + 1.9 * uLavaLight);
    float cone = volc * 0.25 * uLavaLight;
    gEmit += col * vec3(1.0, 0.38, 0.11) * (local + cone) * 3.4;
  }
  gCol = col; gN = Nw; gRough = clamp(rough, 0.04, 1.0); gAO = mix(1.0, ao, 0.85);
}`;

export function createTerrainMaterial(u: TerrainUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ao;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nvarying float vAO;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);\nvAO = ao;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SPLAT_GLSL}`)
      .replace('#include <map_fragment>', `splat();\ndiffuseColor.rgb *= gCol * mix(1.0, vAO, 0.45);`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <normal_fragment_maps>', `normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;`)
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse *= gAO * vAO;\nreflectedLight.indirectSpecular *= mix(1.0, gAO * vAO, 0.75);`);
  };
  mat.customProgramCacheKey = () => 'dino-terrain-v3';
  return mat;
}

interface Chunk {
  cx: number; cz: number; key: string;
  mesh: THREE.Mesh | null;
  lod: number; wantLod: number; building: boolean;
  vegSent: boolean;
  center: THREE.Vector3;
}

export interface VegPlacement { [speciesId: string]: Float32Array }

export class Terrain {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  uniforms: TerrainUniforms;
  workers: TerrainWorkers;
  chunks = new Map<string, Chunk>();
  heightTexture: THREE.DataTexture | null = null;
  farMesh: THREE.Mesh | null = null;
  onVeg: ((key: string, cx: number, cz: number, veg: VegPlacement) => void) | null = null;
  onChunkRemoved: ((key: string) => void) | null = null;
  ready = false;
  private renderer: THREE.WebGLRenderer;
  private vegDensity: number;
  private maxInFlight = 3;
  private lastPx = 0; private lastPz = 0;

  constructor(workers: TerrainWorkers, renderer: THREE.WebGLRenderer) {
    this.workers = workers; this.renderer = renderer;
    this.vegDensity = quality.vegDensity;
    this.uniforms = {
      uAlb: { value: null }, uNrm: { value: null }, uDetA: { value: null }, uDetB: { value: null }, uDetAvg: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
      uSplat0: { value: null }, uSplat1: { value: null }, uSplat2: { value: null }, uSplat3: { value: null }, uSplat4: { value: null },
      uNoise: { value: makeNoiseTexture() }, uTile: { value: [...LAYER_TILE] }, uRough: { value: [...LAYER_ROUGH] }, uTint: { value: LAYER_TINT.map((t) => new THREE.Vector3(t[0], t[1], t[2])) },
      uDetail: { value: [...LAYER_DETAIL] },
      uWorldHalf: { value: HALF }, uTime: { value: 0 }, uLavaGlow: { value: 1 }, uLavaLight: { value: 0 },
      uField: { value: null }, uGrassCol: { value: GRASS_COL_LIN.map((c) => new THREE.Vector3(c[0], c[1], c[2])) }, uGrassCov: { value: [...GRASS_COV] },
      uGrassDry: { value: [...GRASS_DRY] }, uDryCol: { value: new THREE.Vector3(...DRY_LIN) }, uLayerLum: { value: new Array(LAYER_COUNT).fill(0.2) },
    };
    this.material = createTerrainMaterial(this.uniforms);
    this.group.name = 'terrain';
  }

  /** Loads textures + splat + far mesh. Resolves when the ground can be drawn. */
  async init(): Promise<void> {
    const base = '/assets/env/ground/';
    const aUrls = (size: number) => GROUND_LAYERS.map((n) => `${base}${n}_a_${size}.webp`);
    const bUrls = GROUND_LAYERS.map((n) => `${base}${n}_b_512.webp`);
    const splatP = this.workers.request<{ data: Uint8Array; planes: number; field: Uint8Array }>({ type: 'splat', res: 512 });
    const farP = this.workers.request<{ pos: Float32Array; nor: Float32Array; ao: Float32Array; indices: Uint32Array; hm: Float32Array; hres: number }>({ type: 'far', segments: 160 });
    const aniso = quality.anisotropy;
    const [alb, nrm, detA, detB, lums, detAvg, splat, far] = await Promise.all([
      loadLayerArray(this.renderer, aUrls(512), 512, true, aniso),
      loadLayerArray(this.renderer, bUrls, 512, false, aniso),
      loadTexture2D(`${base}${DETAIL_TEXTURE}_a_512.webp`, true, aniso),
      loadTexture2D(`${base}${DETAIL_TEXTURE}_b_512.webp`, false, aniso),
      Promise.all(aUrls(512).map(meanColour)),
      meanColour(`${base}${DETAIL_TEXTURE}_a_512.webp`),
      splatP, farP,
    ]);
    this.uniforms.uAlb.value = alb; this.uniforms.uNrm.value = nrm;
    this.uniforms.uDetA.value = detA; this.uniforms.uDetB.value = detB;
    this.uniforms.uDetAvg.value.set(...detAvg);
    const lumTex = lums.map((c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
    this.uniforms.uLayerLum.value = Array.from({ length: LAYER_COUNT }, (_, ch) => lumTex[texLayerOf(ch)] ?? 0.1);
    const res = 512;
    groundData.splat = splat.data; groundData.splatRes = res;
    groundData.field = { noise: splat.field, res: FIELD_RES };
    const ft = new THREE.DataTexture(splat.field, FIELD_RES, FIELD_RES);
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.minFilter = THREE.LinearMipmapLinearFilter; ft.magFilter = THREE.LinearFilter;
    ft.generateMipmaps = true; ft.needsUpdate = true;
    groundData.fieldTex = ft; this.uniforms.uField.value = ft;
    const keys = ['uSplat0', 'uSplat1', 'uSplat2', 'uSplat3', 'uSplat4'] as const;
    for (let p = 0; p < splat.planes; p++) {
      const t = new THREE.DataTexture(splat.data.subarray(p * res * res * 4, (p + 1) * res * res * 4), res, res);
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      this.uniforms[keys[p]].value = t;
    }
    // far mesh (always visible silhouette under the fog)
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(far.pos, 3));
    fg.setAttribute('normal', new THREE.BufferAttribute(far.nor, 3));
    fg.setAttribute('ao', new THREE.BufferAttribute(far.ao, 1));
    fg.setIndex(new THREE.BufferAttribute(far.indices, 1));
    fg.computeBoundingSphere();
    this.farMesh = new THREE.Mesh(fg, this.material);
    this.farMesh.receiveShadow = false; this.farMesh.frustumCulled = false; this.farMesh.renderOrder = -1;
    this.group.add(this.farMesh);
    // height texture for water shaders
    const hd = new Uint8Array(far.hres * far.hres * 4);
    for (let i = 0; i < far.hres * far.hres; i++) {
      const v = Math.round(Math.min(1, Math.max(0, (far.hm[i] + 64) / 320)) * 65535);
      hd[i * 4] = v >> 8; hd[i * 4 + 1] = v & 255; hd[i * 4 + 3] = 255;
    }
    const ht = new THREE.DataTexture(hd, far.hres, far.hres, THREE.RGBAFormat, THREE.UnsignedByteType);
    ht.minFilter = THREE.LinearFilter; ht.magFilter = THREE.LinearFilter; ht.needsUpdate = true;
    this.heightTexture = ht;
    this.ready = true;
    // sharper albedo once the world is up (high tier only): 1024 Basis layers, GPU-compressed
    if (quality.tier === 'high' && new URLSearchParams(location.search).get('ktx') !== '0') {
      void loadKtx2Array(this.renderer, GROUND_LAYERS.map((n) => `${base}${n}_a_1024.ktx2`), 1024, aniso).then((hi) => {
        if (!hi) return; // keep the 512 set
        const old = this.uniforms.uAlb.value; this.uniforms.uAlb.value = hi; old?.dispose();
      });
    }
  }

  private lodFor(dist: number): number { return dist < CHUNK_LOD_DIST[0] ? 0 : dist < CHUNK_LOD_DIST[1] ? 1 : 2; }

  update(playerX: number, playerZ: number, time: number): void {
    this.uniforms.uTime.value = time;
    this.lastPx = playerX; this.lastPz = playerZ;
    if (!this.ready) return;
    const pcx = Math.floor((playerX + HALF) / CHUNK_SIZE), pcz = Math.floor((playerZ + HALF) / CHUNK_SIZE);
    const r = Math.ceil(CHUNK_LOAD_RADIUS / CHUNK_SIZE);
    const wanted: Chunk[] = [];
    for (let cz = pcz - r; cz <= pcz + r; cz++) for (let cx = pcx - r; cx <= pcx + r; cx++) {
      if (cx < 0 || cz < 0 || cx >= CHUNKS_PER_SIDE || cz >= CHUNKS_PER_SIDE) continue;
      const cxw = cx * CHUNK_SIZE - HALF + CHUNK_SIZE / 2, czw = cz * CHUNK_SIZE - HALF + CHUNK_SIZE / 2;
      const d = Math.hypot(cxw - playerX, czw - playerZ);
      if (d > CHUNK_LOAD_RADIUS) continue;
      const key = `${cx}_${cz}`;
      let c = this.chunks.get(key);
      if (!c) {
        c = { cx, cz, key, mesh: null, lod: -1, wantLod: -1, building: false, vegSent: false, center: new THREE.Vector3(cxw, 0, czw) };
        this.chunks.set(key, c);
      }
      c.wantLod = this.lodFor(d);
      // hysteresis so chunks don't flip LOD at the boundary
      if (c.lod >= 0 && c.lod !== c.wantLod) {
        const boundary = c.lod < c.wantLod ? CHUNK_LOD_DIST[c.lod] : CHUNK_LOD_DIST[c.wantLod];
        if (Math.abs(d - boundary) < 25) c.wantLod = c.lod;
      }
      wanted.push(c);
    }
    // dispose far chunks
    for (const [key, c] of this.chunks) {
      const d = Math.hypot(c.center.x - playerX, c.center.z - playerZ);
      if (d > CHUNK_LOAD_RADIUS + 90 && !c.building) { this.removeChunk(c); this.chunks.delete(key); }
    }
    // build, nearest first
    const pv = new THREE.Vector3(playerX, 0, playerZ);
    wanted.sort((a, b) => a.center.distanceToSquared(pv) - b.center.distanceToSquared(pv));
    for (const c of wanted) {
      if (this.workers.inFlight >= this.maxInFlight) break;
      if (!c.building && c.lod !== c.wantLod) this.build(c, c.wantLod);
    }
  }

  private async build(c: Chunk, lod: number): Promise<void> {
    c.building = true;
    const withVeg = !c.vegSent;
    const res = await this.workers.request<{ pos: Float32Array; nor: Float32Array; ao: Float32Array; indices: Uint16Array | Uint32Array; veg: VegPlacement | null }>({
      type: 'chunk', cx: c.cx, cz: c.cz, lod, size: CHUNK_SIZE, segments: CHUNK_SEGMENTS[lod], withVeg, vegDensity: this.vegDensity,
    });
    c.building = false;
    if (!this.chunks.has(c.key)) return; // removed meanwhile
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(res.nor, 3));
    geo.setAttribute('ao', new THREE.BufferAttribute(res.ao, 1));
    geo.setIndex(new THREE.BufferAttribute(res.indices, 1));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(c.cx * CHUNK_SIZE - HALF, 0, c.cz * CHUNK_SIZE - HALF);
    mesh.receiveShadow = true; mesh.castShadow = lod === 0 && Math.hypot(c.center.x - this.lastPx, c.center.z - this.lastPz) < 85;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    c.mesh = mesh; c.lod = lod;
    this.group.add(mesh);
    if (res.veg && this.onVeg) { c.vegSent = true; this.onVeg(c.key, c.cx, c.cz, res.veg); }
    else if (withVeg) c.vegSent = true;
  }

  private removeChunk(c: Chunk): void {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    if (this.onChunkRemoved) this.onChunkRemoved(c.key);
  }

  /** Ray-march the analytic heightfield. Returns the hit point or null. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 600, out = new THREE.Vector3()): THREE.Vector3 | null {
    let t = 0, step = 0.5;
    const prevAbove = origin.y - heightAt(origin.x, origin.z) > 0;
    if (!prevAbove) return null;
    while (t < maxDist) {
      t += step;
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const h = heightAt(x, z);
      if (y < h) {
        // bisection
        let lo = t - step, hi = t;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) / 2;
          const my = origin.y + dir.y * m, mh = heightAt(origin.x + dir.x * m, origin.z + dir.z * m);
          if (my < mh) hi = m; else lo = m;
        }
        const f = (lo + hi) / 2;
        return out.set(origin.x + dir.x * f, origin.y + dir.y * f, origin.z + dir.z * f);
      }
      step = Math.min(6, 0.5 + t * 0.03 + Math.max(0, y - h) * 0.3);
    }
    return null;
  }

  get stats(): { chunks: number; triangles: number } {
    let tris = 0;
    for (const c of this.chunks.values()) if (c.mesh) tris += (c.mesh.geometry.index?.count ?? 0) / 3;
    return { chunks: this.chunks.size, triangles: tris };
  }
}

export { heightAt, TEX_LAYERS };
