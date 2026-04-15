use crate::types::{FatigueModel, SleepStrategy, StopType};

/// Compute fatigue factor at time `elapsed_h`.
///
/// **Bi-exponential mode** (when fast/slow params are set):
///   factor(t) = floor + A·e^(−λ₁·t) + B·e^(−λ₂·t)
///   - Fast component (λ₁ ~0.3-1.0): neuromuscular fatigue, half-life 2-4h
///   - Slow component (λ₂ ~0.01-0.05): metabolic fatigue, half-life 10-30h
///   Based on Abbiss & Laursen 2005 (8 models of cycling fatigue).
///
/// **Single-exponential fallback** (short training data or legacy):
///   factor(t) = floor + (baseline − floor) · e^(−λ·t)
///
/// For ultra events (>24h), uses `ultra_floor` if available, which is typically
/// higher than the training-derived floor (ultra athletes sustain 60-70% FTP).
///
/// Never drops below floor — athletes reach a sustainable steady-state.
pub fn compute_fatigue_factor(fatigue: &FatigueModel, elapsed_h: f64) -> f64 {
    // Smooth transition from normal floor to ultra_floor between 18-30h
    // Avoids hard cutoff at 24h — riders transition gradually into ultra pacing
    let floor = if let Some(uf) = fatigue.ultra_floor {
        if elapsed_h > 30.0 {
            uf
        } else if elapsed_h > 18.0 {
            let blend = (elapsed_h - 18.0) / 12.0;
            fatigue.floor + (uf - fatigue.floor) * blend
        } else {
            fatigue.floor
        }
    } else {
        fatigue.floor
    };

    let factor = if let (Some(a), Some(l1), Some(b), Some(l2)) = (
        fatigue.fast_amplitude,
        fatigue.fast_lambda,
        fatigue.slow_amplitude,
        fatigue.slow_lambda,
    ) {
        // Bi-exponential: captures dual-phase fatigue dynamics
        floor + a * (-l1 * elapsed_h).exp() + b * (-l2 * elapsed_h).exp()
    } else {
        // Single-exponential fallback
        let baseline = fatigue.baseline;
        let lambda = fatigue.decay_lambda;
        floor + (baseline - floor) * (-lambda * elapsed_h).exp()
    };

    // Safety: never below floor, never above baseline at t=0
    factor.max(floor)
}

/// Circadian rhythm performance factor with multi-night sleep debt compounding.
/// Models the well-established 5-15% performance dip between 2-6 AM.
/// Based on Halson 2014, Atkinson & Reilly 1996, Van Dongen et al. 2003.
///
/// For multi-day events, sleep debt compounds across nights:
///   - Night 1: base dip (~8%)
///   - Night 2: base dip × 1.32 (~10.6%) — cumulative cognitive impairment
///   - Night 3: base dip × 1.72 (~13.7%)
///
/// `sleep_strategy` modulates severity:
///   - MicroNaps: 70% of full debt (rider takes 10-20min naps)
///   - SleepStops: 50% of full debt (rider sleeps 60-90min blocks)
///   - None: full sleep debt effect
pub fn circadian_factor(
    start_time_h: f64,
    elapsed_h: f64,
    sleep_strategy: &SleepStrategy,
) -> f64 {
    let hour = (start_time_h + elapsed_h) % 24.0;

    // Count how many complete nights have passed (0-indexed)
    let night_count = (elapsed_h / 24.0).floor() as u32;

    // Base dip at nadir (3-4 AM)
    let base_dip = 0.08;

    // Sleep debt compounding: polynomial growth (Van Dongen et al. 2003)
    // Reduced coefficient: RAAM data shows sleep deprivation is self-limiting
    // (riders forced to sleep when cognitive decline exceeds safe threshold)
    let debt_multiplier = if night_count > 0 {
        let raw_debt = 1.0 + 0.05 * (night_count as f64).powi(2);
        // Modulate by sleep strategy
        let strategy_factor = match sleep_strategy {
            SleepStrategy::None => 1.0,
            SleepStrategy::MicroNaps => 0.70,
            SleepStrategy::SleepStops => 0.50,
        };
        1.0 + (raw_debt - 1.0) * strategy_factor
    } else {
        1.0
    };

    // Cap maximum dip at 25% for ultra events (severely sleep-deprived athletes)
    // Research: ultra riders show 15-25% performance decline at nadir vs rested state
    let effective_dip = (base_dip * debt_multiplier).min(0.25);

    // Night window: performance dips between 0-6.5 AM
    if hour < 6.5 {
        let phase = std::f64::consts::PI * (hour - 3.25) / 3.25;
        let dip = effective_dip * (0.5 * (1.0 + phase.cos()));
        1.0 - dip
    } else if hour > 22.0 {
        // Late night ramp-down into the dip (22:00 → 00:00)
        let phase = std::f64::consts::PI * (hour - 22.0) / 5.25;
        let dip = effective_dip * (0.5 * (1.0 - phase.cos()));
        1.0 - dip
    } else {
        1.0
    }
}

