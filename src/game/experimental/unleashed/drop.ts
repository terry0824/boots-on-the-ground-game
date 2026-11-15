import * as THREE from 'three';
import type { CameraPose } from '../../script.ts';
import { HeroVisual } from '../../visual.ts';
import { TEAM_COLOR, type World } from '../../world.ts';

/**
 * The opening's cinematic beat: a flying Barracks comes in low over the line and
 * sets down behind it on its own landing animation, seen from the ground among the soldiers;
 * then from inside, the doors open on the swarm and the Lanterns hanging over it; then the
 * player steps out. About thirteen seconds, and any key skips it. Afterwards the Barracks lifts
 * off and flies home.
 */

/** Seconds: the flight in, the landing, the doors, and how long it waits before it goes. */
const FLIGHT = 6;
const LANDING = 2.6;
const DOORS = 4;
const WAIT = 14;
const LIFT = 9;
/** Where it comes from: this far back toward the base and this high, meters. */
const FROM = { back: 380, up: 140 };
/** How high it hovers before setting down. */
const HOVER = 9;

export type DropStage = 'flight' | 'landing' | 'doors' | 'down' | 'gone';

export class BarracksDrop {
  private t = 0;
  private v: HeroVisual;
  private scale: number;
  private from: THREE.Vector3;
  private yaw: number;
  stage: DropStage = 'flight';
  private shook = false;
  private roared = false;
  private finished = false;

  /**
   * Lands at `at`, its doors toward `out` (the swarm's side); `side` is across the line, for the
   * shot from among the soldiers.
   */
  constructor(
    private world: World,
    readonly at: THREE.Vector3,
    private out: THREE.Vector3,
    private line: THREE.Vector3,
  ) {
    const t = world.models.barracks;
    this.scale = world.scaleOf('barracks');
    this.v = new HeroVisual(t.instantiate(TEAM_COLOR.holdouts), world.scene);
    this.v.play('Fly Walk');
    this.from = at.clone().addScaledVector(out, -FROM.back);
    this.from.y = world.terrain.heightAt(this.from.x, this.from.z) + FROM.up;
    this.yaw = Math.atan2(out.x, out.z);
    this.place(this.from);
  }

  /** Where the player steps out: just outside its doors, facing the swarm. */
  door(): THREE.Vector3 {
    const t = this.world.models.barracks;
    const depth = (t.bounds.max.z - t.bounds.min.z) * this.scale * 0.5;
    return this.at.clone().addScaledVector(this.out, depth + 3);
  }

  private place(p: THREE.Vector3) {
    this.v.sync(p, this.yaw, this.scale);
  }

  private ground(): number {
    return this.world.terrain.heightAt(this.at.x, this.at.z);
  }

  /**
   * Steps it; `skip` ends the shots now. Returns the camera's pose while the beat lasts, null once
   * the player has control.
   */
  update(dt: number, skip: boolean): CameraPose | null {
    if (this.finished) return null;
    const w = this.world;
    this.t += dt;
    const shown = this.stage === 'flight' || this.stage === 'landing' || this.stage === 'doors';
    if (shown && skip) {
      this.t = FLIGHT + LANDING + DOORS;
      this.v.play('Stand');
    }
    const g = this.ground();
    const p = new THREE.Vector3();
    if (this.t < FLIGHT) {
      // In low over the line, slowing as it comes.
      const k = 1 - Math.pow(1 - this.t / FLIGHT, 2.2);
      p.lerpVectors(this.from, new THREE.Vector3(this.at.x, g + HOVER, this.at.z), k);
      this.place(p);
    } else if (this.t < FLIGHT + LANDING) {
      if (this.stage === 'flight') {
        this.stage = 'landing';
        this.v.play('Fly End', { loop: false });
        w.audio.play('jetLand', { at: this.at, volume: 1 });
      }
      const k = (this.t - FLIGHT) / LANDING;
      p.set(this.at.x, g + HOVER * (1 - THREE.MathUtils.smoothstep(k, 0, 1)), this.at.z);
      this.place(p);
      if (k > 0.85 && !this.shook) {
        this.shook = true;
        w.effects.shake = Math.max(w.effects.shake, 0.5);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          w.effects.smoke(this.at.clone().add(new THREE.Vector3(Math.cos(a) * 12, g + 1, Math.sin(a) * 12)), 6, 0x9a8a78, 2.5);
        }
      }
    } else if (this.t < FLIGHT + LANDING + DOORS) {
      if (this.stage === 'landing' || this.stage === 'flight') {
        this.stage = 'doors';
        this.v.play('Stand');
        this.place(new THREE.Vector3(this.at.x, g, this.at.z));
      }
      if (!this.roared && this.t > FLIGHT + LANDING + 1.2) {
        this.roared = true;
        w.audio.play('tuskerRoar', { volume: 0.8 });
      }
    } else if (this.t < FLIGHT + LANDING + DOORS + WAIT) {
      this.stage = 'down';
    } else if (this.t < FLIGHT + LANDING + DOORS + WAIT + LIFT) {
      // Back up and home.
      if (this.stage === 'down') {
        this.stage = 'gone';
        this.v.play('Fly Start', { loop: false });
      }
    }
    if (this.stage === 'gone') {
      const k = (this.t - (FLIGHT + LANDING + DOORS + WAIT)) / LIFT;
      if (k >= 1) {
        this.v.dispose();
        this.finished = true;
        return null;
      }
      const up = new THREE.Vector3(this.at.x, g, this.at.z).lerp(this.from, Math.pow(k, 2));
      this.place(up);
    }
    this.v.update(dt);
    return shown && !skip ? this.shot() : null;
  }

  /** Where the camera is for the shot under way. */
  private shot(): CameraPose | null {
    const w = this.world;
    const ship = this.v.instance.object.position;
    const side = new THREE.Vector3(-this.out.z, 0, this.out.x);
    if (this.t < FLIGHT - 0.5) {
      // From the ground in front of the line: looking up as it comes in over the soldiers' heads.
      const from = this.line.clone().addScaledVector(this.out, 6).addScaledVector(side, 22);
      from.y = w.terrain.heightAt(from.x, from.z) + 1.7;
      return { from, to: ship.clone().add(new THREE.Vector3(0, 4, 0)), fov: 72 };
    }
    if (this.t < FLIGHT + LANDING + 0.4) {
      // Setting down, from the ground beside where it lands, the line behind it.
      const from = this.at.clone().addScaledVector(this.out, 30).addScaledVector(side, 34);
      from.y = w.terrain.heightAt(from.x, from.z) + 2.2;
      return { from, to: ship.clone().add(new THREE.Vector3(0, 6, 0)), fov: 64 };
    }
    // At the doors, from just inside: the swarm's side through the opening, the Lanterns over it.
    const from = this.door().addScaledVector(this.out, -3.5);
    from.y = this.ground() + 2.3;
    const to = this.door().addScaledVector(this.out, 220);
    to.y = w.terrain.heightAt(to.x, to.z) + 34;
    return { from, to, fov: 62 };
  }

  /** The doors are open: the player has the body. */
  get open(): boolean {
    return this.stage === 'down' || this.stage === 'gone';
  }
}
