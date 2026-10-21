// A single dinosaur: GLB (skinned, animated) or procedural placeholder,
// animation mixer + small state machine. Movement decisions live in ai.ts.
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ClipName, Species } from './manifest.ts';
import { buildPlaceholder, type PlaceholderRig } from './placeholder.ts';
import { heightAt, waterAt } from '../world/heightmap.ts';
import { Locomotion } from './locomotion.ts';
import { applySkinDetail } from './skin.ts';
import type { Obstacle } from '../world/obstacles.ts';

export type DinoState = 'idle' | 'walk' | 'roar' | 'eat' | 'fly' | 'swim' | 'stomp' | 'sniff' | 'flap' | 'splash';

export interface FoodItem { obj: THREE.Object3D; pos: THREE.Vector3; r: number; kind: string; eaten: boolean; taken: number }
export interface Food { pos: THREE.Vector3; amount: number; mesh: THREE.Object3D; eaters: Map<number, number>; radius: number; items: FoodItem[] }

export interface DinoContext {
  player: THREE.Vector3;
  /** the explorer's eye (what dinosaurs look at) */
  eye: THREE.Vector3;
  /** camera forward direction on the ground plane (unit) — followers walk where the child can see them */
  view: THREE.Vector3;
  obstacles: { near: (x: number, z: number, r: number, out: Obstacle[]) => Obstacle[] };
  others: Dino[];
  /** extra round no-go zones [x, z, r] (the explorer, the camera) */
  keepClear: [number, number, number][];
  time: number;
  foods: Food[];
  onFootstep: (d: Dino, big: boolean, at?: THREE.Vector3, heavy?: boolean) => void;
  onEvent: (d: Dino, ev: 'roar' | 'eat' | 'bite' | 'chew' | 'finished' | 'splash' | 'stomp' | 'sniff' | 'flap', item?: FoodItem) => void;
}

export interface AIData {
  home: THREE.Vector3; target: THREE.Vector3 | null; waitUntil: number; followUntil: number; foodTarget: Food | null;
  angle: number; radius: number; altitude: number; glideUntil: number; actionUntil: number; lastStep: number; breachT: number; nextRoar: number; lastChew: number; breachAt: number;
  yawVel: number; avoidSide: number; blocked: number; bestDist: number; progressAt: number;
  faceTarget: THREE.Vector3 | null; faceUntil: number; glance: THREE.Vector3; glanceUntil: number; glancing: boolean; biteItem: FoodItem | null; bitten: boolean; scripted: boolean; detour: THREE.Vector3 | null; steerT: number; steerDir: number; steerSpeed: number; steerA: number; steerPick: number; route: THREE.Vector3[] | null; routeGoal: THREE.Vector3; routeIdx: number; routeReplanAt: number; standAt: THREE.Vector3 | null; standItem: FoodItem | null; repositions: number; standOk: boolean | null; approachUntil: number; followSide: number; sniffFood: Food | null; sniffed: WeakSet<Food>;
}

export class Dino {
  species: Species;
  root = new THREE.Group();
  model: THREE.Object3D | null = null;
  mixer: THREE.AnimationMixer | null = null;
  actions = new Map<ClipName, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  placeholder: PlaceholderRig | null = null;
  /** procedural legs (land dinosaurs with a leg rig) */
  loco: Locomotion | null = null;
  state: DinoState = 'idle';
  stateTime = 0;
  speed = 0;
  heading = 0;
  awake = true;
  animated = true;
  loaded = false;
  loading = false;
  real = false;
  scale = 1;
  radius: number;
  ai: AIData;
  index: number;
  private animTime = Math.random() * 100;
  private animAcc = 0;
  /** seconds between animation updates (0 = every frame); set by the spawner from distance */
  animInterval = 0;
  private blob: THREE.Mesh;

  constructor(species: Species, index: number, pos: THREE.Vector3, heading: number) {
    this.species = species; this.index = index;
    this.root.position.copy(pos); this.heading = heading; this.root.rotation.y = heading;
    this.root.name = `dino-${species.id}-${index}`;
    this.radius = Math.max(2.2, species.lengthM * 0.45);
    this.ai = { home: pos.clone(), target: null, waitUntil: 0, followUntil: 0, foodTarget: null, angle: Math.random() * Math.PI * 2, radius: 40 + Math.random() * 40, altitude: 25 + Math.random() * 30, glideUntil: 0, actionUntil: 0, lastStep: 0, breachT: -1, nextRoar: 10 + Math.random() * 40, breachAt: -1, lastChew: -1, yawVel: 0, avoidSide: 0, blocked: 0, bestDist: Infinity, progressAt: 0, faceTarget: null, faceUntil: 0, glance: new THREE.Vector3(), glanceUntil: 0, glancing: false, biteItem: null, bitten: false, scripted: false, detour: null, steerT: 0, steerDir: heading, steerSpeed: 0, steerA: 0, steerPick: 0, route: null, routeGoal: new THREE.Vector3(), routeIdx: 0, routeReplanAt: 0, standAt: null, standItem: null, repositions: 0, standOk: null, approachUntil: 0, followSide: 0, sniffFood: null, sniffed: new WeakSet() };
    // placeholder immediately so the world is never empty
    this.placeholder = buildPlaceholder(species);
    this.model = this.placeholder.root;
    this.root.add(this.model);
    // soft contact shadow blob (used for far/unshadowed dinos)
    const blobGeo = new THREE.CircleGeometry(1, 20);
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.08; this.blob.renderOrder = 1;
    this.blob.scale.set(species.lengthM * 0.35, species.lengthM * 0.25, 1);
    this.blob.visible = species.kind === 'land';
    this.root.add(this.blob);
    if (species.kind === 'air') this.state = 'fly';
    if (species.kind === 'water') this.state = 'swim';
  }

