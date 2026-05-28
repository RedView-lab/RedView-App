import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ControlPanelSlopePersistedState } from '@/features/controlPanel/lib/persistedState';
import { SLOPE_CATEGORIES, generateDynamicCategories } from '@/features/slope/lib/slope-config';

import {
  clearForbiddenZoneDraft,
  clearForbiddenZones,
  clearRouteAuditFindings,
  clearRouteEndpoints,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  type RouteEndpoint,
  setRouteAuditFindings,
  setForbiddenZones,
  setRouteEndpoints,
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

interface UseItineraryRouteLayerSyncArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  routeTraceWidthPx?: number;
  routeSlopeConfig?: ControlPanelSlopePersistedState;
}

function routeSlopeBandCountFromSetting(setting: string | undefined): number {
  const match = setting ? /^(\d+)/.exec(setting) : null;
  const value = match ? Number(match[1]) : SLOPE_CATEGORIES.length;
  return Number.isFinite(value) && value >= 2 ? value : SLOPE_CATEGORIES.length;
}

function isLegacyFourColorSlopeConfig(config: ControlPanelSlopePersistedState): boolean {
  if (config.scaleSetting !== '4 couleurs') return false;
  if (Object.keys(config.customColors ?? {}).length > 0) return false;
  if (Object.keys(config.bandVisibility ?? {}).length > 0) return false;
  if (Object.keys(config.breakpoints?.byCount ?? {}).length > 0) return false;
  return true;
}

function buildRouteSlopeBands(
  config: ControlPanelSlopePersistedState | undefined,
): RouteSlopeBand[] {
  if (!config) {
    return SLOPE_CATEGORIES.map((category) => ({
      id: category.id,
      minDeg: category.minDeg,
      maxDeg: category.maxDeg,
      color: category.color,
    }));
  }

  const bandCount = isLegacyFourColorSlopeConfig(config)
    ? SLOPE_CATEGORIES.length
    : routeSlopeBandCountFromSetting(config.scaleSetting);
  const breakpoints = config.breakpoints?.byCount?.[bandCount];
  const categories = generateDynamicCategories(bandCount, breakpoints).map((category) => ({
    ...category,
    color: config.customColors?.[category.id] ?? category.color,
  }));

  return categories.map((category) => ({
    id: category.id,
    minDeg: category.minDeg,
    maxDeg: category.maxDeg,
    color: category.color,
  }));
}

export function useItineraryRouteLayerSync({
  active,
  isMapLoaded,
  itineraries,
  map,
  routeTraceWidthPx = 4,
  routeSlopeConfig,
}: UseItineraryRouteLayerSyncArgs): void {
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeSlopeBands = useMemo(
    () => buildRouteSlopeBands(routeSlopeConfig),
    [routeSlopeConfig],
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
    return `${itinerarySignature}::bands:${routeSlopeBandSignature}`;
  }, [itineraries, routeSlopeBandSignature, routeTraceWidthPx]);

  const replayRouteState = useCallback((): boolean => {
    if (!map || !isMapLoaded || !canAccessStyle(map)) return false;

    for (const it of itineraries) {
      const pts = it.gpxRoute?.points;
      if (!pts || pts.length < 2) continue;
      // Visible iff the user has not explicitly hidden the trace.
      // (`analysisVisible` controls the central chart/profile, not the map line.)
      const routeVisible = it.visible !== false;
      try {
        upsertRouteLayer(map, it.id, pts, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          traceWidthPx: routeTraceWidthPx,
          visible: routeVisible,
          renderMode: it.renderMode ?? 'default',
          slopeBands: routeSlopeBands,
        });
      } catch (error) {
        console.warn('[route-layer] upsert failed for', it.id, error);
      }
    }

    for (const mountedId of listMountedRouteIds(map)) {
      const stillWanted = itineraries.some(
        (it) =>
          it.id.replace(/[^a-zA-Z0-9_-]/g, '_') === mountedId &&
          it.gpxRoute &&
          it.gpxRoute.points.length >= 2,
      );
      if (!stillWanted) {
        removeRouteLayer(map, mountedId);
      }
    }

    if (active) {
      setRouteAuditFindings(
        map,
        active.routeAudit?.findings ?? [],
        active.routeAudit?.visible === true,
      );
      setForbiddenZones(map, active.forbiddenZones ?? []);
      const endpoints = collectActiveRouteEndpoints(active.timeline);
      if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
      else clearRouteEndpoints(map);
    } else {
      clearRouteAuditFindings(map);
      clearForbiddenZones(map);
      clearForbiddenZoneDraft(map);
      clearRouteEndpoints(map);
    }

    return true;
  }, [active, isMapLoaded, itineraries, map, routeSlopeBands, routeTraceWidthPx]);

  const scheduleReplayRouteState = useCallback(() => {
    if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
    replayTimerRef.current = setTimeout(() => {
      replayTimerRef.current = null;
      replayRouteState();
    }, 0);
  }, [replayRouteState]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!replayRouteState()) scheduleReplayRouteState();
  }, [isMapLoaded, layerSignature, map, replayRouteState, scheduleReplayRouteState]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      try {
        removeAllRouteLayers(map);
        clearRouteAuditFindings(map);
        clearForbiddenZones(map);
        clearForbiddenZoneDraft(map);
        clearRouteEndpoints(map);
      } catch {
        /* noop */
      }
      scheduleReplayRouteState();
    };
    const onStyleData = () => {
      scheduleReplayRouteState();
    };

    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      map.off('style.load', onStyleLoad);
      map.off('styledata', onStyleData);
    };
  }, [isMapLoaded, map, scheduleReplayRouteState]);
}

function collectActiveRouteEndpoints(
  timeline: ItineraryProject['itineraries'][number]['timeline'],
): RouteEndpoint[] {
  const endpoints: RouteEndpoint[] = [];
  const start = timeline.find((row) => row.kind === 'start');
  if (start && start.lat != null && start.lon != null) {
    endpoints.push({ lon: start.lon, lat: start.lat, kind: 'start', label: start.label });
  }

  for (const waypoint of timeline) {
    if (waypoint.kind !== 'waypoint' || waypoint.lat == null || waypoint.lon == null) continue;
    endpoints.push({
      lon: waypoint.lon,
      lat: waypoint.lat,
      kind: 'waypoint',
      label: waypoint.label,
    });
  }

  const end = timeline.find((row) => row.kind === 'end');
  if (end && end.lat != null && end.lon != null) {
    endpoints.push({ lon: end.lon, lat: end.lat, kind: 'end', label: end.label });
  }

  return endpoints;
}
