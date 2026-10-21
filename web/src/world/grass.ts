// Dense near-field grass: clumps of curved, tapered blade geometry (no alpha
// test) in two toroidal rings that follow the player — a dense near ring of
// multi-segment blades and a sparser far ring of single-triangle blades that
// thins into the ground. Every clump's colour, coverage and blade type (meadow
// grass, swamp reeds, dry tufts) come from the shared ground field (field.ts),
// i.e. from the same splat weights and macro noise the terrain shader uses,
// so the grass fades into a ground of exactly its own colour. Blades are lit
// by the scene lights (Lambert + wrap + translucency) and receive shadows.
// Each ring is split into 4x4 blocks with their own bounds for frustum culling.
import * as THREE from 'three';
import { heightAt, waterAt } from './heightmap.ts';
import { HALF, LAYER_COUNT } from './biomes.ts';
import { hash2 } from '../util/noise.ts';
import { quality } from '../config.ts';
import { applySteep, grassFieldAt, sampleSplat, type FieldResult } from './field.ts';
import { groundData } from './terrain.ts';

interface RingCfg { cell: number; n: number; blades: number; segs: number; fade: [number, number, number, number]; width: number; budget: number; flowers?: boolean }

/** Blade vertex: position = (side -1/0/1, t 0..1, blade index). */
function clumpGeometry(blades: number, segs: number): THREE.BufferGeometry {
  const pos: number[] = []; const idx: number[] = [];
  const rows = segs === 1 ? [0] : segs === 2 ? [0, 0.5] : [0, 0.38, 0.72];
  for (let b = 0; b < blades; b++) {
    const base = pos.length / 3;
    for (const t of rows) pos.push(-1, t, b, 1, t, b);
    pos.push(0, 1, b);
    for (let r = 0; r < rows.length - 1; r++) { const a = base + r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    const last = base + (rows.length - 1) * 2; idx.push(last, last + 1, last + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** Flower: a thin stem (position.z = 0, like a blade) and a 6-petal star head (z = 1). */
function flowerGeometry(): THREE.BufferGeometry {
  const pos: number[] = [-1, 0, 0, 1, 0, 0, 0, 1, 0];
  const idx: number[] = [0, 1, 2];
  const c = pos.length / 3; pos.push(-1, 0, 1);
  for (let k = 0; k < 6; k++) { const v = pos.length / 3; pos.push(k * 2, 1, 1, k * 2 + 1, 1, 1); idx.push(c, v, v + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const MAX_PUSH = 16;
const shared = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uField: { value: null as THREE.Texture | null },
  /** trampling: (x, z, radius, strength) for the explorer, food piles and nearby dinosaurs */
  uPush: { value: Array.from({ length: MAX_PUSH }, () => new THREE.Vector4()) },
  uPushN: { value: 0 },
};
const TRAMPLE_GLSL = `
uniform vec4 uPush[${MAX_PUSH}]; uniform int uPushN;
// blades near feet, bodies and food piles lean away (xy) and flatten (z)
vec3 trample(vec2 p) {
  vec3 r = vec3(0.0);
  for (int k = 0; k < ${MAX_PUSH}; k++) {
    if (k >= uPushN) break;
    vec4 P = uPush[k]; vec2 dv = p - P.xy; float dd = length(dv);
    float infl = (1.0 - smoothstep(P.z * 0.45, P.z, dd)) * P.w;
    if (infl > 0.0) { r.xy += (dd > 1e-3 ? dv / dd : vec2(1.0, 0.0)) * infl; r.z = max(r.z, infl); }
  }
  return r;
}`;

function flowerMaterial(cfg: RingCfg): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime; shader.uniforms.uWindDir = shared.uWindDir; shader.uniforms.uField = shared.uField; shader.uniforms.uPush = shared.uPush; shader.uniforms.uPushN = shared.uPushN;
    shader.uniforms.uFade = { value: new THREE.Vector4(...cfg.fade) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 iPos; attribute vec4 iA; attribute vec4 iB; attribute vec3 iCol;
uniform float uTime; uniform vec2 uWindDir; uniform sampler2D uField; uniform vec4 uFade;
varying vec3 vGrassCol; varying float vGrassT;${TRAMPLE_GLSL}
float gh(float n) { return fract(sin(n) * 43758.5453123); }
vec3 gPos; vec3 gNrm;`)
      .replace('#include <beginnormal_vertex>', `{
  float seed = iB.w * 97.3;
  float r1 = gh(seed), r2 = gh(seed + 2.3), r3 = gh(seed + 4.7);
  float d = distance(iPos.xz, cameraPosition.xz);
  float alive = step(0.5, iB.z) * (1.0 - smoothstep(uFade.z, uFade.w, d));
  float H = iA.x;
  float gust = texture2D(uField, iPos.xz * 0.012 - uWindDir * uTime * 0.035).g;
  float wind = (0.05 + 0.3 * smoothstep(0.38, 0.8, gust)) * (0.8 + 0.2 * sin(uTime * 2.3 + r3 * 6.28));
  vec2 lean = vec2(cos(r1 * 6.28), sin(r1 * 6.28)) * 0.15 + uWindDir * wind;
  vec3 tr = trample(iPos.xz); lean += tr.xy * 1.4; H *= 1.0 - 0.75 * tr.z;
  vec3 top = iPos + vec3(lean.x * H, H * (1.0 - 0.3 * dot(lean, lean)), lean.y * H);
  vec3 col; vec3 n = vec3(0.0, 1.0, 0.0); float t;
  if (position.z < 0.5) {
    float tt = position.y;
    vec3 wdir = vec3(cos(r2 * 6.28), 0.0, sin(r2 * 6.28));
    gPos = mix(iPos - vec3(0.0, 0.03, 0.0), top, tt) + vec3(lean.x, 0.0, lean.y) * H * (tt * tt - tt) + wdir * position.x * 0.005 * (1.0 - tt);
    col = vec3(0.09, 0.15, 0.04); t = tt * 0.6;
    n = normalize(cross(wdir, normalize(top - iPos)));
  } else {
    float R = (0.04 + 0.025 * r3) * mix(1.0, 0.75, step(1.5, iB.x));
    vec2 tilt = vec2(cos(r2 * 6.28), sin(r2 * 6.28)) * 0.35 + lean * 0.6;
    if (position.y < 0.5) { gPos = top + vec3(0.0, 0.006, 0.0); col = vec3(0.85, 0.55, 0.04); }
    else {
      float k = floor(position.x * 0.5); float sd = position.x - k * 2.0;
      float ang = (k + (sd - 0.5) * 0.86) * 1.0471976 + r1 * 6.28;
      vec2 dv = vec2(cos(ang), sin(ang)) * R;
      gPos = top + vec3(dv.x, dot(dv, tilt) - 0.004, dv.y);
      col = iCol;
    }
    n = normalize(vec3(-tilt.x, 1.0, -tilt.y)); t = 1.0;
  }
  gPos = mix(iPos - vec3(0.0, 0.5, 0.0), gPos, alive);
  gNrm = n; vGrassCol = col; vGrassT = t;
}
vec3 objectNormal = gNrm;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol; varying float vGrassT;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrassCol;');
  };
  m.customProgramCacheKey = () => 'flowers-v1';
  return m;
}

function grassMaterial(cfg: RingCfg): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime; shader.uniforms.uWindDir = shared.uWindDir; shader.uniforms.uField = shared.uField; shader.uniforms.uPush = shared.uPush; shader.uniforms.uPushN = shared.uPushN;
    shader.uniforms.uFade = { value: new THREE.Vector4(...cfg.fade) };
    shader.uniforms.uBlades = { value: cfg.blades };
    shader.uniforms.uWidth = { value: cfg.width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 iPos; attribute vec4 iA; attribute vec4 iB; attribute vec3 iCol;
uniform float uTime; uniform vec2 uWindDir; uniform sampler2D uField; uniform vec4 uFade; uniform float uBlades; uniform float uWidth;
varying vec3 vGrassCol; varying float vGrassT;${TRAMPLE_GLSL}
float gh(float n) { return fract(sin(n) * 43758.5453123); }
vec3 gPos; vec3 gNrm;`)
      .replace('#include <beginnormal_vertex>', `{
  float side = position.x; float t = position.y; float bi = position.z;
  float seed = iB.w * 131.7 + bi * 17.13;
  float r1 = gh(seed), r2 = gh(seed + 1.71), r3 = gh(seed + 3.13), r4 = gh(seed + 5.37), r5 = gh(seed + 7.91), r6 = gh(seed + 9.17);
  float reed = iB.x, tuft = iB.y;
  // blade 0 of every clump is dead thatch lying on the ground (not on reeds)
  float thatch = (bi < 0.5 ? 1.0 : 0.0) * (1.0 - reed);
  float d = distance(iPos.xz, cameraPosition.xz);
  float dens = iB.z * smoothstep(uFade.x, uFade.y, d) * (1.0 - smoothstep(uFade.z, uFade.w, d));
  // sparse ground grows whole tufts here and there instead of scattered single blades
  float sparse = 1.0 - smoothstep(0.2, 0.55, iB.z);
  float alive = step(mix(r5, gh(iB.w * 77.7 + 3.3), sparse), mix(dens, dens * 1.4, thatch * (1.0 - sparse)));
  // clump layout: blades spread around the clump centre, leaning outward
  float a = r1 * 6.2831853 + iA.y;
  vec2 outw = vec2(cos(a), sin(a));
  float rad = sqrt(r2) * mix(mix(0.12, 0.17, reed), 0.07, tuft) * mix(1.0, 1.6, thatch);
  vec2 o = outw * rad;
  float H = iA.x * (0.45 + 1.0 * r3 * r3 + 0.15 * r6) * mix(1.0, 0.7, thatch) * (1.0 - 0.45 * smoothstep(uFade.z * 0.6, uFade.w, d));
  float lean = (0.1 + 0.6 * r4 * r4) * mix(1.0, 0.25, reed) * mix(1.0, 1.6, tuft);
  lean = mix(lean, 1.25 + 0.5 * r4, thatch);
  // wind: travelling gusts from the field noise + per-blade flutter
  float gust = texture2D(uField, iPos.xz * 0.012 - uWindDir * uTime * 0.035).g;
  float wind = (0.06 + 0.42 * smoothstep(0.38, 0.8, gust)) * (0.75 + 0.25 * sin(uTime * 2.1 + r3 * 6.28 + iPos.x * 0.3));
  wind *= mix(1.0, 0.55, tuft) * (1.0 - thatch);
  vec2 flut = vec2(-uWindDir.y, uWindDir.x) * sin(uTime * 3.7 + r6 * 6.28) * 0.04 * (1.0 - thatch);
  vec2 bend = outw * lean + uWindDir * wind + flut;
  vec3 tr = trample(iPos.xz + o); bend += tr.xy * 1.8; H *= 1.0 - 0.45 * tr.z;
  float bl = length(bend);
  float t2 = t * t;
  vec2 off = bend * t2 * H;
  float y = t * H * max(0.12, 1.0 - 0.32 * bl * bl * t2);
  // blade facing: mostly across the lean direction, randomised
  float f = a + 1.5708 + (r6 - 0.5) * 1.4;
  vec3 wdir = vec3(cos(f), 0.0, sin(f));
  float W = uWidth * mix(1.0, 0.6, reed) * mix(1.0, 0.7, tuft) * (0.45 + 1.1 * r2 * r2);
  float w = W * (1.0 - pow(t, 1.5)) * (1.0 + 0.6 * smoothstep(uFade.z * 0.5, uFade.w, d));
  vec3 base = iPos + vec3(o.x, iA.z * o.x + iA.w * o.y - 0.035, o.y);
  gPos = base + vec3(off.x, y, off.y) + wdir * side * w;
  gPos = mix(iPos - vec3(0.0, 0.5, 0.0), gPos, alive);
  vec3 tang = normalize(vec3(bend.x * 2.0 * t * H, H, bend.y * 2.0 * t * H));
  vec3 n = normalize(cross(wdir, tang));
  n = normalize(n + wdir * side * 0.3);
  gNrm = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.45));
  // colour: field colour per clump, per-blade brightness and hue, dry blades, thatch,
  // dark roots, lighter yellowish tips
  float farK = smoothstep(6.0, 20.0, d);
  vec3 col = iCol * (0.8 + 0.5 * r3 * r6);
  col *= mix(vec3(0.95, 1.0, 1.04), vec3(1.1, 1.03, 0.82), r6);
  float dryP = 0.06 + 0.45 * tuft + 0.1 * smoothstep(0.6, 1.0, iA.x);
  col = mix(col, vec3(0.36, 0.29, 0.13) * (0.75 + 0.5 * r2), step(1.0 - dryP, r4) * 0.8);
  col = mix(col, vec3(0.2, 0.15, 0.07) * (0.7 + 0.6 * r2), thatch * 0.9);
  col = mix(col, col * vec3(1.1, 1.06, 0.78), t2 * 0.4);
  col *= mix(mix(mix(0.36, 0.85, farK), 0.62, tuft), 1.05, pow(t, 0.6));
  // far blades converge on the ground's own colour so the ring edge has no tonal step
  col = mix(col, iCol * 0.86, farK * 0.75);
  vGrassCol = col; vGrassT = t;
}
vec3 objectNormal = gNrm;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol; varying float vGrassT;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrassCol;')
      .replace('#include <lights_lambert_pars_fragment>', `
varying vec3 vViewPosition;
struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float nl = dot( geometryNormal, directLight.direction );
  float wrap = saturate( ( nl + 0.45 ) / 1.45 );
  float back = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 3.0 ) * 0.9 + saturate( -nl ) * 0.35;
  vec3 irradiance = ( wrap + back * vGrassT ) * directLight.color;
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor ) * mix(0.55, 1.0, vGrassT);
}
#define RE_Direct RE_Direct_Lambert
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert`);
  };
  m.customProgramCacheKey = () => `grass-v2-${cfg.blades}-${cfg.segs}`;
  return m;
}

interface Block { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; pos: Float32Array; a: Float32Array; b: Float32Array; col: Float32Array; attrs: THREE.InstancedBufferAttribute[]; dirty: boolean; boundsDirty: boolean }

class GrassRing {
  group = new THREE.Group();
  material: THREE.MeshLambertMaterial;
  private cfg: RingCfg;
  private nb: number; private bs: number;
  private blocks: Block[] = [];
  private cellX: Int32Array; private cellZ: Int32Array;
  private wbuf = new Float32Array(LAYER_COUNT);
  private fr: FieldResult = { r: 0, g: 0, b: 0, cov: 0, reed: 0, tuft: 0, hVar: 0 };
  constructor(cfg: RingCfg) {
    this.cfg = cfg;
    this.nb = 4; this.bs = Math.ceil(cfg.n / this.nb);
    const base = cfg.flowers ? flowerGeometry() : clumpGeometry(cfg.blades, cfg.segs);
    this.material = cfg.flowers ? flowerMaterial(cfg) : grassMaterial(cfg);
    const per = this.bs * this.bs;
    for (let k = 0; k < this.nb * this.nb; k++) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index; geo.setAttribute('position', base.getAttribute('position'));
      const pos = new Float32Array(per * 3), a = new Float32Array(per * 4), b = new Float32Array(per * 4), col = new Float32Array(per * 3);
      for (let i = 0; i < per; i++) { pos[i * 3 + 1] = -1e4; b[i * 4 + 2] = 0; }
      const attrs = [new THREE.InstancedBufferAttribute(pos, 3), new THREE.InstancedBufferAttribute(a, 4), new THREE.InstancedBufferAttribute(b, 4), new THREE.InstancedBufferAttribute(col, 3)];
      for (const at of attrs) at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iPos', attrs[0]); geo.setAttribute('iA', attrs[1]); geo.setAttribute('iB', attrs[2]); geo.setAttribute('iCol', attrs[3]);
      geo.instanceCount = per;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1e4, 0), 1);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false; mesh.name = 'grass';
      this.group.add(mesh);
      this.blocks.push({ mesh, geo, pos, a, b, col, attrs, dirty: false, boundsDirty: false });
    }
    const count = this.nb * this.bs * this.nb * this.bs;
    this.cellX = new Int32Array(count).fill(0x7fffffff); this.cellZ = new Int32Array(count).fill(0x7fffffff);
  }

  get triangles(): number { let n = 0; const per = this.cfg.flowers ? 7 : (this.cfg.segs * 2 - 1) * this.cfg.blades; for (const b of this.blocks) if (b.mesh.visible) n += b.geo.instanceCount * per; return n; }

  sample(): number[] | null {
    for (const bl of this.blocks) for (let i = 0; i < bl.geo.instanceCount; i++) if (bl.b[i * 4 + 2] > 0.3) return [bl.col[i * 3], bl.col[i * 3 + 1], bl.col[i * 3 + 2], bl.a[i * 4], bl.b[i * 4 + 2]];
    return null;
  }

  update(px: number, pz: number): void {
    const { cell, budget } = this.cfg; const bs = this.bs; const nn = this.nb * bs;
    const pcx = Math.floor(px / cell), pcz = Math.floor(pz / cell);
    let changed = 0;
    const gd = groundData;
    outer: for (let iz = 0; iz < nn; iz++) {
      const cz = iz + nn * Math.ceil((pcz - nn / 2 - iz) / nn);
      for (let ix = 0; ix < nn; ix++) {
        const cx = ix + nn * Math.ceil((pcx - nn / 2 - ix) / nn);
        const i = iz * nn + ix;
        if (this.cellX[i] === cx && this.cellZ[i] === cz) continue;
        if (changed >= budget) break outer;
        this.cellX[i] = cx; this.cellZ[i] = cz; changed++;
        const bl = this.blocks[Math.floor(iz / bs) * this.nb + Math.floor(ix / bs)];
        const li = (iz % bs) * bs + (ix % bs);
        bl.dirty = true; bl.boundsDirty = true;
        const x = (cx + hash2(cx, cz, 1)) * cell, z = (cz + hash2(cx, cz, 2)) * cell;
        const y = heightAt(x, z);
        let cov = 0;
        const fr = this.fr;
        if (Math.abs(x) < HALF && Math.abs(z) < HALF && gd.splat && gd.field && y > 0.25 && y < 140) {
          const wa = waterAt(x, z);
          const under = wa.kind !== 'none' ? wa.level - y : -1;
          if (under < 0.25) {
            const e = 0.6;
            const gx = (heightAt(x + e, z) - y) / e, gz = (heightAt(x, z + e) - y) / e;
            const ny = 1 / Math.hypot(gx, 1, gz);
            sampleSplat(gd.splat, gd.splatRes, x / (2 * HALF) + 0.5, z / (2 * HALF) + 0.5, this.wbuf);
            applySteep(this.wbuf, 1 - ny);
            grassFieldAt(gd.field, x, z, this.wbuf, fr);
            cov = fr.cov * quality.grassDensity;
            if (under > 0) cov *= fr.reed; // only reeds stand in water
            bl.a[li * 4 + 2] = gx; bl.a[li * 4 + 3] = gz;
          }
        }
        bl.pos[li * 3] = x; bl.pos[li * 3 + 1] = y; bl.pos[li * 3 + 2] = z;
        if (this.cfg.flowers) {
          // flower patches on grassland: clustered by the field noise, one dominant kind per patch
          const meadowish = (this.wbuf[0] + this.wbuf[1] * 0.6) * (1 - fr.tuft) * (1 - fr.reed);
          const patch = Math.max(0, (fr.hVar - 0.45) * 3.2);
          const p = cov * meadowish * (0.08 + 0.85 * Math.min(1, patch * 1.4));
          const alive = hash2(cx, cz, 11) < p;
          const kindN = hash2(Math.floor(x / 23), Math.floor(z / 23), 12);
          const kind = hash2(cx, cz, 13) < 0.7 ? Math.floor(kindN * 4) : Math.floor(hash2(cx, cz, 14) * 4);
          const COLS = [[0.92, 0.92, 0.88], [0.95, 0.68, 0.04], [0.42, 0.22, 0.75], [0.9, 0.35, 0.55]];
          const c = COLS[kind];
          // stems rise just above the local grass
          const gh = (0.26 + 0.34 * fr.hVar) * 1.25;
          bl.a[li * 4] = gh + 0.06 + 0.16 * hash2(cx, cz, 15); bl.a[li * 4 + 1] = 0;
          bl.b[li * 4] = kind; bl.b[li * 4 + 1] = 0; bl.b[li * 4 + 2] = alive ? 1 : 0; bl.b[li * 4 + 3] = hash2(cx, cz, 16);
          bl.col[li * 3] = c[0]; bl.col[li * 3 + 1] = c[1]; bl.col[li * 3 + 2] = c[2];
        } else if (cov > 0.01) {
          const reed = fr.reed, tuft = fr.tuft;
          const h = (0.26 + 0.34 * fr.hVar) * (1 + reed * 1.9) * (1 - tuft * 0.25) * (0.85 + 0.3 * hash2(cx, cz, 4));
          bl.a[li * 4] = h; bl.a[li * 4 + 1] = hash2(cx, cz, 5) * 6.283;
          bl.b[li * 4] = reed; bl.b[li * 4 + 1] = tuft; bl.b[li * 4 + 2] = Math.min(1, cov); bl.b[li * 4 + 3] = hash2(cx, cz, 3);
          bl.col[li * 3] = fr.r; bl.col[li * 3 + 1] = fr.g; bl.col[li * 3 + 2] = fr.b;
        } else {
          bl.a[li * 4] = 0; bl.b[li * 4 + 2] = 0;
        }
      }
    }
    for (let k = 0; k < this.blocks.length; k++) {
      const bl = this.blocks[k];
      if (bl.dirty) { for (const at of bl.attrs) at.needsUpdate = true; bl.dirty = false; }
      if (bl.boundsDirty && changed < budget) { this.updateBounds(bl); bl.boundsDirty = false; }
    }
  }

  private updateBounds(bl: Block): void {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, hmax = 0, any = false;
    for (let i = 0; i < bl.geo.instanceCount; i++) {
      if (bl.b[i * 4 + 2] <= 0) continue; any = true;
      const x = bl.pos[i * 3], y = bl.pos[i * 3 + 1], z = bl.pos[i * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      if (bl.a[i * 4] > hmax) hmax = bl.a[i * 4];
    }
    bl.mesh.visible = any;
    if (!any) return;
    const s = bl.geo.boundingSphere!;
    s.center.set((x0 + x1) / 2, (y0 + y1) / 2 + hmax * 0.7, (z0 + z1) / 2);
    s.radius = Math.hypot(x1 - x0, y1 - y0 + hmax * 1.5, z1 - z0) / 2 + 0.5;
  }
}

