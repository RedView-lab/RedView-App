import type { Map as MapboxMap } from 'mapbox-gl';
import { projectPointToSegment } from '../routeSplit/routeSnap';

/**
 * Zone de saisie de la trace en mode Tracer (px écran, de part et d'autre de la
 * ligne). Large à dessein : pas besoin de viser la ligne pour la saisir.
 *
 * Deux seuils (hystérésis) : il faut s'approcher à ENTER pour passer à la main,
 * et s'éloigner au-delà de EXIT pour revenir au crayon. Un pointeur qui longe
 * la bordure ne peut donc pas faire alterner les deux curseurs.
 */
export const ROUTE_GRAB_ENTER_PX = 44;
export const ROUTE_GRAB_EXIT_PX = 72;

/**
 * Aux deux extrémités, la zone se referme en pointe : juste après un clic de
 * prolongement, le pointeur est posé sur la nouvelle extrémité, et le clic
 * suivant doit encore prolonger le tracé (crayon) au lieu de saisir la trace.
 * Les poignées de départ / d'arrivée restent, elles, saisissables.
 *
 * Mesuré le long de la trace à l'écran depuis chaque bout : rien de saisissable
 * sur les DEAD premiers px (hystérésis entrée / sortie), puis la tolérance
 * s'ouvre en continu jusqu'à sa pleine largeur sur TAPER px — sans marche, donc
 * sans bascule brutale en longeant la ligne.
 */
export const ROUTE_GRAB_END_DEAD_ENTER_PX = 20;
export const ROUTE_GRAB_END_DEAD_EXIT_PX = 12;
export const ROUTE_GRAB_END_TAPER_PX = 140;
const ROUTE_GRAB_END_MEASURE_PX = ROUTE_GRAB_END_DEAD_ENTER_PX + ROUTE_GRAB_END_TAPER_PX;

export type RouteGrabMode = 'enter' | 'exit';

export interface RouteGrabHit {
  /** Point saisi sur la trace (interpolé en continu sur le segment). */
  snapped: { lat: number; lon: number };
  /** Distance écran pointeur ↔ trace, en px. */
  distancePx: number;
}

interface ScreenProjectionCache {
  key: string;
  builtAt: number;
  xs: Float64Array;
  ys: Float64Array;
  /**
   * Longueur de trace à l'écran (px) entre chaque sommet et le départ / l'arrivée.
   * Renseignée seulement près de chaque bout (+∞ ailleurs, et quand
   * l'extrémité est hors écran).
   */
  fromStart: Float64Array;
  fromEnd: Float64Array;
}

/**
 * Projections écran mises en cache par état caméra : le survol appelait
 * `map.project` deux fois par segment à chaque frame (échantillonnage DEM en
 * 3D), ce qui faisait laguer le survol et « clignoter » le curseur. Tant que la
 * caméra ne bouge pas, on réutilise le tableau (courte expiration pour suivre
 * le chargement des tuiles de relief).
 */
const screenProjectionCache = new WeakMap<object, ScreenProjectionCache>();
const SCREEN_PROJECTION_CACHE_TTL_MS = 400;

function cameraKey(map: MapboxMap): string {
  const center = map.getCenter();
  const canvas = map.getCanvas();
  return [
    center.lng.toFixed(7),
    center.lat.toFixed(7),
    map.getZoom().toFixed(4),
    map.getPitch().toFixed(3),
    map.getBearing().toFixed(3),
    canvas.width,
    canvas.height,
  ].join('|');
}

function getScreenProjections(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
): ScreenProjectionCache | null {
  let key: string;
  let bounds;
  try {
    key = cameraKey(map);
    bounds = map.getBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;

  const now = performance.now();
  const cached = screenProjectionCache.get(points);
  if (
    cached
    && cached.key === key
    && cached.xs.length === points.length
    && now - cached.builtAt < SCREEN_PROJECTION_CACHE_TTL_MS
  ) {
    return cached;
  }

  const marginLon = Math.max(0.01, (bounds.getEast() - bounds.getWest()) * 0.15);
  const marginLat = Math.max(0.01, (bounds.getNorth() - bounds.getSouth()) * 0.15);
  const west = bounds.getWest() - marginLon;
  const east = bounds.getEast() + marginLon;
  const south = bounds.getSouth() - marginLat;
  const north = bounds.getNorth() + marginLat;

  const xs = new Float64Array(points.length).fill(Number.NaN);
  const ys = new Float64Array(points.length).fill(Number.NaN);
  const inView = (p: { lat: number; lon: number }) =>
    p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north;

  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    // Un point hors vue reste utile s'il borde un segment qui traverse l'écran.
    const needed = inView(p)
      || (i > 0 && inView(points[i - 1]!))
      || (i + 1 < points.length && inView(points[i + 1]!));
    if (!needed) continue;
    try {
      const s = map.project([p.lon, p.lat]);
      xs[i] = s.x;
      ys[i] = s.y;
    } catch {
      /* ignore projection error on out-of-world points */
    }
  }

  const fromStart = new Float64Array(points.length).fill(Number.POSITIVE_INFINITY);
  const fromEnd = new Float64Array(points.length).fill(Number.POSITIVE_INFINITY);
  measureFromEnd(xs, ys, fromStart, 0, 1);
  measureFromEnd(xs, ys, fromEnd, points.length - 1, -1);

  const next = { key, builtAt: now, xs, ys, fromStart, fromEnd };
  screenProjectionCache.set(points, next);
  return next;
}

