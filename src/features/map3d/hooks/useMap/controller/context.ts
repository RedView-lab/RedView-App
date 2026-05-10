import type { MutableRefObject } from 'react';
import type {
  FogSpecification,
  Map as MapboxMap,
  MapSourceDataEvent,
} from 'mapbox-gl';
import { awsFallbackDEMSource, unifiedDEMSource } from '../../../lib/sources';
import { TerrainManager } from '../../../lib/terrain';
import {
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '../../../lib/overlayStatus';
import type { MapRuntimeProfile } from '../runtimeProfile';
import { getDemTileKey, type DemSourceDataLike, type DemTileProfile } from '../demTiles';
import { PENDING_TILE_MAX_AGE_MS, TRACKED_SOURCE_TYPES } from '../constants';

export type BasemapVisualFamily = 'mapbox-standard-v3' | 'mapbox-classic-v12';
export type TerrainBootstrapContract = 'unified-dem-v1';
// Event-driven style readiness — the bootstrap waits indefinitely for
// real Mapbox signals (style.load / styledata-with-content / sourcedata
// / first idle) instead of guessing at a timeout. This constant only
// gates a periodic telemetry warning so a genuinely stuck style is still
// observable in the console; it does not soft-fail the bootstrap.
export const STYLE_READINESS_TELEMETRY_INTERVAL_MS = 15000;

// Legacy alias kept for downstream modules that still derive recovery
// budgets from a single watchdog constant. No longer used to gate the
// bootstrap promise itself.
export const STYLE_LOAD_WATCHDOG_MS = 5000;

// Root-level safety net: if no real Mapbox readiness signal
// (`style.load` / `styledata` with content / `sourcedata` / first
// `idle`) has fired within this window, we force-engage the sprite-
// storm bypass and resume the bootstrap. This catches the cold
// Standard-Satellite startup where listeners attach a tick after the
// prefetched style has already started settling and Mapbox emits no
// further events for it (visible bug: zero `[map3d]` logs, map stays
// flat at zoom until the user reloads). 3500 ms is short enough to
// recover before the user starts zooming and long enough to let real
// events win on healthy starts.
export const STYLE_READINESS_FORCE_BYPASS_MS = 3500;

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
  getActiveVisualFamily: () => BasemapVisualFamily;
  getActiveTerrainContract: () => TerrainBootstrapContract;
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
  disposeViewportPrefetch: (() => void) | null;
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
  spriteStormBypass: boolean;

  /** Debounce slope/altitude sourceCache reload after burst DEM upgrades. */
  derivedReloadTimer: ReturnType<typeof setTimeout> | null;

  requestedTiles: Set<string>;
  loadedTiles: Set<string>;
  trackedSourceIds: Set<string>;
  requestedAt: Map<string, number>;
}

export interface ControllerFns {
  // helpers
  canMutateStyle: () => boolean;
  getManagedTerrainSourceId: () => string | null;
  isUnifiedTerrainActive: () => boolean;
  isManagedTerrainActive: () => boolean;
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
  applyManagedTerrain: () => boolean;
  applyUnifiedTerrain: () => boolean;
  refreshDemSource: (options?: { forceRebuild?: boolean }) => boolean;
  detachManagedTerrain: () => void;
  scheduleTerrainRecovery: () => void;
  scheduleSetTilesVerify: () => void;
  armTerrainBootstrap: (onReady: () => void) => void;
  attachAwsFallbackTerrain: () => void;
  detachAwsFallbackTerrain: () => void;

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
    disposeViewportPrefetch: null,
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
    spriteStormBypass: false,

    derivedReloadTimer: null,

    requestedTiles: new Set<string>(),
    loadedTiles: new Set<string>(),
    trackedSourceIds: new Set<string>(),
    requestedAt: new Map<string, number>(),
  };
}

export function attachHelpers(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.canMutateStyle = () => {
    if (isCancelled()) return false;
    try {
      // When Mapbox 3.x is stuck in a sprite/image rejection storm,
      // isStyleLoaded() stays false forever even though sources, layers
      // and the rendering pipeline are fully operational. The
      // spriteStormBypass flag (set by the polling fallback in
      // styleBootstrap.ts) relaxes the check so terrain can attach.
      if (st.spriteStormBypass) {
        return Boolean(map.getStyle());
      }
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

  fns.getManagedTerrainSourceId = () => {
    try {
      if (map.getSource(unifiedDEMSource.id)) return unifiedDEMSource.id;
      if (map.getSource(awsFallbackDEMSource.id)) return awsFallbackDEMSource.id;
    } catch {
      return null;
    }
    return null;
  };

  fns.isManagedTerrainActive = () => {
    try {
      const expectedSourceId = fns.getManagedTerrainSourceId();
      if (!expectedSourceId) return false;
      return map.getTerrain()?.source === expectedSourceId;
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

  // All basemap styles use the same 'default' DEM profile so the SW
  // cache (keyed by profile) is shared across style switches. This
  // avoids a full re-fetch when switching from topo to satellite and
  // ensures both styles get IGN MNS LiDAR HD (0.40 cm, with buildings,
  // trees, rocks). The 'terrain' profile is reserved for slope/altitude
  // computation — it routes to RGE ALTI WMS (bare-earth) which strips
  // canopy/buildings and is unsuitable for 3D terrain display.
  fns.getActiveDemProfile = () => 'default';

  fns.shouldUseIgnOrthoOverlay = () => false;
}
