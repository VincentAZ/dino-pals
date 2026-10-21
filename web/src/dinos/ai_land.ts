// Land locomotion decisions: steering with obstacle avoidance, non-overlap constraints, turning that
// the feet can follow, and the "body capsule" every land dinosaur occupies.
import * as THREE from 'three';
import type { Dino, DinoContext } from './dino.ts';
import { heightAt, slopeAt, waterAt } from '../world/heightmap.ts';
import { HALF } from '../world/biomes.ts';
import type { Obstacle } from '../world/obstacles.ts';
import { planRoute } from './path.ts';

export interface Body { back: number; front: number; r: number; tall: boolean }

const bodies = new WeakMap<Dino, Body>();
/** Torso capsule along the heading: from `back` behind the root to `front` ahead of it, radius `r`. */
export function bodyOf(d: Dino): Body {
  let b = bodies.get(d);
  if (b) return b;
  const sp = d.species; const L = sp.lengthM * d.scale;
  const W = (sp.widthM ?? sp.lengthM * 0.22) * d.scale;
  const r = Math.max(0.3, d.loco ? Math.max(d.loco.bodyHalfWidth * 0.9, W * 0.32) : W * 0.38);
  b = { back: 0.2 * L, front: 0.24 * L, r, tall: (sp.heightM ?? 2) * d.scale > 2.6 };
  bodies.set(d, b);
  return b;
}
/** How much room an obstacle needs from this dinosaur's body axis. */
export function obstacleRadius(d: Dino, o: Obstacle): number {
  const b = bodyOf(d);
  // tall bodies keep out of low canopies too; short ones only avoid the trunk
  // canopies start roughly a third of the way up a tree; anything taller than that keeps its head out
  const head = (d.species.heightM ?? 2) * d.scale;
  const underCanopy = o.tree && head > 0.33 * o.h;
  return (underCanopy ? Math.max(o.r, o.canopy * (b.tall ? 0.75 : 0.55)) : o.r) + b.r;
}

export function landOk(x: number, z: number): boolean {
  if (Math.abs(x) > HALF - 20 || Math.abs(z) > HALF - 20) return false;
  const h = heightAt(x, z);
  if (h < 0.4) return false;
  if (waterAt(x, z).kind !== 'none') return false;
  return slopeAt(x, z, 2) < 0.55;
}

function closestOnSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out: { x: number; z: number; t: number }): void {
  const ex = bx - ax, ez = bz - az; const L2 = ex * ex + ez * ez;
  const t = L2 > 1e-9 ? THREE.MathUtils.clamp(((px - ax) * ex + (pz - az) * ez) / L2, 0, 1) : 0;
  out.x = ax + ex * t; out.z = az + ez * t; out.t = t;
}
/** Closest points between two segments (2D). Returns distance; fills p (on first) and q (on second). */
function segSeg(a0x: number, a0z: number, a1x: number, a1z: number, b0x: number, b0z: number, b1x: number, b1z: number,
  p: { x: number; z: number; t: number }, q: { x: number; z: number; t: number }): number {
  let best = Infinity; const tp = { x: 0, z: 0, t: 0 };
  const test = (px: number, pz: number, sx: number, sz: number, ex: number, ez: number, firstIsPoint: boolean) => {
    closestOnSeg(px, pz, sx, sz, ex, ez, tp);
    const dd = Math.hypot(px - tp.x, pz - tp.z);
    if (dd < best) {
      best = dd;
      if (firstIsPoint) { p.x = px; p.z = pz; q.x = tp.x; q.z = tp.z; } else { q.x = px; q.z = pz; p.x = tp.x; p.z = tp.z; }
    }
  };
  test(a0x, a0z, b0x, b0z, b1x, b1z, true); test(a1x, a1z, b0x, b0z, b1x, b1z, true);
  test(b0x, b0z, a0x, a0z, a1x, a1z, false); test(b1x, b1z, a0x, a0z, a1x, a1z, false);
  return best;
}

