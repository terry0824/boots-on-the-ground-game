// What a mission leaves on the graphics card when it ends. The page stays from mission to mission (game/main.ts),
// so what a mission put on the card (its ground, its effects' pools, its crowds' baked animations, its
// first-person arms, its stand-in figures) has to be let go when it's over, or every mission would add to the
// card's memory. What lasts is left: the content's models, cached for the next mission (lastingModel), and the
// compiled shaders.
//
// The renderer says nothing of what it holds, but it listens for each texture's and geometry's "dispose" from
// the moment it first puts one on the card: that's where each upload is seen. Whatever a mission uploaded is
// let go at its end; anything still in use afterwards (the sky, the particles' batches) is simply put on the
// card again the next time it's drawn.

import * as THREE from 'three';

/** A cached model: what it holds on the card (its geometries and textures), kept for as long as it's cached. */
interface Lasting {
  holdings(): (THREE.BufferGeometry | THREE.Texture)[];
}
const models = new Set<Lasting>();
/** What went on the card while a mission ran. */
const uploads = new Set<THREE.Texture | THREE.BufferGeometry>();
let watching = false;

/** Notes each texture and geometry the renderer starts to hold (it listens for their "dispose" from then on). */
function spy(proto: { addEventListener: THREE.EventDispatcher['addEventListener'] }) {
  const add = proto.addEventListener;
  proto.addEventListener = function (this: THREE.Texture | THREE.BufferGeometry, type: string, listener: never) {
    if (watching && type === 'dispose') uploads.add(this);
    return add.call(this, type as never, listener);
  } as typeof add;
}
spy(THREE.Texture.prototype as never);
spy(THREE.BufferGeometry.prototype as never);

/** A model kept from mission to mission (the content's cache): what it holds stays on the card. */
export function lastingModel(model: Lasting): void {
  models.add(model);
}

/** A mission starts: what goes on the card from now on is its own. */
export function watchUploads(): void {
  uploads.clear();
  watching = true;
}

/**
 * A mission ended, its objects out of the scene. What it changed on the lasting models' shared materials is put
 * back (a body still shrouded as it ended: trooper.ts, systems/ultimates.ts); its instanced meshes' buffers are
 * let go, and everything it put on the card but the lasting models' own (render targets are their owners' to
 * keep). Materials are kept, and with them the compiled shaders the next mission reuses.
 */
export function release(roots: THREE.Object3D[]): void {
  watching = false;
  for (const root of roots) {
    root.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      const m = (o as THREE.Mesh).material;
      for (const mat of !m ? [] : Array.isArray(m) ? m : [m]) {
        const saved = mat.userData.shroudSaved as { t: boolean; o: number; d: boolean } | undefined;
        if (!saved) continue;
        mat.transparent = saved.t;
        mat.opacity = saved.o;
        mat.depthWrite = saved.d;
        mat.userData.shroudSaved = undefined;
        mat.needsUpdate = true;
      }
    });
  }
  const keep = new Set<object>();
  for (const model of models) for (const x of model.holdings()) keep.add(x);
  for (const x of uploads) {
    if (keep.has(x)) continue;
    if ((x as THREE.Texture).isRenderTargetTexture || (x as THREE.DepthTexture).isDepthTexture) continue;
    x.dispose();
  }
  uploads.clear();
}
