//! Préréglages de niveau (débutant → expert) du moteur v2 : source unique,
//! la table TS n'existe plus.
//!
//! Ce sont des jeux de paramètres « effectifs » : ils reproduisent des
//! vitesses de déplacement réelles (vélo de voyage / bikepacking courant chez
//! les utilisateurs de RedView), pas une FTP de laboratoire. Ancrages : la
//! cycliste de référence du banc (Cham→Paris) calibrée sur ses .fit est plus
//! rapide qu'« intermédiaire » et plus lente qu'« avancé » ; débutant
//! nettement plus lent ; GT20 (593 km, ~9 800 m D+) d'une traite ≈ 48 h en
//! débutant, ≈ 21 h en expert ; progression monotone sur le plat, en montée et
//! en descente.

use crate::cycling::rider::RiderModel;
use crate::types::Gender;

struct LevelSpec {
    /// Puissance tenue sur le plat (W) pour une cycliste de 56 kg.
    p_flat_female_w: f64,
    climb_ratio: f64,
    climb_sat_pct: f64,
    free_pct: f64,
    cda_female: f64,
    crr: f64,
    /// Masse vélo + bagages (kg).
    bike_kg: f64,
    desc_v1_kmh: f64,
    desc_k_kmh_per_pct: f64,
    desc_vmax_kmh: f64,
    desc_steep_drop_kmh_per_pct: f64,
    a_lat_ms2: f64,
    a_dec_ms2: f64,
    walk_up_pct: f64,
    v_min_ride_kmh: f64,
    warmup_amp: f64,
    endurance_amp: f64,
}

fn level_spec(level: &str) -> LevelSpec {
    // Structure observée chez la cycliste de référence (calibration .fit) : peu
    // de puissance sur le plat, nettement plus en montée (≈ ×1,9), descentes
    // franches mais plafonnées. Les autres niveaux en sont des déclinaisons,
    // bornées par des références publiques (temps de cols par niveau, vitesses
    // sur le plat, records d'ultra : voir script-test-bench/pace-accuracy).
    match level {
        "debutant" => LevelSpec {
            p_flat_female_w: 62.0,
            climb_ratio: 2.0,
            climb_sat_pct: 1.2,
            free_pct: 3.0,
            cda_female: 0.42,
            crr: 0.0060,
            bike_kg: 17.0,
            desc_v1_kmh: 24.0,
            desc_k_kmh_per_pct: 1.3,
            desc_vmax_kmh: 36.0,
            desc_steep_drop_kmh_per_pct: 1.2,
            a_lat_ms2: 1.9,
            a_dec_ms2: 1.6,
            walk_up_pct: 14.0,
            v_min_ride_kmh: 5.0,
            warmup_amp: 0.06,
            endurance_amp: 0.40,
        },
        "avance" => LevelSpec {
            p_flat_female_w: 110.0,
            climb_ratio: 1.95,
            climb_sat_pct: 1.2,
            free_pct: 3.0,
            cda_female: 0.36,
            crr: 0.0050,
            bike_kg: 14.0,
            desc_v1_kmh: 33.0,
            desc_k_kmh_per_pct: 2.0,
            desc_vmax_kmh: 52.0,
            desc_steep_drop_kmh_per_pct: 0.8,
            a_lat_ms2: 3.0,
            a_dec_ms2: 2.5,
            walk_up_pct: 20.0,
            v_min_ride_kmh: 4.0,
            warmup_amp: 0.05,
            endurance_amp: 0.35,
        },
        "expert" => LevelSpec {
            p_flat_female_w: 148.0,
            climb_ratio: 1.9,
            climb_sat_pct: 1.2,
            free_pct: 3.0,
            cda_female: 0.32,
            crr: 0.0045,
            bike_kg: 12.0,
            desc_v1_kmh: 36.0,
            desc_k_kmh_per_pct: 2.3,
            desc_vmax_kmh: 58.0,
            desc_steep_drop_kmh_per_pct: 0.6,
            a_lat_ms2: 3.6,
            a_dec_ms2: 3.0,
            walk_up_pct: 22.0,
            v_min_ride_kmh: 3.5,
            warmup_amp: 0.04,
            endurance_amp: 0.35,
        },
        // "intermediaire" et toute valeur inconnue : un peu en dessous de la
        // cycliste de référence.
        _ => LevelSpec {
            p_flat_female_w: 72.0,
            climb_ratio: 1.95,
            climb_sat_pct: 1.2,
            free_pct: 3.0,
            cda_female: 0.40,
            crr: 0.0055,
            bike_kg: 16.0,
            desc_v1_kmh: 29.0,
            desc_k_kmh_per_pct: 1.7,
            desc_vmax_kmh: 44.0,
            desc_steep_drop_kmh_per_pct: 1.0,
            a_lat_ms2: 2.5,
            a_dec_ms2: 2.0,
            walk_up_pct: 17.0,
            v_min_ride_kmh: 4.5,
            warmup_amp: 0.06,
            endurance_amp: 0.35,
        },
    }
}

