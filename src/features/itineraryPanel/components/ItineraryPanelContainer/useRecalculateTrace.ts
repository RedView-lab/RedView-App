import { useCallback, useEffect, useRef, useState } from 'react';
import type { Itinerary, ItineraryProject, TimelineItem } from '../../types';
import { resolveRouteRequest } from '../../hooks/useItineraryBrouterRouting/resolveRouteRequest';
import type { RouteRequestBase } from '../../hooks/useItineraryBrouterRouting/customProfileFetch';
import {
  buildStoredRoutePointsFromBrouter,
  toGeometryRoutePoints,
  applyBrouterSurfaceToRoutePoints,
  getRoutePointTotalDistanceM,
  roundRouteDistanceKm,
  projectTimelineLocationDistances,
  routePointsEqual,
} from '../../hooks/useItineraryBrouterRoutingShared';
import { getRoutingInputsSignature } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
} from '../../lib/route-metrics';
import {
  RouteSeamError,
  cleanGpxGlitches,
  haversineRouteDistanceM,
  routeSeamJoins,
} from '../../lib/routes';
import { formatForbiddenZonePolygons, type BrouterRoute } from '../../lib/brouter';
import { logger } from '@/shared/lib/logger';

type GpxRoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

/**
 * Extrait les points d'ancrage ordonnés (départ → étapes → arrivée) de la timeline.
 * Ce sont les nœuds entre lesquels BRouter recalculera les segments.
 */
function getTimelineAnchors(
  timeline: TimelineItem[],
): { lat: number; lon: number }[] {
  const anchors: { lat: number; lon: number }[] = [];

  // Start
  const start = timeline.find((r) => r.kind === 'start');
  if (start?.lat != null && start?.lon != null) {
    anchors.push({ lat: start.lat, lon: start.lon });
  }

  // Étapes dans l'ordre
  for (const item of timeline) {
    if (item.kind === 'waypoint' && item.lat != null && item.lon != null) {
      anchors.push({ lat: item.lat, lon: item.lon });
    }
  }

  // End
  const end = timeline.find((r) => r.kind === 'end');
  if (end?.lat != null && end?.lon != null) {
    anchors.push({ lat: end.lat, lon: end.lon });
  }

  return anchors;
}

/**
 * Tracé actuel entre chaque paire d'ancres consécutives ([lon, lat]), pour
 * servir de tracé de référence aux longs tronçons (ancres prises dessus).
 */
function sliceTrackBetweenAnchors(
  routePoints: GpxRoutePoint[],
  anchors: { lat: number; lon: number }[],
): [number, number][][] {
  const indices = [0];
  for (let a = 1; a < anchors.length - 1; a += 1) {
    const anchor = anchors[a]!;
    const kx = Math.cos((anchor.lat * Math.PI) / 180);
    let best = indices[a - 1]!;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let i = indices[a - 1]!; i < routePoints.length; i += 1) {
      const dLon = (routePoints[i]!.lon - anchor.lon) * kx;
      const dLat = routePoints[i]!.lat - anchor.lat;
      const d2 = dLon * dLon + dLat * dLat;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    indices.push(best);
  }
  indices.push(routePoints.length - 1);
  return indices.slice(1).map((to, i) =>
    routePoints.slice(indices[i]!, to + 1).map((point): [number, number] => [point.lon, point.lat]),
  );
}

/** Tronçons calculés en parallèle (BRouter de prod : 4 threads). */
const RECALCULATE_CONCURRENCY = 2;

function buildRoutePointsFromBrouterRoute(
  route: BrouterRoute,
): GpxRoutePoint[] {
  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = extractRouteProfileFromBrouter(route);
  const routePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  return applyBrouterSurfaceToRoutePoints(route, routePoints);
}

