import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildBrfProfile,
  checkRouteWithinFrance,
  formatForbiddenZonePolygons,
  hashBrf,
  isClimbingMode,
} from '../../lib/brouter';
import {
  hasRouteLayer,
  removeRouteLayer,
} from '../../lib/route-layer';
import {
  isBrouterUnmappedPointError,
  type UseItineraryBrouterRoutingArgs,
} from '../useItineraryBrouterRoutingShared';

import { applyRouteWarnings } from './profileFallback';
import {
  applyPendingRoutePatch,
  applyPendingTraceAppend,
  applyRecomputedRoute,
} from './projectMutations';
import { resolveRouteRequest } from './resolveRouteRequest';
import type { RouteRequestBase } from './profileFallback';

export function useItineraryBrouterRouting({
  active,
  isMapLoaded,
  map,
  rollbackPendingTraceAppend,
  setProject,
}: UseItineraryBrouterRoutingArgs) {
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeRequestNonce, setRouteRequestNonce] = useState(0);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  const routeAbortRef = useRef<AbortController | null>(null);
  const cancelRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    setRouteLoading(false);
  }, []);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const beginRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    queueMicrotask(() => {
      setRouteRequestNonce((current) => current + 1);
      setRouteLoading(true);
      setRouteError(null);
    });
    return ctrl;
  }, []);
  const settleRouteState = useCallback((nextError: string | null) => {
    setRouteError(nextError);
    setRouteLoading(false);
  }, []);
  const deferRouteState = useCallback((nextError: string | null) => {
    queueMicrotask(() => {
      settleRouteState(nextError);
    });
  }, [settleRouteState]);

  const startKey = (() => {
    const row = active?.timeline.find((item) => item.kind === 'start');
    return row && row.lat != null && row.lon != null ? `${row.lon},${row.lat}` : '';
  })();
  const activeId = active?.id ?? '';

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
  const forbiddenPolygons = formatForbiddenZonePolygons(active?.forbiddenZones);
  const pendingRoutePatchKey = active?.pendingRoutePatch
    ? JSON.stringify(active.pendingRoutePatch)
    : '';
  const pendingTraceExtensionKey = active?.pendingTraceExtension
    ? JSON.stringify(active.pendingTraceExtension)
    : '';
  const gpxRouteSource = active?.gpxRoute?.source ?? '';
  const gpxRoutePointCount = active?.gpxRoute?.points.length ?? 0;
  const prioritiesKey = active ? JSON.stringify(active.priorities) : '';
  const roadTypesKey = active ? JSON.stringify(active.roadTypes) : '';
  const expertProfileKey = active?.expertProfile
    ? JSON.stringify(active.expertProfile)
    : '';

  const brfInputs = useMemo(() => {
    if (!prioritiesKey || !roadTypesKey) return null;
    return {
      priorities: JSON.parse(prioritiesKey),
      roadTypes: JSON.parse(roadTypesKey),
      expert: expertProfileKey ? JSON.parse(expertProfileKey) : undefined,
    };
  }, [expertProfileKey, prioritiesKey, roadTypesKey]);

  const brfProfile = useMemo(() => {
    if (!brfInputs) return '';
    try {
      return buildBrfProfile(brfInputs);
    } catch (error) {
      console.warn('[BRouter] buildBrfProfile threw:', error);
      return '';
    }
  }, [brfInputs]);

  const brfHash = useMemo(() => {
    if (!brfProfile) return '';
    return hashBrf(brfProfile);
  }, [brfProfile]);

  useEffect(() => {
    if (!brfProfile) return;
    console.log(
      '[BRouter] BRF hash =',
      brfHash,
      '| size =',
      brfProfile.length,
      'B | profile =',
      profileId,
      '| priorities =',
      prioritiesKey,
    );
  }, [brfHash, brfProfile, prioritiesKey, profileId]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const currentActive = activeRef.current;
    const pendingRoutePatch = currentActive?.pendingRoutePatch;
    const pendingTraceExtension = currentActive?.pendingTraceExtension;
    const existingBrouterPoints = currentActive?.gpxRoute?.source === 'brouter'
      ? currentActive.gpxRoute.points
      : null;

    if (
      currentActive &&
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
        deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        return;
      }

      const ctrl = beginRouteRequest();

      const itineraryForRouting = currentActive;
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

      const requestBase: RouteRequestBase = {
        start: pendingRoutePatch.start,
        end: pendingRoutePatch.end,
        via: pendingRoutePatch.via,
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(({ route, usedFallbackProfile, resolvedWarnings }) => {
          if (ctrl.signal.aborted) return;
          setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
          console.log(
            '[BRouter] local patch OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );
          setProject((project) => applyPendingRoutePatch(project, route));
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
      currentActive &&
      pendingTraceExtension &&
      existingBrouterPoints &&
      existingBrouterPoints.length >= 2
    ) {
      const appendStart = pendingTraceExtension.from;
      const appendEnd = pendingTraceExtension.to;
      const bounds = checkRouteWithinFrance([appendStart, appendEnd]);
      if (!bounds.ok) {
        deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        return;
      }

      const ctrl = beginRouteRequest();

      const itineraryForRouting = currentActive;
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

      const requestBase: RouteRequestBase = {
        start: appendStart,
        end: appendEnd,
        via: [] as Array<{ lat: number; lon: number }>,
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(({ route, usedFallbackProfile, resolvedWarnings }) => {
          if (ctrl.signal.aborted) return;
          setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
          console.log(
            '[BRouter] append segment OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );
          setProject((project) => applyPendingTraceAppend(project, route));
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          if (currentActive && isBrouterUnmappedPointError(error)) {
            rollbackPendingTraceAppend(currentActive.id);
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
      deferRouteState(null);
      return;
    }

    if (currentActive?.gpxRoute?.source === 'gpx' && !hasWaypointOverride) {
      deferRouteState(null);
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
      if (currentActive && hasRouteLayer(map, currentActive.id)) {
        try {
          removeRouteLayer(map, currentActive.id);
        } catch {
          // noop
        }
      }
      deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
      return;
    }

    const ctrl = beginRouteRequest();

  const itineraryForRouting = currentActive;
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

    const requestBase: RouteRequestBase = {
      start: { lat: startLat, lon: startLon },
      end: { lat: endLat, lon: endLon },
      via,
      polygons: forbiddenPolygons,
      signal: ctrl.signal,
    };

    resolveRouteRequest({
      itinerary: itineraryForRouting,
      signal: ctrl.signal,
      requestBase,
      setRouteWarnings,
    })
      .then(({ route, usedFallbackProfile, resolvedWarnings, resolved }) => {
        if (ctrl.signal.aborted) return;
        console.log(
          '[BRouter] profile resolved →',
          resolved.profileId,
          '| brf=',
          resolved.brf ? `${resolved.brf.length}B` : 'stock',
          '| warnings=',
          resolved.roadTypes.warnings.length,
        );
        setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
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
        setProject((project) => applyRecomputedRoute(project, route));
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
  }, [
    activeId,
    beginRouteRequest,
    brfHash,
    climbing,
    endKey,
    forbiddenPolygons,
    deferRouteState,
    gpxRoutePointCount,
    gpxRouteSource,
    hasWaypointOverride,
    isMapLoaded,
    map,
    pendingRoutePatchKey,
    pendingTraceExtensionKey,
    profileId,
    rollbackPendingTraceAppend,
    setProject,
    startKey,
    viaKey,
  ]);

  return {
    cancelRouteRequest,
    routeError,
    routeLoading,
    routeRequestNonce,
    routeWarnings,
  };
}