function capsule(d: Dino, x = d.root.position.x, z = d.root.position.z, h = d.heading, frontK = 1): [number, number, number, number] {
  const b = bodyOf(d); const s = Math.sin(h), c = Math.cos(h);
  return [x - s * b.back, z - c * b.back, x + s * b.front * frontK, z + c * b.front * frontK];
}
/** Two animals eating from the same pile may put their heads close together. */
function coEaters(a: Dino, b: Dino): boolean { return !!a.ai.foodTarget && a.ai.foodTarget === b.ai.foodTarget; }

const near: Obstacle[] = [];
const P = { x: 0, z: 0, t: 0 }, Q = { x: 0, z: 0, t: 0 };

/** Is the dinosaur's body free at (x,z) facing h (static obstacles + water + slope)? */
export function bodyFree(d: Dino, ctx: DinoContext, x: number, z: number, h: number, margin = 0.6): boolean {
  if (!landOk(x, z)) return false;
  const [ax, az, bx, bz] = capsule(d, x, z, h);
  if (!landOk(bx, bz) || !landOk(ax, az)) return false;
  const b = bodyOf(d);
  for (const o of ctx.obstacles.near(x, z, b.front + b.back + 6, near)) {
    closestOnSeg(o.x, o.z, ax, az, bx, bz, P);
    if (Math.hypot(o.x - P.x, o.z - P.z) < obstacleRadius(d, o) + margin) return false;
  }
  return true;
}

