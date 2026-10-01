import type { FootDiscipline, SportDiscipline } from '@/shared/lib/discipline';

export type FitPanelMode = 'route' | 'compare';

export type RiderType = 'elite' | 'trained' | 'recreational';

export type Gender = 'male' | 'female' | 'unspecified';

export interface PredictionConfig {
  ftp_w?: number;
  rider_weight_kg?: number;
  bike_weight_kg?: number;
  mass_kg?: number;
  cda?: number;
  crr?: number;
  pacing_factor?: number;
  race_mode?: boolean;
  smoothing_window_m?: number;
  max_route_points?: number;
  fatigue_floor?: number;
  fatigue_lambda?: number;
  start_time_h?: number;
  rider_type?: RiderType;
  target_duration_h?: number;
  surface_types?: number[];
  ambient_temperature_c?: number;
  stop_strategy?: 'auto' | 'none' | 'ultra';
  sleep_strategy?: 'none' | 'sleep_stops' | 'micro_naps';
  gender?: Gender;
}

/** Config of the running / trail-running engine (`predict_run`). */
export interface RunPredictionConfig {
  discipline: FootDiscipline;
  /** Practice level id: debutant | intermediaire | avance | expert. */
  level?: string;
  vma_kmh?: number;
  ref_distance_m?: number;
  ref_time_s?: number;
  /** Runner weight including pack (kg). */
  mass_kg?: number;
  /** Terrain technicality 0..1 (trail only). */
  technicality?: number;
  start_time_h?: number;
  gender?: Gender;
  max_route_points?: number;
}

/** Runner parameters resolved by the running engine. */
export interface RunnerProfile {
  v_ref_kmh: number;
  v_ref_source: 'fit' | 'chrono' | 'vma' | 'level';
  riegel_k: number;
  walk_threshold_pct: number;
  walk_vam_mh: number;
  descent_ratio: number;
  descent_skill: number;
  technicality: number;
  n_activities: number;
  n_ignored: number;
  knn_samples: number;
}

export interface RiderProfile {
  ftp_w: number;
  mass_kg: number;
  rider_weight_kg: number;
  bike_weight_kg: number;
  wkg: number;
  cda: number;
  crr: number;
  has_power: boolean;
}

export interface PredictionPoint {
  distance_m: number;
  elevation_m: number;
  gradient_pct: number;
  predicted_speed_kmh: number;
  predicted_power_w: number;
  elapsed_time_s: number;
  segment_time_s: number;
  fatigue_factor?: number;
  circadian_factor?: number;
  distance_eff_factor?: number;
  knn_confidence?: number;
  predicted_speed_low_kmh?: number;
  predicted_speed_high_kmh?: number;
}

export interface SegmentSummary {
  start_distance_m: number;
  end_distance_m: number;
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  avg_gradient_pct: number;
  avg_speed_kmh: number;
  time_s: number;
  segment_type: string;
  vam_mh?: number;
}

export interface PredictionResult {
  total_time_s: number;
  riding_time_s: number;
  stop_time_s: number;
  total_distance_m: number;
  avg_speed_kmh: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  segments: SegmentSummary[];
  points: PredictionPoint[];
  /** Cycling engine only. */
  rider_profile?: RiderProfile;
  /** Running engine only. */
  runner_profile?: RunnerProfile;
  /** Engine that produced the result; absent on (older) cycling predictions. */
  discipline?: SportDiscipline;
  total_time_low_s?: number;
  total_time_high_s?: number;
  /** Moteur vélo v2 : version (absente = ancien moteur, à recalculer). */
  engine_version?: number;
  model?: CyclingRiderModel;
  model_speeds?: CyclingSpeedTable;
  time_breakdown?: CyclingTimeBreakdown;
  warnings?: string[];
  /** Rapport de calibration .fit (profil personnalisé avec sorties). */
  calibration?: CyclingCalibrationReport;
}

// ── Moteur vélo v2 ──────────────────────────────────────────────────────────

export type CyclingGender = 'male' | 'female' | 'unspecified';

/** Paramètres d'un cycliste (vendor/redviewalgo/src/cycling/rider.rs). */
export interface CyclingRiderModel {
  mass_kg: number;
  rider_weight_kg: number;
  cda: number;
  crr: number;
  drivetrain_eff: number;
  p_flat_w: number;
  climb_ratio: number;
  climb_sat_pct: number;
  free_pct: number;
  desc_v1_kmh: number;
  desc_k_kmh_per_pct: number;
  desc_vmax_kmh: number;
  desc_steep_from_pct: number;
  desc_steep_drop_kmh_per_pct: number;
  a_lat_ms2: number;
  a_dec_ms2: number;
  walk_up_pct: number;
  v_min_ride_kmh: number;
  warmup_amp: number;
  endurance_amp: number;
  ftp_w: number;
  has_power: boolean;
  source: string;
}

