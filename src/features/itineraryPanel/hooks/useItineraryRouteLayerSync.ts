import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';

import {
  clearForbiddenZoneDraft,
  clearForbiddenZones,
  clearRouteAuditFindings,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  setForbiddenZones,
  type RouteSlopeBand,
  upsertRouteLayer,
} from '../lib/route-layer';
import { buildRouteContentSignature } from '../lib/routes';
import { getRouteElevationContext } from '../lib/route-layer/routeElevation';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '../lib/route-layer/constants';
import { resolveRouteDisplayPoints, resolveRouteDisplayPreset } from '../lib/route-layer/displayQuality';
import type { ItineraryProject, RouteDisplayQuality, RouteRenderMode, RouteSurfaceFilter } from '../types';
import { useRouteDisplayContext } from './useRouteDisplayContext';

function canAccessStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

// Debounce window for coalescing bursts of styledata events. The trace reads
// its altitude from the terrain on the GPU: streamed DEM tiles never need a
// replay.
const REPLAY_DEBOUNCE_MS = 120;
const REPLAY_RETRY_MS = 250;
const REPLAY_MAX_RETRIES = 40;

interface UseItineraryRouteLayerSyncArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  routeTraceWidthPx?: number;
  /** Finesse des traces dessinées (vue) ; `auto` suit la 2D / 3D et le relief. */
  routeDisplayQuality?: RouteDisplayQuality;
  /** When false the entire Routes section is off and NO trace renders. */
  routesEnabled?: boolean;
  /** Filtre « Surface » du panneau d'analyse. */
  surfaceFilter?: RouteSurfaceFilter;
  /**
   * Filtre « Pente » du graphe central : cet itinéraire est tracé en pente
   * (même échelle que le profil), quel que soit son mode de rendu.
   */
  slopeItineraryId?: string | null;
}

function resolveRenderMode(
  itinerary: ItineraryProject['itineraries'][number],
  slopeItineraryId: string | null,
): RouteRenderMode {
  if (slopeItineraryId != null && itinerary.id === slopeItineraryId) return 'slope';
  return itinerary.renderMode ?? 'default';
}

