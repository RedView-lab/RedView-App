use crate::math::haversine_distance;
use crate::types::{ActivityData, ActivitySummary, DataPoint};
use fitparser::profile::MesgNum;
use fitparser::{from_bytes, Value};

/// Parse a single FIT file from raw bytes into `ActivityData`.
///
/// Primary path: a fast streaming reader that only decodes Record messages
/// and skips every other message by computed length (no per-message
/// allocation, no field-name strings). Falls back to the reference
/// `fitparser` crate when the fast reader hits anything unexpected, so
/// unusual files keep the exact legacy behaviour.
pub fn parse_fit(data: &[u8]) -> Result<ActivityData, String> {
    match parse_fit_fast(data) {
        Ok(activity) => Ok(activity),
        Err(_fast_err) => parse_fit_reference(data),
    }
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

// ─── Fast streaming FIT reader ──────────────────────────────────────────────
//
// The reference parser materialises every message of every type (laps,
// events, sessions…) into owned structs with per-field name strings and
// enum conversions. On long FIT files that dominates total prediction time.
// This reader understands just enough of the FIT binary format to:
//   * walk definition/data message pairs (incl. compressed timestamps),
//   * skip non-Record messages in O(1) via their computed length,
//   * decode the handful of Record fields we use, with correct
//     scale/offset and FIT invalid-value sentinels.
// Anything unexpected returns Err and `parse_fit` falls back to the
// reference parser.

/// FIT global message number for Record messages.
const MSG_RECORD: u16 = 20;

/// Base type identifiers (FIT protocol §3.3.1).
const BASE_SINT8: u8 = 0x01;
const BASE_UINT8: u8 = 0x02;
const BASE_SINT16: u8 = 0x03;
const BASE_UINT16: u8 = 0x04;
const BASE_SINT32: u8 = 0x05;
const BASE_UINT32: u8 = 0x06;
const BASE_FLOAT32: u8 = 0x08;
const BASE_FLOAT64: u8 = 0x09;
const BASE_UINT8Z: u8 = 0x0A;
const BASE_UINT16Z: u8 = 0x0B;
const BASE_UINT32Z: u8 = 0x0C;
const BASE_SINT64: u8 = 0x0E;
const BASE_UINT64: u8 = 0x0F;

/// A definition message: field layout + total payload length. The length is
/// used to skip any message in O(1); the field layout only matters for
/// Record messages.
struct LocalDef {
    global_msg_num: u16,
    big_endian: bool,
    /// (field_number, payload_offset, size, base_type)
    fields: Vec<(u16, u16, u8, u8)>,
    total_size: usize,
}

/// Decoded values of one Record message (scale/offset applied).
#[derive(Default)]
struct RecordValues {
    lat_semi: Option<i32>,
    lon_semi: Option<i32>,
    alt_std: Option<f64>,
    alt_enh: Option<f64>,
    speed_std: Option<f64>,
    speed_enh: Option<f64>,
    power: Option<f64>,
    cadence: Option<f64>,
    frac_cadence: Option<f64>,
    hr: Option<f64>,
    temperature: Option<f64>,
    distance: Option<f64>,
    timestamp: Option<u32>,
}

impl RecordValues {
    /// Enhanced fields win over their standard equivalents when present.
    fn altitude(&self) -> Option<f64> {
        self.alt_enh.or(self.alt_std)
    }
    fn speed(&self) -> Option<f64> {
        self.speed_enh.or(self.speed_std)
    }
}

/// Read one numeric field value, applying FIT invalid-value sentinels.
/// Returns None for invalid/unsupported values.
fn read_scalar(d: &[u8], off: usize, size: u8, base: u8, be: bool) -> Option<f64> {
    let end = off.checked_add(size as usize)?;
    if end > d.len() {
        return None;
    }
    let v: f64 = match base & 0x7F {
        BASE_SINT8 if size == 1 => d[off] as i8 as f64,
        BASE_UINT8 if size == 1 => d[off] as f64,
        BASE_SINT16 if size == 2 => {
            let b = [d[off], d[off + 1]];
            let u = if be { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) };
            u as i16 as f64
        }
        BASE_UINT16 | BASE_UINT16Z if size == 2 => {
            let b = [d[off], d[off + 1]];
            let u = if be { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) };
            u as f64
        }
        BASE_SINT32 if size == 4 => {
            let b = [d[off], d[off + 1], d[off + 2], d[off + 3]];
            let u = if be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) };
            u as i32 as f64
        }
        BASE_UINT32 | BASE_UINT32Z if size == 4 => {
            let b = [d[off], d[off + 1], d[off + 2], d[off + 3]];
            let u = if be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) };
            u as f64
        }
        BASE_FLOAT32 if size == 4 => {
            let b = [d[off], d[off + 1], d[off + 2], d[off + 3]];
            let u = if be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) };
            f32::from_bits(u) as f64
        }
        BASE_FLOAT64 if size == 8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(&d[off..off + 8]);
            let u = if be { u64::from_be_bytes(b) } else { u64::from_le_bytes(b) };
            f64::from_bits(u)
        }
        BASE_SINT64 if size == 8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(&d[off..off + 8]);
            let u = if be { u64::from_be_bytes(b) } else { u64::from_le_bytes(b) };
            u as i64 as f64
        }
        BASE_UINT64 if size == 8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(&d[off..off + 8]);
            let u = if be { u64::from_be_bytes(b) } else { u64::from_le_bytes(b) };
            u as f64
        }
        _ => return None,
    };

    let invalid = match base & 0x7F {
        BASE_SINT8 => v == 127.0,
        BASE_UINT8 => v == 255.0,
        BASE_SINT16 => v == 32767.0,
        BASE_UINT16 => v == 65535.0,
        BASE_SINT32 => v == 2_147_483_647.0,
        BASE_UINT32 => v == 4_294_967_295.0,
        BASE_UINT8Z | BASE_UINT16Z | BASE_UINT32Z => v == 0.0,
        BASE_SINT64 => v == 9_223_372_036_854_775_807.0,
        BASE_UINT64 => v == 18_446_744_073_709_551_615.0,
        BASE_FLOAT32 | BASE_FLOAT64 => v.is_nan(),
        _ => false,
    };
    if invalid {
        None
    } else {
        Some(v)
    }
}

