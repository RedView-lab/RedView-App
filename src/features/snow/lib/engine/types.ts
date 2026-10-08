// ============================================================================
// Moteur neige v2 — types d'entrée / de sortie (données pures, sûres pour un worker et pour Node)
// ============================================================================

import type { SnowEngineConfig } from './config';

export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * MNT de la scène : une grille de nœuds qui couvre l'emprise de la scène d'un bord
 * à l'autre (x_i = minX + i·sizeX/(width − 1)) ; la ligne 0 est le bord sud.
 */
export interface EngineDem {
  /** Altitude absolue, m. */
  data: Float32Array;
  width: number;
  height: number;
  /** Étendue de la grille de nœuds, m (minX → maxX, minY → maxY). */
  sizeX: number;
  sizeY: number;
}

export interface SceneGeo {
  /** WGS84 of the four corner nodes: SW, SE, NE, NW. */
  corners: [LonLat, LonLat, LonLat, LonLat];
  /** Gisement vrai (degrés, sens horaire depuis le nord vrai) de l'axe +Y de la grille (convergence des méridiens). */
  gridNorthBearingDeg: number;
}

/** Champ grossier de hauteur de neige (AROME 0,01°, ou un modèle mondial plus grossier en repli). */
export interface CoarseSnowGrid {
  source: 'arome' | 'open-meteo';
  width: number;
  height: number;
  /** Centres des cellules : lon = lonMin + i·dLon, lat = latMin + j·dLat (ligne 0 = sud). */
  lonMin: number;
  latMin: number;
  dLon: number;
  dLat: number;
  hsCm: Float32Array;
  /**
   * Hauteur du terrain du modèle pour chaque cellule, m. La neige d'AROME est
   * celle d'une cellule plate à cette hauteur : la descente en échelle selon
   * l'altitude compare chaque pixel à elle. `null` quand elle est inconnue (le MNT
   * de la scène remplace alors les cellules qu'il couvre).
   */
  orographyM: Float32Array | null;
  /** Taille nominale d'une cellule, m. */
  resolutionM: number;
}

/** DEM grossier autour de la scène (lointain : horizons, abri éloigné, apport de neige soufflée). */
export interface FarDem {
  data: Float32Array;
  width: number;
  height: number;
  /** Position du nœud (0, 0) par rapport au nœud SO de la scène, m (axes de la grille de la scène). */
  originX: number;
  originY: number;
  /** Pas entre nœuds, m. */
  cell: number;
}

/**
 * Une hauteur de neige mesurée.
 *  - `flat` : une station de terrain plat (Nivose, IMIS, climatologique) :
 *    représentative du terrain plat dégagé alentour, assimilée dans le champ
 *    grande échelle.
 *  - `point` : une mesure à cet endroit précis de la scène (sondage, profil,
 *    relevé) : corrige le champ fin alentour.
 */
export interface SnowObservation {
  id: string;
  source: string;
  name?: string;
  lon: number;
  lat: number;
  elevationM: number | null;
  hsCm: number;
  /** Heure ISO de la mesure. */
  time?: string;
  kind: 'flat' | 'point';
  /** Erreur de mesure, cm (valeurs par défaut de la config). */
  errorCm?: number;
}

/** Météo-France avalanche bulletin (BRA) snow cover block for the massif. */
export interface BraSnowProfile {
  massif: string;
  date: string;
  /** Hauteur de neige hors piste à quelques altitudes, sur les versants nord et sud. */
  levels: Array<{ altitudeM: number; northCm: number; southCm: number }>;
  /** Altitude de l'enneigement continu, versants nord / sud, m. */
  limitNorthM: number | null;
  limitSouthM: number | null;
}

/** Météo horaire des dernières semaines sur la scène (analyses / prévisions de modèle). */
export interface WeatherHistory {
  /** ms Unix de la première heure. */
  startMs: number;
  /** Altitude à laquelle se rapporte la température, m. */
  elevationM: number;
  temperatureC: Float32Array;
  precipitationMm: Float32Array;
  snowfallCm: Float32Array;
  windSpeedMs: Float32Array;
  /** Direction d'où souffle le vent, degrés vrais. */
  windDirDeg: Float32Array;
}

export interface CanopyGrid {
  data: Float32Array;
  width: number;
  height: number;
}

export interface SnowEngineInput {
  dem: EngineDem;
  geo: SceneGeo;
  coarse: CoarseSnowGrid;
  farDem: FarDem | null;
  /** Couvert de la canopée 0–1 sur une grille de nœuds couvrant l'emprise de la scène, `null` quand la forêt est inconnue. */
  canopy: CanopyGrid | null;
  observations: SnowObservation[];
  bra: BraSnowProfile | null;
  weather: WeatherHistory | null;
  /** Heure de validité du champ grossier, ms Unix. */
  analysisTimeMs: number;
  config: SnowEngineConfig;
}

export interface StationDiagnostic {
  id: string;
  source: string;
  name?: string;
  elevationM: number;
  distanceKm: number;
  observedCm: number;
  /** Champ grande échelle avant assimilation à la station. */
  backgroundCm: number;
  /** Analyse par validation croisée à la station (ce que prédisent les autres stations). */
  looAnalysisCm: number;
  used: boolean;
  rejectedReason?: string;
}

export interface SnowDiagnostics {
  workGrid: { width: number; height: number; pixelM: number };
  coarseSource: CoarseSnowGrid['source'];
  profile: {
    altitudesM: number[];
    hsCm: number[];
    cellsUsed: number;
    /** Gradient autour de l'altitude de la scène, cm par 100 m. */
    gradientCmPer100m: number;
    /** Altitude la plus basse enneigée sur le profil, m. */
    snowlineM: number | null;
    orography: 'model' | 'scene-dtm';
  };
  assimilation: {
    stations: StationDiagnostic[];
    /** Correction du champ grande échelle à l'altitude de la scène, cm (stations + BRA). */
    profileCorrectionCm: number;
    /** Facteur de précipitation ajusté k (HS = k·ébauche(z + Δz)). */
    precipitationFactor: number;
    /** Décalage ajusté de la limite pluie / neige, m (positif : la vraie limite de la neige est plus haute que modélisée). */
    snowlineShiftM: number;
    braUsed: boolean;
    pointsUsed: number;
  };
  wind: {
    source: 'history' | 'default';
    /** Rose pondérée par le transport, 16 secteurs de 22,5° (direction d'où souffle le vent, N d'abord). */
    rose: number[];
    /** Amplitude de transport réellement appliquée, cm·m de flux en terrain plat. */
    fluxCmM: number;
    redistributedPct: number;
  };
  gravity: { movedPct: number };
  melt: {
    source: 'history' | 'season';
    /** Fonte cumulée en terrain plat à l'altitude de la scène, cm de neige. */
    flatMeltCm: number;
    radiationScale: number;
    braCalibrated: boolean;
  };
  forest: { meanCanopyPct: number | null };
  variability: {
    /** σ(HS) de la scène selon Helbig et al. (2015), cm. */
    targetSigmaCm: number;
    modelSigmaCm: number;
  };
  timingsMs: Record<string, number>;
}

export interface SnowEngineResult {
  /** Hauteur de neige (verticale), cm, sur la grille de travail (grille de nœuds couvrant l'emprise de la scène, ligne 0 = sud). */
  hsCm: Float32Array;
  width: number;
  height: number;
  stats: { meanCm: number; maxCm: number; coveragePct: number };
  diagnostics: SnowDiagnostics;
}

export type EngineProgress = (pct: number, label: string) => void;
