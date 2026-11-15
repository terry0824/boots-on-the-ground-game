// Test-only: drives the player's body by the same inputs a person would give (keys, mouse
// buttons, where the view points), for scripted playthroughs from the browser console:
// `game.drive.walkTo(p)`, `game.drive.shootDead(hound)`, `game.drive.tap('KeyF')`.

import * as THREE from 'three';
import type { Entity } from '../game/entity.ts';
import type { AutopilotHost } from './autopilot.ts';

export interface DriveResult {
  ok: boolean;
  t: number;
  at?: [number, number];
}

export function makeDrive(g: AutopilotHost) {
  const canvas = g.renderer.domElement;
  const key = (code: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  const tap = (code: string) => {
    key(code, true);
    g.step(0.05);
    key(code, false);
    g.step(0.05);
  };
  const mouse = (down: boolean, button = 0) => {
    if (down) canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    else window.dispatchEvent(new MouseEvent('mouseup', { button }));
  };
  const click = (button = 0) => {
    mouse(true, button);
    g.step(0.05);
    mouse(false, button);
    g.step(0.05);
  };
  const body = () => g.avatar as unknown as { yaw: number; pitch?: number; position: THREE.Vector3 } | null;
  /** Points the view at `p`. */
  const lookAt = (p: THREE.Vector3) => {
    const a = body();
    if (!a) return;
    const e = g.camera.position;
    a.yaw = Math.atan2(p.x - e.x, p.z - e.z);
    if (a.pitch !== undefined) a.pitch = Math.atan2(p.y - e.y, Math.hypot(p.x - e.x, p.z - e.z));
  };
  const at = (): [number, number] => {
    const p = body()?.position;
    return p ? [+p.x.toFixed(1), +p.z.toFixed(1)] : [NaN, NaN];
  };
  /**
   * Holds W toward `p` until within `within` meters, stepping aside (as a person would) when
   * something stops it.
   */
  const walkTo = (p: THREE.Vector3, within = 4, maxT = 60): DriveResult => {
    let t = 0;
    let still = 0;
    let detour = 0;
    let side = 1;
    let last = body()?.position.clone() ?? new THREE.Vector3();
    while (t < maxT) {
      const a = body();
      if (!a) break;
      const pos = a.position;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) < within) {
        key('KeyW', false);
        return { ok: true, t: +t.toFixed(1) };
      }
      a.yaw = Math.atan2(p.x - pos.x, p.z - pos.z) + (detour > 0 ? side * 1.2 : 0);
      if (a.pitch !== undefined) a.pitch = -0.05;
      key('KeyW', true);
      g.step(0.1);
      t += 0.1;
      detour -= 0.1;
      still = pos.distanceTo(last) < 0.05 ? still + 0.1 : 0;
      last = pos.clone();
      if (still > 0.8 && detour <= 0) {
        detour = 1.5;
        side = -side;
      }
      if (still > 6) break;
    }
    key('KeyW', false);
    return { ok: false, t: +t.toFixed(1), at: at() };
  };
  /** Holds the trigger on `e`, tracking it, until it dies. */
  const shootDead = (e: Entity, maxT = 15): DriveResult => {
    let t = 0;
    mouse(true);
    while (e.alive && t < maxT) {
      lookAt(e.center(new THREE.Vector3()));
      g.step(0.05);
      t += 0.05;
    }
    mouse(false);
    return { ok: !e.alive, t: +t.toFixed(2) };
  };
  /** Runs the game for `seconds`, a tenth at a time. */
  const wait = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.1) g.step(0.1);
  };
  return { key, tap, mouse, click, lookAt, walkTo, shootDead, wait, at };
}
