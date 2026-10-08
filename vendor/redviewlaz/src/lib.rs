//! Décodeur des chunks COPC du viewer LiDAR (src/features/lidar/lib/laz/).
//!
//! Un nœud COPC est un chunk LAZ 1.4 « en couches » (formats de point 6 à 8) :
//! chaque champ est compressé dans sa propre couche, donc on peut ne
//! décompresser que ce que le viewer lit — X/Y (toujours), Z, classe,
//! intensité et RVB — en sautant temps GPS, angle de scan, identifiant de
//! source, données utilisateur et drapeaux. Sur des tuiles IGN LiDAR HD
//! (format 6) : ≈ 2 × plus rapide que laz-perf (WASM), octets identiques.
//!
//! Positions relatives à l'origine de la tuile, calculées comme le décodeur
//! JS de secours (`decodeCopcChunks`) : `X · échelle + (décalage − origine)`
//! en f64, rangé en f32 ; bornes prises sur les valeurs f64.

use std::io::Cursor;

use laz::record::{LayeredPointRecordDecompressor, RecordDecompressor};
use laz::{DecompressionSelection, LazItem, LazItemRecordBuilder};
use wasm_bindgen::prelude::*;

/// Octet de début du RVB (u16 × 3) dans un enregistrement 7/8, après le temps GPS.
const RGB_OFFSET: usize = 30;

#[wasm_bindgen]
pub struct CopcDecoder {
    items: Vec<LazItem>,
    record_length: usize,
    with_rgb: bool,
    scale: [f64; 3],
    local_offset: [f64; 3],
    positions: Vec<f32>,
    classifications: Vec<u8>,
    intensities: Vec<u16>,
    colors: Vec<u8>,
    max_rgb: u16,
    /// min x, y, z puis max x, y, z (relatifs à l'origine).
    bounds: [f64; 6],
}

fn base_record_length(format: u8) -> Option<u16> {
    match format {
        6 => Some(30),
        7 => Some(36),
        8 => Some(38),
        _ => None,
    }
}

#[wasm_bindgen]
impl CopcDecoder {
    /// `local_offset` = décalage de l'en-tête LAS − origine de la tuile.
    #[wasm_bindgen(constructor)]
    pub fn new(point_format: u8, record_length: u16, scale: &[f64], local_offset: &[f64]) -> Result<CopcDecoder, JsError> {
        let format = point_format & 0x3f;
        let base = base_record_length(format).ok_or_else(|| JsError::new(&format!("Format de point COPC non pris en charge : {format}")))?;
        if record_length < base || scale.len() < 3 || local_offset.len() < 3 {
            return Err(JsError::new("En-tête COPC incohérent"));
        }
        let items = LazItemRecordBuilder::default_for_point_format_id(format, record_length - base)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(CopcDecoder {
            items,
            record_length: record_length as usize,
            with_rgb: format != 6,
            scale: [scale[0], scale[1], scale[2]],
            local_offset: [local_offset[0], local_offset[1], local_offset[2]],
            positions: Vec::new(),
            classifications: Vec::new(),
            intensities: Vec::new(),
            colors: Vec::new(),
            max_rgb: 0,
            bounds: [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
        })
    }

    /// Décode un chunk et ajoute ses points à la suite des précédents.
    pub fn decode(&mut self, chunk: &[u8], point_count: u32) -> Result<(), JsError> {
        self.decode_chunk(chunk, point_count as usize).map_err(|e| JsError::new(&e))
    }

    pub fn take_positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.positions)
    }

    pub fn take_classifications(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.classifications)
    }

    pub fn take_intensities(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.intensities)
    }

    /// Octets de poids fort du RVB 16 bits (vide pour le format 6).
    pub fn take_colors(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.colors)
    }

    /// Plus grande composante RVB 16 bits lue (0 sans couleur).
    pub fn max_rgb(&self) -> u16 {
        self.max_rgb
    }

    /// min x, y, z, max x, y, z des points décodés, relatifs à l'origine.
    pub fn bounds(&self) -> Vec<f64> {
        self.bounds.to_vec()
    }
}

