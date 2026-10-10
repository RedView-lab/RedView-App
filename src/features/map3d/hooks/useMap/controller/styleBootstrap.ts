import { applyMapEnvironment } from '../../../lib/mapEnvironment';
import { awaitController, swReady } from '../serviceWorker';
import {
  type Ctx,
} from './context';
import { bootstrapAwsFallback } from './styleBootstrapFallback';
import { waitForStyleReadiness } from './styleBootstrapReadiness';
import { bootstrapUnifiedDem } from './styleBootstrapUnified';
import { logger } from '@/shared/lib/logger';

const supportsStandardLightPreset = (visualFamily: Ctx['getActiveVisualFamily'] extends never ? never : ReturnType<Ctx['getActiveVisualFamily']>): boolean => (
  visualFamily === 'mapbox-standard-v3'
);

/**
 * Orchestration du bootstrap du style. C'est ce qui tourne au montage initial
 * et après chaque changement de fond de carte.
 *
 * Renforts anti-plat :
 *  - Le bootstrap attend que Mapbox ait analysé le style, aussi longtemps que
 *    nécessaire (une page masquée n'analyse rien), et n'est jamais remplacé que
 *    par une exécution plus récente — jamais abandonné. Ses chiens de garde ne
 *    comptent que le temps visible (`visibleClock.ts`).
 *  - `recoverStyleArtifacts` reconstruit toujours la source DEM de zéro sur
 *    `style.load` (la pyramide de tuiles de la source précédente est de toute
 *    façon en général abandonnée par setStyle({diff:false}), mais la
 *    reconstruire explicitement évite le cas d'une pyramide à moitié vide).
 *  - Récupération d'un SW tardif : quand le SW met plus de 2,5 s à prendre le
 *    contrôle, le chemin de repli Mapbox simple programme désormais un écouteur
 *    en arrière-plan sur `swLateReady`. Si le contrôleur apparaît dans les ~20 s,
 *    le bootstrap complet DEM / terrain est relancé automatiquement au lieu de
 *    laisser la carte plate pour de bon.
 */
