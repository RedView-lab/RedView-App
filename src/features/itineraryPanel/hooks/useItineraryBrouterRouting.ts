import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { routeLengthM } from '@/features/poi/lib/gpx-loader';

import {
  buildBrfProfile,
  checkRouteWithinFrance,
  fetchBrouterRoute,
  fetchBrouterRouteBestOfN,
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
  cumulativeRouteLengthsM,
  haversineRouteDistanceM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '../lib/route-distance';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
} from '../lib/route-metrics';
import { analyzeBrouterRoute } from '../lib/routeAudit/analyzeBrouterRoute';
import type { Itinerary, ItineraryProject, ItineraryRouteAuditFinding } from '../types';

interface UseItineraryBrouterRoutingArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  map: MapboxMap | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

export function useItineraryBrouterRouting({
  active,
  isMapLoaded,
  map,
  setProject,
}: UseItineraryBrouterRoutingArgs) {
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  const routeAbortRef = useRef<AbortController | null>(null);

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
          const patchRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
            ? enrichGeometryRoutePoints(geometryPoints, routeProfile)
            : geometryPoints;
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
            const distanceKm = roundDistanceKm(distanceM);
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
          const segmentRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
            ? enrichGeometryRoutePoints(geometryPoints, routeProfile)
            : geometryPoints;
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
            const distanceKm = roundDistanceKm(totalDistanceM);
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
          console.error('[BRouter append fail]', error);
          setRouteError(error instanceof Error ? error.message : 'Erreur BRouter');
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => ctrl.abort();
    }

    if (!startKey || !endKey) {
      if (active && hasRouteLayer(map, active.id)) {
        try {
          removeRouteLayer(map, active.id);
        } catch {
          // noop
        }
      }
      setRouteError(null);
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
        try {
          fitToRoute(map, route.coordinates);
        } catch (error) {
          console.warn('[BRouter] fitToRoute failed', error);
        }

        const geometryPoints = toGeometryRoutePoints(route.coordinates);
        const routeProfile = extractRouteProfileFromBrouter(route);
        const elevationMetrics = routeProfile
          ? computeRouteElevationMetrics(routeProfile)
          : null;
        const surfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
        const auditRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
          ? toStoredRoutePoints(routeProfile)
          : geometryPoints;
        const routePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
          ? enrichGeometryRoutePoints(geometryPoints, routeProfile)
          : geometryPoints;
        const distanceM = route.distanceM > 0 ? route.distanceM : routeLengthM(routePoints);
        const distanceKm = roundDistanceKm(distanceM);
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
  }, [active, brfHash, climbing, endKey, hasWaypointOverride, isMapLoaded, map, profileId, setProject, startKey, viaKey]);

  return {
    routeError,
    routeLoading,
    routeWarnings,
  };
}

function toStoredRoutePoints(
  profile: Array<{
    lat: number;
    lon: number;
    distanceM: number;
    elevationM: number;
    gradientPct: number;
  }>,
): NonNullable<Itinerary['gpxRoute']>['points'] {
  return profile.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM: point.distanceM,
    elevationM: point.elevationM,
    gradientPct: point.gradientPct,
  }));
}

function toGeometryRoutePoints(
  coordinates: [number, number][],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  return coordinates.map((coordinate) => ({
    lat: coordinate[1],
    lon: coordinate[0],
  }));
}

function enrichGeometryRoutePoints(
  geometryPoints: NonNullable<Itinerary['gpxRoute']>['points'],
  profile: Array<{
    lat: number;
    lon: number;
    distanceM: number;
    elevationM: number;
    gradientPct: number;
  }>,
): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (geometryPoints.length === 0 || profile.length < 2) return geometryPoints;

  const geometryDistancesM = new Array<number>(geometryPoints.length).fill(0);
  for (let index = 1; index < geometryPoints.length; index++) {
    geometryDistancesM[index] =
      geometryDistancesM[index - 1] + haversineMeters(geometryPoints[index - 1], geometryPoints[index]);
  }

  const geometryTotalDistanceM = geometryDistancesM[geometryDistancesM.length - 1] ?? 0;
  const profileTotalDistanceM = profile[profile.length - 1]?.distanceM ?? 0;
  const distanceScale =
    geometryTotalDistanceM > 0 && profileTotalDistanceM > 0
      ? profileTotalDistanceM / geometryTotalDistanceM
      : 1;

  return geometryPoints.map((point, index) => {
    const distanceM = geometryDistancesM[index] * distanceScale;
    const sample = interpolateProfileSample(profile, distanceM);
    return {
      lat: point.lat,
      lon: point.lon,
      distanceM,
      elevationM: sample.elevationM,
      gradientPct: sample.gradientPct,
    };
  });
}

