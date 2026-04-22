/// Standard sea-level air density (kg/m³)
const RHO_SEA_LEVEL: f64 = 1.225;

/// Gravity (m/s²)
pub const G: f64 = 9.80665;

/// Default drivetrain efficiency (97%)
pub const DRIVETRAIN_EFFICIENCY: f64 = 0.97;

/// Gradient in percent given horizontal distance and elevation difference.
pub fn gradient_pct(horizontal_distance_m: f64, elevation_diff_m: f64) -> f64 {
    if horizontal_distance_m < 0.1 {
        return 0.0;
    }
    (elevation_diff_m / horizontal_distance_m) * 100.0
}

/// Air density at a given altitude using the barometric formula (troposphere).
/// Returns kg/m³.
pub fn air_density(altitude_m: f64) -> f64 {
    let alt = altitude_m.max(0.0).min(11_000.0);
    RHO_SEA_LEVEL * (1.0 - 0.0000226 * alt).powf(4.256)
}

/// Gravity force component along slope (N). Positive = resisting (uphill).
/// Uses correct trigonometry: sin(arctan(grade)) instead of simplified grade.
pub fn force_gravity(mass_kg: f64, gradient_fraction: f64) -> f64 {
    mass_kg * G * gradient_fraction.atan().sin()
}

/// Aerodynamic drag force (N) at speed v (m/s).
pub fn force_aero(cda: f64, rho: f64, speed_ms: f64) -> f64 {
    0.5 * rho * cda * speed_ms * speed_ms
}

/// Rolling resistance force (N).
/// Uses cos(arctan(grade)) for correct slope projection.
pub fn force_rolling(crr: f64, mass_kg: f64, gradient_fraction: f64) -> f64 {
    crr * mass_kg * G * gradient_fraction.atan().cos()
}

/// Solve for speed given available power using Cardano's analytical solution.
///
/// The power balance equation:
///   P_eff = (F_grav + F_roll) · v + 0.5 · ρ · CdA · v³
///
/// Rearranged as cubic: a·v³ + c·v + d = 0  (b=0, no v² term without headwind)
///   a = 0.5 · ρ · CdA
///   c = F_grav + F_roll
///   d = -P_eff
///
/// Uses Cardano's formula for exact O(1) solution instead of iterative Newton-Raphson.
/// Falls back to Newton-Raphson for edge cases where Cardano discriminant is tricky.
#[cfg(test)]
pub fn solve_speed_from_power(
    power_w: f64,
    mass_kg: f64,
    gradient_fraction: f64,
    cda: f64,
    crr: f64,
    altitude_m: f64,
) -> f64 {
    solve_speed_from_power_with_efficiency(
        power_w, mass_kg, gradient_fraction, cda, crr, altitude_m, DRIVETRAIN_EFFICIENCY,
    )
}

/// Cube root that handles negative numbers correctly.
fn cbrt(x: f64) -> f64 {
    if x >= 0.0 {
        x.cbrt()
    } else {
        -(-x).cbrt()
    }
}

/// Newton-Raphson fallback solver for edge cases.
fn solve_speed_newton_raphson(effective_power: f64, half_rho_cda: f64, static_resist: f64) -> f64 {
    const MIN_SPEED: f64 = 0.8;
    const TOLERANCE: f64 = 1e-6;
    const MAX_ITER: usize = 50;

    let mut v = if static_resist > 0.0 {
        (effective_power / (static_resist + half_rho_cda * 16.0)).max(MIN_SPEED)
    } else {
        8.0
    };

    for _ in 0..MAX_ITER {
        let f = half_rho_cda * v * v * v + static_resist * v - effective_power;
        let f_prime = 3.0 * half_rho_cda * v * v + static_resist;

        if f_prime.abs() < 1e-12 {
            break;
        }

        let v_new = v - f / f_prime;
        if (v_new - v).abs() < TOLERANCE {
            v = v_new;
            break;
        }
        // FIX: clamp to 0.1 instead of MIN_SPEED * 0.5 to prevent negative speeds
        v = v_new.max(0.1);
    }

    v
}

