import { unifiedDEMSource } from '../../../lib/sources';
import { DEM_RELOAD_COOLDOWN_MS } from '../constants';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';
import type { Ctx } from './context';

// Debounce window for back-to-back DEM profile switches. The profile path
// is cheap (no cache wipe), but a forceRebuild still removes/re-adds the
// source, so coalescing rapid toggles avoids thrashing Mapbox's tile graph.
const PROFILE_RELOAD_DEBOUNCE_MS = 250;

/**
 * Reload pipeline + escalation. Used both by the manual reload button
 * and by the self-heal path inside `finishDemActivity`.
 */
export function attachReload(ctx: Ctx): void {
  const { map, isCancelled, getActiveStyleUrl } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  // Shared reload core. The manual reload button wipes the SW caches and
  // bumps the cache-bust token (forces a clean re-fetch from IGN); the DEM
  // profile switch keeps both stable so each profile's tiles survive in
  // CacheStorage and a switch *back* resolves instantly.
  const runReloadOnce = (opts: {
    clearCaches: boolean;
    bumpCacheBust: boolean;
    statusDetail: string;
  }): boolean => {
    if (!fns.canMutateStyle()) return false;
    if (!navigator.serviceWorker?.controller) return false;

    if (opts.clearCaches) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_DEM_CACHE' });
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_NEGATIVE_CACHE' });
    }

    if (opts.bumpCacheBust) {
      st.demCacheBust = Date.now();
    }
    // Force a real source rebuild — `setTiles` alone keeps mapbox's
    // existing (possibly empty) tile pyramid, which is the typical cause
    // of "reload says 100% but the map stays flat". For a profile switch
    // this re-issues the new `rv-dem-profile` template so Mapbox refetches
    // through the SW (served from the profile-keyed cache when warm).
    if (!fns.refreshDemSource({ forceRebuild: true })) return false;

    st.demPassiveRefreshPending = false;
    st.demTrackingEnabled = false;
    fns.clearDemTracking();
    fns.reportStatus('loading', 0, opts.statusDetail);

    fns.armTerrainBootstrap(() => {
      st.demTrackingEnabled = true;
      fns.scheduleDemSettle();
    });
    fns.scheduleTerrainVerifyAfterReload();
    return true;
  };

  fns.performReloadOnce = (): boolean =>
    runReloadOnce({ clearCaches: true, bumpCacheBust: true, statusDetail: 'Rechargement relief' });

  // ── DEM profile switch (0.40 m surface ↔ 1 m terrain) ──────────────
  // Lightweight reload for the "Qualité 3D" selector. Critically it does
  // NOT clear the SW DEM/negative caches and does NOT bump the cache-bust
  // token: the Service Worker keys every DEM tile by profile
  // (buildDemCacheKey includes the profile), so keeping URLs stable lets a
  // switch back to a previously viewed profile come straight from
  // CacheStorage instead of re-fetching the entire viewport from IGN.
  let lastProfileReloadAt = 0;
  fns.reloadMapElevationForProfile = () => {
    // Fast 30 m mode is GPU-decoded AWS Terrarium with no profile concept;
    // the unified DEM pipeline is detached, so a profile change is a no-op
    // until the user returns to an HD quality.
    if (getActiveDem3dQuality() === 'fast-30m') return;

    const now = Date.now();
    if (now - lastProfileReloadAt < PROFILE_RELOAD_DEBOUNCE_MS) return;
    lastProfileReloadAt = now;

    // Don't collide with a heavy manual reload already in flight.
    if (st.reloadInProgress) return;

    if (runReloadOnce({ clearCaches: false, bumpCacheBust: false, statusDetail: 'Changement de relief' })) {
      st.reloadInProgress = true;
    }
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
