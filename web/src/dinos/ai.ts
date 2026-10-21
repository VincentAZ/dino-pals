// Behaviours: wander, follow the player, go to food, flyers circle, swimmers patrol.
import * as THREE from 'three';
import { Dino, type DinoContext, type DinoState } from './dino.ts';
import { heightAt, slopeAt, waterAt } from '../world/heightmap.ts';
import { HALF } from '../world/biomes.ts';

const tmp = new THREE.Vector3();

function headingError(d: Dino, tx: number, tz: number): number {
  const want = Math.atan2(tx - d.root.position.x, tz - d.root.position.z);
  let diff = want - d.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}
function turnToward(d: Dino, tx: number, tz: number, dt: number, rate: number): number {
  const diff = headingError(d, tx, tz);
  d.heading += THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
  return Math.abs(diff);
}
/** Slow pivot without stepping (idle pose) — big animals turn slowly. */
function pivotRate(lengthM: number): number { return THREE.MathUtils.clamp(1.5 / Math.sqrt(lengthM), 0.3, 1.1); }
function snoutOf(d: Dino): number { return (d.species.snoutM ?? d.species.lengthM * 0.45) * d.scale; }

/**
 * Ground locomotion toward (tx,tz): arc while walking (yaw limited by speed / turn radius), pivot in
 * place when the target is far off-axis, ramp speed. Returns the remaining distance.
 */
function driveToward(d: Dino, tx: number, tz: number, dt: number, maxSpeed: number, stopDist: number): number {
  const sp = d.species; const pos = d.root.position;
  const dist = Math.hypot(tx - pos.x, tz - pos.z);
  if (dist <= stopDist) { d.speed = Math.max(0, d.speed - maxSpeed * dt * 3); if (d.speed < 0.05) d.speed = 0; d.setState(d.speed > 0.05 ? 'walk' : 'idle'); return dist; }
  const diff = headingError(d, tx, tz); const absd = Math.abs(diff);
  if (absd > 0.65 && d.speed < 0.3 * maxSpeed) {
    // pivot in place: no walk cycle → no sliding feet
    d.heading += THREE.MathUtils.clamp(diff, -pivotRate(sp.lengthM) * dt, pivotRate(sp.lengthM) * dt);
    d.speed = Math.max(0, d.speed - maxSpeed * dt * 3); if (d.speed < 0.05) d.speed = 0;
    d.setState(d.speed > 0.05 ? 'walk' : 'idle');
    return dist;
  }
  const turnR = Math.max(0.8, sp.lengthM * 0.35 * d.scale);
  const yawMax = Math.max(0.12, d.speed / turnR);
  d.heading += THREE.MathUtils.clamp(diff, -yawMax * dt, yawMax * dt);
  const slowForTurn = absd > 0.9 ? 0.35 : absd > 0.45 ? 0.6 : 1;
  const nearStop = THREE.MathUtils.clamp((dist - stopDist) / Math.max(1, sp.lengthM * 0.6), 0.25, 1);
  const want = maxSpeed * Math.min(slowForTurn, nearStop);
  const accel = maxSpeed / (sp.lengthM > 7 ? 1.6 : 0.8);
  d.speed += THREE.MathUtils.clamp(want - d.speed, -accel * dt * 1.5, accel * dt);
  const nx = pos.x + Math.sin(d.heading) * d.speed * dt, nz = pos.z + Math.cos(d.heading) * d.speed * dt;
  if (landOk(nx, nz)) { pos.x = nx; pos.z = nz; } else { d.speed = 0; d.ai.target = null; d.ai.waitUntil = Infinity; }
  d.setState('walk');
  return dist;
}

function landOk(x: number, z: number): boolean {
  if (Math.abs(x) > HALF - 20 || Math.abs(z) > HALF - 20) return false;
  const h = heightAt(x, z);
  if (h < 0.4) return false;
  if (waterAt(x, z).kind !== 'none') return false;
  return slopeAt(x, z, 2) < 0.55;
}
function waterOk(x: number, z: number, minDepth: number): boolean {
  if (Math.abs(x) > HALF + 100 || Math.abs(z) > HALF + 100) return false;
  const w = waterAt(x, z);
  if (w.kind === 'none' || w.kind === 'pool') return false;
  return w.level - heightAt(x, z) >= minDepth;
}

