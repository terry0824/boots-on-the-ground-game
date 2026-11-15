import { FASTER, type DamageResponse, type DamageStats, type DeathType, type Stats, type Splash } from './stats.ts';
import type { ModelName, SoundName } from '../content/assetnames.ts';
import type { CueName } from './sfx.ts';

/** Harlan's Holdouts (the player's side), the swarm, and the Directorate. */
export type Team = 'holdouts' | 'crawl' | 'directorate';

/**
 * Converting the maps' cells to meters. Movement uses infantry scale (a Trooper is
 * about one cell tall). Ranged weapons get twice that, so firefights happen at shooter
 * distances instead of point-blank; melee reach comes from each model's real size.
 */
export const METERS_PER_CELL = 2.2;
export const RANGE_METERS_PER_CELL = 4.4;
export const SPLASH_METERS_PER_CELL = 4;

/** One way of dying: its own death model (one of several, at random) and whether it has its own sound. */
export interface DeathVariant {
  model?: ModelName | readonly ModelName[];
  sound?: boolean;
}

export interface KindDef {
  dataId: string;
  model: ModelName;
  deathModel?: ModelName;
  /**
   * How it dies to blows that don't kill plainly: burning (Fire), dissolving in acid
   * (Disintegrate), torn apart, blown apart, a sniper's quiet kill. A death type it doesn't list
   * plays its plain death.
   */
  deaths?: Partial<Record<DeathType, DeathVariant>>;
  team: Team;
  weapon?: string;
  /** Fallback when the data has no walk animation speed: m/s at which Walk plays at normal rate. */
  walkAnimSpeed?: number;
  /** Radians per second; infantry and Crawl turn almost instantly, tanks and ships don't. */
  turnRate?: number;
  /** Color of the ichor or debris it sheds when hit. */
  hitColor?: number;
  sounds?: { attack?: SoundName; impact?: SoundName; death?: SoundName; voice?: SoundName };
  /** Layered sound cues (see sfx.ts), used instead of the plain sample where given. */
  cues?: { attack?: CueName; death?: CueName };
  missileColor?: number;
  /**
   * Meters a second, where the data's mover doesn't say (the Sower's Mite, flung by an
   * effect the chain doesn't follow) or a boss is meant to be dodged (Calyx's Psi Blast).
   * Otherwise a missile flies at its mover's speed.
   */
  missileSpeed?: number;
  /** Lobbed in an arc, where the data's mover throws it but the chain doesn't reach it (the Mite). */
  missileLob?: boolean;
  /**
   * Its weapon burns along a line through what it hits, this many cells either side, out to its
   * reach: the Torchrunner's Wide Flamer (its effect sets its areas, 0.15 across, every quarter
   * cell out from the Torchrunner; what's in them burns).
   */
  line?: number;
  /**
   * Tracked or wheeled: it leans with the ground under it (a tank on a ramp, its treads on the
   * slope), where a walker or a soldier stands upright. Held level on a slope, a tank's uphill
   * tread sank into the ground.
   */
  tilt?: true;
  /**
   * Its missile is a creature flung at the target, drawn with that creature's own model (the
   * Sower's missile: the Mite's model playing Birth, then Spell). It leaves from `from` (model
   * units, the model data's axes: x right, y back, z up; mirrored for the other side, which it
   * alternates with), is thrown out along `throw` as the data's mover throws it (its left and
   * right weapons' throw), and dives onto the target.
   */
  fling?: { model: ModelName; from: [number, number, number]; throw: [number, number, number] };
  /**
   * A campaign unit: its numbers come from the campaign's stats (true), or the later campaign's
   * over them ('swarm', loaded only where a mission asks: The Tide: Unleashed).
   */
  campaign?: boolean | 'swarm';
  /** What its missiles leave behind where they land (the Sower's Mites), and the timed-life effect that ends them. */
  impactSpawn?: { kind: string; life: string };
  /** Dies by its own attack (the Blister bursting). */
  suicide?: boolean;
  /** Size of its missile's glow, meters. */
  missileSize?: number;
  /** How hard its missiles steer after their target (per second; 6 by default). Low enough and they can be dodged. */
  missileHoming?: number;
  /** Fights on the move, swirling around its target (a Kite). */
  strafe?: boolean;
  /** A second weapon for flyers (the Warship's ATA Laser Battery). */
  antiAir?: string;
  /** A close-in weapon beside the main one (Calyx's Razor Talons inside her Psi Blast's minimum range). */
  secondary?: string;
  /**
   * Its weapon's effect models, as the game's actors assign them (the launch and impact models
   * they give it, and their scale): `impact` where a round lands, `launch` at the muzzle,
   * `missile` the model a missile carries in flight; `bleeds` adds the blood reaction
   * (`bloodImpact`) when it hits flesh.
   */
  effects?: KindEffects;
  /** Its anti-air weapon's own effect models, where they differ (a Picket's Seeker missiles, not its autocannons' shells). */
  airEffects?: KindEffects;
  /** Its anti-air weapon's own sound, where it differs (a Bulwark's Lances, the Behemoth's missile pods). */
  airCues?: { attack?: CueName };
  /** Its anti-air weapon's own samples, where the sound data gives them (a Picket's Seeker missiles, a Swift's paired missiles). */
  airSounds?: { attack?: SoundName; impact?: SoundName };
  /**
   * Leaps the last few meters onto what it attacks (the later campaign's Leaper strain): the
   * ability and the mover it flies on, and between what distances, cells (the nearest and the
   * farthest the ability allows).
   */
  leap?: { ability: string; mover: string; range: [number, number] };
}