function concatenateSegments(
  segments: GpxRoutePoint[][],
): GpxRoutePoint[] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return segments[0];

  const result: GpxRoutePoint[] = [...segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.length === 0) continue;

    // Le dernier point du segment précédent et le premier point de ce segment
    // sont la même ancre — sauter le doublon. Des segments qui ne s'y rejoignent
    // pas seraient reliés par une ligne droite : le recalcul échoue.
    const lastPoint = result[result.length - 1];
    const firstOfSegment = segment[0];
    if (lastPoint && firstOfSegment && !routeSeamJoins(lastPoint, firstOfSegment)) {
      throw new RouteSeamError(`recalculated segment ${i}`, haversineRouteDistanceM(lastPoint, firstOfSegment));
    }
    const startIdx =
      lastPoint &&
      firstOfSegment &&
      Math.abs(lastPoint.lat - firstOfSegment.lat) < 0.0001 &&
      Math.abs(lastPoint.lon - firstOfSegment.lon) < 0.0001
        ? 1
        : 0;

    // Décaler les distances
    const baseDistanceM = lastPoint?.distanceM ?? 0;
    const segmentBaseM = segment[startIdx]?.distanceM ?? 0;

    for (let j = startIdx; j < segment.length; j++) {
      const point = segment[j];
      result.push({
        ...point,
        distanceM: baseDistanceM + (point.distanceM ?? 0) - segmentBaseM,
      });
    }
  }

  return result;
}

interface UseRecalculateTraceArgs {
  active: Itinerary | null;
  /** Mutation historisée du ProjectStore : le recalcul est annulable. */
  commitTraceMutation: (
    itineraryId: string,
    mutate: (draft: ItineraryProject) => boolean | void,
  ) => boolean;
  /** Révision d'historique : un undo/redo abandonne le recalcul en cours. */
  historyRevision: number;
  /** Annule toute requête de routage principale en cours pour qu'elle n'entre pas en concurrence avec le résultat du recalcul. */
  cancelRouteRequest: () => void;
  /** Indique à l'effet de routage principal de sauter son prochain « recalcul complet ». */
  skipNextRouteRecompute: () => void;
}

