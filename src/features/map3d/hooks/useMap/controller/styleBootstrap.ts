import { unifiedDEMSource } from '../../../lib/sources';
import { waitForMapIdleOrTimeout } from '../runtimeProfile';
import { swReady, swLateReady, awaitController } from '../serviceWorker';
import {
  STYLE_READINESS_TELEMETRY_INTERVAL_MS,
  STYLE_READINESS_FORCE_BYPASS_MS,
  type Ctx,
} from './context';
import { getStyleContentStats } from './styleContent';

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
    runtimeProfile,
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
    const applyStyleDecorators = () => {
      try {
        map.setFog(fogConfig);
      } catch {
        /* style may still be finishing its internal graph rebuild */
      }
      applyConfiguredLightPreset();
    };
    const promoteStyleContentBypass = (logLabel: string): boolean => {
      try {
        const style = map.getStyle();
        if (!style) return false;
        const stats = getStyleContentStats(style);
        if (!stats.hasContent) return false;
        if (!st.spriteStormBypass) {
          console.warn(
            `[map3d] ${logLabel}: style has content while isStyleLoaded() is false — enabling sprite-storm bypass`,
            { layers: stats.layerCount, sources: stats.sourceCount, imports: stats.importCount },
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
      let forceBypassTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        map.off('style.load', onStyleLoad);
        map.off('styledata', onStyleData);
        map.off('sourcedata', onSourceData);
        map.off('idle', onIdle);
        if (telemetryTimer) {
          clearInterval(telemetryTimer);
          telemetryTimer = null;
        }
        if (forceBypassTimer) {
          clearTimeout(forceBypassTimer);
          forceBypassTimer = null;
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

      // Root-level safety net #1 — synchronous + rAF probe.
      // If the style settled before our listeners attached (cold cache
      // hit, or a setStyle({diff:false}) that completed in the same
      // microtask), no event will ever fire again for this run. Probe
      // immediately and on the next two animation frames so we don't
      // depend on Mapbox emitting a fresh signal for an already-loaded
      // style.
      let probeRafs = 0;
      const probeOnce = (origin: string) => {
        if (settled) return;
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (fns.canMutateStyle()) { settle('Style'); return; }
        if (promoteStyleContentBypass(origin)) { settle('Style (récupération)'); return; }
        if (probeRafs < 2) {
          probeRafs += 1;
          requestAnimationFrame(() => probeOnce(`probe-raf-${probeRafs}`));
        }
      };
      probeOnce('probe-sync');

      // Root-level safety net #2 — hard force-bypass timer.
      // Visible bug ("aucun mapload qui arrive en satellite, tout
      // devient plat au zoom"): Mapbox sometimes emits NO usable
      // readiness event after attaching a freshly hydrated satellite
      // style — no `style.load`, no `styledata`, no `sourcedata`, no
      // `idle`. Without this timer, the bootstrap sat indefinitely on
      // the styleLoaded promise (first telemetry tick is 15 s away,
      // by which point the user is already zooming on a flat map and
      // has to reload manually). After STYLE_READINESS_FORCE_BYPASS_MS
      // we apply the same recovery the `idle` handler already does —
      // force sprite-storm bypass, then resolve — so the rest of the
      // bootstrap (DEM source, terrain attach, heartbeat) can run.
      // The heartbeat then self-heals any residual flat state.
      forceBypassTimer = setTimeout(() => {
        forceBypassTimer = null;
        if (settled) return;
        if (isCancelled() || runId !== st.styleBootstrapRunId) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (fns.canMutateStyle()) { settle('Style'); return; }
        if (!promoteStyleContentBypass('force-bypass')) {
          if (!st.spriteStormBypass) {
            console.warn(
              `[map3d] no Mapbox readiness event in ${STYLE_READINESS_FORCE_BYPASS_MS} ms — forcing sprite-storm bypass to unblock terrain bootstrap`,
            );
            st.spriteStormBypass = true;
          }
        }
        settle('Style (forcé)');
      }, STYLE_READINESS_FORCE_BYPASS_MS);
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

    if (!fns.canMutateStyle() && st.spriteStormBypass) {
      // A forced sprite-storm bypass can resolve the readiness gate a
      // fraction too early: Mapbox has started rebuilding the style, but
      // the first usable sources/layers land a few frames later. If we
      // bail immediately here, the single-shot bootstrap ends before DEM
      // source / terrain attach ever run, leaving the world flat until a
      // manual reload. Give the style a short post-bypass grace window to
      // publish its first usable content before declaring failure.
      const bypassUsable = await new Promise<boolean>((resolve) => {
        let settled = false;
        let rafId = 0;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (rafId) cancelAnimationFrame(rafId);
          if (timeoutId) clearTimeout(timeoutId);
          resolve(value);
        };
        const probe = () => {
          if (settled) return;
          if (isCancelled() || runId !== st.styleBootstrapRunId) {
            finish(false);
            return;
          }
          if (fns.canMutateStyle()) {
            finish(true);
            return;
          }
          rafId = requestAnimationFrame(probe);
        };
        timeoutId = setTimeout(() => finish(fns.canMutateStyle()), 1200);
        probe();
      });
      if (!bypassUsable) {
        console.warn('[map3d] style still unusable after forced bypass grace window');
      }
    }

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
      const LATE_SW_UPGRADE_WATCH_MS = 20000;
      const LATE_SW_UPGRADE_RETRY_MS = 750;
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

      let lateSwUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
      const lateSwUpgradeStartedAt = Date.now();
      const clearLateSwUpgradeTimer = () => {
        if (lateSwUpgradeTimer) {
          clearTimeout(lateSwUpgradeTimer);
          lateSwUpgradeTimer = null;
        }
      };
      const scheduleLateSwUpgradeRetry = () => {
        if (lateSwUpgradeTimer) return;
        lateSwUpgradeTimer = setTimeout(() => {
          lateSwUpgradeTimer = null;
          void tryLateSwUpgrade('retry');
        }, LATE_SW_UPGRADE_RETRY_MS);
      };
      const tryLateSwUpgrade = async (origin: string): Promise<void> => {
        if (isCancelled()) return;
        if (runId !== st.styleBootstrapRunId) return;
        if (!navigator.serviceWorker?.controller) return;
        if (map.getSource(unifiedDEMSource.id)) return;

        if (!fns.canMutateStyle()) {
          if (Date.now() - lateSwUpgradeStartedAt > LATE_SW_UPGRADE_WATCH_MS) {
            console.warn(`[map3d] Late SW recovery gave up waiting for mutable style (${origin})`);
            return;
          }
          scheduleLateSwUpgradeRetry();
          return;
        }

        console.log(`[map3d] Late SW recovery (${origin}): upgrading from AWS fallback to full DEM pipeline`);
        clearLateSwUpgradeTimer();
        fns.reportStatus('loading', 50, 'Récupération relief HD');
        fns.detachAwsFallbackTerrain();
        if (st.finishOnIdle) {
          map.off('idle', st.finishOnIdle);
          st.finishOnIdle = null;
        }
        void fns.bootstrapCurrentStyle();
      };
      const priorDispose = st.disposeStyleRecovery;
      st.disposeStyleRecovery = () => {
        priorDispose?.();
        clearLateSwUpgradeTimer();
      };

      // ── Late-SW recovery ──────────────────────────────────────────
      // The SW didn't claim within 2.5 s, but it may still be installing.
      // Wait for it in the background: if it appears within ~20 s,
      // remove the AWS fallback and re-trigger the full DEM/terrain
      // bootstrap with IGN LiDAR HD.
      void swLateReady.then((lateOk) => {
        if (!lateOk) return;
        void tryLateSwUpgrade('swLateReady');
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

    // ── Import-override guard ─────────────────────────────────────────
    // Mapbox Standard / Standard-Satellite are imported v3 styles. Their
    // imports ("basemap" fragment) carry their own terrain spec bound to
    // the builtin `mapbox-dem` source. When the import resolves AFTER our
    // `applyUnifiedTerrain` (which happens during initial bootstrap), the
    // import's terrain silently overwrites ours and the world stays flat
    // until the 12 s heartbeat catches it (~24 s with the failure
    // threshold).
    //
    // Standard-Satellite expands its import in TWO stages: Stage 1
    // (~50-300 ms) publishes a partial layer set (~10-15 top-level
    // layers, sometimes only `imports[].data` populated); Stage 2 (often
    // 500 ms - 5 s+, occasionally still settling at 8-10 s on cold-cache
    // Firefox) attaches the actual terrain spec and the satellite raster
    // sources. A topo → satellite RUNTIME switch is the worst case
    // because the previous topo style had already given us a working
    // `unified-dem` terrain binding, so Stage 2's late hijack flips us
    // from 3D to flat after the user already sees imagery.
    //
    // Strategy: re-verify terrain binding aggressively for the entire
    // import-settling window (up to IMPORT_GUARD_WATCH_MS), not just at
    // four fixed timestamps. Re-add the `unified-dem` source if Mapbox
    // dropped it during the diff:false setStyle, and re-bind terrain
    // every time `style.load` / `style.import.load` fires (these can
    // fire late on satellite, well after our initial bootstrap).
    const IMPORT_GUARD_WATCH_MS = 15000;
    const IMPORT_GUARD_PROBE_INTERVAL_MS = 750;
    const importGuardTimers: ReturnType<typeof setTimeout>[] = [];
    const importGuardCleanup: (() => void)[] = [];
    const importGuardStartedAt = Date.now();
    const verifyAndReapplyTerrain = (origin: string) => {
      if (isCancelled() || runId !== st.styleBootstrapRunId) return;
      // If Mapbox dropped our unified-dem source during the diff:false
      // setStyle and our recovery never re-added it, do that now — the
      // import-guard window is the last line of defense before the
      // 12 s heartbeat catches a flat world.
      if (!map.getSource(unifiedDEMSource.id)) {
        try {
          if (!fns.refreshDemSource()) return;
        } catch {
          return;
        }
      }
      if (fns.isUnifiedTerrainActive() && fns.isManagedTerrainRenderable()) return;
      console.warn(`[map3d] import-override guard (${origin}): terrain unbound, re-applying`);
      fns.applyUnifiedTerrain();
    };
    // Front-load three quick probes for Stage-1 expansion, then a
    // periodic probe every IMPORT_GUARD_PROBE_INTERVAL_MS until the
    // watch window closes. The periodic probe is cheap (it short-
    // circuits as soon as terrain is bound and renderable) and catches
    // any Stage-2 hijack the fixed-timer schedule used to miss.
    for (const delay of [200, 600, 1500]) {
      importGuardTimers.push(setTimeout(() => verifyAndReapplyTerrain(`t+${delay}`), delay));
    }
    const periodicProbe = setInterval(() => {
      if (isCancelled() || runId !== st.styleBootstrapRunId) {
        clearInterval(periodicProbe);
        return;
      }
      if (Date.now() - importGuardStartedAt > IMPORT_GUARD_WATCH_MS) {
        clearInterval(periodicProbe);
        return;
      }
      verifyAndReapplyTerrain('periodic');
    }, IMPORT_GUARD_PROBE_INTERVAL_MS);
    importGuardCleanup.push(() => clearInterval(periodicProbe));
    try {
      const mapWithEvents = map as unknown as {
        on?: (ev: string, fn: () => void) => void;
        off?: (ev: string, fn: () => void) => void;
      };
      // Persistent (not `.once`) so every late import-load — Stage 2,
      // Stage 3, satellite raster re-hydrate — triggers a re-verify.
      const onImportLoad = () => verifyAndReapplyTerrain('style.import.load');
      mapWithEvents.on?.('style.import.load', onImportLoad);
      importGuardCleanup.push(() => mapWithEvents.off?.('style.import.load', onImportLoad));
      // Late `style.load` also indicates the import finished settling and
      // is a strong signal Mapbox may have just (re)applied its builtin
      // terrain spec — re-bind ours immediately.
      const onLateStyleLoad = () => verifyAndReapplyTerrain('style.load');
      mapWithEvents.on?.('style.load', onLateStyleLoad);
      importGuardCleanup.push(() => mapWithEvents.off?.('style.load', onLateStyleLoad));
    } catch { /* event name may not exist on this Mapbox version */ }
    const priorDispose = st.disposeStyleRecovery;
    st.disposeStyleRecovery = () => {
      priorDispose?.();
      for (const t of importGuardTimers) clearTimeout(t);
      for (const c of importGuardCleanup) { try { c(); } catch { /* noop */ } }
    };

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

        // Only clear terrain when it is one of the managed DEM sources we
        // own. Standard / Standard-Satellite can still be hydrating their
        // imported builtin `mapbox-dem` terrain at this point; clearing it
        // unconditionally reintroduces the initial flat-world race before
        // unified-dem has fully rebound.
        fns.detachManagedTerrain();

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
