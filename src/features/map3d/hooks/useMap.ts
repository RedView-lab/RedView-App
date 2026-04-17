import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, MAPBOX_STYLE, DEFAULT_VIEW, FOG_CONFIG } from '../lib/mapbox.config';
import { unifiedDEMSource, ignOrthoSource } from '../lib/sources';
import { ignOrthoLayer } from '../lib/layers';
import { TerrainManager } from '../lib/terrain';
import { loadViewport, saveViewport } from '../lib/viewport-persist';

mapboxgl.accessToken = MAPBOX_TOKEN;

// ---------------------------------------------------------------------------
// Service Worker bootstrap â€” deterministic contract:
//   register â†’ activated â†’ controller â†’ token ACK â†’ READY
// No tile request is issued before the SW reports READY. If the SW can't be
// made ready, the app continues WITHOUT SW interception (Mapbox GL falls back
// to its native DEM/satellite sources â€” identical to "plain Mapbox" behaviour).
// ---------------------------------------------------------------------------

const TOKEN_ACK_TIMEOUT = 1500; // ms per attempt
const TOKEN_ACK_MAX_ATTEMPTS = 3;

async function sendTokenWithAck(controller: ServiceWorker): Promise<boolean> {
  for (let attempt = 1; attempt <= TOKEN_ACK_MAX_ATTEMPTS; attempt++) {
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        resolve(false);
      }, TOKEN_ACK_TIMEOUT);
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type === 'TOKEN_ACK') {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message', onMsg);
          resolve(true);
        }
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
    });

    controller.postMessage({ type: 'SET_MAPBOX_TOKEN', token: MAPBOX_TOKEN });
    const ok = await ack;
    if (ok) return true;
    console.warn(`[sw-dem] TOKEN_ACK missed (attempt ${attempt}/${TOKEN_ACK_MAX_ATTEMPTS})`);
  }
  return false;
}

// Resolves to true when the SW is controlling this page AND has acknowledged
// the Mapbox token. Resolves to false on any failure â€” the caller should
// proceed without SW interception (graceful degradation to plain Mapbox).
const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw-dem.js', { scope: '/' });

    // Wait until an SW is active AND controlling this page
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      console.error('[sw-dem] No controller after registration');
      return false;
    }

    const acked = await sendTokenWithAck(controller);
    if (!acked) {
      console.error('[sw-dem] Token ACK failed â€” proceeding without IGN enhancement');
      return false;
    }

    // Re-send token on SW updates (new controller takes over mid-session)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const c = navigator.serviceWorker.controller;
      if (c) sendTokenWithAck(c).catch(() => {});
    });

    // SW asked for token (cold activation with empty memory)
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      if (e.data?.type === 'REQUEST_TOKEN') {
        const c = navigator.serviceWorker.controller;
        if (c) sendTokenWithAck(c).catch(() => {});
      }
    });

    return true;
  } catch (e) {
    console.error('[sw-dem] Registration failed:', e);
    return false;
  }
})();

// ---------------------------------------------------------------------------
// useMap hook
// ---------------------------------------------------------------------------

export function useMap(containerRef: React.RefObject<HTMLDivElement | null>) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const terrainRef = useRef<TerrainManager | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

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
      // CRITICAL FOR GLASSMORPHISM (CSS `backdrop-filter` over the map):
      // With the default (false), Chromium is allowed to discard the WebGL
      // back-buffer immediately after compositing each frame. When the
      // compositor then needs to read the canvas pixels to build the backdrop
      // image for a `backdrop-filter` blur on an overlay panel, the buffer is
      // already empty -> the panel blurs nothing and looks flat. Forcing the
      // buffer to be preserved keeps the canvas content available as a
      // backdrop source so the frosted-glass effect actually shows the map.
      preserveDrawingBuffer: true,
      // Sized for SaaS production use on laptops/desktops: at ~60 KB per raster
      // tile in VRAM, 1200 tiles ≈ 70 MB — well below any discrete-GPU budget
      // and roughly matching the tile count needed to cover a full-France
      // dezoom at z9 + zoom-in to z14 without re-fetch churn. Low minimum keeps
      // mobile devices happy: the cache only grows when actually needed.
      maxTileCacheSize: 1200,
      minTileCacheSize: 400,
    });

    mapRef.current = map;

    let cancelled = false;

    // Wait for BOTH style.load AND swReady before adding sources.
    (async () => {
      const styleLoaded = new Promise<void>((resolve) => {
        if (map.isStyleLoaded()) return resolve();
        map.once('style.load', () => resolve());
      });
      const [, swOk] = await Promise.all([styleLoaded, swReady]);
      if (cancelled) return;

      // Atmosphere + lighting
      map.setFog(FOG_CONFIG as mapboxgl.FogSpecification);
      try {
        map.setConfigProperty('basemap', 'lightPreset', 'day');
      } catch {
        /* style may not support config properties */
      }

      if (!swOk) {
        // Plain Mapbox mode: SW is unavailable. Don't add /dem-tiles/ or
        // /ortho-tiles/ sources â€” they would 404. The Standard Satellite style
        // already ships its own terrain + satellite imagery.
        console.warn('[map3d] Running in plain-Mapbox mode (no IGN DEM/ortho overlay)');
        setIsLoaded(true);
        return;
      }

      // DEM source
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

      // IGN ortho overlay
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
      if (!map.getLayer(ignOrthoLayer.id)) {
        map.addLayer(ignOrthoLayer);
      }

      // Terrain is applied ONCE, after the first DEM tile has loaded. Prevents
      // the "flat flicker" where setTerrain() runs against an empty source and
      // the mesh renders at zero elevation for a few frames.
      terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
      let applied = false;
      const onSourceData = (e: mapboxgl.MapSourceDataEvent) => {
        if (applied) return;
        if (e.sourceId !== unifiedDEMSource.id) return;
        if (!e.isSourceLoaded) return;
        applied = true;
        map.off('sourcedata', onSourceData);
        terrainRef.current?.init();
      };
      map.on('sourcedata', onSourceData);

      setIsLoaded(true);
    })().catch((err) => {
      console.error('[map3d] init failed', err);
      setIsLoaded(true);
    });

    // Persist viewport (debounced)
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
      cancelled = true;
      if (saveTimer) clearTimeout(saveTimer);
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
