import { awsFallbackDEMSource, unifiedDEMSource } from '../../../lib/sources';
import { awaitController, swLateReady } from '../serviceWorker';
import type { Ctx } from './context';

interface BootstrapAwsFallbackOptions {
  ctx: Ctx;
  runId: number;
  swRegistered: boolean;
}

export function bootstrapAwsFallback({
  ctx,
  runId,
  swRegistered,
}: BootstrapAwsFallbackOptions): boolean {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  const LATE_SW_UPGRADE_WATCH_MS = 20000;
  const LATE_SW_UPGRADE_RETRY_MS = 750;
  const FORCE_HD_UPGRADE_MS = 7000;
  const FALLBACK_IMPORT_GUARD_WATCH_MS = 15000;
  const FALLBACK_IMPORT_GUARD_PROBE_INTERVAL_MS = 750;

  console.info('[map3d] bootstrapCurrentStyle:branch', {
    runId,
    branch: 'aws-fallback',
    swRegistered,
    hasSwController: !!navigator.serviceWorker?.controller,
  });

  const reason = swRegistered
    ? 'SW controller not yet claimed (install/activate race)'
    : 'SW unavailable';
  console.warn(`[map3d] ${reason} — attaching AWS Terrarium fallback DEM (~30 m global); will upgrade to IGN MNS LiDAR HD via swLateReady`);

  fns.ensureTrackingListeners();
  st.demTrackingEnabled = true;
  fns.reportStatus('loading', 60, 'Relief AWS (fallback)');
  fns.attachAwsFallbackTerrain();
  fns.refreshTrackedSourceIds();

  if (!fns.isManagedTerrainActive()) {
    console.warn('[map3d] AWS fallback terrain did not attach cleanly');
    return false;
  }

  const fallbackImportGuardTimers: ReturnType<typeof setTimeout>[] = [];
  const fallbackImportGuardCleanup: (() => void)[] = [];
  const fallbackImportGuardStartedAt = Date.now();

  const verifyAndReapplyFallbackTerrain = (origin: string) => {
    if (isCancelled() || runId !== st.styleBootstrapRunId) return;
    if (!map.getSource(awsFallbackDEMSource.id)) return;
    if (fns.isManagedTerrainRenderable() && fns.getManagedTerrainSourceId() === awsFallbackDEMSource.id) return;
    console.warn(`[map3d] fallback import-override guard (${origin}): terrain unbound, re-applying AWS fallback`);
    fns.attachAwsFallbackTerrain();
  };

  for (const delay of [200, 600, 1500]) {
    fallbackImportGuardTimers.push(setTimeout(() => verifyAndReapplyFallbackTerrain(`t+${delay}`), delay));
  }

  const fallbackPeriodicProbe = setInterval(() => {
    if (isCancelled() || runId !== st.styleBootstrapRunId) {
      clearInterval(fallbackPeriodicProbe);
      return;
    }
    if (Date.now() - fallbackImportGuardStartedAt > FALLBACK_IMPORT_GUARD_WATCH_MS) {
      clearInterval(fallbackPeriodicProbe);
      return;
    }
    verifyAndReapplyFallbackTerrain('periodic');
  }, FALLBACK_IMPORT_GUARD_PROBE_INTERVAL_MS);
  fallbackImportGuardCleanup.push(() => clearInterval(fallbackPeriodicProbe));

  try {
    const mapWithEvents = map as unknown as {
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
    };
    const onImportLoad = () => verifyAndReapplyFallbackTerrain('style.import.load');
    const onLateStyleLoad = () => verifyAndReapplyFallbackTerrain('style.load');
    mapWithEvents.on?.('style.import.load', onImportLoad);
    mapWithEvents.on?.('style.load', onLateStyleLoad);
    fallbackImportGuardCleanup.push(() => mapWithEvents.off?.('style.import.load', onImportLoad));
    fallbackImportGuardCleanup.push(() => mapWithEvents.off?.('style.load', onLateStyleLoad));
  } catch {
    /* event name may not exist on this Mapbox version */
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
    if (!lateSwUpgradeTimer) return;
    clearTimeout(lateSwUpgradeTimer);
    lateSwUpgradeTimer = null;
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

  const forceHdUpgradeTimer = setTimeout(() => {
    if (isCancelled() || runId !== st.styleBootstrapRunId) return;
    if (map.getSource(unifiedDEMSource.id)) return;

    console.warn(
      `[map3d] force-hd escalation: still on AWS fallback after ${FORCE_HD_UPGRADE_MS} ms — forcing SW upgrade check`,
    );

    void (async () => {
      if (!navigator.serviceWorker?.controller) {
        const claimed = await awaitController(2500);
        if (!claimed || isCancelled() || runId !== st.styleBootstrapRunId) {
          if (!fns.isManagedTerrainRenderable()) {
            fns.attachAwsFallbackTerrain();
          }
          return;
        }
      }

      await tryLateSwUpgrade('force-hd-escalation');
    })();
  }, FORCE_HD_UPGRADE_MS);

  const priorDispose = st.disposeStyleRecovery;
  st.disposeStyleRecovery = () => {
    priorDispose?.();
    clearLateSwUpgradeTimer();
    clearTimeout(forceHdUpgradeTimer);
    for (const timer of fallbackImportGuardTimers) clearTimeout(timer);
    for (const cleanup of fallbackImportGuardCleanup) {
      try { cleanup(); } catch { /* noop */ }
    }
  };

  void swLateReady.then((lateOk) => {
    if (!lateOk) return;
    void tryLateSwUpgrade('swLateReady');
  });

  return true;
}