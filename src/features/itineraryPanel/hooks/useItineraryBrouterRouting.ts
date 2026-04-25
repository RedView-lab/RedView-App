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
    if (active?.gpxRoute?.source === 'gpx') {
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
        const routePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
          ? toStoredRoutePoints(routeProfile)
          : geometryPoints;
        const distanceM = route.distanceM > 0 ? route.distanceM : routeLengthM(routePoints);
        const distanceKm = Math.round(distanceM / 100) / 10;
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
        const auditFindings = analyzeBrouterRoute(route, routePoints);

        setProject((project) => {
          const itinerary = project.itineraries.find(
            (item) => item.id === project.activeItineraryId,
          );
          if (!itinerary) return project;
          const endRow = itinerary.timeline.find((row) => row.kind === 'end');
          const endAlreadyOk = endRow?.distanceKm === distanceKm;
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
          if (endAlreadyOk && gpxAlreadyOk && metricsAlreadyOk && auditAlreadyOk) {
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
                    timeline: current.timeline.map((row) =>
                      row.kind === 'end' ? { ...row, distanceKm } : row,
                    ),
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
  }, [active, brfHash, climbing, endKey, isMapLoaded, map, profileId, setProject, startKey, viaKey]);

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