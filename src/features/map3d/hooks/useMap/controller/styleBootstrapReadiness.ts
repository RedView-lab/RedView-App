import {
  STYLE_READINESS_TELEMETRY_INTERVAL_MS,
  type Ctx,
} from './context';
import { clearVisibleTimer, setVisibleInterval, type VisibleTimer } from './visibleClock';

/** Mapbox émet `styledata` quand il analyse un style, `style.load` une fois ses imports arrivés. */
const READINESS_EVENTS = ['style.load', 'styledata', 'sourcedata', 'idle'] as const;

function isActiveRun(ctx: Ctx, runId: number): boolean {
  return !ctx.isCancelled() && runId === ctx.state.styleBootstrapRunId;
}

/**
 * Se résout dès que le style actif est analysé (`canMutateStyle()` : sources,
 * calques et terrain peuvent être ajoutés) — true — ou dès qu'une exécution de
 * bootstrap plus récente a remplacé celle-ci — false. Piloté par les
 * événements, sans échéance : un style est analysé à la première image
 * d'animation après `setStyle` (style JSON) ou dès l'arrivée de son JSON (URL),
 * et une page masquée ne rend aucune image, donc un délai ne se déclencherait
 * que sur une carte qui n'est pas dessinée. L'avertissement de télémétrie
 * compte le temps visible et ne change rien.
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