export function attachStyleBootstrap(ctx: Ctx): void {
  const {
    map,
    isCancelled,
    getActiveVisualFamily,
    getActiveTerrainContract,
    getActiveLightPreset,
  } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  const applyConfiguredLightPreset = () => {
    if (!supportsStandardLightPreset(getActiveVisualFamily())) return;
    const lightPreset = getActiveLightPreset();
    if (!lightPreset) return;
    try {
      map.setConfigProperty('basemap', 'lightPreset', lightPreset);
    } catch {
      /* le style ne gère peut-être pas les propriétés de config */
    }
  };

  fns.prepareStyleChange = (detail = 'Fond de carte') => {
    // On arrête le battement de cœur D'ABORD — il ne doit pas détecter l'état
    // plat volontaire causé par setStyle({diff:false}) et lancer un appel
    // parasite de bootstrapCurrentStyle() en course avec le changement de style
    // légitime.
    fns.stopTerrainHeartbeat();
    st.hasReportedReadyOnce = false;
    st.demPassiveRefreshPending = false;
    st.demTrackingEnabled = false;
    fns.clearDemTracking();
    fns.clearStyleBootstrapArtifacts();
    fns.detachAwsFallbackTerrain();
    fns.detachManagedTerrain();
    fns.reportStatus('loading', 18, detail);
  };

  fns.bootstrapCurrentStyle = async (): Promise<boolean> => {
    const runId = ++st.styleBootstrapRunId;
    logger.map3d.info('bootstrapCurrentStyle:start', {
      runId,
      visualFamily: getActiveVisualFamily(),
      terrainContract: getActiveTerrainContract(),
      hasSwController: !!navigator.serviceWorker?.controller,
    });
    const applyStyleDecorators = () => {
      // Brouillard + lumières de l'environnement actif (jour / crépuscule / nuit) :
      // setStyle réinitialise les deux, ils sont donc réappliqués à chaque bootstrap.
      applyMapEnvironment(map);
      applyConfiguredLightPreset();
    };
    if (!await waitForStyleReadiness(ctx, runId)) return false;

    fns.refreshTrackedSourceIds();
    // Porte de disponibilité du SW. Il faut un vrai `controller` pour que la
    // source DEM passe par le pipeline du SW (`refreshDemSource` abandonne tout
    // de suite sinon). Trois sources de vérité, évaluées par ordre d'autorité :
    //   1. `navigator.serviceWorker.controller` maintenant — le chemin le plus
    //      rapide, sans attente lors d'une visite de retour où le SW contrôle
    //      déjà la page.
    //   2. La promesse `swReady` en cache — résolue quand le contrôleur a pris
    //      la main dans les 2,5 s suivant le chargement du module.
    //   3. `awaitController(5000)` piloté par les événements — couvre la fenêtre
    //      install / activate des visites à froid où le contrôleur est sur le
    //      point de prendre la main. Sans lui, la valeur en cache
    //      `swReady === false` forcerait la branche de repli AWS Terrarium alors
    //      que le SW devient disponible 100 ms plus tard.
    const swRegistered = await swReady;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;
    // Contrôle strict du contrôleur — refreshDemSource abandonne sans lui quelle
    // que soit la valeur résolue de swReady. swRegistered ne sert qu'au libellé
    // du message d'avertissement plus bas.
    let swOk = !!navigator.serviceWorker?.controller;
    if (!swOk) {
      // On attend brièvement que le contrôleur prenne la main avant de se
      // replier. 5 s est un budget généreux mais borné, qui couvre largement une
      // installation à froid sur un réseau lent sans allonger le temps perçu
      // avant une carte prête quand aucun SW n'arrive vraiment.
      swOk = await awaitController(5000);
      if (isCancelled() || runId !== st.styleBootstrapRunId) return false;
    }

    fns.reportStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

    // Sprite, TileJSON ou imports encore en chargement : brouillard et lumières
    // sont posés à la première inactivité, pour qu'un import qui se stabilise
    // ensuite ne les réinitialise pas.
    if (!map.isStyleLoaded()) {
      const applyDecoratorsDeferred = () => {
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        applyStyleDecorators();
      };
      let decoratorsApplied = false;
      const onFirstIdle = () => {
        if (decoratorsApplied) return;
        decoratorsApplied = true;
        clearTimeout(decoratorTimer);
        applyDecoratorsDeferred();
      };
      map.once('idle', onFirstIdle);
      const decoratorTimer = setTimeout(() => {
        if (decoratorsApplied) return;
        decoratorsApplied = true;
        map.off('idle', onFirstIdle);
        applyDecoratorsDeferred();
      }, 2000);
    } else {
      applyStyleDecorators();
    }

    if (!swOk) {
      return bootstrapAwsFallback({ ctx, runId, swRegistered });
    }

    return bootstrapUnifiedDem({ ctx, runId, applyStyleDecorators });
  };

  // Garde-fou permanent du lightPreset.
  //
  // Symptôme : parfois, la scène Mapbox Standard passe de son préréglage
  // configuré au jour simple (bleu vif) ou à la nuit (sombre) « sans raison ».
  // Cause : le préréglage de la config du fond n'est appliqué que par
  // `applyStyleDecorators()` dans `bootstrapCurrentStyle()` (à la récupération
  // de `style.load`). Or les fragments de style importés de Mapbox v3
  // (Standard / Standard-Satellite) peuvent republier leur config par défaut
  // quand l'import finit de se stabiliser APRÈS le déclenchement de notre
  // setTimeout de récupération, ou quand un appel sans rapport à
  // `setConfigProperty('basemap', ...)` (bascule des libellés, etc.) déclenche un
  // rafraîchissement interne du style qui réinitialise des clés de config
  // voisines qu'on n'a jamais touchées. Résultat : lightPreset revient en silence
  // à sa valeur intégrée par défaut, et l'overlay `setLights()` de `useSunlight`
  // ne compense plus, car il ne touche pas au préréglage.
  //
  // Correction : un unique écouteur `styledata` permanent qui réapplique le
  // préréglage configuré dès que la config importée s'en est écartée. Le
  // contrôle utilise `getConfigProperty` pour ne pas boucler (le setter n'est
  // appelé que si la valeur diffère vraiment).
  let lastLightPresetReapplyAt = 0;
  const enforceConfiguredLightPreset = () => {
    if (!supportsStandardLightPreset(getActiveVisualFamily())) return;
    const lightPreset = getActiveLightPreset();
    if (!lightPreset) return;
    if (!fns.canMutateStyle()) return;
    // Limitation peu coûteuse — styledata peut se déclencher en rafale pendant la
    // stabilisation des sprites / imports. Une seule réapplication par rafale suffit.
    const now = performance.now();
    if (now - lastLightPresetReapplyAt < 100) return;
    try {
      const current = (map as unknown as {
        getConfigProperty?: (importId: string, configKey: string) => unknown;
      }).getConfigProperty?.('basemap', 'lightPreset');
      if (current === lightPreset) return;
      lastLightPresetReapplyAt = now;
      map.setConfigProperty('basemap', 'lightPreset', lightPreset);
    } catch {
      /* style en transition — le styledata suivant réessaiera */
    }
  };
  map.on('styledata', enforceConfiguredLightPreset);
}