function interpolateProfileSample(
  profile: Array<{
    distanceM: number;
    elevationM: number;
    gradientPct: number;
  }>,
  distanceM: number,
): { elevationM: number; gradientPct: number } {
  if (distanceM <= profile[0].distanceM) {
    return {
      elevationM: profile[0].elevationM,
      gradientPct: profile[0].gradientPct,
    };
  }

  const last = profile[profile.length - 1];
  if (distanceM >= last.distanceM) {
    return {
      elevationM: last.elevationM,
      gradientPct: last.gradientPct,
    };
  }

  let low = 0;
  let high = profile.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (profile[mid].distanceM <= distanceM) low = mid;
    else high = mid;
  }

  const start = profile[low];
  const end = profile[high];
  const spanM = end.distanceM - start.distanceM;
  if (spanM <= 0) {
    return {
      elevationM: start.elevationM,
      gradientPct: start.gradientPct,
    };
  }

  const t = (distanceM - start.distanceM) / spanM;
  return {
    elevationM: start.elevationM + (end.elevationM - start.elevationM) * t,
    gradientPct: start.gradientPct + (end.gradientPct - start.gradientPct) * t,
  };
}

function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRad(b.lat - a.lat);
  const deltaLon = toRad(b.lon - a.lon);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

function routePointsEqual(
  left: NonNullable<Itinerary['gpxRoute']>['points'] | null | undefined,
  right: NonNullable<Itinerary['gpxRoute']>['points'] | null | undefined,
): boolean {
  return routePointsSignature(left) === routePointsSignature(right);
}

function routePointsSignature(
  points: NonNullable<Itinerary['gpxRoute']>['points'] | null | undefined,
): string {
  if (!points || points.length === 0) return 'empty';
  const indices = Array.from(
    new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]),
  );
  return [
    String(points.length),
    ...indices.map((index) => {
      const point = points[index];
      return [
        index,
        point.lat.toFixed(6),
        point.lon.toFixed(6),
        Number.isFinite(point.distanceM) ? (point.distanceM as number).toFixed(1) : 'null',
        Number.isFinite(point.elevationM)
          ? (point.elevationM as number).toFixed(2)
          : 'null',
        Number.isFinite(point.gradientPct)
          ? (point.gradientPct as number).toFixed(3)
          : 'null',
      ].join(':');
    }),
  ].join('|');
}

function sameRoutePoint(
  left: NonNullable<Itinerary['gpxRoute']>['points'][number] | undefined,
  right: NonNullable<Itinerary['gpxRoute']>['points'][number] | undefined,
): boolean {
  if (!left || !right) return false;
  return Math.abs(left.lat - right.lat) < 1e-6 && Math.abs(left.lon - right.lon) < 1e-6;
}

function getRoutePointTotalDistanceM(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): number {
  const last = points[points.length - 1];
  if (last && Number.isFinite(last.distanceM)) return last.distanceM as number;
  return routeLengthM(points);
}

function getRoutePointDistances(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): number[] {
  if (points.length === 0) return [];

  const distances = new Array<number>(points.length);
  distances[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const nextDistance = point.distanceM;
    if (Number.isFinite(nextDistance) && (nextDistance as number) >= distances[index - 1]) {
      distances[index] = nextDistance as number;
      continue;
    }
    distances[index] = distances[index - 1] + haversineRouteDistanceM(points[index - 1], point);
  }
  return distances;
}

function interpolateRoutePointAtDistance(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
  distances: number[],
  targetDistanceM: number,
): NonNullable<Itinerary['gpxRoute']>['points'][number] | null {
  if (points.length === 0 || distances.length !== points.length) return null;
  if (targetDistanceM <= distances[0]) return { ...points[0], distanceM: 0 };
  const lastIndex = points.length - 1;
  if (targetDistanceM >= distances[lastIndex]) {
    return { ...points[lastIndex], distanceM: distances[lastIndex] };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= targetDistanceM) low = mid;
    else high = mid;
  }

  const startPoint = points[low];
  const endPoint = points[high];
  const spanM = distances[high] - distances[low];
  if (spanM <= 0) return { ...startPoint, distanceM: targetDistanceM };
  const t = Math.max(0, Math.min(1, (targetDistanceM - distances[low]) / spanM));

  return {
    lat: startPoint.lat + ((endPoint.lat - startPoint.lat) * t),
    lon: startPoint.lon + ((endPoint.lon - startPoint.lon) * t),
    distanceM: targetDistanceM,
    elevationM:
      Number.isFinite(startPoint.elevationM) && Number.isFinite(endPoint.elevationM)
        ? (startPoint.elevationM as number) + (((endPoint.elevationM as number) - (startPoint.elevationM as number)) * t)
        : startPoint.elevationM ?? endPoint.elevationM ?? null,
    gradientPct:
      Number.isFinite(startPoint.gradientPct) && Number.isFinite(endPoint.gradientPct)
        ? (startPoint.gradientPct as number) + (((endPoint.gradientPct as number) - (startPoint.gradientPct as number)) * t)
        : startPoint.gradientPct ?? endPoint.gradientPct ?? null,
  };
}

