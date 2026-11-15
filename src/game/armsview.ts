import * as THREE from 'three';
import { frameOf } from '../engine/modelpose.ts';
import type { ModelInstance, ModelTemplate } from '../engine/model.ts';
import type { ModelData } from '../engine/modeldata.ts';
import type { AnimationName, ModelName } from '../content/assetnames.ts';
import { TEAM_COLOR } from './world.ts';

/**
 * First person through the soldier's own arms, for the soldiers whose weapon is part of their
 * unit model (the Burner's flamethrowers, the Seer's LR-6; the unit Trooper's RK-4 when the
 * story-mode one can't be had). The unit model holds its own firing pose, and the whole of it,
 * arms and weapon together, is turned so the barrel points ahead and set so the muzzle sits
 * where a shooter's weapon does: low and to the side at the hip, up under the crosshair when
 * aiming. Nothing is moved apart (the hands stay on the weapon as the animation has them), and
 * only the arms and the weapon are drawn (head, body and legs are left out); the arms run back
 * to shoulders out of the view, so nothing floats. Where the pose reads wrong from the eye, a
 * whole chain is set right (an arm as another clip has it, an arm turned at a joint), the hand
 * never parted from what it holds. The arms are drawn from both faces: they're open shells.
 */

/** Where the muzzle sits in the gun's pass (meters: right, up, forward), and how far the barrel is angled in toward the middle (radians). */
interface Placement {
  muzzle: [number, number, number];
  toeIn: number;
}

export interface ArmsDef {
  /** The model drawn, if not the unit's own: a story-mode character's arms, fingers and all. */
  model?: ModelName;
  /** The pose held: the model's own clip, this far into it; or a frame (seconds in) of a sequence of external keys (manifest's ANIMATIONS). */
  pose: { clip: string; at: number } | { keys: AnimationName; seq: string; time: number };
  /**
   * Chains held as another of the model's own clips has them at a moment, where they are in the
   * model then (the body under them stays the pose's): twin weapons that no one clip raises
   * together, each arm from the attack that raises it.
   */
  graft?: { clip: string; at: number; bones: string[] };
  /**
   * The pose set right where it reads wrong from the eye: a bone's chain turned as one piece
   * (degrees, right hand) about the model's up, the barrel or the level line across the barrel,
   * through `at` (a bone or point; the turned bone's own joint if none; for the barrel, the
   * barrel's nearest point to it). The bones in `hold`, and theirs, stay where they were.
   */
  turns?: { bone: string; deg: number; about?: 'up' | 'barrel' | 'across'; at?: string; hold?: string[] }[];
  /** Points on bones (offsets in the bone's own frame, model units), named for `from` and `muzzles`: a weapon with no muzzle of its own. */
  points?: Record<string, { bone: string; at: [number, number, number] }>;
  /** Bones whose whole chains are drawn (the arms from the upper arm down, a weapon on a chain of its own), and chains left out of those. */
  keep: string[];
  drop?: string[];
  /** The barrel: from the middle of these bones to the middle of the muzzles (attachments or bones), which take turns shot to shot. */
  from: string[];
  muzzles: string[];
  /** How long it is in the gun's pass (meters): sizes the whole rig. */
  length: number;
  hip: Placement;
  aimed: Placement;
  /** Seen in a mirror: a pose that holds its weapon left-handed, made right-handed. */
  mirror?: boolean;
  /** Hidden this far into aiming (a scope fills the view instead). */
  hideAtAds?: number;
  /** The rig to fall back on (on the unit's own model) where this one's model or keys can't be had. */
  fallback?: ArmsDef;
  /** The rig for the game's own model of it (a .glb), where its parts and poses differ from StarCraft II's. */
  own?: ArmsDef;
}

