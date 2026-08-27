import type { Surface } from './types';

const ASPHALT_SURFACES = new Set([
  'asphalt',
  'chipseal',
  'tartan',
  'bitumen',
  'asphalt:lanes',
  'tar',
  'macadam',
]);

const PAVED_SURFACES = new Set([
  'paved',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'paving_stones',
  'paving_stones:lanes',
  'sett',
  'metal',
  'wood',
  'cobblestone',
  'cobblestone:flattened',
  'unhewn_cobblestone',
  'bricks',
  'interlocking',
  'stone',
]);

const GRAVEL_SURFACES = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'gravel:lanes',
  'compacted',
  'pebblestone',
  'crushed_limestone',
  'limestone',
  'stabilized_turf',
  'grass_paver',
]);

const DIRT_SURFACES = new Set([
  'dirt',
  'earth',
  'ground',
  'grass',
  'mud',
  'rock',
  'rocky',
  'snow',
  'ice',
  'salt',
  'woodchips',
  'clay',
  'scree',
  'shingle',
  'volcanic',
]);

const SAND_SURFACES = new Set([
  'sand',
  'dune',
  'sandy',
]);

const PAVED_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'residential',
  'unclassified',
  'service',
  'living_street',
  'pedestrian',
  'road',
  'cycleway',
]);

const DIRT_HIGHWAYS = new Set(['path', 'bridleway', 'footway']);

function isLikelyGravelTrack(tags: Record<string, string>): boolean {
  if (tags.highway !== 'track') return false;
  if (!tags.tracktype) return true;
  return tags.tracktype === 'grade1' || tags.tracktype === 'grade2';
}

function isLikelyDirtTrack(tags: Record<string, string>): boolean {
  if (tags.highway !== 'track') return false;
  return tags.tracktype === 'grade3' || tags.tracktype === 'grade4' || tags.tracktype === 'grade5';
}

export function parseWayTags(tagsStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tagsStr) return out;

  for (const pair of tagsStr.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  return out;
}

export function classifySegment(tagsStr: string): Surface {
  const tags = parseWayTags(tagsStr);
  if (tags.surface) {
    const surfaceVal = tags.surface.toLowerCase().trim();
    if (SAND_SURFACES.has(surfaceVal)) return 'sand';
    if (DIRT_SURFACES.has(surfaceVal)) return 'dirt';
    if (GRAVEL_SURFACES.has(surfaceVal)) return 'gravel';
    if (PAVED_SURFACES.has(surfaceVal)) return 'paved';
    if (ASPHALT_SURFACES.has(surfaceVal)) return 'asphalt';
  }

  if (isLikelyDirtTrack(tags)) return 'dirt';
  if (isLikelyGravelTrack(tags)) return 'gravel';

  if (tags.highway) {
    const highwayVal = tags.highway.toLowerCase().trim();
    if (highwayVal === 'pedestrian' || highwayVal === 'living_street') return 'paved';
    if (PAVED_HIGHWAYS.has(highwayVal)) return 'asphalt';
    if (DIRT_HIGHWAYS.has(highwayVal)) return 'dirt';
  }

  return 'unknown';
}

export function isAsphaltSurface(surface: Surface | null | undefined): boolean {
  return surface === 'asphalt';
}

export function isPavedSurface(surface: Surface | null | undefined): boolean {
  return surface === 'asphalt' || surface === 'paved';
}

export function isOffroadSurface(surface: Surface | null | undefined): boolean {
  return surface === 'gravel' || surface === 'dirt' || surface === 'sand';
}

export function isStyledSurface(surface: Surface | null | undefined): boolean {
  return surface === 'asphalt' || surface === 'paved' || isOffroadSurface(surface);
}