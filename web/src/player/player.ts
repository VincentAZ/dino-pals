// The invisible explorer + damped orbit camera.
import * as THREE from 'three';
import { EYE_HEIGHT } from '../config.ts';
import { heightAt, waterAt } from '../world/heightmap.ts';
import { HALF } from '../world/biomes.ts';

export class Player {
  pos = new THREE.Vector3(0, 0, 0);     // feet
  eye = new THREE.Vector3();
  target: THREE.Vector3 | null = null;
  speed = 0;
  maxSpeed = 3.4;
  yaw = Math.PI;        // camera yaw (around player)
  pitch = 0.2;
  dist = 7;
  private vYaw = Math.PI; private vPitch = 0.2; private vDist = 7;
  /** optional obstacle query: returns the blocking obstacle (centre + radius) or null */
  obstacleAt: ((x: number, z: number) => { x: number; z: number; r: number } | null) | null = null;
  camera: THREE.PerspectiveCamera;
  walkDir = new THREE.Vector3(0, 0, 1);
  stepAcc = 0;
  onStep: (() => void) | null = null;
  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.pos.y = heightAt(0, 0);
  }
  teleport(x: number, z: number): void {
    this.pos.set(THREE.MathUtils.clamp(x, -HALF + 10, HALF - 10), 0, THREE.MathUtils.clamp(z, -HALF + 10, HALF - 10));
    this.pos.y = Math.max(heightAt(this.pos.x, this.pos.z), -0.5);
    this.target = null; this.speed = 0;
    this.update(0.016);
    this.vYaw = this.yaw; this.vPitch = this.pitch; this.vDist = this.dist;
    this.update(0.016);
  }
  walkTo(x: number, z: number): void {
    // don't walk into deep water: stop at the shore
    const w = waterAt(x, z);
    const h = heightAt(x, z);
    if (w.kind !== 'none' && w.level - h > 0.9) {
      // move the target back towards the player until it is wadeable
      const dx = x - this.pos.x, dz = z - this.pos.z; const len = Math.hypot(dx, dz) || 1;
      for (let t = 1; t > 0; t -= 0.04) {
        const tx = this.pos.x + dx * t, tz = this.pos.z + dz * t;
        const ww = waterAt(tx, tz); const hh = heightAt(tx, tz);
        if (ww.kind === 'none' || ww.level - hh <= 0.9) { x = tx; z = tz; break; }
      }
      void len;
    }
    // never end inside a rock or trunk: project the target out of the obstacle
    const ob = this.obstacleAt?.(x, z);
    if (ob) { const dx = x - ob.x, dz = z - ob.z; const d = Math.hypot(dx, dz) || 1; const push = ob.r + 0.6; x = ob.x + (dx / d) * push; z = ob.z + (dz / d) * push; }
    this.target = new THREE.Vector3(THREE.MathUtils.clamp(x, -HALF + 10, HALF - 10), 0, THREE.MathUtils.clamp(z, -HALF + 10, HALF - 10));
  }
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.0045;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.003, 0.02, 1.1);
  }
  zoom(scale: number): void { this.dist = THREE.MathUtils.clamp(this.dist / scale, 2.2, 16); }
  snapCamera(): void { this.vYaw = this.yaw; this.vPitch = this.pitch; this.vDist = this.dist; this.update(0.016); }

  update(dt: number): void {
    // walk
    if (this.target) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25) { this.target = null; this.speed = 0; }
      else {
        const want = Math.min(this.maxSpeed, d * 2.5);
        this.speed += (want - this.speed) * Math.min(1, dt * 4);
        const step = Math.min(d, this.speed * dt);
        const nx = this.pos.x + (dx / d) * step, nz = this.pos.z + (dz / d) * step;
        const slopeOk = heightAt(nx, nz) - heightAt(this.pos.x, this.pos.z) < step * 1.6;
        if (slopeOk) { this.pos.x = nx; this.pos.z = nz; this.walkDir.set(dx / d, 0, dz / d); }
        else { this.target = null; this.speed = 0; }
        this.stepAcc += step;
        if (this.stepAcc > 1.4) { this.stepAcc = 0; this.onStep?.(); }
        // ease the camera yaw towards the walking direction so the child looks where they go
        const walkYaw = Math.atan2(-this.walkDir.x, -this.walkDir.z);
        let diff = walkYaw - this.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
        this.yaw += diff * Math.min(1, dt * 0.6);
      }
    } else this.speed *= 0.8;
    // ground / wading
    const h = heightAt(this.pos.x, this.pos.z);
    const w = waterAt(this.pos.x, this.pos.z);
    const groundY = w.kind !== 'none' ? Math.max(h, w.level - 0.8) : h;
    this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 10);
    const bob = this.speed > 0.2 ? Math.sin(performance.now() * 0.011) * 0.04 * Math.min(1, this.speed / 2) : 0;
    this.eye.set(this.pos.x, this.pos.y + EYE_HEIGHT + bob, this.pos.z);
    // damped orbit
    const k = Math.min(1, dt * 6);
    this.vYaw += (this.yaw - this.vYaw) * k; this.vPitch += (this.pitch - this.vPitch) * k; this.vDist += (this.dist - this.vDist) * k;
    const cx = this.eye.x + Math.sin(this.vYaw) * Math.cos(this.vPitch) * this.vDist;
    const cz = this.eye.z + Math.cos(this.vYaw) * Math.cos(this.vPitch) * this.vDist;
    let cy = this.eye.y + Math.sin(this.vPitch) * this.vDist + 0.6;
    // keep the camera above the terrain and the water
    const ch = heightAt(cx, cz);
    const cw = waterAt(cx, cz);
    const minY = Math.max(ch + 0.9, cw.kind !== 'none' ? cw.level + 0.5 : -Infinity);
    if (cy < minY) cy = minY;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(this.eye.x, this.eye.y + 0.4, this.eye.z);
  }
}