/// Decode a Record message payload using its definition.
fn decode_record_message(payload: &[u8], def: &LocalDef) -> RecordValues {
    let mut v = RecordValues::default();
    let be = def.big_endian;
    for &(fnum, off, size, base) in &def.fields {
        let off = off as usize;
        let s = read_scalar(payload, off, size, base, be);
        match fnum {
            // scale/offset per the FIT profile (Record message).
            0 => v.lat_semi = s.map(|x| x as i32),
            1 => v.lon_semi = s.map(|x| x as i32),
            2 => v.alt_std = s.map(|x| x / 5.0 - 500.0),
            3 => v.hr = s,
            4 => v.cadence = s,
            5 => v.distance = s.map(|x| x / 100.0),
            6 => v.speed_std = s.map(|x| x / 1000.0),
            7 => v.power = s,
            13 => v.temperature = s,
            17 => v.alt_enh = s.map(|x| x / 5.0 - 500.0),
            18 => v.speed_enh = s.map(|x| x / 1000.0),
            28 => v.frac_cadence = s.map(|x| x / 128.0),
            253 => v.timestamp = s.map(|x| x as u32),
            _ => {}
        }
    }
    v
}

/// Build a DataPoint from decoded Record values.
/// Returns None when GPS position or timestamp is missing/invalid
/// (same skip rule as the reference parser). Altitude carries forward the
/// last valid value instead of dropping to 0 on invalid samples.
fn build_point(
    v: &RecordValues,
    first_timestamp: &mut Option<f64>,
    last_altitude: &mut f64,
) -> Option<DataPoint> {
    let ts_raw = v.timestamp?;
    let lat_semi = v.lat_semi?;
    let lon_semi = v.lon_semi?;

    let lat = lat_semi as f64 * (180.0 / 2_147_483_648.0);
    let lon = lon_semi as f64 * (180.0 / 2_147_483_648.0);

    if first_timestamp.is_none() {
        *first_timestamp = Some(ts_raw as f64);
    }
    let elapsed = ts_raw as f64 - first_timestamp.unwrap_or(ts_raw as f64);

    if let Some(a) = v.altitude() {
        *last_altitude = a;
    }

    Some(DataPoint {
        timestamp_s: elapsed,
        lat,
        lon,
        altitude_m: *last_altitude,
        speed_ms: v.speed().unwrap_or(0.0),
        power_w: v.power.unwrap_or(0.0),
        cadence_rpm: v.cadence.unwrap_or(0.0) + v.frac_cadence.unwrap_or(0.0),
        heart_rate_bpm: v.hr.unwrap_or(0.0),
        temperature_c: v.temperature.unwrap_or(0.0),
        distance_m: v.distance.unwrap_or(0.0),
    })
}

