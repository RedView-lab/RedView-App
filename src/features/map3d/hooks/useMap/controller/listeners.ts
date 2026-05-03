import type { ErrorEvent as MapboxErrorEvent, MapSourceDataEvent } from 'mapbox-gl';
import { unifiedDEMSource } from '../../../lib/sources';
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
    // Anti-flat: idle is the cheapest reliable signal that terrain
    // detach happened silently. If the DEM source exists but terrain
    // isn't bound, re-attach immediately.
    if (
      fns.canMutateStyle()
      && map.getSource(unifiedDEMSource.id)
      && !fns.isUnifiedTerrainActive()
    ) {
      console.warn('[map3d] idle: terrain detached from unified-dem; re-attaching');
      fns.applyUnifiedTerrain();
      if (!fns.isUnifiedTerrainActive()) {
        // Re-attach refused — escalate to forceful rebuild via the
        // standard reload path (cooldown bypassed since this is a
        // genuine regression, not user-initiated).
        st.demReloadCoolingUntil = 0;
        fns.reloadMapElevation();
        return;
      }
    }
    if (!fns.allTilesLoaded()) return;
    if (map.isMoving()) return;
    if (fns.applyPendingDemPassiveRefresh()) return;
    fns.finishDemActivity('Carte prête');
  };

  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type !== 'DEM_TILE_CACHE_UPDATED') return;
    st.demPassiveRefreshPending = true;
    fns.scheduleDemSettle();
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
    map.on('movestart', onMovestart);
    map.on('idle', onMapIdle);
    map.on('styledata', fns.scheduleTerrainRecovery);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
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
    map.off('movestart', onMovestart);
    map.off('idle', onMapIdle);
    map.off('styledata', fns.scheduleTerrainRecovery);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
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
    st.reloadInProgress = false;
    st.reloadStyleEscalations = 0;
    if (st.finishOnIdle) {
      map.off('idle', st.finishOnIdle);
      st.finishOnIdle = null;
    }
  };
}
