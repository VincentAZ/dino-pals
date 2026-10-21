// Behaviours: wander, follow the player, go to food, flyers circle, swimmers patrol.
// Land movement (steering, avoidance, turning) lives in ai_land.ts; legs in locomotion.ts.
import * as THREE from 'three';
import { Dino, type DinoContext, type DinoState, type Food } from './dino.ts';
import { heightAt, waterAt } from '../world/heightmap.ts';
import { HALF } from '../world/biomes.ts';
import { brake, travel, freeSpot, headingError, pivotToward, resolveOverlaps, bodyOf } from './ai_land.ts';

function turnToward(d: Dino, tx: number, tz: number, dt: number, rate: number): number {
  const diff = headingError(d, tx, tz);
  d.heading += THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
  return Math.abs(diff);
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

/** Where a dinosaur stands to eat from a pile: one "eat reach" from the food, on its slot's side. */
export function eatStand(d: Dino, f: Food, player: THREE.Vector3, slot: number, out: THREE.Vector3): THREE.Vector3 {
  // slot 0 faces the child across the pile, slots 1/2 to either side (±75°)
  const away = Math.atan2(f.pos.x - player.x, f.pos.z - player.z);
  const ang = away + (slot === 0 ? 0 : slot === 1 ? 1.3 : -1.3);
  const reach = d.eatReach + f.radius * 0.35;
  return out.set(f.pos.x + Math.sin(ang) * reach, 0, f.pos.z + Math.cos(ang) * reach);
}

const standTmp = new THREE.Vector3();

export function updateAI(d: Dino, dt: number, ctx: DinoContext): void {
  const sp = d.species; const ai = d.ai; const pos = d.root.position;
  const following = ctx.time < ai.followUntil;

  if (sp.kind === 'land') {
    updateLook(d, ctx);
    if (d.loco && d.state !== 'eat') d.loco.reachWeight = 0;
    // one-shot actions block walking, but the body may still turn toward the child (stepping)
    if (d.isBusy) {
      if (ai.faceTarget && ctx.time < ai.faceUntil) { if (pivotToward(d, ai.faceTarget.x, ai.faceTarget.z, dt) < 0.08) ai.faceTarget = null; }
      else { d.speed = 0; ai.yawVel *= 0.8; d.heading += ai.yawVel * dt; }
      if (d.state === 'eat') eatTick(d, dt, ctx);
      if (d.stateTime > Dino.actionDuration(d.state)) {
        if (d.state === 'eat' && ai.foodTarget && ai.foodTarget.amount > 0 && atStand(d, ctx)) { ai.lastChew = -1; d.setState('idle'); d.setState('eat'); }
        else { d.setState('idle'); ai.waitUntil = ctx.time + 1 + Math.random() * 2; }
      }
      resolveOverlaps(d, ctx);
      return;
    }
    if (ai.faceTarget && ctx.time < ai.faceUntil) {
      if (pivotToward(d, ai.faceTarget.x, ai.faceTarget.z, dt) < 0.08) ai.faceTarget = null;
      d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle');
      resolveOverlaps(d, ctx);
      return;
    }
    if (ai.scripted) {
      if (ai.target) { const dist = travel(d, ctx, ai.target.x, ai.target.z, dt, sp.speed, 0.6); if (dist <= 0.6 && d.speed === 0) ai.target = null; }
      else brake(d, dt);
      resolveOverlaps(d, ctx);
      return;
    }
    if (following) {
      const dist = Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z);
      const stop = 3 + bodyOf(d).front + 2;
      ai.foodTarget = null;
      if (dist > stop + 1.5) travel(d, ctx, ctx.player.x, ctx.player.z, dt, d.species.speed * 1.5, stop);
      else if (Math.abs(headingError(d, ctx.player.x, ctx.player.z)) > 0.5) { pivotToward(d, ctx.player.x, ctx.player.z, dt); d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); }
      else brake(d, dt);
      resolveOverlaps(d, ctx);
      return;
    }
    // herbivores (and hungry piscivores) go to food
    if (!ai.foodTarget && sp.diet !== 'carnivore') {
      let best: Food | null = null, bd = 130;
      for (const f of ctx.foods) {
        if (f.amount <= 0) continue;
        if (f.eaters.size >= 3 && !f.eaters.has(d.index)) continue;   // the table is full
        const dd = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z); if (dd < bd) { bd = dd; best = f; }
      }
      if (best) {
        if (!best.eaters.has(d.index)) { const taken = new Set(best.eaters.values()); let slot = 0; while (taken.has(slot)) slot++; best.eaters.set(d.index, slot); }
        ai.foodTarget = best; ai.target = null; ai.bestDist = Infinity; ai.progressAt = ctx.time;
      }
    }
    if (ai.foodTarget) {
      const f = ai.foodTarget;
      if (f.amount <= 0) { f.eaters.delete(d.index); ai.foodTarget = null; }
      else {
        const slot = f.eaters.get(d.index) ?? 0;
        const stand = eatStand(d, f, ctx.player, slot, standTmp);
        const here = Math.hypot(stand.x - pos.x, stand.z - pos.z);
        if (here < 0.5) {
          // final alignment: face the pile, then eat
          if (pivotToward(d, f.pos.x, f.pos.z, dt) > 0.07 || Math.abs(ai.yawVel) > 0.08) { d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); resolveOverlaps(d, ctx); return; }
          ai.yawVel = 0; ai.lastChew = -1; d.setState('eat'); ctx.onEvent(d, 'eat'); return;
        }
        travel(d, ctx, stand.x, stand.z, dt, d.species.speed, 0.35);
        if (ctx.time - ai.progressAt > 6) {   // can't get to this side → try another slot / give up
          const taken = new Set(f.eaters.values()); let s2 = (slot + 1) % 3; let n = 0; while (taken.has(s2) && n++ < 3) s2 = (s2 + 1) % 3;
          if (n < 3) f.eaters.set(d.index, s2); else { f.eaters.delete(d.index); ai.foodTarget = null; }
          ai.bestDist = Infinity; ai.progressAt = ctx.time;
        }
        resolveOverlaps(d, ctx);
        return;
      }
    }
    if (!ai.target && ctx.time > ai.waitUntil) {
      const spot = freeSpot(d, ctx, ai.home.x, ai.home.z, 45 + sp.lengthM * 2, 16);
      if (spot) { ai.target = spot; ai.bestDist = Infinity; ai.progressAt = ctx.time; } else ai.waitUntil = ctx.time + 2;
    }
    // occasional friendly hello when the player is near
    if (!ai.scripted && ctx.time > ai.nextRoar && Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z) < 40 && d.speed < 0.2) {
      ai.nextRoar = ctx.time + 25 + Math.random() * 40; d.setState('roar'); ctx.onEvent(d, 'roar'); return;
    }
    if (ai.target) {
      const stop = 1.5 + sp.lengthM * 0.08;
      const dist = travel(d, ctx, ai.target.x, ai.target.z, dt, sp.speed, stop);
      if (dist <= stop && d.speed === 0) { ai.target = null; ai.waitUntil = ctx.time + 2 + Math.random() * 6; }
      else if (ctx.time - ai.progressAt > 5 || ai.blocked > 1.5) { ai.target = null; ai.blocked = 0; ai.waitUntil = ctx.time + 0.5; }
    } else brake(d, dt);
    resolveOverlaps(d, ctx);
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

