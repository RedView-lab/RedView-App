import type { CameraController, CameraPose } from '../camera';
import type { SceneLod } from '../lod/sceneLod';
import { sampleElevationAtProj } from '../route/terrainRaycaster';
import type { ViewerRouteSceneParams } from '../route/types';
import type { FrameClock } from './frameClock';
import { ViewerBench } from './viewerBench';

export interface ViewerBenchHooksDeps {
  mode: 'orbit' | 'shots' | null;
  camera: CameraController;
  extent: number;
  /** Centre de la scène dans le CRS de la tuile. */
  cx: number;
  cy: number;
  heightSceneParams: ViewerRouteSceneParams;
  sceneLod: SceneLod;
  frameClock: FrameClock;
  /** Le bench orbit a démarré : la boucle de rendu enregistre ses images. */
  onBenchRun: (run: ViewerBench) => void;
  /** Une image est programmée (la boucle n'est pas au repos). */
  isRendering: () => boolean;
}

/** `?bench=orbit` et `?bench=shots` : les points d'accroche que pilotent les benchs du viewer. */
export function installViewerBenchHooks(deps: ViewerBenchHooksDeps): void {
  const { camera, extent, cx, cy, heightSceneParams, sceneLod, frameClock } = deps;
  if (deps.mode === 'orbit') {
    void (async () => {
      // Partir d'une scène stabilisée : la première passe mesure alors le flux
      // déclenché par le seul mouvement.
      const deadline = performance.now() + 30_000;
      await new Promise((resolve) => setTimeout(resolve, 500));
      while (!sceneLod.isIdle() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const benchRun = new ViewerBench({
        camera,
        extent,
        groundAt: (x, z) => sampleElevationAtProj(x + cx, cy - z, heightSceneParams),
        getRefreshMs: () => frameClock.getRefreshMs(),
        onDone: (result) => {
          (window as unknown as { __rvLidarBench?: unknown }).__rvLidarBench = result;
          console.log(`[LiDAR bench] ${JSON.stringify(result)}`);
        },
      });
      deps.onBenchRun(benchRun);
      benchRun.start();
    })();
  } else if (deps.mode === 'shots') {
    // Vues fixes pour les captures A/B visuelles (script-test-bench/lidar-viewer-shots) :
    // le script pose une vue, attend que la boucle soit au repos (l'image a
    // atteint sa qualité au repos), puis prend une capture d'écran.
    (window as unknown as { __rvLidarShots?: unknown }).__rvLidarShots = {
      extent,
      setPose: (pose: Partial<CameraPose>) => camera.setPose(pose),
      groundAt: (x: number, z: number) => sampleElevationAtProj(x + cx, cy - z, heightSceneParams),
      state: () => ({ rendering: deps.isRendering(), idle: sceneLod.isIdle(), stats: sceneLod.getStats() }),
    };
  }
}
