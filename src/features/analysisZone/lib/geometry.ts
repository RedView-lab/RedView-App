/**
 * Geometry helpers for the analysis zone (single user-drawn polygon that
 * focuses the terrain widgets — slopes / altitude / sunlight — on a bounded
 * area instead of the whole viewport).
 */

export interface AnalysisZonePoint {
  lat: number;
  lon: number;
}

export interface AnalysisZone {
  id: string;
  points: AnalysisZonePoint[];
  createdAt: string;
}

/** [west, south, east, north] in degrees. */
export type BoundsTuple = [number, number, number, number];

const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -85.05;
const LAT_MAX = 85.05;

export function isValidAnalysisZone(zone: AnalysisZone | null | undefined): zone is AnalysisZone {
  return Boolean(
    zone
    && Array.isArray(zone.points)
    && zone.points.length >= 3
    && zone.points.every(
      (point) => Number.isFinite(point.lat)
        && Number.isFinite(point.lon)
        && point.lat >= -90 && point.lat <= 90
        && point.lon >= -180 && point.lon <= 180,
    ),
  );
}

/** Ring of [lng, lat] pairs, closed (first point repeated at the end). */
export function analysisZoneRing(zone: AnalysisZone): [number, number][] {
  const ring = zone.points.map((point) => [point.lon, point.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

export function analysisZoneBBox(zone: AnalysisZone): BoundsTuple {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const point of zone.points) {
    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  return [
    Math.max(LNG_MIN, west),
    Math.max(LAT_MIN, south),
    Math.min(LNG_MAX, east),
    Math.min(LAT_MAX, north),
  ];
}

/**
 * Mapbox raster-source `bounds` for the zone. Tiles outside these bounds are
 * never requested, which is what keeps the slope / altitude tile fan-out
 * proportional to the zone size instead of the viewport size.
 */
export function analysisZoneSourceBounds(zone: AnalysisZone): [number, number, number, number] {
  const [w, s, e, n] = analysisZoneBBox(zone);
  // Shrink slightly inside the bbox so neighbouring tiles that only touch the
  // bbox edge are not requested when the polygon strictly excludes them. The
  // Service Worker applies the exact per-pixel polygon mask on top of this.
  const padX = Math.min(0.0025, (e - w) * 0.01);
  const padY = Math.min(0.0025, (n - s) * 0.01);
  return [
    Math.max(LNG_MIN, w - padX),
    Math.max(LAT_MIN, s - padY),
    Math.min(LNG_MAX, e + padX),
    Math.min(LAT_MAX, n + padY),
  ];
}

/**
 * Compact stable hash (FNV-1a 32-bit, hex) of the ring, quantised to 1e-6 deg
 * (~0.1 m) so floating point noise never changes the key. Used as the
 * `?zone=` cache-busting token in tile URLs and as the Service Worker
 * registry key: same polygon → same tiles, edited polygon → fresh tiles.
 */
export function hashAnalysisZone(zone: AnalysisZone): string {
  let hash = 0x811c9dc5;
  const ring = analysisZoneRing(zone);
  for (const [lng, lat] of ring) {
    const token = `${lat.toFixed(6)},${lng.toFixed(6)};`;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** Flat [lng, lat, lng, lat, …] ring payload for workers / Service Worker. */
export function analysisZoneRingPayload(zone: AnalysisZone): number[] {
  const out: number[] = [];
  for (const [lng, lat] of analysisZoneRing(zone)) {
    out.push(lng, lat);
  }
  return out;
}

/** Rough max side of the bbox in km — powers the “huge zone” hint. */
export function analysisZoneMaxSideKm(zone: AnalysisZone): number {
  const [w, s, e, n] = analysisZoneBBox(zone);
  const midLat = ((n + s) / 2) * (Math.PI / 180);
  const widthKm = ((e - w) * (Math.PI / 180)) * 6371 * Math.cos(midLat);
  const heightKm = ((n - s) * (Math.PI / 180)) * 6371;
  return Math.max(Math.abs(widthKm), Math.abs(heightKm));
}

/** Suggested soft cap — beyond this the “zone-limited” gain shrinks fast. */
export const ANALYSIS_ZONE_RECOMMENDED_MAX_SIDE_KM = 60;