/// Distance-based mechanical efficiency decay.
/// Models saddle fatigue, posture degradation, and repetitive strain.
/// Based on Knechtle et al. 2014 (RAAM riders: 15-20% total speed decline over 4800km)
/// and Matomäki et al. 2019 (cycling efficiency drops 1-3% over ultra-duration).
///
/// Important: this captures ONLY distance-specific mechanical degradation.
/// Time-dependent fatigue, glycogen, circadian etc are separate factors.
/// RAAM 15-20% is the total from ALL causes — mechanical alone is ~10-15%.
///
/// Returns factor in [0.85, 1.0]. Negligible for rides <200km.
pub fn distance_efficiency_factor(distance_km: f64) -> f64 {
    if distance_km < 200.0 {
        return 1.0;
    }
    // Sigmoidal decay: onset ~300km, inflection ~800km, floor 0.85
    // At 500km: ~4%, at 1000km: ~10%, at 1500km: ~13%, at 3000km+: ~15%
    let sigmoid = 1.0 / (1.0 + (-0.005 * (distance_km - 800.0)).exp());
    let decay = 0.15 * sigmoid;
    (1.0 - decay).clamp(0.85, 1.0)
}

/// Compute partial fatigue recovery after a rest stop.
/// Returns the adjusted fatigue factor after resting for `stop_minutes`.
///
/// Recovery is modulated by stop type:
/// - Micro (5min): negligible — only halts fatigue accumulation
/// - Extended (15min): partial neuromuscular recovery (Minett & Duffield 2014)
/// - Sleep (90min): significant recovery — 25-35% of headroom (Szot et al. 2025, ultra-cycling)
///
/// Recovery fraction also scales with how fatigued the rider is — more fatigued
/// riders have more headroom to recover.
pub fn fatigue_recovery_after_stop(
    fatigue_before: f64,
    stop_minutes: f64,
    floor: f64,
    stop_type: StopType,
) -> f64 {
    if stop_minutes < 5.0 {
        return fatigue_before; // micro-stop, no meaningful recovery
    }

    let headroom = 1.0 - fatigue_before;

    let recovery_frac = match stop_type {
        StopType::Micro => {
            // 5min stop: minimal recovery (~2-3% of headroom)
            0.03 * (stop_minutes / 10.0).min(1.0)
        }
        StopType::Extended => {
            // 15-30min stop: moderate recovery (~10-18% of headroom)
            0.15 * (stop_minutes / 20.0).min(1.2)
        }
        StopType::Sleep => {
            // 90min sleep: significant recovery (35-50% of headroom)
            // Based on ultra-cycling research: sleep stops restore meaningful performance
            // RAAM data shows riders recovering to near-fresh speeds after proper sleep
            let base = 0.35;
            let duration_bonus = 0.15 * ((stop_minutes - 60.0).max(0.0) / 30.0).min(1.0);
            (base + duration_bonus).min(0.50)
        }
        StopType::Mechanical => {
            // ~2min: negligible
            0.01
        }
    };

    let recovered = fatigue_before + headroom * recovery_frac;
    recovered.clamp(floor, 1.0)
}

/// Morning performance rebound after circadian dip.
/// Models the well-documented circadian peak between 10-12 AM (Halson 2014).
/// Returns a factor up to 1.04 (3-5% boost) during morning hours if
/// coming out of a night dip (i.e. multi-day event).
pub fn morning_rebound_factor(start_time_h: f64, elapsed_h: f64, night_count: u32) -> f64 {
    if night_count == 0 {
        return 1.0; // No night passed, no rebound
    }
    let hour = (start_time_h + elapsed_h) % 24.0;
    // Morning peak window: 9-13h, peak at 11h
    if (9.0..13.0).contains(&hour) {
        let phase = std::f64::consts::PI * (hour - 9.0) / 4.0;
        let boost = 0.04 * phase.sin(); // max 4% at 11h
        1.0 + boost
    } else {
        1.0
    }
}

