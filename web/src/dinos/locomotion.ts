// Procedural locomotion for rigged land dinosaurs.
//
// Feet are planted in world space and only move during a swing; leg bones are solved with a
// two-bone IK (hip→knee→ankle) plus foot and toe aiming, so a foot can never slide while it carries
// weight. Swings are scheduled by a gait clock whose rate follows the body's real ground speed
// (including turning in place), so cadence and stride always match the motion. The pelvis bobs and
// sways over the stance leg, the body follows the terrain under the feet, the tail lags behind
// turns, and the neck/head can track a look target.
import * as THREE from 'three';
import { heightAt } from '../world/heightmap.ts';

const UP = new THREE.Vector3(0, 1, 0);
const IDENT = new THREE.Quaternion();
const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _t = new THREE.Quaternion(), _w = new THREE.Quaternion();
const _s = new THREE.Vector3(), _m = new THREE.Matrix4();

function wpos(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 { return out.setFromMatrixPosition(o.matrixWorld); }
function wrap(a: number): number { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function smoother(x: number): number { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); }

/** Rotate `bone` by the world-space rotation `q` about its own origin. */
function rotateWorld(bone: THREE.Object3D, q: THREE.Quaternion): void {
  bone.parent!.matrixWorld.decompose(_s, _pq, _s);
  _t.copy(_pq).invert().multiply(q).multiply(_pq);
  bone.quaternion.premultiply(_t);
  bone.updateMatrixWorld(true);
}
/** Rotate `bone` so the direction from its origin to `from` points to `to` (both world). */
function aim(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, weight = 1): void {
  const p = wpos(bone, _p);
  _a.subVectors(from, p); _b.subVectors(to, p);
  if (_a.lengthSq() < 1e-10 || _b.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(_a.normalize(), _b.normalize());
  if (weight < 1) _q.copy(_w.copy(IDENT).slerp(_q, weight));
  rotateWorld(bone, _q);
}
function rotateAxis(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (Math.abs(angle) < 1e-5) return;
  _q.setFromAxisAngle(axis, angle);
  rotateWorld(bone, _q);
}

interface Leg {
  tag: string; front: boolean; side: number;
  thigh: THREE.Bone; shin: THREE.Bone; foot: THREE.Bone; toes: THREE.Bone; tip: THREE.Bone;
  a: number; b: number;                 // thigh, shin lengths
  restHip: THREE.Vector3; restBall: THREE.Vector3; restAnkleOff: THREE.Vector3; restToeOff: THREE.Vector3; // root space
  poleLocal: THREE.Vector3; hipH: number;
  offset: number;                       // gait phase offset (blended walk → trot)
  walkOffset: number; trotOffset: number;
  plant: THREE.Vector3; plantYaw: number;
  swinging: boolean; t: number; dur: number; from: THREE.Vector3; to: THREE.Vector3; fromYaw: number; toYaw: number; lift: number;
  lastK: number; ball: THREE.Vector3; yaw: number; initialised: boolean;
  stanceStart: THREE.Vector3; slip: number;
}

export interface LocoEvents { onPlant: (pos: THREE.Vector3, leg: string, heavy: boolean) => void }

export interface LocoStats { maxSlip: number; maxReach: number; steps: number; gait: number; settle: number; emergency: number }

export class Locomotion {
  legs: Leg[] = [];
  biped: boolean;
  private root: THREE.Object3D;           // dino root group (world placement)
  private model: THREE.Object3D;
  readonly bones = new Map<string, THREE.Bone>();
  private rest = new Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  private pelvis: THREE.Bone;
  private tail: THREE.Bone[] = [];
  private spine: THREE.Bone[] = [];
  private neck: THREE.Bone[] = [];
  head: THREE.Bone | null = null;
  snout: THREE.Bone | null = null;
  jaw: THREE.Bone | null = null;
  legLen: number;                         // mean hip height (m)
  footRadius: number;                     // mean horizontal distance of feet from the root origin
  footRadiusMax = 1;
  baseCycle: number;
  private minCycle = 0.5; private maxCycle = 1.5; private stanceMax = 1;
  duty: number;
  private walkDuty = 0.3;
  private trotK = 0;
  vRef: number;
  maxSpeed: number;
  /** top speed in a trot (diagonal pairs for quadrupeds, shorter stance for bipeds) */
  trotSpeed: number;
  maxTurnRate: number;
  bodyHalfWidth: number;
  phase = 0;
  lastCycle = 0;
  private prevPos = new THREE.Vector3();
  private prevHeading = 0;
  private vel = new THREE.Vector3();
  private yawRate = 0;
  private speedEff = 0;
  private stillTime = 0;
  private bodyY = 0;
  private reachDrop = 0;
  private pitch = 0; private roll = 0;
  private tailAng: number[] = [];
  private lookYaw = 0; private lookPitch = 0;
  lookTarget: THREE.Vector3 | null = null;
  lookWeight = 1;
  /** neck/head reach (CCD) so the snout lands exactly on a food item */
  reachTarget: THREE.Vector3 | null = null;
  reachWeight = 0;
  stomp = false;
  stats: LocoStats = { maxSlip: 0, maxReach: 0, steps: 0, gait: 0, settle: 0, emergency: 0 };
  private started = false;

  static create(root: THREE.Object3D, model: THREE.Object3D): Locomotion | null {
    const bones = new Map<string, THREE.Bone>();
    model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone); });
    const tags = [...bones.keys()].filter((n) => /^thigh/.test(n)).map((n) => n.slice(5));
    const ok = tags.filter((t) => bones.has('shin' + t) && bones.has('foot' + t) && bones.has('toes' + t) && bones.has('toe' + t));
    if (ok.length < 2 || !bones.has('root')) return null;
    return new Locomotion(root, model, bones, ok);
  }

  private constructor(root: THREE.Object3D, model: THREE.Object3D, bones: Map<string, THREE.Bone>, tags: string[]) {
    this.root = root; this.model = model; this.bones = bones;
    this.root.rotation.order = 'YXZ';
    for (const b of bones.values()) this.rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
    this.pelvis = bones.get('root')!;
    for (let i = 1; bones.has('tail' + i); i++) { this.tail.push(bones.get('tail' + i)!); this.tailAng.push(0); }
    for (let i = 1; bones.has('spine' + i); i++) this.spine.push(bones.get('spine' + i)!);
    for (let i = 1; bones.has('neck' + i); i++) this.neck.push(bones.get('neck' + i)!);
    this.head = bones.get('head') ?? null; this.snout = bones.get('snout') ?? null; this.jaw = bones.get('jaw') ?? null;
    // rest geometry in root space
    const rot = root.rotation.y; root.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
    const inv = _m.copy(root.matrixWorld).invert();
    const local = (b: THREE.Bone) => wpos(b, new THREE.Vector3()).applyMatrix4(inv);
    this.biped = tags.length === 2;
    const quadOffsets: Record<string, number> = { BL: 0, FL: 0.25, BR: 0.5, FR: 0.75 };
    for (const tag of tags) {
      const thigh = bones.get('thigh' + tag)!, shin = bones.get('shin' + tag)!, foot = bones.get('foot' + tag)!, toes = bones.get('toes' + tag)!, tip = bones.get('toe' + tag)!;
      const hip = local(thigh), knee = local(shin), ankle = local(foot), ball = local(toes), toe = local(tip);
      const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
      // knee bend direction: knee minus its projection on the hip→ankle line
      const ha = _a.subVectors(ankle, hip); const t = _b.subVectors(knee, hip).dot(ha) / Math.max(1e-6, ha.lengthSq());
      const pole = new THREE.Vector3().subVectors(knee, hip.clone().addScaledVector(ha, t));
      const front = tag.startsWith('F');
      if (pole.length() < 0.03 * (a + b)) pole.set(0, 0, front ? -1 : 1); else pole.normalize();
      const side = tag.endsWith('L') ? 1 : -1;   // three.js: Blender −X (left) → +X? decided by position below
      this.legs.push({
        tag, front, side: Math.sign(hip.x) || side, thigh, shin, foot, toes, tip, a, b,
        // home: the foot's ball straight under its hip (models are often posed mid-stride), toes as modelled
        restHip: hip, restBall: new THREE.Vector3(ball.x, 0, hip.z + (ball.z - ankle.z) * 0.5), restAnkleOff: ankle.clone().sub(new THREE.Vector3(ball.x, 0, ball.z)),
        restToeOff: new THREE.Vector3(toe.x - ball.x, 0, toe.z - ball.z), poleLocal: pole, hipH: hip.y,
        offset: this.biped ? (tag.startsWith('L') ? 0 : 0.5) : (quadOffsets[tag.slice(0, 2)] ?? 0),
        walkOffset: this.biped ? (tag.startsWith('L') ? 0 : 0.5) : (quadOffsets[tag.slice(0, 2)] ?? 0),
        trotOffset: this.biped ? (tag.startsWith('L') ? 0 : 0.5) : ({ BL: 0, FR: 1, BR: 0.5, FL: 0.5 } as Record<string, number>)[tag.slice(0, 2)] ?? 0,
        plant: new THREE.Vector3(), plantYaw: 0, swinging: false, t: 0, dur: 0.4, from: new THREE.Vector3(), to: new THREE.Vector3(),
        fromYaw: 0, toYaw: 0, lift: 0, lastK: -99, ball: new THREE.Vector3(), yaw: 0, initialised: false, stanceStart: new THREE.Vector3(), slip: 0,
      });
    }
    root.rotation.set(0, rot, 0); root.updateMatrixWorld(true);
    this.legLen = this.legs.reduce((s, l) => s + l.hipH, 0) / this.legs.length;
    this.footRadius = this.legs.reduce((s, l) => s + Math.hypot(l.restBall.x, l.restBall.z), 0) / this.legs.length;
    this.footRadiusMax = Math.max(...this.legs.map((l) => Math.hypot(l.restBall.x, l.restBall.z)));
    this.bodyHalfWidth = Math.max(...this.legs.map((l) => Math.abs(l.restBall.x))) + 0.15 * this.legLen;
    // gait timing from dynamic similarity (Alexander 1976): relative stride λ/h = 2.3·Fr^0.3, Fr = v²/(g·h)
    const h = this.legLen;
    this.minCycle = 0.5 * Math.sqrt(h); this.maxCycle = 1.6 * Math.sqrt(h);
    this.baseCycle = 0.5 * (this.minCycle + this.maxCycle);
    this.duty = this.biped ? 0.42 : 0.3;            // swing fraction of the cycle
    this.walkDuty = this.duty;
    this.stanceMax = (this.biped ? 1.0 : 0.8) * h;   // how far a planted foot can travel under the hip
    this.vRef = 0.35 * Math.sqrt(9.81 * h);
    this.maxSpeed = Math.sqrt(0.25 * 9.81 * h);      // walk → trot transition (Froude 0.25)
    this.trotSpeed = Math.sqrt((this.biped ? 0.6 : 0.5) * 9.81 * h);
    const maxStride = (this.biped ? 1.05 : 0.85) * h;
    this.maxTurnRate = Math.min(1.4, (0.5 * this.stanceMax) / (Math.max(0.3, this.footRadiusMax) * this.minCycle * 1.4 * (1 - this.duty)));
    void maxStride;
  }

  /** Last pose written by the animation mixer (three.js only writes a bone when its value changes,
   *  so the procedural layers must be undone by restoring this, not the bind pose). */
  private base = new Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  /** Bind pose (used for measurements). */
  resetPose(): void {
    for (const [b, r] of this.rest) { b.quaternion.copy(r.q); b.position.copy(r.p); }
    this.base.clear();
  }
  /** Before the mixer: undo last frame's procedural offsets by restoring the clip pose. */
  restoreClipPose(): void {
    for (const [b, r] of this.base) { b.quaternion.copy(r.q); b.position.copy(r.p); }
  }
  /** After the mixer: remember the clip pose. */
  captureClipPose(): void {
    for (const b of this.rest.keys()) {
      let r = this.base.get(b);
      if (!r) { r = { q: new THREE.Quaternion(), p: new THREE.Vector3() }; this.base.set(b, r); }
      r.q.copy(b.quaternion); r.p.copy(b.position);
    }
  }

  private homeAt(leg: Leg, x: number, z: number, heading: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(heading), s = Math.sin(heading);
    const lx = leg.restBall.x, lz = leg.restBall.z;
    out.set(x + lx * c + lz * s, 0, z - lx * s + lz * c);
    out.y = heightAt(out.x, out.z);
    return out;
  }

  /** Place the root (height + terrain tilt) — call before the mixer. */
  placeBody(dt: number, heading: number): void {
    const pos = this.root.position;
    if (!this.started) {
      this.started = true; this.prevPos.copy(pos); this.prevHeading = heading;
      for (const l of this.legs) { this.homeAt(l, pos.x, pos.z, heading, l.plant); l.plantYaw = heading; l.ball.copy(l.plant); l.yaw = heading; l.initialised = true; l.stanceStart.copy(l.plant); }
      this.bodyY = this.groundUnder(heading);
      pos.y = this.bodyY;
    }
    // ground velocity / yaw rate from the actual motion of the root
    if (dt > 0) {
      this.vel.set((pos.x - this.prevPos.x) / dt, 0, (pos.z - this.prevPos.z) / dt);
      const yr = wrap(heading - this.prevHeading) / dt;
      this.yawRate += (yr - this.yawRate) * Math.min(1, dt * 10);
    }
    this.prevPos.copy(pos); this.prevHeading = heading;
    // body height: terrain under the feet (homes), smoothed
    const target = this.groundUnder(heading);
    this.bodyY += (target - this.bodyY) * Math.min(1, dt * 8);
    pos.y = this.bodyY;
    // tilt from the feet: quads pitch to front/back feet, everything rolls a little with left/right
    let front = 0, back = 0, nf = 0, nb = 0, left = 0, right = 0, nl = 0, nr = 0, zf = 0, zb = 0;
    for (const l of this.legs) {
      const h = this.homeAt(l, pos.x, pos.z, heading, _c).y;
      if (l.front) { front += h; nf++; zf += l.restBall.z; } else { back += h; nb++; zb += l.restBall.z; }
      if (l.side > 0) { left += h; nl++; } else { right += h; nr++; }
    }
    let pitch = 0;
    if (nf && nb) pitch = Math.atan2(front / nf - back / nb, Math.max(0.5, zf / nf - zb / nb));
    else {
      const ahead = heightAt(pos.x + Math.sin(heading) * this.legLen, pos.z + Math.cos(heading) * this.legLen);
      const behind = heightAt(pos.x - Math.sin(heading) * this.legLen, pos.z - Math.cos(heading) * this.legLen);
      pitch = 0.5 * Math.atan2(ahead - behind, 2 * this.legLen);
    }
    const roll = nl && nr ? 0.5 * Math.atan2(left / nl - right / nr, Math.max(0.4, 2 * this.bodyHalfWidth)) : 0;
    this.pitch += (THREE.MathUtils.clamp(pitch, -0.35, 0.35) - this.pitch) * Math.min(1, dt * 5);
    this.roll += (THREE.MathUtils.clamp(roll, -0.15, 0.15) - this.roll) * Math.min(1, dt * 5);
    this.root.rotation.set(-this.pitch, heading, this.roll, 'YXZ');
    this.root.updateMatrixWorld(true);
  }

  private groundUnder(heading: number): number {
    let h = 0;
    for (const l of this.legs) h += this.homeAt(l, this.root.position.x, this.root.position.z, heading, _c).y;
    return h / this.legs.length;
  }

  /** Gait + IK + secondary motion. Call after the mixer has written the clip pose. */
  update(dt: number, heading: number, events: LocoEvents, busy: boolean): void {
    const pos = this.root.position;
    this.model.updateMatrixWorld(true);
    const v = Math.hypot(this.vel.x, this.vel.z);
    const turnSpeed = Math.abs(this.yawRate) * this.footRadiusMax;
    this.speedEff = Math.max(v, turnSpeed);
    const moving = this.speedEff > 0.04 && !busy;
    const sf = THREE.MathUtils.clamp(this.speedEff / Math.max(0.3, this.vRef), 0, 2.2);
    const ve = Math.max(0.05, this.speedEff), h = this.legLen;
    const stride = 2.3 * h * Math.pow((ve * ve) / (9.81 * h), 0.3);
    let cycle = THREE.MathUtils.clamp(stride / ve, this.minCycle, this.maxCycle);
    cycle = Math.max(this.minCycle, Math.min(cycle, this.stanceMax / (ve * (1 - this.duty))));
    // gait transition: walk → trot as the speed rises past the walking range
    const trot = THREE.MathUtils.smoothstep(this.speedEff / Math.max(0.2, this.maxSpeed), 0.85, 1.15);
    if (!this.legs.some((l) => l.swinging) || Math.abs(trot - this.trotK) > 0.25) this.trotK = trot;
    for (const l of this.legs) l.offset = THREE.MathUtils.lerp(l.walkOffset, l.trotOffset, this.trotK);
    this.duty = THREE.MathUtils.lerp(this.walkDuty, this.biped ? 0.48 : 0.44, this.trotK);
    if (moving) { this.phase += dt / cycle; this.stillTime = 0; } else this.stillTime += dt;
    this.lastCycle = cycle;
    const stance = (1 - this.duty) * cycle;

    // ---------------------------------------------------------------- schedule swings
    let swingingCount = 0;
    for (const l of this.legs) if (l.swinging) swingingCount++;
    for (const l of this.legs) {
      if (l.swinging) continue;
      const home = this.homeAt(l, pos.x, pos.z, heading, _d);
      const err = Math.hypot(l.plant.x - home.x, l.plant.z - home.z);
      const yawErr = Math.abs(wrap(heading - l.plantYaw));
      let start = false, settle = false;
      if (moving) {
        const k = Math.floor(this.phase - l.offset);
        const lp = this.phase - l.offset - k;
        if (lp < this.duty && l.lastK !== k) { l.lastK = k; start = err > 0.02 * this.legLen || yawErr > 0.05; }
      } else if (!busy || this.stomp) {
        // settle: bring stray feet back under the body, one leg (or one diagonal) at a time
        const conflict = this.legs.some((o) => o !== l && o.swinging && (this.biped || o.front === l.front || o.side === l.side));
        if (this.stomp && !conflict && this.stillTime > 0.15) { start = true; settle = true; }
        else if (!conflict && this.stillTime > 0.2 && (err > 0.12 * this.legLen || yawErr > 0.45)) { start = true; settle = true; }
      }
      // emergency: a planted foot left far behind (pushed / teleported) steps immediately
      let emergency = false;
      if (!start && err > 0.9 * this.legLen && swingingCount < this.legs.length - 1) { start = true; settle = true; emergency = true; }
      if (!start) continue;
      if (emergency) this.stats.emergency++; else if (settle) this.stats.settle++; else this.stats.gait++;
      const dur = settle ? Math.max(0.28, this.duty * this.baseCycle * (this.stomp ? 0.8 : 0.9)) : this.duty * cycle;
      // where will the home be when the foot lands (+ half the coming stance, so the foot lands ahead)?
      const lead = settle ? 0 : dur + stance * 0.5;
      const fx = pos.x + this.vel.x * lead, fz = pos.z + this.vel.z * lead;
      const fh = heading + this.yawRate * lead;
      l.from.copy(l.plant); l.fromYaw = l.plantYaw;
      this.homeAt(l, fx, fz, fh, l.to); l.toYaw = fh;
      l.swinging = true; l.t = 0; l.dur = dur;
      const stride = Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z);
      l.lift = this.stomp ? 0.22 * this.legLen : THREE.MathUtils.clamp(0.06 * this.legLen + 0.22 * stride, 0.03, 0.45 * this.legLen);
      swingingCount++;
    }

    // ---------------------------------------------------------------- advance swings
    let bob = 0, sway = 0, nSw = 0;
    for (const l of this.legs) {
      if (l.swinging) {
        l.t += dt / l.dur;
        // keep steering the landing spot while the swing is young (body may accelerate / turn)
        if (l.t < 0.65) {
          const remain = (1 - l.t) * l.dur + (moving ? stance * 0.5 : 0);
          this.homeAt(l, pos.x + this.vel.x * remain, pos.z + this.vel.z * remain, heading + this.yawRate * remain, _e);
          l.to.lerp(_e, Math.min(1, dt * 10)); l.toYaw = heading + this.yawRate * remain;
        }
        const s = smoother(l.t);
        l.ball.lerpVectors(l.from, l.to, s);
        l.ball.y = THREE.MathUtils.lerp(l.from.y, l.to.y, s) + l.lift * Math.sin(Math.PI * Math.min(1, l.t));
        l.yaw = l.fromYaw + wrap(l.toYaw - l.fromYaw) * s;
        const pulse = Math.sin(Math.PI * Math.min(1, l.t));
        bob += pulse; sway += -l.side * pulse; nSw++;
        if (l.t >= 1) {
          l.swinging = false; l.plant.copy(l.to); l.plant.y = heightAt(l.plant.x, l.plant.z); l.plantYaw = l.toYaw;
          l.ball.copy(l.plant); l.yaw = l.plantYaw; l.stanceStart.copy(l.plant);
          this.stats.steps++;
          events.onPlant(l.plant, l.tag, this.stomp);
        }
      } else {
        l.ball.copy(l.plant); l.yaw = l.plantYaw;
      }
    }

    // ---------------------------------------------------------------- foot targets
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const targets: { ankle: THREE.Vector3; toe: THREE.Vector3 }[] = [];
    for (const l of this.legs) {
      const fq = _q.setFromAxisAngle(UP, l.yaw);
      const ankle = l.restAnkleOff.clone().applyQuaternion(fq).add(l.ball);
      const pulse = l.swinging ? Math.sin(Math.PI * Math.min(1, l.t)) : 0;
      const toe = l.restToeOff.clone().applyQuaternion(fq);
      if (pulse > 0) toe.y -= 0.35 * pulse * toe.length();
      toe.add(l.ball);
      targets.push({ ankle, toe });
    }

    // ---------------------------------------------------------------- pelvis: bob, sway and reach
    const amp = (this.biped ? 0.03 : 0.015) * this.legLen * Math.min(1, sf + (this.stomp ? 0.8 : 0));
    const bobY = nSw ? amp * (bob / nSw - 0.45) : (moving ? -0.45 * amp : 0);
    const swayX = (this.biped ? 0.018 : 0.008) * this.legLen * Math.min(1, sf) * sway;
    // lower the hips just enough that every foot can reach its target (no overstretched legs)
    let need = 0;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i]; const T = targets[i].ankle;
      const H = wpos(l.thigh, _a), K = wpos(l.shin, _b), A = wpos(l.foot, _c);
      const reach = 0.975 * (H.distanceTo(K) + K.distanceTo(A));
      const horiz = Math.hypot(T.x - H.x, T.z - H.z);
      const vmax = Math.sqrt(Math.max(0, reach * reach - horiz * horiz));
      const drop = (H.y + bobY - T.y) - vmax;
      if (drop > need) need = drop;
    }
    need = Math.min(need, 0.45 * this.legLen);
    this.reachDrop += (need - this.reachDrop) * Math.min(1, dt * (need > this.reachDrop ? 30 : 3));
    const dy = bobY - this.reachDrop;
    if (Math.abs(dy) > 1e-4 || Math.abs(swayX) > 1e-4) {
      const right = _f.set(Math.cos(heading), 0, -Math.sin(heading));
      const pw = wpos(this.pelvis, _g);
      const parent = this.pelvis.parent!;
      const p0 = parent.worldToLocal(_a.copy(pw));
      const p1 = parent.worldToLocal(_b.copy(pw).addScaledVector(UP, dy).addScaledVector(right, swayX));
      this.pelvis.position.add(p1.sub(p0));
      this.pelvis.updateMatrixWorld(true);
    }

    // ---------------------------------------------------------------- leg IK
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i]; const { ankle, toe } = targets[i];
      const pole = _c.copy(l.poleLocal).applyQuaternion(rootQ);
      this.twoBone(l, ankle, pole);
      aim(l.foot, wpos(l.toes, _d), l.ball);
      aim(l.toes, wpos(l.tip, _e), toe);
      // measurement: how far is the real ball from where it should be (reach failures) / slip in stance
      const real = wpos(l.toes, _e);
      const miss = real.distanceTo(l.ball);
      if (miss > this.stats.maxReach) this.stats.maxReach = miss;
      if (!l.swinging) { const slip = Math.hypot(real.x - l.stanceStart.x, real.z - l.stanceStart.z); l.slip = slip; if (slip > this.stats.maxSlip) this.stats.maxSlip = slip; }
    }

    // ---------------------------------------------------------------- tail & spine secondary motion
    const bodyUp = _g.set(0, 1, 0).applyQuaternion(rootQ);
    const n = this.tail.length;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) / n;
      const lag = THREE.MathUtils.clamp(-this.yawRate * (0.07 + 0.1 * k), -0.22, 0.22);
      const swing = Math.sin((this.phase * 2 - 0.12 * i) * Math.PI) * 0.045 * Math.min(1, sf) * (0.3 + 0.7 * k);
      const target = lag + (this.biped ? swing : swing * 0.6);
      this.tailAng[i] += (target - this.tailAng[i]) * Math.min(1, dt * (7 - 4 * k));
      rotateAxis(this.tail[i], bodyUp, this.tailAng[i]);
    }
    for (let i = 0; i < this.spine.length; i++) rotateAxis(this.spine[i], bodyUp, -Math.sin(this.phase * 2 * Math.PI) * 0.012 * Math.min(1, sf));

    // ---------------------------------------------------------------- head look
    let wantYaw = 0, wantPitch = 0;
    if (this.lookTarget && this.head && this.lookWeight > 0.01) {
      const base = wpos(this.neck[0] ?? this.head, _d);
      const rel = _e.subVectors(this.lookTarget, base);
      const inv = _t.copy(rootQ).invert();
      rel.applyQuaternion(inv);
      const yaw = Math.atan2(rel.x, rel.z);
      if (Math.abs(yaw) < 1.9) {
        wantYaw = THREE.MathUtils.clamp(yaw, -1.0, 1.0) * this.lookWeight;
        wantPitch = THREE.MathUtils.clamp(Math.atan2(rel.y, Math.hypot(rel.x, rel.z)), -0.45, 0.35) * this.lookWeight;
      }
    }
    this.lookYaw += (wantYaw - this.lookYaw) * Math.min(1, dt * 2.5);
    this.lookPitch += (wantPitch - this.lookPitch) * Math.min(1, dt * 2.5);
    this.reach();
    if (this.head && (Math.abs(this.lookYaw) > 1e-3 || Math.abs(this.lookPitch) > 1e-3)) {
      const chain = [...this.neck, this.head];
      const w = chain.map((_, i) => (i + 1));
      const tot = w.reduce((a, b) => a + b, 0);
      const right = _f.set(1, 0, 0).applyQuaternion(rootQ);
      for (let i = 0; i < chain.length; i++) {
        rotateAxis(chain[i], bodyUp, this.lookYaw * w[i] / tot);
        rotateAxis(chain[i], right, -this.lookPitch * w[i] / tot);
      }
    }
  }

  private reach(): void {
    if (!this.reachTarget || this.reachWeight < 0.01 || !this.snout || !this.head) return;
    const chain = [...this.spine.slice(-2), ...this.neck, this.head];
    const n = chain.length;
    // total rotation each joint may add on top of the clip pose (no folding the head back)
    const cap = (i: number) => (i === n - 1 ? 0.6 : i < 2 ? 0.12 : 0.35) * this.reachWeight;
    const used = new Float32Array(n);
    const eff = new THREE.Vector3();
    for (let it = 0; it < 6; it++) {
      for (let i = n - 1; i >= 0; i--) {
        wpos(this.snout, eff);
        if (eff.distanceToSquared(this.reachTarget) < 0.0004) return;
        const left = cap(i) - used[i]; if (left <= 1e-4) continue;
        const p = wpos(chain[i], _p);
        _a.subVectors(eff, p); _b.subVectors(this.reachTarget, p);
        if (_a.lengthSq() < 1e-8 || _b.lengthSq() < 1e-8) continue;
        _q.setFromUnitVectors(_a.normalize(), _b.normalize());
        const ang = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
        if (ang < 1e-5) continue;
        const step = Math.min(ang, left, i === n - 1 ? 0.3 : 0.15);
        if (step < ang) _q.copy(_w.copy(IDENT).slerp(_q, step / ang));
        rotateWorld(chain[i], _q);
        used[i] += step;
      }
    }
  }

  private twoBone(l: Leg, target: THREE.Vector3, pole: THREE.Vector3): void {
    const H = wpos(l.thigh, new THREE.Vector3());
    const K = wpos(l.shin, new THREE.Vector3());
    const d = new THREE.Vector3().subVectors(target, H);
    const a = H.distanceTo(K), b = K.distanceTo(wpos(l.foot, new THREE.Vector3()));
    const dist = THREE.MathUtils.clamp(d.length(), Math.abs(a - b) + 1e-3, (a + b) * 0.999);
    const dir = d.normalize();
    const pp = pole.clone().addScaledVector(dir, -pole.dot(dir));
    if (pp.lengthSq() < 1e-8) pp.subVectors(K, H).addScaledVector(dir, -new THREE.Vector3().subVectors(K, H).dot(dir));
    pp.normalize();
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const Kd = H.clone().addScaledVector(dir, x).addScaledVector(pp, h);
    aim(l.thigh, K, Kd);
    const A = wpos(l.foot, new THREE.Vector3());
    aim(l.shin, A, H.clone().addScaledVector(dir, dist));
  }

  /** Re-plant every foot under the body (after a teleport). */
  resetPlants(): void {
    this.started = false; for (const l of this.legs) { l.swinging = false; l.lastK = -99; } this.vel.set(0, 0, 0); this.yawRate = 0;
    this.stats = { maxSlip: 0, maxReach: 0, steps: 0, gait: 0, settle: 0, emergency: 0 };
  }

  /** World position of the snout tip (end effector). */
  snoutWorld(out: THREE.Vector3): THREE.Vector3 | null { return this.snout ? wpos(this.snout, out) : null; }
  get swingingLegs(): number { return this.legs.filter((l) => l.swinging).length; }
  get gaitSpeed(): number { return this.speedEff; }
}
