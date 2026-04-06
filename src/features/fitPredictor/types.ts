export type FitPanelMode = 'route' | 'compare';

export type RiderType = 'elite' | 'trained' | 'recreational';

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
  headwind_ms?: number;
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
  rider_profile: RiderProfile;
  total_time_low_s?: number;
  total_time_high_s?: number;
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
      type: 'compare';
      fitFiles: ArrayBuffer[];
      validationFit: ArrayBuffer;
      config?: PredictionConfig;
    });

export type FitWorkerResponse =
  | (WorkerMessageBase & {
      type: 'progress';
      action: 'predict';
      message: string;
    })
  | (WorkerMessageBase & {
      type: 'result';
      action: 'predict';
      data: PredictionResult;
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