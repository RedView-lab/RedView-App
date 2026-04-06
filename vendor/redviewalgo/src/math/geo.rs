/// Earth radius in metres (WGS-84 mean)
const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Haversine distance between two points in metres.
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let lat1_r = lat1.to_radians();
    let lat2_r = lat2.to_radians();

    let a =
        (d_lat / 2.0).sin().powi(2) + lat1_r.cos() * lat2_r.cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    EARTH_RADIUS_M * c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_haversine() {
        // Paris (48.8566, 2.3522) → Lyon (45.7640, 4.8357) ≈ 392 km
        let d = haversine_distance(48.8566, 2.3522, 45.7640, 4.8357);
        assert!((d - 392_000.0).abs() < 5_000.0, "got {d}");
    }
}
