import type { Splash } from '../../stats.ts';
import type { Kind, KindName, Weapon } from '../../kinds.ts';

/**
 * The Tide: Unleashed's power at real-world scale (docs/the-tide-unleashed.md, section 4).
 * The data compresses everything for readability: a 15 m Bulwark needs several hits for one
 * Hound, and a Howitzer in Drive Mode has no splash at all. Here each machine hits as hard
 * as its size and its gun suggest, the AI's and the player's alike, so the battlefield reads true
 * whoever is driving; big Crawl stay big. Applied to the mission's kinds when they're built, so
 * nothing outside this mode changes.
 */

/**
 * A weapon with no range limit in the player's hands: as far as the crosshair finds something
 * (vehicle.ts aims out to 2.5 km), meters.
 */
const UNLIMITED = 2000;

/** The player's edge over the AI: the same shots-to-kill on foot as today (the AI's infantry hit twice as hard here), a little in a machine. */
export const PLAYER_EDGE = { infantry: 3.5 / 2, vehicle: 1.25 };

/** A weapon's Unleashed numbers: damage and bonuses (absolute, or a multiple of the data's), and splash rings in meters. */
export interface WeaponPower {
  /** Multiplies the data's damage and every bonus. */
  scale?: number;
  amount?: number;
  bonus?: Record<string, number>;
  /** [radius in meters, fraction] rings, replacing the data's. */
  splash?: [number, number][];
  /** How its missile flies (meters a second; lobbed or not), where the data's mover doesn't serve. */
  flight?: { speed: number; lob: boolean };
  /** How far it reaches, meters, where its size says further than the data's (the Behemoth's guns). */
  range?: number;
  /**
   * Shots an attack fires at once (the Bulwark's two cannons, its four Lances): see
   * `Weapon.volley`. Each is one hit: the data counts them as the attack's hits, and counted
   * again as shots, a Bulwark's Lances struck sixteen times.
   */
  volley?: number;
  /** How far it reaches when the player drives it, meters, where that's further than the AI's: see `Weapon.playerRange`. */
  playerRange?: number;
  /** How many targets a volley spreads over, near each other: see `Weapon.targets`. */
  targets?: number;
  /** Fires this many times as often as the data's (its period divided by it). */
  rate?: number;
}

export interface KindPower {
  /** Life, absolute. */
  life?: number;
  /** Life, a multiple of the data's. */
  lifeScale?: number;
  armor?: number;
  /** Speed, a multiple of the data's. */
  speed?: number;
  weapon?: WeaponPower;
  antiAir?: WeaponPower;
}

/** The AI's infantry hit twice as hard; the player's keep the shooter's edge they have today. */
const INFANTRY: WeaponPower = { scale: 2 };

/*
 * Machines keep the data's armor and get one and a half to two and a half times its life:
 * enough to wade into the swarm, not enough to stand in it. (The first pass's armor, 3 to 6
 * against Hounds that bite for 5, made a tank all but proof against the swarm.) Their guns
 * reach as far as their size says, two to three times the data's few cells: the swarm still
 * closes, by numbers.
 */
