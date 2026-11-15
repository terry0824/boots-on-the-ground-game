import * as THREE from 'three';
import type { MapData } from './mapdata.ts';
import type { Ground } from './terrain.ts';

/**
 * How a campaign map (the loader's) sits in the world: meters per cell (such maps are drawn for
 * an RTS's compressed proportions; at true unit sizes a cell is several meters), and the height
 * scale. Cell (x, y) maps to world (X, Z) = ((x - cx) * cell, (cy - y) * cell): east is +X
 * and north is -Z, which keeps the map's handedness (the same turn the models get).
 */
export interface MapFrame {
  cell: number;
  vertical: number;
  cx: number;
  cy: number;
  /** Ground height (game units) that becomes world y = 0. */
  base: number;
}

export interface TerrainLayers {
  diffuse: THREE.Texture;
  normal: THREE.Texture;
  /** The tileset's cliff material (from its cliff set), painted on steep faces. */
  cliff?: { diffuse: THREE.Texture; normal: THREE.Texture | null } | null;
}

/** Cells of land added around the map so its edges continue into the distance. */
export const MARGIN = 40;

function smooth(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
  return a + (b - a) * v;
}

const v = new THREE.Vector3();

/**
 * The ground of a real map (the loader's): its heightmap (cliffs included) as a mesh, textured
 * with the tileset's eight blend layers by the map's own painted masks, with their normal maps.
 */
export class MapTerrain implements Ground {
  readonly mesh: THREE.Mesh;
  readonly size: number;
  readonly widthM: number;
  readonly depthM: number;
  /** World heights of the extended grid (the map plus its margin ring), as drawn. */
  private heights: Float32Array;
  /** The same, as walked on: bridge decks instead of the chasm floor beneath them. */
  private ground: Float32Array;
  /**
   * Per cell of the extended grid, which diagonal splits it: 0 from south-east to north-west,
   * 1 from south-west to north-east. Cliff cells split along the diagonal joining corners on the
   * same level, so the slope stays inside the cliff tile instead of folding out through it.
   */
  private split: Uint8Array;
  private readonly vx: number;
  private readonly vy: number;
  /** Mean height of the map's edge, world meters: the land beyond settles toward it. */
  readonly horizonHeight: number;
  /** The far land: a coarse mesh to the horizon in the same material. */
  readonly far: THREE.Mesh;
  /** The blend layer that covers most of the map; the land beyond the map uses it. */
  readonly baseLayer: number;
  /** Pathfinding runs on the map's own cells, so a one-cell passage stays a passage. */
  get pathCell(): number {
    return this.frame.cell;
  }

