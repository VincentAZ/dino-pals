// Dense near-field grass: one instanced mesh of crossed blade quads that
// follows the player on a toroidal grid; only blades whose grid cell changed
// are re-placed, so moving costs almost nothing. Soft, varied blades that
// shrink and thin out with distance (no cutoff line). Biome-coloured:
// meadow/lake/jungle green, swamp tall reeds, canyon sparse dry tufts.
import * as THREE from 'three';
import { heightAt, waterAt, slopeAt } from './heightmap.ts';
import { BIOME_IDS, biomeWeights } from './biomes.ts';
import { hash2 } from '../util/noise.ts';
import { quality } from '../config.ts';

const V = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPos; attribute vec4 iData; // height, rot, bend, alpha
attribute vec3 iColor;
varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vColor; varying vec3 vNrm; varying vec3 vWp;
uniform float uTime; uniform float uRadius;
void main() {
  vUv = uv; vColor = iColor;
  float d = distance(iPos.xz, cameraPosition.xz);
  float far = smoothstep(uRadius * 0.45, uRadius * 0.95, d);
  // thin out + shrink with distance instead of a hard edge
  float keep = step(far * far, iData.w);
  float hgt = iData.x * (1.0 - far * 0.55) * keep;
  float r = iData.y; float c = cos(r), sn = sin(r);
  float h = uv.y;
  // tapered width (rounded tip) + quadratic bend along the blade + wind
  float width = 0.07 * (1.0 - h * h * 0.8) * (0.8 + 0.4 * iData.x);
  float ph = uTime * 1.4 + iPos.x * 0.5 + iPos.z * 0.37;
  float lean = iData.z + sign(iData.z + 0.001) * 0.3; // every blade arcs over, left or right
  float sway = (sin(ph) * 0.5 + sin(ph * 2.1 + 1.0) * 0.25) * 0.14 + lean;
  float bendX = sway * h * h * hgt;
  vec3 p = vec3(position.x * width + bendX, h * hgt * (1.0 - abs(sway) * 0.3 * h * h), position.z * width);
  // normal of the bent strip (for wrap/back lighting)
  vec3 n = normalize(vec3(-2.0 * sway * h * hgt, 1.0 * hgt * 0.9, 1.0));
  p = vec3(p.x * c - p.z * sn, p.y, p.x * sn + p.z * c);
  n = vec3(n.x * c - n.z * sn, n.y, n.x * sn + n.z * c);
  vec3 wp = iPos + p;
  vWp = wp; vNrm = n;
  vAlpha = keep;
  vShade = 0.5 + 0.5 * h;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const F = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uLight; uniform sampler2D uMap; uniform vec3 uSunDir;
varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vColor; varying vec3 vNrm; varying vec3 vWp;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.35) discard;
  // dark base -> light yellow-green tip
  vec3 tip = vColor * 1.3 + vec3(0.12, 0.1, 0.0);
  vec3 base = mix(vColor * 0.4, tip, vUv.y * vUv.y);
  // wrap lighting + translucent back-light
  vec3 N = normalize(vNrm); vec3 V = normalize(cameraPosition - vWp);
  float wrap = clamp((dot(N, uSunDir) + 0.6) / 1.6, 0.0, 1.0);
  float back = pow(max(dot(V, -uSunDir), 0.0), 3.0) * 0.35 * vUv.y;
  vec3 col = base * (0.55 + 0.45 * wrap) * t.r * uLight + tip * back * uLight;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Grey-scale blade mask with soft (alpha-feathered) tips; colour comes per instance. */
function bladeTexture(): THREE.CanvasTexture {
  const w = 32, h = 128; const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  // soft blade: full width at the base, rounded tip, feathered edges (canvas blur)
  ctx.filter = 'blur(1.2px)';
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(190,190,190,1)'); grad.addColorStop(0.7, 'rgba(230,230,230,1)'); grad.addColorStop(1, 'rgba(255,255,255,0.75)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(3, h); ctx.quadraticCurveTo(4, h * 0.45, w / 2, 3); ctx.quadraticCurveTo(w - 4, h * 0.45, w - 3, h); ctx.closePath(); ctx.fill();
  ctx.filter = 'none';
  // central vein
  ctx.strokeStyle = 'rgba(120,120,120,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(w / 2, h); ctx.lineTo(w / 2, 10); ctx.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  return t;
}