/// Glycogen depletion factor.
/// Models progressive glycogen depletion and partial refueling at stops.
/// At race intensity, glycogen stores last ~2-3h (Coyle 1995, Rauch et al. 2005).
/// With proper fueling (60-90g carbs/h), depletion is much slower.
///
/// `glycogen_level`: 0.0 (depleted) to 1.0 (full). Caller tracks state.
/// Returns performance factor [0.85, 1.0].
pub fn glycogen_factor(glycogen_level: f64) -> f64 {
    let level = glycogen_level.clamp(0.0, 1.0);
    // Above 40%: negligible performance impact (well-fueled)
    if level > 0.4 {
        1.0 - 0.04 * (1.0 - level) // very mild: 0-2.4% penalty
    } else {
        // Below 40%: moderate decline
        let penalty = 0.024 + 0.10 * ((0.4 - level) / 0.4); // 2.4-12.4% penalty
        (1.0 - penalty).max(0.85)
    }
}

/// Update glycogen level over a time step.
/// Depletion rate depends on intensity (gradient proxy: steeper = more glycolytic).
/// Assumes well-fueled rider with consistent on-bike nutrition.
///
/// The climbing factor now accounts for sustained climbing blocks: if the rider
/// has been climbing continuously, glycogen burns faster due to higher average
/// intensity and reduced ability to eat efficiently on steep gradients.
///
/// Returns new glycogen level after dt_h hours.
pub fn update_glycogen(
    current_level: f64,
    dt_h: f64,
    gradient_pct: f64,
    is_stopped: bool,
) -> f64 {
    if is_stopped {
        // Eating at stops: restore ~20% per hour stopped
        return (current_level + 0.20 * dt_h).min(1.0);
    }

    // Depletion rate: base 0.06/h for well-fueled rider with nutrition strategy
    // (~16h to bonk from full — realistic for riders eating 60-90g carbs/h)
    let base_rate = 0.06;

    // Climbing intensity factor: steeper = more glycolytic demand
    // Additionally, steep climbing reduces eating efficiency (harder to eat at >8% grade)
    let climb_factor = if gradient_pct > 5.0 {
        let excess = (gradient_pct - 5.0).min(12.0);
        1.0 + 0.08 * excess // up to 1.96x on 17%+ grades (increased from 0.06)
    } else if gradient_pct > 2.0 {
        // Mild climbing: moderate increase
        1.0 + 0.02 * (gradient_pct - 2.0) // up to 1.06x at 5%
    } else {
        1.0
    };

    // On-bike feeding efficiency: reduced when climbing hard (hard to eat at high intensity)
    let feeding_rate = if gradient_pct > 8.0 {
        0.030 // hard to eat on steep climbs (down from 0.045)
    } else if gradient_pct > 5.0 {
        0.038 // reduced eating efficiency
    } else {
        0.045 // normal on flats/mild gradients
    };

    // Low glycogen accelerates depletion (metabolic desperation — body burns
    // remaining stores faster as it dips below 30%)
    let low_glycogen_accel = if current_level < 0.3 {
        1.0 + 0.5 * (0.3 - current_level) / 0.3 // up to 1.5x faster depletion
    } else {
        1.0
    };

    let net_depletion = (base_rate * climb_factor * low_glycogen_accel - feeding_rate).max(0.0);
    (current_level - net_depletion * dt_h).max(0.0)
}

/// Thermal stress factor.
/// Heat and cold both degrade performance (Périard et al. 2015, Castellani & Young 2016).
/// Neutral zone: 10-20°C. Above 30°C: cardiac drift, below 5°C: vasoconstriction.
///
/// Returns factor [0.85, 1.0].
pub fn thermal_factor(ambient_temp_c: f64) -> f64 {
    if ambient_temp_c >= 10.0 && ambient_temp_c <= 20.0 {
        return 1.0; // thermoneutral zone
    }
    if ambient_temp_c > 20.0 {
        // Heat: ~2% per °C above 25°C, onset at 20°C (mild)
        let heat_penalty = if ambient_temp_c > 25.0 {
            0.02 * (ambient_temp_c - 25.0)
        } else {
            0.005 * (ambient_temp_c - 20.0)
        };
        (1.0 - heat_penalty).max(0.85)
    } else {
        // Cold: ~1% per °C below 5°C, mild effect 5-10°C
        let cold_penalty = if ambient_temp_c < 5.0 {
            0.01 * (5.0 - ambient_temp_c) + 0.02
        } else {
            0.004 * (10.0 - ambient_temp_c)
        };
        (1.0 - cold_penalty).max(0.85)
    }
}

