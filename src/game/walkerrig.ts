import * as THREE from 'three';
import type { Unit } from './entity.ts';
import type { Weapon } from './kinds.ts';
import { HeroVisual } from './visual.ts';

/**
 * A walker the player drives (a Bulwark, the Behemoth, a Picket, a landed Jackknife), animated in two
 * halves, as an infantryman is (trooper.ts): its legs walk or stand by how it's moving (backwards
 * as it backs up), and its upper body goes along with them except while it fires, when it plays
 * the weapon's own animation (`KindEffects.anim`) from where the recoil lands with the shot.
 * Played whole, a cannon's Attack (which keys the legs too) froze the walk while it lasted or
 * snapped it back to its first step at every shot. Missiles with no body animation of their own
 * (a Bulwark's Lances, the Behemoth's pods) kick the torso back as each leaves, toward the side it left
 * from, and it springs back: the shoulders took a volley without a flinch.
 */

/** The bone each model's upper body hangs from (its torso; a Picket's turret). */
const SPLITS: Record<string, string> = {
  bulwark: 'Bone_Torso',
  behemoth: 'BoneBoxSpine',
  picket: 'Ref_TurretZ',
  jackknifeAssault: 'Bone_Box33',
};

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

/** How fast it has to be going for its legs to walk, m/s. */
const WALKING = 0.6;

/** A missile's kick to the torso: pitched back and rolled toward its side, radians a second. */
const KICK_PITCH = 1.2;
const KICK_ROLL = 0.6;
/** The torso's spring back: its stiffness (per second squared) and damping (per second). */
const KICK_STIFFNESS = 130;
const KICK_DAMPING = 13;
/** The most it leans, radians, however many leave at once. */
const KICK_MAX = 0.12;

interface Halves {
  upper: THREE.AnimationClip;
  lower: THREE.AnimationClip;
  /** The model's own clip, for its emitters (a Picket's shell casings fly in its Attack). */
  name: string;
}

export class WalkerRig {
  private halves = new Map<string, Halves | null>();
  private upper: THREE.AnimationAction | null = null;
  private lower: THREE.AnimationAction | null = null;
  private upperName = '';
  private lowerName = '';
  /** Seconds left of an attack on the upper body. */
  private firing = 0;
  private upperBones = new Set<number>();
  private split: number;
  /** Over the torso bone: turned by the missiles' kick about the torso's own joint. */
  private pivot: THREE.Object3D | null = null;
  private kick = { pitch: 0, pitchRate: 0, roll: 0, rollRate: 0 };

  /** A rig for `u`'s model, or null where it has none (or isn't drawn in full). */
  static for(u: Unit): WalkerRig | null {
    const bone = SPLITS[u.kind.def.model];
    if (!bone || !(u.visual instanceof HeroVisual)) return null;
    const bones = u.visual.template.data.bones;
    const split = bones.findIndex((b) => b.name === bone);
    return split >= 0 ? new WalkerRig(u, u.visual, split) : null;
  }

  private constructor(
    private u: Unit,
    private visual: HeroVisual,
    split: number,
  ) {
    this.split = split;
    const bones = visual.template.data.bones;
    const under = (i: number) => {
      for (let p = i; p >= 0; p = bones[p].parent) if (p === split) return true;
      return false;
    };
    bones.forEach((_, i) => under(i) && this.upperBones.add(i));
    u.customAnimation = true;
    visual.instance.mixer.stopAllAction();
    const torso = visual.instance.mesh.skeleton.bones[split];
    if (torso?.parent) {
      this.pivot = new THREE.Object3D();
      torso.parent.add(this.pivot);
      this.pivot.add(torso);
    }
    u.onLaunch = (from) => this.launched(from);
    u.afterAnimate = () => this.pose();
    this.update(0);
  }

  /** A missile left from `from`: the torso is kicked back, and toward that side. */
  private launched(from: THREE.Vector3) {
    const u = this.u;
    if (this.u.world.effectsOf(u, u.attackWeapon)?.anim !== null) return;
    const right = v1.set(-Math.cos(u.yaw), 0, Math.sin(u.yaw));
    const side = Math.sign(v2.copy(from).sub(u.position).dot(right));
    this.kick.pitchRate += KICK_PITCH;
    this.kick.rollRate += side * KICK_ROLL;
  }

  /** After the clips have posed it: the torso turned by its kick, about its own joint. */
  private pose() {
    const pivot = this.pivot;
    const torso = pivot?.children[0];
    const parent = pivot?.parent;
    if (!pivot || !torso || !parent) return;
    const k = this.kick;
    if (Math.abs(k.pitch) < 1e-4 && Math.abs(k.roll) < 1e-4) {
      pivot.quaternion.identity();
      pivot.position.set(0, 0, 0);
      return;
    }
    const u = this.u;
    // Back about its right (positive leans the top away from the front), rolled about its front.
    const turn = q1.setFromAxisAngle(v1.set(-Math.cos(u.yaw), 0, Math.sin(u.yaw)), k.pitch);
    turn.multiply(q2.setFromAxisAngle(v2.set(Math.sin(u.yaw), 0, Math.cos(u.yaw)), k.roll));
    const frame = parent.getWorldQuaternion(q2);
    pivot.quaternion.copy(frame).invert().multiply(turn).multiply(frame);
    // About the torso's joint: its place in the parent's frame stays where it is.
    pivot.position.copy(torso.position).sub(v1.copy(torso.position).applyQuaternion(pivot.quaternion));
  }

