import HeightmapWorkerFn from './heightmap-worker?worker';
import type { HeightmapResult } from './heightmap-builder';

export function buildHeightmapAsync(
  positions: Float32Array,
  colors: Uint8Array,
  classifications: Uint8Array,
  count: number,
  resolution: number = 1.0,
): Promise<HeightmapResult> {
  return new Promise((resolve, reject) => {
    const worker = new HeightmapWorkerFn();
    worker.onmessage = (e: MessageEvent<{ result: HeightmapResult }>) => {
      resolve(e.data.result);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    worker.postMessage(
      { positions, colors, classifications, count, resolution },
      [positions.buffer, colors.buffer, classifications.buffer],
    );
  });
}
