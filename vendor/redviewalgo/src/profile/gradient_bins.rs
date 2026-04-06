use crate::math::{gradient_pct, percentile, std_dev};
use crate::types::{ActivityData, GradientBin};

/// Gradient bin width in percent.
const BIN_WIDTH: f64 = 0.5;
/// Min gradient for binning.
const GRADIENT_MIN: f64 = -20.0;
/// Max gradient for binning.
const GRADIENT_MAX: f64 = 25.0;
/// Fresh data window (seconds) — first 2h of each activity.
const FRESH_WINDOW_S: f64 = 7200.0;
/// Fatigued data starts after this (seconds) — after 3h of each activity.
const FATIGUED_START_S: f64 = 10800.0;

/// Build speed-vs-gradient bins from activities (fresh bins only — backward compatible).
pub fn build_gradient_bins(activities: &[ActivityData]) -> Vec<GradientBin> {
    build_gradient_bins_with_percentile(activities, 0.60)
}

/// Build both fresh and fatigued gradient bin sets.
/// Returns (fresh_bins, fatigued_bins).
/// During prediction, these are blended based on elapsed time.
pub fn build_dual_gradient_bins(
    activities: &[ActivityData],
    speed_percentile: f64,
) -> (Vec<GradientBin>, Vec<GradientBin>) {
    let fresh = build_gradient_bins_with_percentile(activities, speed_percentile);
    let fatigued = build_fatigued_gradient_bins(activities, speed_percentile);
    (fresh, fatigued)
}

/// Build gradient bins with a custom speed percentile (fresh data only).
pub fn build_gradient_bins_with_percentile(
    activities: &[ActivityData],
    speed_percentile: f64,
) -> Vec<GradientBin> {
    let mut samples: Vec<(f64, f64)> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        for i in 1..pts.len() {
            if pts[i].timestamp_s > FRESH_WINDOW_S {
                break;
            }

            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 1.0 {
                continue;
            }
            let speed = pts[i].speed_ms;
            if speed < 0.5 {
                continue;
            }

            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = gradient_pct(dist, ele_diff);

            if grad >= GRADIENT_MIN && grad <= GRADIENT_MAX {
                samples.push((grad, speed));
            }
        }
    }

    // If not enough fresh samples, fall back to ALL samples
    if samples.len() < 50 {
        samples.clear();
        collect_all_samples(activities, &mut samples);
    }

    bin_samples(&samples, speed_percentile)
}

/// Build gradient bins from fatigued-state data (>3h into each activity).
/// These represent how the rider actually performs when tired.
fn build_fatigued_gradient_bins(
    activities: &[ActivityData],
    speed_percentile: f64,
) -> Vec<GradientBin> {
    let mut samples: Vec<(f64, f64)> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        // Only use activities that are long enough to have fatigued data
        if activity.summary.duration_s < FATIGUED_START_S + 1800.0 {
            continue;
        }
        for i in 1..pts.len() {
            if pts[i].timestamp_s < FATIGUED_START_S {
                continue;
            }

            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 1.0 {
                continue;
            }
            let speed = pts[i].speed_ms;
            if speed < 0.5 {
                continue;
            }

            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = gradient_pct(dist, ele_diff);

            if grad >= GRADIENT_MIN && grad <= GRADIENT_MAX {
                samples.push((grad, speed));
            }
        }
    }

    // Fall back to fresh bins if insufficient fatigued data
    if samples.len() < 30 {
        return Vec::new();
    }

    bin_samples(&samples, speed_percentile)
}

fn collect_all_samples(activities: &[ActivityData], samples: &mut Vec<(f64, f64)>) {
    for activity in activities {
        let pts = &activity.points;
        for i in 1..pts.len() {
            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 1.0 {
                continue;
            }
            let speed = pts[i].speed_ms;
            if speed < 0.5 {
                continue;
            }
            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = gradient_pct(dist, ele_diff);
            if grad >= GRADIENT_MIN && grad <= GRADIENT_MAX {
                samples.push((grad, speed));
            }
        }
    }
}

fn bin_samples(samples: &[(f64, f64)], speed_percentile: f64) -> Vec<GradientBin> {
    let mut bins: Vec<GradientBin> = Vec::new();
    let mut g = GRADIENT_MIN;
    while g < GRADIENT_MAX {
        let center = g + BIN_WIDTH / 2.0;
        let mut speeds: Vec<f64> = samples
            .iter()
            .filter(|(grad, _)| *grad >= g && *grad < g + BIN_WIDTH)
            .map(|(_, s)| *s)
            .collect();

        if speeds.len() >= 3 {
            let adaptive_pct = if center > 3.0 || center < -3.0 {
                speed_percentile.min(0.50)
            } else {
                speed_percentile
            };
            let p = percentile(&mut speeds, adaptive_pct);
            let sd = std_dev(&speeds);
            bins.push(GradientBin {
                gradient_pct: center,
                median_speed_ms: p,
                std_speed_ms: sd,
                count: speeds.len() as u32,
            });
        }

        g += BIN_WIDTH;
    }

    bins
}

/// Lookup speed from fatigued bins with elapsed-time blending.
/// Blends fresh and fatigued bins: `lerp(fresh, fatigued, min(1, elapsed_h / 12))`.
pub fn lookup_blended_speed(
    fresh_bins: &[GradientBin],
    fatigued_bins: &[GradientBin],
    gradient_pct_val: f64,
    elapsed_h: f64,
) -> Option<f64> {
    let fresh_speed = lookup_bin_speed(fresh_bins, gradient_pct_val);
    if fatigued_bins.is_empty() {
        return fresh_speed;
    }
    let fatigued_speed = lookup_bin_speed(fatigued_bins, gradient_pct_val);

    match (fresh_speed, fatigued_speed) {
        (Some(fs), Some(fatg)) => {
            let blend = (elapsed_h / 12.0).min(1.0).max(0.0);
            Some(fs * (1.0 - blend) + fatg * blend)
        }
        (Some(fs), None) => Some(fs),
        (None, Some(fatg)) => Some(fatg),
        (None, None) => None,
    }
}

fn lookup_bin_speed(bins: &[GradientBin], gradient_pct_val: f64) -> Option<f64> {
    if bins.is_empty() {
        return None;
    }
    // Find closest bin
    bins.iter()
        .min_by(|a, b| {
            let da = (a.gradient_pct - gradient_pct_val).abs();
            let db = (b.gradient_pct - gradient_pct_val).abs();
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .filter(|b| (b.gradient_pct - gradient_pct_val).abs() < 2.0)
        .map(|b| b.median_speed_ms)
}
