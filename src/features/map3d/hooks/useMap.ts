import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, MAPBOX_STYLE, DEFAULT_VIEW, FOG_CONFIG } from '../lib/mapbox.config';
import { unifiedDEMSource, ignOrthoSource } from '../lib/sources';
import { ignOrthoLayer } from '../lib/layers';
import { TerrainManager } from '../lib/terrain';
import { loadViewport, saveViewport } from '../lib/viewport-persist';

mapboxgl.accessToken = MAPBOX_TOKEN;

// ---------------------------------------------------------------------------
// Helpers: send token to active SW controller and wait for ACK
// ---------------------------------------------------------------------------
function sendTokenToSW(): Promise<void> {
  if (!navigator.serviceWorker.controller) return Promise.resolve();
  navigator.serviceWorker.controller.postMessage({ type: 'SET_MAPBOX_TOKEN', token: MAPBOX_TOKEN });
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'TOKEN_ACK') {
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
  });
}

// Register DEM Service Worker and wait until it's actually controlling this page.
// navigator.serviceWorker.ready only means the SW is "active" — it does NOT mean
// it's intercepting fetch events yet (clients.claim() may still be in progress).
// We must wait for controllerchange to guarantee fetch interception.
const swReady = (async () => {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Set up listener BEFORE register() so we can't miss the event
    const controllerReady = navigator.serviceWorker.controller
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        });

    await navigator.serviceWorker.register('/sw-dem.js');
    await controllerReady;

    // SW is now intercepting fetch events — send Mapbox token
    await sendTokenToSW();

    // Re-send token whenever the SW is replaced (update, restart, etc.)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[sw-dem] controllerchange — re-sending token to new SW');
      sendTokenToSW();
    });

    // Handle SW requesting the token (e.g. after SW restart with empty memory)
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'REQUEST_TOKEN') {
        console.log('[sw-dem] SW requested token — sending');
        sendTokenToSW();
      }
    });
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
          minzoom: unifiedDEMSource.minzoom,
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
      terrainRef.current = terrain;

      // Register the sourcedata listener BEFORE calling terrain.init() so the
      // event can't fire between init() and listener registration.
      let terrainVerified = false;
      const onSourceData = (e: mapboxgl.MapSourceDataEvent) => {
        if (terrainVerified) return;
        if (e.sourceId === unifiedDEMSource.id && e.isSourceLoaded) {
          terrainVerified = true;
          map.off('sourcedata', onSourceData);
          // Re-apply terrain to ensure it uses the now-available tile data
          if (terrainRef.current) {
            terrainRef.current.init();
          }
        }
      };
      map.on('sourcedata', onSourceData);

      // Now apply terrain — if tiles haven't loaded yet the listener above
      // will re-apply once they do.
      terrain.init();

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

    // Handle WebGL context loss — prevents STATUS_ACCESS_VIOLATION on GPU
    // memory pressure. Allows the browser to recover the context instead of
    // crashing the entire tab.
    const canvas = map.getCanvas();
    const onContextLost = (e: Event) => {
      e.preventDefault(); // Allow context restoration
      console.warn('[mapbox] WebGL context lost — waiting for restoration');
    };
    const onContextRestored = () => {
      console.log('[mapbox] WebGL context restored — reloading DEM source');
      const src = map.getSource(unifiedDEMSource.id);
      if (src && 'reload' in src) {
        (src as mapboxgl.RasterDemTileSource).reload();
      }
      if (terrainRef.current) {
        terrainRef.current.init();
      }
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    // Free WebGL context synchronously before reload so the new page load
    // doesn't compete with the old context for GPU memory.
    const onBeforeUnload = () => {
      terrainRef.current?.destroy();
      terrainRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // When SW recovers a token after restart, force-reload DEM source so
    // tiles that were served as flat 0m get re-fetched with real elevation.
    const onTokenRecovered = (event: MessageEvent) => {
      if (event.data?.type === 'TOKEN_RECOVERED' && mapRef.current) {
        console.log('[sw-dem] TOKEN_RECOVERED — clearing neg cache & reloading DEM source');
        const src = mapRef.current.getSource(unifiedDEMSource.id);
        if (src && 'reload' in src) {
          (src as mapboxgl.RasterDemTileSource).reload();
        }
      }
    };
    navigator.serviceWorker?.addEventListener('message', onTokenRecovered);

    return () => {
      navigator.serviceWorker?.removeEventListener('message', onTokenRecovered);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('beforeunload', onBeforeUnload);
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
