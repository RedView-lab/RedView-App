// ============================================================================
// Snow feature — public types
// ============================================================================

import type { DetectedCrs } from '../lidar/types';
import type { CanopyGrid, SnowDiagnostics, SnowObservation } from './lib/engine/types';

/** Affichage neige dans le viewer. */
export type SnowDisplayMode = 'off' | 'cover' | 'thickness';

/** Snow depth over a LiDAR scene. */
export interface SnowField {
  /** Snow depth (vertical), cm, row-major, row 0 = southern edge (node grid over the bounds). */
  data: Float32Array;
  width: number;
  height: number;
  /** Scene bounds in the LiDAR CRS, [minX, minY, maxX, maxY]. */
  boundsMeters: [number, number, number, number];
  stats: {
    /** Mean depth of the snow-covered nodes, cm. */
    meanCm: number;
    maxCm: number;
    coveragePct: number;
    elapsedMs: number;
  };
  /** Coarse snow field used (AROME, or a global model outside the AROME domain). */
  arome: {
    timestamp: string;
    runHour: string;
    source: string;
  };
  /** What the engine did and with which data (stations, bulletin, wind, melt…). */
  diagnostics: SnowDiagnostics;
  /** State of every data source (ok, empty, error, unavailable…). */
  sources: Record<string, string>;
}

/** Scene DTM handed to the pipeline (the LiDAR viewer's height grid). */
export interface SnowHeightmap {
  /** Heights relative to `altitudeOffsetM`, node grid spanning the bounds, row 0 = minY. */
  data: Float32Array;
  width: number;
  height: number;
  /** Bounds in the LiDAR CRS, m. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  crs: DetectedCrs;
  /** Absolute altitude = data + altitudeOffsetM (the viewer stores heights around the scene centre). */
  altitudeOffsetM: number;
  /** Canopy cover 0–1 on a node grid over the same bounds, when the point cloud tells it. */
  canopy?: CanopyGrid | null;
}

export type { CanopyGrid, SnowObservation };

/** Progression. */
export type SnowProgress = (pct: number, label: string) => void;
