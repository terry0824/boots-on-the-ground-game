import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import { GuardBrain } from './brains.ts';
import type { Warship } from './warship.ts';
import { lookAtPose, type CameraPose } from './camera.ts';
import { isCommandable, type Entity, type Unit } from './entity.ts';
import { beginBrace, beginUnbrace, isTank, tankMode, TankBrain } from './tank.ts';
import type { World } from './world.ts';

const MIN_HEIGHT = 45;
const MAX_HEIGHT = 340;
const NAMES: Record<string, string> = {
  trooper: 'Trooper',
  howitzer: 'Howitzer',
  howitzerMobile: 'Howitzer',
  bunker: 'Bunker',
  barracks: 'Barracks',
  holdfast: 'Holdfast',
  storehouse: 'Storehouse',
};

export type Possessable = Unit | Warship;

/** How far past a unit's own size on screen a click still picks it, pixels. */
const PICK_MARGIN = 14;
/** Seconds a unit the player orders somewhere has right of way among its own side, getting there. */
const ORDER_RIGHT_OF_WAY = 20;

/**
 * The commander's seat: an RTS camera over the battlefield. Select with click or drag,
 * right-click to send units, double-click (or P) to dive into one and fight as it.
 */
export class CommandView {
  readonly target = new THREE.Vector3();
  height = 170;
  readonly selected = new Set<Entity>();
  bcSelected = false;
  private drag: { x: number; y: number } | null = null;
  private rings: THREE.Mesh[] = [];
  private markers: { mesh: THREE.Mesh; life: number }[] = [];
  private ringGeometry = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
  private ctx: CanvasRenderingContext2D;
  private active = false;
  /** Hooks into the game. */
  onRedeploy: (() => void) | null = null;
  /** Whether the player can take this unit (its kind, and the mission's rules for vehicles). */
  canTake: (u: Unit) => boolean = () => true;
  /** A right-click with the Warship selected: true if the game handled it (a call-in), else it's sent to circle there. */
  onShipOrder: ((at: THREE.Vector3) => boolean) | null = null;

  constructor(
    private world: World,
    private input: Input,
    private camera: THREE.PerspectiveCamera,
    private bc: Warship,
    private overlay: HTMLCanvasElement,
  ) {
    this.ctx = overlay.getContext('2d')!;
  }

  focus(at: THREE.Vector3) {
    this.target.set(at.x, 0, at.z);
  }

