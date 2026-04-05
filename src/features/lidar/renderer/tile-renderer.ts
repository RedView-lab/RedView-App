import type { PointCloudBounds } from '../types/geometry';
import { createInstanceBuffer } from './buffers';

export interface TileGpuData {
  key: string;
  instanceBuffer: GPUBuffer;
  pointCount: number;
  bounds: PointCloudBounds;
}

export function uploadTile(
  device: GPUDevice,
  key: string,
  positions: Float32Array,
  colors: Uint8Array,
  normals: Float32Array,
  count: number,
  bounds: PointCloudBounds,
): TileGpuData {
  const instanceBuffer = createInstanceBuffer(device, positions, colors, normals, count);
  return { key, instanceBuffer, pointCount: count, bounds };
}

export function destroyTileGpu(tile: TileGpuData): void {
  tile.instanceBuffer.destroy();
}
