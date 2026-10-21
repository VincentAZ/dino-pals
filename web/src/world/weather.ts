// Weather accents & ambient life: rain/snow/sand/fireflies (stateless GPU
// points), clouds/mist/smoke/butterflies (stateless instanced billboards) and
// CPU puffs (dust, sparkles, splashes, leaves).
import * as THREE from 'three';
import { quality } from '../config.ts';
import { BIOME_IDS, VOLCANO_CENTER } from './biomes.ts';
import type { SkyState } from './sky.ts';

// ---------- stateless points ----------
const PTS_V = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter; uniform vec3 uBox; uniform float uTime; uniform float uMode; uniform float uSize; uniform float uPixelRatio;
varying float vA;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec3 p;
  float a = 1.0;
  if (uMode < 0.5) { // rain: fast fall
    float t = fract(aSeed.y - uTime * (1.4 + aSeed.w * 0.5));
    p = vec3(aSeed.x * uBox.x, t * uBox.y, aSeed.z * uBox.z);
  } else if (uMode < 1.5) { // snow: slow, swaying
    float t = fract(aSeed.y - uTime * (0.045 + aSeed.w * 0.03));
    p = vec3(aSeed.x * uBox.x + sin(uTime * 0.8 + aSeed.w * 30.0) * 1.2, t * uBox.y, aSeed.z * uBox.z + cos(uTime * 0.6 + aSeed.w * 20.0) * 1.2);
  } else if (uMode < 2.5) { // sand: horizontal gusts, low
    float t = fract(aSeed.x + uTime * (0.25 + aSeed.w * 0.2));
    p = vec3(t * uBox.x, aSeed.y * aSeed.y * uBox.y + sin(uTime * 2.0 + aSeed.w * 40.0) * 0.3, aSeed.z * uBox.z);
    a = sin(t * 3.14159);
  } else if (uMode < 3.5) { // fireflies: slow wandering, blinking
    p = vec3(aSeed.x * uBox.x + sin(uTime * 0.5 + aSeed.w * 50.0) * 2.5, 0.4 + aSeed.y * uBox.y + sin(uTime * 0.7 + aSeed.w * 10.0) * 0.6, aSeed.z * uBox.z + cos(uTime * 0.4 + aSeed.w * 70.0) * 2.5);
    a = smoothstep(0.3, 0.9, sin(uTime * (1.5 + aSeed.w) + aSeed.w * 100.0)) ;
  } else { // embers: rise, drift, flicker
    float t = fract(aSeed.y + uTime * (0.05 + aSeed.w * 0.04));
    p = vec3(aSeed.x * uBox.x + sin(uTime * 0.9 + aSeed.w * 40.0) * 1.5, t * uBox.y, aSeed.z * uBox.z + cos(uTime * 0.7 + aSeed.w * 30.0) * 1.5);
    a = (1.0 - t) * (0.5 + 0.5 * sin(uTime * (6.0 + aSeed.w * 8.0) + aSeed.w * 50.0));
  }
  vec3 wp = uCenter + p - uBox * 0.5 + vec3(0.0, uBox.y * 0.5, 0.0);
  if (uMode > 1.5 && uMode < 2.5) wp.y = uCenter.y + p.y - 0.5; 
  if (uMode > 2.5 && uMode < 3.5) wp.y = uCenter.y + p.y - uBox.y * 0.5;
  if (uMode > 3.5) wp.y = uCenter.y + p.y - 1.0;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * clamp(40.0 / max(dist, 1.0), 0.15, 4.0);
  vA = a * smoothstep(0.5, 3.0, dist);
}`;
const PTS_F = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uMode;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float shape = uMode < 0.5 ? smoothstep(0.5, 0.25, abs(c.x) * 3.0) * smoothstep(0.5, 0.45, abs(c.y)) : smoothstep(0.5, 0.15, d);
  float glow = uMode > 2.5 ? smoothstep(0.5, 0.0, d) * 1.5 : 0.0;
  gl_FragColor = vec4(uColor * (1.0 + glow), (shape + glow * 0.4) * uAlpha * vA);
}`;

export class AmbientPoints {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  constructor(count: number, mode: number, box: [number, number, number], color: THREE.Color, size: number) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3); const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random(); seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random(); }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.ShaderMaterial({
      vertexShader: PTS_V, fragmentShader: PTS_F, transparent: true, depthWrite: false, blending: mode > 2.5 ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(...box) }, uTime: { value: 0 }, uMode: { value: mode }, uSize: { value: size }, uColor: { value: color }, uAlpha: { value: 0 }, uPixelRatio: { value: 1 } },
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false; this.points.renderOrder = 20; this.points.visible = false;
  }
  set(center: THREE.Vector3, time: number, alpha: number, pr: number): void {
    const u = this.material.uniforms;
    u.uCenter.value.copy(center); u.uTime.value = time; u.uAlpha.value = alpha; u.uPixelRatio.value = pr;
    this.points.visible = alpha > 0.01;
  }
}

