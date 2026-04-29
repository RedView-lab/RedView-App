import type { Surface } from './types';

const TARMAC_SURFACES = new Set([
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

const OFFROAD_SURFACES = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'compacted',
  'dirt',
  'earth',
  'ground',
  'grass',
  'mud',
  'sand',
  'pebblestone',
  'rock',
  'snow',
  'ice',
  'salt',
  'woodchips',
]);

const TARMAC_HIGHWAYS = new Set([
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

const OFFROAD_HIGHWAYS = new Set(['track', 'path', 'bridleway', 'footway']);

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
    if (TARMAC_SURFACES.has(tags.surface)) return 'tarmac';
    if (OFFROAD_SURFACES.has(tags.surface)) return 'offroad';
  }

  if (tags.highway) {
    if (TARMAC_HIGHWAYS.has(tags.highway)) return 'tarmac';
    if (OFFROAD_HIGHWAYS.has(tags.highway)) return 'offroad';
  }

  return 'unknown';
}