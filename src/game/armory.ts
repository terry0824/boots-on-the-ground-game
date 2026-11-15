import type { Kind, KindName } from './kinds.ts';
import { RANGE_METERS_PER_CELL } from './kinds.ts';

/**
 * Armory research: the militia's own upgrades with their real effects, bought with the
 * credits missions pay. Each level is the game's increment (Infantry Weapons is +1 damage per
 * level for the RK-4, Vehicle Plating +1 armor, and so on).
 */
export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  /** Credits for each level. */
  cost: number[];
  /** Rank needed for each level. */
  rank: number[];
  apply(kinds: Record<KindName, Kind>, level: number): void;
}

const INFANTRY: KindName[] = ['trooper'];
const TANKS: KindName[] = ['howitzer', 'howitzerMobile'];
const BUILDINGS: KindName[] = ['holdfast', 'barracks', 'bunker', 'storehouse'];

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'infantry-weapons',
    name: 'Infantry Weapons',
    desc: 'RK-4 rounds with denser slugs: +1 damage per attack per level.',
    cost: [150, 300, 450],
    rank: [0, 2, 4],
    apply(kinds, level) {
      for (const k of INFANTRY) if (kinds[k].weapon) kinds[k].weapon!.damage = { ...kinds[k].weapon!.damage, amount: kinds[k].weapon!.damage.amount + level };
    },
  },
  {
    id: 'infantry-armor',
    name: 'Infantry Armor',
    desc: 'Hardsuit armor plating: +1 armor per level for Troopers.',
    cost: [150, 300, 450],
    rank: [1, 3, 5],
    apply(kinds, level) {
      for (const k of INFANTRY) kinds[k].armor += level;
    },
  },
  {
    id: 'arm-shield',
    name: 'Arm Shield',
    desc: 'A shield on every Trooper: +10 life.',
    cost: [250],
    rank: [1],
    apply(kinds, level) {
      if (level) kinds.trooper.maxHp += 10;
    },
  },
  {
    id: 'vehicle-weapons',
    name: 'Vehicle Weapons',
    desc: 'Howitzer cannons: +2 (+1 armored) in Drive Mode, +4 (+1 armored) sieged, per level.',
    cost: [200, 350, 500],
    rank: [2, 4, 6],
    apply(kinds, level) {
      for (const [k, plus] of [['howitzerMobile', 2], ['howitzer', 4]] as const) {
        const w = kinds[k].weapon;
        if (!w) continue;
        w.damage = { ...w.damage, amount: w.damage.amount + plus * level, bonus: { ...w.damage.bonus, Armored: (w.damage.bonus.Armored ?? 0) + level } };
      }
    },
  },
  {
    id: 'vehicle-plating',
    name: 'Vehicle Plating',
    desc: 'Heavier plate on every tank: +1 armor per level.',
    cost: [200, 350, 500],
    rank: [2, 4, 6],
    apply(kinds, level) {
      for (const k of TANKS) kinds[k].armor += level;
    },
  },
  {
    id: 'reinforced',
    name: 'Reinforced Frames',
    desc: 'Structures reinforced: +2 armor for every building.',
    cost: [300],
    rank: [3],
    apply(kinds, level) {
      for (const k of BUILDINGS) kinds[k].armor += 2 * level;
    },
  },
  {
    id: 'long-sights',
    name: 'Long Sights',
    desc: 'Bunker fire control: +1 range for the guns firing from bunkers.',
    cost: [250],
    rank: [2],
    apply() {
      // Read by the bunker's guns (see BunkerGuns): one cell of range.
    },
  },
];

/** Range added to bunker guns by Long Sights, meters. */
export function bunkerRangeBonus(levels: Record<string, number>): number {
  return (levels['long-sights'] ?? 0) * RANGE_METERS_PER_CELL;
}

/** Applies every bought upgrade to the unit kinds. */
export function applyUpgrades(kinds: Record<KindName, Kind>, levels: Record<string, number>) {
  for (const u of UPGRADES) {
    const level = levels[u.id] ?? 0;
    if (level > 0) u.apply(kinds, level);
  }
}
