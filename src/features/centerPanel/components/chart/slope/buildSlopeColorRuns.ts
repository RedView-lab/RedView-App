import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { AxisMode, RouteChartPoint } from '../seriesCommon';
import { resampleRouteElevations } from '../series/routeProfile';
import { buildItineraryXProjector } from '../series/itineraryXProjector';
import { classifyGradientPct, SLOPE_COLOR_CLASSES } from './slopeScale';

/** Pas de ré-échantillonnage du profil (m). */
const SAMPLE_STEP_M = 10;
/** Lissage de l'altitude (5 × 10 m ≈ 50 m) : gomme le bruit du MNT. */
const SMOOTH_WINDOW_SAMPLES = 5;
/**
 * Niveaux de détail, du plus fin au plus grossier. Le profil est simplifié
 * (Douglas-Peucker, écart vertical `toleranceM`), puis aucun tronçon ne reste
 * plus court que `minLengthM` : chaque tronçon porte la pente moyenne de sa
 * corde, comme les paliers d'un profil de col. Vue d'ensemble = grands blocs
 * moyennés ; en zoomant, le graphe descend vers le niveau fin.
 */
const SLOPE_DETAIL_LEVELS: ReadonlyArray<{ minLengthM: number; toleranceM: number }> = [
  { minLengthM: 250, toleranceM: 4 },
  { minLengthM: 500, toleranceM: 6 },
  { minLengthM: 1000, toleranceM: 9 },
  { minLengthM: 2000, toleranceM: 13 },
  { minLengthM: 4000, toleranceM: 19 },
  { minLengthM: 8000, toleranceM: 27 },
  { minLengthM: 16000, toleranceM: 38 },
];
/** Largeur minimale visée d'un tronçon à l'écran (px) : fixe le niveau de détail. */
const MIN_SEGMENT_PX = 6;

export interface SlopeRun {
  startM: number;
  endM: number;
  classIndex: number;
  /** Pente moyenne du tronçon (%). */
  avgPct: number;
}

export interface SlopeProfileLevel {
  /** Longueur minimale d'un tronçon à ce niveau (m). */
  minLengthM: number;
  runs: SlopeRun[];
}

export interface SlopeProfile {
  /** Niveaux de détail, du plus fin au plus grossier. */
  levels: SlopeProfileLevel[];
}

const slopeProfileCache = new WeakMap<object, SlopeProfile | null>();

/**
 * Découpe le tracé en tronçons de pente moyenne homogène, à chaque niveau de
 * détail. Résultat mis en cache par tableau de points (immutable).
 */
export function detectSlopeProfile(
  routePoints: RouteChartPoint[] | null | undefined,
): SlopeProfile | null {
  if (!routePoints || routePoints.length < 2) return null;
  const cached = slopeProfileCache.get(routePoints);
  if (cached !== undefined) return cached;

  const resampled = resampleRouteElevations(routePoints, SAMPLE_STEP_M, SMOOTH_WINDOW_SAMPLES);
  const result = resampled && resampled.elevations.length >= 2
    ? {
        levels: SLOPE_DETAIL_LEVELS.map(({ minLengthM, toleranceM }) => ({
          minLengthM,
          runs: buildLevelRuns(resampled.startM, resampled.elevations, toleranceM, minLengthM),
        })),
      }
    : null;
  slopeProfileCache.set(routePoints, result);
  return result;
}

function gradePct(elev: Float64Array, start: number, end: number): number {
  return ((elev[end]! - elev[start]!) / ((end - start) * SAMPLE_STEP_M)) * 100;
}

function buildLevelRuns(
  startM: number,
  elev: Float64Array,
  toleranceM: number,
  minLengthM: number,
): SlopeRun[] {
  const vertices = simplifyProfile(elev, toleranceM);
  const spans = mergeShortSpans(elev, vertices, Math.max(1, Math.round(minLengthM / SAMPLE_STEP_M)));

  // Tronçons voisins de même classe recollés : la moyenne pondérée reste dans la classe.
  const merged: Array<{ start: number; end: number; classIndex: number }> = [];
  for (const [start, end] of spans) {
    const classIndex = classifyGradientPct(gradePct(elev, start, end));
    const last = merged[merged.length - 1];
    if (last && last.classIndex === classIndex) last.end = end;
    else merged.push({ start, end, classIndex });
  }

  return merged.map(({ start, end, classIndex }) => ({
    startM: startM + start * SAMPLE_STEP_M,
    endM: startM + end * SAMPLE_STEP_M,
    classIndex,
    avgPct: gradePct(elev, start, end),
  }));
}