export const ARMS: Record<string, ArmsDef> = {
  // The unit Trooper's RK-4, in its hand (when the story-mode Trooper and rifle can't be had).
  trooper: {
    pose: { clip: 'Attack', at: 0.5 },
    keep: ['BoneArmR', 'BoneArmL'],
    drop: ['Shield'],
    from: ['BoneHandR'],
    muzzles: ['Ref_Weapon'],
    length: 0.6,
    hip: { muzzle: [0.17, -0.2, -1.05], toeIn: 0.06 },
    aimed: { muzzle: [0.045, -0.095, -0.98], toeIn: 0 },
  },
  // The Kiln flamethrowers on both forearms: two nozzles, low on either side.
  burner: {
    pose: { clip: 'Attack', at: 0.5 },
    keep: ['BoneArmR', 'BoneArmL'],
    drop: ['Bone_HoseRt', 'Bone_HoseLft'],
    from: ['BoneForeArmR', 'BoneForeArmL'],
    muzzles: ['Ref_Weapon Right', 'Ref_Weapon Left'],
    length: 0.46,
    hip: { muzzle: [0, -0.25, -0.95], toeIn: 0 },
    aimed: { muzzle: [0, -0.21, -0.95], toeIn: 0 },
    // The game's own Burner: its forearms and the lances on them (their nozzles riding the lances), without
    // the upper arms, whose shoulder slats came up into the view.
    own: {
      pose: { clip: 'Attack', at: 0.5 },
      keep: ['BoneForeArmR', 'BoneForeArmL'],
      from: ['BoneForeArmR', 'BoneForeArmL'],
      muzzles: ['Ref_Weapon Right', 'Ref_Weapon Left'],
      length: 0.42,
      hip: { muzzle: [0, -0.3, -0.95], toeIn: 0 },
      aimed: { muzzle: [0, -0.26, -0.95], toeIn: 0 },
    },
  },
  // Both Breaker launchers held out ahead, each as the attack that fires it has it (the left arm
  // grafted from the Attack Left: no one clip raises both, and its Stand hangs them at the knees),
  // turned in at the shoulders toward the middle. Only the forearms, the launchers themselves:
  // the upper arm is all shoulder pad, which sat in front of the eye. They're big and close
  // enough that each runs back out of the view at its lower corner. The Ref_Weapons don't ride
  // the arms (they stay where a raised launcher fires), so the muzzles are the launchers' own
  // front barrels, on the forearms. No sights: aiming sets them a little further off, so the zoom
  // brings them only a little closer (set off as far again as the view zooms, their open elbow
  // ends came into the view).
  grenadier: {
    pose: { clip: 'Attack Right', at: 0.6 },
    graft: { clip: 'Attack Left', at: 0.6, bones: ['BoneArmL'] },
    turns: [
      { bone: 'BoneArmR', deg: 16 },
      { bone: 'BoneArmL', deg: -16 },
    ],
    points: { right: { bone: 'BoneForeArmR', at: [0.35, -0.022, -0.043] }, left: { bone: 'BoneForeArmL', at: [0.36, 0.027, -0.05] } },
    keep: ['BoneForeArmR', 'BoneForeArmL'],
    from: ['BoneForeArmR', 'BoneForeArmL'],
    muzzles: ['right', 'left'],
    length: 0.48,
    hip: { muzzle: [0, -0.3, -0.95], toeIn: 0 },
    aimed: { muzzle: [0, -0.25, -1.3], toeIn: 0 },
    // The game's own Grenadier: its launchers (Gun_R, Gun_L) carry their muzzles, so only those are drawn,
    // from the attacks that raise each, set low and wide so the drums stay out of the middle of the view.
    own: {
      pose: { clip: 'Attack Right', at: 0.6 },
      graft: { clip: 'Attack Left', at: 0.6, bones: ['BoneArmL'] },
      turns: [
        { bone: 'BoneArmR', deg: 6 },
        { bone: 'BoneArmL', deg: -6 },
      ],
      keep: ['Gun_R', 'Gun_L'],
      from: ['Gun_R', 'Gun_L'],
      muzzles: ['Ref_Weapon Right', 'Ref_Weapon Left'],
      length: 0.26,
      hip: { muzzle: [0, -0.3, -0.95], toeIn: 0 },
      aimed: { muzzle: [0, -0.3, -1.25], toeIn: 0 },
    },
  },
  // Twin P-38s at arm's length, settled after both shots of its Attack. The barrel line runs from
  // the shoulders (hand to muzzle it's 30° off the bore), so the length is the arm's.
  vaulter: {
    pose: { clip: 'Attack', at: 0.9 },
    keep: ['Bone Arm R', 'Bone Arm L'],
    from: ['Bone Arm R', 'Bone Arm L'],
    muzzles: ['Ref_Weapon Right', 'Ref_Weapon Left'],
    length: 0.62,
    hip: { muzzle: [0, -0.22, -0.95], toeIn: 0 },
    aimed: { muzzle: [0, -0.15, -0.92], toeIn: 0 },
  },
  // The healing gauntlet on the left forearm, reaching out as it heals (its Spell), angled in
  // toward the crosshair; the beam comes from Ref_Weapon, at the hand. The forearm alone, big and
  // close, so it runs back out of the view at the lower left: the upper arm is all shoulder pad,
  // which hung in front of the eye as a pale block hiding the gauntlet. No sights: aiming sets
  // it a little further off, so the zoom only brings it up a little, still out of the corner.
  medic: {
    pose: { clip: 'Spell', at: 0.5 },
    keep: ['BoneForeArmL'],
    from: ['BoneForeArmL'],
    muzzles: ['Ref_Weapon'],
    length: 0.42,
    hip: { muzzle: [-0.2, -0.25, -0.85], toeIn: -0.25 },
    aimed: { muzzle: [-0.2, -0.25, -1.2], toeIn: -0.25 },
  },
  // The LR-6 long rifle in Nova's own hands (story mode, Nova Covert Ops), as her
  // multiplayer keys hold it ready to fire: shouldered and level, a hand on the grip and one on
  // the handguard, fingers and all. The unit Seer's hands have no fingers, and its firing pose
  // brings the front elbow up into the view. She holds it left-handed: mirrored. From the elbows
  // down (the rifle rides her right forearm); her sword left out. The rifle has no muzzle bone:
  // its barrel runs up its bone's +Y, the tip 0.355 along. Her hand on the handguard holds it
  // with the wrist cocked up level with the barrel and the hand hanging from it; from the eye
  // that reads as a wrist above its hand. So her forearm is swung down about the hand, the hand
  // and the rifle left where they are: the wrist bends, and sits under the hand.
  seer: {
    model: 'smSeer',
    pose: { keys: 'seerGrip', seq: 'Stand J Attack', time: 1.67 },
    turns: [{ bone: 'NOV_arm_elbow_R_SkinPoint', about: 'across', at: 'NOV_hand_01_R_SkinPoint', deg: 45, hold: ['Bone_Gun', 'NOV_hand_01_R_SkinPoint'] }],
    keep: ['NOV_arm_elbow_R_SkinPoint', 'NOV_arm_elbow_L_SkinPoint'],
    drop: ['Sword_Vis_Ctrl'],
    points: { breech: { bone: 'Bone_Gun', at: [0, 0, -0.043] }, tip: { bone: 'Bone_Gun', at: [0, 0.355, -0.043] } },
    from: ['breech'],
    muzzles: ['tip'],
    length: 0.8,
    hip: { muzzle: [0.15, -0.21, -1.1], toeIn: 0.05 },
    aimed: { muzzle: [0.04, -0.1, -1], toeIn: 0 },
    mirror: true,
    hideAtAds: 0.5,
    // The unit Seer's own: its Attack holds the rifle left-handed, the front elbow up at the
    // shoulder, so from the forearms down only.
    fallback: {
      pose: { clip: 'Attack', at: 0.5 },
      keep: ['Bone 4Arm R', 'Bone 4ARM L', 'Bone_Rifle'],
      drop: ['Bone Hose B1', 'Blade Handle'],
      from: ['Bone_Rifle'],
      muzzles: ['Ref_Weapon'],
      length: 0.62,
      hip: { muzzle: [0.15, -0.21, -1.1], toeIn: 0.05 },
      aimed: { muzzle: [0.04, -0.1, -1], toeIn: 0 },
      mirror: true,
      hideAtAds: 0.5,
    },
  },
};

