import {
  STYLE_READINESS_TELEMETRY_INTERVAL_MS,
  type Ctx,
} from './context';
import { clearVisibleTimer, setVisibleInterval, type VisibleTimer } from './visibleClock';

/** Mapbox fires `styledata` when it parses a style, `style.load` once its imports are in. */
const READINESS_EVENTS = ['style.load', 'styledata', 'sourcedata', 'idle'] as const;

function isActiveRun(ctx: Ctx, runId: number): boolean {
  return !ctx.isCancelled() && runId === ctx.state.styleBootstrapRunId;
}

/**
 * Resolves once the active style is parsed (`canMutateStyle()`: sources,
 * layers and terrain can be added) — true — or once a newer bootstrap run
 * superseded this one — false. Event-driven, no deadline: a style parses on
 * the first animation frame after `setStyle` (a JSON style) or once its JSON
 * arrived (a URL), and a hidden page renders no frame at all, so a timeout
 * would only fire on a map that is not being drawn. The telemetry warning
 * counts visible time and changes nothing.
 */
export async function waitForStyleReadiness(ctx: Ctx, runId: number): Promise<boolean> {
  const { map } = ctx;
  const fns = ctx.fns;

  await new Promise<void>((resolve) => {
    if (fns.canMutateStyle()) {
      fns.reportStatus('loading', 34, 'Style');
      resolve();
      return;
    }

    let settled = false;
    let telemetryTimer: VisibleTimer | null = null;
    let telemetryTicks = 0;

    const finish = (ready: boolean) => {
      settled = true;
      for (const eventName of READINESS_EVENTS) map.off(eventName, check);
      clearVisibleTimer(telemetryTimer);
      telemetryTimer = null;
      if (ready) fns.reportStatus('loading', 34, 'Style');
      resolve();
    };

    function check() {
      if (settled) return;
      if (!isActiveRun(ctx, runId)) {
        finish(false);
        return;
      }
      if (fns.canMutateStyle()) finish(true);
    }

    for (const eventName of READINESS_EVENTS) map.on(eventName, check);

    telemetryTimer = setVisibleInterval(() => {
      check();
      if (settled) return;
      telemetryTicks += 1;
      const elapsedSec = telemetryTicks * (STYLE_READINESS_TELEMETRY_INTERVAL_MS / 1000);
      const msg = `[map3d] style not parsed after ${elapsedSec} s of visible time — waiting on Mapbox`;
      if (elapsedSec >= 60) console.error(msg);
      else console.warn(msg);
    }, STYLE_READINESS_TELEMETRY_INTERVAL_MS);
  });

  return isActiveRun(ctx, runId);
}
