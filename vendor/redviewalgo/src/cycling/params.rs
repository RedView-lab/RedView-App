//! Constantes globales du modèle vélo v2, toutes surchargeables depuis JS
//! (`config.model_params`, objet partiel) pour que le banc de mesure puisse
//! les balayer sans recompiler.
//!
//! Index des tables :
//! - revêtement : 0 inconnu, 1 asphalte, 2 pavé/béton, 3 gravier, 4 terre, 5 sable
//! - rugosité (smoothness/tracktype) : 0 inconnue, 1 bonne, 2 moyenne, 3 mauvaise, 4 très mauvaise
//! - type de voie : 0 inconnu, 1 grand axe, 2 secondaire, 3 petite route,
//!   4 résidentiel/service, 5 piste cyclable, 6 chemin (track), 7 sentier/piéton

use serde::{Deserialize, Serialize};

pub const N_SURFACES: usize = 6;
pub const N_ROUGHNESS: usize = 5;
pub const N_WAYS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelParams {
    // ── Grille ──
    /// Pas de la grille de simulation (m).
    pub cell_m: f64,
    /// Pas utilisé au-delà de `long_route_m` (m).
    pub cell_long_m: f64,
    pub long_route_m: f64,
    /// Pas de la grille pendant la calibration (rejouée des dizaines de fois).
    pub calibration_cell_m: f64,

    // ── Altitude et pentes ──
    /// Écart-type du lissage gaussien de l'altitude (m), avant prise en compte
    /// de l'espacement des points source.
    pub ele_sigma_m: f64,
    /// Lissage minimal (m) par mètre de bruit d'altitude mesuré sur les points
    /// source (`course::ele_noise_m`) : MNT bruité → lissage plus large.
    pub ele_sigma_per_noise: f64,
    /// Demi-fenêtre du filtre médian anti-pics (m).
    pub ele_median_half_m: f64,
    /// Plafond du lissage quand les points source sont très espacés (m).
    pub ele_sigma_max_m: f64,
    /// Demi-fenêtre de la pente « moyenne » (confort de descente, marche).
    pub g_mid_half_m: f64,
    /// Demi-fenêtre de la pente de contexte (politique de puissance).
    pub g_ctx_half_m: f64,
    /// Demi-fenêtre de la pente soutenue qui décide de la marche.
    pub g_walk_half_m: f64,

    // ── Virages ──
    /// Tolérance Douglas-Peucker (m) : tracé planifié / trace GPS / inconnu.
    pub dp_tol_planned_m: f64,
    pub dp_tol_gps_m: f64,
    pub dp_tol_auto_m: f64,
    /// Lissage de position (σ, m) appliqué aux traces GPS avant simplification.
    pub gps_smooth_sigma_m: f64,
    /// Demi-jambe maximale comptée dans l'arc d'un virage isolé (m).
    pub corner_leg_cap_m: f64,
    /// Fenêtre de regroupement des sommets d'un même virage (m).
    pub corner_arc_window_m: f64,
    /// Déviation (°) à partir de laquelle un groupe de sommets est un vrai virage.
    pub corner_blend_lo_deg: f64,
    pub corner_blend_hi_deg: f64,
    pub corner_min_radius_m: f64,
    pub corner_max_radius_m: f64,
    /// Demi-base (m) de la confirmation du changement de cap d'un virage.
    pub corner_confirm_m: f64,

    // ── Revêtement ──
    /// Multiplicateur de Crr par revêtement.
    pub surface_crr: [f64; N_SURFACES],
    /// Multiplicateur de Crr par rugosité.
    pub rough_crr: [f64; N_ROUGHNESS],
    /// Facteur de vitesse de confort en descente par revêtement.
    pub surface_desc: [f64; N_SURFACES],
    pub rough_desc: [f64; N_ROUGHNESS],
    /// Facteur d'adhérence latérale en virage par revêtement.
    pub surface_alat: [f64; N_SURFACES],
    /// Décalage (points de %) du seuil de marche en montée par revêtement.
    pub walk_up_offset: [f64; N_SURFACES],
    pub rough_walk_up_offset: [f64; N_ROUGHNESS],
    /// Pente (|%|) au-delà de laquelle on descend à pied, par revêtement.
    pub walk_down_pct: [f64; N_SURFACES],
    pub rough_walk_down_offset: [f64; N_ROUGHNESS],

    // ── Contexte de route ──
    /// Vitesse maximale (km/h) par type de voie (≥ 99 = pas de plafond).
    pub way_vmax_kmh: [f64; N_WAYS],
    /// Vitesse de passage (km/h) au droit d'un feu / stop / ralentissement urbain.
    pub signal_kmh: f64,
    /// Vitesse maximale en agglomération (km/h, ≥ 99 = pas de plafond).
    pub urban_vmax_kmh: f64,
    /// Un ralentissement virtuel tous les N m en agglomération (0 = aucun).
    pub urban_slowdown_every_m: f64,

    // ── Marche ──
    /// Hystérésis (points de %) pour remonter en selle.
    pub walk_hysteresis_pct: f64,
    /// Facteur appliqué à la vitesse de Tobler quand on pousse le vélo.
    pub walk_push_factor: f64,
    pub walk_min_kmh: f64,
    /// En descente, marche si la vitesse de confort tombe sous ce seuil.
    pub walk_down_comfort_kmh: f64,
    /// Vitesse (km/h) sous laquelle le vélo ne tient plus : on pousse.
    pub stall_kmh: f64,

    // ── Physiologie ──
    pub warmup_tau_min: f64,
    /// Durée (h de déplacement) au-delà de laquelle l'allure baisse avec la
    /// durée prévue de l'effort, et exposant de cette baisse.
    pub pacing_ref_h: f64,
    pub pacing_exponent: f64,
    /// Durée (h) au-delà de laquelle l'allure ne baisse plus.
    pub pacing_max_h: f64,
    /// Heures de selle avant la fatigue d'endurance.
    pub endurance_onset_h: f64,
    pub endurance_tau_h: f64,

    // ── Intégration ──
    /// Vitesse au départ (m/s).
    pub start_speed_ms: f64,
    /// Masse équivalente des roues en rotation ajoutée à l'inertie (kg).
    pub m_eff_extra_kg: f64,
    /// Force de propulsion maximale, en fraction du poids (couple max).
    pub f_prop_max_weight_frac: f64,

    // ── Sortie ──
    pub output_min_spacing_m: f64,
    pub output_max_points: usize,
}

