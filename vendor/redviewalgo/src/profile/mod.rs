pub mod fatigue_fit;
pub mod gradient_bins;
pub mod power_profile;

use crate::types::{ActivityData, RiderProfile};

/// Default CdA if not estimable (road cyclist, hoods position).
const DEFAULT_CDA: f64 = 0.35;
/// Default Crr (good road surface, 25mm tires at ~6 bar).
const DEFAULT_CRR: f64 = 0.005;
/// Default rider+bike mass (kg).
const DEFAULT_MASS: f64 = 80.0;

/// Build a `RiderProfile` from multiple activities.
///
/// When power data is available, estimates FTP, mass, and CdA from the data.
/// Uses 2-pass mass↔CdA iteration: mass depends on CdA assumption, and CdA
/// depends on mass. Two passes converge well since both are weakly coupled.
pub fn build_rider_profile(activities: &[ActivityData]) -> RiderProfile {
    let has_power = activities.iter().any(|a| a.summary.has_power);

    let (gradient_bins, fatigued_bins) = gradient_bins::build_dual_gradient_bins(activities, 0.60);
    let fatigue = fatigue_fit::build_fatigue_model(activities, has_power);

    let (ftp_w, mass_kg, cda) = if has_power {
        let ftp = power_profile::estimate_ftp(activities);

        // Pass 1: estimate mass (uses climbing CdA internally)
        let mass_pass1 = power_profile::estimate_mass(activities);
        // Estimate CdA from the refined mass
        let cda = power_profile::estimate_cda(activities, mass_pass1);

        (ftp, mass_pass1, cda)
    } else {
        (0.0, DEFAULT_MASS, DEFAULT_CDA)
    };

    RiderProfile {
        gradient_bins,
        fatigued_bins,
        ftp_w,
        mass_kg,
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
