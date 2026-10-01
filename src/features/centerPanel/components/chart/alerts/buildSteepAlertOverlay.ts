import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary, SteepAlertKind } from '@/features/itineraryPanel/types';
import type { AxisMode, RouteChartPoint } from '../seriesCommon';
import { resampleRouteElevations } from '../series/routeProfile';
import { locateRoutePointAtX } from '../series/builders';
import { buildItineraryXProjector } from '../series/itineraryXProjector';

export interface SteepAlertRule {
  /** Pente moyenne minimale (%) tenue sur toute la fenêtre. */
  minGradientPct: number;
  /** Longueur minimale de la fenêtre (m). */
  minLengthM: number;
}

/**
 * Seuils d'alerte (un seul suffit). Volontairement stricts : une alerte doit
 * signaler un vrai obstacle, pas chaque raidillon (la colorisation « Pente »
 * du graphe montre le détail) :
 *  - pente moyenne ≥ 12 % tenue sur au moins 500 m ;
 *  - « mur » : pente moyenne ≥ 18 % tenue sur au moins 200 m.
 */
export const STEEP_ALERT_RULES: ReadonlyArray<SteepAlertRule> = [
  { minGradientPct: 12, minLengthM: 500 },
  { minGradientPct: 18, minLengthM: 200 },
];

/** Pas de ré-échantillonnage du profil (m). */
const SAMPLE_STEP_M = 10;
/** Lissage de l'altitude avant détection (5 × 10 m ≈ 50 m) : ignore le bruit du MNT. */
const SMOOTH_WINDOW_SAMPLES = 5;
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
 * ré-échantillonné et lissé ; toutes les fenêtres au-dessus du seuil sont unies en
 * segments continus (puis fusionnés s'ils sont séparés de ≤ MERGE_GAP_M),
 * dont les bords plats sont rognés.
 */
export function detectSteepAlertSegments(
  routePoints: RouteChartPoint[] | null | undefined,
): SteepAlertSegment[] {
  if (!routePoints || routePoints.length < 2) return [];
  const cached = segmentsCache.get(routePoints);
  if (cached) return cached;

  const resampled = resampleRouteElevations(routePoints, SAMPLE_STEP_M, SMOOTH_WINDOW_SAMPLES);
  const result = resampled ? detectSegmentsOnResampledProfile(resampled.startM, resampled.elevations) : [];
  segmentsCache.set(routePoints, result);
  return result;
}

function detectSegmentsOnResampledProfile(startM: number, elev: Float64Array): SteepAlertSegment[] {
  const result: SteepAlertSegment[] = [];
  const count = elev.length;

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
  // Une fenêtre qualifiante peut déborder sur le plat avant/après la montée :
  // on rogne les bords tant que le pas local est franchement plus doux
  // (< moitié du seuil le plus bas), sans toucher aux épaulements de la montée.
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
  const projector = buildItineraryXProjector(itinerary, prediction, xMode, xOffset);
  if (!projector) return [];
  const { toX } = projector;

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