/// Parse a definition message starting at `pos` (just after its header
/// byte). `has_dev_fields` is the 0x20 bit of the definition header, which
/// is how the FIT protocol marks definitions that carry developer fields
/// (same signal the reference parser uses). Returns the definition and the
/// position right after it.
fn parse_definition(
    data: &[u8],
    pos: usize,
    end: usize,
    has_dev_fields: bool,
) -> Result<(LocalDef, usize), String> {
    // reserved(1) + architecture(1) + global msg num(2) + field count(1)
    if pos + 6 > end {
        return Err("FIT: truncated definition message".into());
    }
    let big_endian = data[pos + 1] == 1;
    let global_msg_num = if big_endian {
        u16::from_be_bytes([data[pos + 2], data[pos + 3]])
    } else {
        u16::from_le_bytes([data[pos + 2], data[pos + 3]])
    };
    let num_fields = data[pos + 4] as usize;
    let mut p = pos + 5;

    let mut fields = Vec::with_capacity(num_fields.min(64));
    let mut total: usize = 0;
    for _ in 0..num_fields {
        if p + 3 > end {
            return Err("FIT: truncated field definition".into());
        }
        let fnum = data[p] as u16;
        let size = data[p + 1];
        let base = data[p + 2];
        fields.push((fnum, total as u16, size, base));
        total += size as usize;
        p += 3;
    }

    // FIT protocol ≥ 2.0 definition messages may carry a developer field
    // count byte (possibly zero) followed by 3-byte developer field
    // definitions. We skip them but must account for their size in data
    // messages.
    if has_dev_fields {
        if p >= end {
            return Err("FIT: truncated developer field count".into());
        }
        let num_dev = data[p] as usize;
        p += 1;
        for _ in 0..num_dev {
            if p + 3 > end {
                return Err("FIT: truncated developer field definition".into());
            }
            // Second byte is the size in the field-definition layout.
            total += data[p + 1] as usize;
            p += 3;
        }
    }

    Ok((
        LocalDef {
            global_msg_num,
            big_endian,
            fields,
            total_size: total,
        },
        p,
    ))
}

