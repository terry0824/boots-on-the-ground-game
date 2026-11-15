import * as THREE from 'three';
import { flipbookFrames, setFlipbookFrame, type ModelInstance, type ModelTemplate } from '../engine/model.ts';
import { atlasPiece } from '../engine/effects.ts';
import { Emitters, type BoneSource } from '../engine/particles.ts';
import { TEAM_COLOR } from './world.ts';

/** Distance from the rifle's skin point to its muzzle on screen, meters (view space). */
const LENGTH = 0.6;
/** Where the skin point sits relative to the eye: right, down, forward. */
const REST = new THREE.Vector3(0.215, -0.235, -0.44);
/**
 * Aimed: up and in, but low and a touch right of the crosshair, which sits well over the
 * receiver. (The RK-4 has no sights to look through; centered, its back end covered the aim,
 * and any higher its muzzle flash burst right on the crosshair.)
 */
const AIMED = new THREE.Vector3(0.05, -0.215, -0.37);
/**
 * How much of the muzzle flash shows from the hip, where a long burst puts it in the eye line,
 * and when aiming, where it bursts just under the crosshair.
 */
const HIP_FLASH = 0.45;
const AIMED_FLASH = 0.35;
/** The barrel angles in toward the crosshair at rest. */
const TOE_IN = 0.07;
/**
 * The most rounds one drawn frame throws casings for: a burst's rounds come 0.08 s apart (a little
 * faster on a Stimpack), so a frame of even 1/20 s sees one or two.
 */
const MAX_ROUNDS_PER_FRAME = 3;

/**
 * The first-person RK-4: the story-mode rifle model, drawn in its own pass after the world so it
 * never clips into walls or Crawl, with recoil, sway, walk bob and a muzzle flash. Its own
 * particle emitters throw sparks, a puff of smoke and a spent casing with every round; they
 * fly in the world, not the gun's pass, so the smoke hangs where it was fired.
 */
export class Viewmodel implements BoneSource {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  /** The rifle, its flash and its frame: what a first-person rig (the arms holding it) takes into its own pass. */
  readonly holder = new THREE.Group();
  /**
   * Held by a first-person rig: the grip's frame in the gun's pass (barrel down its -Z, top up
   * its +Y), set every frame; the rifle's own recoil goes on top. Null: the rifle on its own, at
   * its rest (a body with no arms to hold it).
   */
  grip: THREE.Matrix4 | null = null;
  /** The rifle model's size in the gun's pass: LENGTH over its grip-to-muzzle. */
  readonly scale: number;
  private flash: THREE.Sprite;
  /** Each round's flash lights the rifle and the hands on it, warm and for a moment. */
  private muzzleLight = new THREE.PointLight(0xffb468, 0, 1.6, 2);
  private light: THREE.DirectionalLight;
  /** Local position of the muzzle inside `holder`. */
  private muzzleLocal = new THREE.Vector3();
  private kick = 0;
  private flashLife = 0;
  private sway = new THREE.Vector2();
  private bob = 0;
  private rifle: ModelInstance;
  /**
   * The rifle's own muzzle flash: cards of flame, a glare ring and caps around the barrel's tip.
   * The story-mode model shows them all the time (a gun forever firing in a cinematic); here
   * they light for a frame or two per round.
   */
  private flashCards: THREE.Material[] = [];
  private emitters: Emitters | null = null;
  /** The rifle's emitters fired per round. */
  private muzzle = { sparks: -1, smoke: -1, casing: -1 };
  private shots = 0;
  /** The gun's pass to the world: view space through the main camera, its lens corrected. */
  private toWorld = new THREE.Matrix4();