// ---------- stateless instanced billboards ----------
const BB_V = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
uniform vec3 uCenter; uniform vec3 uBox; uniform float uTime; uniform float uMode; uniform vec2 uSizeRange;
varying vec2 vUv; varying float vA; varying float vSeed;
void main() {
  vUv = uv; vSeed = aSeed.w;
  vec3 c; float size; float a = 1.0;
  if (uMode < 0.5) { // clouds: drift slowly, wrap around the player
    float t = fract(aSeed.x + uTime * 0.0025);
    c = vec3(t * uBox.x, 0.0, aSeed.z * uBox.z) - vec3(uBox.x, 0.0, uBox.z) * 0.5 + vec3(uCenter.x, 0.0, uCenter.z) + vec3(0.0, 230.0 + aSeed.y * 140.0, 0.0);
    size = mix(uSizeRange.x, uSizeRange.y, aSeed.w);
    a = sin(t * 3.14159);
  } else if (uMode < 1.5) { // mist: ground sheets
    float t = fract(aSeed.x + uTime * 0.01);
    c = uCenter + vec3(t * uBox.x, aSeed.y * uBox.y, aSeed.z * uBox.z) - vec3(uBox.x, 0.0, uBox.z) * 0.5;
    size = mix(uSizeRange.x, uSizeRange.y, aSeed.w);
    a = sin(t * 3.14159) * 0.6;
  } else if (uMode < 2.5) { // smoke: rises from a point
    float t = fract(aSeed.x + uTime * (0.028 + aSeed.w * 0.01));
    float ang = aSeed.y * 6.2831;
    c = uCenter + vec3(cos(ang) * (4.0 + t * 90.0) + sin(uTime * 0.2 + aSeed.z * 10.0) * 10.0 * t, t * uBox.y, sin(ang) * (4.0 + t * 90.0) + 30.0 * t);
    size = mix(uSizeRange.x, uSizeRange.y, t);
    a = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.6, 1.0, t)) * 0.5;
  } else { // butterflies: wander around the player
    float ph = uTime * 0.25 + aSeed.w * 20.0;
    c = uCenter + vec3(sin(ph * 1.3 + aSeed.x * 9.0) * uBox.x * 0.5 + cos(ph * 0.7) * 3.0, 0.6 + aSeed.y * uBox.y + sin(uTime * 2.0 + aSeed.w * 30.0) * 0.4, cos(ph * 1.1 + aSeed.z * 9.0) * uBox.z * 0.5);
    size = mix(uSizeRange.x, uSizeRange.y, aSeed.w);
  }
  vec3 toCam = normalize(cameraPosition - c);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(up, toCam));
  vec3 up2 = cross(toCam, right);
  vec3 off;
  if (uMode > 2.5) {
    // butterfly: fold the two half-quads along the centre
    float flap = sin(uTime * 14.0 + aSeed.w * 100.0) * 0.9;
    vec3 fwd = vec3(cos(aSeed.w * 6.28), 0.0, sin(aSeed.w * 6.28));
    vec3 side = vec3(-fwd.z, 0.0, fwd.x);
    off = side * position.x * cos(flap) * size + up * abs(position.x) * sin(flap) * size + fwd * position.y * size;
  } else if (uMode > 0.5 && uMode < 1.5) {
    off = vec3(position.x, 0.0, position.y) * size + up * sin(aSeed.z * 4.0) * 0.3;
    off = right * position.x * size + up2 * position.y * size * 0.35;
  } else {
    off = right * position.x * size + up2 * position.y * size;
  }
  vec3 wp = c + off;
  if (uMode < 0.5) a *= smoothstep(0.015, 0.07, normalize(c - cameraPosition).y);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vA = a * smoothstep(2.0, 12.0, -mvPosition.z);
  #include <fog_vertex>
}`;
const BB_F = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uNoise; uniform vec3 uColor; uniform vec3 uColor2; uniform float uAlpha; uniform float uMode; uniform float uTime;
varying vec2 vUv; varying float vA; varying float vSeed;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  float a;
  vec3 col = uColor;
  if (uMode < 0.5) {
    float n = texture2D(uNoise, vUv * 0.9 + vSeed * 5.0).r * 0.7 + texture2D(uNoise, vUv * 2.3 + vSeed * 9.0).g * 0.5;
    a = smoothstep(1.0, 0.25, d) * smoothstep(0.38, 0.7, n + 0.12);
    col = mix(uColor2, uColor, smoothstep(-0.35, 0.35, c.y + n * 0.3));
  } else if (uMode < 2.5) {
    float n = texture2D(uNoise, vUv * 0.8 + vSeed * 7.0 + uTime * 0.01).r;
    a = smoothstep(1.0, 0.2, d) * (0.5 + 0.5 * n);
    col = mix(uColor2, uColor, vUv.y);
  } else {
    // butterfly wing shape: two lobes
    vec2 q = vec2(abs(c.x), c.y);
    float lobe1 = smoothstep(0.5, 0.42, length(q - vec2(0.27, 0.12)));
    float lobe2 = smoothstep(0.38, 0.3, length(q - vec2(0.2, -0.2)));
    a = max(lobe1, lobe2);
    col = mix(uColor, uColor2, step(0.5, fract(vSeed * 3.0)));
    col *= 0.7 + 0.3 * smoothstep(0.0, 0.3, length(q));
    col = mix(col, vec3(0.1), smoothstep(0.08, 0.03, abs(c.x)) * step(abs(c.y), 0.25));
  }
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a * uAlpha * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class Billboards {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  constructor(count: number, mode: number, box: [number, number, number], sizeRange: [number, number], color: THREE.Color, color2: THREE.Color, noise: THREE.Texture, fog = true) {
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seed[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.ShaderMaterial({
      vertexShader: BB_V, fragmentShader: BB_F, transparent: true, depthWrite: false, fog, side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uCenter: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(...box) }, uTime: { value: 0 }, uMode: { value: mode },
        uSizeRange: { value: new THREE.Vector2(...sizeRange) }, uNoise: { value: null }, uColor: { value: color }, uColor2: { value: color2 }, uAlpha: { value: 0 },
      }]),
    });
    this.material.uniforms.uNoise.value = noise;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = mode < 0.5 ? 2 : 21; this.mesh.visible = false;
  }
  set(center: THREE.Vector3, time: number, alpha: number): void {
    const u = this.material.uniforms;
    u.uCenter.value.copy(center); u.uTime.value = time; u.uAlpha.value = alpha;
    this.mesh.visible = alpha > 0.01;
  }
}

// ---------- CPU puffs ----------
const PUFF_V = /* glsl */ `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uPixelRatio;
varying float vAlpha; varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * clamp(60.0 / max(-mv.z, 1.0), 0.05, 6.0);
  vAlpha = aAlpha; vColor = aColor;
}`;
const PUFF_F = /* glsl */ `
varying float vAlpha; varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.3, d);
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

