import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, DEFAULT_VIEW, FOG_CONFIG } from '../lib/mapbox.config';
import { unifiedDEMSource, ignOrthoSource } from '../lib/sources';
import { ignOrthoLayer } from '../lib/layers';
import { TerrainManager } from '../lib/terrain';
import { loadViewport, saveViewport } from '../lib/viewport-persist';

mapboxgl.accessToken = MAPBOX_TOKEN;

export function useMap(containerRef: React.RefObject<HTMLDivElement | null>) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const terrainRef = useRef<TerrainManager | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Restore viewport from previous session if available
    const savedVp = loadViewport();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/standard',
      center: savedVp?.center ?? DEFAULT_VIEW.center,
      zoom: savedVp?.zoom ?? DEFAULT_VIEW.zoom,
      pitch: savedVp?.pitch ?? DEFAULT_VIEW.pitch,
      bearing: savedVp?.bearing ?? DEFAULT_VIEW.bearing,
      projection: DEFAULT_VIEW.projection,
      antialias: true,
    });

    mapRef.current = map;

    map.on('load', () => {
      // Globe atmosphere
      map.setFog(FOG_CONFIG as mapboxgl.FogSpecification);

      // Unified DEM source: IGN MNS 0.42m/px France + Mapbox 30m elsewhere
      map.addSource(unifiedDEMSource.id, {
        type: 'raster-dem',
        tiles: unifiedDEMSource.tiles,
        tileSize: unifiedDEMSource.tileSize,
        encoding: unifiedDEMSource.encoding,
        maxzoom: unifiedDEMSource.maxzoom,
      });

      // IGN orthophoto source
      map.addSource(ignOrthoSource.id, {
        type: 'raster',
        tiles: ignOrthoSource.tiles,
        tileSize: ignOrthoSource.tileSize,
        minzoom: ignOrthoSource.minzoom,
        maxzoom: ignOrthoSource.maxzoom,
        bounds: ignOrthoSource.bounds,
        attribution: ignOrthoSource.attribution,
      });

      // IGN ortho layer
      map.addLayer(ignOrthoLayer);

      // Terrain with exaggeration 1.5 (better for high-res IGN data)
      const terrain = new TerrainManager(map, unifiedDEMSource.id);
      terrain.init();
      terrainRef.current = terrain;

      setIsLoaded(true);
    });

    // Persist viewport on move (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveEnd = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const center = map.getCenter();
        saveViewport({
          center: [center.lng, center.lat],
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        });
      }, 500);
    };
    map.on('moveend', onMoveEnd);

    map.on('error', (e) => {
      console.error('[mapbox]', e.error?.message || e);
    });

    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      // Final save before teardown
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        saveViewport({
          center: [center.lng, center.lat],
          zoom: mapRef.current.getZoom(),
          pitch: mapRef.current.getPitch(),
          bearing: mapRef.current.getBearing(),
        });
      }
      terrainRef.current?.destroy();
      terrainRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [containerRef]);

  return { map: mapRef, isLoaded };
}
