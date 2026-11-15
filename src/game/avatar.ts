import * as THREE from 'three';
import type { CameraPose } from './camera.ts';
import { lookAtPose } from './camera.ts';
import type { Entity } from './entity.ts';
import type { World } from './world.ts';

export type Crosshair = 'rifle' | 'cannon' | 'artillery' | 'battery' | 'scope' | 'heal' | 'none';

export interface HudBar {
  label: string;
  key?: string;
  /** 0..1 fill. */
  value: number;
  text: string;
  color?: string;
}

export interface AvatarHud {
  title: string;
  hp: number;
  maxHp: number;
  bars: HudBar[];
  crosshair: Crosshair;
  /** Weapon spread in radians, for the crosshair gap. */
  spread: number;
  /** Context action, e.g. "[E] Garrison Bunker". */
  prompt: string | null;
  /** Looking out through a bunker's firing slit. */
  slit?: boolean;
  /** A word under the crosshair: why the weapon won't fire at what it's on (out of range, can't hit flyers). */
  aimNote?: string | null;
}

export interface PlayerStats {
  shots: number;
  hits: number;
  kills: number;
  deaths: number;
}

/**
 * Whatever body the player is in: a soldier, a Howitzer, a vehicle or aircraft (vehicle.ts), the
 * Warship. It reads the input,
 * drives its unit, says where the camera should be, and hands the unit back to the AI when the
 * player leaves.
 */
export interface Avatar {
  readonly kind: 'trooper' | 'tank' | 'warship' | 'vehicle' | 'ride';
  /** The entity being controlled (the Warship has none in the ground simulation). */
  readonly entity: Entity | null;
  readonly position: THREE.Vector3;
  yaw: number;
  pitch: number;
  readonly alive: boolean;
  /** The mouse wheel has pulled out past this body's widest view: rise to command. */
  wantsCommand: boolean;
  /** The mouse's buttons are someone else's this frame (a panel, a placement): no firing or aiming. */
  holdFire: boolean;
  /** Called once per frame for avatars that aren't driven through a unit's controller. */
  tick?(dt: number): void;
  cameraPose(dt: number): CameraPose;
  hud(): AvatarHud;
  /** Extra marks drawn over the 3D view (CSS pixels). */
  drawOverlay?(g: CanvasRenderingContext2D, width: number, height: number): void;
  /** Leaves the body to the AI. */
  release(): void;
  /** The body is gone (it died): clears what the avatar put in the world (markers, reticles). */
  dispose?(): void;
}

const tmp = new THREE.Vector3();

/**
 * Third-person camera over the right shoulder, pulled in when something solid is between the
 * shoulder and the lens.
 */
export function shoulderCamera(
  world: World,
  body: Entity,
  yaw: number,
  pitch: number,
  opts: { distance: number; height: number; side: number; fov: number; lift?: number },
): CameraPose {
  const fwd = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const right = tmp.set(-Math.cos(yaw), 0, Math.sin(yaw));
  const pivot = body.position.clone();
  pivot.y += opts.height;
  const target = pivot.clone().addScaledVector(right, opts.side).addScaledVector(fwd, -opts.distance);
  target.y += opts.lift ?? 0.25;
  const toCam = target.clone().sub(pivot);
  const len = toCam.length();
  if (len > 1e-3) {
    toCam.divideScalar(len);
    const hit = world.raycast(pivot, toCam, len, (e) => e === body || !e.isBuilding);
    if (hit) target.copy(pivot).addScaledVector(toCam, Math.max(0.6, hit.distance - 0.4));
  }
  const ground = world.terrain.heightAt(target.x, target.z) + 0.4;
  if (target.y < ground) target.y = ground;
  return lookAtPose(target, target.clone().add(fwd), opts.fov);
}
