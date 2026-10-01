import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { AxisMode, RouteChartPoint } from '../seriesCommon';
import { resampleRouteElevations } from '../series/routeProfile';
import { buildItineraryXProjector } from '../series/itineraryXProjector';
import { classifyGradientPct, SLOPE_COLOR_CLASSES } from './slopeScale';

/** Pas de ré-échantillonnage du profil (m). */
const SAMPLE_STEP_M = 10;
/** Lissage de l'altitude (5 × 10 m ≈ 50 m) avant calcul de pente. */
const SMOOTH_WINDOW_SAMPLES = 5;
/**
 * Fenêtre centrée de calcul de la pente (m). Une fenêtre courte (30 m) donne
 * un rendu moucheté avec des classes de 2 % ; 100 m suit fidèlement les
 * rampes tout en ignorant le bruit du MNT.
 */
const GRADIENT_WINDOW_M = 100;
/** Un tronçon de classe plus court que ça est absorbé par un voisin. */
const MIN_RUN_M = 40;
/** Pas des échantillons de survol (m). */
const HOVER_SAMPLE_STEP_M = 50;
const MAX_ABSORB_PASSES = 8;

export interface SlopeRun {
  startM: number;
  endM: number;
  classIndex: number;
  /** Pente moyenne du tronçon (%). */
  avgPct: number;
}

export interface SlopeProfile {
  startM: number;
  stepM: number;
  /** Pente lissée (%) de chaque intervalle [k, k+1] du profil ré-échantillonné. */
  intervalGrades: Float32Array;
  runs: SlopeRun[];
}

const slopeProfileCache = new WeakMap<object, SlopeProfile | null>();

/**
 * Découpe le tracé en tronçons de classe de pente homogène (`SLOPE_COLOR_CLASSES`).
 * Résultat mis en cache par tableau de points (immutable).
 */
export function detectSlopeProfile(
  routePoints: RouteChartPoint[] | null | undefined,
): SlopeProfile | null {
  if (!routePoints || routePoints.length < 2) return null;
  const cached = slopeProfileCache.get(routePoints);
  if (cached !== undefined) return cached;

  const resampled = resampleRouteElevations(routePoints, SAMPLE_STEP_M, SMOOTH_WINDOW_SAMPLES);
  const result = resampled ? buildSlopeProfile(resampled.startM, resampled.elevations) : null;
  slopeProfileCache.set(routePoints, result);
  return result;
}

function buildSlopeProfile(startM: number, elev: Float64Array): SlopeProfile | null {
  const intervalCount = elev.length - 1;
  if (intervalCount < 1) return null;

  const halfWindow = Math.max(1, Math.round(GRADIENT_WINDOW_M / SAMPLE_STEP_M / 2));
  const intervalGrades = new Float32Array(intervalCount);
  for (let k = 0; k < intervalCount; k += 1) {
    // Fenêtre centrée sur l'intervalle [k, k+1], tronquée aux extrémités.
    const a = Math.max(0, k + 1 - halfWindow);
    const b = Math.min(elev.length - 1, k + halfWindow);
    intervalGrades[k] = ((elev[b]! - elev[a]!) / ((b - a) * SAMPLE_STEP_M)) * 100;
  }

  // Intervalles consécutifs de même classe → tronçons.
  const runs: Array<{ start: number; end: number; classIndex: number }> = [];
  for (let k = 0; k < intervalCount; k += 1) {
    const classIndex = classifyGradientPct(intervalGrades[k]!);
    const last = runs[runs.length - 1];
    if (last && last.classIndex === classIndex) last.end = k + 1;
    else runs.push({ start: k, end: k + 1, classIndex });
  }

  absorbShortRuns(runs, Math.round(MIN_RUN_M / SAMPLE_STEP_M));

  return {
    startM,
    stepM: SAMPLE_STEP_M,
    intervalGrades,
    runs: runs.map(({ start, end, classIndex }) => ({
      startM: startM + start * SAMPLE_STEP_M,
      endM: startM + end * SAMPLE_STEP_M,
      classIndex,
      avgPct: ((elev[end]! - elev[start]!) / ((end - start) * SAMPLE_STEP_M)) * 100,
    })),
  };
}

/**
 * Fusionne chaque tronçon trop court dans le voisin de classe la plus proche
 * (à égalité, le plus long), puis recolle les voisins devenus identiques.
 * Les classes restent celles des intervalles : seules les miettes disparaissent.
 */
