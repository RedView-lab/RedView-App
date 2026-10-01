//! Calibration d'un cycliste sur ses .fit et protocole de test intégré.
//!
//! 1. Mesure directe de l'adhérence en virage (P80 de v²/R aux apex de
//!    descente), mélangée au prior selon le nombre d'apex observés.
//! 2. Ajustement par rejeu de trois multiplicateurs (puissance sur le plat,
//!    puissance en montée, vitesse de confort en descente) : on
//!    simule chaque sortie sur sa propre trace et on minimise l'écart de temps
//!    par tronçon de 1 km (Huber sur le log) + l'écart par sortie, avec un
//!    rappel vers le préréglage d'autant plus fort que les données sont rares.
//!    Sans capteur de puissance, P, CdA et masse ne sont pas séparables : ces
//!    trois multiplicateurs portent ce qui est identifiable (vitesse sur le
//!    plat, VAM, vitesse en descente).
//! 3. Validation croisée « une sortie de côté » : chaque sortie est prédite
//!    par un modèle calibré sans elle → précision attendue réelle.

use serde::Serialize;

use crate::cycling::calibrate::truth::RideTruth;
use crate::cycling::integrate::{duration_pacing, simulate, SimOptions};
use crate::cycling::params::ModelParams;
use crate::cycling::rider::RiderModel;

const N_PARAMS: usize = 3;
const BOUND: f64 = 0.8;
const BLOCK_M: f64 = 1000.0;
const HUBER_DELTA: f64 = 0.15;
const TOTAL_WEIGHT: f64 = 1.0;
/// Écart-type du prior sur les log-multiplicateurs (≈ ±35 %).
const PRIOR_SIGMA: f64 = 0.35;
/// Kilomètres de terrain pour lesquels données et prior pèsent autant.
const PRIOR_KM: [f64; N_PARAMS] = [15.0, 8.0, 8.0];
/// Poids du rappel au prior, à l'échelle de la perte moyenne par tronçon
/// (≈ 1e-4 pour 1,5 % d'écart) : négligeable dès quelques dizaines de km du
/// terrain concerné, dominant quand ce terrain manque.
const PRIOR_SCALE: f64 = 0.003;
/// Plis de validation croisée au maximum.
const MAX_FOLDS: usize = 5;

