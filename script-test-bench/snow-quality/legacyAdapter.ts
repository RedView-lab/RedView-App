// Runs the frozen v1 engine on a synthetic world (same scene grid, same AROME cells).

import { computeSnowRedistribution } from './legacy/redistribute';
import { DEFAULT_SNOW_CONFIG } from './legacy/config';
import type { World } from './world';

export function runLegacy(world: World): Float32Array {
  const out = computeSnowRedistribution({
    aromeData: world.legacy.aromeData,
    aromeW: world.legacy.aromeW,
    aromeH: world.legacy.aromeH,
    aromeBounds: world.legacy.aromeBounds,
    heightmap: world.sceneZ,
    terrainW: world.sceneW,
    terrainH: world.sceneH,
    terrainOrigin: [0, 0],
    terrainSize: [world.input.dem.sizeX, world.input.dem.sizeY],
    config: { ...DEFAULT_SNOW_CONFIG, maxResolution: world.sceneW },
  });
  if (out.width !== world.sceneW || out.height !== world.sceneH) {
    throw new Error(`legacy grid ${out.width}×${out.height} ≠ scene ${world.sceneW}×${world.sceneH}`);
  }
  return out.data;
}
