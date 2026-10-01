//! État physiologique le long de la simulation : échauffement, fatigue
//! d'endurance (ultra).
//!
//! Le moteur ne connaît pas les pauses : son horloge est le temps de
//! déplacement. Les données de référence (5 jours de bikepacking) ne montrent
//! aucune baisse de forme dans la journée : la fatigue d'endurance ne commence
//! qu'après `endurance_onset_h` heures de selle. Pas de creux nocturne : sans
//! les pauses (sommeil compris, posées par le planning de l'app), l'heure de
//! déplacement ne dit pas l'heure qu'il est.

use crate::cycling::params::ModelParams;
use crate::cycling::rider::RiderModel;

#[derive(Debug, Clone, Default)]
pub struct Physio {
    /// Temps de déplacement depuis le départ (s).
    pub clock_s: f64,
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

    pub fn factor(&self, r: &RiderModel, p: &ModelParams) -> f64 {
        self.warmup_factor(r, p) * self.endurance_factor(r, p)
    }

    pub fn ride(&mut self, dt_s: f64) {
        self.clock_s += dt_s;
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
}
