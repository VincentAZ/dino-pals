// Chunked, LOD'd procedural terrain with a 12-layer PBR splat shader fed by
// texture arrays. Geometry is generated in a worker pool.
import * as THREE from 'three';
import { CHUNK_LOAD_RADIUS, CHUNK_LOD_DIST, CHUNK_SEGMENTS, CHUNK_SIZE, CHUNKS_PER_SIDE, quality } from '../config.ts';
import { GROUND_LAYERS, HALF, LAYER_COUNT, LAYER_ROUGH, LAYER_TILE, LAYER_TINT } from './biomes.ts';
import { heightAt } from './heightmap.ts';
import type { ChunkRequest, FarRequest, SplatRequest } from './terrain.worker.ts';

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

async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const res = await fetch(url);
  const blob = await res.blob();
  try { return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = URL.createObjectURL(blob); });
  }
}

/** Load N square images into a DataArrayTexture. */
export async function loadArrayTexture(urls: string[], size: number, srgb: boolean, aniso: number): Promise<THREE.DataArrayTexture> {
  const data = new Uint8Array(size * size * 4 * urls.length);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const images = await Promise.all(urls.map((u) => loadImage(u).catch(() => null)));
  images.forEach((img, i) => {
    ctx.clearRect(0, 0, size, size);
    if (img) ctx.drawImage(img, 0, 0, size, size);
    else { ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, size, size); }
    const id = ctx.getImageData(0, 0, size, size);
    data.set(id.data, i * size * size * 4);
    if (img && 'close' in img) img.close();
  });
  const tex = new THREE.DataArrayTexture(data, size, size, urls.length);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = aniso; tex.needsUpdate = true;
  return tex;
}

function makeNoiseTexture(): THREE.DataTexture {
  const n = 256; const d = new Uint8Array(n * n * 4);
  // cheap tileable value noise via summed sines of hashed phases
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
  uDiff: { value: THREE.DataArrayTexture | null };
  uNorm: { value: THREE.DataArrayTexture | null };
  uSplat0: { value: THREE.Texture | null };
  uSplat1: { value: THREE.Texture | null };
  uSplat2: { value: THREE.Texture | null };
  uNoise: { value: THREE.Texture };
  uTile: { value: number[] };
  uRough: { value: number[] };
  uTint: { value: THREE.Vector3[] };
  uWorldHalf: { value: number };
  uTime: { value: number };
  uLavaGlow: { value: number };
}

