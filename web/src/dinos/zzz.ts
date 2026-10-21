// Little "z" bubbles rising from sleeping dinosaurs.
import * as THREE from 'three';

function zTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 54px "Arial Rounded MT Bold", "Helvetica Rounded", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(40,60,120,0.55)'; g.strokeText('z', 32, 34);
  g.fillStyle = '#ffffff'; g.fillText('z', 32, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Z { s: THREE.Sprite; age: number; life: number; vx: number; vz: number; size: number }

export class Zzz {
  group = new THREE.Group();
  private pool: Z[] = [];
  private free: THREE.Sprite[] = [];
  private mat: THREE.SpriteMaterial;
  constructor() {
    this.mat = new THREE.SpriteMaterial({ map: zTexture(), transparent: true, depthWrite: false, opacity: 1 });
    this.group.name = 'zzz';
  }
  spawn(p: THREE.Vector3, size: number): void {
    if (this.pool.length > 40) return;
    const s = this.free.pop() ?? new THREE.Sprite(this.mat.clone());
    s.position.copy(p); s.scale.setScalar(size * 0.4); s.renderOrder = 23;
    this.group.add(s);
    const a = Math.random() * Math.PI * 2;
    this.pool.push({ s, age: 0, life: 2.6, vx: Math.cos(a) * 0.15, vz: Math.sin(a) * 0.15, size });
  }
  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const z = this.pool[i]; z.age += dt;
      const t = z.age / z.life;
      if (t >= 1) { this.group.remove(z.s); this.free.push(z.s); this.pool.splice(i, 1); continue; }
      z.s.position.x += (z.vx + Math.sin(z.age * 2.5) * 0.25) * dt; z.s.position.z += z.vz * dt; z.s.position.y += 0.45 * dt * z.size;
      z.s.scale.setScalar(z.size * (0.35 + 0.45 * t));
      (z.s.material as THREE.SpriteMaterial).opacity = Math.min(1, t * 5) * (1 - t);
    }
  }
}
