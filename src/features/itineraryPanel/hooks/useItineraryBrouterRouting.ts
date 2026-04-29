import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildBrfProfile,
  checkRouteWithinFrance,
  fetchBrouterRoute,
  fetchBrouterRouteBestOfN,
  formatForbiddenZonePolygons,
  hashBrf,
  isClimbingMode,
  resolveItineraryRouting,
  type BrouterRoute,
  type ResolvedRouting,
} from '../lib/brouter';
import {
  fitToRoute,
  hasRouteLayer,
  removeRouteLayer,
} from '../lib/route-layer';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
} from '../lib/route-metrics';
import { analyzeBrouterRoute } from '../lib/routeAudit/analyzeBrouterRoute';
import type { Itinerary } from '../types';
import {
  appendRoutePoints,
  buildStoredRoutePointsFromBrouter,
  getRoutePointTotalDistanceM,
  isBrouterUnmappedPointError,
  mergeSurfaceMetrics,
  projectTimelineLocationDistances,
  recomputeApproxSurfaceMetrics,
  replaceRouteSegment,
  roundRouteDistanceKm,
  routeAuditEqual,
  routePointsEqual,
  toGeometryRoutePoints,
  toStoredRoutePoints,
  type UseItineraryBrouterRoutingArgs,
} from './useItineraryBrouterRoutingShared';

