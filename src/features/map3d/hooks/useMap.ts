import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_TOKEN, MAPBOX_STYLE, DEFAULT_VIEW, FOG_CONFIG } from '../lib/mapbox.config';
import { unifiedDEMSource, ignOrthoSource } from '../lib/sources';
import { ignOrthoLayer } from '../lib/layers';
import { TerrainManager } from '../lib/terrain';
import { loadViewport, saveViewport, type MapViewport } from '../lib/viewport-persist';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '../overlayStatus';

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
const ORTHO_BOOT_FALLBACK_MS = 1500;
const DEM_RELOAD_COOLDOWN_MS = 15000;
const DEM_ACTIVITY_SETTLE_MS = 220;

type DemSourceDataLike = mapboxgl.MapSourceDataEvent & {
  coord?: {
    canonical?: { z: number; x: number; y: number };
    overscaledZ?: number;
    wrap?: number;
  };
  tile?: {
    tileID?: {
      canonical?: { z: number; x: number; y: number };
      overscaledZ?: number;
      wrap?: number;
    };
  };
};

function getDemTileKey(event: DemSourceDataLike): string | null {
  const directCanonical = event.coord?.canonical;
  if (directCanonical) {
    return `${event.coord?.overscaledZ ?? directCanonical.z}/${directCanonical.x}/${directCanonical.y}/${event.coord?.wrap ?? 0}`;
  }

  const tileId = event.tile?.tileID;
  const tileCanonical = tileId?.canonical;
  if (tileCanonical) {
    return `${tileId?.overscaledZ ?? tileCanonical.z}/${tileCanonical.x}/${tileCanonical.y}/${tileId?.wrap ?? 0}`;
  }

  return null;
}

function buildDemTilesTemplate(cacheBust: number): string[] {
  if (cacheBust <= 0) return unifiedDEMSource.tiles;
  return unifiedDEMSource.tiles.map((tile) => `${tile}?rv-dem=${cacheBust}`);
}

function waitForMapIdleOrTimeout(map: mapboxgl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.off('idle', onIdle);
      resolve();
    };
    const onIdle = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    map.on('idle', onIdle);
  });
}

function addIgnOrthoOverlay(map: mapboxgl.Map): void {
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
}

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

interface UseMapOptions {
  initialViewport?: MapViewport | null;
  onViewportChange?: (viewport: MapViewport) => void;
  onLoadStatusChange?: OverlayStatusReporter;
  registerReload?: OverlayReloadRegistrar;
}