export function findSpot(ok: (x: number, z: number) => boolean, cx: number, cz: number, r: number, rnd: () => number, tries = 30): THREE.Vector3 | null {
  for (let i = 0; i < tries; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (ok(x, z)) return new THREE.Vector3(x, 0, z);
  }
  return null;
}

/** Push overlapping land dinosaurs apart (called once per frame for the awake set). */
export function separate(dinos: Dino[]): void {
  for (let i = 0; i < dinos.length; i++) {
    const a = dinos[i]; if (a.species.kind !== 'land' || !a.awake) continue;
    for (let j = i + 1; j < dinos.length; j++) {
      const b = dinos[j]; if (b.species.kind !== 'land' || !b.awake) continue;
      const dx = b.root.position.x - a.root.position.x, dz = b.root.position.z - a.root.position.z;
      const min = (a.radius + b.radius) * 0.55; const dd = Math.hypot(dx, dz);
      if (dd >= min || dd < 1e-3) continue;
      const push = (min - dd) * 0.5; const nx = dx / dd, nz = dz / dd;
      const wa = b.radius / (a.radius + b.radius), wb = 1 - wa;   // the lighter one moves more
      if (!a.isBusy) { a.root.position.x -= nx * push * wa; a.root.position.z -= nz * push * wa; }
      if (!b.isBusy) { b.root.position.x += nx * push * wb; b.root.position.z += nz * push * wb; }
    }
  }
}

