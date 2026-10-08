use crate::math::haversine_distance;
use crate::types::{ActivitySummary, DataPoint};

// ─── Post-traitement des points et résumé d'activité ────────────────────────

/// FIT stocke lat / lon en semicercles. Conversion en degrés.
pub(super) fn semicircles_to_degrees(semicircles: f64) -> f64 {
    semicircles * (180.0 / 2_147_483_648.0)
}

/// Si la distance rapportée par le FIT manque ou vaut zéro, la recalcule depuis le GPS.
/// Recalcule aussi la vitesse depuis le dt / la distance GPS si la vitesse manque sur toute l'activité.
pub(super) fn recompute_distance_if_needed(points: &mut [DataPoint]) {
    let last_dist = points.last().map(|p| p.distance_m).unwrap_or(0.0);
    if last_dist <= 100.0 {
        let mut cumulative = 0.0;
        for i in 0..points.len() {
            if i == 0 {
                points[i].distance_m = 0.0;
                continue;
            }
            let d = haversine_distance(
                points[i - 1].lat,
                points[i - 1].lon,
                points[i].lat,
                points[i].lon,
            );
            cumulative += d;
            points[i].distance_m = cumulative;
        }
    }

    // Robustesse : si la vitesse n'a pas été enregistrée dans le FIT, on la déduit de la distance et du dt
    let has_speed = points.iter().any(|p| p.speed_ms > 0.5);
    if !has_speed {
        for i in 1..points.len() {
            let dt = points[i].timestamp_s - points[i - 1].timestamp_s;
            let dd = points[i].distance_m - points[i - 1].distance_m;
            if dt > 0.0 && dt < 120.0 && dd >= 0.0 {
                points[i].speed_ms = (dd / dt).min(35.0);
            }
        }
    }
}

pub(super) fn compute_summary(points: &[DataPoint]) -> ActivitySummary {
    let duration_s = points.last().map(|p| p.timestamp_s).unwrap_or(0.0);
    let distance_m = points.last().map(|p| p.distance_m).unwrap_or(0.0);

    // Supprime les pics d'altitude avant d'intégrer le D+ — sinon le bruit
    // barométrique brut par échantillon gonfle le dénivelé de centaines de
    // mètres sur les longues sorties (même filtre médian que pour la route GPX).
    let raw_altitudes: Vec<f64> = points.iter().map(|p| p.altitude_m).collect();
    let altitudes = crate::math::median_filter_elevations(&raw_altitudes, 5);
    let mut elevation_gain = 0.0;
    for i in 1..altitudes.len() {
        let diff = altitudes[i] - altitudes[i - 1];
        if diff > 0.0 {
            elevation_gain += diff;
        }
    }

    let avg_speed_ms = if duration_s > 0.0 {
        distance_m / duration_s
    } else {
        0.0
    };

    let power_points: Vec<f64> = points.iter().filter(|p| p.power_w > 0.0).map(|p| p.power_w).collect();
    let has_power = power_points.len() as f64 > points.len() as f64 * 0.5;
    let avg_power_w = if !power_points.is_empty() {
        power_points.iter().sum::<f64>() / power_points.len() as f64
    } else {
        0.0
    };

    let hr_points: Vec<f64> = points.iter().filter(|p| p.heart_rate_bpm > 0.0).map(|p| p.heart_rate_bpm).collect();
    let has_hr = hr_points.len() as f64 > points.len() as f64 * 0.5;
    let avg_hr_bpm = if !hr_points.is_empty() {
        hr_points.iter().sum::<f64>() / hr_points.len() as f64
    } else {
        0.0
    };

    ActivitySummary {
        duration_s,
        distance_m,
        elevation_gain_m: elevation_gain,
        avg_speed_ms,
        avg_power_w,
        avg_hr_bpm,
        has_power,
        has_hr,
        sport: None,
    }
}
