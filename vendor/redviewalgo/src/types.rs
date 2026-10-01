use serde::{Deserialize, Serialize};

// ─── Gender / sex (physiological model) ──────────────────────────────────────

/// Genre du cycliste / coureur : choisit le gabarit des préréglages
/// (masse, puissance absolue, traînée), jamais un coefficient de vitesse.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Gender {
    Male,
    Female,
    /// Non précisé : gabarit masculin moyen.
    Unspecified,
}

impl Default for Gender {
    fn default() -> Self {
        Gender::Unspecified
    }
}

// ─── Surface type (from OpenStreetMap data) ─────────────────────────────────

/// Surface type detected from OSM data.
/// Affects rolling resistance (Crr) and speed penalty.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceType {
    /// Paved road (asphalt, concrete, paving_stones)
    Road,
    /// Unpaved surface (gravel, dirt, grass, sand, compacted)
    Gravel,
    /// Unknown — no OSM data available, use conservative defaults
    Unknown,
}

impl Default for SurfaceType {
    fn default() -> Self {
        SurfaceType::Unknown
    }
}

// ─── Stop / sleep strategy for ultra-distance races ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StopStrategy {
    /// No stops predicted (legacy behaviour)
    None,
    /// Auto-detect based on route distance (>200km → Ultra)
    Auto,
    /// Ultra-distance: micro-stops + food stops + optional sleep stops
    Ultra,
    /// Custom: caller provides exact stop cadence
    Custom {
        /// Minutes of stop per riding hour
        stop_min_per_hour: f64,
    },
}

