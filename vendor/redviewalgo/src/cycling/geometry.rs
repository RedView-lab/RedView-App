//! Rayons de virage à partir de la polyligne.
//!
//! Une polyligne ne porte pas de rayon : un virage serré dessiné avec
//! beaucoup de nœuds (épingle OSM, trace GPS) et un coude isolé entre deux
//! longues jambes (carrefour) ne se lisent pas pareil. Méthode :
//! 1. simplification Douglas-Peucker (tolérance selon la source) : le bruit GPS
//!    disparaît, les vrais virages restent ;
//! 2. par sommet, rayon de raccord `R = (min(L_in, L_out)/2) / tan(θ/2)` —
//!    juste pour les courbes douces échantillonnées en points espacés ;
//! 3. sommets voisins tournant du même côté regroupés en un virage : rayon
//!    `S / Θ` (longueur de l'arc / déviation totale), les jambes extrêmes
//!    comptées au plus `corner_leg_cap_m` — un coude isolé à 90° est un
//!    carrefour ou un virage serré, pas une courbe de 100 m de rayon ;
//! 4. mélange des deux selon la déviation totale du groupe.

use crate::cycling::input::{CleanInput, GeometrySource};
use crate::cycling::params::ModelParams;

const EARTH_RADIUS_M: f64 = 6_371_008.8;
/// Déviation (rad) sous laquelle un sommet est considéré comme rectiligne.
const MIN_TURN_RAD: f64 = 1.5 * std::f64::consts::PI / 180.0;
const CHUNK_MAX_M: f64 = 20_000.0;
const CHUNK_MAX_POINTS: usize = 5000;

#[derive(Debug, Clone, Copy)]
pub struct Corner {
    /// Position du sommet (distance canonique, m).
    pub d: f64,
    /// Demi-longueur de l'arc couvert par ce sommet (m).
    pub half_arc_m: f64,
    pub radius_m: f64,
}

pub fn dp_tolerance(source: GeometrySource, p: &ModelParams) -> f64 {
    match source {
        GeometrySource::Planned => p.dp_tol_planned_m,
        GeometrySource::Gps => p.dp_tol_gps_m,
        GeometrySource::Auto => p.dp_tol_auto_m,
    }
}

/// Polyligne sur laquelle on cherche les virages.
pub struct Polyline {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    /// Distance canonique (m).
    pub d: Vec<f64>,
}

impl Polyline {
    fn len(&self) -> usize {
        self.lat.len()
    }
}

/// Trace GPS : rééchantillonnage tous les `step_m` puis lissage gaussien de la
/// position (σ en m). Un véhicule ne fait pas de coude vif : le bruit blanc de
/// position disparaît, les épingles (arcs de 20-40 m) restent.
fn smoothed_polyline(c: &CleanInput, step_m: f64, sigma_m: f64) -> Polyline {
    let total = c.total_m();
    let n = ((total / step_m).ceil() as usize).max(1) + 1;
    let mut lat = Vec::with_capacity(n);
    let mut lon = Vec::with_capacity(n);
    let mut d = Vec::with_capacity(n);
    let mut j = 0usize;
    for k in 0..n {
        let s = (k as f64 * step_m).min(total);
        while j + 1 < c.len() - 1 && c.d[j + 1] < s {
            j += 1;
        }
        let (d0, d1) = (c.d[j], c.d[j + 1]);
        let t = if d1 > d0 { ((s - d0) / (d1 - d0)).clamp(0.0, 1.0) } else { 0.0 };
        lat.push(c.lat[j] + t * (c.lat[j + 1] - c.lat[j]));
        lon.push(c.lon[j] + t * (c.lon[j + 1] - c.lon[j]));
        d.push(s);
    }
    let sig = sigma_m / step_m;
    if sig < 0.3 {
        return Polyline { lat, lon, d };
    }
    let radius = (3.0 * sig).ceil() as isize;
    let kernel: Vec<f64> = (-radius..=radius).map(|i| (-(i as f64).powi(2) / (2.0 * sig * sig)).exp()).collect();
    let smooth = |v: &[f64]| -> Vec<f64> {
        let m = v.len() as isize;
        (0..m)
            .map(|i| {
                // Extrémités gardées fixes (départ / arrivée exacts).
                if i == 0 || i == m - 1 {
                    return v[i as usize];
                }
                let mut sum = 0.0;
                let mut ws = 0.0;
                for (k, w) in kernel.iter().enumerate() {
                    let j = i + k as isize - radius;
                    if j >= 0 && j < m {
                        sum += w * v[j as usize];
                        ws += w;
                    }
                }
                sum / ws
            })
            .collect()
    };
    Polyline { lat: smooth(&lat), lon: smooth(&lon), d }
}