export const UNLEASHED_POWER: Partial<Record<KindName, KindPower>> = {
  trooper: { weapon: INFANTRY },
  grenadier: { weapon: INFANTRY },
  burner: { weapon: INFANTRY },
  seer: { weapon: INFANTRY },
  vaulter: { weapon: INFANTRY },
  // Twin 90 mm cannons that burst: a Hound a shell, a Shellback in two. The AI's reach a fifth
  // less than the player's: braced at 90 m, a battery of them shelled the swarm before it ever
  // reached the lines.
  howitzerMobile: { life: 350, weapon: { amount: 45, bonus: { Armored: 30 }, splash: [[2.5, 1], [4, 0.5]], range: 40, playerRange: 50 } },
  // The Anvil's 180 mm shell: everything but a Tusker dies within 4 m, most things within 7.
  howitzer: { life: 350, weapon: { amount: 120, bonus: { Armored: 80 }, splash: [[4, 1], [7, 0.5], [10, 0.25]], range: 72, playerRange: 90 } },
  // A walker a few floors tall. Its two arm cannons fire together (the data's two attacks), each
  // shell bursting through a pack; its four Lances a volley, as the data has them, a Kite each
  // and the ones beside it.
  bulwark: {
    life: 1000,
    armor: 2,
    weapon: { amount: 80, bonus: {}, splash: [[3, 1], [5, 0.5]], range: 55, volley: 2 },
    // Its Lances at two flyers near each other at once (the player's lock on one picks the other).
    antiAir: { amount: 25, bonus: { Light: 25 }, splash: [[2.5, 1]], range: 70, volley: 4, targets: 2 },
  },
  // A raider buggy at a buggy's speed (85 km/h): the data's is a jolted Trooper's and a little more,
  // and Unleashed's Hounds run faster than that.
  torchrunner: { life: 160, speed: 1.8, weapon: { scale: 3 } },
  // Dart Torpedoes (its only weapon, at flyers): a Kite a pair; the armored heavies take
  // longer, a Bilewing two pairs and a Sower three or four from the player's own (with the
  // data's armored bonus, +45, two pairs brought a Sower down).
  jackknifeFighter: { life: 220, weapon: { amount: 60, bonus: {}, range: 80 } },
  // Landed, its Gatlings reach whatever the player aims at.
  jackknifeAssault: { life: 220, weapon: { amount: 35, bonus: {}, splash: [[1.5, 1]], range: 40, playerRange: UNLIMITED } },
  // Strafe Rockets that burst: the Hound hit and the ones around it.
  nightjar: { life: 220, weapon: { amount: 35, bonus: {}, splash: [[3, 1], [5, 0.5]], range: 40 } },
  // Its lasers half again as often (they did too little, and they're hard to keep on a target
  // from the air), reaching whatever the player aims at; its paired missiles out to 100 m in the
  // player's hands (67 m, half again).
  swift: { life: 220, weapon: { amount: 35, bonus: {}, range: 45, rate: 1.5, playerRange: UNLIMITED }, antiAir: { amount: 30, bonus: { Armored: 25 }, range: 50, playerRange: 67 } },
  dustoff: { life: 250 },
  // The classic machines (only here).
  // Twin 30 mm autocannons that burst; Seeker missiles, a Kite in two volleys (the data's
  // mover throws them, so they're given a missile's flight).
  picket: {
    life: 260,
    weapon: { amount: 45, bonus: {}, splash: [[1.5, 1]], range: 45 },
    antiAir: { amount: 35, bonus: { Armored: 35 }, flight: { speed: 75, lob: false }, range: 60 },
  },
  // Fragmentation grenades: a Hound a grenade, and the one beside it.
  coyote: { life: 120, weapon: { amount: 35, bonus: { Light: 30 }, splash: [[2, 1]], range: 35 } },
  // A mine that clears a street: everything but a Tusker dies within 6 m.
  scuttleMine: { weapon: { amount: 250, bonus: {}, splash: [[4, 1], [6, 0.5], [8, 0.25]] } },
  // The frigate, firing as the First War's did: rockets in volleys of eight, light ones
  // each, spread over up to four flyers near each other and bursting through the cloud round
  // them (a Kite clump thinned a volley at a time). Half the first pass's: at 14 (+6 light),
  // three rockets brought down a Kite.
  frigate: { life: 220, weapon: { amount: 7, bonus: { Light: 3 }, splash: [[3, 1], [6, 0.5]], range: 55, volley: 8, targets: 4 } },
  // The prize: a walking fortress the swarm parts around. Twin cannons half again a Bulwark's, and
  // missile pods a volley of four, reaching as far as a 30 m walker's guns should.
  behemoth: {
    life: 4000,
    armor: 3,
    weapon: { amount: 200, bonus: {}, splash: [[5, 1], [8, 0.5]], range: 75, volley: 2 },
    antiAir: { amount: 60, bonus: {}, splash: [[3, 1]], range: 90, volley: 4, targets: 3 },
  },
  // Flak Towers: Longbolt Missiles that reach a little short of the Bulwark's Lances and bring
  // down a Kite in a couple of pairs (the data's 31 m left them behind the lines with nothing
  // in reach).
  flakTower: { life: 400, weapon: { amount: 30, bonus: {}, range: 60 } },
  // Big things stay big.
  tusker: { lifeScale: 2 },
  sower: { lifeScale: 2 },
  lantern: { lifeScale: 2 },
};

function powered(w: Weapon | null, p: WeaponPower | undefined): Weapon | null {
  if (!w || !p) return w;
  const k = p.scale ?? 1;
  const bonus = p.bonus ?? Object.fromEntries(Object.entries(w.damage.bonus).map(([a, v]) => [a, v * k]));
  const splash: Splash[] = p.splash ? p.splash.map(([radius, fraction]) => ({ radius, fraction, arc: 360 })) : w.splash;
  return { ...w, damage: { ...w.damage, amount: p.amount ?? w.damage.amount * k, bonus, hits: p.volley ? 1 : w.damage.hits }, splash, flight: p.flight ?? w.flight, missile: w.missile || !!p.flight, range: p.range ?? w.range, volley: p.volley ?? w.volley, playerRange: p.playerRange ?? w.playerRange, targets: p.targets ?? w.targets, period: p.rate ? w.period / p.rate : w.period };
}

/** Gives the mission's kinds their Unleashed power. */
export function unleash(kinds: Record<KindName, Kind>, power = UNLEASHED_POWER) {
  for (const [name, p] of Object.entries(power) as [KindName, KindPower][]) {
    const kind = kinds[name];
    if (!kind) continue;
    if (p.life) kind.maxHp = p.life;
    if (p.lifeScale) kind.maxHp *= p.lifeScale;
    if (p.armor !== undefined) kind.armor = p.armor;
    if (p.speed) kind.speed *= p.speed;
    kind.weapon = powered(kind.weapon, p.weapon);
    kind.antiAir = powered(kind.antiAir, p.antiAir);
  }
}