/**
 * Cumule la longueur écran de la trace depuis l'extrémité `start` (pas `step`),
 * jusqu'à dépasser la zone de resserrement ou tomber sur un sommet hors écran.
 */
function measureFromEnd(
  xs: Float64Array,
  ys: Float64Array,
  out: Float64Array,
  start: number,
  step: 1 | -1,
): void {
  if (Number.isNaN(xs[start]!)) return;
  out[start] = 0;
  let length = 0;
  for (let i = start + step; i >= 0 && i < xs.length; i += step) {
    const x = xs[i]!;
    if (Number.isNaN(x)) return;
    length += Math.hypot(x - xs[i - step]!, ys[i]! - ys[i - step]!);
    out[i] = length;
    if (length >= ROUTE_GRAB_END_MEASURE_PX) return;
  }
}

function smoothstep(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value * value * (3 - 2 * value);
}

/**
 * Cherche le point de trace saisissable sous le pointeur (coordonnées écran du
 * conteneur de la carte, comme `map.project`).
 *
 * La tolérance vaut ROUTE_GRAB_ENTER_PX (`mode: 'enter'`) ou ROUTE_GRAB_EXIT_PX
 * (`mode: 'exit'`, quand la main est déjà affichée), refermée aux extrémités.
 * Parmi les segments à portée, on garde le plus proche : c'est là que le point
 * d'aperçu s'affiche et que le point de passage sera inséré.
 */
export function findRouteGrabHit(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
  screenX: number,
  screenY: number,
  mode: RouteGrabMode,
): RouteGrabHit | null {
  if (points.length < 2) return null;

  const projections = getScreenProjections(map, points);
  if (!projections) return null;
  const { xs, ys, fromStart, fromEnd } = projections;

  const fullTolerance = mode === 'exit' ? ROUTE_GRAB_EXIT_PX : ROUTE_GRAB_ENTER_PX;
  const endDeadLength = mode === 'exit' ? ROUTE_GRAB_END_DEAD_EXIT_PX : ROUTE_GRAB_END_DEAD_ENTER_PX;
  const maxDistanceSq = fullTolerance * fullTolerance;

  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegment = -1;
  let bestT = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (Number.isNaN(x0) || Number.isNaN(x1)) continue;
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;

    const { distanceSq, t } = projectPointToSegment(screenX, screenY, x0, y0, x1, y1);
    if (distanceSq > maxDistanceSq || distanceSq >= bestDistanceSq) continue;

    // Tolérance au point projeté : pleine au milieu, refermée près des bouts.
    const segmentLength = Math.hypot(x1 - x0, y1 - y0);
    const alongFromEnds = Math.min(
      fromStart[i]! + t * segmentLength,
      fromEnd[i + 1]! + (1 - t) * segmentLength,
    );
    const tolerance = fullTolerance
      * smoothstep((alongFromEnds - endDeadLength) / ROUTE_GRAB_END_TAPER_PX);
    if (tolerance <= 0 || distanceSq > tolerance * tolerance) continue;

    bestDistanceSq = distanceSq;
    bestSegment = i;
    bestT = t;
  }

  if (bestSegment < 0) return null;

  const p0 = points[bestSegment]!;
  const p1 = points[bestSegment + 1]!;
  return {
    snapped: {
      lat: p0.lat + bestT * (p1.lat - p0.lat),
      lon: p0.lon + bestT * (p1.lon - p0.lon),
    },
    distancePx: Math.sqrt(bestDistanceSq),
  };
}

/** Re-exported tolerance so the drag tool shares the split tool's hit radius. */
export {
  findSplitProjectionForMapHover,
} from '../routeSplit/routeSnap';

export interface RouteAnchorPoint {
  /** Cumulative distance along the route, in metres. */
  distanceM: number;
  lat: number;
  lon: number;
}
