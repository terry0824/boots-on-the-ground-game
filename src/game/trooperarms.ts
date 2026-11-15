import * as THREE from 'three';
import { frameOf, worldOf } from '../engine/modelpose.ts';
import type { ModelInstance, ModelTemplate } from '../engine/model.ts';
import type { ModelData } from '../engine/modeldata.ts';
import type { Viewmodel } from './viewmodel.ts';
import { TEAM_COLOR } from './world.ts';

/**
 * The Trooper in first person: the story-mode Trooper's own arms holding the story-mode RK-4, in
 * the grip a cinematic gives them. In the Lodestar scene 06B a Trooper raises his rifle in both
 * hands; the Trooper and the rifle are both posed at that frame from the scene's own keys, so the
 * hands are on the rifle exactly as the scene animated them, fingers and all. The pair is turned
 * so the barrel points ahead (angled in a touch toward the crosshair) and the rifle sits
 * upright, and set where a shooter's rifle sits: low and right at the hip, up under the
 * crosshair when aiming. Sway, recoil and aiming move the two together. Only the arms are drawn
 * (head, body and legs are left out); they run back to shoulders out of the view, below and to
 * the sides, so nothing floats. (In the scene itself the rifle is held at the chest, under the
 * chin: seen from the eye that fills half the view, so the pair is set further out.)
 */

/** The frame of scene 06B the grip comes from: the rifle up and level, a hand on the grip and one under the barrel. */
const GRIP = { body: 'Dialogue 06 B', rifle: 'Dialogue 06 B Two', at: 25.25 };
/** The arms, from the shoulder joints down; the shoulder pads stay off (they'd sit by the eye). */
const KEEP = ['_Ctrl_RightShoulder_SkinPoint', '_Ctrl_LeftShoulder_SkinPoint'];
const DROP = ['_Ctrl_ShoulderPad_R_SkinPoint', '_Ctrl_ShoulderPad_L_SkinPoint'];
/**
 * Where the muzzle sits in the gun's pass (meters: right, up, forward) and how far the barrel is
 * angled in toward the middle (radians): at the hip, low and right, as the RK-4 always sat;
 * aiming, just under the crosshair. Both keep the shoulders out of the view.
 */
const HIP = { muzzle: new THREE.Vector3(0.17, -0.2, -1.05), toeIn: 0.06 };
const AIMED = { muzzle: new THREE.Vector3(0.045, -0.095, -0.98), toeIn: 0 };
const UP = new THREE.Vector3(0, 1, 0);

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const m1 = new THREE.Matrix4();

