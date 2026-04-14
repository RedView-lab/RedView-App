import { useState, useCallback, useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { GpxRoute } from '../types';
import { parseGpxFile } from '../lib/gpx-loader';
import { addGpxRoute, removeGpxRoute, fitMapToRoute } from '../lib/gpx-layer';

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
  const layerAdded = useRef(false);

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

  // Sync GPX route display on map
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (gpxRoute) {
      addGpxRoute(map, gpxRoute.points);
      fitMapToRoute(map, gpxRoute.points);
      layerAdded.current = true;
    } else if (layerAdded.current) {
      removeGpxRoute(map);
      layerAdded.current = false;
    }

    return () => {
      if (layerAdded.current) {
        try { removeGpxRoute(map); } catch { /* */ }
        layerAdded.current = false;
      }
    };
  }, [map, isMapLoaded, gpxRoute]);

  return { gpxRoute, radiusM, gpxLoading, gpxError, setRadiusM, loadGpx, clearGpx };
}
