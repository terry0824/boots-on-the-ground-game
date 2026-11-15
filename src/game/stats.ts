// The game's stats, by id: the shapes of what a unit, a weapon and an ability are (damage, splash,
// how a unit takes a hit...), the questions the game asks of them (\`Stats\`), and the arithmetic
// of a hit. The numbers themselves come from the content: the game's own table, or a plugin's.

/** Players play on "Faster", which runs game time 1.4x as fast as "Normal", the speed the numbers are given in. */
export const FASTER = 1.4;

export interface Splash {
  radius: number;
  fraction: number;
  arc: number; // degrees; 360 is a full circle
}

/**
 * How a blow kills (its damage effect's death type): a plain death, burning (Fire),
 * dissolving in acid (Disintegrate), torn apart (Eviscerate), blown apart (Blast), a sniper's
 * quiet kill (Silentkill)... Each unit's actor has its own death model for some of them.
 */
export type DeathType = 'Normal' | 'Fire' | 'Disintegrate' | 'Eviscerate' | 'Blast' | 'Silentkill' | 'Electrocute' | 'Eat' | 'Squish' | 'Timeout' | 'Remove';

export interface DamageStats {
  amount: number;
  bonus: Record<string, number>; // extra damage against units with an attribute
  splash: Splash[];
  /** Damage instances per attack (the Vaulter's two pistols), armor applying to each. */
  hits?: number;
  /**
   * What it deals to structures, where a separate effect handles them (the Blister's
   * Volatile Burst: 16, +19 against Light, to units; 80 to buildings).
   */
  structure?: number;
  /** The attack hands on to one more enemy nearby (the Kite's Bounce Shard: 9, then 3, then 1). */
  bounce?: { radius: number; damage: DamageStats };
  /** How it kills, when not plainly (the Burner's flames burn, the Shellback's acid dissolves). */
  death?: DeathType;
  /**
   * How much of the target's armor counts against it, where not all (a weapon's damage takes
   * armor in full; a spell's ignores it: the Keel Gun, the Warhead, the Seer's Snipe).
   */
  armor?: number;
}

export interface WeaponStats {
  id: string;
  range: number;
  minRange: number;
  period: number; // seconds between attacks, Normal speed
  damagePoint: number; // seconds into the attack when damage happens
  missile: boolean;
  damage: DamageStats;
  /** A melee weapon by the data's own flag: claws, blades, a Swollen's fists. */
  melee: boolean;
  /** What it can shoot at, by the weapon's target filters: flyers, ground units, buildings. */
  air: boolean;
  ground: boolean;
  structures: boolean;
}

/**
 * A behavior's response to incoming damage (Calyx's shield on Scoria: no weapon hit over
 * 6; spells at a quarter). Applies to weapon attacks, to spells, or both, by the damage kinds
 * the behavior names.
 */
export interface DamageResponse {
  weapon: boolean;
  spell: boolean;
  /** Damage below this passes untouched. */
  minimum: number;
  /** Only answers a blow that would kill (the Voice of the Crawl can't die on Scoria). */
  fatal: boolean;
  /** Whose damage it answers, by its target filters: the enemy's, its own side's. */
  enemy: boolean;
  friendly: boolean;
  clampMax: number;
  fraction: number;
  /** How likely it is to answer a given blow (a 20% chance to shrug one off). */
  chance: number;
}

export interface UnitStats {
  id: string;
  lifeMax: number;
  lifeArmor: number;
  lifeRegen: number; // per second, Normal speed
  speed: number; // cells per second, Normal speed
  radius: number;
  attributes: string[];
  weapons: WeaponStats[];
  energyMax: number;
  energyStart: number;
  /** Per second, Normal speed. */
  energyRegen: number;
  /** In the air plane (Kites, Sowers): over cliffs and buildings, hit only by anti-air. */
  flying: boolean;
  /** Flying height, cells. */
  height: number;
  /** An effect its behaviors fire when it dies (the Blister's Volatile Burst). */
  deathEffect: string | null;
  damageResponses: DamageResponse[];
  /** Who moves aside for whom: a unit pushes only those of a lower priority (10 for most; the Behemoth 11, civilians 5). */
  pushPriority: number;
}

export interface KeelGunStats {
  damage: DamageStats;
  prep: number; // Normal speed
  cooldown: number; // Normal speed
}

export interface JoltStats {
  duration: number; // Normal speed
  moveSpeed: number;
  attackSpeed: number;
  lifeCost: number;
  cooldown: number;
}

/**
 * The game's stats: what a unit, a weapon, an ability costs, takes and does, asked by id. Where the
 * numbers come from is the content's business: the game's own table (numbers.ts), or a plugin's.
 */