export type CyclingRiderSpec =
  | { preset: { level: string; gender: CyclingGender } }
  | { model: CyclingRiderModel }
  | { custom: { level?: string; gender: CyclingGender; ftp_w?: number; mass_kg?: number; tires_mm?: number } };

/** Config du moteur vélo v2 : temps de déplacement seul, sans pauses. */
export interface CyclingConfig {
  rider?: CyclingRiderSpec;
  rider_override?: Partial<CyclingRiderModel>;
  ambient_temperature_c?: number;
  /** `planned` (BRouter), `gps` (trace enregistrée), `auto` (GPX importé). */
  geometry?: 'planned' | 'gps' | 'auto';
  /** Demi-largeur relative de la fourchette de temps. */
  uncertainty?: number;
  model_params?: Record<string, unknown>;
  output?: { diagnostics?: boolean };
}

/**
 * Tracé passé au moteur v2 (tableaux alignés) ; `surface` / `way` codés comme
 * dans route-metrics/engineCodes.ts, vides = inconnus.
 */
export interface CyclingRouteInput {
  lat: Float64Array;
  lon: Float64Array;
  ele: Float64Array;
  dist: Float64Array;
  surface: Uint8Array;
  way: Uint8Array;
  headwind: Float64Array;
}

export interface CyclingSpeedTable {
  grades_pct: number[];
  surfaces: string[];
  kmh: number[][];
  walking: boolean[][];
}

export interface CyclingTimeBreakdown {
  climb_s: number;
  flat_s: number;
  descent_s: number;
  walk_s: number;
  walk_m: number;
  by_limit: Record<string, number>;
  corner_loss_s?: number;
  way_loss_s?: number;
  physio_loss_s?: number;
}

export interface CyclingCalibrationRide {
  index: number;
  distance_km: number;
  moving_h: number;
  predicted_h: number;
  error_pct: number;
  loo_error_pct: number | null;
}

export interface CyclingCalibrationReport {
  n_rides: number;
  n_ignored: number;
  total_km: number;
  total_moving_h: number;
  longest_h: number;
  climb_km: number;
  flat_km: number;
  descent_km: number;
  rides: CyclingCalibrationRide[];
  loo_median_abs_pct: number | null;
  loo_max_abs_pct: number | null;
  in_sample_median_abs_pct: number;
  expected_accuracy_pct: number;
  grade_table: { label: string; km: number; real_kmh: number; model_kmh: number }[];
  multipliers: [number, number, number];
  a_lat_measured: number | null;
  a_lat_samples: number;
  warnings: string[];
}

export interface CyclingCalibration {
  engine_version: number;
  model: CyclingRiderModel;
  report: CyclingCalibrationReport;
}

export interface ActualSpeedPoint {
  distance_m: number;
  speed_kmh: number;
  elapsed_time_s: number;
  elevation_m: number;
}

export interface ComparisonResult {
  prediction: PredictionResult;
  actual_points: ActualSpeedPoint[];
  actual_total_time_s: number;
  actual_riding_time_s: number;
  actual_avg_speed_kmh: number;
  actual_distance_m: number;
}

interface WorkerMessageBase {
  _id: number;
}

export type FitWorkerRequest =
  | (WorkerMessageBase & {
      type: 'predict';
      fitFiles: ArrayBuffer[];
      gpxData: ArrayBuffer;
      config?: PredictionConfig;
    })
  | (WorkerMessageBase & {
      type: 'predictRun';
      fitFiles: ArrayBuffer[];
      gpxData: ArrayBuffer;
      config: RunPredictionConfig;
    })
  | (WorkerMessageBase & {
      type: 'compare';
      fitFiles: ArrayBuffer[];
      validationFit: ArrayBuffer;
      config?: PredictionConfig;
    })
  | (WorkerMessageBase & {
      type: 'calibrateCycling';
      fitFiles: ArrayBuffer[];
      config: CyclingConfig;
    })
  | (WorkerMessageBase & {
      type: 'predictCycling';
      route: CyclingRouteInput;
      config: CyclingConfig;
    });

export type FitWorkerResponse =
  | (WorkerMessageBase & {
      type: 'progress';
      action: 'predict' | 'predictRun' | 'calibrateCycling';
      message: string;
    })
  | (WorkerMessageBase & {
      type: 'result';
      action: 'predict' | 'predictRun' | 'predictCycling';
      data: PredictionResult;
    })
  | (WorkerMessageBase & {
      type: 'result';
      action: 'calibrateCycling';
      data: CyclingCalibration;
    })
  | (WorkerMessageBase & {
      type: 'result';
      action: 'compare';
      data: ComparisonResult;
    })
  | (WorkerMessageBase & {
      type: 'error';
      message: string;
    });