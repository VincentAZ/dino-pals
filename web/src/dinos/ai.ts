// Behaviours: wander, follow the player, go to food, flyers circle, swimmers patrol.
// Land movement (steering, avoidance, turning) lives in ai_land.ts; legs in locomotion.ts.
import * as THREE from 'three';
import { Dino, type DinoContext, type DinoState, type Food, type FoodItem } from './dino.ts';
import { heightAt, waterAt } from '../world/heightmap.ts';
import { HALF } from '../world/biomes.ts';
import { brake, travel, freeSpot, headingError, pivotToward, resolveOverlaps, bodyOf, coast, setAICtx, moveBlocked, landOk, bodyFree } from './ai_land.ts';

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
  setAICtx(ctx);
  const sp = d.species; const ai = d.ai; const pos = d.root.position;
  const following = ctx.time < ai.followUntil;

  if (sp.kind === 'land') {
    updateLook(d, ctx);
    if (d.loco && d.state !== 'eat') d.loco.reachWeight = 0;
    // one-shot actions block walking, but the body may still turn toward the child (stepping)
    if (d.isBusy) {
      if (ai.faceTarget && ctx.time < ai.faceUntil) { if (pivotToward(d, ai.faceTarget.x, ai.faceTarget.z, dt, ctx) < 0.08) ai.faceTarget = null; }
      else { coast(d, dt); ai.yawVel *= 0.8; d.heading += ai.yawVel * dt; }
      if (d.state === 'eat') eatTick(d, dt, ctx);
      if (d.stateTime > d.busyFor(d.state)) {
        if (d.state === 'eat' && ai.foodTarget && ai.foodTarget.amount > 0 && ai.biteItem && !ai.biteItem.eaten) { ai.lastChew = -1; ai.bitten = false; d.replay(); }
        else if (d.state === 'eat' && ai.sips > 1) { ai.sips--; ai.lastChew = -1; ai.bitten = false; d.replay(); }   // another sip
        else if (d.state === 'eat' && ai.sips === 1) { ai.sips = 0; ai.drinkAt = null; ai.drinkStand = null; ai.nextDrink = ctx.time + 90 + Math.random() * 120; d.setState('idle'); ai.waitUntil = ctx.time + 1 + Math.random() * 2; }
        else { d.setState('idle'); ai.waitUntil = ctx.time + 1 + Math.random() * 2; }
      }
      resolveOverlaps(d, ctx);
      return;
    }
    if (ai.faceTarget && ctx.time < ai.faceUntil) {
      if (pivotToward(d, ai.faceTarget.x, ai.faceTarget.z, dt, ctx) < 0.08) ai.faceTarget = null;
      d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle');
      resolveOverlaps(d, ctx);
      return;
    }
    // night: settle down and sleep (babies next to their parent); dawn: wake up with a big yawn
    if (d.state === 'sleep') {
      d.speed = 0; ai.yawVel = 0;
      if (d.loco) { d.loco.lookTarget = landTmp.set(pos.x + Math.sin(d.heading) * d.sizeM, pos.y - d.sizeM * 0.4, pos.z + Math.cos(d.heading) * d.sizeM); d.loco.lookWeight = 1; }
      if (ctx.night < 0.35 || ctx.time < ai.awakeUntil || following) { d.setState('idle'); if (!following) { d.setState('roar'); ctx.onEvent(d, 'yawn'); } return; }
      if (ctx.time > ai.snoreAt) { ai.snoreAt = ctx.time + 2.6 + Math.random() * 1.4; ctx.onEvent(d, 'snore'); }
      return;
    }
    const sleepy = ctx.night > 0.6 && ctx.time > ai.awakeUntil && !following && !ai.foodTarget && !ai.sniffFood && ctx.time > ai.approachUntil && !ai.scripted;
    if (sleepy && (!d.parent || d.parent.state === 'sleep')) {
      ai.target = null;
      if (d.speed < 0.05 && Math.abs(ai.yawVel) < 0.05) { d.setState('sleep'); ai.snoreAt = ctx.time + 1 + Math.random() * 3; return; }
      brake(d, dt); resolveOverlaps(d, ctx); return;
    }
    if (ai.scripted) {
      if (ai.target) { const dist = travel(d, ctx, ai.target.x, ai.target.z, dt, sp.speed, 0.6); if (dist <= 0.6 && d.speed === 0) ai.target = null; }
      else brake(d, dt);
      resolveOverlaps(d, ctx);
      return;
    }
    if (following) {
      // walk beside the child, a little ahead, on our side of the camera — so the child sees us coming along
      if (!ai.followSide) {
        const rx = ctx.view.z, rz = -ctx.view.x;    // camera right
        ai.followSide = ((pos.x - ctx.player.x) * rx + (pos.z - ctx.player.z) * rz) >= 0 ? 1 : -1;
      }
      const b = bodyOf(d);
      const side = ai.followSide * (3.5 + b.r + b.front * 0.3), ahead = 2 + b.front * 0.5;
      const gx = ctx.player.x + ctx.view.x * ahead + ctx.view.z * side, gz = ctx.player.z + ctx.view.z * ahead - ctx.view.x * side;
      ai.foodTarget = null;
      const dist = Math.hypot(gx - pos.x, gz - pos.z);
      if (dist > 2.5) travel(d, ctx, gx, gz, dt, d.species.speed * d.speedScale * (dist > 10 ? 2.2 : 1.2), 1.5);
      else if (Math.abs(headingError(d, ctx.eye.x, ctx.eye.z)) > 0.7) { pivotToward(d, ctx.eye.x, ctx.eye.z, dt, ctx); d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); }
      else brake(d, dt);
      resolveOverlaps(d, ctx);
      return;
    }
    if (ctx.time < ai.approachUntil) {
      // tapped from afar: come over to say hello, stop a friendly distance away, facing the child
      const b = bodyOf(d); const R = 6 + b.front + b.r;
      let dx = pos.x - ctx.player.x, dz = pos.z - ctx.player.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const gx = ctx.player.x + dx * R, gz = ctx.player.z + dz * R;
      if (L > R + 1.5) travel(d, ctx, gx, gz, dt, d.species.speed * d.speedScale * 1.3, 0.8);
      else {
        ai.approachUntil = 0; ai.faceTarget = ctx.eye.clone(); ai.faceUntil = ctx.time + 4; ai.waitUntil = ctx.time + 6 + Math.random() * 4;
        ai.target = null; brake(d, dt);
      }
      resolveOverlaps(d, ctx);
      return;
    }
    // babies stay at their parent's side (a little behind its shoulder); when the parent eats, so do they
    const par = d.parent;
    if (par && par.awake) {
      const pp = par.root.position, L = par.sizeM, side = d.index % 2 ? 1 : -1;
      const sx = Math.sin(par.heading), cx = Math.cos(par.heading);
      // stand outside the circle the parent's body sweeps when it turns in place
      const pb = bodyOf(par), mb = bodyOf(d); const back = L * 0.15;
      const sweep = Math.max(pb.front, pb.back) + pb.r + mb.r + 0.5;
      const lat = Math.max(L * 0.22 + 1.2, Math.sqrt(Math.max(0, sweep * sweep - back * back)));
      const ox = -sx * back + cx * side * lat, oz = -cx * back - sx * side * lat;
      // aim where the parent will be in a moment, so the baby sets off together with it
      const lead = par.speed > 0.15 ? 1.5 : 0;
      const gx = pp.x + ox + sx * par.speed * lead, gz = pp.z + oz + cx * par.speed * lead;
      const dist = Math.hypot(gx - pos.x, gz - pos.z);
      if (dist > (par.speed > 0.15 ? 0.6 : 2.2 + L * 0.05)) {
        travel(d, ctx, gx, gz, dt, Math.max(par.speed * 1.15, sp.speed * d.speedScale * (dist > 6 ? 2.4 : 1.2)), 0.5);
      } else if (par.state === 'eat' && Math.random() < dt * 0.6) {
        ai.lastChew = -1; coast(d, dt); d.setState('eat'); ctx.onEvent(d, 'graze'); return;
      } else if (Math.abs(headingError(d, pos.x + sx, pos.z + cx)) > 0.5 && par.speed < 0.1) {
        pivotToward(d, pos.x + sx * 5, pos.z + cx * 5, dt, ctx); d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle');
      } else brake(d, dt);
      // a baby answers when its parent calls
      if (par.state === 'roar' && par.stateTime < 0.1 && d.state !== 'roar') { ai.echoAt = ctx.time + 0.7 + Math.random() * 0.4; }
      if (ai.echoAt > 0 && ctx.time > ai.echoAt) { ai.echoAt = 0; d.setState('roar'); ctx.onEvent(d, 'roar'); return; }
      resolveOverlaps(d, ctx);
      return;
    }
    // grown-up herbivores graze now and then while idling
    if (sp.diet === 'herbivore' && !ai.target && !ai.foodTarget && d.speed < 0.05 && ctx.time > ai.waitUntil - 1 && Math.random() < dt * 0.05) {
      ai.lastChew = -1; coast(d, dt); d.setState('eat'); ctx.onEvent(d, 'graze'); return;
    }
    // carnivores are curious about the pile: walk over, sniff it, lose interest, wander off
    if (sp.diet === 'carnivore') {
      if (!ai.sniffFood) {
        for (const f of ctx.foods) if (f.amount > 0 && !ai.sniffed.has(f) && Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z) < 30) { ai.sniffFood = f; ai.bestDist = Infinity; ai.progressAt = ctx.time; break; }
      }
      const f = ai.sniffFood;
      if (f) {
        if (f.amount <= 0) { ai.sniffFood = null; }
        else {
          let dx = pos.x - f.pos.x, dz = pos.z - f.pos.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
          const R = d.reachNow + f.radius * 0.6;
          const sx = f.pos.x + dx * R, sz = f.pos.z + dz * R;
          const here = Math.hypot(sx - pos.x, sz - pos.z);
          if (here < 0.8 || ctx.time - ai.progressAt > 6) {
            if (pivotToward(d, f.pos.x, f.pos.z, dt, ctx) > 0.1) { d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); resolveOverlaps(d, ctx); return; }
            ai.sniffed.add(f); ai.sniffFood = null;
            d.setState('sniff'); ctx.onEvent(d, 'sniff');
            // afterwards: amble away from the pile
            ai.target = new THREE.Vector3(f.pos.x + dx * (R + 12 + Math.random() * 8), 0, f.pos.z + dz * (R + 12 + Math.random() * 8));
            ai.waitUntil = ctx.time + 1;
            return;
          }
          if (d.loco) { d.loco.lookTarget = f.pos; d.loco.lookWeight = 1; }
          travel(d, ctx, sx, sz, dt, d.species.speed * d.speedScale, 0.5);
          resolveOverlaps(d, ctx);
          return;
        }
      }
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
        // hysteresis: once arrived, stay arrived until well outside the tolerance (no step/turn flicker)
        if (here < tol || (ai.standOk === true && here < tol * 2.5 + 0.05) || (ai.repositions > 0 && here < 0.8 && ctx.time - ai.progressAt > 1.5)) {
          if (here < tol && ai.standOk !== false) ai.standOk = true;
          if (ai.shuffling) {   // let the last shuffle step settle out over a few frames
            ai.shuffleV.multiplyScalar(Math.max(0, 1 - dt * 9));
            const sx2 = pos.x + ai.shuffleV.x * dt, sz2 = pos.z + ai.shuffleV.z * dt;
            if (!moveBlocked(d, ctx, sx2, sz2)) { pos.x = sx2; pos.z = sz2; }
            if (ai.shuffleV.lengthSq() < 0.0004) ai.shuffling = false;
          }
          // final alignment: face the item, then eat it
          if (pivotToward(d, item.pos.x, item.pos.z, dt, ctx) > 0.06 || Math.abs(ai.yawVel) > 0.08) { d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle'); resolveOverlaps(d, ctx); return; }
          ai.yawVel = 0; ai.lastChew = -1; ai.bitten = false; ai.biteItem = item; d.setState('eat'); ctx.onEvent(d, 'eat'); return;
        }
        if (here < (ai.repositions ? 1.5 : 1.6)) {
          // shuffle: a slow direct step or two while keeping the head on the item
          // the shuffle has its own velocity: it starts from the walking velocity and steers toward the
          // stand point with limited acceleration (no direction or speed change in a single frame)
          const vt = Math.min(0.55, Math.max(0.2, here * 0.8)) * (d.species.lengthM > 8 ? 0.8 : 1);
          if (!ai.shuffling) { ai.shuffleV.set(Math.sin(d.heading) * d.speed, 0, Math.cos(d.heading) * d.speed); ai.shuffling = true; }
          const ux = (ai.standAt.x - pos.x) / here * vt - ai.shuffleV.x, uz = (ai.standAt.z - pos.z) / here * vt - ai.shuffleV.z;
          const ul = Math.hypot(ux, uz), amax = 2.0 * dt;
          if (ul > amax) { ai.shuffleV.x += ux / ul * amax; ai.shuffleV.z += uz / ul * amax; } else { ai.shuffleV.x += ux; ai.shuffleV.z += uz; }
          let stepX = ai.shuffleV.x * dt, stepZ = ai.shuffleV.z * dt; const sl = Math.hypot(stepX, stepZ);
          if (sl > here) { stepX *= here / sl; stepZ *= here / sl; }
          if (!moveBlocked(d, ctx, pos.x + stepX, pos.z + stepZ)) { pos.x += stepX; pos.z += stepZ; }
          else { ai.shuffleV.multiplyScalar(0.5); if (!moveBlocked(d, ctx, pos.x + stepX * 0.5, pos.z + stepZ * 0.5)) { pos.x += stepX * 0.5; pos.z += stepZ * 0.5; } }
          d.speed = 0; pivotToward(d, item.pos.x, item.pos.z, dt, ctx);   // turn only (the step above is the motion)
          d.speed = Math.hypot(ai.shuffleV.x, ai.shuffleV.z); d.setState('walk');
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
        travel(d, ctx, ai.standAt.x, ai.standAt.z, dt, d.species.speed * d.speedScale * (ai.repositions ? 0.6 : far > 10 + bodyOf(d).front ? 2.2 : 1), 0.3);
        if (ctx.time - ai.progressAt > 6) {   // can't get there: try another side / give up
          const taken = new Set(f.eaters.values()); const slot = f.eaters.get(d.index) ?? 0; let s2 = (slot + 1) % 3; let n = 0; while (taken.has(s2) && n++ < 3) s2 = (s2 + 1) % 3;
          if (n < 3) f.eaters.set(d.index, s2); else { f.eaters.delete(d.index); ai.foodTarget = null; }
          ai.standAt = null; ai.standItem = null; ai.repositions = 0; ai.bestDist = Infinity; ai.progressAt = ctx.time;
        }
        resolveOverlaps(d, ctx);
        return;
      }
    }
    // thirsty now and then: walk to the nearest shallow water edge, lower the head and drink a few sips
    if (!ai.target && !ai.drinkStand && ctx.time > ai.nextDrink && !ai.scripted) {
      const found = findWaterEdge(d, ctx);
      if (found) { ai.drinkAt = found[0]; ai.drinkStand = found[1]; ai.bestDist = Infinity; ai.progressAt = ctx.time; }
      else ai.nextDrink = ctx.time + 40 + Math.random() * 40;
    }
    if (ai.drinkStand && ai.drinkAt) {
      const here = Math.hypot(ai.drinkStand.x - pos.x, ai.drinkStand.z - pos.z);
      if (here > 0.7 && ctx.time - ai.progressAt < 12) {
        travel(d, ctx, ai.drinkStand.x, ai.drinkStand.z, dt, sp.speed * d.speedScale, 0.5);
      } else if (here > 0.7) { ai.drinkStand = null; ai.drinkAt = null; ai.nextDrink = ctx.time + 30; }   // can't get there
      else if (pivotToward(d, ai.drinkAt.x, ai.drinkAt.z, dt, ctx) > 0.08 || Math.abs(ai.yawVel) > 0.08) d.setState(Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle');
      else { ai.yawVel = 0; ai.sips = 2 + Math.floor(Math.random() * 3); ai.lastChew = -1; ai.bitten = false; coast(d, dt); d.setState('eat'); }
      resolveOverlaps(d, ctx);
      return;
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
    // circle around home (or the player when following); now and then a low pass around the child
    if (!following && ctx.time > ai.actionUntil + 70 + (d.index % 5) * 9 && Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z) < 150 && Math.random() < dt * 0.05) {
      ai.actionUntil = ctx.time + 15; ai.altitude = 9 + Math.random() * 5;
    }
    const flyby = ctx.time < ai.actionUntil;
    if (!flyby && !following && ai.altitude < 20 && ctx.time > ai.actionUntil && ctx.time < ai.actionUntil + 1) ai.altitude = 25 + Math.random() * 30;   // climb back up
    const center = following || flyby ? ctx.player : ai.home;
    const r = following ? 18 : flyby ? 16 : ai.radius;
    const angSpeed = (sp.speed * d.speedScale) / r;
    ai.angle += angSpeed * dt;
    const tx = center.x + Math.cos(ai.angle) * r, tz = center.z + Math.sin(ai.angle) * r;
    turnToward(d, tx, tz, dt, 3);
    d.speed = sp.speed * d.speedScale;
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
    if (following && Math.random() < dt * 0.02) ai.altitude = 12 + Math.random() * 10; else if (!following && !flyby && ai.altitude < 20 && Math.random() < dt * 0.1) ai.altitude = 25 + Math.random() * 30;
  } else {
    // water: patrol between random deep spots; breach on request
    const minDepth = Math.max(1.2, sp.heightM * d.scale * 1.05);   // deep enough for the whole body below the surface
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
        d.speed += (sp.speed * d.speedScale - d.speed) * Math.min(1, dt);
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
  if (!f) {
    if (loco) loco.reachWeight = 0;
    const ph = d.clipPhase;
    if (ph < 0.05) ai.bitten = false;
    if (!ai.bitten && ph >= 0.38) { ai.bitten = true; ctx.onEvent(d, ai.sips > 0 ? 'drink' : 'graze'); }
    if (ph > 0.62 && ai.sips === 0) { const chew = Math.floor((ph - 0.62) / 0.095); if (chew !== ai.lastChew && chew < 3) { ai.lastChew = chew; ctx.onEvent(d, 'chew'); } }
    return;
  }
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
  if (ai.foodTarget || ai.sniffFood) return;     // the food branches aim the head while approaching
  const dist = Math.hypot(ctx.eye.x - pos.x, ctx.eye.z - pos.z);
  if (dist < 32) {
    // near the child: mostly watch them, but glance around and down now and then like a real animal
    // (a fixed stare reads as a statue); just after a tap or while turning to the child, keep watching
    const attentive = !!ai.faceTarget || ctx.time < ai.awakeUntil - 38 || ctx.time < ai.followUntil;
    if (ctx.time > ai.glanceUntil) {
      ai.glanceUntil = ctx.time + 2 + Math.random() * 3.5;
      const r = Math.random();
      if (r < (dist < 10 ? 0.65 : 0.5)) ai.glancing = false;
      else {
        const down = r > 0.86, a = d.heading + (Math.random() - 0.5) * (down ? 0.8 : 2.2), rr = down ? 2 + Math.random() * 2 : 7 + Math.random() * 15;
        ai.glance.set(pos.x + Math.sin(a) * rr, pos.y + (down ? 0.1 : d.species.heightM * (0.3 + Math.random() * 0.5)), pos.z + Math.cos(a) * rr);
        ai.glancing = true;
      }
    }
    loco.lookTarget = ai.glancing && !attentive ? ai.glance : ctx.eye; loco.lookWeight = d.state === 'roar' ? 0.7 : 1;
    return;
  }
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

/**
 * The nearest shallow water edge within 60 m: returns [where the snout drinks, where to stand], or null.
 * The stand point is one neck-reach back from the water, on walkable ground, facing the water.
 */
function findWaterEdge(d: Dino, ctx: DinoContext): [THREE.Vector3, THREE.Vector3] | null {
  const pos = d.root.position; const reach = Math.max(0.8, d.reachNow);
  let best: [THREE.Vector3, THREE.Vector3] | null = null, bd = Infinity;
  for (let r = 6; r <= 60 && !best; r += 6) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2; const x = pos.x + Math.sin(a) * r, z = pos.z + Math.cos(a) * r;
      const w = waterAt(x, z); if (w.kind === 'none' || w.kind === 'sea') continue;
      const depth = w.level - heightAt(x, z); if (depth < 0.02 || depth > 0.3) continue;
      // step back toward the animal until dry, then one neck-reach further: the stand point
      let ex = x, ez = z; const ux = (pos.x - x) / r, uz = (pos.z - z) / r;
      for (let i = 0; i < 12; i++) { const wi = waterAt(ex, ez); if (wi.kind === 'none' || wi.level <= heightAt(ex, ez)) break; ex += ux * 0.5; ez += uz * 0.5; }
      const sx = ex + ux * reach * 0.9, sz = ez + uz * reach * 0.9;
      if (!landOk(sx, sz) || !bodyFree(d, ctx, sx, sz, Math.atan2(-ux, -uz), 0.6)) continue;
      const dd = Math.hypot(sx - pos.x, sz - pos.z);
      if (dd < bd) { bd = dd; best = [new THREE.Vector3(ex - ux * 0.3, 0, ez - uz * 0.3), new THREE.Vector3(sx, 0, sz)]; }
    }
  }
  return best;
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

