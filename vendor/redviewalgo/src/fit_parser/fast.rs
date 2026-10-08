use super::summary::{compute_summary, recompute_distance_if_needed};
use super::{merge_sport, FIT_FILE_TYPE_COURSE, NOT_AN_ACTIVITY_ERR};
use crate::types::{ActivityData, DataPoint};

/// Numéro de message global FIT des messages File Id, et son champ `type`.
const MSG_FILE_ID: u16 = 0;
const FILE_ID_TYPE_FIELD: u16 = 0;
fn decode_file_type(payload: &[u8], def: &LocalDef) -> Option<u8> {
    def.fields
        .iter()
        .find(|&&(fnum, _, size, _)| fnum == FILE_ID_TYPE_FIELD && size == 1)
        .and_then(|&(_, off, size, base)| read_scalar(payload, off as usize, size, base, def.big_endian))
        .map(|v| v as u8)
}

// ─── Lecteur FIT rapide en flux ─────────────────────────────────────────────
//
// L'analyseur de référence matérialise chaque message de chaque type (tours,
// événements, sessions…) en structures possédées avec des chaînes de nom par
// champ et des conversions d'énumérations. Sur les longs fichiers FIT, cela
// domine le temps total de prédiction. Ce lecteur comprend juste assez du
// format binaire FIT pour :
//   * parcourir les paires de messages de définition / de données (horodatages compressés compris),
//   * sauter les messages autres que Record en O(1) grâce à leur longueur calculée,
//   * décoder la poignée de champs Record utilisés, avec les bons
//     échelle / décalage et les sentinelles de valeur invalide de FIT.
// Tout ce qui est inattendu renvoie Err et `parse_fit` se replie sur
// l'analyseur de référence.

/// Numéro de message global FIT des messages Record.
const MSG_RECORD: u16 = 20;
/// Numéros de message globaux FIT qui portent le sport de l'activité (champ `sport`).
const MSG_SESSION: u16 = 18;
const MSG_SPORT: u16 = 12;
/// Numéro du champ `sport` dans les messages Session (5) et Sport (0).
const SESSION_SPORT_FIELD: u16 = 5;
const SPORT_SPORT_FIELD: u16 = 0;

/// Identifiants de type de base (protocole FIT §3.3.1).
const BASE_ENUM: u8 = 0x00;
pub(super) const BASE_SINT8: u8 = 0x01;
pub(super) const BASE_UINT8: u8 = 0x02;
const BASE_SINT16: u8 = 0x03;
pub(super) const BASE_UINT16: u8 = 0x04;
pub(super) const BASE_SINT32: u8 = 0x05;
pub(super) const BASE_UINT32: u8 = 0x06;
const BASE_FLOAT32: u8 = 0x08;
const BASE_FLOAT64: u8 = 0x09;
const BASE_UINT8Z: u8 = 0x0A;
const BASE_UINT16Z: u8 = 0x0B;
const BASE_UINT32Z: u8 = 0x0C;
const BASE_SINT64: u8 = 0x0E;
const BASE_UINT64: u8 = 0x0F;

/// Un message de définition : disposition des champs + longueur totale de la
/// charge utile. La longueur sert à sauter tout message en O(1) ; la
/// disposition des champs ne compte que pour les messages Record.
struct LocalDef {
    global_msg_num: u16,
    big_endian: bool,
    /// (field_number, payload_offset, size, base_type)
    fields: Vec<(u16, u16, u8, u8)>,
    total_size: usize,
}

/// Valeurs décodées d'un message Record (échelle / décalage appliqués).
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
    /// Les champs « enhanced » l'emportent sur leurs équivalents standard quand ils sont présents.
    fn altitude(&self) -> Option<f64> {
        self.alt_enh.or(self.alt_std)
    }
    fn speed(&self) -> Option<f64> {
        self.speed_enh.or(self.speed_std)
    }
}

