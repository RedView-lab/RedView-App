pub mod features;
pub mod kdtree;

use crate::types::ActivityData;
use features::{FeatureNorm, NormalizedSample, TrainingSample, DEFAULT_WEIGHTS};
use kdtree::KdTree;
use serde::{Deserialize, Serialize};

/// Minimum number of training samples needed for KNN to be used.
const MIN_SAMPLES: usize = 50;

/// Maximum training samples — with efficient distance search, we can use more data.
const MAX_SAMPLES: usize = 50_000;

/// KNN prediction result with confidence metric.
pub struct KnnPrediction {
    pub speed_ms: f64,
    /// Confidence in [0, 1]. Higher = closer neighbors, more reliable prediction.
    pub confidence: f64,
}

/// The complete KNN model with pre-normalized samples for fast distance computation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnnModel {
    /// Raw training samples (kept for serialisation / debugging)
    pub samples: Vec<TrainingSample>,
    /// Normalization params: [gradient, elapsed_h, cum_climb, recent_grad, elevation, cum_dist, hr_zone, temp]
    pub norms: Vec<FeatureNorm>,
    /// Optimized feature weights from LOO-CV (defaults if optimization skipped).
    #[serde(default = "default_weights")]
    pub weights: [f64; features::N_FEATURES],
    /// Pre-normalized & weighted feature vectors — NOT serialised, rebuilt on demand.
    #[serde(skip)]
    precomputed: Vec<NormalizedSample>,
    /// K-d tree spatial index — NOT serialised, rebuilt on demand.
    #[serde(skip)]
    kdtree: Option<KdTree>,
}

fn default_weights() -> [f64; features::N_FEATURES] {
    DEFAULT_WEIGHTS
}

impl KnnModel {
    pub fn is_usable(&mut self) -> bool {
        self.ensure_precomputed();
        self.precomputed.len() >= MIN_SAMPLES
    }

    /// Maximum elapsed_h seen in training data.
    pub fn max_elapsed_h(&self) -> f64 {
        self.samples
            .iter()
            .map(|s| s.elapsed_h)
            .fold(0.0_f64, f64::max)
    }

    /// Create an empty model (used as fallback when no training data exists).
    pub fn empty() -> Self {
        KnnModel {
            samples: vec![],
            norms: vec![],
            weights: DEFAULT_WEIGHTS,
            precomputed: vec![],
            kdtree: None,
        }
    }

    /// FIX: Rebuild precomputed samples after deserialization.
    /// Called lazily on first use if precomputed is empty but samples exist.
    /// Also builds the k-d tree index for O(log N) queries.
    pub fn ensure_precomputed(&mut self) {
        if self.precomputed.is_empty() && !self.samples.is_empty() && !self.norms.is_empty() {
            let weights = &self.weights;
            self.precomputed = self
                .samples
                .iter()
                .map(|s| NormalizedSample {
                    features: features::normalize_features_weighted(
                        s.gradient_pct,
                        s.elapsed_h,
                        s.cum_climb_m,
                        s.recent_avg_gradient,
                        s.elevation_m,
                        s.cum_distance_m,
                        s.heart_rate_zone,
                        s.temperature_c,
                        &self.norms,
                        weights,
                    ),
                    speed_ms: s.speed_ms,
                })
                .collect();
        }
        // Build k-d tree if needed
        if self.kdtree.is_none() && !self.precomputed.is_empty() {
            let feats: Vec<[f64; features::N_FEATURES]> =
                self.precomputed.iter().map(|s| s.features).collect();
            let speeds: Vec<f64> = self.precomputed.iter().map(|s| s.speed_ms).collect();
            self.kdtree = Some(KdTree::build(&feats, &speeds));
        }
    }
}