#[derive(Debug, Clone, Serialize)]
pub struct RideReport {
    pub index: usize,
    pub distance_km: f64,
    pub moving_h: f64,
    pub predicted_h: f64,
    pub error_pct: f64,
    /// Erreur de la prédiction faite par un modèle calibré SANS cette sortie.
    pub loo_error_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GradeRow {
    pub label: String,
    pub km: f64,
    pub real_kmh: f64,
    pub model_kmh: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalibrationReport {
    pub n_rides: usize,
    pub n_ignored: usize,
    pub total_km: f64,
    pub total_moving_h: f64,
    pub longest_h: f64,
    pub climb_km: f64,
    pub flat_km: f64,
    pub descent_km: f64,
    pub rides: Vec<RideReport>,
    pub loo_median_abs_pct: Option<f64>,
    pub loo_max_abs_pct: Option<f64>,
    pub in_sample_median_abs_pct: f64,
    /// Précision attendue (± %) d'une prédiction de temps de déplacement.
    pub expected_accuracy_pct: f64,
    pub grade_table: Vec<GradeRow>,
    /// Multiplicateurs ajustés (puissance plat, puissance montée, descente).
    pub multipliers: [f64; N_PARAMS],
    pub a_lat_measured: Option<f64>,
    pub a_lat_samples: usize,
    pub warnings: Vec<String>,
}

struct Terrain {
    flat_km: f64,
    climb_km: f64,
    descent_km: f64,
}

fn terrain(rides: &[&RideTruth]) -> Terrain {
    let mut t = Terrain { flat_km: 0.0, climb_km: 0.0, descent_km: 0.0 };
    for r in rides {
        for c in &r.course.cells {
            if c.g_ctx > 2.0 {
                t.climb_km += c.ds / 1000.0;
            } else if c.g_ctx < -2.0 {
                t.descent_km += c.ds / 1000.0;
            } else {
                t.flat_km += c.ds / 1000.0;
            }
        }
    }
    t
}

/// Multiplicateurs (log) : puissance sur le plat, puissance en montée, vitesse
/// de confort en descente. Plat et montée sont ajustés séparément (et non
/// plat × surcroît) : chacun se lit sur son propre terrain, les deux ne se
/// compensent pas pendant l'ajustement.
pub fn apply_multipliers(base: &RiderModel, m: &[f64; N_PARAMS]) -> RiderModel {
    let mut r = base.clone();
    let p_climb = base.p_flat_w * base.climb_ratio * m[1].exp();
    r.p_flat_w = base.p_flat_w * m[0].exp();
    r.climb_ratio = (p_climb / r.p_flat_w).clamp(0.8, 3.0);
    let k = m[2].exp();
    r.desc_v1_kmh = base.desc_v1_kmh * k;
    r.desc_k_kmh_per_pct = base.desc_k_kmh_per_pct * k;
    r.desc_vmax_kmh = base.desc_vmax_kmh * k;
    r
}

fn huber(e: f64) -> f64 {
    let a = e.abs();
    if a <= HUBER_DELTA { 0.5 * e * e } else { HUBER_DELTA * (a - 0.5 * HUBER_DELTA) }
}

/// Simulation d'une sortie : temps prédit par cellule.
fn replay(ride: &RideTruth, model: &RiderModel, p: &ModelParams) -> Vec<f64> {
    // L'allure liée à la durée est celle de la sortie réelle : un modèle
    // calibré sur une sortie de 20 h décrit la même puissance « à la journée ».
    let opts = SimOptions { power_scale: Some(duration_pacing(ride.moving_s, p)), ..Default::default() };
    simulate(&ride.course, model, p, &opts).cells.iter().map(|c| c.dt).collect()
}

/// (Σ poids·Huber par bloc, Σ poids, erreur log du total).
fn ride_loss(ride: &RideTruth, pred: &[f64]) -> (f64, f64, f64) {
    let mut sum = 0.0;
    let mut wsum = 0.0;
    let (mut bl_real, mut bl_pred, mut bl_len) = (0.0, 0.0, 0.0);
    let (mut tot_real, mut tot_pred) = (0.0, 0.0);
    for (k, cell) in ride.course.cells.iter().enumerate() {
        bl_real += ride.cell_dt[k];
        bl_pred += pred[k];
        bl_len += cell.ds;
        tot_real += ride.cell_dt[k];
        tot_pred += pred[k];
        if bl_len >= BLOCK_M || k + 1 == ride.course.cells.len() {
            if bl_real > 5.0 && bl_pred > 0.0 {
                sum += bl_real * huber((bl_pred / bl_real).ln());
                wsum += bl_real;
            }
            bl_real = 0.0;
            bl_pred = 0.0;
            bl_len = 0.0;
        }
    }
    let e_tot = if tot_real > 0.0 && tot_pred > 0.0 { (tot_pred / tot_real).ln() } else { 0.0 };
    (sum, wsum, e_tot)
}

fn objective(rides: &[&RideTruth], base: &RiderModel, p: &ModelParams, m: &[f64; N_PARAMS], prior_w: &[f64; N_PARAMS]) -> f64 {
    let model = apply_multipliers(base, m);
    let mut sum = 0.0;
    let mut wsum = 0.0;
    let mut tot = 0.0;
    for ride in rides {
        let pred = replay(ride, &model, p);
        let (s, w, e) = ride_loss(ride, &pred);
        sum += s;
        wsum += w;
        tot += e * e;
    }
    let data = if wsum > 0.0 { sum / wsum } else { 0.0 } + TOTAL_WEIGHT * tot / rides.len().max(1) as f64;
    let prior: f64 = (0..N_PARAMS).map(|j| prior_w[j] * (m[j] / PRIOR_SIGMA).powi(2)).sum::<f64>() * PRIOR_SCALE;
    data + prior
}

fn golden<F: FnMut(f64) -> f64>(mut f: F, mut a: f64, mut b: f64, tol: f64) -> f64 {
    let gr = (5f64.sqrt() - 1.0) / 2.0;
    let mut c = b - gr * (b - a);
    let mut d = a + gr * (b - a);
    let mut fc = f(c);
    let mut fd = f(d);
    while (b - a).abs() > tol {
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - gr * (b - a);
            fc = f(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + gr * (b - a);
            fd = f(d);
        }
    }
    0.5 * (a + b)
}

/// Descente par coordonnées sur les trois log-multiplicateurs.
fn optimize(rides: &[&RideTruth], base: &RiderModel, p: &ModelParams, start: [f64; N_PARAMS], cycles: usize, half_range: f64) -> [f64; N_PARAMS] {
    let t = terrain(rides);
    let km = [t.flat_km, t.climb_km, t.descent_km];
    let mut prior_w = [0.0; N_PARAMS];
    for j in 0..N_PARAMS {
        prior_w[j] = PRIOR_KM[j] / (PRIOR_KM[j] + km[j]);
    }
    let mut m = start;
    for _ in 0..cycles {
        for j in 0..N_PARAMS {
            let lo = (m[j] - half_range).max(-BOUND);
            let hi = (m[j] + half_range).min(BOUND);
            m[j] = golden(
                |x| {
                    let mut mm = m;
                    mm[j] = x;
                    objective(rides, base, p, &mm, &prior_w)
                },
                lo,
                hi,
                0.01,
            );
        }
    }
    m
}

/// Adhérence latérale mesurée : P80 de v²/R aux apex de descente (R < 60 m).
fn measure_a_lat(rides: &[&RideTruth]) -> (Option<f64>, usize) {
    let mut values = Vec::new();
    for ride in rides {
        for (k, c) in ride.course.cells.iter().enumerate() {
            if c.radius_m < 60.0 && c.g_mid < -2.0 && ride.cell_dt[k] > 0.0 {
                let v = c.ds / ride.cell_dt[k];
                if v > 2.0 && v < 25.0 {
                    values.push(v * v / c.radius_m);
                }
            }
        }
    }
    let n = values.len();
    if n < 15 {
        return (None, n);
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p80 = values[((n as f64 * 0.8) as usize).min(n - 1)];
    (Some(p80.clamp(1.0, 6.0)), n)
}

fn grade_table(rides: &[&RideTruth], model: &RiderModel, p: &ModelParams) -> Vec<GradeRow> {
    let classes: [(&str, f64, f64); 9] = [
        ("<-8", f64::NEG_INFINITY, -8.0),
        ("-8..-5", -8.0, -5.0),
        ("-5..-3", -5.0, -3.0),
        ("-3..-1", -3.0, -1.0),
        ("-1..1", -1.0, 1.0),
        ("1..3", 1.0, 3.0),
        ("3..5", 3.0, 5.0),
        ("5..7", 5.0, 7.0),
        (">7", 7.0, f64::INFINITY),
    ];
    let mut acc = vec![(0.0_f64, 0.0_f64, 0.0_f64); classes.len()];
    for ride in rides {
        let pred = replay(ride, model, p);
        for (k, c) in ride.course.cells.iter().enumerate() {
            if let Some(i) = classes.iter().position(|(_, lo, hi)| c.g_mid >= *lo && c.g_mid < *hi) {
                acc[i].0 += c.ds;
                acc[i].1 += ride.cell_dt[k];
                acc[i].2 += pred[k];
            }
        }
    }
    classes
        .iter()
        .zip(acc)
        .filter(|(_, a)| a.0 >= 500.0 && a.1 > 0.0 && a.2 > 0.0)
        .map(|((label, _, _), a)| GradeRow {
            label: label.to_string(),
            km: (a.0 / 100.0).round() / 10.0,
            real_kmh: (a.0 / a.1 * 36.0).round() / 10.0,
            model_kmh: (a.0 / a.2 * 36.0).round() / 10.0,
        })
        .collect()
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn err_pct(ride: &RideTruth, model: &RiderModel, p: &ModelParams) -> (f64, f64) {
    let pred: f64 = replay(ride, model, p).iter().sum();
    (pred, (pred / ride.moving_s - 1.0) * 100.0)
}

pub fn calibrate(rides: &[RideTruth], n_ignored: usize, prior: &RiderModel, p: &ModelParams) -> (RiderModel, CalibrationReport) {
    let all: Vec<&RideTruth> = rides.iter().collect();
    let mut base = prior.clone();
    let (a_lat, a_lat_samples) = measure_a_lat(&all);
    if let Some(a) = a_lat {
        let w = a_lat_samples as f64 / (a_lat_samples as f64 + 30.0);
        base.a_lat_ms2 = (1.0 - w) * prior.a_lat_ms2 + w * a;
    }

    let m = if all.is_empty() { [0.0; N_PARAMS] } else { optimize(&all, &base, p, [0.0; N_PARAMS], 3, BOUND) };
    let mut model = apply_multipliers(&base, &m);
    model.source = "fit".to_string();

    // Validation croisée (départ à chaud) : chaque sortie prédite par un modèle
    // calibré sans elle — une sortie par pli jusqu'à 5 sorties, 5 plis au-delà
    // (la sortie i dans le pli i mod 5) pour borner le calcul.
    let n_folds = rides.len().min(MAX_FOLDS);
    let fold_models: Vec<RiderModel> = if rides.len() >= 2 {
        (0..n_folds)
            .map(|f| {
                let train: Vec<&RideTruth> = rides.iter().enumerate().filter(|(j, _)| j % n_folds != f).map(|(_, r)| r).collect();
                apply_multipliers(&base, &optimize(&train, &base, p, m, 1, 0.25))
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut reports = Vec::new();
    let mut loo_abs = Vec::new();
    let mut in_abs = Vec::new();
    for (i, ride) in rides.iter().enumerate() {
        let (pred, err) = err_pct(ride, &model, p);
        in_abs.push(err.abs());
        let loo = fold_models.get(i % n_folds.max(1)).map(|fold_model| {
            let (_, e) = err_pct(ride, fold_model, p);
            loo_abs.push(e.abs());
            (e * 10.0).round() / 10.0
        });
        reports.push(RideReport {
            index: i,
            distance_km: (ride.distance_m / 100.0).round() / 10.0,
            moving_h: ride.moving_s / 3600.0,
            predicted_h: pred / 3600.0,
            error_pct: (err * 10.0).round() / 10.0,
            loo_error_pct: loo,
        });
    }

    let t = terrain(&all);
    let total_km: f64 = rides.iter().map(|r| r.distance_m).sum::<f64>() / 1000.0;
    let total_h: f64 = rides.iter().map(|r| r.moving_s).sum::<f64>() / 3600.0;
    let longest_h = rides.iter().map(|r| r.moving_s / 3600.0).fold(0.0, f64::max);
    let loo_median = if loo_abs.is_empty() { None } else { Some(median(&mut loo_abs.clone())) };
    let loo_max = loo_abs.iter().copied().fold(None, |acc: Option<f64>, v| Some(acc.map_or(v, |a| a.max(v))));

    let mut warnings = Vec::new();
    if rides.is_empty() {
        warnings.push("no_usable_ride".to_string());
    } else if rides.len() < 3 {
        warnings.push("few_rides".to_string());
    }
    if t.climb_km < 5.0 {
        warnings.push("few_climbs".to_string());
    }
    if t.descent_km < 5.0 {
        warnings.push("few_descents".to_string());
    }
    if longest_h < 3.0 {
        warnings.push("short_rides".to_string());
    }
    if loo_median.is_some_and(|v| v > 8.0) {
        warnings.push("low_consistency".to_string());
    }

    // Précision attendue : médiane de validation croisée (majorée), sinon
    // incertitude d'un préréglage.
    let expected = match loo_median {
        Some(v) => (v * 1.25).clamp(3.0, 20.0),
        None => 10.0,
    };
    let grade = grade_table(&all, &model, p);
    let report = CalibrationReport {
        n_rides: rides.len(),
        n_ignored,
        total_km: (total_km * 10.0).round() / 10.0,
        total_moving_h: (total_h * 100.0).round() / 100.0,
        longest_h: (longest_h * 100.0).round() / 100.0,
        climb_km: (t.climb_km * 10.0).round() / 10.0,
        flat_km: (t.flat_km * 10.0).round() / 10.0,
        descent_km: (t.descent_km * 10.0).round() / 10.0,
        rides: reports,
        loo_median_abs_pct: loo_median.map(|v| (v * 10.0).round() / 10.0),
        loo_max_abs_pct: loo_max.map(|v| (v * 10.0).round() / 10.0),
        in_sample_median_abs_pct: (median(&mut in_abs) * 10.0).round() / 10.0,
        expected_accuracy_pct: (expected * 10.0).round() / 10.0,
        grade_table: grade,
        multipliers: [m[0].exp(), m[1].exp(), m[2].exp()],
        a_lat_measured: a_lat,
        a_lat_samples,
        warnings,
    };
    (model, report)
}
