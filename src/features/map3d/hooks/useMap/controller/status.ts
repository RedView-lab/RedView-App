import { unifiedDEMSource } from '../../../lib/sources';
import { createOverlayStatus } from '../../../lib/overlayStatus';
import {
  DEM_ACTIVITY_SETTLE_MS,
  DEM_PASSIVE_REFRESH_COOLDOWN_MS,
  LOADING_WATCHDOG_MS,
} from '../constants';
import type { Ctx } from './context';

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
    if (st.demSettleTimer) {
      clearTimeout(st.demSettleTimer);
      st.demSettleTimer = null;
    }
    if (st.loadingWatchdog) {
      clearTimeout(st.loadingWatchdog);
      st.loadingWatchdog = null;
    }
  };

  fns.reportStatus = (state, progress, detail) => {
    st.lastReportedState = state;
    st.lastReportedProgress = progress;
    if (state !== 'loading' && st.loadingWatchdog) {
      clearTimeout(st.loadingWatchdog);
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
    if (!fns.isManagedTerrainActive() && fns.getManagedTerrainSourceId()) {
      // A terrain source exists but the renderer lost its binding.
      // Re-attach in place before claiming success.
      fns.applyManagedTerrain();
    }
    if (
      !fns.isManagedTerrainActive()
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
    if (st.loadingWatchdog) clearTimeout(st.loadingWatchdog);
    st.loadingWatchdog = setTimeout(() => {
      st.loadingWatchdog = null;
      if (isCancelled() || !st.demTrackingEnabled) return;
      if (fns.allTilesLoaded() && !map.isMoving()) {
        fns.finishDemActivity('Carte prête');
      } else {
        for (const key of Array.from(st.requestedTiles)) {
          if (st.loadedTiles.has(key)) fns.dropTrackedTile(key);
        }
        fns.pruneStalePendingTiles();
        fns.publishDemProgress('Tuiles en attente');
        fns.armLoadingWatchdog();
      }
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
    if (st.demSettleTimer) clearTimeout(st.demSettleTimer);
    st.demSettleTimer = setTimeout(() => {
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