/// Extract training samples from multiple activities and build the KNN model.
/// Includes LOO-CV weight optimization for maximum prediction accuracy.
pub fn build_knn_model(activities: &[ActivityData]) -> KnnModel {
    let mut samples = features::extract_training_samples(activities);

    // Subsample if needed — keep every Nth sample uniformly
    if samples.len() > MAX_SAMPLES {
        let step = samples.len() as f64 / MAX_SAMPLES as f64;
        let mut kept = Vec::with_capacity(MAX_SAMPLES);
        let mut idx = 0.0_f64;
        while (idx as usize) < samples.len() && kept.len() < MAX_SAMPLES {
            kept.push(samples[idx as usize].clone());
            idx += step;
        }
        samples = kept;
    }

    let norms = features::compute_norms(&samples);

    // Optimize feature weights via LOO-CV if enough samples
    let weights = if samples.len() >= 200 {
        features::optimize_feature_weights(&samples, &norms)
    } else {
        DEFAULT_WEIGHTS
    };

    let precomputed: Vec<NormalizedSample> = samples
        .iter()
        .map(|s| NormalizedSample {
            features: features::normalize_features_weighted(
                s.gradient_pct,
                s.elapsed_h,
                s.cum_climb_m,
                s.recent_avg_gradient,
                s.elevation_m,
                s.cum_distance_m,
                s.heart_rate_zone,
                s.temperature_c,
                &norms,
                &weights,
            ),
            speed_ms: s.speed_ms,
        })
        .collect();

    // Build k-d tree index for O(log N) nearest-neighbor queries
    let feats: Vec<[f64; features::N_FEATURES]> =
        precomputed.iter().map(|s| s.features).collect();
    let speeds: Vec<f64> = precomputed.iter().map(|s| s.speed_ms).collect();
    let kdtree = Some(KdTree::build(&feats, &speeds));

    KnnModel {
        samples,
        norms,
        weights,
        precomputed,
        kdtree,
    }
}

/// Predict speed (m/s) using KNN for a single route point.
/// Returns KnnPrediction with speed and confidence metric.
///
/// Uses k-d tree index for O(log N) nearest-neighbor queries.
/// Confidence combines proximity, Gaussian weight, and neighbor speed variance.
pub fn knn_predict_speed(
    model: &mut KnnModel,
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
) -> KnnPrediction {
    model.ensure_precomputed();
    let precomputed = &model.precomputed;

    if precomputed.is_empty() {
        return KnnPrediction {
            speed_ms: 5.56,
            confidence: 0.0,
        };
    }

    let q = features::normalize_features_weighted(
        gradient_pct,
        elapsed_h,
        cum_climb_m,
        recent_avg_gradient,
        elevation_m,
        cum_distance_m,
        0.7,  // neutral HR zone for prediction (unknown future HR)
        18.0, // neutral temperature for prediction
        &model.norms,
        &model.weights,
    );

    // Adaptive K: scale with data size, raised cap for large datasets
    let adaptive_k = ((precomputed.len() as f64).sqrt() as usize).clamp(7, 50);
    let k = adaptive_k.min(precomputed.len());

    // Use k-d tree for O(log N) nearest-neighbor search
    let top_k = model.kdtree.as_ref().unwrap().knn_query(&q, k);

    // Gaussian-based inverse-distance weighting — smoother falloff than 1/d
    let mut weight_sum = 0.0;
    let mut value_sum = 0.0;
    let mut dist_sum = 0.0;

    // Compute bandwidth from median neighbor distance for adaptive Gaussian width
    let median_d2 = if top_k.len() >= 3 {
        let mid = top_k.len() / 2;
        top_k[mid].0.max(1e-12)
    } else {
        1.0
    };

    for &(d, speed) in &top_k {
        let r = d.sqrt();
        // Gaussian kernel: w = exp(-d / (2·σ²))
        let w = (-d / (2.0 * median_d2)).exp();
        weight_sum += w;
        value_sum += w * speed;
        dist_sum += r;
    }

    let speed = if weight_sum > 0.0 {
        value_sum / weight_sum
    } else {
        5.56
    };

    // Confidence: combines mean distance, Gaussian weight, and speed variance
    let mean_dist = if !top_k.is_empty() {
        dist_sum / top_k.len() as f64
    } else {
        f64::MAX
    };
    let mean_weight = if !top_k.is_empty() && weight_sum > 0.0 {
        weight_sum / top_k.len() as f64
    } else {
        0.0
    };

    // Variance-weighted confidence: penalize when neighbors disagree on speed
    let speed_variance = if weight_sum > 0.0 && !top_k.is_empty() {
        let mean_spd = value_sum / weight_sum;
        let var: f64 = top_k.iter()
            .map(|&(d, spd)| {
                let w = (-d / (2.0 * median_d2)).exp();
                w * (spd - mean_spd).powi(2)
            })
            .sum::<f64>() / weight_sum;
        var.sqrt()
    } else {
        1.0
    };
    let variance_penalty = 1.0 / (1.0 + speed_variance);

    let confidence = ((1.0 / (1.0 + mean_dist)) * mean_weight.sqrt() * variance_penalty).clamp(0.0, 1.0);

    KnnPrediction { speed_ms: speed, confidence }
}