export function headingError(d: Dino, tx: number, tz: number): number {
  let diff = Math.atan2(tx - d.root.position.x, tz - d.root.position.z) - d.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** Turn in place toward a world point at the rate the feet can follow (with angular acceleration). */
export function pivotToward(d: Dino, tx: number, tz: number, dt: number): number {
  const err = headingError(d, tx, tz);
  const max = d.maxTurnRate;
  const want = THREE.MathUtils.clamp(err * 2.2, -max, max);
  const acc = d.species.lengthM > 8 ? 1.6 : 3.5;
  d.ai.yawVel += THREE.MathUtils.clamp(want - d.ai.yawVel, -acc * dt, acc * dt);
  if (Math.abs(err) < 0.02) d.ai.yawVel *= 0.5;
  d.heading += d.ai.yawVel * dt;
  d.speed = Math.max(0, d.speed - d.maxSpeed * dt * 2.5);
  return Math.abs(err);
}

/**
 * Steering toward (tx,tz): desired direction from the target, pushed sideways by obstacles on the
 * path and other dinosaurs; heading turns at a rate limited by speed (arcs) or pivots in place when
 * the goal is behind; speed ramps and brakes for turns, obstacles and arrival.
 * Returns the remaining distance.
 */
/** Time until two moving circles touch (0 if they already overlap, Infinity if never within reach). */
function ttc(px: number, pz: number, wx: number, wz: number, R: number): number {
  const c = px * px + pz * pz - R * R;
  const bb = px * wx + pz * wz;
  // already inside the margin: only moving closer counts as a collision (moving out is always allowed)
  if (c <= 0) return bb < -1e-6 ? 0 : Infinity;
  if (bb >= 0) return Infinity;
  const aa = wx * wx + wz * wz;
  const disc = bb * bb - aa * c;
  if (disc <= 0) return Infinity;
  return (-bb - Math.sqrt(disc)) / aa;
}

const HORIZON = 3;
const ANGLES = [0, -0.2, 0.2, -0.42, 0.42, -0.68, 0.68, -0.95, 0.95, -1.25, 1.25, -1.6, 1.6, -2.0, 2.0, -2.5, 2.5, Math.PI];
interface Circle { x: number; z: number; r: number; vx: number; vz: number; hard: boolean }
const circles: Circle[] = [];

/**
 * Sampled velocity obstacles: try directions around the goal direction at two speeds, predict the
 * time to the first contact with every nearby trunk/rock/dinosaur/explorer (each body is two circles
 * along its axis) and pick the cheapest safe option. Keeps a slight right-hand preference so two
 * animals meeting head-on pass instead of mirroring each other.
 */
function chooseVelocity(d: Dino, ctx: DinoContext, dx: number, dz: number, pref: number): { dir: number; speed: number } {
  const ai = d.ai; const pos = d.root.position; const b = bodyOf(d);
  const reachR = pref * HORIZON + b.front + b.back + 4;
  circles.length = 0;
  for (const o of ctx.obstacles.near(pos.x, pos.z, reachR, near)) circles.push({ x: o.x, z: o.z, r: obstacleRadius(d, o) - b.r + 0.4, vx: 0, vz: 0, hard: true });
  for (const e of ctx.others) {
    if (e === d || !e.awake || e.species.kind !== 'land') continue;
    const ep = e.root.position;
    if (Math.abs(ep.x - pos.x) > reachR + 20 || Math.abs(ep.z - pos.z) > reachR + 20) continue;
    const eb = bodyOf(e); const s = Math.sin(e.heading), c = Math.cos(e.heading);
    const moving = e.speed > 0.05 && !e.isBusy;
    const vx = moving ? s * e.speed : 0, vz = moving ? c * e.speed : 0;
    // lower-priority animals treat moving higher-priority ones as moving; the others only half
    const share = e.index < d.index || !moving ? 1 : 0.5;
    const fk = coEaters(d, e) ? 0.35 : 1;
    circles.push({ x: ep.x + s * eb.front * 0.55 * fk, z: ep.z + c * eb.front * 0.55 * fk, r: eb.r + 0.5, vx: vx * share, vz: vz * share, hard: false });
    circles.push({ x: ep.x - s * eb.back * 0.55, z: ep.z - c * eb.back * 0.55, r: eb.r + 0.5, vx: vx * share, vz: vz * share, hard: false });
  }
  for (const [ox, oz, rr] of ctx.keepClear) circles.push({ x: ox, z: oz, r: rr + 0.6, vx: 0, vz: 0, hard: true });
  const base = Math.atan2(dx, dz);
  let best = { dir: base, speed: 0 }, bestCost = Infinity;
  for (const a of ANGLES) {
    const dir = base + a; const s = Math.sin(dir), c = Math.cos(dir);
    for (const k of [1, 0.55]) {
      const sp = pref * k;
      const vx = s * sp, vz = c * sp;
      // our two body circles, oriented along the candidate direction
      const fx = pos.x + s * b.front * 0.55, fz = pos.z + c * b.front * 0.55;
      const bx = pos.x - s * b.back * 0.55, bz = pos.z - c * b.back * 0.55;
      let t = Infinity;
      for (const o of circles) {
        const R = o.r + b.r;
        const t1 = ttc(o.x - fx, o.z - fz, o.vx - vx, o.vz - vz, R);
        const t2 = ttc(o.x - bx, o.z - bz, o.vx - vx, o.vz - vz, R);
        const tt = Math.min(t1, t2);
        if (tt < t) t = tt;
        if (t === 0) break;
      }
      let turn = dir - d.heading; while (turn > Math.PI) turn -= Math.PI * 2; while (turn < -Math.PI) turn += Math.PI * 2;
      let cost = (1 - Math.cos(a)) * 1.2 + (1 - k) * 0.5 + Math.abs(turn) * 0.12 + (a > 0 ? 0.04 : 0) + Math.abs(a - ai.steerA) * 0.08;
      if (t < HORIZON) cost += 3 * (1 - t / HORIZON) * (1 - t / HORIZON) + (t < 0.6 ? 6 : 0);
      if (cost < bestCost) { bestCost = cost; best = { dir, speed: sp }; ai.steerPick = a; }
    }
  }
  // every option collides almost immediately: stand still and face the best way out
  if (bestCost > 6) best.speed = 0;
  ai.steerA = ai.steerPick;
  return best;
}

/**
 * Steering toward (tx,tz): velocity-obstacle choice of direction/speed (refreshed ~10×/s), heading
 * turned at a rate limited by speed (arcs) or pivoting in place when the goal is behind; speed ramps
 * and brakes for turns and arrival. Returns the remaining distance.
 */
export function drive(d: Dino, ctx: DinoContext, tx: number, tz: number, dt: number, maxSpeed: number, stopDist: number, through = false): number {
  const ai = d.ai; const pos = d.root.position; const b = bodyOf(d);
  maxSpeed = Math.min(maxSpeed, maxSpeed > d.species.speed * d.speedScale * 1.05 ? d.trotSpeed : d.maxSpeed);
  let dx = tx - pos.x, dz = tz - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= stopDist) { brake(d, dt); return dist; }
  dx /= dist; dz /= dist;
  // brake with a constant deceleration (v = √(2·a·d)), so the last metres aren't a crawl
  const decel = d.species.lengthM > 8 ? 0.7 : 1.2;
  const arrive = through ? 1 : THREE.MathUtils.clamp(Math.sqrt(2 * decel * Math.max(0, dist - stopDist)) / Math.max(0.2, maxSpeed), 0.15, 1);
  ai.steerT -= dt;
  if (ai.steerT <= 0) {
    ai.steerT = 0.1;
    const v = chooseVelocity(d, ctx, dx, dz, maxSpeed * arrive);
    ai.steerDir = v.dir; ai.steerSpeed = v.speed;
  }
  // ---- turning: arcs while walking, pivot in place when the goal is far off-axis
  let err = ai.steerDir - d.heading;
  while (err > Math.PI) err -= Math.PI * 2; while (err < -Math.PI) err += Math.PI * 2;
  const absErr = Math.abs(err);
  const turnR = Math.max(0.8, d.species.lengthM * d.scale * 0.32);
  const pivoting = absErr > 0.7 && d.speed < 0.35 * maxSpeed;
  const maxYaw = pivoting ? d.maxTurnRate : Math.min(d.maxTurnRate, Math.max(0.15, d.speed / turnR));
  const wantYaw = THREE.MathUtils.clamp(err * 2.0, -maxYaw, maxYaw);
  const angAcc = d.species.lengthM > 8 ? 1.4 : 3.2;
  ai.yawVel += THREE.MathUtils.clamp(wantYaw - ai.yawVel, -angAcc * dt, angAcc * dt);
  d.heading += ai.yawVel * dt;
  // ---- speed
  const turnSlow = pivoting ? 0 : absErr > 0.9 ? 0.3 : absErr > 0.45 ? 0.6 : 1;
  const want = Math.min(ai.steerSpeed, maxSpeed * Math.min(arrive, turnSlow));
  const accel = maxSpeed / (d.species.lengthM > 8 ? 1.8 : 1.0);
  d.speed += THREE.MathUtils.clamp(want - d.speed, -accel * 2.5 * dt, accel * dt);
  if (d.speed < 0.02 && want === 0) d.speed = 0;
  const nx = pos.x + Math.sin(d.heading) * d.speed * dt, nz = pos.z + Math.cos(d.heading) * d.speed * dt;
  if (landOk(nx, nz) && landOk(nx + Math.sin(d.heading) * b.front, nz + Math.cos(d.heading) * b.front)) { pos.x = nx; pos.z = nz; }
  else { d.speed = 0; ai.blocked += dt; }
  d.setState(d.speed > 0.05 || Math.abs(ai.yawVel) > 0.05 ? 'walk' : 'idle');
  // ---- progress watchdog
  if (dist < ai.bestDist - 0.5) { ai.bestDist = dist; ai.progressAt = ctx.time; }
  return dist;
}

