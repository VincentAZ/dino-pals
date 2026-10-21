// Behaviours: wander, follow the player, go to food, flyers circle, swimmers patrol.
// Land movement (steering, avoidance, turning) lives in ai_land.ts; legs in locomotion.ts.
import * as THREE from 'three';
import { Dino, type DinoContext, type DinoState, type Food, type FoodItem } from './dino.ts';
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

/** Where a dinosaur stands to eat from a pile: one "eat reach" back from the outermost uneaten item
 *  on its own side (slot 0 faces the child across the pile, slots 1/2 to either side). */
export function eatStand(d: Dino, f: Food, player: THREE.Vector3, slot: number, out: THREE.Vector3): THREE.Vector3 {
  const away = Math.atan2(f.pos.x - player.x, f.pos.z - player.z);
  const ang = away + (slot === 0 ? 0 : slot === 1 ? 1.3 : -1.3);
  const dx = Math.sin(ang), dz = Math.cos(ang);
  let px = f.pos.x, pz = f.pos.z, best = -Infinity;
  for (const it of f.items) {
    if (it.eaten) continue;
    const proj = (it.pos.x - f.pos.x) * dx + (it.pos.z - f.pos.z) * dz;
    if (proj > best) { best = proj; px = it.pos.x; pz = it.pos.z; }
  }
  return out.set(px + dx * d.eatReach, 0, pz + dz * d.eatReach);
}


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
      if (d.stateTime > d.busyFor(d.state)) {
        if (d.state === 'eat' && ai.foodTarget && ai.foodTarget.amount > 0 && ai.biteItem && !ai.biteItem.eaten) { ai.lastChew = -1; ai.bitten = false; d.replay(); }
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
        if (f.eaters.size >= 2 && !f.eaters.has(d.index)) continue;   // two at a time; others wait their turn
        const dd = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z); if (dd < bd) { bd = dd; best = f; }
      }
      if (!best) {
        // a full pile nearby: come over, wait a few metres away and watch the others eat
        let full: Food | null = null, fd = 60;
        for (const f of ctx.foods) { if (f.amount <= 0) continue; const dd = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z); if (dd < fd) { fd = dd; full = f; } }
        if (full) {
          const r = full.radius + d.eatReach + bodyOf(d).front + 2.5;
          if (!ai.target && Math.hypot(full.pos.x - pos.x, full.pos.z - pos.z) > r + 2) {
            const a = Math.atan2(pos.x - full.pos.x, pos.z - full.pos.z);
            ai.target = new THREE.Vector3(full.pos.x + Math.sin(a) * r, 0, full.pos.z + Math.cos(a) * r); ai.bestDist = Infinity; ai.progressAt = ctx.time;
          }
          if (d.loco) { d.loco.lookTarget = full.pos; d.loco.lookWeight = 0.9; }
          ai.waitUntil = Math.max(ai.waitUntil, ctx.time + 1);
        }
      }
      if (best) {
        if (!best.eaters.has(d.index)) { const taken = new Set(best.eaters.values()); let slot = 0; while (taken.has(slot)) slot++; best.eaters.set(d.index, slot); }
        ai.foodTarget = best; ai.target = null; ai.bestDist = Infinity; ai.progressAt = ctx.time; ai.standAt = null; ai.standItem = null; ai.repositions = 0;
      }
    }
    if (ai.foodTarget) {
      const f = ai.foodTarget;
      if (f.amount <= 0 || !f.items.some((it) => !it.eaten)) { f.eaters.delete(d.index); ai.foodTarget = null; ai.standAt = null; ai.standItem = null; }
      else {
        // commit to one item: the outermost one on our side first, afterwards the one nearest our snout
        if (!ai.standItem || ai.standItem.eaten) {
          ai.standItem = ai.standAt ? nearestTo(f, snoutLanding(d, landTmp)) : outermost(f, slotDir(d, f, ctx.player));
          ai.standAt = null;
        }
        const item = ai.standItem!;
        if (!ai.standAt) {
          // stand one eat-reach back from the item, on the side we approach from
          let dx = d.root.position.x - item.pos.x, dz = d.root.position.z - item.pos.z;
          if (!ai.repositions) { const sd = slotDir(d, f, ctx.player); dx = sd.x; dz = sd.z; }
          const L = Math.hypot(dx, dz) || 1;
          ai.standAt = new THREE.Vector3(item.pos.x + dx / L * d.reachNow, 0, item.pos.z + dz / L * d.reachNow);
          ai.standOk = null;
        }
        const here = Math.hypot(ai.standAt.x - pos.x, ai.standAt.z - pos.z);
        const tol = ai.repositions ? 0.1 : 0.45;
        if (here < tol || (ai.repositions > 0 && here < 0.8 && ctx.time - ai.progressAt > 1.5)) {
          if (here < tol && ai.standOk !== false) ai.standOk = true;
          // final alignment: face the item, then eat it
          if (pivotToward(d, item.pos.x, item.pos.z, dt) > 0.06 || Math.abs(ai.yawVel) > 0.08) { d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); resolveOverlaps(d, ctx); return; }
          ai.yawVel = 0; ai.lastChew = -1; ai.bitten = false; ai.biteItem = item; d.setState('eat'); ctx.onEvent(d, 'eat'); return;
        }
        if (here < (ai.repositions ? 1.5 : 1.6)) {
          // shuffle: a slow direct step or two while keeping the head on the item
          const v = Math.min(0.55, Math.max(0.2, here * 0.8)) * (d.species.lengthM > 8 ? 0.8 : 1);
          const k = Math.min(1, (v * dt) / here);
          pos.x += (ai.standAt.x - pos.x) * k; pos.z += (ai.standAt.z - pos.z) * k;
          pivotToward(d, item.pos.x, item.pos.z, dt);
          d.speed = v; d.setState('walk');
          if (here < ai.bestDist - 0.03) { ai.bestDist = here; ai.progressAt = ctx.time; }
          if (ctx.time - ai.progressAt > 1.5) {
            // blocked (by a neighbour): eat from where we stand — the item nearest to our snout
            const near = nearestTo(f, snoutLanding(d, landTmp));
            if (near) { ai.standItem = near; ai.standAt.copy(pos); ai.standOk = false; ai.bestDist = Infinity; ai.progressAt = ctx.time; }
          }
          resolveOverlaps(d, ctx);
          return;
        }
        const far = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z);
        if (d.loco) { d.loco.lookTarget = f.pos; d.loco.lookWeight = 1; }
        travel(d, ctx, ai.standAt.x, ai.standAt.z, dt, d.species.speed * d.scale * (ai.repositions ? 0.6 : far > 10 + bodyOf(d).front ? 2.2 : 1), 0.3);
        if (ctx.time - ai.progressAt > 6) {   // can't get there: try another side / give up
          const taken = new Set(f.eaters.values()); const slot = f.eaters.get(d.index) ?? 0; let s2 = (slot + 1) % 3; let n = 0; while (taken.has(s2) && n++ < 3) s2 = (s2 + 1) % 3;
          if (n < 3) f.eaters.set(d.index, s2); else { f.eaters.delete(d.index); ai.foodTarget = null; }
          ai.standAt = null; ai.standItem = null; ai.repositions = 0; ai.bestDist = Infinity; ai.progressAt = ctx.time;
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

const aimTmp = new THREE.Vector3();
const landTmp = new THREE.Vector3();
/** Unit vector from the pile toward this dinosaur's slot (0 = across from the child, 1/2 = sides). */
function slotDir(d: Dino, f: Food, player: THREE.Vector3): THREE.Vector3 {
  const away = Math.atan2(f.pos.x - player.x, f.pos.z - player.z);
  const slot = f.eaters.get(d.index) ?? 0;
  // both places on the far side of the pile (facing the child), 110° apart so big bodies don't collide
  const ang = away + (slot === 0 ? -0.95 : slot === 1 ? 0.95 : Math.PI);
  return aimTmp.set(Math.sin(ang), 0, Math.cos(ang));
}
function outermost(f: Food, dir: THREE.Vector3): FoodItem | null {
  let best: FoodItem | null = null, bp = -Infinity;
  for (const it of f.items) { if (it.eaten) continue; const p = (it.pos.x - f.pos.x) * dir.x + (it.pos.z - f.pos.z) * dir.z; if (p > bp) { bp = p; best = it; } }
  return best;
}
function nearestTo(f: Food, p: THREE.Vector3): FoodItem | null {
  let best: FoodItem | null = null, bd = Infinity;
  for (const it of f.items) { if (it.eaten) continue; const dd = Math.hypot(it.pos.x - p.x, it.pos.z - p.z); if (dd < bd) { bd = dd; best = it; } }
  return best;
}
/** Where the snout comes down when eating from the current stance. */
function snoutLanding(d: Dino, out: THREE.Vector3): THREE.Vector3 {
  return out.set(d.root.position.x + Math.sin(d.heading) * d.reachNow, 0, d.root.position.z + Math.cos(d.heading) * d.reachNow);
}
/** Eating: the head goes down to the committed item (neck IK), the jaw snaps shut on it, the head
 *  lifts and the dinosaur chews where the child can see it. Clip phases: down 0–0.30, bite 0.30–0.42,
 *  lift 0.42–0.62, chew 0.62–1. Between bites it shuffles closer when the next item is out of reach. */
function eatTick(d: Dino, dt: number, ctx: DinoContext): void {
  const ai = d.ai; const f = ai.foodTarget;
  const loco = d.loco;
  if (!f) { if (loco) loco.reachWeight = 0; return; }
  const ph = d.clipPhase;
  if (ph < 0.05 && ai.bitten) { ai.bitten = false; ai.lastChew = -1; }
  if (!ai.bitten && (!ai.biteItem || ai.biteItem.eaten)) {
    // the committed item was taken by somebody else: the nearest one under our snout, or step closer
    const next = nearestTo(f, snoutLanding(d, landTmp));
    if (next && ph < 0.15 && Math.hypot(next.pos.x - landTmp.x, next.pos.z - landTmp.z) > Math.max(0.2, 0.025 * d.species.lengthM * d.scale)) {
      ai.standItem = next; ai.standAt = null; ai.repositions++; ai.biteItem = null; ai.bestDist = Infinity; ai.progressAt = ctx.time;
      if (loco) loco.reachWeight = 0;
      d.setState('idle'); return;
    }
    ai.biteItem = next;
  }
  if (loco) {
    const k = ph < 0.08 ? 0 : ph < 0.28 ? smooth((ph - 0.08) / 0.2) : ph < 0.42 ? 1 : 1 - smooth((ph - 0.42) / 0.12);
    if (ai.biteItem && !ai.bitten) { loco.reachTarget = ai.biteItem.pos; loco.reachWeight = k; }
    else loco.reachWeight = Math.max(0, loco.reachWeight - dt * 4);
  }
  if (!ai.bitten && ph >= 0.38) {
    ai.bitten = true;
    if (ai.biteItem && ai.standOk) {
      // learn (only from bites taken at the planned spot): how far short or long did the snout come down?
      const sn = d.snoutPos(landTmp);
      const e = (ai.biteItem.pos.x - sn.x) * Math.sin(d.heading) + (ai.biteItem.pos.z - sn.z) * Math.cos(d.heading);
      d.eatTrim = THREE.MathUtils.clamp(d.eatTrim + 0.8 * e, -0.35 * d.eatReach, 0.35 * d.eatReach);
    }
    if (f.items.length) ctx.onEvent(d, 'bite', ai.biteItem ?? undefined);
    else { f.amount -= 0.12; ctx.onEvent(d, 'bite'); }
    ai.standItem = null; ai.biteItem = null;
  }
  if (ph > 0.62) {
    const chew = Math.floor((ph - 0.62) / 0.095);
    if (chew !== ai.lastChew && chew < 4) { ai.lastChew = chew; ctx.onEvent(d, 'chew'); }
  }
  if (ph > 0.92 && !ai.standItem && f.amount > 0) {
    // choose the next bite now, so the loop either continues in place or steps closer
    const next = nearestTo(f, snoutLanding(d, landTmp));
    if (next) {
      ai.standItem = next;
      if (Math.hypot(next.pos.x - landTmp.x, next.pos.z - landTmp.z) > Math.max(0.2, 0.025 * d.species.lengthM * d.scale)) { ai.standAt = null; ai.repositions++; ai.bestDist = Infinity; ai.progressAt = ctx.time; }
      else ai.biteItem = next;
    }
  }
  if (f.amount <= 0 && ph > 0.9) { f.amount = 0; f.eaters.delete(d.index); ai.foodTarget = null; ai.standAt = null; ai.standItem = null; if (loco) loco.reachWeight = 0; ctx.onEvent(d, 'finished'); }
}
function smooth(x: number): number { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

/** Head tracking: look at the child when near, glance around otherwise; never while eating. */
function updateLook(d: Dino, ctx: DinoContext): void {
  const loco = d.loco; if (!loco) return;
  const ai = d.ai; const pos = d.root.position;
  if (d.state === 'eat' || d.state === 'sniff') { loco.lookWeight = 0; return; }
  if (ai.foodTarget) return;     // the food branch aims the head while approaching
  const dist = Math.hypot(ctx.eye.x - pos.x, ctx.eye.z - pos.z);
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
  d.ai.standAt = null; d.ai.standItem = null;
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
