import type { MutableRefObject } from 'react';
import type {
  Map as MapboxMap,
  MapSourceDataEvent,
} from 'mapbox-gl';
import { awsFallbackDEMSource, awsFastDEMSource, unifiedDEMSource } from '../../../lib/sources';
import { TerrainManager } from '../../../lib/terrain';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';
import { getActiveDemProfilePreference } from '../../../lib/demProfileBus';
import {
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '../../../lib/overlayStatus';
import type { MapRuntimeProfile } from '../runtimeProfile';
import { getDemTileKey, type DemSourceDataLike, type DemTileProfile } from '../demTiles';
import { PENDING_TILE_MAX_AGE_MS, TRACKED_SOURCE_TYPES } from '../constants';
import { styleHasUsableContent } from './styleContent';
import type { VisibleTimer } from './visibleClock';

type BasemapVisualFamily = 'mapbox-standard-v3' | 'mapbox-classic-v12';
type TerrainBootstrapContract = 'unified-dem-v1';
type BasemapLightPreset = 'dawn' | 'day' | 'dusk' | 'night';
// Disponibilité du style pilotée par les événements — le bootstrap attend que
// Mapbox ait analysé le style (styleBootstrapReadiness.ts). Cette constante ne
// conditionne qu'un avertissement périodique de télémétrie, compté en temps
// visible, pour qu'un style vraiment bloqué reste observable dans la console.
export const STYLE_READINESS_TELEMETRY_INTERVAL_MS = 15000;

// Constantes de renfort anti-plat. Assez basses pour détecter vite une
// régression vers l'état plat, assez hautes pour laisser à Mapbox le temps de
// stabiliser entre deux contrôles un graphe de terrain fraîchement attaché.
export const TERRAIN_HEARTBEAT_INTERVAL_MS = 12000;
export const TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD = 2;
export const DEM_SETTILE_VERIFY_MS = 3500;

export interface CreateMapLifecycleControllerOptions {
  map: MapboxMap;
  runtimeProfile: MapRuntimeProfile;
  terrainRef: MutableRefObject<TerrainManager | null>;
  onLoadStatusChangeRef: MutableRefObject<OverlayStatusReporter | undefined>;
  registerReloadRef: MutableRefObject<OverlayReloadRegistrar | undefined>;
  getActiveStyleUrl: () => string;
  getActiveVisualFamily: () => BasemapVisualFamily;
  getActiveTerrainContract: () => TerrainBootstrapContract;
  getActiveLightPreset: () => BasemapLightPreset | undefined;
  isCancelled: () => boolean;
}

export interface MapLifecycleController {
  reportStatus: (state: 'loading' | 'ready' | 'error', progress: number, detail?: string) => void;
  reloadMapElevation: () => void;
  reloadMapElevationForProfile: () => void;
  prepareStyleChange: (detail?: string) => void;
  bootstrapCurrentStyle: () => Promise<boolean>;
  setDem3dQuality: (quality: 'hd' | 'fast-30m') => void;
  cleanup: () => void;
}

type ReportStatusFn = (
  state: 'loading' | 'ready' | 'error',
  progress: number,
  detail?: string,
) => void;

/** État d'exécution mutable partagé par tous les modules du contrôleur. */
export interface ControllerState {
  demCacheBust: number;
  demTrackingEnabled: boolean;
  demReloadCoolingUntil: number;
  demPassiveRefreshCoolingUntil: number;
  demPassiveRefreshPending: boolean;
  demSettleTimer: VisibleTimer | null;
  loadingWatchdog: VisibleTimer | null;
  /** Échéance ferme du cycle de « chargement » en cours (voir MAP_LOADING_MAX_MS). */
  loadingDeadline: VisibleTimer | null;
  lastReportedState: 'loading' | 'ready' | 'error';
  lastReportedProgress: number;
  disposeTerrainBootstrap: (() => void) | null;
  disposeStyleRecovery: (() => void) | null;
  disposeViewportPrefetch: (() => void) | null;
  disposeOrthoPairingSync: (() => void) | null;
  disposeDemWantedTilesSync: (() => void) | null;
  orthoBootTimer: VisibleTimer | null;
  finishOnIdle: (() => void) | null;
  readyFallbackTimer: VisibleTimer | null;
  terrainRecoveryTimer: VisibleTimer | null;
  styleBootstrapRunId: number;
  trackingListenersBound: boolean;

  reloadVerifyTimer: VisibleTimer | null;
  reloadReadinessTimer: VisibleTimer | null;
  /** Changement de profil DEM arrivé pendant l'attente ou un rechargement : rejoué ensuite (reload.ts). */
  profileReloadTimer: VisibleTimer | null;
  reloadInProgress: boolean;
  reloadStyleEscalations: number;

  // renforts anti-carte plate
  heartbeatTimer: VisibleTimer | null;
  heartbeatFailures: number;
  setTilesVerifyTimer: VisibleTimer | null;
  hasReportedReadyOnce: boolean;

  /** Antirebond du rechargement du sourceCache pente / altitude après une rafale de mises à niveau de DEM. */
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
  isManagedTerrainRenderable: () => boolean;
  allTilesLoaded: () => boolean;
  isTrackedSource: (sourceId: string | undefined | null) => boolean;
  buildTileKey: (event: MapSourceDataEvent) => string | null;
  refreshTrackedSourceIds: () => void;
  getActiveDemProfile: () => DemTileProfile;
  shouldUseIgnOrthoOverlay: () => boolean;
  dropTrackedTile: (tileKey: string) => void;
  pruneStalePendingTiles: () => boolean;

  // état / progression
  reportStatus: ReportStatusFn;
  finishDemActivity: (detail?: string) => void;
  publishDemProgress: (detail?: string) => void;
  armLoadingWatchdog: () => void;
  scheduleDemSettle: () => void;
  applyPendingDemPassiveRefresh: () => boolean;
  clearDemTracking: () => void;

  // DEM / terrain
  applyManagedTerrain: () => boolean;
  applyUnifiedTerrain: () => boolean;
  refreshDemSource: (options?: { forceRebuild?: boolean }) => boolean;
  detachManagedTerrain: () => void;
  scheduleTerrainRecovery: () => void;
  scheduleSetTilesVerify: () => void;
  armTerrainBootstrap: (onReady: () => void) => void;
  attachAwsFallbackTerrain: () => void;
  detachAwsFallbackTerrain: () => void;

  // 3D quality switch (HD unified DEM ↔ fast AWS Terrarium ~30 m)
  applyFastDemTerrain: () => boolean;
  setDem3dQuality: (quality: 'hd' | 'fast-30m') => void;

  // reload
  performReloadOnce: () => boolean;
  scheduleTerrainVerifyAfterReload: () => void;
  reloadMapElevation: () => void;
  reloadMapElevationForProfile: () => void;

  // surcouche IGN
  addIgnOrthoOverlay: () => void;
  addVhrOrthoOverlay: () => void;

  // amorçage du style
  prepareStyleChange: (detail?: string) => void;
  bootstrapCurrentStyle: () => Promise<boolean>;

  // listeners
  ensureTrackingListeners: () => void;
  removeTrackingListeners: () => void;
  clearStyleBootstrapArtifacts: () => void;

  // battement de cœur (anti-carte plate)
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
    loadingDeadline: null,
    lastReportedState: 'loading',
    lastReportedProgress: 0,
    disposeTerrainBootstrap: null,
    disposeStyleRecovery: null,
    disposeViewportPrefetch: null,
    disposeOrthoPairingSync: null,
    disposeDemWantedTilesSync: null,
    orthoBootTimer: null,
    finishOnIdle: null,
    readyFallbackTimer: null,
    terrainRecoveryTimer: null,
    styleBootstrapRunId: 0,
    trackingListenersBound: false,

    reloadVerifyTimer: null,
    reloadReadinessTimer: null,
    profileReloadTimer: null,
    reloadInProgress: false,
    reloadStyleEscalations: 0,

    heartbeatTimer: null,
    heartbeatFailures: 0,
    setTilesVerifyTimer: null,
    hasReportedReadyOnce: false,

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
      // Sources, calques et terrain peuvent être ajoutés dès que Mapbox a
      // analysé le style (`getStyle()` lève une exception avant). `isStyleLoaded()`
      // attend aussi le sprite, le TileJSON de chaque source et les imports —
      // des secondes à froid — dont aucun n'a besoin. La coquille vide du
      // bootstrap n'a pas de contenu : rien n'est attaché à un style sur le point
      // d'être remplacé.
      return styleHasUsableContent(map.getStyle());
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
      if (getActiveDem3dQuality() === 'fast-30m') {
        if (map.getSource(awsFastDEMSource.id)) return awsFastDEMSource.id;
        if (map.getSource(awsFallbackDEMSource.id)) return awsFallbackDEMSource.id;
      }
      if (map.getSource(unifiedDEMSource.id)) return unifiedDEMSource.id;
      if (map.getSource(awsFallbackDEMSource.id)) return awsFallbackDEMSource.id;
      if (map.getSource(awsFastDEMSource.id)) return awsFastDEMSource.id;
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

  fns.isManagedTerrainRenderable = () => {
    try {
      const expectedSourceId = fns.getManagedTerrainSourceId();
      if (!expectedSourceId) return false;
      if (map.getTerrain()?.source !== expectedSourceId) return false;
      if (map.isMoving()) return true;

      let sourceLoaded = false;
      try {
        sourceLoaded = map.isSourceLoaded(expectedSourceId);
      } catch {
        sourceLoaded = false;
      }
      if (!sourceLoaded) return true;

      // Sous le minzoom de la source DEM (p. ex. le minzoom d'unifiedDEMSource est 6
      // alors que la vue par défaut est un globe à zoom 5,5), Mapbox ne charge pas de
      // tuiles DEM et queryTerrainElevation renvoie null. Le terrain est lié et valide ;
      // le déclarer non affichable ici déclencherait une boucle d'escalade à tort.
      const source = map.getSource(expectedSourceId) as { minzoom?: number } | undefined;
      const minzoom = typeof source?.minzoom === 'number'
        ? source.minzoom
        : (expectedSourceId === unifiedDEMSource.id ? unifiedDEMSource.minzoom : 0);
      if (map.getZoom() < minzoom) return true;

      const queryTerrainElevation = (map as unknown as {
        queryTerrainElevation?: (
          lngLat: [number, number],
          options?: { exaggerated?: boolean },
        ) => number | null | undefined;
      }).queryTerrainElevation;
      if (typeof queryTerrainElevation !== 'function') return true;

      const center = map.getCenter();
      const sampleOffsets = [
        [0, 0],
        [0.0012, 0],
        [-0.0012, 0],
        [0, 0.0012],
        [0, -0.0012],
      ] as const;

      return sampleOffsets.some(([lngOffset, latOffset]) => {
        const elevation = queryTerrainElevation.call(
          map,
          [center.lng + lngOffset, center.lat + latOffset],
          { exaggerated: false },
        );
        return Number.isFinite(elevation);
      });
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

  // Tous les styles de fond utilisent le même profil DEM 'default', pour que le
  // cache du SW (indexé par profil) soit partagé entre changements de style. Cela
  // évite un nouveau téléchargement complet en passant de topo à satellite et
  // garantit que les deux styles reçoivent le MNS LiDAR HD de l'IGN (0,40 m, avec
  // bâtiments, arbres, rochers). Le profil 'terrain' est réservé au calcul des
  // pentes / altitudes — il passe par le WMS RGE ALTI (sol nu), qui retire la
  // canopée et les bâtiments et ne convient pas à l'affichage du terrain 3D.
  fns.getActiveDemProfile = () => getActiveDemProfilePreference();

  fns.shouldUseIgnOrthoOverlay = () => false;
}
