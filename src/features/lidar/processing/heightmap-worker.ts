import { buildHeightmap } from './heightmap-builder';
import type { HeightmapResult } from './heightmap-builder';

export type HeightmapWorkerInput = {
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  resolution: number;
};

self.onmessage = (e: MessageEvent<HeightmapWorkerInput>) => {
  const { positions, colors, classifications, count, resolution } = e.data;
  const result = buildHeightmap(positions, colors, classifications, count, resolution);
  (self as unknown as Worker).postMessage(
    { result } as { result: HeightmapResult },
    [result.vertices.buffer, result.colors.buffer, result.indices.buffer, result.heightGrid.buffer],
  );
};
