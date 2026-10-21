// Spawns dinosaurs per biome, lazy-loads GLBs nearest-first, sleeps far ones.
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Dino, type DinoContext } from './dino.ts';
import type { Species } from './manifest.ts';
import { updateAI, findSpot, runQueuedTap } from './ai.ts';
import { resetRouteBudget } from './path.ts';
import { prewarmLand } from './ai_land.ts';
import { BIOMES, type BiomeId } from '../world/biomes.ts';
import { heightAt, slopeAt, waterAt } from '../world/heightmap.ts';
import { DINO_SLEEP_DIST, MAX_ANIMATED_DINOS } from '../config.ts';
import { mulberry32 } from '../util/noise.ts';

export class DinoManager {
  group = new THREE.Group();
  dinos: Dino[] = [];
  private loader: GLTFLoader;
  private loadingCount = 0;
  constructor(loader: GLTFLoader) { this.loader = loader; this.group.name = 'dinos'; }

  /** Opening tableau: friendly stars close to the start, facing the explorer. */
  private static TABLEAU: Record<string, [number, number]> = { paluxysaurus: [-15, -31], triceratops: [13, -17], stegosaurus: [-6, -14], trex: [20, -36] };
  private herdTimer = 0;

  spawnAll(species: Species[], seed = 7): void {
    const rnd = mulberry32(seed);
    let idx = 0;
    for (const sp of species) {
      for (let i = 0; i < sp.count; i++) {
        const tab = i === 0 ? DinoManager.TABLEAU[sp.id] : undefined;
        if (tab) {
          const d = new Dino(sp, idx++, new THREE.Vector3(tab[0], 0, tab[1]), Math.atan2(-tab[0], -tab[1]));
          d.ai.waitUntil = 6 + rnd() * 6;
          this.dinos.push(d); this.group.add(d.root);
          idx = this.addBaby(d, idx, rnd);
          continue;
        }
        const biome = BIOMES[sp.biomes[i % sp.biomes.length]] ?? BIOMES.meadow;
        const [ax, az] = biome.anchor;
        let spot: THREE.Vector3 | null = null;
        if (sp.kind === 'water') {
          const minDepth = Math.max(1.2, sp.heightM * 0.6);
          spot = findSpot((x, z) => { const w = waterAt(x, z); return (w.kind === 'sea' || w.kind === 'lake') && w.level - heightAt(x, z) >= minDepth; }, biome.center[0], biome.center[1], biome.radius * 0.9, rnd, 80)
            ?? findSpot((x, z) => { const w = waterAt(x, z); return w.kind === 'sea' && w.level - heightAt(x, z) >= minDepth; }, 150, 560, 300, rnd, 200);
        } else {
          spot = findSpot((x, z) => { const h = heightAt(x, z); return h > 1 && waterAt(x, z).kind === 'none' && slopeAt(x, z, 2) < 0.4 && Math.hypot(x, z) > 18; }, ax, az, biome.radius * 0.6, rnd, 80);
        }
        if (!spot) spot = new THREE.Vector3(ax, 0, az);
        const d = new Dino(sp, idx++, spot, rnd() * Math.PI * 2);
        d.scale = 1;
        if (sp.kind === 'air') d.root.position.y = Math.max(heightAt(spot.x, spot.z), 0) + d.ai.altitude;
        d.root.visible = false;
        this.dinos.push(d); this.group.add(d.root);
        if (i === 1 && sp.kind === 'land') idx = this.addBaby(d, idx, rnd);
      }
    }
  }

