// Footprints: every planted foot of a nearby dinosaur leaves a print pressed into soft ground (sand,
// dirt, mud, snow) that fades over a minute. One instanced, multiply-blended decal mesh: a print darkens
// the ground under it, which reads as a depression. Three-toed prints for bipeds, round ones for the rest.
import * as THREE from 'three';
import { heightAt, slopeAt, waterAt } from './heightmap.ts';
import { biomeWeights } from './biomes.ts';

const MAX = 256;

function printTexture(): THREE.CanvasTexture {
  // two prints side by side in one atlas, each filling its cell: [0, 0.5) three-toed, [0.5, 1) round
  const C = 256, W = C * 2, H = C; const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.filter = 'blur(5px)';
  const ink = 'rgb(160,146,132)', deep = 'rgba(120,104,90,0.55)';
  // three-toed (theropod): broad heel pad and three thick toes fanning forward (up = forward)
  g.fillStyle = ink;
  g.beginPath(); g.ellipse(128, 188, 36, 44, 0, 0, Math.PI * 2); g.fill();
  for (const [ang, len] of [[-0.46, 104], [0, 122], [0.46, 104]] as [number, number][]) {
    g.save(); g.translate(128, 168); g.rotate(ang);
    g.beginPath(); g.ellipse(0, -len * 0.5, 20, len * 0.52, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(0, -len * 1.0, 9, 14, 0, 0, Math.PI * 2); g.fill();      // claw
    g.restore();
  }
  g.fillStyle = deep;
  g.beginPath(); g.ellipse(128, 192, 22, 28, 0, 0, Math.PI * 2); g.fill();
  for (const ang of [-0.46, 0, 0.46]) { g.save(); g.translate(128, 168); g.rotate(ang); g.beginPath(); g.ellipse(0, -46, 10, 36, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
  // round (sauropods, horned and armoured dinosaurs): broad pad with stubby toes at the front
  g.fillStyle = ink;
  g.beginPath(); g.ellipse(C + 128, 150, 96, 86, 0, 0, Math.PI * 2); g.fill();
  for (const dx of [-66, -23, 23, 66]) { g.beginPath(); g.ellipse(C + 128 + dx, 56 + Math.abs(dx) * 0.35, 21, 25, 0, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = deep;
  g.beginPath(); g.ellipse(C + 128, 156, 62, 54, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Footprints {
  mesh: THREE.InstancedMesh;
  private born = new Float32Array(MAX).fill(-1e9);
  private life = new Float32Array(MAX);
  private tint: THREE.Color[] = [];
  private next = 0;
  private clock = 0;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private s = new THREE.Vector3(); private p = new THREE.Vector3();
  private n = new THREE.Vector3(); private white = new THREE.Color(1, 1, 1);
  constructor() {
    // a unit quad whose UVs pick half of the atlas per instance via a per-instance offset attribute
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const atlas = new Float32Array(MAX); geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(atlas, 1));
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1));
    const mat = new THREE.MeshBasicMaterial({ map: printTexture(), transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false, toneMapped: false });   // white must stay exactly 1.0 or the quad shows
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aAtlas; attribute float aFade; varying float vFade;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFade = aFade;\n#ifdef USE_MAP\nvMapUv = vec2(aAtlas * 0.5 + uv.x * 0.5, uv.y);\n#endif');
      // multiply blending can only darken: fade a print by blending its colour toward white
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(vec3(1.0), diffuseColor.rgb, vFade);');
    };
    mat.customProgramCacheKey = () => 'footprints-v1';
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.name = 'footprints';
    for (let i = 0; i < MAX; i++) { this.tint.push(new THREE.Color(1, 1, 1)); this.mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); this.mesh.setColorAt(i, this.white); }
    this.mesh.count = MAX;
  }

  /** A foot planted at `at` (heading `yaw`, print length `size` m, three-toed if `biped`). */
  add(at: THREE.Vector3, yaw: number, size: number, biped: boolean): void {
    const x = at.x, z = at.z;
    const w = waterAt(x, z); const h = heightAt(x, z);
    if (w.kind !== 'none' && w.level > h + 0.05) return;           // underwater: nothing to see
    if (slopeAt(x, z, 1) > 0.42) return;                           // steep rock keeps no prints
    const b = biomeWeights(x, z);
    const snow = b.dominant === 'snow';
    const i = this.next; this.next = (this.next + 1) % MAX;
    // ground normal for the decal's tilt
    const e = 0.4; this.n.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
    this.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.n).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI));
    const width = biped ? size * 0.9 : size * 0.85;
    this.s.set(width, 1, size); this.p.set(x, h + 0.02, z);
    this.m.compose(this.p, this.q, this.s); this.mesh.setMatrixAt(i, this.m);
    (this.mesh.geometry.getAttribute('aAtlas') as THREE.InstancedBufferAttribute).setX(i, biped ? 0 : 1);
    (this.mesh.geometry.getAttribute('aAtlas') as THREE.InstancedBufferAttribute).needsUpdate = true;
    // snow prints are blue-grey shadows, everything else damp earth
    this.tint[i].set(snow ? 0xb8c4d6 : 0xffffff); this.mesh.setColorAt(i, this.tint[i]); if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.born[i] = this.clock; this.life[i] = snow ? 90 : 45;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.clock += dt;
    const fade = this.mesh.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute;
    let dirty = false;
    for (let i = 0; i < MAX; i++) {
      const age = this.clock - this.born[i]; if (age < 0 || age > this.life[i] + 1) continue;
      // fresh prints press in over a moment and fade out over the last third of their life
      const k = Math.min(1, age / 0.25) * (1 - THREE.MathUtils.smoothstep(age, this.life[i] * 0.66, this.life[i]));
      fade.setX(i, k); dirty = true;
      if (age > this.life[i]) { this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)); this.mesh.instanceMatrix.needsUpdate = true; this.born[i] = -1e9; }
    }
    if (dirty) fade.needsUpdate = true;
  }
}