impl Default for StopStrategy {
    fn default() -> Self {
        StopStrategy::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SleepStrategy {
    /// No sleep modelling
    None,
    /// Rider takes micro-naps (10-20 min) — mild circadian compounding
    MicroNaps,
    /// Rider takes scheduled sleep stops (60-90 min) — moderate recovery
    SleepStops,
}

impl Default for SleepStrategy {
    fn default() -> Self {
        SleepStrategy::None
    }
}

// ─── Raw data point from a FIT file ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataPoint {
    /// Seconds since activity start
    pub timestamp_s: f64,
    pub lat: f64,
    pub lon: f64,
    /// Metres
    pub altitude_m: f64,
    /// m/s
    pub speed_ms: f64,
    /// Watts (0 if no power meter)
    pub power_w: f64,
    /// RPM
    pub cadence_rpm: f64,
    /// BPM
    pub heart_rate_bpm: f64,
    /// Celsius
    pub temperature_c: f64,
    /// Cumulative distance in metres from activity start
    pub distance_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySummary {
    pub duration_s: f64,
    pub distance_m: f64,
    pub elevation_gain_m: f64,
    pub avg_speed_ms: f64,
    pub avg_power_w: f64,
    pub avg_hr_bpm: f64,
    pub has_power: bool,
    pub has_hr: bool,
    /// FIT `sport` enum from the Session/Sport message, when recorded
    /// (1 running, 2 cycling, 11 walking, 17 hiking — see FIT_SPORT_*).
    #[serde(default)]
    pub sport: Option<u8>,
}

/// FIT profile `sport` codes used to route activities to the right engine.
pub const FIT_SPORT_RUNNING: u8 = 1;
pub const FIT_SPORT_CYCLING: u8 = 2;
pub const FIT_SPORT_WALKING: u8 = 11;
pub const FIT_SPORT_HIKING: u8 = 17;

impl ActivitySummary {
    /// On-foot activity (running, walking, hiking).
    pub fn is_foot_sport(&self) -> bool {
        matches!(
            self.sport,
            Some(FIT_SPORT_RUNNING) | Some(FIT_SPORT_WALKING) | Some(FIT_SPORT_HIKING)
        )
    }

    pub fn is_cycling_sport(&self) -> bool {
        self.sport == Some(FIT_SPORT_CYCLING)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityData {
    pub points: Vec<DataPoint>,
    pub summary: ActivitySummary,
}

// ─── GPX route ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutePoint {
    pub lat: f64,
    pub lon: f64,
    /// Smoothed elevation (metres)
    pub elevation_m: f64,
    /// Cumulative distance from route start (metres)
    pub distance_m: f64,
    /// Gradient to next point (%)
    pub gradient_pct: f64,
    /// Segment length to next point (metres)
    pub segment_length_m: f64,
    /// Road curvature density (degrees of heading change per km).
    /// Higher = more technical/twisty. 0 = straight road.
    pub curvature_deg_per_km: f64,
    /// Surface type from OSM (road, gravel, unknown).
    /// Affects rolling resistance and speed penalty.
    #[serde(default)]
    pub surface_type: SurfaceType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub points: Vec<RoutePoint>,
    pub total_distance_m: f64,
    pub total_elevation_gain_m: f64,
    pub total_elevation_loss_m: f64,
}

// ─── Prediction output ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionPoint {
    /// Cumulative distance (m)
    pub distance_m: f64,
    /// Elevation at this point (m)
    pub elevation_m: f64,
    /// Local gradient (%)
    pub gradient_pct: f64,
    /// Predicted speed (km/h)
    pub predicted_speed_kmh: f64,
    /// Predicted power output (W) — 0 if no power model
    pub predicted_power_w: f64,
    /// Elapsed time from start (s)
    pub elapsed_time_s: f64,
    /// Time for this segment only (s)
    pub segment_time_s: f64,
    /// Fatigue factor at this point [0-1]
    #[serde(default)]
    pub fatigue_factor: f64,
    /// Circadian rhythm factor [0-1]
    #[serde(default)]
    pub circadian_factor: f64,
    /// Distance efficiency factor [0-1]
    #[serde(default)]
    pub distance_eff_factor: f64,
    /// KNN confidence at this point [0-1]
    #[serde(default)]
    pub knn_confidence: f64,
    /// Predicted speed lower bound (km/h) — 90% confidence interval
    #[serde(default)]
    pub predicted_speed_low_kmh: f64,
    /// Predicted speed upper bound (km/h) — 90% confidence interval
    #[serde(default)]
    pub predicted_speed_high_kmh: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentSummary {
    pub start_distance_m: f64,
    pub end_distance_m: f64,
    pub distance_m: f64,
    pub elevation_gain_m: f64,
    pub elevation_loss_m: f64,
    pub avg_gradient_pct: f64,
    pub avg_speed_kmh: f64,
    pub time_s: f64,
    pub segment_type: String, // "climb", "descent", "flat"
    /// VAM (Velocità Ascensionale Media) in m/h — only meaningful for climb segments
    #[serde(default)]
    pub vam_mh: f64,
}

// ─── Config from JS ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionConfig {
    /// Override FTP in watts. When provided, takes priority over auto-estimated FTP.
    /// Must be the rider's known FTP (from lab test, Zwift, TrainingPeaks, etc.).
    #[serde(default)]
    pub ftp_w: Option<f64>,
    /// Rider body weight only (kg). Used with bike_weight_kg to compute total mass
    /// and W/kg ratio. Takes priority over mass_kg.
    #[serde(default)]
    pub rider_weight_kg: Option<f64>,
    /// Bike + bags + equipment weight (kg). Combined with rider_weight_kg.
    /// Default: 10kg if rider_weight_kg is provided but this is missing.
    #[serde(default)]
    pub bike_weight_kg: Option<f64>,
    /// Override rider+bike+equipment mass (kg). If None, auto-estimated.
    /// LEGACY: prefer rider_weight_kg + bike_weight_kg for accurate W/kg.
    #[serde(default)]
    pub mass_kg: Option<f64>,
    /// Override CdA (m²). If None, auto-estimated or default.
    #[serde(default)]
    pub cda: Option<f64>,
    /// Override Crr. If None, default 0.005.
    #[serde(default)]
    pub crr: Option<f64>,
    /// Pacing strategy factor (0.8 = conservative, 1.0 = normal, 1.1 = aggressive)
    #[serde(default = "default_pacing")]
    pub pacing_factor: f64,
    /// Race mode: use upper percentile of speed bins instead of median
    #[serde(default)]
    pub race_mode: bool,
    /// Smoothing window distance in metres (default: 50). Larger = smoother elevation profile.
    #[serde(default)]
    pub smoothing_window_m: Option<f64>,
    /// Maximum route points after downsampling (default: 15000).
    /// Lower = faster but less resolution. Set to 0 to disable downsampling.
    #[serde(default)]
    pub max_route_points: Option<usize>,
    /// Override fatigue floor (0.0-1.0). Lower = more fatigue for ultra events.
    #[serde(default)]
    pub fatigue_floor: Option<f64>,
    /// Override fatigue decay lambda. Higher = faster fatigue onset.
    #[serde(default)]
    pub fatigue_lambda: Option<f64>,
    /// Stop time per hour of riding (seconds). Default auto-estimated based on event duration.
    /// Typical: 180-300s/h (3-5 min/h) for ultra events. Set to 0 to disable.
    /// DEPRECATED: Stop time is no longer computed. Kept for backward config compat.
    #[serde(default)]
    pub stop_time_per_hour_s: Option<f64>,
    /// Drivetrain efficiency (0.90-1.0). Default: 0.97. Reduces effective power
    /// reaching the rear wheel. Lower for older/dirtier drivetrains.
    #[serde(default)]
    pub drivetrain_efficiency: Option<f64>,
    /// Race aggressiveness factor (0.0-1.0). Default: 0.5.
    /// 0.0 = conservative (use median speed), 1.0 = aggressive (use upper percentile).
    /// Replaces the old boolean race_mode with a continuous scale.
    #[serde(default)]
    pub race_aggressiveness: Option<f64>,
    /// Start time of day (0.0-24.0, hours). When set, enables circadian rhythm
    /// modulation — models the 5-15% performance dip between 2-6 AM.
    /// Example: 8.0 = 8:00 AM start.
    #[serde(default)]
    pub start_time_h: Option<f64>,
    /// Stop/rest strategy for the event.
    #[serde(default)]
    pub stop_strategy: StopStrategy,
    /// Sleep strategy — affects circadian compounding across multiple nights.
    #[serde(default)]
    pub sleep_strategy: SleepStrategy,
    /// Surface type data from OpenStreetMap, one per route point.
    /// Encoded as u8: 0=Road, 1=Gravel, 2=Unknown.
    /// If None or empty, all points default to Unknown.
    #[serde(default)]
    pub surface_types: Option<Vec<u8>>,
    /// Ambient temperature (°C) — affects thermal stress model.
    /// Default: 18.0 (thermoneutral). Set to actual forecast for better accuracy.
    #[serde(default)]
    pub ambient_temperature_c: Option<f64>,
    /// Headwind speed (m/s) — positive = headwind, negative = tailwind.
    /// Default: 0.0 (no wind). Average expected wind for the route.
    #[serde(default)]
    pub headwind_ms: Option<f64>,
    /// Rider gender for physiological adjustments.
    /// Affects speed prediction via VO2max/power-to-speed differences.
    #[serde(default)]
    pub gender: Gender,
}

fn default_pacing() -> f64 {
    1.0
}

impl Default for PredictionConfig {
    fn default() -> Self {
        Self {
            ftp_w: None,
            rider_weight_kg: None,
            bike_weight_kg: None,
            mass_kg: None,
            cda: None,
            crr: None,
            pacing_factor: 1.0,
            race_mode: false,
            smoothing_window_m: None,
            max_route_points: None,
            fatigue_floor: None,
            fatigue_lambda: None,
            stop_time_per_hour_s: None,
            drivetrain_efficiency: None,
            race_aggressiveness: None,
            start_time_h: None,
            stop_strategy: StopStrategy::None,
            sleep_strategy: SleepStrategy::None,
            surface_types: None,
            ambient_temperature_c: None,
            headwind_ms: None,
            gender: Gender::Unspecified,
        }
    }
}
