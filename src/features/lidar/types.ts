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
  /** Pays-Bas : Amersfoort / RD New (EPSG:28992), altitudes NAP. */
  | 'RD_NEW'
  /** Belgique : Belge 1972 / Belgian Lambert 72 (EPSG:31370), altitudes TAW/DNG. */
  | 'BL72'
  | Jgd2011ZoneCrs;

/** Territory code for IGN/Swiss/NZ/Japan tile naming */
export type Territory = 'FXX' | 'REU' | 'CH' | 'NZ' | 'JP' | 'NL' | 'BE';

/** Altitude reference system */
export type AltitudeRef = 'IGN69' | 'IGN78' | 'REUN89' | 'LN02' | 'NZVD2016' | 'TP' | 'NAP' | 'TAW';

/** Status of a LiDAR tile in the pipeline */
type LidarTileStatus =
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

/** Emprise d'un fichier source, en mètres du SCR de la dalle. */
export interface TileFootprint {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 1km x 1km tile coordinate in Lambert93 km grid */
export interface TileCoord {
  xKm: number;
  yKm: number;
  territory: Territory;
  projection: DetectedCrs;
  altRef: AltitudeRef;
  /**
   * Japon / NZ / Pays-Bas / Flandre : la dalle est un fichier précis de
   * l'index (sous-feuille de grille, emprise propre, sous-dalle AHN de
   * 1 × 1,25 km, cellule DHMV de 500 m), identifié par son emprise ;
   * `xKm`/`yKm` sont alors le km de son centre. Absent : la dalle de 1 km,
   * servie par le meilleur fichier sous son centre.
   */
  footprint?: TileFootprint;
}

/** Bounding box of a point cloud in native CRS */
export interface PointCloudBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * Local origin (CRS units, float64) that `PointCloudData.positions` are
 * relative to. Absolute Lambert-93 northings (~6.5e6 m) stored as float32 are
 * quantised to 0.5 m; relative to a km-aligned origin they keep ~0.1 mm.
 */
export interface PointCloudOrigin {
  x: number;
  y: number;
  z: number;
}

/**
 * COPC octree of a decoded tile: `nodes` are listed in the order their points
 * appear in `PointCloudData.positions` (coarse levels first).
 */
export interface CopcHierarchyInfo {
  nodes: { key: string; pointCount: number }[];
  /** Absolute octree cube [minX, minY, minZ, maxX, maxY, maxZ]. */
  cube: number[];
  /** Point spacing of the root node (halves at each level). */
  spacing: number;
}

/** Data returned from LAZ parsing (transferable buffers) */
export interface PointCloudData {
  /** XYZ relative to `origin` (never absolute CRS coordinates). */
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  /** Absolute CRS bounds (float64). */
  bounds: PointCloudBounds;
  origin: PointCloudOrigin;
  crs: DetectedCrs;
  /** `colors` come from the file's own RGB (PDRF 7/8); orthophoto colourisation is skipped. */
  embeddedRgb?: boolean;
  /** Raw LAS intensity per point, when decoded. */
  intensities?: Uint16Array;
  /** Present for COPC files: lets the viewer use the file's own octree as LOD. */
  copc?: CopcHierarchyInfo;
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

/** LiDAR manager event types */
type LidarEventType = 'progress' | 'tileLoaded' | 'tileRemoved' | 'error' | 'cancelled';

export interface LidarEvent {
  type: LidarEventType;
  tileCoord?: TileCoord;
  progress?: DownloadProgress;
  error?: string;
  message?: string;
}

export type LidarEventCallback = (event: LidarEvent) => void;
