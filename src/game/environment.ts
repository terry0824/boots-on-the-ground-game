import * as THREE from 'three';

// How a planet looks: its sky, its light, its haze. The game's own battlefield has its own (below); a
// plugin's maps bring theirs (src/content/provider.ts \`environment\`).

/** How a planet looks: its sky, its light, its haze. */
export interface Environment {
  /** The sky dome (follows the camera), or null to keep the procedural sky. */
  sky: THREE.Object3D | null;
  /** The haze color at the horizon, matched to the sky so the ground dissolves into it. */
  fog: THREE.Color;
  /** Toward the sun (world, normalized). */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyLight: THREE.Color;
  groundLight: THREE.Color;
  ambientIntensity: number;
  /** The tileset's back light (toward it), a rim of color from behind: Scoria's lava glow. */
  backDir: THREE.Vector3;
  backColor: THREE.Color;
  backIntensity: number;
  /** The procedural sky's top color, where the tileset has no sky dome. */
  zenith: THREE.Color | null;
  /** How much thicker than usual the haze is. */
  fogScale: number;
}

/** A planet's light: key (the sun), fill and back lights, and the ambient. */
export interface Light {
  /** Toward the sun (world, normalized). */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyLight: THREE.Color;
  groundLight: THREE.Color;
  /** Toward the back light, a rim of color from behind. */
  backDir: THREE.Vector3;
  backColor: THREE.Color;
  backIntensity: number;
}

/** The game's own battlefield's light: a warm afternoon sun over a dusty plateau, no back light. */
export function defaultLight(): Light {
  return {
    sunDir: new THREE.Vector3(-0.72, 0.68, -0.12).normalize(),
    sunColor: new THREE.Color(0.9, 0.77, 0.66),
    sunIntensity: 3.1,
    skyLight: new THREE.Color(0.52, 0.47, 0.4),
    groundLight: new THREE.Color(0.26, 0.18, 0.16).multiplyScalar(3),
    backDir: new THREE.Vector3(-0, 1, 0).normalize(),
    backColor: new THREE.Color(0, 0, 0),
    backIntensity: 0,
  };
}

/** The game's own battlefield's sky: the procedural sky, a sandy haze. */
export function defaultEnvironment(): Environment {
  return { sky: null, fog: new THREE.Color(0xc9a57f), zenith: null, fogScale: 1, ...defaultLight(), ambientIntensity: 1.6 };
}