export class Grass {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private n: number;
  private cell: number;
  private radius: number;
  private cellX: Int32Array; private cellZ: Int32Array;
  private pos: Float32Array; private data: Float32Array; private col: Float32Array;
  private posAttr: THREE.InstancedBufferAttribute; private dataAttr: THREE.InstancedBufferAttribute; private colAttr: THREE.InstancedBufferAttribute;
  private bw = new Float32Array(BIOME_IDS.length);
  private time = 0;
  constructor() {
    this.n = quality.tier === 'high' ? 96 : 68;
    this.cell = 0.5;
    this.radius = (this.n * this.cell) / 2;
    const count = this.n * this.n;
    const base = new THREE.BufferGeometry();
    const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
    const SEG = 4;
    for (let q = 0; q < 2; q++) {
      const a = q * Math.PI / 2; const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
      const o = q * (SEG + 1) * 2;
      for (let s2 = 0; s2 <= SEG; s2++) {
        const y = s2 / SEG;
        verts.push(-dx, y, -dz, dx, y, dz);
        uvs.push(0, y, 1, y);
        if (s2 < SEG) { const b = o + s2 * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
      }
    }
    base.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    base.setIndex(idx);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    this.pos = new Float32Array(count * 3); this.data = new Float32Array(count * 4); this.col = new Float32Array(count * 3);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3); this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.InstancedBufferAttribute(this.data, 4); this.dataAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.InstancedBufferAttribute(this.col, 3); this.colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.posAttr); g.setAttribute('iData', this.dataAttr); g.setAttribute('iColor', this.colAttr);
    g.instanceCount = count; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.ShaderMaterial({
      vertexShader: V, fragmentShader: F, fog: true, side: THREE.DoubleSide, transparent: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uRadius: { value: this.radius }, uLight: { value: new THREE.Color(1, 1, 1) }, uMap: { value: null }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } }]),
    });
    this.material.uniforms.uMap.value = bladeTexture();
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.name = 'grass';
    this.cellX = new Int32Array(count).fill(0x7fffffff); this.cellZ = new Int32Array(count).fill(0x7fffffff);
  }

  sample(): Float32Array { for (let i = 0; i < this.n * this.n; i++) if (this.data[i * 4 + 3] > 0) return new Float32Array([this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2], this.data[i * 4], this.data[i * 4 + 3]]); return new Float32Array(0); }

  update(dt: number, px: number, pz: number, light: THREE.Color, sunDir?: THREE.Vector3): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uLight.value.copy(light);
    if (sunDir) this.material.uniforms.uSunDir.value.copy(sunDir);
    const n = this.n, cell = this.cell;
    const pcx = Math.floor(px / cell), pcz = Math.floor(pz / cell);
    let changed = 0;
    for (let iz = 0; iz < n; iz++) {
      const cz = iz + n * Math.ceil((pcz - n / 2 - iz) / n);
      for (let ix = 0; ix < n; ix++) {
        const cx = ix + n * Math.ceil((pcx - n / 2 - ix) / n);
        const i = iz * n + ix;
        if (this.cellX[i] === cx && this.cellZ[i] === cz) continue;
        if (changed > 450) { this.posAttr.needsUpdate = true; this.dataAttr.needsUpdate = true; this.colAttr.needsUpdate = true; return; }
        this.cellX[i] = cx; this.cellZ[i] = cz; changed++;
        const jx = hash2(cx, cz, 1), jz = hash2(cx, cz, 2);
        const x = (cx + jx) * cell, z = (cz + jz) * cell;
        const h = heightAt(x, z);
        let a = 0, height = 0.45, r = 0.45, g = 0.55, b = 0.3;
        if (h >= 1.0 && h <= 95 && waterAt(x, z).kind === 'none') {
          biomeWeights(x, z, this.bw);
          const w = this.bw;
          const meadow = w[0] + w[7], jungle = w[1], swamp = w[4], canyon = w[6];
          const prob = meadow * 0.95 + jungle * 0.75 + swamp * 0.7 + canyon * 0.14;
          const thr = hash2(cx, cz, 3);
          if (prob > thr * 0.9 + 0.08 && slopeAt(x, z, 1.0) < 0.5) {
            a = 1;
            // colour by biome
            const tot = meadow + jungle + swamp + canyon + 1e-4;
            r = (meadow * 0.36 + jungle * 0.26 + swamp * 0.42 + canyon * 0.7) / tot;
            g = (meadow * 0.58 + jungle * 0.48 + swamp * 0.46 + canyon * 0.58) / tot;
            b = (meadow * 0.2 + jungle * 0.2 + swamp * 0.18 + canyon * 0.34) / tot;
            const v = 0.85 + hash2(cx, cz, 7) * 0.3; r *= v; g *= v; b *= v;
            const hue = (hash2(cx, cz, 9) - 0.5) * 0.28; r *= 1 + hue; b *= 1 - hue * 0.5; // yellow <-> blue-green shift
            height = (0.25 + hash2(cx, cz, 4) * 0.35) * (1 + (swamp / tot) * 1.4) * (1 - (canyon / tot) * 0.35);
            this.data[i * 4 + 2] = 0; // bend set below
          }
        }
        this.pos[i * 3] = x; this.pos[i * 3 + 1] = h - 0.03; this.pos[i * 3 + 2] = z;
        this.data[i * 4] = height; this.data[i * 4 + 1] = hash2(cx, cz, 5) * Math.PI; this.data[i * 4 + 2] = (hash2(cx, cz, 6) - 0.5) * 0.9; this.data[i * 4 + 3] = a > 0 ? 0.05 + hash2(cx, cz, 8) * 0.95 : -1;
        this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
      }
    }
    if (changed) { this.posAttr.needsUpdate = true; this.dataAttr.needsUpdate = true; this.colAttr.needsUpdate = true; }
  }
}
