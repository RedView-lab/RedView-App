import { isValidElevation } from '@/features/itineraryPanel/lib/route-metrics/elevationSanitizer';
import { lngFromMercatorX, latFromMercatorY, mercatorXFromLng, mercatorYFromLat } from './geo';

export interface FlyoverRoutePoint {
  lat: number;
  lon: number;
  elevationM?: number | null;
}

/**
 * Trace d'origine prête pour la lecture : positions Mercator, distance
 * cumulée (même convention que le graphique), altitude (NaN si inconnue) et
 * avancement `line-progress` — longueur d'arc Mercator projetée, la métrique
 * que geojson-vt utilise pour `line-trim-offset`.
 */
export interface RouteTrack {
  readonly count: number;
  readonly totalM: number;
  readonly distanceM: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly elevationM: Float64Array;
  readonly hasElevation: boolean;
  readonly lineProgress: Float64Array;
  readonly bounds: readonly [[number, number], [number, number]];
}

/**
 * @param distancesM distance cumulée de chaque point (`getRoutePointDistances`
 * côté app) : la tête de lecture et le curseur du graphique partagent ainsi le
 * même repère.
 */
export function buildRouteTrack(points: readonly FlyoverRoutePoint[], distancesM: ArrayLike<number>): RouteTrack | null {
  const count = points.length;
  if (count < 2 || distancesM.length !== count) return null;
  const totalM = distancesM[count - 1];
  if (!(totalM > 1)) return null;

  const distanceM = new Float64Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const rawElevation = new Float64Array(count);
  const lineProgress = new Float64Array(count);
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    const point = points[i];
    // Distances monotones même si la source ne l'est pas.
    previous = Math.max(previous, Number.isFinite(distancesM[i]) ? distancesM[i] : previous);
    distanceM[i] = previous;
    x[i] = mercatorXFromLng(point.lon);
    y[i] = mercatorYFromLat(point.lat);
    rawElevation[i] = isValidElevation(point.elevationM) ? (point.elevationM as number) : Number.NaN;
    if (i > 0) lineProgress[i] = lineProgress[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    minLng = Math.min(minLng, point.lon);
    maxLng = Math.max(maxLng, point.lon);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  }
  const arc = lineProgress[count - 1];
  for (let i = 0; i < count; i += 1) lineProgress[i] = arc > 0 ? lineProgress[i] / arc : i / (count - 1);

  const { values: elevationM, hasValues } = fillElevationGaps(rawElevation, distanceM);
  return {
    count,
    totalM: distanceM[count - 1],
    distanceM,
    x,
    y,
    elevationM,
    hasElevation: hasValues,
    lineProgress,
    bounds: [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
  };
}

/** Trous d'altitude comblés linéairement en distance, bords prolongés ; zéros si aucune valeur. */
function fillElevationGaps(raw: Float64Array, distanceM: Float64Array): { values: Float64Array; hasValues: boolean } {
  const n = raw.length;
  const values = new Float64Array(n);
  let firstValid = -1;
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(raw[i])) {
      firstValid = i;
      break;
    }
  }
  if (firstValid < 0) return { values, hasValues: false };
  let lastValid = firstValid;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(raw[i])) continue;
    values[i] = raw[i];
    if (i > lastValid + 1) {
      const span = distanceM[i] - distanceM[lastValid];
      for (let k = lastValid + 1; k < i; k += 1) {
        const t = span > 0 ? (distanceM[k] - distanceM[lastValid]) / span : (k - lastValid) / (i - lastValid);
        values[k] = raw[lastValid] + (raw[i] - raw[lastValid]) * t;
      }
    }
    lastValid = i;
  }
  for (let i = 0; i < firstValid; i += 1) values[i] = raw[firstValid];
  for (let i = lastValid + 1; i < n; i += 1) values[i] = raw[lastValid];
  return { values, hasValues: true };
}

export interface TrackPosition {
  x: number;
  y: number;
  lng: number;
  lat: number;
  elevationM: number;
  lineProgress: number;
}

/**
 * Lecture de la trace à une distance donnée. Garde le dernier segment trouvé :
 * en lecture la tête avance de quelques segments par frame, la recherche est
 * donc en O(1) amorti (dichotomie seulement sur un saut, ex. seek).
 */
export class TrackCursor {
  private readonly track: RouteTrack;
  private segment = 0;

  constructor(track: RouteTrack) {
    this.track = track;
  }

  locate(distance: number, out: TrackPosition): TrackPosition {
    const { distanceM, x, y, elevationM, lineProgress, count } = this.track;
    const s = Math.max(0, Math.min(this.track.totalM, distance));
    let i = this.segment;
    if (s < distanceM[i] || s > distanceM[Math.min(count - 1, i + 1)]) {
      // Petit pas : marche ; grand saut : dichotomie.
      let steps = 0;
      while (i > 0 && s < distanceM[i] && steps < 32) {
        i -= 1;
        steps += 1;
      }
      while (i < count - 2 && s > distanceM[i + 1] && steps < 32) {
        i += 1;
        steps += 1;
      }
      if (s < distanceM[i] || s > distanceM[i + 1]) i = this.search(s);
      this.segment = i;
    }
    const j = Math.min(count - 1, i + 1);
    const span = distanceM[j] - distanceM[i];
    const t = span > 0 ? (s - distanceM[i]) / span : 0;
    out.x = x[i] + (x[j] - x[i]) * t;
    out.y = y[i] + (y[j] - y[i]) * t;
    out.lng = lngFromMercatorX(out.x);
    out.lat = latFromMercatorY(out.y);
    out.elevationM = elevationM[i] + (elevationM[j] - elevationM[i]) * t;
    out.lineProgress = lineProgress[i] + (lineProgress[j] - lineProgress[i]) * t;
    return out;
  }

  private search(s: number): number {
    const { distanceM, count } = this.track;
    let lo = 0;
    let hi = count - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (distanceM[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}

export function createTrackPosition(): TrackPosition {
  return { x: 0, y: 0, lng: 0, lat: 0, elevationM: 0, lineProgress: 0 };
}
