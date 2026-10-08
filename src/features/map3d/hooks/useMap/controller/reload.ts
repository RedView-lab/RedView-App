import { unifiedDEMSource } from '../../../lib/sources';
import { DEM_RELOAD_COOLDOWN_MS } from '../constants';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';
import { buildDemTilesTemplate } from '../demTiles';
import { resolveStyleInputSync } from '../stylePrefetch';
import type { Ctx } from './context';
import { clearVisibleTimer, setVisibleTimeout } from './visibleClock';
import { logger } from '@/shared/lib/logger';

// Fenêtre d'antirebond pour des changements de profil DEM consécutifs. Le
// chemin du profil est peu coûteux (aucun vidage de cache), mais un
// forceRebuild retire et réajoute quand même la source : regrouper les
// bascules rapides évite de malmener le graphe de tuiles de Mapbox.
const PROFILE_RELOAD_DEBOUNCE_MS = 250;
// Attente de disponibilité d'un rechargement demandé avant que le style / le SW puissent le prendre.
const RELOAD_READINESS_POLL_MS = 400;
const RELOAD_READINESS_MAX_POLLS = 25; // ~10 s de temps visible

/**
 * Pipeline de rechargement + escalade. Utilisé par le bouton de rechargement
 * manuel et par le chemin d'autoréparation dans `finishDemActivity`.
 */
