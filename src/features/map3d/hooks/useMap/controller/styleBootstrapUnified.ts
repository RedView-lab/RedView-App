import { unifiedDEMSource } from '../../../lib/sources';
import { waitForMapIdleOrTimeout } from '../runtimeProfile';
import type { Ctx } from './context';

interface BootstrapUnifiedDemOptions {
  ctx: Ctx;
  runId: number;
  applyStyleDecorators: () => void;
}

export function bootstrapUnifiedDem({
  ctx,
  runId,
  applyStyleDecorators,
}: BootstrapUnifiedDemOptions): boolean {
  const {
    map,
    isCancelled,
    getActiveTerrainContract,
    runtimeProfile,
  } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.ensureTrackingListeners();
  console.info('[map3d] bootstrapCurrentStyle:branch', {
    runId,
    branch: 'unified-dem',
    hasSwController: !!navigator.serviceWorker?.controller,
  });

  const terrainContract = getActiveTerrainContract();
  if (map.getSource(unifiedDEMSource.id)) {
    if (!fns.refreshDemSource({ forceRebuild: terrainContract === 'unified-dem-v1' })) {
      fns.applyUnifiedTerrain();
      return false;
    }
  } else if (!fns.refreshDemSource()) {
    return false;
  }

  fns.reportStatus('loading', 68, 'Relief');
  fns.startTerrainHeartbeat();

  const IMPORT_GUARD_WATCH_MS = 15000;
  const IMPORT_GUARD_PROBE_INTERVAL_MS = 750;
  const FORCE_3D_ESCALATION_MS = 7000;
  const importGuardTimers: ReturnType<typeof setTimeout>[] = [];
  const importGuardCleanup: (() => void)[] = [];
  const importGuardStartedAt = Date.now();

  const verifyAndReapplyTerrain = (origin: string) => {
    if (isCancelled() || runId !== st.styleBootstrapRunId) return;
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
    const onImportLoad = () => verifyAndReapplyTerrain('style.import.load');
    const onLateStyleLoad = () => verifyAndReapplyTerrain('style.load');
    mapWithEvents.on?.('style.import.load', onImportLoad);
    mapWithEvents.on?.('style.load', onLateStyleLoad);
    importGuardCleanup.push(() => mapWithEvents.off?.('style.import.load', onImportLoad));
    importGuardCleanup.push(() => mapWithEvents.off?.('style.load', onLateStyleLoad));
  } catch {
    /* event name may not exist on this Mapbox version */
  }

  const force3dEscalationTimer = setTimeout(() => {
    if (isCancelled() || runId !== st.styleBootstrapRunId) return;
    if (fns.isUnifiedTerrainActive() && fns.isManagedTerrainRenderable()) return;

    console.warn(
      `[map3d] force-3d escalation: terrain still not renderable after ${FORCE_3D_ESCALATION_MS} ms — forcing rebuild`,
    );

    if (!fns.canMutateStyle()) {
      fns.scheduleTerrainRecovery();
      return;
    }

    let rebuilt = false;
    try {
      rebuilt = fns.refreshDemSource({ forceRebuild: true });
    } catch {
      rebuilt = false;
    }
    if (rebuilt) {
      fns.applyUnifiedTerrain();
    }

    if (fns.isUnifiedTerrainActive() && fns.isManagedTerrainRenderable()) return;

    if (navigator.serviceWorker?.controller) {
      st.demReloadCoolingUntil = 0;
      fns.reloadMapElevation();
      return;
    }

    fns.scheduleTerrainRecovery();
  }, FORCE_3D_ESCALATION_MS);

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
      fns.detachManagedTerrain();

      const needsRebuild = !map.getSource(unifiedDEMSource.id);
      if (needsRebuild) {
        if (!fns.refreshDemSource()) return;
      } else if (!fns.refreshDemSource({ forceRebuild: true })) {
        return;
      }

      fns.reportStatus('loading', 68, 'Relief');
      fns.armTerrainBootstrap(() => {
        void finishStyleBootstrapWhenReady();
      });
    }, 0);
  };

  map.on('style.load', recoverStyleArtifacts);

  const priorDispose = st.disposeStyleRecovery;
  st.disposeStyleRecovery = () => {
    priorDispose?.();
    clearTimeout(force3dEscalationTimer);
    for (const timer of importGuardTimers) clearTimeout(timer);
    for (const cleanup of importGuardCleanup) {
      try { cleanup(); } catch { /* noop */ }
    }
    map.off('style.load', recoverStyleArtifacts);
  };

  st.orthoBootTimer = setTimeout(() => {
    void finishStyleBootstrapWhenReady();
  }, runtimeProfile.orthoBootFallbackMs);

  fns.armTerrainBootstrap(() => {
    void finishStyleBootstrapWhenReady();
  });

  return true;
}