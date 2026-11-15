import * as THREE from 'three';
import type { MapTerrain } from '../engine/mapterrain.ts';
import type { MapData, Placement } from '../engine/mapdata.ts';

/** A spot and a facing (radians, our convention: 0 faces +Z). */
export interface Spot {
  x: number;
  z: number;
  yaw: number;
}

/** One approach to the base: where the swarm comes from and who holds it. */
export interface Lane {
  /** Where this lane's Crawl appear (they spread around it). */
  spawn: THREE.Vector3;
  spawnSpread: number;
  bunker: Spot | null;
  /** A Howitzer's post, braced, behind the bunker. */
  tank: THREE.Vector3 | null;
  /** Where the lane's squad of Troopers stands. */
  posts: THREE.Vector3[];
}

/** Everything a defense mission needs to know about where things go on its map. */
export interface Layout {
  holdfast: Spot;
  barracks: Spot[];
  depots: Spot[];
  turrets: Spot[];
  lanes: Lane[];
  /** Tanks held back in Drive Mode near the Holdfast. */
  reserveTanks: Spot[];
  /** Radius of the base perimeter (where the Warship starts firing). */
  perimeter: number;
}

/** The procedural Hold the Line map: a plateau with three ramps. */
export function proceduralLayout(ramps: number[]): Layout {
  return {
    holdfast: { x: 0, z: 0, yaw: Math.PI },
    barracks: [
      { x: -58, z: -42, yaw: 0.4 },
      { x: 58, z: -42, yaw: -0.4 },
    ],
    depots: [[-28, 52], [-12, 58], [28, 52], [12, 58], [-62, 8], [62, 8]].map(([x, z]) => ({ x, z, yaw: 0 })),
    turrets: [],
    lanes: ramps.map((a, i) => {
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const posts: THREE.Vector3[] = [];
      for (let k = 0; k < 8; k++) {
        const side = (k - 3.5) * 4.2;
        const row = k % 2 ? 4 : 0;
        posts.push(new THREE.Vector3(dx * (92 - row) - dz * side, 0, dz * (92 - row) + dx * side));
      }
      return {
        spawn: new THREE.Vector3(dx * 300, 0, dz * 300),
        spawnSpread: 40,
        bunker: { x: dx * 100, z: dz * 100, yaw: -a + Math.PI / 2 },
        tank: new THREE.Vector3(dx * 66 + dz * (i % 2 ? 14 : -14), 0, dz * 66 - dx * (i % 2 ? 14 : -14)),
        posts,
      };
    }),
    reserveTanks: [-26, 26].map((x) => ({ x, z: -34, yaw: Math.PI })),
    perimeter: 135,
  };
}

/** Map facing (0 = east, counterclockwise) as our yaw. */
export function mapYaw(rotation: number): number {
  return rotation + Math.PI / 2;
}

/**
 * The layout of a real map (the loader's), read from what the map places: player 1's Holdfast,
 * Barracks, Storehouses, Flak Towers and Bunkers, and the enemy's start locations and
 * nests as the swarm's sources. Units by the game's names (`own`, where the map was made for
 * another game's). Each bunker becomes a lane facing the nearest source; its
 * tank and squad stand behind it, toward the Holdfast.
 */
export function mapLayout(map: MapData, terrain: MapTerrain, player = 1): Layout {
  const units = map.placements.filter((p) => p.kind === 'unit');
  const typeOf = (u: Placement) => u.own ?? u.type;
  const mine = (type: string) => units.filter((u) => u.player === player && typeOf(u) === type);
  const spot = (p: Placement): Spot => {
    const w = terrain.toWorld(p.x, p.y);
    return { x: w.x, z: w.z, yaw: mapYaw(p.rotation) };
  };
  const cc = mine('Holdfast')[0] ?? units.find((u) => typeOf(u) === 'Holdfast');
  const ccSpot = cc ? spot(cc) : { x: 0, z: 0, yaw: 0 };
  const ccPos = new THREE.Vector3(ccSpot.x, 0, ccSpot.z);

  // Where the swarm comes from: enemy start locations and nests, far from our base.
  const points = map.placements.filter((p) => p.kind === 'point' && p.type === 'StartLoc' && !/player0?1\b/i.test(p.name));
  const nests = units.filter((u) => typeOf(u) === 'Nest' && u.player !== player);
  const sources = [...points, ...nests]
    .map((p) => terrain.toWorld(p.x, p.y))
    .filter((v, i, all) => all.findIndex((o) => o.distanceTo(v) < 60) === i)
    .filter((v) => v.distanceTo(ccPos) > 150);
  if (!sources.length) sources.push(new THREE.Vector3(-ccPos.x, 0, -ccPos.z));

  const lanes: Lane[] = mine('Bunker').map((b) => {
    const bs = spot(b);
    const bp = new THREE.Vector3(bs.x, 0, bs.z);
    const spawn = sources.reduce((best, s) => (s.distanceTo(bp) < best.distanceTo(bp) ? s : best), sources[0]);
    // Face the bunker toward the threat; the squad and tank stand behind it.
    const out = new THREE.Vector3().subVectors(spawn, bp).setY(0).normalize();
    const back = new THREE.Vector3().subVectors(ccPos, bp).setY(0).normalize();
    const side = new THREE.Vector3(-out.z, 0, out.x);
    const posts: THREE.Vector3[] = [];
    for (let k = 0; k < 8; k++) {
      const s = (k - 3.5) * 4.2;
      const row = 12 + (k % 2) * 4;
      posts.push(bp.clone().addScaledVector(back, row).addScaledVector(side, s));
    }
    return {
      spawn,
      spawnSpread: 30,
      bunker: { x: bs.x, z: bs.z, yaw: Math.atan2(out.x, out.z) },
      tank: bp.clone().addScaledVector(back, 34).addScaledVector(side, 10),
      posts,
    };
  });

  return {
    holdfast: ccSpot,
    barracks: mine('Barracks').map(spot),
    depots: mine('Storehouse').map(spot),
    turrets: mine('FlakTower').map(spot),
    lanes,
    reserveTanks: [ccPos.clone().add(new THREE.Vector3(30, 0, 30)), ccPos.clone().add(new THREE.Vector3(-30, 0, 30))].map((v) => ({ x: v.x, z: v.z, yaw: 0 })),
    perimeter: Math.max(140, ...lanes.map((l) => (l.bunker ? Math.hypot(l.bunker.x - ccPos.x, l.bunker.z - ccPos.z) + 30 : 0))),
  };
}
