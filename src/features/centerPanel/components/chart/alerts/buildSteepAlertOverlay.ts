import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary, SteepAlertKind } from '@/features/itineraryPanel/types';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { AxisMode, RouteChartPoint } from '../seriesCommon';
import { normalizeRouteProfile } from '../series/routeProfile';
import { locateRoutePointAtX } from '../series/builders';
import { projectPredictionElapsedHoursToX } from '../series/timeline';

export interface SteepAlertRule {
  /** Pente moyenne minimale (%) tenue sur toute la fenêtre. */
  minGradientPct: number;
  /** Longueur minimale de la fenêtre (m). */
  minLengthM: number;
}

/**
 * Seuils d'alerte (un seul suffit) :
 *  - pente moyenne ≥ 10 % tenue sur au moins 1 km ;
 *  - pente moyenne ≥ 15 % tenue sur au moins 100 m.
 */
export const STEEP_ALERT_RULES: ReadonlyArray<SteepAlertRule> = [
  { minGradientPct: 10, minLengthM: 1000 },
  { minGradientPct: 15, minLengthM: 100 },
];

/** Pas de ré-échantillonnage du profil (m). */
const SAMPLE_STEP_M = 10;
/** Fenêtre utilisée pour la pente max affichée d'un tronçon (m). */
const MAX_GRADIENT_WINDOW_M = 100;
/** Deux alertes séparées de moins que ça sont fusionnées en une seule colonne. */
const MERGE_GAP_M = 40;

export interface SteepAlertSegment {
  startM: number;
  endM: number;
  avgGradientPct: number;
  maxGradientPct: number;
}

export interface ChartAlertWindow {
  id: string;
  itineraryId: string;
  itineraryName: string;
  startX: number;
  endX: number;
  lengthM: number;
  avgGradientPct: number;
  maxGradientPct: number;
}

export interface ChartAlertOverlay {
  alertWindows: ChartAlertWindow[];
}

const segmentsCache = new WeakMap<object, SteepAlertSegment[]>();

/** Alerte pente résolue pour un itinéraire, avec son point d'ancrage (milieu du tronçon). */
export interface ItinerarySteepAlert {
  id: string;
  /** Clé stable (coordonnées du milieu) : survit aux éditions ailleurs sur le tracé. */
  key: string;
  itineraryId: string;
  segment: SteepAlertSegment;
  mid: RouteChartPoint;
  kind: SteepAlertKind;
}

