import { useEffect, useMemo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  clearRouteAuditFindings,
  clearRouteEndpoints,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  type RouteEndpoint,
  setRouteAuditFindings,
  setRouteEndpoints,
  upsertRouteLayer,
} from '../lib/route-layer';
import type { ItineraryProject } from '../types';

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
          it.routeAudit?.visible ? 1 : 0,
          it.routeAudit?.findings.length ?? 0,
        ].join(':');
      })
      .join('|');
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
      setRouteAuditFindings(
        map,
        active.routeAudit?.findings ?? [],
        active.routeAudit?.visible === true,
      );
      const endpoints = collectActiveRouteEndpoints(active.timeline);
      if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
      else clearRouteEndpoints(map);
    } else {
      clearRouteAuditFindings(map);
      clearRouteEndpoints(map);
    }
  }, [active, isMapLoaded, layerSignature, map, itineraries]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      setTimeout(() => {
        try {
          removeAllRouteLayers(map);
          clearRouteAuditFindings(map);
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
            setRouteAuditFindings(
              map,
              active.routeAudit?.findings ?? [],
              active.routeAudit?.visible === true,
            );
            const endpoints = collectActiveRouteEndpoints(active.timeline);
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
