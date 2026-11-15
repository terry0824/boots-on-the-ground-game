import * as THREE from 'three';

/**
 * Distance-to-goal over a grid of the map, for steering swarms around cliffs and buildings.
 * Every cell stores its walking distance to the nearest goal; units walk downhill.
 */
export class FlowField {
  readonly n: number;
  private cost: Float64Array;
  private blocked: Uint8Array;
  private readonly half: number;

  constructor(
    readonly size: number,
    readonly cell: number,
  ) {
    this.n = Math.ceil(size / cell);
    this.half = size / 2;
    this.cost = new Float64Array(this.n * this.n).fill(Infinity);
    this.blocked = new Uint8Array(this.n * this.n);
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x + this.half) / this.cell);
    const j = Math.floor((z + this.half) / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  private center(k: number, out: THREE.Vector2): THREE.Vector2 {
    return out.set(((k % this.n) + 0.5) * this.cell - this.half, (Math.floor(k / this.n) + 0.5) * this.cell - this.half);
  }

  /** Marks cells as walkable or not; `walkable` is sampled at each cell center. */
  setTerrain(walkable: (x: number, z: number) => boolean) {
    const p = new THREE.Vector2();
    for (let k = 0; k < this.blocked.length; k++) {
      this.center(k, p);
      this.blocked[k] = walkable(p.x, p.y) ? 0 : 1;
    }
  }

  /** Recomputes distances from goal circles, treating `obstacles` circles as blocked. */
  compute(goals: { x: number; z: number; r: number }[], obstacles: { x: number; z: number; r: number }[]) {
    const n = this.n;
    const blocked = this.blocked.slice();
    const p = new THREE.Vector2();
    const inside = (list: { x: number; z: number; r: number }[]) =>
      list.some((c) => (p.x - c.x) ** 2 + (p.y - c.z) ** 2 < c.r * c.r);
    const queue: number[] = [];
    this.cost.fill(Infinity);
    for (let k = 0; k < blocked.length; k++) {
      this.center(k, p);
      if (inside(obstacles)) blocked[k] = 1;
      if (inside(goals)) {
        this.cost[k] = 0;
        blocked[k] = 0;
        queue.push(k);
      }
    }
    // Dijkstra with a simple binary heap; diagonal steps cost sqrt(2).
    const heap = new MinHeap();
    for (const k of queue) heap.push(k, 0);
    const steps = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];
    while (heap.size) {
      const [k, c] = heap.pop();
      if (c > this.cost[k]) continue;
      const i = k % n;
      const j = Math.floor(k / n);
      for (const [di, dj, w] of steps) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (blocked[nk]) continue;
        // No cutting corners past blocked cells.
        if (di && dj && (blocked[j * n + ni] || blocked[nj * n + i])) continue;
        const nc = c + w;
        if (nc < this.cost[nk]) {
          this.cost[nk] = nc;
          heap.push(nk, nc);
        }
      }
    }
  }

  /** Walking distance (in cells) from a point to the goal, or Infinity. */
  distance(x: number, z: number): number {
    const k = this.index(x, z);
    return k < 0 ? Infinity : this.cost[k];
  }

  /**
   * For a unit that has ended up somewhere the field doesn't reach (pushed into a pocket by the
   * crowd): direction to the nearest cell that does, searching up to `maxCells` away.
   */
  escape(x: number, z: number, out: THREE.Vector2, maxCells = 6): boolean {
    if (!this.rejoin(x, z, out, maxCells)) return false;
    out.set(out.x - x, out.y - z).normalize();
    return true;
  }

  /**
   * The center of the nearest cell the field reaches, into `out` (x, z), searching up to
   * `maxCells` away. Of cells equally near, the one nearer the goal: the other side of a
   * cliff's edge may be the top of the cliff.
   */
  rejoin(x: number, z: number, out: THREE.Vector2, maxCells = 6): boolean {
    const k = this.index(x, z);
    if (k < 0) return false;
    const n = this.n;
    const i = k % n;
    const j = Math.floor(k / n);
    let best = -1;
    let bestD = Infinity;
    for (let dj = -maxCells; dj <= maxCells; dj++) {
      for (let di = -maxCells; di <= maxCells; di++) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        const d = di * di + dj * dj;
        if (this.cost[nk] < Infinity && (d < bestD || (d === bestD && this.cost[nk] < this.cost[best]))) {
          bestD = d;
          best = nk;
        }
      }
    }
    if (best < 0) return false;
    this.center(best, out);
    return true;
  }

  /** Direction toward the goal at a point; false where the goal can't be reached. */
  direction(x: number, z: number, out: THREE.Vector2): boolean {
    const k = this.index(x, z);
    if (k < 0 || this.cost[k] === Infinity) return false;
    const n = this.n;
    const i = k % n;
    const j = Math.floor(k / n);
    let best = this.cost[k];
    let bi = 0;
    let bj = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const c = this.cost[nj * n + ni];
        if (c < best) {
          best = c;
          bi = di;
          bj = dj;
        }
      }
    }
    if (!bi && !bj) return false;
    // Blend toward the next cell's center so units don't zigzag along cell edges.
    const target = this.center((j + bj) * n + (i + bi), new THREE.Vector2());
    out.set(target.x - x, target.y - z).normalize();
    return true;
  }
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size() {
    return this.keys.length;
  }

  push(key: number, val: number) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.vals[0]];
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.vals[l] < this.vals[m]) m = l;
        if (r < this.keys.length && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}