/**
 * A tap on a dinosaur. Taps alternate its two actions (roar, then stomp / sniff / graze / flap / splash).
 * A tap that lands while a tapped action is still playing does not restart it (a toddler taps fast, and
 * restarting froze the clip on its first frame); it queues the next action, which starts when this one ends.
 */
export function tapAction(d: Dino, ctx: DinoContext): DinoState | 'queued' {
  const ai = d.ai;
  if (ctx.time - ai.lastTapAt > 10) ai.tapSeq = 0;
  ai.lastTapAt = ctx.time;
  const next: DinoState = ai.tapSeq % 2 === 0 ? 'roar' : secondAction(d);
  if (d.isBusy && ai.tapAct && d.stateTime < d.busyFor(d.state) * 0.75) { ai.queued = next; return 'queued'; }
  return runTap(d, next, ctx);
}
function runTap(d: Dino, action: DinoState, ctx: DinoContext): DinoState {
  d.ai.tapSeq++; d.ai.queued = null;
  d.ai.nextRoar = Math.max(d.ai.nextRoar, ctx.time + 20 + Math.random() * 20);   // no unprompted roar right after a tapped one
  const r = triggerAction(d, action, ctx);
  d.ai.tapAct = true;
  return r;
}
/** Every frame after updateAI: start a queued tap action once the current one has finished. */
export function runQueuedTap(d: Dino, ctx: DinoContext): void {
  if (d.isBusy) return;
  d.ai.tapAct = false;
  if (d.ai.queued && ctx.time - d.ai.lastTapAt > 6) d.ai.queued = null;   // a stale tap never fires late
  if (d.ai.queued) runTap(d, d.ai.queued, ctx);
}