pub fn normalize_level(level: &str) -> &'static str {
    match level.trim().to_lowercase().as_str() {
        "debutant" | "débutant" | "beginner" => "debutant",
        "avance" | "avancé" | "advanced" => "avance",
        "expert" => "expert",
        _ => "intermediaire",
    }
}

/// Modèle effectif d'un niveau. Genre non précisé = gabarit masculin moyen
/// (70 kg) : plus de puissance absolue et un peu plus de traînée.
pub fn preset(level: &str, gender: Gender) -> RiderModel {
    let level = normalize_level(level);
    let s = level_spec(level);
    let (rider_kg, power_scale, cda_scale) = match gender {
        Gender::Female => (56.0, 1.0, 1.0),
        _ => (70.0, 1.25, 1.06),
    };
    let p_flat = s.p_flat_female_w * power_scale;
    RiderModel {
        mass_kg: rider_kg + s.bike_kg,
        rider_weight_kg: rider_kg,
        cda: s.cda_female * cda_scale,
        crr: s.crr,
        drivetrain_eff: 0.97,
        p_flat_w: p_flat,
        climb_ratio: s.climb_ratio,
        climb_sat_pct: s.climb_sat_pct,
        free_pct: s.free_pct,
        desc_v1_kmh: s.desc_v1_kmh,
        desc_k_kmh_per_pct: s.desc_k_kmh_per_pct,
        desc_vmax_kmh: s.desc_vmax_kmh,
        desc_steep_from_pct: 10.0,
        desc_steep_drop_kmh_per_pct: s.desc_steep_drop_kmh_per_pct,
        a_lat_ms2: s.a_lat_ms2,
        a_dec_ms2: s.a_dec_ms2,
        walk_up_pct: s.walk_up_pct,
        v_min_ride_kmh: s.v_min_ride_kmh,
        warmup_amp: s.warmup_amp,
        endurance_amp: s.endurance_amp,
        // FTP indicative (affichage) : montées tenues à ≈ 85 % de la FTP.
        ftp_w: (p_flat * s.climb_ratio / 0.85).round(),
        has_power: false,
        source: format!(
            "preset:{level}:{}",
            match gender {
                Gender::Female => "female",
                Gender::Male => "male",
                Gender::Unspecified => "default",
            }
        ),
    }
}

/// Profil « Personnalisé » sans .fit : part du niveau choisi (intermédiaire par
/// défaut) puis applique ce que l'utilisateur a saisi.
pub fn custom(level: Option<&str>, gender: Gender, ftp_w: Option<f64>, mass_kg: Option<f64>, tires_mm: Option<f64>) -> RiderModel {
    let mut m = preset(level.unwrap_or("intermediaire"), gender);
    if let Some(mass) = mass_kg.filter(|v| v.is_finite() && *v > 30.0 && *v < 250.0) {
        m.mass_kg = mass;
    }
    if let Some(mm) = tires_mm.filter(|v| v.is_finite() && *v > 15.0 && *v < 130.0) {
        // 25-28 mm route ≈ 0,0047 ; 35 mm ≈ 0,0051 ; 45-50 mm gravel ≈ 0,0057.
        m.crr = 0.0035 + mm * 0.000045;
    }
    if let Some(ftp) = ftp_w.filter(|v| v.is_finite() && *v > 50.0 && *v < 600.0) {
        // Endurance sur le plat ≈ 55 % FTP, montées tenues ≈ 85 % FTP.
        m.ftp_w = ftp;
        m.p_flat_w = 0.55 * ftp;
        m.climb_ratio = 0.85 / 0.55;
        m.has_power = true;
    }
    m.source = "custom".to_string();
    m
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn levels_are_ordered() {
        let levels = ["debutant", "intermediaire", "avance", "expert"];
        for g in [Gender::Female, Gender::Unspecified] {
            for w in levels.windows(2) {
                let a = preset(w[0], g);
                let b = preset(w[1], g);
                assert!(b.p_flat_w / b.cda > a.p_flat_w / a.cda);
                assert!(b.p_flat_w * b.climb_ratio / b.mass_kg > a.p_flat_w * a.climb_ratio / a.mass_kg);
                assert!(b.desc_vmax_kmh > a.desc_vmax_kmh);
                assert!(b.a_lat_ms2 > a.a_lat_ms2);
            }
        }
    }

    #[test]
    fn unknown_level_is_intermediate() {
        assert_eq!(normalize_level("Intermédiaire"), "intermediaire");
        assert_eq!(normalize_level("whatever"), "intermediaire");
        assert_eq!(normalize_level("Débutant"), "debutant");
    }
}