export class Grass {
  mesh = new THREE.Group();
  /** kept for the stats() probe in main.ts */
  material = { uniforms: { uLight: { value: new THREE.Color(1, 1, 1) } } };
  private rings: GrassRing[] = [];
  private time = 0;
  constructor() {
    const high = quality.tier === 'high';
    const cfgs: RingCfg[] = high
      ? [
          { cell: 0.32, n: 72, blades: 7, segs: 3, fade: [-1, 0, 8.0, 11.2], width: 0.03, budget: 700 },
          { cell: 0.6, n: 84, blades: 6, segs: 1, fade: [7.2, 10.5, 19, 25.5], width: 0.05, budget: 500 },
          { cell: 0.8, n: 36, blades: 1, segs: 1, fade: [-1, 0, 20, 26], width: 0, budget: 300, flowers: true },
        ]
      : [
          { cell: 0.4, n: 52, blades: 7, segs: 2, fade: [-1, 0, 7.0, 10.0], width: 0.03, budget: 500 },
          { cell: 0.9, n: 48, blades: 5, segs: 1, fade: [6.5, 9.5, 15, 21], width: 0.05, budget: 350 },
          { cell: 1.0, n: 28, blades: 1, segs: 1, fade: [-1, 0, 16, 22], width: 0, budget: 200, flowers: true },
        ];
    for (const c of cfgs) { const r = new GrassRing(c); this.rings.push(r); this.mesh.add(r.group); }
    this.mesh.name = 'grass';
  }

  /** Set this frame's trampling sources: [x, z, radius, strength] (at most 16). */
  setPushers(list: ArrayLike<number>, n: number): void {
    const k = Math.min(n, MAX_PUSH);
    for (let i = 0; i < k; i++) shared.uPush.value[i].set(list[i * 4], list[i * 4 + 1], list[i * 4 + 2], list[i * 4 + 3]);
    shared.uPushN.value = k;
  }

  sample(): Float32Array { for (const r of this.rings) { const s = r.sample(); if (s) return new Float32Array(s); } return new Float32Array(0); }
  get triangles(): number { return this.rings.reduce((n, r) => n + r.triangles, 0); }

  update(dt: number, px: number, pz: number, light: THREE.Color, _sunDir?: THREE.Vector3): void {
    this.time += dt;
    shared.uTime.value = this.time;
    shared.uField.value = groundData.fieldTex;
    // slowly veering wind
    const wa = 0.6 + Math.sin(this.time * 0.021) * 0.5;
    shared.uWindDir.value.set(Math.cos(wa), Math.sin(wa));
    this.material.uniforms.uLight.value.copy(light);
    if (!groundData.splat) return;
    for (const r of this.rings) r.update(px, pz);
  }
}
