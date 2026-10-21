// Sky dome, sun/moon, stars, day/night lighting, fog and environment map.
import * as THREE from 'three';
import { DAY_LENGTH_SEC, quality } from '../config.ts';
import { BIOMES, BIOME_IDS, biomeWeights } from './biomes.ts';

const V = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always at far plane
}`;
const F = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunCol;
uniform float uNight; uniform float uDusk; uniform float uTime; uniform sampler2D uNoise; uniform float uCloud;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(1.0 - h, 0.0, 1.0), 4.5);
  vec3 col = mix(uZenith, uHorizon, t);
  // horizon glow towards the sun at dusk/dawn
  vec2 dh = normalize(d.xz + 1e-5); vec2 sh = normalize(uSunDir.xz + 1e-5);
  float toward = max(dot(dh, sh), 0.0);
  float glow = pow(toward, 4.0) * uDusk * pow(clamp(1.0 - abs(h) * 2.0, 0.0, 1.0), 1.6);
  col += vec3(1.0, 0.45, 0.18) * glow * 0.9;
  // sun
  float sd = max(dot(d, uSunDir), 0.0);
  float sunVis = smoothstep(-0.06, 0.02, uSunDir.y);
  col += uSunCol * (pow(sd, 1800.0) * 14.0 + pow(sd, 48.0) * 0.5 + pow(sd, 6.0) * 0.12) * sunVis;
  // moon
  float md = dot(d, uMoonDir);
  float moonVis = smoothstep(-0.05, 0.05, uMoonDir.y) * (0.35 + 0.65 * uNight);
  float moon = smoothstep(0.99935, 0.99965, md);
  float moonShade = smoothstep(0.9990, 0.99965, dot(d, normalize(uMoonDir + vec3(0.012, 0.004, 0.0))));
  col += vec3(0.92, 0.94, 1.0) * (moon * (0.55 + 0.45 * moonShade) * 1.6 + pow(max(md, 0.0), 160.0) * 0.08) * moonVis;
  // stars
  if (uNight > 0.01 && h > 0.0) {
    vec3 sp = d * 240.0;
    vec3 cell = floor(sp);
    float r = hash(cell);
    vec3 cp = cell + vec3(hash(cell + 1.7), hash(cell + 3.1), hash(cell + 5.3));
    float dist = length(sp - cp);
    float star = smoothstep(0.42, 0.0, dist) * step(0.985, r);
    float tw = 0.7 + 0.3 * sin(uTime * (1.5 + r * 3.0) + r * 40.0);
    col += vec3(0.85, 0.9, 1.0) * star * tw * uNight * smoothstep(0.0, 0.25, h) * 1.4;
  }
  // thin high clouds
  if (h > 0.02) {
    vec2 cuv = d.xz / (h + 0.15);
    float n = texture2D(uNoise, cuv * 0.08 + uTime * 0.0012).b;
    float n2 = texture2D(uNoise, cuv * 0.21 - uTime * 0.0008).r;
    float c = smoothstep(0.62, 0.95, n * 0.7 + n2 * 0.45) * uCloud * smoothstep(0.02, 0.25, h);
    vec3 cloudCol = mix(uHorizon * 1.15 + uSunCol * 0.1, vec3(1.0), 0.6 * (1.0 - uNight)) * (1.0 - 0.85 * uNight);
    cloudCol = mix(cloudCol, vec3(1.0, 0.6, 0.4), uDusk * 0.5);
    col = mix(col, cloudCol, c * 0.55);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SkyState {
  sunDir: THREE.Vector3; moonDir: THREE.Vector3; day: number; night: number; dusk: number;
  sunColor: THREE.Color; zenith: THREE.Color; horizon: THREE.Color; ambient: number;
}

export class Sky {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fog: THREE.FogExp2;
  /** hours [0,24) */
  hours = 9.5;
  speed = 1; // multiplier for the day cycle
  state: SkyState = {
    sunDir: new THREE.Vector3(0, 1, 0), moonDir: new THREE.Vector3(0, -1, 0), day: 1, night: 0, dusk: 0,
    sunColor: new THREE.Color(), zenith: new THREE.Color(), horizon: new THREE.Color(), ambient: 1,
  };
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envMesh: THREE.Mesh;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvHours = -99;
  private biomeW = new Float32Array(BIOME_IDS.length);
  private fogColor = new THREE.Color();
  private tmpC = new THREE.Color();
  private sunTarget = new THREE.Object3D();
  private shadowSize = 90;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, noise: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: V, fragmentShader: F, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
      uniforms: {
        uSunDir: { value: this.state.sunDir }, uMoonDir: { value: this.state.moonDir }, uZenith: { value: this.state.zenith },
        uHorizon: { value: this.state.horizon }, uSunCol: { value: this.state.sunColor }, uNight: { value: 0 }, uDusk: { value: 0 },
        uTime: { value: 0 }, uNoise: { value: noise }, uCloud: { value: 0.45 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(3000); this.mesh.frustumCulled = false; this.mesh.renderOrder = -100;
    scene.add(this.mesh);
    this.envMesh = new THREE.Mesh(this.mesh.geometry, this.material);
    this.envMesh.scale.setScalar(100);
    this.envScene.add(this.envMesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    const s = this.shadowSize;
    this.sun.shadow.camera.left = -s; this.sun.shadow.camera.right = s; this.sun.shadow.camera.top = s; this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 10; this.sun.shadow.camera.far = 400;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.6; this.sun.shadow.radius = 2; this.sun.shadow.intensity = 0.85;
    this.sun.target = this.sunTarget;
    scene.add(this.sun); scene.add(this.sunTarget);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a6a40, 0.8);
    scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xc0d0e0, 0.0022);
    scene.fog = this.fog;
    this.setTime(this.hours);
  }

  setTime(hours: number): void { this.hours = ((hours % 24) + 24) % 24; this.lastEnvHours = -99; }

  /** Advance time and update lights/fog for the player's position. */
  update(dt: number, px: number, pz: number, scene: THREE.Scene, playerPos: THREE.Vector3, camDir: THREE.Vector3): void {
    this.hours = (this.hours + (dt * this.speed * 24) / DAY_LENGTH_SEC) % 24;
    const st = this.state;
    // sunrise ~06:00, sunset ~20:00, night 20:00-06:00
    const h = this.hours;
    const a = h >= 6 && h <= 20 ? ((h - 6) / 14) * Math.PI : Math.PI + (((h - 20 + 24) % 24) / 10) * Math.PI;
    st.sunDir.set(Math.cos(a), Math.sin(a), 0.38).normalize();
    st.moonDir.set(-Math.cos(a + 0.4), -Math.sin(a + 0.4), -0.3).normalize();
    const e = st.sunDir.y;
    st.night = THREE.MathUtils.smoothstep(-e, -0.02, 0.18);
    st.day = 1 - st.night;
    st.dusk = Math.exp(-(e * e) / (0.16 * 0.16)) * (1 - THREE.MathUtils.smoothstep(e, 0.25, 0.5));
    // palette
    const dayZ = this.tmpC.setRGB(0.16, 0.38, 0.9), nightZ = new THREE.Color(0.02, 0.035, 0.09);
    const duskZ = new THREE.Color(0.2, 0.22, 0.42);
    st.zenith.copy(dayZ).lerp(nightZ, st.night).lerp(duskZ, st.dusk * 0.7);
    const dayH = new THREE.Color(0.62, 0.78, 0.97), nightH = new THREE.Color(0.11, 0.14, 0.24), duskH = new THREE.Color(0.98, 0.56, 0.36);
    st.horizon.copy(dayH).lerp(nightH, st.night).lerp(duskH, st.dusk * 0.8);
    st.sunColor.setRGB(1, 0.98, 0.92).lerp(new THREE.Color(1, 0.55, 0.25), st.dusk * 0.9);
    const u = this.material.uniforms;
    u.uNight.value = st.night; u.uDusk.value = st.dusk; u.uTime.value += dt;
    // lights: sun by day, moon by night, sharing the shadow-casting directional light
    const useMoon = e < -0.02;
    const dir = useMoon ? st.moonDir : st.sunDir;
    const sunI = 3.2 * THREE.MathUtils.smoothstep(e, -0.02, 0.2) * (1 - st.dusk * 0.35);
    const moonI = 1.0 * THREE.MathUtils.smoothstep(st.moonDir.y, -0.02, 0.2) * st.night + 0.25 * st.night;
    biomeWeights(px, pz, this.biomeW);
    const wJungle = this.biomeW[1], wSnow = this.biomeW[5];
    this.sun.intensity = (useMoon ? moonI : sunI) * (1 - 0.35 * wJungle);
    this.sun.color.copy(useMoon ? new THREE.Color(0.62, 0.7, 1.0) : st.sunColor);
    // tight shadow frustum following the player, oriented along the view so near things get resolution
    this.sunTarget.position.copy(playerPos).addScaledVector(camDir, 25);
    this.sun.position.copy(this.sunTarget.position).addScaledVector(dir, 180);
    // moonlit blue-grey ambient at night (~25% of day), bluish in the snow, dimmer under the jungle canopy
    const dayHemi = new THREE.Color().copy(st.zenith).lerp(new THREE.Color(0.8, 0.85, 1), 0.3).lerp(new THREE.Color(0.65, 0.75, 1.0), wSnow * 0.6);
    const nightHemi = new THREE.Color(0.42, 0.5, 0.78);
    this.hemi.color.copy(dayHemi).lerp(nightHemi, st.night);
    this.hemi.groundColor.setRGB(0.36, 0.34, 0.26).lerp(new THREE.Color(0.45, 0.55, 0.85), wSnow * 0.5).lerp(new THREE.Color(0.18, 0.2, 0.3), st.night);
    this.hemi.intensity = (0.62 + 0.55 * st.day) * (1 - 0.3 * wJungle);
    st.ambient = 0.25 + 0.75 * st.day;
    // fog: blend biome fog colours by position, darken by night, warm at dusk
    this.fogColor.setRGB(0, 0, 0); let dens = 0;
    for (let i = 0; i < BIOME_IDS.length; i++) {
      const b = BIOMES[BIOME_IDS[i]]; const w = this.biomeW[i];
      this.fogColor.r += b.fog[0] * w; this.fogColor.g += b.fog[1] * w; this.fogColor.b += b.fog[2] * w; dens += b.fogDensityMul * w;
    }
    // fog = sky colour at the horizon, tinted by the biome
    this.fogColor.multiply(st.horizon).multiplyScalar(1 + st.dusk * 0.15);
    this.fog.color.copy(this.fogColor);
    this.fog.density = 0.0019 * dens * (1 + st.night * 0.25);
    // environment map (cheap PMREM of the sky), refreshed as the light changes
    if (Math.abs(this.hours - this.lastEnvHours) > 0.3 || this.lastEnvHours < 0) {
      this.lastEnvHours = this.hours;
      const old = this.envTarget;
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      scene.environment = this.envTarget.texture;
      scene.environmentIntensity = 0.45;
      if (old) old.dispose();
    }
  }
}
