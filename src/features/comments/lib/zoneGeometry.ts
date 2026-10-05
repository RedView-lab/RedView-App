import type { ProjectCommentZone } from '@/features/itineraryPanel/types';

import { MAX_COMMENT_ZONE_VERTICES, MIN_COMMENT_ZONE_VERTICES } from './limits';

/**
 * Zones commentées : le rectangle glissé à l'écran devient l'empreinte au sol
 * de ce rectangle (ce que l'utilisateur voyait pendant le geste, y compris en
 * vue inclinée). Les bords sont densifiés pour bien se draper sur le relief.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

export type LngLatPair = [number, number];

/** Taille minimale (px) d'un rectangle de zone : en dessous, c'est un clic. */
export const MIN_ZONE_DRAG_PX = 12;
/** Points par côté du rectangle (4 côtés : 4 × 8 = 32 sommets). */
const POINTS_PER_SIDE = 8;

export function isZoneDrag(start: ScreenPoint, end: ScreenPoint): boolean {
  return Math.abs(end.x - start.x) >= MIN_ZONE_DRAG_PX && Math.abs(end.y - start.y) >= MIN_ZONE_DRAG_PX;
}

/** Points du contour d'un rectangle écran, sens horaire depuis le coin haut-gauche. */
export function screenRectOutline(start: ScreenPoint, end: ScreenPoint, pointsPerSide = POINTS_PER_SIDE): ScreenPoint[] {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const corners: ScreenPoint[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const out: ScreenPoint[] = [];
  for (let side = 0; side < 4; side += 1) {
    const from = corners[side];
    const to = corners[(side + 1) % 4];
    for (let step = 0; step < pointsPerSide; step += 1) {
      const t = step / pointsPerSide;
      out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return out;
}

/**
 * Empreinte au sol d'un rectangle écran. `unproject` : point écran → lng/lat
 * sur le terrain (null au-dessus de l'horizon). `minY` : premier y écran
 * sous l'horizon (les points plus hauts y sont ramenés). Null : rectangle
 * trop petit ou hors du sol.
 */
export function zoneFromScreenRect(
  start: ScreenPoint,
  end: ScreenPoint,
  unproject: (point: ScreenPoint) => LngLatPair | null,
  minY = Number.NEGATIVE_INFINITY,
): ProjectCommentZone | null {
  if (!isZoneDrag(start, end)) return null;
  const ring: LngLatPair[] = [];
  for (const point of screenRectOutline(start, end)) {
    const lngLat = unproject({ x: point.x, y: Math.max(point.y, minY) });
    if (!lngLat || !Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) continue;
    const previous = ring[ring.length - 1];
    if (previous && previous[0] === lngLat[0] && previous[1] === lngLat[1]) continue;
    ring.push([roundCoordinate(lngLat[0]), roundCoordinate(lngLat[1])]);
  }
  if (ring.length < MIN_COMMENT_ZONE_VERTICES) return null;
  return { ring: ring.slice(0, MAX_COMMENT_ZONE_VERTICES) };
}

/** 1e-7° ≈ 1 cm : assez pour une zone, moins de bruit dans le document. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/** Anneau fermé GeoJSON (premier sommet répété). */
export function closedRing(zone: ProjectCommentZone): LngLatPair[] {
  const ring = zone.ring.map(([lng, lat]) => [lng, lat] as LngLatPair);
  if (ring.length > 0) ring.push([...ring[0]] as LngLatPair);
  return ring;
}

/** Polygone (sommets lng/lat) en zone : simplifiée au nombre maximal de sommets. */
export function zoneFromPolygon(points: readonly LngLatPair[]): ProjectCommentZone | null {
  const ring = points.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    .map(([lng, lat]) => [roundCoordinate(lng), roundCoordinate(lat)] as LngLatPair);
  if (ring.length < MIN_COMMENT_ZONE_VERTICES) return null;
  if (ring.length <= MAX_COMMENT_ZONE_VERTICES) return { ring };
  const step = ring.length / MAX_COMMENT_ZONE_VERTICES;
  return { ring: Array.from({ length: MAX_COMMENT_ZONE_VERTICES }, (_, index) => ring[Math.floor(index * step)]) };
}

/** Emprise d'une zone : [[ouest, sud], [est, nord]]. */
export function zoneBounds(zone: ProjectCommentZone): [LngLatPair, LngLatPair] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of zone.ring) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [[west, south], [east, north]];
}
