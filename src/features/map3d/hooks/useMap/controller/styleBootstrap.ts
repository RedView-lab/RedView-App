import { unifiedDEMSource } from '../../../lib/sources';
import { waitForMapIdleOrTimeout } from '../runtimeProfile';
import { swReady, swLateReady } from '../serviceWorker';
import {
  STYLE_LOAD_WATCHDOG_MS,
  type Ctx,
} from './context';

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
  const { map, isCancelled, getActiveVisualFamily, getActiveTerrainContract, fogConfig, runtimeProfile } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

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
    const applyStyleDecorators = () => {
      try {
        map.setFog(fogConfig);
      } catch {
        /* style may still be finishing its internal graph rebuild */
      }
      if (supportsStandardLightPreset(getActiveVisualFamily())) {
        try {
          map.setConfigProperty('basemap', 'lightPreset', 'dusk');
        } catch {
          /* style may not support config properties */
        }
      }
    };
    const promoteStyleContentBypass = (logLabel: string): boolean => {
      try {
        const style = map.getStyle();
        const hasContent = style && (
          (style.layers?.length ?? 0) > 0
          || Object.keys(style.sources ?? {}).length > 0
        );
        if (!hasContent) return false;
        if (!st.spriteStormBypass) {
          console.warn(
            `[map3d] ${logLabel}: style has content while isStyleLoaded() is false — enabling sprite-storm bypass`,
            { layers: style.layers?.length ?? 0, sources: Object.keys(style.sources ?? {}).length },
          );
          st.spriteStormBypass = true;
        }
        return true;
      } catch {
        return false;
      }
    };
    const styleLoaded = new Promise<void>((resolve) => {
      if (fns.canMutateStyle()) {
        fns.reportStatus('loading', 34, 'Style');
        resolve();
        return;
      }
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let watchdogFired = false;
      const cleanup = () => {
        map.off('style.load', onStyleLoad);
        map.off('styledata', onStyleData);
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };
      const finish = (deferred = false) => {
        if (settled) return;
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (!deferred && !fns.canMutateStyle() && !promoteStyleContentBypass('style readiness')) return;
        settled = true;
        cleanup();
        fns.reportStatus(
          'loading',
          deferred ? 30 : 34,
          deferred
            ? 'Fond de carte (lent)'
            : watchdogFired ? 'Style (récupération)' : 'Style',
        );
        resolve();
      };
      const scheduleFinish = () => {
        setTimeout(() => {
          finish();
        }, 0);
      };
      const onStyleLoad = () => scheduleFinish();
      const onStyleData = () => scheduleFinish();
      map.on('style.load', onStyleLoad);
      map.on('styledata', onStyleData);
      watchdog = setTimeout(() => {
        watchdog = null;
        if (fns.canMutateStyle()) {
          finish();
          return;
        }
        // Soft-fail: resolve the bootstrap so the page-side "Chargement
        // du globe…" loader can hide. We schedule a late re-bootstrap
        // (below, after `await styleLoaded`) that fires when Mapbox
        // eventually finishes the style. Hard-rejecting here used to
        // leave the map permanently flat (no terrain attached) when
        // sprite/image requests stall — typical when Mapbox 3.x rejects
        // an SVG asset referenced by the basemap and keeps retrying it.
        watchdogFired = true;
        console.warn(
          '[map3d] style.load not seen within',
          STYLE_LOAD_WATCHDOG_MS,
          'ms; deferring DEM/terrain attach until late style.load',
        );
        finish(true);
      }, STYLE_LOAD_WATCHDOG_MS);
    });

    await styleLoaded;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;

    if (!fns.canMutateStyle()) {
      // Mapbox 3.x can enter a state where isStyleLoaded() stays false
      // indefinitely (SVG sprite rejection storm) even though tiles, layers
      // and sources are fully operational. In that scenario neither
      // style.load nor styledata fire again, so event-only recovery is a
      // dead-end.
      //
      // Aggressive inline check: if getStyle() already has content, the
      // rendering pipeline is alive — only sprites are blocking
      // isStyleLoaded(). Enable spriteStormBypass and continue the
      // bootstrap *inline* instead of returning false and waiting 2+ s
      // for the polling loop. This eliminates the visible flat-terrain
      // gap that occurred between the 15 s watchdog and the first poll.
      //
      // IMPORTANT: Standard-Satellite uses Mapbox v3 imported style
      // fragments — its sources live inside the fragment, NOT in the
      // root style.sources. We check style.layers instead, which ARE
      // populated from imported fragments.
      promoteStyleContentBypass('style bootstrap');

      // If the bypass didn't activate (style truly has no sources yet),
      // fall back to the event + polling loop.
      if (!fns.canMutateStyle()) {
        let lateRecovered = false;
        const doLateRecovery = () => {
          if (lateRecovered) return;
          lateRecovered = true;
          map.off('style.load', onLateEvent);
          map.off('styledata', onLateEvent);
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (isCancelled()) return;
          void fns.bootstrapCurrentStyle();
        };
        const onLateEvent = () => doLateRecovery();
        map.on('style.load', onLateEvent);
        map.on('styledata', onLateEvent);

        // Polling fallback: check every 1 s (was 2 s — tightened to
        // reduce the flat-terrain window on genuinely slow styles).
        let pollCount = 0;
        const MAX_POLLS = 30; // 30 × 1 s = 30 s max
        let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
          pollCount += 1;
          if (isCancelled() || runId !== st.styleBootstrapRunId) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            return;
          }
          if (fns.canMutateStyle()) {
            doLateRecovery();
            return;
          }
          if (promoteStyleContentBypass('late style recovery')) {
            doLateRecovery();
            return;
          }
          if (pollCount >= MAX_POLLS) {
            console.warn('[map3d] late style recovery polling exhausted after 30 s');
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          }
        }, 1000);

        return false;
      }
    }

    fns.refreshTrackedSourceIds();
    // swReady resolves once (cached). On a late-recovery re-run the
    // promise may still be `false` even though the controller has since
    // appeared. Check the live controller reference as a secondary gate
    // so the DEM path runs whenever the SW is actually available.
    const swOk = (await swReady) || !!navigator.serviceWorker?.controller;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;

    fns.reportStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

    // In sprite-storm bypass mode, defer fog/decorators until the base map
    // has had time to load its first batch of tiles. Applying fog
    // immediately produces large pink patches (fog color rgb(255,196,150))
    // wherever satellite tiles haven't loaded yet — jarring for the user.
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
      console.warn('[map3d] SW unavailable — attaching AWS Terrarium fallback DEM (~30 m global)');
      st.demTrackingEnabled = true;
      fns.reportStatus('loading', 60, 'Relief AWS (fallback)');

      // ── AWS Terrarium direct fallback ──────────────────────────────
      // Attach the AWS Open Data Terrarium tiles directly as a
      // raster-dem source with native `terrarium` encoding. Mapbox GL
      // v3 decodes terrarium on the GPU — no SW pipeline needed.
      // This gives the user 3D terrain everywhere at ~30 m resolution,
      // much better than a completely flat map.
      fns.attachAwsFallbackTerrain();

      fns.reportStatus('loading', 80, 'Tuiles satellites');
      st.finishOnIdle = () => {
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        if (!fns.allTilesLoaded() || map.isMoving()) return;
        map.off('idle', st.finishOnIdle!);
        st.finishOnIdle = null;
        fns.finishDemActivity('Carte prête (relief 30 m)');
      };
      map.on('idle', st.finishOnIdle);
      st.readyFallbackTimer = setTimeout(() => {
        st.readyFallbackTimer = null;
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        if (st.lastReportedState === 'ready') return;
        fns.finishDemActivity('Carte prête (relief 30 m)');
      }, 8000);

      // ── Late-SW recovery ──────────────────────────────────────────
      // The SW didn't claim within 2.5 s, but it may still be installing.
      // Wait for it in the background: if it appears within ~20 s,
      // remove the AWS fallback and re-trigger the full DEM/terrain
      // bootstrap with IGN LiDAR HD.
      void swLateReady.then((lateOk) => {
        if (!lateOk) return;
        if (isCancelled()) return;
        if (runId !== st.styleBootstrapRunId) return;
        // Only upgrade if the unified-dem source hasn't been attached
        // yet by another path.
        if (map.getSource(unifiedDEMSource.id)) return;
        if (!fns.canMutateStyle()) return;

        console.log('[map3d] Late SW recovery: upgrading from AWS fallback to full DEM pipeline');
        fns.reportStatus('loading', 50, 'Récupération relief HD');
        // Remove the AWS fallback source/terrain before re-bootstrapping
        fns.detachAwsFallbackTerrain();
        if (st.finishOnIdle) {
          map.off('idle', st.finishOnIdle);
          st.finishOnIdle = null;
        }
        void fns.bootstrapCurrentStyle();
      });

      return false;
    }

    fns.ensureTrackingListeners();

    fns.detachManagedTerrain();

    const terrainContract = getActiveTerrainContract();
    if (map.getSource(unifiedDEMSource.id)) {
      // Treat every basemap switch the same way, regardless of whether the
      // previous style was a legacy v11/v12 stylesheet or a Standard v3
      // imported style. A surviving raster-dem source is not trustworthy
      // here: its tile pyramid may belong to the previous style lifecycle,
      // and Standard-Satellite is exactly the style family that can delay or
      // suppress the later style.load recovery path. Rebuild immediately so
      // terrain always reattaches onto a fresh source contract.
      if (!fns.refreshDemSource({ forceRebuild: terrainContract === 'unified-dem-v1' })) return false;
    } else {
      if (!fns.refreshDemSource()) return false;
    }
    fns.reportStatus('loading', 68, 'Relief');

    // Start heartbeat proactively so self-heal works even if the
    // finishDemActivity path is slow or stalls. The heartbeat's own
    // guards (hasReportedReadyOnce, reloadInProgress) limit it to
    // acting only when the system has settled.
    fns.startTerrainHeartbeat();

    let orthoAdded = false;
    const finishStyleBootstrapWhenReady = async () => {
      if (isCancelled() || runId !== st.styleBootstrapRunId || orthoAdded) return;
      orthoAdded = true;
      await waitForMapIdleOrTimeout(map, 500);
      if (isCancelled() || runId !== st.styleBootstrapRunId) return;
      fns.reportStatus(
        'loading',
        92,
        fns.shouldUseIgnOrthoOverlay() ? 'Textures IGN' : 'Fond de carte',
      );
      if (fns.shouldUseIgnOrthoOverlay()) {
        fns.addIgnOrthoOverlay();
      }
      fns.refreshTrackedSourceIds();
      st.demTrackingEnabled = true;
      fns.scheduleDemSettle();
    };

    const recoverStyleArtifacts = () => {
      setTimeout(() => {
        if (isCancelled() || runId !== st.styleBootstrapRunId || !fns.canMutateStyle()) return;

        applyStyleDecorators();
        orthoAdded = false;

        try {
          map.setTerrain(null);
        } catch {
          /* terrain may already have been dropped by the style reload */
        }

        // Anti-flat: setStyle({diff:false}) drops sources, but if the
        // style was reloaded with diff=true (rare path) the source can
        // survive with a stale/empty pyramid. Always force a clean
        // rebuild here so we never end up bound to an empty source.
        const needsRebuild = !map.getSource(unifiedDEMSource.id);
        if (needsRebuild) {
          if (!fns.refreshDemSource()) return;
        } else {
          if (!fns.refreshDemSource({ forceRebuild: true })) return;
        }

        fns.reportStatus('loading', 68, 'Relief');
        fns.armTerrainBootstrap(() => {
          void finishStyleBootstrapWhenReady();
        });
      }, 0);
    };

    map.on('style.load', recoverStyleArtifacts);
    st.disposeStyleRecovery = () => {
      map.off('style.load', recoverStyleArtifacts);
    };

    st.orthoBootTimer = setTimeout(() => {
      void finishStyleBootstrapWhenReady();
    }, runtimeProfile.orthoBootFallbackMs);

    fns.armTerrainBootstrap(() => {
      void finishStyleBootstrapWhenReady();
    });

    return true;
  };
}
