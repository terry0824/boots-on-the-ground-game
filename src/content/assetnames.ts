// The names the game asks for its assets by: every model, animation, piece of music and sound it
// uses. The content supplies each by its name: the game's own pack (public/content/original, its
// index listing what it has), a plugin, or the game's stand-ins where neither has one.

/** Models every mission loads. */
export const MODEL_NAMES = [
  'trooper', 'trooperDeath', 'hound', 'houndDeath', 'quillback', 'quillbackDeath', 'shellback', 'shellbackDeath',
  'tusker', 'tuskerDeath', 'holdfast', 'barracks', 'bunker', 'storehouse', 'howitzer', 'howitzerMorph',
  'howitzerDeath', 'howitzerBracedDeath', 'warship', 'rifle', 'smTrooper', 'smSeer', 'harlan', 'harlanDeath',
  'grenadier', 'grenadierDeath', 'burner', 'burnerDeath', 'medic', 'medicDeath', 'seer', 'seerDeath', 'vaulter',
  'vaulterDeath', 'radioTower', 'billboard', 'statue', 'colonistHauler', 'colonistHaulerDeath', 'blister',
  'blisterDeath', 'kite', 'kiteDeath', 'sower', 'sowerDeath', 'mite', 'miteDeath',
  'calyx', 'artifact', 'flakTower', 'workshop', 'motorPool', 'airfield', 'armory', 'reactorHall',
  'hiringHall', 'defenseWall', 'dustoff', 'dustoffDeath', 'mender', 'menderDeath', 'dropPod', 'comsatScanner',
  'turnedColonist', 'turnedColonistDeath', 'turnedTrooper', 'turnedTrooperDeath', 'swollen',
  'swollenDeath', 'colonistHut', 'biodome', 'cocoon', 'holdfastDeath', 'barracksDeath', 'bunkerDeath',
  'storehouseDeath', 'workshopDeath', 'motorPoolDeath', 'airfieldDeath', 'armoryDeath', 'reactorHallDeath',
  'flakTowerDeath', 'colonistHutDeath', 'biodomeDeath', 'trooperLaunch', 'trooperImpact', 'bloodImpact',
  'metalImpact', 'armorImpact', 'seerLaunch', 'seerImpact', 'vaulterLaunch', 'vaulterImpact', 'grenadierLaunch',
  'tankLaunch', 'tankImpact', 'braceLaunch', 'braceImpact', 'turretImpact', 'bcImpact', 'bcMissile',
  'quillbackImpact', 'shellbackImpact', 'houndImpact', 'sowerImpact', 'quillbackMissile', 'quillbackMissileLaunch',
  'quillbackMissileImpact', 'shellbackMissile', 'shellbackMissileImpact', 'kiteMissile', 'bilewingMissile',
  'bilewingMissileLaunch', 'bilewingMissileImpact', 'grenadierMissile', 'flakTowerMissile',
  'jackknifeFighterMissile', 'jackknifeFighterMissileLaunch', 'jackknifeFighterMissileImpact', 'nightjarMissile',
  'nightjarMissileImpact', 'bulwarkArmMissileLaunch', 'bulwarkArmMissileImpact', 'bulwarkShoulderMissileLaunch',
  'bulwarkChestMissileImpact', 'jackknifeAssaultWeaponLaunch', 'jackknifeAssaultWeaponImpact', 'torchrunnerBeamImpact',
  'swiftLaserMissile', 'swiftLaserMissileImpact', 'swiftMissile', 'swiftMissileImpact', 'bulwarkMissile', 'rigger',
  'riggerDeath', 'jackknifeFighter', 'jackknifeFighterDeath', 'jackknifeAssault', 'jackknifeAssaultDeath', 'jackknifeMorph', 'nightjar',
  'nightjarDeath', 'swift', 'swiftDeath', 'torchrunner', 'torchrunnerDeath', 'bulwark', 'bulwarkDeath', 'lantern',
  'lanternDeath', 'bilewing', 'bilewingDeath', 'oreField', 'refinery', 'trooperDeathFire', 'trooperDeathAcid',
  'trooperDeathBlast', 'trooperDeathEviscerate', 'trooperDeathEviscerate1', 'houndDeathFire', 'houndDeathAcid',
  'houndDeathEviscerate', 'houndDeathEviscerate1', 'quillbackDeathFire', 'quillbackDeathAcid', 'shellbackDeathFire',
  'shellbackDeathAcid', 'tuskerDeathFire', 'tuskerDeathAcid', 'seerDeathFire', 'seerDeathAcid', 'seerDeathBlast',
  'seerDeathEviscerate', 'miteDeathFire', 'miteDeathAcid', 'turnedTrooperDeathFire',
  'turnedTrooperDeathAcid', 'turnedColonistDeathFire', 'harlanDeathFire', 'grenadierDeathEviscerate',
] as const;

/** Models only The Tide: Unleashed (and the Practice Range) loads: its classic machines and their effects. */
export const UNLEASHED_MODEL_NAMES = [
  'picket', 'picketDeath', 'picketAirMissile', 'picketAirMissileImpact', 'coyote', 'coyoteDeath',
  'seerFireSprite', 'picketMissile', 'scuttleMine', 'scuttleMineExplosion', 'behemoth', 'behemothDeath',
  'behemothShoulderMissileImpact', 'frigate', 'frigateDeath', 'leaper', 'leaperDeath', 'jumpLandDust', 'bulwarkFootprint',
  'burnerFireSprite', 'magneticMine', 'magneticMineMissile', 'vaulterJumpLandDown', 'humanSmallBlast',
] as const;

