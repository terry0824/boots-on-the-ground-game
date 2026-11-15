import type { Ground } from '../../engine/terrain.ts';

/**
 * The height flyers fly over: an "air" height map. Flyers don't follow the ground under them
 * but a smoothed copy of it, made when the map loads, so a flyer rises ahead of a cliff and
 * glides over a gully instead of dropping into it, while over a whole basin it still comes down
 * to the basin's level (and stays in sight). Here: the ground's height on a coarse grid, widened
 * by its highest point nearby (so the smoothing never cuts under a ridge) and then blurred.
 */

/** Grid cell, meters. */
const CELL = 4;
/** How far a high point holds the surface up around it, meters. */
const HOLD = 12;
/** How far the surface is smoothed, meters (each of two passes). */
const BLUR = 24;

export class AirHeight {
  private readonly n: number;
  private readonly half: number;
  private readonly heights: Float32Array;

  constructor(readonly ground: Ground) {
    this.half = ground.size / 2;
    this.n = Math.max(2, Math.ceil(ground.size / CELL) + 1);
    const n = this.n;
    let h: Float32Array = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = ground.heightAt(i * CELL - this.half, j * CELL - this.half);
    h = this.pass(h, Math.round(HOLD / CELL), true);
    const r = Math.round(BLUR / CELL);
    h = this.pass(this.pass(h, r, false), r, false);
    this.heights = h;
  }

  /** The surface's height at a point (bilinear between grid points). */
  at(x: number, z: number): number {
    const n = this.n;
    const fx = Math.min(n - 1.0001, Math.max(0, (x + this.half) / CELL));
    const fz = Math.min(n - 1.0001, Math.max(0, (z + this.half) / CELL));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    const a = h[j * n + i] * (1 - tx) + h[j * n + i + 1] * tx;
    const b = h[(j + 1) * n + i] * (1 - tx) + h[(j + 1) * n + i + 1] * tx;
    return a * (1 - tz) + b * tz;
  }

  /** A separable filter of radius `r` cells: the highest value around (`max`), or the mean. */
  private pass(src: Float32Array, r: number, max: boolean): Float32Array {
    const n = this.n;
    const tmp = new Float32Array(n * n);
    const out = new Float32Array(n * n);
    for (const [from, to, horizontal] of [
      [src, tmp, true],
      [tmp, out, false],
    ] as const) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          let acc = max ? -Infinity : 0;
          let count = 0;
          for (let k = -r; k <= r; k++) {
            const ii = horizontal ? i + k : i;
            const jj = horizontal ? j : j + k;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const v = from[jj * n + ii];
            if (max) acc = Math.max(acc, v);
            else acc += v;
            count++;
          }
          to[j * n + i] = max ? acc : acc / count;
        }
      }
    }
    return out;
  }
}
