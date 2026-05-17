import { awaitController, swReady } from '../serviceWorker';
import {
  type Ctx,
} from './context';
import { bootstrapAwsFallback } from './styleBootstrapFallback';
import {
  ensureStyleUsableForBootstrap,
  waitForStyleReadiness,
} from './styleBootstrapReadiness';
import { bootstrapUnifiedDem } from './styleBootstrapUnified';

const supportsStandardLightPreset = (visualFamily: Ctx['getActiveVisualFamily'] extends never ? never : ReturnType<Ctx['getActiveVisualFamily']>): boolean => (
  visualFamily === 'mapbox-standard-v3'
);

/**
 * Style bootstrap orchestration. This is what runs on initial mount and
 * after every basemap switch.
 *
 * Anti-flat reinforcements:
 *  - The watchdog soft-fails: it never rejects (which used to leave the
 *    map permanently flat when sprite/image requests stalled).
 *  - `recoverStyleArtifacts` always rebuilds the DEM source from
 *    scratch on `style.load` (the previous source's tile pyramid is
 *    typically dropped by setStyle({diff:false}) anyway, but rebuilding
 *    explicitly avoids the half-empty pyramid case).
 *  - Late-SW recovery: when the SW takes longer than 2.5 s to claim,
 *    the plain-Mapbox fallback path now schedules a background listener
 *    on `swLateReady`. If the controller appears within ~20 s, the
 *    full DEM/terrain bootstrap is re-triggered automatically instead
 *    of leaving the map permanently flat.
 */
export function attachStyleBootstrap(ctx: Ctx): void {
  const {
    map,
    isCancelled,
    getActiveVisualFamily,
    getActiveTerrainContract,
    getActiveLightPreset,
    fogConfig,
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
      /* style may not support config properties */
    }
  };

  fns.prepareStyleChange = (detail = 'Fond de carte') => {
    // Stop the heartbeat FIRST — it must not detect the intentionally
    // flat state caused by setStyle({diff:false}) and launch a parasitic
    // bootstrapCurrentStyle() call that races the legitimate style switch.
    fns.stopTerrainHeartbeat();
    st.hasReportedReadyOnce = false;
    st.demPassiveRefreshPending = false;
    st.demTrackingEnabled = false;
    st.spriteStormBypass = false;
    fns.clearDemTracking();
    fns.clearStyleBootstrapArtifacts();
    fns.detachAwsFallbackTerrain();
    fns.detachManagedTerrain();
    fns.reportStatus('loading', 18, detail);
  };

  fns.bootstrapCurrentStyle = async (): Promise<boolean> => {
    const runId = ++st.styleBootstrapRunId;
    console.info('[map3d] bootstrapCurrentStyle:start', {
      runId,
      visualFamily: getActiveVisualFamily(),
      terrainContract: getActiveTerrainContract(),
      hasSwController: !!navigator.serviceWorker?.controller,
      spriteStormBypass: st.spriteStormBypass,
    });
    const applyStyleDecorators = () => {
      try {
        map.setFog(fogConfig);
      } catch {
        /* style may still be finishing its internal graph rebuild */
      }
      applyConfiguredLightPreset();
    };
    if (!await waitForStyleReadiness(ctx, runId)) return false;
    if (!await ensureStyleUsableForBootstrap(ctx, runId)) return false;

    fns.refreshTrackedSourceIds();
    // SW readiness gate. We need an actual `controller` for the DEM
    // source to flow through the SW pipeline (`refreshDemSource` bails
    // immediately otherwise). Three sources of truth, evaluated in
    // order of authority:
    //   1. `navigator.serviceWorker.controller` right now — fastest
    //      path, no await on a returning visit where the SW already
    //      controls the page.
    //   2. The cached `swReady` promise — resolved when the controller
    //      claimed within 2.5 s of module load.
    //   3. Event-driven `awaitController(5000)` — bridges the
    //      install/activate window on cold visits where the controller
    //      is moments away from claiming. Without this, the cached
    //      `swReady === false` would force the AWS Terrarium fallback
    //      branch even though the SW becomes available 100 ms later.
    const swRegistered = await swReady;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;
    // Strictly check the controller — refreshDemSource bails without
    // one regardless of swReady's resolved value. swRegistered is kept
    // only for the warn-message label below.
    let swOk = !!navigator.serviceWorker?.controller;
    if (!swOk) {
      // Wait briefly for the controller to claim before falling back.
      // 5 s is a generous-but-bounded budget that comfortably covers
      // a cold install on slow networks while not stretching the
      // user-perceived map-ready time when no SW is actually coming.
      swOk = await awaitController(5000);
      if (isCancelled() || runId !== st.styleBootstrapRunId) return false;
    }

    fns.reportStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

    if (st.spriteStormBypass) {
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

  // Permanent lightPreset guard.
  //
  // Symptom: occasionally the user sees the Mapbox Standard scene flip from
  // its configured preset to plain day (bright blue) or night (dark) "for no
  // reason". Root cause: the basemap-config preset is only applied via
  // `applyStyleDecorators()` inside `bootstrapCurrentStyle()` (on
  // `style.load` recovery). However Mapbox v3 imported style fragments
  // (Standard / Standard-Satellite) can republish their config to defaults
  // when the import finishes settling AFTER our recovery setTimeout has
  // already fired, or when an unrelated `setConfigProperty('basemap', ...)`
  // call (labels toggle, etc.) triggers an internal style refresh that
  // resets sibling config keys we never touched. The result: lightPreset
  // silently reverts to its built-in default, and `useSunlight`'s
  // `setLights()` overlay no longer compensates because it does not touch
  // the preset.
  //
  // Fix: a single permanent `styledata` listener that re-applies the
  // configured preset whenever the imported config has drifted away from
  // it. The check uses `getConfigProperty` so we do not loop (the setter
  // is only called when the value actually differs).
  let lastLightPresetReapplyAt = 0;
  const enforceConfiguredLightPreset = () => {
    if (!supportsStandardLightPreset(getActiveVisualFamily())) return;
    const lightPreset = getActiveLightPreset();
    if (!lightPreset) return;
    if (!fns.canMutateStyle()) return;
    // Cheap throttle — styledata can fire rapidly during sprite/import
    // settling. We only need a single reapply per refresh burst.
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
      /* style transitioning — next styledata will retry */
    }
  };
  map.on('styledata', enforceConfiguredLightPreset);
}
