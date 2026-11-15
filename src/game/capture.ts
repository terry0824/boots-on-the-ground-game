import * as THREE from 'three';
import type { Team } from './kinds.ts';
import { TEAM_COLOR, type World } from './world.ts';

const NEUTRAL = new THREE.Color(0xd8d8d0);

/**
 * A point to take and hold, PlanetSide style: stand in it with no enemy inside and the bar
 * fills (faster with more of you); an enemy inside freezes it; when it fills, the point is
 * yours. Drawn as a ring on the ground in its owner's color.
 */
export class CapturePoint {
  owner: Team | null;
  /** How far the side taking it has got, 0..1. */
  progress = 0;
  capturer: Team | null = null;
  contested = false;
  readonly counts = new Map<Team, number>();
  onCaptured: ((team: Team, previous: Team | null) => void) | null = null;
  private ring: THREE.Mesh;
  private fill: THREE.Mesh;
  private pulse = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly letter: string,
    readonly position: THREE.Vector3,
    readonly radius: number,
    owner: Team | null,
    private world: World,
    /** Seconds for one soldier to take it; more go faster. */
    readonly captureTime = 14,
  ) {
    this.owner = owner;
    const y = world.terrain.heightAt(position.x, position.z) + 0.35;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.8, radius, 72),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(position.x, y, position.z);
    this.fill = new THREE.Mesh(
      new THREE.CircleGeometry(radius - 0.8, 72),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.fill.rotation.x = -Math.PI / 2;
    this.fill.position.set(position.x, y - 0.05, position.z);
    world.scene.add(this.ring, this.fill);
    this.paint();
  }

  get color(): THREE.Color {
    return this.owner ? TEAM_COLOR[this.owner] : NEUTRAL;
  }

  private paint() {
    const c = this.owner ? TEAM_COLOR[this.owner].clone().multiplyScalar(1.6) : NEUTRAL;
    (this.ring.material as THREE.MeshBasicMaterial).color.copy(c);
    (this.fill.material as THREE.MeshBasicMaterial).color.copy(c);
  }

  /** Who is inside, and the capture moving on. */
  update(dt: number) {
    this.counts.clear();
    for (const u of this.world.unitsNear(this.position.x, this.position.z, this.radius)) {
      if (!u.targetable || u.ignored || u.immobile) continue;
      this.counts.set(u.team, (this.counts.get(u.team) ?? 0) + 1);
    }
    const present = [...this.counts.keys()];
    this.contested = present.length > 1;
    this.pulse += dt;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = this.contested ? 0.5 + 0.4 * Math.abs(Math.sin(this.pulse * 6)) : 0.75;
    if (this.contested) return;
    if (!present.length) {
      // Left alone, a half-taken point slowly reverts.
      this.progress = Math.max(0, this.progress - dt / (this.captureTime * 2));
      if (this.progress === 0) this.capturer = null;
      return;
    }
    const team = present[0];
    if (team === this.owner) {
      this.progress = Math.max(0, this.progress - dt / (this.captureTime * 0.5));
      if (this.progress === 0) this.capturer = null;
      return;
    }
    if (this.capturer !== team) {
      // Someone else's half-finished capture has to be undone first.
      if (this.progress > 0 && this.capturer) {
        this.progress = Math.max(0, this.progress - dt / (this.captureTime * 0.5));
        return;
      }
      this.capturer = team;
    }
    const n = this.counts.get(team) ?? 1;
    this.progress += (dt / this.captureTime) * Math.min(3, 1 + 0.35 * (n - 1));
    if (this.progress >= 1) {
      const previous = this.owner;
      this.owner = team;
      this.progress = 0;
      this.capturer = null;
      this.paint();
      this.onCaptured?.(team, previous);
    }
  }

  /** Is a point (the player) inside? */
  contains(p: THREE.Vector3): boolean {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z) <= this.radius;
  }

  dispose() {
    this.world.scene.remove(this.ring, this.fill);
  }
}
