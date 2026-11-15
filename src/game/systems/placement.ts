import * as THREE from 'three';
import type { KindName } from '../kinds.ts';
import { TEAM_COLOR, type World } from '../world.ts';

/**
 * Placing something on the battlefield: a see-through ghost of the structure and a ring for its
 * footprint, green where it can go and red where it can't, wherever the commander is pointing
 * (the cursor in the command view, the crosshair on foot). The mode decides where that is and
 * what a click does; this only shows it.
 */
const OK = 0x5dff8a;
const NO = 0xff4a3a;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/**
 * Where the commander is pointing on the ground: under the crosshair (the middle of the view) on
 * foot, under the cursor in the command view. Null where that isn't ground within `reach`.
 */
export function aimPoint(world: World, camera: THREE.Camera, cursor: { x: number; y: number } | null, reach: number): THREE.Vector3 | null {
  const { origin, direction } = raycaster.ray;
  if (cursor) {
    ndc.set((cursor.x / window.innerWidth) * 2 - 1, -(cursor.y / window.innerHeight) * 2 + 1);
    // Where the camera is now (its matrix is otherwise only brought up to date as it's drawn).
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
  } else {
    // The crosshair is the middle of the view: straight down the camera's line of sight.
    camera.getWorldPosition(origin);
    camera.getWorldDirection(direction);
  }
  if (!Number.isFinite(direction.x)) return null;
  const t = world.terrain.raycast(origin, direction, reach);
  return t === null ? null : origin.clone().addScaledVector(direction, t);
}

export class PlacementGhost {
  /** What's being placed, or null. */
  kind: KindName | null = null;
  private ghost: THREE.Object3D | null = null;
  private ring: THREE.Mesh;
  private material = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.32, depthWrite: false });

  constructor(private world: World) {
    const g = new THREE.RingGeometry(0.9, 1, 48);
    g.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.8, depthWrite: false }));
    this.ring.visible = false;
    world.scene.add(this.ring);
  }

  /** Starts placing a structure of `kind`. */
  begin(kind: KindName) {
    this.end();
    const w = this.world;
    const k = w.kinds[kind];
    const t = w.models[k.def.model];
    this.kind = kind;
    if (!t) return;
    const inst = t.instantiate(TEAM_COLOR.holdouts, true);
    inst.play('Stand');
    inst.update(0);
    const groups = (inst.mesh.material as THREE.Material[]).length || 1;
    inst.mesh.material = Array.from({ length: groups }, () => this.material);
    inst.object.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    inst.object.scale.setScalar(w.scaleOf(k.def.model));
    this.ghost = inst.object;
    w.scene.add(this.ghost);
  }

  /** Where it would go now (null: nowhere on the ground), and why not (null: it can). */
  show(at: THREE.Vector3 | null, why: string | null, yaw = 0) {
    const visible = !!at && !!this.kind;
    this.ring.visible = visible;
    if (this.ghost) this.ghost.visible = visible;
    if (!at || !this.kind) return;
    const color = why ? NO : OK;
    this.material.color.setHex(color);
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    const y = this.world.terrain.heightAt(at.x, at.z);
    this.ring.position.set(at.x, y + 0.3, at.z);
    this.ring.scale.setScalar(this.world.structureRadius(this.kind));
    if (this.ghost) {
      this.ghost.position.set(at.x, y, at.z);
      this.ghost.rotation.y = yaw;
    }
  }

  end() {
    this.kind = null;
    this.ring.visible = false;
    if (this.ghost) this.world.scene.remove(this.ghost);
    this.ghost = null;
  }
}
