import type { MapSourceDataEvent } from 'mapbox-gl';
import { unifiedDEMSource, awsFallbackDEMSource, awsFastDEMSource } from '../../../lib/sources';
import { TerrainManager } from '../../../lib/terrain';
import { buildDemTilesTemplate } from '../demTiles';
import type { Ctx } from './context';
import { DEM_SETTILE_VERIFY_MS } from './context';
import { clearVisibleTimer, setVisibleTimeout, type VisibleTimer } from './visibleClock';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';
import { logger } from '@/shared/lib/logger';

/**
 * Cycle de vie de la source DEM et de l'attachement du terrain.
 *
 * Renforts anti-plat :
 *  - `refreshDemSource({ forceRebuild })` retire la source pour que l'`addSource`
 *    suivant reconstruise la pyramide de tuiles de zéro (le chemin rapide
 *    `setTiles` laisse en place des tuiles vides en cache).
 *  - `scheduleSetTilesVerify` revérifie ~3,5 s après un rafraîchissement par
 *    `setTiles` seul que des tuiles ont bien commencé à charger ; si aucune
 *    tuile DEM n'a été demandée OU que le terrain n'est pas lié, reconstruction
 *    complète forcée.
 *  - `applyUnifiedTerrain` réémet toujours `setTerrain` même si le gestionnaire
 *    existe déjà (couvre le cas où Mapbox a détaché le terrain en silence après
 *    un style.load tardif).
 */
