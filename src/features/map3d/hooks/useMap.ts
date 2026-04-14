import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, MAPBOX_STYLE, DEFAULT_VIEW, FOG_CONFIG } from '../lib/mapbox.config';
import { unifiedDEMSource, ignOrthoSource } from '../lib/sources';
import { ignOrthoLayer } from '../lib/layers';
import { TerrainManager } from '../lib/terrain';
import { loadViewport, saveViewport } from '../lib/viewport-persist';

mapboxgl.accessToken = MAPBOX_TOKEN;

// Register DEM Service Worker and send Mapbox token
const swReady = (async () => {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw-dem.js');
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: 'SET_MAPBOX_TOKEN', token: MAPBOX_TOKEN });
  } catch (e) {
    console.error('[sw-dem] Registration failed:', e);
  }
})();

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
      style: MAPBOX_STYLE,
      center: savedVp?.center ?? DEFAULT_VIEW.center,
      zoom: savedVp?.zoom ?? DEFAULT_VIEW.zoom,
      pitch: savedVp?.pitch ?? DEFAULT_VIEW.pitch,
      bearing: savedVp?.bearing ?? DEFAULT_VIEW.bearing,
      projection: DEFAULT_VIEW.projection,
      antialias: true,
      maxTileCacheSize: 800,
      minTileCacheSize: 200,
    });

    mapRef.current = map;

    // style.load fires earlier than load — terrain appears sooner
    map.on('style.load', async () => {
      // Wait for Service Worker to be ready before adding DEM source
      await swReady;

      // Globe atmosphere
      map.setFog(FOG_CONFIG as mapboxgl.FogSpecification);

      // Standard Satellite style: set daytime lighting for clearer, brighter look
      try {
        map.setConfigProperty('basemap', 'lightPreset', 'day');
      } catch {
        // Ignore if style doesn't support config properties
      }

      // Unified DEM source: IGN MNS 0.42m/px France + Mapbox 30m elsewhere
      if (!map.getSource(unifiedDEMSource.id)) {
        map.addSource(unifiedDEMSource.id, {
          type: 'raster-dem',
          tiles: unifiedDEMSource.tiles,
          tileSize: unifiedDEMSource.tileSize,
          encoding: unifiedDEMSource.encoding,
          maxzoom: unifiedDEMSource.maxzoom,
        });
      }

      // IGN orthophoto source (20cm/px France overlay on top of satellite base)
      if (!map.getSource(ignOrthoSource.id)) {
        map.addSource(ignOrthoSource.id, {
          type: 'raster',
          tiles: ignOrthoSource.tiles,
          tileSize: ignOrthoSource.tileSize,
          minzoom: ignOrthoSource.minzoom,
          maxzoom: ignOrthoSource.maxzoom,
          bounds: ignOrthoSource.bounds,
          attribution: ignOrthoSource.attribution,
        });
      }

      // IGN ortho layer
      if (!map.getLayer(ignOrthoLayer.id)) {
        map.addLayer(ignOrthoLayer);
      }

      // Terrain with natural exaggeration
      if (terrainRef.current) {
        terrainRef.current.destroy();
      }
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