/** Is the dinosaur at its eating spot (so another bite loop makes sense)? */
function atStand(d: Dino, ctx: DinoContext): boolean {
  const f = d.ai.foodTarget; if (!f) return false;
  const s = eatStand(d, f, ctx.player, f.eaters.get(d.index) ?? 0, standTmp);
  return Math.hypot(s.x - d.root.position.x, s.z - d.root.position.z) < 1.2;
}

/** Eating: the head goes down to one chosen item (neck IK), takes it at the lowest point, then chews. */
function eatTick(d: Dino, dt: number, ctx: DinoContext): void {
  const ai = d.ai; const f = ai.foodTarget;
  const loco = d.loco;
  if (!f) { if (loco) loco.reachWeight = 0; return; }
  const ph = d.clipPhase;
  if (ph < 0.05) { ai.bitten = false; ai.biteItem = null; }
  if (!ai.biteItem || ai.biteItem.eaten) {
    // the item closest to where the snout comes down
    const s = Math.sin(d.heading), c = Math.cos(d.heading), r = d.eatReach;
    const nx = d.root.position.x + s * r, nz = d.root.position.z + c * r;
    let best = null as typeof ai.biteItem, bd = Infinity;
    for (const it of f.items) { if (it.eaten) continue; const dd = Math.hypot(it.pos.x - nx, it.pos.z - nz) - it.pos.y * 0.3; if (dd < bd) { bd = dd; best = it; } }
    ai.biteItem = best;
  }
  if (loco) {
    const k = ph < 0.3 ? smooth(ph / 0.3) : ph > 0.7 ? 1 - smooth((ph - 0.7) / 0.3) : 1;
    if (ai.biteItem) { loco.reachTarget = ai.biteItem.pos; loco.reachWeight = (ai.bitten ? 0.5 : 1) * k; }
    else loco.reachWeight = 0;
  }
  if (!ai.bitten && ph >= 0.48) {
    ai.bitten = true;
    if (f.items.length) ctx.onEvent(d, 'bite', ai.biteItem ?? undefined);
    else { f.amount -= 0.12; ctx.onEvent(d, 'bite'); }
    ai.biteItem = null;
  }
  if (f.amount <= 0) { f.amount = 0; f.eaters.delete(d.index); ai.foodTarget = null; if (loco) loco.reachWeight = 0; ctx.onEvent(d, 'finished'); }
  void dt;
}
function smooth(x: number): number { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

/** Head tracking: look at the child when near, glance around otherwise; never while eating. */
function updateLook(d: Dino, ctx: DinoContext): void {
  const loco = d.loco; if (!loco) return;
  const ai = d.ai; const pos = d.root.position;
  const dist = Math.hypot(ctx.eye.x - pos.x, ctx.eye.z - pos.z);
  if (d.state === 'eat' || d.state === 'sniff') { loco.lookWeight = 0; return; }
  if (dist < 32) { loco.lookTarget = ctx.eye; loco.lookWeight = d.state === 'roar' ? 0.7 : 1; return; }
  if (ctx.time > ai.glanceUntil) {
    ai.glanceUntil = ctx.time + 3 + Math.random() * 5;
    if (Math.random() < 0.6) {
      const a = d.heading + (Math.random() - 0.5) * 2.2, r = 8 + Math.random() * 20;
      ai.glance.set(pos.x + Math.sin(a) * r, pos.y + d.species.heightM * (0.3 + Math.random() * 0.5), pos.z + Math.cos(a) * r);
      ai.glancing = true;
    } else ai.glancing = false;
  }
  loco.lookTarget = ai.glancing ? ai.glance : null; loco.lookWeight = 0.8;
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
  d.ai.target = null;
  if (d.ai.foodTarget) { d.ai.foodTarget.eaters.delete(d.index); d.ai.foodTarget = null; }
  d.speed = 0;
  d.setState('idle'); d.setState(action);
  ctx.onEvent(d, action as 'roar' | 'eat' | 'stomp' | 'sniff');
  return action;
}

/** Turn (by stepping) to face the player — used on tap and hold. */
export function facePlayer(d: Dino, player: THREE.Vector3, time: number): void {
  if (d.species.kind !== 'land') return;
  d.ai.faceTarget = player.clone(); d.ai.faceUntil = time + 5;
}
