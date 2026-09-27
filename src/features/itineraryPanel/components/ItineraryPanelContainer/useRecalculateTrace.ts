import { useCallback, useRef, useState } from 'react';
import type { Itinerary, ItineraryProject, TimelineItem } from '../../types';
import { resolveRouteRequest } from '../../hooks/useItineraryBrouterRouting/resolveRouteRequest';
import type { RouteRequestBase } from '../../hooks/useItineraryBrouterRouting/profileFallback';
import {
  buildStoredRoutePointsFromBrouter,
  toGeometryRoutePoints,
  applyBrouterSurfaceToRoutePoints,
  getRoutePointTotalDistanceM,
  roundRouteDistanceKm,
  projectTimelineLocationDistances,
} from '../../hooks/useItineraryBrouterRoutingShared';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
  refineRouteProfileWithIgnAltimetry,
} from '../../lib/route-metrics';
import { cleanGpxGlitches } from '../../lib/routes';
import { formatForbiddenZonePolygons, type BrouterRoute } from '../../lib/brouter';

type GpxRoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

/**
 * Extract ordered anchor points (start → waypoints → end) from the timeline.
 * These are the nodes between which BRouter will recalculate segments.
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

  // Waypoints in order
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

    // The last point of the previous segment and the first point of this
    // segment are the same anchor — skip the duplicate.
    const lastPoint = result[result.length - 1];
    const firstOfSegment = segment[0];
    const startIdx =
      lastPoint &&
      firstOfSegment &&
      Math.abs(lastPoint.lat - firstOfSegment.lat) < 0.0001 &&
      Math.abs(lastPoint.lon - firstOfSegment.lon) < 0.0001
        ? 1
        : 0;

    // Offset distances
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
  setProject: (updater: (project: ItineraryProject) => ItineraryProject) => void;
  /** Cancel any in-flight main routing request so it doesn't race with the recalculate result. */
  cancelRouteRequest: () => void;
  /** Tell the main routing effect to skip its next "full recompute" run. */
  skipNextRouteRecompute: () => void;
}

export function useRecalculateTrace({
  active,
  setProject,
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

    // Abort any previous run
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setProgress(0);

    const segmentCount = anchors.length - 1;
    const segments: GpxRoutePoint[][] = [];
    const segmentRoutes: BrouterRoute[] = [];
    const forbiddenPolygons = formatForbiddenZonePolygons(active.forbiddenZones);

    try {
      for (let i = 0; i < segmentCount; i++) {
        if (ctrl.signal.aborted) return;

        const start = anchors[i];
        const end = anchors[i + 1];

        console.log(
          `[Recalculate] segment ${i + 1}/${segmentCount}:`,
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
        });

        segmentRoutes.push(route);
        segments.push(buildRoutePointsFromBrouterRoute(route));
        setProgress((i + 1) / segmentCount);
      }

      if (ctrl.signal.aborted) return;

      // Concatenate all segments
      const mergedPoints = cleanGpxGlitches(concatenateSegments(segments));
      const elevationMetrics = computeRouteElevationMetrics(mergedPoints);
      const totalDistanceM = getRoutePointTotalDistanceM(mergedPoints);
      const distanceKm = roundRouteDistanceKm(totalDistanceM);

      // Aggregate surface metrics from all segments
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

      // Cancel any in-flight main routing request and prevent the routing
      // effect from re-triggering a full recompute when it sees the source
      // change from 'gpx' → 'brouter'.
      cancelRouteRequest();
      skipNextRouteRecompute();

      // Update project with recalculated route
      setProject((project) => {
        const itinerary = project.itineraries.find(
          (it) => it.id === project.activeItineraryId,
        );
        if (!itinerary) return project;

        const nextTimeline = projectTimelineLocationDistances(
          itinerary.timeline,
          mergedPoints,
          distanceKm,
        );

        return {
          ...project,
          itineraries: project.itineraries.map((current) =>
            current.id === project.activeItineraryId
              ? {
                  ...current,
                  visible: true,
                  gpxRoute: {
                    name: current.gpxRoute?.name ?? null,
                    points: mergedPoints,
                    originalPoints: mergedPoints,
                    gpxQuality: current.gpxRoute?.gpxQuality ?? 'default',
                    gpxQualityPointsPerKm: current.gpxRoute?.gpxQualityPointsPerKm ?? null,
                    source: 'brouter',
                  },
                  metrics: {
                    ...current.metrics,
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
                  },
                  timeline: nextTimeline,
                  routeAudit: undefined,
                  pendingRoutePatch: undefined,
                  pendingTraceExtension: undefined,
                }
              : current,
          ),
        };
      });

      console.log(
        `[Recalculate] ✔ done: ${segmentCount} segments, ${distanceKm} km total`,
      );

      // Background IGN altimetry refinement
      if (totalDistanceM <= 500_000) {
        try {
          // Combine all BRouter routes into a single virtual route for refinement
          const allCoords = segmentRoutes.flatMap((r) => r.coordinates);
          const virtualRoute: BrouterRoute = {
            coordinates: allCoords,
            distanceM: totalDistanceM,
            ascentM: elevationMetrics?.ascentM ?? 0,
            descentM: elevationMetrics?.descentM ?? 0,
            durationS: segmentRoutes.reduce((s, r) => s + r.durationS, 0),
            raw: { type: 'FeatureCollection', features: [] },
          };
          const refined = await refineRouteProfileWithIgnAltimetry(virtualRoute, ctrl.signal);
          if (refined && !ctrl.signal.aborted) {
            // Re-apply with IGN altimetry
            setProject((project) => {
              const itinerary = project.itineraries.find(
                (it) => it.id === project.activeItineraryId,
              );
              if (!itinerary) return project;
              return project; // Let the existing layer sync handle visual refresh
            });
          }
        } catch {
          // Non-critical, ignore
        }
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      console.error('[Recalculate] failed:', error);
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [active, setProject, cancelRouteRequest, skipNextRouteRecompute]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setProgress(null);
  }, []);

  return {
    recalculateLoading: loading,
    recalculateProgress: progress,
    showRecalculateTrace: showButton,
    handleRecalculateTrace: recalculate,
    cancelRecalculate: cancel,
  };
}
