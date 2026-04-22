/**
 * Route metrics computation from a BRouter response.
 *
 * BRouter returns a `messages` array on the GeoJSON feature with one row
 * per polyline vertex. Each row contains the vertex `Longitude`/
 * `Latitude` (in microdegrees), `Elevation` (metres), the segment
 * `Distance` (metres) leading up to the vertex, and a `WayTags` string
 * (`key=value` pairs separated by spaces) describing the OSM way the
 * segment belongs to.
 *
 * From this we compute:
 *   - filtered ascent / descent (small noise threshold)
 *   - average slope = ascent / distance
 *   - tarmac vs off-road share (from the `surface` / `highway` tags)
 *
 * BRouter's built-in `filtered ascend` is global with a coarse 10 m
 * threshold and ignores descent entirely; computing both from the raw
 * per-vertex elevations is much more accurate. When a higher-resolution
 * DEM is available on the map (Mapbox terrain ≈ 10 m, LIDAR 0.4 m)
 * `refineMetricsWithTerrain` resamples the same vertices to get an even
 * tighter elevation profile.
 */
import type { BrouterRoute } from './brouter';

export interface RouteProfilePoint {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number;
  gradientPct: number;
}

export interface RouteMetrics {
  distanceM: number;
  ascentM: number;
  descentM: number;
  /** Average slope in percent, computed as ascent / distance. */
  avgSlopePercent: number;
  /** Tarmac share (0–100), of the segments we could classify. */
  tarmacPercent: number;
  /** Off-road share (0–100), of the segments we could classify. */
  offroadPercent: number;
}

/* ------------------------------------------------------------------ */
/* Surface / highway classification                                    */
/* ------------------------------------------------------------------ */

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

const OFFROAD_HIGHWAYS = new Set([
  'track',
  'path',
  'bridleway',
  'footway',
]);

type Surface = 'tarmac' | 'offroad' | 'unknown';

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

