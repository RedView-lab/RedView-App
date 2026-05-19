import { unifiedDEMSource, awsFallbackDEMSource, awsFastDEMSource } from '../../../lib/sources';
import {
  TERRAIN_HEARTBEAT_INTERVAL_MS,
  TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD,
  type Ctx,
} from './context';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';

/**
 * Anti-flat heartbeat. Once the bootstrap has reported "ready" at least
 * once, periodically verify that terrain is still bound to the unified
 * DEM. This is the last line of defence against silent terrain drops
 * (Mapbox sometimes detaches terrain after a late style.load or after
 * a sprite/image rejection storm without firing any error event).
 *
 * Escalation:
 *   1. Try a soft re-attach (`applyUnifiedTerrain`).
 *   2. If the next heartbeat still sees a flat state, force a full
 *      reload (`reloadMapElevation`, cooldown bypassed).
 *   3. After repeated failures, the standard reload escalation kicks
 *      in (style re-apply, etc.).
 *   4. NEW: if the SW controller is now available but no DEM source
 *      was ever added (late-SW-claim session stuck in plain-Mapbox
 *      mode), re-trigger the full bootstrap from scratch.
 */
export function attachHeartbeat(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.startTerrainHeartbeat = () => {
    if (st.heartbeatTimer) return;
    st.heartbeatFailures = 0;
    let tickCount = 0;
    st.heartbeatTimer = setInterval(() => {
      tickCount += 1;
      if (isCancelled()) {
        fns.stopTerrainHeartbeat();
        return;
      }
      // Don't probe while a reload is already in flight — those paths
      // handle their own verification.
      if (st.reloadInProgress) return;
      if (!fns.canMutateStyle()) return;
      // Fast 30 m mode owns the terrain binding directly. The aws-fast-dem
      // source is rock-stable (AWS S3), so we only verify it is still
      // bound and re-attach on the rare detach. No reload escalation.
      if (getActiveDem3dQuality() === 'fast-30m') {
        try {
          const currentTerrain = map.getTerrain();
          if (currentTerrain?.source === awsFastDEMSource.id) {
            st.heartbeatFailures = 0;
            return;
          }
        } catch { /* terrain query failed */ }
        // Silent detach — re-bind.
        try {
          fns.applyFastDemTerrain();
          st.heartbeatFailures = 0;
        } catch { /* best-effort */ }
        return;
      }
      // Allow self-heal even before the first "ready" report if the
      // heartbeat has been ticking for a while (>15s = 3 ticks). This
      // covers bootstraps that stall and never call finishDemActivity.
      if (!st.hasReportedReadyOnce && tickCount < 3) return;

      const sourcePresent = !!map.getSource(unifiedDEMSource.id);
      const awsFallbackPresent = !!map.getSource(awsFallbackDEMSource.id);
      const terrainBound = fns.isUnifiedTerrainActive();
      const terrainRenderable = fns.isManagedTerrainRenderable();

      // AWS fallback terrain is active — this is the expected state
      // when the SW never claimed. The terrain is real (~30 m AWS
      // Terrarium), just lower resolution. Don't report flat state.
      if (awsFallbackPresent && !sourcePresent) {
        try {
          const currentTerrain = map.getTerrain();
          if (currentTerrain?.source === awsFallbackDEMSource.id) {
            st.heartbeatFailures = 0;
            return;
          }
        } catch { /* terrain query failed */ }
        // AWS source exists but terrain isn't bound — try re-attaching
        try {
          map.setTerrain({ source: awsFallbackDEMSource.id, exaggeration: 1.5 });
          st.heartbeatFailures = 0;
          return;
        } catch { /* fallback re-attach failed */ }
      }

      if (sourcePresent && terrainBound && terrainRenderable) {
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

      // Soft fix first: re-attach if the source is still there.
      if (sourcePresent && !terrainBound) {
        fns.applyUnifiedTerrain();
        if (fns.isUnifiedTerrainActive()) {
          st.heartbeatFailures = 0;
          return;
        }
      }

      // If the DEM source was never added AND the SW controller
      // is now available, we're in a late-SW-claim session that got
      // stuck in plain-Mapbox mode. The only fix is to re-run the
      // full bootstrap.
      if (!sourcePresent && navigator.serviceWorker?.controller) {
        console.warn('[map3d] heartbeat: DEM source missing but SW available — re-bootstrapping');
        st.heartbeatFailures = 0;
        void fns.bootstrapCurrentStyle();
        return;
      }

      // Either the source is gone or re-attach didn't take. Escalate
      // to a full reload (cooldown bypassed) once we're sure it's not
      // a one-shot blip — but only if the SW is available, since
      // reloadMapElevation requires the controller.
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
    if (st.heartbeatTimer) {
      clearInterval(st.heartbeatTimer);
      st.heartbeatTimer = null;
    }
    st.heartbeatFailures = 0;
  };
}

