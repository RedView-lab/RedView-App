use crate::math::{air_density, median, percentile, G, DRIVETRAIN_EFFICIENCY};
use crate::types::ActivityData;

/// Default CdA if not estimable (road cyclist, hoods position).
const DEFAULT_CDA: f64 = 0.35;
/// CdA multiplier for climbing position (rider sits up, ~15% increase).
const CLIMBING_CDA_FACTOR: f64 = 1.15;
/// Default Crr.
const DEFAULT_CRR: f64 = 0.005;
/// Default rider+bike mass (kg).
const DEFAULT_MASS: f64 = 75.0;

/// Estimate FTP using Critical Power (CP) model when sufficient data exists,
/// falling back to best 20-minute power × 0.95.
///
/// The CP model fits P(t) = CP + W'/t on Mean Maximal Power (MMP) data
/// at multiple durations. CP ≈ FTP and is more robust than a single 20-min test
/// because it doesn't require an all-out 20-minute effort in the data.
pub fn estimate_ftp(activities: &[ActivityData]) -> f64 {
    // Try Critical Power model first (more robust)
    let cp = estimate_ftp_from_mmp(activities);
    if cp > 50.0 {
        return cp;
    }
    // Fallback to 20-min best × 0.95
    estimate_ftp_20min(activities)
}

/// Classic FTP estimation: best 20-minute average power × 0.95.
fn estimate_ftp_20min(activities: &[ActivityData]) -> f64 {
    let mut best_20min_avg = 0.0_f64;

    for activity in activities {
        let pts = &activity.points;
        if pts.len() < 120 {
            continue;
        }

        best_20min_avg = best_20min_avg.max(best_time_weighted_power(pts, 1200.0));
    }

    best_20min_avg * 0.95
}

/// Best `duration_s` average power, time-weighted.
///
/// FIT smart recording writes samples at irregular intervals (up to 15-30 s
/// and more when stationary). Averaging per-sample would over-weight slow
/// segments recorded at high frequency; weighting by the time each sample
/// represents (t_i − t_{i−1}) gives the true mean power over the window.
/// Single O(N) sliding pass.
fn best_time_weighted_power(pts: &[crate::types::DataPoint], duration_s: f64) -> f64 {
    let mut best_avg = 0.0_f64;
    let mut left = 0usize;
    let mut sum_pdt = 0.0_f64; // Σ power·dt over the window
    let mut sum_dt = 0.0_f64; // Σ dt over the window

    for right in 0..pts.len() {
        let t_r = pts[right].timestamp_s;
        // dt each sample represents (guarded against gaps / unsorted data)
        let dt = if right == 0 {
            0.0
        } else {
            (t_r - pts[right - 1].timestamp_s).max(0.0).min(3600.0)
        };
        sum_pdt += pts[right].power_w * dt;
        sum_dt += dt;

        while t_r - pts[left].timestamp_s > duration_s {
            let dtl = if left == 0 {
                0.0
            } else {
                (pts[left].timestamp_s - pts[left - 1].timestamp_s)
                    .max(0.0)
                    .min(3600.0)
            };
            sum_pdt -= pts[left].power_w * dtl;
            sum_dt -= dtl;
            left += 1;
        }

        if t_r - pts[left].timestamp_s >= duration_s * 0.9 && sum_dt > duration_s * 0.5 {
            best_avg = best_avg.max(sum_pdt / sum_dt);
        }
    }

    best_avg
}