export type PuffKind = 'dust' | 'sparkle' | 'splash' | 'leaf' | 'heart' | 'snowkick';
interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number; r: number; g: number; b: number; grav: number; drag: number; alpha: number }

export class Puffs {
  points: THREE.Points;
  private pool: Puff[] = [];
  private cap: number;
  private pos: Float32Array; private size: Float32Array; private alpha: Float32Array; private col: Float32Array;
  private geo: THREE.BufferGeometry;
  constructor(cap = 600, additive = false) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3); this.size = new Float32Array(cap); this.alpha = new Float32Array(cap); this.col = new Float32Array(cap * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({ vertexShader: PUFF_V, fragmentShader: PUFF_F, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uPixelRatio: { value: 1 } } });
    this.points = new THREE.Points(this.geo, m);
    this.points.frustumCulled = false; this.points.renderOrder = 22;
  }
  spawn(kind: PuffKind, x: number, y: number, z: number, n = 12, scale = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.pool.length >= this.cap) this.pool.shift();
      const a = Math.random() * Math.PI * 2, r = Math.random();
      let p: Puff;
      switch (kind) {
        case 'dust': p = { x: x + Math.cos(a) * r * 0.8 * scale, y: y + 0.1, z: z + Math.sin(a) * r * 0.8 * scale, vx: Math.cos(a) * (0.8 + r) * scale, vy: 0.6 + Math.random() * 0.8 * scale, vz: Math.sin(a) * (0.8 + r) * scale, age: 0, life: 0.9 + Math.random() * 0.6, size: (1.2 + Math.random()) * scale * 10, r: 0.62, g: 0.55, b: 0.42, grav: -0.3, drag: 2.2, alpha: 0.45 }; break;
        case 'snowkick': p = { x: x + Math.cos(a) * r * 0.8 * scale, y: y + 0.1, z: z + Math.sin(a) * r * 0.8 * scale, vx: Math.cos(a) * (0.8 + r) * scale, vy: 0.8 + Math.random() * 0.8 * scale, vz: Math.sin(a) * (0.8 + r) * scale, age: 0, life: 0.8 + Math.random() * 0.5, size: (1 + Math.random()) * scale * 8, r: 0.95, g: 0.97, b: 1, grav: -1.5, drag: 1.5, alpha: 0.6 }; break;
        case 'sparkle': p = { x: x + Math.cos(a) * r * 0.6, y: y + Math.random() * 1.2, z: z + Math.sin(a) * r * 0.6, vx: Math.cos(a) * 1.5, vy: 1.2 + Math.random() * 2.5, vz: Math.sin(a) * 1.5, age: 0, life: 0.8 + Math.random() * 0.8, size: 4 + Math.random() * 5, r: 1, g: 0.85 + Math.random() * 0.15, b: 0.4 + Math.random() * 0.6, grav: -1.2, drag: 1, alpha: 1 }; break;
        case 'heart': p = { x: x + Math.cos(a) * r * 0.5, y: y + 0.5, z: z + Math.sin(a) * r * 0.5, vx: Math.cos(a) * 0.4, vy: 0.9 + Math.random(), vz: Math.sin(a) * 0.4, age: 0, life: 1.2 + Math.random() * 0.6, size: 6 + Math.random() * 4, r: 1, g: 0.4, b: 0.6, grav: 0.3, drag: 0.5, alpha: 0.9 }; break;
        case 'splash': p = { x: x + Math.cos(a) * r * 0.5 * scale, y: y, z: z + Math.sin(a) * r * 0.5 * scale, vx: Math.cos(a) * (1 + r * 2) * scale, vy: 2 + Math.random() * 3 * scale, vz: Math.sin(a) * (1 + r * 2) * scale, age: 0, life: 0.7 + Math.random() * 0.5, size: (1.5 + Math.random()) * 6, r: 0.85, g: 0.95, b: 1, grav: -9, drag: 0.3, alpha: 0.8 }; break;
        default: p = { x: x + Math.cos(a) * r * 1.5, y: y + 1 + Math.random() * 1.5, z: z + Math.sin(a) * r * 1.5, vx: Math.cos(a) * 0.5, vy: -0.4, vz: Math.sin(a) * 0.5, age: 0, life: 1.5 + Math.random(), size: 3 + Math.random() * 3, r: 0.5, g: 0.75, b: 0.25, grav: -0.5, drag: 1.5, alpha: 0.9 };
      }
      this.pool.push(p);
    }
  }
  update(dt: number, pr: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr;
    let n = 0;
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i];
      p.age += dt;
      if (p.age >= p.life) { this.pool.splice(i, 1); continue; }
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k + p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const t = p.age / p.life;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.size[n] = p.size * (0.6 + t * 0.8); this.alpha[n] = p.alpha * (1 - t) * Math.min(1, t * 8);
      this.col[n * 3] = p.r; this.col[n * 3 + 1] = p.g; this.col[n * 3 + 2] = p.b;
      n++;
    }
    this.geo.setDrawRange(0, n);
    for (const a of ['position', 'aSize', 'aAlpha', 'aColor']) (this.geo.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = n > 0;
  }
  /** Remove every live particle (used when rendering stills). */
  clear(): void { this.pool.length = 0; this.points.visible = false; }
}