function absorbShortRuns(
  runs: Array<{ start: number; end: number; classIndex: number }>,
  minSteps: number,
): void {
  for (let pass = 0; pass < MAX_ABSORB_PASSES && runs.length > 1; pass += 1) {
    let changed = false;
    for (let i = 0; i < runs.length && runs.length > 1; i += 1) {
      const run = runs[i]!;
      if (run.end - run.start >= minSteps) continue;
      const prev = runs[i - 1];
      const next = runs[i + 1];
      let target: typeof run | undefined;
      if (prev && next) {
        const prevDelta = Math.abs(prev.classIndex - run.classIndex);
        const nextDelta = Math.abs(next.classIndex - run.classIndex);
        target = prevDelta < nextDelta
          ? prev
          : nextDelta < prevDelta
            ? next
            : prev.end - prev.start >= next.end - next.start ? prev : next;
      } else {
        target = prev ?? next;
      }
      if (prev && target === prev) prev.end = run.end;
      else if (next && target === next) next.start = run.start;
      else continue;
      runs.splice(i, 1);
      i -= 1;
      changed = true;
    }
    // Recolle les voisins de même classe créés par les absorptions.
    for (let i = runs.length - 1; i > 0; i -= 1) {
      if (runs[i]!.classIndex === runs[i - 1]!.classIndex) {
        runs[i - 1]!.end = runs[i]!.end;
        runs.splice(i, 1);
      }
    }
    if (!changed) break;
  }
}

/** Distance (m) parcourue dans chaque classe de `SLOPE_COLOR_CLASSES`. */
export function summarizeSlopeDistribution(runs: ReadonlyArray<SlopeRun>): number[] {
  const distribution = SLOPE_COLOR_CLASSES.map(() => 0);
  for (const run of runs) {
    distribution[run.classIndex] = (distribution[run.classIndex] ?? 0) + (run.endM - run.startM);
  }
  return distribution;
}

export interface ChartSlopeSegment {
  startX: number;
  endX: number;
  classIndex: number;
}

export interface ChartSlopeOverlay {
  itineraryId: string;
  /** Tronçons projetés sur l'axe X, triés ; les pauses (modes temps) n'en font pas partie. */
  segments: ChartSlopeSegment[];
  /** Échantillons de survol : X croissants et pente locale (%) correspondante. */
  hoverXs: Float64Array;
  hoverGrades: Float32Array;
  /** Distance (m) par classe sur tout l'itinéraire. */
  distributionM: number[];
  totalM: number;
}

/**
 * Colorisation « Pente » d'un itinéraire, projetée sur l'axe X du graphe.
 * `null` si le profil est inexploitable ou si le mode temps/heure n'a pas de prédiction.
 */
export function buildSlopeOverlayForItinerary(
  itinerary: Itinerary,
  prediction: PredictionResult | null | undefined,
  xMode: AxisMode,
  xOffset = 0,
): ChartSlopeOverlay | null {
  const profile = detectSlopeProfile(itinerary.gpxRoute?.points);
  if (!profile || profile.runs.length === 0) return null;
  const projector = buildItineraryXProjector(itinerary, prediction, xMode, xOffset);
  if (!projector) return null;

  const segments: ChartSlopeSegment[] = [];
  for (const run of profile.runs) {
    for (const [startX, endX] of projector.projectRange(run.startM, run.endM)) {
      segments.push({ startX, endX, classIndex: run.classIndex });
    }
  }
  if (segments.length === 0) return null;

  const sampleEvery = Math.max(1, Math.round(HOVER_SAMPLE_STEP_M / profile.stepM));
  const sampleCount = Math.ceil(profile.intervalGrades.length / sampleEvery);
  const hoverXs = new Float64Array(sampleCount);
  const hoverGrades = new Float32Array(sampleCount);
  let written = 0;
  for (let k = 0; k < profile.intervalGrades.length; k += sampleEvery) {
    const x = projector.toX(profile.startM + (k + 0.5) * profile.stepM);
    if (!Number.isFinite(x)) continue;
    hoverXs[written] = x;
    hoverGrades[written] = profile.intervalGrades[k]!;
    written += 1;
  }

  const distributionM = summarizeSlopeDistribution(profile.runs);
  return {
    itineraryId: itinerary.id,
    segments,
    hoverXs: hoverXs.subarray(0, written),
    hoverGrades: hoverGrades.subarray(0, written),
    distributionM,
    totalM: distributionM.reduce((sum, value) => sum + value, 0),
  };
}

/** Classe affichée au point X (null hors tracé ou pendant une pause). */
export function slopeClassAtX(overlay: ChartSlopeOverlay, x: number): number | null {
  const { segments } = overlay;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid]!;
    if (x < segment.startX) hi = mid - 1;
    else if (x > segment.endX) lo = mid + 1;
    else return segment.classIndex;
  }
  return null;
}

/** Pente locale (%) au point X, ou null hors tronçon roulé. */
export function slopeGradeAtX(overlay: ChartSlopeOverlay, x: number): number | null {
  if (slopeClassAtX(overlay, x) === null) return null;
  const { hoverXs, hoverGrades } = overlay;
  if (hoverXs.length === 0) return null;
  let lo = 0;
  let hi = hoverXs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hoverXs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo > 0 ? lo - 1 : lo;
  const nearest = Math.abs(hoverXs[prev]! - x) < Math.abs(hoverXs[lo]! - x) ? prev : lo;
  return hoverGrades[nearest]!;
}