impl CopcDecoder {
    fn decode_chunk(&mut self, chunk: &[u8], count: usize) -> Result<(), String> {
        let mut decompressor = LayeredPointRecordDecompressor::new(Cursor::new(chunk));
        decompressor.set_fields_from(&self.items).map_err(|e| e.to_string())?;
        let mut selection = DecompressionSelection::base()
            .decompress_z()
            .decompress_classification()
            .decompress_intensity();
        if self.with_rgb {
            selection = selection.decompress_rgb();
        }
        decompressor.set_selection(selection);

        let [sx, sy, sz] = self.scale;
        let [ox, oy, oz] = self.local_offset;
        let mut record = vec![0u8; self.record_length];
        self.positions.reserve(count * 3);
        self.classifications.reserve(count);
        self.intensities.reserve(count);
        if self.with_rgb {
            self.colors.reserve(count * 3);
        }
        let b = &mut self.bounds;
        for _ in 0..count {
            decompressor.decompress_next(&mut record).map_err(|e| format!("Chunk COPC illisible : {e}"))?;
            let x = i32::from_le_bytes([record[0], record[1], record[2], record[3]]) as f64 * sx + ox;
            let y = i32::from_le_bytes([record[4], record[5], record[6], record[7]]) as f64 * sy + oy;
            let z = i32::from_le_bytes([record[8], record[9], record[10], record[11]]) as f64 * sz + oz;
            self.positions.extend_from_slice(&[x as f32, y as f32, z as f32]);
            self.intensities.push(u16::from_le_bytes([record[12], record[13]]));
            self.classifications.push(record[16]);
            if x < b[0] { b[0] = x; }
            if x > b[3] { b[3] = x; }
            if y < b[1] { b[1] = y; }
            if y > b[4] { b[4] = y; }
            if z < b[2] { b[2] = z; }
            if z > b[5] { b[5] = z; }
            if self.with_rgb {
                for c in 0..3 {
                    let at = RGB_OFFSET + 2 * c;
                    let v = u16::from_le_bytes([record[at], record[at + 1]]);
                    if v > self.max_rgb {
                        self.max_rgb = v;
                    }
                    self.colors.push((v >> 8) as u8);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;
    use laz::record::{LayeredPointRecordCompressor, RecordCompressor};

    /// Enregistrements LAS synthétiques (tous les champs remplis, pour que les
    /// couches sautées ne soient pas vides) compressés en un chunk en couches.
    fn compressed_chunk(format: u8, count: usize) -> (Vec<u8>, Vec<Vec<u8>>) {
        let base = base_record_length(format).unwrap() as usize;
        let items = LazItemRecordBuilder::default_for_point_format_id(format, 0).unwrap();
        let mut compressor = LayeredPointRecordCompressor::new(Cursor::new(Vec::new()));
        compressor.set_fields_from(&items).unwrap();
        let mut seed = 0x2545_f491u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut records = Vec::new();
        for i in 0..count {
            let mut r = vec![0u8; base];
            let x = 96_500_000 + (i as i32 % 300) * 37 + (next() % 50) as i32;
            let y = 649_900_000 + (i as i32 / 300) * 41 + (next() % 50) as i32;
            let z = 200_000 + (next() % 30_000) as i32;
            r[0..4].copy_from_slice(&x.to_le_bytes());
            r[4..8].copy_from_slice(&y.to_le_bytes());
            r[8..12].copy_from_slice(&z.to_le_bytes());
            r[12..14].copy_from_slice(&((next() % 4096) as u16).to_le_bytes());
            r[14] = 0x11 + (next() % 2) as u8; // return 1 of 1 or 2
            r[15] = (next() % 4) as u8; // class flags, channel, scan direction
            r[16] = [2u8, 3, 4, 5, 6, 9][next() as usize % 6];
            r[17] = (next() % 255) as u8; // user data
            r[18..20].copy_from_slice(&((next() % 3000) as i16 - 1500).to_le_bytes());
            r[20..22].copy_from_slice(&((next() % 40) as u16).to_le_bytes());
            r[22..30].copy_from_slice(&(3.0e8 + i as f64 * 1e-4).to_le_bytes());
            if format != 6 {
                for c in 0..3 {
                    r[30 + 2 * c..32 + 2 * c].copy_from_slice(&((next() % 65536) as u16).to_le_bytes());
                }
            }
            if format == 8 {
                r[36..38].copy_from_slice(&((next() % 65536) as u16).to_le_bytes());
            }
            compressor.compress_next(&r).unwrap();
            records.push(r);
        }
        compressor.done().unwrap();
        (compressor.into_inner().into_inner(), records)
    }

    fn check(format: u8) {
        let (chunk, records) = compressed_chunk(format, 5000);
        let scale = [0.01, 0.01, 0.01];
        let offset = [-965_000.0, -6_499_000.0, 0.0];
        let mut decoder = CopcDecoder::new(format, base_record_length(format).unwrap(), &scale, &offset).unwrap();
        // Deux chunks à la suite : les points sont ajoutés à la fin.
        decoder.decode_chunk(&chunk, records.len()).unwrap();
        decoder.decode_chunk(&chunk, records.len()).unwrap();
        let positions = decoder.take_positions();
        let classes = decoder.take_classifications();
        let intensities = decoder.take_intensities();
        let colors = decoder.take_colors();
        assert_eq!(classes.len(), 2 * records.len());
        let mut max_rgb = 0u16;
        for (k, r) in records.iter().chain(records.iter()).enumerate() {
            let i32_at = |at: usize| i32::from_le_bytes([r[at], r[at + 1], r[at + 2], r[at + 3]]) as f64;
            assert_eq!(positions[k * 3], (i32_at(0) * 0.01 - 965_000.0) as f32);
            assert_eq!(positions[k * 3 + 1], (i32_at(4) * 0.01 - 6_499_000.0) as f32);
            assert_eq!(positions[k * 3 + 2], (i32_at(8) * 0.01) as f32);
            assert_eq!(intensities[k], u16::from_le_bytes([r[12], r[13]]));
            assert_eq!(classes[k], r[16]);
            if format != 6 {
                for c in 0..3 {
                    let v = u16::from_le_bytes([r[30 + 2 * c], r[31 + 2 * c]]);
                    max_rgb = max_rgb.max(v);
                    assert_eq!(colors[k * 3 + c], (v >> 8) as u8);
                }
            }
        }
        assert_eq!(decoder.max_rgb(), max_rgb);
        if format == 6 {
            assert!(colors.is_empty());
        }
        let b = decoder.bounds();
        assert!(b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5]);
    }

    #[test]
    fn decodes_point_format_6() {
        check(6);
    }

    #[test]
    fn decodes_point_format_7_with_rgb() {
        check(7);
    }

    #[test]
    fn decodes_point_format_8_with_rgb() {
        check(8);
    }

    #[test]
    fn rejects_a_truncated_chunk() {
        let (chunk, records) = compressed_chunk(6, 2000);
        let mut decoder = CopcDecoder::new(6, 30, &[0.01; 3], &[0.0; 3]).unwrap();
        assert!(decoder.decode_chunk(&chunk[..chunk.len() / 3], records.len()).is_err());
    }

    #[test]
    fn rejects_point_formats_without_layers() {
        assert!(base_record_length(3).is_none());
    }
}
