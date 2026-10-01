//! État physiologique le long de la simulation : échauffement, fatigue
//! d'endurance (ultra), creux circadien.
//!
//! Le moteur ne connaît pas les pauses : son horloge est le temps de
//! déplacement. Les données de référence (5 jours de bikepacking) ne montrent
//! aucune baisse de forme dans la journée : la fatigue d'endurance ne commence
//! qu'après `endurance_onset_h` heures de selle.

use crate::cycling::params::ModelParams;
use crate::cycling::rider::RiderModel;

#[derive(Debug, Clone)]
pub struct Physio {
    /// Temps de déplacement depuis le départ (s).
    pub clock_s: f64,
    /// Heures d'éveil (pour la dette de sommeil), départ ≈ 1 h après le réveil.
    pub awake_h: f64,
}

impl Default for Physio {
    fn default() -> Self {
        Self { clock_s: 0.0, awake_h: 1.0 }
    }
}

impl Physio {
    pub fn warmup_factor(&self, r: &RiderModel, p: &ModelParams) -> f64 {
        let tau = (p.warmup_tau_min * 60.0).max(1.0);
        1.0 - r.warmup_amp.clamp(0.0, 0.5) * (-self.clock_s / tau).exp()
    }

    pub fn endurance_factor(&self, r: &RiderModel, p: &ModelParams) -> f64 {
        let over = (self.clock_s / 3600.0 - p.endurance_onset_h).max(0.0);
        1.0 - r.endurance_amp.clamp(0.0, 0.8) * (1.0 - (-over / p.endurance_tau_h.max(0.1)).exp())
    }

    pub fn circadian_factor(&self, p: &ModelParams, start_time_h: Option<f64>) -> f64 {
        let Some(start) = start_time_h else { return 1.0 };
        let hour = (start + self.clock_s / 3600.0).rem_euclid(24.0);
        let dip = (p.circadian_dip + p.circadian_debt_per_h * (self.awake_h - 16.0).max(0.0))
            .min(p.circadian_max_dip);
        if hour < 6.5 {
            let phase = std::f64::consts::PI * (hour - 3.25) / 3.25;
            1.0 - dip * 0.5 * (1.0 + phase.cos())
        } else if hour > 22.0 {
            let phase = std::f64::consts::PI * (hour - 22.0) / 5.25;
            1.0 - dip * 0.5 * (1.0 - phase.cos())
        } else {
            1.0
        }
    }

    pub fn factor(&self, r: &RiderModel, p: &ModelParams, start_time_h: Option<f64>) -> f64 {
        self.warmup_factor(r, p) * self.endurance_factor(r, p) * self.circadian_factor(p, start_time_h)
    }

    pub fn ride(&mut self, dt_s: f64) {
        self.clock_s += dt_s;
        self.awake_h += dt_s / 3600.0;
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;
    use crate::cycling::presets::preset;
    use crate::types::Gender;

    #[test]
    fn no_endurance_loss_on_a_day_ride() {
        let r = preset("intermediaire", Gender::Female);
        let p = ModelParams::default();
        let mut s = Physio::default();
        s.ride(5.0 * 3600.0);
        assert!((s.endurance_factor(&r, &p) - 1.0).abs() < 1e-12);
        assert!(s.warmup_factor(&r, &p) > 0.999);
    }

    #[test]
    fn endurance_fatigue_grows_on_ultra_rides() {
        let r = preset("intermediaire", Gender::Female);
        let p = ModelParams::default();
        let mut s = Physio::default();
        s.ride(12.0 * 3600.0);
        let at12 = s.endurance_factor(&r, &p);
        s.ride(12.0 * 3600.0);
        let at24 = s.endurance_factor(&r, &p);
        assert!(at12 < 1.0 && at24 < at12, "{at12} {at24}");
    }

    #[test]
    fn night_dip_only_with_start_time() {
        let p = ModelParams::default();
        let mut s = Physio::default();
        assert_eq!(s.circadian_factor(&p, None), 1.0);
        s.clock_s = 18.0 * 3600.0; // départ 10 h → 4 h du matin
        s.awake_h = 19.0;
        let f = s.circadian_factor(&p, Some(10.0));
        assert!(f < 0.95, "{f}");
    }
}