export function attachReload(ctx: Ctx): void {
  const { map, isCancelled, getActiveStyleUrl } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  // Cœur de rechargement partagé. Le bouton de rechargement manuel vide les
  // caches du SW et change le jeton d'invalidation (force un nouveau
  // téléchargement propre depuis l'IGN) ; le changement de profil DEM garde les
  // deux stables, pour que les tuiles de chaque profil survivent dans
  // CacheStorage et qu'un *retour* soit instantané.
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
    // Force une vraie reconstruction de la source — `setTiles` seul garde la
    // pyramide de tuiles existante (peut-être vide) de Mapbox, cause typique de
    // « le rechargement affiche 100 % mais la carte reste plate ». Pour un
    // changement de profil, cela réémet le nouveau modèle `rv-dem-profile`, pour
    // que Mapbox redemande via le SW (servi depuis le cache indexé par profil
    // quand il est chaud).
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

  // ── Changement de profil DEM (surface 0,40 m ↔ terrain 1 m) ────────
  // Rechargement léger pour le sélecteur « Qualité 3D ». Point essentiel : il NE
  // vide PAS les caches DEM / négatifs du SW et NE change PAS le jeton
  // d'invalidation : le Service Worker indexe chaque tuile DEM par profil
  // (buildDemCacheKey inclut le profil), donc garder des URL stables permet à un
  // retour vers un profil déjà vu de venir directement de CacheStorage au lieu
  // de redemander toute la vue à l'IGN.
  let lastProfileReloadAt = 0;
  fns.reloadMapElevationForProfile = () => {
    // Le mode rapide 30 m est de l'AWS Terrarium décodé par le GPU, sans notion
    // de profil ; le pipeline du DEM unifié est détaché, donc un changement de
    // profil ne fait rien tant que l'utilisateur ne revient pas à une qualité HD.
    if (getActiveDem3dQuality() === 'fast-30m') return;

    // Un changement qui arrive dans la fenêtre d'antirebond, ou pendant un
    // rechargement lourd, est rejoué ensuite avec le profil actif *à ce
    // moment-là* — il était abandonné, laissant le terrain sur l'ancien profil
    // MNT / MNS alors que le sélecteur montrait le nouveau (audit d-basemap-static).
    const now = Date.now();
    const wait = PROFILE_RELOAD_DEBOUNCE_MS - (now - lastProfileReloadAt);
    if (wait > 0 || st.reloadInProgress) {
      if (!st.profileReloadTimer) {
        st.profileReloadTimer = setVisibleTimeout(() => {
          st.profileReloadTimer = null;
          if (!isCancelled()) fns.reloadMapElevationForProfile();
        }, Math.max(wait, st.reloadInProgress ? RELOAD_READINESS_POLL_MS : 0));
      }
      return;
    }
    lastProfileReloadAt = now;

    const profile = fns.getActiveDemProfile();
    const tiles = buildDemTilesTemplate(st.demCacheBust, profile);
    const existingSource = map.getSource(unifiedDEMSource.id) as {
      setTiles?: (tiles: string[]) => unknown;
      tiles?: string[];
    } | undefined;

    // Changement rejoué qui finit sur le profil déjà affiché : rien à recharger.
    if (existingSource?.tiles && existingSource.tiles.length === tiles.length
      && existingSource.tiles.every((url, index) => url === tiles[index])) return;

    if (existingSource && typeof existingSource.setTiles === 'function') {
      existingSource.setTiles(tiles);
      fns.refreshTrackedSourceIds();
      fns.applyUnifiedTerrain();
      st.demTrackingEnabled = true;
      fns.clearDemTracking();
      fns.reportStatus('loading', 20, profile === 'terrain' ? 'Relief 1 m' : 'Relief 0.40 m');
      fns.scheduleDemSettle();
      fns.scheduleSetTilesVerify();
      return;
    }

    if (runReloadOnce({ clearCaches: false, bumpCacheBust: false, statusDetail: 'Changement de relief' })) {
      st.reloadInProgress = true;
    }
  };

  fns.scheduleTerrainVerifyAfterReload = () => {
    clearVisibleTimer(st.reloadVerifyTimer);
    st.reloadVerifyTimer = setVisibleTimeout(() => {
      st.reloadVerifyTimer = null;
      if (isCancelled()) return;
      if (getActiveDem3dQuality() === 'fast-30m') return;

      const unifiedPresent = Boolean(map.getSource(unifiedDEMSource.id));
      const terrainBound = fns.isUnifiedTerrainActive();

      // Si le terrain est seulement délié, on tente un rattachement en douceur avant toute escalade
      if (unifiedPresent && !terrainBound) {
        fns.applyUnifiedTerrain();
        if (fns.isUnifiedTerrainActive()) {
          st.reloadInProgress = false;
          return;
        }
      }

      // Vérifie si des tuiles sont en cours de chargement (le DEM à 0,40 m prend 3 à 6 s à froid depuis l'IGN distant)
      let isSourceBusy = false;
      try {
        isSourceBusy = !map.isSourceLoaded(unifiedDEMSource.id);
      } catch {
        isSourceBusy = false;
      }
      const hasTileActivity = [...st.requestedTiles].some((key) => key.startsWith(`${unifiedDEMSource.id}:`))
        && st.requestedTiles.size > st.loadedTiles.size;

      // NE PAS détruire puis réappliquer le style si des tuiles sont en cours de chargement
      if (unifiedPresent && (isSourceBusy || hasTileActivity)) {
        logger.map3d.info('reload verify: tiles still loading, extending grace window');
        st.reloadVerifyTimer = setVisibleTimeout(() => {
          st.reloadVerifyTimer = null;
          if (isCancelled()) return;
          st.reloadInProgress = false;
        }, 5000);
        return;
      }

      // Si le terrain est encore complètement cassé après le délai de grâce, on escalade en douceur
      if (!terrainBound || !unifiedPresent) {
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
          map.setStyle(resolveStyleInputSync(getActiveStyleUrl()) as Parameters<typeof map.setStyle>[0], {
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
        const onLateStyleLoad = () => {
          map.off('style.load', onLateStyleLoad);
          if (isCancelled()) return;
          setVisibleTimeout(() => {
            if (isCancelled()) return;
            fns.performReloadOnce();
          }, 250);
        };
        map.on('style.load', onLateStyleLoad);
        return;
      }
      st.reloadInProgress = false;
      st.reloadStyleEscalations = 0;
    }, 9000);
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

    // Les conditions n'étaient pas réunies (style pas encore chargé, contrôleur
    // du SW absent). On n'affiche pas un faux statut « prêt » à 100 % — c'est ce
    // qui donnait l'impression d'un bouton cassé. On attend plutôt que tout soit
    // prêt pendant jusqu'à ~10 s de temps visible et on réessaie, puis on remonte
    // une vraie erreur si ça ne peut toujours pas tourner.
    st.reloadInProgress = true;
    fns.reportStatus('loading', 8, 'En attente du fond de carte');
    clearVisibleTimer(st.reloadReadinessTimer);
    let polls = 0;
    const tryAgain = () => {
      st.reloadReadinessTimer = null;
      if (isCancelled()) {
        st.reloadInProgress = false;
        return;
      }
      if (fns.performReloadOnce()) return;
      polls += 1;
      if (polls > RELOAD_READINESS_MAX_POLLS) {
        console.warn('[map3d] reload aborted: style/SW never became ready');
        fns.reportStatus('error', 0, 'Rechargement impossible');
        st.reloadInProgress = false;
        st.demReloadCoolingUntil = 0;
        return;
      }
      st.reloadReadinessTimer = setVisibleTimeout(tryAgain, RELOAD_READINESS_POLL_MS);
    };
    st.reloadReadinessTimer = setVisibleTimeout(tryAgain, 200);
  };
}
