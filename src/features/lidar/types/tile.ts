import type { TileCoord, PointCloudBounds, DetectedCrs } from './geometry';

export type LidarTileStatus =
  | 'available'
  | 'downloading'
  | 'parsing'
  | 'colorizing'
  | 'computing-normals'
  | 'rendering'
  | 'cached'
  | 'error';

export interface PointCloudData {
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  bounds: PointCloudBounds;
  crs: DetectedCrs;
}

export interface CachedTileInfo {
  coord: TileCoord;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
}

export interface GpuTileBuffers {
  coord: TileCoord;
  vertexBuffer: GPUBuffer;
  pointCount: number;
  bounds: PointCloudBounds;
  crs: DetectedCrs;
}

export interface TerrainCache {
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  heightGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
}
