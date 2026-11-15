import * as THREE from 'three';
import { FASTER, type Stats } from '../stats.ts';
import type { Unit } from '../entity.ts';
import type { KindName } from '../kinds.ts';
import type { ModelName, SoundName } from '../../content/assetnames.ts';
import { HeroVisual } from '../visual.ts';

/**
 * Transformations, for any unit the stats let change shape (a morph ability): a Jackknife landing
 * as a walker, and lifting off again. Each takes its ability's own time (the stats' morph
 * timing), is drawn on the unit's transformation rig playing its clip, brings a flyer down (or
 * up) over the ability's move time, and makes the unit the other kind at the end: its stats,
 * weapons and model, flying or not. It carries on whoever is driving the unit, or nobody: a
 * player who climbs out halfway doesn't leave it stuck between shapes. (The Howitzer's own
 * transformation, in tank.ts, came first and works the same way.)
 */

export interface MorphDef {
  from: KindName;
  to: KindName;
  /** The ability it times itself by (the stats' morphTiming). */
  ability: string;
  /** The model it's drawn on while it transforms, and the clip that plays. */
  rig: ModelName;
  clip: string;
  sound?: SoundName;
  /** What the HUD calls it under way ("Landing"). */
  label: string;
}

/** Every transformation, by the kind that starts it. */
export const MORPHS: MorphDef[] = [
  // The rig's "Morph Start" ends in Assault Mode, "Morph End" in Fighter Mode (as the Howitzer's).
  { from: 'jackknifeFighter', to: 'jackknifeAssault', ability: 'AssaultMode', rig: 'jackknifeMorph', clip: 'Morph Start', sound: 'jackknifeToAssault', label: 'Landing' },
  { from: 'jackknifeAssault', to: 'jackknifeFighter', ability: 'FighterMode', rig: 'jackknifeMorph', clip: 'Morph End', sound: 'jackknifeToFighter', label: 'Taking off' },
];

/** The transformation a kind can make, if any. */
export function morphFrom(kind: KindName): MorphDef | null {
  return MORPHS.find((m) => m.from === kind) ?? null;
}

/** Timings, real seconds, read once per ability. */
const timings = new Map<string, { total: number; moveDelay: number; move: number }>();
let data: Stats | null = null;

/** The game data the transformations time themselves by (set once at load). */
export function useMorphData(d: Stats) {
  data = d;
  timings.clear();
}

function timing(ability: string) {
  let t = timings.get(ability);
  if (!t) {
    const raw = data?.morphTiming(ability) ?? { total: 2.34, moveDelay: 0.5, move: 1.2 };
    t = { total: raw.total / FASTER, moveDelay: raw.moveDelay / FASTER, move: Math.max(0.05, raw.move / FASTER) };
    timings.set(ability, t);
  }
  return t;
}

/** A transformation under way: the unit's `morph`. */
class Morph {
  private t = 0;
  private readonly fromAlt: number;
  private readonly toAlt: number;
  private readonly wasCustom: boolean;
  private readonly wasHero: boolean;
  /** A kind to turn back into once this is done (the AI taking back a Jackknife the player landed). */
  then: KindName | null = null;

  constructor(
    private u: Unit,
    readonly def: MorphDef,
    private time: { total: number; moveDelay: number; move: number },
  ) {
    const w = u.world;
    // From where it is (the player's aircraft flies at its own height), to the other kind's.
    this.fromAlt = Math.max(0, u.position.y - w.terrain.heightAt(u.position.x, u.position.z));
    this.toAlt = w.kinds[def.to].flying * u.scale;
    this.wasCustom = u.customAnimation;
    this.wasHero = u.visual instanceof HeroVisual;
    u.customAnimation = true;
    u.immobile = true;
    u.airborne = true;
    u.move.set(0, 0);
    u.velocity.set(0, 0, 0);
    // A full skeleton for the rig while it transforms: the clip is a one-shot.
    w.setHero(u, true, w.models[def.rig]);
    const length = u.visual.play(def.clip, { loop: false, restart: true, fade: 0 });
    if (length > 0) u.visual.setTimeScale(length / time.total);
    if (def.sound) w.audio.play(def.sound, { at: u.position, volume: 0.9 });
  }

  /** How far along, 0..1. */
  get progress(): number {
    return Math.min(1, this.t / this.time.total);
  }

  /** True while it's still transforming. */
  update(dt: number): boolean {
    const u = this.u;
    const w = u.world;
    this.t += dt;
    u.move.set(0, 0);
    // Down to the ground (or up to its flying height) over the ability's move time, eased.
    const k = THREE.MathUtils.clamp((this.t - this.time.moveDelay) / this.time.move, 0, 1);
    const e = k * k * (3 - 2 * k);
    u.position.y = w.terrain.heightAt(u.position.x, u.position.z) + THREE.MathUtils.lerp(this.fromAlt, this.toAlt, e);
    u.syncTransform();
    if (this.t < this.time.total) return true;
    // The other kind, on its own model, life kept as a share.
    const share = u.hp / u.maxHp;
    // A full skeleton afterwards for the player's body (or one that had it before); a crowd otherwise.
    const hero = w.player === u || this.wasHero;
    u.kind = w.kinds[this.def.to];
    u.hp = share * u.maxHp;
    u.morph = null;
    u.immobile = false;
    u.airborne = false;
    u.customAnimation = this.wasCustom;
    w.setHero(u, hero, w.models[u.kind.def.model]);
    u.visual.play('Stand', { restart: true, fade: 0 });
    u.refit();
    if (this.then && this.then !== u.kind.name) morphTo(u, this.then);
    return false;
  }
}

/** The transformation under way on `u`, if any. */
export function morphOf(u: Unit): Morph | null {
  return u.morph instanceof Morph ? u.morph : null;
}

/** Starts `u`'s transformation, if it has one and isn't already transforming. */
export function beginMorph(u: Unit): boolean {
  if (u.morph || !u.alive) return false;
  const def = morphFrom(u.kind.name);
  if (!def) return false;
  u.morph = new Morph(u, def, timing(def.ability));
  return true;
}

/**
 * Makes `u` become `kind` by its transformations, as soon as it can: now, or once the one under
 * way is done (it turns back if that was going the other way).
 */
export function morphTo(u: Unit, kind: KindName) {
  if (u.kind.name === kind && !u.morph) return;
  const m = morphOf(u);
  if (m) {
    m.then = m.def.to === kind ? null : kind;
    return;
  }
  if (morphFrom(u.kind.name)?.to === kind) beginMorph(u);
}
