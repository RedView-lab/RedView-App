use crate::math::haversine_distance;
use crate::types::{ActivitySummary, DataPoint};

// ─── Point post-processing and activity summary ─────────────────────────────

/// FIT stores lat/lon as semicircles. Convert to degrees.
pub(super) fn semicircles_to_degrees(semicircles: f64) -> f64 {
    semicircles * (180.0 / 2_147_483_648.0)
}

/// If FIT-reported distance is missing or zero, recompute from GPS.
/// Also recomputes speed from GPS dt/distance if speed is missing across the activity.
pub(super) fn recompute_distance_if_needed(points: &mut [DataPoint]) {
    let last_dist = points.last().map(|p| p.distance_m).unwrap_or(0.0);
    if last_dist <= 100.0 {
        let mut cumulative = 0.0;
        for i in 0..points.len() {
            if i == 0 {
                points[i].distance_m = 0.0;
                continue;
            }
            let d = haversine_distance(
                points[i - 1].lat,
                points[i - 1].lon,
                points[i].lat,
                points[i].lon,
            );
            cumulative += d;
            points[i].distance_m = cumulative;
        }
    }

    // Resiliency: if speed was not recorded in FIT, derive from distance and dt
    let has_speed = points.iter().any(|p| p.speed_ms > 0.5);
    if !has_speed {
        for i in 1..points.len() {
            let dt = points[i].timestamp_s - points[i - 1].timestamp_s;
            let dd = points[i].distance_m - points[i - 1].distance_m;
            if dt > 0.0 && dt < 120.0 && dd >= 0.0 {
                points[i].speed_ms = (dd / dt).min(35.0);
            }
        }
    }
}

pub(super) fn compute_summary(points: &[DataPoint]) -> ActivitySummary {
    let duration_s = points.last().map(|p| p.timestamp_s).unwrap_or(0.0);
    let distance_m = points.last().map(|p| p.distance_m).unwrap_or(0.0);

    // Despike altitudes before integrating D+ — raw per-sample barometric
    // noise otherwise inflates elevation gain by hundreds of metres on
    // long rides (same median filter as the GPX route path).
    let raw_altitudes: Vec<f64> = points.iter().map(|p| p.altitude_m).collect();
    let altitudes = crate::math::median_filter_elevations(&raw_altitudes, 5);
    let mut elevation_gain = 0.0;
    for i in 1..altitudes.len() {
        let diff = altitudes[i] - altitudes[i - 1];
        if diff > 0.0 {
            elevation_gain += diff;
        }
    }

    let avg_speed_ms = if duration_s > 0.0 {
        distance_m / duration_s
    } else {
        0.0
    };

    let power_points: Vec<f64> = points.iter().filter(|p| p.power_w > 0.0).map(|p| p.power_w).collect();
    let has_power = power_points.len() as f64 > points.len() as f64 * 0.5;
    let avg_power_w = if !power_points.is_empty() {
        power_points.iter().sum::<f64>() / power_points.len() as f64
    } else {
        0.0
    };

    let hr_points: Vec<f64> = points.iter().filter(|p| p.heart_rate_bpm > 0.0).map(|p| p.heart_rate_bpm).collect();
    let has_hr = hr_points.len() as f64 > points.len() as f64 * 0.5;
    let avg_hr_bpm = if !hr_points.is_empty() {
        hr_points.iter().sum::<f64>() / hr_points.len() as f64
    } else {
        0.0
    };

    ActivitySummary {
        duration_s,
        distance_m,
        elevation_gain_m: elevation_gain,
        avg_speed_ms,
        avg_power_w,
        avg_hr_bpm,
        has_power,
        has_hr,
        sport: None,
    }
}
