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
    }
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
