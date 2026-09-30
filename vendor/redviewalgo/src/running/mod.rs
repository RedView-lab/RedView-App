//! Running / trail-running time prediction.
//!
//! Model, per route point:
//!   flat speed  = v_ref · endurance(t) · altitude · night · terrain
//!   running     = flat speed / effort(grade)            (Ultrapacer / Strava-HR GAP)
//!   uphill      → power-hike above the walk threshold, at a vertical rate (VAM)
//!   downhill    → capped by a technical descent limit, degraded by eccentric damage
//! The reference speed comes from FIT files, a reference race, VMA or the
//! practice level; FIT files also personalise the walk threshold, hiking VAM,
//! descent skill and endurance decay, and feed a KNN blended with the model.

pub mod cost;
pub mod profile;

use crate::knn::{build_knn_model, knn_predict_speed, KnnModel};
use crate::prediction::fatigue::circadian_factor;
use crate::prediction::segments::build_segments;
use crate::types::{
    ActivityData, Gender, PredictionPoint, Route, SegmentSummary, SleepStrategy,
};
use cost::{altitude_factor, effort_factor, walk_speed_ms};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Hard floor on predicted speed (m/s) ≈ 2 km/h (very steep scrambling).
const MIN_SPEED_MS: f64 = 0.55;
/// Hard ceiling on predicted speed (m/s) ≈ 28 km/h.
const MAX_SPEED_MS: f64 = 7.8;
/// Floor of the combined altitude × night × eccentric penalty (anti-stacking).
const MICRO_FLOOR: f64 = 0.65;
/// Width (grade %) of the run → hike transition around the walk threshold.
const WALK_BLEND_WIDTH_PCT: f64 = 4.0;
/// KNN base weight in the model/KNN blend (lower than cycling: running FIT
/// files mix many terrains and paces, so the model stays the anchor).
const KNN_BASE_WEIGHT: f64 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunDiscipline {
    /// Road running.
    #[default]
    Running,
    /// Trail running (technical terrain, power-hiking, long descents).
    Trail,
}