export function createTerrainMaterial(u: TerrainUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos; varying vec3 vWNormal;
uniform sampler2DArray uDiff; uniform sampler2DArray uNorm;
uniform sampler2D uSplat0; uniform sampler2D uSplat1; uniform sampler2D uSplat2; uniform sampler2D uNoise;
uniform float uTile[${LAYER_COUNT}]; uniform float uRough[${LAYER_COUNT}]; uniform vec3 uTint[${LAYER_COUNT}]; uniform float uWorldHalf; uniform float uTime; uniform float uLavaGlow;
vec3 gCol; vec3 gNrm; float gRough; float gLava;
void splat() {
  vec2 suv = vWPos.xz / (2.0 * uWorldHalf) + 0.5;
  vec4 s0 = texture2D(uSplat0, suv); vec4 s1 = texture2D(uSplat1, suv); vec4 s2 = texture2D(uSplat2, suv);
  float w[${LAYER_COUNT}];
  w[0]=s0.r; w[1]=s0.g; w[2]=s0.b; w[3]=s0.a; w[4]=s1.r; w[5]=s1.g; w[6]=s1.b; w[7]=s1.a; w[8]=s2.r; w[9]=s2.g; w[10]=s2.b; w[11]=s2.a;
  // steep slopes -> cliff rock (fine-grained, from the geometric normal)
  float slope = 1.0 - clamp(vWNormal.y, 0.0, 1.0);
  float steep = smoothstep(0.38, 0.62, slope);
  float redW = w[7];
  float cliffW = steep * (1.0 - w[8]);
  for (int i = 0; i < ${LAYER_COUNT}; i++) w[i] *= (1.0 - cliffW);
  w[11] += cliffW;
  vec3 macro = texture2D(uNoise, vWPos.xz * 0.0045).rgb;
  vec3 macro2 = texture2D(uNoise, vWPos.xz * 0.013 + 0.5).rgb;
  float tint = 0.78 + 0.3 * macro.g + 0.14 * macro2.r;
  float dCam = distance(vWPos, cameraPosition);
  float far = smoothstep(35.0, 140.0, dCam);
  // steep faces: map along the dominant horizontal axis instead of xz to avoid streaking
  vec2 wallUv = abs(vWNormal.x) > abs(vWNormal.z) ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y);
  vec3 col = vec3(0.0); vec3 nrm = vec3(0.0); float rough = 0.0; float sum = 0.0;
  for (int i = 0; i < ${LAYER_COUNT}; i++) {
    float wi = w[i];
    if (wi > 0.025) {
      vec2 base = mix(vWPos.xz, wallUv, steep);
      vec2 uv = base / uTile[i];
      vec2 uvFar = base / (uTile[i] * 6.3) + 0.21;
      vec3 c = texture(uDiff, vec3(uv, float(i))).rgb;
      vec3 cFar = texture(uDiff, vec3(uvFar, float(i))).rgb;
      vec3 tintI = uTint[i];
      if (i == 11) tintI = mix(tintI, vec3(1.18, 0.72, 0.52), clamp(redW * 2.5, 0.0, 1.0));
      c = mix(c, cFar, far * 0.7) * tintI;
      vec3 n = texture(uNorm, vec3(uv, float(i))).rgb * 2.0 - 1.0;
      col += wi * c; nrm += wi * n; rough += wi * uRough[i]; sum += wi;
    }
  }
  float inv = 1.0 / max(sum, 1e-4);
  gCol = col * inv * tint;
  gNrm = normalize(mix(nrm * inv, vec3(0.0, 0.0, 1.0), far * 0.85) + vec3(0.0, 0.0, 1e-3)); gRough = mix(rough * inv, 1.0, far * 0.5);
  // thin glowing lava cracks on dark volcanic rock
  float lavaW = w[8];
  float cr = texture2D(uNoise, vWPos.xz * 0.075 + macro.r * 0.03).r;
  float cr2 = texture2D(uNoise, vWPos.xz * 0.19 + 0.3).g;
  float band = abs(cr - 0.5) + abs(cr2 - 0.5) * 0.35;
  float crack = (smoothstep(0.03, 0.008, band) + smoothstep(0.09, 0.02, band) * 0.18) * smoothstep(0.55, 0.8, macro2.g);
  float pulse = 0.7 + 0.3 * sin(uTime * 1.1 + vWPos.x * 0.3 + vWPos.z * 0.23);
  // lava pools on flat dark rock
  float poolN = texture2D(uNoise, vWPos.xz * 0.03 + 0.73).r * 0.7 + texture2D(uNoise, vWPos.xz * 0.009 + 0.2).g * 0.5;
  float pool = smoothstep(0.86, 0.92, poolN) * smoothstep(0.2, 0.08, steep);
  gLava = (crack + pool * 0.9) * smoothstep(0.45, 0.9, lavaW) * smoothstep(0.35, 0.15, steep) * uLavaGlow * pulse;
}`)
      .replace('#include <map_fragment>', `splat();\ndiffuseColor.rgb *= gCol;`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <normal_fragment_maps>', `{
  vec3 N = normalize(vWNormal);
  vec3 B = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 T = cross(B, N);
  vec3 wn = normalize(T * gNrm.x + B * gNrm.y + N * gNrm.z * 1.4);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.3, 0.04) * gLava * 2.6;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), gLava * 0.8);`);
  };
  mat.customProgramCacheKey = () => 'dino-terrain';
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
  private vegDensity: number;
  private maxInFlight = 3;
  private lastPx = 0; private lastPz = 0;

  constructor(workers: TerrainWorkers) {
    this.workers = workers;
    this.vegDensity = quality.vegDensity;
    this.uniforms = {
      uDiff: { value: null }, uNorm: { value: null }, uSplat0: { value: null }, uSplat1: { value: null }, uSplat2: { value: null },
      uNoise: { value: makeNoiseTexture() }, uTile: { value: [...LAYER_TILE] }, uRough: { value: [...LAYER_ROUGH] }, uTint: { value: LAYER_TINT.map((t) => new THREE.Vector3(t[0], t[1], t[2])) },
      uWorldHalf: { value: HALF }, uTime: { value: 0 }, uLavaGlow: { value: 1 },
    };
    this.material = createTerrainMaterial(this.uniforms);
    this.group.name = 'terrain';
  }

  /** Loads textures + splat + far mesh. Resolves when the ground can be drawn. */
  async init(): Promise<void> {
    const size = quality.groundTex;
    const base = '/assets/env/ground/';
    const diffUrls = GROUND_LAYERS.map((n) => `${base}${n}_diff_${size}.webp`);
    const normUrls = GROUND_LAYERS.map((n) => `${base}${n}_nor_512.webp`);
    const splatP = this.workers.request<{ data: Uint8Array; planes: number }>({ type: 'splat', res: 512 });
    const farP = this.workers.request<{ pos: Float32Array; nor: Float32Array; indices: Uint32Array; hm: Float32Array; hres: number }>({ type: 'far', segments: 160 });
    const [diff, norm, splat, far] = await Promise.all([
      loadArrayTexture(diffUrls, size, true, quality.anisotropy),
      loadArrayTexture(normUrls, 512, false, quality.anisotropy),
      splatP, farP,
    ]);
    this.uniforms.uDiff.value = diff; this.uniforms.uNorm.value = norm;
    const res = 512;
    const keys = ['uSplat0', 'uSplat1', 'uSplat2'] as const;
    for (let p = 0; p < splat.planes; p++) {
      const t = new THREE.DataTexture(splat.data.subarray(p * res * res * 4, (p + 1) * res * res * 4), res, res);
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      this.uniforms[keys[p]].value = t;
    }
    // far mesh (always visible silhouette under the fog)
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(far.pos, 3));
    fg.setAttribute('normal', new THREE.BufferAttribute(far.nor, 3));
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
    wanted.sort((a, b) => a.center.distanceToSquared(new THREE.Vector3(playerX, 0, playerZ)) - b.center.distanceToSquared(new THREE.Vector3(playerX, 0, playerZ)));
    for (const c of wanted) {
      if (this.workers.inFlight >= this.maxInFlight) break;
      if (!c.building && c.lod !== c.wantLod) this.build(c, c.wantLod);
    }
  }

  private async build(c: Chunk, lod: number): Promise<void> {
    c.building = true;
    const withVeg = !c.vegSent;
    const res = await this.workers.request<{ pos: Float32Array; nor: Float32Array; indices: Uint16Array | Uint32Array; veg: VegPlacement | null }>({
      type: 'chunk', cx: c.cx, cz: c.cz, lod, size: CHUNK_SIZE, segments: CHUNK_SEGMENTS[lod], withVeg, vegDensity: this.vegDensity,
    });
    c.building = false;
    if (!this.chunks.has(c.key)) return; // removed meanwhile
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(res.nor, 3));
    geo.setIndex(new THREE.BufferAttribute(res.indices, 1));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(c.cx * CHUNK_SIZE - HALF, 0, c.cz * CHUNK_SIZE - HALF);
    mesh.receiveShadow = true; mesh.castShadow = lod === 0 && Math.hypot(c.center.x - this.lastPx, c.center.z - this.lastPz) < 120;
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
    let prevAbove = origin.y - heightAt(origin.x, origin.z) > 0;
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

export { heightAt };
