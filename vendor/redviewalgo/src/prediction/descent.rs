use crate::math::terminal_velocity;

/// Absolute maximum descent speed (m/s) ≈ 80 km/h — safety hard limit.
const ABSOLUTE_MAX_DESCENT_MS: f64 = 22.2;

/// Apply a physics-based descent speed cap.
///
/// Instead of hard-coded speed tiers, this computes the terminal velocity
/// (zero-pedaling equilibrium speed) from the physics model and applies:
/// 1. Terminal velocity cap (physics-based, gradient-dependent)
/// 2. Curvature penalty (twisty roads → slower descents)
/// 3. Smooth fatigue-based reaction penalty (replaces old step function)
///
/// The fatigue/reaction penalty is intentionally mild — general fatigue
/// is already applied by the caller. This only models the additional
/// caution a tired rider exercises on descents.
pub fn cap_descent_speed(
    speed_ms: f64,
    gradient_pct: f64,
    elapsed_h: f64,
    mass_kg: f64,
    cda_tuck: f64,
    crr: f64,
    altitude_m: f64,
    curvature_deg_per_km: f64,
) -> f64 {
    // Only cap on descents (gradient < -1%)
    if gradient_pct >= -1.0 {
        return speed_ms;
    }

    let gradient_frac = gradient_pct / 100.0;

    // 1. Physics-based terminal velocity (what speed would gravity alone produce?)
    let v_terminal = terminal_velocity(mass_kg, gradient_frac, cda_tuck, crr, altitude_m);
    let physics_max = if v_terminal > 0.1 {
        v_terminal.min(ABSOLUTE_MAX_DESCENT_MS)
    } else {
        ABSOLUTE_MAX_DESCENT_MS
    };

    // 2. Curvature penalty — twisty roads require braking
    let curvature_factor = curvature_penalty(curvature_deg_per_km);

    // 3. Smooth reaction-time penalty (fatigue reduces descent confidence)
    //    Sigmoid: 1 / (1 + 0.003 * t^1.5)
    //    At 5h: 0.967, 15h: 0.854, 30h: 0.672
    let reaction_factor = 1.0 / (1.0 + 0.003 * elapsed_h.powf(1.5));

    let effective_max = physics_max * curvature_factor * reaction_factor;
    speed_ms.min(effective_max)
}

/// Compute curvature-based speed penalty factor.
///
/// Straight road (<50 deg/km): 1.0 (no penalty)
/// Moderate turns (50-200): 0.85
/// Switchbacks (200-500): 0.70
/// Extreme hairpins (>500): 0.55
///
/// Uses smooth interpolation between thresholds.
fn curvature_penalty(curvature_deg_per_km: f64) -> f64 {
    if curvature_deg_per_km <= 50.0 {
        1.0
    } else if curvature_deg_per_km <= 200.0 {
        // Interpolate 1.0 → 0.85
        let t = (curvature_deg_per_km - 50.0) / 150.0;
        1.0 - 0.15 * t
    } else if curvature_deg_per_km <= 500.0 {
        // Interpolate 0.85 → 0.70
        let t = (curvature_deg_per_km - 200.0) / 300.0;
        0.85 - 0.15 * t
    } else {
        // Interpolate 0.70 → 0.55
        let excess = (curvature_deg_per_km - 500.0) / 500.0;
        (0.70 - 0.15 * excess).max(0.55)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_cap_on_slight_descent() {
        let speed = cap_descent_speed(10.0, -0.5, 0.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        assert_eq!(speed, 10.0, "Slight descent should not be capped");
    }

    #[test]
    fn test_steep_descent_capped_by_terminal_velocity() {
        // -15% gradient, fresh rider, should be capped well below 80 km/h
        let speed = cap_descent_speed(25.0, -15.0, 0.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        let kmh = speed * 3.6;
        assert!(kmh < 80.0, "Steep descent should be capped: got {kmh:.1} km/h");
        assert!(kmh > 30.0, "Steep descent shouldn't be too slow: got {kmh:.1} km/h");
    }

    #[test]
    fn test_curvature_reduces_speed() {
        let straight = cap_descent_speed(15.0, -5.0, 2.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        let twisty = cap_descent_speed(15.0, -5.0, 2.0, 80.0, 0.28, 0.005, 0.0, 300.0);
        assert!(
            twisty < straight,
            "Twisty ({twisty:.1}) should be slower than straight ({straight:.1})"
        );
    }

    #[test]
    fn test_fatigue_reduces_descent_speed() {
        let fresh = cap_descent_speed(15.0, -5.0, 1.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        let tired = cap_descent_speed(15.0, -5.0, 20.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        assert!(
            tired <= fresh,
            "Tired ({tired:.1}) should be <= fresh ({fresh:.1})"
        );
    }

    #[test]
    fn test_reaction_penalty_not_too_harsh() {
        // At 20h: reaction = 1/(1+0.003*20^1.5) ≈ 0.789
        let speed = cap_descent_speed(16.0, -5.0, 20.0, 80.0, 0.28, 0.005, 0.0, 0.0);
        assert!(speed > 10.0, "Should not over-penalize descent: got {} m/s", speed);
    }
}