export function useMap(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseMapOptions = {},
) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const terrainRef = useRef<TerrainManager | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const { initialViewport = null, onViewportChange, onLoadStatusChange, registerReload } = options;
  const onViewportChangeRef = useRef(onViewportChange);
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  const registerReloadRef = useRef(registerReload);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onLoadStatusChangeRef.current = onLoadStatusChange;
  }, [onLoadStatusChange]);

  useEffect(() => {
    registerReloadRef.current = registerReload;
  }, [registerReload]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let demCacheBust = 0;
    let demTrackingEnabled = false;
    let demReloadCoolingUntil = 0;
    let demSettleTimer: ReturnType<typeof setTimeout> | null = null;
    const demRequestedTiles = new Set<string>();
    const demLoadedTiles = new Set<string>();

    const clearDemTracking = () => {
      demRequestedTiles.clear();
      demLoadedTiles.clear();
      if (demSettleTimer) {
        clearTimeout(demSettleTimer);
        demSettleTimer = null;
      }
    };

    const reportMapStatus = (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => {
      onLoadStatusChangeRef.current?.(createOverlayStatus({
        id: 'map',
        label: 'Carte',
        state,
        progress,
        detail,
        reloadable: Boolean(registerReloadRef.current),
      }));
    };

    const finishDemActivity = (detail = 'Carte prête') => {
      clearDemTracking();
      if (!cancelled) {
        demTrackingEnabled = true;
        reportMapStatus('ready', 100, detail);
      }
    };

    const publishDemProgress = (detail = 'Relief HD') => {
      if (!demTrackingEnabled || cancelled) return;
      const total = Math.max(demRequestedTiles.size, demLoadedTiles.size, 1);
      const progress = Math.min(99, Math.round((demLoadedTiles.size / total) * 100));
      reportMapStatus('loading', progress, detail);
    };

    const scheduleDemSettle = () => {
      if (!demTrackingEnabled) return;
      if (demSettleTimer) clearTimeout(demSettleTimer);
      demSettleTimer = setTimeout(() => {
        demSettleTimer = null;
        if (cancelled) return;
        if (map.isSourceLoaded(unifiedDEMSource.id) && !map.isMoving()) {
          finishDemActivity('Carte prête');
        }
      }, DEM_ACTIVITY_SETTLE_MS);
    };

    const refreshDemSource = () => {
      try {
        map.setTerrain(null);
      } catch {
        /* terrain may not be set yet */
      }

      if (map.getSource(unifiedDEMSource.id)) {
        map.removeSource(unifiedDEMSource.id);
      }

      map.addSource(unifiedDEMSource.id, {
        type: 'raster-dem',
        tiles: buildDemTilesTemplate(demCacheBust),
        tileSize: unifiedDEMSource.tileSize,
        encoding: unifiedDEMSource.encoding,
        minzoom: unifiedDEMSource.minzoom,
        maxzoom: unifiedDEMSource.maxzoom,
      });

      terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
    };

    const reloadMapElevation = () => {
      const now = Date.now();
      if (now < demReloadCoolingUntil) return;
      demReloadCoolingUntil = now + DEM_RELOAD_COOLDOWN_MS;

      demTrackingEnabled = false;
      clearDemTracking();
      reportMapStatus('loading', 0, 'Rechargement relief');

      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DEM_CACHE' });
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_NEGATIVE_CACHE' });

      demCacheBust = now;
      refreshDemSource();
    };

    registerReloadRef.current?.(reloadMapElevation);

    reportMapStatus('loading', 6, 'Initialisation');

    const savedVp = initialViewport ?? loadViewport();

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
  reportMapStatus('loading', 14, 'Moteur 3D');

    let cancelled = false;
    let orthoBootTimer: ReturnType<typeof setTimeout> | null = null;

    // Wait for BOTH style.load AND swReady before adding sources.
    (async () => {
      const styleLoaded = new Promise<void>((resolve) => {
        if (map.isStyleLoaded()) {
          reportMapStatus('loading', 34, 'Style');
          return resolve();
        }
        map.once('style.load', () => {
          reportMapStatus('loading', 34, 'Style');
          resolve();
        });
      });
      await styleLoaded;
      const swOk = await swReady;
      if (cancelled) return;
      reportMapStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

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
        finishDemActivity('Carte prête');
        setIsLoaded(true);
        return;
      }

      // The Standard Satellite style already starts its own terrain requests.
      // Once the SW path is ready we switch to our unified DEM source and stop
      // the native terrain churn, otherwise cold loads compete for the same
      // Mapbox origin and the basemap can sit white until retries land.
      try {
        map.setTerrain(null);
      } catch {
        /* terrain may not be set yet on the initial style */
      }

      // DEM source
      if (!map.getSource(unifiedDEMSource.id)) {
        refreshDemSource();
      }
      reportMapStatus('loading', 68, 'Relief');

      // Terrain is applied ONCE, after the first DEM tile has loaded. Prevents
      // the "flat flicker" where setTerrain() runs against an empty source and
      // the mesh renders at zero elevation for a few frames.
      let orthoAdded = false;
      const addOrthoWhenReady = async () => {
        if (cancelled || orthoAdded) return;
        orthoAdded = true;
        await waitForMapIdleOrTimeout(map, 500);
        if (cancelled) return;
        reportMapStatus('loading', 92, 'Textures IGN');
        addIgnOrthoOverlay(map);
        finishDemActivity('Carte prête');
      };

      orthoBootTimer = setTimeout(() => {
        void addOrthoWhenReady();
      }, ORTHO_BOOT_FALLBACK_MS);

      let applied = false;
      const onSourceData = (e: mapboxgl.MapSourceDataEvent) => {
        if (applied) return;
        if (e.sourceId !== unifiedDEMSource.id) return;
        if (!e.isSourceLoaded) return;
        applied = true;
        map.off('sourcedata', onSourceData);
        terrainRef.current?.init();
        reportMapStatus('loading', 82, 'Terrain');
        void addOrthoWhenReady();
      };
      map.on('sourcedata', onSourceData);

      const onDemSourceDataLoading = (event: mapboxgl.MapSourceDataEvent) => {
        if (!demTrackingEnabled) return;
        if (event.sourceId !== unifiedDEMSource.id) return;
        const tileKey = getDemTileKey(event as DemSourceDataLike);
        if (!tileKey) return;
        demRequestedTiles.add(tileKey);
        publishDemProgress('Relief HD');
      };

      const onDemSourceData = (event: mapboxgl.MapSourceDataEvent) => {
        if (!demTrackingEnabled) return;
        if (event.sourceId !== unifiedDEMSource.id) return;
        const tileKey = getDemTileKey(event as DemSourceDataLike);
        if (tileKey) {
          demRequestedTiles.add(tileKey);
          demLoadedTiles.add(tileKey);
          publishDemProgress('Relief HD');
        }
        if (event.isSourceLoaded) {
          scheduleDemSettle();
        }
      };

      map.on('sourcedataloading', onDemSourceDataLoading);
      map.on('sourcedata', onDemSourceData);
      map.on('moveend', scheduleDemSettle);
      map.on('zoomend', scheduleDemSettle);

      setIsLoaded(true);

      return () => {
        map.off('sourcedata', onSourceData);
        map.off('sourcedataloading', onDemSourceDataLoading);
        map.off('sourcedata', onDemSourceData);
        map.off('moveend', scheduleDemSettle);
        map.off('zoomend', scheduleDemSettle);
      };
    })().catch((err) => {
      console.error('[map3d] init failed', err);
      reportMapStatus('error', 0, err instanceof Error ? err.message : 'Chargement impossible');
      setIsLoaded(true);
    });

    // Persist viewport (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const persistViewport = (viewport: MapViewport) => {
      saveViewport(viewport);
      onViewportChangeRef.current?.(viewport);
    };
    const onMoveEnd = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const center = map.getCenter();
        persistViewport({
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
      clearDemTracking();
      if (orthoBootTimer) clearTimeout(orthoBootTimer);
      if (saveTimer) clearTimeout(saveTimer);
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        persistViewport({
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
      registerReloadRef.current?.(null);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [containerRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !initialViewport) return;

    const center = map.getCenter();
    const sameViewport =
      Math.abs(center.lng - initialViewport.center[0]) < 1e-7
      && Math.abs(center.lat - initialViewport.center[1]) < 1e-7
      && Math.abs(map.getZoom() - initialViewport.zoom) < 1e-7
      && Math.abs(map.getPitch() - initialViewport.pitch) < 1e-7
      && Math.abs(map.getBearing() - initialViewport.bearing) < 1e-7;
    if (sameViewport) return;

    map.jumpTo({
      center: initialViewport.center,
      zoom: initialViewport.zoom,
      pitch: initialViewport.pitch,
      bearing: initialViewport.bearing,
    });
  }, [initialViewport]);

  return { map: mapRef, isLoaded };
}