export interface KindEffects {
  impact?: ModelName;
  launch?: ModelName;
  /**
   * The attachments its launch model plays at, all at once, where its attack actor's launch
   * matches several of its model's attachments: a Picket's two autocannons, a landed
   * Jackknife's two Gatlings. Its weapon attachment otherwise.
   */
  launchFrom?: string[];
  scale?: number;
  bleeds?: boolean;
  missile?: ModelName;
  /**
   * The body animation an attack with it plays, as its actor's weapon-start event has it:
   * "Attack" where unset; a Picket's Seekers its "Spell" (the missile arms kick out); none
   * (null) for a Bulwark's Lances or a Behemoth's missile pods, which move nothing but their covers.
   * (Played "Attack", a Bulwark held its cannons' recoil through every Lance volley, gliding.)
   */
  anim?: string | null;
  /** Seconds into its animation an attack starts, so the recoil lands with the shot (a Bulwark's cannons kick 0.87 s in). */
  animAt?: number;
  /**
   * Rounds an attack fires one after another from its `launchFrom` in turn, each its share of
   * the damage, spread over the attack: a Picket's twin autocannons, one a barrel, each finding
   * its own target.
   */
  rounds?: number;
  /**
   * Its missiles leave from these attachments in turn, attack after attack (its model's attachment
   * sets: a Picket's six Seeker tubes, left and right; a Bulwark's four shoulder pods).
   */
  launchCycle?: string[];
  /**
   * Seconds after the attack each of its missiles leaves (the data's launch periods), one a hit
   * where the attack has several (a Picket's two Seekers, a Bulwark's four Lances).
   */
  burst?: number[];
  /** Its missile drawn this many times the size its shooter's scale gives it (the model data has a Bulwark at half scale, its Lances at full). */
  missileScale?: number;
}

