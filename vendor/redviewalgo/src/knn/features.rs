use crate::math::gradient_pct;
use crate::types::ActivityData;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Feature weights — relative importance of each feature for distance calculation.
/// These are default weights; can be optimized via LOO-CV in `optimize_feature_weights()`.
const WEIGHT_GRADIENT: f64 = 3.0;
const WEIGHT_ELAPSED_H: f64 = 2.5;
const WEIGHT_CUM_CLIMB: f64 = 1.2;
const WEIGHT_RECENT_GRAD: f64 = 1.5;
const WEIGHT_ELEVATION: f64 = 0.3;
const WEIGHT_CUM_DISTANCE: f64 = 1.5;
const WEIGHT_HEART_RATE: f64 = 2.0;
const WEIGHT_TEMPERATURE: f64 = 1.0;

/// Default weights array for convenience.
pub const DEFAULT_WEIGHTS: [f64; N_FEATURES] = [
    WEIGHT_GRADIENT,
    WEIGHT_ELAPSED_H,
    WEIGHT_CUM_CLIMB,
    WEIGHT_RECENT_GRAD,
    WEIGHT_ELEVATION,
    WEIGHT_CUM_DISTANCE,
    WEIGHT_HEART_RATE,
    WEIGHT_TEMPERATURE,
];

/// Number of feature dimensions (8D: gradient, elapsed, cum_climb, recent_grad,
/// elevation, cum_distance, heart_rate_zone, temperature_c)
pub const N_FEATURES: usize = 8;

/// Recent gradient context: distance-based window (metres)
const RECENT_GRADIENT_WINDOW_M: f64 = 500.0;

/// Yeo-Johnson power transform with λ=0.5.
/// Preserves more separation at large values than ln(1+x).
/// For x ≥ 0: ((1+x)^λ - 1) / λ = 2 * ((1+x)^0.5 - 1)
#[inline]
pub fn yeo_johnson(x: f64) -> f64 {
    2.0 * ((1.0 + x.max(0.0)).sqrt() - 1.0)
}

