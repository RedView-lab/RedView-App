use crate::math::gradient_pct;
use crate::types::ActivityData;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Feature weights — relative importance of each feature for distance calculation.
const WEIGHT_GRADIENT: f64 = 3.0;
const WEIGHT_ELAPSED_H: f64 = 2.5;
const WEIGHT_CUM_CLIMB: f64 = 1.2;
const WEIGHT_RECENT_GRAD: f64 = 1.5;
const WEIGHT_ELEVATION: f64 = 0.3;
const WEIGHT_CUM_DISTANCE: f64 = 1.5;

/// Number of feature dimensions (6D: gradient, elapsed, cum_climb, recent_grad, elevation, cum_distance)
pub const N_FEATURES: usize = 6;

/// Recent gradient context: distance-based window (metres)
const RECENT_GRADIENT_WINDOW_M: f64 = 500.0;

/// A single training sample extracted from a FIT activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingSample {
    pub gradient_pct: f64,
    pub elapsed_h: f64,
    pub cum_climb_m: f64,
    pub recent_avg_gradient: f64,
    pub elevation_m: f64,
    pub cum_distance_m: f64,
    pub speed_ms: f64,
}

/// Normalization parameters for each feature dimension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureNorm {
    pub mean: f64,
    pub std: f64,
}

/// Pre-normalized feature vector + speed — stored for O(1) lookup during prediction.
#[derive(Debug, Clone)]
pub struct NormalizedSample {
    pub features: [f64; N_FEATURES],
    pub speed_ms: f64,
}

/// Extract training samples from multiple activities.
pub fn extract_training_samples(activities: &[ActivityData]) -> Vec<TrainingSample> {
    let mut samples: Vec<TrainingSample> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        if pts.len() < 20 {
            continue;
        }

        let mut cum_climb = 0.0_f64;
        // IMPROVED: Distance-based recent gradient window (500m) instead of time-based (300s)
        let mut recent_grads: VecDeque<(f64, f64)> = VecDeque::new(); // (distance, gradient)

        for i in 1..pts.len() {
            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 1.0 {
                continue;
            }

            let speed = pts[i].speed_ms;
            if speed < 0.5 || speed > 25.0 {
                continue;
            }

            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = gradient_pct(dist, ele_diff);
            if grad < -25.0 || grad > 30.0 {
                continue;
            }

            if ele_diff > 0.0 {
                cum_climb += ele_diff;
            }

            let current_dist = pts[i].distance_m;
            recent_grads.push_back((current_dist, grad));

            // IMPROVED: Remove entries outside distance window
            let dist_cutoff = current_dist - RECENT_GRADIENT_WINDOW_M;
            while recent_grads.len() > 1 && recent_grads[0].0 < dist_cutoff {
                recent_grads.pop_front();
            }

            let recent_avg = if recent_grads.is_empty() {
                grad
            } else {
                recent_grads.iter().map(|(_, g)| g).sum::<f64>() / recent_grads.len() as f64
            };

            let elapsed_h = pts[i].timestamp_s / 3600.0;

            samples.push(TrainingSample {
                gradient_pct: grad,
                elapsed_h: (1.0 + elapsed_h).ln(),
                cum_climb_m: (1.0 + cum_climb / 1000.0).ln(),
                recent_avg_gradient: recent_avg,
                elevation_m: pts[i].altitude_m,
                cum_distance_m: (1.0 + pts[i].distance_m / 100_000.0).ln(),
                speed_ms: speed,
            });
        }
    }

    samples
}

/// Compute normalization parameters (mean, std) for each feature dimension.
pub fn compute_norms(samples: &[TrainingSample]) -> Vec<FeatureNorm> {
    if samples.is_empty() {
        return vec![
            FeatureNorm { mean: 0.0, std: 10.0 },   // gradient
            FeatureNorm { mean: 0.5, std: 0.5 },     // ln(1+elapsed_h)
            FeatureNorm { mean: 0.5, std: 0.5 },     // ln(1+cum_climb/1000)
            FeatureNorm { mean: 0.0, std: 10.0 },    // recent_grad
            FeatureNorm { mean: 500.0, std: 500.0 },  // elevation
            FeatureNorm { mean: 0.5, std: 0.5 },     // ln(1+cum_dist/100km)
        ];
    }

    let n = samples.len() as f64;
    let mut norms = Vec::with_capacity(N_FEATURES);

    let raw: Vec<[f64; N_FEATURES]> = samples
        .iter()
        .map(|s| {
            [
                s.gradient_pct,
                s.elapsed_h,
                s.cum_climb_m,
                s.recent_avg_gradient,
                s.elevation_m,
                s.cum_distance_m,
            ]
        })
        .collect();

    for dim in 0..N_FEATURES {
        let mean = raw.iter().map(|f| f[dim]).sum::<f64>() / n;
        let variance = raw.iter().map(|f| (f[dim] - mean).powi(2)).sum::<f64>() / n;
        let std = variance.sqrt().max(1e-6);
        norms.push(FeatureNorm { mean, std });
    }
    norms
}

/// Normalise + weight a feature vector.
/// Uses log-compressed elapsed_h, cum_climb_m, and cum_distance_m for query features.
#[inline]
pub fn normalize_features(
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
    norms: &[FeatureNorm],
) -> [f64; N_FEATURES] {
    let compressed_elapsed = (1.0 + elapsed_h).ln();
    let compressed_climb = (1.0 + cum_climb_m / 1000.0).ln();
    let compressed_dist = (1.0 + cum_distance_m / 100_000.0).ln();

    [
        (gradient_pct - norms[0].mean) / norms[0].std * WEIGHT_GRADIENT,
        (compressed_elapsed - norms[1].mean) / norms[1].std * WEIGHT_ELAPSED_H,
        (compressed_climb - norms[2].mean) / norms[2].std * WEIGHT_CUM_CLIMB,
        (recent_avg_gradient - norms[3].mean) / norms[3].std * WEIGHT_RECENT_GRAD,
        (elevation_m - norms[4].mean) / norms[4].std * WEIGHT_ELEVATION,
        (compressed_dist - norms[5].mean) / norms[5].std * WEIGHT_CUM_DISTANCE,
    ]
}
