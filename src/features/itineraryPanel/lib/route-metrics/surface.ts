import type { Surface } from './types';

const PAVED_SURFACES = new Set([
  'asphalt',
  'paved',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'paving_stones',
  'sett',
  'metal',
  'wood',
  'cobblestone',
  'unhewn_cobblestone',
  'chipseal',
  'tartan',
]);

const GRAVEL_SURFACES = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'compacted',
  'pebblestone',
]);

const DIRT_SURFACES = new Set([
  'dirt',
  'earth',
  'ground',
  'grass',
  'mud',
  'rock',
  'snow',
  'ice',
  'salt',
  'woodchips',
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

function parseWayTags(tagsStr: string): Record<string, string> {
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
    if (tags.surface === 'sand') return 'dirt';
    if (DIRT_SURFACES.has(tags.surface)) return 'dirt';
    if (GRAVEL_SURFACES.has(tags.surface)) return 'gravel';
    if (PAVED_SURFACES.has(tags.surface)) return 'paved';
  }

  if (isLikelyDirtTrack(tags)) return 'dirt';
  if (isLikelyGravelTrack(tags)) return 'gravel';

  if (tags.highway) {
    if (PAVED_HIGHWAYS.has(tags.highway)) return 'paved';
    if (DIRT_HIGHWAYS.has(tags.highway)) return 'dirt';
  }

  return 'unknown';
}

export function isPavedSurface(surface: Surface | null | undefined): boolean {
  return surface === 'paved';
}

export function isOffroadSurface(surface: Surface | null | undefined): boolean {
  return surface === 'gravel' || surface === 'dirt' || surface === 'sand';
}

export function isStyledSurface(surface: Surface | null | undefined): boolean {
  return isPavedSurface(surface) || isOffroadSurface(surface);
}