impl RunDiscipline {
    fn as_str(self) -> &'static str {
        match self {
            RunDiscipline::Running => "running",
            RunDiscipline::Trail => "trail",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RunPredictionConfig {
    #[serde(default)]
    pub discipline: RunDiscipline,
    /// Practice level id: debutant | intermediaire | avance | expert.
    #[serde(default)]
    pub level: Option<String>,
    /// Maximal aerobic speed (km/h).
    #[serde(default)]
    pub vma_kmh: Option<f64>,
    /// Reference race distance (m) and finish time (s).
    #[serde(default)]
    pub ref_distance_m: Option<f64>,
    #[serde(default)]
    pub ref_time_s: Option<f64>,
    /// Runner weight including pack (kg).
    #[serde(default)]
    pub mass_kg: Option<f64>,
    /// Terrain technicality 0 (smooth) … 1 (very technical). Trail only.
    #[serde(default)]
    pub technicality: Option<f64>,
    /// Start time of day (h) — enables the night performance dip.
    #[serde(default)]
    pub start_time_h: Option<f64>,
    #[serde(default)]
    pub gender: Gender,
    #[serde(default)]
    pub max_route_points: Option<usize>,
    #[serde(default)]
    pub smoothing_window_m: Option<f64>,
}

impl RunPredictionConfig {
    /// Technicality only applies to trail; road running is smooth by definition.
    pub fn effective_technicality(&self) -> f64 {
        match self.discipline {
            RunDiscipline::Trail => self.technicality.unwrap_or(0.5).clamp(0.0, 1.0),
            RunDiscipline::Running => 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerProfile {
    /// Flat speed sustainable for ~1 h (km/h).
    pub v_ref_kmh: f64,
    /// Where v_ref comes from: fit | chrono | vma | level.
    pub v_ref_source: String,
    /// Endurance decay exponent: speed ∝ t^(−k) beyond the first hour.
    pub riegel_k: f64,
    pub walk_threshold_pct: f64,
    pub walk_vam_mh: f64,
    /// Learnt downhill speed ratio vs the default descent model (1 = default).
    pub descent_ratio: f64,
    pub descent_skill: f64,
    pub technicality: f64,
    pub n_activities: usize,
    /// FIT files dropped because they were recorded for another sport.
    pub n_ignored: usize,
    pub knn_samples: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunPredictionResult {
    pub discipline: String,
    pub total_time_s: f64,
    pub riding_time_s: f64,
    pub stop_time_s: f64,
    pub total_distance_m: f64,
    pub avg_speed_kmh: f64,
    pub elevation_gain_m: f64,
    pub elevation_loss_m: f64,
    pub segments: Vec<SegmentSummary>,
    pub points: Vec<PredictionPoint>,
    pub runner_profile: RunnerProfile,
    pub total_time_low_s: f64,
    pub total_time_high_s: f64,
}

/// Flat-ground terrain factor: technical trail slows even the flat sections.
pub fn terrain_factor(technicality: f64, discipline: RunDiscipline) -> f64 {
    match discipline {
        RunDiscipline::Running => 1.0,
        RunDiscipline::Trail => 0.95 - 0.17 * technicality.clamp(0.0, 1.0),
    }
}

/// Downhill running speed (m/s) from the (terrain-adjusted) flat speed:
/// grade-adjusted pace, capped by what footing and skill allow. Steep
/// technical descents are where levels differ most (~18 % between top and
/// bottom finishers vs ~5 % on climbs).
pub fn descent_speed_ms(
    v_flat_ms: f64,
    grade_pct: f64,
    technicality: f64,
    skill: f64,
    discipline: RunDiscipline,
) -> f64 {
    let model = v_flat_ms / effort_factor(grade_pct);
    let steep = (-grade_pct).max(0.0);
    let cap = match discipline {
        RunDiscipline::Running => {
            let mut c = v_flat_ms * 1.30;
            if steep > 10.0 {
                c *= (1.0 - (steep - 10.0) / 100.0).max(0.6);
            }
            c
        }
        RunDiscipline::Trail => {
            let mut c = v_flat_ms * 1.25 * skill;
            if steep > 15.0 {
                let slope_penalty = (1.5 + 2.0 * technicality) * (steep - 15.0) / 100.0;
                c *= (1.0 - slope_penalty).max(0.35);
            }
            c
        }
    };
    model.min(cap)
}

/// Instantaneous endurance factor: speed ∝ (t/1h)^(−k) after the first hour.
fn endurance_factor(elapsed_h: f64, k: f64) -> f64 {
    if elapsed_h <= 1.0 {
        1.0
    } else {
        elapsed_h.powf(-k)
    }
}

/// Eccentric muscle damage from cumulated descent: downhill speeds keep
/// dropping through ultra-trails.
fn eccentric_factor(cum_descent_m: f64) -> f64 {
    1.0 - 0.10 * cum_descent_m / (cum_descent_m + 4000.0)
}

/// Load effect on climbs (heavier runner or pack): mild, bounded.
fn load_factor(mass_kg: Option<f64>, gender: Gender) -> f64 {
    let reference = if gender == Gender::Female { 58.0 } else { 70.0 };
    match mass_kg {
        Some(m) if m > 30.0 => (reference / m).powf(0.35).clamp(0.85, 1.05),
        _ => 1.0,
    }
}

fn smoothstep(x: f64) -> f64 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Run the prediction on already-parsed inputs.
pub fn predict_run(
    activities: &[ActivityData],
    n_ignored: usize,
    route: &Route,
    cfg: &RunPredictionConfig,
) -> RunPredictionResult {
    let (mut runner, _preset) = profile::build_runner_profile(activities, cfg, n_ignored);
    let mut knn: KnnModel = if activities.is_empty() {
        KnnModel::empty()
    } else {
        build_knn_model(activities)
    };
    let use_knn = knn.is_usable();
    runner.knn_samples = if use_knn { knn.samples.len() } else { 0 };
    let knn_max_h = if use_knn { knn.max_elapsed_h() } else { 0.0 };

    let discipline = cfg.discipline;
    let technicality = runner.technicality;
    let terrain = terrain_factor(technicality, discipline);
    let v_ref_ms = runner.v_ref_kmh / 3.6;
    let load = load_factor(cfg.mass_kg, cfg.gender);
    let descent_skill = runner.descent_skill * runner.descent_ratio;

    let n = route.points.len();
    let mut points: Vec<PredictionPoint> = Vec::with_capacity(n);
    let mut elapsed_s = 0.0_f64;
    let mut cum_climb_m = 0.0_f64;
    let mut cum_descent_m = 0.0_f64;
    let mut recent: VecDeque<(f64, f64)> = VecDeque::new();
    let mut recent_sum = 0.0_f64;

    for i in 0..n {
        let rp = &route.points[i];
        if i > 0 {
            let d = rp.elevation_m - route.points[i - 1].elevation_m;
            if d > 0.0 {
                cum_climb_m += d;
            } else {
                cum_descent_m -= d;
            }
        }

        // 500 m gradient context, blended with the local grade to tame GPX noise.
        recent.push_back((rp.distance_m, rp.gradient_pct));
        recent_sum += rp.gradient_pct;
        while recent.len() > 1 && recent[0].0 < rp.distance_m - 500.0 {
            if let Some((_, g)) = recent.pop_front() {
                recent_sum -= g;
            }
        }
        let recent_avg = recent_sum / recent.len() as f64;
        let grade = 0.6 * rp.gradient_pct + 0.4 * recent_avg;

        let elapsed_h = elapsed_s / 3600.0;
        let endurance = endurance_factor(elapsed_h, runner.riegel_k);
        let night = cfg
            .start_time_h
            .map(|start| circadian_factor(start, elapsed_h, &SleepStrategy::None))
            .unwrap_or(1.0);
        let eccentric = eccentric_factor(cum_descent_m);
        let micro = (altitude_factor(rp.elevation_m) * night).max(MICRO_FLOOR);

        let v_flat = v_ref_ms * endurance * micro * terrain;

        let model_speed = if grade >= 0.0 {
            let run = v_flat / effort_factor(grade) * if grade > 2.0 { load } else { 1.0 };
            // Hiking is barely affected by footing; apply half the terrain penalty.
            let hike_terrain = 1.0 - 0.5 * (1.0 - terrain);
            let vam = runner.walk_vam_mh * endurance * micro * load * hike_terrain;
            let hike = walk_speed_ms(grade, vam);
            let w = smoothstep(
                (grade - (runner.walk_threshold_pct - WALK_BLEND_WIDTH_PCT / 2.0))
                    / WALK_BLEND_WIDTH_PCT,
            );
            let blended = (1.0 - w) * run + w * hike;
            // Power-hiking is chosen whenever it is simply faster.
            if grade > 3.0 {
                blended.max(hike)
            } else {
                blended
            }
        } else {
            // Eccentric damage mostly shows on descents.
            descent_speed_ms(v_flat * eccentric, grade, technicality, descent_skill, discipline)
        };
        let model_speed = if grade >= 0.0 {
            model_speed * (1.0 - 0.3 * (1.0 - eccentric))
        } else {
            model_speed
        };

        let (speed, confidence) = if use_knn {
            let k = knn_predict_speed(
                &mut knn,
                rp.gradient_pct,
                elapsed_h,
                cum_climb_m,
                recent_avg,
                rp.elevation_m,
                rp.distance_m,
            );
            // KNN trust fades beyond the longest training effort (3× → ~0).
            let beyond = if knn_max_h > 0.5 && elapsed_h > knn_max_h {
                let over = (elapsed_h - knn_max_h) / (2.0 * knn_max_h);
                (1.0 - over).clamp(0.0, 1.0)
            } else {
                1.0
            };
            let conf_scaled = (k.confidence * 2.5).clamp(0.25, 1.0);
            let alpha = (KNN_BASE_WEIGHT * conf_scaled * beyond).clamp(0.0, 0.8);
            (alpha * k.speed_ms + (1.0 - alpha) * model_speed, k.confidence)
        } else {
            (model_speed, 0.0)
        };

        let speed = speed.clamp(MIN_SPEED_MS, MAX_SPEED_MS);
        let segment_time = if rp.segment_length_m > 0.01 {
            rp.segment_length_m / speed
        } else {
            0.0
        };

        points.push(PredictionPoint {
            distance_m: rp.distance_m,
            elevation_m: rp.elevation_m,
            gradient_pct: rp.gradient_pct,
            predicted_speed_kmh: speed * 3.6,
            predicted_power_w: 0.0,
            elapsed_time_s: elapsed_s,
            segment_time_s: segment_time,
            fatigue_factor: endurance,
            circadian_factor: night,
            distance_eff_factor: eccentric,
            knn_confidence: confidence,
            predicted_speed_low_kmh: 0.0,
            predicted_speed_high_kmh: 0.0,
        });

        elapsed_s += segment_time;
    }

    // Uncertainty band: ±7 % with good personal data, up to ±17 % without.
    let mean_conf = if points.is_empty() {
        0.0
    } else {
        points.iter().map(|p| p.knn_confidence).sum::<f64>() / points.len() as f64
    };
    let source_bonus = match runner.v_ref_source.as_str() {
        "fit" | "chrono" => 0.0,
        "vma" => 0.02,
        _ => 0.04,
    };
    let uncertainty = 0.07 + 0.06 * (1.0 - mean_conf) + source_bonus;
    for p in &mut points {
        let u = 0.07 + 0.06 * (1.0 - p.knn_confidence) + source_bonus;
        p.predicted_speed_low_kmh = p.predicted_speed_kmh * (1.0 - u);
        p.predicted_speed_high_kmh = p.predicted_speed_kmh * (1.0 + u);
    }

    let segments = build_segments(&points, &route.points);
    let total_time_s = elapsed_s;
    let total_distance_m = route.total_distance_m;

    RunPredictionResult {
        discipline: discipline.as_str().to_string(),
        total_time_s,
        riding_time_s: total_time_s,
        stop_time_s: 0.0,
        total_distance_m,
        avg_speed_kmh: if total_time_s > 0.0 {
            total_distance_m / total_time_s * 3.6
        } else {
            0.0
        },
        elevation_gain_m: route.total_elevation_gain_m,
        elevation_loss_m: route.total_elevation_loss_m,
        segments,
        points,
        runner_profile: runner,
        total_time_low_s: total_time_s * (1.0 - uncertainty),
        total_time_high_s: total_time_s * (1.0 + uncertainty),
    }
}
