// A map in the game's terms: its terrain (heights, cliff levels, the ground textures' weights, what
// can be walked), what's placed on it (units, doodads, points) and its named regions. A plugin's maps
// arrive in it (src/content/provider.ts \`battlefield\`); the engine builds the ground from it.

export interface Placement {
  id: number;
  kind: 'unit' | 'doodad' | 'point';
  /** What it is, in the map's own names. */
  type: string;
  /** A unit's type in the game's names, where the map was made for another game's (a plugin's map): what the game reads. */
  own?: string;
  /** Cells, and height in game units (doodads only; units and points sit on the ground). */
  x: number;
  y: number;
  z: number;
  /** Radians; map facing (0 = east, counterclockwise). */
  rotation: number;
  scale: [number, number, number];
  variation: number;
  player: number;
  name: string;
}

export type RegionShape = { type: 'circle'; x: number; y: number; r: number } | { type: 'rect'; x0: number; y0: number; x1: number; y1: number };

export interface Region {
  id: number;
  name: string;
  /** Circles and rectangles, in cells. */
  shapes: RegionShape[];
}

export interface MapData {
  name: string;
  tileset: string;
  /** Cells. */
  width: number;
  height: number;
  /** Ground height per vertex, game units, (width+1) * (height+1), row-major by y. */
  heights: Float32Array;
  /** Cliff level per vertex. */
  cliff: Uint8Array;
  /** Ground height per vertex where it differs for walking: bridge decks over chasms. */
  walkHeights: Float32Array;
  /** Per cell: whether ground units can stand there (the map's own pathing flags). */
  pathable: Uint8Array;
  /**
   * Cliff level per cell, in levels: whole numbers on flat ground,
   * fractions along ramps. Where neighboring cells differ by a whole level, there's a cliff.
   */
  cellLevels: Float32Array;
  /** The eight blend textures (terrain texture ids), in mask order. */
  textures: string[];
  /** Two RGBA masks (weights of textures 0-3 and 4-7, 0..255), maskWidth x maskHeight each. */
  masks: [Uint8Array, Uint8Array];
  maskWidth: number;
  maskHeight: number;
  /** Texture tiling, as the map sets it (repeats across the map, by its editor's convention). */
  uvTiling: number;
  cliffSets: string[];
  placements: Placement[];
  regions: Region[];
  /** Playable area, cells. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}
