//! Modèle de cycliste du moteur v2 : quelques paramètres physiques et
//! comportementaux interprétables, communs aux préréglages et aux profils
//! calibrés sur .fit.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RiderModel {
    // ── Physique ──
    /// Masse totale cycliste + vélo + bagages (kg).
    pub mass_kg: f64,
    /// Masse du cycliste seul (affichage W/kg).
    pub rider_weight_kg: f64,
    /// Surface frontale × coefficient de traînée (m²).
    pub cda: f64,
    /// Résistance au roulement sur asphalte.
    pub crr: f64,
    pub drivetrain_eff: f64,

    // ── Politique de puissance ──
    /// Puissance tenue sur le plat (W).
    pub p_flat_w: f64,
    /// Rapport puissance en montée / plat une fois la pente « installée ».
    pub climb_ratio: f64,
    /// Pente (%) caractéristique de la montée en puissance (1 − e^(−g/g_sat)).
    pub climb_sat_pct: f64,
    /// Pente de descente (|%|) à laquelle on arrête de pédaler.
    pub free_pct: f64,

    // ── Descente ──
    /// Vitesse de confort à −1 % (km/h).
    pub desc_v1_kmh: f64,
    /// Gain de vitesse de confort par point de pente (km/h/%).
    pub desc_k_kmh_per_pct: f64,
    /// Plafond de vitesse en descente (km/h).
    pub desc_vmax_kmh: f64,
    /// Au-delà de cette pente (|%|), on freine davantage…
    pub desc_steep_from_pct: f64,
    /// …de tant de km/h par point de pente.
    pub desc_steep_drop_kmh_per_pct: f64,
    /// Accélération latérale tolérée en virage (m/s²).
    pub a_lat_ms2: f64,
    /// Décélération de freinage confortable (m/s²).
    pub a_dec_ms2: f64,

    // ── Marche ──
    /// Pente (%) sur asphalte au-delà de laquelle on pousse le vélo.
    pub walk_up_pct: f64,
    /// Vitesse sous laquelle on préfère marcher (km/h).
    pub v_min_ride_kmh: f64,

    // ── Physiologie ──
    /// Amplitude du déficit d'échauffement (fraction de puissance).
    pub warmup_amp: f64,
    /// Amplitude maximale de la fatigue d'endurance (fraction de puissance).
    pub endurance_amp: f64,

    // ── Métadonnées ──
    /// FTP indicative (W) — affichage.
    pub ftp_w: f64,
    pub has_power: bool,
    /// Origine : `preset:<niveau>:<genre>`, `custom`, `fit`.
    pub source: String,
}

impl Default for RiderModel {
    fn default() -> Self {
        crate::cycling::presets::preset("intermediaire", crate::types::Gender::Unspecified)
    }
}

impl RiderModel {
    /// Puissance visée (W) selon la pente de contexte (%), avant physiologie.
    /// Continue : 0 % → P_plat, montée → P_plat·climb_ratio, descente → 0 à −free_pct.
    pub fn power_at(&self, g_ctx_pct: f64) -> f64 {
        if g_ctx_pct >= 0.0 {
            let sat = self.climb_sat_pct.max(0.05);
            self.p_flat_w * (1.0 + (self.climb_ratio - 1.0) * (1.0 - (-g_ctx_pct / sat).exp()))
        } else {
            let free = self.free_pct.max(0.1);
            self.p_flat_w * (1.0 + g_ctx_pct / free).max(0.0)
        }
    }

    /// Vitesse de confort en descente (km/h) sur asphalte, sans virage.
    /// `None` au-dessus de −1 % (pas de plafond de confort).
    pub fn comfort_kmh(&self, g_mid_pct: f64) -> Option<f64> {
        if g_mid_pct >= -1.0 {
            return None;
        }
        let steep = -g_mid_pct;
        let mut v = (self.desc_v1_kmh + self.desc_k_kmh_per_pct * (steep - 1.0)).min(self.desc_vmax_kmh);
        if steep > self.desc_steep_from_pct {
            v -= self.desc_steep_drop_kmh_per_pct * (steep - self.desc_steep_from_pct);
        }
        Some(v.max(6.0))
    }

    pub fn wkg(&self) -> f64 {
        if self.rider_weight_kg > 0.0 { self.ftp_w / self.rider_weight_kg } else { 0.0 }
    }
}

/// Surcharge partielle d'un modèle (banc de mesure, saisie avancée).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RiderOverride {
    pub mass_kg: Option<f64>,
    pub cda: Option<f64>,
    pub crr: Option<f64>,
    pub p_flat_w: Option<f64>,
    pub climb_ratio: Option<f64>,
    pub climb_sat_pct: Option<f64>,
    pub free_pct: Option<f64>,
    pub desc_v1_kmh: Option<f64>,
    pub desc_k_kmh_per_pct: Option<f64>,
    pub desc_vmax_kmh: Option<f64>,
    pub desc_steep_from_pct: Option<f64>,
    pub desc_steep_drop_kmh_per_pct: Option<f64>,
    pub a_lat_ms2: Option<f64>,
    pub a_dec_ms2: Option<f64>,
    pub walk_up_pct: Option<f64>,
    pub v_min_ride_kmh: Option<f64>,
    pub warmup_amp: Option<f64>,
    pub endurance_amp: Option<f64>,
}

impl RiderOverride {
    pub fn apply(&self, m: &mut RiderModel) {
        macro_rules! set {
            ($($f:ident),*) => { $( if let Some(v) = self.$f { if v.is_finite() { m.$f = v; } } )* };
        }
        set!(
            mass_kg, cda, crr, p_flat_w, climb_ratio, climb_sat_pct, free_pct, desc_v1_kmh,
            desc_k_kmh_per_pct, desc_vmax_kmh, desc_steep_from_pct, desc_steep_drop_kmh_per_pct,
            a_lat_ms2, a_dec_ms2, walk_up_pct, v_min_ride_kmh, warmup_amp, endurance_amp
        );
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use crate::types::Gender;

    #[test]
    fn power_policy_is_continuous_and_monotone() {
        let r = crate::cycling::presets::preset("intermediaire", Gender::Female);
        let at0 = r.power_at(0.0);
        assert!((r.power_at(1e-6) - at0).abs() < 1e-3);
        assert!((r.power_at(-1e-6) - at0).abs() < 1e-3);
        let mut prev = r.power_at(-10.0);
        for i in -99..150 {
            let p = r.power_at(i as f64 / 10.0);
            assert!(p + 1e-9 >= prev, "non monotone at {i}");
            prev = p;
        }
        assert_eq!(r.power_at(-r.free_pct - 0.5), 0.0);
        assert!(r.power_at(15.0) <= r.p_flat_w * r.climb_ratio + 1e-9);
    }

    #[test]
    fn comfort_speed_saturates_then_drops_on_steep() {
        let r = crate::cycling::presets::preset("intermediaire", Gender::Female);
        assert!(r.comfort_kmh(0.0).is_none());
        let v4 = r.comfort_kmh(-4.0).unwrap();
        let v8 = r.comfort_kmh(-8.0).unwrap();
        let v20 = r.comfort_kmh(-20.0).unwrap();
        assert!(v8 >= v4);
        assert!(v20 < v8);
        assert!(v8 <= r.desc_vmax_kmh + 1e-9);
    }
}
