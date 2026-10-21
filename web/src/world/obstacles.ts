// Spatial hash of static obstacles (tree trunks, canopies, rocks) for dinosaur steering.
import type { Vegetation } from './vegetation.ts';

export interface Obstacle { x: number; z: number; r: number; canopy: number; h: number; tree: boolean }

const CELL = 8;
const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);

export class ObstacleGrid {
  private cells = new Map<number, Obstacle[]>();
  private builtVersion = -1;
  private veg: Vegetation;
  private nextCheck = 0;
  count = 0;
  constructor(veg: Vegetation) { this.veg = veg; }

  /** Rebuild when the vegetation changed (at most twice a second). */
  update(time: number): void {
    if (time < this.nextCheck || this.veg.version === this.builtVersion) return;
    this.nextCheck = time + 0.5;
    this.builtVersion = this.veg.version;
    this.cells.clear(); this.count = 0;
    this.veg.forEachObstacle((x, z, r, canopy, h, tree) => {
      const o: Obstacle = { x, z, r, canopy, h, tree };
      const span = Math.max(r, canopy);
      const i0 = Math.floor((x - span) / CELL), i1 = Math.floor((x + span) / CELL);
      const j0 = Math.floor((z - span) / CELL), j1 = Math.floor((z + span) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = key(i, j); let list = this.cells.get(k); if (!list) { list = []; this.cells.set(k, list); } list.push(o);
      }
      this.count++;
    });
  }

  /** Obstacles whose footprint may come within `r` of (x,z). Results are unique. */
  near(x: number, z: number, r: number, out: Obstacle[]): Obstacle[] {
    out.length = 0;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = this.cells.get(key(i, j)); if (!list) continue;
      for (const o of list) if (!out.includes(o)) out.push(o);
    }
    return out;
  }
}
