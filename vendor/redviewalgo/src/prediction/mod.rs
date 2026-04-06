pub mod descent;
pub mod fatigue;
pub mod segments;
pub mod speed;
pub mod stops;
pub mod surface;

use crate::knn::KnnModel;
use crate::math::DRIVETRAIN_EFFICIENCY;
use crate::types::{PredictionConfig, PredictionResult, RiderProfile, Route, SleepStrategy, SurfaceType};

/// Run prediction in a single pass.
///
/// Fatigue is handled per-point by the exponential decay model in fatigue.rs.
/// No iterative convergence — the fatigue model already captures the power-duration
/// relationship correctly via exponential decay to a floor.
pub fn predict(
    profile: &RiderProfile,
    route: &Route,
    config: &PredictionConfig,
    knn: &mut KnnModel,
) -> PredictionResult {
    // Total system mass: prefer split weight from profile (already resolved
    // from config overrides in build_rider_profile), fallback to config.mass_kg
    let mass_kg = config.mass_kg.unwrap_or(profile.mass_kg);
    // If user provided split weights via config, profile already has the correct
    // total mass from rider_weight_kg + bike_weight_kg. The config.mass_kg
    // override is only for legacy callers who pass a single total.
    let cda = config.cda.unwrap_or(profile.cda);
    let crr = config.crr.unwrap_or(profile.crr);
    let pacing = config.pacing_factor;
    let drivetrain_eff = config.drivetrain_efficiency.unwrap_or(DRIVETRAIN_EFFICIENCY);

    // Apply fatigue overrides from config
    let mut profile = profile.clone();
    if let Some(floor) = config.fatigue_floor {
        profile.fatigue.floor = floor.clamp(0.1, 0.95);
    }
    if let Some(lambda) = config.fatigue_lambda {
        profile.fatigue.decay_lambda = lambda.clamp(0.0, 1.0);
    }

    // Auto-detect stop strategy: if Auto or None + long route, use Ultra
    let effective_stop_strategy = match &config.stop_strategy {
        crate::types::StopStrategy::Auto => {
            if route.total_distance_m > 200_000.0 {
                crate::types::StopStrategy::Ultra
            } else {
                crate::types::StopStrategy::None
            }
        }
        crate::types::StopStrategy::None => {
            // Auto-upgrade: if distance > 300km on None, likely an oversight
            if route.total_distance_m > 300_000.0 {
                crate::types::StopStrategy::Ultra
            } else {
                crate::types::StopStrategy::None
            }
        }
        other => other.clone(),
    };

    // Estimate riding time for stop schedule generation (rough: distance / 25 km/h)
    let estimated_riding_time_s = route.total_distance_m / (25.0 / 3.6);
    let has_sleep_stops = matches!(config.sleep_strategy, SleepStrategy::SleepStops);
    let mut stop_schedule = stops::generate_stop_schedule(
        estimated_riding_time_s,
        &effective_stop_strategy,
        has_sleep_stops,
    );

    // Terrain-aware stop placement: shift stops to valley bottoms
    let estimated_avg_speed = 25.0 / 3.6; // rough estimate for terrain search
    stops::terrain_aware_shift(&mut stop_schedule, &route, estimated_avg_speed);

    // Add extra stops at high altitude (>2500m)
    stops::altitude_adjusted_stops(
        &mut stop_schedule,
        &route,
        estimated_avg_speed,
        estimated_riding_time_s,
    );

    // Apply surface types from OSM data if provided
    let mut route = route.clone();
    if let Some(ref surface_data) = config.surface_types {
        for (i, rp) in route.points.iter_mut().enumerate() {
            rp.surface_type = if i < surface_data.len() {
                SurfaceType::from_u8(surface_data[i])
            } else {
                SurfaceType::Unknown
            };
        }
    }

    // Single-pass prediction — fatigue is applied per-point internally,
    // stops are integrated into the loop for recovery effects
    let (mut pred_points, riding_time_s) = speed::predict_single_pass(
        &profile, &route, knn, mass_kg, cda, crr, pacing, drivetrain_eff,
        config.start_time_h,
        &config.sleep_strategy,
        config.race_mode,
        &stop_schedule,
        config.ambient_temperature_c.unwrap_or(18.0),
    );

    // Build segment summaries
    let segment_list = segments::build_segments(&pred_points, &route.points);

    // Stop time = sum of all scheduled stop durations
    let stop_time_s: f64 = stop_schedule.iter().map(|s| s.duration_s).sum();
    let total_time_s = riding_time_s + stop_time_s;
    let total_distance_m = route.total_distance_m;

    let avg_speed_kmh = if total_time_s > 0.0 {
        (total_distance_m / total_time_s) * 3.6
    } else {
        0.0
    };

    // Confidence intervals: compute time bounds from per-point speed bounds
    // Use average KNN confidence to estimate prediction uncertainty
    let mean_confidence = if !pred_points.is_empty() {
        pred_points.iter().map(|p| p.knn_confidence).sum::<f64>() / pred_points.len() as f64
    } else {
        0.0
    };
    // Uncertainty band: ±5% with good data, ±15% with poor data
    let uncertainty = 0.05 + 0.10 * (1.0 - mean_confidence);
    let total_time_low_s = total_time_s * (1.0 - uncertainty);
    let total_time_high_s = total_time_s * (1.0 + uncertainty);

    // Add per-point speed bounds
    for p in &mut pred_points {
        let point_uncertainty = 0.05 + 0.10 * (1.0 - p.knn_confidence);
        p.predicted_speed_low_kmh = p.predicted_speed_kmh * (1.0 - point_uncertainty);
        p.predicted_speed_high_kmh = p.predicted_speed_kmh * (1.0 + point_uncertainty);
    }

    PredictionResult {
        total_time_s,
        riding_time_s,
        stop_time_s,
        total_distance_m,
        avg_speed_kmh,
        elevation_gain_m: route.total_elevation_gain_m,
        elevation_loss_m: route.total_elevation_loss_m,
        segments: segment_list,
        points: pred_points,
        rider_profile: profile.clone(),
        total_time_low_s,
        total_time_high_s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    fn empty_knn() -> KnnModel {
        KnnModel::empty()
    }

    fn mock_profile() -> RiderProfile {
        RiderProfile {
            gradient_bins: vec![
                GradientBin {
                    gradient_pct: 0.0,
                    median_speed_ms: 8.33,
                    std_speed_ms: 1.0,
                    count: 100,
                },
                GradientBin {
                    gradient_pct: 5.0,
                    median_speed_ms: 3.33,
                    std_speed_ms: 0.5,
                    count: 50,
                },
                GradientBin {
                    gradient_pct: -5.0,
                    median_speed_ms: 13.89,
                    std_speed_ms: 2.0,
                    count: 50,
                },
            ],
            fatigued_bins: vec![],
            ftp_w: 250.0,
            mass_kg: 75.0,
            cda: 0.35,
            crr: 0.005,
            fatigue: FatigueModel {
                decay_lambda: 0.02,
                baseline: 1.0,
                floor: 0.60,
                ultra_floor: None,
                fast_amplitude: None,
                fast_lambda: None,
                slow_amplitude: None,
                slow_lambda: None,
            },
            has_power: true,
        }
    }

    fn mock_route() -> Route {
        let mut points = Vec::new();
        let distances =
            [0.0, 1000.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0];
        let elevations =
            [100.0, 100.0, 100.0, 150.0, 200.0, 250.0, 200.0, 150.0, 100.0, 100.0];

        for i in 0..10 {
            let seg_len = if i < 9 { 1000.0 } else { 0.0 };
            let grad = if i < 9 {
                (elevations[i + 1] - elevations[i]) / 1000.0 * 100.0
            } else {
                0.0
            };
            points.push(RoutePoint {
                lat: 45.0 + i as f64 * 0.01,
                lon: 6.0,
                elevation_m: elevations[i],
                distance_m: distances[i],
                gradient_pct: grad,
                segment_length_m: seg_len,
                curvature_deg_per_km: 0.0,
                surface_type: SurfaceType::Road,
            });
        }

        Route {
            points,
            total_distance_m: 9000.0,
            total_elevation_gain_m: 150.0,
            total_elevation_loss_m: 150.0,
        }
    }

    #[test]
    fn test_prediction_produces_output() {
        let profile = mock_profile();
        let route = mock_route();
        let config = PredictionConfig::default();
        let mut knn = empty_knn();

        let result = predict(&profile, &route, &config, &mut knn);

        assert_eq!(result.points.len(), 10);
        assert!(result.total_time_s > 0.0);
        assert!(result.avg_speed_kmh > 5.0);
        assert!(result.avg_speed_kmh < 60.0);
    }

    #[test]
    fn test_uphill_slower_than_flat() {
        let profile = mock_profile();
        let route = mock_route();
        let config = PredictionConfig::default();
        let mut knn = empty_knn();

        let result = predict(&profile, &route, &config, &mut knn);

        let flat_speed = result.points[0].predicted_speed_kmh;
        let climb_speed = result.points[3].predicted_speed_kmh;

        assert!(
            climb_speed < flat_speed,
            "Climb ({climb_speed}) should be slower than flat ({flat_speed})"
        );
    }
}