export function brake(d: Dino, dt: number): void {
  d.speed = Math.max(0, d.speed - d.maxSpeed * dt * 2);
  d.ai.yawVel *= Math.max(0, 1 - dt * 4);
  d.heading += d.ai.yawVel * dt;
  d.setState(d.speed > 0.05 || Math.abs(d.ai.yawVel) > 0.05 ? 'walk' : 'idle');
}

/** Hard non-overlap constraint against trees/rocks and other dinosaurs (small positional fixes). */
export function resolveOverlaps(d: Dino, ctx: DinoContext): void {
  if (d.species.kind !== 'land') return;
  const pos = d.root.position; const b = bodyOf(d);
  for (let iter = 0; iter < 2; iter++) {
    const [ax, az, bx, bz] = capsule(d);
    for (const o of ctx.obstacles.near(pos.x, pos.z, b.front + b.back + 4, near)) {
      closestOnSeg(o.x, o.z, ax, az, bx, bz, P);
      const min = obstacleRadius(d, o); const dx = P.x - o.x, dz = P.z - o.z; const dd = Math.hypot(dx, dz);
      if (dd < min && dd > 1e-4) { const push = min - dd; pos.x += dx / dd * push; pos.z += dz / dd * push; }
    }
    for (const e of ctx.others) {
      if (e === d || !e.awake || e.species.kind !== 'land') continue;
      const ep = e.root.position;
      if (Math.abs(ep.x - pos.x) > 40 || Math.abs(ep.z - pos.z) > 40) continue;
      const k = coEaters(d, e) ? 0.35 : 1;
      const [ex0, ez0, ex1, ez1] = capsule(e, ep.x, ep.z, e.heading, k);
      const [ax, az, bx, bz] = capsule(d, pos.x, pos.z, d.heading, k);
      const dd = segSeg(ax, az, bx, bz, ex0, ez0, ex1, ez1, P, Q);
      const min = b.r + bodyOf(e).r;
      if (dd < min && dd > 1e-4) {
        // the one that is moving (or the smaller one) gives way
        const share = e.isBusy || e.speed < 0.05 ? 1 : d.speed < 0.05 ? 0 : 0.5;
        const push = (min - dd) * share; pos.x += (P.x - Q.x) / dd * push; pos.z += (P.z - Q.z) / dd * push;
      }
    }
  }
}

