/// Gradient in percent given horizontal distance and elevation difference.
pub fn gradient_pct(horizontal_distance_m: f64, elevation_diff_m: f64) -> f64 {
    if horizontal_distance_m < 0.1 {
        return 0.0;
    }
    (elevation_diff_m / horizontal_distance_m) * 100.0
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn test_gradient_pct() {
        assert!((gradient_pct(100.0, 10.0) - 10.0).abs() < 0.01);
        assert_eq!(gradient_pct(0.05, 5.0), 0.0); // too short
    }
}
