import type { MutableRefObject } from 'react';
import type {
  ErrorEvent as MapboxErrorEvent,
  FogSpecification,
  Map as MapboxMap,
  MapSourceDataEvent,
} from 'mapbox-gl';
import { ignOrthoLayer } from '../../lib/layers';
import { unifiedDEMSource, ignOrthoSource } from '../../lib/sources';
import { TerrainManager } from '../../lib/terrain';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '../../overlayStatus';
import {
  DEM_ACTIVITY_SETTLE_MS,
  DEM_PASSIVE_REFRESH_COOLDOWN_MS,
  DEM_RELOAD_COOLDOWN_MS,
  LOADING_WATCHDOG_MS,
  PENDING_TILE_MAX_AGE_MS,
  TRACKED_SOURCE_TYPES,
} from './constants';
import {
  buildDemTilesTemplate,
  getDemTileKey,
  type DemSourceDataLike,
  type DemTileProfile,
} from './demTiles';
import type { MapRuntimeProfile } from './runtimeProfile';
import { waitForMapIdleOrTimeout } from './runtimeProfile';
import { swReady } from './serviceWorker';

interface CreateMapLifecycleControllerOptions {
  map: MapboxMap;
  fogConfig: FogSpecification;
  runtimeProfile: MapRuntimeProfile;
  terrainRef: MutableRefObject<TerrainManager | null>;
  onLoadStatusChangeRef: MutableRefObject<OverlayStatusReporter | undefined>;
  registerReloadRef: MutableRefObject<OverlayReloadRegistrar | undefined>;
  getActiveStyleUrl: () => string;
  isCancelled: () => boolean;
}

const MAPBOX_STANDARD_STYLE_URL = 'mapbox://styles/mapbox/standard';