const deg = THREE.MathUtils.degToRad;
const q1 = new THREE.Quaternion();
const m1 = new THREE.Matrix4();
const m2 = new THREE.Matrix4();
const data = new THREE.Matrix4();
const m4 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

export class ArmsViewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 30);
  /** It found its pose, its barrel and some arms to draw: usable. */
  readonly ok: boolean;
  /** Sway, bob and recoil, about the eye. */
  private holder = new THREE.Group();
  /** A left-handed pose made right-handed. */
  private mirror = new THREE.Group();
  /** The posed soldier, turned and set so its muzzle sits where it shows. */
  private assembly = new THREE.Group();
  private inst: ModelInstance;
  private light: THREE.DirectionalLight;
  private muzzleBones: THREE.Object3D[];
  private nextMuzzle = 0;
  private hip = { q: new THREE.Quaternion(), p: new THREE.Vector3() };
  private aimed = { q: new THREE.Quaternion(), p: new THREE.Vector3() };
  private kick = 0;
  private sway = new THREE.Vector2();
  private bob = 0;

  constructor(
    template: ModelTemplate,
    private def: ArmsDef,
    /** The external keys its pose is a frame of, if it is. */
    keys?: ModelData,
  ) {
    const inst = template.instantiate(TEAM_COLOR.holdouts, true);
    this.inst = inst;
    const bones = inst.mesh.skeleton.bones;
    const points = new Map<string, THREE.Object3D>();
    for (const [name, p] of Object.entries(def.points ?? {})) {
      const bone = bones.find((b) => b.userData.sourceName === p.bone);
      if (!bone) continue;
      const point = new THREE.Object3D();
      point.position.fromArray(p.at);
      bone.add(point);
      points.set(name, point);
    }
    const named = (n: string): THREE.Object3D | null => points.get(n) ?? bones.find((b) => b.userData.sourceName === n) ?? inst.attachment(n);
    inst.object.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });
    this.assembly.add(inst.object);
    this.mirror.add(this.assembly);
    this.holder.add(this.mirror);
    this.scene.add(this.holder, this.camera);

    // The firing pose, held: a clip of its own, or a frame of the keys.
    const pose = def.pose;
    let posed = true;
    if ('keys' in pose) {
      const seq = keys?.sequences.find((x) => x.name === pose.seq);
      posed = !!keys && !!seq;
      if (keys && seq) {
        frameOf(template.data.bones, keys, seq, pose.time).forEach((l, i) => {
          bones[i].position.copy(l.position);
          bones[i].quaternion.copy(l.quaternion);
          bones[i].scale.copy(l.scale);
        });
      }
    } else {
      // Held, not played: the clip isn't run again, so what's grafted and turned below stays.
      const length = inst.play(pose.clip, { loop: false, fade: 0 })?.getClip().duration ?? 0;
      inst.update(length * pose.at);
      inst.setTimeScale(0);
    }
    this.scene.updateMatrixWorld(true);

    // Grafted chains: each root where the other clip has it in the model, bent below as it bends
    // them. (The assembly sits at the origin, unturned, for now: the scene is the model's frame.)
    if (def.graft) {
      const other = template.instantiate(TEAM_COLOR.holdouts);
      const length = other.play(def.graft.clip, { loop: false, fade: 0 })?.getClip().duration ?? 0;
      other.update(length * def.graft.at);
      other.object.updateMatrixWorld(true);
      const theirs = other.mesh.skeleton.bones;
      posed &&= length > 0;
      for (const name of def.graft.bones) {
        const root = bones.find((b) => b.userData.sourceName === name);
        if (!root?.parent) {
          posed = false;
          continue;
        }
        root.traverse((o) => {
          const k = bones.indexOf(o as THREE.Bone);
          if (k < 0) return;
          bones[k].position.copy(theirs[k].position);
          bones[k].quaternion.copy(theirs[k].quaternion);
          bones[k].scale.copy(theirs[k].scale);
        });
        m1.copy(root.parent.matrixWorld).invert().multiply(theirs[bones.indexOf(root)].matrixWorld).decompose(root.position, root.quaternion, root.scale);
      }
      this.scene.updateMatrixWorld(true);
    }

    // The barrel, in the assembly's own frame.
    const from = def.from.map(named);
    this.muzzleBones = def.muzzles.map(named).filter((b): b is THREE.Object3D => !!b);
    const middle = (list: THREE.Object3D[]) => list.reduce((a, b) => a.add(b.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).divideScalar(Math.max(1, list.length));
    const ends = () => ({ start: middle(from.filter((b): b is THREE.Object3D => !!b)), muzzle: middle(this.muzzleBones) });

    // The turns, each chain as one piece about its pivot; held bones put back where they were.
    for (const t of def.turns ?? []) {
      const bone = named(t.bone);
      const at = named(t.at ?? t.bone);
      if (!bone?.parent || !at) {
        posed = false;
        continue;
      }
      const pivot = at.getWorldPosition(new THREE.Vector3());
      const axis = UP.clone();
      if (t.about === 'barrel' || t.about === 'across') {
        const { start, muzzle } = ends();
        const along = muzzle.sub(start).normalize();
        if (t.about === 'across') axis.crossVectors(along, UP).normalize();
        else {
          axis.copy(along);
          pivot.sub(start).projectOnVector(along).add(start);
        }
      }
      const held = (t.hold ?? []).map(named).filter((h): h is THREE.Object3D => !!h?.parent).map((h) => ({ h, world: h.matrixWorld.clone() }));
      m2.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(data.makeRotationAxis(axis, deg(t.deg))).multiply(m4.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      m1.copy(bone.parent.matrixWorld).invert().multiply(m2).multiply(bone.matrixWorld).decompose(bone.position, bone.quaternion, bone.scale);
      this.scene.updateMatrixWorld(true);
      for (const { h, world } of held) {
        m1.copy(h.parent!.matrixWorld).invert().multiply(world).decompose(h.position, h.quaternion, h.scale);
        h.updateMatrixWorld(true);
      }
    }

    const { start, muzzle } = ends();
    const barrel = muzzle.clone().sub(start);
    const reach = barrel.length();
    barrel.divideScalar(reach || 1);

    // Turned so the barrel points ahead (-Z) and the body stands upright, then angled in; set so
    // the muzzle lands where it shows. A mirrored rig is set for the mirror image of the spot.
    const top = UP.clone().addScaledVector(barrel, -barrel.y).normalize();
    const back = barrel.clone().negate();
    const right = new THREE.Vector3().crossVectors(top, back);
    const level = new THREE.Quaternion().setFromRotationMatrix(m1.makeBasis(right, top, back)).invert();
    const s = def.length / Math.max(1e-3, reach);
    this.assembly.scale.setScalar(s);
    const flip = def.mirror ? -1 : 1;
    const set = (at: Placement, out: { q: THREE.Quaternion; p: THREE.Vector3 }) => {
      out.q.setFromAxisAngle(UP, at.toeIn * flip).multiply(level);
      out.p.set(at.muzzle[0] * flip, at.muzzle[1], at.muzzle[2]).sub(muzzle.clone().multiplyScalar(s).applyQuaternion(out.q));
    };
    set(def.hip, this.hip);
    set(def.aimed, this.aimed);
    this.place(0);
    // Mirrored only now: everything above was measured in the model's own hands.
    if (def.mirror) this.mirror.scale.set(-1, 1, 1);

    this.keepOnly(template);
    for (const m of inst.mesh.material as THREE.Material[]) {
      // Both faces: a unit's arms are open shells (where they meet the body, inside a cuff), and
      // from behind the shoulder one looks into them; drawn from outside only, they vanished
      // wherever seen from within (the Vaulter's sleeves were see-through).
      m.side = THREE.DoubleSide;
      // No self-lit panels, and a duller shine: this close to the eye they glare.
      if (!(m instanceof THREE.MeshPhongMaterial)) continue;
      m.emissiveIntensity = 0;
      m.specular.setHex(0x3a3a3a);
    }
    this.ok = posed && from.every((b) => !!b) && this.muzzleBones.length === def.muzzles.length && reach > 1e-3 && (inst.mesh.geometry.index?.count ?? 0) > 0;

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

  /** Only the arms and what they hold: triangles whose every corner rides a kept bone most, solid surfaces only. */
  private keepOnly(template: ModelTemplate) {
    const def = this.def;
    const mesh = this.inst.mesh;
    const bones = mesh.skeleton.bones;
    const keep = new Set<number>();
    const chain = (names: string[] | undefined, fn: (i: number) => void) => {
      for (const b of bones) if (names?.includes(b.userData.sourceName)) b.traverse((o) => fn(bones.indexOf(o as THREE.Bone)));
    };
    chain(def.keep, (i) => i >= 0 && keep.add(i));
    chain(def.drop, (i) => keep.delete(i));
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

  /** Nothing to take over: the weapon is its own. */
  claim(): this {
    return this;
  }

  shoot() {
    this.kick = Math.min(1, this.kick + 0.4);
  }

  /**
   * The muzzle in the main camera's world space (for rounds and flames): where it appears on
   * screen, the gun's narrower lens widened by the difference first. Twin weapons take turns,
   * call by call.
   */
  muzzleWorld(mainCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.nextMuzzle = (this.nextMuzzle + 1) % Math.max(1, this.muzzleBones.length);
    const bone = this.muzzleBones[this.nextMuzzle];
    this.scene.updateMatrixWorld(true);
    if (bone) bone.getWorldPosition(out);
    else out.set(0.15, -0.25, -0.7);
    const fov = (mainCamera as THREE.PerspectiveCamera).fov;
    if (fov) {
      const k = Math.tan(deg(fov) / 2) / Math.tan(deg(this.camera.fov) / 2);
      out.x *= k;
      out.y *= k;
    }
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  update(dt: number, opts: { moving: number; ads: number; turnX: number; turnY: number; aspect: number; fov: number; sunDir: THREE.Vector3; cameraQuat: THREE.Quaternion; camera: THREE.Camera }) {
    this.camera.aspect = opts.aspect;
    this.camera.fov = opts.fov * 0.85;
    this.camera.updateProjectionMatrix();
    this.holder.visible = opts.ads < (this.def.hideAtAds ?? 2);
    this.kick = Math.max(0, this.kick - dt * 7);
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-opts.turnX * 0.0009, -0.05, 0.05), 10, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(opts.turnY * 0.0009, -0.05, 0.05), 10, dt);
    this.bob += dt * opts.moving * 8;
    const bob = opts.moving * (1 - opts.ads) * 0.012;
    // Sway and bob shift the arms and the weapon together; a shot kicks them back and up.
    this.holder.position.set(this.sway.x + Math.sin(this.bob) * bob, this.sway.y - Math.abs(Math.cos(this.bob)) * bob, this.kick * 0.035);
    this.holder.rotation.set(this.kick * 0.03 + this.sway.y * 0.6, this.sway.x * 0.8, 0);
    this.place(opts.ads);
    const toView = q1.copy(opts.cameraQuat).invert();
    this.light.position.copy(opts.sunDir).applyQuaternion(toView).multiplyScalar(10);
  }
}
