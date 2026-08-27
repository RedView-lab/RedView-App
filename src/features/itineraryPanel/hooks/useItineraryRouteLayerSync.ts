import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ROUTE_SLOPE_LEGEND_BANDS } from '@/features/controlPanel/lib';

import {
  clearForbiddenZoneDraft,
  clearForbiddenZones,
  clearRouteAuditFindings,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  setRouteAuditFindings,
  setForbiddenZones,
  type RouteSlopeBand,
  upsertRouteLayer,
} from '../lib/route-layer';
import { buildRouteContentSignature } from '../lib/routes';
import type { ItineraryProject } from '../types';

function canAccessStyle(map: MapboxMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

// Debounce window for coalescing bursts of styledata / sourcedata events.
// These fire repeatedly while DEM terrain tiles stream in, but the route
// geometry itself does not depend on terrain, so we batch them hard.
const REPLAY_DEBOUNCE_MS = 120;

interface UseItineraryRouteLayerSyncArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  routeTraceWidthPx?: number;
  /** When false the entire Routes section is off and NO trace renders. */
  routesEnabled?: boolean;
}

export function useItineraryRouteLayerSync({
  active,
  isMapLoaded,
  itineraries,
  map,
  routeTraceWidthPx = 8,
  routesEnabled = true,
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
          routeKey,
          it.color,
          it.opacity ?? 100,
          it.renderMode ?? 'default',
          routeTraceWidthPx,
          it.visible !== false ? 1 : 0,
          it.analysisVisible !== false ? 1 : 0,
          it.routeAudit?.visible ? 1 : 0,
          it.routeAudit?.findings.length ?? 0,
          (it.forbiddenZones ?? []).map((zone) => {
            const first = zone.points[0];
            return `${zone.id}:${zone.points.length}:${first?.lon ?? ''}:${first?.lat ?? ''}`;
          }).join(','),
        ].join(':');
      })
      .join('|');
    return `${routesEnabled ? 1 : 0}::${itinerarySignature}::bands:${routeSlopeBandSignature}`;
  }, [itineraries, routeSlopeBandSignature, routeTraceWidthPx, routesEnabled]);

  // Ref bag so the stable map listeners always read the latest values without
  // having to re-subscribe on every project mutation. Updated synchronously
  // during render so effects always see the freshest committed state.
  const stateRef = useRef({
    active,
    isMapLoaded,
    itineraries,
    map,
    routeSlopeBands,
    routeTraceWidthPx,
    routesEnabled,
    layerSignature,
  });
  stateRef.current = {
    active,
    isMapLoaded,
    itineraries,
    map,
    routeSlopeBands,
    routeTraceWidthPx,
    routesEnabled,
    layerSignature,
  };

  const replayRouteState = useCallback((force = false): boolean => {
    const {
      map: currentMap,
      isMapLoaded: loaded,
      itineraries: currentItineraries,
      active: currentActive,
      routeSlopeBands: bands,
      routeTraceWidthPx: traceWidthPx,
      layerSignature: signature,
      routesEnabled: areRoutesEnabled,
    } = stateRef.current;
    if (!currentMap || !loaded || !canAccessStyle(currentMap)) return false;

    // If nothing about the routes changed since the last successful replay,
    // skip the (expensive, O(total points)) rebuild. styledata/sourcedata storms
    // triggered by terrain tile streaming collapse here.
    if (!force && lastReplayedSignatureRef.current === signature) return true;

    for (const it of currentItineraries) {
      const pts = it.gpxRoute?.points;
      if (!pts || pts.length < 2) continue;
      // Visible iff the Routes section is active AND the user has not
      // explicitly hidden this trace. (`analysisVisible` controls the central
      // chart/profile, not the map line.)
      const routeVisible = areRoutesEnabled && it.visible !== false;
      try {
        upsertRouteLayer(currentMap, it.id, pts, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          traceWidthPx,
          visible: routeVisible,
          renderMode: it.renderMode ?? 'default',
          slopeBands: bands,
        });
      } catch (error) {
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

    if (currentActive && areRoutesEnabled) {
      setRouteAuditFindings(
        currentMap,
        currentActive.routeAudit?.findings ?? [],
        currentActive.routeAudit?.visible === true,
      );
      setForbiddenZones(currentMap, currentActive.forbiddenZones ?? []);
    } else {
      clearRouteAuditFindings(currentMap);
      clearForbiddenZones(currentMap);
      clearForbiddenZoneDraft(currentMap);
    }

    lastReplayedSignatureRef.current = signature;
    return true;
  }, []);

  const scheduleReplayRouteState = useCallback((force = false): void => {
    if (force) forceReplayPendingRef.current = true;
    // Already scheduled — the pending timer will pick up the `force` flag.
    if (replayTimerRef.current) return;
    replayTimerRef.current = setTimeout(() => {
      replayTimerRef.current = null;
      const pendingForce = forceReplayPendingRef.current;
      forceReplayPendingRef.current = false;
      replayRouteState(pendingForce);
    }, REPLAY_DEBOUNCE_MS);
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
    const onSourceData = (event: { sourceId?: string } | undefined) => {
      const terrainSourceId = map.getTerrain()?.source;
      if (!terrainSourceId || event?.sourceId !== terrainSourceId) return;
      try {
        if (!map.isSourceLoaded(terrainSourceId)) return;
      } catch {
        return;
      }
      scheduleReplayRouteState(false);
    };

    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    map.on('sourcedata', onSourceData as never);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      forceReplayPendingRef.current = false;
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleData);
      map.off('sourcedata', onSourceData as never);
    };
  }, [isMapLoaded, map, scheduleReplayRouteState]);
}
