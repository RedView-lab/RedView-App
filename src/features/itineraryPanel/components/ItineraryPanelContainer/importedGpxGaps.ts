/**
 * Discontinuités d'un GPX importé reliées par le réseau routable, jamais par
 * une ligne droite.
 *
 * Le fichier ne dit pas toujours le chemin suivi d'un point au suivant :
 *  - entre deux segments (`<trkseg>`) ou deux traces (`<trk>`) : pause GPS,
 *    étapes exportées séparément, morceaux dans le désordre ;
 *  - au milieu d'une trace, un saut sans commune mesure avec l'espacement des
 *    autres points (signal perdu, export tronqué) ;
 *  - une route (`<rtept>` seuls) aux points espacés : des points de passage à
 *    relier, comme le fait un GPS, pas un tracé.
 * Chacune est routée avec le profil par défaut d'un nouvel itinéraire (celui
 * que reçoit l'itinéraire importé) et recollée dans les points du fichier.
 * Une discontinuité que BRouter ne sait pas relier (hors carte, île…) reste
 * telle quelle et est signalée.
 */
import type { GpxRoute } from '@/features/poi/types';

import { resolveRouteRequest } from '../../hooks/useItineraryBrouterRouting/resolveRouteRequest';
import { createDefaultItinerary } from '../../lib/project';
import {
  ROUTE_SEAM_TOLERANCE_M,
  ROUTE_SNAP_TOLERANCE_M,
  haversineRouteDistanceM,
} from '../../lib/routes';

type GpxPoint = GpxRoute['points'][number];
type GpxGapInput = Pick<GpxRoute, 'points' | 'pointsKind' | 'segmentStarts'>;

/** Saut minimal, au milieu d'une trace, pour que le fichier ait perdu le chemin. */
const TRACK_JUMP_MIN_M = 1_000;
/** … et rapporté à l'espacement médian des points de la trace. */
const TRACK_JUMP_SPACING_FACTOR = 25;
/** Route (`<rtept>`) aux points plus espacés que ça : des points de passage à relier. */
const SPARSE_ROUTE_SPACING_M = 150;
/** Requêtes de raccord au plus par import (BRouter partagé). */
const MAX_BRIDGE_REQUESTS = 40;
/** Durée maximale des raccords : l'import ne reste jamais bloqué. */
const BRIDGE_TIMEOUT_MS = 90_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Indices `i` des pas (point `i` → point `i + 1`) que le fichier ne décrit
 * pas et qu'un raccord routé doit remplacer.
 */
export function findImportedGpxGaps(route: GpxGapInput): number[] {
  const { points } = route;
  if (points.length < 2) return [];
  const stepsM = points.slice(1).map((point, index) => haversineRouteDistanceM(points[index]!, point));
  const spacingM = median(stepsM);

  if (route.pointsKind === 'route' && spacingM > SPARSE_ROUTE_SPACING_M) {
    return stepsM.flatMap((stepM, index) => (stepM > ROUTE_SEAM_TOLERANCE_M ? [index] : []));
  }

  const gaps = new Set<number>();
  for (const start of route.segmentStarts ?? []) {
    if (start > 0 && start < points.length && stepsM[start - 1]! > ROUTE_SEAM_TOLERANCE_M) gaps.add(start - 1);
  }
  const jumpM = Math.max(TRACK_JUMP_MIN_M, spacingM * TRACK_JUMP_SPACING_FACTOR);
  stepsM.forEach((stepM, index) => {
    if (stepM > jumpM) gaps.add(index);
  });
  return [...gaps].sort((a, b) => a - b);
}

/** Pas consécutifs regroupés : `[first, last]` relie les points first … last + 1. */
function groupGapRuns(gaps: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const gap of gaps) {
    const run = runs[runs.length - 1];
    if (run && run[1] === gap - 1) run[1] = gap;
    else runs.push([gap, gap]);
  }
  return runs;
}

function withCumulativeDistances(points: GpxPoint[]): GpxPoint[] {
  let distanceM = 0;
  return points.map((point, index) => {
    if (index > 0) distanceM += haversineRouteDistanceM(points[index - 1]!, point);
    return { ...point, distanceM };
  });
}

export interface BridgedGpxRoute<T extends GpxGapInput> {
  route: T;
  /** Discontinuités reliées par le réseau routable. */
  bridged: number;
  /** Discontinuités laissées telles quelles (BRouter n'a pas su les relier). */
  unbridged: number;
}

/**
 * Relie les discontinuités du GPX (cf. findImportedGpxGaps) par des tronçons
 * routés. Les points du fichier sont gardés tels quels ; seuls les pas
 * manquants sont remplacés.
 */
export async function bridgeImportedGpxGaps<T extends GpxGapInput>(route: T): Promise<BridgedGpxRoute<T>> {
  const runs = groupGapRuns(findImportedGpxGaps(route));
  if (runs.length === 0) return { route, bridged: 0, unbridged: 0 };

  const itinerary = createDefaultItinerary();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
  const { points } = route;
  const pieces = new Map<number, GpxPoint[]>();
  let bridged = 0;
  let unbridged = 0;

  try {
    for (const [runIndex, [first, last]] of runs.entries()) {
      const gapCount = last - first + 1;
      if (runIndex >= MAX_BRIDGE_REQUESTS || ctrl.signal.aborted) {
        unbridged += gapCount;
        continue;
      }
      const start = points[first]!;
      const end = points[last + 1]!;
      try {
        const { route: routed } = await resolveRouteRequest({
          itinerary,
          signal: ctrl.signal,
          requestBase: {
            start: { lat: start.lat, lon: start.lon },
            end: { lat: end.lat, lon: end.lon },
            via: points.slice(first + 1, last + 1).map((point) => ({ lat: point.lat, lon: point.lon })),
            signal: ctrl.signal,
          },
          setRouteWarnings: () => {},
        });
        const piece: GpxPoint[] = routed.coordinates.map((coordinate) => {
          const elevationM = (coordinate as [number, number, number?])[2];
          return {
            lat: coordinate[1],
            lon: coordinate[0],
            elevationM: Number.isFinite(elevationM) ? (elevationM as number) : null,
          };
        });
        const joins = piece.length >= 2
          && haversineRouteDistanceM(start, piece[0]!) <= ROUTE_SNAP_TOLERANCE_M
          && haversineRouteDistanceM(end, piece[piece.length - 1]!) <= ROUTE_SNAP_TOLERANCE_M;
        if (!joins) {
          unbridged += gapCount;
          continue;
        }
        pieces.set(first, piece);
        bridged += gapCount;
      } catch (error) {
        if (!ctrl.signal.aborted) console.warn('[gpx-import] gap could not be routed', { first, last }, error);
        unbridged += gapCount;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (pieces.size === 0) return { route, bridged, unbridged };
  const lastByFirst = new Map(runs.map(([first, last]) => [first, last]));
  const out: GpxPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    out.push(points[index]!);
    const piece = pieces.get(index);
    if (!piece) continue;
    // Le raccord remplace les pas manquants : ses extrémités accrochent les
    // points du fichier, ses points intermédiaires du fichier sont des via.
    out.push(...piece);
    index = lastByFirst.get(index)!;
  }
  return {
    route: { ...route, points: withCumulativeDistances(out), segmentStarts: [] },
    bridged,
    unbridged,
  };
}
