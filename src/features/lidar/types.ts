/** Detected Coordinate Reference System */
export type DetectedCrs = 'LAMB93' | 'RGR92UTM40S';

/** Territory code for IGN tile naming */
export type Territory = 'FXX' | 'REU';

/** Altitude reference system */
export type AltitudeRef = 'IGN69' | 'IGN78' | 'REUN89';

/** Status of a LiDAR tile in the pipeline */
export type LidarTileStatus =
  | 'available'
  | 'downloading'
  | 'parsing'
  | 'colorizing'
  | 'rendering'
  | 'cached'
  | 'error';

/** LiDAR HD zone info from WFS discovery */
export interface ZoneInfo {
  name: string;
  bbox: { west: number; south: number; east: number; north: number };
  date: string;
}

/** 1km x 1km tile coordinate in Lambert93 km grid */
export interface TileCoord {
  xKm: number;
  yKm: number;
  territory: Territory;
  projection: DetectedCrs;
  altRef: AltitudeRef;
}

/** Bounding box of a point cloud in native CRS */
export interface PointCloudBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** Data returned from LAZ parsing (transferable buffers) */
export interface PointCloudData {
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  bounds: PointCloudBounds;
  crs: DetectedCrs;
}

/** Download progress event */
export interface DownloadProgress {
  tileCoord: TileCoord;
  bytesDownloaded: number;
  totalBytes: number;
  phase: LidarTileStatus;
  message?: string;
  percent?: number;
}

/** Stored tile metadata in OPFS */
export interface CachedTileInfo {
  coord: TileCoord;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
}

/** GPU buffer set for one loaded tile */
export interface GpuTileBuffers {
  coord: TileCoord;
  vertexBuffer: GPUBuffer;
  pointCount: number;
  bounds: PointCloudBounds;
  crs: DetectedCrs;
}

/** LiDAR manager event types */
export type LidarEventType = 'progress' | 'tileLoaded' | 'tileRemoved' | 'error';

export interface LidarEvent {
  type: LidarEventType;
  tileCoord?: TileCoord;
  progress?: DownloadProgress;
  error?: string;
}

export type LidarEventCallback = (event: LidarEvent) => void;
