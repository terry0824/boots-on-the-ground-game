// Test-only: plays the mission headlessly. As a Trooper it heads for the nearest bunker with
// room and fights from the slit, aims at the nearest visible enemy, calls the Keel Gun on
// Tuskers, falls back to the Holdfast when the swarm breaks in, and after losing a
// body takes over the Trooper closest to the fighting (or redeploys). With `player: 'none'` it
// rises to command and lets the AI hold the line alone, as a baseline.

import * as THREE from 'three';
import type { Avatar, PlayerStats } from '../game/avatar.ts';
import type { BunkerGuns } from '../game/brains.ts';
import type { EchoSquad } from '../game/echo.ts';
import type { Entity, Unit } from '../game/entity.ts';
import { TrooperAvatar } from '../game/trooper.ts';
import type { Mission } from '../game/mission.ts';
import type { World } from '../game/world.ts';

export interface AutopilotHost {
  world: World;
  mission: Mission;
  readonly avatar: Avatar | null;
  readonly mode: string;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  stats: PlayerStats;
  step(seconds: number): void;
  redeploy(): void;
  possess(target: Unit): void;
  toCommand(transition: number, at: THREE.Vector3): void;
  /** Echo Squad, when the mission has it: the autopilot gets downed squadmates up, as a player would. */
  echo?: EchoSquad;
}

export type AutopilotPlayer = 'trooper' | 'none';

