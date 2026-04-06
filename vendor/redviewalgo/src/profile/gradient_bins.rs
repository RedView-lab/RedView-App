use crate::math::{gradient_pct, monotone_cubic_interp, percentile, std_dev, MonotoneSpline};
use crate::types::{ActivityData, GradientBin};

/// Gradient bin width in percent — 0.25% for fine-grained speed curves.
/// Critical: 3% vs 3.5% grade is ~1-2 km/h in pro cycling.
const BIN_WIDTH: f64 = 0.25;
/// Min gradient for binning.
const GRADIENT_MIN: f64 = -20.0;
/// Max gradient for binning.
const GRADIENT_MAX: f64 = 25.0;
/// Minimum samples per bin for a reliable estimate.
/// Kept at 3 despite narrower bins — cubic interpolation smooths across neighbors.
const MIN_BIN_SAMPLES: usize = 3;
/// Fresh data window (seconds) — first 2h of each activity.
const FRESH_WINDOW_S: f64 = 7200.0;
/// Fatigued data starts after this (seconds) — after 3h of each activity.
const FATIGUED_START_S: f64 = 10800.0;

/// Pre-computed spline cache for fast gradient→speed lookups.
/// Build once from gradient bins, then O(log N) per evaluation.
#[derive(Debug, Clone)]
pub struct SplineBins {
    fresh_spline: Option<MonotoneSpline>,
    fatigued_spline: Option<MonotoneSpline>,
    fresh_min_g: f64,
    fresh_max_g: f64,
    fatigued_min_g: f64,
    fatigued_max_g: f64,
}

impl SplineBins {
    /// Build pre-computed splines from fresh and fatigued gradient bin vectors.
    pub fn build(fresh_bins: &[GradientBin], fatigued_bins: &[GradientBin]) -> Self {
        let fresh_spline = Self::build_spline(fresh_bins);
        let fatigued_spline = Self::build_spline(fatigued_bins);

        let (fresh_min_g, fresh_max_g) = Self::gradient_range(fresh_bins);
        let (fatigued_min_g, fatigued_max_g) = Self::gradient_range(fatigued_bins);

        SplineBins {
            fresh_spline,
            fatigued_spline,
            fresh_min_g,
            fresh_max_g,
            fatigued_min_g,
            fatigued_max_g,
        }
    }

    fn build_spline(bins: &[GradientBin]) -> Option<MonotoneSpline> {
        if bins.len() < 2 {
            return None;
        }
        let mut sorted: Vec<(f64, f64)> = bins
            .iter()
            .map(|b| (b.gradient_pct, b.median_speed_ms))
            .collect();
        sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let xs: Vec<f64> = sorted.iter().map(|(g, _)| *g).collect();
        let ys: Vec<f64> = sorted.iter().map(|(_, s)| *s).collect();
        Some(MonotoneSpline::build(xs, ys))
    }

    fn gradient_range(bins: &[GradientBin]) -> (f64, f64) {
        if bins.is_empty() {
            return (0.0, 0.0);
        }
        let min = bins.iter().map(|b| b.gradient_pct).fold(f64::MAX, f64::min);
        let max = bins.iter().map(|b| b.gradient_pct).fold(f64::MIN, f64::max);
        (min - 2.0, max + 2.0)
    }

    /// Fast blended speed lookup using pre-computed splines.
    /// O(log N) per call instead of O(N) sort + spline rebuild.
    #[inline]
    pub fn lookup_blended(&self, gradient_pct_val: f64, elapsed_h: f64) -> Option<f64> {
        let fresh_speed = self.lookup_fresh(gradient_pct_val);
        let fatigued_speed = self.lookup_fatigued(gradient_pct_val);

        match (fresh_speed, fatigued_speed) {
            (Some(fs), Some(fatg)) => {
                let blend = 1.0 - (-elapsed_h / 8.0).exp();
                let blend = blend.clamp(0.0, 1.0);
                Some(fs * (1.0 - blend) + fatg * blend)
            }
            (Some(fs), None) => Some(fs),
            (None, Some(fatg)) => Some(fatg),
            (None, None) => None,
        }
    }

    #[inline]
    fn lookup_fresh(&self, gradient_pct_val: f64) -> Option<f64> {
        if let Some(ref spline) = self.fresh_spline {
            if gradient_pct_val >= self.fresh_min_g && gradient_pct_val <= self.fresh_max_g {
                return Some(spline.eval(gradient_pct_val).max(0.5));
            }
        }
        None
    }

    #[inline]
    fn lookup_fatigued(&self, gradient_pct_val: f64) -> Option<f64> {
        if let Some(ref spline) = self.fatigued_spline {
            if gradient_pct_val >= self.fatigued_min_g && gradient_pct_val <= self.fatigued_max_g {
                return Some(spline.eval(gradient_pct_val).max(0.5));
            }
        }
        None
    }
}

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

        if speeds.len() >= MIN_BIN_SAMPLES {
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
/// Uses exponential fatigue blending (Abbiss & Laursen 2005 kinetics):
///   blend = 1 - exp(-elapsed_h / 8)
/// τ=8h → 63% fatigued at 8h, 86% at 16h, 95% at 24h.
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
            // Exponential onset: matches physiological fatigue kinetics
            let blend = 1.0 - (-elapsed_h / 8.0).exp();
            let blend = blend.clamp(0.0, 1.0);
            Some(fs * (1.0 - blend) + fatg * blend)
        }
        (Some(fs), None) => Some(fs),
        (None, Some(fatg)) => Some(fatg),
        (None, None) => None,
    }
}

/// Lookup speed using monotone cubic interpolation across gradient bins.
/// Produces smooth, continuous speed curves instead of step-function nearest-bin.
fn lookup_bin_speed(bins: &[GradientBin], gradient_pct_val: f64) -> Option<f64> {
    if bins.is_empty() {
        return None;
    }
    if bins.len() == 1 {
        // Only one bin: check if close enough
        if (bins[0].gradient_pct - gradient_pct_val).abs() < 3.0 {
            return Some(bins[0].median_speed_ms);
        }
        return None;
    }

    // Sort bins by gradient and use monotone cubic interpolation
    let mut sorted: Vec<(f64, f64)> = bins
        .iter()
        .map(|b| (b.gradient_pct, b.median_speed_ms))
        .collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let xs: Vec<f64> = sorted.iter().map(|(g, _)| *g).collect();
    let ys: Vec<f64> = sorted.iter().map(|(_, s)| *s).collect();

    // Check if gradient is within range (with 2% margin)
    let min_g = xs.first().unwrap() - 2.0;
    let max_g = xs.last().unwrap() + 2.0;
    if gradient_pct_val < min_g || gradient_pct_val > max_g {
        return None;
    }

    let speed = monotone_cubic_interp(&xs, &ys, gradient_pct_val);
    Some(speed.max(0.5))
}
