//! Entrée brute d'un tracé et nettoyage.
//!
//! Codage des attributs par point (valables du point au suivant) :
//! - `surface` : bits 0-3 = revêtement (0 inconnu, 1 asphalte, 2 pavé/béton,
//!   3 gravier, 4 terre, 5 sable), bits 4-6 = rugosité (0 inconnue, 1 bonne,
//!   2 moyenne, 3 mauvaise, 4 très mauvaise) ;
//! - `way` : bits 0-3 = type de voie (voir `params`), bit 6 = agglomération,
//!   bit 7 = feu / stop au point.

use serde::{Deserialize, Serialize};

use crate::math::haversine_distance;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GeometrySource {
    /// Tracé planifié (BRouter, OSM) : sommets exacts.
    Planned,
    /// Trace GPS enregistrée : bruit de quelques mètres.
    Gps,
    /// Inconnu (GPX importé).
    #[default]
    Auto,
}

#[derive(Debug, Clone, Default)]
pub struct CourseInput {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    /// Altitude (m), NaN si absente.
    pub ele: Vec<f64>,
    /// Axe de distance de l'app (m), même longueur que `lat` ; vide = haversine.
    pub dist: Vec<f64>,
    pub surface: Vec<u8>,
    pub way: Vec<u8>,
    /// Vent de face par point (m/s) ; vide = pas de vent.
    pub headwind_ms: Vec<f64>,
    pub geometry: GeometrySource,
}

#[derive(Debug, Clone)]
pub struct CleanInput {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    pub ele: Vec<f64>,
    /// Distance canonique (m), strictement croissante.
    pub d: Vec<f64>,
    pub surface: Vec<u8>,
    pub rough: Vec<u8>,
    pub way: Vec<u8>,
    pub urban: Vec<bool>,
    pub signal: Vec<bool>,
    pub wind: Vec<f64>,
    pub geometry: GeometrySource,
    pub warnings: Vec<String>,
}

impl CleanInput {
    pub fn len(&self) -> usize {
        self.lat.len()
    }
    pub fn total_m(&self) -> f64 {
        *self.d.last().unwrap_or(&0.0)
    }
}

const MIN_SPACING_M: f64 = 0.5;

