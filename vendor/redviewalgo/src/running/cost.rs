//! Modèle pente → effort pour la course à pied et la marche rapide.
//!
//! Sources :
//! - modèle de pente d'Ultrapacer (même forme que la GAP fondée sur la
//!   fréquence cardiaque de Strava, Robb 2017) : effort relatif
//!   `f(g) = 1 + 0.034·g + 0.0021·g²`, g en %, ajusté sur −22 %…+16 %. Il
//!   crédite bien moins les descentes que la courbe métabolique de Minetti
//!   (2002), ce qui correspond à ce que les coureurs tiennent réellement dans
//!   les vraies descentes.
//! - Minetti et al. 2002 / Giovanelli et al. 2016 : au-delà de ~15 %, marcher
//!   coûte autant que courir, donc les montées raides se font en marche
//!   rapide à une vitesse verticale.
//! - Polynôme de perte de VO₂max avec l'altitude (jumeau numérique du trail, Sensors 2026).

/// Domaine de validité de l'ajustement Ultrapacer (pente en %).
const EFFORT_MIN_GRADE_PCT: f64 = -22.0;
const EFFORT_MAX_GRADE_PCT: f64 = 16.0;

/// Vitesse horizontale maximale tenable en marche rapide (m/s) ≈ 6 km/h.
pub const MAX_WALK_SPEED_MS: f64 = 6.0 / 3.6;

fn effort_poly(g: f64) -> f64 {
    1.0 + 0.034 * g + 0.0021 * g * g
}

fn effort_slope(g: f64) -> f64 {
    0.034 + 0.0042 * g
}

/// Effort relatif de la course à `grade_pct` par rapport au plat (1,0 sur le
/// plat). Hors du domaine ajusté, la courbe continue le long de sa tangente
/// pour rester monotone des deux côtés.
pub fn effort_factor(grade_pct: f64) -> f64 {
    let f = if grade_pct < EFFORT_MIN_GRADE_PCT {
        effort_poly(EFFORT_MIN_GRADE_PCT)
            + effort_slope(EFFORT_MIN_GRADE_PCT) * (grade_pct - EFFORT_MIN_GRADE_PCT)
    } else if grade_pct > EFFORT_MAX_GRADE_PCT {
        effort_poly(EFFORT_MAX_GRADE_PCT)
            + effort_slope(EFFORT_MAX_GRADE_PCT) * (grade_pct - EFFORT_MAX_GRADE_PCT)
    } else {
        effort_poly(grade_pct)
    };
    f.max(0.5)
}

/// Vitesse horizontale (m/s) d'une marche rapide qui tient `vam_mh` mètres de
/// montée par heure, plafonnée à une allure de marche soutenue.
pub fn walk_speed_ms(grade_pct: f64, vam_mh: f64) -> f64 {
    if grade_pct <= 0.5 {
        return MAX_WALK_SPEED_MS;
    }
    let vertical_ms = vam_mh / 3600.0;
    (vertical_ms / (grade_pct / 100.0)).min(MAX_WALK_SPEED_MS)
}

/// Perte de capacité aérobie avec l'altitude (fraction de la performance au niveau de la mer).
pub fn altitude_factor(altitude_m: f64) -> f64 {
    let a = altitude_m.max(0.0);
    (1.0 - 11.7e-9 * a * a - 4.01e-6 * a).clamp(0.7, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_is_one_on_flat_and_grows_uphill() {
        assert!((effort_factor(0.0) - 1.0).abs() < 1e-9);
        assert!(effort_factor(10.0) > effort_factor(5.0));
        assert!(effort_factor(30.0) > effort_factor(16.0));
    }

    #[test]
    fn descents_have_a_sweet_spot_then_get_harder() {
        assert!(effort_factor(-8.0) < 1.0);
        assert!(effort_factor(-30.0) > effort_factor(-15.0));
    }
}