/// Post-sleep inertia factor.
/// After waking from a sleep stop, performance is reduced for 15-30 min
/// (Tassi & Muzet 2000: sleep inertia lasts 15-60 min, worst in first 10 min).
///
/// `time_since_wake_h`: hours since waking from last sleep stop.
/// Returns factor [0.88, 1.0]. Only applies within first 0.5h of waking.
pub fn sleep_inertia_factor(time_since_wake_h: f64) -> f64 {
    if time_since_wake_h < 0.0 || time_since_wake_h > 0.5 {
        return 1.0;
    }
    // Exponential dissipation: 12% penalty at wake, halving every 10 min
    let penalty = 0.12 * (-time_since_wake_h * 6.0).exp(); // τ = 10min
    (1.0 - penalty).max(0.88)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FatigueModel;

    fn single_exp_model() -> FatigueModel {
        FatigueModel {
            decay_lambda: 0.1,
            baseline: 1.0,
            floor: 0.55,
            ultra_floor: None,
            fast_amplitude: None,
            fast_lambda: None,
            slow_amplitude: None,
            slow_lambda: None,
        }
    }

    fn biexp_model() -> FatigueModel {
        FatigueModel {
            decay_lambda: 0.05,
            baseline: 1.0,
            floor: 0.50,
            ultra_floor: None,
            fast_amplitude: Some(0.25),
            fast_lambda: Some(0.5),
            slow_amplitude: Some(0.25),
            slow_lambda: Some(0.02),
        }
    }

    #[test]
    fn test_fatigue_floor_never_breached() {
        let fatigue = single_exp_model();
        for h in 0..100 {
            let factor = compute_fatigue_factor(&fatigue, h as f64);
            assert!(
                factor >= fatigue.floor - 1e-10,
                "Fatigue factor {} at {}h should be >= floor {}",
                factor, h, fatigue.floor
            );
        }
    }

    #[test]
    fn test_fatigue_at_zero_is_baseline() {
        let fatigue = FatigueModel {
            decay_lambda: 0.05, baseline: 1.0, floor: 0.60, ultra_floor: None,
            fast_amplitude: None, fast_lambda: None,
            slow_amplitude: None, slow_lambda: None,
        };
        let factor = compute_fatigue_factor(&fatigue, 0.0);
        assert!((factor - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_fatigue_monotonically_decreasing() {
        let fatigue = FatigueModel {
            decay_lambda: 0.03, baseline: 1.0, floor: 0.55, ultra_floor: None,
            fast_amplitude: None, fast_lambda: None,
            slow_amplitude: None, slow_lambda: None,
        };
        let mut prev = compute_fatigue_factor(&fatigue, 0.0);
        for h in 1..50 {
            let cur = compute_fatigue_factor(&fatigue, h as f64);
            assert!(cur <= prev + 1e-12, "h={}: {} > prev {}", h, cur, prev);
            prev = cur;
        }
    }

    #[test]
    fn test_biexp_at_zero_is_one() {
        let fatigue = biexp_model();
        let factor = compute_fatigue_factor(&fatigue, 0.0);
        assert!((factor - 1.0).abs() < 1e-10, "At t=0: expected 1.0, got {factor}");
    }

    #[test]
    fn test_biexp_dual_phase_decay() {
        let fatigue = biexp_model();
        let f6 = compute_fatigue_factor(&fatigue, 6.0);
        let f24 = compute_fatigue_factor(&fatigue, 24.0);
        let f48 = compute_fatigue_factor(&fatigue, 48.0);

        assert!(f6 < 0.80, "At 6h: expected <0.80, got {f6}");
        assert!(f6 > 0.65, "At 6h: expected >0.65, got {f6}");
        assert!(f24 < f6, "24h should be lower than 6h");
        assert!(f24 > 0.60, "At 24h: expected >0.60, got {f24}");
        assert!(f48 > fatigue.floor - 0.01, "At 48h: should be near floor, got {f48}");
        assert!(f48 < f24, "48h should be lower than 24h");
    }

    #[test]
    fn test_biexp_floor_never_breached() {
        let fatigue = biexp_model();
        for h in 0..200 {
            let factor = compute_fatigue_factor(&fatigue, h as f64);
            assert!(
                factor >= fatigue.floor - 1e-10,
                "Bi-exp factor {} at {}h should be >= floor {}",
                factor, h, fatigue.floor
            );
        }
    }

    #[test]
    fn test_ultra_floor_used_after_24h() {
        let mut fatigue = single_exp_model();
        fatigue.ultra_floor = Some(0.65);
        let f_30 = compute_fatigue_factor(&fatigue, 30.0);
        assert!(f_30 >= 0.65 - 1e-10, "Ultra floor should apply at 30h, got {f_30}");
    }

    #[test]
    fn test_circadian_daytime_is_one() {
        let f = circadian_factor(10.0, 2.0, &SleepStrategy::None); // 12:00
        assert!((f - 1.0).abs() < 0.001, "Daytime should be ~1.0, got {f}");
    }

    #[test]
    fn test_circadian_night_dip() {
        let f = circadian_factor(22.0, 5.0, &SleepStrategy::None); // 03:00
        assert!(f < 0.96, "3 AM should dip below 0.96, got {f}");
        assert!(f > 0.88, "3 AM dip should be >0.88, got {f}");
    }

    #[test]
    fn test_circadian_multi_night_compounds() {
        // Night 1 dip vs Night 3 dip should be deeper
        let f_night1 = circadian_factor(22.0, 5.0, &SleepStrategy::None); // 3AM, night 1
        let f_night3 = circadian_factor(22.0, 53.0, &SleepStrategy::None); // 3AM, night 3
        assert!(f_night3 < f_night1, "Night 3 dip ({f_night3}) should be deeper than night 1 ({f_night1})");
    }

    #[test]
    fn test_circadian_sleep_stops_mitigates() {
        let f_none = circadian_factor(22.0, 53.0, &SleepStrategy::None);
        let f_sleep = circadian_factor(22.0, 53.0, &SleepStrategy::SleepStops);
        assert!(f_sleep > f_none, "Sleep stops ({f_sleep}) should mitigate dip vs none ({f_none})");
    }

    #[test]
    fn test_circadian_always_positive() {
        for start in 0..24 {
            for elapsed in 0..120 {
                let f = circadian_factor(start as f64, elapsed as f64, &SleepStrategy::None);
                assert!(f > 0.65 && f <= 1.001, "start={start}, elapsed={elapsed}: got {f}");
            }
        }
    }

    #[test]
    fn test_distance_efficiency_short_ride() {
        assert!((distance_efficiency_factor(50.0) - 1.0).abs() < 1e-10);
        assert!((distance_efficiency_factor(100.0) - 1.0).abs() < 0.001);
        assert!((distance_efficiency_factor(140.0) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_distance_efficiency_ultra() {
        let f500 = distance_efficiency_factor(500.0);
        let f1000 = distance_efficiency_factor(1000.0);
        let f2000 = distance_efficiency_factor(2000.0);
        assert!(f500 > 0.88 && f500 < 0.98, "500km: expected ~0.94, got {f500}");
        assert!(f1000 > 0.85 && f1000 < 0.93, "1000km: expected ~0.88, got {f1000}");
        assert!(f2000 > 0.85 && f2000 < 0.88, "2000km: expected ~0.86, got {f2000}");
        assert!(f1000 < f500, "1000km should be lower than 500km");
    }

    #[test]
    fn test_distance_efficiency_floor() {
        let f3000 = distance_efficiency_factor(3000.0);
        assert!(f3000 >= 0.85, "Should never go below 0.85, got {f3000}");
    }

    #[test]
    fn test_fatigue_recovery_after_extended_stop() {
        let recovered = fatigue_recovery_after_stop(0.55, 15.0, 0.50, StopType::Extended);
        assert!(recovered > 0.55, "Recovery should increase fatigue factor, got {recovered}");
        assert!(recovered < 0.70, "Recovery should be moderate, got {recovered}");
    }

    #[test]
    fn test_fatigue_recovery_sleep_stop() {
        let recovered = fatigue_recovery_after_stop(0.55, 90.0, 0.50, StopType::Sleep);
        assert!(recovered > 0.65, "Sleep recovery should be significant, got {recovered}");
        assert!(recovered < 0.85, "Sleep recovery should be bounded, got {recovered}");
    }

    #[test]
    fn test_fatigue_recovery_micro_stop_no_effect() {
        let recovered = fatigue_recovery_after_stop(0.55, 3.0, 0.50, StopType::Micro);
        assert!((recovered - 0.55).abs() < 1e-10, "Micro-stop should have no effect");
    }
}