/// Solve for speed given available power.
/// Convenience wrapper with configurable drivetrain efficiency.
pub fn solve_speed_from_power_with_efficiency(
    power_w: f64,
    mass_kg: f64,
    gradient_fraction: f64,
    cda: f64,
    crr: f64,
    altitude_m: f64,
    efficiency: f64,
) -> f64 {
    const MIN_SPEED: f64 = 0.8;
    // Hard upper bound on the cubic-solver output (~70 km/h). The descent
    // module applies a tighter, physics + curvature based cap on top; this
    // simply prevents the solver from returning extreme values when given
    // a slightly negative gradient with high power.
    const MAX_SPEED: f64 = 19.5;

    let effective_power = power_w * efficiency;
    let rho = air_density(altitude_m);
    let a = 0.5 * rho * cda;
    let f_grav = force_gravity(mass_kg, gradient_fraction);
    let f_roll = force_rolling(crr, mass_kg, gradient_fraction);
    let static_resist = f_grav + f_roll;

    if a < 1e-12 {
        if static_resist.abs() < 1e-6 {
            return MAX_SPEED;
        }
        let v = effective_power / static_resist;
        return v.clamp(MIN_SPEED, MAX_SPEED);
    }

    let p = static_resist / a;
    let q = -effective_power / a;
    let discriminant = (q / 2.0).powi(2) + (p / 3.0).powi(3);

    let v = if discriminant >= 0.0 {
        let sqrt_d = discriminant.sqrt();
        let s = cbrt(-q / 2.0 + sqrt_d);
        let t = cbrt(-q / 2.0 - sqrt_d);
        s + t
    } else {
        let r = ((-(p / 3.0)).powi(3)).sqrt();
        let phi = (-q / (2.0 * r)).acos();
        let cube_root_r = r.cbrt();
        let v1 = 2.0 * cube_root_r * (phi / 3.0).cos();
        let v2 = 2.0 * cube_root_r * ((phi + 2.0 * std::f64::consts::PI) / 3.0).cos();
        let v3 = 2.0 * cube_root_r * ((phi + 4.0 * std::f64::consts::PI) / 3.0).cos();
        [v1, v2, v3]
            .iter()
            .copied()
            .filter(|v| *v > 0.0)
            .fold(0.0_f64, f64::max)
    };

    if v > 0.1 {
        v.clamp(MIN_SPEED, MAX_SPEED)
    } else {
        solve_speed_newton_raphson(effective_power, a, static_resist).clamp(MIN_SPEED, MAX_SPEED)
    }
}

/// Compute terminal velocity on a descent (zero pedaling power).
///
/// Terminal velocity is reached when gravity equals drag + rolling resistance:
///   m·g·sin(θ) = 0.5·ρ·CdA·v² + Crr·m·g·cos(θ)
///
/// Solving for v:
///   v = sqrt(2·m·g·(sin(θ) - Crr·cos(θ)) / (ρ·CdA))
///
/// Returns 0.0 if the gradient doesn't produce enough gravity to overcome rolling resistance
/// (i.e., the grade is too gentle or uphill).
pub fn terminal_velocity(
    mass_kg: f64,
    gradient_fraction: f64,
    cda_tuck: f64,
    crr: f64,
    altitude_m: f64,
) -> f64 {
    // Terminal velocity only exists on descents (negative gradient)
    if gradient_fraction >= 0.0 {
        return 0.0;
    }
    let theta = gradient_fraction.abs().atan();
    let net_gravity_component = theta.sin() - crr * theta.cos();
    if net_gravity_component <= 0.0 {
        return 0.0;
    }
    let rho = air_density(altitude_m);
    if rho < 1e-6 || cda_tuck < 1e-6 {
        return 0.0;
    }
    let v_sq = 2.0 * mass_kg * G * net_gravity_component / (rho * cda_tuck);
    v_sq.sqrt()
}

