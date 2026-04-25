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