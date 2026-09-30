//! Grade → effort model for running and power-hiking.
//!
//! Sources:
//! - Ultrapacer grade model (same shape as Strava's heart-rate based GAP,
//!   Robb 2017): relative effort `f(g) = 1 + 0.034·g + 0.0021·g²`, g in %,
//!   fitted on −22 %…+16 %. It gives far less credit to descents than the
//!   metabolic Minetti (2002) curve, which matches what runners can actually
//!   hold on real downhills.
//! - Minetti et al. 2002 / Giovanelli et al. 2016: above ~15 % walking is as
//!   cheap as running, so steep climbs are power-hiked at a vertical rate.
//! - Altitude VO₂max impairment polynomial (trail digital-twin, Sensors 2026).

/// Validity range of the Ultrapacer fit (grade %).
const EFFORT_MIN_GRADE_PCT: f64 = -22.0;
const EFFORT_MAX_GRADE_PCT: f64 = 16.0;

/// Maximum sustained horizontal power-hiking speed (m/s) ≈ 6 km/h.
pub const MAX_WALK_SPEED_MS: f64 = 6.0 / 3.6;

fn effort_poly(g: f64) -> f64 {
    1.0 + 0.034 * g + 0.0021 * g * g
}

fn effort_slope(g: f64) -> f64 {
    0.034 + 0.0042 * g
}

/// Relative effort of running at `grade_pct` versus flat ground (1.0 on the
/// flat). Outside the fitted range the curve continues along its tangent so
/// it stays monotonic on both sides.
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

/// Horizontal speed (m/s) of a power-hike holding `vam_mh` metres of
/// ascent per hour, capped at a brisk walking pace.
pub fn walk_speed_ms(grade_pct: f64, vam_mh: f64) -> f64 {
    if grade_pct <= 0.5 {
        return MAX_WALK_SPEED_MS;
    }
    let vertical_ms = vam_mh / 3600.0;
    (vertical_ms / (grade_pct / 100.0)).min(MAX_WALK_SPEED_MS)
}

/// Aerobic capacity loss with altitude (fraction of sea-level performance).
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