impl Default for ModelParams {
    fn default() -> Self {
        Self {
            cell_m: 10.0,
            cell_long_m: 20.0,
            long_route_m: 1_500_000.0,
            calibration_cell_m: 20.0,

            ele_sigma_m: 30.0,
            ele_sigma_per_noise: 75.0,
            ele_median_half_m: 40.0,
            ele_sigma_max_m: 150.0,
            g_mid_half_m: 60.0,
            g_ctx_half_m: 200.0,
            g_walk_half_m: 150.0,

            dp_tol_planned_m: 1.0,
            dp_tol_gps_m: 2.5,
            dp_tol_auto_m: 2.5,
            gps_smooth_sigma_m: 4.0,
            corner_leg_cap_m: 10.0,
            corner_arc_window_m: 40.0,
            corner_blend_lo_deg: 30.0,
            corner_blend_hi_deg: 60.0,
            corner_min_radius_m: 5.0,
            corner_max_radius_m: 3000.0,
            corner_confirm_m: 15.0,

            surface_crr: [1.15, 1.0, 1.6, 2.2, 3.2, 6.0],
            rough_crr: [1.0, 1.0, 1.15, 1.4, 1.8],
            surface_desc: [0.97, 1.0, 0.85, 0.72, 0.58, 0.42],
            rough_desc: [1.0, 1.0, 0.9, 0.75, 0.6],
            surface_alat: [0.95, 1.0, 0.85, 0.7, 0.6, 0.45],
            walk_up_offset: [0.0, 0.0, -2.0, -4.0, -6.0, -9.0],
            rough_walk_up_offset: [0.0, 0.0, -1.0, -3.0, -5.0],
            walk_down_pct: [99.0, 99.0, 30.0, 24.0, 18.0, 14.0],
            rough_walk_down_offset: [0.0, 0.0, -2.0, -5.0, -8.0],

            way_vmax_kmh: [99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0],
            signal_kmh: 99.0,
            urban_vmax_kmh: 99.0,
            urban_slowdown_every_m: 0.0,

            walk_hysteresis_pct: 2.0,
            walk_push_factor: 0.85,
            walk_min_kmh: 2.0,
            walk_down_comfort_kmh: 7.0,
            stall_kmh: 2.5,

            warmup_tau_min: 15.0,
            pacing_ref_h: 16.0,
            pacing_exponent: 0.2,
            pacing_max_h: 60.0,
            endurance_onset_h: 6.0,
            endurance_tau_h: 12.0,

            start_speed_ms: 1.5,
            m_eff_extra_kg: 1.5,
            f_prop_max_weight_frac: 0.45,

            output_min_spacing_m: 50.0,
            output_max_points: 6000,
        }
    }
}

impl ModelParams {
    pub fn surface_idx(code: u8) -> usize {
        (code as usize).min(N_SURFACES - 1)
    }
    pub fn rough_idx(code: u8) -> usize {
        (code as usize).min(N_ROUGHNESS - 1)
    }
    pub fn way_idx(code: u8) -> usize {
        (code as usize).min(N_WAYS - 1)
    }
}
