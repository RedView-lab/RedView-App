import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildBrfProfile,
  checkRouteWithinFrance,
  formatForbiddenZonePolygons,
  hashBrf,
  isClimbingMode,
} from '../../lib/brouter';
import {
  fitToRoute,
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

  const beginRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    setRouteRequestNonce((current) => current + 1);
    setRouteLoading(true);
    setRouteError(null);
    return ctrl;
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

      const ctrl = beginRouteRequest();

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

      const ctrl = beginRouteRequest();

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

    const ctrl = beginRouteRequest();

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
  }, [active, brfHash, climbing, endKey, forbiddenPolygons, hasWaypointOverride, isMapLoaded, map, profileId, rollbackPendingTraceAppend, setProject, startKey, viaKey]);

  return {
    cancelRouteRequest,
    routeError,
    routeLoading,
    routeRequestNonce,
    routeWarnings,
  };
}