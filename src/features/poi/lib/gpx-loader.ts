import type { GpxRoute } from '../types';

/**
 * Parse a .gpx file into a lightweight route (coordinates only).
 * Supports both <trkpt> (tracks) and <rtept> (routes).
 */
export async function parseGpxFile(file: File): Promise<GpxRoute> {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Fichier GPX invalide');

  // Extract route name
  const nameEl = doc.querySelector('trk > name') ?? doc.querySelector('rte > name');
  const name = nameEl?.textContent?.trim() ?? null;

  // Collect track points first, then route points as fallback
  const trkpts = doc.querySelectorAll('trkpt');
  const rtepts = doc.querySelectorAll('rtept');
  const raw = trkpts.length > 0 ? trkpts : rtepts;

  if (raw.length === 0) throw new Error('Aucun point trouvé dans le GPX');

  const points: { lat: number; lon: number }[] = [];

  for (const el of raw) {
    const lat = parseFloat(el.getAttribute('lat') ?? '');
    const lon = parseFloat(el.getAttribute('lon') ?? '');
    if (!isFinite(lat) || !isFinite(lon)) continue;
    points.push({ lat, lon });
  }

  if (points.length < 2) throw new Error('GPX doit contenir au moins 2 points');

  return { name, points };
}

/**
 * Downsample route to at most `maxPts` points, keeping first & last.
 * Uses uniform stride sampling — good enough for Overpass corridor queries.
 */
export function sampleRoutePoints(
  points: { lat: number; lon: number }[],
  maxPts: number,
): { lat: number; lon: number }[] {
  if (points.length <= maxPts) return points;

  const result: { lat: number; lon: number }[] = [points[0]];
  const step = (points.length - 1) / (maxPts - 1);

  for (let i = 1; i < maxPts - 1; i++) {
    result.push(points[Math.round(i * step)]);
  }

  result.push(points[points.length - 1]);
  return result;
}

// ── Distance-aware sampling for Overpass corridor queries ─────────────

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres between two lat/lon pairs. */
function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Sample a polyline so that consecutive samples are spaced **at most**
 * `spacingM` apart along the route (so two `around:r` disks of radius
 * `r = spacingM / 2` overlap and leave no gap in the corridor).
 *
 * Always keeps the first and last point. Extra in-between points are
 * inserted by walking the polyline and emitting a sample every time the
 * cumulative distance exceeds `spacingM`.
 *
 * Returns at most `maxPts` samples — for very long routes we let the
 * caller chunk the result and run multiple Overpass queries in
 * sequence rather than blow the URL/body limit on a single one.
 */
export function sampleRouteByDistance(
  points: { lat: number; lon: number }[],
  spacingM: number,
  maxPts: number = 5_000,
): { lat: number; lon: number }[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  if (spacingM <= 0) return points.slice(0, maxPts);

  const result: { lat: number; lon: number }[] = [points[0]];
  let acc = 0;

  for (let i = 1; i < points.length; i++) {
    const seg = haversineM(points[i - 1], points[i]);
    acc += seg;
    if (acc >= spacingM) {
      result.push(points[i]);
      acc = 0;
      if (result.length >= maxPts - 1) break;
    }
  }

  // Always include the last point (unless it's already there).
  const last = points[points.length - 1];
  const tail = result[result.length - 1];
  if (tail.lat !== last.lat || tail.lon !== last.lon) result.push(last);

  return result;
}

/** Total length of a polyline in metres (sum of segment lengths). */
export function routeLengthM(points: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1], points[i]);
  }
  return total;
}
