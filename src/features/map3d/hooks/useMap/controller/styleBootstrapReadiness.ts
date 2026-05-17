import {
  STYLE_READINESS_TELEMETRY_INTERVAL_MS,
  STYLE_READINESS_FORCE_BYPASS_MS,
  type Ctx,
} from './context';
import { getStyleContentStats } from './styleContent';

function isActiveRun(ctx: Ctx, runId: number): boolean {
  return !ctx.isCancelled() && runId === ctx.state.styleBootstrapRunId;
}

function promoteStyleContentBypass(ctx: Ctx, logLabel: string): boolean {
  const { map } = ctx;
  const st = ctx.state;

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
}

export async function waitForStyleReadiness(ctx: Ctx, runId: number): Promise<boolean> {
  const { map } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;

  await new Promise<void>((resolve) => {
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

    const resolveIfInactive = () => {
      if (settled) return true;
      if (isActiveRun(ctx, runId)) return false;
      settled = true;
      cleanup();
      resolve();
      return true;
    };

    const tryReady = (origin: string) => {
      if (settled) return;
      if (resolveIfInactive()) return;
      if (fns.canMutateStyle()) {
        settle('Style');
        return;
      }
      if (promoteStyleContentBypass(ctx, origin)) {
        settle('Style (récupération)');
      }
    };

    const onStyleLoad = () => tryReady('style.load');
    const onStyleData = () => tryReady('styledata');
    const onSourceData = () => tryReady('sourcedata');
    const onIdle = () => {
      if (settled) return;
      if (resolveIfInactive()) return;
      if (fns.canMutateStyle()) {
        settle('Style');
        return;
      }
      if (!promoteStyleContentBypass(ctx, 'idle') && !st.spriteStormBypass) {
        console.warn('[map3d] first idle reached without style content — forcing sprite-storm bypass');
        st.spriteStormBypass = true;
      }
      settle('Style (idle)');
    };

    map.on('style.load', onStyleLoad);
    map.on('styledata', onStyleData);
    map.on('sourcedata', onSourceData);
    map.on('idle', onIdle);

    let probeRafs = 0;
    const probeOnce = (origin: string) => {
      if (settled) return;
      if (resolveIfInactive()) return;
      if (fns.canMutateStyle()) {
        settle('Style');
        return;
      }
      if (promoteStyleContentBypass(ctx, origin)) {
        settle('Style (récupération)');
        return;
      }
      if (probeRafs < 2) {
        probeRafs += 1;
        const nextProbe = probeRafs;
        requestAnimationFrame(() => probeOnce(`probe-raf-${nextProbe}`));
      }
    };
    probeOnce('probe-sync');

    forceBypassTimer = setTimeout(() => {
      forceBypassTimer = null;
      if (settled) return;
      if (resolveIfInactive()) return;
      if (fns.canMutateStyle()) {
        settle('Style');
        return;
      }
      if (!promoteStyleContentBypass(ctx, 'force-bypass') && !st.spriteStormBypass) {
        console.warn(
          `[map3d] no Mapbox readiness event in ${STYLE_READINESS_FORCE_BYPASS_MS} ms — forcing sprite-storm bypass to unblock terrain bootstrap`,
        );
        st.spriteStormBypass = true;
      }
      settle('Style (forcé)');
    }, STYLE_READINESS_FORCE_BYPASS_MS);

    telemetryTimer = setInterval(() => {
      if (settled) {
        if (telemetryTimer) {
          clearInterval(telemetryTimer);
          telemetryTimer = null;
        }
        return;
      }
      if (resolveIfInactive()) return;

      telemetryTicks += 1;
      let layers = 0;
      let sources = 0;
      let importsLen = 0;
      try {
        const style = map.getStyle();
        layers = style?.layers?.length ?? 0;
        sources = Object.keys(style?.sources ?? {}).length;
        const imports = (style as { imports?: unknown[] } | null | undefined)?.imports;
        if (Array.isArray(imports)) importsLen = imports.length;
      } catch {
        /* ignore */
      }
      const elapsedSec = telemetryTicks * (STYLE_READINESS_TELEMETRY_INTERVAL_MS / 1000);
      const tag = elapsedSec >= 60 ? 'error' : 'warn';
      const msg = `[map3d] style readiness still pending after ${elapsedSec}s — waiting on Mapbox events`;
      const diag = {
        isStyleLoaded: (() => {
          try { return map.isStyleLoaded(); } catch { return false; }
        })(),
        layers,
        sources,
        imports: importsLen,
      };
      if (tag === 'error') console.error(msg, diag);
      else console.warn(msg, diag);
      tryReady('telemetry-probe');
    }, STYLE_READINESS_TELEMETRY_INTERVAL_MS);
  });

  return isActiveRun(ctx, runId);
}

export async function ensureStyleUsableForBootstrap(ctx: Ctx, runId: number): Promise<boolean> {
  const fns = ctx.fns;
  const st = ctx.state;

  if (!isActiveRun(ctx, runId)) return false;

  if (!fns.canMutateStyle() && st.spriteStormBypass) {
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
        if (!isActiveRun(ctx, runId)) {
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

  let styleUsableForBootstrap = fns.canMutateStyle();
  if (!styleUsableForBootstrap) {
    try {
      const stats = getStyleContentStats(ctx.map.getStyle());
      if (stats.hasContent) {
        if (!st.spriteStormBypass) {
          console.warn(
            '[map3d] post-readiness fallback: proceeding with usable style content while isStyleLoaded() remains false',
            { layers: stats.layerCount, sources: stats.sourceCount, imports: stats.importCount },
          );
          st.spriteStormBypass = true;
        }
        styleUsableForBootstrap = true;
      }
    } catch {
      styleUsableForBootstrap = false;
    }
  }

  return styleUsableForBootstrap && isActiveRun(ctx, runId);
}