import * as THREE from 'three';

export interface TerrainLayers {
  sandA: THREE.Texture;
  sandB: THREE.Texture;
  rock: THREE.Texture;
  gravel: THREE.Texture;
  plating: THREE.Texture;
}

/** What the game needs from the ground, procedural or a real map (the loader's). */
export interface Ground {
  readonly mesh: THREE.Mesh;
  /** Extent, meters, centered on the origin (the larger side for a rectangular map). */
  readonly size: number;
  heightAt(x: number, z: number): number;
  /** Steepness: 0 flat, 1 vertical. */
  slopeAt(x: number, z: number): number;
  /** Distance along a ray to the ground, or null if it doesn't hit within maxDist. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null;
  /** On the playable area (units can be there). */
  playable(x: number, z: number): boolean;
  /** Where ground units can walk: playable, and not on a cliff face. */
  walkable(x: number, z: number): boolean;
  /** Grid size (m) for pathfinding over this ground, aligned to its own cells where it has them. */
  readonly pathCell: number;
}

/** A square heightfield centered on the origin, with height queries and ray casts. */
export class Terrain implements Ground {
  /** Playable radius around the origin (the procedural map is round). */
  radius = Infinity;
  readonly pathCell = 4;
  readonly mesh: THREE.Mesh;
  private heights: Float32Array;
  private readonly cell: number;
  private readonly half: number;

  constructor(
    readonly size: number,
    readonly segments: number,
    height: (x: number, z: number) => number,
    /** 0..1: how much "base" ground (gravel, plating) to show at a point. */
    baseMask: (x: number, z: number) => number,
    layers: TerrainLayers,
    /** Distance from the origin over which the ground dissolves into the fog (the world's edge). */
    horizon: [number, number] = [1e7, 1e7 + 1],
    /** Shade with the slope of this surface instead of the mesh's own (to hide a cut-out). */
    shading?: (x: number, z: number) => number,
  ) {
    this.cell = size / segments;
    this.half = size / 2;
    const n = segments + 1;
    this.heights = new Float32Array(n * n);

    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const mask = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = height(x, z);
      pos.setY(i, h);
      const gx = Math.round((x + this.half) / this.cell);
      const gz = Math.round((z + this.half) / this.cell);
      this.heights[gz * n + gx] = h;
      mask[i] = baseMask(x, z);
    }
    geometry.setAttribute('baseMask', new THREE.BufferAttribute(mask, 1));
    geometry.computeVertexNormals();
    if (shading) {
      const normals = geometry.attributes.normal as THREE.BufferAttribute;
      const e = this.cell * 0.5;
      const n3 = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        n3.set(shading(x - e, z) - shading(x + e, z), 2 * e, shading(x, z - e) - shading(x, z + e)).normalize();
        normals.setXYZ(i, n3.x, n3.y, n3.z);
      }
    }

    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 4, specular: 0x111111 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        tSandA: { value: layers.sandA },
        tSandB: { value: layers.sandB },
        tRock: { value: layers.rock },
        tGravel: { value: layers.gravel },
        tPlating: { value: layers.plating },
        horizon: { value: new THREE.Vector2(...horizon) },
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float baseMask;\nvarying vec3 vWorld;\nvarying vec3 vWorldNormal;\nvarying float vBase;',
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vBase = baseMask;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D tSandA, tSandB, tRock, tGravel, tPlating;
          uniform vec2 horizon;
          varying vec3 vWorld;
          varying vec3 vWorldNormal;
          varying float vBase;
          float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise2(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
          }`,
        )
        .replace(
          '#include <map_fragment>',
          `{
            vec2 uv = vWorld.xz / 9.0;
            // Far off, the same textures at seven times the scale, so their tiling doesn't
            // read as a grid from a Warship's altitude.
            float far = smoothstep(160.0, 700.0, distance(vWorld, cameraPosition));
            #define LAYER(t, s) mix(texture2D(t, uv * (s)).rgb, texture2D(t, uv * (s) * 0.14).rgb, far)
            // Several octaves at once, so the sand shifts in drifts rather than in blocks.
            float n = noise2(vWorld.xz / 210.0) * 0.45 + noise2(vWorld.xz / 70.0) * 0.3 + noise2(vWorld.xz / 23.0) * 0.17 + noise2(vWorld.xz / 7.0) * 0.08;
            vec3 sand = mix(LAYER(tSandA, 1.0), LAYER(tSandB, 0.73), smoothstep(0.25, 0.8, n) * 0.8);
            sand *= 0.88 + 0.24 * noise2(vWorld.xz / 330.0);
            float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
            vec3 rock = LAYER(tRock, 0.6);
            vec3 ground = mix(sand, rock, smoothstep(0.18, 0.38, slope));
            vec3 base = mix(texture2D(tGravel, uv).rgb, texture2D(tPlating, uv * 0.5).rgb, smoothstep(0.55, 0.9, vBase));
            diffuseColor.rgb *= mix(ground, base, smoothstep(0.05, 0.4, vBase));
            #undef LAYER
          }`,
        )
        .replace(
          '#include <fog_fragment>',
          `#include <fog_fragment>
          #ifdef USE_FOG
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(horizon.x, horizon.y, length(vWorld.xz)));
          #endif`,
        );
    };

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
  }

  heightAt(x: number, z: number): number {
    const n = this.segments + 1;
    const fx = THREE.MathUtils.clamp((x + this.half) / this.cell, 0, this.segments - 1e-4);
    const fz = THREE.MathUtils.clamp((z + this.half) / this.cell, 0, this.segments - 1e-4);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = this.heights[iz * n + ix];
    const h10 = this.heights[iz * n + ix + 1];
    const h01 = this.heights[(iz + 1) * n + ix];
    const h11 = this.heights[(iz + 1) * n + ix + 1];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  }

  playable(x: number, z: number): boolean {
    return Math.hypot(x, z) < this.radius;
  }

  walkable(x: number, z: number): boolean {
    return this.playable(x, z) && this.slopeAt(x, z) < 0.3;
  }

  /** Steepness at a point: 0 flat, 1 vertical. */
  slopeAt(x: number, z: number): number {
    const e = this.cell * 0.5;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  /** Distance along a ray to the ground, or null if it doesn't hit within maxDist. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null {
    const step = 1;
    let prev = 0;
    for (let t = step; t <= maxDist + step; t += step) {
      const d = Math.min(t, maxDist);
      if (origin.y + dir.y * d <= this.heightAt(origin.x + dir.x * d, origin.z + dir.z * d)) {
        let lo = prev;
        let hi = d;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (origin.y + dir.y * mid <= this.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid)) hi = mid;
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