export class Weather {
  group = new THREE.Group();
  rain: AmbientPoints; snow: AmbientPoints; sand: AmbientPoints; fireflies: AmbientPoints; embers: AmbientPoints;
  clouds: Billboards; mist: Billboards; smoke: Billboards; butterflies: Billboards;
  puffs = new Puffs(700, false);
  sparkles = new Puffs(400, true);
  private time = 0;
  private rainCycle = 0;
  rainAmount = 0;
  constructor(noise: THREE.Texture) {
    const pm = quality.particleMul;
    this.rain = new AmbientPoints(Math.round(1600 * pm), 0, [36, 26, 36], new THREE.Color(0.75, 0.85, 1), 2.2);
    this.snow = new AmbientPoints(Math.round(2200 * pm), 1, [44, 26, 44], new THREE.Color(1, 1, 1), 5);
    this.sand = new AmbientPoints(Math.round(700 * pm), 2, [50, 3, 50], new THREE.Color(0.85, 0.7, 0.45), 2.5);
    this.fireflies = new AmbientPoints(Math.round(160 * pm), 3, [50, 4, 50], new THREE.Color(0.85, 1, 0.35), 6);
    this.embers = new AmbientPoints(Math.round(140 * pm), 4, [50, 14, 50], new THREE.Color(1.0, 0.45, 0.1), 4);
    this.clouds = new Billboards(Math.round(18 * pm) + 8, 0, [3200, 1, 3200], [180, 420], new THREE.Color(1, 1, 1), new THREE.Color(0.62, 0.66, 0.76), noise, false);
    this.mist = new Billboards(Math.round(48 * pm) + 12, 1, [80, 1.8, 80], [14, 30], new THREE.Color(0.85, 0.9, 0.85), new THREE.Color(0.7, 0.75, 0.7), noise, true);
    this.smoke = new Billboards(Math.round(40 * pm) + 10, 2, [1, 220, 1], [12, 70], new THREE.Color(0.55, 0.52, 0.5), new THREE.Color(0.3, 0.28, 0.27), noise, true);
    this.butterflies = new Billboards(Math.round(22 * pm) + 4, 3, [30, 2, 30], [0.14, 0.26], new THREE.Color(1, 0.6, 0.15), new THREE.Color(0.95, 0.9, 0.3), noise, true);
    this.group.add(this.rain.points, this.snow.points, this.sand.points, this.fireflies.points, this.embers.points, this.clouds.mesh, this.mist.mesh, this.smoke.mesh, this.butterflies.mesh, this.puffs.points, this.sparkles.points);
  }
  update(dt: number, camPos: THREE.Vector3, playerPos: THREE.Vector3, biomeW: Float32Array, sky: SkyState, pr: number): void {
    this.time += dt;
    const w = (id: string) => biomeW[BIOME_IDS.indexOf(id as never)];
    // soft rain comes and goes in the jungle
    this.rainCycle += dt;
    const rainPhase = Math.max(0, Math.sin(this.rainCycle * 0.025) - 0.35) / 0.65;
    this.rainAmount = rainPhase * Math.min(1, w('jungle') * 1.6);
    this.rain.set(camPos, this.time, this.rainAmount * 0.55, pr);
    this.snow.set(camPos, this.time, Math.min(1, w('snow') * 1.5) * 0.8, pr);
    this.sand.set(playerPos, this.time, Math.min(1, w('canyon') * 1.4) * (0.4 + 0.6 * Math.max(0, Math.sin(this.time * 0.15))) * 0.7, pr);
    this.fireflies.set(playerPos, this.time, Math.min(1, w('swamp') * 1.6) * sky.night, pr);
    this.embers.set(playerPos, this.time, Math.min(1, Math.max(0, w('volcano') - 0.3) * 2.2) * 0.9, pr);
    this.clouds.set(camPos, this.time, 0.92);
    const cu = this.clouds.material.uniforms;
    cu.uColor.value.copy(sky.sunColor).lerp(new THREE.Color(1, 1, 1), 0.5).multiplyScalar(0.25 + 0.75 * sky.day).lerp(new THREE.Color(1, 0.6, 0.4), sky.dusk * 0.5);
    cu.uColor2.value.copy(sky.zenith).lerp(new THREE.Color(0.5, 0.55, 0.65), 0.5).multiplyScalar(0.3 + 0.7 * sky.day);
    this.mist.set(playerPos, this.time, Math.max(Math.min(1, w('swamp') * 1.5) * (0.5 + 0.3 * sky.night), Math.min(1, w('jungle') * 1.3) * 0.18));
    const mu = this.mist.material.uniforms;
    mu.uColor.value.setRGB(0.85, 0.9, 0.85).multiplyScalar(0.2 + 0.8 * sky.day);
    mu.uColor2.value.setRGB(0.7, 0.75, 0.7).multiplyScalar(0.2 + 0.8 * sky.day);
    const crater = new THREE.Vector3(VOLCANO_CENTER[0], 150, VOLCANO_CENTER[1]);
    this.smoke.set(crater, this.time, 0.85);
    const su = this.smoke.material.uniforms;
    su.uColor.value.setRGB(0.55, 0.52, 0.5).multiplyScalar(0.25 + 0.75 * sky.day);
    su.uColor2.value.setRGB(0.4, 0.3, 0.25).multiplyScalar(0.3 + 0.7 * sky.day).add(new THREE.Color(0.35, 0.08, 0).multiplyScalar(sky.night));
    this.butterflies.set(playerPos, this.time, Math.min(1, w('meadow') * 1.3 + w('lake') * 0.8) * sky.day);
    this.puffs.update(dt, pr); this.sparkles.update(dt, pr);
  }
}