/// Fast streaming FIT parse. Errors trigger the reference-parser fallback.
fn parse_fit_fast(data: &[u8]) -> Result<ActivityData, String> {
    // ── File header ──
    if data.len() < 12 {
        return Err("FIT: file too short".into());
    }
    let header_size = data[0] as usize;
    if header_size < 12 || header_size > 14 || header_size > data.len() {
        return Err("FIT: invalid header size".into());
    }
    if &data[8..12] != b".FIT" {
        return Err("FIT: bad header signature".into());
    }
    let protocol_version = data[1];
    let _ = protocol_version;
    let data_size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;

    let body_start = header_size;
    let mut body_end =
        if data_size > 0 && data_size <= data.len() && body_start <= data.len() - data_size {
            body_start + data_size
        } else {
            data.len()
        };

    // Rough capacity hint: records are ≥ ~30 bytes in practice.
    let mut points: Vec<DataPoint> = Vec::with_capacity((body_end - body_start) / 30 + 16);

    let mut local_defs: Vec<Option<LocalDef>> = (0..16).map(|_| None).collect();
    let mut last_timestamp: u32 = 0;
    let mut first_timestamp: Option<f64> = None;
    let mut last_altitude: f64 = 0.0;

    let mut pos = body_start;
    'segments: loop {
        while pos < body_end {
            let header_byte = data[pos];

            if header_byte & 0x80 != 0 {
                // ── Compressed timestamp data message ──
                // bits 5-6: local message type (0-3), bits 0-4: time offset
                let local = ((header_byte >> 5) & 0x03) as usize;
                let offset = (header_byte & 0x1F) as u32;
                pos += 1;
                let def = local_defs[local]
                    .as_ref()
                    .ok_or("FIT: compressed message without definition")?;

                // Advance the timestamp reference (32 s rollover counter).
                if last_timestamp != 0 {
                    let mut ts = (last_timestamp & !0x1F) | offset;
                    if (last_timestamp & 0x1F) > offset {
                        ts += 32;
                    }
                    last_timestamp = ts;
                }

                let payload_end = pos + def.total_size;
                if payload_end > body_end {
                    return Err("FIT: truncated data message".into());
                }
                if def.global_msg_num == MSG_RECORD {
                    let mut v = decode_record_message(&data[pos..payload_end], def);
                    if last_timestamp != 0 {
                        v.timestamp = Some(last_timestamp);
                    }
                    if let Some(pt) = build_point(&v, &mut first_timestamp, &mut last_altitude) {
                        points.push(pt);
                    }
                }
                pos = payload_end;
            } else if header_byte & 0x40 != 0 {
                // ── Definition message ──
                pos += 1;
                // Bit 0x20 marks definitions carrying developer fields.
                let has_dev = header_byte & 0x20 != 0;
                let (def, new_pos) = parse_definition(data, pos, body_end, has_dev)?;
                local_defs[(header_byte & 0x0F) as usize] = Some(def);
                pos = new_pos;
            } else {
                // ── Normal data message ──
                pos += 1;
                let local = (header_byte & 0x0F) as usize;
                let def = local_defs[local]
                    .as_ref()
                    .ok_or("FIT: data message without definition")?;
                let payload_end = pos + def.total_size;
                if payload_end > body_end {
                    return Err("FIT: truncated data message".into());
                }
                if def.global_msg_num == MSG_RECORD {
                    let v = decode_record_message(&data[pos..payload_end], def);
                    if let Some(raw) = v.timestamp {
                        last_timestamp = raw;
                    }
                    if let Some(pt) = build_point(&v, &mut first_timestamp, &mut last_altitude) {
                        points.push(pt);
                    }
                }
                pos = payload_end;
            }
        }

        // After this segment's 2-byte file CRC, a chained FIT file may hold
        // another header+data segment (activity pools). Keep parsing while a
        // valid header follows; local definitions carry over.
        let next = body_end + 2;
        if next + 12 <= data.len()
            && (data[next] == 12 || data[next] == 14)
            && &data[next + 8..next + 12] == b".FIT"
        {
            let hs = data[next] as usize;
            let dsz = u32::from_le_bytes([
                data[next + 4],
                data[next + 5],
                data[next + 6],
                data[next + 7],
            ]) as usize;
            if dsz > 0 && next + hs + dsz <= data.len() {
                pos = next + hs;
                body_end = next + hs + dsz;
                continue 'segments;
            }
        }
        break 'segments;
    }

    if points.is_empty() {
        return Err("No valid record points found in FIT file".into());
    }

    recompute_distance_if_needed(&mut points);
    let summary = compute_summary(&points);
    Ok(ActivityData { points, summary })
}

