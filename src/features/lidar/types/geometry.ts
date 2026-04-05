export type DetectedCrs = 'LAMB93' | 'RGR92UTM40S';

export type Territory = 'FXX' | 'REU';

export type AltitudeRef = 'IGN69' | 'IGN78' | 'REUN89';

export interface TileCoord {
  xKm: number;
  yKm: number;
  territory: Territory;
  projection: DetectedCrs;
  altRef: AltitudeRef;
}

export interface PointCloudBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface ZoneInfo {
  name: string;
  bbox: { west: number; south: number; east: number; north: number };
  date: string;
}
