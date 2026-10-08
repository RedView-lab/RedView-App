use super::{merge_sport, FIT_FILE_TYPE_COURSE, NOT_AN_ACTIVITY_ERR};
use super::summary::{compute_summary, recompute_distance_if_needed, semicircles_to_degrees};
use crate::types::{ActivityData, DataPoint};
use fitparser::profile::MesgNum;
use fitparser::{from_bytes, Value};

// ─── Analyseur de référence (crate fitparser) — chemin de repli ────────────

/// Analyse FIT de référence avec la crate `fitparser` (gardée en repli pour
/// les fichiers que le lecteur rapide ne sait pas traiter).
pub(super) fn parse_fit_reference(data: &[u8]) -> Result<ActivityData, String> {
    let messages = from_bytes(data).map_err(|e| format!("FIT parse error: {e}"))?;

    let mut points: Vec<DataPoint> = Vec::new();
    let mut first_timestamp: Option<f64> = None;
    let mut sport: Option<u8> = None;

    for msg in &messages {
        if msg.kind() == MesgNum::FileId {
            let is_course = msg.fields().iter().any(|f| {
                f.name() == "type"
                    && match f.value() {
                        Value::String(s) => s == "course",
                        Value::Enum(v) => *v == FIT_FILE_TYPE_COURSE,
                        _ => false,
                    }
            });
            if is_course {
                return Err(NOT_AN_ACTIVITY_ERR.into());
            }
            continue;
        }
        if msg.kind() == MesgNum::Session || msg.kind() == MesgNum::Sport {
            let value = msg
                .fields()
                .iter()
                .find(|f| f.name() == "sport")
                .and_then(|f| sport_from_value(f.value()));
            merge_sport(&mut sport, msg.kind() == MesgNum::Session, value);
            continue;
        }
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

        // Saute les points sans position GPS
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

    recompute_distance_if_needed(&mut points);

    let mut summary = compute_summary(&points);
    summary.sport = sport;

    Ok(ActivityData { points, summary })
}

/// L'analyseur de référence nomme les énumérations du profil (« running ») ;
/// on ramène celles qui intéressent les moteurs à leurs codes numériques FIT.
fn sport_from_value(value: &Value) -> Option<u8> {
    match value {
        Value::Enum(v) | Value::UInt8(v) => Some(*v),
        Value::String(name) => match name.as_str() {
            "generic" => Some(0),
            "running" => Some(crate::types::FIT_SPORT_RUNNING),
            "cycling" => Some(crate::types::FIT_SPORT_CYCLING),
            "walking" => Some(crate::types::FIT_SPORT_WALKING),
            "hiking" => Some(crate::types::FIT_SPORT_HIKING),
            _ => None,
        },
        _ => None,
    }
}

/// Tente d'extraire un f64 de la valeur d'un champ FIT.
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
