//! Rythme circadien (course à pied). Le moteur vélo v2 a sa propre physiologie
//! (`cycling::physio`).

use crate::types::SleepStrategy;


/// Facteur de performance du rythme circadien avec cumul de la dette de sommeil sur plusieurs nuits.
/// Modélise la baisse de performance bien établie de 5 à 15 % entre 2 h et 6 h.
/// D'après Halson 2014, Atkinson & Reilly 1996, Van Dongen et al. 2003.
///
/// Pour les épreuves de plusieurs jours, la dette de sommeil se cumule d'une nuit à l'autre :
///   - nuit 1 : baisse de base (~8 %)
///   - nuit 2 : baisse de base × 1,32 (~10,6 %) — dégradation cognitive cumulée
///   - nuit 3 : baisse de base × 1,72 (~13,7 %)
///
/// `sleep_strategy` module la sévérité :
///   - MicroNaps : 70 % de la dette complète (le cycliste fait des siestes de 10-20 min)
///   - SleepStops : 50 % de la dette complète (le cycliste dort par blocs de 60-90 min)
///   - None : effet complet de la dette de sommeil
pub fn circadian_factor(
    start_time_h: f64,
    elapsed_h: f64,
    sleep_strategy: &SleepStrategy,
) -> f64 {
    let hour = (start_time_h + elapsed_h) % 24.0;

    // Nombre de nuits complètes écoulées (à partir de 0)
    let night_count = (elapsed_h / 24.0).floor() as u32;

    // Baisse de base au creux (3-4 h)
    let base_dip = 0.08;

    // Cumul de la dette de sommeil : croissance polynomiale (Van Dongen et al. 2003)
    // Coefficient réduit : les données de la RAAM montrent que la privation de sommeil
    // s'autolimite (les coureurs sont forcés de dormir quand le déclin cognitif dépasse un seuil sûr)
    let debt_multiplier = if night_count > 0 {
        let raw_debt = 1.0 + 0.05 * (night_count as f64).powi(2);
        // Module selon la stratégie de sommeil
        let strategy_factor = match sleep_strategy {
            SleepStrategy::None => 1.0,
            SleepStrategy::MicroNaps => 0.70,
            SleepStrategy::SleepStops => 0.50,
        };
        1.0 + (raw_debt - 1.0) * strategy_factor
    } else {
        1.0
    };

    // Baisse maximale plafonnée à 25 % pour les épreuves d'ultra (athlètes en grave manque de sommeil)
    // Recherche : les ultra-cyclistes montrent 15 à 25 % de baisse de performance au creux face à l'état reposé
    let effective_dip = (base_dip * debt_multiplier).min(0.25);

    // Fenêtre de nuit : la performance baisse entre 0 h et 6 h 30
    if hour < 6.5 {
        let phase = std::f64::consts::PI * (hour - 3.25) / 3.25;
        let dip = effective_dip * (0.5 * (1.0 + phase.cos()));
        1.0 - dip
    } else if hour > 22.0 {
        // Descente en fin de soirée vers le creux (22:00 → 00:00)
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
        // La baisse de la nuit 3 doit être plus profonde que celle de la nuit 1
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
