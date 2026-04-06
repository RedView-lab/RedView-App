use crate::math::haversine_distance;
use crate::types::{ActivityData, ActivitySummary, DataPoint};
use fitparser::profile::MesgNum;
use fitparser::{from_bytes, Value};

/// Parse a single FIT file from raw bytes into `ActivityData`.
pub fn parse_fit(data: &[u8]) -> Result<ActivityData, String> {
    let messages = from_bytes(data).map_err(|e| format!("FIT parse error: {e}"))?;

    let mut points: Vec<DataPoint> = Vec::new();
    let mut first_timestamp: Option<f64> = None;

    for msg in &messages {
        if msg.kind() != MesgNum::Record {
            continue;
        }

        let mut lat: Option<f64> = None;
        let mut lon: Option<f64> = None;
        let mut altitude: f64 = 0.0;
        let mut speed: f64 = 0.0;
        let mut power: f64 = 0.0;
        let mut cadence: f64 = 0.0;
        let mut hr: f64 = 0.0;
        let mut temperature: f64 = 0.0;
        let mut timestamp_raw: Option<f64> = None;
        let mut distance: f64 = 0.0;

        for field in msg.fields() {
            let name = field.name();
            match name {
                "position_lat" => {
                    lat = extract_f64(field.value()).map(semicircles_to_degrees);
                }
                "position_long" => {
                    lon = extract_f64(field.value()).map(semicircles_to_degrees);
                }
                "enhanced_altitude" | "altitude" => {
                    if let Some(v) = extract_f64(field.value()) {
                        altitude = v;
                    }
                }
                "enhanced_speed" | "speed" => {
                    if let Some(v) = extract_f64(field.value()) {
                        speed = v; // already m/s in FIT SDK
                    }
                }
                "power" => {
                    if let Some(v) = extract_f64(field.value()) {
                        power = v;
                    }
                }
                "cadence" | "fractional_cadence" => {
                    if let Some(v) = extract_f64(field.value()) {
                        if name == "cadence" {
                            cadence = v;
                        } else {
                            cadence += v; // fractional part
                        }
                    }
                }
                "heart_rate" => {
                    if let Some(v) = extract_f64(field.value()) {
                        hr = v;
                    }
                }
                "temperature" => {
                    if let Some(v) = extract_f64(field.value()) {
                        temperature = v;
                    }
                }
                "distance" => {
                    if let Some(v) = extract_f64(field.value()) {
                        distance = v;
                    }
                }
                "timestamp" => {
                    if let Value::Timestamp(ts) = field.value() {
                        timestamp_raw = Some(ts.timestamp() as f64);
                    }
                }
                _ => {}
            }
        }

        // Skip points without GPS position
        let (lat_v, lon_v) = match (lat, lon) {
            (Some(la), Some(lo)) => (la, lo),
            _ => continue,
        };

        let ts = match timestamp_raw {
            Some(t) => t,
            None => continue,
        };

        if first_timestamp.is_none() {
            first_timestamp = Some(ts);
        }

        let elapsed = ts - first_timestamp.unwrap_or(ts);

        points.push(DataPoint {
            timestamp_s: elapsed,
            lat: lat_v,
            lon: lon_v,
            altitude_m: altitude,
            speed_ms: speed,
            power_w: power,
            cadence_rpm: cadence,
            heart_rate_bpm: hr,
            temperature_c: temperature,
            distance_m: distance,
        });
    }

    if points.is_empty() {
        return Err("No valid record points found in FIT file".to_string());
    }

    // Recompute cumulative distance from GPS if FIT distance looks wrong
    recompute_distance_if_needed(&mut points);

    let summary = compute_summary(&points);

    Ok(ActivityData { points, summary })
}

/// Parse multiple FIT files.
pub fn parse_fit_batch(files: &[&[u8]]) -> Result<Vec<ActivityData>, String> {
    let mut results = Vec::with_capacity(files.len());
    for (i, data) in files.iter().enumerate() {
        match parse_fit(data) {
            Ok(activity) => results.push(activity),
            Err(e) => return Err(format!("Error parsing FIT file #{}: {}", i + 1, e)),
        }
    }
    Ok(results)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// FIT stores lat/lon as semicircles. Convert to degrees.
fn semicircles_to_degrees(semicircles: f64) -> f64 {
    semicircles * (180.0 / 2_147_483_648.0)
}

/// Try to extract an f64 from a FIT field value.
fn extract_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Float64(v) => Some(*v),
        Value::Float32(v) => Some(*v as f64),
        Value::UInt8(v) => Some(*v as f64),
        Value::UInt16(v) => Some(*v as f64),
        Value::UInt32(v) => Some(*v as f64),
        Value::SInt8(v) => Some(*v as f64),
        Value::SInt16(v) => Some(*v as f64),
        Value::SInt32(v) => Some(*v as f64),
        Value::UInt64(v) => Some(*v as f64),
        Value::SInt64(v) => Some(*v as f64),
        _ => None,
    }
}

/// If FIT-reported distance is missing or zero, recompute from GPS.
fn recompute_distance_if_needed(points: &mut [DataPoint]) {
    let last_dist = points.last().map(|p| p.distance_m).unwrap_or(0.0);
    if last_dist > 100.0 {
        return; // FIT distance seems valid
    }

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

fn compute_summary(points: &[DataPoint]) -> ActivitySummary {
    let duration_s = points.last().map(|p| p.timestamp_s).unwrap_or(0.0);
    let distance_m = points.last().map(|p| p.distance_m).unwrap_or(0.0);

    let mut elevation_gain = 0.0;
    for i in 1..points.len() {
        let diff = points[i].altitude_m - points[i - 1].altitude_m;
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
    }
}