export function updateAI(d: Dino, dt: number, ctx: DinoContext): void {
  const sp = d.species; const ai = d.ai; const pos = d.root.position;
  const following = ctx.time < ai.followUntil;

  // one-shot actions block locomotion (except for flyers/swimmers which keep moving)
  if (d.isBusy && sp.kind === 'land') {
    d.speed = 0;
    if (d.state === 'eat' && ai.foodTarget) {
      const f = ai.foodTarget; f.amount -= dt * 0.028;
      // bites happen while the head is down (30–72% of the 4 s clip): one event per chew
      const ph = d.stateTime / Dino.actionDuration('eat');
      if (ph > 0.3 && ph < 0.72) { const chew = Math.floor((ph - 0.3) / 0.14); if (chew !== ai.lastChew) { ai.lastChew = chew; ctx.onEvent(d, 'bite'); } }
      if (f.amount <= 0) { f.amount = 0; f.eaters?.delete(d.index); ai.foodTarget = null; ctx.onEvent(d, 'finished'); }
    }
    if (d.stateTime > Dino.actionDuration(d.state)) {
      if (d.state === 'eat' && ai.foodTarget && ai.foodTarget.amount > 0) { d.stateTime = 0; ai.lastChew = -1; d.setState('idle'); d.setState('eat'); }
      else { d.setState('idle'); ai.waitUntil = ctx.time + 1 + Math.random() * 2; }
    }
    return;
  }

  if (sp.kind === 'land') {
    // choose a target
    if (following) {
      tmp.copy(ctx.player);
      const dist = Math.hypot(tmp.x - pos.x, tmp.z - pos.z);
      const stop = 3 + sp.lengthM * 0.45;
      if (dist > stop + 1) { ai.target = tmp.clone(); }
      else { ai.target = null; }
      ai.foodTarget = null;
    } else {
      // herbivores (and hungry piscivores) go to food
      if (!ai.foodTarget && sp.diet !== 'carnivore') {
        let best: typeof ctx.foods[number] | null = null, bd = 120;
        for (const f of ctx.foods) {
          if (f.amount <= 0) continue;
          if (f.eaters && f.eaters.size >= 3 && !f.eaters.has(d.index)) continue;   // table is full
          const dd = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z); if (dd < bd) { bd = dd; best = f; }
        }
        if (best) {
          best.eaters ??= new Map();
          if (!best.eaters.has(d.index)) { const taken = new Set(best.eaters.values()); let slot = 0; while (taken.has(slot)) slot++; best.eaters.set(d.index, slot); }
          ai.foodTarget = best; ai.target = best.pos.clone();
        }
      }
      if (ai.foodTarget) {
        if (ai.foodTarget.amount <= 0) { ai.foodTarget.eaters?.delete(d.index); ai.foodTarget = null; ai.target = null; }
        else {
          // stand so the snout ends up over the pile: a point one snout-length short of the food, on our side
          const fp = ai.foodTarget.pos; const snout = snoutOf(d) * 0.92 + 0.6;
          // each eater gets its own side of the pile (slot angle), so they never stack on each other
          const slot = ai.foodTarget.eaters?.get(d.index) ?? 0;
          const base = Math.atan2(pos.x - fp.x, pos.z - fp.z);
          const ang = slot === 0 ? base : base + (slot === 1 ? 2.1 : -2.1);
          const sx = fp.x + Math.sin(ang) * snout, sz = fp.z + Math.cos(ang) * snout;
          const here = Math.hypot(sx - pos.x, sz - pos.z);
          if (here < 0.45) {
            // final alignment: pivot until the head points at the food, then eat
            const err = Math.abs(headingError(d, fp.x, fp.z));
            d.speed = 0;
            if (err > 0.12) { turnToward(d, fp.x, fp.z, dt, pivotRate(sp.lengthM)); d.setState('idle'); return; }
            ai.lastChew = -1; d.setState('eat'); ctx.onEvent(d, 'eat'); return;
          }
          driveToward(d, sx, sz, dt, sp.speed * d.scale, 0.3);
          return;
        }
      } else if (!ai.target && ctx.time > ai.waitUntil) {
        const spot = findSpot(landOk, ai.home.x, ai.home.z, 45 + sp.lengthM * 2, Math.random, 12);
        if (spot) ai.target = spot; else ai.waitUntil = ctx.time + 2;
      }
      // occasional friendly hello when the player is near
      if (ctx.time > ai.nextRoar && Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z) < 40) {
        ai.nextRoar = ctx.time + 25 + Math.random() * 40; d.setState('roar'); ctx.onEvent(d, 'roar'); return;
      }
    }
    if (ai.target) {
      const stop = 1.2 + sp.lengthM * 0.1;
      const maxSpeed = sp.speed * (following ? 1.5 : 1) * d.scale;
      const dist = driveToward(d, ai.target.x, ai.target.z, dt, maxSpeed, stop);
      if (ai.waitUntil === Infinity) { ai.waitUntil = ctx.time + 1; }     // blocked by terrain/water
      else if (dist <= stop && d.speed === 0) { ai.target = null; ai.waitUntil = ctx.time + 2 + Math.random() * 5; }
    } else {
      d.speed = Math.max(0, d.speed - sp.speed * dt * 3); if (d.speed < 0.05) d.speed = 0;
      d.setState(d.speed > 0.05 ? 'walk' : 'idle');
    }
  } else if (sp.kind === 'air') {
    // circle around home (or the player when following)
    const center = following ? ctx.player : ai.home;
    const r = following ? 18 : ai.radius;
    const angSpeed = (sp.speed * d.scale) / r;
    ai.angle += angSpeed * dt;
    const tx = center.x + Math.cos(ai.angle) * r, tz = center.z + Math.sin(ai.angle) * r;
    turnToward(d, tx, tz, dt, 3);
    d.speed = sp.speed * d.scale;
    pos.x += Math.sin(d.heading) * d.speed * dt; pos.z += Math.cos(d.heading) * d.speed * dt;
    const ground = Math.max(heightAt(pos.x, pos.z), 0);
    let targetY = ground + ai.altitude + Math.sin(ctx.time * 0.3 + d.index) * 6;
    if (d.state === 'flap' && d.stateTime < 3) {
      // swoop: dip towards the player then climb
      const t = d.stateTime / 3; targetY = ground + ai.altitude * (0.25 + 0.75 * Math.abs(Math.cos(t * Math.PI)));
      if (d.stateTime > 3 - dt) d.setState('fly');
    } else if (d.state === 'roar' && d.stateTime > 2.2) { d.setState('fly'); }
    else if (d.state === 'fly' && ctx.time > ai.glideUntil && Math.random() < dt * 0.1) { d.setState('idle'); ai.glideUntil = ctx.time + 4 + Math.random() * 4; }
    else if (d.state === 'idle' && ctx.time > ai.glideUntil) d.setState('fly');
    pos.y += (targetY - pos.y) * Math.min(1, dt * 1.2);
    if (following && Math.random() < dt * 0.02) ai.altitude = 12 + Math.random() * 10; else if (!following && ai.altitude < 20 && Math.random() < dt * 0.1) ai.altitude = 25 + Math.random() * 30;
  } else {
    // water: patrol between random deep spots; breach on request
    const minDepth = Math.max(1.2, sp.heightM * 0.6);
    if (ai.breachAt >= 0 && ctx.time > ai.breachAt) { ai.breachAt = -1; ai.breachT = 0; d.setState('roar'); ctx.onEvent(d, 'splash'); }
    if (ai.breachT >= 0) { ai.breachT += dt; if (ai.breachT > 1.6) { ai.breachT = -1; d.setState('swim'); } }
    if (d.state === 'roar' && d.stateTime > 2.2 && ai.breachT < 0) d.setState('swim');
    if (following) {
      const dist = Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z);
      if (dist > 10 + sp.lengthM * 0.6) {
        // approach the player only through water
        const nx = pos.x + (ctx.player.x - pos.x) * 0.05, nz = pos.z + (ctx.player.z - pos.z) * 0.05;
        if (waterOk(nx, nz, minDepth)) ai.target = new THREE.Vector3(nx, 0, nz);
      } else ai.target = null;
    }
    if (!ai.target && ctx.time > ai.waitUntil) {
      const spot = findSpot((x, z) => waterOk(x, z, minDepth), ai.home.x, ai.home.z, 70 + sp.lengthM * 2, Math.random, 20);
      if (spot) ai.target = spot; else ai.waitUntil = ctx.time + 2;
    }
    if (ai.target) {
      const dist = Math.hypot(ai.target.x - pos.x, ai.target.z - pos.z);
      if (dist < 3) { ai.target = null; ai.waitUntil = ctx.time + 1 + Math.random() * 3; d.speed *= 0.5; }
      else {
        turnToward(d, ai.target.x, ai.target.z, dt, 0.8);
        d.speed += (sp.speed * d.scale - d.speed) * Math.min(1, dt);
        const nx = pos.x + Math.sin(d.heading) * d.speed * dt, nz = pos.z + Math.cos(d.heading) * d.speed * dt;
        if (waterOk(nx, nz, minDepth * 0.8)) { pos.x = nx; pos.z = nz; } else { ai.target = null; d.speed = 0; }
        if (d.state === 'idle') d.setState('swim');
      }
    } else { d.speed = Math.max(0, d.speed - dt); if (d.state === 'swim' && d.speed < 0.1 && ai.breachT < 0) d.setState('idle'); }
  }
}