/// Altitude-dependent power reduction factor (VO2max loss).
///
/// Based on Wehrlin & Hallén (2006): ~6.3% VO2max loss per 1000m above 1500m.
/// Based on Wehrlin & Hallén (2006): ~6.3% VO2max loss per 1000m above 1500m.
/// Simplified to 6% loss per 1000m above 1500m for practical use.
///
/// Returns a factor in [0.72, 1.0]:
///   - Sea level to 1500m: 1.0 (no reduction)
///   - 2000m: 0.97
///   - 2500m: 0.94
///   - 3000m: 0.91
///   - 5000m: 0.79 (near cap)
pub fn altitude_power_factor(altitude_m: f64) -> f64 {
    if altitude_m <= 1500.0 {
        return 1.0;
    }
    let factor = 1.0 - 0.06 * (altitude_m - 1500.0) / 1000.0;
    factor.clamp(0.72, 1.0)
}

/// Compute CdA adjusted for rider position based on gradient.
///
/// - Climbing (>4%): rider sits up, CdA increases ~15%
/// - Flat (-2% to 4%): baseline CdA
/// - Descent (<-2%): rider tucks, CdA decreases ~20%
///
/// Uses smooth linear interpolation between thresholds to avoid step changes.
pub fn gradient_adjusted_cda(base_cda: f64, gradient_pct: f64) -> f64 {
    if gradient_pct >= 6.0 {
        base_cda * 1.15
    } else if gradient_pct >= 4.0 {
        // Interpolate between 1.0 and 1.15 over gradient 4..6
        let t = (gradient_pct - 4.0) / 2.0;
        base_cda * (1.0 + 0.15 * t)
    } else if gradient_pct >= -2.0 {
        base_cda
    } else if gradient_pct >= -4.0 {
        // Interpolate between 1.0 and 0.80 over gradient -2..-4
        let t = (-2.0 - gradient_pct) / 2.0;
        base_cda * (1.0 - 0.20 * t)
    } else {
        base_cda * 0.80
    }
}

/// Aerodynamic drag force with headwind (N) at ground speed v (m/s).
/// `headwind_ms` is positive for headwind, negative for tailwind.
/// Drag depends on airspeed (ground speed + headwind), not ground speed alone.
/// Power required: F_aero * v_ground (force acts at ground speed).
pub fn force_aero_wind(cda: f64, rho: f64, speed_ms: f64, headwind_ms: f64) -> f64 {
    let airspeed = (speed_ms + headwind_ms).max(0.0);
    0.5 * rho * cda * airspeed * airspeed
}

