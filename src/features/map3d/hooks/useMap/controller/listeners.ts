import type { ErrorEvent as MapboxErrorEvent, MapSourceDataEvent } from 'mapbox-gl';
import { awsFallbackDEMSource, awsFastDEMSource, ignOrthoSource, unifiedDEMSource } from '../../../lib/sources';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';
import { getActiveDemProfilePreference } from '../../../lib/demProfileBus';
import { installViewportPrefetch } from '../../../lib/viewportPrefetch';
import type { Ctx } from './context';
import { installDemWantedTilesSync } from './demWantedTiles';
import { clearVisibleTimer } from './visibleClock';
import { logger } from '@/shared/lib/logger';

/**
 * Écouteurs de suivi des tuiles + accroches aux événements de style /
 * d'inactivité. Centralisés pour que le nettoyage détache tout en un seul appel.
 *
 * Renfort anti-plat : `onMapIdle` revérifie aussi que le terrain est toujours
 * lié au DEM unifié. Si Mapbox a perdu le terrain en silence (cas typique après
 * un style.load tardif lors d'un changement de fond), l'inactivité est le
 * premier moment fiable pour le détecter et le rattacher.
 */
export function attachListeners(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;
  let styleDataTerrainRepairTimer: ReturnType<typeof setTimeout> | null = null;
  // Sources d'overlays dérivés (pente, altitude) en attente de rechargement : un
  // seul minuteur recharge toutes les sources mises en file avant son déclenchement.
  const pendingDerivedReloads = new Set<string>();
  const staleSourcesAwaitingMoveEnd = new Set<string>();

  const repairManagedTerrain = (): boolean => {
    const managedSourceId = fns.getManagedTerrainSourceId();
    if (!managedSourceId) return false;
    if (managedSourceId === awsFastDEMSource.id) {
      return fns.applyFastDemTerrain();
    }
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
    // Anti-plat : si la source du DEM unifié manque toujours mais que le
    // contrôleur du SW est enfin apparu, on fait évoluer tout de suite le chemin
    // de repli AWS / Mapbox simple depuis l'inactivité — le premier moment sûr
    // pour modifier le style.
    if (
      getActiveDem3dQuality() !== 'fast-30m'
      &&
      fns.canMutateStyle()
      && !map.getSource(unifiedDEMSource.id)
      && navigator.serviceWorker?.controller
    ) {
      console.warn('[map3d] idle: DEM source missing but SW available — re-bootstrapping');
      void fns.bootstrapCurrentStyle();
      return;
    }
    // Anti-plat : l'inactivité est le signal fiable le moins coûteux d'un
    // détachement silencieux du terrain. Si la source DEM existe mais que le
    // terrain n'est pas lié, on le rattache tout de suite.
    //
    // On utilise ici `isManagedTerrainActive()` (contrôle de liaison), pas
    // `isManagedTerrainRenderable()` — la sonde d'affichabilité renvoie false
    // au-dessus de l'eau / à l'échelle du globe même quand le terrain va bien, ce
    // qui déclenchait une boucle de rattachement qui affamait le chargement des
    // tuiles du fond de carte.
    if (fns.canMutateStyle()) {
      const managedSourceId = fns.getManagedTerrainSourceId();
      if (managedSourceId && !fns.isManagedTerrainActive()) {
        console.warn(
          `[map3d] idle: terrain detached from ${managedSourceId}; re-attaching`,
        );
        if (!repairManagedTerrain() && managedSourceId === unifiedDEMSource.id) {
        // Rattachement refusé — escalade vers une reconstruction forcée par le
        // chemin de rechargement standard (sans délai de récupération, car c'est
        // une vraie régression et non une action de l'utilisateur).
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

  // Anti-plat : Standard / Standard-Satellite peuvent émettre des rafales de
  // `styledata` supplémentaires après l'attachement de la source DEM, et ces
  // mises à jour de styles importés peuvent en silence ramener la source de
  // terrain active ailleurs qu'`unified-dem` pendant que `isStyleLoaded()` est
  // encore false. On réagit dès la macrotâche suivante au lieu d'attendre
  // `idle` / le battement de cœur.
  const onStyleDataTerrainCheck = () => {
    if (isCancelled()) return;
    if (styleDataTerrainRepairTimer) return;
    styleDataTerrainRepairTimer = setTimeout(() => {
      styleDataTerrainRepairTimer = null;
      if (isCancelled()) return;
      const managedSourceId = fns.getManagedTerrainSourceId();
      if (!managedSourceId) return;
      const terrainBound = fns.isManagedTerrainActive();
      const terrainRenderable = fns.isManagedTerrainRenderable();
      if (terrainBound && terrainRenderable) return;
      if (terrainBound) return;
      console.warn(
        `[map3d] styledata: ${managedSourceId} present but terrain ${terrainBound ? 'non-renderable' : 'unbound'}; re-attaching`,
      );
      repairManagedTerrain();
    }, 0);
  };

  // Anti-plat : vérifie la liaison du terrain après chaque zoom. Mapbox GL v3
  // perd parfois le terrain en silence pendant les transitions de zoom (quand la
  // pyramide de tuiles franchit des niveaux z). On le rattache tout de suite pour
  // que l'utilisateur ne voie jamais d'image plate.
  //
  // Important : ne déclencher le chemin de rattachement bruyant que si le
  // terrain est vraiment délié (`isManagedTerrainActive()` à false). Le contrôle
  // d'affichabilité renvoie aussi false quand la caméra est centrée sur l'eau ou
  // sur le globe à l'échelle du monde, où `queryTerrainElevation` renvoie null à
  // chaque point d'échantillonnage — ce ne sont PAS de vrais détachements, et
  // ils provoquaient des boucles de spam dans la console + des modifications de
  // style répétées qui privaient le fond de carte de son budget de tuiles.
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
    if (event.data?.type === 'DEM_PENTE_LOG') {
      return;
    }

    if (event.data?.type === 'ZONE_SLOPE_PROGRESS') {
      const { phase, loaded, total, percent } = event.data;
      if (phase === 'low' && (loaded === 0 || loaded === 1)) {
        logger.map3d.info(`zone slopes: start, ${total} z14 tiles`);
      } else if (phase === 'low' && (loaded === total || loaded % 10 === 0)) {
        logger.map3d.info(`zone slopes: 30 m preview ${loaded}/${total} (${percent}%)`);
      } else if (phase === 'hd' && (loaded === total || loaded % 5 === 0)) {
        logger.map3d.info(`zone slopes: LiDAR HD ${loaded}/${total} (${percent}%)`);
      } else if (phase === 'done') {
        logger.map3d.info(`zone slopes: LiDAR HD ready (${total} tiles)`);
        // Safety reload on done
        try {
          const sourceCaches = (map.style as unknown as {
            _sourceCaches?: Record<string, { reload?: () => void }>;
            sourceCaches?: Record<string, { reload?: () => void }>;
          });
          const caches = sourceCaches?._sourceCaches ?? sourceCaches?.sourceCaches;
          if (caches) {
            for (const key of Object.keys(caches)) {
              if (key === 'slope-tiles' || key.endsWith(':slope-tiles')) {
                try { caches[key].reload?.(); } catch { /* noop */ }
              }
            }
            map.triggerRepaint();
          }
        } catch { /* noop */ }
      }
      return;
    }

    // Pente par défaut. L'altitude seulement sur ALTITUDE_TILES_STALE : elle
    // relit le DEM du terrain (Terrarium en fast-30m, passage direct par le SW en
    // HD), et les bandes hypsométriques ne gagnent rien à un rechargement complet
    // de la pyramide à chaque mise à niveau de DEM — seules ses tuiles
    // provisoires en ont besoin.
    const scheduleDerivedCachesReload = (delayMs = 250, sourceIds: readonly string[] = ['slope-tiles']) => {
      for (const id of sourceIds) pendingDerivedReloads.add(id);
      if (st.derivedReloadTimer) clearTimeout(st.derivedReloadTimer);
      st.derivedReloadTimer = setTimeout(() => {
        st.derivedReloadTimer = null;
        const ids = [...pendingDerivedReloads];
        pendingDerivedReloads.clear();
        try {
          const sourceCaches = (map.style as unknown as {
            _sourceCaches?: Record<string, { reload?: () => void }>;
            sourceCaches?: Record<string, { reload?: () => void }>;
          });
          const caches = sourceCaches?._sourceCaches ?? sourceCaches?.sourceCaches;
          if (!caches) return;
          for (const key of Object.keys(caches)) {
            if (ids.some((id) => key === id || key.endsWith(`:${id}`))) {
              try { caches[key].reload?.(); } catch { /* noop */ }
            }
          }
          map.triggerRepaint();
        } catch { /* noop */ }
      }, delayMs);
    };

    if (event.data?.type === 'SLOPE_ZONE_HD_READY' || event.data?.type === 'SLOPE_ZONE_PHASE1_READY') {
      scheduleDerivedCachesReload(0);
      return;
    }

    // Le SW a répondu à certaines tuiles de pente / d'altitude par un remplaçant
    // ou une construction provisoire (travail annulé par un geste de
    // déplacement / zoom, DEM pas encore construit, voisines manquantes). Mapbox
    // garde toute image en 200 comme définitive, donc ces tuiles restaient vides
    // jusqu'à leur sortie de la vue. On recharge cette source une fois le geste
    // terminé — un rechargement pendant le geste serait de nouveau annulé par le
    // movestart suivant. Les tuiles complètes reviennent du niveau chaud du SW.
    const staleSourceId = event.data?.type === 'SLOPE_TILES_STALE'
      ? 'slope-tiles'
      : event.data?.type === 'ALTITUDE_TILES_STALE'
        ? 'altitude-tiles'
        : null;
    if (staleSourceId) {
      const reloadWhenSettled = (): void => {
        if (isCancelled()) return;
        if (map.isMoving()) {
          if (staleSourcesAwaitingMoveEnd.has(staleSourceId)) return;
          staleSourcesAwaitingMoveEnd.add(staleSourceId);
          map.once('moveend', () => {
            staleSourcesAwaitingMoveEnd.delete(staleSourceId);
            reloadWhenSettled();
          });
          return;
        }
        scheduleDerivedCachesReload(400, [staleSourceId]);
      };
      reloadWhenSettled();
      return;
    }

    if (event.data?.type === 'SLOPE_TILE_UPDATED') {
      // On ignore les mises à jour par tuile propres à une zone, pour éviter des rechargements tuile par tuile en patchwork
      if (event.data?.zone) return;
      scheduleDerivedCachesReload(200);
      return;
    }

    if (event.data?.type !== 'DEM_TILE_CACHE_UPDATED') return;

    // ── Cette mise à jour du cache touche-t-elle le maillage du FOND DE CARTE ? ──
    // Un rafraîchissement passif du fond de carte coûte cher :
    // `applyPendingDemPassiveRefresh` incrémente `st.demCacheBust`, ce qui réécrit
    // l'URL de chaque tuile DEM et force un nouveau téléchargement complet du
    // terrain visible (très visible en Satellite). Il ne vaut la peine que si la
    // tuile qui vient de changer dans le cache du SW alimente vraiment le relief
    // du fond de carte.
    //
    // Deux mises à jour n'alimentent PAS le fond de carte et doivent être
    // traitées comme concernant seulement les overlays dérivés (recharger pente /
    // altitude, ne jamais toucher à la source DEM) :
    //   1. `source === 'slope-seam-heal'` — le SW n'a fait que préchauffer des
    //      tuiles DEM *voisines* pour que le remplissage de Horn 3×3 de l'overlay
    //      des pentes soit sans jointure. Le rendu DEM du fond de carte ne change
    //      pas. Des dizaines de ces mises à jour arrivent quand la pente à 1 m est
    //      active ; avant ce garde-fou, elles mettaient en file un rafraîchissement
    //      passif qui se déclenchait (invalidation + reconstruction complète du
    //      DEM) dès que l'overlay était démonté et que `idle` survenait → « la
    //      carte met une éternité à charger après avoir désactivé la pente 1 m ».
    //   2. Une vraie mise à niveau de qualité construite pour un profil DEM qui
    //      n'est PAS celui du fond de carte actif (p. ex. une mise à niveau de
    //      tuile de pente à 1 m du profil terrain alors que le fond de carte
    //      tourne sur la surface 0,40 m par défaut). Le fond de carte lit une autre
    //      tuile indexée par profil : la rafraîchir redemanderait des octets
    //      identiques.
    const source = typeof event.data.source === 'string' ? event.data.source : '';
    const tileProfile = typeof event.data.profile === 'string' ? event.data.profile : null;
    const isSlopeUpdate = source === 'slope-seam-heal' || source.startsWith('slope');
    const profileMatchesBasemap =
      tileProfile == null || tileProfile === getActiveDemProfilePreference();
    const affectsBasemap = !isSlopeUpdate && profileMatchesBasemap;

    if (affectsBasemap) {
      st.demPassiveRefreshPending = true;
      fns.scheduleDemSettle();
    }

    // Invalidation par tuile des caches dérivés pente / altitude, pour que la
    // résolution du DEM mis à niveau apparaisse vraiment dans les overlays. Sans
    // cela, l'utilisateur voit un « délai » entre la mise à niveau du DEM HD et le
    // rattrapage de la pente — les PNG de pente / altitude encodent l'ANCIEN DEM
    // jusqu'à la suppression de l'entrée du SW.
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
      scheduleDerivedCachesReload(300);
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

  let lastSyncCenterAt = 0;
  const syncViewportCenterToSW = () => {
    if (isCancelled()) return;
    const now = Date.now();
    if (now - lastSyncCenterAt < 150) return;
    lastSyncCenterAt = now;
    try {
      const center = map.getCenter();
      navigator.serviceWorker?.controller?.postMessage({
        type: 'SET_VIEWPORT_CENTER',
        center: { lng: center.lng, lat: center.lat },
        z: map.getZoom(),
      });
    } catch { /* best-effort */ }
  };

  fns.ensureTrackingListeners = () => {
    if (st.trackingListenersBound) return;
    map.on('sourcedataloading', onTrackedSourceDataLoading);
    map.on('sourcedata', onTrackedSourceData);
    map.on('dataabort', onTrackedSourceAbort);
    map.on('error', onTrackedTileError);
    map.on('move', syncViewportCenterToSW);
    map.on('moveend', syncViewportCenterToSW);
    map.on('moveend', fns.scheduleDemSettle);
    map.on('zoomend', fns.scheduleDemSettle);
    map.on('zoomend', onZoomEndTerrainCheck);
    map.on('movestart', onMovestart);
    map.on('idle', onMapIdle);
    map.on('styledata', onStyleDataTerrainCheck);
    map.on('styledata', fns.scheduleTerrainRecovery);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    syncViewportCenterToSW();
    // Préchargement spéculatif à la Strava : on préchauffe l'anneau d'une tuile
    // autour de la bbox visible + les 4 enfants z+1 du centre à chaque
    // inactivité. Les tuiles arrivent dans le CacheStorage du SW avec une faible
    // priorité H2 (elles ne passent pas devant les fetchs des tuiles visibles),
    // donc les déplacements / zooms suivants s'affichent depuis le cache au lieu
    // de payer l'aller-retour du fournisseur (50 à 400 ms à froid).
    if (!st.disposeViewportPrefetch) {
      const handle = installViewportPrefetch(map, {
        isOrthoActive: () => Boolean(map.getSource(ignOrthoSource.id)),
        // Les tuiles de pente sont dérivées par le SW du DEM en cache. Les
        // préchauffer avec leur tuile DEM parente signifie que, quand
        // l'utilisateur se déplace / zoome dans le voisinage préchargé, le
        // pipeline du SW (Horn / décodage / encodage PNG) a déjà tourné — le
        // raster apparaît en un aller-retour de chargement de tuile Mapbox au
        // lieu de plusieurs secondes de pipeline à froid. La détection se fait
        // par le calque (style.getLayer) — le hook des pentes bascule la
        // visibilité du calque, pas la présence de la source, il faut donc
        // regarder le calque.
        isSlopeActive: () => {
          try {
            return Boolean(map.getLayer('slope-overlay'))
              && map.getLayoutProperty('slope-overlay', 'visibility') !== 'none';
          } catch { return false; }
        },
      });
      st.disposeViewportPrefetch = handle.dispose;
    }
    // Le SW garde le travail LiDAR de chaque tuile de terrain que la carte
    // attend encore, quoi que fasse la caméra, et abandonne le reste
    // (demWantedTiles.ts).
    if (!st.disposeDemWantedTilesSync) {
      st.disposeDemWantedTilesSync = installDemWantedTilesSync(map);
    }
    // ── Indicateur d'appariement DEM ↔ Ortho (accélération côté SW) ──────
    // Quand le fond satellite est actif, on demande au SW d'associer à chaque
    // requête /dem-tiles un fetch /ortho-tiles immédiat en arrière-plan. Supprime
    // l'écart perçu « DEM d'abord, ortho 200 à 800 ms plus tard » au chargement à
    // froid d'une vue. Le SW conditionne tout à cet indicateur, pour ne PAS
    // gaspiller de fetchs d'ortho IGN quand l'utilisateur est sur un fond non
    // satellite (topo, plan IGN).
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
      syncOrthoPairing(); // déclenché une fois tout de suite au cas où la source serait déjà montée
      st.disposeOrthoPairingSync = () => {
        try { map.off('styledata', syncOrthoPairing); } catch { /* ignore */ }
        // Dit au SW d'arrêter l'appariement au démontage.
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
    map.off('move', syncViewportCenterToSW);
    map.off('moveend', syncViewportCenterToSW);
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
    st.disposeDemWantedTilesSync?.();
    st.disposeDemWantedTilesSync = null;
    st.trackingListenersBound = false;
  };

  fns.clearStyleBootstrapArtifacts = () => {
    st.disposeTerrainBootstrap?.();
    st.disposeTerrainBootstrap = null;
    st.disposeStyleRecovery?.();
    st.disposeStyleRecovery = null;
    clearVisibleTimer(st.orthoBootTimer);
    st.orthoBootTimer = null;
    clearVisibleTimer(st.readyFallbackTimer);
    st.readyFallbackTimer = null;
    clearVisibleTimer(st.terrainRecoveryTimer);
    st.terrainRecoveryTimer = null;
    clearVisibleTimer(st.reloadVerifyTimer);
    st.reloadVerifyTimer = null;
    clearVisibleTimer(st.reloadReadinessTimer);
    st.reloadReadinessTimer = null;
    clearVisibleTimer(st.profileReloadTimer);
    st.profileReloadTimer = null;
    clearVisibleTimer(st.setTilesVerifyTimer);
    st.setTilesVerifyTimer = null;
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