export interface Stats {
  /** The campaign's numbers, for campaign-only units (the same where there's no difference). */
  campaign: Stats;
  /** A later campaign's numbers over those, where a mission asked for them: null otherwise. */
  swarm: Stats | null;
  unit(id: string): UnitStats;
  /** The Medic's heal (the campaign's "heal", a heal over time): life per second and energy per life. */
  heal(): { rate: number; energyPerLife: number; range: number };
  /** The Dustoff's heal (its autocast): life per second (Normal speed), energy per life, range in cells. */
  dustoffHeal(): { rate: number; energyPerLife: number; range: number };
  /** The Seer's Personal Shroud: energy to switch on and energy drained per second. */
  shroud(): { cost: number; drain: number };
  /** Warhead Strike: the blast (damage in rings) and the seconds it takes to land. */
  warhead(): { damage: DamageStats; delay: number };
  weapon(id: string): WeaponStats;
  /**
   * How a weapon's missile flies, from its launch effect's mover: the fastest of its motion
   * phases (cells a second, Normal speed), and whether a phase throws it in an arc first (the
   * Sower's Mite) or it is guided straight in (most of them: the Quillback's needles at 40, the
   * Shellback's acid at 18.75, a Breaker round at 20). Null for an instant weapon.
   */
  missileFlight(id: string): { speed: number; lob: boolean } | null;
  /** What a unit costs to make: ore, fuel, and the supply it takes up. */
  cost(id: string): { ore: number; gas: number; supply: number };
  /** Seconds (Normal speed) a production building takes to train a unit, from its train ability, or null if nothing trains it. */
  trainTime(id: string): number | null;
  /** Seconds (Normal speed) a worker takes to build a structure, from its build ability, or null. */
  buildTime(id: string): number | null;
  /** The effect a weapon fires (its own id when it doesn't name one). */
  weaponEffect(id: string): string;
  /** Seconds (Normal speed) a timed-life effect lasts: a Mite's 5. */
  duration(effect: string, fallback: number): number;
  /**
   * A leap at what it's attacking (the later campaign's Leaper: LeaperCharge, cast on its own
   * as it attacks): Normal seconds between leaps (the ability's cooldown), and how its mover flies
   * it: cells a Normal second, and the arc's clearance (cells).
   */
  leap(ability: string, mover: string): { cooldown: number; speed: number; clearance: number };
  /** The Warship's Keel Gun: a launched missile carrying one huge damage effect. */
  keelGun(): KeelGunStats;
  /**
   * The speed (cells per Normal second, in the model's own units) at which a unit's walk
   * animation plays at its natural rate; the game scales the animation by speed over this.
   * 0 when the actor doesn't say.
   */
  walkAnimMoveSpeed(actor: string): number;
  /** The scale the game draws a unit's model at: its model's scale in the data (the Vaulter's 0.8); 1 if unset. */
  modelScale(id: string): number;
  /**
   * A transformation's timing (a morph: the Jackknife's AssaultMode and FighterMode), Normal
   * seconds: the whole of it (its animation), and when the body moves within it (its movement:
   * a flyer coming down, or going up).
   */
  morphTiming(ability: string): { total: number; moveDelay: number; move: number };
  /**
   * A transport's hold (a transport ability: the Dustoff's): its cargo space, Normal seconds between
   * units unloaded, whether its cargo dies with it, and how far "load all" reaches (cells).
   */
  transport(ability?: string): { space: number; unloadPeriod: number; cargoDeath: boolean; searchRadius: number };
  /** How much of a transport's hold a unit takes; 0 if it can't be carried. */
  cargoSize(id: string): number;
  /** Seconds (Normal speed) to transform into Braced Mode: the morph's delay plus its animation. */
  braceTime(): number;
  /** The Jolt: the Trooper's, or the Grenadier's (`JoltGrenadier`, which costs 20 life). */
  jolt(id?: string): JoltStats;
  /**
   * The Voice of the Crawl's Blight Storm on Scoria: damage every period (Normal seconds) to everything
   * within the radius (cells), for `count` periods.
   */
  blightStorm(): { damage: DamageStats; radius: number; period: number; count: number };
  /** Crush: seconds (Normal) until the target is crushed. */
  crush(): number;
  /**
   * The artifact's Aurora: its damage, the ring's reach in cells (the search grows by its
   * radius bonus every period), and the seconds (Normal) it takes to roll out.
   */
  aurora(): { amount: number; cells: number; seconds: number };
  /**
   * The Skywatch's calldowns: its energy (start, max, regeneration per Normal second),
   * the Skyscan (cost, reveal radius in cells, Normal seconds) and the Mender (cost, timed
   * life in Normal seconds).
   */
  orbital(): {
    energy: { start: number; max: number; regen: number };
    skyscan: { cost: number; radius: number; duration: number };
    /** `delay`: Normal seconds from the call to the Mender stepping out of its pod. */
    mender: { cost: number; life: number; delay: number };
  };
  /** Stagger Rounds: the Breaker grenade's slow (behavior "Slow"). Duration in Normal seconds. */
  stagger(): { factor: number; duration: number };
}

/** The damage one hit deals: amount plus attribute bonuses, less armor (as much of it as counts), never below 0.5. */
export function hitDamage(damage: DamageStats, targetAttributes: readonly string[], targetArmor: number, fraction = 1): number {
  let amount = damage.amount;
  if (damage.structure !== undefined && targetAttributes.includes('Structure')) amount = damage.structure;
  else for (const attr of targetAttributes) amount += damage.bonus[attr] ?? 0;
  return Math.max(0.5, amount * fraction - targetArmor * (damage.armor ?? 1)) * (damage.hits ?? 1);
}