/** The second (per-species) action after a repeated tap. */
export function secondAction(d: Dino): DinoState {
  const sp = d.species;
  if (sp.kind === 'air') return 'flap';
  if (sp.kind === 'water') return 'splash';
  if (sp.voice === 'bigTheropod') return 'stomp';
  if (sp.voice === 'raptor' || sp.voice === 'chirp') return 'sniff';
  return 'eat';
}

/** Trigger an action from a tap (returns the resulting state). */
export function triggerAction(d: Dino, action: DinoState, ctx: DinoContext): DinoState {
  if (d.species.kind === 'water' && action === 'splash') { d.ai.breachT = 0; d.setState('roar'); ctx.onEvent(d, 'splash'); return 'splash'; }
  if (d.species.kind === 'water' && action === 'roar') { d.setState('roar'); ctx.onEvent(d, 'roar'); return 'roar'; }
  if (d.species.kind === 'air') { d.setState(action === 'flap' ? 'flap' : 'roar'); ctx.onEvent(d, action === 'flap' ? 'flap' : 'roar'); return d.state; }
  d.ai.target = null; d.ai.foodTarget = null; d.speed = 0;
  d.setState('idle'); d.setState(action);
  ctx.onEvent(d, action as 'roar' | 'eat' | 'stomp' | 'sniff');
  return action;
}

/** Turn to face the player (used on tap). */
export function facePlayer(d: Dino, player: THREE.Vector3): void {
  if (d.species.kind !== 'land') return;
  d.heading = Math.atan2(player.x - d.root.position.x, player.z - d.root.position.z);
}
