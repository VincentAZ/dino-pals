// A single dinosaur: GLB (skinned, animated) or procedural placeholder,
// animation mixer + small state machine. Movement decisions live in ai.ts.
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ClipName, Species } from './manifest.ts';
import { buildPlaceholder, type PlaceholderRig } from './placeholder.ts';
import { heightAt, waterAt } from '../world/heightmap.ts';

export type DinoState = 'idle' | 'walk' | 'roar' | 'eat' | 'fly' | 'swim' | 'stomp' | 'sniff' | 'flap' | 'splash';

export interface Food { pos: THREE.Vector3; amount: number; mesh: THREE.Object3D; eaters?: Map<number, number> }

export interface DinoContext {
  player: THREE.Vector3;
  time: number;
  foods: Food[];
  onFootstep: (d: Dino, big: boolean) => void;
  onEvent: (d: Dino, ev: 'roar' | 'eat' | 'bite' | 'finished' | 'splash' | 'stomp' | 'sniff' | 'flap') => void;
}

export interface AIData {
  home: THREE.Vector3; target: THREE.Vector3 | null; waitUntil: number; followUntil: number; foodTarget: Food | null;
  angle: number; radius: number; altitude: number; glideUntil: number; actionUntil: number; lastStep: number; breachT: number; nextRoar: number; lastChew: number; breachAt: number;
}

export class Dino {
  species: Species;
  root = new THREE.Group();
  model: THREE.Object3D | null = null;
  mixer: THREE.AnimationMixer | null = null;
  actions = new Map<ClipName, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  placeholder: PlaceholderRig | null = null;
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
  private blob: THREE.Mesh;

  constructor(species: Species, index: number, pos: THREE.Vector3, heading: number) {
    this.species = species; this.index = index;
    this.root.position.copy(pos); this.heading = heading; this.root.rotation.y = heading;
    this.root.name = `dino-${species.id}-${index}`;
    this.radius = Math.max(2.2, species.lengthM * 0.45);
    this.ai = { home: pos.clone(), target: null, waitUntil: 0, followUntil: 0, foodTarget: null, angle: Math.random() * Math.PI * 2, radius: 40 + Math.random() * 40, altitude: 25 + Math.random() * 30, glideUntil: 0, actionUntil: 0, lastStep: 0, breachT: -1, nextRoar: 10 + Math.random() * 40, breachAt: -1, lastChew: -1 };
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
      if (this.model) this.root.remove(this.model);
      this.model = model; this.root.add(model);
      this.placeholder = null; this.real = true;
      this.play(this.clipFor(this.state), 0);
    } catch {
      // placeholder stays
    }
    this.loaded = true; this.loading = false;
  }

  private clipFor(s: DinoState): ClipName {
    switch (s) {
      case 'walk': case 'stomp': return this.actions.has('walk') ? 'walk' : 'idle';
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

  /** Per-frame: animation + ground/water alignment (movement is set by ai.ts). */
  update(dt: number, ctx: DinoContext): void {
    this.stateTime += dt;
    const pos = this.root.position;
    const sp = this.species;
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
      const walk = this.actions.get('walk'), idle = this.actions.get('idle');
      if (walk && this.current === walk && (this.state === 'walk' || this.state === 'stomp')) {
        // feet must cover exactly the ground distance: rate = ground speed / clip's natural speed
        const natural = Math.max(0.2, sp.speed * this.scale);
        walk.timeScale = THREE.MathUtils.clamp(this.speed / natural, 0.25, 2.4);
        // near-stationary → mostly idle, so starts/stops/turns don't moonwalk
        const w = THREE.MathUtils.clamp(this.speed / (0.45 * natural), 0, 1);
        if (idle && this.stateTime > 0.4) {
          if (!idle.isRunning()) { idle.reset(); idle.enabled = true; idle.setEffectiveWeight(0); idle.play(); }
          walk.setEffectiveWeight(Math.max(0.02, w)); idle.setEffectiveWeight(1 - w);
        }
      }
      this.mixer.update(dt);
      if (this.current && this.current.loop === THREE.LoopOnce && !this.current.isRunning() && !this.isBusy) this.play(this.clipFor(this.state));
    }
    // footsteps
    if ((this.state === 'walk' || this.state === 'stomp') && sp.kind === 'land') {
      const rate = Math.max(0.25, this.speed / Math.max(0.2, sp.speed * this.scale));
      const stride = this.state === 'stomp' ? 0.45 : (sp.walkSeconds ? sp.walkSeconds / 2 : THREE.MathUtils.clamp(sp.lengthM * 0.09, 0.28, 1.1)) / rate;
      if (this.animTime - this.ai.lastStep > stride) { this.ai.lastStep = this.animTime; ctx.onFootstep(this, sp.lengthM >= 6); }
    }
  }

  /** World position of the snout (near the ground when eating, else at head height). */
  snoutPos(out: THREE.Vector3): THREE.Vector3 {
    const sp = this.species; const snout = (sp.snoutM ?? sp.lengthM * 0.45) * this.scale;
    const h = this.state === 'eat' ? 0.5 : (sp.headM ?? sp.heightM * 0.8) * this.scale;
    return out.set(this.root.position.x + Math.sin(this.heading) * snout, this.root.position.y + h, this.root.position.z + Math.cos(this.heading) * snout);
  }
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
