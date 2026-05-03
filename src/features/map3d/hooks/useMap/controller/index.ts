import {
  attachHelpers,
  createInitialState,
  type ControllerFns,
  type CreateMapLifecycleControllerOptions,
  type Ctx,
  type MapLifecycleController,
} from './context';
import { attachStatus } from './status';
import { attachDemSource } from './demSource';
import { attachReload } from './reload';
import { attachIgnOrtho } from './ignOrtho';
import { attachListeners } from './listeners';
import { attachStyleBootstrap } from './styleBootstrap';
import { attachHeartbeat } from './heartbeat';

/**
 * Map / DEM / terrain lifecycle controller.
 *
 * The controller is split into focused modules under `controller/`. They
 * all share a single mutable `Ctx` containing the runtime state and a
 * `fns` registry. Modules attach their functions onto `fns` during
 * construction; the assembly order below doesn't matter for runtime
 * behaviour because every cross-module call goes through `ctx.fns.*`
 * after construction completes.
 *
 * Responsibilities:
 *  - `context.ts`          : shared types, state factory, helpers.
 *  - `status.ts`           : status reporting + DEM tile progress.
 *  - `demSource.ts`        : DEM source attach/refresh + terrain bind.
 *  - `reload.ts`           : reload pipeline + escalation.
 *  - `ignOrtho.ts`         : optional IGN ortho overlay.
 *  - `listeners.ts`        : tile-tracking + idle/style hooks.
 *  - `styleBootstrap.ts`   : initial + post-switch style bootstrap.
 *  - `heartbeat.ts`        : anti-flat periodic terrain verification.
 */
export function createMapLifecycleController(
  options: CreateMapLifecycleControllerOptions,
): MapLifecycleController {
  const ctx: Ctx = {
    ...options,
    state: createInitialState(),
    // populated below — every property is assigned by an attach* call.
    fns: {} as ControllerFns,
  };

  attachHelpers(ctx);
  attachStatus(ctx);
  attachDemSource(ctx);
  attachReload(ctx);
  attachIgnOrtho(ctx);
  attachListeners(ctx);
  attachStyleBootstrap(ctx);
  attachHeartbeat(ctx);

  const cleanup = () => {
    ctx.fns.stopTerrainHeartbeat();
    ctx.fns.clearDemTracking();
    ctx.fns.clearStyleBootstrapArtifacts();
    ctx.fns.removeTrackingListeners();
  };

  return {
    reportStatus: ctx.fns.reportStatus,
    reloadMapElevation: ctx.fns.reloadMapElevation,
    prepareStyleChange: ctx.fns.prepareStyleChange,
    bootstrapCurrentStyle: ctx.fns.bootstrapCurrentStyle,
    cleanup,
  };
}

export type {
  CreateMapLifecycleControllerOptions,
  MapLifecycleController,
} from './context';
