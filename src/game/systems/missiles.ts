import * as THREE from 'three';
import { heading } from '../../engine/fxmodel.ts';
import type { ModelInstance, ModelTemplate } from '../../engine/model.ts';

/**
 * Missiles' own bodies in flight (a Jackknife's Dart torpedo, a Bulwark's Lance, a Nightjar's
 * rocket): the mesh of the missile's model, drawn along with its emitters (the exhaust and the
 * trail, carried by the effects), its front (its -Y: see `heading`) along the flight, playing
 * its Turbo where it has one (a Jackknife's torpedo plays it once under way) or its Stand. Kept
 * and reused, model by model.
 */

export class MissileBodies {
  private pool = new Map<ModelTemplate, ModelInstance[]>();

  constructor(private scene: THREE.Scene) {}

  /** A body for `template` at `scale` meters per model unit, or null where the model is all emitters. */
  take(template: ModelTemplate, team: THREE.Color, scale: number): ModelInstance | null {
    if (!template.data.batches.some((b) => b.material >= 0)) return null;
    let list = this.pool.get(template);
    if (!list) this.pool.set(template, (list = []));
    let body = list.pop();
    if (!body) {
      body = template.instantiate(team);
      body.object.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
      });
      this.scene.add(body.object);
    }
    body.object.visible = true;
    body.object.scale.setScalar(scale);
    body.play(template.variants('Turbo').length ? 'Turbo' : 'Stand', { loop: true, restart: true, fade: 0 });
    return body;
  }

  /** Where it is now, heading along `velocity`. */
  place(body: ModelInstance, at: THREE.Vector3, velocity: THREE.Vector3, dt: number) {
    body.object.position.copy(at);
    if (velocity.lengthSq() > 1e-8) heading(velocity, body.object.quaternion);
    body.update(dt);
  }

  /** It has landed: out of sight until it's fired again. */
  give(body: ModelInstance) {
    body.object.visible = false;
    this.pool.get(body.template)?.push(body);
  }
}
