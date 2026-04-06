use crate::types::SurfaceType;

/// Base Crr values by surface type.
/// Road: standard road tires on asphalt (0.005)
/// Gravel: gravel tires on unpaved surface (0.008)
/// Unknown: conservative middle ground (0.006)
const CRR_ROAD: f64 = 0.005;
const CRR_GRAVEL: f64 = 0.008;
const CRR_UNKNOWN: f64 = 0.006;

/// Get the effective Crr for a given surface type.
/// If a base Crr override is provided (from config), it scales proportionally.
pub fn surface_effective_crr(surface: SurfaceType, base_crr: f64) -> f64 {
    let ratio = match surface {
        SurfaceType::Road => CRR_ROAD / CRR_ROAD, // 1.0
        SurfaceType::Gravel => CRR_GRAVEL / CRR_ROAD, // 1.6
        SurfaceType::Unknown => CRR_UNKNOWN / CRR_ROAD, // 1.2
    };
    base_crr * ratio
}

/// Speed penalty factor for gravel surfaces.
///
/// Gravel slows riders down beyond just rolling resistance:
/// - Reduced traction → less efficient power transfer
/// - Vibration → wasted energy in suspension losses
/// - Rider caution → slower cornering, braking earlier
///
/// On climbs, the penalty is reduced because speed is low and aero is negligible,
/// so the main effect is rolling resistance (already handled by Crr).
///
/// On flats/descents, the penalty includes handling/traction effects.
///
/// Returns a factor in [0.85, 1.0].
pub fn surface_speed_penalty(surface: SurfaceType, gradient_pct: f64) -> f64 {
    match surface {
        SurfaceType::Road => 1.0,
        SurfaceType::Gravel => {
            if gradient_pct > 4.0 {
                // Climbing: main penalty is Crr (already handled), small additional
                0.94
            } else if gradient_pct < -3.0 {
                // Descending on gravel: significant caution penalty
                0.85
            } else {
                // Flat/rolling: moderate penalty
                0.88
            }
        }
        SurfaceType::Unknown => {
            // Conservative: assume ~30% chance of gravel
            if gradient_pct < -3.0 {
                0.95
            } else {
                0.96
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crr_road_unchanged() {
        let crr = surface_effective_crr(SurfaceType::Road, 0.005);
        assert!((crr - 0.005).abs() < 1e-10);
    }

    #[test]
    fn test_crr_gravel_higher() {
        let crr = surface_effective_crr(SurfaceType::Gravel, 0.005);
        assert!((crr - 0.008).abs() < 1e-10);
    }

    #[test]
    fn test_crr_unknown_middle() {
        let crr = surface_effective_crr(SurfaceType::Unknown, 0.005);
        assert!((crr - 0.006).abs() < 1e-10);
    }

    #[test]
    fn test_speed_penalty_road_no_effect() {
        assert!((surface_speed_penalty(SurfaceType::Road, 0.0) - 1.0).abs() < 1e-10);
        assert!((surface_speed_penalty(SurfaceType::Road, 8.0) - 1.0).abs() < 1e-10);
        assert!((surface_speed_penalty(SurfaceType::Road, -5.0) - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_speed_penalty_gravel_flat() {
        let f = surface_speed_penalty(SurfaceType::Gravel, 0.0);
        assert!((f - 0.88).abs() < 1e-10, "Flat gravel should be 0.88, got {f}");
    }

    #[test]
    fn test_speed_penalty_gravel_climb() {
        let f = surface_speed_penalty(SurfaceType::Gravel, 6.0);
        assert!((f - 0.94).abs() < 1e-10, "Climb gravel should be 0.94, got {f}");
    }

    #[test]
    fn test_speed_penalty_gravel_descent() {
        let f = surface_speed_penalty(SurfaceType::Gravel, -5.0);
        assert!((f - 0.85).abs() < 1e-10, "Descent gravel should be 0.85, got {f}");
    }

    #[test]
    fn test_speed_penalty_unknown_conservative() {
        let f = surface_speed_penalty(SurfaceType::Unknown, 0.0);
        assert!(f > 0.90, "Unknown should be mild penalty, got {f}");
        assert!(f < 1.0, "Unknown should have some penalty, got {f}");
    }
}