/// Indices conservés par Douglas-Peucker, par tronçons projetés localement.
pub fn simplify(c: &Polyline, tol_m: f64) -> Vec<usize> {
    let n = c.len();
    let mut kept = vec![0usize];
    let mut a = 0usize;
    while a < n - 1 {
        let mut b = a + 1;
        while b < n - 1 && b - a < CHUNK_MAX_POINTS && c.d[b] - c.d[a] < CHUNK_MAX_M {
            b += 1;
        }
        let lat0 = c.lat[a].to_radians();
        let kx = EARTH_RADIUS_M * lat0.cos() * std::f64::consts::PI / 180.0;
        let ky = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
        let xs: Vec<f64> = (a..=b).map(|i| (c.lon[i] - c.lon[a]) * kx).collect();
        let ys: Vec<f64> = (a..=b).map(|i| (c.lat[i] - c.lat[a]) * ky).collect();
        let mut keep = vec![false; b - a + 1];
        keep[0] = true;
        keep[b - a] = true;
        let mut stack = vec![(0usize, b - a)];
        while let Some((i, j)) = stack.pop() {
            if j <= i + 1 {
                continue;
            }
            let (x1, y1, x2, y2) = (xs[i], ys[i], xs[j], ys[j]);
            let (dx, dy) = (x2 - x1, y2 - y1);
            let len2 = dx * dx + dy * dy;
            let mut best = 0.0;
            let mut best_k = i;
            for k in i + 1..j {
                let (px, py) = (xs[k] - x1, ys[k] - y1);
                let dist = if len2 > 1e-12 {
                    let t = ((px * dx + py * dy) / len2).clamp(0.0, 1.0);
                    ((px - t * dx).powi(2) + (py - t * dy).powi(2)).sqrt()
                } else {
                    (px * px + py * py).sqrt()
                };
                if dist > best {
                    best = dist;
                    best_k = k;
                }
            }
            if best > tol_m {
                keep[best_k] = true;
                stack.push((i, best_k));
                stack.push((best_k, j));
            }
        }
        for (k, &flag) in keep.iter().enumerate().skip(1) {
            if flag {
                kept.push(a + k);
            }
        }
        a = b;
    }
    kept
}

fn point_at(c: &Polyline, s: f64) -> (f64, f64) {
    let n = c.len();
    let s = s.clamp(c.d[0], c.d[n - 1]);
    let (mut lo, mut hi) = (0usize, n - 1);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if c.d[mid] <= s { lo = mid } else { hi = mid }
    }
    let span = c.d[hi] - c.d[lo];
    let t = if span > 0.0 { (s - c.d[lo]) / span } else { 0.0 };
    (c.lat[lo] + t * (c.lat[hi] - c.lat[lo]), c.lon[lo] + t * (c.lon[hi] - c.lon[lo]))
}

/// Changement de cap absolu (rad) entre [s−L, s] et [s, s+L].
fn heading_change(c: &Polyline, s: f64, l: f64) -> f64 {
    let a = point_at(c, s - l);
    let b = point_at(c, s);
    let e = point_at(c, s + l);
    let ky = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
    let kx = ky * b.0.to_radians().cos();
    let v1 = ((b.1 - a.1) * kx, (b.0 - a.0) * ky);
    let v2 = ((e.1 - b.1) * kx, (e.0 - b.0) * ky);
    let cross = v1.0 * v2.1 - v1.1 * v2.0;
    let dot = v1.0 * v2.0 + v1.1 * v2.1;
    cross.atan2(dot).abs()
}

