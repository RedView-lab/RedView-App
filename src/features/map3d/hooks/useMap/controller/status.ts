import { unifiedDEMSource } from '../../../lib/sources';
import { createOverlayStatus } from '../../../lib/overlayStatus';
import {
  DEM_ACTIVITY_SETTLE_MS,
  DEM_PASSIVE_REFRESH_COOLDOWN_MS,
  LOADING_WATCHDOG_MS,
  MAP_LOADING_MAX_MS,
} from '../constants';
import type { Ctx } from './context';
import { clearVisibleTimer, setVisibleTimeout } from './visibleClock';

/**
 * Status reporting + DEM tile progress aggregation.
 *
 * Anti-flat reinforcement: `finishDemActivity` self-heals when
 * the bootstrap settled in 2D (terrain not bound to unified-dem).
 */
export function attachStatus(ctx: Ctx): void {
  const { map, isCancelled, onLoadStatusChangeRef, registerReloadRef } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.clearDemTracking = () => {
    st.requestedTiles.clear();
    st.loadedTiles.clear();
    st.requestedAt.clear();
    clearVisibleTimer(st.demSettleTimer);
    st.demSettleTimer = null;
    clearVisibleTimer(st.loadingWatchdog);
    st.loadingWatchdog = null;
  };

  // Hard deadline per loading cycle. Bootstrap phases ("Relief" 68 %,
  // "Tuiles satellites" 80 %, "Terrain" 82 %…) only complete on Mapbox
  // `idle` / `areTilesLoaded()`, which never fire while ANY source keeps
  // streaming (weather, POI, prefetch…). Without this cap the pill stayed
  // frozen at 80–99 % forever even though the map was fully usable.
  // Visible time only: a hidden page loads no tile and never goes idle.
  const armLoadingDeadline = (delayMs: number) => {
    st.loadingDeadline = setVisibleTimeout(() => {
      st.loadingDeadline = null;
      if (isCancelled() || st.lastReportedState !== 'loading') return;
      if (map.isMoving()) {
        armLoadingDeadline(1_000);
        return;
      }
      console.warn(`[map3d] loading cycle exceeded ${MAP_LOADING_MAX_MS} ms; reporting ready`);
      // Deliberately NOT finishDemActivity(): its flat-terrain self-heal can
      // trigger a reload, which would restart a cycle and loop every 12 s.
      // The terrain heartbeat keeps covering genuine terrain drops.
      if (st.demTrackingEnabled) {
        fns.clearDemTracking();
        st.hasReportedReadyOnce = true;
        fns.reportStatus('ready', 100, 'Carte prête');
        fns.startTerrainHeartbeat();
      } else {
        fns.reportStatus('ready', 100, 'Carte prête');
      }
    }, delayMs);
  };

  fns.reportStatus = (state, progress, detail) => {
    st.lastReportedState = state;
    st.lastReportedProgress = progress;
    if (state === 'loading') {
      if (!st.loadingDeadline) armLoadingDeadline(MAP_LOADING_MAX_MS);
    } else if (st.loadingDeadline) {
      clearVisibleTimer(st.loadingDeadline);
      st.loadingDeadline = null;
    }
    if (state !== 'loading' && st.loadingWatchdog) {
      clearVisibleTimer(st.loadingWatchdog);
      st.loadingWatchdog = null;
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

  fns.finishDemActivity = (detail = 'Carte prête') => {
    fns.clearDemTracking();
    if (isCancelled()) return;

    // Self-heal: if we're about to report "ready" but terrain isn't
    // actually wired to the unified DEM, the bootstrap finished in a
    // flat 2D state. Auto-trigger a reload instead of falsely
    // reporting 100% — that's what made the manual reload button feel
    // useless ("ça met 100% mais tout reste plat").
    if (!fns.isManagedTerrainRenderable() && fns.getManagedTerrainSourceId()) {
      // A terrain source exists but the renderer lost its binding.
      // Re-attach in place before claiming success.
      fns.applyManagedTerrain();
    }
    if (
      !fns.isManagedTerrainRenderable()
      && navigator.serviceWorker?.controller
      && fns.canMutateStyle()
      && !st.reloadInProgress
    ) {
      if (!map.getSource(unifiedDEMSource.id)) {
        console.warn('[map3d] bootstrap finished on fallback terrain; upgrading to unified DEM');
        void fns.bootstrapCurrentStyle();
        return;
      }
      console.warn('[map3d] bootstrap finished flat; triggering self-heal reload');
      st.demReloadCoolingUntil = 0;
      fns.reloadMapElevation();
      return;
    }
    st.demTrackingEnabled = true;
    st.hasReportedReadyOnce = true;
    fns.reportStatus('ready', 100, detail);
    // Anti-flat reinforcement: ensure heartbeat is running once we've
    // reported ready at least once. The heartbeat verifies every 5s
    // that terrain is still bound to the unified DEM and self-heals if
    // it isn't (covers silent terrain drops after late style.load).
    fns.startTerrainHeartbeat();
  };

  fns.applyPendingDemPassiveRefresh = () => {
    if (!st.demPassiveRefreshPending || isCancelled() || map.isMoving()) return false;
    const now = Date.now();
    if (now < st.demPassiveRefreshCoolingUntil) return false;

    st.demCacheBust = now;
    if (!fns.refreshDemSource()) return false;

    st.demPassiveRefreshPending = false;
    st.demPassiveRefreshCoolingUntil = now + DEM_PASSIVE_REFRESH_COOLDOWN_MS;
    st.demTrackingEnabled = false;
    fns.clearDemTracking();
    fns.reportStatus('loading', 0, 'Affinage relief');

    fns.armTerrainBootstrap(() => {
      st.demTrackingEnabled = true;
      fns.scheduleDemSettle();
    });
    return true;
  };

  fns.armLoadingWatchdog = () => {
    clearVisibleTimer(st.loadingWatchdog);
    st.loadingWatchdog = setVisibleTimeout(() => {
      st.loadingWatchdog = null;
      if (isCancelled() || !st.demTrackingEnabled) return;
      if (map.isMoving()) {
        fns.armLoadingWatchdog();
        return;
      }
      if (fns.allTilesLoaded()) {
        fns.finishDemActivity('Carte prête');
        return;
      }
      for (const key of Array.from(st.requestedTiles)) {
        if (st.loadedTiles.has(key)) fns.dropTrackedTile(key);
      }
      fns.pruneStalePendingTiles();
      // `allTilesLoaded()` covers EVERY source (weather, POI, vector…), so it
      // can stay false indefinitely. Once no tracked relief/raster tile is
      // pending anymore, the map is done from the user's point of view.
      if (st.requestedTiles.size === 0) {
        fns.finishDemActivity('Carte prête');
        return;
      }
      fns.publishDemProgress('Tuiles en attente');
      fns.armLoadingWatchdog();
    }, LOADING_WATCHDOG_MS);
  };

  fns.publishDemProgress = (detail = 'Relief HD') => {
    if (!st.demTrackingEnabled || isCancelled()) return;
    const requested = st.requestedTiles.size;
    const loaded = st.loadedTiles.size;
    if (requested === 0) return;
    const ratio = loaded / Math.max(requested, 1);
    const pct = loaded >= requested
      ? (fns.allTilesLoaded() && !map.isMoving() ? 100 : 99)
      : Math.max(1, Math.min(99, Math.round(ratio * 100)));
    if (pct >= 100) {
      fns.finishDemActivity(detail);
      return;
    }
    fns.reportStatus('loading', pct, detail);
    fns.armLoadingWatchdog();
  };

  fns.scheduleDemSettle = () => {
    if (!st.demTrackingEnabled) return;
    clearVisibleTimer(st.demSettleTimer);
    st.demSettleTimer = setVisibleTimeout(() => {
      st.demSettleTimer = null;
      if (isCancelled()) return;
      const pruned = fns.pruneStalePendingTiles();
      if (pruned && st.requestedTiles.size > 0) {
        fns.publishDemProgress('Tuiles');
      }
      if (fns.allTilesLoaded() && !map.isMoving()) {
        if (fns.applyPendingDemPassiveRefresh()) return;
        fns.finishDemActivity('Carte prête');
      } else {
        if (st.lastReportedState !== 'loading') {
          fns.reportStatus(
            'loading',
            st.requestedTiles.size > 0 ? Math.max(1, Math.min(99, st.lastReportedProgress || 99)) : 5,
            st.requestedTiles.size > 0 ? 'Tuiles' : 'Déplacement',
          );
        }
        fns.armLoadingWatchdog();
      }
    }, DEM_ACTIVITY_SETTLE_MS);
  };
}
