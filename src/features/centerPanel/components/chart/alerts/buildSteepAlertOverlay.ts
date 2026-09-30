import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { AxisMode, RouteChartPoint } from '../seriesCommon';
import { normalizeRouteProfile } from '../series/routeProfile';
import { projectPredictionElapsedHoursToX } from '../series/timeline';

/** Seuil d'alerte : pente moyenne ≥ 12 % tenue sur au moins 100 m. */
export const STEEP_ALERT_MIN_GRADIENT_PCT = 12;
export const STEEP_ALERT_MIN_LENGTH_M = 100;

/** Pas de ré-échantillonnage du profil (m). */
const SAMPLE_STEP_M = 10;
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

/**
 * Détecte les tronçons dont la pente moyenne est ≥ 12 % sur au moins 100 m.
 * Une fenêtre glissante de 100 m parcourt le profil ré-échantillonné ; toutes
 * les fenêtres au-dessus du seuil sont unies en segments continus.
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
    const windowSteps = Math.round(STEEP_ALERT_MIN_LENGTH_M / SAMPLE_STEP_M);

    if (count > windowSteps) {
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

      const threshold = STEEP_ALERT_MIN_GRADIENT_PCT / 100;
      let runStart = -1;
      let runEnd = -1;
      let runMax = 0;

      const flush = () => {
        if (runStart < 0) return;
        const lengthM = (runEnd - runStart) * SAMPLE_STEP_M;
        const avg = ((elev[runEnd]! - elev[runStart]!) / lengthM) * 100;
        const segStart = startM + runStart * SAMPLE_STEP_M;
        const segEnd = startM + runEnd * SAMPLE_STEP_M;
        const previous = result[result.length - 1];
        if (previous && segStart - previous.endM <= MERGE_GAP_M) {
          const mergedLength = segEnd - previous.startM;
          const startIdx = Math.round((previous.startM - startM) / SAMPLE_STEP_M);
          previous.avgGradientPct = ((elev[runEnd]! - elev[startIdx]!) / mergedLength) * 100;
          previous.endM = segEnd;
          previous.maxGradientPct = Math.max(previous.maxGradientPct, runMax);
        } else {
          result.push({ startM: segStart, endM: segEnd, avgGradientPct: avg, maxGradientPct: runMax });
        }
        runStart = -1;
      };

      for (let i = 0; i + windowSteps < count; i += 1) {
        const j = i + windowSteps;
        const grade = (elev[j]! - elev[i]!) / STEEP_ALERT_MIN_LENGTH_M;
        if (grade >= threshold) {
          if (runStart < 0 || i > runEnd) {
            flush();
            runStart = i;
            runMax = 0;
          }
          runEnd = j;
          runMax = Math.max(runMax, grade * 100);
        }
      }
      flush();
    }
  }

  segmentsCache.set(routePoints, result);
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
  const segments = detectSteepAlertSegments(itinerary.gpxRoute?.points ?? null);
  if (segments.length === 0) return [];
  if (xMode !== 'distance' && (!prediction || prediction.points.length < 2)) return [];

  const pauseSchedule = xMode === 'distance' ? null : buildPauseAwareSchedule(itinerary, prediction);
  const toX = (distanceM: number): number => {
    if (xMode === 'distance') return distanceM / 1000 + xOffset;
    const hours = interpolateElapsedHours(prediction as PredictionResult, distanceM);
    return projectPredictionElapsedHoursToX(hours, xMode, itinerary.rhythm.startTime, pauseSchedule);
  };

  const windows: ChartAlertWindow[] = [];
  segments.forEach((segment, index) => {
    const startX = toX(segment.startM);
    const endX = toX(segment.endM);
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || endX <= startX) return;
    windows.push({
      id: `${itinerary.id}::alert::${index}`,
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
