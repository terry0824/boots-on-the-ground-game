import * as THREE from 'three';
import type { ModelInstance } from '../engine/model.ts';
import type { PortraitName } from '../content/assetnames.ts';
import { provider } from '../content/provider.ts';
import { usesInstall } from '../content/mode.ts';
import { packPortrait } from '../content/resolve.ts';

export type { PortraitName };

/** The radio's existing slots, mapped to original speakers (art-direction.md §4.3). */
export const ORIGINAL_PORTRAITS: Partial<Record<PortraitName, string>> = {
  trooper: 'rourke', trooper2: 'rourke', rookie: 'vey', medic: 'marrow', tank: 'briggs',
  dispatch: 'dispatch', civilian: 'colonist', scientist: 'weller', directorate: 'officer',
  pilot: 'pilot', ostrander: 'ostrander', ashby: 'ashby', harlan: 'harlan',
  tolliver: 'tolliver', calyx: 'calyx',
};

/**
 * The radio head: an original still with a slow push-in and line-start flicker where the pack
 * has one, otherwise a plugin's animated model where the mode allows it. Drawn into the
 * box's rectangle of the main canvas after the scene; the HUD supplies the speaker's name.
 */
export class PortraitView {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(24, 1, 0.05, 50);
  private current: { name: string; instance: ModelInstance } | null = null;
  private loading = '';
  private talking = 0;
  private time = 0;
  private lineTime = 0;
  private stillRequest = 0;
  private still: string | null = null;
  private stillScene = new THREE.Scene();
  private stillCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private stillMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
  private stillPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.stillMaterial);
  private stillTextures = new Map<string, Promise<THREE.Texture | null>>();

  private key = new THREE.DirectionalLight(0xfff1e0, 2.4);
  private rim = new THREE.DirectionalLight(0x8cc4ff, 1.6);

  constructor() {
    this.stillCamera.position.z = 1;
    this.stillScene.add(this.stillPlane);
    // Key light over the camera's shoulder, a cool rim from behind, soft fill all round:
    // placed relative to the portrait's own camera once it's framed.
    this.scene.add(this.key, this.key.target, this.rim, this.rim.target, new THREE.HemisphereLight(0xc8d8ff, 0x2a2018, 1.1));
  }

  /** Puts `name` on screen, talking for `seconds`. */
  async show(name: PortraitName, seconds: number) {
    this.lineTime = 0;
    this.talking = seconds;
    const ticket = ++this.stillRequest;
    const speaker = ORIGINAL_PORTRAITS[name];
    const url = speaker ? packPortrait(speaker) : null;
    if (url || !usesInstall) {
      // Cancel a model load and clear the previous speaker while the still loads.
      this.loading = '';
      if (this.current) this.scene.remove(this.current.instance.object);
      this.current = null;
      if (url && this.still === url) return;
      this.still = null;
      if (!url) return;
      let pending = this.stillTextures.get(url);
      if (!pending) {
        pending = new THREE.TextureLoader().loadAsync(url).then((texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          return texture;
        }).catch(() => null);
        this.stillTextures.set(url, pending);
      }
      const texture = await pending;
      if (ticket !== this.stillRequest) return;
      if (texture) {
        this.stillMaterial.map = texture;
        this.stillMaterial.needsUpdate = true;
        this.still = url;
        return;
      }
      if (!usesInstall) return;
    }
    this.still = null;
    return this.showModel(name, seconds);
  }

  /** A plugin's portraits retain their lighting, framing and Talk/Stand animations. */
  private async showModel(name: PortraitName, seconds: number) {
    this.talking = seconds;
    if (this.current?.name === name || this.loading === name) {
      this.current?.instance.play('Talk', { fade: 0.15 });
      return;
    }
    this.loading = name;
    const template = await (provider()?.portrait(name) ?? Promise.resolve(null)).catch(() => null);
    if (this.loading !== name || !template) return;
    this.loading = '';
    if (this.current) this.scene.remove(this.current.instance.object);
    const instance = template.instantiate(new THREE.Color(0.12, 0.4, 1), true);
    this.scene.add(instance.object);
    instance.play('Talk') ?? instance.play('Stand');
    this.current = { name, instance };
    this.frame(instance);
  }

  /**
   * Puts the camera where the model's own portrait camera puts it: on its bone, with its
   * lens. The bone's look axis is whichever of its axes points most nearly at the head.
   */
  private frame(instance: ModelInstance) {
    const t = instance.template;
    instance.mixer.update(0);
    instance.object.updateMatrixWorld(true);
    const b = t.bounds;
    const head = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y - (b.max.y - b.min.y) * 0.25, (b.min.z + b.max.z) / 2);
    instance.attachment('Ref_Head')?.getWorldPosition(head);
    const cam = t.data.cameras.find((c) => /portrait/i.test(c.name)) ?? t.data.cameras[0];
    const bone = cam ? instance.mesh.skeleton.bones[cam.bone] : null;
    if (!cam || !bone) {
      const size = Math.max(0.35, (b.max.y - b.min.y) * 0.62);
      const distance = size / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
      this.camera.position.set(head.x, head.y, head.z + distance);
      this.camera.lookAt(head);
      this.light(head);
      return;
    }
    const pos = bone.getWorldPosition(new THREE.Vector3());
    const rot = bone.getWorldQuaternion(new THREE.Quaternion());
    const toHead = head.clone().sub(pos).normalize();
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)].map((a) => a.applyQuaternion(rot));
    const look = axes.reduce((best, a) => (a.dot(toHead) > best.dot(toHead) ? a : best));
    this.camera.position.copy(pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(pos.clone().add(look));
    // The lens: the model gives the field of view in radians; ours is vertical, in degrees.
    this.camera.fov = THREE.MathUtils.radToDeg(cam.fov) * 1.15;
    this.camera.near = 0.02;
    this.camera.far = 60;
    this.camera.updateProjectionMatrix();
    this.light(head);
  }

  private light(subject: THREE.Vector3) {
    const c = this.camera;
    c.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const toCam = c.position.clone().sub(subject).normalize();
    this.key.position.copy(subject).addScaledVector(toCam, 2).addScaledVector(right, 1.4).addScaledVector(up, 1.6);
    this.key.target.position.copy(subject);
    this.rim.position.copy(subject).addScaledVector(toCam, -2).addScaledVector(right, -1.2).addScaledVector(up, 1);
    this.rim.target.position.copy(subject);
  }

  /** Draws into the portrait rectangle (CSS pixels), or nothing when there's no transmission. */
  render(renderer: THREE.WebGLRenderer, rect: DOMRect | null, dt: number) {
    if (!rect || (!this.current && !this.still)) return;
    this.time += dt;
    this.talking -= dt;
    this.lineTime += dt;
    if (this.current && !this.still) {
      const inst = this.current.instance;
      if (this.talking <= 0 && inst.animation === 'Talk') inst.play('Stand', { fade: 0.3 });
      inst.update(dt);
    }
    const h = renderer.domElement.clientHeight;
    const x = rect.left;
    const y = h - rect.bottom;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x06101c, 1);
    renderer.clear(true, true, false);
    if (this.still) {
      const aspect = rect.width / rect.height;
      const zoom = 1 + Math.min(this.lineTime / 12, 1) * 0.045;
      this.stillPlane.scale.set(Math.max(1, 1 / aspect) * zoom, Math.max(1, aspect) * zoom, 1);
      this.stillMaterial.color.setScalar(1 - 0.2 * Math.exp(-this.lineTime * 8) * (0.5 + 0.5 * Math.cos(this.lineTime * 80)));
      renderer.render(this.stillScene, this.stillCamera);
    } else renderer.render(this.scene, this.camera);
    renderer.setClearColor(clear, alpha);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, h);
  }
}
