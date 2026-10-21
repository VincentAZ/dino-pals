// Instanced vegetation/rocks with CPU-bucketed LODs.
// Each terrain chunk is split into 50 m cells. Per species+variant there is
// one LOD0 batch per cell and one LOD1 batch per chunk; a batch only holds the
// instances currently inside its distance band (refilled as the player moves),
// and all mesh parts of a batch share one instance-matrix buffer. A vertex
// shader test against the same LOD centre gives exact, gap-free hand-overs.
// Far trees are camera-facing impostors rendered at load time into an albedo
// atlas and a normal atlas, and shaded with the live sun / sky light so they
// match the 3D LODs at every time of day.
import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VEG, type VegSpecies } from './vegrules.ts';
import type { VegPlacement } from './terrain.ts';
import { CHUNK_SIZE, quality } from '../config.ts';
import { HALF } from './biomes.ts';

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; depth?: THREE.Material }
interface Variant { lod0: Part[]; lod1: Part[]; bounds: THREE.Box3; height: number; width: number; slot: number }
interface SpeciesAssets { def: VegSpecies; variants: Variant[]; loaded: boolean; failed: boolean; lod: [number, number, number] }

const STRIDE = 6; // x, y, z, rotY, scale, variantSeed
const CELLS = 2;  // cells per chunk side
const CELL = CHUNK_SIZE / CELLS;
const BAND = 5;   // CPU bucketing margin (m) around each LOD band
const REFILL = 3; // refill a straddling batch after the player moved this far (m)

/** One LOD band of one species variant in one cell (LOD0) or chunk (LOD1). */
interface Batch {
  attr: THREE.InstancedBufferAttribute; meshes: THREE.InstancedMesh[]; src: Float32Array[];
  lo: number; hi: number; cx: number; cz: number; half: number; fx: number; fz: number; count: number;
}
interface CellSpecies { data: Float32Array[]; l0: (Batch | null)[] }
interface Cell { cx: number; cz: number; species: Map<string, CellSpecies>; pending: VegPlacement }
interface ChunkRec { cx: number; cz: number; cells: Cell[]; bb: THREE.Mesh | null; bbSpecies: number; l1: Map<string, (Batch | null)[]> }

const shared = {
  time: { value: 0 }, wind: { value: 1 }, light: { value: new THREE.Color(1, 1, 1) },
  center: { value: new THREE.Vector3() },
  sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) },
  hemiSky: { value: new THREE.Color(0.5, 0.6, 0.8) }, hemiGround: { value: new THREE.Color(0.3, 0.3, 0.2) },
};

// foliage: both faces keep the (crown-bent) normal, plus light transmitted through backlit leaves
const FOLIAGE_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');
const FOLIAGE_TRANSLUCENCY = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
  {
    vec3 tL = directionalLights[0].direction;
    vec3 tV = normalize(vViewPosition);
    float tBack = pow(saturate(dot(-tV, tL)), 3.0) * 0.8 + saturate(-dot(normal, tL)) * 0.25;
    reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * vec3(1.0, 1.05, 0.7) * tBack * 0.55 * RECIPROCAL_PI;
  }
#endif`;

// alpha-tested leaves keep their coverage in the distance: mipmapping averages alpha
// towards transparent, so scale alpha up with the mip level (Golus) before the test
const FOLIAGE_ALPHA = /* glsl */ `
#ifdef USE_MAP
  {
    vec2 tsz = vec2(textureSize(map, 0));
    vec2 ddx = dFdx(vMapUv * tsz), ddy = dFdy(vMapUv * tsz);
    float mipL = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
    diffuseColor.a *= 1.0 + mipL * 0.28;
  }
#endif
#include <alphatest_fragment>`;

function vegetationHooks(mat: THREE.Material, range: [number, number], height: number, windAmt: number, key: string, foliage = false): void {
  mat.onBeforeCompile = (shader) => {
    if (foliage) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <alphatest_fragment>', FOLIAGE_ALPHA)
        .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FOLIAGE_TRANSLUCENCY}`);
    }
    shader.uniforms.uTime = shared.time; shader.uniforms.uWind = shared.wind; shader.uniforms.uLodCenter = shared.center;
    shader.uniforms.uLodRange = { value: new THREE.Vector2(range[0], range[1]) };
    shader.uniforms.uHeight = { value: height }; shader.uniforms.uWindAmt = { value: windAmt };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; uniform float uWind; uniform vec2 uLodRange; uniform float uHeight; uniform float uWindAmt; uniform vec3 uLodCenter;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float dLod = distance(iPos.xz, uLodCenter.xz);
  float vis = (dLod >= uLodRange.x && dLod < uLodRange.y) ? 1.0 : 0.0;
  float hf = clamp(transformed.y / max(uHeight, 0.01), 0.0, 1.0);
  float ph = uTime * 1.3 + iPos.x * 0.21 + iPos.z * 0.17;
  float sway = (sin(ph) * 0.65 + sin(ph * 2.7 + 1.3) * 0.25 + sin(ph * 5.1) * 0.1) * uWind * uWindAmt;
  transformed.x += sway * hf * hf * uHeight * 0.05;
  transformed.z += sway * hf * hf * uHeight * 0.03 * cos(ph * 0.7);
  transformed *= vis;
#endif`);
  };
  mat.customProgramCacheKey = () => `veg-${key}-${foliage ? 'f' : 'o'}`;
}