/** A wander goal the body can actually stand on (clear of trees/rocks), or null. */
export function freeSpot(d: Dino, ctx: DinoContext, cx: number, cz: number, r: number, tries = 24): THREE.Vector3 | null {
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    const h = Math.atan2(x - d.root.position.x, z - d.root.position.z);
    if (bodyFree(d, ctx, x, z, h, 1.2)) return new THREE.Vector3(x, 0, z);
  }
  return null;
}

/**
 * Go to (gx,gz) along a planned route (A* around trees/rocks/water, re-planned when the goal moves
 * or progress stalls); local steering handles moving things. Returns the distance to the goal.
 */
export function travel(d: Dino, ctx: DinoContext, gx: number, gz: number, dt: number, maxSpeed: number, stopDist: number): number {
  const ai = d.ai; const pos = d.root.position; const b = bodyOf(d);
  const goalDist = Math.hypot(gx - pos.x, gz - pos.z);
  if (goalDist <= stopDist) { brake(d, dt); ai.route = null; return goalDist; }
  const moved = !ai.route || Math.hypot(ai.routeGoal.x - gx, ai.routeGoal.z - gz) > 1.5;
  const stalled = ctx.time - ai.progressAt > 3.5 && ctx.time > ai.routeReplanAt - 2;
  if (moved || stalled || ctx.time > ai.routeReplanAt) {
    const r = planRoute(d, ctx, gx, gz);
    if (r === undefined) {
      // planning budget spent this frame: steer straight for now, plan on a later frame
      if (!ai.route) ai.route = [new THREE.Vector3(gx, 0, gz)];
    } else {
      ai.route = r ?? [new THREE.Vector3(gx, 0, gz)];
      ai.routeGoal.set(gx, 0, gz); ai.routeIdx = 0; ai.routeReplanAt = ctx.time + (moved ? 6 : 4) + Math.random();
      if (stalled) ai.progressAt = ctx.time;
    }
  }
  const route = ai.route!;
  let wp = route[Math.min(ai.routeIdx, route.length - 1)];
  while (ai.routeIdx < route.length - 1 && Math.hypot(wp.x - pos.x, wp.z - pos.z) < Math.max(2, b.r * 1.6)) { ai.routeIdx++; wp = route[ai.routeIdx]; }
  const last = ai.routeIdx >= route.length - 1;
  drive(d, ctx, wp.x, wp.z, dt, maxSpeed, last ? stopDist : 0.05, !last);
  if (goalDist < ai.bestDist - 0.5) { ai.bestDist = goalDist; ai.progressAt = ctx.time; }
  return goalDist;
}
