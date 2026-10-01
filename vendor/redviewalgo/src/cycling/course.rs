//! Discrétisation du tracé en cellules uniformes (≈ 10 m) portant altitude
//! lissée, pentes à trois échelles, rayon de virage et attributs de route.

use crate::cycling::geometry::detect_corners;
use crate::cycling::input::CleanInput;
use crate::cycling::params::ModelParams;

#[derive(Debug, Clone)]
pub struct Cell {
    /// Distance au début de la cellule (m).
    pub s: f64,
    pub ds: f64,
    /// Altitude lissée au début / à la fin (m).
    pub ele0: f64,
    pub ele1: f64,
    /// Pente locale (%) — forces.
    pub g_local: f64,
    /// Pente moyenne ±`g_mid_half_m` (%) — confort de descente, marche.
    pub g_mid: f64,
    /// Pente de contexte ±`g_ctx_half_m` (%) — politique de puissance.
    pub g_ctx: f64,
    /// Pente soutenue ±`g_walk_half_m` (%) — décision de marcher : une rampe
    /// courte (ou un pic d'altitude du MNT) se monte en selle.
    pub g_walk: f64,
    /// Rayon de virage (m), infini en ligne droite.
    pub radius_m: f64,
    pub surface: u8,
    pub rough: u8,
    pub way: u8,
    pub urban: bool,
    /// Feu / stop, ou ralentissement urbain virtuel, dans la cellule.
    pub signal: bool,
    /// Vent de face (m/s).
    pub wind: f64,
}

#[derive(Debug, Clone)]
pub struct Course {
    pub cells: Vec<Cell>,
    pub total_m: f64,
    pub gain_m: f64,
    pub loss_m: f64,
    pub warnings: Vec<String>,
}

fn median_of(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 { values[n / 2] } else { 0.5 * (values[n / 2 - 1] + values[n / 2]) }
}

fn gaussian_smooth(values: &[f64], sigma_nodes: f64) -> Vec<f64> {
    if sigma_nodes < 0.3 {
        return values.to_vec();
    }
    let radius = (3.0 * sigma_nodes).ceil() as isize;
    let kernel: Vec<f64> = (-radius..=radius)
        .map(|i| (-(i as f64).powi(2) / (2.0 * sigma_nodes * sigma_nodes)).exp())
        .collect();
    let n = values.len() as isize;
    (0..n)
        .map(|i| {
            let mut sum = 0.0;
            let mut wsum = 0.0;
            for (k, w) in kernel.iter().enumerate() {
                let j = i + k as isize - radius;
                if j >= 0 && j < n {
                    sum += w * values[j as usize];
                    wsum += w;
                }
            }
            sum / wsum
        })
        .collect()
}