export function runMission(g: AutopilotHost, maxSeconds = 900, player: AutopilotPlayer = 'trooper', fastCountdown = true): string[] {
  const canvas = g.renderer.domElement;
  const log: string[] = [];
  let firing = false;
  const setFire = (on: boolean) => {
    if (on === firing) return;
    firing = on;
    if (on) canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    else window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  };
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF'];
  const press = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const releaseAll = () => {
    for (const k of keys) window.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
  };
  /** Holds the movement keys that walk a body facing `yaw` toward (dx, dz). */
  const walk = (yaw: number, dx: number, dz: number) => {
    const fwd = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const right = -dx * Math.cos(yaw) + dz * Math.sin(yaw);
    if (fwd > 2) press('KeyW');
    if (fwd < -2) press('KeyS');
    if (right > 2) press('KeyD');
    if (right < -2) press('KeyA');
  };
  const crawlNear = (p: THREE.Vector3, r: number) =>
    g.world.entities.filter((e) => e.team === 'crawl' && e.targetable && e.position.distanceTo(p) < r).length;

  /** The next body after a death: the Trooper nearest the worst of the fighting. */
  const nextBody = (): Unit | null => {
    const cc = g.mission.holdfast!;
    const threat = g.world.entities
      .filter((e) => e.team === 'crawl' && e.targetable)
      .sort((a, b) => a.position.distanceTo(cc.position) - b.position.distanceTo(cc.position))[0];
    const at = threat?.position ?? cc.position;
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const e of g.world.entities) {
      if (e.team !== 'holdouts' || e.isBuilding || !e.alive || e.stowed || e.kind.name !== 'trooper') continue;
      const d = e.position.distanceTo(at);
      if (d < bestD) {
        bestD = d;
        best = e as Unit;
      }
    }
    return best;
  };

  const play = () => {
    releaseAll();
    const p = g.avatar;
    if (!(p instanceof TrooperAvatar)) {
      setFire(false);
      if (g.mode === 'command' && player === 'trooper') {
        const body = nextBody();
        if (body) g.possess(body);
        else g.redeploy();
      }
      return;
    }
    const u = p.unit;
    const eye = g.camera.position.clone();
    let best: { d: THREE.Vector3; dist: number } | null = null;
    for (const z of g.world.entities) {
      if (z.team !== 'crawl' || !z.targetable || z.position.distanceTo(u.position) > 90) continue;
      const d = z.center(new THREE.Vector3()).sub(eye);
      const dist = d.length();
      d.normalize();
      const hit = g.world.raycast(eye, d, dist + 2, (e: Entity) => e === u || e === p.garrison || (e.team === 'holdouts' && !e.isBuilding));
      if (hit?.entity === z && (!best || dist < best.dist)) best = { d, dist };
    }
    // Save the Warship's cannon for the biggest thing on the field, once it's charged (F
    // checks the charge before it calls; so does this).
    const ultra = g.world.entities.find((e) => e.kind.name === 'tusker' && e.targetable && e.position.distanceTo(u.position) < 160);
    if (ultra && p.onKeelGun && !p.canUltimate?.()) p.onKeelGun(ultra, ultra.center(new THREE.Vector3()));
    // The mission's own key (the artifact's Aurora) when the swarm is at the walls.
    if (g.mission.script?.action && crawlNear(g.mission.holdfast!.position, 90) > 14) g.mission.script.action();

    // A squadmate down close by: out of the bunker and over to them, E held until they're up.
    const down = g.echo?.slots
      .filter((s) => s.state === 'down' && s.unit.position.distanceTo(u.position) < 45)
      .sort((a, b) => a.unit.position.distanceTo(u.position) - b.unit.position.distanceTo(u.position))[0];
    if (down) {
      const to = down.unit.position;
      // Aim first (keys are read against where the body faces), then move.
      if (best) {
        p.yaw = Math.atan2(best.d.x, best.d.z);
        p.pitch = Math.atan2(best.d.y, Math.hypot(best.d.x, best.d.z));
      } else {
        p.yaw = Math.atan2(to.x - u.position.x, to.z - u.position.z);
        p.pitch = 0;
      }
      setFire(!!best);
      if (p.garrison) return press('KeyF');
      const gap = Math.hypot(to.x - u.position.x, to.z - u.position.z) - u.radius - down.unit.radius;
      if (gap < 2) press('KeyF');
      else walk(p.yaw, to.x - u.position.x, to.z - u.position.z);
      return;
    }

    const cc = g.mission.holdfast!;
    const breach = crawlNear(cc.position, 70) > 0;
    if (!p.garrison) {
      // Fall back to the Holdfast when the swarm gets inside the base; otherwise make
      // for the nearest bunker with a free slot and climb in.
      let goal: THREE.Vector3 | null = null;
      if (breach) {
        if (u.position.distanceTo(cc.position) > 35) goal = cc.position;
      } else {
        const bunker = g.world.entities
          .filter((e) => e.isBuilding && e.alive && e.kind.name === 'bunker' && (e.controller as BunkerGuns | null)?.hasRoom)
          .sort((a, b) => a.position.distanceTo(u.position) - b.position.distanceTo(u.position))[0];
        if (bunker) {
          if (u.position.distanceTo(bunker.position) - bunker.radius < 3.5) press('KeyF');
          else goal = bunker.position;
        }
      }
      if (goal && !best) {
        p.yaw = Math.atan2(goal.x - u.position.x, goal.z - u.position.z);
        p.pitch = 0;
        press('KeyW');
      } else if (goal) walk(p.yaw, goal.x - u.position.x, goal.z - u.position.z);
    }
    if (!best) return setFire(false);
    p.yaw = Math.atan2(best.d.x, best.d.z);
    p.pitch = Math.atan2(best.d.y, Math.hypot(best.d.x, best.d.z));
    setFire(true);
  };

  const m = g.mission;
  if (player === 'none') g.toCommand(0.01, m.holdfast!.position);
  let lastWave = -1;
  const t0 = performance.now();
  const start = g.world.time;
  let worst = 0;
  let ccLow = m.holdfast!.hp;
  while (g.world.time - start < maxSeconds && m.phase !== 'victory' && m.phase !== 'defeat') {
    play();
    const f0 = performance.now();
    g.step(0.1);
    worst = Math.max(worst, (performance.now() - f0) / 3);
    ccLow = Math.min(ccLow, m.holdfast!.hp);
    if (fastCountdown && m.phase === 'countdown' && m.countdown > 2) m.countdown = 2;
    if (m.wave !== lastWave) {
      lastWave = m.wave;
      const s = g.stats;
      const holdouts = g.world.entities.filter((e) => e.team === 'holdouts' && e.alive && !e.isBuilding).length;
      const buildings = g.world.entities.filter((e) => e.team === 'holdouts' && e.alive && e.isBuilding).length;
      log.push(`t=${g.world.time.toFixed(0)}s wave ${m.wave + 1}: Holdfast ${m.holdfast!.hp.toFixed(0)} hp (low ${ccLow.toFixed(0)}), kills ${s.kills}, deaths ${s.deaths}, holdout units ${holdouts}, buildings ${buildings}`);
      ccLow = m.holdfast!.hp;
    }
  }
  setFire(false);
  releaseAll();
  log.push(`end: ${m.phase} at t=${g.world.time.toFixed(0)}s, Holdfast ${m.holdfast!.hp.toFixed(0)} hp (low ${ccLow.toFixed(0)}), ${m.enemiesLeft} enemies left, player kills ${g.stats.kills} (${((performance.now() - t0) / 1000).toFixed(1)}s wall clock, worst sim step ${worst.toFixed(1)} ms)`);
  return log;
}

/**
 * Plays a scripted assault (Saltwell Rising) as a Trooper: follows the mission's waypoint along
 * a flow field, stops to fight whatever enemy is nearest and in reach, redeploys after a death.
 */
