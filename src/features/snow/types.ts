// ============================================================================
// Snow feature — Types
// ----------------------------------------------------------------------------
// Port web de la pipeline RedView v0.1 (crates/redview-scene/.../snow).
// Récupération AROME (Météo-France) via Open-Meteo + redistribution
// physique (López-Moreno, SnowSlide, D-inf, Winstral Sx, Liston-Elder).
// ============================================================================

import type { DetectedCrs } from '../lidar/types';

/** Affichage neige dans le viewer. */
export type SnowDisplayMode = 'off' | 'cover' | 'thickness';

/** Grille AROME brute (entrée de la pipeline). */
export interface AromeSnowGrid {
  /** Largeur (longitude). */
  width: number;
  /** Hauteur (latitude). */
  height: number;
  /** Épaisseur de neige en cm, row-major, sud→nord. */
  snowDepthCm: Float32Array;
  /** Bbox du CRS de travail (LiDAR), [minX, minY, maxX, maxY] en mètres. */
  boundsMeters: [number, number, number, number];
  /** Résolution AROME en mètres (≈ 1100 m). */
  resolutionM: number;
  /** Horodatage UTC du run AROME utilisé. */
  timestamp: string;
  /** Heure du run (ex: "00", "06"). */
  runHour: string;
  /** Source effective (debug). */
  source:
    | 'open-meteo-arome'
    | 'open-meteo-ecmwf'
    | 'open-meteo-best-match'
    | 'fallback';
}

/** Résultat de la redistribution. */
export interface SnowField {
  /** Profondeur de neige en cm, row-major. */
  data: Float32Array;
  width: number;
  height: number;
  /** Bbox dans le repère du LiDAR (Lambert93/UTM), [minX, minY, maxX, maxY]. */
  boundsMeters: [number, number, number, number];
  /** Statistiques globales. */
  stats: {
    meanCm: number;
    maxCm: number;
    coveragePct: number;
    elapsedMs: number;
  };
  /** Métadonnées AROME. */
  arome: {
    timestamp: string;
    runHour: string;
    source: string;
  };
}

/** Heightmap d'entrée pour la pipeline (vient du viewer LiDAR). */
export interface SnowHeightmap {
  data: Float32Array;
  width: number;
  height: number;
  /** Bbox monde en mètres (CRS du LiDAR : Lambert93 ou RGR92/UTM40S). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** CRS du LiDAR — sert à reconvertir vers WGS84 pour l'API AROME. */
  crs: DetectedCrs;
}

/** Progression. */
export type SnowProgress = (pct: number, label: string) => void;
