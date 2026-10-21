// Food piles: a photoscanned heap whose items are eaten one by one, each bite carrying a real piece
// into the dinosaur's mouth.
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Dino, Food, FoodItem } from '../dinos/dino.ts';

interface FoodMeta { items: { name: string; x: number; y: number; z: number; r: number; kind: string }[]; radius: number; height: number }
interface Flying { item: FoodItem; dino: Dino; t: number; from: THREE.Vector3 }

export class FoodSystem {
  foods: Food[];
  private scene: THREE.Scene;
  private loader: GLTFLoader;
  private proto: THREE.Object3D | null = null;
  private meta: FoodMeta | null = null;
  private scale = 1;
  private flying: Flying[] = [];
  private fading: { food: Food; t: number }[] = [];
  constructor(scene: THREE.Scene, loader: GLTFLoader, foods: Food[]) { this.scene = scene; this.loader = loader; this.foods = foods; }

  async load(): Promise<void> {
    try {
      const [g, meta] = await Promise.all([
        this.loader.loadAsync('/assets/dinos/food.glb'),
        fetch('/assets/dinos/food.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      g.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      this.proto = g.scene; this.meta = meta as FoodMeta | null;
      // legacy pile (fern + fruit spheres) was authored small
      let hasItems = false; g.scene.traverse((o) => { if (/^item_/.test(o.name)) hasItems = true; });
      this.scale = hasItems ? 1 : 2.4;
    } catch { this.proto = null; }
  }

  get ready(): boolean { return !!this.proto; }

  /** Drop a pile at (x, y, z). */
  drop(x: number, y: number, z: number): Food {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = Math.random() * Math.PI * 2;
    const items: FoodItem[] = [];
    let radius = 1.2 * this.scale;
    if (this.proto) {
      const pile = this.proto.clone(true); pile.scale.setScalar(this.scale); g.add(pile);
      g.updateMatrixWorld(true);
      pile.traverse((o) => {
        if (/^(item_|fruit\d)/.test(o.name)) {
          const box = new THREE.Box3().setFromObject(o);
          const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3());
          items.push({ obj: o, pos: c, r: Math.max(s.x, s.y, s.z) / 2, kind: o.name, eaten: false, taken: -1 });
        }
      });
      // stems of the legacy fruit follow their fruit
      if (this.meta) radius = this.meta.radius * this.scale;
    }
    this.scene.add(g);
    const food: Food = { pos: new THREE.Vector3(x, y, z), amount: 1, mesh: g, eaters: new Map(), radius, items };
    this.foods.push(food);
    if (this.foods.length > 4) { const old = this.foods.shift()!; this.remove(old); }
    return food;
  }

  /** The uneaten item a bite at `near` should take (closest first; top of the pile breaks ties). */
  pick(food: Food, near: THREE.Vector3): FoodItem | null {
    let best: FoodItem | null = null, bd = Infinity;
    for (const it of food.items) {
      if (it.eaten) continue;
      const d = Math.hypot(it.pos.x - near.x, it.pos.z - near.z) - it.pos.y * 0.3;
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  /** Take one item into the dinosaur's mouth. Returns the item (or null when the pile is empty). */
  bite(d: Dino, food: Food, preferred: FoodItem | null, mouth: THREE.Vector3): FoodItem | null {
    const it = preferred && !preferred.eaten ? preferred : this.pick(food, mouth);
    if (!it) { food.amount = 0; return null; }
    it.eaten = true;
    const from = new THREE.Vector3(); it.obj.getWorldPosition(from);
    // re-parent to the scene so it can travel to the mouth independently of the pile
    this.scene.attach(it.obj);
    this.flying.push({ item: it, dino: d, t: 0, from });
    const left = food.items.filter((i) => !i.eaten).length;
    food.amount = food.items.length ? left / food.items.length : 0;
    if (food.amount <= 0) this.fading.push({ food, t: 0 });
    return it;
  }

  update(dt: number): void {
    const mouth = new THREE.Vector3();
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i]; f.t += dt;
      const k = Math.min(1, f.t / 0.35);
      f.dino.snoutPos(mouth);
      f.item.obj.position.lerpVectors(f.from, mouth, k * k * (3 - 2 * k));
      const s = f.t < 0.35 ? 1 : Math.max(0, 1 - (f.t - 0.35) / 0.5);
      f.item.obj.scale.setScalar(s * (f.item.obj.userData.s0 ?? (f.item.obj.userData.s0 = f.item.obj.scale.x)));
      if (f.t > 0.35) f.item.obj.position.copy(mouth);
      if (f.t > 0.85) { f.item.obj.removeFromParent(); this.flying.splice(i, 1); }
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]; f.t += dt;
      if (f.t > 1.5) {   // leftover greens sink away
        const k = Math.max(0, 1 - (f.t - 1.5) / 2);
        f.food.mesh.scale.set(1, k, 1);
        if (k <= 0) { this.remove(f.food); this.fading.splice(i, 1); }
      }
    }
  }

  private remove(food: Food): void {
    food.amount = 0;
    this.scene.remove(food.mesh);
    const i = this.foods.indexOf(food); if (i >= 0) this.foods.splice(i, 1);
  }
}
