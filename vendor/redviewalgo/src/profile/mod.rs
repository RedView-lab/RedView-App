pub mod fatigue_fit;
pub mod gradient_bins;
pub mod power_profile;

use crate::types::{ActivityData, PredictionConfig, RiderProfile};

/// Default CdA if not estimable (road cyclist, hoods position).
const DEFAULT_CDA: f64 = 0.35;
/// Default Crr (good road surface, 25mm tires at ~6 bar).
const DEFAULT_CRR: f64 = 0.005;
/// Default rider+bike mass (kg).
const DEFAULT_MASS: f64 = 80.0;
/// Default bike + equipment weight (kg) when rider weight is provided alone.
const DEFAULT_BIKE_WEIGHT: f64 = 10.0;

/// Build a `RiderProfile` from multiple activities and user config overrides.
///
/// Config overrides (ftp_w, rider_weight_kg, bike_weight_kg) take priority
/// over auto-estimated values. Auto-estimation still runs as a fallback
/// and for comparison logging.
///
/// W/kg (watts per kilogram of body weight) is computed from FTP and rider
/// weight — this is the #1 predictor of climbing performance in cycling.
pub fn build_rider_profile(activities: &[ActivityData], config: &PredictionConfig) -> RiderProfile {
    let has_power = activities.iter().any(|a| a.summary.has_power);

    let (gradient_bins, fatigued_bins) = gradient_bins::build_dual_gradient_bins(activities, 0.60);
    let fatigue = fatigue_fit::build_fatigue_model(activities, has_power);

    // Auto-estimate from data (always, for fallback / comparison)
    let (auto_ftp, auto_mass, auto_cda) = if has_power {
        let ftp = power_profile::estimate_ftp(activities);
        let mass_pass1 = power_profile::estimate_mass(activities);
        let cda = power_profile::estimate_cda(activities, mass_pass1);
        (ftp, mass_pass1, cda)
    } else {
        (0.0, DEFAULT_MASS, DEFAULT_CDA)
    };

    // Apply user overrides: FTP
    let ftp_w = config.ftp_w.unwrap_or(auto_ftp);

    // Apply user overrides: weight (split rider + bike)
    let (rider_weight_kg, bike_weight_kg, mass_kg) = if let Some(rw) = config.rider_weight_kg {
        let bw = config.bike_weight_kg.unwrap_or(DEFAULT_BIKE_WEIGHT);
        (rw, bw, rw + bw)
    } else if let Some(total) = config.mass_kg {
        // Legacy: single mass_kg provided — assume 80/20 split
        let bw = (total * 0.12).clamp(6.0, 20.0);
        let rw = total - bw;
        (rw, bw, total)
    } else {
        // Auto-estimated total, assume 80/20 split
        let bw = (auto_mass * 0.12).clamp(6.0, 20.0);
        let rw = auto_mass - bw;
        (rw, bw, auto_mass)
    };

    // Compute W/kg — the single most important metric in cycling performance
    let wkg = if rider_weight_kg > 0.0 && ftp_w > 0.0 {
        ftp_w / rider_weight_kg
    } else {
        0.0
    };

    let cda = auto_cda;

    // Compute training D+ statistics from historical activities
    let (training_dplus_per_km, training_max_climb_rate_mh,
         training_avg_climb_rate_mh, training_max_dplus_m)
        = compute_training_dplus_stats(activities);

    RiderProfile {
        gradient_bins,
        fatigued_bins,
        ftp_w,
        mass_kg,
        rider_weight_kg,
        bike_weight_kg,
        wkg,
        cda,
        crr: DEFAULT_CRR,
        fatigue,
        has_power,
        training_dplus_per_km,
        training_max_climb_rate_mh,
        training_avg_climb_rate_mh,
        training_max_dplus_m,
    }
}

/// Compute D+ training statistics from historical activities.
/// These stats are used to compare route difficulty vs training experience.
fn compute_training_dplus_stats(activities: &[ActivityData]) -> (f64, f64, f64, f64) {
    let mut total_dplus = 0.0_f64;
    let mut total_distance_km = 0.0_f64;
    let mut max_dplus_single = 0.0_f64;
    let mut climb_rates: Vec<f64> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        if pts.len() < 20 || activity.summary.duration_s < 1800.0 {
            continue;
        }

        // Despike altitudes before integrating D+ — raw per-second diffs of
        // barometric noise accumulate hundreds of fake metres on long rides
        // and skew route-vs-training difficulty comparison.
        let raw_altitudes: Vec<f64> = pts.iter().map(|p| p.altitude_m).collect();
        let altitudes = crate::math::median_filter_elevations(&raw_altitudes, 5);

        let mut activity_dplus = 0.0_f64;
        // Track climbing blocks: accumulate D+ and time while gradient > 2%
        let mut block_dplus = 0.0_f64;
        let mut block_time_s = 0.0_f64;

        for i in 1..pts.len() {
            let ele_diff = altitudes[i] - altitudes[i - 1];
            let dt = pts[i].timestamp_s - pts[i - 1].timestamp_s;

            if ele_diff > 0.0 {
                activity_dplus += ele_diff;
            }

            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            let grad_pct = if dist > 1.0 { (ele_diff / dist) * 100.0 } else { 0.0 };

            if grad_pct > 2.0 && dt > 0.0 && dt < 120.0 {
                block_dplus += ele_diff.max(0.0);
                block_time_s += dt;
            } else {
                // End of climbing block — record climb rate if significant
                if block_dplus > 50.0 && block_time_s > 300.0 {
                    let rate_mh = block_dplus / (block_time_s / 3600.0);
                    climb_rates.push(rate_mh);
                }
                block_dplus = 0.0;
                block_time_s = 0.0;
            }
        }

        // Final climbing block
        if block_dplus > 50.0 && block_time_s > 300.0 {
            let rate_mh = block_dplus / (block_time_s / 3600.0);
            climb_rates.push(rate_mh);
        }

        let dist_km = activity.summary.distance_m / 1000.0;
        total_dplus += activity_dplus;
        total_distance_km += dist_km;
        if activity_dplus > max_dplus_single {
            max_dplus_single = activity_dplus;
        }
    }

    let dplus_per_km = if total_distance_km > 0.0 {
        total_dplus / total_distance_km
    } else {
        10.0 // default moderate terrain
    };

    let max_climb_rate = climb_rates.iter().cloned().fold(0.0_f64, f64::max);
    let avg_climb_rate = if !climb_rates.is_empty() {
        climb_rates.iter().sum::<f64>() / climb_rates.len() as f64
    } else {
        600.0 // default moderate climber
    };

    (dplus_per_km, max_climb_rate, avg_climb_rate, max_dplus_single)
}

/// Lookup speed for a given gradient from the rider profile bins.
/// Returns speed in m/s. Uses monotone cubic interpolation for smooth, non-linear results.
pub fn lookup_speed_for_gradient(
    bins: &[crate::types::GradientBin],
    gradient_pct: f64,
) -> Option<f64> {
    if bins.is_empty() {
        return None;
    }
    if bins.len() == 1 {
        return Some(bins[0].median_speed_ms);
    }

    let mut sorted: Vec<(f64, f64)> = bins
        .iter()
        .map(|b| (b.gradient_pct, b.median_speed_ms))
        .collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let xs: Vec<f64> = sorted.iter().map(|(g, _)| *g).collect();
    let ys: Vec<f64> = sorted.iter().map(|(_, s)| *s).collect();

    let speed = crate::math::monotone_cubic_interp(&xs, &ys, gradient_pct);
    Some(speed.max(0.5))
}
