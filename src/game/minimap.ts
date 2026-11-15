import type { Ground } from '../engine/terrain.ts';

/** The world rectangle the minimap shows (meters) and its picture of the ground. */
export interface MinimapFrame {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  image: HTMLCanvasElement;
}

/**
 * Paints the ground from above, the map's way round: north (the map's +y, our -Z) up,
 * east right. Walkable ground in the planet's sand tones by height, cliffs and chasms dark,
 * hill-shaded from the north-west so ramps and plateaus read at a glance.
 */
export function buildMinimap(ground: Ground, rect: { x0: number; z0: number; x1: number; z1: number }, size = 256): MinimapFrame {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const heights = new Float32Array(size * size);
  const walk = new Uint8Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;
  const sx = (rect.x1 - rect.x0) / size;
  const sz = (rect.z1 - rect.z0) / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = rect.x0 + (i + 0.5) * sx;
      const z = rect.z0 + (j + 0.5) * sz;
      const h = ground.heightAt(x, z);
      heights[j * size + i] = h;
      const w = ground.walkable(x, z) ? 1 : 0;
      walk[j * size + i] = w;
      if (w) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const span = Math.max(1, hi - lo);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const h = heights[k];
      // Hill shading: slope toward the light (from the north-west) brightens.
      const hx = heights[j * size + Math.min(size - 1, i + 1)] - heights[j * size + Math.max(0, i - 1)];
      const hz = heights[Math.min(size - 1, j + 1) * size + i] - heights[Math.max(0, j - 1) * size + i];
      const shade = Math.max(0.45, Math.min(1.35, 1 - (hx + hz) / (sx * 6)));
      const t = Math.max(0, Math.min(1, (h - lo) / span));
      let r: number;
      let gg: number;
      let b: number;
      if (walk[k]) {
        r = 74 + 92 * t;
        gg = 58 + 70 * t;
        b = 44 + 46 * t;
      } else {
        r = 34 + 22 * t;
        gg = 30 + 18 * t;
        b = 28 + 14 * t;
      }
      img.data[k * 4] = Math.min(255, r * shade);
      img.data[k * 4 + 1] = Math.min(255, gg * shade);
      img.data[k * 4 + 2] = Math.min(255, b * shade);
      img.data[k * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { ...rect, image: c };
}

/** World point to minimap pixel. */
export function toMinimap(f: MinimapFrame, x: number, z: number, size: number): [number, number] {
  return [((x - f.x0) / (f.x1 - f.x0)) * size, ((z - f.z0) / (f.z1 - f.z0)) * size];
}
