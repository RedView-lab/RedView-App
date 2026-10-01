//! Forces et équilibre de puissance du moteur vélo v2 (unités SI).

pub const G: f64 = 9.80665;

/// Masse volumique de l'air (kg/m³) : pression barométrique standard et
/// température donnée, sinon atmosphère standard (15 °C − 6,5 °C/km).
pub fn air_density(altitude_m: f64, temperature_c: Option<f64>) -> f64 {
    let h = altitude_m.clamp(-500.0, 9000.0);
    let pressure = 101_325.0 * (1.0 - 2.255_77e-5 * h).max(0.1).powf(5.255_88);
    let t_c = temperature_c.unwrap_or(15.0 - 0.0065 * h).clamp(-40.0, 50.0);
    pressure / (287.05 * (t_c + 273.15))
}

/// Part de la puissance disponible en altitude (Bassett et al., sujets
/// acclimatés) : ≈ 0,99 à 1000 m, 0,95 à 2000 m, 0,90 à 3000 m.
pub fn altitude_power_factor(altitude_m: f64) -> f64 {
    let h = (altitude_m / 1000.0).clamp(0.0, 5.0);
    (1.0 + 0.00178 * h.powi(3) - 0.0143 * h.powi(2) - 0.00407 * h).clamp(0.5, 1.0)
}

/// Résistances à l'avancement (N) à la vitesse `v` (m/s) sur la pente `g`
/// (fraction), avec un vent de face `wind` (m/s, négatif = dans le dos).
#[inline]
pub fn resistance(v: f64, g: f64, mass: f64, crr: f64, cda: f64, rho: f64, wind: f64) -> f64 {
    let theta = g.atan();
    let air = v + wind;
    mass * G * theta.sin() + crr * mass * G * theta.cos() + 0.5 * rho * cda * air * air.abs()
}

/// Vitesse d'équilibre (m/s) pour une puissance à la roue `p_wheel` (W).
/// Puissance nulle en descente : vitesse terminale de roue libre.
pub fn steady_speed(p_wheel: f64, g: f64, mass: f64, crr: f64, cda: f64, rho: f64, wind: f64) -> f64 {
    // Excès de propulsion décroissant avec v : bissection robuste.
    let excess = |v: f64| p_wheel - resistance(v, g, mass, crr, cda, rho, wind) * v;
    let mut lo = 0.0_f64;
    let mut hi = 40.0_f64;
    if excess(hi) > 0.0 {
        return hi;
    }
    // En descente sans puissance, excess(0) = 0 : partir d'une petite vitesse.
    if excess(1e-3) <= 0.0 {
        return 0.0;
    }
    lo = lo.max(1e-3);
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if excess(mid) > 0.0 { lo = mid } else { hi = mid }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn density_sea_level_is_standard() {
        let rho = air_density(0.0, None);
        assert!((rho - 1.225).abs() < 0.01, "{rho}");
        assert!(air_density(2000.0, None) < rho);
        assert!(air_density(0.0, Some(35.0)) < air_density(0.0, Some(5.0)));
    }

    #[test]
    fn steady_speed_matches_power_balance() {
        // 200 W à la roue, plat, 80 kg, Crr 0,005, CdA 0,32 → ≈ 34 km/h.
        let v = steady_speed(200.0, 0.0, 80.0, 0.005, 0.32, 1.225, 0.0);
        let p = resistance(v, 0.0, 80.0, 0.005, 0.32, 1.225, 0.0) * v;
        assert!((p - 200.0).abs() < 0.5);
        assert!(v * 3.6 > 32.0 && v * 3.6 < 37.0, "{}", v * 3.6);
        // Montée à 8 % : vitesse ≈ P / (m g sin θ + roulement + aéro) ≈ 13,9 km/h.
        let v8 = steady_speed(250.0, 0.08, 75.0, 0.005, 0.35, 1.2, 0.0);
        assert!(v8 * 3.6 > 13.0 && v8 * 3.6 < 15.0, "{}", v8 * 3.6);
        // Roue libre à −8 % : vitesse terminale élevée.
        let vt = steady_speed(0.0, -0.08, 80.0, 0.005, 0.35, 1.2, 0.0);
        assert!(vt * 3.6 > 55.0 && vt * 3.6 < 75.0, "{}", vt * 3.6);
    }

    #[test]
    fn altitude_factor_bounds() {
        assert!((altitude_power_factor(0.0) - 1.0).abs() < 1e-9);
        let f2 = altitude_power_factor(2000.0);
        assert!(f2 < 0.97 && f2 > 0.93, "{f2}");
    }
}