// ─── Reference parser (fitparser crate) — fallback path ────────────────────

/// Reference FIT parse using the `fitparser` crate (kept as the fallback
/// for files the fast reader cannot handle).
fn parse_fit_reference(data: &[u8]) -> Result<ActivityData, String> {
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

    recompute_distance_if_needed(&mut points);

    let summary = compute_summary(&points);

    Ok(ActivityData { points, summary })
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

    // Despike altitudes before integrating D+ — raw per-sample barometric
    // noise otherwise inflates elevation gain by hundreds of metres on
    // long rides (same median filter as the GPX route path).
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
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Minimal FIT encoder for tests ──

    /// FIT CRC-16 as implemented in the FIT SDK (fit_crc.c) — nibble
    /// table variant, init 0. The naive MSB-first CCITT variant produces a
    /// different value and is rejected by the reference parser.
    const CRC_TABLE: [u16; 16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800,
        0xB400, 0x5000, 0x9C01, 0x8800, 0x4400,
    ];

    fn fit_crc16(data: &[u8]) -> u16 {
        let mut crc: u16 = 0;
        for &byte in data {
            let mut tmp = CRC_TABLE[(crc & 0xF) as usize];
            crc = (crc >> 4) & 0x0FFF;
            crc ^= tmp ^ CRC_TABLE[(byte & 0xF) as usize];
            tmp = CRC_TABLE[(crc & 0xF) as usize];
            crc = (crc >> 4) & 0x0FFF;
            crc ^= tmp ^ CRC_TABLE[((byte >> 4) & 0xF) as usize];
        }
        crc
    }

    const T_SEMI: u32 = 631_234_800; // arbitrary FIT-epoch timestamp

    #[derive(Clone)]
    struct RecordSpec {
        /// None → invalid sentinel (i32::MAX), point must be skipped
        lat_semi: Option<i32>,
        lon_semi: i32,
        altitude_m: f64,
        speed_ms: f64,
        power_w: u16,
        cadence: u8,
        hr: u8,
        temp: i8,
        distance_m: f64,
    }

    fn spec(i: usize) -> RecordSpec {
        RecordSpec {
            lat_semi: Some(degrees_to_semicircles(45.0 + i as f64 * 0.0001)),
            lon_semi: degrees_to_semicircles(6.0 + i as f64 * 0.0001),
            altitude_m: 500.0 + i as f64 * 0.5,
            speed_ms: 8.0,
            power_w: 210,
            cadence: 85,
            hr: 140,
            temp: 20,
            distance_m: i as f64 * 10.0,
        }
    }

    fn write_record_payload(body: &mut Vec<u8>, s: &RecordSpec, valid_power: bool) {
        // matches the definition built in encode_test_fit (33 bytes + dev 2)
        match s.lat_semi {
            Some(v) => body.extend_from_slice(&v.to_le_bytes()),
            None => body.extend_from_slice(&i32::MAX.to_le_bytes()),
        }
        body.extend_from_slice(&s.lon_semi.to_le_bytes());
        body.extend_from_slice(&(((s.altitude_m + 500.0) * 5.0) as u16).to_le_bytes());
        body.push(s.hr);
        body.push(s.cadence);
        body.extend_from_slice(&((s.distance_m * 100.0) as u32).to_le_bytes());
        body.extend_from_slice(&((s.speed_ms * 1000.0) as u16).to_le_bytes());
        let pw: u16 = if valid_power { s.power_w } else { 0xFFFF };
        body.extend_from_slice(&pw.to_le_bytes());
        body.push(s.temp as u8);
        body.extend_from_slice(&(((s.altitude_m + 500.0) * 5.0) as u32).to_le_bytes());
        body.extend_from_slice(&((s.speed_ms * 1000.0) as u32).to_le_bytes());
    }

    fn write_dev_bytes(body: &mut Vec<u8>, protocol_2: bool) {
        if protocol_2 {
            body.push(0xAB);
            body.push(0xCD);
        }
    }

    /// Encode a synthetic FIT file: file-id def+msg, Record def (local 0),
    /// `n` record messages, optionally one invalid-GPS record and one
    /// compressed-timestamp record, plus a developer field when
    /// protocol 2.0 is requested.
    fn encode_test_fit(n: usize, protocol_2: bool, inject_invalid: bool) -> Vec<u8> {
        let mut body: Vec<u8> = Vec::new();

        // FileId definition (local 1): fields 253 (time) + 0 (type)
        body.push(0x41);
        body.extend_from_slice(&[0x00, 0x00]); // reserved, architecture LE
        body.extend_from_slice(&0u16.to_le_bytes()); // global msg 0
        body.push(2);
        body.extend_from_slice(&[253, 0x04, BASE_UINT32]);
        body.extend_from_slice(&[0x00, 0x01, BASE_UINT8]);
        // FileId data (local 1): time + type(4 = activity) = 5 bytes
        body.push(0x01);
        body.extend_from_slice(&T_SEMI.to_le_bytes());
        body.push(4);

        // Record definition (local 0) — header bit 0x20 when developer
        // fields are present (same signal the reference parser uses).
        body.push(if protocol_2 { 0x60 } else { 0x40 });
        body.extend_from_slice(&[0x00, 0x00]);
        body.extend_from_slice(&20u16.to_le_bytes()); // global msg 20 (Record)
        let fields: &[(u16, u8, u8)] = &[
            (253, 4, BASE_UINT32), // timestamp
            (0, 4, BASE_SINT32),   // position_lat
            (1, 4, BASE_SINT32),   // position_long
            (2, 2, BASE_UINT16),   // altitude
            (3, 1, BASE_UINT8),    // heart_rate
            (4, 1, BASE_UINT8),    // cadence
            (5, 4, BASE_UINT32),   // distance
            (6, 2, BASE_UINT16),   // speed
            (7, 2, BASE_UINT16),   // power
            (13, 1, BASE_SINT8),   // temperature
            (17, 4, BASE_UINT32),  // enhanced_altitude
            (18, 4, BASE_UINT32),  // enhanced_speed
        ];
        body.push(fields.len() as u8);
        for &(num, size, base) in fields {
            body.push(num as u8);
            body.push(size);
            body.push(base);
        }
        if protocol_2 {
            // one 2-byte developer field — ignored by our reader
            body.push(1);
            body.push(250); // field number
            body.push(2); // size
            body.push(0); // developer data index
        }

        for i in 0..n {
            let s = spec(i);
            let ts = T_SEMI + (i as u32) * 60;
            // One invalid-power sample mid-file to test sentinel handling
            let valid_power = inject_invalid && i != n / 2 || !inject_invalid;
            body.push(0x00); // local 0 data message
            body.extend_from_slice(&ts.to_le_bytes());
            write_record_payload(&mut body, &s, valid_power);
            write_dev_bytes(&mut body, protocol_2);
        }

        if inject_invalid && n > 2 {
            // One invalid-GPS record (skipped by the parser)
            let mut s = spec(n);
            s.lat_semi = None;
            body.push(0x00);
            body.extend_from_slice(&(T_SEMI + n as u32 * 60).to_le_bytes());
            write_record_payload(&mut body, &s, true);
            write_dev_bytes(&mut body, protocol_2);
        }

        // One compressed-timestamp record (local 0, offset 1 s → rollover).
        // Same byte layout as a normal record (incl. the timestamp slot);
        // the compressed header timestamp overrides the field value.
        {
            let mut s = spec(n);
            s.distance_m += 10.0;
            body.push(0x80 | 0x01); // compressed header: local 0, offset 1
            let _ignored_ts = T_SEMI + n as u32 * 60;
            body.extend_from_slice(&_ignored_ts.to_le_bytes());
            write_record_payload(&mut body, &s, true);
            write_dev_bytes(&mut body, protocol_2);
        }

        // 12-byte header + body + file CRC
        let mut file: Vec<u8> = Vec::with_capacity(body.len() + 14);
        file.push(12);
        file.push(if protocol_2 { 0x20 } else { 0x10 });
        file.extend_from_slice(&2132u16.to_le_bytes()); // profile version
        file.extend_from_slice(&(body.len() as u32).to_le_bytes());
        file.extend_from_slice(b".FIT");
        file.extend_from_slice(&body);
        let crc = fit_crc16(&file);
        file.extend_from_slice(&crc.to_le_bytes());
        file
    }

    fn degrees_to_semicircles(deg: f64) -> i32 {
        (deg * (2_147_483_648.0_f64 / 180.0)).round() as i32
    }

    #[test]
    fn test_fast_parser_synthetic() {
        for protocol_2 in [false, true] {
            let data = encode_test_fit(50, protocol_2, true);
            let activity = parse_fit_fast(&data)
                .unwrap_or_else(|e| panic!("protocol_2={protocol_2}: {e}"));

            // 50 valid records; the invalid-GPS record is skipped; the
            // compressed-timestamp record is kept.
            assert_eq!(activity.points.len(), 51, "protocol_2={protocol_2}");

            let p0 = &activity.points[0];
            assert!((p0.lat - 45.0).abs() < 1e-6);
            assert!((p0.lon - 6.0).abs() < 1e-6);
            assert!((p0.timestamp_s - 0.0).abs() < 1e-9);
            assert!((p0.speed_ms - 8.0).abs() < 1e-9);
            assert!((p0.altitude_m - 500.0).abs() < 0.01);
            assert!((p0.distance_m - 0.0).abs() < 1e-9);
            assert!((p0.heart_rate_bpm - 140.0).abs() < 1e-9);
            assert!((p0.cadence_rpm - 85.0).abs() < 1e-9);
            assert!((p0.temperature_c - 20.0).abs() < 1e-9);
            assert!((p0.power_w - 210.0).abs() < 1e-9);

            // Invalid power sentinel → 0
            let mid = &activity.points[25];
            assert!((mid.power_w - 0.0).abs() < 1e-9, "invalid power must read 0");

            // Compressed-timestamp record survived with correct distance
            let last = activity.points.last().unwrap();
            assert!(
                (last.distance_m - 510.0).abs() < 0.5,
                "got {}",
                last.distance_m
            );
            // and its timestamp advanced past the previous valid point
            let prev = &activity.points[49];
            assert!(last.timestamp_s > prev.timestamp_s);
        }
    }

    #[test]
    fn test_parse_fit_falls_back_on_garbage() {
        // Not a FIT file → both parsers fail, error surfaced
        assert!(parse_fit(b"not a fit file at all").is_err());
        assert!(parse_fit(&[]).is_err());
    }

    #[test]
    fn test_summary_and_distance_recompute() {
        let data = encode_test_fit(30, false, false);
        let activity = parse_fit_fast(&data).unwrap();
        // distance field present and valid → no recompute needed
        assert!(activity.summary.distance_m > 100.0);
        assert!(activity.summary.duration_s > 0.0);
        assert!(activity.summary.elevation_gain_m > 0.0);
        assert!(activity.summary.has_hr);
    }

    /// Perf smoke test on a large synthetic file (500k records).
    /// Run with: cargo test --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn test_bench_parse_large_fit() {
        let n = 500_000;
        let data = encode_test_fit(n, true, false);
        let t0 = std::time::Instant::now();
        let activity = parse_fit_fast(&data).expect("fast parse");
        let fast_ms = t0.elapsed().as_millis();
        assert_eq!(activity.points.len(), n + 1);
        println!("fast parser: {} records in {} ms", n + 1, fast_ms);
    }
}
