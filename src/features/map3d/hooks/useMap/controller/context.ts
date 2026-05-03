import type { MutableRefObject } from 'react';
import type {
  FogSpecification,
  Map as MapboxMap,
  MapSourceDataEvent,
} from 'mapbox-gl';
import { unifiedDEMSource } from '../../../lib/sources';
import { TerrainManager } from '../../../lib/terrain';
import {
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '../../../lib/overlayStatus';
import type { MapRuntimeProfile } from '../runtimeProfile';
import { getDemTileKey, type DemSourceDataLike, type DemTileProfile } from '../demTiles';
import { PENDING_TILE_MAX_AGE_MS, TRACKED_SOURCE_TYPES } from '../constants';

export const MAPBOX_STANDARD_STYLE_URL = 'mapbox://styles/mapbox/standard';
export const MAPBOX_STANDARD_SATELLITE_STYLE_URL = 'mapbox://styles/mapbox/standard-satellite';
export const STYLE_LOAD_WATCHDOG_MS = 15000;

// Anti-flat reinforcement constants. Picked low enough to detect a
// flat-state regression quickly but high enough to leave Mapbox time to
// settle a freshly attached terrain graph between checks.
export const TERRAIN_HEARTBEAT_INTERVAL_MS = 5000;
export const TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD = 2;
export const DEM_SETTILE_VERIFY_MS = 3500;

export interface CreateMapLifecycleControllerOptions {
  map: MapboxMap;
  fogConfig: FogSpecification;
  runtimeProfile: MapRuntimeProfile;
  terrainRef: MutableRefObject<TerrainManager | null>;
  onLoadStatusChangeRef: MutableRefObject<OverlayStatusReporter | undefined>;
  registerReloadRef: MutableRefObject<OverlayReloadRegistrar | undefined>;
  getActiveStyleUrl: () => string;
  isCancelled: () => boolean;
}

export interface MapLifecycleController {
  reportStatus: (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => void;
  reloadMapElevation: () => void;
  prepareStyleChange: (detail?: string) => void;
  bootstrapCurrentStyle: () => Promise<boolean>;
  cleanup: () => void;
}

export type ReportStatusFn = (
  state: 'loading' | 'ready' | 'error',
  progress: number,
  detail?: string,
) => void;

/** Mutable runtime state shared across all controller modules. */
export interface ControllerState {
  demCacheBust: number;
  demTrackingEnabled: boolean;
  demReloadCoolingUntil: number;
  demPassiveRefreshCoolingUntil: number;
  demPassiveRefreshPending: boolean;
  demSettleTimer: ReturnType<typeof setTimeout> | null;
  loadingWatchdog: ReturnType<typeof setTimeout> | null;
  lastReportedState: 'loading' | 'ready' | 'error';
  lastReportedProgress: number;
  disposeTerrainBootstrap: (() => void) | null;
  disposeStyleRecovery: (() => void) | null;
  orthoBootTimer: ReturnType<typeof setTimeout> | null;
  finishOnIdle: (() => void) | null;
  readyFallbackTimer: ReturnType<typeof setTimeout> | null;
  terrainRecoveryTimer: ReturnType<typeof setTimeout> | null;
  styleBootstrapRunId: number;
  trackingListenersBound: boolean;

  reloadVerifyTimer: ReturnType<typeof setTimeout> | null;
  reloadReadinessTimer: ReturnType<typeof setTimeout> | null;
  reloadInProgress: boolean;
  reloadStyleEscalations: number;

  // anti-flat reinforcements
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatFailures: number;
  setTilesVerifyTimer: ReturnType<typeof setTimeout> | null;
  hasReportedReadyOnce: boolean;

  requestedTiles: Set<string>;
  loadedTiles: Set<string>;
  trackedSourceIds: Set<string>;
  requestedAt: Map<string, number>;
}

export interface ControllerFns {
  // helpers
  canMutateStyle: () => boolean;
  isUnifiedTerrainActive: () => boolean;
  allTilesLoaded: () => boolean;
  isTrackedSource: (sourceId: string | undefined | null) => boolean;
  buildTileKey: (event: MapSourceDataEvent) => string | null;
  refreshTrackedSourceIds: () => void;
  getActiveDemProfile: () => DemTileProfile;
  shouldUseIgnOrthoOverlay: () => boolean;
  dropTrackedTile: (tileKey: string) => void;
  pruneStalePendingTiles: () => boolean;

  // status / progress
  reportStatus: ReportStatusFn;
  finishDemActivity: (detail?: string) => void;
  publishDemProgress: (detail?: string) => void;
  armLoadingWatchdog: () => void;
  scheduleDemSettle: () => void;
  applyPendingDemPassiveRefresh: () => boolean;
  clearDemTracking: () => void;

  // dem / terrain
  applyUnifiedTerrain: () => boolean;
  refreshDemSource: (options?: { forceRebuild?: boolean }) => boolean;
  detachManagedTerrain: () => void;
  scheduleTerrainRecovery: () => void;
  scheduleSetTilesVerify: () => void;
  armTerrainBootstrap: (onReady: () => void) => void;

  // reload
  performReloadOnce: () => boolean;
  scheduleTerrainVerifyAfterReload: () => void;
  reloadMapElevation: () => void;

  // ign overlay
  addIgnOrthoOverlay: () => void;

  // style bootstrap
  prepareStyleChange: (detail?: string) => void;
  bootstrapCurrentStyle: () => Promise<boolean>;

  // listeners
  ensureTrackingListeners: () => void;
  removeTrackingListeners: () => void;
  clearStyleBootstrapArtifacts: () => void;

  // heartbeat (anti-flat)
  startTerrainHeartbeat: () => void;
  stopTerrainHeartbeat: () => void;
}

export interface Ctx extends CreateMapLifecycleControllerOptions {
  state: ControllerState;
  fns: ControllerFns;
}

export function createInitialState(): ControllerState {
  return {
    demCacheBust: 0,
    demTrackingEnabled: false,
    demReloadCoolingUntil: 0,
    demPassiveRefreshCoolingUntil: 0,
    demPassiveRefreshPending: false,
    demSettleTimer: null,
    loadingWatchdog: null,
    lastReportedState: 'loading',
    lastReportedProgress: 0,
    disposeTerrainBootstrap: null,
    disposeStyleRecovery: null,
    orthoBootTimer: null,
    finishOnIdle: null,
    readyFallbackTimer: null,
    terrainRecoveryTimer: null,
    styleBootstrapRunId: 0,
    trackingListenersBound: false,

    reloadVerifyTimer: null,
    reloadReadinessTimer: null,
    reloadInProgress: false,
    reloadStyleEscalations: 0,

    heartbeatTimer: null,
    heartbeatFailures: 0,
    setTilesVerifyTimer: null,
    hasReportedReadyOnce: false,

    requestedTiles: new Set<string>(),
    loadedTiles: new Set<string>(),
    trackedSourceIds: new Set<string>(),
    requestedAt: new Map<string, number>(),
  };
}

export function attachHelpers(ctx: Ctx): void {
  const { map, isCancelled, getActiveStyleUrl } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.canMutateStyle = () => {
    if (isCancelled()) return false;
    try {
      return map.isStyleLoaded() && Boolean(map.getStyle());
    } catch {
      return false;
    }
  };

  fns.isUnifiedTerrainActive = () => {
    try {
      return map.getTerrain()?.source === unifiedDEMSource.id;
    } catch {
      return false;
    }
  };

  fns.allTilesLoaded = () => {
    try {
      if (!map.loaded()) return false;
      const fn = (map as unknown as { areTilesLoaded?: () => boolean }).areTilesLoaded;
      if (typeof fn === 'function') return fn.call(map);
      return true;
    } catch {
      return false;
    }
  };

  fns.dropTrackedTile = (tileKey: string) => {
    st.requestedTiles.delete(tileKey);
    st.loadedTiles.delete(tileKey);
    st.requestedAt.delete(tileKey);
  };

  fns.pruneStalePendingTiles = () => {
    if (st.requestedAt.size === 0) return false;
    const now = Date.now();
    let pruned = false;
    for (const [key, ts] of st.requestedAt) {
      if (st.loadedTiles.has(key)) continue;
      if (now - ts < PENDING_TILE_MAX_AGE_MS) continue;
      fns.dropTrackedTile(key);
      pruned = true;
    }
    return pruned;
  };

  fns.refreshTrackedSourceIds = () => {
    st.trackedSourceIds.clear();
    if (!fns.canMutateStyle()) return;
    const styleSources = map.getStyle()?.sources ?? {};
    for (const [sourceId, source] of Object.entries(styleSources)) {
      if (TRACKED_SOURCE_TYPES.has((source as { type?: string }).type ?? '')) {
        st.trackedSourceIds.add(sourceId);
      }
    }
  };

  fns.isTrackedSource = (sourceId) => !!sourceId && st.trackedSourceIds.has(sourceId);

  fns.buildTileKey = (event: MapSourceDataEvent) => {
    const tileKey = getDemTileKey(event as DemSourceDataLike);
    if (!tileKey) return null;
    return `${event.sourceId}:${tileKey}`;
  };

  fns.getActiveDemProfile = () => (
    getActiveStyleUrl() === MAPBOX_STANDARD_STYLE_URL ? 'terrain' : 'default'
  );

  fns.shouldUseIgnOrthoOverlay = () => false;
}