export async function runAssault(g: AutopilotHost & { readonly avatar: Avatar | null }, maxSeconds = 600): Promise<string[]> {
  const { FlowField } = await import('../game/flowfield.ts');
  const canvas = g.renderer.domElement;
  const log: string[] = [];
  const w = g.world;
  const m = g.mission;
  let firing = false;
  const setFire = (on: boolean) => {
    if (on === firing) return;
    firing = on;
    if (on) canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    else window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  };
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
  const releaseAll = () => {
    for (const k of keys) window.dispatchEvent(new KeyboardEvent('keyup', { code: k }));
  };
  let field: InstanceType<typeof FlowField> | null = null;
  let fieldFor = new THREE.Vector3(Infinity, 0, 0);
  const dir = new THREE.Vector2();
  const t0 = performance.now();
  let nextLog = 0;
  let deadSince = -1;
  const skip = new Map<Entity, number>();
  let engaged: { target: Entity | null; hp: number; since: number } = { target: null, hp: 0, since: 0 };
  for (let t = 0; t < maxSeconds && m.phase !== 'victory' && m.phase !== 'defeat'; t += 0.1) {
    releaseAll();
    const a = g.avatar;
    if (!a || !(a instanceof TrooperAvatar) || !a.alive) {
      setFire(false);
      if (deadSince < 0) deadSince = w.time;
      if (w.time - deadSince > 6.5) {
        g.redeploy();
        deadSince = -1;
      }
      g.step(0.1);
      continue;
    }
    const u = a.unit;
    const goal = m.waypoint?.position;
    if (goal && goal.distanceTo(fieldFor) > 4) {
      field = new FlowField(w.terrain.size, w.terrain.pathCell);
      field.setTerrain((x, z) => w.terrain.walkable(x, z));
      // A goal on a structure (a tower to destroy) mustn't be walled in by that structure.
      const obstacles = w.buildings.filter((b) => b.position.distanceTo(goal) > b.radius + 8).map((b) => ({ x: b.position.x, z: b.position.z, r: b.radius }));
      field.compute([{ x: goal.x, z: goal.z, r: 12 }], obstacles);
      fieldFor = goal.clone();
    }
    // The nearest enemy in reach (structures only when they're the objective), skipping any
    // we've been shooting without effect (out of sight on a cliff).
    let target: Entity | null = null;
    let best = 30;
    for (const e of w.entities) {
      if (!e.targetable || e.team === 'holdouts' || (e.isBuilding && e.ignored) || (skip.get(e) ?? 0) > w.time) continue;
      const d = e.position.distanceTo(u.position);
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (target) {
      if (target !== engaged.target) engaged = { target, hp: target.hp, since: w.time };
      else if (target.hp < engaged.hp) engaged = { target, hp: target.hp, since: w.time };
      else if (w.time - engaged.since > 4) skip.set(target, w.time + 20);
      const c = target.center(new THREE.Vector3());
      const eye = g.camera.getWorldPosition(new THREE.Vector3());
      a.yaw = Math.atan2(c.x - u.position.x, c.z - u.position.z);
      a.pitch = Math.atan2(c.y - eye.y, Math.hypot(c.x - eye.x, c.z - eye.z));
      setFire(true);
    } else setFire(false);
    const far = goal ? Math.hypot(goal.x - u.position.x, goal.z - u.position.z) : 0;
    if (goal && far > 5 && (!target || best > 18)) {
      if (field && field.direction(u.position.x, u.position.z, dir)) {
        if (!target) a.yaw = Math.atan2(dir.x, dir.y);
        const fwd = dir.x * Math.sin(a.yaw) + dir.y * Math.cos(a.yaw);
        const right = -dir.x * Math.cos(a.yaw) + dir.y * Math.sin(a.yaw);
        if (fwd > 0.3) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        if (fwd < -0.3) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }));
        if (right > 0.3) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
        if (right < -0.3) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
      }
    }
    g.step(0.1);
    if (w.time >= nextLog) {
      nextLog = w.time + 15;
      const st = [...m.status.entries()].map(([k, v]) => `${k}:${v[0]}`).join(' ');
      const pts = m.points.map((p) => `${p.letter}=${p.owner?.[0] ?? '-'}${p.capturer ? `>${p.capturer[0]}${Math.round(p.progress * 100)}` : ''}`).join(' ');
      const dom = w.entities.filter((e) => e.alive && e.team === 'directorate' && !e.isBuilding).length;
      const ours = w.entities.filter((e) => e.alive && e.team === 'holdouts' && !e.isBuilding).length;
      log.push(`t=${w.time.toFixed(0)} ${st} | ${pts} | wp=${m.waypoint?.label ?? '-'} ${far.toFixed(0)}m | hp=${u.hp.toFixed(0)} kills=${g.stats.kills} deaths=${g.stats.deaths} | ours=${ours} dominion=${dom}`);
    }
  }
  setFire(false);
  releaseAll();
  log.push(`end: ${m.phase} at t=${w.time.toFixed(0)} (${((performance.now() - t0) / 1000).toFixed(1)}s wall) kills=${g.stats.kills} deaths=${g.stats.deaths}`);
  return log;
}