export function useItineraryRouteLayerSync({
  active,
  isMapLoaded,
  itineraries,
  map,
  routeTraceWidthPx = DEFAULT_ROUTE_TRACE_WIDTH_PX,
  routeDisplayQuality = 'auto',
  routesEnabled = true,
  surfaceFilter = 'all',
  slopeItineraryId = null,
}: UseItineraryRouteLayerSyncArgs): void {
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceReplayPendingRef = useRef(false);
  // Signature the last time we actually pushed data to the map. When styledata /
  // sourcedata fire but this signature is unchanged, the replay is a no-op
  // (the route geometry / styling has not changed — only terrain did).
  const lastReplayedSignatureRef = useRef<string | null>(null);

  const routeSlopeBands = useMemo(
    (): RouteSlopeBand[] => ROUTE_SLOPE_LEGEND_BANDS.map((band) => ({
      id: band.id,
      minDeg: band.minDeg,
      maxDeg: band.maxDeg,
      color: band.color,
    })),
    [],
  );
  const displayContext = useRouteDisplayContext(map);
  const routeDisplayPreset = resolveRouteDisplayPreset(routeDisplayQuality, displayContext);
  const routeSlopeBandSignature = useMemo(
    () => routeSlopeBands.map((band) => `${band.id}:${band.minDeg}:${band.maxDeg}:${band.color}`).join('|'),
    [routeSlopeBands],
  );
  const layerSignature = useMemo(() => {
    const itinerarySignature = itineraries
      .map((it) => {
        const len = it.gpxRoute?.points.length ?? 0;
        const routeKey = buildRouteContentSignature(it.gpxRoute?.points);
        return [
          it.id,
          len,
          it.gpxRoute?.originalPoints?.length ?? 0,
          routeKey,
          it.color,
          it.opacity ?? 100,
          resolveRenderMode(it, slopeItineraryId),
          routeTraceWidthPx,
          it.visible !== false ? 1 : 0,
          it.analysisVisible !== false ? 1 : 0,
          (it.forbiddenZones ?? []).map((zone) => {
            const first = zone.points[0];
            return `${zone.id}:${zone.points.length}:${first?.lon ?? ''}:${first?.lat ?? ''}`;
          }).join(','),
        ].join(':');
      })
      .join('|');
    return `${routesEnabled ? 1 : 0}::${itinerarySignature}::bands:${routeSlopeBandSignature}::surface:${surfaceFilter}::quality:${routeDisplayPreset}`;
  }, [itineraries, routeDisplayPreset, routeSlopeBandSignature, routeTraceWidthPx, routesEnabled, slopeItineraryId, surfaceFilter]);

  // Ref bag so the stable map listeners always read the latest values without
  // having to re-subscribe on every project mutation. Synced in a layout
  // effect, i.e. before any passive effect below reads it.
  const latestState = {
    active,
    isMapLoaded,
    itineraries,
    map,
    routeSlopeBands,
    routeTraceWidthPx,
    routeDisplayPreset,
    routesEnabled,
    surfaceFilter,
    slopeItineraryId,
    layerSignature,
  };
  const stateRef = useRef(latestState);
  useLayoutEffect(() => {
    stateRef.current = latestState;
  });

  const replayRouteState = useCallback((force = false): boolean => {
    const {
      map: currentMap,
      isMapLoaded: loaded,
      itineraries: currentItineraries,
      active: currentActive,
      routeSlopeBands: bands,
      routeTraceWidthPx: traceWidthPx,
      routeDisplayPreset: displayPreset,
      layerSignature: signature,
      routesEnabled: areRoutesEnabled,
      surfaceFilter: activeSurfaceFilter,
      slopeItineraryId: currentSlopeItineraryId,
    } = stateRef.current;
    if (!currentMap || !loaded || !canAccessStyle(currentMap)) return false;

    // Elevated (terrain, Mercator) vs draped (globe / no terrain): the line
    // layers' elevation reference follows it. Streamed DEM tiles never matter.
    const renderSignature = `${signature}::elevation:${getRouteElevationContext(currentMap).signature}`;
    if (!force && lastReplayedSignatureRef.current === renderSignature) return true;

    let allMounted = true;
    for (const it of currentItineraries) {
      const route = it.gpxRoute;
      if (!route || route.points.length < 2) continue;
      const pts = resolveRouteDisplayPoints(route, displayPreset);
      // Visible iff the Routes section is active AND the user has not
      // explicitly hidden this trace. (`analysisVisible` controls the central
      // chart/profile, not the map line.)
      const routeVisible = areRoutesEnabled && it.visible !== false;
      try {
        const mounted = upsertRouteLayer(currentMap, it.id, pts, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          traceWidthPx,
          visible: routeVisible,
          renderMode: resolveRenderMode(it, currentSlopeItineraryId),
          slopeBands: bands,
          surfaceFilter: activeSurfaceFilter,
        });
        if (!mounted) allMounted = false;
      } catch (error) {
        allMounted = false;
        console.warn('[route-layer] upsert failed for', it.id, error);
      }
    }

    for (const mountedId of listMountedRouteIds(currentMap)) {
      const stillWanted = currentItineraries.some(
        (it) =>
          it.id.replace(/[^a-zA-Z0-9_-]/g, '_') === mountedId &&
          it.gpxRoute &&
          it.gpxRoute.points.length >= 2,
      );
      if (!stillWanted) {
        removeRouteLayer(currentMap, mountedId);
      }
    }

    clearRouteAuditFindings(currentMap);
    if (currentActive && areRoutesEnabled) {
      setForbiddenZones(currentMap, currentActive.forbiddenZones ?? []);
    } else {
      clearForbiddenZones(currentMap);
      clearForbiddenZoneDraft(currentMap);
    }

    // A trace the style could not take yet is retried by the next event /
    // timer instead of being considered done.
    lastReplayedSignatureRef.current = allMounted ? renderSignature : null;
    return allMounted;
  }, []);

  const scheduleReplayRouteState = useCallback((force = false): void => {
    if (force) forceReplayPendingRef.current = true;
    // Already scheduled — the pending timer will pick up the `force` flag.
    if (replayTimerRef.current) return;
    const run = (attempt: number): void => {
      replayTimerRef.current = setTimeout(() => {
        replayTimerRef.current = null;
        const pendingForce = forceReplayPendingRef.current;
        forceReplayPendingRef.current = false;
        if (replayRouteState(pendingForce) || attempt >= REPLAY_MAX_RETRIES) return;
        // The style refused a trace (being replaced): retry on a timer too, a
        // settled map may not emit another event for a long time.
        if (pendingForce) forceReplayPendingRef.current = true;
        run(attempt + 1);
      }, attempt === 0 ? REPLAY_DEBOUNCE_MS : REPLAY_RETRY_MS);
    };
    run(0);
  }, [replayRouteState]);

  // Replay whenever the actual route state (points / colors / visibility) changes.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!replayRouteState()) scheduleReplayRouteState();
  }, [isMapLoaded, layerSignature, map, replayRouteState, scheduleReplayRouteState]);

  // Stable map listeners: subscribe once per (map, isMapLoaded). They read the
  // latest state through refs, so they don't tear down/re-attach on every project
  // mutation — which previously caused a listener churn storm during GPX import.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      try {
        removeAllRouteLayers(map);
        clearRouteAuditFindings(map);
        clearForbiddenZones(map);
        clearForbiddenZoneDraft(map);
      } catch {
        /* noop */
      }
      // Layers were wiped — next replay MUST push everything back regardless of
      // signature, so bust the cache and force.
      lastReplayedSignatureRef.current = null;
      scheduleReplayRouteState(true);
    };
    const onStyleData = () => {
      scheduleReplayRouteState(false);
    };
    // Elevated lines are not drawn on the globe: switch the layers as soon as
    // the zoom crosses ROUTE_ELEVATED_MIN_ZOOM, not after zoomend + debounce
    // (a zoom-out used to leave the whole trace invisible until then).
    let lastElevated = getRouteElevationContext(map).elevated;
    const onZoom = () => {
      const elevated = getRouteElevationContext(map).elevated;
      if (elevated === lastElevated) return;
      lastElevated = elevated;
      if (!replayRouteState()) scheduleReplayRouteState();
    };
    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    map.on('zoomend', onStyleData);
    map.on('zoom', onZoom);
    map.on('terrain', onStyleData);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      forceReplayPendingRef.current = false;
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleData);
      map.off('zoomend', onStyleData);
      map.off('zoom', onZoom);
      map.off('terrain', onStyleData);
    };
  }, [isMapLoaded, map, replayRouteState, scheduleReplayRouteState]);
}