pub fn build_course(c: &CleanInput, p: &ModelParams) -> Course {
    let total = c.total_m();
    let ds = if total > p.long_route_m { p.cell_long_m } else { p.cell_m }.max(1.0);
    let n_cells = ((total / ds).ceil() as usize).max(1);
    let nodes: Vec<f64> = (0..=n_cells).map(|k| (k as f64 * ds).min(total)).collect();

    // ── Altitude aux nœuds ──
    let mut raw = Vec::with_capacity(nodes.len());
    let mut j = 0usize;
    for &s in &nodes {
        while j + 1 < c.len() - 1 && c.d[j + 1] < s {
            j += 1;
        }
        let (d0, d1) = (c.d[j], c.d[j + 1]);
        let t = if d1 > d0 { ((s - d0) / (d1 - d0)).clamp(0.0, 1.0) } else { 0.0 };
        raw.push(c.ele[j] + t * (c.ele[j + 1] - c.ele[j]));
    }
    // Filtre médian anti-pics (glitch MNT / baro isolé).
    let half = ((p.ele_median_half_m / ds).round() as usize).max(1);
    let despiked: Vec<f64> = (0..raw.len())
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half).min(raw.len() - 1);
            let mut w = raw[a..=b].to_vec();
            median_of(&mut w)
        })
        .collect();
    // Lissage gaussien, élargi quand les points source sont espacés (une
    // interpolation linéaire entre points lointains crée des marches de pente).
    let mut spacings: Vec<f64> = c.d.windows(2).map(|w| w[1] - w[0]).collect();
    let median_spacing = if spacings.is_empty() { ds } else { median_of(&mut spacings) };
    let sigma = p.ele_sigma_m.max(0.5 * median_spacing).min(p.ele_sigma_max_m);
    let ele = gaussian_smooth(&despiked, sigma / ds);

    let slope_between = |a: usize, b: usize| -> f64 {
        let span = nodes[b] - nodes[a];
        if span > 0.1 { (ele[b] - ele[a]) / span * 100.0 } else { 0.0 }
    };
    let mid_half = ((p.g_mid_half_m / ds).round() as usize).max(1);
    let ctx_half = ((p.g_ctx_half_m / ds).round() as usize).max(1);
    let walk_half = ((p.g_walk_half_m / ds).round() as usize).max(1);

    // ── Cellules ──
    let mut cells = Vec::with_capacity(n_cells);
    let mut j = 0usize;
    for k in 0..n_cells {
        let (s0, s1) = (nodes[k], nodes[k + 1]);
        let len = s1 - s0;
        let center = 0.5 * (s0 + s1);
        while j + 1 < c.len() - 1 && c.d[j + 1] <= center {
            j += 1;
        }
        let (d0, d1) = (c.d[j], c.d[j + 1]);
        let t = if d1 > d0 { ((center - d0) / (d1 - d0)).clamp(0.0, 1.0) } else { 0.0 };
        let wind = c.wind[j] + t * (c.wind[j + 1] - c.wind[j]);
        cells.push(Cell {
            s: s0,
            ds: len,
            ele0: ele[k],
            ele1: ele[k + 1],
            g_local: slope_between(k, k + 1),
            g_mid: slope_between(k.saturating_sub(mid_half), (k + 1 + mid_half).min(n_cells)),
            g_ctx: slope_between(k.saturating_sub(ctx_half), (k + 1 + ctx_half).min(n_cells)),
            g_walk: slope_between(k.saturating_sub(walk_half), (k + 1 + walk_half).min(n_cells)),
            radius_m: f64::INFINITY,
            surface: c.surface[j],
            rough: c.rough[j],
            way: c.way[j],
            urban: c.urban[j],
            signal: false,
            wind,
        });
    }
    let cell_at = |d: f64| -> usize { ((d / ds).floor().max(0.0) as usize).min(n_cells - 1) };
    for i in 0..c.len() {
        if c.signal[i] {
            cells[cell_at(c.d[i])].signal = true;
        }
    }
    // Agglomération : un ralentissement (carrefour, passage piéton, giratoire)
    // tous les `urban_slowdown_every_m` mètres, en plus des feux connus.
    if p.urban_slowdown_every_m > 0.0 {
        let mut since = 0.0;
        for cell in cells.iter_mut() {
            if cell.urban {
                since += cell.ds;
                if since >= p.urban_slowdown_every_m {
                    cell.signal = true;
                    since = 0.0;
                }
            } else {
                since = 0.0;
            }
        }
    }
    for corner in detect_corners(c, p) {
        let a = cell_at(corner.d - corner.half_arc_m);
        let b = cell_at(corner.d + corner.half_arc_m);
        for cell in &mut cells[a..=b] {
            cell.radius_m = cell.radius_m.min(corner.radius_m);
        }
    }

    let mut gain = 0.0;
    let mut loss = 0.0;
    for w in ele.windows(2) {
        let d = w[1] - w[0];
        if d > 0.0 { gain += d } else { loss -= d }
    }
    Course { cells, total_m: total, gain_m: gain, loss_m: loss, warnings: c.warnings.clone() }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;
    use crate::cycling::input::{sanitize, CourseInput};

    #[test]
    fn uniform_cells_and_gradients() {
        // 2 km : 1 km plat puis 1 km à 5 %, un point tous les 25 m.
        let n = 81;
        let ky = 111_195.0;
        let input = CourseInput {
            lat: (0..n).map(|i| 45.0 + i as f64 * 25.0 / ky).collect(),
            lon: vec![6.0; n],
            ele: (0..n).map(|i| { let d = i as f64 * 25.0; if d <= 1000.0 { 100.0 } else { 100.0 + 0.05 * (d - 1000.0) } }).collect(),
            ..Default::default()
        };
        let c = sanitize(&input).unwrap();
        let course = build_course(&c, &ModelParams::default());
        assert!((course.total_m - 2000.0).abs() < 5.0);
        assert!(course.cells.iter().all(|cell| cell.ds <= 10.0 + 1e-9));
        let mid_flat = &course.cells[40];
        let mid_climb = &course.cells[160];
        assert!(mid_flat.g_local.abs() < 0.2, "{}", mid_flat.g_local);
        assert!((mid_climb.g_local - 5.0).abs() < 0.2, "{}", mid_climb.g_local);
        assert!((course.gain_m - 50.0).abs() < 2.0, "{}", course.gain_m);
    }
}
