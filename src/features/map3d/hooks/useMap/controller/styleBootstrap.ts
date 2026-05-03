import { unifiedDEMSource } from '../../../lib/sources';
import { waitForMapIdleOrTimeout } from '../runtimeProfile';
import { swReady, swLateReady } from '../serviceWorker';
import {
  MAPBOX_STANDARD_STYLE_URL,
  MAPBOX_STANDARD_SATELLITE_STYLE_URL,
  STYLE_LOAD_WATCHDOG_MS,
  type Ctx,
} from './context';

const supportsStandardLightPreset = (styleUrl: string): boolean => (
  styleUrl === MAPBOX_STANDARD_STYLE_URL || styleUrl === MAPBOX_STANDARD_SATELLITE_STYLE_URL
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
  const { map, isCancelled, getActiveStyleUrl, fogConfig, runtimeProfile } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.prepareStyleChange = (detail = 'Fond de carte') => {
    st.demPassiveRefreshPending = false;
    st.demTrackingEnabled = false;
    st.spriteStormBypass = false;
    fns.clearDemTracking();
    fns.clearStyleBootstrapArtifacts();
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
      if (supportsStandardLightPreset(getActiveStyleUrl())) {
        try {
          map.setConfigProperty('basemap', 'lightPreset', 'dusk');
        } catch {
          /* style may not support config properties */
        }
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
        if (!deferred && !fns.canMutateStyle()) return;
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
      // Two reinforcements:
      //  1. A polling interval (every 2 s, up to 30 s) that checks whether
      //     canMutateStyle() finally flipped, OR whether getStyle() has
      //     sources — if so, the style is "good enough" for terrain.
      //  2. The event listeners are still registered as a fast path.
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

      // Polling fallback: check whether the style became usable even
      // though the events never fire. Also detect the "sprite-storm"
      // case: getStyle() has sources but isStyleLoaded() is stuck false.
      let pollCount = 0;
      const MAX_POLLS = 15; // 15 × 2 s = 30 s max
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
        // Force-mutable fallback: if the style object has sources, the
        // rendering pipeline is alive — only sprites are blocking
        // isStyleLoaded(). We can safely attach terrain anyway.
        try {
          const style = map.getStyle();
          if (style && Object.keys(style.sources ?? {}).length > 0) {
            console.warn(
              '[map3d] style has sources but isStyleLoaded() is false — forcing terrain bootstrap (sprite storm workaround)',
            );
            st.spriteStormBypass = true;
            doLateRecovery();
            return;
          }
        } catch { /* style not ready yet */ }
        if (pollCount >= MAX_POLLS) {
          console.warn('[map3d] late style recovery polling exhausted after 30 s');
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      }, 2000);

      return false;
    }

    fns.refreshTrackedSourceIds();
    // swReady resolves once (cached). On a late-recovery re-run the
    // promise may still be `false` even though the controller has since
    // appeared. Check the live controller reference as a secondary gate
    // so the DEM path runs whenever the SW is actually available.
    const swOk = (await swReady) || !!navigator.serviceWorker?.controller;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;

    fns.reportStatus('loading', swOk ? 52 : 46, swOk ? 'Sources IGN' : 'Fond de carte');

    applyStyleDecorators();

    if (!swOk) {
      console.warn('[map3d] Running in plain-Mapbox mode (no IGN DEM/ortho overlay)');
      st.demTrackingEnabled = true;
      fns.reportStatus('loading', 80, 'Tuiles satellites');
      st.finishOnIdle = () => {
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        if (!fns.allTilesLoaded() || map.isMoving()) return;
        map.off('idle', st.finishOnIdle!);
        st.finishOnIdle = null;
        fns.finishDemActivity('Carte prête');
      };
      map.on('idle', st.finishOnIdle);
      st.readyFallbackTimer = setTimeout(() => {
        st.readyFallbackTimer = null;
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        if (st.lastReportedState === 'ready') return;
        fns.finishDemActivity('Carte prête');
      }, 8000);

      // ── Late-SW recovery ──────────────────────────────────────────
      // The SW didn't claim within 2.5 s, but it may still be installing.
      // Wait for it in the background: if it appears within ~20 s,
      // re-trigger the full DEM/terrain bootstrap so the map doesn't
      // stay flat forever. This is the key fix for the "tout devient
      // plat quand je zoom" regression.
      void swLateReady.then((lateOk) => {
        if (!lateOk) return;
        if (isCancelled()) return;
        // Only recover if we're still in the same bootstrap run (no
        // basemap switch happened in the meantime) and the DEM source
        // hasn't been attached yet by another path.
        if (runId !== st.styleBootstrapRunId) return;
        if (map.getSource(unifiedDEMSource.id)) return;
        if (!fns.canMutateStyle()) return;

        console.log('[map3d] Late SW recovery: re-triggering full DEM bootstrap');
        fns.reportStatus('loading', 50, 'Récupération relief');
        // Clear the plain-Mapbox idle listener to avoid interference
        if (st.finishOnIdle) {
          map.off('idle', st.finishOnIdle);
          st.finishOnIdle = null;
        }
        // Re-run the full bootstrap — this time swReady is already
        // resolved true (or the controller is now available), so the
        // DEM/terrain path will execute.
        void fns.bootstrapCurrentStyle();
      });

      return false;
    }

    fns.ensureTrackingListeners();

    fns.detachManagedTerrain();

    if (!map.getSource(unifiedDEMSource.id)) {
      fns.refreshDemSource();
    }
    fns.reportStatus('loading', 68, 'Relief');

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
