import { unifiedDEMSource } from '../../../lib/sources';
import { DEM_RELOAD_COOLDOWN_MS } from '../constants';
import type { Ctx } from './context';

/**
 * Reload pipeline + escalation. Used both by the manual reload button
 * and by the self-heal path inside `finishDemActivity`.
 */
export function attachReload(ctx: Ctx): void {
  const { map, isCancelled, getActiveStyleUrl } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.performReloadOnce = (): boolean => {
    if (!fns.canMutateStyle()) return false;
    if (!navigator.serviceWorker?.controller) return false;

    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_DEM_CACHE' });
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_NEGATIVE_CACHE' });

    st.demCacheBust = Date.now();
    // Force a real source rebuild — `setTiles` alone keeps mapbox's
    // existing (possibly empty) tile pyramid, which is the typical cause
    // of "reload says 100% but the map stays flat".
    if (!fns.refreshDemSource({ forceRebuild: true })) return false;

    st.demPassiveRefreshPending = false;
    st.demTrackingEnabled = false;
    fns.clearDemTracking();
    fns.reportStatus('loading', 0, 'Rechargement relief');

    fns.armTerrainBootstrap(() => {
      st.demTrackingEnabled = true;
      fns.scheduleDemSettle();
    });
    fns.scheduleTerrainVerifyAfterReload();
    return true;
  };

  fns.scheduleTerrainVerifyAfterReload = () => {
    if (st.reloadVerifyTimer) clearTimeout(st.reloadVerifyTimer);
    st.reloadVerifyTimer = setTimeout(() => {
      st.reloadVerifyTimer = null;
      if (isCancelled()) return;
      // If terrain is still not the unified DEM, escalate: do a full
      // setStyle re-apply (limited to 2 attempts) so the style.load
      // recovery handler rebuilds DEM + terrain from scratch.
      if (!fns.isUnifiedTerrainActive() || !fns.isManagedTerrainRenderable() || !map.getSource(unifiedDEMSource.id)) {
        if (st.reloadStyleEscalations >= 2) {
          console.warn('[map3d] reload escalation exhausted; map may stay flat');
          fns.reportStatus('error', 0, 'Relief 3D indisponible');
          st.reloadInProgress = false;
          return;
        }
        st.reloadStyleEscalations += 1;
        console.warn(
          '[map3d] reload: terrain still flat, forcing style re-apply',
          st.reloadStyleEscalations,
        );
        fns.reportStatus('loading', 12, 'Reconstruction fond de carte');
        try {
          fns.detachManagedTerrain();
          map.setStyle(getActiveStyleUrl(), {
            diff: false,
            localFontFamily: null,
            localIdeographFontFamily: 'sans-serif',
          });
        } catch (error) {
          console.warn('[map3d] forced setStyle failed', error);
          fns.reportStatus('error', 0, 'Relief 3D indisponible');
          st.reloadInProgress = false;
          return;
        }
        // After style.load fires, recoverStyleArtifacts re-runs and we
        // re-attempt the elevation refresh.
        const onLateStyleLoad = () => {
          map.off('style.load', onLateStyleLoad);
          if (isCancelled()) return;
          setTimeout(() => {
            if (isCancelled()) return;
            fns.performReloadOnce();
          }, 250);
        };
        map.on('style.load', onLateStyleLoad);
        return;
      }
      st.reloadInProgress = false;
      st.reloadStyleEscalations = 0;
    }, 2500);
  };

  fns.reloadMapElevation = () => {
    const now = Date.now();
    if (now < st.demReloadCoolingUntil) return;
    st.demReloadCoolingUntil = now + DEM_RELOAD_COOLDOWN_MS;
    if (st.reloadInProgress) return;

    if (fns.performReloadOnce()) {
      st.reloadInProgress = true;
      return;
    }

    // Conditions weren't ready (style not loaded yet, SW controller
    // missing). Don't fake a 100% "ready" status — that's what made the
    // button look broken. Instead poll for readiness for up to ~10s and
    // retry, then surface a real error if it still can't run.
    st.reloadInProgress = true;
    fns.reportStatus('loading', 8, 'En attente du fond de carte');
    if (st.reloadReadinessTimer) clearTimeout(st.reloadReadinessTimer);
    const startedAt = Date.now();
    const tryAgain = () => {
      st.reloadReadinessTimer = null;
      if (isCancelled()) {
        st.reloadInProgress = false;
        return;
      }
      if (fns.performReloadOnce()) return;
      if (Date.now() - startedAt > 10000) {
        console.warn('[map3d] reload aborted: style/SW never became ready');
        fns.reportStatus('error', 0, 'Rechargement impossible');
        st.reloadInProgress = false;
        st.demReloadCoolingUntil = 0;
        return;
      }
      st.reloadReadinessTimer = setTimeout(tryAgain, 400);
    };
    st.reloadReadinessTimer = setTimeout(tryAgain, 200);
  };
}
