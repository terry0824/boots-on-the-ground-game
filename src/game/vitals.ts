import * as THREE from 'three';
import type { World } from './world.ts';

/** How far the wounded around you show their life: soldiers close by, machines further out. */
const BIO_RANGE = 45;
const MECH_RANGE = 95;
/** A machine below this share of its life is flagged for repair (a Mender's work). */
const NEEDS_REPAIR = 0.5;

const tmp = new THREE.Vector3();

/**
 * Life bars over the wounded on your side, seen from the ground: the soldiers around you who
 * are hurt (a Medic's work), and the tanks, bunkers and turrets further out that are damaged,
 * with the ones in a bad way framed for repair (a Mender's). Units at full life stay clean.
 */
export function drawVitals(g: CanvasRenderingContext2D, camera: THREE.Camera, world: World, width: number, height: number) {
  const ratio = g.canvas.width / width;
  const pulse = 0.55 + 0.45 * Math.sin(world.time * 6);
  g.save();
  g.scale(ratio, ratio);
  for (const e of world.entities) {
    if (!e.targetable || e.team !== 'holdouts' || e === world.player) continue;
    const f = e.hp / e.maxHp;
    if (f > 0.98) continue;
    const mech = e.isBuilding || e.kind.attributes.includes('Mechanical');
    const dist = camera.position.distanceTo(e.position);
    if (dist > (mech ? MECH_RANGE : BIO_RANGE)) continue;
    tmp.copy(e.position);
    tmp.y += e.height * 1.05 + 0.3;
    tmp.project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1 || Math.abs(tmp.y) > 1) continue;
    const x = (tmp.x * 0.5 + 0.5) * width;
    const y = (-tmp.y * 0.5 + 0.5) * height;
    const near = 1 - dist / (mech ? MECH_RANGE : BIO_RANGE);
    const w = THREE.MathUtils.clamp((mech ? 34 : 18) + near * 22 + e.radius * 2, 16, mech ? 74 : 44);
    const h = mech ? 5 : 4;
    g.globalAlpha = THREE.MathUtils.clamp(0.35 + near * 0.9, 0.35, 1);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
    g.fillStyle = f > 0.6 ? '#3fe07a' : f > 0.3 ? '#ffc14a' : '#ff4a3a';
    g.fillRect(x - w / 2, y, w * f, h);
    if (mech && f < NEEDS_REPAIR) {
      // Needs a Mender: an orange frame that pulses.
      g.globalAlpha *= pulse;
      g.strokeStyle = '#ff9a3a';
      g.lineWidth = 1.5;
      g.strokeRect(x - w / 2 - 3, y - 3, w + 6, h + 6);
    }
  }
  g.restore();
}
