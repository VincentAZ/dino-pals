// Sea, lake, river and swamp pools with one animated water shader.
import * as THREE from 'three';
import { HALF, LAKE_CENTER, LAKE_LEVEL, LAKE_RADIUS, SWAMP_POOL_LEVEL, BIOMES } from './biomes.ts';
import { RIVER, riverInfo } from './heightmap.ts';
import type { SkyState } from './sky.ts';

const V = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vW; varying vec3 vN;
uniform float uTime; uniform vec3 uSwamp;
void main() {
  vec3 p = position;
  vec4 w = modelMatrix * vec4(p, 1.0);
  float wave = sin(w.x * 0.35 + uTime * 1.1) * 0.06 + sin(w.z * 0.27 - uTime * 0.9) * 0.05 + sin((w.x + w.z) * 0.12 + uTime * 0.6) * 0.08;
  w.y += wave * uWaveAmp * (1.0 - smoothstep(uSwamp.z, uSwamp.z * 0.55, distance(w.xz, uSwamp.xy)));
  vW = w.xyz; vN = vec3(0.0, 1.0, 0.0);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const F = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec3 vW; varying vec3 vN;
uniform sampler2D uNoise; uniform sampler2D uHeight; uniform float uWorldHalf; uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uZenith; uniform vec3 uHorizon; uniform float uDay;
uniform float uDiscardBelow; uniform vec3 uShallow; uniform vec3 uDeep; uniform float uFish; uniform float uFoam; uniform float uMinAlpha; uniform float uReflect;
uniform vec3 uSwamp; // swamp centre (x, z) and radius: murky, weedy, still water inside
float terrainH(vec2 xz) { vec4 t = texture2D(uHeight, xz / (2.0 * uWorldHalf) + 0.5); return (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * 320.0 - 64.0; }
vec3 waterNormal(vec2 p) {
  vec2 uv1 = p * 0.09 + vec2(uTime * 0.025, uTime * 0.018);
  vec2 uv2 = p * 0.17 - vec2(uTime * 0.021, -uTime * 0.03);
  vec2 uv3 = p * 0.33 + vec2(-uTime * 0.04, uTime * 0.012);
  float e = 0.012;
  float h  = texture2D(uNoise, uv1).r + texture2D(uNoise, uv2).g * 0.6 + texture2D(uNoise, uv3).r * 0.3;
  float hx = texture2D(uNoise, uv1 + vec2(e, 0.0)).r + texture2D(uNoise, uv2 + vec2(e, 0.0)).g * 0.6 + texture2D(uNoise, uv3 + vec2(e, 0.0)).r * 0.3;
  float hz = texture2D(uNoise, uv1 + vec2(0.0, e)).r + texture2D(uNoise, uv2 + vec2(0.0, e)).g * 0.6 + texture2D(uNoise, uv3 + vec2(0.0, e)).r * 0.3;
  return normalize(vec3((h - hx) * 2.2, 1.0, (h - hz) * 2.2));
}
void main() {
  float th = terrainH(vW.xz);
  if (th < uDiscardBelow) discard;
  float depth = max(vW.y - th, 0.0);
  vec3 N = waterNormal(vW.xz);
  vec3 V = normalize(cameraPosition - vW);
  float NdV = max(dot(N, V), 0.0);
  float F0 = 0.02;
  float fres = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  // body colour by depth
  float dfac = 1.0 - exp(-depth * 0.16);
  vec3 body = mix(uShallow, uDeep, dfac);
  float murk = smoothstep(uSwamp.z, uSwamp.z * 0.55, distance(vW.xz, uSwamp.xy));
  body = mix(body, mix(vec3(0.1, 0.11, 0.055), vec3(0.035, 0.045, 0.022), dfac), murk);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), murk * 0.8));
  // sand/ground seen through shallow water: fade alpha
  float alpha = max(uMinAlpha, mix(0.35, 0.93, 1.0 - exp(-depth * 0.45)));
  // reflection: sky gradient from reflected direction + sun highlight
  vec3 R = reflect(-V, N);
  float t = pow(clamp(1.0 - R.y, 0.0, 1.0), 2.0);
  vec3 refl = mix(uZenith, uHorizon, t);
  float spec = pow(max(dot(R, uSunDir), 0.0), 240.0) * 3.0 + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.25;
  alpha = mix(alpha, max(alpha, 0.92), murk);
  vec3 col = mix(body * (0.35 + 0.65 * uDay), refl, clamp(fres * 1.2 * uReflect * (1.0 - murk * 0.62), 0.0, 0.85));
  col += uSunCol * spec * smoothstep(-0.05, 0.1, uSunDir.y) * uReflect;
  // fish
  if (uFish > 0.5 && murk < 0.5 && depth > 0.6 && depth < 9.0) {
    vec2 cell = floor(vW.xz / 7.0);
    float r = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    if (r > 0.55) {
      float ang = r * 6.2831 + uTime * (0.3 + r * 0.4);
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 c = (cell + 0.5) * 7.0 + vec2(cos(uTime * 0.5 + r * 9.0), sin(uTime * 0.37 + r * 5.0)) * 2.2;
      vec2 q = vW.xz - c;
      float along = dot(q, dir), across = dot(q, vec2(-dir.y, dir.x));
      float body2 = smoothstep(1.0, 0.7, (along * along) / 0.6 + (across * across) / 0.05);
      float tail = smoothstep(0.25, 0.0, abs(across - sin(uTime * 9.0 + r * 10.0) * 0.08 * clamp(-along, 0.0, 1.0))) * smoothstep(-1.1, -0.7, along) * step(along, -0.6);
      float fish = max(body2, tail) * (1.0 - fres) * smoothstep(8.0, 2.0, depth);
      col = mix(col, vec3(0.9, 0.55, 0.2) * (0.4 + 0.6 * uDay), fish * 0.75);
      alpha = max(alpha, fish * 0.9);
    }
  }
  // shoreline foam + crest foam
  float foamN = texture2D(uNoise, vW.xz * 0.11 + vec2(uTime * 0.03, -uTime * 0.02)).g;
  float foamN2 = texture2D(uNoise, vW.xz * 0.05 - vec2(uTime * 0.015, uTime * 0.025)).r;
  float shore = smoothstep(1.6, 0.0, depth) * smoothstep(0.35, 0.7, foamN * 0.6 + foamN2 * 0.5 + sin(depth * 4.0 - uTime * 1.6) * 0.15);
  float crest = smoothstep(0.86, 0.96, foamN2 + N.x * 0.3) * 0.5;
  float foam = clamp(shore + crest, 0.0, 1.0) * uFoam * (1.0 - murk);
  // duckweed and algae rafts on the still swamp water
  float weed = smoothstep(0.56, 0.74, texture2D(uNoise, vW.xz * 0.045 + 0.13).g * 0.7 + texture2D(uNoise, vW.xz * 0.21).r * 0.3) * murk;
  col = mix(col, vec3(0.13, 0.2, 0.045) * (0.3 + 0.7 * uDay), weed * 0.85);
  col = mix(col, vec3(0.95) * (0.25 + 0.75 * uDay), foam * 0.85);
  alpha = max(alpha, foam * 0.9);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class Water {
  group = new THREE.Group();
  materials: THREE.ShaderMaterial[] = [];
  private nearSea: THREE.Mesh;
  private time = 0;
  constructor(noise: THREE.Texture, heightTex: THREE.Texture) {
    const mk = (opts: { discardBelow: number; shallow: THREE.Color; deep: THREE.Color; fish: number; waveAmp: number; foam: number; minAlpha: number; reflect: number }) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: `uniform float uWaveAmp;\n` + V, fragmentShader: F, transparent: true, depthWrite: false, fog: true,
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
          uNoise: { value: noise }, uHeight: { value: heightTex }, uWorldHalf: { value: HALF }, uTime: { value: 0 },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) }, uZenith: { value: new THREE.Color(0.3, 0.5, 0.9) },
          uHorizon: { value: new THREE.Color(0.8, 0.9, 1) }, uDay: { value: 1 }, uDiscardBelow: { value: opts.discardBelow },
          uShallow: { value: opts.shallow }, uDeep: { value: opts.deep }, uFish: { value: opts.fish }, uWaveAmp: { value: opts.waveAmp }, uFoam: { value: opts.foam }, uMinAlpha: { value: opts.minAlpha }, uReflect: { value: opts.reflect },
          uSwamp: { value: new THREE.Vector3(BIOMES.swamp.center[0], BIOMES.swamp.center[1], BIOMES.swamp.radius + 30) },
        }]),
      });
      // merge() clones textures' holders; re-point to shared textures
      m.uniforms.uNoise.value = noise; m.uniforms.uHeight.value = heightTex;
      this.materials.push(m);
      return m;
    };
    const seaMat = mk({ discardBelow: -1e9, shallow: new THREE.Color(0.1, 0.72, 0.72), deep: new THREE.Color(0.02, 0.16, 0.38), fish: 1, waveAmp: 1, foam: 1, minAlpha: 0, reflect: 1 });
    const lakeMat = mk({ discardBelow: -1e9, shallow: new THREE.Color(0.18, 0.55, 0.5), deep: new THREE.Color(0.03, 0.17, 0.3), fish: 1, waveAmp: 0.4, foam: 0.3, minAlpha: 0.3, reflect: 0.9 });
    const poolMat = mk({ discardBelow: 0.0, shallow: new THREE.Color(0.16, 0.24, 0.13), deep: new THREE.Color(0.05, 0.09, 0.05), fish: 0, waveAmp: 0.15, foam: 0, minAlpha: 0.95, reflect: 0.25 });
    const riverMat = mk({ discardBelow: -1e9, shallow: new THREE.Color(0.2, 0.55, 0.55), deep: new THREE.Color(0.04, 0.2, 0.32), fish: 1, waveAmp: 0.3, foam: 0.4, minAlpha: 0.3, reflect: 0.8 });

    // far sea: one giant plane
    const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 8, 8), seaMat);
    far.rotation.x = -Math.PI / 2; far.position.y = 0; far.frustumCulled = false; far.renderOrder = 5;
    this.group.add(far);
    // near sea: finer grid that follows the player (vertex waves)
    this.nearSea = new THREE.Mesh(new THREE.PlaneGeometry(320, 320, 80, 80), seaMat);
    this.nearSea.rotation.x = -Math.PI / 2; this.nearSea.position.y = 0.02; this.nearSea.frustumCulled = false; this.nearSea.renderOrder = 6;
    this.group.add(this.nearSea);
    // lake
    const lake = new THREE.Mesh(new THREE.CircleGeometry(LAKE_RADIUS + 60, 64), lakeMat);
    lake.rotation.x = -Math.PI / 2; lake.position.set(LAKE_CENTER[0], LAKE_LEVEL, LAKE_CENTER[1]); lake.renderOrder = 6;
    this.group.add(lake);
    // swamp pools
    const sw = BIOMES.swamp;
    const pools = new THREE.Mesh(new THREE.CircleGeometry(sw.radius + 40, 48), poolMat);
    pools.rotation.x = -Math.PI / 2; pools.position.set(sw.center[0], SWAMP_POOL_LEVEL, sw.center[1]); pools.renderOrder = 6;
    this.group.add(pools);
    // river ribbon
    this.group.add(new THREE.Mesh(buildRiverGeometry(), riverMat));
  }

  update(dt: number, sky: SkyState, px: number, pz: number): void {
    this.time += dt;
    for (const m of this.materials) {
      const u = m.uniforms;
      u.uTime.value = this.time; u.uSunDir.value.copy(sky.sunDir); u.uSunCol.value.copy(sky.sunColor).multiplyScalar(sky.day);
      u.uZenith.value.copy(sky.zenith); u.uHorizon.value.copy(sky.horizon); u.uDay.value = sky.day;
    }
    this.nearSea.position.x = Math.round(px / 4) * 4; this.nearSea.position.z = Math.round(pz / 4) * 4;
  }
}

function buildRiverGeometry(): THREE.BufferGeometry {
  // ribbon along the river polyline with lateral width, following the water level
  const samples = 60; const width = 30;
  const pts: THREE.Vector3[] = [];
  const total = RIVER.length - 1;
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * total; const seg = Math.min(Math.floor(t), total - 1); const f = t - seg;
    const a = RIVER[seg], b = RIVER[seg + 1];
    const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
    pts.push(new THREE.Vector3(x, riverInfo(x, z).y + 0.05, z));
  }
  // extend a bit into the sea
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  pts.push(last.clone().add(last.clone().sub(prev).setLength(80)).setY(-0.5));
  const pos: number[] = []; const idx: number[] = []; const nor: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]; const q = pts[Math.min(i + 1, pts.length - 1)]; const r = pts[Math.max(i - 1, 0)];
    const dir = q.clone().sub(r).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
    nor.push(0, 1, 0, 0, 1, 0);
    if (i < pts.length - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}