/// Lit la valeur d'un champ numérique, en appliquant les sentinelles de valeur invalide de FIT.
/// Renvoie None pour les valeurs invalides / non prises en charge.
fn read_scalar(d: &[u8], off: usize, size: u8, base: u8, be: bool) -> Option<f64> {
    let end = off.checked_add(size as usize)?;
    if end > d.len() {
        return None;
    }
    let v: f64 = match base & 0x7F {
        BASE_SINT8 if size == 1 => d[off] as i8 as f64,
        BASE_ENUM | BASE_UINT8 if size == 1 => d[off] as f64,
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
        BASE_ENUM | BASE_UINT8 => v == 255.0,
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

/// Décode la charge utile d'un message Record à l'aide de sa définition.
fn decode_record_message(payload: &[u8], def: &LocalDef) -> RecordValues {
    let mut v = RecordValues::default();
    let be = def.big_endian;
    for &(fnum, off, size, base) in &def.fields {
        let off = off as usize;
        let s = read_scalar(payload, off, size, base, be);
        match fnum {
            // échelle / décalage selon le profil FIT (message Record).
            0 => v.lat_semi = s.map(|x| x as i32),
            1 => v.lon_semi = s.map(|x| x as i32),
            2 => v.alt_std = s.map(|x| x / 5.0 - 500.0),
            3 => v.hr = s,
            4 => v.cadence = s,
            5 => v.distance = s.map(|x| x / 100.0),
            6 => v.speed_std = s.map(|x| x / 1000.0),
            7 => v.power = s,
            13 => v.temperature = s,
            17 | 78 => v.alt_enh = s.map(|x| x / 5.0 - 500.0),
            18 | 73 => v.speed_enh = s.map(|x| x / 1000.0),
            28 => v.frac_cadence = s.map(|x| x / 128.0),
            253 => v.timestamp = s.map(|x| x as u32),
            _ => {}
        }
    }
    v
}

/// Lit l'énumération FIT `sport` dans la charge utile d'un message Session ou Sport.
fn decode_sport_message(payload: &[u8], def: &LocalDef) -> Option<u8> {
    let wanted = match def.global_msg_num {
        MSG_SESSION => SESSION_SPORT_FIELD,
        MSG_SPORT => SPORT_SPORT_FIELD,
        _ => return None,
    };
    def.fields
        .iter()
        .find(|&&(fnum, _, size, _)| fnum == wanted && size == 1)
        .and_then(|&(_, off, size, base)| read_scalar(payload, off as usize, size, base, def.big_endian))
        .map(|v| v as u8)
}

/// Construit un DataPoint à partir des valeurs Record décodées.
/// Renvoie None quand la position GPS ou l'horodatage manque / est invalide
/// (même règle d'exclusion que l'analyseur de référence). L'altitude reprend la
/// dernière valeur valide au lieu de tomber à 0 sur les échantillons invalides.
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

/// Analyse un message de définition qui commence à `pos` (juste après son
/// octet d'en-tête). `has_dev_fields` est le bit 0x20 de l'en-tête de
/// définition, par lequel le protocole FIT marque les définitions qui portent
/// des champs développeur (même signal que celui de l'analyseur de référence).
/// Renvoie la définition et la position juste après elle.
fn parse_definition(
    data: &[u8],
    pos: usize,
    end: usize,
    has_dev_fields: bool,
) -> Result<(LocalDef, usize), String> {
    // réservé(1) + architecture(1) + n° de message global(2) + nombre de champs(1)
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

    // Les messages de définition du protocole FIT ≥ 2.0 peuvent porter un octet
    // de nombre de champs développeur (éventuellement nul) suivi de définitions
    // de champs développeur de 3 octets. On les saute, mais il faut compter
    // leur taille dans les messages de données.
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
            // Le second octet est la taille dans la disposition de la définition de champ.
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

/// Analyse FIT rapide en flux. Les erreurs déclenchent le repli sur l'analyseur de référence.
pub(super) fn parse_fit_fast(data: &[u8]) -> Result<ActivityData, String> {
    // ── En-tête du fichier ──
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

    // Indication grossière de capacité : les records font ≥ ~30 octets en pratique.
    let mut points: Vec<DataPoint> = Vec::with_capacity((body_end - body_start) / 30 + 16);

    let mut local_defs: Vec<Option<LocalDef>> = (0..16).map(|_| None).collect();
    let mut last_timestamp: u32 = 0;
    let mut first_timestamp: Option<f64> = None;
    let mut last_altitude: f64 = 0.0;
    let mut sport: Option<u8> = None;

    let mut pos = body_start;
    'segments: loop {
        while pos < body_end {
            let header_byte = data[pos];

            if header_byte & 0x80 != 0 {
                // ── Message de données à horodatage compressé ──
                // bits 5-6 : type de message local (0-3), bits 0-4 : décalage temporel
                let local = ((header_byte >> 5) & 0x03) as usize;
                let offset = (header_byte & 0x1F) as u32;
                pos += 1;
                let def = local_defs[local]
                    .as_ref()
                    .ok_or("FIT: compressed message without definition")?;

                // Avance la référence d'horodatage (compteur à bouclage de 32 s).
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
                } else if def.global_msg_num == MSG_SESSION || def.global_msg_num == MSG_SPORT {
                    let value = decode_sport_message(&data[pos..payload_end], def);
                    merge_sport(&mut sport, def.global_msg_num == MSG_SESSION, value);
                } else if def.global_msg_num == MSG_FILE_ID
                    && decode_file_type(&data[pos..payload_end], def) == Some(FIT_FILE_TYPE_COURSE)
                {
                    return Err(NOT_AN_ACTIVITY_ERR.into());
                }
                pos = payload_end;
            } else if header_byte & 0x40 != 0 {
                // ── Message de définition ──
                pos += 1;
                // Le bit 0x20 marque les définitions qui portent des champs développeur.
                let has_dev = header_byte & 0x20 != 0;
                let (def, new_pos) = parse_definition(data, pos, body_end, has_dev)?;
                local_defs[(header_byte & 0x0F) as usize] = Some(def);
                pos = new_pos;
            } else {
                // ── Message de données normal ──
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
                } else if def.global_msg_num == MSG_SESSION || def.global_msg_num == MSG_SPORT {
                    let value = decode_sport_message(&data[pos..payload_end], def);
                    merge_sport(&mut sport, def.global_msg_num == MSG_SESSION, value);
                } else if def.global_msg_num == MSG_FILE_ID
                    && decode_file_type(&data[pos..payload_end], def) == Some(FIT_FILE_TYPE_COURSE)
                {
                    return Err(NOT_AN_ACTIVITY_ERR.into());
                }
                pos = payload_end;
            }
        }

        // Après le CRC de fichier de 2 octets de ce segment, un fichier FIT
        // chaîné peut contenir un autre segment en-tête + données (groupes
        // d'activités). On continue tant qu'un en-tête valide suit ; les
        // définitions locales sont conservées.
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
    let mut summary = compute_summary(&points);
    summary.sport = sport;
    Ok(ActivityData { points, summary })
}
