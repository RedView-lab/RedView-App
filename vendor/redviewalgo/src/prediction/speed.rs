use crate::knn::{knn_predict_speed, KnnModel};

use crate::math::{
    air_density, altitude_power_factor, force_aero, force_gravity, force_rolling,
    gradient_adjusted_cda, solve_speed_from_power_with_efficiency,
};
use crate::prediction::descent::cap_descent_speed;
use crate::prediction::fatigue::{
    circadian_factor, compute_fatigue_factor, distance_efficiency_factor,
    fatigue_recovery_after_stop, glycogen_factor, morning_rebound_factor,
    sleep_inertia_factor, thermal_factor, update_glycogen,
};
use crate::prediction::surface::{surface_effective_crr, surface_speed_penalty};
use crate::profile::lookup_speed_for_gradient;
use crate::profile::gradient_bins::SplineBins;
use crate::types::{PredictionPoint, RiderProfile, Route, SleepStrategy, StopEvent};
use std::collections::VecDeque;

/// Maximum descent speed (m/s) ≈ 80 km/h
const MAX_DESCENT_SPEED_MS: f64 = 22.2;
/// Minimum speed (m/s) ≈ 3 km/h (very steep climb)
const MIN_SPEED_MS: f64 = 0.83;
/// Default speed fallback (m/s) ≈ 20 km/h
const FALLBACK_SPEED_MS: f64 = 5.56;

/// KNN/physics ensemble blending constant (base weight for KNN).
const KNN_BASE_WEIGHT: f64 = 0.7;

/// CdA multiplier for tuck position on descents (used in terminal velocity).
const CDA_TUCK_FACTOR: f64 = 0.80;

/// Reference climbing rate for climbing load (600m D+/30min = very hard sustained climbing).
/// This is the default; overridden dynamically if training data provides a better reference.
const CLIMBING_LOAD_REFERENCE_DEFAULT: f64 = 600.0;
/// Climbing load penalty coefficient (short-term).
const CLIMBING_LOAD_COEFF: f64 = 0.08;
/// Climbing load sliding window (seconds) — short-term (30min).
const CLIMBING_LOAD_WINDOW_S: f64 = 1800.0;
/// Long-term climbing load window (4h) — accumulated fatigue from repeated climbs.
const CLIMBING_LOAD_LONG_WINDOW_S: f64 = 14400.0;
/// Long-term climbing load reference (2500m D+/4h).
const CLIMBING_LOAD_LONG_REFERENCE_DEFAULT: f64 = 2500.0;
/// Long-term climbing load penalty coefficient (milder but persistent).
const CLIMBING_LOAD_LONG_COEFF: f64 = 0.06;
/// Recovery boost after descent (maximum 3% speed boost at start of new climb).
const RECOVERY_BOOST_MAX: f64 = 0.03;
/// Recovery boost decay half-life in seconds of climbing.
const RECOVERY_BOOST_HALFLIFE_S: f64 = 300.0;

/// Recovery boost decay half-life in seconds of riding after a stop.
const STOP_RECOVERY_HALFLIFE_S: f64 = 3600.0;
/// Distance efficiency partial recovery after a long stop (>30min).
const DIST_EFF_RECOVERY_PER_STOP: f64 = 0.02;

/// Combined micro-factor floor — prevents catastrophic stacking of independent
/// penalties (climbing load × distance eff × circadian × recovery).
/// Without this, 4 independent 10% penalties create a 35% total penalty.
/// Uses a smooth continuous curve based on total route distance.
fn combined_micro_factor_floor(total_route_km: f64) -> f64 {
    if total_route_km < 200.0 {
        1.0 // no floor for short rides
    } else {
        // Smooth sigmoid transition: 0.78 at 200km, converging to 0.55 at 3000km+
        // Allows real penalty stacking for ultra events
        let x = (total_route_km - 200.0) / 1000.0;
        let floor = 0.55 + 0.23 / (1.0 + x);
        floor.clamp(0.55, 0.78)
    }
}