export function steepAlertKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Détecte les tronçons qui satisfont au moins une règle de `STEEP_ALERT_RULES`.
 * Pour chaque règle, une fenêtre glissante de `minLengthM` parcourt le profil
 * ré-échantillonné ; toutes les fenêtres au-dessus du seuil sont unies en
 * segments continus (puis fusionnés s'ils sont séparés de ≤ MERGE_GAP_M),
 * dont les bords plats sont rognés.
 */
export function detectSteepAlertSegments(
  routePoints: RouteChartPoint[] | null | undefined,
): SteepAlertSegment[] {
  if (!routePoints || routePoints.length < 2) return [];
  const cached = segmentsCache.get(routePoints);
  if (cached) return cached;

  const profile = normalizeRouteProfile(routePoints);
  const result: SteepAlertSegment[] = [];
  if (profile && profile.length >= 2) {
    const startM = profile[0]!.distanceM;
    const totalM = profile[profile.length - 1]!.distanceM;
    const count = Math.floor((totalM - startM) / SAMPLE_STEP_M) + 1;

    if (count >= 2) {
      // Profil d'altitude ré-échantillonné à pas fixe (interpolation linéaire).
      const elev = new Float64Array(count);
      let cursor = 0;
      for (let i = 0; i < count; i += 1) {
        const d = startM + i * SAMPLE_STEP_M;
        while (cursor + 1 < profile.length - 1 && profile[cursor + 1]!.distanceM <= d) cursor += 1;
        const a = profile[cursor]!;
        const b = profile[Math.min(cursor + 1, profile.length - 1)]!;
        const span = b.distanceM - a.distanceM;
        const t = span > 0 ? Math.max(0, Math.min(1, (d - a.distanceM) / span)) : 0;
        elev[i] = a.elevationM + (b.elevationM - a.elevationM) * t;
      }

      // Couverture par intervalle d'échantillonnage [k, k+1] : tableau de
      // différences, chaque fenêtre qualifiante [i, j] ajoute +1 sur [i, j-1].
      const coverage = new Int32Array(count);
      for (const rule of STEEP_ALERT_RULES) {
        const windowSteps = Math.round(rule.minLengthM / SAMPLE_STEP_M);
        const threshold = rule.minGradientPct / 100;
        const windowM = windowSteps * SAMPLE_STEP_M;
        for (let i = 0; i + windowSteps < count; i += 1) {
          const j = i + windowSteps;
          if ((elev[j]! - elev[i]!) / windowM >= threshold) {
            coverage[i]! += 1;
            coverage[j]! -= 1;
          }
        }
      }

      const maxWindowSteps = Math.round(MAX_GRADIENT_WINDOW_M / SAMPLE_STEP_M);
      // Une fenêtre qualifiante (surtout celle de 1 km) peut déborder sur le
      // plat avant/après la montée : on rogne les bords tant que le pas local
      // est franchement plus doux (< moitié du seuil le plus bas), sans toucher
      // aux épaulements de la montée elle-même.
      const edgeThreshold = Math.min(...STEEP_ALERT_RULES.map((rule) => rule.minGradientPct)) / 200;
      const stepGrade = (k: number) => (elev[k + 1]! - elev[k]!) / SAMPLE_STEP_M;
      const pushSegment = (rawStart: number, rawEnd: number) => {
        let runStart = rawStart;
        let runEnd = rawEnd;
        while (runEnd - runStart > maxWindowSteps && stepGrade(runStart) < edgeThreshold) runStart += 1;
        while (runEnd - runStart > maxWindowSteps && stepGrade(runEnd - 1) < edgeThreshold) runEnd -= 1;
        let maxGrade = -Infinity;
        for (let i = runStart; i + maxWindowSteps <= runEnd; i += 1) {
          maxGrade = Math.max(maxGrade, (elev[i + maxWindowSteps]! - elev[i]!) / MAX_GRADIENT_WINDOW_M);
        }
        const segStart = startM + runStart * SAMPLE_STEP_M;
        const segEnd = startM + runEnd * SAMPLE_STEP_M;
        const avg = ((elev[runEnd]! - elev[runStart]!) / (segEnd - segStart)) * 100;
        result.push({
          startM: segStart,
          endM: segEnd,
          avgGradientPct: avg,
          maxGradientPct: Math.max(avg, maxGrade * 100),
        });
      };

      const mergeGapSteps = Math.round(MERGE_GAP_M / SAMPLE_STEP_M);
      let runStart = -1;
      let runEnd = -1;
      let depth = 0;
      for (let k = 0; k < count - 1; k += 1) {
        depth += coverage[k]!;
        if (depth <= 0) continue;
        if (runStart >= 0 && k - runEnd <= mergeGapSteps) {
          runEnd = k + 1;
          continue;
        }
        if (runStart >= 0) pushSegment(runStart, runEnd);
        runStart = k;
        runEnd = k + 1;
      }
      if (runStart >= 0) pushSegment(runStart, runEnd);
    }
  }

  segmentsCache.set(routePoints, result);
  return result;
}

/**
 * Alertes pente d'un itinéraire, sans celles que l'utilisateur a ignorées.
 * `id` reprend l'index du segment détecté (même id que les colonnes du graphe).
 */
export function listItinerarySteepAlerts(itinerary: Itinerary): ItinerarySteepAlert[] {
  const points = itinerary.gpxRoute?.points;
  if (!points || points.length < 2) return [];
  const overrides = itinerary.steepAlertOverrides;
  const result: ItinerarySteepAlert[] = [];
  detectSteepAlertSegments(points).forEach((segment, index) => {
    const midKm = (segment.startM + segment.endM) / 2000;
    const mid = locateRoutePointAtX(points, null, 'distance', midKm);
    if (!mid || !Number.isFinite(mid.lat) || !Number.isFinite(mid.lon)) return;
    const key = steepAlertKey(mid.lat, mid.lon);
    const override = overrides?.[key];
    if (override?.ignored) return;
    result.push({
      id: `${itinerary.id}::alert::${index}`,
      key,
      itineraryId: itinerary.id,
      segment,
      mid,
      kind: override?.kind ?? 'alert',
    });
  });
  return result;
}

function interpolateElapsedHours(prediction: PredictionResult, distanceM: number): number | null {
  const points = prediction.points;
  if (!points || points.length < 2) return null;
  if (distanceM <= points[0]!.distance_m) return points[0]!.elapsed_time_s / 3600;
  const last = points[points.length - 1]!;
  if (distanceM >= last.distance_m) return last.elapsed_time_s / 3600;

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.distance_m <= distanceM) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const span = b.distance_m - a.distance_m;
  const t = span > 0 ? (distanceM - a.distance_m) / span : 0;
  return (a.elapsed_time_s + (b.elapsed_time_s - a.elapsed_time_s) * t) / 3600;
}

/**
 * Projette les alertes pente d'un itinéraire sur l'axe X du graphe (distance,
 * temps ou heure). En mode temps/heure, une prédiction est requise.
 */
export function buildAlertWindowsForItinerary(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  xOffset = 0,
): ChartAlertWindow[] {
  const alerts = listItinerarySteepAlerts(itinerary);
  if (alerts.length === 0) return [];
  if (xMode !== 'distance' && (!prediction || prediction.points.length < 2)) return [];

  const pauseSchedule = xMode === 'distance' ? null : buildPauseAwareSchedule(itinerary, prediction);
  const toX = (distanceM: number): number => {
    if (xMode === 'distance') return distanceM / 1000 + xOffset;
    const hours = interpolateElapsedHours(prediction as PredictionResult, distanceM);
    return projectPredictionElapsedHoursToX(hours, xMode, itinerary.rhythm.startTime, pauseSchedule);
  };

  const windows: ChartAlertWindow[] = [];
  alerts.forEach(({ id, segment }) => {
    const startX = toX(segment.startM);
    const endX = toX(segment.endM);
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || endX <= startX) return;
    windows.push({
      id,
      itineraryId: itinerary.id,
      itineraryName: itinerary.name,
      startX,
      endX,
      lengthM: segment.endM - segment.startM,
      avgGradientPct: segment.avgGradientPct,
      maxGradientPct: segment.maxGradientPct,
    });
  });
  return windows;
}
