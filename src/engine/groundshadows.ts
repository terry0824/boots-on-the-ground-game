import * as THREE from 'three';

/** A soft round shadow, dark in the middle and gone at the edge. */
function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * Soft shadows on the ground under the units the shadow map doesn't reach (all of them, with
 * shadows off): a dark smudge under each, pushed a little away from the sun, so a swarm on the
 * far side of a field still stands on the ground rather than floating over it. One instanced
 * draw, refilled every frame.
 */
export class GroundShadows {
  readonly mesh: THREE.InstancedMesh;
  private alpha: THREE.InstancedBufferAttribute;
  private count = 0;
  private m = new THREE.Matrix4();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private static q = new THREE.Quaternion();

  constructor(readonly capacity: number) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('shadowAlpha', this.alpha);
    const material = new THREE.MeshBasicMaterial({
      map: blobTexture(),
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float shadowAlpha;\nvarying float vShadowAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShadowAlpha = shadowAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vShadowAlpha;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vShadowAlpha;');
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.count = 0;
  }

  begin() {
    this.count = 0;
  }

  /** A shadow `radius` meters across on the ground at (x, y, z), `alpha` dark. */
  add(x: number, y: number, z: number, radius: number, alpha: number) {
    if (this.count >= this.capacity || alpha <= 0.01) return;
    this.s.set(radius * 2, 1, radius * 2);
    this.m.compose(this.p.set(x, y, z), GroundShadows.q, this.s);
    this.mesh.setMatrixAt(this.count, this.m);
    this.alpha.setX(this.count, alpha);
    this.count++;
  }

  end() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}