export interface MapLifecycleController {
  reportStatus: (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => void;
  reloadMapElevation: () => void;
  prepareStyleChange: (detail?: string) => void;
  bootstrapCurrentStyle: () => Promise<boolean>;
  cleanup: () => void;
}

export function createMapLifecycleController({
  map,
  fogConfig,
  runtimeProfile,
  terrainRef,
  onLoadStatusChangeRef,
  registerReloadRef,
  getActiveStyleUrl,
  isCancelled,
}: CreateMapLifecycleControllerOptions): MapLifecycleController {
  let demCacheBust = 0;
  let demTrackingEnabled = false;
  let demReloadCoolingUntil = 0;
  let demPassiveRefreshCoolingUntil = 0;
  let demPassiveRefreshPending = false;
  let demSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
  let lastReportedState: 'loading' | 'ready' | 'error' = 'loading';
  let disposeTerrainBootstrap: (() => void) | null = null;
  let disposeStyleRecovery: (() => void) | null = null;
  let orthoBootTimer: ReturnType<typeof setTimeout> | null = null;
  let finishOnIdle: (() => void) | null = null;
  let readyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let terrainRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let styleBootstrapRunId = 0;
  let trackingListenersBound = false;

  const requestedTiles = new Set<string>();
  const loadedTiles = new Set<string>();
  const trackedSourceIds = new Set<string>();
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

  const buildTileKey = (event: MapSourceDataEvent): string | null => {
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

  const isUnifiedTerrainActive = (): boolean => {
    try {
      return map.getTerrain()?.source === unifiedDEMSource.id;
    } catch {
      return false;
    }
  };

  const getActiveDemProfile = (): DemTileProfile => 'terrain';

  const shouldUseIgnOrthoOverlay = (): boolean => false;

  const applyUnifiedTerrain = (): boolean => {
    if (!map.getSource(unifiedDEMSource.id)) return false;
    try {
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
      }
      terrainRef.current.init();
      return true;
    } catch (error) {
      console.warn('[map3d] Unified terrain apply failed', error);
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

  const reportStatus = (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => {
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

  const finishDemActivity = (detail = 'Carte prête') => {
    clearDemTracking();
    if (!isCancelled()) {
      demTrackingEnabled = true;
      reportStatus('ready', 100, detail);
    }
  };

  const applyPendingDemPassiveRefresh = (): boolean => {
    if (!demPassiveRefreshPending || isCancelled() || map.isMoving()) return false;
    const now = Date.now();
    if (now < demPassiveRefreshCoolingUntil) return false;

    if (!refreshDemSource()) return false;

    demPassiveRefreshPending = false;
    demPassiveRefreshCoolingUntil = now + DEM_PASSIVE_REFRESH_COOLDOWN_MS;
    demTrackingEnabled = false;
    clearDemTracking();
    reportStatus('loading', 0, 'Affinage relief');

    armTerrainBootstrap(() => {
      demTrackingEnabled = true;
      scheduleDemSettle();
    });
    return true;
  };

  const armLoadingWatchdog = () => {
    if (loadingWatchdog) clearTimeout(loadingWatchdog);
    loadingWatchdog = setTimeout(() => {
      loadingWatchdog = null;
      if (isCancelled() || !demTrackingEnabled) return;
      if (allTilesLoaded() && !map.isMoving()) {
        finishDemActivity('Carte prête');
      } else {
        for (const key of Array.from(requestedTiles)) {
          if (loadedTiles.has(key)) dropTrackedTile(key);
        }
        pruneStalePendingTiles();
        publishDemProgress('Tuiles en attente');
        armLoadingWatchdog();
      }
    }, LOADING_WATCHDOG_MS);
  };

  const publishDemProgress = (detail = 'Relief HD') => {
    if (!demTrackingEnabled || isCancelled()) return;
    const requested = requestedTiles.size;
    const loaded = loadedTiles.size;
    if (requested === 0) return;
    const ratio = loaded / Math.max(requested, 1);
    const pct = loaded >= requested
      ? (allTilesLoaded() && !map.isMoving() ? 100 : 99)
      : Math.max(1, Math.min(99, Math.round(ratio * 100)));
    if (pct >= 100) {
      finishDemActivity(detail);
      return;
    }
    reportStatus('loading', pct, detail);
    armLoadingWatchdog();
  };

  const scheduleDemSettle = () => {
    if (!demTrackingEnabled) return;
    if (demSettleTimer) clearTimeout(demSettleTimer);
    demSettleTimer = setTimeout(() => {
      demSettleTimer = null;
      if (isCancelled()) return;
      if (allTilesLoaded() && !map.isMoving()) {
        if (applyPendingDemPassiveRefresh()) return;
        finishDemActivity('Carte prête');
      } else if (lastReportedState !== 'loading') {
        reportStatus('loading', 99, 'Tuiles');
        armLoadingWatchdog();
      }
    }, DEM_ACTIVITY_SETTLE_MS);
  };

  const refreshDemSource = (): boolean => {
    if (!navigator.serviceWorker?.controller) {
      console.warn('[map3d] DEM source refresh skipped: no active service worker controller');
      return false;
    }

    disposeTerrainBootstrap?.();
    disposeTerrainBootstrap = null;
    const tiles = buildDemTilesTemplate(demCacheBust, getActiveDemProfile());
    const existingSource = map.getSource(unifiedDEMSource.id) as {
      setTiles?: (tiles: string[]) => unknown;
    } | undefined;

    if (existingSource) {
      if (typeof existingSource.setTiles !== 'function') {
        console.warn('[map3d] DEM source refresh skipped: source cannot update tiles');
        return false;
      }
      existingSource.setTiles(tiles);
      refreshTrackedSourceIds();
      applyUnifiedTerrain();
      return true;
    }

    map.addSource(unifiedDEMSource.id, {
      type: 'raster-dem',
      tiles,
      tileSize: unifiedDEMSource.tileSize,
      encoding: unifiedDEMSource.encoding,
      minzoom: unifiedDEMSource.minzoom,
      maxzoom: unifiedDEMSource.maxzoom,
    });
    refreshTrackedSourceIds();

    terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
    applyUnifiedTerrain();
    return true;
  };

  const armTerrainBootstrap = (onReady: () => void) => {
    disposeTerrainBootstrap?.();

    let applied = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const complete = () => {
      if (applied) return;
      applied = true;
      map.off('sourcedata', onSourceData);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      disposeTerrainBootstrap = null;
      applyUnifiedTerrain();
      reportStatus('loading', 82, 'Terrain');
      onReady();
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (applied) return;
      if (event.sourceId !== unifiedDEMSource.id) return;
      if (!event.isSourceLoaded) return;
      complete();
    };

    disposeTerrainBootstrap = () => {
      map.off('sourcedata', onSourceData);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    applyUnifiedTerrain();
    map.on('sourcedata', onSourceData);

    if (map.isSourceLoaded(unifiedDEMSource.id)) {
      onSourceData({ sourceId: unifiedDEMSource.id, isSourceLoaded: true } as MapSourceDataEvent);
    } else {
      fallbackTimer = setTimeout(complete, 1200);
    }
  };

  const scheduleTerrainRecovery = () => {
    if (terrainRecoveryTimer) return;
    terrainRecoveryTimer = setTimeout(() => {
      terrainRecoveryTimer = null;
      if (isCancelled() || !map.isStyleLoaded()) return;
      if (!navigator.serviceWorker?.controller) return;

      if (!map.getSource(unifiedDEMSource.id)) {
        if (!refreshDemSource()) return;
        reportStatus('loading', 68, 'Relief');
        armTerrainBootstrap(() => {
          demTrackingEnabled = true;
          scheduleDemSettle();
        });
        return;
      }

      refreshTrackedSourceIds();
      if (!isUnifiedTerrainActive()) {
        applyUnifiedTerrain();
      }
    }, 0);
  };

  const addIgnOrthoOverlay = () => {
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
  };

  const reloadMapElevation = () => {
    const now = Date.now();
    if (now < demReloadCoolingUntil) return;
    demReloadCoolingUntil = now + DEM_RELOAD_COOLDOWN_MS;

    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DEM_CACHE' });
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_NEGATIVE_CACHE' });

    demCacheBust = now;
    if (!refreshDemSource()) {
      finishDemActivity('Relief inchangé');
      return;
    }

    demPassiveRefreshPending = false;
    demTrackingEnabled = false;
    clearDemTracking();
    reportStatus('loading', 0, 'Rechargement relief');

    armTerrainBootstrap(() => {
      demTrackingEnabled = true;
      scheduleDemSettle();
    });
  };

  const onTrackedSourceDataLoading = (event: MapSourceDataEvent) => {
    if (!demTrackingEnabled) return;
    if (!isTrackedSource(event.sourceId)) return;
    const tileKey = buildTileKey(event);
    if (!tileKey) return;
    if (!requestedTiles.has(tileKey)) requestedAt.set(tileKey, Date.now());
    requestedTiles.add(tileKey);
    publishDemProgress('Tuiles');
  };

  const onTrackedSourceData = (event: MapSourceDataEvent) => {
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

  const onTrackedSourceAbort = (event: MapSourceDataEvent) => {
    if (!demTrackingEnabled) return;
    if (!isTrackedSource(event.sourceId)) return;
    const tileKey = buildTileKey(event);
    if (!tileKey) return;
    dropTrackedTile(tileKey);
    publishDemProgress('Tuiles');
  };

  const onTrackedTileError = (event: MapboxErrorEvent & { sourceId?: string }) => {
    const sourceId = (event as unknown as { sourceId?: string }).sourceId;
    if (!sourceId || !isTrackedSource(sourceId)) return;
    const tileKey = buildTileKey(event as unknown as MapSourceDataEvent);
    if (tileKey) dropTrackedTile(tileKey);
  };

  const onMapIdle = () => {
    if (!demTrackingEnabled || isCancelled()) return;
    if (!allTilesLoaded()) return;
    if (map.isMoving()) return;
    if (applyPendingDemPassiveRefresh()) return;
    finishDemActivity('Carte prête');
  };

  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type !== 'DEM_TILE_CACHE_UPDATED') return;
    demPassiveRefreshPending = true;
    scheduleDemSettle();
  };

  const onMovestart = () => {
    if (!demTrackingEnabled || isCancelled()) return;
    if (pruneStalePendingTiles()) publishDemProgress('Tuiles');
    if (allTilesLoaded()) return;
    if (lastReportedState === 'ready') {
      reportStatus('loading', 5, 'Déplacement');
    }
  };

  const ensureTrackingListeners = () => {
    if (trackingListenersBound) return;
    map.on('sourcedataloading', onTrackedSourceDataLoading);
    map.on('sourcedata', onTrackedSourceData);
    map.on('dataabort', onTrackedSourceAbort);
    map.on('error', onTrackedTileError);
    map.on('moveend', scheduleDemSettle);
    map.on('zoomend', scheduleDemSettle);
    map.on('movestart', onMovestart);
    map.on('idle', onMapIdle);
    map.on('styledata', scheduleTerrainRecovery);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    trackingListenersBound = true;
  };

  const removeTrackingListeners = () => {
    if (!trackingListenersBound) return;
    map.off('sourcedataloading', onTrackedSourceDataLoading);
    map.off('sourcedata', onTrackedSourceData);
    map.off('dataabort', onTrackedSourceAbort);
    map.off('error', onTrackedTileError);
    map.off('moveend', scheduleDemSettle);
    map.off('zoomend', scheduleDemSettle);
    map.off('movestart', onMovestart);
    map.off('idle', onMapIdle);
    map.off('styledata', scheduleTerrainRecovery);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    trackingListenersBound = false;
  };

  const clearStyleBootstrapArtifacts = () => {
    disposeTerrainBootstrap?.();
    disposeTerrainBootstrap = null;
    disposeStyleRecovery?.();
    disposeStyleRecovery = null;
    if (orthoBootTimer) {
      clearTimeout(orthoBootTimer);
      orthoBootTimer = null;
    }
    if (readyFallbackTimer) {
      clearTimeout(readyFallbackTimer);
      readyFallbackTimer = null;
    }
    if (terrainRecoveryTimer) {
      clearTimeout(terrainRecoveryTimer);
      terrainRecoveryTimer = null;
    }
    if (finishOnIdle) {
      map.off('idle', finishOnIdle);
      finishOnIdle = null;
    }
  };

  const detachManagedTerrain = () => {
    try {
      terrainRef.current?.destroy();
    } catch {
      /* terrain teardown must stay best-effort during style rebuilds */
    }
    terrainRef.current = null;

    try {
      map.setTerrain(null);
    } catch {
      /* style may already be replacing the terrain graph */
    }
  };

  const prepareStyleChange = (detail = 'Fond de carte') => {
    demPassiveRefreshPending = false;
    demTrackingEnabled = false;
    clearDemTracking();
    clearStyleBootstrapArtifacts();
    detachManagedTerrain();
    reportStatus('loading', 18, detail);
  };

  const bootstrapCurrentStyle = async (): Promise<boolean> => {
    const runId = ++styleBootstrapRunId;
    const applyStyleDecorators = () => {
      map.setFog(fogConfig);
      if (getActiveStyleUrl() !== MAPBOX_STANDARD_STYLE_URL) {
        try {
          map.setConfigProperty('basemap', 'lightPreset', 'day');
        } catch {
          /* style may not support config properties */
        }
      }
    };
    const styleLoaded = new Promise<void>((resolve) => {
      if (map.isStyleLoaded()) {
        reportStatus('loading', 34, 'Style');
        resolve();
        return;
      }
      map.once('style.load', () => {
        reportStatus('loading', 34, 'Style');
        resolve();
      });
    });

    await styleLoaded;
    if (isCancelled() || runId !== styleBootstrapRunId) return false;

    refreshTrackedSourceIds();
    const swOk = await swReady;
    if (isCancelled() || runId !== styleBootstrapRunId) return false;

    reportStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

    applyStyleDecorators();

    if (!swOk) {
      console.warn('[map3d] Running in plain-Mapbox mode (no IGN DEM/ortho overlay)');
      demTrackingEnabled = true;
      reportStatus('loading', 80, 'Tuiles satellites');
      finishOnIdle = () => {
        if (isCancelled() || runId !== styleBootstrapRunId) return;
        if (!allTilesLoaded() || map.isMoving()) return;
        map.off('idle', finishOnIdle!);
        finishOnIdle = null;
        finishDemActivity('Carte prête');
      };
      map.on('idle', finishOnIdle);
      readyFallbackTimer = setTimeout(() => {
        readyFallbackTimer = null;
        if (isCancelled() || runId !== styleBootstrapRunId) return;
        if (lastReportedState === 'ready') return;
        finishDemActivity('Carte prête');
      }, 8000);
      return false;
    }

    ensureTrackingListeners();

    detachManagedTerrain();

    if (!map.getSource(unifiedDEMSource.id)) {
      refreshDemSource();
    }
    reportStatus('loading', 68, 'Relief');

    let orthoAdded = false;
    const finishStyleBootstrapWhenReady = async () => {
      if (isCancelled() || runId !== styleBootstrapRunId || orthoAdded) return;
      orthoAdded = true;
      await waitForMapIdleOrTimeout(map, 500);
      if (isCancelled() || runId !== styleBootstrapRunId) return;
      reportStatus('loading', 92, shouldUseIgnOrthoOverlay() ? 'Textures IGN' : 'Fond de carte');
      if (shouldUseIgnOrthoOverlay()) {
        addIgnOrthoOverlay();
      }
      refreshTrackedSourceIds();
      demTrackingEnabled = true;
      scheduleDemSettle();
    };

    const recoverStyleArtifacts = () => {
      if (isCancelled() || runId !== styleBootstrapRunId) return;

      applyStyleDecorators();
      orthoAdded = false;

      try {
        map.setTerrain(null);
      } catch {
        /* terrain may already have been dropped by the style reload */
      }

      if (!map.getSource(unifiedDEMSource.id)) {
        refreshDemSource();
      } else {
        refreshTrackedSourceIds();
      }

      reportStatus('loading', 68, 'Relief');
      armTerrainBootstrap(() => {
        void finishStyleBootstrapWhenReady();
      });
    };

    map.on('style.load', recoverStyleArtifacts);
    disposeStyleRecovery = () => {
      map.off('style.load', recoverStyleArtifacts);
    };

    orthoBootTimer = setTimeout(() => {
      void finishStyleBootstrapWhenReady();
    }, runtimeProfile.orthoBootFallbackMs);

    armTerrainBootstrap(() => {
      void finishStyleBootstrapWhenReady();
    });

    return true;
  };

  const cleanup = () => {
    clearDemTracking();
    clearStyleBootstrapArtifacts();
    removeTrackingListeners();
  };

  return {
    reportStatus,
    reloadMapElevation,
    prepareStyleChange,
    bootstrapCurrentStyle,
    cleanup,
  };
}