  /** Try to load the real GLB; keep the placeholder on failure. */
  async load(loader: GLTFLoader): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    try {
      const gltf = await loader.loadAsync(`/assets/dinos/${this.species.file}`);
      const model = gltf.scene;
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat && mat.isMeshStandardMaterial) { mat.envMapIntensity = 0.6; }
        }
      });
      // normalise to manifest length if the file is wildly off scale
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const len = Math.max(size.x, size.z, 0.01);
      const ratio = this.species.lengthM / len;
      if (ratio < 0.5 || ratio > 2) model.scale.setScalar(ratio);
      model.position.y = -box.min.y * (ratio < 0.5 || ratio > 2 ? ratio : 1);
      this.mixer = new THREE.AnimationMixer(model);
      if (this.species.kind === 'land') {
        this.root.add(model); this.root.updateMatrixWorld(true);
        this.loco = Locomotion.create(this.root, model);
        this.root.remove(model);
      }
      const wanted: ClipName[] = ['idle', 'walk', 'roar', 'eat', 'fly', 'swim'];
      for (const name of wanted) {
        const clipName = this.species.clips[name] ?? name;
        const clip = THREE.AnimationClip.findByName(gltf.animations, clipName) ?? gltf.animations.find((c) => c.name.toLowerCase().includes(name));
        if (clip) {
          const a = this.mixer.clipAction(clip);
          if (name === 'roar' || name === 'eat') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          this.actions.set(name, a);
        }
      }
      applySkinDetail(model, this.species.lengthM, this.species.uvPerM);
      // level of detail: '<id>_lod1' meshes share the skeleton with the full mesh
      this.lodHi = []; this.lodLo = [];
      model.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; (/_lod1/.test(m.name) || /_lod1/.test(m.parent?.name ?? '') ? this.lodLo : this.lodHi).push(m); });
      if (!this.lodLo.length) this.lodLo = this.lodHi;
      for (const m of this.lodLo) if (this.lodLo !== this.lodHi) m.visible = false;
      this.lod = 0;
      if (this.model) this.root.remove(this.model);
      this.model = model; this.root.add(model);
      this.placeholder = null; this.real = true;
      this.measureEat();
      this.play(this.clipFor(this.state), 0);
    } catch {
      // placeholder stays
    }
    this.loaded = true; this.loading = false;
  }

  clipFor(s: DinoState): ClipName {
    switch (s) {
      case 'walk': case 'stomp': return this.loco ? 'idle' : this.actions.has('walk') ? 'walk' : 'idle';
      case 'roar': case 'splash': return this.actions.has('roar') ? 'roar' : 'idle';
      case 'eat': case 'sniff': return this.actions.has('eat') ? 'eat' : 'idle';
      case 'fly': case 'flap': return this.actions.has('fly') ? 'fly' : 'idle';
      case 'swim': return this.actions.has('swim') ? 'swim' : 'idle';
      default: return 'idle';
    }
  }

  private play(name: ClipName, fade = 0.35): void {
    const a = this.actions.get(name) ?? this.actions.get('idle');
    if (!a || !this.mixer) return;
    if (this.current === a && a.isRunning() && (a.loop !== THREE.LoopOnce)) return;
    a.reset(); a.enabled = true; a.setEffectiveWeight(1);
    if (this.current && this.current !== a) { a.crossFadeFrom(this.current, fade, false); }
    a.play();
    this.current = a;
    if (name === 'walk') a.timeScale = THREE.MathUtils.clamp(this.speed / Math.max(0.3, this.species.speed), 0.6, 1.8);
    else a.timeScale = 1;
  }

  setState(s: DinoState): void {
    if (this.state === s) return;
    this.state = s; this.stateTime = 0;
    this.play(this.clipFor(s));
  }

  /** Duration of one-shot actions. */
  static actionDuration(s: DinoState): number {
    return s === 'roar' ? 2.4 : s === 'eat' ? 4 : s === 'stomp' ? 2.4 : s === 'sniff' ? 2.6 : s === 'flap' ? 3 : s === 'splash' ? 2.2 : 0;
  }
  get isBusy(): boolean { return Dino.actionDuration(this.state) > 0; }
  /** How long this dinosaur stays busy in a one-shot state (the real clip length when it has one). */
  busyFor(s: DinoState): number {
    const name = this.clipFor(s);
    const a = (s === 'eat' || s === 'roar' || s === 'sniff' || s === 'splash') ? this.actions.get(name) : undefined;
    return a ? a.getClip().duration + 0.05 : Dino.actionDuration(s);
  }
  /** Restart the current one-shot clip from its first frame (seamless feeding loops). */
  replay(): void { if (this.current) { this.current.reset(); this.current.play(); } this.stateTime = 0; }

  /** Per-frame: animation + ground/water alignment (movement is set by ai.ts). */
  update(dt: number, ctx: DinoContext): void {
    this.stateTime += dt;
    const pos = this.root.position;
    const sp = this.species;
    if (this.loco && this.real) {
      // distant animals update their legs at a lower rate (iPad CPU budget); the pose holds in between
      this.animAcc += dt;
      if (this.animAcc < this.animInterval) return;
      dt = this.animAcc; this.animAcc = 0;
      // procedural legs: the body follows the planted feet, clips drive the upper body
      this.loco.placeBody(dt, this.heading);
      if (!this.animated) return;
      this.animTime += dt;
      this.loco.restoreClipPose();
      if (this.mixer) {
        this.mixer.update(dt);
        if (this.current && this.current.loop === THREE.LoopOnce && !this.current.isRunning() && !this.isBusy) this.play(this.clipFor(this.state));
      }
      this.loco.captureClipPose();
      this.loco.stomp = this.state === 'stomp';
      this.loco.update(dt, this.heading, {
        onPlant: (at, _leg, heavy) => ctx.onFootstep(this, sp.lengthM >= 6 || heavy, at, heavy),
      }, this.isBusy);
      return;
    }
    // vertical placement
    if (sp.kind === 'land') {
      const h = heightAt(pos.x, pos.z);
      const w = waterAt(pos.x, pos.z);
      const wade = w.kind !== 'none' ? Math.min(w.level - h, sp.heightM * 0.45) : 0;
      pos.y += (h + Math.max(0, wade * 0.2) - pos.y) * Math.min(1, dt * 8);
      // tilt with the slope
      const ahead = heightAt(pos.x + Math.sin(this.heading) * 2, pos.z + Math.cos(this.heading) * 2);
      const behind = heightAt(pos.x - Math.sin(this.heading) * 2, pos.z - Math.cos(this.heading) * 2);
      const pitch = Math.atan2(ahead - behind, 4);
      this.root.rotation.x += (-pitch * 0.7 - this.root.rotation.x) * Math.min(1, dt * 4);
    } else if (sp.kind === 'water') {
      const w = waterAt(pos.x, pos.z);
      const level = w.kind === 'none' ? 0 : w.level;
      let y = level - sp.heightM * 0.35 + Math.sin(ctx.time * 0.8 + this.index) * 0.2;
      if (this.ai.breachT >= 0) { const t = this.ai.breachT; y += Math.sin(Math.min(1, t / 1.4) * Math.PI) * sp.heightM * 1.2; this.root.rotation.x = -Math.sin(Math.min(1, t / 1.4) * Math.PI * 2) * 0.5; }
      else this.root.rotation.x *= 0.9;
      pos.y += (y - pos.y) * Math.min(1, dt * 3);
    } else {
      // air: y is set by the ai (altitude), add a bob
      this.root.rotation.z += ((this.state === 'flap' ? -0.35 : -0.15) - this.root.rotation.z) * Math.min(1, dt * 2);
    }
    this.root.rotation.y = this.heading;
    if (!this.animated) return;
    this.animTime += dt;
    if (this.placeholder) this.placeholder.update(dt, this.state, this.speed / Math.max(0.3, sp.speed), this.animTime);
    if (this.mixer) {
      const walk = this.actions.get('walk');
      if (walk && this.current === walk) walk.timeScale = THREE.MathUtils.clamp(this.speed / Math.max(0.2, sp.speed * this.scale), 0.25, 2.4);
      this.mixer.update(dt);
      if (this.current && this.current.loop === THREE.LoopOnce && !this.current.isRunning() && !this.isBusy) this.play(this.clipFor(this.state));
    }
    // footsteps (placeholder / clip-driven only)
    if ((this.state === 'walk' || this.state === 'stomp') && sp.kind === 'land') {
      const rate = Math.max(0.25, this.speed / Math.max(0.2, sp.speed * this.scale));
      const stride = this.state === 'stomp' ? 0.45 : (sp.walkSeconds ? sp.walkSeconds / 2 : THREE.MathUtils.clamp(sp.lengthM * 0.09, 0.28, 1.1)) / rate;
      if (this.animTime - this.ai.lastStep > stride) { this.ai.lastStep = this.animTime; ctx.onFootstep(this, sp.lengthM >= 6); }
    }
  }

  /** Progress (0..1) through the clip that is playing for the current one-shot state. */
  get clipPhase(): number {
    const a = this.current; if (!a) return Math.min(1, this.stateTime / Math.max(0.1, Dino.actionDuration(this.state)));
    return Math.min(1, a.time / Math.max(0.01, a.getClip().duration));
  }
  /** Horizontal distance from the root to the snout at the bottom of the eat clip (m). */
  eatReach = 0;
  eatHeight = 0;
  /** learned correction (m) from real bites: food sits on a heap, not on the ground */
  eatTrim = 0;
  get reachNow(): number { return Math.max(0.3, this.eatReach - this.eatTrim); }
  private measureEat(): void {
    const sp = this.species;
    this.eatReach = (sp.snoutM ?? sp.lengthM * 0.45) * 0.8 * this.scale;
    const eat = this.actions.get('eat');
    if (!this.loco || !eat || !this.mixer || !this.model) return;
    const tmpQ = this.root.rotation.clone(); this.root.rotation.set(0, 0, 0); this.root.updateMatrixWorld(true);
    this.loco.resetPose();
    eat.reset(); eat.enabled = true; eat.setEffectiveWeight(1); eat.play();
    let best = { y: Infinity, z: 0 };
    const v = new THREE.Vector3();
    for (let t = 0.3; t <= 0.72; t += 0.06) {
      eat.time = t * eat.getClip().duration; this.mixer.update(0);
      this.model.updateMatrixWorld(true);
      if (this.loco.snoutWorld(v)) { this.root.worldToLocal(v); if (v.y < best.y) best = { y: v.y, z: v.z }; }
    }
    eat.stop(); this.loco.resetPose(); this.model.updateMatrixWorld(true);
    // drop the mixer's cached bindings so the next clip writes every bone again
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    for (const [k, a] of this.actions) {
      const clip = a.getClip(); const na = this.mixer.clipAction(clip);
      if (k === 'roar' || k === 'eat') { na.setLoop(THREE.LoopOnce, 1); na.clampWhenFinished = true; }
      this.actions.set(k, na);
    }
    this.root.rotation.copy(tmpQ); this.root.updateMatrixWorld(true);
    if (best.y < Infinity) { this.eatReach = best.z; this.eatHeight = best.y; }
    this.current = null;
  }

  /** Top walking speed the legs can carry (m/s). */
  get maxSpeed(): number { return this.loco ? Math.min(this.species.speed * this.scale, this.loco.maxSpeed) : this.species.speed * this.scale; }
  /** Fastest the legs can carry the body at a trot (m/s). */
  get trotSpeed(): number { return this.loco ? this.loco.trotSpeed : this.species.speed * this.scale * 1.5; }
  /** Fastest yaw rate the feet can follow when pivoting (rad/s). */
  get maxTurnRate(): number { return this.loco ? this.loco.maxTurnRate : 1.2; }

  /** World position of the snout (near the ground when eating, else at head height). */
  snoutPos(out: THREE.Vector3): THREE.Vector3 {
    if (this.loco && this.real && this.loco.snoutWorld(out)) return out;
    const sp = this.species; const snout = (sp.snoutM ?? sp.lengthM * 0.45) * this.scale;
    const h = this.state === 'eat' ? 0.5 : (sp.headM ?? sp.heightM * 0.8) * this.scale;
    return out.set(this.root.position.x + Math.sin(this.heading) * snout, this.root.position.y + h, this.root.position.z + Math.cos(this.heading) * snout);
  }
  private lodHi: THREE.Object3D[] = []; private lodLo: THREE.Object3D[] = []; private lod = 0;
  /** 0 = full mesh, 1 = reduced mesh (with hysteresis handled by the caller). */
  setLod(level: number): void {
    if (level === this.lod || this.lodLo === this.lodHi || !this.lodHi.length) return;
    this.lod = level;
    for (const m of this.lodHi) m.visible = level === 0;
    for (const m of this.lodLo) m.visible = level === 1;
  }
  get lodLevel(): number { return this.lod; }
  setBlobVisible(v: boolean): void { this.blob.visible = v && this.species.kind === 'land'; }
  private castShadowOn = true;
  setCastShadow(v: boolean): void {
    if (v === this.castShadowOn || !this.model) return;
    this.castShadowOn = v;
    this.model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = v; });
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const mat of mats) mat.dispose(); }
    });
    this.mixer?.stopAllAction();
  }
}
