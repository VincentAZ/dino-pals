// Instanced vegetation/rocks. Each terrain chunk is split into 50 m cells;
// per cell+species+variant we create instanced meshes only for the LOD buckets
// the cell's distance range needs (LOD0 mesh / LOD1 mesh / impostor billboard).
// A vertex-shader distance test gives smooth per-instance LOD transitions.
import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VEG, type VegSpecies } from './vegrules.ts';
import type { VegPlacement } from './terrain.ts';
import { CHUNK_SIZE, quality } from '../config.ts';
import { HALF } from './biomes.ts';

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; depth?: THREE.Material }
interface Variant { lod0: Part[]; lod1: Part[]; bounds: THREE.Box3; height: number; width: number; slot: number }
interface SpeciesAssets { def: VegSpecies; variants: Variant[]; loaded: boolean; failed: boolean }

const STRIDE = 6; // x, y, z, rotY, scale, variantSeed
const CELLS = 2;  // cells per chunk side
const CELL = CHUNK_SIZE / CELLS;

interface CellSpecies { data: Float32Array[]; meshes: Record<'l0' | 'l1', THREE.Object3D[] | null> }
interface Cell { cx: number; cz: number; species: Map<string, CellSpecies>; pending: VegPlacement }
interface ChunkRec { cx: number; cz: number; cells: Cell[]; bb: THREE.Mesh | null; bbSpecies: number; l1: Map<string, THREE.Object3D[] | null> }

const shared = { time: { value: 0 }, wind: { value: 1 }, light: { value: new THREE.Color(1, 1, 1) } };

function vegetationHooks(mat: THREE.Material, range: [number, number], height: number, windAmt: number, key: string): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.time; shader.uniforms.uWind = shared.wind;
    shader.uniforms.uLodRange = { value: new THREE.Vector2(range[0], range[1]) };
    shader.uniforms.uHeight = { value: height }; shader.uniforms.uWindAmt = { value: windAmt };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; uniform float uWind; uniform vec2 uLodRange; uniform float uHeight; uniform float uWindAmt;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float dCam = distance(iPos, cameraPosition);
  float vis = (dCam >= uLodRange.x && dCam < uLodRange.y) ? 1.0 : 0.0;
  float hf = clamp(transformed.y / max(uHeight, 0.01), 0.0, 1.0);
  float ph = uTime * 1.3 + iPos.x * 0.21 + iPos.z * 0.17;
  float sway = (sin(ph) * 0.65 + sin(ph * 2.7 + 1.3) * 0.25 + sin(ph * 5.1) * 0.1) * uWind * uWindAmt;
  transformed.x += sway * hf * hf * uHeight * 0.05;
  transformed.z += sway * hf * hf * uHeight * 0.03 * cos(ph * 0.7);
  transformed *= vis;
#endif`);
  };
  mat.customProgramCacheKey = () => `veg-${key}`;
}