function dedupeRoutePoints(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  const deduped: NonNullable<Itinerary['gpxRoute']>['points'] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && sameRoutePoint(previous, point)) continue;
    deduped.push(point);
  }
  return deduped;
}

function normalizeRoutePointDistances(
  points: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (points.length === 0) return [];
  let cumulativeDistanceM = 0;
  return points.map((point, index) => {
    if (index > 0) {
      cumulativeDistanceM += haversineRouteDistanceM(points[index - 1], point);
    }
    return {
      ...point,
      distanceM: cumulativeDistanceM,
    };
  });
}

function routePatchBoundaryDistanceM(
  patchPoint: { lat: number; lon: number; kind: 'start' | 'waypoint' | 'end' },
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  routeDistances: number[],
): number | null {
  if (patchPoint.kind === 'start') return 0;
  if (patchPoint.kind === 'end') return routeDistances[routeDistances.length - 1] ?? 0;
  return projectPointAlongRoute(patchPoint, routePoints, routeDistances)?.distanceM ?? null;
}

function replaceRouteSegment(
  basePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementPoints: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (basePoints.length === 0) return replacementPoints;

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return replacementPoints;
  }

  const prefix = basePoints
    .filter((_, index) => baseDistances[index] < startDistanceM - 1e-6)
    .map((point) => ({ ...point }));
  const startBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, startDistanceM);
  if (startBoundaryPoint) prefix.push(startBoundaryPoint);

  const endBoundaryPoint = interpolateRoutePointAtDistance(basePoints, baseDistances, endDistanceM);
  const suffix = basePoints
    .filter((_, index) => baseDistances[index] > endDistanceM + 1e-6)
    .map((point) => ({ ...point }));
  if (endBoundaryPoint) suffix.unshift(endBoundaryPoint);

  return normalizeRoutePointDistances(
    dedupeRoutePoints([
      ...prefix,
      ...replacementPoints.map((point) => ({ ...point })),
      ...suffix,
    ]),
  );
}

function recomputeApproxSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  basePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  patch: NonNullable<Itinerary['pendingRoutePatch']>,
  replacementSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  replacementDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!replacementSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseDistances = getRoutePointDistances(basePoints);
  const startDistanceM = routePatchBoundaryDistanceM(patch.start, basePoints, baseDistances);
  const endDistanceM = routePatchBoundaryDistanceM(patch.end, basePoints, baseDistances);
  if (startDistanceM == null || endDistanceM == null || endDistanceM < startDistanceM) {
    return {
      tarmacPercent: Math.round(replacementSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(replacementSurfaceMetrics.offroadPercent),
    };
  }

  const remainingBaseDistanceM = Math.max(0, (baseDistances[baseDistances.length - 1] ?? 0) - (endDistanceM - startDistanceM));
  return mergeSurfaceMetrics(
    existingMetrics,
    remainingBaseDistanceM,
    replacementSurfaceMetrics,
    replacementDistanceM,
  );
}

function appendRoutePoints(
  basePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  extensionPoints: NonNullable<Itinerary['gpxRoute']>['points'],
): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (basePoints.length === 0) return extensionPoints;
  if (extensionPoints.length === 0) return basePoints;

  const baseDistanceM = getRoutePointTotalDistanceM(basePoints);
  const shouldDropFirstExtensionPoint = sameRoutePoint(
    basePoints[basePoints.length - 1],
    extensionPoints[0],
  );
  const segmentTail = shouldDropFirstExtensionPoint ? extensionPoints.slice(1) : extensionPoints;
  if (segmentTail.length === 0) return basePoints;

  return [
    ...basePoints,
    ...segmentTail.map((point) => ({
      ...point,
      distanceM: baseDistanceM + (Number.isFinite(point.distanceM) ? (point.distanceM as number) : 0),
    })),
  ];
}