  constructor(
    readonly template: ModelTemplate,
    flashTexture: THREE.Texture | null,
  ) {
    const rifle = template.instantiate(TEAM_COLOR.holdouts, true);
    this.rifle = rifle;
    rifle.play(template.clips.has('GLstand') ? 'GLstand' : [...template.clips.keys()][0]);
    rifle.update(0);
    const materials = rifle.mesh.material as THREE.Material[];
    this.flashCards = materials.filter((_, i) => {
      const m = template.data.materials[i];
      return m && m.blendMode !== 0 && /muzzle|ringflash/i.test(m.name);
    });
    for (const m of this.flashCards) {
      m.visible = false;
      // Dimmed: at full strength, with the bloom, a burst from the hip blinds.
      (m as THREE.MeshBasicMaterial).color?.setScalar(HIP_FLASH);
    }
    rifle.object.updateMatrixWorld(true);
    const bones = rifle.mesh.skeleton.bones;
    const find = (n: string) => bones.find((b) => b.userData.sourceName === n);
    const gripBone = find('MRF_Ctrl_Main_SkinPoint')!;
    const grip = gripBone.getWorldPosition(new THREE.Vector3());
    const muzzle = find('MRF_Ctrl_MuzzleFlash')!.getWorldPosition(new THREE.Vector3());

    // The rifle's own frame, from its grip bone: the barrel runs along the bone's +Z and the
    // gun's top is its -X. (Checked against the mesh: its long axis is within 2 degrees of the
    // bone's Z, and the pistol grip hangs along +X below the barrel.) The grip-to-muzzle line is
    // no use as the barrel: the grip sits below the bore, 12 degrees off it.
    const q = gripBone.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const up = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    up.addScaledVector(forward, -up.dot(forward)).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up);
    // Barrel straight ahead (-Z), top up (+Y), the grip at the origin, scaled to LENGTH.
    const scale = LENGTH / muzzle.distanceTo(grip);
    this.scale = scale;
    const inner = new THREE.Group();
    rifle.object.position.copy(grip).negate();
    inner.add(rifle.object);
    inner.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()).transpose());
    inner.scale.setScalar(scale);
    this.holder.add(inner);
    this.muzzleLocal.copy(muzzle).sub(grip).applyQuaternion(inner.quaternion).multiplyScalar(scale);
    rifle.object.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });

    this.flash = new THREE.Sprite(
      // The big burst from the muzzle-flash atlas.
      new THREE.SpriteMaterial({ map: flashTexture && atlasPiece(flashTexture, 512, 262, 262, 512, 476), color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.visible = false;
    this.holder.add(this.flash, this.muzzleLight);
    this.scene.add(this.holder, this.camera);
    this.scene.add(new THREE.HemisphereLight(0xe2e8f5, 0x8a6a4a, 1.8));
    this.light = new THREE.DirectionalLight(0xfff0dc, 3.1);
    // A soft fill from over the shoulder so the gunmetal reads even with the sun behind.
    const fill = new THREE.DirectionalLight(0xdfe6f0, 1.6);
    fill.position.set(0.6, 0.8, 1);
    this.scene.add(this.light, this.light.target, fill);

    // The story-mode rifle's emitters run all the time in its own animation (a gun forever
    // firing); here they're fired by hand, per round.
    if (template.data.emitters.length) {
      this.emitters = new Emitters(template);
      this.muzzle = {
        sparks: this.emitters.find('MRF_Particle_Spark'),
        smoke: this.emitters.find('MRF_Particle_Smoke_Main'),
        casing: this.emitters.find('MRF_Particle_ShellEject'),
      };
    }
  }

  /** One of the rifle's bones, by its name in the model. */
  bone(name: string): THREE.Bone | null {
    return this.rifle.mesh.skeleton.bones.find((b) => b.userData.sourceName === name) ?? null;
  }

  /** From the grip to the muzzle, in the holder's frame (meters, before a rig scales it). */
  get length(): number {
    return this.muzzleLocal.length();
  }

  shoot() {
    this.kick = Math.min(1, this.kick + 0.55);
    this.flashLife = 0.045;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    // A different moment of the model's firing loop each round (the flame cards jitter), and a
    // different set of flames from their atlas.
    this.rifle.mixer.setTime(Math.random() * 1.9);
    for (const m of this.flashCards) setFlipbookFrame(m, Math.floor(Math.random() * flipbookFrames(m)));
    this.shots++;
  }

  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null {
    const bone = this.rifle.mesh.skeleton.bones[index];
    return bone ? out.multiplyMatrices(this.toWorld, bone.matrixWorld) : null;
  }

  /** This frame's rounds: sparks, smoke and casings, from where the rifle is drawn. */
  private emit(camera: THREE.Camera, fov: number) {
    if (!this.emitters || this.shots === 0) return;
    // This frame's rounds only. Those fired while the rifle wasn't drawn (from behind the shoulder,
    // from a bunker's slit) are gone; kept, they all came out at once the next time it was, a
    // heap of casings and a cloud of smoke at the muzzle.
    let rounds = Math.min(this.shots, MAX_ROUNDS_PER_FRAME);
    this.shots = 0;
    // The holder sits at the root of whichever pass draws it (its own, or a rig's).
    this.holder.updateMatrixWorld(true);
    // The gun's lens is narrower than the world's; widen view space by the difference so
    // particles leave the muzzle where it appears on screen.
    const k = Math.tan(THREE.MathUtils.degToRad(fov) / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.toWorld.makeScale(k, k, 1).premultiply(camera.matrixWorld);
    for (; rounds > 0; rounds--) {
      this.emitters.fire(this.muzzle.sparks, 2 + Math.floor(Math.random() * 3), this);
      this.emitters.fire(this.muzzle.smoke, 2, this);
      this.emitters.fire(this.muzzle.casing, 1, this);
    }
  }

  /**
   * Muzzle position in the main camera's world space (for tracers): where the muzzle appears on
   * screen, so rounds leave the barrel you see. The gun's pass has a narrower lens, so its view
   * space is widened by the difference first.
   */
  muzzleWorld(mainCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.muzzleLocal).applyMatrix4(this.holder.matrix);
    const fov = (mainCamera as THREE.PerspectiveCamera).fov;
    if (fov) {
      const k = Math.tan(THREE.MathUtils.degToRad(fov) / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      out.x *= k;
      out.y *= k;
    }
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  update(dt: number, opts: { moving: number; ads: number; turnX: number; turnY: number; aspect: number; fov: number; sunDir: THREE.Vector3; cameraQuat: THREE.Quaternion; camera: THREE.Camera }) {
    this.camera.aspect = opts.aspect;
    this.camera.fov = opts.fov * 0.85;
    this.camera.updateProjectionMatrix();

    this.kick = Math.max(0, this.kick - dt * 9);
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-opts.turnX * 0.0009, -0.05, 0.05), 10, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(opts.turnY * 0.0009, -0.05, 0.05), 10, dt);
    this.bob += dt * opts.moving * 9;
    const bobAmt = opts.moving * (1 - opts.ads) * 0.012;

    if (this.grip) {
      // In the hands, where they hold it (the hands take the recoil with it).
      this.holder.matrixAutoUpdate = false;
      this.holder.matrix.copy(this.grip);
    } else {
      const pos = REST.clone().lerp(AIMED, opts.ads);
      pos.x += this.sway.x + Math.sin(this.bob) * bobAmt;
      pos.y += this.sway.y - Math.abs(Math.cos(this.bob)) * bobAmt;
      pos.z += this.kick * 0.06;
      this.holder.matrixAutoUpdate = true;
      this.holder.position.copy(pos);
      this.holder.rotation.set(this.kick * 0.06 + this.sway.y * 0.6, this.sway.x * 0.8 + TOE_IN * (1 - opts.ads), 0);
      this.holder.updateMatrix();
    }
    this.emit(opts.camera, opts.fov);

    this.flashLife -= dt;
    this.flash.visible = this.flashLife > 0;
    // Aiming, the muzzle is just under the crosshair: a smaller, dimmer burst, and none of the
    // rifle's big flame cards, so the target stays in sight through a long burst.
    for (const m of this.flashCards) m.visible = this.flash.visible && opts.ads < 0.5;
    this.muzzleLight.intensity = this.flash.visible ? THREE.MathUtils.lerp(HIP_FLASH, AIMED_FLASH, opts.ads) * (5 + Math.random() * 3) : 0;
    if (this.flash.visible) {
      const k = THREE.MathUtils.lerp(HIP_FLASH, AIMED_FLASH, opts.ads);
      this.muzzleLight.position.copy(this.muzzleLocal).add(new THREE.Vector3(0, 0.02, -0.04));
      this.flash.position.copy(this.muzzleLocal).add(new THREE.Vector3(0, 0, -0.06));
      this.flash.scale.setScalar((0.16 + Math.random() * 0.08) * Math.sqrt(k));
      this.flash.material.opacity = 0.85 * k;
    }

    // Light the gun from the same sun as the world, expressed in view space.
    const toView = opts.cameraQuat.clone().invert();
    this.light.position.copy(opts.sunDir).applyQuaternion(toView).multiplyScalar(10);
  }
}
