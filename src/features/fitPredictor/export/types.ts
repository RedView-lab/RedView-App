export interface CheckpointRow {
  /** Checkpoint label, e.g. 0, 20, 40 … or "Arrivée" */
  km: number;
  /** Cumulative distance from start in meters */
  distanceCumM: number;
  /** Cumulative riding time in seconds (pure ride time, excludes stops) */
  elapsedTimeS: number;
  /** Time for this section only (delta with previous checkpoint) in seconds */
  segmentTimeS: number;
  /** Average speed over this section in km/h */
  avgSpeedKmh: number;
  /** Elevation at checkpoint in meters */
  elevationM: number;
  /** Elevation gain over this section in meters */
  elevGainM: number;
  /** Elevation loss over this section in meters */
  elevLossM: number;
  /** Average gradient over this section in % */
  avgGradientPct: number;
  /** Average predicted power over this section in watts */
  avgPowerW: number;
}

export interface ExportConfig {
  /** Interval between checkpoints in km (default: 20) */
  intervalKm: number;
  /** Optional route name for the summary sheet */
  routeName?: string;
}