/// Logistics efficiency factor for ultra-distance events.
/// Models the cumulative overhead of navigation, resupply, bike maintenance,
/// and general "off-bike" inefficiency that increases with distance.
///
/// Based on TCR/RAAM data: self-supported riders lose 5-12% of effective speed
/// purely to logistical overhead beyond what stop time captures.
///
/// Returns a factor in [0.88, 1.0]. Negligible under 300km.
fn logistics_efficiency_factor(distance_km: f64) -> f64 {
    if distance_km < 300.0 {
        return 1.0;
    }
    // Logarithmic decay: ~2.5% at 500km, ~5% at 1500km, ~7% at 3000km
    let penalty = 0.035 * (1.0 + (distance_km - 300.0) / 500.0).ln();
    (1.0 - penalty).clamp(0.88, 1.0)
}

/// Altitude × climbing interaction penalty.
///
/// Climbing at altitude is disproportionately harder than climbing at sea level:
/// - VO2max drops ~6% per 1000m above 1500m (already modeled by altitude_power_factor)
/// - But climbing EFFORT at altitude is compounded: lower O2 + high power demand
/// - Steeper gradients at altitude amplify this since climbing is intensity-limited
///
/// This factor represents the *additional* penalty beyond what altitude_power_factor
/// already captures — the interaction effect.
///
/// Returns a factor in [0.88, 1.0].
fn altitude_climbing_interaction(gradient_pct: f64, elevation_m: f64) -> f64 {
    if gradient_pct < 3.0 || elevation_m < 1200.0 {
        return 1.0;
    }
    // Scale with both gradient steepness and altitude
    let grad_intensity = ((gradient_pct - 3.0) / 10.0).min(1.0); // 0 at 3%, 1 at 13%+
    let alt_severity = ((elevation_m - 1200.0) / 2000.0).min(1.0); // 0 at 1200m, 1 at 3200m+
    let penalty = 0.12 * grad_intensity * alt_severity; // max 12% additional penalty
    (1.0 - penalty).clamp(0.88, 1.0)
}

/// Cumulative D+ fatigue factor.
///
/// Models progressive muscular damage from repeated climbing that is separate
/// from time-based fatigue. The eccentric muscle contractions during climbing
/// cause micro-damage that accumulates over the ride.
///
/// This is particularly significant for mountainous ultra events where total D+
/// exceeds 5000m. The penalty is proportional to cumulative climbing and
/// accelerates as total climb accumulates.
///
/// Returns a factor in [0.88, 1.0].
fn cumulative_dplus_fatigue(cum_climb_m: f64) -> f64 {
    if cum_climb_m < 2000.0 {
        return 1.0;
    }
    // Sigmoid-based fatigue onset at 2000m D+, converging to 0.88 at ~15000m+
    let x = (cum_climb_m - 2000.0) / 5000.0;
    let penalty = 0.12 * x / (1.0 + x); // approaches 0.12 asymptotically
    (1.0 - penalty).clamp(0.88, 1.0)
}

/// Route D+ intensity correction.
///
/// Compares the route's D+ per km against the rider's training D+ per km.
/// If the route is significantly more mountainous than what the rider trains on,
/// the prediction should be more conservative (the rider is outside their
/// comfort zone and will likely be slower than the model predicts).
///
/// Returns a factor in [0.90, 1.0]. No penalty if route is similar or easier
/// than training.
fn route_dplus_intensity_correction(
    route_dplus_per_km: f64,
    training_dplus_per_km: f64,
) -> f64 {
    if training_dplus_per_km < 1.0 {
        // No training data — can't compare; apply mild conservative penalty
        // if route is mountainous
        if route_dplus_per_km > 15.0 {
            return 0.96;
        }
        return 1.0;
    }
    let ratio = route_dplus_per_km / training_dplus_per_km;
    if ratio <= 1.2 {
        // Route is similar or easier than training
        1.0
    } else {
        // Route is harder: penalty scales with how far outside training range
        // ratio 1.5 → ~3% penalty, ratio 2.0 → ~5%, ratio 3.0 → ~8%
        let excess = ratio - 1.2;
        let penalty = 0.10 * excess / (1.0 + excess); // max 10%
        (1.0 - penalty).clamp(0.90, 1.0)
    }
}

