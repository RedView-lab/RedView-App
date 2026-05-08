import { unifiedDEMSource } from '../../../lib/sources';
import { waitForMapIdleOrTimeout } from '../runtimeProfile';
import { swReady, swLateReady, awaitController } from '../serviceWorker';
import {
  STYLE_READINESS_TELEMETRY_INTERVAL_MS,
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
        if (!style) return false;
        const layerCount = style.layers?.length ?? 0;
        const sourceCount = Object.keys(style.sources ?? {}).length;
        // Mapbox v3 imported style fragments (Standard / Standard-Satellite)
        // expose their layers/sources via `imports`; even when the root
        // style.layers and style.sources arrays are empty, an import entry
        // with `data` populated means the rendering pipeline has the style
        // graph it needs to draw.
        const imports = (style as unknown as { imports?: Array<{ data?: unknown }> }).imports;
        const hasImportContent = Array.isArray(imports)
          && imports.some((imp) => imp && imp.data != null);
        const hasContent = layerCount > 0 || sourceCount > 0 || hasImportContent;
        if (!hasContent) return false;
        if (!st.spriteStormBypass) {
          console.warn(
            `[map3d] ${logLabel}: style has content while isStyleLoaded() is false — enabling sprite-storm bypass`,
            { layers: layerCount, sources: sourceCount, imports: Array.isArray(imports) ? imports.length : 0 },
          );
          st.spriteStormBypass = true;
        }
        return true;
      } catch {
        return false;
      }
    };
    // Event-driven style readiness gate.
    //
    // Pro-grade replacement of the previous "5 s watchdog → soft-fail →
    // outer 3× retry → inner 1 s polling" stack, which raced itself and
    // left the map flat whenever Mapbox 3.x's `isStyleLoaded()` got
    // stuck false (typical sprite/import-fragment storm on
    // Standard-Satellite). The gate now:
    //
    //   1. Resolves on the FIRST genuine signal that the rendering
    //      pipeline is alive:
    //        • `style.load`         — Mapbox's intended "fully ready"
    //        • `styledata`          — content arrived; recheck readiness
    //        • `sourcedata`         — a source produced data; pipeline
    //                                 is definitely live
    //        • `idle`               — painter rendered a frame; this is
    //                                 the strongest possible proof, and
    //                                 promotes the sprite-storm bypass
    //                                 even if `isStyleLoaded()` is stuck
    //   2. Never soft-fails on a timer. A genuinely stuck style is
    //      surfaced via periodic telemetry warns (every 15 s) so it is
    //      still observable; the bootstrap simply waits.
    //   3. Cleans up listeners on cancellation / runId rotation so
    //      basemap switches in flight cannot leak handlers.
    const styleLoaded = new Promise<void>((resolve) => {
      if (fns.canMutateStyle()) {
        fns.reportStatus('loading', 34, 'Style');
        resolve();
        return;
      }
      let settled = false;
      let telemetryTimer: ReturnType<typeof setInterval> | null = null;
      let telemetryTicks = 0;
      const cleanup = () => {
        map.off('style.load', onStyleLoad);
        map.off('styledata', onStyleData);
        map.off('sourcedata', onSourceData);
        map.off('idle', onIdle);
        if (telemetryTimer) {
          clearInterval(telemetryTimer);
          telemetryTimer = null;
        }
      };
      const settle = (label: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        fns.reportStatus('loading', 34, label);
        resolve();
      };
      const tryReady = (origin: string) => {
        if (settled) return;
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (fns.canMutateStyle()) {
          settle('Style');
          return;
        }
        if (promoteStyleContentBypass(origin)) {
          settle('Style (récupération)');
        }
      };
      const onStyleLoad = () => tryReady('style.load');
      const onStyleData = () => tryReady('styledata');
      const onSourceData = () => tryReady('sourcedata');
      const onIdle = () => {
        // First idle = Mapbox finished a render pass. That can only
        // happen if the style graph is operational — promote the bypass
        // unconditionally even if `getStyle()` still looks empty in this
        // microtask.
        if (settled) return;
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (fns.canMutateStyle()) {
          settle('Style');
          return;
        }
        // promoteStyleContentBypass may legitimately return false on the
        // very first idle (style.imports is sometimes populated only
        // after the first paint commits). In that case, force the
        // bypass: idle is a strictly stronger signal than getStyle()
        // content inspection.
        if (!promoteStyleContentBypass('idle')) {
          if (!st.spriteStormBypass) {
            console.warn('[map3d] first idle reached without style content — forcing sprite-storm bypass');
            st.spriteStormBypass = true;
          }
        }
        settle('Style (idle)');
      };
      map.on('style.load', onStyleLoad);
      map.on('styledata', onStyleData);
      map.on('sourcedata', onSourceData);
      map.on('idle', onIdle);
      // Telemetry-only watchdog. Logs diagnostics every 15 s so a
      // genuinely stuck style is observable, but never soft-fails the
      // bootstrap. After 60 s we log an error tag for production
      // monitoring; the listeners stay attached.
      telemetryTimer = setInterval(() => {
        if (settled) {
          if (telemetryTimer) { clearInterval(telemetryTimer); telemetryTimer = null; }
          return;
        }
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        telemetryTicks += 1;
        let layers = 0;
        let sources = 0;
        let importsLen = 0;
        try {
          const s = map.getStyle();
          layers = s?.layers?.length ?? 0;
          sources = Object.keys(s?.sources ?? {}).length;
          const imp = (s as unknown as { imports?: unknown[] })?.imports;
          if (Array.isArray(imp)) importsLen = imp.length;
        } catch { /* ignore */ }
        const elapsedSec = telemetryTicks * (STYLE_READINESS_TELEMETRY_INTERVAL_MS / 1000);
        const tag = elapsedSec >= 60 ? 'error' : 'warn';
        const msg = `[map3d] style readiness still pending after ${elapsedSec}s — waiting on Mapbox events`;
        const diag = { isStyleLoaded: (() => { try { return map.isStyleLoaded(); } catch { return false; } })(), layers, sources, imports: importsLen };
        if (tag === 'error') console.error(msg, diag);
        else console.warn(msg, diag);
        // Re-probe in case a styledata/sourcedata event was suppressed
        // (extremely rare, but cheap to guard against).
        tryReady('telemetry-probe');
      }, STYLE_READINESS_TELEMETRY_INTERVAL_MS);
    });

    await styleLoaded;
    if (isCancelled() || runId !== st.styleBootstrapRunId) return false;

    if (!fns.canMutateStyle()) {
      // Defensive: the event-driven gate above only resolves when
      // `canMutateStyle()` is true or the sprite-storm bypass is
      // engaged. Reaching here means a cancellation or runId rotation
      // raced the gate at exactly the resolve boundary — bail cleanly
      // so the subsequent style switch / mount can take over.
      return false;
    }

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
      const reason = swRegistered
        ? 'SW controller not yet claimed (install/activate race)'
        : 'SW unavailable';
      console.warn(`[map3d] ${reason} — attaching AWS Terrarium fallback DEM (~30 m global); will upgrade to IGN MNS LiDAR HD via swLateReady`);
      fns.ensureTrackingListeners();
      st.demTrackingEnabled = true;
      fns.reportStatus('loading', 60, 'Relief AWS (fallback)');

      // ── AWS Terrarium direct fallback ──────────────────────────────
      // Attach the AWS Open Data Terrarium tiles directly as a
      // raster-dem source with native `terrarium` encoding. Mapbox GL
      // v3 decodes terrarium on the GPU — no SW pipeline needed.
      // This gives the user 3D terrain everywhere at ~30 m resolution,
      // much better than a completely flat map.
      fns.attachAwsFallbackTerrain();
      fns.refreshTrackedSourceIds();

      if (!fns.isManagedTerrainActive()) {
        console.warn('[map3d] AWS fallback terrain did not attach cleanly');
        return false;
      }

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

      return true;
    }

    fns.ensureTrackingListeners();

    // Anti-flat: do NOT call detachManagedTerrain() here. refreshDemSource
    // (in the forceRebuild path) already detaches terrain *just before*
    // removing the source, then re-attaches it after addSource. Detaching
    // unconditionally here used to leave the map flat for the entire window
    // between this line and the subsequent setTerrain inside
    // refreshDemSource — visible during heartbeat-triggered re-bootstraps
    // and during setStyle({diff:false}) retries ("tile devient plate au
    // zoom" regression).

    const terrainContract = getActiveTerrainContract();
    if (map.getSource(unifiedDEMSource.id)) {
      // Treat every basemap switch the same way, regardless of whether the
      // previous style was a legacy v11/v12 stylesheet or a Standard v3
      // imported style. A surviving raster-dem source is not trustworthy
      // here: its tile pyramid may belong to the previous style lifecycle,
      // and Standard-Satellite is exactly the style family that can delay or
      // suppress the later style.load recovery path. Rebuild immediately so
      // terrain always reattaches onto a fresh source contract.
      if (!fns.refreshDemSource({ forceRebuild: terrainContract === 'unified-dem-v1' })) {
        // Last-resort: refreshDemSource detached terrain internally before
        // failing. Try a soft re-attach so we don't leave the map flat.
        fns.applyUnifiedTerrain();
        return false;
      }
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
        if (isCancelled() || runId !== st.styleBootstrapRunId) return;
        if (!fns.canMutateStyle()) {
          fns.scheduleTerrainRecovery();
          return;
        }

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
