// ============================================================================
// Fonction neige — types publics
// ============================================================================

import type { DetectedCrs } from '../lidar/types';
import type { CanopyGrid, SnowDiagnostics, SnowObservation } from './lib/engine/types';

/** Affichage neige dans le viewer. */
export type SnowDisplayMode = 'off' | 'cover' | 'thickness';

/** Hauteur de neige sur une scène LiDAR. */
export interface SnowField {
  /** Hauteur de neige (verticale), cm, ligne par ligne, ligne 0 = bord sud (grille de nœuds couvrant l'emprise). */
  data: Float32Array;
  width: number;
  height: number;
  /** Emprise de la scène dans le CRS du LiDAR, [minX, minY, maxX, maxY]. */
  boundsMeters: [number, number, number, number];
  stats: {
    /** Hauteur moyenne des nœuds enneigés, cm. */
    meanCm: number;
    maxCm: number;
    coveragePct: number;
    elapsedMs: number;
  };
  /** Champ de neige grossier utilisé (AROME, ou un modèle mondial hors du domaine AROME). */
  arome: {
    timestamp: string;
    runHour: string;
    source: string;
  };
  /** Ce qu'a fait le moteur et avec quelles données (stations, bulletin, vent, fonte…). */
  diagnostics: SnowDiagnostics;
  /** État de chaque source de données (ok, vide, erreur, indisponible…). */
  sources: Record<string, string>;
}

/** MNT de la scène confié au pipeline (la grille de hauteurs du visualiseur LiDAR). */
export interface SnowHeightmap {
  /** Hauteurs relatives à `altitudeOffsetM`, grille de nœuds couvrant l'emprise, ligne 0 = minY. */
  data: Float32Array;
  width: number;
  height: number;
  /** Emprise dans le CRS du LiDAR, m. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  crs: DetectedCrs;
  /** Altitude absolue = donnée + altitudeOffsetM (le visualiseur stocke les hauteurs autour du centre de la scène). */
  altitudeOffsetM: number;
  /** Couvert de la canopée 0–1 sur une grille de nœuds de même emprise, quand le nuage de points le donne. */
  canopy?: CanopyGrid | null;
}

export type { CanopyGrid, SnowObservation };

/** Progression. */
export type SnowProgress = (pct: number, label: string) => void;
