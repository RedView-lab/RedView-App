import type { Point } from './config';

// Géométrie des points de détour (distances, ancres le long du tracé).

export function haversineKm(a: Point, b: Point): number {
  const radiusKm = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = (sinLat * sinLat) + (Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon);
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildDetourPoint(start: Point, end: Point, along: number, offsetKm: number): Point {
  const meanLatRad = (((start.lat + end.lat) / 2) * Math.PI) / 180;
  const kmPerDegLon = Math.max(25, 111.32 * Math.cos(meanLatRad));
  const kmPerDegLat = 110.57;
  const dxKm = (end.lon - start.lon) * kmPerDegLon;
  const dyKm = (end.lat - start.lat) * kmPerDegLat;
  const lengthKm = Math.max(1, Math.hypot(dxKm, dyKm));
  const perpX = -dyKm / lengthKm;
  const perpY = dxKm / lengthKm;
  const baseLat = start.lat + ((end.lat - start.lat) * along);
  const baseLon = start.lon + ((end.lon - start.lon) * along);
  return {
    lat: Math.max(-85, Math.min(85, baseLat + ((perpY * offsetKm) / kmPerDegLat))),
    lon: Math.max(-180, Math.min(180, baseLon + ((perpX * offsetKm) / kmPerDegLon))),
  };
}

export function buildAnchoredDetourPoint(anchor: Point, tangentStart: Point, tangentEnd: Point, offsetKm: number): Point {
  const meanLatRad = (((tangentStart.lat + tangentEnd.lat) / 2) * Math.PI) / 180;
  const kmPerDegLon = Math.max(25, 111.32 * Math.cos(meanLatRad));
  const kmPerDegLat = 110.57;
  const dxKm = (tangentEnd.lon - tangentStart.lon) * kmPerDegLon;
  const dyKm = (tangentEnd.lat - tangentStart.lat) * kmPerDegLat;
  const lengthKm = Math.max(1, Math.hypot(dxKm, dyKm));
  const perpX = -dyKm / lengthKm;
  const perpY = dxKm / lengthKm;
  return {
    lat: Math.max(-85, Math.min(85, anchor.lat + ((perpY * offsetKm) / kmPerDegLat))),
    lon: Math.max(-180, Math.min(180, anchor.lon + ((perpX * offsetKm) / kmPerDegLon))),
  };
}

export function estimateRouteSpanKm(from: Point, to: Point): number {
  const meanLatRad = (((from.lat + to.lat) / 2) * Math.PI) / 180;
  const dxKm = (to.lon - from.lon) * Math.max(25, 111.32 * Math.cos(meanLatRad));
  const dyKm = (to.lat - from.lat) * 110.57;
  return Math.max(1, Math.hypot(dxKm, dyKm));
}

export function normalizeDetourRatios(values: number[]): number[] {
  const seen = new Set<number>();
  const ratios: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const normalized = Math.round(Math.max(0.06, Math.min(0.56, value)) * 1000) / 1000;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ratios.push(normalized);
  }
  return ratios;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sampleRouteAnchor(
  coordinates: [number, number][],
  along: number,
): { anchor: Point; tangentStart: Point; tangentEnd: Point } | null {
  if (coordinates.length < 2) return null;
  const routePoints = coordinates.map(([lon, lat]) => ({ lat, lon }));
  const clampedAlong = Math.max(0.02, Math.min(0.98, along));
  let totalKm = 0;
  const cumulativeKm = [0];
  for (let i = 1; i < routePoints.length; i++) {
    totalKm += haversineKm(routePoints[i - 1], routePoints[i]);
    cumulativeKm.push(totalKm);
  }
  if (totalKm <= 0) return null;
  const targetKm = totalKm * clampedAlong;
  for (let i = 1; i < routePoints.length; i++) {
    const segStartKm = cumulativeKm[i - 1];
    const segEndKm = cumulativeKm[i];
    if (targetKm > segEndKm && i < routePoints.length - 1) continue;
    const segmentKm = Math.max(0.001, segEndKm - segStartKm);
    const segAlong = Math.max(0, Math.min(1, (targetKm - segStartKm) / segmentKm));
    const start = routePoints[i - 1];
    const end = routePoints[i];
    return {
      anchor: {
        lat: start.lat + ((end.lat - start.lat) * segAlong),
        lon: start.lon + ((end.lon - start.lon) * segAlong),
      },
      tangentStart: start,
      tangentEnd: end,
    };
  }
  return null;
}

export function computeRouteLateralBias(
  coordinates: [number, number][],
  start: Point,
  end: Point,
): number {
  const directDx = end.lon - start.lon;
  const directDy = end.lat - start.lat;
  const directNorm = Math.hypot(directDx, directDy);
  if (directNorm <= 1e-9 || coordinates.length < 2) return 0;
  const sampleAlongs = [0.36, 0.5, 0.64];
  let weightedBias = 0;
  let weightSum = 0;
  for (const along of sampleAlongs) {
    const anchor = sampleRouteAnchor(coordinates, along);
    if (!anchor) continue;
    const relDx = anchor.anchor.lon - start.lon;
    const relDy = anchor.anchor.lat - start.lat;
    const signedArea = ((directDx * relDy) - (directDy * relDx)) / directNorm;
    const weight = 1 - Math.abs(along - 0.5);
    weightedBias += signedArea * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedBias / weightSum : 0;
}
