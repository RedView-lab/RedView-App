import type { ErrorEvent as MapboxErrorEvent, MapSourceDataEvent } from 'mapbox-gl';
import { awsFallbackDEMSource, ignOrthoSource, unifiedDEMSource } from '../../../lib/sources';
import { installViewportPrefetch } from '../../../lib/viewportPrefetch';
import type { Ctx } from './context';

/**
 * Tile-tracking listeners + style/idle event hooks. Centralised so the
 * cleanup path can detach everything in one call.
 *
 * Anti-flat reinforcement: `onMapIdle` also re-verifies that terrain is
 * still bound to the unified DEM. If Mapbox silently dropped terrain
 * (typical after a late style.load on basemap switch), idle is the
 * earliest reliable point to detect it and re-attach.
 */
export function attachListeners(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;
  let styleDataTerrainRepairTimer: ReturnType<typeof setTimeout> | null = null;

  const repairManagedTerrain = (): boolean => {
    const managedSourceId = fns.getManagedTerrainSourceId();
    if (!managedSourceId) return false;
    if (managedSourceId === unifiedDEMSource.id) {
      return fns.applyUnifiedTerrain();
    }
    if (managedSourceId === awsFallbackDEMSource.id) {
      fns.attachAwsFallbackTerrain();
      return fns.isManagedTerrainActive();
    }
    return false;
  };

  const onTrackedSourceDataLoading = (event: MapSourceDataEvent) => {
    if (!st.demTrackingEnabled) return;
    if (!fns.isTrackedSource(event.sourceId)) return;
    const tileKey = fns.buildTileKey(event);
    if (!tileKey) return;
    if (!st.requestedTiles.has(tileKey)) st.requestedAt.set(tileKey, Date.now());
    st.requestedTiles.add(tileKey);
    fns.publishDemProgress('Tuiles');
  };

  const onTrackedSourceData = (event: MapSourceDataEvent) => {
    if (!st.demTrackingEnabled) return;
    if (!fns.isTrackedSource(event.sourceId)) return;
    const tileKey = fns.buildTileKey(event);
    if (tileKey) {
      st.requestedTiles.add(tileKey);
      st.loadedTiles.add(tileKey);
      st.requestedAt.delete(tileKey);
      fns.publishDemProgress('Tuiles');
    }
    if (event.isSourceLoaded) {
      fns.scheduleDemSettle();
    }
  };

  const onTrackedSourceAbort = (event: MapSourceDataEvent) => {
    if (!st.demTrackingEnabled) return;
    if (!fns.isTrackedSource(event.sourceId)) return;
    const tileKey = fns.buildTileKey(event);
    if (!tileKey) return;
    fns.dropTrackedTile(tileKey);
    fns.publishDemProgress('Tuiles');
  };

  const onTrackedTileError = (event: MapboxErrorEvent & { sourceId?: string }) => {
    const sourceId = (event as unknown as { sourceId?: string }).sourceId;
    if (!sourceId || !fns.isTrackedSource(sourceId)) return;
    const tileKey = fns.buildTileKey(event as unknown as MapSourceDataEvent);
    if (tileKey) fns.dropTrackedTile(tileKey);
  };

  const onMapIdle = () => {
    if (!st.demTrackingEnabled || isCancelled()) return;
    // Anti-flat: if the unified DEM source is still missing but the SW
    // controller finally appeared, upgrade the AWS/plain fallback path
    // immediately from idle — the earliest safe point to mutate style.
    if (
      fns.canMutateStyle()
      && !map.getSource(unifiedDEMSource.id)
      && navigator.serviceWorker?.controller
    ) {
      console.warn('[map3d] idle: DEM source missing but SW available — re-bootstrapping');
      void fns.bootstrapCurrentStyle();
      return;
    }
    // Anti-flat: idle is the cheapest reliable signal that terrain
    // detach happened silently. If the DEM source exists but terrain
    // isn't bound, re-attach immediately.
    //
    // Use `isManagedTerrainActive()` (binding check) here, not
    // `isManagedTerrainRenderable()` — the renderable probe returns
    // false over water / at globe-world zoom even when terrain is
    // healthy, which previously triggered a re-attach loop that
    // starved basemap tile loading.
    if (fns.canMutateStyle()) {
      const managedSourceId = fns.getManagedTerrainSourceId();
      if (managedSourceId && !fns.isManagedTerrainActive()) {
        console.warn(
          `[map3d] idle: terrain detached from ${managedSourceId}; re-attaching`,
        );
        if (!repairManagedTerrain() && managedSourceId === unifiedDEMSource.id) {
        // Re-attach refused — escalate to forceful rebuild via the
        // standard reload path (cooldown bypassed since this is a
        // genuine regression, not user-initiated).
          st.demReloadCoolingUntil = 0;
          fns.reloadMapElevation();
          return;
        }
      }
    }
    if (!fns.allTilesLoaded()) return;
    if (map.isMoving()) return;
    if (fns.applyPendingDemPassiveRefresh()) return;
    fns.finishDemActivity('Carte prête');
  };

  // Anti-flat: Standard / Standard-Satellite can emit additional
  // `styledata` bursts after DEM source attach, and those imported-style
  // updates may silently overwrite the active terrain source back away from
  // `unified-dem` while `isStyleLoaded()` is still false. React immediately
  // on the next macrotask instead of waiting for `idle` / heartbeat.
  const onStyleDataTerrainCheck = () => {
    if (isCancelled()) return;
    if (styleDataTerrainRepairTimer) return;
    styleDataTerrainRepairTimer = setTimeout(() => {
      styleDataTerrainRepairTimer = null;
      if (isCancelled()) return;
      const managedSourceId = fns.getManagedTerrainSourceId();
      if (managedSourceId !== unifiedDEMSource.id) return;
      const terrainBound = fns.isUnifiedTerrainActive();
      const terrainRenderable = fns.isManagedTerrainRenderable();
      if (terrainBound && terrainRenderable) return;
      if (terrainBound) return;
      console.warn(
        `[map3d] styledata: unified-dem present but terrain ${terrainBound ? 'non-renderable' : 'unbound'}; re-attaching`,
      );
      repairManagedTerrain();
    }, 0);
  };

  // Anti-flat: verify terrain binding after every zoom operation.
  // Mapbox GL v3 occasionally drops terrain silently during zoom
  // transitions (when the tile pyramid crosses z-level boundaries).
  // Re-attach immediately so the user never sees a flat frame.
  //
  // Important: only trigger the noisy re-attach path when terrain is
  // actually unbound (`isManagedTerrainActive()` false). The renderable
  // check also returns false when the camera is centered over water or
  // on the globe at world zoom where `queryTerrainElevation` returns
  // null at every sample point — those are NOT real detachments and
  // were causing console-spam loops + repeated style mutations that
  // starved the basemap of its tile budget.
  const onZoomEndTerrainCheck = () => {
    if (!st.demTrackingEnabled || isCancelled()) return;
    if (!fns.canMutateStyle()) return;
    const managedSourceId = fns.getManagedTerrainSourceId();
    if (managedSourceId && !fns.isManagedTerrainActive()) {
      console.warn(`[map3d] zoomend: terrain detached from ${managedSourceId}; re-attaching`);
      repairManagedTerrain();
    }
    if (managedSourceId === unifiedDEMSource.id) {
      fns.scheduleSetTilesVerify();
    }
  };

  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type !== 'DEM_TILE_CACHE_UPDATED') return;
    st.demPassiveRefreshPending = true;
    fns.scheduleDemSettle();

    // Per-tile invalidation of derived slope/altitude caches so the
    // upgraded DEM resolution actually shows up in the overlays. Without
    // this the user sees a "delais" between DEM HD upgrading and slope
    // catching up — slope/altitude PNGs encode the OLD DEM until the SW
    // entry is deleted.
    const z = event.data.z | 0;
    const x = event.data.x | 0;
    const y = event.data.y | 0;
    if (Number.isFinite(z) && Number.isFinite(x) && Number.isFinite(y)) {
      try {
        navigator.serviceWorker?.controller?.postMessage({
          type: 'INVALIDATE_DERIVED_TILE',
          z,
          x,
          y,
        });
      } catch { /* best-effort */ }
      // Then nudge Mapbox to refetch slope/altitude. We debounce a full
      // sourceCache reload because many DEM tiles may upgrade in quick
      // succession (after a fresh viewport settles); reloading once per
      // burst is far cheaper than per-tile and visually identical.
      if (st.derivedReloadTimer) clearTimeout(st.derivedReloadTimer);
      st.derivedReloadTimer = setTimeout(() => {
        st.derivedReloadTimer = null;
        try {
          // Internal but stable Mapbox API for v3.x.
          const sourceCaches = (map.style as unknown as {
            _sourceCaches?: Record<string, { reload?: () => void }>;
            sourceCaches?: Record<string, { reload?: () => void }>;
          });
          const caches = sourceCaches?._sourceCaches ?? sourceCaches?.sourceCaches;
          if (!caches) return;
          const isDerivedSourceCache = (key: string): boolean => (
            key === 'slope-tiles'
            || key === 'altitude-tiles'
            || key.endsWith(':slope-tiles')
            || key.endsWith(':altitude-tiles')
          );
          for (const key of Object.keys(caches)) {
            if (isDerivedSourceCache(key)) {
              try { caches[key].reload?.(); } catch { /* noop */ }
            }
          }
        } catch { /* noop */ }
      }, 350);
    }
  };

  const onMovestart = () => {
    if (!st.demTrackingEnabled || isCancelled()) return;
    if (fns.pruneStalePendingTiles()) fns.publishDemProgress('Tuiles');
    if (fns.allTilesLoaded()) return;
    if (st.lastReportedState === 'ready') {
      fns.reportStatus('loading', 5, 'Déplacement');
    }
  };

  fns.ensureTrackingListeners = () => {
    if (st.trackingListenersBound) return;
    map.on('sourcedataloading', onTrackedSourceDataLoading);
    map.on('sourcedata', onTrackedSourceData);
    map.on('dataabort', onTrackedSourceAbort);
    map.on('error', onTrackedTileError);
    map.on('moveend', fns.scheduleDemSettle);
    map.on('zoomend', fns.scheduleDemSettle);
    map.on('zoomend', onZoomEndTerrainCheck);
    map.on('movestart', onMovestart);
    map.on('idle', onMapIdle);
    map.on('styledata', onStyleDataTerrainCheck);
    map.on('styledata', fns.scheduleTerrainRecovery);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    // Strava-style speculative prefetch: warm the 1-tile ring outside the
    // visible bbox + the 4 z+1 children of centre on every idle. Tiles land
    // in the SW CacheStorage at low H2 priority (won't preempt visible-tile
    // fetches) so subsequent pans / zooms render from cache instead of
    // paying provider RTT (50–400 ms cold).
    if (!st.disposeViewportPrefetch) {
      const handle = installViewportPrefetch(map, {
        isOrthoActive: () => Boolean(map.getSource(ignOrthoSource.id)),
        // Slope/altitude tiles are derived from cached DEM by the SW.
        // Warming them alongside their parent DEM tile means: by the time
        // the user pans/zooms into the prefetched neighbourhood the SW
        // pipeline (Horn / decode / PNG encode) has already run — the
        // raster appears within one Mapbox tile-load round-trip instead
        // of several seconds of cold pipeline. Detection is layer-based
        // (style.getLayer) — the slope/altitude hooks toggle the layer
        // visibility, not the source presence, so we have to look at the
        // layer.
        isSlopeActive: () => {
          try {
            return Boolean(map.getLayer('slope-overlay'))
              && map.getLayoutProperty('slope-overlay', 'visibility') !== 'none';
          } catch { return false; }
        },
        isAltitudeActive: () => {
          try {
            return Boolean(map.getLayer('altitude-overlay'))
              && map.getLayoutProperty('altitude-overlay', 'visibility') !== 'none';
          } catch { return false; }
        },
      });
      st.disposeViewportPrefetch = handle.dispose;
    }
    // ── DEM ↔ Ortho pairing flag (SW-side speed-up) ──────────────────
    // When the satellite basemap is active, instruct the SW to pair
    // every /dem-tiles request with an immediate /ortho-tiles
    // background fetch. Eliminates the perceived "DEM first, ortho
    // 200-800 ms later" gap on cold viewport loads. The SW gates
    // everything behind this flag so we do NOT waste IGN ortho fetches
    // when the user is on a non-satellite basemap (topo, plan IGN).
    if (!st.disposeOrthoPairingSync) {
      let lastOrthoPairingFlag: boolean | null = null;
      const syncOrthoPairing = (): void => {
        const enabled = Boolean(map.getSource(ignOrthoSource.id));
        if (enabled === lastOrthoPairingFlag) return;
        lastOrthoPairingFlag = enabled;
        try {
          navigator.serviceWorker?.controller?.postMessage({
            type: 'SET_PAIR_ORTHO_WITH_DEM',
            enabled,
          });
        } catch { /* best-effort */ }
      };
      map.on('styledata', syncOrthoPairing);
      syncOrthoPairing(); // fire once now in case source already mounted
      st.disposeOrthoPairingSync = () => {
        try { map.off('styledata', syncOrthoPairing); } catch { /* ignore */ }
        // Tell SW to stop pairing on teardown.
        try {
          navigator.serviceWorker?.controller?.postMessage({
            type: 'SET_PAIR_ORTHO_WITH_DEM',
            enabled: false,
          });
        } catch { /* best-effort */ }
      };
    }
    st.trackingListenersBound = true;
  };

  fns.removeTrackingListeners = () => {
    if (!st.trackingListenersBound) return;
    map.off('sourcedataloading', onTrackedSourceDataLoading);
    map.off('sourcedata', onTrackedSourceData);
    map.off('dataabort', onTrackedSourceAbort);
    map.off('error', onTrackedTileError);
    map.off('moveend', fns.scheduleDemSettle);
    map.off('zoomend', fns.scheduleDemSettle);
    map.off('zoomend', onZoomEndTerrainCheck);
    map.off('movestart', onMovestart);
    map.off('idle', onMapIdle);
    map.off('styledata', onStyleDataTerrainCheck);
    map.off('styledata', fns.scheduleTerrainRecovery);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    if (styleDataTerrainRepairTimer) {
      clearTimeout(styleDataTerrainRepairTimer);
      styleDataTerrainRepairTimer = null;
    }
    st.disposeViewportPrefetch?.();
    st.disposeViewportPrefetch = null;
    st.disposeOrthoPairingSync?.();
    st.disposeOrthoPairingSync = null;
    st.trackingListenersBound = false;
  };

  fns.clearStyleBootstrapArtifacts = () => {
    st.disposeTerrainBootstrap?.();
    st.disposeTerrainBootstrap = null;
    st.disposeStyleRecovery?.();
    st.disposeStyleRecovery = null;
    if (st.orthoBootTimer) {
      clearTimeout(st.orthoBootTimer);
      st.orthoBootTimer = null;
    }
    if (st.readyFallbackTimer) {
      clearTimeout(st.readyFallbackTimer);
      st.readyFallbackTimer = null;
    }
    if (st.terrainRecoveryTimer) {
      clearTimeout(st.terrainRecoveryTimer);
      st.terrainRecoveryTimer = null;
    }
    if (st.reloadVerifyTimer) {
      clearTimeout(st.reloadVerifyTimer);
      st.reloadVerifyTimer = null;
    }
    if (st.reloadReadinessTimer) {
      clearTimeout(st.reloadReadinessTimer);
      st.reloadReadinessTimer = null;
    }
    if (st.setTilesVerifyTimer) {
      clearTimeout(st.setTilesVerifyTimer);
      st.setTilesVerifyTimer = null;
    }
    if (styleDataTerrainRepairTimer) {
      clearTimeout(styleDataTerrainRepairTimer);
      styleDataTerrainRepairTimer = null;
    }
    st.reloadInProgress = false;
    st.reloadStyleEscalations = 0;
    if (st.finishOnIdle) {
      map.off('idle', st.finishOnIdle);
      st.finishOnIdle = null;
    }
  };
}