pub fn sanitize(input: &CourseInput) -> Result<CleanInput, String> {
    let n = input.lat.len().min(input.lon.len());
    if n < 2 {
        return Err("Tracé trop court (moins de 2 points).".to_string());
    }
    let at = |v: &Vec<f64>, i: usize| v.get(i).copied().unwrap_or(f64::NAN);
    let at_u8 = |v: &Vec<u8>, i: usize| v.get(i).copied().unwrap_or(0);

    let mut out = CleanInput {
        lat: Vec::with_capacity(n),
        lon: Vec::with_capacity(n),
        ele: Vec::with_capacity(n),
        d: Vec::with_capacity(n),
        surface: Vec::with_capacity(n),
        rough: Vec::with_capacity(n),
        way: Vec::with_capacity(n),
        urban: Vec::with_capacity(n),
        signal: Vec::with_capacity(n),
        wind: Vec::with_capacity(n),
        geometry: input.geometry,
        warnings: Vec::new(),
    };
    let mut provided: Vec<f64> = Vec::with_capacity(n);
    let mut haversine_total = 0.0;
    let use_dist = input.dist.len() == input.lat.len();

    for i in 0..n {
        let (la, lo) = (input.lat[i], input.lon[i]);
        if !la.is_finite() || !lo.is_finite() || la.abs() > 90.0 || lo.abs() > 180.0 || (la == 0.0 && lo == 0.0) {
            continue;
        }
        let s = at_u8(&input.surface, i);
        let w = at_u8(&input.way, i);
        if let (Some(&pla), Some(&plo)) = (out.lat.last(), out.lon.last()) {
            let step = haversine_distance(pla, plo, la, lo);
            if step < MIN_SPACING_M {
                if w & 0x80 != 0 {
                    if let Some(last) = out.signal.last_mut() { *last = true; }
                }
                continue;
            }
            haversine_total += step;
        }
        out.lat.push(la);
        out.lon.push(lo);
        let e = at(&input.ele, i);
        out.ele.push(if e.is_finite() && e > -500.0 && e < 9000.0 { e } else { f64::NAN });
        out.d.push(haversine_total);
        out.surface.push(s & 0x0f);
        out.rough.push((s >> 4) & 0x07);
        out.way.push(w & 0x0f);
        out.urban.push(w & 0x40 != 0);
        out.signal.push(w & 0x80 != 0);
        let wind = at(&input.headwind_ms, i);
        out.wind.push(if wind.is_finite() { wind.clamp(-30.0, 30.0) } else { 0.0 });
        if use_dist {
            provided.push(input.dist[i]);
        }
    }

    if out.len() < 2 || haversine_total < 10.0 {
        return Err("Tracé trop court ou dégénéré.".to_string());
    }

    // Axe de distance de l'app : gardé s'il est cohérent avec la géométrie, pour
    // que graphique, timeline et moteur parlent exactement des mêmes km.
    if use_dist && provided.len() == out.len() {
        let finite = provided.iter().all(|v| v.is_finite());
        let start = provided[0];
        let total = provided.last().copied().unwrap_or(0.0) - start;
        let coherent = finite && total > 0.0 && (total / haversine_total - 1.0).abs() < 0.03;
        if coherent {
            let mut prev = 0.0_f64;
            for (i, v) in provided.iter().enumerate() {
                let mut x = v - start;
                if i > 0 && x <= prev {
                    x = prev + 0.01;
                }
                out.d[i] = x;
                prev = x;
            }
        } else {
            out.warnings.push("distance_axis_ignored".to_string());
        }
    }

    // Altitudes manquantes : interpolation linéaire le long de la distance.
    let valid: Vec<usize> = (0..out.len()).filter(|&i| out.ele[i].is_finite()).collect();
    if valid.is_empty() {
        out.warnings.push("no_elevation".to_string());
        for e in out.ele.iter_mut() {
            *e = 0.0;
        }
    } else if valid.len() < out.len() {
        if valid.len() * 2 < out.len() {
            out.warnings.push("sparse_elevation".to_string());
        }
        let first = valid[0];
        let last = *valid.last().unwrap();
        for i in 0..first {
            out.ele[i] = out.ele[first];
        }
        for i in last + 1..out.len() {
            out.ele[i] = out.ele[last];
        }
        for w in valid.windows(2) {
            let (a, b) = (w[0], w[1]);
            let (da, db) = (out.d[a], out.d[b]);
            for i in a + 1..b {
                let t = if db > da { (out.d[i] - da) / (db - da) } else { 0.0 };
                out.ele[i] = out.ele[a] + t * (out.ele[b] - out.ele[a]);
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn dedupes_and_fills_elevation() {
        let input = CourseInput {
            lat: vec![45.0, 45.0, 45.001, 45.002, f64::NAN, 45.003],
            lon: vec![6.0, 6.0, 6.0, 6.0, 6.0, 6.0],
            ele: vec![100.0, 100.0, f64::NAN, 120.0, 0.0, 130.0],
            surface: vec![1 | (2 << 4), 1, 3, 3, 0, 0],
            way: vec![0x80 | 4, 0x80, 4, 4, 0, 4],
            ..Default::default()
        };
        let c = sanitize(&input).unwrap();
        assert_eq!(c.len(), 4);
        assert!(c.signal[0]);
        assert_eq!(c.surface[0], 1);
        assert_eq!(c.rough[0], 2);
        assert!((c.ele[1] - 110.0).abs() < 1e-6);
        assert!(c.d.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn rejects_degenerate() {
        let input = CourseInput { lat: vec![45.0], lon: vec![6.0], ..Default::default() };
        assert!(sanitize(&input).is_err());
    }
}