/** Trigger an action from a tap (returns the resulting state). */
export function triggerAction(d: Dino, action: DinoState, ctx: DinoContext): DinoState {
  if (d.species.kind === 'water' && action === 'splash') { d.ai.breachT = 0; d.setState('roar'); ctx.onEvent(d, 'splash'); return 'splash'; }
  if (d.species.kind === 'water' && action === 'roar') { d.setState('roar'); ctx.onEvent(d, 'roar'); return 'roar'; }
  if (d.species.kind === 'air') { d.setState(action === 'flap' ? 'flap' : 'roar'); ctx.onEvent(d, action === 'flap' ? 'flap' : 'roar'); return d.state; }
  d.ai.target = null;
  if (d.ai.foodTarget) { d.ai.foodTarget.eaters.delete(d.index); d.ai.foodTarget = null; }
  d.ai.standAt = null; d.ai.standItem = null;
  d.ai.drinkAt = null; d.ai.drinkStand = null; d.ai.sips = 0;
  d.ai.awakeUntil = ctx.time + 45;
  d.setState('idle'); d.setState(action);   // keeps its speed: the busy branch coasts it to a halt
  ctx.onEvent(d, action as 'roar' | 'eat' | 'stomp' | 'sniff');
  // after saying hello from afar, come closer
  const far = Math.hypot(ctx.player.x - d.root.position.x, ctx.player.z - d.root.position.z);
  if (action === 'roar' && far > 14 + bodyOf(d).front) d.ai.approachUntil = ctx.time + 20;
  return action;
}

/** Turn (by stepping) to face the player — used on tap and hold. */
export function facePlayer(d: Dino, player: THREE.Vector3, time: number): void {
  if (d.species.kind !== 'land') return;
  d.ai.faceTarget = player.clone(); d.ai.faceUntil = time + 5;
}