export const KIND_DEFS = {
  trooper: {
    effects: { impact: 'trooperImpact', launch: 'trooperLaunch', bleeds: true },
    dataId: 'Trooper', model: 'trooper', deathModel: 'trooperDeath', team: 'holdouts', weapon: 'CoilRifle',
    deaths: {
      Fire: { model: 'trooperDeathFire', sound: true },
      Disintegrate: { model: 'trooperDeathAcid', sound: true },
      Blast: { model: 'trooperDeathBlast' },
      Eviscerate: { model: ['trooperDeathEviscerate', 'trooperDeathEviscerate1'], sound: true },
      Silentkill: { sound: true },
    },
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { attack: 'rifle', death: 'trooperDeath' }, cues: { attack: 'rifle.npc', death: 'death.trooper' },
  },
  hound: {
    effects: { impact: 'houndImpact' },
    dataId: 'Hound', model: 'hound', deathModel: 'houndDeath', team: 'crawl', weapon: 'Claws',
    deaths: {
      Fire: { model: 'houndDeathFire', sound: true },
      Disintegrate: { model: 'houndDeathAcid', sound: true },
      Eviscerate: { model: ['houndDeathEviscerate', 'houndDeathEviscerate1'], sound: true },
    },
    walkAnimSpeed: 3.4, hitColor: 0x9a7a1c, sounds: { attack: 'houndAttack', death: 'houndDeath', voice: 'houndVoice' }, cues: { death: 'death.hound' },
  },
  quillback: {
    effects: { impact: 'quillbackMissileImpact', launch: 'quillbackMissileLaunch', missile: 'quillbackMissile', bleeds: true },
    dataId: 'Quillback', model: 'quillback', deathModel: 'quillbackDeath', team: 'crawl', weapon: 'NeedleSpines',
    deaths: { Fire: { model: 'quillbackDeathFire', sound: true }, Disintegrate: { model: 'quillbackDeathAcid', sound: true } },
    walkAnimSpeed: 3.6, hitColor: 0x9a7a1c, missileColor: 0xd8ff7a,
    sounds: { attack: 'quillbackLaunch', impact: 'quillbackImpact', death: 'quillbackDeath' }, cues: { death: 'death.quillback' },
  },
  shellback: {
    effects: { impact: 'shellbackMissileImpact', missile: 'shellbackMissile' },
    dataId: 'Shellback', model: 'shellback', deathModel: 'shellbackDeath', team: 'crawl', weapon: 'AcidSaliva',
    deaths: { Fire: { model: 'shellbackDeathFire', sound: true }, Disintegrate: { model: 'shellbackDeathAcid', sound: true } },
    walkAnimSpeed: 4.0, hitColor: 0x8a6a18, missileColor: 0x9cff40, missileSize: 1.4,
    sounds: { attack: 'shellbackLaunch', impact: 'shellbackImpact', death: 'shellbackDeath' }, cues: { death: 'death.shellback' },
  },
  tusker: {
    dataId: 'Tusker', model: 'tusker', deathModel: 'tuskerDeath', team: 'crawl', weapon: 'TuskBlades',
    deaths: { Fire: { model: 'tuskerDeathFire', sound: true }, Disintegrate: { model: 'tuskerDeathAcid', sound: true } },
    walkAnimSpeed: 6.5, hitColor: 0x8a6a18, sounds: { attack: 'tuskerLaunch', impact: 'tuskerImpact', death: 'tuskerDeath', voice: 'tuskerRoar' }, cues: { death: 'death.tusker' },
  },
  /** Braced Mode: rooted, Anvil Shock Cannon. Drawn with the transformation rig at the end of "Morph Start". */
  howitzer: {
    effects: { impact: 'braceImpact', launch: 'braceLaunch' },
    dataId: 'HowitzerBraced', model: 'howitzerMorph', deathModel: 'howitzerBracedDeath', team: 'holdouts',
    weapon: 'AnvilShockCannon', hitColor: 0x555555, turnRate: 2.5, tilt: true,
    sounds: { attack: 'tankFire', impact: 'shellImpact', death: 'humanExplosionMedium' }, cues: { attack: 'tank.brace', death: 'death.machine' },
  },
  /** Drive Mode: mobile, twin 90mm cannons. Drawn with the transformation rig at the end of "Morph End". */
  howitzerMobile: {
    effects: { impact: 'tankImpact', launch: 'tankLaunch' },
    dataId: 'Howitzer', model: 'howitzerMorph', deathModel: 'howitzerDeath', team: 'holdouts',
    weapon: '90mmCannons', hitColor: 0x555555, turnRate: 1.6, walkAnimSpeed: 6, tilt: true,
    sounds: { attack: 'tankCannon', impact: 'tankShellSmall', death: 'humanExplosionMedium' }, cues: { attack: 'tank.cannon', death: 'death.machine' },
  },
  /** The capital ship. Not a ground unit; its stats and laser battery come from the data. */
  warship: { dataId: 'Warship', model: 'warship', team: 'holdouts', weapon: 'ATSLaserBattery', antiAir: 'ATALaserBattery', hitColor: 0x555555, effects: { impact: 'bcImpact' } },
  holdfast: { dataId: 'Holdfast', model: 'holdfast', deathModel: 'holdfastDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  barracks: { dataId: 'Barracks', model: 'barracks', deathModel: 'barracksDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  bunker: { dataId: 'Bunker', model: 'bunker', deathModel: 'bunkerDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  storehouse: { dataId: 'Storehouse', model: 'storehouse', deathModel: 'storehouseDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** Wes Harlan as he fights on Calder: Saltwell Rising's hero unit, 200 life, his own rifle. */
  harlan: {
    effects: { impact: 'trooperImpact', launch: 'trooperLaunch', bleeds: true },
    dataId: 'Harlan', model: 'harlan', deathModel: 'harlanDeath', team: 'holdouts', weapon: 'HarlanCoilRifle', campaign: true,
    deaths: { Fire: { model: 'harlanDeathFire', sound: true } },
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { attack: 'rifle', death: 'trooperDeath' }, cues: { attack: 'rifle.npc', death: 'death.trooper' },
  },
  grenadier: {
    effects: { launch: 'grenadierLaunch', missile: 'grenadierMissile' },
    dataId: 'Grenadier', model: 'grenadier', deathModel: 'grenadierDeath', team: 'holdouts', weapon: 'BreakerGrenades',
    deaths: { Eviscerate: { model: 'grenadierDeathEviscerate', sound: true }, Silentkill: { sound: true } },
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, missileColor: 0xffb060,
    sounds: { attack: 'grenadierLaunch', impact: 'grenadierImpact', death: 'trooperDeath' }, cues: { death: 'death.trooper' },
  },
  burner: {
    dataId: 'Burner', model: 'burner', deathModel: 'burnerDeath', team: 'holdouts', weapon: 'Burner', campaign: true,
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { attack: 'burnerLaunch', death: 'trooperDeath' }, cues: { death: 'death.trooper' },
  },
  medic: {
    dataId: 'Medic', model: 'medic', deathModel: 'medicDeath', team: 'holdouts', campaign: true,
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { death: 'trooperDeath' }, cues: { death: 'death.trooper' },
  },
  seer: {
    effects: { impact: 'seerImpact', launch: 'seerLaunch', bleeds: true },
    dataId: 'Seer', model: 'seer', deathModel: 'seerDeath', team: 'holdouts', weapon: 'LongRifle',
    deaths: {
      Fire: { model: 'seerDeathFire', sound: true },
      Disintegrate: { model: 'seerDeathAcid', sound: true },
      Blast: { model: 'seerDeathBlast' },
      Eviscerate: { model: 'seerDeathEviscerate', sound: true },
    },
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { attack: 'seerLaunch', death: 'seerDeath' }, cues: { death: 'death.trooper' },
  },
  vaulter: {
    effects: { impact: 'vaulterImpact', launch: 'vaulterLaunch' },
    dataId: 'Vaulter', model: 'vaulter', deathModel: 'vaulterDeath', team: 'holdouts', weapon: 'PK2Pistol',
    walkAnimSpeed: 5.2, hitColor: 0x8a1a10, sounds: { attack: 'vaulterLaunch', death: 'trooperDeath' }, cues: { death: 'death.trooper' },
  },
  /** A colonist hauler: slow, unarmed, 150 life under vehicle plating. */
  colonistHauler: {
    dataId: 'ColonistHauler', model: 'colonistHauler', deathModel: 'colonistHaulerDeath', team: 'holdouts', campaign: true,
    hitColor: 0x555555, turnRate: 1.4, walkAnimSpeed: 4, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.vehicle' },
  },
  /** The Directorate's Logistical Headquarters on Calder: a broadcast tower. */
  radioTower: {
    dataId: 'LogisticsHeadquarters', model: 'radioTower', team: 'directorate', campaign: true, hitColor: 0x555555,
    sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' },
  },
  /** Rolls into the enemy and bursts: Volatile Burst, 16 (+19 against Light) to everything nearby, 80 to a building. */
  blister: {
    dataId: 'Blister', model: 'blister', deathModel: 'blisterDeath', team: 'crawl', weapon: 'VolatileBurst', suicide: true,
    walkAnimSpeed: 3.2, hitColor: 0x7ac01c, cues: { death: 'death.blister' },
  },
  /** The swarm's harasser: fast, in the air, a Bounce Shard that jumps from one target to the next. */
  kite: {
    effects: { impact: 'quillbackImpact', missile: 'kiteMissile' },
    dataId: 'Kite', model: 'kite', deathModel: 'kiteDeath', team: 'crawl', weapon: 'BounceShard', strafe: true,
    walkAnimSpeed: 8, turnRate: 4, hitColor: 0x9a7a1c, missileColor: 0xc8ff60, missileSize: 1.1,
    sounds: { impact: 'kiteImpact', voice: 'kiteVoice' }, cues: { attack: 'kite.attack', death: 'death.kite' },
  },
  /** Flying artillery: slow, armored, out of a rifle's reach for long, its Mites landing on whatever it's over. */
  sower: {
    effects: { impact: 'sowerImpact' },
    dataId: 'Sower', model: 'sower', deathModel: 'sowerDeath', team: 'crawl', weapon: 'MiteStrike',
    impactSpawn: { kind: 'mite', life: 'MiteLife' },
    // Its Mites ride at its sides (its model data seats them 1 to the side and 1 back) and are
    // flung from there.
    fling: { model: 'mite', from: [1, 1, 0], throw: [0.8, -1, 0.75] },
    walkAnimSpeed: 4, turnRate: 0.9, hitColor: 0x9a7a1c, missileColor: 0xffa040, missileSpeed: 26, missileLob: true,
    sounds: { impact: 'sowerImpact', voice: 'sowerVoice' }, cues: { attack: 'sower.attack', death: 'death.sower' },
  },
  mite: {
    dataId: 'Mite', model: 'mite', deathModel: 'miteDeath', team: 'crawl', weapon: 'NeedleClaws',
    deaths: { Fire: { model: 'miteDeathFire', sound: true }, Disintegrate: { model: 'miteDeathAcid', sound: true } },
    walkAnimSpeed: 3.4, hitColor: 0x9a7a1c, cues: { death: 'death.mite' },
  },
  /**
   * The Voice of the Crawl, as she fights on Scoria: 1000 life, a Psi Blast at range and Razor
   * Talons up close, both 75 (+75 against buildings). Her missile is slow enough to sidestep.
   */
  calyx: {
    dataId: 'Calyx', model: 'calyx', team: 'crawl', weapon: 'CalyxPsiBlast', secondary: 'CalyxTalons', campaign: true,
    walkAnimSpeed: 4.2, hitColor: 0x7a2a6a, missileColor: 0xd060ff, missileSpeed: 24, missileSize: 1.8, missileHoming: 1.2,
    sounds: { voice: 'calyxAttack', death: 'calyxDeath' },
  },
  /** The Forebear artifact in the Holdouts' containment rig: 3000 life, and the Aurora. */
  artifact: { dataId: 'Artifact', model: 'artifact', team: 'holdouts', campaign: true, hitColor: 0x7ab8ff, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** Anti-air: Longbolt Missiles, two 12s a volley, at flyers only. */
  flakTower: {
    effects: { impact: 'turretImpact', missile: 'flakTowerMissile', bleeds: true },
    dataId: 'FlakTower', model: 'flakTower', deathModel: 'flakTowerDeath', team: 'holdouts', weapon: 'LongboltMissile', hitColor: 0x555555,
    missileColor: 0xffd0a0, missileSize: 0.7, sounds: { attack: 'turretLaunch', death: 'buildingExplosion' }, cues: { death: 'death.building' },
  },
  workshop: { dataId: 'Workshop', model: 'workshop', deathModel: 'workshopDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  motorPool: { dataId: 'MotorPool', model: 'motorPool', deathModel: 'motorPoolDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  airfield: { dataId: 'Airfield', model: 'airfield', deathModel: 'airfieldDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  armory: { dataId: 'Armory', model: 'armory', deathModel: 'armoryDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  reactorHall: { dataId: 'ReactorHall', model: 'reactorHall', deathModel: 'reactorHallDeath', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  hiringHall: { dataId: 'HiringHall', model: 'hiringHall', team: 'holdouts', campaign: true, hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** A barricade of rubble and wire: 100 life, in the swarm's way until it's torn down. */
  defenseWall: { dataId: 'DefenseWall', model: 'defenseWall', team: 'holdouts', campaign: true, hitColor: 0x6a5a48, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.vehicle' } },
  /** Fenmoor's colonists, taken by the infestation: they shamble, they claw, they come at night. */
  turnedColonist: {
    dataId: 'TurnedColonist', model: 'turnedColonist', deathModel: 'turnedColonistDeath', team: 'crawl', weapon: 'TurnedClaws', campaign: true,
    deaths: { Fire: { model: 'turnedColonistDeathFire', sound: true } },
    walkAnimSpeed: 2.2, hitColor: 0x6a7a2a, sounds: { death: 'civilianDeath', voice: 'turnedMoan' }, cues: { death: 'death.turned' },
  },
  /** A colony Trooper, infested: still carries his rifle (5 damage, 4 range). */
  turnedTrooper: {
    effects: { impact: 'trooperImpact', bleeds: true },
    dataId: 'TurnedTrooper', model: 'turnedTrooper', deathModel: 'turnedTrooperDeath', team: 'crawl', weapon: 'TurnedTrooper', campaign: true,
    deaths: { Fire: { model: 'turnedTrooperDeathFire', sound: true }, Disintegrate: { model: 'turnedTrooperDeathAcid', sound: true } },
    walkAnimSpeed: 2.6, hitColor: 0x6a7a2a, sounds: { voice: 'turnedMoan' }, cues: { attack: 'rifle.npc', death: 'death.turned' },
  },
  /** The Swollen: 450 life, armor 1, fists for 20. */
  swollen: {
    dataId: 'Swollen', model: 'swollen', deathModel: 'swollenDeath', team: 'crawl', weapon: 'Swollen', campaign: true,
    walkAnimSpeed: 4.5, hitColor: 0x7a6a1a, sounds: { attack: 'tuskerLaunch', voice: 'tuskerRoar' }, cues: { death: 'death.tusker' },
  },
  /** A colonist hut the infestation has taken: 500 life, armor 1. */
  overgrownHut: { dataId: 'OvergrownHut', model: 'colonistHut', deathModel: 'colonistHutDeath', team: 'crawl', campaign: true, hitColor: 0x6a5a48, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** A colony biodome the infestation has taken: 1250 life, armor 1. */
  overgrownDome: { dataId: 'OvergrownDome', model: 'biodome', deathModel: 'biodomeDeath', team: 'crawl', campaign: true, hitColor: 0x6a5a48, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** Colonists cocooned on the walls, mid-infestation. */
  cocoon: { dataId: 'Cocoon', model: 'cocoon', team: 'crawl', campaign: true, hitColor: 0x7a8a22, cues: { death: 'death.hound' } },
  /** The dropship of the call-ins: Troopers and a Howitzer delivered where you mark. */
  dustoff: {
    dataId: 'Dustoff', model: 'dustoff', deathModel: 'dustoffDeath', team: 'holdouts', hitColor: 0x555555, turnRate: 1.6, walkAnimSpeed: 8,
    sounds: { death: 'humanExplosionMedium' }, cues: { death: 'death.machine' },
  },
  /** The Skywatch's Mender: dropped from orbit, it repairs what's broken until its power runs out. */
  mender: {
    dataId: 'Mender', model: 'mender', deathModel: 'menderDeath', team: 'holdouts', hitColor: 0x555555, walkAnimSpeed: 4,
    sounds: { death: 'menderExplode' }, cues: { death: 'death.vehicle' },
  },
  /** The worker: mines, builds and repairs (its Fusion Cutter isn't used here). */
  rigger: {
    dataId: 'Rigger', model: 'rigger', deathModel: 'riggerDeath', team: 'holdouts', hitColor: 0x555555, walkAnimSpeed: 4,
    sounds: { death: 'menderExplode' }, cues: { death: 'death.vehicle' },
  },
  /** The Airfield's air superiority fighter: Dart Torpedoes, two at a time, at flyers only. */
  jackknifeFighter: {
    effects: { missile: 'jackknifeFighterMissile', launch: 'jackknifeFighterMissileLaunch', impact: 'jackknifeFighterMissileImpact', bleeds: true },
    dataId: 'JackknifeFighter', model: 'jackknifeFighter', deathModel: 'jackknifeFighterDeath', team: 'holdouts', weapon: 'DartTorpedoes',
    hitColor: 0x555555, turnRate: 2.4, walkAnimSpeed: 8, missileColor: 0xffd0a0, missileSize: 0.6,
    sounds: { attack: 'jackknifeFighterAttack', impact: 'humanExplosionSmall', death: 'humanExplosionMedium' }, cues: { attack: 'jackknife.dart', death: 'death.machine' },
  },
  /** The Jackknife landed (Assault Mode, from AssaultMode): a walker with a Twin Gatling Cannon, at the ground only. */
  jackknifeAssault: {
    // Its attack launches from Ref_Weapon Left and Right, both Gatlings at once. Four rounds an
    // attack, from each in turn, a quarter of the damage apiece: its Attack and its sound (some
    // 0.8 s of fire) pour rounds out, where one landed.
    effects: { launch: 'jackknifeAssaultWeaponLaunch', launchFrom: ['Ref_Weapon Left', 'Ref_Weapon Right'], impact: 'jackknifeAssaultWeaponImpact', bleeds: true, rounds: 4 },
    dataId: 'JackknifeAssault', model: 'jackknifeAssault', deathModel: 'jackknifeAssaultDeath', team: 'holdouts', weapon: 'TwinGatlingCannon',
    hitColor: 0x555555, turnRate: 3, walkAnimSpeed: 4, sounds: { attack: 'jackknifeGatling', impact: 'burstImpact', death: 'humanExplosionMedium' }, cues: { attack: 'jackknife.gatling', death: 'death.machine' },
  },
  /** The Airfield's gunship: Strafe Rockets at whatever is on the ground under it. */
  nightjar: {
    effects: { missile: 'nightjarMissile', impact: 'nightjarMissileImpact' },
    dataId: 'Nightjar', model: 'nightjar', deathModel: 'nightjarDeath', team: 'holdouts', weapon: 'StrafeRockets',
    hitColor: 0x555555, turnRate: 2.4, walkAnimSpeed: 8, missileColor: 0xffc080, missileSize: 0.6,
    sounds: { attack: 'nightjarAttack', impact: 'nightjarImpact', death: 'humanExplosionMedium' }, cues: { attack: 'nightjar.rockets', death: 'death.machine' },
  },
  /** The campaign's Swift: lasers at the ground, paired missiles at flyers. */
  swift: {
    effects: { missile: 'swiftLaserMissile', impact: 'swiftLaserMissileImpact' },
    // Paired missiles: the data's two hits an attack are a pair of missiles, one from the pod
    // under each wingtip, all but together, each carrying its hit (one from the nose, both hits in it).
    airEffects: { missile: 'swiftMissile', impact: 'swiftMissileImpact', launchCycle: ['Ref_Weapon Left', 'Ref_Weapon Right'], burst: [0, 0.05] },
    dataId: 'Swift', model: 'swift', deathModel: 'swiftDeath', team: 'holdouts', weapon: 'SwiftG', antiAir: 'SwiftA', campaign: true,
    hitColor: 0x555555, turnRate: 2.8, walkAnimSpeed: 8, missileColor: 0xff5a40, missileSize: 0.5,
    sounds: { attack: 'warshipBattery', impact: 'swiftGroundImpact', death: 'humanExplosionMedium' },
    airSounds: { attack: 'nightjarAttack', impact: 'humanExplosionSmall' }, cues: { attack: 'swift.laser', death: 'death.machine' }, airCues: { attack: 'swift.missiles' },
  },
  /** The Motor Pool's raider: a Wide Flamer, a line of fire through light infantry. */
  torchrunner: {
    effects: { impact: 'torchrunnerBeamImpact' },
    dataId: 'Torchrunner', model: 'torchrunner', deathModel: 'torchrunnerDeath', team: 'holdouts', weapon: 'WideFlamer', line: 0.15,
    hitColor: 0x555555, turnRate: 3, walkAnimSpeed: 7, tilt: true, sounds: { attack: 'torchrunnerAttack', impact: 'torchrunnerImpact', death: 'humanExplosionMedium' }, cues: { attack: 'torchrunner.flame', death: 'death.machine' },
  },
  /** The Motor Pool's walker: Bulwark Cannons at the ground, Lance missiles at flyers. */
  bulwark: {
    // Its cannons' recoil 0.87 s into its Attack. The Lances leave the four shoulder pods in turn
    // (its model's Ref_Weapon 15-18, the data's launch periods), with no body animation, drawn three
    // times the size: the model data has the Bulwark at half scale and the missile at full.
    effects: { launch: 'bulwarkArmMissileLaunch', impact: 'bulwarkArmMissileImpact', animAt: 0.85 },
    airEffects: {
      launch: 'bulwarkShoulderMissileLaunch', missile: 'bulwarkMissile', impact: 'bulwarkChestMissileImpact', anim: null,
      launchCycle: ['Ref_Weapon 15', 'Ref_Weapon 16', 'Ref_Weapon 17', 'Ref_Weapon 18'], burst: [0, 0.089, 0.268, 0.357], missileScale: 3,
    },
    dataId: 'Bulwark', model: 'bulwark', deathModel: 'bulwarkDeath', team: 'holdouts', weapon: 'BulwarkCannons', antiAir: 'LanceMissileLaunchers',
    hitColor: 0x555555, turnRate: 1.4, walkAnimSpeed: 4, missileColor: 0xffd0a0, missileSize: 0.5,
    sounds: { attack: 'bulwarkAttack', impact: 'humanExplosionSmall', death: 'humanExplosionLarge' }, airSounds: { impact: 'bulwarkImpact' },
    cues: { attack: 'bulwark.cannon', death: 'death.machineLarge' }, airCues: { attack: 'bulwark.lance' },
  },
  // The Tide: Unleashed's classic machines, from the campaign's stats. Their models and sounds
  // load only for that mission (manifest.ts, UNLEASHED_MODELS).
  /** A walker: twin autocannons at the ground, Seeker missiles at flyers. */
  picket: {
    // Its attack launches from Ref_Weapon and Ref_Weapon 01, both autocannons at once.
    // Its impact (the landed Jackknife's) drawn at twice the size, or a 30 mm shell landing was a speck.
    // A round from each in turn, half the damage apiece (its burst is heard once an attack). Its
    // Seekers two an attack, 0.15 s apart, from the pods' six tubes in turn, right and left
    // (the order its model data gives them), the missile arms kicking out (its Spell).
    effects: { launch: 'jackknifeAssaultWeaponLaunch', launchFrom: ['Ref_Weapon', 'Ref_Weapon 01'], impact: 'jackknifeAssaultWeaponImpact', scale: 2.2, rounds: 2 },
    airEffects: {
      missile: 'picketAirMissile', launch: 'jackknifeFighterMissileLaunch', impact: 'picketAirMissileImpact', anim: 'Spell',
      launchCycle: ['Ref_Weapon 02', 'Ref_Weapon 05', 'Ref_Weapon 03', 'Ref_Weapon 06', 'Ref_Weapon 04', 'Ref_Weapon 07'], burst: [0, 0.15],
    },
    dataId: 'Picket', model: 'picket', deathModel: 'picketDeath', team: 'holdouts', weapon: 'PicketG', antiAir: 'PicketA', campaign: true,
    hitColor: 0x555555, turnRate: 2.4, walkAnimSpeed: 4, missileColor: 0xffd0a0, missileSize: 0.5,
    sounds: { attack: 'picketAttack', impact: 'burstImpact', death: 'humanExplosionMedium' },
    airSounds: { attack: 'jackknifeFighterAttack', impact: 'humanExplosionSmall' }, cues: { attack: 'picket.cannon', death: 'death.machine' }, airCues: { attack: 'picket.missiles' },
  },
  /** A hover bike: fragmentation grenades at the ground, and Scuttle Mines laid in the swarm's way. It turns on a coin. */
  coyote: {
    effects: { launch: 'seerFireSprite', missile: 'picketMissile', impact: 'jackknifeFighterMissileImpact' },
    dataId: 'Coyote', model: 'coyote', deathModel: 'coyoteDeath', team: 'holdouts', weapon: 'Coyote', campaign: true,
    hitColor: 0x555555, turnRate: 9, walkAnimSpeed: 8, tilt: true, missileColor: 0xffb070, missileSize: 0.5,
    sounds: { attack: 'coyoteAttack', impact: 'humanExplosionSmall', death: 'humanExplosionMedium' }, cues: { attack: 'coyote.grenade', death: 'death.machine' },
  },
  /** A Coyote's mine: burrowed until the swarm comes near, then it runs at it and bursts. */
  scuttleMine: { dataId: 'ScuttleMine', model: 'scuttleMine', team: 'holdouts', weapon: 'CoyoteScuttleMines', campaign: true, hitColor: 0x555555, walkAnimSpeed: 6 },
  /** The Directorate's prototype super-Bulwark (stolen by the Holdouts): twin cannons, missile pods, half again a Bulwark's height. */
  behemoth: {
    // Its cannons' recoil 0.97 s into its Attack; its missile pods' four from the chest guns in turn
    // (Ref_Weapon 09 and 12), no body animation, twice the size (as the Bulwark's).
    effects: { impact: 'braceImpact', launch: 'bulwarkArmMissileLaunch', animAt: 0.95 },
    airEffects: {
      missile: 'bulwarkMissile', launch: 'bulwarkShoulderMissileLaunch', impact: 'behemothShoulderMissileImpact', anim: null,
      launchCycle: ['Ref_Weapon 09', 'Ref_Weapon 12'], burst: [0, 0.143, 0.286, 0.429], missileScale: 2,
    },
    dataId: 'Behemoth', model: 'behemoth', deathModel: 'behemothDeath', team: 'holdouts', weapon: 'Behemoth', antiAir: 'BehemothAntiAir', campaign: true,
    hitColor: 0x555555, turnRate: 0.9, walkAnimSpeed: 4, missileColor: 0xffd0a0, missileSize: 0.7,
    sounds: { attack: 'bulwarkAttack', impact: 'humanExplosionSmall', death: 'humanExplosionLarge' }, airSounds: { impact: 'bulwarkImpact' },
    cues: { attack: 'behemoth.cannon', death: 'death.machineLarge' }, airCues: { attack: 'behemoth.missiles' },
  },
  // The later campaign's, from its stats (loaded only for The Tide: Unleashed).
  /** The Frigate: a frigate that fills the sky with rockets, at flyers only. */
  frigate: {
    effects: { missile: 'grenadierMissile', launch: 'jackknifeFighterMissileLaunch', impact: 'jackknifeFighterMissileImpact', bleeds: true },
    dataId: 'Frigate', model: 'frigate', deathModel: 'frigateDeath', team: 'holdouts', weapon: 'Frigate', campaign: 'swarm',
    hitColor: 0x555555, turnRate: 2.2, walkAnimSpeed: 8, missileColor: 0xffd0a0, missileSize: 0.5,
    sounds: { attack: 'frigateAttack', impact: 'frigateImpact', death: 'humanExplosionMedium' }, cues: { attack: 'frigate.missiles', death: 'death.machine' },
  },
  /** The Leaper strain: a Hound that leaps the last few meters onto its prey. */
  leaper: {
    effects: { impact: 'houndImpact' },
    dataId: 'Leaper', model: 'leaper', deathModel: 'leaperDeath', team: 'crawl', weapon: 'LeaperClaws', campaign: 'swarm',
    leap: { ability: 'LeaperCharge', mover: 'LeaperChargeMissile', range: [0.6, 4] },
    walkAnimSpeed: 3.4, hitColor: 0x9a7a1c, sounds: { attack: 'houndAttack', death: 'houndDeath', voice: 'houndVoice' }, cues: { death: 'death.hound' },
  },
  /** A refinery over a geyser: what the base's gas comes from. */
  refinery: { dataId: 'Refinery', model: 'refinery', team: 'holdouts', hitColor: 0x555555, sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' } },
  /** The swarm's transport: unarmed, slow, and full of Hounds over wherever it's headed. */
  lantern: {
    dataId: 'Lantern', model: 'lantern', deathModel: 'lanternDeath', team: 'crawl', walkAnimSpeed: 3, turnRate: 1, hitColor: 0x9a7a1c, cues: { death: 'death.sower' },
  },
  /** The swarm's anti-air: Parasite Spores at anything that flies. */
  bilewing: {
    effects: { missile: 'bilewingMissile', launch: 'bilewingMissileLaunch', impact: 'bilewingMissileImpact' },
    dataId: 'Bilewing', model: 'bilewing', deathModel: 'bilewingDeath', team: 'crawl', weapon: 'ParasiteSpore',
    walkAnimSpeed: 6, turnRate: 2.4, hitColor: 0x9a7a1c, missileColor: 0xd060ff, missileSize: 0.9, cues: { death: 'death.kite' },
  },
  /** An Ostrander hologram billboard: propaganda, destructible. */
  billboard: {
    dataId: 'DirectorateBillboard', model: 'billboard', team: 'directorate', campaign: true, hitColor: 0x555555,
    sounds: { death: 'buildingExplosion' }, cues: { death: 'death.building' },
  },
} satisfies Record<string, KindDef>;

export type KindName = keyof typeof KIND_DEFS;

export interface Weapon {
  id: string;
  /** Meters. */
  range: number;
  minRange: number;
  melee: boolean;
  /** Real seconds between attacks. */
  period: number;
  /** Real seconds from the start of an attack to the hit. */
  damagePoint: number;
  missile: boolean;
  damage: DamageStats;
  /** Splash rings in meters. */
  splash: Splash[];
  /** Whether it can shoot flyers, ground units, buildings (the data's target filters). */
  air: boolean;
  ground: boolean;
  structures: boolean;
  /** Meters to the next target a bouncing attack (Bounce Shard) jumps to. */
  bounceRange: number;
  /**
   * How its missile flies, from the data's mover: meters per real second (at the range scale, so
   * a missile takes its stats' time to cross a range), and whether it's lobbed. Null if instant.
   */
  flight: { speed: number; lob: boolean } | null;
  /**
   * Shots an attack fires at once, where a mode says more than one (The Tide: Unleashed's Bulwark,
   * two cannons; its four Lances): the first at the target, the rest at what's around it.
   */
  volley?: number;
  /**
   * How many targets near each other a volley spreads over, its shots taking turns among them (a
   * Bulwark's Lances at two flyers, the Behemoth's at three). Unset: each of a volley's other shots
   * goes to a different enemy round the target.
   */
  targets?: number;
  /** How far it reaches in the player's hands, meters, where a mode sets that apart from the AI's (Unleashed's Howitzers). */
  playerRange?: number;
  /**
   * It burns along a line through what it hits, this many meters either side, out to its reach
   * (see `KindDef.line`).
   */
  line?: number;
}

/** Whether a weapon can reach a target, by its target filters: flyers, ground units, buildings. */
export function canHit(w: Weapon | null | undefined, e: { isBuilding: boolean; flying: boolean }): boolean {
  if (!w) return true;
  if (e.isBuilding) return w.ground && w.structures;
  return e.flying ? w.air : w.ground;
}

export interface Kind {
  name: KindName;
  def: KindDef;
  maxHp: number;
  armor: number;
  /** Life per real second. */
  regen: number;
  /** Meters per real second. */
  speed: number;
  /**
   * The actor's walk animation speed: model units per second the Walk animation covers at its
   * natural rate (0 if unknown). Multiply by the model's scale for meters.
   */
  walkAnim: number;
  attributes: string[];
  weapon: Weapon | null;
  /** Its weapon against flyers, where that's a different one. */
  antiAir: Weapon | null;
  /** A close-in weapon beside the main one. */
  secondary: Weapon | null;
  /** Energy for casters (Medic, Seer): max, start, and regeneration per real second. */
  energy: { max: number; start: number; regen: number };
  /**
   * Flying height in cells (the data's), 0 on the ground. In meters it's this times the
   * model's own scale, so a flyer hangs at the height its art (and its death fall) is made for.
   */
  flying: number;
  /**
   * How far above the ground a ground unit's model is drawn, in its model's units: its height in
   * the data over its model's scale (a Vaulter skims on its jets, its toes below its origin). 0 for
   * the rest, and for flyers (their height is `flying`).
   */
  hover: number;
  /** Bursts when it dies, as when it attacks (the Blister's Volatile Burst). */
  burstOnDeath: boolean;
  /** How its behaviors answer damage (Calyx's shield). */
  damageResponses: DamageResponse[];
  /** What its attacks leave where they land, and for how many real seconds. */
  impactSpawn: { kind: KindName; life: number } | null;
  /** Its leap (systems/leap.ts): from and to how far, meters; real seconds between; meters a second; the arc's height, meters. */
  leap: { min: number; max: number; cooldown: number; speed: number; apex: number } | null;
  /**
   * Its push priority: it shoulders aside units of a lower one and never gives way to them. A
   * Massive one (a Bulwark, a Tusker) a step over the ordinary, as big as it is here beside the
   * infantry.
   */
  push: number;
}

/** The data a kind's numbers come from: the skirmish numbers, or a campaign's over them (null where that isn't loaded). */
export function dataOf(data: Stats, def: KindDef): Stats | null {
  return def.campaign === 'swarm' ? data.swarm : def.campaign ? data.campaign : data;
}

export function buildKinds(data: Stats): Record<KindName, Kind> {
  const out = {} as Record<KindName, Kind>;
  for (const [name, def] of Object.entries(KIND_DEFS) as [KindName, KindDef][]) {
    // A kind whose campaign isn't loaded here isn't in this mission.
    const src = dataOf(data, def);
    if (!src) continue;
    const stats = src.unit(def.dataId);
    const build = (id: string): Weapon => {
      const w = src.weapon(id);
      const melee = w.melee || w.range <= 1;
      return {
        id: w.id,
        range: melee ? w.range * METERS_PER_CELL : w.range * RANGE_METERS_PER_CELL,
        minRange: w.minRange * RANGE_METERS_PER_CELL,
        melee,
        period: w.period / FASTER,
        damagePoint: w.damagePoint / FASTER,
        // The Sower's strike is a Mite flung at the target: a missile in all but name.
        missile: w.missile || !!def.missileSpeed,
        damage: w.damage,
        splash: w.damage.splash.map((s) => ({ ...s, radius: s.radius * SPLASH_METERS_PER_CELL })),
        air: w.air,
        ground: w.ground,
        structures: w.structures,
        bounceRange: (w.damage.bounce?.radius ?? 0) * RANGE_METERS_PER_CELL,
        flight: ((f) => (f ? { speed: f.speed * FASTER * RANGE_METERS_PER_CELL, lob: f.lob } : null))(src.missileFlight(id)),
      };
    };
    const weapon = def.weapon ? build(def.weapon) : null;
    if (weapon && def.line) weapon.line = def.line * SPLASH_METERS_PER_CELL;
    out[name] = {
      name,
      def,
      maxHp: stats.lifeMax,
      armor: stats.lifeArmor,
      regen: stats.lifeRegen * FASTER,
      speed: stats.speed * FASTER * METERS_PER_CELL,
      walkAnim: src.walkAnimMoveSpeed(def.dataId),
      attributes: stats.attributes,
      weapon,
      antiAir: def.antiAir ? build(def.antiAir) : null,
      secondary: def.secondary ? build(def.secondary) : null,
      energy: { max: stats.energyMax, start: stats.energyStart, regen: stats.energyRegen * FASTER },
      flying: stats.flying ? stats.height : 0,
      hover: stats.flying ? 0 : stats.height / src.modelScale(def.dataId),
      burstOnDeath: !!def.weapon && stats.deathEffect === src.weaponEffect(def.weapon),
      damageResponses: stats.damageResponses,
      push: stats.pushPriority + (stats.attributes.includes('Massive') && stats.pushPriority <= 10 ? 1 : 0),
      impactSpawn: def.impactSpawn ? { kind: def.impactSpawn.kind as KindName, life: src.duration(def.impactSpawn.life, 5) / FASTER } : null,
      // A leap is movement: at the movement scale.
      leap: def.leap
        ? ((l, [min, max]) => ({ min: min * METERS_PER_CELL, max: max * METERS_PER_CELL, cooldown: l.cooldown / FASTER, speed: l.speed * FASTER * METERS_PER_CELL, apex: l.clearance * METERS_PER_CELL }))(
            src.leap(def.leap.ability, def.leap.mover),
            def.leap.range,
          )
        : null,
    };
  }
  return out;
}