/// Estimate FTP via Critical Power (CP) from Mean Maximal Power at multiple durations.
///
/// Uses the Monod/Scherrer model: P(t) = CP + W'/t
/// Rearranged: P(t) · t = CP · t + W'  →  linear regression of (t, P·t) gives CP as slope.
///
/// MMP is computed at durations: 3, 5, 8, 12, 20, 40, 60 minutes.
/// Requires at least 3 valid MMP data points to fit.
fn estimate_ftp_from_mmp(activities: &[ActivityData]) -> f64 {
    let target_durations_s: &[f64] = &[180.0, 300.0, 480.0, 720.0, 1200.0, 2400.0, 3600.0];

    let mut mmp_points: Vec<(f64, f64)> = Vec::new(); // (duration_s, best_avg_power)

    for &dur in target_durations_s {
        let mut best_avg = 0.0_f64;

        for activity in activities {
            let pts = &activity.points;
            if pts.len() < 30 {
                continue;
            }
            let activity_dur = pts.last().map(|p| p.timestamp_s).unwrap_or(0.0)
                - pts.first().map(|p| p.timestamp_s).unwrap_or(0.0);
            if activity_dur < dur * 0.9 {
                continue;
            }

            best_avg = best_avg.max(best_time_weighted_power(pts, dur));
        }

        if best_avg > 30.0 {
            mmp_points.push((dur, best_avg));
        }
    }

    // Need at least 3 durations including one ≥ 12 min for a reliable CP fit
    if mmp_points.len() < 3 {
        return 0.0;
    }
    let has_long = mmp_points.iter().any(|(d, _)| *d >= 720.0);
    if !has_long {
        return 0.0;
    }

    // Linear regression on (t, P·t) → slope = CP, intercept = W'
    // P(t) · t = CP · t + W'
    let xs: Vec<f64> = mmp_points.iter().map(|(t, _)| *t).collect();
    let ys: Vec<f64> = mmp_points.iter().map(|(t, p)| p * t).collect();
    let (cp, _wprime) = crate::math::statistics::linear_regression(&xs, &ys);

    // Sanity check: CP should be physiologically reasonable
    if cp > 50.0 && cp < 600.0 {
        cp
    } else {
        0.0
    }
}

/// Estimate rider+bike mass from climbing segments where power is known.
///
/// Uses steep climbs (7-12%) where aerodynamic drag is minimal, so the
/// power balance is dominated by gravity → mass estimation is more accurate.
///
/// Corrections vs naive approach:
/// - Applies drivetrain efficiency (power meter reads crank power, not wheel power)
/// - Uses climbing CdA (rider is upright, not in hoods position)
/// - Minimum gradient 7% to reduce sensitivity to CdA errors
/// - IQR outlier filtering instead of simple range check
/// - Segment duration weighting (longer segments → more reliable)
pub fn estimate_mass(activities: &[ActivityData]) -> f64 {
    let mut mass_estimates: Vec<(f64, f64)> = Vec::new(); // (mass, duration_weight)

    let climbing_cda = DEFAULT_CDA * CLIMBING_CDA_FACTOR;

    for activity in activities {
        let pts = &activity.points;
        let mut seg_start = None;

        for i in 1..pts.len() {
            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 0.5 {
                continue;
            }
            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = ele_diff / dist; // fraction
            let power = pts[i].power_w;

            // Use 7-12% gradient: at 7%+, aero is <10% of total power
            if grad >= 0.07 && grad <= 0.12 && power > 50.0 {
                if seg_start.is_none() {
                    seg_start = Some(i - 1);
                }
            } else if let Some(start) = seg_start {
                let duration = pts[i - 1].timestamp_s - pts[start].timestamp_s;
                if duration > 120.0 {
                    let total_ele = pts[i - 1].altitude_m - pts[start].altitude_m;
                    let total_dist = pts[i - 1].distance_m - pts[start].distance_m;
                    let avg_grad = if total_dist > 0.0 {
                        total_ele / total_dist
                    } else {
                        0.08
                    };

                    let seg_pts = &pts[start..i];
                    let avg_power: f64 = seg_pts.iter().map(|p| p.power_w).sum::<f64>()
                        / seg_pts.len().max(1) as f64;
                    let avg_speed: f64 = seg_pts.iter().map(|p| p.speed_ms).sum::<f64>()
                        / seg_pts.len().max(1) as f64;

                    if avg_speed > 0.5 {
                        let avg_alt: f64 = seg_pts.iter().map(|p| p.altitude_m).sum::<f64>()
                            / seg_pts.len() as f64;
                        let rho = crate::math::air_density(avg_alt);

                        // Apply drivetrain efficiency: crank power → wheel power
                        let wheel_power = avg_power * DRIVETRAIN_EFFICIENCY;

                        // Use climbing CdA (rider upright) instead of flat CdA
                        let theta = avg_grad.atan();
                        let aero_power = 0.5 * rho * climbing_cda * avg_speed.powi(3);
                        let net_power = wheel_power - aero_power;
                        let gravity_factor =
                            crate::math::G * (theta.sin() + DEFAULT_CRR * theta.cos());

                        if gravity_factor > 0.01 && net_power > 10.0 {
                            let m = net_power / (gravity_factor * avg_speed);
                            if m > 40.0 && m < 150.0 {
                                // Weight by sqrt(duration) — longer segments are more reliable
                                mass_estimates.push((m, duration.sqrt()));
                            }
                        }
                    }
                }
                seg_start = None;
            }
        }
    }

    if mass_estimates.is_empty() {
        return DEFAULT_MASS;
    }

    // IQR outlier filtering
    let mut raw_masses: Vec<f64> = mass_estimates.iter().map(|(m, _)| *m).collect();
    let q1 = percentile(&mut raw_masses.clone(), 0.25);
    let q3 = percentile(&mut raw_masses.clone(), 0.75);
    let iqr = q3 - q1;
    let lower_bound = q1 - 1.5 * iqr;
    let upper_bound = q3 + 1.5 * iqr;

    // Weighted average of inliers
    let mut sum_weighted = 0.0;
    let mut sum_weights = 0.0;
    for (m, w) in &mass_estimates {
        if *m >= lower_bound && *m <= upper_bound {
            sum_weighted += m * w;
            sum_weights += w;
        }
    }

    if sum_weights > 0.0 {
        sum_weighted / sum_weights
    } else {
        // All filtered out — fall back to median
        median(&mut raw_masses)
    }
}

