/** JGD2011 Plane Rectangular Coordinate System Zones (1 to 19) */
export type Jgd2011ZoneCrs =
  | 'JGD2011_ZONE_01'
  | 'JGD2011_ZONE_02'
  | 'JGD2011_ZONE_03'
  | 'JGD2011_ZONE_04'
  | 'JGD2011_ZONE_05'
  | 'JGD2011_ZONE_06'
  | 'JGD2011_ZONE_07'
  | 'JGD2011_ZONE_08'
  | 'JGD2011_ZONE_09'
  | 'JGD2011_ZONE_10'
  | 'JGD2011_ZONE_11'
  | 'JGD2011_ZONE_12'
  | 'JGD2011_ZONE_13'
  | 'JGD2011_ZONE_14'
  | 'JGD2011_ZONE_15'
  | 'JGD2011_ZONE_16'
  | 'JGD2011_ZONE_17'
  | 'JGD2011_ZONE_18'
  | 'JGD2011_ZONE_19';

/** Detected Coordinate Reference System */
export type DetectedCrs =
  | 'LAMB93'
  | 'RGR92UTM40S'
  | 'CH1903_LV95'
  | 'NZTM2000'
  | Jgd2011ZoneCrs;

/** Territory code for IGN/Swiss/NZ/Japan tile naming */
export type Territory = 'FXX' | 'REU' | 'CH' | 'NZ' | 'JP';

/** Altitude reference system */
export type AltitudeRef = 'IGN69' | 'IGN78' | 'REUN89' | 'LN02' | 'NZVD2016' | 'TP';

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

/** GPU buffer set for one loaded tile (typed loosely to avoid WebGPU dep in shared types) */
export interface GpuTileBuffers {
  coord: TileCoord;
  vertexBuffer: unknown;
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
  message?: string;
}

export type LidarEventCallback = (event: LidarEvent) => void;