/// A single training sample extracted from a FIT activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingSample {
    pub gradient_pct: f64,
    pub elapsed_h: f64,
    pub cum_climb_m: f64,
    pub recent_avg_gradient: f64,
    pub elevation_m: f64,
    pub cum_distance_m: f64,
    pub heart_rate_zone: f64,
    pub temperature_c: f64,
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

        // Compute max HR for this activity to normalize HR into zones (0-1)
        let max_hr = pts
            .iter()
            .map(|p| p.heart_rate_bpm)
            .fold(0.0_f64, f64::max);
        let has_hr = max_hr > 60.0; // valid HR data

        let mut cum_climb = 0.0_f64;
        let mut recent_grads: VecDeque<(f64, f64)> = VecDeque::new();

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

            // Heart rate zone: normalized to % of max HR (0.0-1.0)
            // If no HR data, use neutral 0.7 (moderate intensity assumption)
            let hr_zone = if has_hr && pts[i].heart_rate_bpm > 40.0 {
                (pts[i].heart_rate_bpm / max_hr).clamp(0.0, 1.0)
            } else {
                0.7
            };

            // Temperature: use raw value, default 18.0°C if invalid/missing
            let temp = if pts[i].temperature_c > -30.0 && pts[i].temperature_c < 55.0 {
                pts[i].temperature_c
            } else {
                18.0
            };

            samples.push(TrainingSample {
                gradient_pct: grad,
                elapsed_h: yeo_johnson(elapsed_h),
                cum_climb_m: yeo_johnson(cum_climb / 1000.0),
                recent_avg_gradient: recent_avg,
                elevation_m: pts[i].altitude_m,
                cum_distance_m: yeo_johnson(pts[i].distance_m / 100_000.0),
                heart_rate_zone: hr_zone,
                temperature_c: temp,
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
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(elapsed_h)
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(cum_climb/1000)
            FeatureNorm { mean: 0.0, std: 10.0 },    // recent_grad
            FeatureNorm { mean: 500.0, std: 500.0 },  // elevation
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(cum_dist/100km)
            FeatureNorm { mean: 0.7, std: 0.15 },    // heart_rate_zone
            FeatureNorm { mean: 18.0, std: 8.0 },    // temperature_c
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
                s.heart_rate_zone,
                s.temperature_c,
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
/// Uses Yeo-Johnson-compressed elapsed_h, cum_climb_m, and cum_distance_m for query features.
/// Accepts optional custom weights (from LOO-CV optimization) or uses defaults.
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
    normalize_features_weighted(
        gradient_pct, elapsed_h, cum_climb_m, recent_avg_gradient,
        elevation_m, cum_distance_m, 0.7, 18.0, norms, &DEFAULT_WEIGHTS,
    )
}

/// Full normalize with all 8 features and custom weights.
#[inline]
pub fn normalize_features_weighted(
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
    heart_rate_zone: f64,
    temperature_c: f64,
    norms: &[FeatureNorm],
    weights: &[f64; N_FEATURES],
) -> [f64; N_FEATURES] {
    let compressed_elapsed = yeo_johnson(elapsed_h);
    let compressed_climb = yeo_johnson(cum_climb_m / 1000.0);
    let compressed_dist = yeo_johnson(cum_distance_m / 100_000.0);

    [
        (gradient_pct - norms[0].mean) / norms[0].std * weights[0],
        (compressed_elapsed - norms[1].mean) / norms[1].std * weights[1],
        (compressed_climb - norms[2].mean) / norms[2].std * weights[2],
        (recent_avg_gradient - norms[3].mean) / norms[3].std * weights[3],
        (elevation_m - norms[4].mean) / norms[4].std * weights[4],
        (compressed_dist - norms[5].mean) / norms[5].std * weights[5],
        (heart_rate_zone - norms[6].mean) / norms[6].std * weights[6],
        (temperature_c - norms[7].mean) / norms[7].std * weights[7],
    ]
}

/// Optimize feature weights via leave-one-out cross-validation on a subsample.
/// Tests random weight combinations and returns the set minimizing RMSE.
/// Uses k-d tree for fast neighbor lookups in inner loop.
pub fn optimize_feature_weights(
    samples: &[TrainingSample],
    norms: &[FeatureNorm],
) -> [f64; N_FEATURES] {
    // Subsample for speed: max 1000 samples for LOO-CV
    let max_cv_samples = 1000;
    let step = if samples.len() > max_cv_samples {
        samples.len() as f64 / max_cv_samples as f64
    } else {
        1.0
    };
    let mut cv_indices: Vec<usize> = Vec::new();
    let mut idx = 0.0;
    while (idx as usize) < samples.len() && cv_indices.len() < max_cv_samples {
        cv_indices.push(idx as usize);
        idx += step;
    }

    let weight_options: &[f64] = &[0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

    // Use a simple pseudo-random generator (deterministic, no external deps)
    let mut rng_state: u64 = 42;
    let mut next_rand = || -> usize {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((rng_state >> 33) as usize) % weight_options.len()
    };

    let mut best_weights = DEFAULT_WEIGHTS;
    let mut best_rmse = f64::MAX;

    // Test default weights first
    let default_rmse = evaluate_weights_loo(&cv_indices, samples, norms, &DEFAULT_WEIGHTS);
    if default_rmse < best_rmse {
        best_rmse = default_rmse;
    }

    // Random search: 200 random weight combinations (was 800, k-d tree makes each faster)
    for _ in 0..200 {
        let mut candidate = [0.0_f64; N_FEATURES];
        for d in 0..N_FEATURES {
            candidate[d] = weight_options[next_rand()];
        }
        // Ensure gradient stays dominant (>= 2.0)
        if candidate[0] < 2.0 {
            candidate[0] = 2.0;
        }

        let rmse = evaluate_weights_loo(&cv_indices, samples, norms, &candidate);
        if rmse < best_rmse {
            best_rmse = rmse;
            best_weights = candidate;
        }
    }

    best_weights
}

/// Evaluate feature weights via approximate LOO-CV, returning RMSE.
/// Uses k-d tree for fast nearest-neighbor queries in the inner loop.
fn evaluate_weights_loo(
    indices: &[usize],
    samples: &[TrainingSample],
    norms: &[FeatureNorm],
    weights: &[f64; N_FEATURES],
) -> f64 {
    // Pre-normalize all samples with these weights
    let normalized: Vec<([f64; N_FEATURES], f64)> = samples
        .iter()
        .map(|s| {
            let f = normalize_features_weighted(
                s.gradient_pct, s.elapsed_h, s.cum_climb_m,
                s.recent_avg_gradient, s.elevation_m, s.cum_distance_m,
                s.heart_rate_zone, s.temperature_c, norms, weights,
            );
            (f, s.speed_ms)
        })
        .collect();

    // Build k-d tree over all normalized samples
    let feats: Vec<[f64; N_FEATURES]> = normalized.iter().map(|(f, _)| *f).collect();
    let speeds: Vec<f64> = normalized.iter().map(|(_, s)| *s).collect();
    let tree = super::kdtree::KdTree::build(&feats, &speeds);

    // K+1 because we need to exclude self
    let k = ((samples.len() as f64).sqrt() as usize).clamp(7, 50);
    let k_query = (k + 1).min(samples.len());
    let mut sse = 0.0;

    for &test_idx in indices {
        let q = &normalized[test_idx].0;
        let actual_speed = normalized[test_idx].1;

        // Query k+1 neighbors (one will be self with dist=0, skip it)
        let neighbors = tree.knn_query(q, k_query);

        // Gaussian-weighted prediction, skipping self
        let mut found = 0;
        let median_d2 = if neighbors.len() >= 4 {
            neighbors[neighbors.len() / 2].0.max(1e-12)
        } else {
            1.0
        };
        let mut w_sum = 0.0;
        let mut v_sum = 0.0;
        for &(d, spd) in &neighbors {
            // Skip self (distance ≈ 0)
            if d < 1e-15 {
                continue;
            }
            let w = (-d / (2.0 * median_d2)).exp();
            w_sum += w;
            v_sum += w * spd;
            found += 1;
            if found >= k {
                break;
            }
        }
        let predicted = if w_sum > 0.0 { v_sum / w_sum } else { actual_speed };
        sse += (predicted - actual_speed).powi(2);
    }

    (sse / indices.len() as f64).sqrt()
}

#[inline]
fn dist_sq_arr(a: &[f64; N_FEATURES], b: &[f64; N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    for i in 0..N_FEATURES {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum
}
