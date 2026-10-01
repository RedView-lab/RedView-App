//! Vérité terrain d'une sortie .fit : trace en mouvement et temps de
//! déplacement réel par cellule (arrêts retirés).
//!
//! Même définition que le banc TS (script-test-bench/pace-accuracy) : un
//! intervalle compte comme roulé si dt ≤ 30 s et vitesse ≥ 0,6 m/s. Les points
//! à l'arrêt sont retirés (la dérive GPS au café ferait de faux virages).

use crate::cycling::course::{build_course, Course};
use crate::cycling::input::{sanitize, CourseInput, GeometrySource};
use crate::cycling::params::ModelParams;
use crate::math::haversine_distance;
use crate::types::ActivityData;

const MAX_GAP_S: f64 = 30.0;
const MIN_MOVING_MS: f64 = 0.6;

#[derive(Debug, Clone)]
pub struct RideTruth {
    pub course: Course,
    /// Temps de déplacement réel par cellule (s).
    pub cell_dt: Vec<f64>,
    pub moving_s: f64,
    pub distance_m: f64,
}

/// Interpolation du temps cumulé à la distance `s`.
fn time_at(d: &[f64], t: &[f64], s: f64) -> f64 {
    let n = d.len();
    if s <= d[0] {
        return t[0];
    }
    if s >= d[n - 1] {
        return t[n - 1];
    }
    let (mut lo, mut hi) = (0usize, n - 1);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if d[mid] <= s { lo = mid } else { hi = mid }
    }
    let span = d[hi] - d[lo];
    if span > 0.0 { t[lo] + (t[hi] - t[lo]) * (s - d[lo]) / span } else { t[lo] }
}

pub fn ride_truth(a: &ActivityData, p: &ModelParams) -> Option<RideTruth> {
    let pts: Vec<_> = a.points.iter().filter(|q| q.lat.abs() > 1e-3 && q.lon.abs() > 1e-3).collect();
    if pts.len() < 10 {
        return None;
    }
    let mut lat = vec![pts[0].lat];
    let mut lon = vec![pts[0].lon];
    let mut ele = vec![pts[0].altitude_m];
    let mut d = vec![0.0_f64];
    let mut t = vec![0.0_f64];
    let mut last = pts[0];

    for w in pts.windows(2) {
        let (prev, cur) = (w[0], w[1]);
        let dt = cur.timestamp_s - prev.timestamp_s;
        if dt <= 0.0 {
            continue;
        }
        let dd_dev = cur.distance_m - prev.distance_m;
        let dd = if dd_dev > 0.0 { dd_dev } else { haversine_distance(prev.lat, prev.lon, cur.lat, cur.lon) };
        let moving = dt <= MAX_GAP_S && dd / dt >= MIN_MOVING_MS;
        if moving {
            let step = haversine_distance(last.lat, last.lon, cur.lat, cur.lon);
            d.push(d.last().unwrap() + step);
            t.push(t.last().unwrap() + dt);
            lat.push(cur.lat);
            lon.push(cur.lon);
            ele.push(cur.altitude_m);
            last = cur;
        } else {
            if dt > MAX_GAP_S {
                let jump = haversine_distance(last.lat, last.lon, cur.lat, cur.lon);
                if jump > 50.0 {
                    d.push(d.last().unwrap() + jump);
                    t.push(*t.last().unwrap());
                    lat.push(cur.lat);
                    lon.push(cur.lon);
                    ele.push(cur.altitude_m);
                    last = cur;
                }
            }
        }
    }
    let input = CourseInput {
        lat,
        lon,
        ele,
        dist: d.clone(),
        geometry: GeometrySource::Gps,
        ..Default::default()
    };
    build_truth(input, &t, p)
}

/// Vérité à partir d'une trace déjà en mouvement : `input.dist` = distance
/// cumulée, `t` = temps de déplacement cumulé au même point.
pub fn build_truth(input: CourseInput, t: &[f64], p: &ModelParams) -> Option<RideTruth> {
    let d = input.dist.clone();
    if d.len() != t.len() || d.len() < 10 {
        return None;
    }
    let moving_s = *t.last().unwrap();
    let distance_m = *d.last().unwrap() - d[0];
    if moving_s < 1200.0 || distance_m < 5000.0 {
        return None;
    }
    let clean = sanitize(&input).ok()?;
    let course = build_course(&clean, p);
    // Axe canonique = d (fourni et cohérent) : temps réel aux bords des cellules.
    let d0 = d[0];
    let cell_dt = course
        .cells
        .iter()
        .map(|c| (time_at(&d, t, d0 + c.s + c.ds) - time_at(&d, t, d0 + c.s)).max(0.0))
        .collect();
    Some(RideTruth { course, cell_dt, moving_s, distance_m })
}
