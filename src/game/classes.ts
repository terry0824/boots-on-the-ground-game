import type { KindName } from './kinds.ts';
import type { PortraitName } from './portrait.ts';

export type ClassId = 'trooper' | 'medic' | 'grenadier' | 'burner' | 'vaulter' | 'seer';

/** How a class's primary weapon is fired by the player. */
export type FireStyle = 'burst' | 'grenade' | 'flame' | 'heal' | 'pistols' | 'rifle';

/**
 * The infantry the player can deploy as: the militia's soldiers with their own numbers,
 * each a different way to fight. PlanetSide's classes map onto them closely: the Trooper is
 * the rifleman, the Medic the combat medic, the Grenadier heavy assault, the Vaulter light
 * assault with a jet pack, the Seer the infiltrator, and the Burner a close-quarters brute.
 */
export interface ClassDef {
  id: ClassId;
  kind: KindName;
  name: string;
  role: string;
  /** One line for the deploy screen. */
  desc: string;
  /** What each key does, for the deploy screen and HUD. */
  keys: [string, string][];
  portrait: PortraitName;
  /** Rank needed to deploy as this class. */
  rank: number;
  fire: FireStyle;
  /** Shift: Jolt or Personal Shroud; the jet pack (Space, or Shift). */
  shift: 'jolt' | 'shroud' | 'jump' | null;
}

export const CLASSES: ClassDef[] = [
  {
    id: 'trooper',
    kind: 'trooper',
    name: 'Trooper',
    role: 'Rifleman',
    desc: 'RK-4 coil rifle and the Jolt. The backbone of every militia line.',
    keys: [['Left button', 'RK-4 burst'], ['Right button', 'Aim down sights'], ['Shift', 'Jolt'], ['Q', 'Ultimate']],
    portrait: 'trooper',
    rank: 0,
    fire: 'burst',
    shift: 'jolt',
  },
  {
    id: 'medic',
    kind: 'medic',
    name: 'Medic',
    role: 'Combat medic',
    desc: 'No gun, all heart: heals the infantry around you, drawing on energy. Every life saved pays.',
    keys: [['Left button', 'Heal: keep it on an ally'], ['Auto', 'Heals nearby wounded'], ['Q', 'Ultimate']],
    portrait: 'medic',
    rank: 1,
    fire: 'heal',
    shift: null,
  },
  {
    id: 'grenadier',
    kind: 'grenadier',
    name: 'Grenadier',
    role: 'Heavy assault',
    desc: 'Breaker grenades, double damage against armor; every hit slows. 125 life under thick plate.',
    keys: [['Left button', 'Breaker grenade'], ['Shift', 'Jolt'], ['Q', 'Ultimate']],
    portrait: 'grenadier',
    rank: 2,
    fire: 'grenade',
    shift: 'jolt',
  },
  {
    id: 'burner',
    kind: 'burner',
    name: 'Burner',
    role: 'Close assault',
    desc: 'Kiln flamethrowers burn everything in front of you. Armored, slow to fall, short reach. Jolts as a Trooper does.',
    keys: [['Left button', 'Flamethrower'], ['Shift', 'Jolt'], ['Q', 'Ultimate']],
    portrait: 'burner',
    rank: 3,
    fire: 'flame',
    // The data's Burner has no Jolt; the First War's did, as the Trooper's (faster legs and a
    // faster burn, for 10 life).
    shift: 'jolt',
  },
  {
    id: 'vaulter',
    kind: 'vaulter',
    name: 'Vaulter',
    role: 'Light assault',
    desc: 'Twin pistols and a jet pack: up and down cliffs where no one else can go. Fast and fragile.',
    keys: [['Left button', 'PK-2 pistols'], ['Space · E', 'Jet pack jump'], ['Q', 'Ultimate']],
    portrait: 'vaulter',
    rank: 4,
    fire: 'pistols',
    shift: 'jump',
  },
  {
    id: 'seer',
    kind: 'seer',
    name: 'Seer',
    role: 'Infiltrator',
    desc: 'LR-6 long rifle with a scope, Personal Shroud, and the Warhead Strike.',
    keys: [['Left button', 'LR-6 rifle'], ['Right button', 'Scope'], ['E · Shift', 'Shroud (energy)'], ['Q', 'Warhead Strike (ultimate)']],
    portrait: 'seer',
    rank: 5,
    fire: 'rifle',
    shift: 'shroud',
  },
];

// Without a plugin's text, the cards' lines are the game's own (their names and keys are named as they're shown: content/names.ts).

export function classById(id: string | undefined): ClassDef {
  return CLASSES.find((c) => c.id === id) ?? CLASSES[0];
}

/** The class a unit kind plays as, when the player takes it over. */
export function classForKind(kind: KindName): ClassDef {
  return CLASSES.find((c) => c.kind === kind) ?? CLASSES[0];
}