/// Squared Euclidean distance between two feature vectors.
#[inline]
fn dist_sq(a: &[f64; features::N_FEATURES], b: &[f64; features::N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    for i in 0..features::N_FEATURES {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ActivityData, ActivitySummary, DataPoint};

    fn make_activity(n_points: usize, base_speed: f64, has_power: bool) -> ActivityData {
        let mut points = Vec::with_capacity(n_points);
        for i in 0..n_points {
            let t = i as f64;
            let dist = t * base_speed;
            let grad_cycle = (t * 0.01).sin() * 5.0;
            let ele = 500.0 + grad_cycle * 10.0;
            let speed = (base_speed - grad_cycle * 0.3).max(1.0);

            points.push(DataPoint {
                timestamp_s: t,
                lat: 45.0 + t * 0.00001,
                lon: 6.0,
                altitude_m: ele,
                speed_ms: speed,
                power_w: if has_power { 200.0 } else { 0.0 },
                cadence_rpm: 80.0,
                heart_rate_bpm: 140.0,
                temperature_c: 20.0,
                distance_m: dist,
            });
        }

        let summary = ActivitySummary {
            duration_s: n_points as f64,
            distance_m: points.last().map(|p| p.distance_m).unwrap_or(0.0),
            elevation_gain_m: 500.0,
            avg_speed_ms: base_speed,
            avg_power_w: if has_power { 200.0 } else { 0.0 },
            avg_hr_bpm: 140.0,
            has_power,
            has_hr: true,
        };

        ActivityData { points, summary }
    }

    #[test]
    fn test_knn_model_building() {
        let activities = vec![
            make_activity(1000, 7.0, false),
            make_activity(500, 6.0, false),
        ];

        let mut model = build_knn_model(&activities);

        assert!(
            model.samples.len() > 100,
            "Expected >100 samples, got {}",
            model.samples.len()
        );
        assert_eq!(model.norms.len(), 8);
        assert!(model.is_usable());
    }

    #[test]
    fn test_knn_prediction() {
        let activities = vec![
            make_activity(2000, 7.0, false),
            make_activity(1000, 6.5, false),
        ];

        let mut model = build_knn_model(&activities);

        let pred = knn_predict_speed(&mut model, 0.0, 0.5, 100.0, 0.0, 500.0, 5000.0);
        assert!(
            pred.speed_ms > 4.0 && pred.speed_ms < 12.0,
            "Flat prediction: got {} m/s",
            pred.speed_ms
        );
        assert!(pred.confidence > 0.0, "Confidence should be > 0");

        let pred_up = knn_predict_speed(&mut model, 8.0, 0.5, 100.0, 5.0, 800.0, 5000.0);
        assert!(
            pred_up.speed_ms < pred.speed_ms,
            "Uphill ({}) should be slower than flat ({})",
            pred_up.speed_ms,
            pred.speed_ms
        );
    }

    #[test]
    fn test_knn_model_too_small() {
        let activities = vec![make_activity(10, 7.0, false)];
        let mut model = build_knn_model(&activities);
        assert!(!model.is_usable());
    }

    #[test]
    fn test_knn_confidence_decreases_with_extrapolation() {
        let activities = vec![make_activity(2000, 7.0, false)];
        let mut model = build_knn_model(&activities);

        // Within training range
        let pred_normal = knn_predict_speed(&mut model, 0.0, 0.3, 100.0, 0.0, 500.0, 3000.0);
        // Far outside training range (50h elapsed = way beyond training data)
        let pred_extrap = knn_predict_speed(&mut model, 0.0, 50.0, 50000.0, 0.0, 500.0, 500000.0);

        assert!(
            pred_normal.confidence > pred_extrap.confidence,
            "Normal confidence ({}) should be > extrapolated ({})",
            pred_normal.confidence,
            pred_extrap.confidence
        );
    }
}