/// Estimate CdA from flat segments where power and speed are known.
///
/// IMPROVED: Configurable Crr, validates CdA output range [0.18, 0.55].
pub fn estimate_cda(activities: &[ActivityData], mass_kg: f64) -> f64 {
    estimate_cda_with_crr(activities, mass_kg, DEFAULT_CRR)
}

/// Estimate CdA with explicit Crr parameter.
/// On flat ground: P_wheel ≈ 0.5·ρ·CdA·v³ + Crr·m·g·v
/// → CdA ≈ 2(P_wheel − Crr·m·g·v) / (ρ·v³)
pub fn estimate_cda_with_crr(activities: &[ActivityData], mass_kg: f64, crr: f64) -> f64 {
    let mut cda_estimates: Vec<f64> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        for i in 1..pts.len() {
            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 5.0 {
                continue;
            }
            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = (ele_diff / dist).abs();
            let speed = pts[i].speed_ms;
            let power = pts[i].power_w;

            // Flat road: gradient < 1%, decent speed, valid power
            if grad < 0.01 && speed > 5.0 && power > 50.0 {
                let rho = air_density(pts[i].altitude_m);
                // Apply drivetrain efficiency: crank power → wheel power
                let wheel_power = power * DRIVETRAIN_EFFICIENCY;
                let p_rolling = crr * mass_kg * G * speed;
                let p_aero = wheel_power - p_rolling;
                if p_aero > 10.0 {
                    let cda = 2.0 * p_aero / (rho * speed.powi(3));
                    if cda > 0.18 && cda < 0.55 {
                        cda_estimates.push(cda);
                    }
                }
            }
        }
    }

    if cda_estimates.is_empty() {
        return DEFAULT_CDA;
    }

    median(&mut cda_estimates)
}
