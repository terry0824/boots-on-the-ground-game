import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import { shoulderCamera, type Avatar, type AvatarHud, type HudBar, type PlayerStats } from './avatar.ts';
import { view, type CameraPose } from './camera.ts';
import type { Entity, Unit } from './entity.ts';
import { holdOf } from './systems/transport.ts';
import type { World } from './world.ts';

const SENSITIVITY = 0.002;

/**
 * The player aboard a transport someone else flies (a Dustoff pulling a line out): a seat with a
 * view, the camera round the transport, nothing to fly or fire. Their body is in the hold, so it
 * goes where the hold goes: set down at the drop (and the player is back in it), or lost with
 * the transport if it's shot down.
 */
export class RideAvatar implements Avatar {
  readonly kind = 'ride';
  yaw: number;
  pitch = -0.3;
  distance: number;
  wantsCommand = false;
  holdFire = true;

  constructor(
    readonly transport: Unit,
    /** The player's body, stowed in the transport's hold. */
    readonly body: Unit,
    private input: Input,
    private world: World,
    readonly stats: PlayerStats,
    /** Where it's taking them, for the HUD. */
    private where: () => string,
  ) {
    this.yaw = transport.yaw;
    this.distance = Math.max(14, transport.radius * 5);
  }

  /** The player is their body, aboard. */
  get entity(): Entity {
    return this.body;
  }

  get position(): THREE.Vector3 {
    return this.transport.position;
  }

  get alive(): boolean {
    return this.body.alive;
  }

  /** Set down (or the transport gone): the seat is empty. */
  get over(): boolean {
    return !this.body.stowed || !this.transport.alive;
  }

  tick() {
    const { dx, dy, wheel } = this.input.consume();
    this.yaw -= dx * SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * SENSITIVITY, -1.2, 0.4);
    if (wheel) {
      this.distance = THREE.MathUtils.clamp(this.distance + wheel * 3, 10, 60);
      if (wheel > 0 && this.distance >= 60) this.wantsCommand = true;
    }
    this.holdFire = true;
  }

  cameraPose(): CameraPose {
    const t = this.transport;
    return shoulderCamera(this.world, t, this.yaw, this.pitch, { distance: this.distance, height: t.base + t.height, side: 0, fov: view.fov, lift: 2 });
  }

  hud(): AvatarHud {
    const hold = holdOf(this.transport);
    const bars: HudBar[] = hold ? [{ label: 'Aboard', value: hold.used / hold.spec.space, text: `${hold.cargo.length} aboard · ${hold.used}/${hold.spec.space}`, color: 'linear-gradient(90deg, #5aa8ff, #bfe4ff)' }] : [];
    return {
      title: `Aboard the ${this.transport.name ?? 'Dustoff'}`,
      hp: this.body.hp,
      maxHp: this.body.maxHp,
      bars,
      crosshair: 'none',
      spread: 0,
      prompt: `On the way ${this.where()} · you're set down there`,
    };
  }

  release() {}
}