const BILL_V = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPos; attribute vec2 iSize; attribute float iSeed; attribute float iSlot; attribute vec2 iRange;
varying vec2 vUv; varying vec3 vRight; varying vec3 vToCam; varying float vH;
uniform float uTime; uniform float uGrid; uniform vec3 uLodCenter;
void main() {
  float col = mod(iSlot, uGrid); float row = floor(iSlot / uGrid);
  vUv = vec2((col + uv.x) / uGrid, (row + uv.y) / uGrid);
  float d = distance(iPos.xz, uLodCenter.xz);
  float vis = (d >= iRange.x && d < iRange.y) ? 1.0 : 0.0;
  vec3 toCam = cameraPosition - iPos; toCam.y = 0.0; toCam = normalize(toCam);
  vec3 right = vec3(-toCam.z, 0.0, toCam.x);
  vRight = right; vToCam = toCam; vH = uv.y;
  float sway = sin(uTime * 1.1 + iSeed * 20.0) * 0.012;
  vec3 wp = iPos + right * (position.x * iSize.x + sway * iSize.y * uv.y) + vec3(0.0, (position.y + 0.5) * iSize.y, 0.0);
  wp = mix(iPos, wp, vis);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const BILL_F = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D map; uniform sampler2D nmap;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uHemiSky; uniform vec3 uHemiGround;
varying vec2 vUv; varying vec3 vRight; varying vec3 vToCam; varying float vH;
void main() {
  vec4 c = texture2D(map, vUv);
  vec2 tsz = vec2(textureSize(map, 0)); vec2 ddx = dFdx(vUv * tsz), ddy = dFdy(vUv * tsz);
  float mipL = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  if (c.a * (1.0 + mipL * 0.2) < 0.5) discard;
  c.rgb /= max(c.a, 0.02); // atlas is cleared to transparent black: un-premultiply the mip average
  vec4 nt = texture2D(nmap, vUv);
  vec3 nl = (nt.xyz / max(nt.a, 0.02)) * 2.0 - 1.0;
  vec3 N = normalize(vRight * nl.x + vec3(0.0, 1.0, 0.0) * nl.y + vToCam * nl.z);
  vec3 irr = uSunCol * saturate(dot(N, uSunDir)) + mix(uHemiGround, uHemiSky, N.y * 0.5 + 0.5) * 1.35;
  float back = pow(saturate(dot(-vToCam, uSunDir)), 3.0) * 0.8 * 0.55;
  vec3 col = c.rgb * (irr + uSunCol * back * vec3(1.0, 1.05, 0.7)) * RECIPROCAL_PI;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Bake the node's world matrix into a float copy of the geometry (quantized attributes would clamp). */
function bakedGeometry(m: THREE.Mesh): THREE.BufferGeometry {
  const src = m.geometry;
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  const fp = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { fp[i * 3] = pos.getX(i); fp[i * 3 + 1] = pos.getY(i); fp[i * 3 + 2] = pos.getZ(i); }
  g.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  const nor = src.getAttribute('normal');
  if (nor) { const fn = new Float32Array(nor.count * 3); for (let i = 0; i < nor.count; i++) { fn[i * 3] = nor.getX(i); fn[i * 3 + 1] = nor.getY(i); fn[i * 3 + 2] = nor.getZ(i); } g.setAttribute('normal', new THREE.BufferAttribute(fn, 3)); }
  const uv = src.getAttribute('uv');
  if (uv) { const fu = new Float32Array(uv.count * 2); for (let i = 0; i < uv.count; i++) { fu[i * 2] = uv.getX(i); fu[i * 2 + 1] = uv.getY(i); } g.setAttribute('uv', new THREE.BufferAttribute(fu, 2)); }
  const col = src.getAttribute('color');
  if (col) { const fc = new Float32Array(col.count * 3); for (let i = 0; i < col.count; i++) { fc[i * 3] = col.getX(i); fc[i * 3 + 1] = col.getY(i); fc[i * 3 + 2] = col.getZ(i); } g.setAttribute('color', new THREE.BufferAttribute(fc, 3)); }
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(m.matrixWorld);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

export class Vegetation {
  group = new THREE.Group();
  species = new Map<string, SpeciesAssets>();
  private chunks = new Map<string, ChunkRec>();
  /** bumps whenever the set of placed trees / rocks changes (for the obstacle grid) */
  version = 0;
  private loader: GLTFLoader;
  private renderer: THREE.WebGLRenderer;
  private impostorScene = new THREE.Scene();
  private impostorCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private billboardGeo = new THREE.PlaneGeometry(1, 1);
  private atlas: THREE.WebGLRenderTarget | null = null;
  private natlas: THREE.WebGLRenderTarget | null = null;
  private atlasMat: THREE.ShaderMaterial | null = null;
  private atlasGrid = 8;
  private atlasSlot = 256;
  private nextSlot = 0;
  private loadQueue: string[] = [];
  private loading = 0;
  private playerPos = new THREE.Vector3();
  private frame = 0;
  private batches = new Set<Batch>();
  private batchIter: Batch[] = [];
  private batchCursor = 0;
  private sunLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  stats: { meshes: number; triangles: number; l0: number; l1: number; bb: number; by: Record<string, number> } = { meshes: 0, triangles: 0, l0: 0, l1: 0, bb: 0, by: {} };

  constructor(renderer: THREE.WebGLRenderer, loader: GLTFLoader) {
    this.renderer = renderer; this.loader = loader;
    this.group.name = 'vegetation';
    for (const v of VEG) {
      const k = quality.tier === 'high' ? 1 : 0.8;
      const lod: [number, number, number] = [v.lod[0] * k, v.lod[1] * k, v.lod[2]];
      this.species.set(v.id, { def: v, variants: [], loaded: false, failed: false, lod });
    }
    this.loadQueue = VEG.map((v) => v.id);
  }

  addChunk(key: string, cx: number, cz: number, veg: VegPlacement): void {
    const cells: Cell[] = [];
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
      const x0 = cx * CHUNK_SIZE - HALF + i * CELL, z0 = cz * CHUNK_SIZE - HALF + j * CELL;
      const cell: Cell = { cx: x0 + CELL / 2, cz: z0 + CELL / 2, species: new Map(), pending: {} };
      for (const [id, data] of Object.entries(veg)) {
        const items: number[] = [];
        for (let k = 0; k < data.length; k += STRIDE) {
          const x = data[k], z = data[k + 2];
          if (x >= x0 && x < x0 + CELL && z >= z0 && z < z0 + CELL) for (let s = 0; s < STRIDE; s++) items.push(data[k + s]);
        }
        if (items.length) cell.pending[id] = new Float32Array(items);
      }
      cells.push(cell);
    }
    this.chunks.set(key, { cx: cx * CHUNK_SIZE - HALF + CHUNK_SIZE / 2, cz: cz * CHUNK_SIZE - HALF + CHUNK_SIZE / 2, cells, bb: null, bbSpecies: 0, l1: new Map() });
    for (const c of cells) this.resolvePending(c);
    this.version++;
  }

  removeChunk(key: string): void {
    const rec = this.chunks.get(key);
    if (!rec) return;
    for (const c of rec.cells) for (const cs of c.species.values()) { for (const b of cs.l0) if (b) this.destroyBatch(b); cs.l0.fill(null); }
    if (rec.bb) { this.group.remove(rec.bb); rec.bb.geometry.dispose(); }
    for (const list of rec.l1.values()) for (const b of list) if (b) this.destroyBatch(b);
    this.chunks.delete(key);
    this.version++;
  }

  private resolvePending(cell: Cell): void {
    for (const [id, data] of Object.entries(cell.pending)) {
      const sp = this.species.get(id);
      if (!sp) { delete cell.pending[id]; continue; }
      if (sp.failed) { delete cell.pending[id]; continue; }
      if (!sp.loaded) continue;
      const nv = sp.variants.length;
      const lists: number[][] = Array.from({ length: nv }, () => []);
      for (let k = 0; k < data.length; k += STRIDE) {
        const v = Math.min(nv - 1, Math.floor(data[k + 5] * nv));
        lists[v].push(data[k], data[k + 1], data[k + 2], data[k + 3], data[k + 4]);
      }
      cell.species.set(id, { data: lists.map((l) => new Float32Array(l)), l0: new Array(nv).fill(null) });
      delete cell.pending[id];
    }
  }

  update(dt: number, light: THREE.Color, playerPos: THREE.Vector3): void {
    shared.time.value += dt;
    shared.light.value.copy(light);
    shared.center.value.copy(playerPos);
    this.playerPos.copy(playerPos);
    while (this.loading < 2 && this.loadQueue.length) this.loadSpecies(this.loadQueue.shift()!);
    this.updateLights();
    const px = playerPos.x, pz = playerPos.z;
    // batch creation / destruction, spread over frames
    this.frame++;
    let i = 0;
    for (const rec of this.chunks.values()) {
      if ((i++ + this.frame) % 4 === 0) this.updateChunk(rec, px, pz);
      for (const cell of rec.cells) {
        if ((i++ + this.frame) % 4 !== 0) continue;
        const dmin = Math.hypot(Math.max(0, Math.abs(px - cell.cx) - CELL / 2), Math.max(0, Math.abs(pz - cell.cz) - CELL / 2));
        for (const [id, cs] of cell.species) {
          const sp = this.species.get(id)!; const lod = sp.lod;
          if (!(lod[0] > 0)) continue;
          for (let v = 0; v < cs.data.length; v++) {
            const b = cs.l0[v];
            if (!b && dmin < lod[0] + BAND && cs.data[v].length) cs.l0[v] = this.makeBatch(sp, v, [cs.data[v]], 'l0', cell.cx, cell.cz, CELL / 2, 0, lod[0]);
            else if (b && dmin > lod[0] + BAND + 15) { this.destroyBatch(b); cs.l0[v] = null; }
          }
        }
      }
    }
    // refill straddling batches as the player moves (bounded work per frame)
    if (this.batchIter.length !== this.batches.size) { this.batchIter = [...this.batches]; this.batchCursor = 0; }
    let work = 0;
    for (let k = 0; k < this.batchIter.length && work < 3000; k++) {
      const b = this.batchIter[this.batchCursor++ % this.batchIter.length];
      if (Math.hypot(px - b.fx, pz - b.fz) < REFILL) continue;
      const dmin = Math.hypot(Math.max(0, Math.abs(px - b.cx) - b.half), Math.max(0, Math.abs(pz - b.cz) - b.half));
      const dmax = Math.hypot(Math.abs(px - b.cx) + b.half, Math.abs(pz - b.cz) + b.half);
      if (dmin > b.lo + BAND && dmax < b.hi - BAND) { b.fx = px; b.fz = pz; continue; } // fully inside its band
      work += this.fill(b, px, pz);
    }
    if (this.frame % 30 === 0) this.updateStats();
  }

  /** Read the scene's sun / hemisphere lights for the impostor shading (found once). */
  private updateLights(): void {
    if (!this.sunLight || !this.hemiLight) {
      let root: THREE.Object3D = this.group; while (root.parent) root = root.parent;
      root.traverse((o) => { const l = o as THREE.Light; if ((l as THREE.DirectionalLight).isDirectionalLight && !this.sunLight) this.sunLight = l as THREE.DirectionalLight; if ((l as THREE.HemisphereLight).isHemisphereLight && !this.hemiLight) this.hemiLight = l as THREE.HemisphereLight; });
      if (!this.sunLight || !this.hemiLight) return;
    }
    const s = this.sunLight;
    shared.sunDir.value.subVectors(s.position, s.target.position).normalize();
    shared.sunCol.value.copy(s.color).multiplyScalar(s.intensity);
    shared.hemiSky.value.copy(this.hemiLight.color).multiplyScalar(this.hemiLight.intensity);
    shared.hemiGround.value.copy(this.hemiLight.groundColor).multiplyScalar(this.hemiLight.intensity);
  }

  private updateStats(): void {
    let tris = 0, l0 = 0, l1 = 0, bb = 0;
    const by: Record<string, number> = {};
    for (const o of this.group.children) {
      const m = o as THREE.InstancedMesh; const g = m.geometry as THREE.BufferGeometry;
      const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const n = m.isInstancedMesh ? m.count : (g as THREE.InstancedBufferGeometry).instanceCount;
      tris += t * n;
      if (m.isInstancedMesh) { if (m.name.endsWith('l0')) l0 += t * n; else l1 += t * n; } else bb += t * n;
      by[o.name] = (by[o.name] ?? 0) + Math.round(t * n);
    }
    this.stats = { meshes: this.group.children.length, triangles: Math.round(tris), l0: Math.round(l0), l1: Math.round(l1), bb: Math.round(bb), by };
  }

  private updateChunk(rec: ChunkRec, px: number, pz: number): void {
    const half = CHUNK_SIZE / 2;
    const dmin = Math.hypot(Math.max(0, Math.abs(px - rec.cx) - half), Math.max(0, Math.abs(pz - rec.cz) - half));
    const dmax = Math.hypot(Math.abs(px - rec.cx) + half, Math.abs(pz - rec.cz) + half);
    const ids = new Set<string>();
    for (const c of rec.cells) for (const id of c.species.keys()) ids.add(id);
    let bbMin = Infinity, bbMax = 0, bbSpecies = 0;
    for (const id of ids) {
      const sp = this.species.get(id)!; const lod = sp.lod;
      if (lod[1] > lod[0]) {
        const want = dmax >= lod[0] - BAND && dmin < lod[1] + BAND;
        const keep = dmax >= lod[0] - BAND - 15 && dmin < lod[1] + BAND + 15;
        let cur = rec.l1.get(id);
        if (want && !cur) {
          cur = [];
          for (let v = 0; v < sp.variants.length; v++) {
            const lists: Float32Array[] = [];
            for (const c of rec.cells) { const cs = c.species.get(id); if (cs && cs.data[v] && cs.data[v].length) lists.push(cs.data[v]); }
            cur.push(lists.length ? this.makeBatch(sp, v, lists, 'l1', rec.cx, rec.cz, half, lod[0], lod[1]) : null);
          }
          rec.l1.set(id, cur);
        } else if (!keep && cur) { for (const b of cur) if (b) this.destroyBatch(b); rec.l1.delete(id); }
      }
      if (lod[2] > 0) { bbSpecies++; bbMin = Math.min(bbMin, lod[1]); bbMax = Math.max(bbMax, lod[2]); }
    }
    if (bbSpecies) {
      const want = dmax >= bbMin && dmin < bbMax;
      const keep = dmax >= bbMin - 18 && dmin < bbMax + 18;
      if ((want && !rec.bb) || (rec.bb && rec.bbSpecies !== bbSpecies)) {
        if (rec.bb) { this.group.remove(rec.bb); rec.bb.geometry.dispose(); }
        rec.bb = this.buildBillboards(rec); rec.bbSpecies = bbSpecies;
      } else if (!keep && rec.bb) { this.group.remove(rec.bb); rec.bb.geometry.dispose(); rec.bb = null; }
    }
  }

  private makeBatch(sp: SpeciesAssets, v: number, src: Float32Array[], k: 'l0' | 'l1', cx: number, cz: number, half: number, lo: number, hi: number): Batch | null {
    const va = sp.variants[v]; if (!va) return null;
    let cap = 0; for (const d of src) cap += d.length / 5;
    if (!cap) return null;
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    attr.setUsage(THREE.DynamicDrawUsage);
    const sphere = new THREE.Sphere(new THREE.Vector3(cx, va.height * 0.5, cz), half * 1.5 + va.height + va.width);
    const parts = k === 'l0' ? va.lod0 : va.lod1;
    const shadow = sp.def.castShadow && quality.shadows && (k === 'l0' || quality.tier === 'high');
    const meshes: THREE.InstancedMesh[] = [];
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, cap);
      im.instanceMatrix = attr;
      im.boundingSphere = sphere;
      im.castShadow = shadow && !!part.depth; im.receiveShadow = false;
      if (im.castShadow) im.customDepthMaterial = part.depth;
      im.matrixAutoUpdate = false;
      im.name = `${sp.def.id}-${k}`;
      im.count = 0;
      this.group.add(im); meshes.push(im);
    }
    const b: Batch = { attr, meshes, src, lo, hi, cx, cz, half, fx: 1e9, fz: 1e9, count: 0 };
    this.fill(b, this.playerPos.x, this.playerPos.z);
    this.batches.add(b);
    return b;
  }

  /** Write the instances inside [lo-BAND, hi+BAND) of the player; returns the work done. */
  private fill(b: Batch, px: number, pz: number): number {
    const e = b.attr.array as Float32Array;
    const lo = Math.max(0, b.lo - BAND), hi = b.hi + BAND;
    let n = 0, work = 0;
    for (const d of b.src) {
      for (let k = 0; k < d.length; k += 5) {
        work++;
        const dist = Math.hypot(d[k] - px, d[k + 2] - pz);
        if (dist < lo || dist >= hi) continue;
        const c = Math.cos(d[k + 3]), s = Math.sin(d[k + 3]), S = d[k + 4];
        const o = n * 16;
        e[o] = c * S; e[o + 1] = 0; e[o + 2] = -s * S; e[o + 3] = 0;
        e[o + 4] = 0; e[o + 5] = S; e[o + 6] = 0; e[o + 7] = 0;
        e[o + 8] = s * S; e[o + 9] = 0; e[o + 10] = c * S; e[o + 11] = 0;
        e[o + 12] = d[k]; e[o + 13] = d[k + 1]; e[o + 14] = d[k + 2]; e[o + 15] = 1;
        n++;
      }
    }
    b.count = n; b.fx = px; b.fz = pz;
    b.attr.clearUpdateRanges(); b.attr.addUpdateRange(0, Math.max(16, n * 16)); b.attr.needsUpdate = true;
    for (const m of b.meshes) { m.count = n; m.visible = n > 0; }
    return work;
  }

  private destroyBatch(b: Batch): void {
    for (const m of b.meshes) { this.group.remove(m); m.dispose(); }
    this.batches.delete(b);
  }

  private buildBillboards(rec: ChunkRec): THREE.Mesh | null {
    if (!this.atlasMat) return null;
    const entries: { sp: SpeciesAssets; cs: CellSpecies }[] = [];
    let count = 0;
    for (const c of rec.cells) for (const [id, cs] of c.species) {
      const sp = this.species.get(id)!; if (!(sp.lod[2] > 0)) continue;
      entries.push({ sp, cs }); for (const d of cs.data) count += d.length / 5;
    }
    if (!count) return null;
    const ipos = new Float32Array(count * 3), isize = new Float32Array(count * 2), iseed = new Float32Array(count), islot = new Float32Array(count), irange = new Float32Array(count * 2);
    let i = 0, hmax = 0, wmax = 0;
    for (const { sp, cs } of entries) {
      for (let v = 0; v < cs.data.length; v++) {
        const data = cs.data[v]; const va = sp.variants[v]; const b = va.bounds;
        if (va.slot < 0) continue;
        hmax = Math.max(hmax, va.height); wmax = Math.max(wmax, va.width);
        for (let k = 0; k < data.length; k += 5) {
          const sc = data[k + 4];
          ipos[i * 3] = data[k] + ((b.min.x + b.max.x) / 2) * sc; ipos[i * 3 + 1] = data[k + 1] + b.min.y * sc; ipos[i * 3 + 2] = data[k + 2] + ((b.min.z + b.max.z) / 2) * sc;
          isize[i * 2] = va.width * 1.02 * sc; isize[i * 2 + 1] = va.height * 1.02 * sc; iseed[i] = (i * 0.37) % 1; islot[i] = va.slot;
          irange[i * 2] = sp.lod[1]; irange[i * 2 + 1] = sp.lod[2];
          i++;
        }
      }
    }
    if (!i) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.billboardGeo.index; g.attributes.position = this.billboardGeo.attributes.position; g.attributes.uv = this.billboardGeo.attributes.uv;
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(ipos, 3));
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(isize, 2));
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iseed, 1));
    g.setAttribute('iSlot', new THREE.InstancedBufferAttribute(islot, 1));
    g.setAttribute('iRange', new THREE.InstancedBufferAttribute(irange, 2));
    g.instanceCount = i;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(rec.cx, hmax, rec.cz), CHUNK_SIZE * 0.75 + hmax * 2 + wmax * 2);
    const mesh = new THREE.Mesh(g, this.atlasMat);
    mesh.name = 'billboards';
    this.group.add(mesh);
    return mesh;
  }

  private async loadSpecies(id: string): Promise<void> {
    const sp = this.species.get(id)!;
    this.loading++;
    try {
      const gltf: GLTF = await this.loader.loadAsync(`/assets/env/${id}.glb`);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const windAmt = sp.def.kind === 'rock' ? 0 : sp.def.kind === 'tree' ? 1 : 1.6;
      const collect = (node: THREE.Object3D): Part[] => {
        const parts: Part[] = [];
        node.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) parts.push({ geometry: bakedGeometry(m), material: (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material }); });
        return parts;
      };
      const variants: Variant[] = [];
      const maxVariants = 3;
      for (let v = 0; v < maxVariants; v++) {
        const n0 = root.getObjectByName(`V${v}_LOD0`);
        if (!n0) break;
        const n1 = root.getObjectByName(`V${v}_LOD1`);
        const lod0 = collect(n0); const lod1 = n1 ? collect(n1) : lod0;
        if (!lod0.length) continue;
        const bounds = new THREE.Box3();
        for (const p of lod0) bounds.union(p.geometry.boundingBox!);
        const size = bounds.getSize(new THREE.Vector3());
        variants.push({ lod0, lod1: lod1.length ? lod1 : lod0, bounds, height: Math.max(size.y, 0.2), width: Math.max(size.x, size.z, 0.2), slot: -1 });
      }
      if (!variants.length) { // legacy single-model file
        const lod0 = collect(root.getObjectByName('LOD0') ?? root); const lod1 = root.getObjectByName('LOD1') ? collect(root.getObjectByName('LOD1')!) : lod0;
        const bounds = new THREE.Box3(); for (const p of lod0) bounds.union(p.geometry.boundingBox!);
        const size = bounds.getSize(new THREE.Vector3());
        variants.push({ lod0, lod1, bounds, height: Math.max(size.y, 0.2), width: Math.max(size.x, size.z, 0.2), slot: -1 });
      }
      const lod = sp.lod;
      const prep = (parts: Part[], range: [number, number], tag: string, va: Variant, shadow: boolean) => {
        for (const it of parts) {
          const m = (it.material as THREE.MeshStandardMaterial).clone();
          const cutout = !!m.alphaMap || m.alphaTest > 0 || m.transparent || sp.def.kind !== 'rock';
          if (cutout) { m.alphaTest = 0.5; m.transparent = false; m.side = THREE.DoubleSide; m.depthWrite = true; }
          m.vertexColors = !!it.geometry.getAttribute('color');
          m.roughness = sp.def.kind === 'rock' ? Math.max(m.roughness, 0.7) : 0.9; m.envMapIntensity = sp.def.kind === 'rock' ? 0.5 : 0.35; m.metalness = 0;
          vegetationHooks(m, range, va.height, windAmt, `${id}-${tag}`, cutout && sp.def.kind !== 'rock');
          it.material = m;
          if (shadow) {
            const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
            if (cutout) { dm.alphaTest = 0.5; dm.map = m.map; dm.side = THREE.DoubleSide; }
            dm.onBeforeCompile = m.onBeforeCompile; dm.customProgramCacheKey = () => `${m.customProgramCacheKey()}-depth`;
            it.depth = dm;
          }
        }
      };
      for (const va of variants) {
        prep(va.lod0, [0, lod[0]], 'l0', va, sp.def.castShadow);
        if (va.lod1 !== va.lod0) prep(va.lod1, [lod[0], lod[1]], 'l1', va, sp.def.castShadow && quality.tier === 'high');
      }
      sp.variants = variants;
      if (lod[2] > 0) this.renderImpostors(sp);
      sp.loaded = true; this.version++;
    } catch (e) {
      console.warn(`vegetation ${id} failed to load`, e);
      sp.failed = true;
    }
    this.loading--;
    for (const rec of this.chunks.values()) for (const c of rec.cells) this.resolvePending(c);
  }

  private ensureAtlas(): void {
    if (this.atlas) return;
    const size = this.atlasGrid * this.atlasSlot;
    const mk = (cs: THREE.ColorSpace) => {
      const rt = new THREE.WebGLRenderTarget(size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: cs });
      rt.texture.minFilter = THREE.LinearMipmapLinearFilter; rt.texture.generateMipmaps = true;
      return rt;
    };
    this.atlas = mk(THREE.SRGBColorSpace); this.natlas = mk(THREE.NoColorSpace);
    const r = this.renderer; const prevRT = r.getRenderTarget();
    for (const rt of [this.atlas, this.natlas]) { r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); }
    r.setRenderTarget(prevRT);
    this.atlasMat = new THREE.ShaderMaterial({
      vertexShader: BILL_V, fragmentShader: BILL_F, fog: true, transparent: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, nmap: { value: null }, uTime: { value: 0 }, uGrid: { value: this.atlasGrid } }]),
    });
    const u = this.atlasMat.uniforms;
    u.map.value = this.atlas.texture; u.nmap.value = this.natlas.texture; u.uTime = shared.time; u.uLodCenter = shared.center;
    u.uSunDir = shared.sunDir; u.uSunCol = shared.sunCol; u.uHemiSky = shared.hemiSky; u.uHemiGround = shared.hemiGround;
  }

  /** Renders each variant into a slot of the albedo atlas (unlit, crown AO baked) and of the normal atlas. */
  private renderImpostors(sp: SpeciesAssets): void {
    this.ensureAtlas();
    const r = this.renderer; const res = this.atlasSlot;
    const prevRT = r.getRenderTarget(); const prevClear = r.getClearAlpha(); const prevColor = r.getClearColor(new THREE.Color());
    const prevScissor = r.getScissorTest();
    const prevViewport = r.getViewport(new THREE.Vector4()); const prevScissorBox = r.getScissor(new THREE.Vector4());
    r.setClearColor(0x000000, 0);
    r.setScissorTest(true);
    for (const va of sp.variants) {
      if (this.nextSlot >= this.atlasGrid * this.atlasGrid) break;
      va.slot = this.nextSlot++;
      const albedo = new THREE.Group(), normals = new THREE.Group();
      const mats: THREE.Material[] = [];
      for (const it of va.lod0) {
        const src = it.material as THREE.MeshStandardMaterial;
        const am = new THREE.MeshBasicMaterial({ map: src.map, color: src.color, alphaTest: src.alphaTest, side: src.side, vertexColors: src.vertexColors, fog: false });
        am.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `${FOLIAGE_ALPHA}\ndiffuseColor.a = 1.0;`); };
        am.customProgramCacheKey = () => `imp-a-${am.map ? 1 : 0}-${am.alphaTest > 0 ? 1 : 0}-${am.vertexColors ? 1 : 0}`;
        const nm = new THREE.ShaderMaterial({
          side: src.side,
          uniforms: { map: { value: src.map }, useMap: { value: src.map && src.alphaTest > 0 ? 1 : 0 } },
          vertexShader: 'varying vec3 vN; varying vec2 vUv; void main() { vN = normal; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `uniform sampler2D map; uniform float useMap; varying vec3 vN; varying vec2 vUv;
void main() {
  if (useMap > 0.5) { vec2 tsz = vec2(textureSize(map, 0)); vec2 ddx = dFdx(vUv * tsz), ddy = dFdy(vUv * tsz);
    float mipL = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy)))); if (texture2D(map, vUv).a * (1.0 + mipL * 0.28) < 0.5) discard; }
  vec3 n = normalize(vN); if (!gl_FrontFacing && useMap < 0.5) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
        });
        mats.push(am, nm);
        albedo.add(new THREE.Mesh(it.geometry, am)); normals.add(new THREE.Mesh(it.geometry, nm));
      }
      const b = va.bounds; const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const w = va.width * 1.02, h = va.height * 1.02;
      this.impostorCam.left = -w / 2; this.impostorCam.right = w / 2; this.impostorCam.top = b.min.y + h; this.impostorCam.bottom = b.min.y;
      this.impostorCam.near = 0.1; this.impostorCam.far = 400;
      this.impostorCam.position.set(cx, 0, cz + 150); this.impostorCam.lookAt(cx, 0, cz); this.impostorCam.updateProjectionMatrix();
      const sx = (va.slot % this.atlasGrid) * res, sy = Math.floor(va.slot / this.atlasGrid) * res;
      for (const [rt, grp] of [[this.atlas!, albedo], [this.natlas!, normals]] as const) {
        r.setRenderTarget(rt);
        r.setViewport(sx, sy, res, res); r.setScissor(sx, sy, res, res);
        r.clear();
        this.impostorScene.add(grp);
        r.render(this.impostorScene, this.impostorCam);
        this.impostorScene.remove(grp);
      }
      for (const m of mats) m.dispose();
    }
    r.setScissorTest(prevScissor);
    r.setRenderTarget(prevRT); r.setClearColor(prevColor, prevClear);
    r.setViewport(prevViewport); r.setScissor(prevScissorBox);
    // species whose variants have no slot (atlas full) get no billboards
    if (sp.variants.some((v) => v.slot < 0)) sp.lod[2] = 0;
  }

  /** Every placed tree / rock: trunk (or rock) radius, canopy radius and height, in metres. */
  forEachObstacle(cb: (x: number, z: number, r: number, canopy: number, height: number, tree: boolean) => void): void {
    for (const rec of this.chunks.values()) for (const c of rec.cells) for (const [id, cs] of c.species) {
      const sp = this.species.get(id)!; if (sp.def.kind === 'plant') continue;
      const tree = sp.def.kind === 'tree';
      for (let v = 0; v < cs.data.length; v++) {
        const data = cs.data[v]; const va = sp.variants[v]; if (!va) continue;
        for (let k = 0; k < data.length; k += 5) {
          const sc = data[k + 4];
          const r = (tree ? Math.min(1.2, va.width * 0.12) : va.width * 0.45) * sc + 0.3;
          cb(data[k], data[k + 2], r, tree ? va.width * 0.5 * sc : r, va.height * sc, tree);
        }
      }
    }
  }

  /** Blocking tree trunk / rock near (x,z), or null. */
  obstacleAt(x: number, z: number): { x: number; z: number; r: number } | null {
    let best: { x: number; z: number; r: number } | null = null, bd = Infinity;
    for (const rec of this.chunks.values()) {
      if (Math.abs(rec.cx - x) > 80 || Math.abs(rec.cz - z) > 80) continue;
      for (const c of rec.cells) for (const [id, cs] of c.species) {
        const sp = this.species.get(id)!; if (sp.def.kind === 'plant') continue;
        for (let v = 0; v < cs.data.length; v++) {
          const data = cs.data[v]; const va = sp.variants[v]; if (!va) continue;
          const foot = sp.def.kind === 'tree' ? Math.min(1.2, va.width * 0.12) : va.width * 0.45;
          for (let k = 0; k < data.length; k += 5) {
            const r = foot * data[k + 4] + 0.3;
            const d = Math.hypot(data[k] - x, data[k + 2] - z);
            if (d < r && d < bd) { bd = d; best = { x: data[k], z: data[k + 2], r }; }
          }
        }
      }
    }
    return best;
  }

  /** Nearest placed instance of a species to (x,z): [x,y,z] or null. */
  nearest(id: string, x: number, z: number): [number, number, number] | null {
    let best: [number, number, number] | null = null, bd = Infinity;
    for (const rec of this.chunks.values()) for (const c of rec.cells) {
      const cs = c.species.get(id); if (!cs) continue;
      for (const data of cs.data) for (let k = 0; k < data.length; k += 5) {
        const d = Math.hypot(data[k] - x, data[k + 2] - z);
        if (d < bd) { bd = d; best = [data[k], data[k + 1], data[k + 2]]; }
      }
    }
    return best;
  }

  get loadedCount(): number { let n = 0; for (const s of this.species.values()) if (s.loaded || s.failed) n++; return n; }
}
