import { useState, useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { GpxRoute } from '../types';
import { parseGpxFile } from '../lib/gpx-loader';
import { addGpxRoute, removeGpxRoute, fitMapToRoute, isGpxRouteOnMap } from '../lib/gpx-layer';

export interface UseGpxRouteReturn {
  gpxRoute: GpxRoute | null;
  radiusM: number;
  gpxLoading: boolean;
  gpxError: string | null;
  setRadiusM: (v: number) => void;
  loadGpx: (file: File) => void;
  clearGpx: () => void;
}

export function useGpxRoute(
  map: MapboxMap | null,
  isMapLoaded: boolean,
): UseGpxRouteReturn {
  const [gpxRoute, setGpxRoute] = useState<GpxRoute | null>(null);
  const [radiusM, setRadiusM] = useState(1000);
  const [gpxLoading, setGpxLoading] = useState(false);
  const [gpxError, setGpxError] = useState<string | null>(null);
  const routeRef = useRef<GpxRoute | null>(null);
  routeRef.current = gpxRoute;

  const loadGpx = useCallback((file: File) => {
    setGpxLoading(true);
    setGpxError(null);

    parseGpxFile(file)
      .then((route) => {
        setGpxRoute(route);
      })
      .catch((err: unknown) => {
        setGpxError(err instanceof Error ? err.message : 'Erreur GPX');
      })
      .finally(() => setGpxLoading(false));
  }, []);

  const clearGpx = useCallback(() => {
    setGpxRoute(null);
    setGpxError(null);
  }, []);

  // Add / remove GPX layer on map
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (gpxRoute) {
      addGpxRoute(map, gpxRoute.points);
      fitMapToRoute(map, gpxRoute.points);
    } else {
      removeGpxRoute(map);
    }

    return () => {
      try { removeGpxRoute(map); } catch { /* */ }
    };
  }, [map, isMapLoaded, gpxRoute]);

  // Re-add GPX after style reloads (Standard Satellite fires style.load
  // multiple times as imports/terrain finish loading, wiping custom layers)
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      const route = routeRef.current;
      if (route && !isGpxRouteOnMap(map)) {
        // Style reload wiped our layers — re-add them
        try { addGpxRoute(map, route.points); } catch { /* */ }
      }
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded]);

  return { gpxRoute, radiusM, gpxLoading, gpxError, setRadiusM, loadGpx, clearGpx };
}
