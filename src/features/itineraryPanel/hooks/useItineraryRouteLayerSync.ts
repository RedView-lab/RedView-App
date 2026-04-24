import { useEffect, useMemo } from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import {
  clearAnalysisHoverPoint,
  clearRouteEndpoints,
  getRouteLayerIds,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  setAnalysisHoverPoint,
  setRouteEndpoints,
  upsertRouteLayer,
} from '../lib/route-layer';
import type { ItineraryProject } from '../types';

const ROUTE_HOVER_QUERY_RADIUS_PX = 10;
const ROUTE_HOVER_MAX_DISTANCE_PX = 18;

type Itinerary = ItineraryProject['itineraries'][number];
type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

interface RouteHoverTarget {
  id: string;
  color: string;
  lineLayerId: string;
  glowLayerId: string;
  points: RoutePoint[];
}

interface UseItineraryRouteLayerSyncArgs {
  active: ItineraryProject['itineraries'][number] | null;
  isMapLoaded: boolean;
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
}

export function useItineraryRouteLayerSync({
  active,
  isMapLoaded,
  itineraries,
  map,
}: UseItineraryRouteLayerSyncArgs): void {
  const layerSignature = useMemo(() => {
    return itineraries
      .map((it) => {
        const len = it.gpxRoute?.points.length ?? 0;
        const head = it.gpxRoute?.points[0];
        const tail = it.gpxRoute?.points[len - 1];
        const headKey = head ? `${head.lon.toFixed(5)},${head.lat.toFixed(5)}` : '';
        const tailKey = tail ? `${tail.lon.toFixed(5)},${tail.lat.toFixed(5)}` : '';
        return [
          it.id,
          len,
          headKey,
          tailKey,
          it.color,
          it.opacity ?? 100,
          it.visible !== false ? 1 : 0,
        ].join(':');
      })
      .join('|');
  }, [itineraries]);

  const hoverTargets = useMemo<RouteHoverTarget[]>(() => {
    return itineraries
      .filter((it) => it.visible !== false && (it.gpxRoute?.points.length ?? 0) >= 2)
      .map((it) => {
        const layerIds = getRouteLayerIds(it.id);
        return {
          id: it.id,
          color: it.color,
          lineLayerId: layerIds.line,
          glowLayerId: layerIds.glow,
          points: it.gpxRoute?.points ?? [],
        };
      });
  }, [itineraries]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    for (const it of itineraries) {
      const pts = it.gpxRoute?.points;
      if (!pts || pts.length < 2) continue;
      const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
      try {
        upsertRouteLayer(map, it.id, coords, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          visible: it.visible !== false,
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
      const start = active.timeline.find((row) => row.kind === 'start');
      const end = active.timeline.find((row) => row.kind === 'end');
      const endpoints: { lon: number; lat: number; kind: 'start' | 'end' }[] = [];
      if (start && start.lat != null && start.lon != null) {
        endpoints.push({ lon: start.lon, lat: start.lat, kind: 'start' });
      }
      if (end && end.lat != null && end.lon != null) {
        endpoints.push({ lon: end.lon, lat: end.lat, kind: 'end' });
      }
      if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
      else clearRouteEndpoints(map);
    } else {
      clearRouteEndpoints(map);
    }
  }, [active, isMapLoaded, layerSignature, map, itineraries]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      setTimeout(() => {
        try {
          removeAllRouteLayers(map);
          clearRouteEndpoints(map);
          for (const it of itineraries) {
            const pts = it.gpxRoute?.points;
            if (!pts || pts.length < 2) continue;
            const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
            upsertRouteLayer(map, it.id, coords, {
              color: it.color,
              opacity01: (it.opacity ?? 100) / 100,
              visible: it.visible !== false,
            });
          }
          if (active) {
            const start = active.timeline.find((row) => row.kind === 'start');
            const end = active.timeline.find((row) => row.kind === 'end');
            const endpoints: { lon: number; lat: number; kind: 'start' | 'end' }[] = [];
            if (start && start.lat != null && start.lon != null) {
              endpoints.push({ lon: start.lon, lat: start.lat, kind: 'start' });
            }
            if (end && end.lat != null && end.lon != null) {
              endpoints.push({ lon: end.lon, lat: end.lat, kind: 'end' });
            }
            if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
          }
        } catch {
          // noop
        }
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [active, isMapLoaded, itineraries, layerSignature, map]);

  useEffect(() => {
    if (!map || !isMapLoaded || hoverTargets.length === 0) return;

    let pendingEvent: MapMouseEvent | null = null;
    let frameId: number | null = null;
    let lastMarkerKey: string | null = null;
    let ownsPointerCursor = false;

    const canvas = map.getCanvas();

    const setPointerCursor = (enabled: boolean) => {
      if (enabled) {
        if (!ownsPointerCursor && canvas.style.cursor && canvas.style.cursor !== 'pointer') return;
        ownsPointerCursor = true;
        canvas.style.cursor = 'pointer';
        return;
      }

      if (ownsPointerCursor) {
        canvas.style.cursor = '';
        ownsPointerCursor = false;
      }
    };

    const clearHover = () => {
      pendingEvent = null;
      lastMarkerKey = null;
      setPointerCursor(false);
      clearAnalysisHoverPoint(map);
    };

    const processHover = (event: MapMouseEvent) => {
      const layers = hoverTargets
        .flatMap((target) => [target.lineLayerId, target.glowLayerId])
        .filter((layerId) => Boolean(map.getLayer(layerId)));

      if (layers.length === 0) {
        clearHover();
        return;
      }

      const queryBox: [[number, number], [number, number]] = [
        [event.point.x - ROUTE_HOVER_QUERY_RADIUS_PX, event.point.y - ROUTE_HOVER_QUERY_RADIUS_PX],
        [event.point.x + ROUTE_HOVER_QUERY_RADIUS_PX, event.point.y + ROUTE_HOVER_QUERY_RADIUS_PX],
      ];

      let hoveredLayerIds: Set<string>;
      try {
        hoveredLayerIds = new Set(
          map
            .queryRenderedFeatures(queryBox, { layers })
            .map((feature) => feature.layer?.id)
            .filter((layerId): layerId is string => Boolean(layerId)),
        );
      } catch {
        clearHover();
        return;
      }

      if (hoveredLayerIds.size === 0) {
        clearHover();
        return;
      }

      let best: { target: RouteHoverTarget; lon: number; lat: number; distanceSq: number } | null = null;
      for (const target of hoverTargets) {
        if (!hoveredLayerIds.has(target.lineLayerId) && !hoveredLayerIds.has(target.glowLayerId)) {
          continue;
        }

        const snapped = findNearestRoutePointOnScreen(map, target.points, event.point);
        if (!snapped) continue;
        if (!best || snapped.distanceSq < best.distanceSq) {
          best = { target, ...snapped };
        }
      }

      if (!best || best.distanceSq > ROUTE_HOVER_MAX_DISTANCE_PX * ROUTE_HOVER_MAX_DISTANCE_PX) {
        clearHover();
        return;
      }

      setPointerCursor(true);
      const markerKey = `${best.target.id}:${best.lon.toFixed(6)}:${best.lat.toFixed(6)}:${best.target.color}`;
      if (markerKey === lastMarkerKey) return;
      lastMarkerKey = markerKey;

      setAnalysisHoverPoint(map, {
        lon: best.lon,
        lat: best.lat,
        color: best.target.color,
      });
    };

    const flushPendingHover = () => {
      frameId = null;
      const event = pendingEvent;
      pendingEvent = null;
      if (event) processHover(event);
    };

    const handleMouseMove = (event: MapMouseEvent) => {
      pendingEvent = event;
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(flushPendingHover);
    };

    const handleMouseLeave = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      clearHover();
    };

    map.on('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      map.off('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      clearHover();
    };
  }, [hoverTargets, isMapLoaded, map]);
}

function findNearestRoutePointOnScreen(
  map: MapboxMap,
  points: RoutePoint[],
  cursor: { x: number; y: number },
): { lon: number; lat: number; distanceSq: number } | null {
  if (points.length < 2) return null;

  let best: { lon: number; lat: number; distanceSq: number } | null = null;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue;

    const startPx = map.project([start.lon, start.lat]);
    const endPx = map.project([end.lon, end.lat]);
    const segmentX = endPx.x - startPx.x;
    const segmentY = endPx.y - startPx.y;
    const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
    const rawT = segmentLengthSq > 0
      ? ((cursor.x - startPx.x) * segmentX + (cursor.y - startPx.y) * segmentY) / segmentLengthSq
      : 0;
    const t = Math.max(0, Math.min(1, rawT));
    const x = startPx.x + segmentX * t;
    const y = startPx.y + segmentY * t;
    const dx = cursor.x - x;
    const dy = cursor.y - y;
    const distanceSq = dx * dx + dy * dy;

    if (best && distanceSq >= best.distanceSq) continue;
    best = {
      lon: start.lon + (end.lon - start.lon) * t,
      lat: start.lat + (end.lat - start.lat) * t,
      distanceSq,
    };
  }

  return best;
}

function isFinitePoint(point: RoutePoint): boolean {
  return Number.isFinite(point.lon) && Number.isFinite(point.lat);
}
