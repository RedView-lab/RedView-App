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
import { attachVhrOrtho } from './vhrOrtho';
import { attachListeners } from './listeners';
import { attachStyleBootstrap } from './styleBootstrap';
import { attachHeartbeat } from './heartbeat';
import { clearVisibleTimer } from './visibleClock';

/**
 * Contrôleur du cycle de vie carte / DEM / terrain.
 *
 * Le contrôleur est découpé en modules ciblés sous `controller/`. Ils
 * partagent tous un `Ctx` mutable unique qui contient l'état d'exécution et un
 * registre `fns`. Les modules attachent leurs fonctions à `fns` pendant la
 * construction ; l'ordre d'assemblage ci-dessous ne change rien au
 * comportement, car chaque appel entre modules passe par `ctx.fns.*` une fois
 * la construction terminée.
 *
 * Responsabilités :
 *  - `context.ts`          : types partagés, fabrique d'état, fonctions d'appui.
 *  - `status.ts`           : remontée d'état + progression des tuiles DEM.
 *  - `demSource.ts`        : attachement / rafraîchissement de la source DEM + liaison du terrain.
 *  - `reload.ts`           : pipeline de rechargement + escalade.
 *  - `ignOrtho.ts`         : overlay d'ortho IGN optionnel.
 *  - `vhrOrtho.ts`         : overlay IGN PCRS / THR au-dessus de Mapbox Satellite.
 *  - `listeners.ts`        : suivi des tuiles + accroches inactivité / style.
 *  - `styleBootstrap.ts`   : bootstrap du style initial et après changement.
 *  - `heartbeat.ts`        : vérification périodique anti-plat du terrain.
 */
export function createMapLifecycleController(
  options: CreateMapLifecycleControllerOptions,
): MapLifecycleController {
  const ctx: Ctx = {
    ...options,
    state: createInitialState(),
    // rempli plus bas — chaque propriété est affectée par un appel attach*.
    fns: {} as ControllerFns,
  };

  attachHelpers(ctx);
  attachStatus(ctx);
  attachDemSource(ctx);
  attachReload(ctx);
  attachIgnOrtho(ctx);
  attachVhrOrtho(ctx);
  attachListeners(ctx);
  attachStyleBootstrap(ctx);
  attachHeartbeat(ctx);

  const cleanup = () => {
    ctx.fns.stopTerrainHeartbeat();
    ctx.fns.clearDemTracking();
    clearVisibleTimer(ctx.state.loadingDeadline);
    ctx.state.loadingDeadline = null;
    ctx.fns.clearStyleBootstrapArtifacts();
    ctx.fns.removeTrackingListeners();
  };

  return {
    reportStatus: ctx.fns.reportStatus,
    reloadMapElevation: ctx.fns.reloadMapElevation,
    reloadMapElevationForProfile: ctx.fns.reloadMapElevationForProfile,
    prepareStyleChange: ctx.fns.prepareStyleChange,
    bootstrapCurrentStyle: ctx.fns.bootstrapCurrentStyle,
    setDem3dQuality: ctx.fns.setDem3dQuality,
    cleanup,
  };
}

export type {
  CreateMapLifecycleControllerOptions,
  MapLifecycleController,
} from './context';
