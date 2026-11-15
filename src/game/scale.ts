import * as THREE from 'three';
import type { ModelTemplate } from '../engine/model.ts';
import type { ModelName } from '../content/assetnames.ts';

/**
 * Story-scale sizes, in meters. An RTS draws everything at gameplay scale: a Trooper is
 * a fifth as tall as a Holdfast and a Warship barely covers a few buildings. Here
 * every model is resized to its in-universe size. Canon figures conflict, so each entry says
 * where its number comes from; where there is none, the size is a judgment call that keeps
 * the rest of the lineup consistent.
 */
export const LORE_SIZE: Partial<Record<ModelName, { measure: 'height' | 'length' | 'width' | 'head'; meters: number; source: string }>> = {
  trooper: {
    measure: 'height',
    meters: 2.3,
    source: 'hardsuit armor adds about a foot to a ~2 m soldier; the heavy hardsuit is listed at 2.13 m',
  },
  hound: { measure: 'height', meters: 1.2, source: '"about one meter tall, comparable to a large dog"' },
  quillback: { measure: 'height', meters: 3.8, source: 'estimates run 2.4-5.4 m; 3.67 m from in-game proportions' },
  shellback: { measure: 'height', meters: 2.4, source: 'no figure in the story; between a hound and a quillback, armored like a tank' },
  tusker: { measure: 'height', meters: 8.5, source: '"as tall as four troopers in full armor"; often quoted at 5 m tall, 20 m long' },
  howitzer: { measure: 'length', meters: 11, source: 'Howitzer, about 11 m long by in-game proportions' },
  warship: { measure: 'length', meters: 560, source: 'Gorgon-class Bucephalus: 560 m long, 82.4 m wide (in-game info card)' },
  holdfast: { measure: 'width', meters: 48, source: 'no figure in the story; a three-story flying base that dwarfs its infantry' },
  barracks: { measure: 'width', meters: 30, source: 'no figure in the story; trains and garrisons a company of troopers' },
  bunker: { measure: 'width', meters: 13, source: 'no figure in the story; holds four troopers in powered armor' },
  storehouse: { measure: 'width', meters: 11, source: 'no figure in the story; lowers flush into the ground' },
  harlan: { measure: 'height', meters: 2.3, source: 'Harlan in hardsuit, the same armor as any Trooper' },
  grenadier: { measure: 'height', meters: 2.8, source: 'no figure in the story; heavier armor than a Trooper, half a head taller in every picture' },
  smTrooper: { measure: 'height', meters: 2.3, source: 'the close-up Trooper, the same hardsuit as any Trooper' },
  burner: { measure: 'height', meters: 2.6, source: 'no figure in the story; Burner armor sits between the Trooper and the Grenadier' },
  medic: { measure: 'height', meters: 2.05, source: 'light combat armor over a ~1.8 m soldier' },
  seer: { measure: 'head', meters: 1.78, source: 'a ~1.85 m operative in a hostile environment suit; measured at the head, since the raised LR-6 stretches the model bounds' },
  vaulter: { measure: 'height', meters: 2.05, source: 'light armor and a jet pack over a ~1.85 m soldier' },
  blister: { measure: 'height', meters: 1.5, source: 'no figure in the story; a Hound swollen into a rolling acid sac, about chest-high on a Trooper' },
  kite: { measure: 'width', meters: 11, source: 'no figure in the story; a winged serpent with the wingspan of a light aircraft, hanging tail-down in the air' },
  sower: { measure: 'length', meters: 26, source: 'no figure in the story; a flying siege beast several times a Kite, the strain it is morphed from' },
  mite: { measure: 'length', meters: 2, source: 'no figure in the story; flung from a Sower and fighting where it lands: about three-quarters of a Hound, as the two are drawn beside each other' },
  calyx: { measure: 'head', meters: 1.75, source: "Calyx's own height, about 1.78 m; her shell folds spread wide of it" },
  artifact: { measure: 'width', meters: 30, source: "no figure in the story; the assembled Forebear artifact in the Holdouts' containment rig, the size of a hangar" },
  flakTower: { measure: 'height', meters: 12, source: 'no figure in the story; an anti-air tower over the base walls' },
  workshop: { measure: 'width', meters: 30, source: 'no figure in the story; the same footprint as a Barracks' },
  motorPool: { measure: 'width', meters: 32, source: 'no figure in the story; builds Howitzers, so a hangar for several' },
  airfield: { measure: 'width', meters: 32, source: 'no figure in the story; launches Jackknives and Dustoffs from its pad' },
  armory: { measure: 'width', meters: 28, source: 'no figure in the story; the same footprint as a Barracks' },
  reactorHall: { measure: 'width', meters: 28, source: 'no figure in the story; the same footprint as a Barracks' },
  hiringHall: { measure: 'width', meters: 30, source: 'no figure in the story; the same footprint as a Barracks' },
  defenseWall: { measure: 'length', meters: 22, source: 'a barricade of rubble and wire across a 2x4-cell footprint' },
  dustoff: { measure: 'length', meters: 16, source: 'no figure in the story; a dropship that carries eight Troopers or a Howitzer' },
  mender: { measure: 'height', meters: 4.2, source: 'no figure in the story; a heavy work mech, a head taller than a Rigger' },
  rigger: { measure: 'height', meters: 3.5, source: 'no figure in the story; a worker sealed in a construction rig, a head shorter than a Mender' },
  turnedColonist: { measure: 'height', meters: 1.85, source: 'a colonist, standing a little hunched' },
  turnedTrooper: { measure: 'height', meters: 2.3, source: 'a Trooper in hardsuit armor, as the Trooper' },
  swollen: { measure: 'height', meters: 4.2, source: 'no figure in the story; a hulking Crawl-human hybrid twice a man\'s height' },
  colonistHut: { measure: 'width', meters: 14, source: 'no figure in the story; a prefab colony dwelling' },
  biodome: { measure: 'width', meters: 34, source: 'no figure in the story; a colony greenhouse dome' },
  cocoon: { measure: 'height', meters: 2.6, source: 'a colonist wrapped in a cocoon' },
  colonistHauler: { measure: 'length', meters: 13, source: 'no figure in the story; a civilian hauler longer than a Howitzer' },
  radioTower: { measure: 'height', meters: 46, source: "no figure in the story; Calder's broadcast mast, taller than any building in Saltwell" },
  billboard: { measure: 'height', meters: 11, source: 'no figure in the story; a street-corner holo-billboard' },
  statue: { measure: 'height', meters: 15, source: "no figure in the story; a dictator's monument in a town square" },
  jackknifeFighter: { measure: 'length', meters: 14, source: 'no figure in the story; a transforming fighter about the length of a jet fighter' },
  nightjar: { measure: 'length', meters: 12, source: 'no figure in the story; a twin-rotor gunship a little shorter than a Jackknife' },
  swift: { measure: 'length', meters: 13, source: 'no figure in the story; the old Union space fighter, about a Jackknife\'s size' },
  torchrunner: { measure: 'length', meters: 9, source: 'no figure in the story; a fast-attack flamethrower buggy, shorter than a Howitzer' },
  bulwark: { measure: 'height', meters: 15, source: 'no figure in the story; a walking fortress several stories tall, towering over the tanks' },
  lantern: { measure: 'width', meters: 22, source: 'no figure in the story; a floating sac the size of a small airship' },
  bilewing: { measure: 'length', meters: 14, source: 'no figure in the story; about a Kite\'s size, heavier' },
  oreField: { measure: 'width', meters: 10, source: 'no figure in the story; a field covers two cells of the map, a little under 12 m' },
  refinery: { measure: 'width', meters: 26, source: 'no figure in the story; a gas plant capping a geyser, a Barracks\' footprint' },
  // The Tide: Unleashed's classic machines (only there).
  picket: { measure: 'height', meters: 5, source: 'about 5 m on the field manual\'s scale chart (others say 12 ft)' },
  coyote: { measure: 'length', meters: 6, source: 'no figure in the story; a hover bike longer than a car, shorter than a Torchrunner' },
  scuttleMine: { measure: 'width', meters: 1.6, source: 'no figure in the story; a mine a Coyote carries three of' },
  behemoth: { measure: 'height', meters: 30, source: 'no figure in the story; its model stands 1.7 times the Bulwark\'s, and Unleashed\'s Bulwark is 20 m' },
  frigate: { measure: 'length', meters: 16, source: 'no figure in the story; the First War\'s heavy frigate, bigger than a Swift' },
};

/**
 * Models drawn at another's scale: one unit's other shapes (a Jackknife landed, and the rig it
 * transforms on), so it's the same size whatever shape it's in.
 */
export const SCALE_AS: Partial<Record<ModelName, ModelName>> = {
  jackknifeAssault: 'jackknifeFighter',
  jackknifeAssaultDeath: 'jackknifeFighter',
  jackknifeMorph: 'jackknifeFighter',
  // The Leaper is a Hound of another strain, made at the same scale (a model scale of 0.77 for both).
  leaper: 'hound',
  leaperDeath: 'hound',
};

/** Scale factor that brings a model to its story size (or to `meters`, a mode's own, by the same measure). */
export function loreScale(name: ModelName, template: ModelTemplate, meters?: number): number {
  const spec = LORE_SIZE[name];
  if (!spec) return 1;
  const size = template.bounds.getSize(new THREE.Vector3());
  const measured =
    spec.measure === 'head' ? template.headHeight || size.y : spec.measure === 'height' ? size.y : spec.measure === 'length' ? size.z : Math.max(size.x, size.z);
  return measured > 0 ? (meters ?? spec.meters) / measured : 1;
}
