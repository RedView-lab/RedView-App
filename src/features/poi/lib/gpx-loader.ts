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
