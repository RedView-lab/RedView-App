//! Rythme circadien (course à pied). Le moteur vélo v2 a sa propre physiologie
//! (`cycling::physio`).

use crate::types::SleepStrategy;


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

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

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
}
