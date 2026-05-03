import { unifiedDEMSource } from '../../../lib/sources';
import {
  TERRAIN_HEARTBEAT_INTERVAL_MS,
  TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD,
  type Ctx,
} from './context';

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
 */
export function attachHeartbeat(ctx: Ctx): void {
  const { map, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  fns.startTerrainHeartbeat = () => {
    if (st.heartbeatTimer) return;
    st.heartbeatFailures = 0;
    st.heartbeatTimer = setInterval(() => {
      if (isCancelled()) {
        fns.stopTerrainHeartbeat();
        return;
      }
      // Don't probe before the first ready or while a reload is
      // already in flight — those paths handle their own verification.
      if (!st.hasReportedReadyOnce) return;
      if (st.reloadInProgress) return;
      if (!fns.canMutateStyle()) return;

      const sourcePresent = !!map.getSource(unifiedDEMSource.id);
      const terrainBound = fns.isUnifiedTerrainActive();
      if (sourcePresent && terrainBound) {
        st.heartbeatFailures = 0;
        return;
      }

      st.heartbeatFailures += 1;
      console.warn(
        '[map3d] heartbeat: flat state detected',
        { sourcePresent, terrainBound, failures: st.heartbeatFailures },
      );

      // Soft fix first: re-attach if the source is still there.
      if (sourcePresent && !terrainBound) {
        fns.applyUnifiedTerrain();
        if (fns.isUnifiedTerrainActive()) {
          st.heartbeatFailures = 0;
          return;
        }
      }

      // Either the source is gone or re-attach didn't take. Escalate
      // to a full reload (cooldown bypassed) once we're sure it's not
      // a one-shot blip.
      if (st.heartbeatFailures >= TERRAIN_HEARTBEAT_FAILURES_BEFORE_RELOAD) {
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
