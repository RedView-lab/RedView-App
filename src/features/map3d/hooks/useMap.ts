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
const SW_CONTROLLER_TIMEOUT = 2500;
const DEFAULT_ORTHO_BOOT_FALLBACK_MS = 1500;
// User-initiated reload should feel reactive; 5 s is enough to absorb a
// double-click without throttling a legitimate retry after a failed first
// attempt (which is exactly when users want to reload).
const DEM_RELOAD_COOLDOWN_MS = 5000;
// Maximum age (ms) before a still-pending tile request is considered orphan
// and pruned from the tracking set. Aborted tiles on a fast fly never emit
// a matching `sourcedata` so without this the bar can latch at 60-99 %.
const PENDING_TILE_MAX_AGE_MS = 6000;
// How long the map must remain idle (no pending tiles, no movement) before we
// declare loading complete. Short enough to feel snappy, long enough to absorb
// the gap between two camera-driven tile bursts (zoom cascade, inertia).
const DEM_ACTIVITY_SETTLE_MS = 380;
// Stale-loading watchdog: if the dock has been > 99% for this long while the
// map keeps reporting unfinished tiles, force a re-evaluation so we don't
// freeze on "99 %". Must be larger than the network timeout for a single tile.
// 8 s aligns with the plain-Mapbox safety net below and keeps perceived
// stalls under the 10 s "abandon" threshold for users on slow networks.
const LOADING_WATCHDOG_MS = 8_000;
// Sources whose tile activity should feed the global "Carte" progress bar.
// `background` and vector glyph/sprite sources never fire tile events; the
// IGN ortho is a `raster` source, the unified DEM is `raster-dem`, and Mapbox
// satellite/streets baseline tiles are also `raster`. Tracking all of them
// gives a faithful end-to-end picture of "is the camera fully painted yet".
const TRACKED_SOURCE_TYPES = new Set(['raster', 'raster-dem']);

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

interface MapRuntimeProfile {
  antialias: boolean;
  minTileCacheSize: number;
  maxTileCacheSize: number;
  orthoBootFallbackMs: number;
}

function getMapRuntimeProfile(): MapRuntimeProfile {
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      saveData?: boolean;
    };
    deviceMemory?: number;
    userAgentData?: {
      mobile?: boolean;
    };
  };

  const ua = (nav.userAgent || '').toLowerCase();
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = nav.hardwareConcurrency || 0;
  const effectiveType = nav.connection?.effectiveType ?? '';
  const saveData = !!nav.connection?.saveData;
  const isMobile = !!nav.userAgentData?.mobile || /android|iphone|ipad|ipod|mobile/.test(ua);

  const constrainedDevice = saveData
    || effectiveType === 'slow-2g'
    || effectiveType === '2g'
    || isMobile
    || (mem > 0 && mem <= 4)
    || (cores > 0 && cores <= 4);
  if (constrainedDevice) {
    return {
      antialias: false,
      minTileCacheSize: 240,
      maxTileCacheSize: 800,
      orthoBootFallbackMs: 2400,
    };
  }

  const balancedDevice = effectiveType === '3g'
    || (mem > 0 && mem <= 8)
    || (cores > 0 && cores <= 6);
  if (balancedDevice) {
    return {
      antialias: true,
      minTileCacheSize: 320,
      maxTileCacheSize: 1000,
      orthoBootFallbackMs: 1800,
    };
  }

  return {
    antialias: true,
    minTileCacheSize: 400,
    maxTileCacheSize: 1200,
    orthoBootFallbackMs: DEFAULT_ORTHO_BOOT_FALLBACK_MS,
  };
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