function mergeSurfaceMetrics(
  existingMetrics: Itinerary['metrics'] | undefined,
  baseDistanceM: number,
  segmentSurfaceMetrics: ReturnType<typeof computeRouteSurfaceMetricsFromBrouter>,
  segmentDistanceM: number,
): { tarmacPercent?: number; offroadPercent?: number } | undefined {
  if (!segmentSurfaceMetrics) {
    return existingMetrics
      ? {
          tarmacPercent: existingMetrics.tarmacPercent,
          offroadPercent: existingMetrics.offroadPercent,
        }
      : undefined;
  }

  const baseTarmacDistanceM =
    existingMetrics?.tarmacPercent != null ? (existingMetrics.tarmacPercent / 100) * baseDistanceM : Number.NaN;
  const baseOffroadDistanceM =
    existingMetrics?.offroadPercent != null ? (existingMetrics.offroadPercent / 100) * baseDistanceM : Number.NaN;
  const segmentTarmacDistanceM =
    (segmentSurfaceMetrics.tarmacPercent / 100) * Math.max(segmentDistanceM, 0);
  const segmentOffroadDistanceM =
    (segmentSurfaceMetrics.offroadPercent / 100) * Math.max(segmentDistanceM, 0);

  if (!Number.isFinite(baseTarmacDistanceM) || !Number.isFinite(baseOffroadDistanceM)) {
    return {
      tarmacPercent: Math.round(segmentSurfaceMetrics.tarmacPercent),
      offroadPercent: Math.round(segmentSurfaceMetrics.offroadPercent),
    };
  }

  const totalClassifiedDistanceM =
    baseTarmacDistanceM +
    baseOffroadDistanceM +
    segmentTarmacDistanceM +
    segmentOffroadDistanceM;
  if (!(totalClassifiedDistanceM > 0)) return undefined;

  return {
    tarmacPercent: Math.round(((baseTarmacDistanceM + segmentTarmacDistanceM) / totalClassifiedDistanceM) * 100),
    offroadPercent: Math.round(((baseOffroadDistanceM + segmentOffroadDistanceM) / totalClassifiedDistanceM) * 100),
  };
}

function routeAuditEqual(
  left: ItineraryRouteAuditFinding[] | undefined,
  right: ItineraryRouteAuditFinding[] | undefined,
): boolean {
  const leftFindings = left ?? [];
  const rightFindings = right ?? [];
  return (
    leftFindings.length === rightFindings.length &&
    leftFindings.every((finding, index) => {
      const other = rightFindings[index];
      return (
        finding.id === other?.id &&
        finding.kind === other.kind &&
        finding.title === other.title &&
        finding.detail === other.detail &&
        finding.coordinates.length === other.coordinates.length &&
        finding.coordinates.every((coord, coordIndex) => {
          const next = other.coordinates[coordIndex];
          return coord[0] === next?.[0] && coord[1] === next?.[1];
        })
      );
    })
  );
}

function projectTimelineLocationDistances(
  timeline: Itinerary['timeline'],
  routePoints: NonNullable<Itinerary['gpxRoute']>['points'],
  totalDistanceKm: number,
): Itinerary['timeline'] {
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  const snappedStart = routePoints[0] ?? null;
  const snappedEnd = routePoints[routePoints.length - 1] ?? null;
  let changed = false;

  const nextTimeline = timeline.map((row) => {
    if (row.kind === 'start') {
      if (
        row.distanceKm === 0 &&
        row.lat === snappedStart?.lat &&
        row.lon === snappedStart?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: 0,
        lat: snappedStart?.lat ?? row.lat,
        lon: snappedStart?.lon ?? row.lon,
      };
    }

    if (row.kind === 'end') {
      if (
        row.distanceKm === totalDistanceKm &&
        row.lat === snappedEnd?.lat &&
        row.lon === snappedEnd?.lon
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        distanceKm: totalDistanceKm,
        lat: snappedEnd?.lat ?? row.lat,
        lon: snappedEnd?.lon ?? row.lon,
      };
    }

    if (row.kind !== 'waypoint') return row;

    const snappedWaypoint =
      row.lat != null && row.lon != null
        ? projectPointAlongRoute(
            { lat: row.lat, lon: row.lon },
            routePoints,
            cumulativeLengths,
          )
        : null;
    const projectedDistanceKm =
      snappedWaypoint == null ? null : roundDistanceKm(snappedWaypoint.distanceM);
    if (
      row.distanceKm === projectedDistanceKm &&
      row.lat === snappedWaypoint?.lat &&
      row.lon === snappedWaypoint?.lon
    ) {
      return row;
    }
    changed = true;
    return {
      ...row,
      distanceKm: projectedDistanceKm,
      lat: snappedWaypoint?.lat ?? row.lat,
      lon: snappedWaypoint?.lon ?? row.lon,
    };
  });

  return changed ? nextTimeline : timeline;
}