use super::fast::{BASE_SINT32, BASE_SINT8, BASE_UINT16, BASE_UINT32, BASE_UINT8};
use super::*;

// ── Encodeur FIT minimal pour les tests ──

/// CRC-16 de FIT tel qu'implémenté dans le SDK FIT (fit_crc.c) — variante à
/// table de quartets, initialisée à 0. La variante CCITT naïve, bit de poids
/// fort d'abord, donne une autre valeur et est refusée par l'analyseur de référence.
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
    /// None → sentinelle invalide (i32::MAX), le point doit être sauté
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
    // correspond à la définition construite dans encode_test_fit (33 octets + dev 2)
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

/// Encode un fichier FIT synthétique : déf + message file-id, déf Record
/// (local 0), `n` messages record, en option un record à GPS invalide et un
/// record à horodatage compressé, plus un champ développeur quand le
/// protocole 2.0 est demandé.
fn encode_test_fit(n: usize, protocol_2: bool, inject_invalid: bool) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::new();

    // Définition FileId (local 1) : champs 253 (time) + 0 (type)
    body.push(0x41);
    body.extend_from_slice(&[0x00, 0x00]); // reserved, architecture LE
    body.extend_from_slice(&0u16.to_le_bytes()); // global msg 0
    body.push(2);
    body.extend_from_slice(&[253, 0x04, BASE_UINT32]);
    body.extend_from_slice(&[0x00, 0x01, BASE_UINT8]);
    // Données FileId (local 1) : time + type(4 = activité) = 5 octets
    body.push(0x01);
    body.extend_from_slice(&T_SEMI.to_le_bytes());
    body.push(4);

    // Définition Record (local 0) — bit d'en-tête 0x20 quand des champs
    // développeur sont présents (même signal que l'analyseur de référence).
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
        // un champ développeur de 2 octets — ignoré par notre lecteur
        body.push(1);
        body.push(250); // field number
        body.push(2); // size
        body.push(0); // developer data index
    }

    for i in 0..n {
        let s = spec(i);
        let ts = T_SEMI + (i as u32) * 60;
        // Un échantillon de puissance invalide au milieu du fichier pour tester la gestion des sentinelles
        let valid_power = inject_invalid && i != n / 2 || !inject_invalid;
        body.push(0x00); // local 0 data message
        body.extend_from_slice(&ts.to_le_bytes());
        write_record_payload(&mut body, &s, valid_power);
        write_dev_bytes(&mut body, protocol_2);
    }

    if inject_invalid && n > 2 {
        // Un record à GPS invalide (sauté par l'analyseur)
        let mut s = spec(n);
        s.lat_semi = None;
        body.push(0x00);
        body.extend_from_slice(&(T_SEMI + n as u32 * 60).to_le_bytes());
        write_record_payload(&mut body, &s, true);
        write_dev_bytes(&mut body, protocol_2);
    }

    // Un record à horodatage compressé (local 0, décalage 1 s → bouclage).
    // Même disposition d'octets qu'un record normal (emplacement de
    // l'horodatage compris) ; l'horodatage compressé de l'en-tête remplace la valeur du champ.
    {
        let mut s = spec(n);
        s.distance_m += 10.0;
        body.push(0x80 | 0x01); // compressed header: local 0, offset 1
        let _ignored_ts = T_SEMI + n as u32 * 60;
        body.extend_from_slice(&_ignored_ts.to_le_bytes());
        write_record_payload(&mut body, &s, true);
        write_dev_bytes(&mut body, protocol_2);
    }

    // en-tête de 12 octets + corps + CRC du fichier
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

        // 50 records valides ; le record à GPS invalide est sauté ; le record à
        // horodatage compressé est gardé.
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

        // Sentinelle de puissance invalide → 0
        let mid = &activity.points[25];
        assert!((mid.power_w - 0.0).abs() < 1e-9, "invalid power must read 0");

        // Le record à horodatage compressé a survécu avec la bonne distance
        let last = activity.points.last().unwrap();
        assert!(
            (last.distance_m - 510.0).abs() < 0.5,
            "got {}",
            last.distance_m
        );
        // et son horodatage a dépassé le point valide précédent
        let prev = &activity.points[49];
        assert!(last.timestamp_s > prev.timestamp_s);
    }
}

#[test]
fn test_parse_fit_falls_back_on_garbage() {
    // Pas un fichier FIT → les deux analyseurs échouent, l'erreur remonte
    assert!(parse_fit(b"not a fit file at all").is_err());
    assert!(parse_fit(&[]).is_err());
}

#[test]
fn test_summary_and_distance_recompute() {
    let data = encode_test_fit(30, false, false);
    let activity = parse_fit_fast(&data).unwrap();
    // champ distance présent et valide → aucun recalcul nécessaire
    assert!(activity.summary.distance_m > 100.0);
    assert!(activity.summary.duration_s > 0.0);
    assert!(activity.summary.elevation_gain_m > 0.0);
    assert!(activity.summary.has_hr);
}

/// Test de performance rapide sur un gros fichier synthétique (500 k records).
/// Lancement : cargo test --release -- --ignored --nocapture
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