  show(on: boolean) {
    this.active = on;
    if (!on) {
      for (const r of this.rings) r.visible = false;
      this.drag = null;
      this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
  }

  private pitch(): number {
    const t = (this.height - MIN_HEIGHT) / (MAX_HEIGHT - MIN_HEIGHT);
    return THREE.MathUtils.lerp(0.95, 1.2, THREE.MathUtils.clamp(t, 0, 1));
  }

  /**
   * The level the camera keeps its height over: the battlefield's typical ground (the median of
   * where units can walk), so it glides level over ridges and hollows rather than riding them up
   * and down as a terrain-following camera does.
   */
  private datum(): number {
    if (this.level !== null) return this.level;
    const t = this.world.terrain;
    const heights: number[] = [];
    for (let x = -400; x <= 400; x += 16) for (let z = -400; z <= 400; z += 16) if (t.walkable(x, z)) heights.push(t.heightAt(x, z));
    heights.sort((a, b) => a - b);
    return (this.level = heights.length ? heights[Math.floor(heights.length / 2)] : 0);
  }
  private level: number | null = null;

  cameraPose(): CameraPose {
    const look = new THREE.Vector3(this.target.x, this.datum(), this.target.z);
    // An RTS camera: north (+Z) at the top of the screen, looking down at an angle.
    const pos = look.clone().add(new THREE.Vector3(0, this.height, -this.height / Math.tan(this.pitch())));
    // Never inside a mountain when zoomed right in.
    pos.y = Math.max(pos.y, this.world.terrain.heightAt(pos.x, pos.z) + 12);
    return lookAtPose(pos, look, 45);
  }

  /** Ground point (and nearby friendly) under a screen position. */
  private pick(x: number, y: number): { point: THREE.Vector3 | null; unit: Entity | null; ship: boolean } {
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // The Warship first: it's in the sky, above everything else.
    const ship = this.bc.position.clone().project(this.camera);
    const sx = ((ship.x + 1) / 2) * window.innerWidth;
    const sy = ((1 - ship.y) / 2) * window.innerHeight;
    if (ship.z < 1 && Math.hypot(sx - x, sy - y) < 70) return { point: null, unit: null, ship: true };
    const t = this.world.terrain.raycast(ray.ray.origin, ray.ray.direction, 6000);
    const point = t === null ? null : ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
    // Whatever of ours is drawn nearest the cursor, by where it is on screen: an aircraft is drawn
    // high over the ground under it, so the ground point would miss it. Within its own size there
    // and a margin, the nearest wins.
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const c = new THREE.Vector3();
    const edge = new THREE.Vector3();
    let best: Entity | null = null;
    let bestD = PICK_MARGIN;
    for (const e of this.world.entities) {
      if (!e.targetable || e.team !== 'holdouts') continue;
      e.center(c);
      edge.copy(c).addScaledVector(up, Math.max(e.radius, e.height * 0.5));
      c.project(this.camera);
      if (c.z >= 1) continue;
      edge.project(this.camera);
      const sx = ((c.x + 1) / 2) * window.innerWidth;
      const sy = ((1 - c.y) / 2) * window.innerHeight;
      const size = Math.hypot(((edge.x - c.x) / 2) * window.innerWidth, ((edge.y - c.y) / 2) * window.innerHeight);
      const d = Math.hypot(sx - x, sy - y) - size;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return { point, unit: best, ship: false };
  }

  /** The single unit or ship that P (or a double-click) would take control of. */
  private possessable(): Possessable | null {
    if (this.bcSelected) return this.bc;
    for (const e of this.selected) if (!e.isBuilding && e.alive && this.canTake(e as Unit)) return e as Unit;
    return null;
  }

  /**
   * Per-frame input; returns a unit to dive into, if the player asked for one. `clicks`: the
   * mouse's buttons select and order (not while a mission is placing something with them).
   */
  update(dt: number, clicks = true): { dive?: Possessable; zoomedIn?: boolean } {
    const input = this.input;
    const result: { dive?: Possessable; zoomedIn?: boolean } = {};
    const { wheel } = input.consume();
    if (wheel) {
      this.height = this.height * (1 + wheel * 0.12);
      if (this.height < MIN_HEIGHT) result.zoomedIn = true;
      this.height = THREE.MathUtils.clamp(this.height, MIN_HEIGHT, MAX_HEIGHT);
    }
    // Pan with the keyboard, or by pushing the cursor against the screen edge.
    const speed = this.height * 1.4 * dt;
    let px = (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0) - (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0);
    let pz = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
    if (input.cursorActive) {
      const m = 8;
      if (input.cursor.x < m) px += 1;
      if (input.cursor.x > window.innerWidth - m) px -= 1;
      if (input.cursor.y < m) pz += 1;
      if (input.cursor.y > window.innerHeight - m) pz -= 1;
    }
    this.target.x += px * speed;
    this.target.z += pz * speed;
    const r = Math.hypot(this.target.x, this.target.z);
    if (r > 360) this.target.multiplyScalar(360 / r);

    if (!clicks) this.drag = null;
    for (const ev of clicks ? input.pointerEvents() : []) {
      if (ev.type === 'down' && ev.button === 0) {
        if (ev.double) {
          const p = this.pick(ev.x, ev.y);
          if (p.ship) result.dive = this.bc;
          else if (p.unit && !p.unit.isBuilding && this.canTake(p.unit as Unit)) result.dive = p.unit as Unit;
        }
        this.drag = { x: ev.x, y: ev.y };
      } else if (ev.type === 'up' && ev.button === 0 && this.drag) {
        const moved = Math.hypot(ev.x - this.drag.x, ev.y - this.drag.y);
        if (moved < 8) this.clickSelect(ev.x, ev.y);
        else this.boxSelect(this.drag.x, this.drag.y, ev.x, ev.y);
        this.drag = null;
      } else if (ev.type === 'down' && ev.button === 2) {
        this.order(ev.x, ev.y);
      }
    }
    if (input.hit('KeyP') || input.hit('Enter')) {
      const p = this.possessable();
      if (p) result.dive = p;
    }
    if (input.hit('KeyB')) {
      // The Warship flies above the command camera; B selects it (B again takes control).
      if (this.bcSelected) result.dive = this.bc;
      this.selected.clear();
      this.bcSelected = true;
    }
    if (input.hit('KeyE')) this.toggleBrace();
    // X: the Warship called to where the cursor is (where the mission has it as a call-in).
    if (input.hit('KeyX') && this.onShipOrder && input.cursorActive) {
      const p = this.pick(input.cursor.x, input.cursor.y);
      if (p.point) this.onShipOrder(p.point);
    }
    if (input.hit('KeyR')) this.onRedeploy?.();
    if (input.hit('Escape')) {
      this.selected.clear();
      this.bcSelected = false;
    }
    for (const e of [...this.selected]) if (!e.targetable) this.selected.delete(e);
    this.updateRings(dt);
    return result;
  }

  private clickSelect(x: number, y: number) {
    const p = this.pick(x, y);
    this.selected.clear();
    this.bcSelected = p.ship;
    if (p.unit) this.selected.add(p.unit);
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const v = new THREE.Vector3();
    this.selected.clear();
    this.bcSelected = false;
    for (const e of this.world.entities) {
      if (!e.targetable || e.team !== 'holdouts' || e.isBuilding) continue;
      e.center(v).project(this.camera);
      const sx = ((v.x + 1) / 2) * window.innerWidth;
      const sy = ((1 - v.y) / 2) * window.innerHeight;
      if (v.z < 1 && sx >= ax && sx <= bx && sy >= ay && sy <= by) this.selected.add(e);
    }
  }

  /** Right-click: send the selection there, spread into a loose formation. */
  private order(x: number, y: number) {
    const p = this.pick(x, y);
    const point = p.point;
    if (!point) return;
    const units = [...this.selected].filter((e): e is Unit => !e.isBuilding && e.alive);
    const cols = Math.ceil(Math.sqrt(units.length));
    units.forEach((u, i) => {
      const post = point.clone().add(new THREE.Vector3(((i % cols) - (cols - 1) / 2) * 3.5, 0, (Math.floor(i / cols) - (cols - 1) / 2) * 3.5));
      // On the player's order: its own side makes way for it on the way there.
      u.orderedUntil = this.world.time + ORDER_RIGHT_OF_WAY;
      if (isCommandable(u.controller)) {
        // It keeps its own way of fighting; only where it fights from changes.
        u.controller.command(post);
      } else if (isTank(u)) {
        const brain = u.controller instanceof TankBrain ? u.controller : new TankBrain(u, post);
        brain.post = post;
        u.setController(brain);
      } else {
        u.setController(new GuardBrain(u, post));
      }
    });
    if (this.bcSelected && !this.onShipOrder?.(point.clone())) this.bc.station = point.clone();
    const mesh = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ color: 0x5aff7a, transparent: true, depthWrite: false }));
    mesh.position.copy(point).setY(this.world.terrain.heightAt(point.x, point.z) + 0.4);
    this.world.scene.add(mesh);
    this.markers.push({ mesh, life: 0.6 });
    if (units.length || this.bcSelected) this.world.audio.play('trooperYes', { volume: 0.6, limit: 1, spacing: 0.4 });
  }

  private toggleBrace() {
    for (const e of this.selected) {
      if (!isTank(e)) continue;
      const tank = e as Unit;
      const mode = tankMode(tank);
      if (mode === 'tank') beginBrace(tank, this.world);
      else if (mode === 'braced') beginUnbrace(tank, this.world);
      const brain = tank.controller instanceof TankBrain ? tank.controller : new TankBrain(tank, tank.position.clone());
      brain.post = tank.position.clone();
      tank.setController(brain);
    }
  }

  private updateRings(dt: number) {
    let i = 0;
    const ringFor = (pos: THREE.Vector3, radius: number) => {
      let ring = this.rings[i];
      if (!ring) {
        ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ color: 0x4dff6a, transparent: true, opacity: 0.85, depthWrite: false }));
        this.world.scene.add(ring);
        this.rings.push(ring);
      }
      ring.visible = this.active;
      ring.position.copy(pos);
      ring.scale.setScalar(radius);
      i++;
    };
    for (const e of this.selected) ringFor(e.position.clone().setY(e.position.y + 0.3), e.radius * 1.35);
    if (this.bcSelected) ringFor(new THREE.Vector3(this.bc.position.x, this.world.terrain.heightAt(this.bc.position.x, this.bc.position.z) + 0.5, this.bc.position.z), 150);
    for (; i < this.rings.length; i++) this.rings[i].visible = false;
    for (let k = this.markers.length - 1; k >= 0; k--) {
      const m = this.markers[k];
      m.life -= dt;
      m.mesh.scale.setScalar(1 + (0.6 - m.life) * 6);
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, m.life / 0.6);
      if (m.life <= 0) {
        this.world.scene.remove(m.mesh);
        this.markers.splice(k, 1);
      }
    }
  }

  /** Selection box and health bars, drawn over the 3D view. */
  drawOverlay() {
    const c = this.overlay;
    if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
      c.width = window.innerWidth;
      c.height = window.innerHeight;
    }
    const g = this.ctx;
    g.clearRect(0, 0, c.width, c.height);
    if (!this.active) return;
    const v = new THREE.Vector3();
    for (const e of this.world.entities) {
      if (!e.targetable) continue;
      const damaged = e.hp < e.maxHp;
      if (!damaged && !this.selected.has(e)) continue;
      v.copy(e.position);
      v.y += e.height * 1.05;
      v.project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      const sx = ((v.x + 1) / 2) * c.width;
      const sy = ((1 - v.y) / 2) * c.height;
      const w = THREE.MathUtils.clamp(e.radius * 600 / this.height, 14, 90);
      const f = e.hp / e.maxHp;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(sx - w / 2 - 1, sy - 1, w + 2, 5);
      g.fillStyle = e.team === 'crawl' ? '#d24aff' : e.team === 'directorate' ? '#ff5040' : f > 0.6 ? '#3fe07a' : f > 0.3 ? '#ffc14a' : '#ff4a3a';
      g.fillRect(sx - w / 2, sy, w * f, 3);
    }
    if (this.drag) {
      const { x, y } = this.input.cursor;
      g.strokeStyle = '#4dff6a';
      g.lineWidth = 1;
      g.fillStyle = 'rgba(77,255,106,0.08)';
      g.fillRect(this.drag.x, this.drag.y, x - this.drag.x, y - this.drag.y);
      g.strokeRect(this.drag.x, this.drag.y, x - this.drag.x, y - this.drag.y);
    }
  }

  /** One line describing the selection, for the HUD. */
  summary(): string {
    if (this.bcSelected) return `Warship · ${Math.ceil(this.bc.hp)} / ${this.bc.kind.maxHp}`;
    if (!this.selected.size) return 'Nothing selected';
    if (this.selected.size === 1) {
      const e = [...this.selected][0];
      const m = isTank(e) ? tankMode(e as Unit) : null;
      const mode = m ? ` · ${m === 'braced' ? 'Braced Mode' : m === 'tank' ? 'Drive Mode' : 'transforming'}` : '';
      return `${NAMES[e.kind.name] ?? e.kind.name}${mode} · ${Math.ceil(e.hp)} / ${e.maxHp}`;
    }
    const counts = new Map<string, number>();
    for (const e of this.selected) {
      const n = NAMES[e.kind.name] ?? e.kind.name;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return [...counts].map(([n, c]) => `${c} ${n}${c > 1 ? 's' : ''}`).join(' · ');
  }
}