fn smoothstep(x: f64, lo: f64, hi: f64) -> f64 {
    if hi <= lo {
        return if x >= hi { 1.0 } else { 0.0 };
    }
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Virages d'un tracé nettoyé.
pub fn detect_corners(input: &CleanInput, p: &ModelParams) -> Vec<Corner> {
    let tol = dp_tolerance(input.geometry, p);
    let owned;
    let c: &Polyline = if input.geometry == GeometrySource::Gps && p.gps_smooth_sigma_m > 0.0 {
        owned = smoothed_polyline(input, 2.0, p.gps_smooth_sigma_m);
        &owned
    } else {
        owned = Polyline { lat: input.lat.clone(), lon: input.lon.clone(), d: input.d.clone() };
        &owned
    };
    let kept = simplify(c, tol);
    let m = kept.len();
    if m < 3 {
        return Vec::new();
    }
    let ky = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
    // Jambes et déviations sur les sommets conservés.
    let mut leg = vec![0.0_f64; m]; // leg[k] = longueur kept[k-1] → kept[k]
    let mut theta = vec![0.0_f64; m];
    let mut vec_in = vec![(0.0_f64, 0.0_f64); m];
    for k in 1..m {
        let (i0, i1) = (kept[k - 1], kept[k]);
        let kx = ky * (0.5 * (c.lat[i0] + c.lat[i1])).to_radians().cos();
        let v = ((c.lon[i1] - c.lon[i0]) * kx, (c.lat[i1] - c.lat[i0]) * ky);
        leg[k] = (v.0 * v.0 + v.1 * v.1).sqrt();
        vec_in[k] = v;
    }
    for k in 1..m - 1 {
        let a = vec_in[k];
        let b = vec_in[k + 1];
        let cross = a.0 * b.1 - a.1 * b.0;
        let dot = a.0 * b.0 + a.1 * b.1;
        theta[k] = cross.atan2(dot);
    }
    let mut pos = vec![0.0_f64; m];
    for k in 1..m {
        pos[k] = pos[k - 1] + leg[k];
    }

    let window = p.corner_arc_window_m;
    let cap = p.corner_leg_cap_m;
    let mut corners = Vec::new();
    for k in 1..m - 1 {
        let th = theta[k].abs();
        if th < MIN_TURN_RAD {
            continue;
        }
        let sign = theta[k].signum();
        let same = |j: usize| j >= 1 && j < m - 1 && theta[j].signum() == sign && theta[j].abs() >= MIN_TURN_RAD;
        let mut l = k;
        while l > 1 && same(l - 1) && pos[k] - pos[l - 1] <= window {
            l -= 1;
        }
        let mut r = k;
        while r + 1 < m - 1 && same(r + 1) && pos[r + 1] - pos[k] <= window {
            r += 1;
        }
        let total_turn: f64 = (l..=r).map(|j| theta[j].abs()).sum();
        let s = (pos[r] - pos[l]) + (leg[l] / 2.0).min(cap) + (leg[r + 1] / 2.0).min(cap);
        let r_run = s / total_turn.max(1e-6);
        let r_fillet = (leg[k].min(leg[k + 1]) / 2.0) / (th / 2.0).tan().max(1e-6);
        let w = smoothstep(total_turn.to_degrees(), p.corner_blend_lo_deg, p.corner_blend_hi_deg);
        let mut radius = (1.0 - w) * r_fillet + w * r_fillet.min(r_run);
        // Confirmation à plus grande échelle : sur ±L, un vrai virage de rayon R
        // change le cap de min(Θ, L/R). Un zigzag de bruit (quelques mètres)
        // dévie localement mais pas sur ±L : son rayon est agrandi d'autant.
        let l = p.corner_confirm_m;
        let phi_expected = total_turn.min(l / radius.max(1.0));
        let phi = heading_change(c, c.d[kept[k]], l);
        if phi < phi_expected {
            radius *= phi_expected / phi.max(0.02);
        }
        let radius = radius.clamp(p.corner_min_radius_m, p.corner_max_radius_m);
        if radius >= p.corner_max_radius_m {
            continue;
        }
        corners.push(Corner {
            d: c.d[kept[k]],
            half_arc_m: (radius * th).max(5.0) / 2.0,
            radius_m: radius,
        });
    }
    corners
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;
    use crate::cycling::input::{sanitize, CourseInput};

    /// Construit un tracé à partir de points plans (m) autour de 45°N 6°E.
    fn course_from_xy(pts: &[(f64, f64)], geometry: GeometrySource) -> CleanInput {
        let ky = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
        let kx = ky * 45f64.to_radians().cos();
        let input = CourseInput {
            lat: pts.iter().map(|p| 45.0 + p.1 / ky).collect(),
            lon: pts.iter().map(|p| 6.0 + p.0 / kx).collect(),
            ele: vec![0.0; pts.len()],
            geometry,
            ..Default::default()
        };
        sanitize(&input).unwrap()
    }

    /// Droite, arc de rayon `r` sur `deg` degrés échantillonné tous les `step` m, droite.
    fn arc_course(r: f64, deg: f64, step: f64, lead: f64) -> Vec<(f64, f64)> {
        let mut pts = Vec::new();
        let mut x = -lead;
        while x < 0.0 {
            pts.push((x, 0.0));
            x += step.max(5.0);
        }
        let n = ((r * deg.to_radians()) / step).ceil().max(1.0) as usize;
        for i in 0..=n {
            let a = deg.to_radians() * i as f64 / n as f64;
            pts.push((r * a.sin(), r - r * a.cos()));
        }
        let a = deg.to_radians();
        let (ex, ey) = (r * a.sin(), r - r * a.cos());
        let mut t = step.max(5.0);
        while t <= lead {
            pts.push((ex + t * a.cos(), ey + t * a.sin()));
            t += step.max(5.0);
        }
        pts
    }

    fn min_radius(corners: &[Corner]) -> f64 {
        corners.iter().map(|c| c.radius_m).fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn dense_hairpin_gives_true_radius() {
        let c = course_from_xy(&arc_course(10.0, 180.0, 2.0, 200.0), GeometrySource::Planned);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 6.0 && r < 15.0, "hairpin radius {r}");
    }

    #[test]
    fn sweeping_curve_keeps_large_radius() {
        let c = course_from_xy(&arc_course(100.0, 90.0, 10.0, 300.0), GeometrySource::Planned);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 70.0 && r < 140.0, "sweeper radius {r}");
    }

    #[test]
    fn sparse_gentle_kink_is_not_a_hairpin() {
        let pts = [(0.0, 0.0), (200.0, 0.0), (200.0 + 200.0 * 20f64.to_radians().cos(), 200.0 * 20f64.to_radians().sin())];
        let c = course_from_xy(&pts, GeometrySource::Planned);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 200.0, "kink radius {r}");
    }

    #[test]
    fn isolated_right_angle_is_a_tight_corner() {
        let pts = [(0.0, 0.0), (150.0, 0.0), (150.0, 150.0)];
        let c = course_from_xy(&pts, GeometrySource::Planned);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 8.0 && r < 20.0, "junction radius {r}");
    }

    #[test]
    fn noisy_gps_hairpin_is_still_a_hairpin() {
        let mut s = 777u64;
        let pts: Vec<(f64, f64)> = arc_course(12.0, 180.0, 3.0, 150.0)
            .into_iter()
            .map(|(x, y)| {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let nx = ((s >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 3.0;
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let ny = ((s >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 3.0;
                (x + nx, y + ny)
            })
            .collect();
        let c = course_from_xy(&pts, GeometrySource::Gps);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 7.0 && r < 22.0, "gps hairpin radius {r}");
    }

    fn noisy_straight(white_amp: f64, drift_amp: f64, seed: u64) -> Vec<(f64, f64)> {
        let mut s = seed;
        let mut rnd = move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as f64 / (1u64 << 31) as f64 - 0.5
        };
        let mut drift = 0.0;
        (0..400)
            .map(|i| {
                // Dérive lente (AR(1)) + bruit blanc : profil d'un GPS de montre.
                drift = 0.95 * drift + drift_amp * rnd();
                (i as f64 * 5.0, drift + white_amp * rnd())
            })
            .collect()
    }

    #[test]
    fn realistic_gps_noise_makes_no_limiting_corner() {
        for seed in [1u64, 2, 3, 4, 5] {
            let c = course_from_xy(&noisy_straight(1.0, 1.0, seed), GeometrySource::Gps);
            let r = min_radius(&detect_corners(&c, &ModelParams::default()));
            // ≥ 60 m : ne limite qu'au-delà de ~40 km/h (a_lat 2,2).
            assert!(r > 60.0, "seed {seed}: noise produced radius {r}");
        }
    }

    #[test]
    fn extreme_white_noise_makes_no_hairpin() {
        // ±3 m indépendant tous les 5 m : bien pire qu'un GPS réel.
        let c = course_from_xy(&noisy_straight(6.0, 0.0, 12345), GeometrySource::Gps);
        let r = min_radius(&detect_corners(&c, &ModelParams::default()));
        assert!(r > 20.0, "white noise produced radius {r}");
    }
}
