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
  /** Scene centre in the tile CRS. */
  cx: number;
  cy: number;
  heightSceneParams: ViewerRouteSceneParams;
  sceneLod: SceneLod;
  frameClock: FrameClock;
  /** The orbit bench started: the render loop records its frames. */
  onBenchRun: (run: ViewerBench) => void;
  /** A frame is scheduled (the loop has not gone idle). */
  isRendering: () => boolean;
}

/** `?bench=orbit` and `?bench=shots`: the hooks the viewer benchmarks drive. */
export function installViewerBenchHooks(deps: ViewerBenchHooksDeps): void {
  const { camera, extent, cx, cy, heightSceneParams, sceneLod, frameClock } = deps;
  if (deps.mode === 'orbit') {
    void (async () => {
      // Start from a settled scene: the first pass then measures streaming
      // driven by the motion only.
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
    // Still views for visual A/B captures (script-test-bench/lidar-viewer-shots):
    // the script sets a pose, waits until the loop goes idle (the image has
    // reached its resting quality), then takes a screenshot.
    (window as unknown as { __rvLidarShots?: unknown }).__rvLidarShots = {
      extent,
      setPose: (pose: Partial<CameraPose>) => camera.setPose(pose),
      groundAt: (x: number, z: number) => sampleElevationAtProj(x + cx, cy - z, heightSceneParams),
      state: () => ({ rendering: deps.isRendering(), idle: sceneLod.isIdle(), stats: sceneLod.getStats() }),
    };
  }
}
