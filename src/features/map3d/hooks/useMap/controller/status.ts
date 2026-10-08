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
 * Remontée d'état + agrégation de la progression des tuiles DEM.
 *
 * Renfort anti-plat : `finishDemActivity` s'autorépare quand le bootstrap s'est
 * stabilisé en 2D (terrain non lié à unified-dem).
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

  // Échéance ferme par cycle de chargement. Les phases du bootstrap (« Relief »
  // 68 %, « Tuiles satellites » 80 %, « Terrain » 82 %…) ne se terminent que sur
  // `idle` / `areTilesLoaded()` de Mapbox, qui ne se déclenchent jamais tant
  // qu'UNE source continue de streamer (météo, POI, préchargement…). Sans ce
  // plafond, la pastille restait figée entre 80 et 99 % pour toujours alors que
  // la carte était parfaitement utilisable. Temps visible seulement : une page
  // masquée ne charge aucune tuile et n'atteint jamais l'inactivité.
  const armLoadingDeadline = (delayMs: number) => {
    st.loadingDeadline = setVisibleTimeout(() => {
      st.loadingDeadline = null;
      if (isCancelled() || st.lastReportedState !== 'loading') return;
      if (map.isMoving()) {
        armLoadingDeadline(1_000);
        return;
      }
      console.warn(`[map3d] loading cycle exceeded ${MAP_LOADING_MAX_MS} ms; reporting ready`);
      // Volontairement PAS finishDemActivity() : son autoréparation du terrain
      // plat peut déclencher un rechargement, qui relancerait un cycle et
      // bouclerait toutes les 12 s. Le battement de cœur du terrain continue de
      // couvrir les vraies pertes de terrain.
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

    // Autoréparation : si on s'apprête à signaler « prêt » alors que le terrain
    // n'est pas vraiment relié au DEM unifié, le bootstrap s'est terminé dans un
    // état 2D plat. On déclenche automatiquement un rechargement au lieu
    // d'afficher à tort 100 % — c'est ce qui rendait le bouton de rechargement
    // manuel inutile (« ça met 100% mais tout reste plat »).
    if (!fns.isManagedTerrainRenderable() && fns.getManagedTerrainSourceId()) {
      // Une source de terrain existe mais le rendu a perdu sa liaison. On la
      // rattache sur place avant de déclarer le succès.
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
    // Renfort anti-plat : on s'assure que le battement de cœur tourne dès qu'on a
    // signalé « prêt » au moins une fois. Il vérifie toutes les 5 s que le
    // terrain est toujours lié au DEM unifié et s'autorépare sinon (couvre les
    // pertes silencieuses de terrain après un style.load tardif).
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
      // `allTilesLoaded()` couvre TOUTES les sources (météo, POI, vectoriel…) et
      // peut rester à false indéfiniment. Dès qu'aucune tuile de relief / raster
      // suivie n'est plus en attente, la carte est terminée du point de vue de
      // l'utilisateur.
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