/**
 * Douglas-Peucker sur (distance, altitude) avec un écart vertical : renvoie les
 * indices conservés (extrémités incluses), triés.
 */
function simplifyProfile(elev: Float64Array, toleranceM: number): number[] {
  const last = elev.length - 1;
  const keep = new Uint8Array(elev.length);
  keep[0] = 1;
  keep[last] = 1;
  const stack: number[] = [0, last];
  while (stack.length > 0) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    if (b - a < 2) continue;
    const za = elev[a]!;
    const slope = (elev[b]! - za) / (b - a);
    let worst = -1;
    let worstDeviation = toleranceM;
    for (let i = a + 1; i < b; i += 1) {
      const deviation = Math.abs(elev[i]! - (za + slope * (i - a)));
      if (deviation > worstDeviation) {
        worstDeviation = deviation;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(a, worst, worst, b);
  }
  const vertices: number[] = [];
  for (let i = 0; i <= last; i += 1) {
    if (keep[i]) vertices.push(i);
  }
  return vertices;
}

/**
 * Fusionne, du plus court au plus long, chaque tronçon de moins de `minSteps`
 * échantillons dans le voisin de pente la plus proche (à égalité, le plus
 * long). La pente du tronçon fusionné est recalculée : c'est une moyenne.
 */
function mergeShortSpans(
  elev: Float64Array,
  vertices: number[],
  minSteps: number,
): Array<[number, number]> {
  const count = vertices.length - 1;
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  const prev = new Int32Array(count);
  const next = new Int32Array(count);
  const alive = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    starts[i] = vertices[i]!;
    ends[i] = vertices[i + 1]!;
    prev[i] = i - 1;
    next[i] = i + 1 < count ? i + 1 : -1;
    alive[i] = 1;
  }
  const lengthOf = (id: number) => ends[id]! - starts[id]!;
  const gradeOf = (id: number) => gradePct(elev, starts[id]!, ends[id]!);

  // Tas binaire (longueur, id) ; une entrée est périmée si la longueur a changé.
  const heapKeys: number[] = [];
  const heapIds: number[] = [];
  const push = (key: number, id: number) => {
    let i = heapKeys.length;
    heapKeys.push(key);
    heapIds.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKeys[parent]! <= key) break;
      heapKeys[i] = heapKeys[parent]!;
      heapIds[i] = heapIds[parent]!;
      i = parent;
    }
    heapKeys[i] = key;
    heapIds[i] = id;
  };
  const pop = () => {
    const top = { key: heapKeys[0]!, id: heapIds[0]! };
    const lastKey = heapKeys.pop()!;
    const lastId = heapIds.pop()!;
    const size = heapKeys.length;
    if (size > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && heapKeys[child + 1]! < heapKeys[child]!) child += 1;
        if (heapKeys[child]! >= lastKey) break;
        heapKeys[i] = heapKeys[child]!;
        heapIds[i] = heapIds[child]!;
        i = child;
      }
      heapKeys[i] = lastKey;
      heapIds[i] = lastId;
    }
    return top;
  };

  for (let id = 0; id < count; id += 1) {
    if (lengthOf(id) < minSteps) push(lengthOf(id), id);
  }

  while (heapKeys.length > 0) {
    const { key, id } = pop();
    if (!alive[id] || lengthOf(id) !== key) continue;
    const before = prev[id]!;
    const after = next[id]!;
    if (before < 0 && after < 0) break;
    let target: number;
    if (before >= 0 && after >= 0) {
      const grade = gradeOf(id);
      const beforeDelta = Math.abs(gradeOf(before) - grade);
      const afterDelta = Math.abs(gradeOf(after) - grade);
      target = beforeDelta < afterDelta
        ? before
        : afterDelta < beforeDelta
          ? after
          : lengthOf(before) >= lengthOf(after) ? before : after;
    } else {
      target = before >= 0 ? before : after;
    }
    if (target === before) {
      ends[before] = ends[id]!;
      next[before] = after;
      if (after >= 0) prev[after] = before;
    } else {
      starts[after] = starts[id]!;
      prev[after] = before;
      if (before >= 0) next[before] = after;
    }
    alive[id] = 0;
    if (lengthOf(target) < minSteps) push(lengthOf(target), target);
  }

  const spans: Array<[number, number]> = [];
  let id = 0;
  while (id >= 0 && !alive[id]) id += 1;
  for (; id >= 0 && id < count; id = next[id]!) spans.push([starts[id]!, ends[id]!]);
  return spans;
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
  /** Pente moyenne du tronçon (%). */
  avgPct: number;
  /** Longueur du tronçon sur le tracé (m), pauses exclues. */
  lengthM: number;
}