/// Run a single prediction pass with per-point fatigue.
pub fn predict_single_pass(
    profile: &RiderProfile,
    route: &Route,
    knn: &mut KnnModel,
    mass_kg: f64,
    cda: f64,
    crr: f64,
    pacing: f64,
    drivetrain_eff: f64,
    start_time_h: Option<f64>,
    sleep_strategy: &SleepStrategy,
    race_mode: bool,
    stop_schedule: &[StopEvent],
    ambient_temperature_c: f64,
    gender_factor: f64,
) -> (Vec<PredictionPoint>, f64) {
    let n = route.points.len();
    let use_knn = knn.is_usable();
    let has_physics = profile.has_power && profile.ftp_w > 50.0;
    let mut pred_points: Vec<PredictionPoint> = Vec::with_capacity(n);
    let mut elapsed_s = 0.0_f64; // total wall-clock time including stops
    let mut riding_s = 0.0_f64; // pure riding time (excludes stops)
    let mut cum_climb_m = 0.0_f64;

    // Stop/recovery tracking
    let mut next_stop_idx = 0usize;
    let mut recovery_boost = 0.0_f64; // multiplicative boost from recent recovery
    let mut riding_since_last_stop_s = 0.0_f64; // riding time since last stop for boost decay
    let mut dist_eff_recovery = 0.0_f64; // cumulative distance efficiency recovery from stops

    // Use ultra_floor for floor reference in recovery calculations
    let fatigue_floor = profile.fatigue.ultra_floor.unwrap_or(profile.fatigue.floor);

    // Distance-based recent gradient window (500m)
    let mut recent_grads: VecDeque<(f64, f64)> = VecDeque::new();

    // Climbing load: sliding window of (elapsed_s, ele_gain) for recent climbing effort
    let mut climb_window: VecDeque<(f64, f64)> = VecDeque::new();
    // Long-term climbing load window (4h)
    let mut climb_window_long: VecDeque<(f64, f64)> = VecDeque::new();
    // Track descent duration for recovery boost
    let mut last_climb_end_s: f64 = 0.0;
    let mut is_climbing = false;
    // Track time spent climbing since last descent for recovery boost decay
    let mut climb_duration_since_recovery_s: f64 = 0.0;

    // Glycogen tracking: starts at 1.0 (full stores)
    let mut glycogen_level: f64 = 1.0;
    // Previous speed for gradient transition momentum smoothing
    let mut prev_speed_ms: f64 = FALLBACK_SPEED_MS;
    // Sleep inertia tracking: time since last sleep stop wake-up (hours)
    let mut time_since_wake_h: f64 = f64::MAX; // MAX = no recent sleep, no inertia
    // Ambient temperature from config
    let ambient_temp_c = ambient_temperature_c;

    // Pre-compute spline cache for gradient bins — avoids O(N) sort+rebuild per lookup
    let spline_bins = SplineBins::build(&profile.gradient_bins, &profile.fatigued_bins);

    // Hoist constant micro-factor floor out of loop
    let total_route_km = route.total_distance_m / 1000.0;
    let micro_floor = combined_micro_factor_floor(total_route_km);

    // ── Route D+ characterization ──
    // Compute route D+ per km for comparison against training
    let route_total_dplus: f64 = route.points.windows(2)
        .map(|w| (w[1].elevation_m - w[0].elevation_m).max(0.0))
        .sum();
    let route_dplus_per_km = if total_route_km > 0.0 {
        route_total_dplus / total_route_km
    } else {
        0.0
    };

    // Dynamic climbing load references based on training data
    // If training data shows rider's actual climbing rate, use that as reference
    // (harder reference = less penalty for a strong climber, and vice versa)
    let climbing_load_ref = if profile.training_avg_climb_rate_mh > 100.0 {
        // Training climb rate is in m/h; convert to m per 30min window
        (profile.training_avg_climb_rate_mh * 0.5).clamp(250.0, 900.0)
    } else {
        CLIMBING_LOAD_REFERENCE_DEFAULT
    };
    let climbing_load_long_ref = if profile.training_avg_climb_rate_mh > 100.0 {
        // 4h equivalent: sustained rate reduces with time
        (profile.training_avg_climb_rate_mh * 3.5).clamp(1500.0, 4000.0)
    } else {
        CLIMBING_LOAD_LONG_REFERENCE_DEFAULT
    };

    // Route vs training D+ intensity correction (constant for the whole route)
    let dplus_intensity_corr = route_dplus_intensity_correction(
        route_dplus_per_km,
        profile.training_dplus_per_km,
    );

    for i in 0..n {
        let rp = &route.points[i];
        let gradient_frac = rp.gradient_pct / 100.0;
        let segment_len = rp.segment_length_m;

        // Track cumulative climb
        if i > 0 {
            let ele_diff = rp.elevation_m - route.points[i - 1].elevation_m;
            if ele_diff > 0.0 {
                cum_climb_m += ele_diff;
            }
        }

        // Distance-based recent gradient context (500m window)
        recent_grads.push_back((rp.distance_m, rp.gradient_pct));
        let dist_cutoff = rp.distance_m - 500.0;
        while recent_grads.len() > 1 && recent_grads[0].0 < dist_cutoff {
            recent_grads.pop_front();
        }
        let recent_avg_gradient = if recent_grads.is_empty() {
            rp.gradient_pct
        } else {
            recent_grads.iter().map(|(_, g)| g).sum::<f64>() / recent_grads.len() as f64
        };

        let elapsed_h = elapsed_s / 3600.0;

        // ── Check for scheduled stops ──
        // Process any stops whose riding-time trigger has been reached
        while next_stop_idx < stop_schedule.len()
            && riding_s >= stop_schedule[next_stop_idx].riding_time_trigger_s
        {
            let stop = &stop_schedule[next_stop_idx];
            // Advance wall-clock time by stop duration (affects circadian/fatigue clock)
            elapsed_s += stop.duration_s;

            // Apply fatigue recovery
            let current_fatigue = compute_fatigue_factor(&profile.fatigue, elapsed_s / 3600.0);
            let recovered_fatigue = fatigue_recovery_after_stop(
                current_fatigue,
                stop.duration_s / 60.0,
                fatigue_floor,
                stop.stop_type,
            );
            recovery_boost = (recovered_fatigue - current_fatigue).max(0.0);
            riding_since_last_stop_s = 0.0;

            // Distance efficiency partial recovery for long stops (>30min)
            if stop.duration_s > 1800.0 {
                dist_eff_recovery = (dist_eff_recovery + DIST_EFF_RECOVERY_PER_STOP).min(0.08);
            }

            // Glycogen refuel during stops (eating at rest)
            glycogen_level = update_glycogen(glycogen_level, stop.duration_s / 3600.0, 0.0, true);

            // Track sleep inertia: if this was a sleep stop, reset wake timer
            if matches!(stop.stop_type, crate::types::StopType::Sleep) {
                time_since_wake_h = 0.0;
            }

            next_stop_idx += 1;
        }

        // Decay recovery boost exponentially with riding time since last stop
        let effective_recovery_boost = if recovery_boost > 0.001 {
            recovery_boost * (-riding_since_last_stop_s / STOP_RECOVERY_HALFLIFE_S).exp()
        } else {
            0.0
        };

        // Night count for morning rebound
        let night_count = (elapsed_h / 24.0).floor() as u32;
        let morning_factor = if let Some(start_h) = start_time_h {
            morning_rebound_factor(start_h, elapsed_h, night_count)
        } else {
            1.0
        };

        // Gradient-adjusted CdA (rider position changes with terrain)
        let effective_cda = gradient_adjusted_cda(cda, rp.gradient_pct);

        // Surface-adjusted Crr (gravel has higher rolling resistance)
        let effective_crr = surface_effective_crr(rp.surface_type, crr);

        // Altitude power reduction (VO2max loss at altitude)
        let alt_factor = altitude_power_factor(rp.elevation_m);

        // ── Climbing load micro-fatigue ──
        // Track recent elevation gain in a sliding time window
        let ele_gain_here = if i > 0 {
            let diff = rp.elevation_m - route.points[i - 1].elevation_m;
            if diff > 0.0 { diff } else { 0.0 }
        } else {
            0.0
        };

        if ele_gain_here > 0.0 {
            climb_window.push_back((elapsed_s, ele_gain_here));
            climb_window_long.push_back((elapsed_s, ele_gain_here));
        }
        // Evict old entries outside the short window
        let window_cutoff = elapsed_s - CLIMBING_LOAD_WINDOW_S;
        while !climb_window.is_empty() && climb_window[0].0 < window_cutoff {
            climb_window.pop_front();
        }
        // Evict old entries outside the long window
        let long_cutoff = elapsed_s - CLIMBING_LOAD_LONG_WINDOW_S;
        while !climb_window_long.is_empty() && climb_window_long[0].0 < long_cutoff {
            climb_window_long.pop_front();
        }
        let recent_climb_m: f64 = climb_window.iter().map(|(_, g)| g).sum();
        let long_climb_m: f64 = climb_window_long.iter().map(|(_, g)| g).sum();

        // Short-term climbing load penalty (30min window)
        let climbing_load_factor = if rp.gradient_pct > 2.0 && recent_climb_m > 10.0 {
            let load_ratio = recent_climb_m / climbing_load_ref;
            1.0 / (1.0 + CLIMBING_LOAD_COEFF * load_ratio)
        } else {
            1.0
        };

        // Long-term climbing load penalty (4h window) — accumulated fatigue from repeated climbs
        let long_climb_factor = if rp.gradient_pct > 2.0 && long_climb_m > 100.0 {
            let load_ratio = long_climb_m / climbing_load_long_ref;
            1.0 / (1.0 + CLIMBING_LOAD_LONG_COEFF * load_ratio)
        } else {
            1.0
        };

        // Distance-based mechanical efficiency decay (saddle fatigue, posture)
        let cum_distance_km = rp.distance_m / 1000.0;
        let dist_eff = distance_efficiency_factor(cum_distance_km);

        // Circadian rhythm factor (opt-in via start_time_h)
        let circadian = if let Some(start_h) = start_time_h {
            circadian_factor(start_h, elapsed_h, sleep_strategy)
        } else {
            1.0
        };

        // Recovery boost: slight speed increase at start of a new climb after descent
        let currently_climbing = rp.gradient_pct > 2.0;
        if currently_climbing && !is_climbing {
            // Just started climbing — reset recovery tracking
            climb_duration_since_recovery_s = 0.0;
        }
        if !currently_climbing && is_climbing {
            // Just ended a climb
            last_climb_end_s = elapsed_s;
        }
        is_climbing = currently_climbing;

        let recovery_factor = if currently_climbing && climb_duration_since_recovery_s < RECOVERY_BOOST_HALFLIFE_S * 3.0 {
            let descent_rest_s = if last_climb_end_s > 0.0 {
                (elapsed_s - last_climb_end_s).max(0.0) - climb_duration_since_recovery_s
            } else {
                0.0
            };
            if descent_rest_s > 60.0 {
                // Boost decays exponentially with climbing duration since recovery
                let boost = RECOVERY_BOOST_MAX * (-climb_duration_since_recovery_s / RECOVERY_BOOST_HALFLIFE_S).exp();
                1.0 + boost
            } else {
                1.0
            }
        } else {
            1.0
        };

        if currently_climbing {
            let segment_time_est = if segment_len > 0.01 && FALLBACK_SPEED_MS > 0.0 {
                segment_len / FALLBACK_SPEED_MS // rough estimate for tracking
            } else {
                1.0
            };
            climb_duration_since_recovery_s += segment_time_est;
        }

        // ── Compute speed via ensemble or fallback ──
        let (raw_speed_ms, point_knn_confidence) = if use_knn && has_physics {
            // Ensemble blending of KNN + Physics
            let knn_result = knn_predict_speed(
                knn,
                rp.gradient_pct,
                elapsed_h,
                cum_climb_m,
                recent_avg_gradient,
                rp.elevation_m,
                rp.distance_m,
            );

            let fatigue_factor = compute_fatigue_factor(&profile.fatigue, elapsed_h);
            let effective_power =
                profile.ftp_w * fatigue_factor * pacing * alt_factor;
            let physics_speed = solve_speed_from_power_with_efficiency(
                effective_power,
                mass_kg,
                gradient_frac,
                effective_cda,
                effective_crr,
                rp.elevation_m,
                drivetrain_eff,
            );

            // Adaptive blend: gradient + elapsed-time aware
            // Steep climbs (>6%): trust physics more (aero negligible)
            // Ultra-duration (>12h): rapidly decay KNN trust beyond training data
            let gradient_blend = if rp.gradient_pct > 6.0 {
                0.4
            } else {
                KNN_BASE_WEIGHT
            };

            let max_training_h = knn.max_elapsed_h();
            let ultra_shift = if elapsed_h > max_training_h && max_training_h > 0.5 {
                // Beyond training range: sigmoid decay to zero at 3× max training
                // Smoother than exponential — avoids sharp cliff at boundary
                let overshoot = elapsed_h - max_training_h;
                let max_overshoot = max_training_h * 2.0; // zero at 3× max
                let sigmoid = 1.0 / (1.0 + (6.0 * (overshoot / max_overshoot - 0.5)).exp());
                (gradient_blend * sigmoid).max(0.05)
            } else if elapsed_h > 12.0 {
                let shift = 0.12 * ((elapsed_h - 12.0) / 24.0).min(1.0);
                (gradient_blend - shift).max(0.35)
            } else {
                gradient_blend
            };
            let alpha = ultra_shift * knn_result.confidence;

            // Race mode: boost KNN speed slightly (race effort > training)
            let race_factor = if race_mode { 1.05 } else { 1.0 };

            let blended = alpha * knn_result.speed_ms * pacing * race_factor
                + (1.0 - alpha) * physics_speed;
            (blended, knn_result.confidence)
        } else if use_knn {
            // KNN only (no power data for physics)
            let knn_result = knn_predict_speed(
                knn,
                rp.gradient_pct,
                elapsed_h,
                cum_climb_m,
                recent_avg_gradient,
                rp.elevation_m,
                rp.distance_m,
            );

            // Improved extrapolation: use fatigue model ratio + exponential decay
            let max_training_h = knn.max_elapsed_h();
            let ultra_fatigue = if elapsed_h > max_training_h && max_training_h > 0.5 {
                let fatigue_at_now = compute_fatigue_factor(&profile.fatigue, elapsed_h);
                let fatigue_at_max = compute_fatigue_factor(&profile.fatigue, max_training_h);
                let fatigue_ratio = if fatigue_at_max > 0.01 {
                    fatigue_at_now / fatigue_at_max
                } else {
                    0.5
                };
                // Also decay KNN contribution by confidence
                let conf_decay = (-((elapsed_h - max_training_h) / 12.0)).exp();
                (fatigue_ratio * conf_decay).clamp(0.3, 1.0)
            } else {
                1.0
            };

            let race_factor = if race_mode { 1.05 } else { 1.0 };
            (knn_result.speed_ms * pacing * ultra_fatigue * race_factor, knn_result.confidence)
        } else if has_physics {
            // Physics-based fallback (has power but not enough KNN data)
            let fatigue_factor = compute_fatigue_factor(&profile.fatigue, elapsed_h);
            let effective_factor = fatigue_factor * pacing;
            let available_power = profile.ftp_w * effective_factor * alt_factor;
            let speed = solve_speed_from_power_with_efficiency(
                available_power,
                mass_kg,
                gradient_frac,
                effective_cda,
                effective_crr,
                rp.elevation_m,
                drivetrain_eff,
            );
            (speed, 0.0)
        } else {
            // Empirical gradient bins fallback — use blended fresh/fatigued bins
            let fatigue_factor = compute_fatigue_factor(&profile.fatigue, elapsed_h);
            let base_speed = if !profile.fatigued_bins.is_empty() {
                spline_bins.lookup_blended(
                    rp.gradient_pct,
                    elapsed_h,
                ).unwrap_or(FALLBACK_SPEED_MS)
            } else {
                lookup_speed_for_gradient(&profile.gradient_bins, rp.gradient_pct)
                    .unwrap_or(FALLBACK_SPEED_MS)
            };
            // Fix double-counting: fatigued bins already encode slower speeds due
            // to tiredness. Scale down the fatigue penalty proportionally to how
            // much we blend toward fatigued bins.
            let blend_ratio = if !profile.fatigued_bins.is_empty() {
                1.0 - (-elapsed_h / 8.0).exp() // exponential onset matching gradient_bins
            } else {
                0.0
            };
            let effective_fatigue = 1.0 - (1.0 - fatigue_factor) * (1.0 - blend_ratio * 0.6);
            let effective_factor = effective_fatigue * pacing;
            let race_factor = if race_mode { 1.05 } else { 1.0 };
            let adjusted = base_speed * effective_factor * race_factor;
            (adjusted.clamp(MIN_SPEED_MS, MAX_DESCENT_SPEED_MS), 0.0)
        };

        // Apply climbing load micro-fatigue, long-term climb fatigue,
        // distance efficiency decay, circadian, recovery boosts, and morning rebound
        let effective_dist_eff = (dist_eff + dist_eff_recovery).min(1.0);

        // Thermal stress factor
        let thermal = thermal_factor(ambient_temp_c);

        // Glycogen depletion factor
        let glycogen = glycogen_factor(glycogen_level);

        // Sleep inertia factor (post-wake penalty)
        let sleep_inertia = sleep_inertia_factor(time_since_wake_h);

        // Compute combined micro-factor with anti-stacking floor
        let logistics_eff = logistics_efficiency_factor(cum_distance_km);
        let surface_penalty = surface_speed_penalty(rp.surface_type, rp.gradient_pct);
        let alt_climb_interaction = altitude_climbing_interaction(rp.gradient_pct, rp.elevation_m);
        let cum_dplus_fatigue = cumulative_dplus_fatigue(cum_climb_m);
        let micro_combined = climbing_load_factor
            * long_climb_factor
            * effective_dist_eff
            * circadian
            * morning_factor
            * logistics_eff
            * surface_penalty
            * thermal
            * glycogen
            * sleep_inertia
            * alt_climb_interaction
            * cum_dplus_fatigue
            * dplus_intensity_corr;
        let micro_clamped = micro_combined.max(micro_floor);

        let raw_speed_ms = raw_speed_ms
            * micro_clamped
            * recovery_factor
            * (1.0 + effective_recovery_boost)
            * gender_factor;

        // Gradient transition momentum: smooth speed changes to model
        // real-world inertia (rider doesn't instantly change speed at gradient transitions).
        // Apply asymmetric smoothing: 80/20 for decelerations, no smoothing for accelerations.
        let momentum_speed = if raw_speed_ms < prev_speed_ms {
            // Decelerating (e.g. flat→climb): rider carries momentum
            0.8 * raw_speed_ms + 0.2 * prev_speed_ms
        } else {
            raw_speed_ms // Accelerating: no artificial boost
        };

        // Physics-based descent cap (terminal velocity + curvature + reaction)
        let cda_tuck = cda * CDA_TUCK_FACTOR;
        let capped_speed = cap_descent_speed(
            momentum_speed,
            rp.gradient_pct,
            elapsed_h,
            mass_kg,
            cda_tuck,
            crr,
            rp.elevation_m,
            rp.curvature_deg_per_km,
        );
        let speed_ms = capped_speed.clamp(MIN_SPEED_MS, MAX_DESCENT_SPEED_MS);

        // Time for this segment
        let segment_time = if segment_len > 0.01 {
            segment_len / speed_ms
        } else {
            0.0
        };

        // Update state for next iteration
        let segment_dt_h = segment_time / 3600.0;
        glycogen_level = update_glycogen(glycogen_level, segment_dt_h, rp.gradient_pct, false);
        time_since_wake_h += segment_dt_h;
        prev_speed_ms = speed_ms;

        // Power estimate for display
        let predicted_power = estimate_power_from_speed(
            speed_ms, mass_kg, gradient_frac, effective_cda, effective_crr, rp.elevation_m,
        );

        pred_points.push(PredictionPoint {
            distance_m: rp.distance_m,
            elevation_m: rp.elevation_m,
            gradient_pct: rp.gradient_pct,
            predicted_speed_kmh: speed_ms * 3.6,
            predicted_power_w: predicted_power.max(0.0),
            elapsed_time_s: elapsed_s,
            segment_time_s: segment_time,
            fatigue_factor: compute_fatigue_factor(&profile.fatigue, elapsed_h),
            circadian_factor: circadian,
            distance_eff_factor: effective_dist_eff,
            knn_confidence: point_knn_confidence,
            predicted_speed_low_kmh: 0.0,  // filled in by mod.rs after loop
            predicted_speed_high_kmh: 0.0, // filled in by mod.rs after loop
        });

        elapsed_s += segment_time;
        riding_s += segment_time;
        riding_since_last_stop_s += segment_time;
    }

    (pred_points, riding_s)
}

/// Estimate power from speed for display purposes.
fn estimate_power_from_speed(
    speed_ms: f64,
    mass_kg: f64,
    gradient_frac: f64,
    cda: f64,
    crr: f64,
    altitude_m: f64,
) -> f64 {
    let rho = air_density(altitude_m);
    let f_grav = force_gravity(mass_kg, gradient_frac);
    let f_aero = force_aero(cda, rho, speed_ms);
    let f_roll = force_rolling(crr, mass_kg, gradient_frac);
    (f_grav + f_aero + f_roll) * speed_ms
}
