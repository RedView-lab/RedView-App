import { unifiedDEMSource, awsFallbackDEMSource, awsFastDEMSource } from '../../../lib/sources';
import {
  TERRAIN_HEARTBEAT_INTERVAL_MS,
  TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD,
  type Ctx,
} from './context';
import { clearVisibleTimer, setVisibleInterval } from './visibleClock';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';

/**
 * Battement de cœur anti-plat. Une fois que le bootstrap a signalé « prêt » au
 * moins une fois, vérifie périodiquement que le terrain est toujours lié au DEM
 * unifié. C'est la dernière ligne de défense contre les pertes de terrain
 * silencieuses (Mapbox détache parfois le terrain après un style.load tardif ou
 * après une tempête de rejets de sprites / d'images, sans émettre d'erreur).
 *
 * Escalade :
 *   1. Tentative de rattachement doux (`applyUnifiedTerrain`).
 *   2. Si le battement suivant voit encore un état plat, rechargement complet
 *      forcé (`reloadMapElevation`, sans délai de récupération).
 *   3. Après des échecs répétés, l'escalade standard du rechargement prend le
 *      relais (réapplication du style, etc.).
 *   4. NOUVEAU : si le contrôleur du SW est maintenant disponible mais qu'aucune
 *      source DEM n'a jamais été ajoutée (session à prise de contrôle tardive du
 *      SW bloquée en mode Mapbox simple), relance complète du bootstrap.
 */
export function attachHeartbeat(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.startTerrainHeartbeat = () => {
    if (st.heartbeatTimer) return;
    st.heartbeatFailures = 0;
    let tickCount = 0;
    st.heartbeatTimer = setVisibleInterval(() => {
      tickCount += 1;
      if (isCancelled()) {
        fns.stopTerrainHeartbeat();
        return;
      }
      // Pas de sonde pendant qu'un rechargement est en cours — ces chemins font
      // leur propre vérification.
      if (st.reloadInProgress) return;
      if (!fns.canMutateStyle()) return;
      // Le mode rapide 30 m possède directement la liaison du terrain. La source
      // aws-fast-dem est très stable (AWS S3) : on vérifie seulement qu'elle est
      // toujours liée et on la rattache dans le rare cas d'un détachement. Pas
      // d'escalade de rechargement.
      if (getActiveDem3dQuality() === 'fast-30m') {
        try {
          const currentTerrain = map.getTerrain();
          if (currentTerrain?.source === awsFastDEMSource.id) {
            st.heartbeatFailures = 0;
            return;
          }
        } catch { /* requête de terrain échouée */ }
        // Détachement silencieux — on rattache.
        try {
          fns.applyFastDemTerrain();
          st.heartbeatFailures = 0;
        } catch { /* au mieux */ }
        return;
      }
      // Autorise l'autoréparation avant même le premier signal « prêt » si le
      // battement tourne depuis un moment (3 battements de temps visible). Couvre
      // les bootstraps qui se bloquent et n'appellent jamais finishDemActivity.
      if (!st.hasReportedReadyOnce && tickCount < 3) return;

      const sourcePresent = !!map.getSource(unifiedDEMSource.id);
      const awsFallbackPresent = !!map.getSource(awsFallbackDEMSource.id);
      const terrainBound = fns.isUnifiedTerrainActive();
      const terrainRenderable = fns.isManagedTerrainRenderable();

      // Le terrain de repli AWS est actif — c'est l'état attendu quand le SW n'a
      // jamais pris le contrôle. Le terrain est réel (AWS Terrarium à ~30 m),
      // simplement en plus basse résolution. On ne signale pas d'état plat.
      if (awsFallbackPresent && !sourcePresent) {
        try {
          const currentTerrain = map.getTerrain();
          if (currentTerrain?.source === awsFallbackDEMSource.id) {
            st.heartbeatFailures = 0;
            return;
          }
        } catch { /* requête de terrain échouée */ }
        // La source AWS existe mais le terrain n'y est pas lié — on tente de le rattacher
        try {
          map.setTerrain({ source: awsFallbackDEMSource.id, exaggeration: 1.5 });
          st.heartbeatFailures = 0;
          return;
        } catch { /* rattachement de repli échoué */ }
      }

      let isSourceBusy = false;
      try {
        isSourceBusy = !map.isSourceLoaded(unifiedDEMSource.id);
      } catch {
        isSourceBusy = false;
      }
      const hasTileActivity = [...st.requestedTiles].some((key) => key.startsWith(`${unifiedDEMSource.id}:`))
        && st.requestedTiles.size > st.loadedTiles.size;

      if (sourcePresent && terrainBound && (terrainRenderable || isSourceBusy || hasTileActivity)) {
        st.heartbeatFailures = 0;
        return;
      }

      st.heartbeatFailures += 1;
      console.warn(
        '[map3d] heartbeat: flat state detected',
        {
          sourcePresent,
          awsFallbackPresent,
          terrainBound,
          terrainRenderable,
          failures: st.heartbeatFailures,
        },
      );

      // Correction douce d'abord : rattachement si la source est encore là.
      if (sourcePresent && !terrainBound) {
        fns.applyUnifiedTerrain();
        if (fns.isUnifiedTerrainActive()) {
          st.heartbeatFailures = 0;
          return;
        }
      }

      // Si la source DEM n'a jamais été ajoutée ET que le contrôleur du SW est
      // maintenant disponible, on est dans une session à prise de contrôle
      // tardive du SW restée bloquée en mode Mapbox simple. La seule correction
      // est de relancer tout le bootstrap.
      if (!sourcePresent && navigator.serviceWorker?.controller) {
        console.warn('[map3d] heartbeat: DEM source missing but SW available — re-bootstrapping');
        st.heartbeatFailures = 0;
        void fns.bootstrapCurrentStyle();
        return;
      }

      // Soit la source a disparu, soit le rattachement n'a pas pris. On escalade
      // vers un rechargement complet (sans délai de récupération) une fois sûr que
      // ce n'est pas un accident ponctuel — mais seulement si le SW est
      // disponible, car reloadMapElevation exige le contrôleur.
      if (
        st.heartbeatFailures >= TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD
        && navigator.serviceWorker?.controller
      ) {
        st.heartbeatFailures = 0;
        st.demReloadCoolingUntil = 0;
        fns.reloadMapElevation();
      }
    }, TERRAIN_HEARTBEAT_INTERVAL_MS);
  };

  fns.stopTerrainHeartbeat = () => {
    clearVisibleTimer(st.heartbeatTimer);
    st.heartbeatTimer = null;
    st.heartbeatFailures = 0;
  };
}