export interface ChartSlopeLevel {
  minLengthM: number;
  /** Tronçons projetés sur l'axe X, triés ; les pauses (modes temps) n'en font pas partie. */
  segments: ChartSlopeSegment[];
}

export interface ChartSlopeOverlay {
  itineraryId: string;
  /** Niveaux de détail, du plus fin au plus grossier (voir `pickSlopeLevel`). */
  levels: ChartSlopeLevel[];
  /** Mètres de tracé par unité X (approx. en mode temps), pour choisir le niveau. */
  metersPerXUnit: number;
  /** Distance (m) par classe sur tout l'itinéraire, au niveau le plus fin. */
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
  const finest = profile?.levels[0];
  if (!profile || !finest || finest.runs.length === 0) return null;
  const projector = buildItineraryXProjector(itinerary, prediction, xMode, xOffset);
  if (!projector) return null;

  const levels: ChartSlopeLevel[] = profile.levels.map(({ minLengthM, runs }) => {
    const segments: ChartSlopeSegment[] = [];
    for (const run of runs) {
      const lengthM = run.endM - run.startM;
      for (const [startX, endX] of projector.projectRange(run.startM, run.endM)) {
        segments.push({ startX, endX, classIndex: run.classIndex, avgPct: run.avgPct, lengthM });
      }
    }
    return { minLengthM, segments };
  });
  if (levels[0]!.segments.length === 0) return null;

  const routeStartM = finest.runs[0]!.startM;
  const routeEndM = finest.runs[finest.runs.length - 1]!.endM;
  const xSpan = projector.toX(routeEndM) - projector.toX(routeStartM);
  const distributionM = summarizeSlopeDistribution(finest.runs);
  return {
    itineraryId: itinerary.id,
    levels,
    metersPerXUnit: Number.isFinite(xSpan) && xSpan > 0 ? (routeEndM - routeStartM) / xSpan : 1000,
    distributionM,
    totalM: distributionM.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Niveau de détail adapté au zoom : le plus fin dont les tronçons font au
 * moins `MIN_SEGMENT_PX` à l'écran (sinon le plus grossier).
 */
export function pickSlopeLevel(
  overlay: ChartSlopeOverlay,
  xDomain: { min: number; max: number },
  widthPx: number,
): ChartSlopeLevel | null {
  const { levels } = overlay;
  if (levels.length === 0) return null;
  const span = xDomain.max - xDomain.min;
  if (!(span > 0) || !(widthPx > 0)) return levels[levels.length - 1]!;
  const wantedM = ((overlay.metersPerXUnit * span) / widthPx) * MIN_SEGMENT_PX;
  return levels.find((level) => level.minLengthM >= wantedM) ?? levels[levels.length - 1]!;
}

/** Tronçon affiché au point X (null hors tracé ou pendant une pause). */
export function slopeSegmentAtX(
  segments: ReadonlyArray<ChartSlopeSegment>,
  x: number,
): ChartSlopeSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid]!;
    if (x < segment.startX) hi = mid - 1;
    else if (x > segment.endX) lo = mid + 1;
    else return segment;
  }
  return null;
}
