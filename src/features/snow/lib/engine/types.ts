// ============================================================================
// Snow engine v2 — input / output types (pure data, worker- and Node-safe)
// ============================================================================

import type { SnowEngineConfig } from './config';

export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Scene DTM: a node grid spanning the scene bounds edge to edge
 * (x_i = minX + i·sizeX/(width − 1)); row 0 is the southern edge.
 */
export interface EngineDem {
  /** Absolute altitude, m. */
  data: Float32Array;
  width: number;
  height: number;
  /** Extent of the node grid, m (minX → maxX, minY → maxY). */
  sizeX: number;
  sizeY: number;
}

export interface SceneGeo {
  /** WGS84 of the four corner nodes: SW, SE, NE, NW. */
  corners: [LonLat, LonLat, LonLat, LonLat];
  /** True bearing (deg, clockwise from true north) of the grid +Y axis (meridian convergence). */
  gridNorthBearingDeg: number;
}

/** Coarse snow-depth field (AROME 0.01°, or a coarser global model as fallback). */
export interface CoarseSnowGrid {
  source: 'arome' | 'open-meteo';
  width: number;
  height: number;
  /** Cell centres: lon = lonMin + i·dLon, lat = latMin + j·dLat (row 0 = south). */
  lonMin: number;
  latMin: number;
  dLon: number;
  dLat: number;
  hsCm: Float32Array;
  /**
   * Model terrain height of each cell, m. AROME's snow is the snow of a flat
   * cell at that height: the elevation downscaling compares every pixel with
   * it. `null` when unknown (the scene DTM then stands in for the cells it covers).
   */
  orographyM: Float32Array | null;
  /** Nominal cell size, m. */
  resolutionM: number;
}

/** Coarse DEM around the scene (far field: horizons, outlying shelter, drift inflow). */
export interface FarDem {
  data: Float32Array;
  width: number;
  height: number;
  /** Position of node (0, 0) relative to the scene SW node, m (scene grid axes). */
  originX: number;
  originY: number;
  /** Node spacing, m. */
  cell: number;
}

/**
 * A measured snow depth.
 *  - `flat`: a flat-field station (Nivose, IMIS, climatological): representative
 *    of open flat terrain around it, assimilated into the large-scale field.
 *  - `point`: a measurement at that exact spot of the scene (probe, pit, survey):
 *    corrects the fine field around it.
 */
export interface SnowObservation {
  id: string;
  source: string;
  name?: string;
  lon: number;
  lat: number;
  elevationM: number | null;
  hsCm: number;
  /** ISO time of the measurement. */
  time?: string;
  kind: 'flat' | 'point';
  /** Measurement error, cm (defaults from the config). */
  errorCm?: number;
}

/** Météo-France avalanche bulletin (BRA) snow cover block for the massif. */
export interface BraSnowProfile {
  massif: string;
  date: string;
  /** Off-piste snow depth at a few altitudes, on north and south slopes. */
  levels: Array<{ altitudeM: number; northCm: number; southCm: number }>;
  /** Altitude of the continuous snow cover, north / south slopes, m. */
  limitNorthM: number | null;
  limitSouthM: number | null;
}

/** Hourly weather of the past weeks at the scene (model analyses/forecasts). */
export interface WeatherHistory {
  /** Unix ms of the first hour. */
  startMs: number;
  /** Altitude the temperature refers to, m. */
  elevationM: number;
  temperatureC: Float32Array;
  precipitationMm: Float32Array;
  snowfallCm: Float32Array;
  windSpeedMs: Float32Array;
  /** Direction the wind blows from, deg true. */
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
  /** Canopy cover 0–1 on a node grid over the scene bounds, `null` when the forest is unknown. */
  canopy: CanopyGrid | null;
  observations: SnowObservation[];
  bra: BraSnowProfile | null;
  weather: WeatherHistory | null;
  /** Validity time of the coarse field, Unix ms. */
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
  /** Large-scale field before assimilation at the station. */
  backgroundCm: number;
  /** Leave-one-out analysis at the station (what the other stations predict). */
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
    /** Gradient around the scene altitude, cm per 100 m. */
    gradientCmPer100m: number;
    /** Lowest altitude with snow on the profile, m. */
    snowlineM: number | null;
    orography: 'model' | 'scene-dtm';
  };
  assimilation: {
    stations: StationDiagnostic[];
    /** Correction of the large-scale field at the scene altitude, cm (stations + BRA). */
    profileCorrectionCm: number;
    /** Fitted precipitation factor k (HS = k·background(z + Δz)). */
    precipitationFactor: number;
    /** Fitted shift of the rain/snow limit, m (positive: the real snow line is higher than modelled). */
    snowlineShiftM: number;
    braUsed: boolean;
    pointsUsed: number;
  };
  wind: {
    source: 'history' | 'default';
    /** Transport-weighted rose, 16 sectors of 22.5° (direction the wind blows from, N first). */
    rose: number[];
    /** Transport amplitude actually applied, cm·m of flux on flat terrain. */
    fluxCmM: number;
    redistributedPct: number;
  };
  gravity: { movedPct: number };
  melt: {
    source: 'history' | 'season';
    /** Cumulative melt on flat terrain at the scene altitude, cm of snow. */
    flatMeltCm: number;
    radiationScale: number;
    braCalibrated: boolean;
  };
  forest: { meanCanopyPct: number | null };
  variability: {
    /** Helbig et al. (2015) σ(HS) of the scene, cm. */
    targetSigmaCm: number;
    modelSigmaCm: number;
  };
  timingsMs: Record<string, number>;
}

export interface SnowEngineResult {
  /** Snow depth (vertical), cm, on the work grid (node grid over the scene bounds, row 0 = south). */
  hsCm: Float32Array;
  width: number;
  height: number;
  stats: { meanCm: number; maxCm: number; coveragePct: number };
  diagnostics: SnowDiagnostics;
}

export type EngineProgress = (pct: number, label: string) => void;