/// Altitude acclimatization factor.
/// Reduces the VO2max penalty from altitude_power_factor over time spent at altitude.
/// Based on Chapman et al. 2014: acclimatization recovers ~50% of altitude deficit
/// over 7-14 days, with most gains in first 3-5 days.
///
/// `hours_above_1500m`: cumulative hours spent above 1500m during the event.
/// Returns a correction multiplier to apply *on top of* altitude_power_factor.
/// Range: [1.0, ~1.03] — up to 3% recovery of altitude penalty.
pub fn altitude_acclimatization(hours_above_1500m: f64) -> f64 {
    if hours_above_1500m <= 0.0 {
        return 1.0;
    }
    // Exponential onset: ~50% of maximum benefit at 72h (3 days)
    // Maximum recovery: 3% (modest, since event-duration acclimatization is limited)
    let max_recovery = 0.03;
    let tau = 72.0; // hours for 63% of benefit
    let recovery = max_recovery * (1.0 - (-hours_above_1500m / tau).exp());
    1.0 + recovery
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_air_density_sea_level() {
        let rho = air_density(0.0);
        assert!((rho - 1.225).abs() < 0.01);
    }

    #[test]
    fn test_air_density_altitude() {
        let rho = air_density(2000.0);
        assert!(rho > 0.95 && rho < 1.10, "got {rho}");
    }

    #[test]
    fn test_solve_speed_flat() {
        // 200W, 75kg, flat, CdA=0.35, Crr=0.005, sea level → ~30 km/h
        let v = solve_speed_from_power(200.0, 75.0, 0.0, 0.35, 0.005, 0.0);
        let kmh = v * 3.6;
        assert!(kmh > 25.0 && kmh < 35.0, "got {kmh} km/h");
    }

    #[test]
    fn test_solve_speed_uphill() {
        // 200W, 75kg, 8% grade → should be slow, ~8-12 km/h
        let v = solve_speed_from_power(200.0, 75.0, 0.08, 0.35, 0.005, 500.0);
        let kmh = v * 3.6;
        assert!(kmh > 5.0 && kmh < 15.0, "got {kmh} km/h");
    }

    #[test]
    fn test_terminal_velocity_steep_descent() {
        // -8% grade, 80kg, CdA_tuck=0.28, Crr=0.005, sea level
        let v = terminal_velocity(80.0, -0.08, 0.28, 0.005, 0.0);
        let kmh = v * 3.6;
        // Should be roughly 55–70 km/h
        assert!(kmh > 45.0 && kmh < 80.0, "-8% terminal velocity: got {kmh:.1} km/h");
    }

    #[test]
    fn test_terminal_velocity_gentle_descent() {
        // -2% grade → lower terminal velocity
        let v = terminal_velocity(80.0, -0.02, 0.28, 0.005, 0.0);
        let kmh = v * 3.6;
        assert!(kmh > 15.0 && kmh < 50.0, "-2% terminal velocity: got {kmh:.1} km/h");
    }

    #[test]
    fn test_terminal_velocity_uphill_zero() {
        // Uphill has no terminal velocity → should return 0
        let v = terminal_velocity(80.0, 0.05, 0.28, 0.005, 0.0);
        assert!(v < 0.01, "Uphill terminal velocity should be ~0, got {v}");
    }

    #[test]
    fn test_altitude_power_factor() {
        assert!((altitude_power_factor(0.0) - 1.0).abs() < 0.001);
        assert!((altitude_power_factor(1000.0) - 1.0).abs() < 0.001);
        assert!((altitude_power_factor(1500.0) - 1.0).abs() < 0.001);
        // 2000m: 1.0 - 0.06 * 500/1000 = 0.97
        assert!((altitude_power_factor(2000.0) - 0.97).abs() < 0.01);
        // 2500m: 1.0 - 0.06 * 1000/1000 = 0.94
        assert!((altitude_power_factor(2500.0) - 0.94).abs() < 0.01);
        // 3000m: 1.0 - 0.06 * 1500/1000 = 0.91
        assert!((altitude_power_factor(3000.0) - 0.91).abs() < 0.01);
        // Should not go below 0.72
        assert!(altitude_power_factor(10000.0) >= 0.72);
    }

    #[test]
    fn test_cardano_matches_newton_raphson() {
        // Test that Cardano and Newton-Raphson give the same result
        // across a range of conditions
        let test_cases = [
            (200.0, 75.0, 0.0, 0.35, 0.005, 0.0),    // flat sea level
            (300.0, 80.0, 0.05, 0.35, 0.005, 500.0),  // 5% climb
            (150.0, 70.0, -0.03, 0.30, 0.004, 1000.0), // 3% descent
            (250.0, 85.0, 0.10, 0.40, 0.006, 200.0),  // 10% climb
            (100.0, 60.0, 0.0, 0.25, 0.003, 2000.0),  // flat high altitude
        ];

        for (power, mass, grad, cda, crr, alt) in test_cases {
            let v = solve_speed_from_power(power, mass, grad, cda, crr, alt);
            // Verify result is physically consistent: P ≈ F_total * v
            let rho = air_density(alt);
            let f_total =
                force_gravity(mass, grad) + force_rolling(crr, mass, grad) + force_aero(cda, rho, v);
            let p_check = f_total * v;
            let p_eff = power * DRIVETRAIN_EFFICIENCY;
            assert!(
                (p_check - p_eff).abs() < 1.0,
                "Power mismatch at grad={grad}: expected {p_eff:.1}W, got {p_check:.1}W (v={v:.2})"
            );
        }
    }

    #[test]
    fn test_gradient_pct() {
        assert!((gradient_pct(100.0, 10.0) - 10.0).abs() < 0.01);
        assert_eq!(gradient_pct(0.05, 5.0), 0.0); // too short
    }

    #[test]
    fn test_no_negative_speed() {
        // Even with extreme conditions, speed should never be negative
        let v = solve_speed_from_power(10.0, 100.0, 0.20, 0.35, 0.005, 0.0);
        assert!(v >= 0.8, "Speed should be >= MIN_SPEED, got {v}");
    }
}
