import * as THREE from 'three';

/**
 * Textures the game makes for itself where neither the original pack nor an install has one
 * (docs/original-assets.md, phase 0): the procedural battlefield's ground, made from tiling
 * noise. Plain on purpose; the pack's own (`ground/<name>`) replace them as they're made.
 */

export type GroundName = 'sandA' | 'sandB' | 'rock' | 'gravel' | 'plating';

const SIZE = 256;

/** A hash of a lattice point, 0..1. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise at (x, y) in 0..1 of the tile, `cells` lattice cells across, wrapping so the tile repeats seamlessly. */
function noise(x: number, y: number, cells: number, seed: number): number {
  const fx = x * cells;
  const fy = y * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const at = (i: number, j: number) => hash(((i % cells) + cells) % cells, ((j % cells) + cells) % cells, seed);
  const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
  const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

/** Octaves of noise from `cells` across, each twice as fine and half as strong: 0..1. */
function fbm(x: number, y: number, cells: number, octaves: number, seed: number): number {
  let sum = 0;
  let weight = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, y, cells << o, seed + o * 17) * weight;
    total += weight;
    weight *= 0.5;
  }
  return sum / total;
}

/** Each ground's color (sRGB, 0..255) and how its surface varies. */
const GROUNDS: Record<GroundName, (x: number, y: number) => [number, number, number]> = {
  // Fine desert sand, a warm tan with a faint grain.
  sandA: (x, y) => {
    const n = fbm(x, y, 8, 5, 1);
    const grain = hash(Math.floor(x * SIZE), Math.floor(y * SIZE), 2) * 0.08;
    const v = 0.86 + n * 0.22 + grain;
    return [176 * v, 142 * v, 104 * v];
  },
  // Drifted sand, paler, in long soft ripples.
  sandB: (x, y) => {
    const ripple = Math.sin((y + fbm(x, y, 4, 3, 3) * 0.35) * Math.PI * 2 * 12) * 0.5 + 0.5;
    const v = 0.9 + ripple * 0.1 + fbm(x, y, 8, 4, 4) * 0.12;
    return [188 * v, 158 * v, 118 * v];
  },
  // Weathered rock: grey-brown blotches, darker in its cracks.
  rock: (x, y) => {
    const n = fbm(x, y, 4, 6, 5);
    const crack = Math.abs(fbm(x, y, 6, 3, 6) - 0.5) < 0.025 ? 0.7 : 1;
    const v = (0.7 + n * 0.5) * crack;
    return [122 * v, 106 * v, 92 * v];
  },
  // Packed gravel: small stones, light and dark, softly blended rather than in hard pixels.
  gravel: (x, y) => {
    const stones = noise(x, y, 48, 7);
    const v = 0.84 + (stones - 0.5) * 0.22 + fbm(x, y, 8, 3, 8) * 0.14;
    return [140 * v, 128 * v, 112 * v];
  },
  // Deck plating: square plates with dark seams, worn unevenly.
  plating: (x, y) => {
    const px = (x * 4) % 1;
    const py = (y * 4) % 1;
    const seam = px < 0.025 || py < 0.025 ? 0.55 : 1;
    const wear = 0.85 + fbm(x, y, 8, 4, 9) * 0.25;
    const v = seam * wear;
    return [112 * v, 114 * v, 118 * v];
  },
};

const made = new Map<GroundName, THREE.Texture>();

/** A ground texture of the game's own, made once. */
export function groundTexture(name: GroundName): THREE.Texture {
  const known = made.get(name);
  if (known) return known;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const color = GROUNDS[name];
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const [r, g, b] = color(i / SIZE, j / SIZE);
      const k = (j * SIZE + i) * 4;
      image.data[k] = Math.min(255, r);
      image.data[k + 1] = Math.min(255, g);
      image.data[k + 2] = Math.min(255, b);
      image.data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.name = `ground/${name}`;
  made.set(name, texture);
  return texture;
}

const loader = new THREE.TextureLoader();

/** A PNG or WebP of the original pack as a tiling texture (color: sRGB), or null if it won't load. */
export async function loadImageTexture(url: string, srgb: boolean): Promise<THREE.Texture | null> {
  try {
    const texture = await loader.loadAsync(url);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  } catch {
    return null;
  }
}