export function attachDemSource(ctx: Ctx): void {
  const { map, terrainRef, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;
  const terrainRecoveryRetryMs = 120;
  // ~6 s de temps visible pour que le style redevienne modifiable.
  const maxTerrainRecoveryAttempts = Math.ceil(6000 / terrainRecoveryRetryMs);

  fns.applyManagedTerrain = () => {
    // Le mode rapide 30 m court-circuite le pipeline du DEM unifié. AWS Terrarium
    // est décodé nativement sur le GPU — sans dépendance au SW ni à l'IGN —,
    // donc n'importe quel environnement peut y basculer instantanément.
    if (getActiveDem3dQuality() === 'fast-30m') {
      return fns.applyFastDemTerrain();
    }
    if (map.getSource(unifiedDEMSource.id)) {
      return fns.applyUnifiedTerrain();
    }
    if (map.getSource(awsFallbackDEMSource.id)) {
      fns.attachAwsFallbackTerrain();
      return fns.isManagedTerrainActive();
    }
    return false;
  };

  fns.applyUnifiedTerrain = () => {
    // Respecte le choix de qualité 3D de l'utilisateur : quand fast-30m est actif,
    // chaque appelant (bootstrap, vérification de stabilisation, rechargement,
    // handlers d'inactivité, …) doit aller vers la source rapide AWS au lieu de
    // relier le DEM HD unifié qu'on vient de quitter.
    if (getActiveDem3dQuality() === 'fast-30m') {
      return fns.applyFastDemTerrain();
    }
    if (!map.getSource(unifiedDEMSource.id)) return false;
    try {
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
        terrainRef.current.init();
      } else {
        terrainRef.current.setSource(unifiedDEMSource.id);
      }
      return true;
    } catch (error) {
      console.warn('[map3d] Unified terrain apply failed', error);
      return false;
    }
  };

  fns.detachManagedTerrain = () => {
    // On ne démonte le terrain que si la source de terrain active est l'une des
    // sources DEM gérées qui nous appartiennent. Les styles Mapbox Standard /
    // Standard-Satellite importés peuvent publier un moment leur propre terrain
    // intégré (`mapbox-dem`) pendant l'hydratation initiale ; le supprimer ici
    // avant le bootstrap du DEM unifié peut bloquer toute la chaîne de
    // disponibilité et laisser le globe plat pour de bon, sans aucune activité
    // `[map3d]` / `[sw-dem]`. Si notre référence est périmée mais que le terrain
    // actif n'est pas géré, on abandonne la référence sans modifier le style.
    let activeTerrainSource: string | null = null;
    try {
      activeTerrainSource = map.getTerrain()?.source ?? null;
    } catch {
      return;
    }
    const hasManagedTerrainActive = activeTerrainSource === unifiedDEMSource.id
      || activeTerrainSource === awsFallbackDEMSource.id
      || activeTerrainSource === awsFastDEMSource.id;
    if (!terrainRef.current && !hasManagedTerrainActive) return;

    if (terrainRef.current && hasManagedTerrainActive) {
      try {
        terrainRef.current.destroy();
      } catch {
        /* le démontage du terrain doit rester « au mieux » pendant les reconstructions de style */
      }
    }
    terrainRef.current = null;
    if (!hasManagedTerrainActive) return;
    try {
      map.setTerrain(null);
    } catch {
      /* le style est peut-être déjà en train de remplacer le graphe de terrain */
    }
  };

  fns.refreshDemSource = (options: { forceRebuild?: boolean } = {}): boolean => {
    if (!fns.canMutateStyle()) return false;
    if (!navigator.serviceWorker?.controller) {
      console.warn('[map3d] DEM source refresh skipped: no active service worker controller');
      return false;
    }

    st.disposeTerrainBootstrap?.();
    st.disposeTerrainBootstrap = null;
    clearVisibleTimer(st.setTilesVerifyTimer);
    st.setTilesVerifyTimer = null;

    const tiles = buildDemTilesTemplate(st.demCacheBust, fns.getActiveDemProfile());
    const existingSource = map.getSource(unifiedDEMSource.id) as {
      setTiles?: (tiles: string[]) => unknown;
    } | undefined;

    if (existingSource && !options.forceRebuild) {
      if (typeof existingSource.setTiles !== 'function') {
        console.warn('[map3d] DEM source refresh skipped: source cannot update tiles');
        return false;
      }
      existingSource.setTiles(tiles);
      fns.refreshTrackedSourceIds();
      fns.applyUnifiedTerrain();
      // Anti-plat : un rafraîchissement doux par setTiles garde la pyramide de
      // tuiles existante. On vérifie peu après que des tuiles ont bien commencé
      // à charger et que le terrain est lié — sinon on passe à une
      // reconstruction complète.
      fns.scheduleSetTilesVerify();
      return true;
    }

    if (existingSource && options.forceRebuild) {
      // Reconstruction complète : on détache d'abord le terrain géré pour que
      // Mapbox ne plante pas quand la source raster-dem disparaît sous le graphe
      // de terrain actif, puis on retire la source pour que l'addSource suivant
      // remplisse la pyramide de zéro (setTiles seul laisse en place des tuiles
      // vides en cache, ce qui laisse la carte plate après un rechargement doux).
      fns.detachManagedTerrain();
      try {
        map.setTerrain(null);
      } catch {
        /* noop */
      }
      let removeSucceeded = false;
      try {
        // Contournement d'un bug de Mapbox GL JS v3 : en projection globe, appeler setTerrain(null)
        // déclenche setTerrainForDraping(), qui laisse un objet terrain factice interne
        // { source: "", exaggeration: 0 } sans les enveloppes StyleProperty (.properties / .get).
        // Un map.removeSource() ultérieur exécute painter.updateTerrain(), qui plante
        // avec « TypeError: can't access property 'get', i is undefined ».
        // On détache le terrain interne avant removeSource pour un retrait sûr :
        const mapAny = map as unknown as {
          style?: { terrain?: unknown };
          painter?: { _terrain?: { enabled?: boolean } | null };
        };
        if (mapAny.style && 'terrain' in mapAny.style) {
          delete (mapAny.style as { terrain?: unknown }).terrain;
        }
        if (mapAny.painter?._terrain) {
          mapAny.painter._terrain.enabled = false;
        }

        map.removeSource(unifiedDEMSource.id);
        removeSucceeded = true;
      } catch (error) {
        console.warn('[map3d] DEM source remove failed (forceRebuild)', error);
        // Mapbox 3.x peut planter dans removeSource quand le graphe de terrain
        // interne garde une référence périmée (Cannot read properties of undefined
        // reading 'get'). Si la source existe encore, on retombe sur un
        // rafraîchissement doux par setTiles — mieux que de faire planter tout le
        // bootstrap.
        const staleSource = map.getSource(unifiedDEMSource.id) as {
          setTiles?: (tiles: string[]) => unknown;
        } | undefined;
        if (staleSource && typeof staleSource.setTiles === 'function') {
          console.warn('[map3d] falling back to setTiles after failed removeSource');
          staleSource.setTiles(tiles);
          fns.refreshTrackedSourceIds();
          terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
          fns.applyUnifiedTerrain();
          fns.scheduleSetTilesVerify();
          return true;
        }
      }
      // Si removeSource a levé une exception mais que la source a bien disparu
      // (course), on traite le cas comme un retrait réussi et on continue vers
      // l'addSource ci-dessous.
      if (!removeSucceeded && map.getSource(unifiedDEMSource.id)) {
        // Anti-plat : le terrain a été détaché en haut de cette branche et le
        // repli setTiles ci-dessus ne s'est pas déclenché (pas de méthode
        // setTiles). La source est toujours là — on y relie le terrain avant de
        // sortir, pour ne jamais laisser la carte plate avec une source DEM
        // utilisable en dessous.
        fns.applyUnifiedTerrain();
        return false;
      }
    }

    try {
      map.addSource(unifiedDEMSource.id, {
        type: 'raster-dem',
        tiles,
        tileSize: unifiedDEMSource.tileSize,
        encoding: unifiedDEMSource.encoding,
        minzoom: unifiedDEMSource.minzoom,
        maxzoom: unifiedDEMSource.maxzoom,
      });
    } catch (error) {
      console.warn('[map3d] DEM source attach failed', error);
      return false;
    }
    fns.refreshTrackedSourceIds();

    terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
    fns.applyUnifiedTerrain();
    return true;
  };

  fns.scheduleSetTilesVerify = () => {
    clearVisibleTimer(st.setTilesVerifyTimer);
    st.setTilesVerifyTimer = setVisibleTimeout(() => {
      st.setTilesVerifyTimer = null;
      if (isCancelled()) return;
      if (getActiveDem3dQuality() === 'fast-30m') return;
      if (!fns.canMutateStyle()) return;
      if (!map.getSource(unifiedDEMSource.id)) return;
      // Si le terrain n'est pas réellement lié à unified-dem après setTiles,
      // forcer une reconstruction propre — c'est le symptôme que signale
      // l'utilisateur (« la donnée semble là mais les tuiles ne se mettent pas
      // en relief »).
      if (!fns.isUnifiedTerrainActive()) {
        console.warn('[map3d] setTiles verify: terrain not bound, forcing rebuild');
        fns.refreshDemSource({ forceRebuild: true });
        return;
      }
      // Si aucune tuile DEM n'est encore chargée dans la source unified-dem, la
      // pyramide précédente est périmée / vide — reconstruction forcée pour tout
      // redemander via le SW.
      let unifiedLoaded = false;
      try {
        unifiedLoaded = map.isSourceLoaded(unifiedDEMSource.id);
      } catch {
        unifiedLoaded = false;
      }
      const hasUnifiedTileActivity = [...st.requestedTiles, ...st.loadedTiles]
        .some((key) => key.startsWith(`${unifiedDEMSource.id}:`));
      if (!unifiedLoaded && !hasUnifiedTileActivity) {
        console.warn('[map3d] setTiles verify: no DEM tile activity, forcing rebuild');
        fns.refreshDemSource({ forceRebuild: true });
      }
    }, DEM_SETTILE_VERIFY_MS);
  };

  fns.scheduleTerrainRecovery = () => {
    if (st.terrainRecoveryTimer) return;
    // Un court délai (au lieu de 0) laisse Mapbox finir la rafale de styledata
    // qui précède souvent le détachement du terrain — vérifier tout de suite
    // ferait la course avec la reconstruction.
    const runRecovery = (attempt: number) => {
      st.terrainRecoveryTimer = null;
      if (getActiveDem3dQuality() === 'fast-30m') {
        fns.applyFastDemTerrain();
        return;
      }
      if (!fns.canMutateStyle()) {
        if (attempt >= maxTerrainRecoveryAttempts) return;
        st.terrainRecoveryTimer = setVisibleTimeout(() => {
          runRecovery(attempt + 1);
        }, terrainRecoveryRetryMs);
        return;
      }
      if (!navigator.serviceWorker?.controller) return;

      if (!map.getSource(unifiedDEMSource.id)) {
        if (!fns.refreshDemSource()) return;
        fns.reportStatus('loading', 68, 'Relief');
        fns.armTerrainBootstrap(() => {
          st.demTrackingEnabled = true;
          fns.scheduleDemSettle();
        });
        return;
      }

      fns.refreshTrackedSourceIds();
      if (!fns.isManagedTerrainActive()) {
        fns.applyUnifiedTerrain();
        // Si le rattachement n'a pas pris, la source est probablement périmée. On
        // force une reconstruction plutôt que de laisser la carte plate.
        if (!fns.isManagedTerrainActive()) {
          console.warn('[map3d] terrain re-attach failed; forcing source rebuild');
          fns.refreshDemSource({ forceRebuild: true });
        }
      }
    };

    st.terrainRecoveryTimer = setVisibleTimeout(() => {
      runRecovery(0);
    }, 60);
  };

  fns.armTerrainBootstrap = (onReady: () => void) => {
    st.disposeTerrainBootstrap?.();

    let applied = false;
    let fallbackTimer: VisibleTimer | null = null;
    const complete = () => {
      if (applied) return;
      applied = true;
      map.off('sourcedata', onSourceData);
      clearVisibleTimer(fallbackTimer);
      fallbackTimer = null;
      st.disposeTerrainBootstrap = null;
      fns.applyUnifiedTerrain();
      fns.reportStatus('loading', 82, 'Terrain');
      onReady();
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (applied) return;
      if (event.sourceId !== unifiedDEMSource.id) return;
      if (!event.isSourceLoaded) return;
      complete();
    };

    st.disposeTerrainBootstrap = () => {
      map.off('sourcedata', onSourceData);
      clearVisibleTimer(fallbackTimer);
      fallbackTimer = null;
    };

    fns.applyUnifiedTerrain();
    map.on('sourcedata', onSourceData);

    if (map.isSourceLoaded(unifiedDEMSource.id)) {
      onSourceData({ sourceId: unifiedDEMSource.id, isSourceLoaded: true } as MapSourceDataEvent);
    } else {
      fallbackTimer = setVisibleTimeout(complete, 1200);
    }
  };

  // ── Repli direct AWS Terrarium ─────────────────────────────────────
  // Utilisé quand le SW ne prend jamais le contrôle. Attache directement les
  // tuiles AWS Open Data Terrarium comme source raster-dem avec l'encodage natif
  // `terrarium`. Mapbox GL v3 décode sur le GPU — pas de pipeline SW, pas de
  // réencodage, pas de logique d'overzoom. Terrain mondial à ~30 m.
  fns.attachAwsFallbackTerrain = () => {
    if (!fns.canMutateStyle()) return;
    // Respecte le choix de qualité 3D de l'utilisateur : en mode fast-30m, la
    // source rapide possède la liaison du terrain ; le chemin de repli ne doit
    // pas la remplacer.
    if (getActiveDem3dQuality() === 'fast-30m') {
      fns.applyFastDemTerrain();
      return;
    }
    // Pas d'attachement si la source unified-dem est déjà présente (le chemin
    // SW a pris le relais).
    if (map.getSource(unifiedDEMSource.id)) return;
    const sourceAlreadyPresent = !!map.getSource(awsFallbackDEMSource.id);

    if (!sourceAlreadyPresent) {
      try {
        map.addSource(awsFallbackDEMSource.id, {
          type: 'raster-dem',
          tiles: awsFallbackDEMSource.tiles,
          tileSize: awsFallbackDEMSource.tileSize,
          encoding: awsFallbackDEMSource.encoding,
          minzoom: awsFallbackDEMSource.minzoom,
          maxzoom: awsFallbackDEMSource.maxzoom,
        });
      } catch (error) {
        console.warn('[map3d] AWS fallback DEM source attach failed', error);
        return;
      }
    }

    try {
      terrainRef.current = new TerrainManager(map, awsFallbackDEMSource.id);
      terrainRef.current.init();
      logger.map3d.info(
        sourceAlreadyPresent
          ? 'AWS Terrarium fallback terrain re-attached'
          : 'AWS Terrarium fallback terrain attached',
      );
    } catch (error) {
      console.warn('[map3d] AWS fallback terrain apply failed', error);
    }
  };

  fns.detachAwsFallbackTerrain = () => {
    let hasAwsSource = false;
    let activeTerrainSource: string | null = null;
    try {
      hasAwsSource = !!map.getSource(awsFallbackDEMSource.id);
    } catch { /* au mieux */ }
    try {
      activeTerrainSource = map.getTerrain()?.source ?? null;
    } catch { /* au mieux */ }

    if (!hasAwsSource && activeTerrainSource !== awsFallbackDEMSource.id) return;

    if (activeTerrainSource === awsFallbackDEMSource.id) {
      try {
        terrainRef.current?.destroy();
      } catch { /* au mieux */ }
      terrainRef.current = null;
      try {
        map.setTerrain(null);
      } catch { /* au mieux */ }
    }

    try {
      if (hasAwsSource) {
        map.removeSource(awsFallbackDEMSource.id);
        logger.map3d.info('AWS fallback DEM source removed');
      }
    } catch (error) {
      console.warn('[map3d] AWS fallback DEM source remove failed', error);
    }
  };

  // ── Mode rapide 30 m (AWS Terrarium en direct, sans SW) ───────────
  // Même pipeline AWS Open Data Terrarium que le repli, mais attaché sous son
  // propre identifiant de source `aws-fast-dem` pour coexister sans conflit avec
  // la source unifiée du SW — ce qui permet de basculer instantanément entre les
  // qualités HD et Rapide. Le cache HTTP du navigateur et le cache de tuiles par
  // source de Mapbox rendent chaque bascule suivante sans aucun délai visible.
  fns.applyFastDemTerrain = () => {
    if (!fns.canMutateStyle()) return false;
    const sourceAlreadyPresent = !!map.getSource(awsFastDEMSource.id);
    if (!sourceAlreadyPresent) {
      try {
        map.addSource(awsFastDEMSource.id, {
          type: 'raster-dem',
          tiles: awsFastDEMSource.tiles,
          tileSize: awsFastDEMSource.tileSize,
          encoding: awsFastDEMSource.encoding,
          minzoom: awsFastDEMSource.minzoom,
          maxzoom: awsFastDEMSource.maxzoom,
        });
      } catch (error) {
        console.warn('[map3d] AWS fast DEM source attach failed', error);
        return false;
      }
    }

    try {
      // Remplace toute liaison TerrainManager existante (qui peut viser
      // unified-dem ou aws-fallback-dem) par une nouvelle pointant sur la source
      // rapide. TerrainManager.init() émet setTerrain, que Mapbox traite comme un
      // remplacement à chaud — aucune image plate entre les deux.
      let activeTerrainSource: string | null = null;
      try { activeTerrainSource = map.getTerrain()?.source ?? null; } catch { /* au mieux */ }
      const alreadyBound = activeTerrainSource === awsFastDEMSource.id;
      if (alreadyBound && terrainRef.current) {
        terrainRef.current.init();
        return true;
      }
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, awsFastDEMSource.id);
        terrainRef.current.init();
      } else {
        terrainRef.current.setSource(awsFastDEMSource.id);
      }
      logger.map3d.info(
        sourceAlreadyPresent
          ? 'fast 30 m terrain re-bound'
          : 'fast 30 m terrain attached',
      );
      return true;
    } catch (error) {
      console.warn('[map3d] fast 30 m terrain apply failed', error);
      return false;
    }
  };

  // Point d'entrée du changement de qualité. Idempotent — peut être appelé
  // plusieurs fois avec la même valeur (rien ne se passe si le terrain voulu est
  // déjà lié). Conçu pour une bascule côté utilisateur sans scintillement.
  fns.setDem3dQuality = (quality) => {
    if (!fns.canMutateStyle()) return;

    if (quality === 'fast-30m') {
      fns.applyFastDemTerrain();
      fns.reportStatus('ready', 100, 'Relief 30 m (rapide)');
      return;
    }

    // mode 'hd' :
    const profile = fns.getActiveDemProfile();
    const tiles = buildDemTilesTemplate(st.demCacheBust, profile);
    let unifiedSource = map.getSource(unifiedDEMSource.id) as {
      setTiles?: (tiles: string[]) => unknown;
    } | undefined;

    if (!unifiedSource) {
      try {
        map.addSource(unifiedDEMSource.id, {
          type: 'raster-dem',
          tiles,
          tileSize: unifiedDEMSource.tileSize,
          encoding: unifiedDEMSource.encoding,
          minzoom: unifiedDEMSource.minzoom,
          maxzoom: unifiedDEMSource.maxzoom,
        });
        unifiedSource = map.getSource(unifiedDEMSource.id) as {
          setTiles?: (tiles: string[]) => unknown;
        } | undefined;
      } catch (error) {
        console.warn('[map3d] DEM source attach failed during quality switch', error);
      }
    } else if (typeof unifiedSource.setTiles === 'function') {
      unifiedSource.setTiles(tiles);
    }

    fns.refreshTrackedSourceIds();

    if (map.getSource(unifiedDEMSource.id)) {
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
        terrainRef.current.init();
      } else {
        terrainRef.current.setSource(unifiedDEMSource.id);
      }
      st.demTrackingEnabled = true;
      fns.clearDemTracking();
      fns.reportStatus('loading', 25, profile === 'terrain' ? 'Relief 1 m' : 'Relief 0.40 m');
      fns.scheduleDemSettle();
      fns.scheduleSetTilesVerify();
      logger.map3d.info('HD terrain hot-swapped (unified DEM)');
      return;
    }

    if (map.getSource(awsFallbackDEMSource.id)) {
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, awsFallbackDEMSource.id);
        terrainRef.current.init();
      } else {
        terrainRef.current.setSource(awsFallbackDEMSource.id);
      }
      logger.map3d.info('HD terrain unavailable — bound to AWS fallback');
    }
  };
}