export type ModelName = (typeof MODEL_NAMES)[number] | (typeof UNLEASHED_MODEL_NAMES)[number];

/** Animation keys first person takes its grips from. */
export const ANIMATION_NAMES = [
  'trooperGrip', 'rifleGrip', 'seerGrip',
] as const;

export type AnimationName = (typeof ANIMATION_NAMES)[number];

/** The score: one piece per mood. */
export const MUSIC_NAMES = [
  'calm', 'tension', 'tensionFull', 'combat', 'danger', 'victory', 'defeat', 'menu',
] as const;

export type MusicName = (typeof MUSIC_NAMES)[number];

/** Sounds every mission loads (each name a set of variants). */
export const SOUND_NAMES = [
  'rifle', 'jolt', 'bulletImpact', 'burstImpact', 'trooperReady', 'trooperYes', 'trooperAttack', 'trooperPissed',
  'trooperDeath', 'trooperHelp', 'houndAttack', 'houndDeath', 'houndVoice', 'quillbackLaunch',
  'quillbackImpact', 'quillbackDeath', 'shellbackLaunch', 'shellbackImpact', 'shellbackDeath', 'tuskerLaunch',
  'tuskerImpact', 'tuskerDeath', 'tuskerRoar', 'blisterBurst', 'blisterDeath', 'blisterRoll',
  'kiteLaunch', 'kiteImpact', 'kiteDeath', 'kiteVoice', 'sowerLaunch', 'sowerImpact',
  'sowerDeath', 'sowerVoice', 'miteDeath', 'turretLaunch', 'calyxAttack', 'calyxPissed',
  'calyxDeath', 'artifactHum', 'artifactAurora', 'stormLaunch', 'skyscan', 'dustoffUnload', 'dustoffEngine',
  'menderExplode', 'menderDrop', 'menderImpact', 'menderReady', 'repair', 'turnedMoan', 'civilianDeath', 'deathFire',
  'deathAcid', 'deathEviscerate', 'deathSilent', 'stormImpact', 'tankFire', 'tankCannon', 'tankShellSmall',
  'torchrunnerAttack', 'torchrunnerImpact', 'jackknifeFighterAttack', 'nightjarAttack', 'nightjarImpact', 'swiftGroundImpact',
  'bulwarkAttack', 'bulwarkImpact', 'braceMorph', 'unbraceMorph', 'jackknifeToAssault', 'jackknifeToFighter', 'jackknifeGatling',
  'explosion', 'buildingExplosion', 'baseUnderAttack', 'forcesUnderAttack', 'transmission', 'keelGunCharge',
  'keelGunLaunch', 'warshipVoice', 'grenadierLaunch', 'grenadierImpact', 'burnerLaunch', 'seerLaunch',
  'seerDeath', 'vaulterLaunch', 'warheadAlert', 'warheadReady', 'warheadLaunch', 'warheadDrop', 'warheadImpact', 'warheadExplosion',
  'warheadIncoming', 'shroudOn', 'shroudOff', 'jetLaunch', 'jetLand', 'healStart', 'healLoop', 'grenadierReady',
  'seerReady', 'vaulterReady', 'crawlGoreSmall', 'crawlGoreMedium', 'crawlGoreLarge', 'humanExplosionSmall',
  'humanExplosionMedium', 'humanExplosionLarge', 'shellImpact', 'tuskerBodyfall', 'warshipBattery',
  'warshipLaser', 'warshipGround', 'hyperspaceOut', 'hyperspaceIn', 'uiHover', 'uiSelect', 'uiClick',
  'ambienceCalder', 'distantBattle', 'stingerIntro', 'stingerTense',
] as const;

/** Sounds only The Tide: Unleashed (and the Practice Range) loads. */
export const UNLEASHED_SOUND_NAMES = [
  'picketAttack', 'coyoteAttack', 'scuttleMinePlace', 'scuttleMineBurrow', 'scuttleMineSeek', 'frigateImpact',
  'frigateAttack', 'leaperJump', 'leaperLand', 'd8Explode', 'd8Voice',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number] | (typeof UNLEASHED_SOUND_NAMES)[number];

/** Named textures: the procedural battlefield's ground, and the effects' own (a muzzle flash, a laser bolt). */
export const TEXTURE_NAMES = ['ground/sandA', 'ground/sandB', 'ground/rock', 'ground/gravel', 'ground/plating', 'muzzleFlash', 'laserBolt'] as const;
export type TextureName = (typeof TEXTURE_NAMES)[number];

/** Command-card icons: the deploy screen's soldiers and machines, the call-ins, the abilities. */
export const ICON_NAMES = [
  'trooper', 'medic', 'grenadier', 'burner', 'vaulter', 'seer', 'howitzer', 'warship',
  'jolt', 'heal', 'shroud', 'keelGun', 'skyscan', 'mender', 'dustoff',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** The radio's speakers (portrait.ts maps each to the game's own: ORIGINAL_PORTRAITS). */
export const PORTRAIT_NAMES = [
  'trooper', 'rookie', 'trooper2', 'grenadier', 'burner', 'medic', 'seer', 'vaulter', 'rigger', 'pilot', 'tank',
  'dispatch', 'civilian', 'scientist', 'directorate', 'ostrander', 'ashby', 'harlan', 'tolliver', 'calyx',
] as const;
export type PortraitName = (typeof PORTRAIT_NAMES)[number];