const BILL_V = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPos; attribute vec2 iSize; attribute float iSeed; attribute float iSlot; attribute vec2 iRange;
varying vec2 vUv;
uniform float uTime; uniform float uGrid;
void main() {
  float col = mod(iSlot, uGrid); float row = floor(iSlot / uGrid);
  vUv = vec2((col + uv.x) / uGrid, (row + uv.y) / uGrid);
  float d = distance(iPos, cameraPosition);
  float vis = (d >= iRange.x && d < iRange.y) ? 1.0 : 0.0;
  vec3 toCam = cameraPosition - iPos; toCam.y = 0.0; toCam = normalize(toCam);
  vec3 right = vec3(-toCam.z, 0.0, toCam.x);
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
uniform sampler2D map; uniform vec3 uLight;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.45) discard;
  gl_FragColor = vec4(c.rgb * uLight, 1.0);
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
  private loader: GLTFLoader;
  private renderer: THREE.WebGLRenderer;
  private impostorScene = new THREE.Scene();
  private impostorCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private billboardGeo = new THREE.PlaneGeometry(1, 1);
  private atlas: THREE.WebGLRenderTarget | null = null;
  private atlasMat: THREE.ShaderMaterial | null = null;
  private atlasGrid = 8;
  private atlasSlot = 256;
  private nextSlot = 0;
  private loadQueue: string[] = [];
  private loading = 0;
  private playerPos = new THREE.Vector3();
  private frame = 0;
  stats: { meshes: number; triangles: number; l0: number; l1: number; bb: number; by: Record<string, number> } = { meshes: 0, triangles: 0, l0: 0, l1: 0, bb: 0, by: {} };

  constructor(renderer: THREE.WebGLRenderer, loader: GLTFLoader) {
    this.renderer = renderer; this.loader = loader;
    this.group.name = 'vegetation';
    const amb = new THREE.HemisphereLight(0xffffff, 0x777777, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(2, 4, 5);
    this.impostorScene.add(amb, sun);
    for (const v of VEG) this.species.set(v.id, { def: v, variants: [], loaded: false, failed: false });
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
  }

  removeChunk(key: string): void {
    const rec = this.chunks.get(key);
    if (!rec) return;
    for (const c of rec.cells) for (const cs of c.species.values()) for (const k of ['l0', 'l1'] as const) this.destroy(cs, k);
    if (rec.bb) { this.group.remove(rec.bb); rec.bb.geometry.dispose(); }
    for (const list of rec.l1.values()) if (list) for (const m of list) { this.group.remove(m); (m as THREE.InstancedMesh).dispose(); }
    this.chunks.delete(key);
  }

  private resolvePending(cell: Cell): void {
    for (const [id, data] of Object.entries(cell.pending)) {
      const sp = this.species.get(id);
      if (!sp) { delete cell.pending[id]; continue; }
      if (sp.failed) { delete cell.pending[id]; continue; }
      if (!sp.loaded) continue;
      // split by variant
      const nv = sp.variants.length;
      const lists: number[][] = Array.from({ length: nv }, () => []);
      for (let k = 0; k < data.length; k += STRIDE) {
        const v = Math.min(nv - 1, Math.floor(data[k + 5] * nv));
        lists[v].push(data[k], data[k + 1], data[k + 2], data[k + 3], data[k + 4]);
      }
      cell.species.set(id, { data: lists.map((l) => new Float32Array(l)), meshes: { l0: null, l1: null } });
      delete cell.pending[id];
    }
  }

  update(dt: number, light: THREE.Color, playerPos: THREE.Vector3): void {
    shared.time.value += dt;
    shared.light.value.copy(light);
    this.playerPos.copy(playerPos);
    while (this.loading < 2 && this.loadQueue.length) this.loadSpecies(this.loadQueue.shift()!);
    // LOD bucket maintenance, spread over frames
    this.frame++;
    let i = 0;
    for (const rec of this.chunks.values()) {
      if ((i++ + this.frame) % 4 === 0) this.updateChunkBillboards(rec, playerPos);
      for (const cell of rec.cells) {
      if ((i++ + this.frame) % 4 !== 0) continue;
      const dx = Math.max(0, Math.abs(playerPos.x - cell.cx) - CELL / 2), dz = Math.max(0, Math.abs(playerPos.z - cell.cz) - CELL / 2);
      const dmin = Math.hypot(dx, dz);
      const dmax = Math.hypot(Math.abs(playerPos.x - cell.cx) + CELL / 2, Math.abs(playerPos.z - cell.cz) + CELL / 2);
      for (const [id, cs] of cell.species) {
        const sp = this.species.get(id)!; const lod = sp.def.lod;
        const want0 = lod[0] > 0 && dmin < lod[0];
        const chunkL1 = lod[0] > 0; // everything but near-only grass builds LOD1 per chunk (fewer draw calls)
        const want1 = !chunkL1 && lod[1] > 0 && dmax >= lod[0] && dmin < lod[1];
        const m = 18; // hysteresis margin
        const keep0 = lod[0] > 0 && dmin < lod[0] + m;
        const keep1 = !chunkL1 && lod[1] > 0 && dmax >= lod[0] - m && dmin < lod[1] + m;
        if (want0 && !cs.meshes.l0) this.build(sp, cell, cs, 'l0'); else if (!keep0 && cs.meshes.l0) this.destroy(cs, 'l0');
        if (want1 && !cs.meshes.l1) this.build(sp, cell, cs, 'l1'); else if (!keep1 && cs.meshes.l1) this.destroy(cs, 'l1');
      }
      }
    }
    if (this.frame % 30 === 0) {
      let tris = 0, l0 = 0, l1 = 0, bb = 0;
      for (const o of this.group.children) {
        const m = o as THREE.InstancedMesh; const g = m.geometry as THREE.BufferGeometry;
        const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        if (m.isInstancedMesh) { tris += t * m.count; if (m.name.endsWith('l0')) l0 += t * m.count; else l1 += t * m.count; }
        else { const ig = g as THREE.InstancedBufferGeometry; tris += t * ig.instanceCount; bb += t * ig.instanceCount; }
      }
      const by: Record<string, number> = {};
      for (const o of this.group.children) by[o.name] = (by[o.name] ?? 0) + 1;
      this.stats = { meshes: this.group.children.length, triangles: Math.round(tris), l0: Math.round(l0), l1: Math.round(l1), bb: Math.round(bb), by };
    }
  }

  private updateChunkBillboards(rec: ChunkRec, playerPos: THREE.Vector3): void {
    const half = CHUNK_SIZE / 2;
    const dx = Math.max(0, Math.abs(playerPos.x - rec.cx) - half), dz = Math.max(0, Math.abs(playerPos.z - rec.cz) - half);
    const dmin = Math.hypot(dx, dz);
    const dmax = Math.hypot(Math.abs(playerPos.x - rec.cx) + half, Math.abs(playerPos.z - rec.cz) + half);
    // species present in any cell
    const ids = new Set<string>();
    for (const c of rec.cells) for (const id of c.species.keys()) ids.add(id);
    let bbMin = Infinity, bbMax = 0, bbSpecies = 0;
    for (const id of ids) {
      const sp = this.species.get(id)!; const lod = sp.def.lod;
      if (lod[0] > 0 && lod[1] > lod[0]) {
        const want1 = dmax >= lod[0] && dmin < lod[1];
        const keep1 = dmax >= lod[0] - 18 && dmin < lod[1] + 18;
        const cur1 = rec.l1.get(id) ?? null;
        if (want1 && !cur1) rec.l1.set(id, this.buildChunkLod1(sp, rec));
        else if (!keep1 && cur1) { for (const m of cur1) { this.group.remove(m); (m as THREE.InstancedMesh).dispose(); } rec.l1.set(id, null); }
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

  private buildChunkLod1(sp: SpeciesAssets, rec: ChunkRec): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let v = 0; v < sp.variants.length; v++) {
      const va = sp.variants[v];
      const lists: Float32Array[] = [];
      let count = 0;
      for (const c of rec.cells) { const cs = c.species.get(sp.def.id); if (cs && cs.data[v]) { lists.push(cs.data[v]); count += cs.data[v].length / 5; } }
      if (!count) continue;
      const sphere = new THREE.Sphere(new THREE.Vector3(rec.cx, va.height / 2, rec.cz), CHUNK_SIZE * 0.75 + va.height + va.width);
      for (const part of va.lod1) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, count);
        let i = 0;
        for (const data of lists) for (let k = 0; k < data.length; k += 5) {
          pos.set(data[k], data[k + 1], data[k + 2]); q.setFromAxisAngle(up, data[k + 3]); scl.setScalar(data[k + 4]);
          im.setMatrixAt(i++, m4.compose(pos, q, scl));
        }
        im.instanceMatrix.needsUpdate = true; im.boundingSphere = sphere.clone(); im.castShadow = false; im.receiveShadow = false;
        im.name = `${sp.def.id}-l1`;
        this.group.add(im); out.push(im);
      }
    }
    return out;
  }

  private buildBillboards(rec: ChunkRec): THREE.Mesh | null {
    if (!this.atlasMat) return null;
    const entries: { sp: SpeciesAssets; cs: CellSpecies }[] = [];
    let count = 0;
    for (const c of rec.cells) for (const [id, cs] of c.species) {
      const sp = this.species.get(id)!; if (!(sp.def.lod[2] > 0)) continue;
      entries.push({ sp, cs }); for (const d of cs.data) count += d.length / 5;
    }
    if (!count) return null;
    const ipos = new Float32Array(count * 3), isize = new Float32Array(count * 2), iseed = new Float32Array(count), islot = new Float32Array(count), irange = new Float32Array(count * 2);
    let i = 0, hmax = 0, wmax = 0;
    for (const { sp, cs } of entries) {
      for (let v = 0; v < cs.data.length; v++) {
        const data = cs.data[v]; const va = sp.variants[v]; const b = va.bounds;
        hmax = Math.max(hmax, va.height); wmax = Math.max(wmax, va.width);
        for (let k = 0; k < data.length; k += 5) {
          const sc = data[k + 4];
          ipos[i * 3] = data[k] + ((b.min.x + b.max.x) / 2) * sc; ipos[i * 3 + 1] = data[k + 1] + b.min.y * sc; ipos[i * 3 + 2] = data[k + 2] + ((b.min.z + b.max.z) / 2) * sc;
          isize[i * 2] = va.width * 1.02 * sc; isize[i * 2 + 1] = va.height * 1.02 * sc; iseed[i] = (i * 0.37) % 1; islot[i] = va.slot;
          irange[i * 2] = sp.def.lod[1]; irange[i * 2 + 1] = sp.def.lod[2];
          i++;
        }
      }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.billboardGeo.index; g.attributes.position = this.billboardGeo.attributes.position; g.attributes.uv = this.billboardGeo.attributes.uv;
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(ipos, 3));
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(isize, 2));
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iseed, 1));
    g.setAttribute('iSlot', new THREE.InstancedBufferAttribute(islot, 1));
    g.setAttribute('iRange', new THREE.InstancedBufferAttribute(irange, 2));
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(rec.cx, hmax, rec.cz), CHUNK_SIZE * 0.75 + hmax * 2 + wmax * 2);
    const mesh = new THREE.Mesh(g, this.atlasMat);
    mesh.name = 'billboards';
    this.group.add(mesh);
    return mesh;
  }

  private destroy(cs: CellSpecies, k: 'l0' | 'l1'): void {
    const list = cs.meshes[k];
    if (!list) return;
    for (const m of list) {
      this.group.remove(m);
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
      else (m as THREE.Mesh).geometry.dispose();
    }
    cs.meshes[k] = null;
  }

  private build(sp: SpeciesAssets, cell: Cell, cs: CellSpecies, k: 'l0' | 'l1'): void {
    const out: THREE.Object3D[] = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const sphere = new THREE.Sphere(new THREE.Vector3(cell.cx, 0, cell.cz), CELL * 0.75);
    for (let v = 0; v < sp.variants.length; v++) {
      const data = cs.data[v]; const count = data.length / 5;
      if (!count) continue;
      const va = sp.variants[v];
      sphere.center.y = va.height * 0.5; sphere.radius = CELL * 0.75 + va.height + va.width;
      const parts = k === 'l0' ? va.lod0 : va.lod1;
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, count);
        for (let i = 0; i < count; i++) {
          pos.set(data[i * 5], data[i * 5 + 1], data[i * 5 + 2]);
          q.setFromAxisAngle(up, data[i * 5 + 3]); scl.setScalar(data[i * 5 + 4]);
          im.setMatrixAt(i, m4.compose(pos, q, scl));
        }
        im.instanceMatrix.needsUpdate = true;
        im.boundingSphere = sphere.clone();
        im.castShadow = k === 'l0' && sp.def.castShadow && quality.shadows; im.receiveShadow = false;
        if (im.castShadow && part.depth) im.customDepthMaterial = part.depth;
        im.name = `${sp.def.id}-${k}`;
        this.group.add(im); out.push(im);
      }
    }
    cs.meshes[k] = out;
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
      const lod = sp.def.lod;
      const prep = (parts: Part[], range: [number, number], tag: string, va: Variant, shadow: boolean) => {
        for (const it of parts) {
          const m = (it.material as THREE.MeshStandardMaterial).clone();
          const cutout = !!m.alphaMap || m.alphaTest > 0 || m.transparent || sp.def.kind !== 'rock';
          if (cutout) { m.alphaTest = 0.5; m.transparent = false; m.side = THREE.DoubleSide; m.depthWrite = true; }
          m.vertexColors = m.name.startsWith('canopy_') && !!it.geometry.getAttribute('color');
          m.roughness = sp.def.kind === 'rock' ? Math.max(m.roughness, 0.7) : 0.95; m.envMapIntensity = sp.def.kind === 'rock' ? 0.5 : 0.25; m.metalness = 0;
          vegetationHooks(m, range, va.height, windAmt, `${id}-${tag}`);
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
        if (va.lod1 !== va.lod0) prep(va.lod1, [lod[0], lod[1]], 'l1', va, false);
      }
      sp.variants = variants;
      if (lod[2] > 0) this.renderImpostors(sp);
      sp.loaded = true;
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
    this.atlas = new THREE.WebGLRenderTarget(size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: THREE.LinearSRGBColorSpace });
    this.atlas.texture.minFilter = THREE.LinearMipmapLinearFilter; this.atlas.texture.generateMipmaps = true;
    const r = this.renderer; const prevRT = r.getRenderTarget();
    r.setRenderTarget(this.atlas); r.setClearColor(0x000000, 0); r.clear(); r.setRenderTarget(prevRT);
    this.atlasMat = new THREE.ShaderMaterial({
      vertexShader: BILL_V, fragmentShader: BILL_F, fog: true, transparent: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uLight: { value: null }, uTime: { value: 0 }, uGrid: { value: this.atlasGrid } }]),
    });
    this.atlasMat.uniforms.map.value = this.atlas.texture; this.atlasMat.uniforms.uLight = shared.light; this.atlasMat.uniforms.uTime = shared.time;
  }

  /** Renders each variant's LOD1 into a slot of the shared impostor atlas. */
  private renderImpostors(sp: SpeciesAssets): void {
    this.ensureAtlas();
    const r = this.renderer; const res = this.atlasSlot;
    const prevRT = r.getRenderTarget(); const prevClear = r.getClearAlpha(); const prevColor = r.getClearColor(new THREE.Color());
    const prevScissor = r.getScissorTest();
    const prevViewport = r.getViewport(new THREE.Vector4()); const prevScissorBox = r.getScissor(new THREE.Vector4());
    r.setRenderTarget(this.atlas); r.setClearColor(0x000000, 0);
    r.setScissorTest(true);
    for (const va of sp.variants) {
      if (this.nextSlot >= this.atlasGrid * this.atlasGrid) break;
      va.slot = this.nextSlot++;
      const group = new THREE.Group();
      for (const it of va.lod1) {
        const m = (it.material as THREE.MeshStandardMaterial).clone();
        m.onBeforeCompile = () => {}; m.customProgramCacheKey = () => `imp-${m.map ? 1 : 0}-${m.alphaTest > 0 ? 1 : 0}-${m.side}-${m.vertexColors ? 1 : 0}`; m.envMapIntensity = 0;
        group.add(new THREE.Mesh(it.geometry, m));
      }
      this.impostorScene.add(group);
      const b = va.bounds; const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const w = va.width * 1.02, h = va.height * 1.02;
      this.impostorCam.left = -w / 2; this.impostorCam.right = w / 2; this.impostorCam.top = b.min.y + h; this.impostorCam.bottom = b.min.y;
      this.impostorCam.near = 0.1; this.impostorCam.far = 400;
      this.impostorCam.position.set(cx, 0, cz + 150); this.impostorCam.lookAt(cx, 0, cz); this.impostorCam.updateProjectionMatrix();
      const sx = (va.slot % this.atlasGrid) * res, sy = Math.floor(va.slot / this.atlasGrid) * res;
      r.setViewport(sx, sy, res, res); r.setScissor(sx, sy, res, res);
      r.clear();
      r.render(this.impostorScene, this.impostorCam);
      this.impostorScene.remove(group);
      for (const c of group.children) ((c as THREE.Mesh).material as THREE.Material).dispose();
    }
    r.setScissorTest(prevScissor);
    r.setRenderTarget(prevRT); r.setClearColor(prevColor, prevClear);
    r.setViewport(prevViewport); r.setScissor(prevScissorBox);
    // species whose variants have no slot (atlas full) get no billboards
    if (sp.variants.some((v) => v.slot < 0)) sp.def.lod[2] = 0;
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