function classifySegment(tagsStr: string): Surface {
  const tags = parseWayTags(tagsStr);
  // `surface` always wins when present (it is the literal pavement type).
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

/* ------------------------------------------------------------------ */
/* BRouter messages parsing                                            */
/* ------------------------------------------------------------------ */

interface ParsedRow {
  lon: number;
  lat: number;
  ele: number;
  /** Length of the segment ending at this vertex, in metres. */
  segDistM: number;
  surface: Surface;
}

interface BrouterFeatureProps {
  messages?: unknown[][];
  [k: string]: unknown;
}

function parseMessages(route: BrouterRoute): ParsedRow[] {
  const feat = route.raw.features?.[0];
  const props = (feat?.properties ?? {}) as BrouterFeatureProps;
  const messages = props.messages;
  if (!Array.isArray(messages) || messages.length < 2) return [];

  const header = (messages[0] as unknown[]).map((c) => String(c));
  const idxLon = header.indexOf('Longitude');
  const idxLat = header.indexOf('Latitude');
  const idxEle = header.indexOf('Elevation');
  const idxDist = header.indexOf('Distance');
  const idxTags = header.indexOf('WayTags');
  if (idxLon < 0 || idxLat < 0 || idxEle < 0 || idxDist < 0) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < messages.length; i++) {
    const r = messages[i];
    const lon = Number(r[idxLon]) / 1e6;
    const lat = Number(r[idxLat]) / 1e6;
    const ele = Number(r[idxEle]);
    const segDist = Number(r[idxDist]);
    const surface =
      idxTags >= 0 ? classifySegment(String(r[idxTags] ?? '')) : 'unknown';
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    rows.push({
      lon,
      lat,
      ele: Number.isFinite(ele) ? ele : 0,
      segDistM: Number.isFinite(segDist) ? segDist : 0,
      surface,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Elevation smoothing & ascent/descent                                */
/* ------------------------------------------------------------------ */

/** Centred moving-average smoothing — kills DEM quantisation noise. */
function smoothElevations(rows: ParsedRow[], windowSize = 5): number[] {
  const n = rows.length;
  const out = new Array<number>(n);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += rows[j].ele;
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/**
 * Sum positive / negative deltas after a small noise threshold. Anything
 * below `thresholdM` is considered jitter and rolled into the next move.
 */
function computeAscentDescent(
  eles: number[],
  thresholdM = 1,
): { ascent: number; descent: number } {
  if (eles.length < 2) return { ascent: 0, descent: 0 };
  let ascent = 0;
  let descent = 0;
  let pivot = eles[0];
  for (let i = 1; i < eles.length; i++) {
    const delta = eles[i] - pivot;
    if (Math.abs(delta) >= thresholdM) {
      if (delta > 0) ascent += delta;
      else descent += -delta;
      pivot = eles[i];
    }
  }
  return { ascent, descent };
}

function aggregate(rows: ParsedRow[], totalDistFallback: number): RouteMetrics {
  const smoothed = smoothElevations(rows, 5);
  const { ascent, descent } = computeAscentDescent(smoothed, 1);

  let totalDist = 0;
  let tarmacDist = 0;
  let offroadDist = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].segDistM;
    totalDist += d;
    if (rows[i].surface === 'tarmac') tarmacDist += d;
    else if (rows[i].surface === 'offroad') offroadDist += d;
  }
  if (totalDist === 0) totalDist = totalDistFallback;

  const classifiedDist = tarmacDist + offroadDist;
  const tarmacPercent =
    classifiedDist > 0 ? (tarmacDist / classifiedDist) * 100 : 0;
  const offroadPercent =
    classifiedDist > 0 ? (offroadDist / classifiedDist) * 100 : 0;
  const avgSlopePercent = totalDist > 0 ? (ascent / totalDist) * 100 : 0;

  return {
    distanceM: totalDist,
    ascentM: ascent,
    descentM: descent,
    avgSlopePercent,
    tarmacPercent,
    offroadPercent,
  };
}

function buildRouteProfile(rows: ParsedRow[]): RouteProfilePoint[] {
  const smoothed = smoothElevations(rows, 5);
  const distancesM = new Array<number>(rows.length).fill(0);

  for (let i = 1; i < rows.length; i++) {
    distancesM[i] = distancesM[i - 1] + Math.max(0, rows[i].segDistM);
  }

  const profile: RouteProfilePoint[] = [];

  for (let i = 0; i < rows.length; i++) {
    const prevIndex = i > 0 ? i - 1 : i;
    const nextIndex = i < rows.length - 1 ? i + 1 : i;
    const spanM = distancesM[nextIndex] - distancesM[prevIndex];
    const gradientPct =
      spanM > 0.5 ? ((smoothed[nextIndex] - smoothed[prevIndex]) / spanM) * 100 : 0;
    profile.push({
      lat: rows[i].lat,
      lon: rows[i].lon,
      distanceM: distancesM[i],
      elevationM: smoothed[i],
      gradientPct,
    });
  }

  return profile;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * First-pass metrics straight from the BRouter messages. Returns null
 * when the response carries no parsable messages array (older proxy
 * configs).
 */
export function computeRouteMetricsFromBrouter(
  route: BrouterRoute,
): RouteMetrics | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;
  return aggregate(rows, route.distanceM);
}

export function extractRouteProfileFromBrouter(
  route: BrouterRoute,
): RouteProfilePoint[] | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;
  return buildRouteProfile(rows);
}

/**
 * Resample elevations using the map's currently-loaded DEM (Mapbox
 * terrain ≈ 10 m at z14, LIDAR 0.4 m where downloaded). Vertices that
 * are not yet covered by loaded tiles fall back to BRouter's elevation.
 *
 * Returns null when fewer than 60 % of the vertices could be sampled —
 * in that case the caller should keep the BRouter-based metrics.
 */
export function refineMetricsWithTerrain(
  route: BrouterRoute,
  queryEle: (lng: number, lat: number) => number | null | undefined,
): RouteMetrics | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;

  let coverage = 0;
  for (const r of rows) {
    const e = queryEle(r.lon, r.lat);
    if (e != null && Number.isFinite(e)) {
      r.ele = e;
      coverage++;
    }
  }
  if (coverage / rows.length < 0.6) return null;

  return aggregate(rows, route.distanceM);
}

export function refineRouteProfileWithTerrain(
  route: BrouterRoute,
  queryEle: (lng: number, lat: number) => number | null | undefined,
): RouteProfilePoint[] | null {
  const rows = parseMessages(route);
  if (rows.length < 2) return null;

  let coverage = 0;
  for (const r of rows) {
    const e = queryEle(r.lon, r.lat);
    if (e != null && Number.isFinite(e)) {
      r.ele = e;
      coverage++;
    }
  }
  if (coverage / rows.length < 0.6) return null;

  return buildRouteProfile(rows);
}