  /** `name` cut in two: the tracks of the bones under the split, and the rest (the split bone's own place stays with the legs). */
  private cut(name: string): Halves | null {
    if (this.halves.has(name)) return this.halves.get(name)!;
    const clip = this.visual.template.variants(name)[0];
    let h: Halves | null = null;
    if (clip) {
      const up: THREE.KeyframeTrack[] = [];
      const down: THREE.KeyframeTrack[] = [];
      for (const t of clip.tracks) {
        const m = /^b(\d+)\.(\w+)/.exec(t.name);
        const bone = m ? Number(m[1]) : -1;
        // The torso's own drop (an Behemoth's crouch as it fires) would sink it into its hips.
        const upper = this.upperBones.has(bone) && !(bone === this.split && m?.[2] === 'position');
        (upper ? up : down).push(t);
      }
      h = { upper: new THREE.AnimationClip(`${clip.name}-upper`, clip.duration, up), lower: new THREE.AnimationClip(`${clip.name}-lower`, clip.duration, down), name: clip.name };
    }
    this.halves.set(name, h);
    return h;
  }

  /** The upper body fires `w`: its animation (if it has one) from its recoil, fitted to the attack. */
  fire(w: Weapon) {
    const fx = this.u.world.effectsOf(this.u, w);
    const anim = fx?.anim === undefined ? 'Attack' : fx.anim;
    const h = anim ? this.cut(anim) : null;
    if (!h) return;
    const at = Math.min(fx?.animAt ?? 0, h.upper.duration);
    const left = Math.max(0.05, h.upper.duration - at);
    const cooldown = w.period / this.u.attackRate;
    const rate = Math.max(1, left / Math.max(0.2, cooldown));
    const action = this.visual.instance.mixer.clipAction(h.upper);
    action.reset().setLoop(THREE.LoopOnce, 1).play();
    action.clampWhenFinished = true;
    action.time = at;
    action.timeScale = rate;
    if (this.upper && this.upper !== action) this.upper.stop();
    this.upper = action;
    this.upperName = anim!;
    this.firing = left / rate;
  }

  update(dt: number) {
    const u = this.u;
    // The kick's spring, in small steps (it's stiff).
    const k = this.kick;
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      k.pitchRate += (-KICK_STIFFNESS * k.pitch - KICK_DAMPING * k.pitchRate) * h;
      k.rollRate += (-KICK_STIFFNESS * k.roll - KICK_DAMPING * k.rollRate) * h;
      k.pitch = THREE.MathUtils.clamp(k.pitch + k.pitchRate * h, -KICK_MAX, KICK_MAX);
      k.roll = THREE.MathUtils.clamp(k.roll + k.rollRate * h, -KICK_MAX, KICK_MAX);
    }
    const speed = Math.hypot(u.velocity.x, u.velocity.z);
    const along = u.velocity.x * Math.sin(u.yaw) + u.velocity.z * Math.cos(u.yaw);
    const name = speed > WALKING ? 'Walk' : 'Stand';
    const rate = name === 'Walk' ? (along < -0.5 ? -1 : 1) * (u.walkRate(speed) || 1) : 1;
    const mixer = this.visual.instance.mixer;
    const legs = this.cut(name);
    if (legs && (name !== this.lowerName || !this.lower)) {
      const next = mixer.clipAction(legs.lower);
      next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
      if (this.lower && this.lower !== next) next.crossFadeFrom(this.lower, 0.2, false);
      this.lower = next;
      this.lowerName = name;
    }
    if (this.lower) this.lower.timeScale = rate;
    this.firing -= dt;
    if (this.firing <= 0 && legs) {
      // Back with the legs, in step with them.
      if (this.upperName !== name || !this.upper) {
        const next = mixer.clipAction(legs.upper);
        next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        if (this.upper && this.upper !== next) next.crossFadeFrom(this.upper, 0.25, false);
        this.upper = next;
        this.upperName = name;
      }
      this.upper.timeScale = rate;
      if (this.lower) this.upper.time = this.lower.time;
    }
    // Its emitters go by the half that's doing something: the attack while it fires (a
    // Picket's casings), the walk otherwise (an Behemoth's exhausts).
    const shown = this.firing > 0 ? this.upper : this.lower;
    const clip = this.firing > 0 ? this.cut(this.upperName) : legs;
    this.visual.instance.layered = shown && clip ? { clip: clip.name, time: shown.time, loop: this.firing <= 0, timeScale: shown.timeScale } : null;
  }

  /** Back to the whole model's animation, as the AI plays it. */
  release() {
    const inst = this.visual.instance;
    inst.layered = null;
    inst.mixer.stopAllAction();
    if (this.pivot) {
      this.pivot.quaternion.identity();
      this.pivot.position.set(0, 0, 0);
    }
    if (this.u.onLaunch) this.u.onLaunch = null;
    if (this.u.afterAnimate) this.u.afterAnimate = null;
    this.u.customAnimation = false;
    this.u.visual.play('Stand', { restart: true, fade: 0 });
  }
}
