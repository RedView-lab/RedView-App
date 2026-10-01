//! Résultat sérialisé vers JS — compatible avec le `PredictionResult` lu par
//! l'app (graphique, timeline, pauses, survol), décimé et arrondi pour rester
//! léger dans les projets persistés.
//!
//! Contrat : temps de DÉPLACEMENT uniquement, le moteur ne connaît pas les
//! pauses. `total_time_s` = `riding_time_s`, `stop_time_s` = 0 et
//! `elapsed_time_s` est l'horloge de déplacement au début de chaque point (le
//! dernier point vaut `total_time_s`) : les pauses sont ajoutées par l'app
//! (pauseAwareSchedule).

use serde::Serialize;

use crate::cycling::course::Course;
use crate::cycling::integrate::{Limit, Simulation};
use crate::cycling::params::ModelParams;
use crate::cycling::rider::RiderModel;
use crate::cycling::speeds::{speed_table, SpeedTable};
use crate::prediction::segments::build_segments;
use crate::types::{PredictionPoint, SegmentSummary};

#[derive(Debug, Clone, Serialize)]
pub struct OutPoint {
    pub distance_m: f64,
    pub elevation_m: f64,
    pub gradient_pct: f64,
    pub predicted_speed_kmh: f64,
    pub predicted_power_w: f64,
    pub elapsed_time_s: f64,
    pub segment_time_s: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LimitTimes {
    pub power: f64,
    pub comfort: f64,
    pub corner: f64,
    pub brake: f64,
    pub walk: f64,
    pub way: f64,
    pub signal: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TimeBreakdown {
    /// Temps passé en montée (pente de contexte > 2 %), sur le plat, en descente (< −2 %).
    pub climb_s: f64,
    pub flat_s: f64,
    pub descent_s: f64,
    /// Temps à pied (inclus dans les trois précédents).
    pub walk_s: f64,
    pub walk_m: f64,
    /// Temps par facteur limitant la vitesse.
    pub by_limit: LimitTimes,
    /// Coût des virages, du contexte de route et de la physiologie (s), par
    /// comparaison avec une simulation sans ce facteur (diagnostic).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_loss_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub way_loss_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physio_loss_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyRiderProfile {
    pub ftp_w: f64,
    pub mass_kg: f64,
    pub rider_weight_kg: f64,
    pub bike_weight_kg: f64,
    pub wkg: f64,
    pub cda: f64,
    pub crr: f64,
    pub has_power: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CyclingResult {
    pub engine_version: u32,
    pub total_time_s: f64,
    pub riding_time_s: f64,
    pub stop_time_s: f64,
    pub total_distance_m: f64,
    pub avg_speed_kmh: f64,
    pub elevation_gain_m: f64,
    pub elevation_loss_m: f64,
    pub segments: Vec<SegmentSummary>,
    pub points: Vec<OutPoint>,
    pub rider_profile: LegacyRiderProfile,
    pub model: RiderModel,
    /// Vitesses du modèle en régime établi (pente × revêtement).
    pub model_speeds: SpeedTable,
    pub time_breakdown: TimeBreakdown,
    pub warnings: Vec<String>,
    pub total_time_low_s: f64,
    pub total_time_high_s: f64,
}

fn round_to(x: f64, step: f64) -> f64 {
    if x.is_finite() { (x / step).round() * step } else { 0.0 }
}

pub struct OutputOptions {
    pub uncertainty: f64,
    pub diagnostics: Option<(f64, f64, f64)>,
}

pub fn build_result(
    engine_version: u32,
    course: &Course,
    sim: &Simulation,
    rider: &RiderModel,
    p: &ModelParams,
    opts: &OutputOptions,
) -> CyclingResult {
    let total = course.total_m;
    let spacing = p.output_min_spacing_m.max(total / p.output_max_points.max(100) as f64);

    let mut points: Vec<OutPoint> = Vec::new();
    let mut clock = 0.0;
    let mut seg_start = 0usize;
    let mut acc_len = 0.0;
    let n = course.cells.len();
    let flush = |a: usize, b: usize, clock: f64, points: &mut Vec<OutPoint>| {
        let len: f64 = course.cells[a..b].iter().map(|c| c.ds).sum();
        let dt: f64 = sim.cells[a..b].iter().map(|c| c.dt).sum();
        let work: f64 = sim.cells[a..b].iter().map(|c| c.power_w * c.dt).sum();
        let e0 = course.cells[a].ele0;
        let e1 = course.cells[b - 1].ele1;
        points.push(OutPoint {
            distance_m: round_to(course.cells[a].s, 0.1),
            elevation_m: round_to(e0, 0.1),
            gradient_pct: round_to(if len > 0.0 { (e1 - e0) / len * 100.0 } else { 0.0 }, 0.01),
            predicted_speed_kmh: round_to(if dt > 0.0 { len / dt * 3.6 } else { 0.0 }, 0.01),
            predicted_power_w: round_to(if dt > 0.0 { work / dt } else { 0.0 }, 1.0),
            elapsed_time_s: round_to(clock, 0.1),
            segment_time_s: round_to(dt, 0.1),
        });
        dt
    };
    for k in 0..n {
        acc_len += course.cells[k].ds;
        if acc_len >= spacing - 1e-6 || k == n - 1 {
            clock += flush(seg_start, k + 1, clock, &mut points);
            seg_start = k + 1;
            acc_len = 0.0;
        }
    }
    let last_speed = points.last().map(|p| p.predicted_speed_kmh).unwrap_or(0.0);
    let total_time = sim.moving_s;
    points.push(OutPoint {
        distance_m: round_to(total, 0.1),
        elevation_m: round_to(course.cells.last().map(|c| c.ele1).unwrap_or(0.0), 0.1),
        gradient_pct: 0.0,
        predicted_speed_kmh: last_speed,
        predicted_power_w: 0.0,
        elapsed_time_s: round_to(total_time, 0.1),
        segment_time_s: 0.0,
    });

    let legacy: Vec<PredictionPoint> = points
        .iter()
        .map(|p| PredictionPoint {
            distance_m: p.distance_m,
            elevation_m: p.elevation_m,
            gradient_pct: p.gradient_pct,
            predicted_speed_kmh: p.predicted_speed_kmh,
            predicted_power_w: p.predicted_power_w,
            elapsed_time_s: p.elapsed_time_s,
            segment_time_s: p.segment_time_s,
            fatigue_factor: 1.0,
            circadian_factor: 1.0,
            distance_eff_factor: 1.0,
            knn_confidence: 0.0,
            predicted_speed_low_kmh: 0.0,
            predicted_speed_high_kmh: 0.0,
        })
        .collect();
    let segments = build_segments(&legacy, &[]);

    let mut tb = TimeBreakdown::default();
    for (cell, s) in course.cells.iter().zip(&sim.cells) {
        if cell.g_ctx > 2.0 {
            tb.climb_s += s.dt;
        } else if cell.g_ctx < -2.0 {
            tb.descent_s += s.dt;
        } else {
            tb.flat_s += s.dt;
        }
        if s.walking {
            tb.walk_s += s.dt;
            tb.walk_m += cell.ds;
        }
        let slot = match s.limit {
            Limit::Power => &mut tb.by_limit.power,
            Limit::Comfort => &mut tb.by_limit.comfort,
            Limit::Corner => &mut tb.by_limit.corner,
            Limit::Brake => &mut tb.by_limit.brake,
            Limit::Walk => &mut tb.by_limit.walk,
            Limit::Way => &mut tb.by_limit.way,
            Limit::Signal => &mut tb.by_limit.signal,
        };
        *slot += s.dt;
    }
    if let Some((corner, way, physio)) = opts.diagnostics {
        tb.corner_loss_s = Some(round_to(corner, 0.1));
        tb.way_loss_s = Some(round_to(way, 0.1));
        tb.physio_loss_s = Some(round_to(physio, 0.1));
    }
    for v in [&mut tb.climb_s, &mut tb.flat_s, &mut tb.descent_s, &mut tb.walk_s, &mut tb.walk_m] {
        *v = round_to(*v, 0.1);
    }

    let mut warnings = course.warnings.clone();
    if tb.walk_m > 50.0 {
        warnings.push("walking_sections".to_string());
    }

    CyclingResult {
        engine_version,
        total_time_s: total_time,
        riding_time_s: total_time,
        stop_time_s: 0.0,
        total_distance_m: total,
        avg_speed_kmh: if total_time > 0.0 { total / total_time * 3.6 } else { 0.0 },
        elevation_gain_m: course.gain_m,
        elevation_loss_m: course.loss_m,
        segments,
        points,
        rider_profile: LegacyRiderProfile {
            ftp_w: rider.ftp_w,
            mass_kg: rider.mass_kg,
            rider_weight_kg: rider.rider_weight_kg,
            bike_weight_kg: (rider.mass_kg - rider.rider_weight_kg).max(0.0),
            wkg: rider.wkg(),
            cda: rider.cda,
            crr: rider.crr,
            has_power: rider.has_power,
        },
        model: rider.clone(),
        model_speeds: speed_table(rider, p),
        time_breakdown: tb,
        warnings,
        total_time_low_s: total_time * (1.0 - opts.uncertainty),
        total_time_high_s: total_time * (1.0 + opts.uncertainty),
    }
}