export function useRecalculateTrace({
  active,
  commitTraceMutation,
  historyRevision,
  cancelRouteRequest,
  skipNextRouteRecompute,
}: UseRecalculateTraceArgs) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const showButton = Boolean(
    active &&
      active.gpxRoute &&
      active.timeline.some((item) => item.kind === 'waypoint' && item.lat != null),
  );

  const recalculate = useCallback(async () => {
    if (!active || !active.gpxRoute) return;

    const anchors = getTimelineAnchors(active.timeline);
    if (anchors.length < 2) {
      console.warn('[Recalculate] need at least 2 anchors (start + end)');
      return;
    }

    // Abandonner toute exécution précédente
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setProgress(0);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading: true } }));
    }

    // Le résultat ne s'applique qu'à l'itinéraire et au tracé de départ :
    // s'ils ont changé entre-temps (undo, autre édition), il est périmé.
    const targetId = active.id;
    const sourceRoutePoints = active.gpxRoute.points;
    const segmentCount = anchors.length - 1;
    const segments: GpxRoutePoint[][] = new Array(segmentCount);
    const segmentRoutes: BrouterRoute[] = new Array(segmentCount);
    const forbiddenPolygons = formatForbiddenZonePolygons(active.forbiddenZones);
    // Un GPX est l'intention de l'utilisateur : les ancres des longs tronçons
    // y sont prises directement, au lieu d'un tracé grossier.
    const referenceTracks = active.gpxRoute.source === 'gpx'
      ? sliceTrackBetweenAnchors(sourceRoutePoints, anchors)
      : null;

    const routeSegment = async (i: number) => {
      const start = anchors[i];
      const end = anchors[i + 1];

      logger.brouter.info(
        `recalculate: segment ${i + 1}/${segmentCount}:`,
        `${start.lon.toFixed(4)},${start.lat.toFixed(4)}`,
        '→',
        `${end.lon.toFixed(4)},${end.lat.toFixed(4)}`,
      );

      const requestBase: RouteRequestBase = {
        start,
        end,
        via: [],
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      const { route } = await resolveRouteRequest({
        itinerary: active,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings: () => {},
        referenceTrack: referenceTracks?.[i],
      });

      segmentRoutes[i] = route;
      segments[i] = buildRoutePointsFromBrouterRoute(route);
    };

    try {
      let nextSegment = 0;
      let doneSegments = 0;
      // Un tronçon en échec arrête l'autre file : le recalcul est abandonné.
      let failed = false;
      await Promise.all(
        Array.from({ length: Math.min(RECALCULATE_CONCURRENCY, segmentCount) }, async () => {
          while (nextSegment < segmentCount && !failed && !ctrl.signal.aborted) {
            const i = nextSegment;
            nextSegment += 1;
            try {
              await routeSegment(i);
            } catch (error) {
              failed = true;
              throw error;
            }
            doneSegments += 1;
            setProgress(doneSegments / segmentCount);
          }
        }),
      );

      if (ctrl.signal.aborted) return;

      // Concaténer tous les segments
      const mergedPoints = cleanGpxGlitches(concatenateSegments(segments));
      const elevationMetrics = computeRouteElevationMetrics(mergedPoints);
      const totalDistanceM = getRoutePointTotalDistanceM(mergedPoints);
      const distanceKm = roundRouteDistanceKm(totalDistanceM);

      // Agréger les métriques de surface de tous les segments
      let totalTarmacWeighted = 0;
      let totalOffroadWeighted = 0;
      let totalWeightM = 0;
      for (const route of segmentRoutes) {
        const sm = computeRouteSurfaceMetricsFromBrouter(route);
        if (sm && route.distanceM > 0) {
          totalTarmacWeighted += sm.tarmacPercent * route.distanceM;
          totalOffroadWeighted += sm.offroadPercent * route.distanceM;
          totalWeightM += route.distanceM;
        }
      }
      const tarmacPercent = totalWeightM > 0 ? Math.round(totalTarmacWeighted / totalWeightM) : undefined;
      const offroadPercent = totalWeightM > 0 ? Math.round(totalOffroadWeighted / totalWeightM) : undefined;

      // Annuler toute requête de routage principale en cours pour qu'elle ne
      // puisse pas entrer en concurrence avec le résultat recalculé.
      cancelRouteRequest();

      // Met à jour le projet avec le tracé recalculé (historisé → annulable)
      const applied = commitTraceMutation(targetId, (draft) => {
        const itinerary = draft.itineraries.find((it) => it.id === targetId);
        if (!itinerary || !routePointsEqual(itinerary.gpxRoute?.points, sourceRoutePoints)) {
          return false;
        }

        itinerary.visible = true;
        itinerary.gpxRoute = {
          name: itinerary.gpxRoute?.name ?? null,
          points: mergedPoints,
          originalPoints: mergedPoints,
          gpxQuality: itinerary.gpxRoute?.gpxQuality ?? 'default',
          gpxQualityPointsPerKm: itinerary.gpxRoute?.gpxQualityPointsPerKm ?? null,
          source: 'brouter',
          routedInputsKey: getRoutingInputsSignature(itinerary),
        };
        itinerary.metrics = {
          ...itinerary.metrics,
          distanceKm,
          ascentM: elevationMetrics
            ? Math.max(0, Math.round(elevationMetrics.ascentM))
            : undefined,
          descentM: elevationMetrics
            ? Math.max(0, Math.round(elevationMetrics.descentM))
            : undefined,
          avgSlopePercent: elevationMetrics
            ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
            : undefined,
          tarmacPercent,
          offroadPercent,
        };
        itinerary.timeline = projectTimelineLocationDistances(
          itinerary.timeline,
          mergedPoints,
          distanceKm,
        );
        itinerary.routeAudit = undefined;
        itinerary.pendingRoutePatch = undefined;
        itinerary.pendingTraceExtension = undefined;
      });
      if (!applied) {
        console.warn('[Recalculate] itinerary changed during recalculation — result discarded');
        return;
      }
      // La source peut passer de 'gpx' à 'brouter' : empêcher l'effet de routage
      // d'écraser le résultat par un unique recalcul de bout en bout.
      skipNextRouteRecompute();

      logger.brouter.info(
        `recalculate ✔ done: ${segmentCount} segments, ${distanceKm} km total`,
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      console.error('[Recalculate] failed:', error);
    } finally {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading: false } }));
      }
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [active, commitTraceMutation, cancelRouteRequest, skipNextRouteRecompute]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setProgress(null);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading: false } }));
    }
  }, []);

  // Undo / redo pendant un recalcul : l'état restauré fait foi, on abandonne.
  const seenHistoryRevisionRef = useRef(historyRevision);
  useEffect(() => {
    if (seenHistoryRevisionRef.current === historyRevision) return;
    seenHistoryRevisionRef.current = historyRevision;
    if (abortRef.current) cancel();
  }, [cancel, historyRevision]);

  return {
    recalculateLoading: loading,
    recalculateProgress: progress,
    showRecalculateTrace: showButton,
    handleRecalculateTrace: recalculate,
    cancelRecalculate: cancel,
  };
}
