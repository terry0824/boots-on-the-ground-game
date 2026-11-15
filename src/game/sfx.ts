import type * as THREE from 'three';
import type { Audio, Bus } from '../engine/audio.ts';

/** One layer of a cue: a sample group (or a synthesized one, "synth.*") and how to play it. */
interface Layer {
  g: string;
  v: number;
  /** Random pitch spread, semitones. */
  p?: number;
  rate?: number;
  bus?: Bus;
  reverb?: number;
  near?: number;
  /** Speed-of-sound delay with distance. */
  delay?: boolean;
  priority?: number;
  limit?: number;
  spacing?: number;
  /** Chance this layer plays at all (variety between repeats). */
  chance?: number;
}

/**
 * Every sound event in the game, as layers, routed to buses with reverb and distance behavior.
 * What the units do (their weapons, impacts, deaths, explosions) is the content's own
 * recordings only, at levels from its sound data's mix (each sound's volume, measured against the
 * recordings' loudness). Synthesized layers are left only in what is the player's own: the
 * per-round punch of the player's rifle, hit and kill feedback, and the interface.
 */
const CUES = {
  // The player's RK-4: the recorded burst once per attack, punch and crack on every round.
  'rifle.attack': [
    { g: 'rifle', v: 0.42, p: 0.5, bus: 'weapons', reverb: 0.28, priority: 4 },
    { g: 'synth.tail', v: 0.3, p: 1.5, bus: 'weapons', reverb: 0.15, priority: 3 },
  ],
  'rifle.round': [
    { g: 'synth.punch', v: 0.5, p: 0.7, bus: 'weapons', reverb: 0.3, priority: 4 },
    { g: 'synth.crack', v: 0.26, p: 1.2, bus: 'weapons', reverb: 0.35, priority: 4 },
    { g: 'synth.mech', v: 0.12, p: 1, bus: 'weapons', reverb: 0, priority: 3 },
  ],
  // Other Troopers' rifles, positioned.
  'rifle.npc': [{ g: 'rifle', v: 0.46, p: 0.6, bus: 'weapons', near: 10, reverb: 0.25, limit: 10, spacing: 0.025 }],
  // The player's own rounds landing: the content's single-bullet impact.
  'impact.flesh': [{ g: 'bulletImpact', v: 0.35, p: 1, near: 6, limit: 4 }],
  // An AI Trooper's burst landing: the Trooper's own attack impact.
  'impact.burst': [{ g: 'burstImpact', v: 0.45, p: 1, near: 8, reverb: 0.15, limit: 5, spacing: 0.03 }],
  'impact.metal': [{ g: 'bulletImpact', v: 0.45, p: 1, near: 8, limit: 4 }],
  'impact.ground': [{ g: 'bulletImpact', v: 0.25, p: 2, near: 5, limit: 4 }],
  // Anyone else's rounds landing: the content's single-bullet impact.
  'hit.flesh': [{ g: 'bulletImpact', v: 0.3, p: 1.5, near: 6, limit: 4 }],
  'hit.metal': [{ g: 'bulletImpact', v: 0.4, p: 1, near: 8, limit: 4 }],
  // Rounds that miss the player: the snap of a round going past the ear.
  'bullet.whiz': [
    { g: 'synth.crack', v: 0.5, p: 3, bus: 'sfx', near: 4, reverb: 0.05, priority: 6, spacing: 0.04 },
    { g: 'synth.whoosh', v: 0.35, p: 3, bus: 'sfx', near: 4, reverb: 0, priority: 5, chance: 0.6 },
  ],
  'impact.cover': [{ g: 'bulletImpact', v: 0.55, p: 2, near: 6, limit: 5 }],
  // The campaign infantry's weapons, positioned.
  'grenade.npc': [{ g: 'grenadierLaunch', v: 0.6, p: 0.6, bus: 'weapons', near: 12, reverb: 0.3, limit: 6 }],
  'grenade.impact': [{ g: 'grenadierImpact', v: 0.75, p: 0.8, near: 12, reverb: 0.3, limit: 6 }],
  'flame.npc': [{ g: 'burnerLaunch', v: 0.7, p: 0.5, bus: 'weapons', near: 10, reverb: 0.15, limit: 5 }],
  'snipe.npc': [{ g: 'seerLaunch', v: 0.8, p: 0.4, bus: 'weapons', near: 20, reverb: 0.4, limit: 4 }],
  'pistol.npc': [{ g: 'vaulterLaunch', v: 0.55, p: 0.6, bus: 'weapons', near: 10, reverb: 0.25, limit: 6 }],
  // The player's own feedback, unpositioned. (A hit and a kill have no sound of their own: they're
  // heard as anyone's are, where they land.)
  'ui.hurt': [{ g: 'synth.hurt', v: 0.6, p: 1, bus: 'ui', reverb: 0, priority: 6, spacing: 0.15 }],
  'ui.heartbeat': [{ g: 'synth.heartbeat', v: 0.5, bus: 'ui', reverb: 0, priority: 6 }],
  'ui.click': [{ g: 'uiClick', v: 0.5, bus: 'ui', reverb: 0, priority: 8 }],
  'ui.hover': [{ g: 'uiHover', v: 0.35, bus: 'ui', reverb: 0, priority: 8, spacing: 0.05 }],
  'ui.select': [{ g: 'uiSelect', v: 0.5, bus: 'ui', reverb: 0, priority: 8 }],
  // The radio between lines of a conversation, and an objective asking for attention.
  'ui.radio': [{ g: 'synth.squelch', v: 0.4, p: 0.5, bus: 'voice', reverb: 0, priority: 7 }],
  'ui.nudge': [{ g: 'synth.nudge', v: 0.5, bus: 'ui', reverb: 0.08, priority: 8 }],
  // Deaths: the creature's own death cry and the squelch of it bursting.
  'death.hound': [
    { g: 'houndDeath', v: 0.75, p: 1, near: 9, limit: 5, spacing: 0.04 },
    { g: 'crawlGoreSmall', v: 0.6, p: 1, near: 8, limit: 6 },
  ],
  'death.quillback': [
    { g: 'quillbackDeath', v: 0.85, p: 1, near: 12, limit: 4 },
    { g: 'crawlGoreMedium', v: 0.65, p: 1, near: 10, limit: 4 },
  ],
  'death.shellback': [
    { g: 'shellbackDeath', v: 0.85, p: 1, near: 12, limit: 4 },
    { g: 'crawlGoreMedium', v: 0.7, p: 1, near: 10, limit: 4 },
  ],
  'death.tusker': [
    { g: 'tuskerDeath', v: 1, p: 0.5, near: 30, reverb: 0.4, priority: 5 },
    { g: 'crawlGoreLarge', v: 0.95, p: 0.5, near: 25, priority: 5 },
    { g: 'tuskerBodyfall', v: 1, near: 30, delay: true, priority: 5 },
  ],
  'death.blister': [
    { g: 'blisterBurst', v: 0.95, p: 0.8, near: 14, reverb: 0.3, limit: 6, spacing: 0.03 },
    { g: 'crawlGoreMedium', v: 0.6, p: 1, near: 10, limit: 4 },
  ],
  'death.kite': [
    { g: 'kiteDeath', v: 0.95, p: 0.8, near: 18, reverb: 0.3, limit: 4 },
    { g: 'crawlGoreMedium', v: 0.65, p: 1, near: 14, limit: 4 },
  ],
  'death.sower': [
    { g: 'sowerDeath', v: 1, p: 0.5, near: 40, reverb: 0.5, priority: 5 },
    { g: 'crawlGoreLarge', v: 1, p: 0.5, near: 35, priority: 5 },
  ],
  'death.mite': [{ g: 'miteDeath', v: 0.65, p: 1, near: 8, limit: 5, spacing: 0.04 }],
  'kite.attack': [{ g: 'kiteLaunch', v: 0.7, p: 0.8, bus: 'weapons', near: 16, reverb: 0.3, limit: 6, spacing: 0.04 }],
  'sower.attack': [{ g: 'sowerLaunch', v: 0.9, p: 0.6, bus: 'weapons', near: 35, reverb: 0.5, limit: 4, spacing: 0.08 }],
  'death.turned': [
    { g: 'civilianDeath', v: 0.6, p: 1, near: 9, limit: 4, spacing: 0.05 },
    { g: 'crawlGoreSmall', v: 0.55, p: 1, near: 8, limit: 5 },
  ],
  'death.trooper': [{ g: 'trooperDeath', v: 0.85, p: 0.5, near: 12, limit: 3 }],
  // A machine's death, as its data has it (the medium explosion for most, the large one for
  // the walkers).
  'death.machine': [{ g: 'humanExplosionMedium', v: 1.1, p: 0.5, near: 30, delay: true, reverb: 0.5, priority: 5 }],
  'death.machineLarge': [{ g: 'humanExplosionLarge', v: 1.15, p: 0.4, near: 40, delay: true, reverb: 0.6, priority: 6 }],
  'death.vehicle': [{ g: 'buildingExplosion', v: 1.1, p: 0.6, near: 30, delay: true, reverb: 0.5, priority: 5 }],
  // How the blow killed, laid over the creature's own death: burning, dissolving in acid, torn
  // apart. A sniper's quiet kill is only its own sound.
  'death.fire': [{ g: 'deathFire', v: 0.75, p: 0.5, near: 12, limit: 4, spacing: 0.05 }],
  'death.acid': [{ g: 'deathAcid', v: 0.75, p: 0.5, near: 12, limit: 4, spacing: 0.05 }],
  'death.eviscerate': [{ g: 'deathEviscerate', v: 0.7, p: 0.5, near: 10, limit: 4, spacing: 0.05 }],
  'death.silent': [{ g: 'deathSilent', v: 0.7, p: 0.3, near: 10, limit: 3 }],
  'death.building': [
    { g: 'humanExplosionLarge', v: 1.1, p: 0.5, near: 40, delay: true, reverb: 0.6, priority: 6 },
    { g: 'buildingExplosion', v: 1, p: 0.5, near: 40, delay: true, priority: 6 },
  ],
  // The machines' weapons. Each launch at its volume in the sound data (the Bulwark's cannons
  // 0 dB, a Howitzer's -6, a Picket's autocannons -3, a landed Jackknife's Gatlings -10...)
  // against how loud its recording is, so they sit with one another as the data mixes them; the
  // Bulwark's and the Behemoth's cannons a little over theirs, up with a braced tank's.
  'tank.cannon': [{ g: 'tankCannon', v: 0.95, p: 0.5, bus: 'weapons', near: 20, reverb: 0.4, delay: true, priority: 4 }],
  'tank.brace': [{ g: 'tankFire', v: 1.05, p: 0.4, bus: 'weapons', near: 35, reverb: 0.55, delay: true, priority: 5 }],
  // Bulwark: the sound data's own (its cannons and its Lances launch with the same recording).
  'bulwark.cannon': [{ g: 'bulwarkAttack', v: 2.4, p: 0.5, bus: 'weapons', near: 30, reverb: 0.45, delay: true, priority: 5, limit: 4 }],
  'bulwark.lance': [{ g: 'bulwarkAttack', v: 1.6, p: 0.5, bus: 'weapons', near: 25, reverb: 0.35, delay: true, priority: 4, limit: 4 }],
  // The Behemoth: the campaign gives it the Bulwark's own launch sounds.
  'behemoth.cannon': [{ g: 'bulwarkAttack', v: 2.9, p: 0.4, bus: 'weapons', near: 40, reverb: 0.55, delay: true, priority: 6, limit: 4 }],
  'behemoth.missiles': [{ g: 'bulwarkAttack', v: 1.8, p: 0.5, bus: 'weapons', near: 35, reverb: 0.45, delay: true, priority: 5, limit: 4 }],
  'picket.cannon': [{ g: 'picketAttack', v: 1.05, p: 0.5, bus: 'weapons', near: 15, reverb: 0.35, delay: true, priority: 4, limit: 4 }],
  'picket.missiles': [{ g: 'jackknifeFighterAttack', v: 0.7, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, delay: true, priority: 4, limit: 4 }],
  'coyote.grenade': [{ g: 'coyoteAttack', v: 1, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, delay: true, priority: 4, limit: 4 }],
  'torchrunner.flame': [{ g: 'torchrunnerAttack', v: 0.85, p: 0.5, bus: 'weapons', near: 14, reverb: 0.25, priority: 4, limit: 4 }],
  'jackknife.gatling': [{ g: 'jackknifeGatling', v: 0.5, p: 0.5, bus: 'weapons', near: 12, reverb: 0.3, priority: 4, limit: 4 }],
  'jackknife.dart': [{ g: 'jackknifeFighterAttack', v: 0.7, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, priority: 4, limit: 4 }],
  'nightjar.rockets': [{ g: 'nightjarAttack', v: 0.85, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, priority: 4, limit: 4 }],
  'swift.laser': [{ g: 'warshipBattery', v: 0.5, p: 0.5, bus: 'weapons', near: 15, reverb: 0.35, priority: 4, limit: 4 }],
  'swift.missiles': [{ g: 'nightjarAttack', v: 0.85, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, priority: 4, limit: 4 }],
  'frigate.missiles': [{ g: 'frigateAttack', v: 0.75, p: 0.5, bus: 'weapons', near: 15, reverb: 0.3, priority: 4, limit: 4 }],
  // A walker's foot coming down on the swarm: the data's stomp on landing (a braced shell's burst,
  // pitched down) and the Bulwark's own impact.
  'walker.stomp': [
    { g: 'explosion', v: 0.4, p: 1, rate: 0.7, near: 18, delay: true, priority: 3, limit: 3 },
    { g: 'bulwarkImpact', v: 0.45, p: 1, rate: 0.6, near: 18, priority: 3, limit: 3 },
  ],
  // A shell bursting where its weapon has no impact sound of its own.
  'explosion.shell': [{ g: 'explosion', v: 1.05, p: 0.6, near: 25, reverb: 0.5, delay: true, priority: 5, limit: 6 }],
  // Warship.
  'bc.battery': [{ g: 'warshipBattery', v: 0.55, p: 1, near: 60, reverb: 0.6, delay: true, limit: 4, spacing: 0.05 }],
  'bc.ground': [{ g: 'warshipGround', v: 0.5, p: 1, near: 60, reverb: 0.6, delay: true, limit: 4, spacing: 0.05 }],
  'bc.keelGunCharge': [{ g: 'keelGunCharge', v: 1, priority: 7 }],
  'bc.keelGunFire': [{ g: 'keelGunLaunch', v: 1, reverb: 0.5, priority: 7 }],
  // Snap Jump (the Warship's own jump-out sound): spooling, into hyperspace, and out
  // of it over the mark.
  'bc.jump': [{ g: 'hyperspaceOut', v: 0.8, rate: 0.9, reverb: 0.6, priority: 6 }],
  'bc.jumpOut': [{ g: 'hyperspaceOut', v: 1.1, reverb: 0.6, priority: 7 }],
  'bc.jumpIn': [{ g: 'hyperspaceIn', v: 1.1, reverb: 0.6, priority: 7 }],
  // The batteries over a strike: a laser crackle from the hull, far above.
  'bc.laser': [{ g: 'warshipLaser', v: 0.5, p: 1, near: 80, reverb: 0.6, delay: true, limit: 5, spacing: 0.06 }],
} satisfies Record<string, Layer[]>;

export type CueName = keyof typeof CUES;

export interface CueOptions {
  at?: THREE.Vector3;
  /** Scales every layer. */
  volume?: number;
  /** Multiplies every layer's playback rate (a rising kill sound on a streak). */
  rate?: number;
}

/** Plays cues through the mixer. */
export class Sfx {
  constructor(readonly audio: Audio) {}

  play(name: CueName, opts: CueOptions = {}) {
    const layers = CUES[name] as Layer[];
    for (const l of layers) {
      if (l.chance !== undefined && Math.random() > l.chance) continue;
      this.audio.play(l.g, {
        at: opts.at,
        volume: l.v * (opts.volume ?? 1),
        pitch: l.p,
        rate: (l.rate ?? 1) * (opts.rate ?? 1),
        bus: l.bus ?? 'sfx',
        reverb: l.reverb,
        near: l.near,
        delay: l.delay,
        priority: l.priority,
        limit: l.limit,
        spacing: l.spacing,
      });
    }
  }
}
