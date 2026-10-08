/** Zones des systèmes de coordonnées planes rectangulaires JGD2011 (1 à 19) */
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

/** Système de référence de coordonnées détecté */
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

/** Code de territoire pour le nommage des tuiles IGN/Suisse/NZ/Japon */
export type Territory = 'FXX' | 'REU' | 'CH' | 'NZ' | 'JP' | 'NL' | 'BE';

/** Système de référence altimétrique */
export type AltitudeRef = 'IGN69' | 'IGN78' | 'REUN89' | 'LN02' | 'NZVD2016' | 'TP' | 'NAP' | 'TAW';

/** État d'une tuile LiDAR dans le pipeline */
type LidarTileStatus =
  | 'available'
  | 'downloading'
  | 'parsing'
  | 'colorizing'
  | 'rendering'
  | 'cached'
  | 'error';

/** Informations de zone LiDAR HD issues de la découverte WFS */
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

/** Coordonnée d'une tuile de 1 km x 1 km dans la grille kilométrique Lambert 93 */
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

/** Emprise d'un nuage de points dans son CRS natif */
export interface PointCloudBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * Origine locale (unités du CRS, float64) à laquelle `PointCloudData.positions`
 * sont relatives. Des ordonnées Lambert 93 absolues (~6,5e6 m) stockées en float32
 * sont quantifiées à 0,5 m ; relatives à une origine alignée sur le km, elles gardent ~0,1 mm.
 */
export interface PointCloudOrigin {
  x: number;
  y: number;
  z: number;
}

/**
 * Octree COPC d'une tuile décodée : `nodes` sont listés dans l'ordre où leurs
 * points apparaissent dans `PointCloudData.positions` (niveaux grossiers d'abord).
 */
export interface CopcHierarchyInfo {
  nodes: { key: string; pointCount: number }[];
  /** Cube absolu de l'octree [minX, minY, minZ, maxX, maxY, maxZ]. */
  cube: number[];
  /** Espacement des points du nœud racine (divisé par deux à chaque niveau). */
  spacing: number;
}

/** Données renvoyées par le parse LAZ (tampons transférables) */
export interface PointCloudData {
  /** XYZ relatifs à `origin` (jamais des coordonnées CRS absolues). */
  positions: Float32Array;
  colors: Uint8Array;
  classifications: Uint8Array;
  count: number;
  /** Emprise CRS absolue (float64). */
  bounds: PointCloudBounds;
  origin: PointCloudOrigin;
  crs: DetectedCrs;
  /** `colors` viennent du RVB du fichier lui-même (PDRF 7/8) ; la colorisation par orthophoto est sautée. */
  embeddedRgb?: boolean;
  /** Intensité LAS brute par point, quand elle est décodée. */
  intensities?: Uint16Array;
  /** Présent pour les fichiers COPC : permet au viewer d'utiliser l'octree du fichier comme LOD. */
  copc?: CopcHierarchyInfo;
}

/** Événement de progression du téléchargement */
export interface DownloadProgress {
  tileCoord: TileCoord;
  bytesDownloaded: number;
  totalBytes: number;
  phase: LidarTileStatus;
  message?: string;
  percent?: number;
}

/** Métadonnées d'une tuile stockée dans l'OPFS */
export interface CachedTileInfo {
  coord: TileCoord;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
}

/** Types d'événements du gestionnaire LiDAR */
type LidarEventType = 'progress' | 'tileLoaded' | 'tileRemoved' | 'error' | 'cancelled';

export interface LidarEvent {
  type: LidarEventType;
  tileCoord?: TileCoord;
  progress?: DownloadProgress;
  error?: string;
  message?: string;
}

export type LidarEventCallback = (event: LidarEvent) => void;