  /** Species that bring a little one along. */
  private static BABIES = new Set(['triceratops', 'stegosaurus', 'paluxysaurus', 'trex', 'iguanodon', 'ankylosaurus', 'pachycephalosaurus']);
  private addBaby(parent: Dino, idx: number, rnd: () => number): number {
    if (!DinoManager.BABIES.has(parent.species.id)) return idx;
    const p = parent.root.position, L = parent.species.lengthM;
    const a = parent.heading + Math.PI * 0.5 + (rnd() - 0.5) * 0.6;
    const b = new Dino(parent.species, idx, new THREE.Vector3(p.x + Math.sin(a) * L * 0.5, 0, p.z + Math.cos(a) * L * 0.5), parent.heading);
    b.setScale(parent.species.id === 'paluxysaurus' ? 0.25 : 0.38);
    b.parent = parent; b.ai.home.copy(parent.ai.home); b.ai.waitUntil = parent.ai.waitUntil;
    b.root.visible = parent.root.visible;
    if (parent.species.kind === 'air') b.root.position.y = p.y;
    this.dinos.push(b); this.group.add(b.root);
    return idx + 1;
  }

  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  /** "Herd nearby": keep a few land dinos wandering towards the player when the area is empty. */
  private herd(ctx: DinoContext): void {
    const p = ctx.player;
    let near = 0;
    for (const d of this.dinos) if (d.awake && d.species.kind === 'land' && Math.hypot(d.root.position.x - p.x, d.root.position.z - p.z) < 60) near++;
    if (near >= 3) return;
    const cands = this.dinos
      .filter((d) => d.species.kind === 'land' && !d.parent && !d.isBusy && !d.ai.scripted && d.ai.followUntil < ctx.time && !d.ai.foodTarget)
      .map((d) => ({ d, dist: Math.hypot(d.root.position.x - p.x, d.root.position.z - p.z) }))
      .filter((c) => c.dist >= 60 && c.dist < 340)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3 - near);
    for (const { d } of cands) {
      const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 15;
      const spot = findSpot((x, z) => heightAt(x, z) > 0.8 && waterAt(x, z).kind === 'none' && slopeAt(x, z, 2) < 0.5, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 6, Math.random, 10);
      if (spot) { d.ai.target = spot; d.ai.waitUntil = 0; d.ai.home.copy(spot); }
    }
  }

  /** Bring a biome's species close to the player after a teleport (land on land, swimmers in water, flyers overhead). */
  attract(biome: BiomeId, player: THREE.Vector3, time: number): void {
    const rnd = Math.random;
    const used = new Set<string>();
    for (const d of this.dinos) {
      const sp = d.species;
      if (!sp.biomes.includes(biome) || used.has(sp.id)) continue;
      const dist = Math.hypot(d.root.position.x - player.x, d.root.position.z - player.z);
      if (dist < 45 && sp.kind !== 'water') { used.add(sp.id); continue; }
      let spot: THREE.Vector3 | null = null;
      if (sp.kind === 'water') {
        const minDepth = Math.max(1.2, sp.heightM * 0.6);
        spot = findSpot((x, z) => { const w = waterAt(x, z); return (w.kind === 'sea' || w.kind === 'lake') && w.level - heightAt(x, z) >= minDepth && Math.hypot(x - player.x, z - player.z) > 12; }, player.x, player.z, 60, rnd, 120);
        if (spot) d.ai.breachAt = time + 2 + rnd() * 2;
      } else if (sp.kind === 'land') {
        spot = findSpot((x, z) => heightAt(x, z) > 0.8 && waterAt(x, z).kind === 'none' && slopeAt(x, z, 2) < 0.45 && Math.hypot(x - player.x, z - player.z) > 14 + sp.lengthM * 0.4, player.x, player.z, 40, rnd, 80);
      } else {
        spot = new THREE.Vector3(player.x + (rnd() - 0.5) * 60, 0, player.z + (rnd() - 0.5) * 60);
        d.root.position.y = Math.max(heightAt(spot.x, spot.z), 0) + d.ai.altitude;
      }
      if (!spot) continue;
      used.add(sp.id);
      d.root.position.x = spot.x; d.root.position.z = spot.z;
      if (sp.kind === 'land') { d.root.position.y = heightAt(spot.x, spot.z); d.heading = Math.atan2(player.x - spot.x, player.z - spot.z); }
      d.ai.home.copy(spot); d.ai.target = null; d.ai.foodTarget = null; d.ai.waitUntil = time + 3 + rnd() * 4; d.speed = 0;
      if (sp.kind === 'land') d.setState('idle');
      for (const b of this.dinos) if (b.parent === d) {
        const a = d.heading + Math.PI * 0.5; const L = sp.lengthM;
        b.root.position.set(spot.x + Math.sin(a) * L * 0.5, heightAt(spot.x + Math.sin(a) * L * 0.5, spot.z + Math.cos(a) * L * 0.5), spot.z + Math.cos(a) * L * 0.5);
        b.heading = d.heading; b.ai.target = null; b.speed = 0; b.loco?.resetPlants();
      }
    }
  }

  update(dt: number, ctx: DinoContext, shadowCenter: THREE.Vector3, camera: THREE.Camera): void {
    const p = ctx.player;
    resetRouteBudget(1);
    prewarmLand(p.x, p.z, 0.6);   // walkability ahead of need, so route plans are lookups
    this.herdTimer -= dt;
    if (this.herdTimer <= 0) { this.herdTimer = 2.5; this.herd(ctx); }
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    // distance sort for budgets
    const sorted = this.dinos.map((d) => ({ d, dist: Math.hypot(d.root.position.x - p.x, d.root.position.z - p.z) })).sort((a, b) => a.dist - b.dist);
    let animated = 0;
    for (const { d, dist } of sorted) {
      const awake = dist < DINO_SLEEP_DIST;
      d.awake = awake; d.root.visible = awake;
      d.animated = awake && animated < MAX_ANIMATED_DINOS;
      if (d.animated) animated++;
      if (!awake) { if (d.ai.followUntil > ctx.time) d.ai.followUntil = 0; continue; }
      // only animated dinosaurs may move (an un-animated one would glide like a statue)
      if (d.animated || d.species.kind !== 'land') { updateAI(d, dt, ctx); runQueuedTap(d, ctx); } else d.speed = 0;
      d.animInterval = dist < 45 ? 0 : dist < 100 ? 1 / 31 : 1 / 16;
      const camD = d.root.position.distanceTo((camera as THREE.PerspectiveCamera).position);
      const lodFar = 30 + d.species.lengthM * 1.5;
      d.setLod(d.lodLevel === 0 ? (camD > lodFar + 4 ? 1 : 0) : (camD < lodFar - 4 ? 0 : 1));
      d.update(dt, ctx);
      // manual frustum culling (skinned meshes have unreliable bounds)
      this.sphere.center.copy(d.root.position); this.sphere.center.y += d.species.heightM * 0.5; this.sphere.radius = d.species.lengthM * 0.75 + 2;
      d.root.visible = this.frustum.intersectsSphere(this.sphere);
      // shadow: real shadows only near the shadow frustum; blobs for the rest
      const nearShadow = Math.hypot(d.root.position.x - shadowCenter.x, d.root.position.z - shadowCenter.z) < 48;
      d.setBlobVisible(!nearShadow); d.setCastShadow(nearShadow);
      if (!d.loaded && !d.loading && this.loadingCount < 2 && dist < 350) { this.loadingCount++; d.load(this.loader).finally(() => this.loadingCount--); }
    }
  }

  /** Pick the dinosaur under a screen point: the full projected silhouette box (min 88 px) counts. */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number, minPx: number, viewW: number, viewH: number): Dino | null {
    const v = new THREE.Vector3();
    const px = (ndcX + 1) * viewW / 2, py = (1 - ndcY) * viewH / 2;
    let best: Dino | null = null, bestDist = Infinity;
    for (const d of this.dinos) {
      if (!d.awake || !d.root.visible) continue;
      const sp = d.species; const L = sp.lengthM * d.scale, H = sp.heightM * d.scale, W = Math.max(L * 0.22, 0.6);
      const sinH = Math.sin(d.heading), cosH = Math.cos(d.heading);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; let behind = false;
      for (const [lx, ly, lz] of [[-W, 0, -L / 2], [W, 0, -L / 2], [-W, 0, L / 2], [W, 0, L / 2], [-W, H, -L / 2], [W, H, -L / 2], [-W, H, L / 2], [W, H, L / 2]]) {
        v.set(d.root.position.x + lx * cosH + lz * sinH, d.root.position.y + ly, d.root.position.z - lx * sinH + lz * cosH).project(camera);
        if (v.z > 1) { behind = true; break; }
        const sx = (v.x + 1) * viewW / 2, sy = (1 - v.y) * viewH / 2;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (behind) continue;
      // guarantee a big enough target
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const hw = Math.max((maxX - minX) / 2, minPx), hh = Math.max((maxY - minY) / 2, minPx);
      if (Math.abs(px - cx) <= hw && Math.abs(py - cy) <= hh) {
        const dist = d.root.position.distanceTo((camera as THREE.PerspectiveCamera).position);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
    }
    return best;
  }

  get stats(): { total: number; awake: number; animated: number; real: number } {
    let awake = 0, animated = 0, real = 0;
    for (const d of this.dinos) { if (d.awake) awake++; if (d.animated && d.awake) animated++; if (d.real) real++; }
    return { total: this.dinos.length, awake, animated, real };
  }
}