  constructor(
    readonly map: MapData,
    readonly frame: MapFrame,
    layers: TerrainLayers,
  ) {
    const { width, height } = map;
    const M = MARGIN;
    const mapVx = width + 1;
    this.vx = width + 1 + 2 * M;
    this.vy = height + 1 + 2 * M;
    this.widthM = width * frame.cell;
    this.depthM = height * frame.cell;
    this.size = Math.max(this.widthM, this.depthM) + 2 * M * frame.cell;
    const mapHeight = (x: number, y: number) => (map.heights[y * mapVx + x] - frame.base) * frame.vertical;
    // The edge's average height: beyond the margin the land rolls around it.
    let edge = 0;
    let edges = 0;
    for (let x = 0; x <= width; x++) {
      edge += mapHeight(x, 0) + mapHeight(x, height);
      edges += 2;
    }
    for (let y = 0; y <= height; y++) {
      edge += mapHeight(0, y) + mapHeight(width, y);
      edges += 2;
    }
    this.horizonHeight = edge / edges;
    this.heights = new Float32Array(this.vx * this.vy);
    for (let gy = 0; gy < this.vy; gy++) {
      for (let gx = 0; gx < this.vx; gx++) {
        const x = gx - M;
        const y = gy - M;
        const cx = Math.min(width, Math.max(0, x));
        const cy = Math.min(height, Math.max(0, y));
        const out = Math.hypot(x - cx, y - cy);
        const h = out === 0 ? mapHeight(x, y) : mapHeight(cx, cy) + (this.farHeight((x - frame.cx) * frame.cell, (frame.cy - y) * frame.cell) - mapHeight(cx, cy)) * smooth(out / (M * 0.75));
        this.heights[gy * this.vx + gx] = h;
      }
    }
    this.ground = this.heights.slice();
    for (let y = 0; y <= height; y++) {
      for (let x = 0; x <= width; x++) {
        const i = y * mapVx + x;
        if (map.walkHeights[i] !== map.heights[i]) this.ground[(y + M) * this.vx + x + M] = (map.walkHeights[i] - frame.base) * frame.vertical;
      }
    }

    const count = this.vx * this.vy;
    const pos = new Float32Array(count * 3);
    const cell = new Float32Array(count * 2);
    for (let gy = 0; gy < this.vy; gy++) {
      for (let gx = 0; gx < this.vx; gx++) {
        const i = gy * this.vx + gx;
        const x = gx - M;
        const y = gy - M;
        pos[i * 3] = (x - frame.cx) * frame.cell;
        pos[i * 3 + 1] = this.heights[i];
        pos[i * 3 + 2] = (frame.cy - y) * frame.cell;
        cell[i * 2] = x;
        cell[i * 2 + 1] = y;
      }
    }
    const cellsX = this.vx - 1;
    const cellsY = this.vy - 1;
    this.split = new Uint8Array(cellsX * cellsY);
    const level = (x: number, y: number) => map.cliff[Math.min(height, Math.max(0, y)) * mapVx + Math.min(width, Math.max(0, x))];
    const index = new Uint32Array(cellsX * cellsY * 6);
    let k = 0;
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const a = y * this.vx + x;
        const b = a + 1;
        const c = a + this.vx;
        const d = c + 1;
        const mx = x - M;
        const my = y - M;
        const sw = level(mx, my);
        const se = level(mx + 1, my);
        const nw = level(mx, my + 1);
        const ne = level(mx + 1, my + 1);
        const alt = se !== nw && sw === ne;
        this.split[y * cellsX + x] = alt ? 1 : 0;
        // Counterclockwise seen from above (+y): rows run toward -Z.
        if (alt) index.set([a, b, d, a, d, c], k);
        else index.set([a, b, c, b, d, c], k);
        k += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('cell', new THREE.BufferAttribute(cell, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeVertexNormals();

    // The ground beyond the map: the tileset's plain sand (or dirt) if it has one, otherwise
    // the most-used layer. Maps are framed in rock and cliffs that shouldn't run to the horizon.
    const totals = new Array(8).fill(0);
    for (let k = 0; k < 2; k++) {
      const m = map.masks[k];
      for (let i = 0; i < m.length; i += 64) for (let c = 0; c < 4; c++) totals[k * 4 + c] += m[i + c];
    }
    const byName = (re: RegExp) => map.textures.findIndex((t) => re.test(t));
    const named = [byName(/(?<!dark)sand$/i), byName(/sand/i), byName(/dirt$/i), byName(/dirt/i)].find((i) => i >= 0);
    this.baseLayer = named ?? totals.indexOf(Math.max(...totals));
    const masks = map.masks.map((m) => {
      const t = new THREE.DataTexture(m, map.maskWidth, map.maskHeight, THREE.RGBAFormat);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    });
    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 14, specular: 0x262626 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        tLayers: { value: layers.diffuse },
        tLayerNormals: { value: layers.normal },
        tMaskA: { value: masks[0] },
        tMaskB: { value: masks[1] },
        mapCells: { value: new THREE.Vector2(width, height) },
        baseLayer: { value: this.baseLayer },
        // Beyond this distance from the map's center the land dissolves into the haze.
        horizon: { value: new THREE.Vector2(2600, 4300) },
        // Texture repeats per cell: dense enough to read at a soldier's eye height.
        tiling: { value: 0.32 },
        tCliff: { value: layers.cliff?.diffuse ?? null },
        tCliffN: { value: layers.cliff?.normal ?? null },
        // One repeat of the cliff texture per cliff level's height (two height units).
        cliffScale: { value: 1 / (frame.vertical * 2) },
      });
      if (layers.cliff) shader.defines = { ...(shader.defines ?? {}), MAT_CLIFF: '' };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 cell;\nvarying vec2 vCell;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldN;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vCell = cell;
          vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWorldN = normalize(mat3(modelMatrix) * objectNormal);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform highp sampler2DArray tLayers;
          uniform highp sampler2DArray tLayerNormals;
          uniform sampler2D tMaskA;
          uniform sampler2D tMaskB;
          uniform vec2 mapCells;
          uniform float tiling;
          uniform int baseLayer;
          uniform vec2 horizon;
          #ifdef MAT_CLIFF
            uniform sampler2D tCliff;
            uniform sampler2D tCliffN;
            uniform float cliffScale;
          #endif
          varying vec2 vCell;
          varying vec3 vWorldPos;
          varying vec3 vWorldN;
          float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise2(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
          }
          vec3 terrainNormalT = vec3(0.0);`,
        )
        .replace(
          '#include <map_fragment>',
          `{
            vec2 maskUv = (vCell + 0.5 / 8.0) / mapCells;
            vec4 wa = texture(tMaskA, maskUv);
            vec4 wb = texture(tMaskB, maskUv);
            float w[8] = float[8](wa.r, wa.g, wa.b, wa.a, wb.r, wb.g, wb.b, wb.a);
            // Outside the map, fade to the map's main ground layer.
            vec2 beyond = max(vec2(0.0), max(-vCell, vCell - mapCells));
            float outside = smoothstep(2.0, 24.0, length(beyond));
            for (int i = 0; i < 8; i++) w[i] = mix(w[i], i == baseLayer ? 1.0 : 0.0, outside);
            vec2 uv = vCell * tiling;
            // Far off, sample at a larger scale too so the repeat doesn't read as a grid.
            float far = smoothstep(90.0, 600.0, distance(vWorldPos, cameraPosition));
            vec3 color = vec3(0.0);
            vec3 nrm = vec3(0.0);
            float total = 0.0;
            for (int i = 0; i < 8; i++) {
              if (w[i] < 0.02) continue;
              vec3 c = texture(tLayers, vec3(uv, float(i))).rgb;
              vec3 cf = texture(tLayers, vec3(uv * 0.23, float(i))).rgb;
              color += mix(c, mix(c, cf, 0.5), far) * w[i];
              vec2 n = texture(tLayerNormals, vec3(uv, float(i))).ag * 2.0 - 1.0;
              nrm.xy += n * w[i];
              total += w[i];
            }
            color /= max(total, 0.001);
            nrm.xy /= max(total, 0.001);
            terrainNormalT = vec3(nrm.xy, sqrt(saturate(1.0 - dot(nrm.xy, nrm.xy))));
            #ifdef MAT_CLIFF
            {
              // Cliff faces in the tileset's own cliff material, projected from the side so it
              // doesn't stretch down the slope, darker toward the foot of the wall.
              vec3 gn = normalize(vWorldN);
              float steep = 1.0 - smoothstep(0.42, 0.7, gn.y);
              if (steep > 0.01) {
                vec3 an = abs(gn);
                float wx = an.x / max(an.x + an.z, 1e-3);
                vec2 uvx = vec2(vWorldPos.z, -vWorldPos.y) * cliffScale;
                vec2 uvz = vec2(vWorldPos.x, -vWorldPos.y) * cliffScale;
                // (A cliff texture's alpha cuts shapes for the loader's own cliff meshes; it means
                // nothing to this projection, so it's ignored.)
                vec3 cliffColor = texture2D(tCliff, uvx).rgb * wx + texture2D(tCliff, uvz).rgb * (1.0 - wx);
                vec2 cn = (texture2D(tCliffN, uvx).ag * wx + texture2D(tCliffN, uvz).ag * (1.0 - wx)) * 2.0 - 1.0;
                color = mix(color, cliffColor * 1.05, steep);
                nrm.xy = mix(nrm.xy, cn, steep);
                terrainNormalT = vec3(nrm.xy, sqrt(saturate(1.0 - dot(nrm.xy, nrm.xy))));
              }
            }
            #endif
            // Broad tonal variation so large areas of one texture aren't flat.
            color *= 0.86 + 0.28 * noise2(vWorldPos.xz / 140.0) * (0.7 + 0.3 * noise2(vWorldPos.xz / 31.0));
            diffuseColor.rgb *= color * 1.25;
          }`,
        )
        .replace(
          '#include <fog_fragment>',
          `#include <fog_fragment>
          #ifdef USE_FOG
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(horizon.x, horizon.y, length(vWorldPos.xz)));
          #endif`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `{
            // Tangent frame for a heightfield: tangent along +X, bitangent along -Z (north).
            vec3 Nw = normalize(vWorldN);
            vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
            vec3 Bw = cross(Nw, Tw);
            vec3 mapped = normalize(Tw * terrainNormalT.x * 0.9 + Bw * terrainNormalT.y * 0.9 + Nw * terrainNormalT.z);
            normal = normalize((viewMatrix * vec4(mapped, 0.0)).xyz);
          }`,
        );
    };
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.far = this.buildFar(material);
  }

  /**
   * The land to the horizon: a coarse grid following farHeight, which the margin ring already
   * settles into. Under the map and its ring it drops away out of sight; it's shaded by the
   * smooth far profile so the drop doesn't darken the land next to the ring.
   */
  private buildFar(material: THREE.Material): THREE.Mesh {
    const size = 9000;
    const segs = 240;
    const step = size / segs;
    const c = this.frame.cell;
    const hx = (this.map.width / 2 + MARGIN) * c - step * 2;
    const hz = (this.map.height / 2 + MARGIN) * c - step * 2;
    const n = segs + 1;
    const pos = new Float32Array(n * n * 3);
    const nrm = new Float32Array(n * n * 3);
    const cell = new Float32Array(n * n * 2);
    const e = step * 0.5;
    const nv = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -size / 2 + i * step;
        const z = -size / 2 + j * step;
        const inside = Math.abs(x) < hx && Math.abs(z) < hz;
        pos.set([x, this.farHeight(x, z) - (inside ? 300 : 1.5), z], k * 3);
        nv.set(this.farHeight(x - e, z) - this.farHeight(x + e, z), 2 * e, this.farHeight(x, z - e) - this.farHeight(x, z + e)).normalize();
        nrm.set([nv.x, nv.y, nv.z], k * 3);
        cell.set([x / c + this.frame.cx, this.frame.cy - z / c], k * 2);
      }
    }
    const index = new Uint32Array(segs * segs * 6);
    let t = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * n + i;
        // Rows run toward +Z here, so this winding faces up.
        index.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], t);
        t += 6;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('cell', new THREE.BufferAttribute(cell, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * The land beyond the map, world meters: broad hills settling around the height of the map's
   * edge. Long wavelengths only, so a coarse far mesh can follow it exactly.
   */
  farHeight(x: number, z: number): number {
    const c = this.frame.cell;
    const n = noise(x / (70 * c), z / (70 * c)) * 0.65 + noise(x / (28 * c) + 9, z / (28 * c) + 3) * 0.35;
    // Far from the map the land sinks to a broad plain with long dunes, then rises into a ring
    // of distant ranges, so even from a Warship's altitude the land meets the sky.
    const r = Math.hypot(x, z);
    const sink = Math.min(1, Math.max(0, (r - 900) / 1800));
    const rim = Math.min(1, Math.max(0, (r - 2300) / 2100));
    const a = Math.atan2(z, x);
    const ridge = 0.55 + 0.45 * noise(Math.cos(a) * 6 + 31, Math.sin(a) * 6 + 17) + 0.25 * noise(Math.cos(a) * 19 + 5, Math.sin(a) * 19 + 2);
    return (this.horizonHeight ?? 0) - 2 * c - sink * 4 * c + n * 7 * c + rim * rim * 780 * ridge;
  }

  /** Cell coordinates of a world point. */
  toCell(x: number, z: number, out = new THREE.Vector2()): THREE.Vector2 {
    return out.set(x / this.frame.cell + this.frame.cx, this.frame.cy - z / this.frame.cell);
  }

  /** World position of a map point (cells, and game-unit height if given). */
  toWorld(x: number, y: number, z?: number, out = new THREE.Vector3()): THREE.Vector3 {
    const wx = (x - this.frame.cx) * this.frame.cell;
    const wz = (this.frame.cy - y) * this.frame.cell;
    return out.set(wx, z === undefined ? this.heightAt(wx, wz) : (z - this.frame.base) * this.frame.vertical, wz);
  }

  heightAt(x: number, z: number): number {
    const fx = THREE.MathUtils.clamp(x / this.frame.cell + this.frame.cx + MARGIN, 0, this.vx - 1.0001);
    const fy = THREE.MathUtils.clamp(this.frame.cy - z / this.frame.cell + MARGIN, 0, this.vy - 1.0001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const h = this.ground;
    const i = iy * this.vx + ix;
    const vx = this.vx;
    // Match the mesh's triangulation: (a, b, c) and (b, d, c), or (a, b, d) and (a, d, c).
    if (this.split[iy * (vx - 1) + ix]) {
      const d = h[i + vx + 1];
      if (tx >= ty) return h[i] + (h[i + 1] - h[i]) * tx + (d - h[i + 1]) * ty;
      return h[i] + (d - h[i + vx]) * tx + (h[i + vx] - h[i]) * ty;
    }
    if (tx + ty <= 1) return h[i] + (h[i + 1] - h[i]) * tx + (h[i + vx] - h[i]) * ty;
    const d = h[i + vx + 1];
    return d + (h[i + vx] - d) * (1 - tx) + (h[i + 1] - d) * (1 - ty);
  }

  slopeAt(x: number, z: number): number {
    const e = this.frame.cell * 0.35;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  /**
   * Ground units can walk here: the map's own pathing flags say so, and it isn't beside a drop
   * of most of a cliff level (ramp cells, between whole levels, connect two levels; bridges
   * over chasms walk like level 1).
   */
  walkable(x: number, z: number): boolean {
    if (!this.playable(x, z)) return false;
    const c = this.toCell(x, z);
    const cx = Math.floor(c.x);
    const cy = Math.floor(c.y);
    const { width, height, cellLevels, pathable } = this.map;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
    if (!pathable[cy * width + cx]) return false;
    // A bridge over a chasm walks like level 1.
    const lvl = (i: number) => (cellLevels[i] < 0.5 && pathable[i] ? 1 : cellLevels[i]);
    const here = lvl(cy * width + cx);
    // Ramp cells (between levels) are always open.
    if (Math.abs(here - Math.round(here)) > 0.01) return true;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (pathable[ny * width + nx] && Math.abs(lvl(ny * width + nx) - here) >= 0.75) return false;
      }
    }
    return true;
  }

  /** Inside the map's playable bounds. */
  playable(x: number, z: number): boolean {
    const c = this.toCell(x, z);
    const b = this.map.bounds;
    return c.x >= b.x0 + 1 && c.x <= b.x1 - 1 && c.y >= b.y0 + 1 && c.y <= b.y1 - 1;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null {
    const step = Math.max(0.5, this.frame.cell * 0.25);
    let prev = 0;
    for (let t = step; t <= maxDist + step; t += step) {
      const d = Math.min(t, maxDist);
      v.copy(origin).addScaledVector(dir, d);
      if (v.y <= this.heightAt(v.x, v.z)) {
        let lo = prev;
        let hi = d;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          v.copy(origin).addScaledVector(dir, mid);
          if (v.y <= this.heightAt(v.x, v.z)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = d;
      if (d === maxDist) break;
    }
    return null;
  }
}