export class TrooperArms {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 30);
  /** It found its frame, its bones and some arms to draw: usable. */
  readonly ok: boolean;
  /** Sway, bob and recoil, about the eye. */
  private holder = new THREE.Group();
  /** The posed Trooper, turned and placed so its eye is at the origin; the rifle follows its frame. */
  private assembly = new THREE.Group();
  private inst: ModelInstance;
  private container: THREE.Object3D;
  /** The rifle's main bone at the frame, in the Trooper's (Z-up) scene space. */
  private rifleAt = new THREE.Matrix4();
  /** From the rifle's main bone back to its viewmodel holder. */
  private boneToHolder = new THREE.Matrix4();
  private hip = { q: new THREE.Quaternion(), p: new THREE.Vector3() };
  private aimed = { q: new THREE.Quaternion(), p: new THREE.Vector3() };
  private light: THREE.DirectionalLight;
  private kick = 0;
  private sway = new THREE.Vector2();
  private bob = 0;
  private grip = new THREE.Matrix4();

  constructor(
    body: ModelTemplate,
    bodyAnim: ModelData,
    rifleAnim: ModelData,
    private rifle: Viewmodel,
  ) {
    const inst = body.instantiate(TEAM_COLOR.holdouts, true);
    this.inst = inst;
    this.container = inst.object.children[0];
    inst.object.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });
    const bodySeq = bodyAnim.sequences.find((s) => s.name === GRIP.body);
    const rifleSeq = rifleAnim.sequences.find((s) => s.name === GRIP.rifle);
    const rifleBones = rifle.template.data.bones;
    const main = rifleBones.findIndex((b) => b.name === 'MRF_Ctrl_Main_SkinPoint');
    const flash = rifleBones.findIndex((b) => b.name === 'MRF_Ctrl_MuzzleFlash');
    const bones = inst.mesh.skeleton.bones;
    this.ok = !!bodySeq && !!rifleSeq && main >= 0 && flash >= 0;
    if (!this.ok || !bodySeq || !rifleSeq) {
      this.light = new THREE.DirectionalLight();
      return;
    }

    // The Trooper at the frame.
    const locals = frameOf(body.data.bones, bodyAnim, bodySeq, GRIP.at);
    locals.forEach((l, i) => {
      bones[i].position.copy(l.position);
      bones[i].quaternion.copy(l.quaternion);
      bones[i].scale.copy(l.scale);
    });
    // The rifle at the frame: its main bone (the grip; the barrel runs down its +Z, its top is -X).
    const rifleWorld = worldOf(rifleBones, frameOf(rifleBones, rifleAnim, rifleSeq, GRIP.at));
    this.rifleAt.copy(rifleWorld[main]);

    // Into the assembly's frame (the model's container turns Z-up to Y-up).
    this.assembly.add(inst.object);
    this.holder.add(this.assembly);
    this.scene.add(this.holder, this.camera);
    this.scene.updateMatrixWorld(true);
    const toLocal = this.container.matrix;
    const rot = new THREE.Quaternion().setFromRotationMatrix(m1.extractRotation(this.rifleAt));
    const barrel = v1.set(0, 0, 1).applyQuaternion(rot).transformDirection(toLocal).normalize().clone();
    const top = v2.set(-1, 0, 0).applyQuaternion(rot).transformDirection(toLocal);
    top.addScaledVector(barrel, -top.dot(barrel)).normalize();
    const muzzle = new THREE.Vector3().setFromMatrixPosition(rifleWorld[flash]).applyMatrix4(toLocal);

    // Turned so the barrel points ahead (-Z) with the rifle's top up, then angled in; set so the
    // muzzle lands where it shows. At the rifle's own viewmodel scale, so its flash and casings
    // stay their size.
    const back = barrel.clone().negate();
    const right = new THREE.Vector3().crossVectors(top, back);
    const level = new THREE.Quaternion().setFromRotationMatrix(m1.makeBasis(right, top, back)).invert();
    const s = rifle.scale;
    this.assembly.scale.setScalar(s);
    const set = (at: { muzzle: THREE.Vector3; toeIn: number }, out: { q: THREE.Quaternion; p: THREE.Vector3 }) => {
      out.q.setFromAxisAngle(UP, at.toeIn).multiply(level);
      out.p.copy(at.muzzle).sub(muzzle.clone().multiplyScalar(s).applyQuaternion(out.q));
    };
    set(HIP, this.hip);
    set(AIMED, this.aimed);
    this.place(0);

    this.keepOnly(body);
    for (const m of inst.mesh.material as THREE.Material[]) {
      // No self-lit panels this close to the eye.
      if (m instanceof THREE.MeshPhongMaterial) m.emissiveIntensity = 0;
    }

    // From the rifle's main bone to its holder, with the holder where it is.
    this.claim();
    rifle.holder.matrixAutoUpdate = false;
    rifle.holder.matrix.identity();
    rifle.holder.updateMatrixWorld(true);
    const mainBone = rifle.bone('MRF_Ctrl_Main_SkinPoint');
    if (mainBone) this.boneToHolder.copy(mainBone.matrixWorld).invert();

    this.scene.add(new THREE.HemisphereLight(0xe2e8f5, 0x8a6a4a, 1.8));
    this.light = new THREE.DirectionalLight(0xfff0dc, 3.1);
    const fill = new THREE.DirectionalLight(0xdfe6f0, 1.6);
    fill.position.set(0.6, 0.8, 1);
    this.scene.add(this.light, this.light.target, fill);
  }

  /** The assembly at `ads` of the way from the hip to aiming. */
  private place(ads: number) {
    this.assembly.quaternion.slerpQuaternions(this.hip.q, this.aimed.q, ads);
    this.assembly.position.lerpVectors(this.hip.p, this.aimed.p, ads);
  }

  /** Only the arms: triangles whose every corner rides a kept bone most, solid surfaces only. */
  private keepOnly(template: ModelTemplate) {
    const mesh = this.inst.mesh;
    const bones = mesh.skeleton.bones;
    const keep = new Set<number>();
    const chain = (suffixes: string[], fn: (i: number) => void) => {
      for (const b of bones) if (suffixes.some((x) => (b.userData.sourceName as string).endsWith(x))) b.traverse((o) => fn(bones.indexOf(o as THREE.Bone)));
    };
    chain(KEEP, (i) => i >= 0 && keep.add(i));
    chain(DROP, (i) => keep.delete(i));
    const src = mesh.geometry;
    const index = src.index!;
    const si = src.attributes.skinIndex;
    const sw = src.attributes.skinWeight;
    const rides = (v: number) => {
      let best = 0;
      let bone = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w > best) {
          best = w;
          bone = si.getComponent(v, k);
        }
      }
      return keep.has(bone);
    };
    const kept: number[] = [];
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
    for (const grp of src.groups) {
      if (template.data.materials[grp.materialIndex ?? 0]?.blendMode !== 0) continue;
      const start = kept.length;
      for (let i = grp.start; i < grp.start + grp.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        if (rides(a) && rides(b) && rides(c)) kept.push(a, b, c);
      }
      if (kept.length > start) g.addGroup(start, kept.length - start, grp.materialIndex ?? 0);
    }
    g.setIndex(kept);
    mesh.geometry = g;
  }

  /** Takes the rifle into this pass (another body's view may have had it). */
  claim(): this {
    if (this.rifle.holder.parent !== this.scene) this.scene.add(this.rifle.holder);
    return this;
  }

  shoot() {
    this.kick = Math.min(1, this.kick + 0.45);
    this.rifle.shoot();
  }

  muzzleWorld(mainCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    return this.rifle.muzzleWorld(mainCamera, out);
  }

  update(dt: number, opts: { moving: number; ads: number; turnX: number; turnY: number; aspect: number; fov: number; sunDir: THREE.Vector3; cameraQuat: THREE.Quaternion; camera: THREE.Camera }) {
    this.camera.aspect = opts.aspect;
    this.camera.fov = opts.fov * 0.85;
    this.camera.updateProjectionMatrix();
    this.kick = Math.max(0, this.kick - dt * 9);
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-opts.turnX * 0.0009, -0.05, 0.05), 10, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(opts.turnY * 0.0009, -0.05, 0.05), 10, dt);
    this.bob += dt * opts.moving * 9;
    const bob = opts.moving * (1 - opts.ads) * 0.012;
    // Sway and bob shift the arms and rifle together; a round kicks them back and up.
    this.holder.position.set(this.sway.x + Math.sin(this.bob) * bob, this.sway.y - Math.abs(Math.cos(this.bob)) * bob, this.kick * 0.04);
    this.holder.rotation.set(this.kick * 0.04 + this.sway.y * 0.6, this.sway.x * 0.8, 0);
    this.place(opts.ads);
    this.scene.updateMatrixWorld(true);
    // The rifle where the frame has it, in these hands.
    this.grip.multiplyMatrices(this.container.matrixWorld, this.rifleAt).multiply(this.boneToHolder);
    this.rifle.grip = this.grip;
    this.rifle.update(dt, opts);
    const toView = q1.copy(opts.cameraQuat).invert();
    this.light.position.copy(opts.sunDir).applyQuaternion(toView).multiplyScalar(10);
  }
}
