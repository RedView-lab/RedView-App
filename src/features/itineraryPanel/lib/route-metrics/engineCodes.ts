/**
 * Attributs de route pour le moteur de temps vélo v2, tirés des WayTags /
 * NodeTags de BRouter et codés sur un octet par point (voir
 * vendor/redviewalgo/src/cycling/input.rs) :
 *
 * - surface : bits 0-3 = revêtement (0 inconnu, 1 asphalte, 2 pavé/béton,
 *   3 gravier, 4 terre, 5 sable), bits 4-6 = rugosité (0 inconnue, 1 bonne,
 *   2 moyenne, 3 mauvaise, 4 très mauvaise) ;
 * - way : bits 0-3 = type de voie (0 inconnu, 1 grand axe, 2 secondaire,
 *   3 petite route, 4 résidentiel/service, 5 piste cyclable, 6 chemin,
 *   7 sentier/piéton), bit 6 = agglomération, bit 7 = feu / stop au point.
 */
import { classifySegment, parseWayTags } from './surface';
import type { Surface } from './types';

export type WayClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Roughness = 0 | 1 | 2 | 3 | 4;

const SURFACE_CODES: Record<Surface, number> = {
  unknown: 0,
  asphalt: 1,
  paved: 2,
  gravel: 3,
  dirt: 4,
  sand: 5,
};

const WAY_CLASS_BY_HIGHWAY: Record<string, WayClass> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 1,
  trunk_link: 1,
  primary: 1,
  primary_link: 1,
  secondary: 2,
  secondary_link: 2,
  tertiary: 2,
  tertiary_link: 2,
  unclassified: 3,
  road: 3,
  residential: 4,
  living_street: 4,
  service: 4,
  pedestrian: 4,
  cycleway: 5,
  track: 6,
  path: 7,
  footway: 7,
  bridleway: 7,
  steps: 7,
};

const ROUGHNESS_BY_SMOOTHNESS: Record<string, Roughness> = {
  excellent: 1,
  good: 1,
  intermediate: 2,
  bad: 3,
  very_bad: 4,
  horrible: 4,
  very_horrible: 4,
  impassable: 4,
};

const ROUGHNESS_BY_TRACKTYPE: Record<string, Roughness> = {
  grade1: 1,
  grade2: 2,
  grade3: 3,
  grade4: 4,
  grade5: 4,
};

export function classifyWayClass(tags: Record<string, string>): WayClass {
  return WAY_CLASS_BY_HIGHWAY[(tags.highway ?? '').toLowerCase().trim()] ?? 0;
}

export function classifyRoughness(tags: Record<string, string>): Roughness {
  const smoothness = (tags.smoothness ?? '').toLowerCase().trim();
  if (smoothness in ROUGHNESS_BY_SMOOTHNESS) return ROUGHNESS_BY_SMOOTHNESS[smoothness]!;
  const tracktype = (tags.tracktype ?? '').toLowerCase().trim();
  return ROUGHNESS_BY_TRACKTYPE[tracktype] ?? 0;
}

/** Agglomération : vitesse limitée à 50 km/h ou moins, ou rue résidentielle. */
export function isUrbanWay(tags: Record<string, string>): boolean {
  const maxspeed = Number.parseInt(tags.maxspeed ?? '', 10);
  if (Number.isFinite(maxspeed) && maxspeed > 0 && maxspeed <= 50) return true;
  const highway = (tags.highway ?? '').toLowerCase().trim();
  return highway === 'residential' || highway === 'living_street' || highway === 'pedestrian';
}

/** Feu, stop ou cédez-le-passage au nœud. */
export function isSignalNode(nodeTagsStr: string): boolean {
  const tags = parseWayTags(nodeTagsStr);
  const highway = (tags.highway ?? '').toLowerCase();
  return highway === 'traffic_signals' || highway === 'stop' || highway === 'give_way'
    || tags.crossing === 'traffic_signals';
}

export function encodeEngineSurface(surface: Surface | null | undefined, roughness: number = 0): number {
  return (SURFACE_CODES[surface ?? 'unknown'] ?? 0) | ((roughness & 0x07) << 4);
}

export function encodeEngineWay(wayClass: WayClass, urban: boolean, signal: boolean): number {
  return (wayClass & 0x0f) | (urban ? 0x40 : 0) | (signal ? 0x80 : 0);
}

/** Codes moteur d'un tronçon BRouter (WayTags) et de son nœud final (NodeTags). */
export function engineCodesFromTags(wayTagsStr: string, nodeTagsStr = ''): { surface: number; way: number } {
  const tags = parseWayTags(wayTagsStr);
  return {
    surface: encodeEngineSurface(classifySegment(wayTagsStr), classifyRoughness(tags)),
    way: encodeEngineWay(classifyWayClass(tags), isUrbanWay(tags), nodeTagsStr ? isSignalNode(nodeTagsStr) : false),
  };
}