async function waitForServiceWorkerController(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

  return await new Promise<ServiceWorker | null>((resolve) => {
    let settled = false;
    const finish = (controller: ServiceWorker | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(controller);
    };

    const onControllerChange = () => finish(navigator.serviceWorker.controller);
    const timer = setTimeout(() => finish(navigator.serviceWorker.controller), timeoutMs);

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

// Resolves to true when the SW is controlling this page AND has acknowledged
// the Mapbox token. Resolves to false on any failure â€” the caller should
// proceed without SW interception (graceful degradation to plain Mapbox).
const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw-dem.js', { scope: '/' });

    // Wait until an SW is active AND controlling this page
    const controller = await waitForServiceWorkerController(SW_CONTROLLER_TIMEOUT);
    if (!controller) {
      console.warn('[sw-dem] No controller after registration timeout - proceeding without IGN enhancement');
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
    let loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
    let lastReportedState: 'loading' | 'ready' | 'error' = 'loading';
    let disposeTerrainBootstrap: (() => void) | null = null;
    // Multi-source tile tracking: every raster / raster-dem source that emits
    // tile activity feeds these counters. Keys are `${sourceId}:${tileId}` to
    // avoid collisions between sources sharing the same z/x/y.
    const requestedTiles = new Set<string>();
    const loadedTiles = new Set<string>();
    const trackedSourceIds = new Set<string>();
    // Wall-clock when each pending tile was first requested. Used to evict
    // orphans that Mapbox aborted without firing `dataabort` (happens when
    // the camera is panned faster than the SW can drain its queue).
    const requestedAt = new Map<string, number>();

    const dropTrackedTile = (tileKey: string) => {
      requestedTiles.delete(tileKey);
      loadedTiles.delete(tileKey);
      requestedAt.delete(tileKey);
    };

    const pruneStalePendingTiles = () => {
      if (requestedAt.size === 0) return false;
      const now = Date.now();
      let pruned = false;
      for (const [key, ts] of requestedAt) {
        if (loadedTiles.has(key)) continue;
        if (now - ts < PENDING_TILE_MAX_AGE_MS) continue;
        dropTrackedTile(key);
        pruned = true;
      }
      return pruned;
    };

    const refreshTrackedSourceIds = () => {
      trackedSourceIds.clear();
      const styleSources = map.getStyle()?.sources ?? {};
      for (const [sourceId, source] of Object.entries(styleSources)) {
        if (TRACKED_SOURCE_TYPES.has((source as { type?: string }).type ?? '')) {
          trackedSourceIds.add(sourceId);
        }
      }
    };

    const isTrackedSource = (sourceId: string | undefined | null): boolean => {
      if (!sourceId) return false;
      return trackedSourceIds.has(sourceId);
    };

    const buildTileKey = (event: mapboxgl.MapSourceDataEvent): string | null => {
      const tileKey = getDemTileKey(event as DemSourceDataLike);
      if (!tileKey) return null;
      return `${event.sourceId}:${tileKey}`;
    };

    const allTilesLoaded = (): boolean => {
      try {
        if (!map.loaded()) return false;
        const fn = (map as unknown as { areTilesLoaded?: () => boolean }).areTilesLoaded;
        if (typeof fn === 'function') return fn.call(map);
        return true;
      } catch {
        return false;
      }
    };

    const clearDemTracking = () => {
      requestedTiles.clear();
      loadedTiles.clear();
      requestedAt.clear();
      if (demSettleTimer) {
        clearTimeout(demSettleTimer);
        demSettleTimer = null;
      }
      if (loadingWatchdog) {
        clearTimeout(loadingWatchdog);
        loadingWatchdog = null;
      }
    };

    const reportMapStatus = (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => {
      lastReportedState = state;
      if (state !== 'loading' && loadingWatchdog) {
        clearTimeout(loadingWatchdog);
        loadingWatchdog = null;
      }
      onLoadStatusChangeRef.current?.(createOverlayStatus({
        id: 'map',
        label: 'Carte',
        state,
        progress,
        detail,
        reloadable: Boolean(registerReloadRef.current),
      }));
    };

    const armLoadingWatchdog = () => {
      if (loadingWatchdog) clearTimeout(loadingWatchdog);
      loadingWatchdog = setTimeout(() => {
        loadingWatchdog = null;
        if (cancelled || !demTrackingEnabled) return;
        // Forced re-evaluation: if Mapbox reports everything as loaded, finish;
        // otherwise reset the request counter to the currently-pending set so
        // the bar stops being stuck at 99 % from stale entries.
        if (allTilesLoaded() && !map.isMoving()) {
          finishDemActivity('Carte prête');
        } else {
          // Drop completed tiles AND stale-pending tiles so the next progress
          // tick re-bases on the live pending count.
          for (const key of Array.from(requestedTiles)) {
            if (loadedTiles.has(key)) dropTrackedTile(key);
          }
          pruneStalePendingTiles();
          publishDemProgress('Tuiles en attente');
          armLoadingWatchdog();
        }
      }, LOADING_WATCHDOG_MS);
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
      const requested = requestedTiles.size;
      const loaded = loadedTiles.size;
      // No pending tile activity at all: defer the verdict to `idle` /
      // `allTilesLoaded()` so we don't flip to 0 % between bursts.
      if (requested === 0) return;
      const ratio = loaded / Math.max(requested, 1);
      // Cap at 99 while at least one tile is still in-flight; only the idle /
      // settle path is allowed to publish 100 (and switch to "ready").
      const pct = loaded >= requested
        ? (allTilesLoaded() && !map.isMoving() ? 100 : 99)
        : Math.max(1, Math.min(99, Math.round(ratio * 100)));
      if (pct >= 100) {
        finishDemActivity(detail);
        return;
      }
      reportMapStatus('loading', pct, detail);
      armLoadingWatchdog();
    };

    const scheduleDemSettle = () => {
      if (!demTrackingEnabled) return;
      if (demSettleTimer) clearTimeout(demSettleTimer);
      demSettleTimer = setTimeout(() => {
        demSettleTimer = null;
        if (cancelled) return;
        if (allTilesLoaded() && !map.isMoving()) {
          finishDemActivity('Carte prête');
        } else if (lastReportedState !== 'loading') {
          // New tile activity sneaked in after a "ready" tick: fall back into
          // loading mode and let the standard tracker drive the bar.
          reportMapStatus('loading', 99, 'Tuiles');
          armLoadingWatchdog();
        }
      }, DEM_ACTIVITY_SETTLE_MS);
    };

    const refreshDemSource = () => {
      disposeTerrainBootstrap?.();
      disposeTerrainBootstrap = null;

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
      refreshTrackedSourceIds();

      terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
    };

    const armTerrainBootstrap = (onReady: () => void) => {
      disposeTerrainBootstrap?.();

      let applied = false;
      const onSourceData = (event: mapboxgl.MapSourceDataEvent) => {
        if (applied) return;
        if (event.sourceId !== unifiedDEMSource.id) return;
        if (!event.isSourceLoaded) return;
        applied = true;
        map.off('sourcedata', onSourceData);
        disposeTerrainBootstrap = null;
        terrainRef.current?.init();
        reportMapStatus('loading', 82, 'Terrain');
        onReady();
      };

      disposeTerrainBootstrap = () => {
        map.off('sourcedata', onSourceData);
      };

      map.on('sourcedata', onSourceData);

      if (map.isSourceLoaded(unifiedDEMSource.id)) {
        onSourceData({ sourceId: unifiedDEMSource.id, isSourceLoaded: true } as mapboxgl.MapSourceDataEvent);
      }
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
      armTerrainBootstrap(() => {
        // Re-arm live tracking after the new DEM source has emitted its first
        // tile; the global `idle` watcher will close the session once Mapbox
        // confirms every tracked source is fully painted.
        demTrackingEnabled = true;
        scheduleDemSettle();
      });
    };

    registerReloadRef.current?.(reloadMapElevation);

    reportMapStatus('loading', 6, 'Initialisation');

    const savedVp = initialViewport ?? loadViewport();
    const runtimeProfile = getMapRuntimeProfile();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: savedVp?.center ?? DEFAULT_VIEW.center,
      zoom: savedVp?.zoom ?? DEFAULT_VIEW.zoom,
      pitch: savedVp?.pitch ?? DEFAULT_VIEW.pitch,
      bearing: savedVp?.bearing ?? DEFAULT_VIEW.bearing,
      projection: DEFAULT_VIEW.projection,
      antialias: runtimeProfile.antialias,
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
      maxTileCacheSize: runtimeProfile.maxTileCacheSize,
      minTileCacheSize: runtimeProfile.minTileCacheSize,
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
      refreshTrackedSourceIds();
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
        // Hand readiness over to the `idle` watcher set up below so we don't
        // flash 100 % while the native satellite tiles are still painting.
        demTrackingEnabled = true;
        reportMapStatus('loading', 80, 'Tuiles satellites');
        const finishOnIdle = () => {
          if (cancelled) return;
          if (!allTilesLoaded() || map.isMoving()) return;
          map.off('idle', finishOnIdle);
          finishDemActivity('Carte prête');
        };
        map.on('idle', finishOnIdle);
        // Safety net: if `idle` never fires (extreme network), unblock after
        // 8 s so the UI is never permanently stuck mid-bar.
        setTimeout(() => {
          if (cancelled) return;
          if (lastReportedState === 'ready') return;
          finishDemActivity('Carte prête');
        }, 8000);
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
        refreshTrackedSourceIds();
        // Enable live tile tracking now that all tracked sources exist; do NOT
        // call finishDemActivity() here. The `idle` event below is the only
        // authority allowed to flip the dock to "ready", so we wait until
        // every raster + raster-dem tile has actually painted.
        demTrackingEnabled = true;
        scheduleDemSettle();
      };

      orthoBootTimer = setTimeout(() => {
        void addOrthoWhenReady();
      }, runtimeProfile.orthoBootFallbackMs);

      armTerrainBootstrap(() => {
        void addOrthoWhenReady();
      });

      const onTrackedSourceDataLoading = (event: mapboxgl.MapSourceDataEvent) => {
        if (!demTrackingEnabled) return;
        if (!isTrackedSource(event.sourceId)) return;
        const tileKey = buildTileKey(event);
        if (!tileKey) return;
        if (!requestedTiles.has(tileKey)) requestedAt.set(tileKey, Date.now());
        requestedTiles.add(tileKey);
        publishDemProgress('Tuiles');
      };

      const onTrackedSourceData = (event: mapboxgl.MapSourceDataEvent) => {
        if (!demTrackingEnabled) return;
        if (!isTrackedSource(event.sourceId)) return;
        const tileKey = buildTileKey(event);
        if (tileKey) {
          requestedTiles.add(tileKey);
          loadedTiles.add(tileKey);
          requestedAt.delete(tileKey);
          publishDemProgress('Tuiles');
        }
        if (event.isSourceLoaded) {
          scheduleDemSettle();
        }
      };

      // Mapbox 3.x fires `dataabort` for tiles cancelled before they finish
      // (typical on rapid fly-to: previous viewport's tiles get aborted). If
      // we don't drop them from `requestedTiles`, the progress denominator
      // stays inflated and the bar appears stuck mid-load.
      const onTrackedSourceAbort = (event: mapboxgl.MapSourceDataEvent) => {
        if (!demTrackingEnabled) return;
        if (!isTrackedSource(event.sourceId)) return;
        const tileKey = buildTileKey(event);
        if (!tileKey) return;
        dropTrackedTile(tileKey);
        publishDemProgress('Tuiles');
      };

      // Tile-level errors (404 from IGN edge, network failures) are also
      // terminal: the request will never produce a matching `sourcedata`. Drop
      // the tile so it does not clog the progress denominator.
      const onTrackedTileError = (event: mapboxgl.ErrorEvent & { sourceId?: string }) => {
        const sourceId = (event as unknown as { sourceId?: string }).sourceId;
        if (!sourceId || !isTrackedSource(sourceId)) return;
        const tileKey = buildTileKey(event as unknown as mapboxgl.MapSourceDataEvent);
        if (tileKey) dropTrackedTile(tileKey);
      };

      // The `idle` event is Mapbox's authoritative "all tiles painted, no
      // animation pending" signal. It is the ONLY place we are allowed to
      // declare the map fully ready.
      const onMapIdle = () => {
        if (!demTrackingEnabled || cancelled) return;
        if (!allTilesLoaded()) return;
        if (map.isMoving()) return;
        finishDemActivity('Carte prête');
      };

      // While the camera is moving Mapbox will queue a fresh tile burst as
      // soon as it stops; immediately revert the bar to "loading" so the user
      // sees the upcoming work instead of a misleading "ready" flash. Also
      // prune stale-pending tiles aggressively at this point so a fly-to to a
      // brand-new region doesn't drag the previous viewport's orphans along.
      const onMovestart = () => {
        if (!demTrackingEnabled || cancelled) return;
        if (pruneStalePendingTiles()) publishDemProgress('Tuiles');
        if (allTilesLoaded()) return;
        if (lastReportedState === 'ready') {
          reportMapStatus('loading', 5, 'Déplacement');
        }
      };

      map.on('sourcedataloading', onTrackedSourceDataLoading);
      map.on('sourcedata', onTrackedSourceData);
      map.on('dataabort', onTrackedSourceAbort);
      map.on('error', onTrackedTileError);
      map.on('moveend', scheduleDemSettle);
      map.on('zoomend', scheduleDemSettle);
      map.on('movestart', onMovestart);
      map.on('idle', onMapIdle);

      setIsLoaded(true);

      return () => {
        map.off('sourcedataloading', onTrackedSourceDataLoading);
        map.off('sourcedata', onTrackedSourceData);
        map.off('dataabort', onTrackedSourceAbort);
        map.off('error', onTrackedTileError);
        map.off('moveend', scheduleDemSettle);
        map.off('zoomend', scheduleDemSettle);
        map.off('movestart', onMovestart);
        map.off('idle', onMapIdle);
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
      disposeTerrainBootstrap?.();
      disposeTerrainBootstrap = null;
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