export function useItineraryBrouterRouting({
  active,
  isMapLoaded,
  map,
  rollbackPendingTraceAppend,
  setProject,
}: UseItineraryBrouterRoutingArgs) {
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  const routeAbortRef = useRef<AbortController | null>(null);
  const cancelRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    setRouteLoading(false);
  }, []);

  const startKey = (() => {
    const row = active?.timeline.find((item) => item.kind === 'start');
    return row && row.lat != null && row.lon != null ? `${row.lon},${row.lat}` : '';
  })();

  const endKey = (() => {
    const row = active?.timeline.find((item) => item.kind === 'end');
    return row && row.lat != null && row.lon != null ? `${row.lon},${row.lat}` : '';
  })();

  const viaKey = active
    ? active.timeline
        .filter((item) => item.kind === 'waypoint' && item.lat != null && item.lon != null)
        .map((item) => `${item.lon},${item.lat}`)
        .join('|')
    : '';
  const hasWaypointOverride = viaKey.length > 0;
  const profileId = active?.profileId ?? 'gravel-default';
  const climbing = active ? isClimbingMode(active.priorities) : false;
  const prioritiesJson = active ? JSON.stringify(active.priorities) : '';
  const roadTypesJson = active ? JSON.stringify(active.roadTypes) : '';
  const expertJson = active ? JSON.stringify(active.expertProfile) : '';
  const forbiddenPolygons = formatForbiddenZonePolygons(active?.forbiddenZones);

  const brfHash = useMemo(() => {
    if (!active) return '';
    try {
      const brf = buildBrfProfile({
        priorities: active.priorities,
        roadTypes: active.roadTypes,
        expert: active.expertProfile,
      });
      const hash = hashBrf(brf);
      console.log(
        '[BRouter] BRF hash =',
        hash,
        '| size =',
        brf.length,
        'B | profile =',
        active.profileId,
        '| priorities =',
        active.priorities,
      );
      return hash;
    } catch (error) {
      console.warn('[BRouter] buildBrfProfile threw:', error);
      return '';
    }
  }, [active, expertJson, prioritiesJson, roadTypesJson]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const pendingRoutePatch = active?.pendingRoutePatch;
    const pendingTraceExtension = active?.pendingTraceExtension;
    const existingBrouterPoints = active?.gpxRoute?.source === 'brouter'
      ? active.gpxRoute.points
      : null;

    if (
      active &&
      pendingRoutePatch &&
      existingBrouterPoints &&
      existingBrouterPoints.length >= 2
    ) {
      const patchPoints = [
        pendingRoutePatch.start,
        ...pendingRoutePatch.via,
        pendingRoutePatch.end,
      ];
      const bounds = checkRouteWithinFrance(patchPoints);
      if (!bounds.ok) {
        setRouteError(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        setRouteLoading(false);
        return;
      }

      routeAbortRef.current?.abort();
      const ctrl = new AbortController();
      routeAbortRef.current = ctrl;
      setRouteLoading(true);
      setRouteError(null);

      const itineraryForRouting = active;
      const t0 = performance.now();
      console.log(
        '[BRouter] local patch START hash=',
        brfHash,
        'climbing=',
        climbing,
        'start=',
        `${pendingRoutePatch.start.lon},${pendingRoutePatch.start.lat}`,
        'end=',
        `${pendingRoutePatch.end.lon},${pendingRoutePatch.end.lat}`,
        'via=',
        pendingRoutePatch.via.length,
      );

      resolveItineraryRouting(itineraryForRouting, ctrl.signal)
        .then((resolved: ResolvedRouting) => {
          if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');
          setRouteWarnings(resolved.roadTypes.warnings);
          const reqBase = {
            start: pendingRoutePatch.start,
            end: pendingRoutePatch.end,
            via: pendingRoutePatch.via,
            polygons: forbiddenPolygons,
            profile: resolved.profileId,
            signal: ctrl.signal,
          };
          return climbing
            ? fetchBrouterRouteBestOfN(reqBase, 4)
            : fetchBrouterRoute(reqBase);
        })
        .then((route: BrouterRoute) => {
          if (ctrl.signal.aborted) return;
          console.log(
            '[BRouter] local patch OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );

          const geometryPoints = toGeometryRoutePoints(route.coordinates);
          const routeProfile = extractRouteProfileFromBrouter(route);
          const patchRoutePoints = buildStoredRoutePointsFromBrouter(
            geometryPoints,
            routeProfile,
            route.distanceM,
          );
          const patchSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);

          setProject((project) => {
            const itinerary = project.itineraries.find(
              (item) => item.id === project.activeItineraryId,
            );
            if (!itinerary || !itinerary.pendingRoutePatch) return project;

            const basePoints = itinerary.gpxRoute?.points ?? [];
            if (basePoints.length < 2) return project;

            const mergedRoutePoints = replaceRouteSegment(
              basePoints,
              itinerary.pendingRoutePatch,
              patchRoutePoints,
            );
            const elevationMetrics = computeRouteElevationMetrics(mergedRoutePoints);
            const distanceM = getRoutePointTotalDistanceM(mergedRoutePoints);
            const distanceKm = roundRouteDistanceKm(distanceM);
            const nextTimeline = projectTimelineLocationDistances(
              itinerary.timeline,
              mergedRoutePoints,
              distanceKm,
            );
            const surfaceMetrics = recomputeApproxSurfaceMetrics(
              itinerary.metrics,
              basePoints,
              itinerary.pendingRoutePatch,
              patchSurfaceMetrics,
              route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(patchRoutePoints),
            );

            return {
              ...project,
              itineraries: project.itineraries.map((current) =>
                current.id === project.activeItineraryId
                  ? {
                      ...current,
                      gpxRoute: {
                        name: current.gpxRoute?.name ?? null,
                        points: mergedRoutePoints,
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
                        tarmacPercent: surfaceMetrics?.tarmacPercent,
                        offroadPercent: surfaceMetrics?.offroadPercent,
                      },
                      timeline: nextTimeline,
                      routeAudit: undefined,
                      pendingTraceExtension: undefined,
                      pendingRoutePatch: undefined,
                    }
                  : current,
              ),
            };
          });
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          console.error('[BRouter local patch fail]', error);
          setRouteError(error instanceof Error ? error.message : 'Erreur BRouter');
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => ctrl.abort();
    }

    if (
      active &&
      pendingTraceExtension &&
      existingBrouterPoints &&
      existingBrouterPoints.length >= 2
    ) {
      const appendStart = pendingTraceExtension.from;
      const appendEnd = pendingTraceExtension.to;
      const bounds = checkRouteWithinFrance([appendStart, appendEnd]);
      if (!bounds.ok) {
        setRouteError(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        setRouteLoading(false);
        return;
      }

      routeAbortRef.current?.abort();
      const ctrl = new AbortController();
      routeAbortRef.current = ctrl;
      setRouteLoading(true);
      setRouteError(null);

      const itineraryForRouting = active;
      const t0 = performance.now();
      console.log(
        '[BRouter] append segment START hash=',
        brfHash,
        'climbing=',
        climbing,
        'from=',
        `${appendStart.lon},${appendStart.lat}`,
        'to=',
        `${appendEnd.lon},${appendEnd.lat}`,
      );

      resolveItineraryRouting(itineraryForRouting, ctrl.signal)
        .then((resolved: ResolvedRouting) => {
          if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');
          setRouteWarnings(resolved.roadTypes.warnings);
          const reqBase = {
            start: appendStart,
            end: appendEnd,
            via: [] as Array<{ lat: number; lon: number }>,
            polygons: forbiddenPolygons,
            profile: resolved.profileId,
            signal: ctrl.signal,
          };
          return climbing
            ? fetchBrouterRouteBestOfN(reqBase, 4)
            : fetchBrouterRoute(reqBase);
        })
        .then((route: BrouterRoute) => {
          if (ctrl.signal.aborted) return;
          console.log(
            '[BRouter] append segment OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );

          const geometryPoints = toGeometryRoutePoints(route.coordinates);
          const routeProfile = extractRouteProfileFromBrouter(route);
          const segmentRoutePoints = buildStoredRoutePointsFromBrouter(
            geometryPoints,
            routeProfile,
            route.distanceM,
          );
          const segmentSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);

          setProject((project) => {
            const itinerary = project.itineraries.find(
              (item) => item.id === project.activeItineraryId,
            );
            if (!itinerary || !itinerary.pendingTraceExtension) return project;

            const basePoints = itinerary.gpxRoute?.points ?? [];
            if (basePoints.length < 2) return project;

            const mergedRoutePoints = appendRoutePoints(basePoints, segmentRoutePoints);
            const elevationMetrics = computeRouteElevationMetrics(mergedRoutePoints);
            const totalDistanceM = getRoutePointTotalDistanceM(mergedRoutePoints);
            const distanceKm = roundRouteDistanceKm(totalDistanceM);
            const surfaceMetrics = mergeSurfaceMetrics(
              itinerary.metrics,
              getRoutePointTotalDistanceM(basePoints),
              segmentSurfaceMetrics,
              route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(segmentRoutePoints),
            );
            const nextTimeline = projectTimelineLocationDistances(
              itinerary.timeline,
              mergedRoutePoints,
              distanceKm,
            );

            return {
              ...project,
              itineraries: project.itineraries.map((current) =>
                current.id === project.activeItineraryId
                  ? {
                      ...current,
                      gpxRoute: {
                        name: current.gpxRoute?.name ?? null,
                        points: mergedRoutePoints,
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
                        tarmacPercent: surfaceMetrics?.tarmacPercent,
                        offroadPercent: surfaceMetrics?.offroadPercent,
                      },
                      timeline: nextTimeline,
                      pendingTraceExtension: undefined,
                    }
                  : current,
              ),
            };
          });
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          if (active && isBrouterUnmappedPointError(error)) {
            rollbackPendingTraceAppend(active.id);
          }
          console.error('[BRouter append fail]', error);
          setRouteError(error instanceof Error ? error.message : 'Erreur BRouter');
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => ctrl.abort();
    }

    if (!startKey || !endKey) {
      setRouteError(null);
      setRouteLoading(false);
      return;
    }

    // When the itinerary was seeded from an imported GPX file, the GPX
    // trace IS the route — don't trigger a BRouter point-to-point
    // recompute. For long-distance imports (e.g. Race Across France,
    // ~2500 km) this would exceed the 55 s Vercel timeout anyway, and
    // silently overwriting the user's track is never desired.
    if (active?.gpxRoute?.source === 'gpx' && !hasWaypointOverride) {
      setRouteError(null);
      setRouteLoading(false);
      return;
    }

    const [startLon, startLat] = startKey.split(',').map(Number);
    const [endLon, endLat] = endKey.split(',').map(Number);
    const userVia = viaKey
      ? viaKey.split('|').map((segment) => {
          const [lon, lat] = segment.split(',').map(Number);
          return { lat, lon };
        })
      : [];
    const via = userVia.slice(0, 14);

    const allPoints = [
      { lat: startLat, lon: startLon },
      { lat: endLat, lon: endLon },
      ...via,
    ];
    const bounds = checkRouteWithinFrance(allPoints);
    if (!bounds.ok) {
      if (active && hasRouteLayer(map, active.id)) {
        try {
          removeRouteLayer(map, active.id);
        } catch {
          // noop
        }
      }
      setRouteError(bounds.reason ?? 'Itinéraire hors zone autorisée.');
      setRouteLoading(false);
      return;
    }

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    setRouteLoading(true);
    setRouteError(null);

    const itineraryForRouting = active;
    if (!itineraryForRouting) return;

    const t0 = performance.now();
    console.log(
      '[BRouter] recompute START hash=',
      brfHash,
      'climbing=',
      climbing,
      'start=',
      startKey,
      'end=',
      endKey,
      'via=',
      viaKey || '∅',
    );

    resolveItineraryRouting(itineraryForRouting, ctrl.signal)
      .then((resolved: ResolvedRouting) => {
        if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');
        console.log(
          '[BRouter] profile resolved →',
          resolved.profileId,
          '| brf=',
          resolved.brf ? `${resolved.brf.length}B` : 'stock',
          '| warnings=',
          resolved.roadTypes.warnings.length,
        );
        setRouteWarnings(resolved.roadTypes.warnings);
        const reqBase = {
          start: { lat: startLat, lon: startLon },
          end: { lat: endLat, lon: endLon },
          via,
          polygons: forbiddenPolygons,
          profile: resolved.profileId,
          signal: ctrl.signal,
        };
        return climbing
          ? fetchBrouterRouteBestOfN(reqBase, 4)
          : fetchBrouterRoute(reqBase);
      })
      .then((route: BrouterRoute) => {
        if (ctrl.signal.aborted) return;
        console.log(
          '[BRouter] route OK in',
          Math.round(performance.now() - t0),
          'ms | dist=',
          (route.distanceM / 1000).toFixed(2),
          'km | ascent=',
          Math.round(route.ascentM),
          'm | pts=',
          route.coordinates.length,
        );
        const shouldAutoFit = !(
          active?.gpxRoute?.source === 'brouter' &&
          (active.gpxRoute.points.length ?? 0) >= 2
        );
        if (shouldAutoFit) {
          try {
            fitToRoute(map, route.coordinates);
          } catch (error) {
            console.warn('[BRouter] fitToRoute failed', error);
          }
        }

        const geometryPoints = toGeometryRoutePoints(route.coordinates);
        const routeProfile = extractRouteProfileFromBrouter(route);
        const routePoints = buildStoredRoutePointsFromBrouter(
          geometryPoints,
          routeProfile,
          route.distanceM,
        );
        const elevationMetrics = computeRouteElevationMetrics(routePoints);
        const surfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
        const auditRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
          ? toStoredRoutePoints(routeProfile)
          : routePoints;
        const distanceM = route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(routePoints);
        const distanceKm = roundRouteDistanceKm(distanceM);
        const ascentM = elevationMetrics
          ? Math.max(0, Math.round(elevationMetrics.ascentM))
          : undefined;
        const descentM = elevationMetrics
          ? Math.max(0, Math.round(elevationMetrics.descentM))
          : undefined;
        const avgSlopePercent = elevationMetrics
          ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
          : undefined;
        const tarmacPercent = surfaceMetrics
          ? Math.round(surfaceMetrics.tarmacPercent)
          : undefined;
        const offroadPercent = surfaceMetrics
          ? Math.round(surfaceMetrics.offroadPercent)
          : undefined;
        const auditFindings = analyzeBrouterRoute(route, auditRoutePoints);

        setProject((project) => {
          const itinerary = project.itineraries.find(
            (item) => item.id === project.activeItineraryId,
          );
          if (!itinerary) return project;
          const nextTimeline = projectTimelineLocationDistances(
            itinerary.timeline,
            routePoints,
            distanceKm,
          );
          const gpxAlreadyOk = routePointsEqual(itinerary.gpxRoute?.points, routePoints);
          const metricsAlreadyOk =
            itinerary.metrics?.distanceKm === distanceKm &&
            itinerary.metrics?.ascentM === ascentM &&
            itinerary.metrics?.descentM === descentM &&
            itinerary.metrics?.avgSlopePercent === avgSlopePercent &&
            itinerary.metrics?.tarmacPercent === tarmacPercent &&
            itinerary.metrics?.offroadPercent === offroadPercent;
          const auditAlreadyOk = routeAuditEqual(
            itinerary.routeAudit?.findings,
            auditFindings,
          );
          if (nextTimeline === itinerary.timeline && gpxAlreadyOk && metricsAlreadyOk && auditAlreadyOk) {
            return project;
          }
          return {
            ...project,
            itineraries: project.itineraries.map((current) =>
              current.id === project.activeItineraryId
                ? {
                    ...current,
                    gpxRoute: {
                      name: current.gpxRoute?.name ?? null,
                      points: routePoints,
                      source: 'brouter',
                    },
                    metrics: {
                      ...current.metrics,
                      distanceKm,
                      ascentM,
                      descentM,
                      avgSlopePercent,
                      tarmacPercent,
                      offroadPercent,
                    },
                    timeline: nextTimeline,
                    routeAudit: {
                      visible: current.routeAudit?.visible ?? false,
                      findings: auditFindings,
                    },
                  }
                : current,
            ),
          };
        });

      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return;
        console.error('[BRouter fetch fail]', error);
        setRouteError(error instanceof Error ? error.message : 'Erreur BRouter');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setRouteLoading(false);
      });

    return () => ctrl.abort();
  }, [active, brfHash, climbing, endKey, forbiddenPolygons, hasWaypointOverride, isMapLoaded, map, profileId, rollbackPendingTraceAppend, setProject, startKey, viaKey]);

  return {
    cancelRouteRequest,
    routeError,
    routeLoading,
    routeWarnings,
  };
}
