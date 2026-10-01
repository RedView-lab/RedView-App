//! Simulation le long du tracé.
//!
//! 1. Plafonds par cellule : confort de descente (pente, revêtement), virage
//!    `√(a_lat·R)`, type de voie, feux, marche à pied.
//! 2. Passe arrière : on freine (`a_dec`) assez tôt pour respecter le plafond
//!    suivant — une épingle coûte le freinage avant et la relance après.
//! 3. Passe avant : énergie cinétique `d(v²)/ds = 2·(F_propulsion − F_résistance)/m_eff`
//!    intégrée en Euler implicite (stable aux faibles vitesses en montée),
//!    puissance visée selon la pente de contexte × physiologie × altitude.

use serde::Serialize;

use crate::cycling::course::{Cell, Course};
use crate::cycling::params::ModelParams;
use crate::cycling::physics::{air_density, altitude_power_factor, steady_speed, G};
use crate::cycling::physio::Physio;
use crate::cycling::rider::RiderModel;

#[derive(Debug, Clone, Default)]
pub struct SimOptions {
    pub temperature_c: Option<f64>,
    pub disable_corners: bool,
    pub disable_way: bool,
    pub disable_physio: bool,
    /// Allure selon la durée prévue de l'effort (voir `duration_pacing`) ;
    /// `None` = 1.
    pub power_scale: Option<f64>,
}

/// Allure selon la durée de l'effort : jusqu'à `pacing_ref_h` heures de
/// déplacement (une longue journée), on roule à l'intensité d'une sortie à la
/// journée ; au-delà, puissance × (T / T_ref)^(−k). Plafonnée à
/// `pacing_max_h` : au-delà de deux à trois jours de roulage, tout le monde
/// dort et l'intensité horaire cesse de baisser (le moteur, lui, ne connaît
/// pas les pauses). Réglage : ultras de 38 à 107 h d'un coureur expert
/// (validation croisée), sorties à la journée de la cycliste de référence.
pub fn duration_pacing(moving_s: f64, p: &ModelParams) -> f64 {
    let hours = (moving_s / 3600.0).min(p.pacing_max_h.max(p.pacing_ref_h));
    if !(hours > p.pacing_ref_h) || p.pacing_ref_h <= 0.0 {
        return 1.0;
    }
    (hours / p.pacing_ref_h).powf(-p.pacing_exponent.max(0.0)).clamp(0.4, 1.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Limit {
    Power,
    Comfort,
    Corner,
    Brake,
    Walk,
    Way,
    Signal,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct CellSim {
    pub dt: f64,
    pub v_in: f64,
    pub v_out: f64,
    /// Puissance effectivement fournie (W au pédalier).
    pub power_w: f64,
    pub walking: bool,
    pub limit: Limit,
}

#[derive(Debug, Clone)]
pub struct Simulation {
    pub cells: Vec<CellSim>,
    pub moving_s: f64,
}

/// Vitesse de marche (km/h) de Tobler, en poussant le vélo.
pub fn walk_kmh(g_pct: f64, p: &ModelParams) -> f64 {
    let tobler = 6.0 * (-3.5 * (g_pct / 100.0 + 0.05).abs()).exp();
    (tobler * p.walk_push_factor).max(p.walk_min_kmh)
}

/// Un pas d'Euler implicite sur u = v² : résout u' − u0 − ds·f(u') = 0 avec
/// f(u) = 2·(F_prop(v) − F_res(v)) / m_eff, fonction croissante de u'.
/// Newton protégé par un encadrement (bissection en secours).
#[allow(clippy::too_many_arguments)]
fn implicit_step(u0: f64, ds: f64, p_wheel: f64, f_max: f64, a_res: f64, b_aero: f64, wind: f64, m_eff: f64) -> f64 {
    let k = 2.0 / m_eff;
    // h(u) et h'(u).
    let eval = |u: f64| -> (f64, f64) {
        let v = u.max(1e-8).sqrt();
        let (f_prop, df_prop) = if v > 0.5 && p_wheel / v < f_max {
            (p_wheel / v, -p_wheel / (v * v))
        } else {
            ((p_wheel / v.max(0.5)).min(f_max), 0.0)
        };
        let air = v + wind;
        let f_res = a_res + b_aero * air * air.abs();
        let df_res = 2.0 * b_aero * air.abs();
        let h = u - u0 - ds * k * (f_prop - f_res);
        let dh = 1.0 - ds * k * (df_prop - df_res) / (2.0 * v);
        (h, dh)
    };
    let mut lo = 1e-4_f64;
    if eval(lo).0 >= 0.0 {
        return lo;
    }
    let mut hi = u0.max(1.0);
    while eval(hi).0 <= 0.0 && hi < 1600.0 {
        hi *= 2.0;
    }
    let mut u = u0.clamp(lo, hi);
    for _ in 0..40 {
        let (h, dh) = eval(u);
        if h.abs() < 1e-7 * u.max(1.0) {
            return u;
        }
        if h > 0.0 { hi = u } else { lo = u }
        let newton = u - h / dh;
        u = if dh > 0.0 && newton > lo && newton < hi { newton } else { 0.5 * (lo + hi) };
        if hi - lo < 1e-9 * hi {
            break;
        }
    }
    u
}

struct CellConst {
    crr: f64,
    rho: f64,
    alt: f64,
    sin_t: f64,
    cos_t: f64,
    cap: f64,
    cap_kind: Limit,
    walking: bool,
    v_walk: f64,
}

fn cell_constants(cell: &Cell, r: &RiderModel, p: &ModelParams, o: &SimOptions) -> CellConst {
    let s = ModelParams::surface_idx(cell.surface);
    let ro = ModelParams::rough_idx(cell.rough);
    let w = ModelParams::way_idx(cell.way);
    let ele = 0.5 * (cell.ele0 + cell.ele1);
    let theta = (cell.g_local / 100.0).atan();
    let mut cap = f64::INFINITY;
    let mut cap_kind = Limit::Power;
    let mut set = |v: f64, kind: Limit| {
        if v < cap {
            cap = v;
            cap_kind = kind;
        }
    };
    if let Some(v) = r.comfort_kmh(cell.g_mid) {
        set(v * p.surface_desc[s] * p.rough_desc[ro] / 3.6, Limit::Comfort);
    }
    if !o.disable_corners && cell.radius_m.is_finite() {
        set((r.a_lat_ms2 * p.surface_alat[s] * cell.radius_m).sqrt(), Limit::Corner);
    }
    if !o.disable_way {
        if p.way_vmax_kmh[w] < 99.0 {
            set(p.way_vmax_kmh[w] / 3.6, Limit::Way);
        }
        if cell.signal && p.signal_kmh < 99.0 {
            set(p.signal_kmh / 3.6, Limit::Signal);
        }
        if cell.urban && p.urban_vmax_kmh < 99.0 {
            set(p.urban_vmax_kmh / 3.6, Limit::Way);
        }
    }
    CellConst {
        crr: r.crr * p.surface_crr[s] * p.rough_crr[ro],
        rho: air_density(ele, o.temperature_c),
        alt: altitude_power_factor(ele),
        sin_t: theta.sin(),
        cos_t: theta.cos(),
        cap,
        cap_kind,
        walking: false,
        v_walk: walk_kmh(cell.g_walk, p) / 3.6,
    }
}

/// Décide des cellules parcourues à pied (montée trop raide pour rouler,
/// descente trop raide/rugueuse), avec hystérésis.
fn mark_walking(course: &Course, consts: &mut [CellConst], r: &RiderModel, p: &ModelParams, scale: f64) {
    let mut walking = false;
    for (cell, k) in course.cells.iter().zip(consts.iter_mut()) {
        let s = ModelParams::surface_idx(cell.surface);
        let ro = ModelParams::rough_idx(cell.rough);
        let up_thr = r.walk_up_pct + p.walk_up_offset[s] + p.rough_walk_up_offset[ro];
        let down_thr = p.walk_down_pct[s] + p.rough_walk_down_offset[ro];
        let hyst = if walking { p.walk_hysteresis_pct } else { 0.0 };
        let mut walk = cell.g_walk > up_thr - hyst || -cell.g_walk > down_thr - hyst;
        if !walk && cell.g_walk > 3.0 {
            // Trop raide pour la puissance disponible : sous v_min, on pousse.
            let v = steady_speed(
                r.drivetrain_eff * r.power_at(cell.g_ctx.max(cell.g_walk)) * k.alt * scale,
                cell.g_walk / 100.0,
                r.mass_kg,
                k.crr,
                r.cda,
                k.rho,
                cell.wind,
            );
            let margin = if walking { 0.5 } else { 0.0 };
            walk = v * 3.6 < r.v_min_ride_kmh + margin;
        }
        if !walk && k.cap_kind == Limit::Comfort && k.cap * 3.6 < p.walk_down_comfort_kmh {
            walk = true;
        }
        k.walking = walk;
        walking = walk;
        if walk {
            k.cap = k.v_walk;
            k.cap_kind = Limit::Walk;
        }
    }
}

pub fn simulate(course: &Course, r: &RiderModel, p: &ModelParams, o: &SimOptions) -> Simulation {
    let n = course.cells.len();
    let m = r.mass_kg.max(20.0);
    let m_eff = m + p.m_eff_extra_kg;
    let eta = r.drivetrain_eff.clamp(0.8, 1.0);
    let f_max = (p.f_prop_max_weight_frac * m * G).max(150.0);
    let v_start = p.start_speed_ms.max(0.3);

    let mut consts: Vec<CellConst> = course.cells.iter().map(|c| cell_constants(c, r, p, o)).collect();
    let scale = o.power_scale.unwrap_or(1.0).clamp(0.3, 1.5);
    mark_walking(course, &mut consts, r, p, scale);

    // Plafonds aux nœuds puis passe arrière de freinage.
    let mut node_cap = vec![f64::INFINITY; n + 1];
    let mut node_kind = vec![Limit::Power; n + 1];
    for k in 0..=n {
        let mut best = f64::INFINITY;
        let mut kind = Limit::Power;
        for idx in [k.wrapping_sub(1), k] {
            if idx < n && consts[idx].cap < best {
                best = consts[idx].cap;
                kind = consts[idx].cap_kind;
            }
        }
        node_cap[k] = best;
        node_kind[k] = kind;
    }
    node_cap[0] = node_cap[0].min(v_start);
    for k in (0..n).rev() {
        let s = ModelParams::surface_idx(course.cells[k].surface);
        let a_dec = (r.a_dec_ms2 * p.surface_alat[s]).max(0.3);
        let reachable = (node_cap[k + 1] * node_cap[k + 1] + 2.0 * a_dec * course.cells[k].ds).sqrt();
        if reachable < node_cap[k] {
            node_cap[k] = reachable;
            node_kind[k] = Limit::Brake;
        }
    }

    // Passe avant.
    let mut physio = Physio::default();
    let mut out = Vec::with_capacity(n);
    let mut v = node_cap[0];
    let mut moving = 0.0;
    for k in 0..n {
        let cell = &course.cells[k];
        let c = &consts[k];
        let ds = cell.ds;
        if c.walking {
            let v_out = c.v_walk.min(node_cap[k + 1].max(c.v_walk));
            let dt = ds / c.v_walk.max(0.1);
            physio.ride(dt);
            moving += dt;
            out.push(CellSim { dt, v_in: v, v_out, power_w: 0.0, walking: true, limit: Limit::Walk });
            v = v_out;
            continue;
        }

        let phys = scale * if o.disable_physio { 1.0 } else { physio.factor(r, p) };
        // Allure réglée sur la pente de contexte (on ne relâche pas sur un
        // replat de montée, on ne force pas sur une bosse de 50 m — ni sur le
        // bruit du MNT), mais on repédale sur une bosse en pleine descente.
        let g_power = if cell.g_ctx < 0.0 { cell.g_ctx.max(cell.g_mid) } else { cell.g_ctx };
        let power = r.power_at(g_power) * phys * c.alt;
        let a_res = m * G * (c.sin_t + c.crr * c.cos_t);
        let b_aero = 0.5 * c.rho * r.cda;
        let v_free = implicit_step(v * v, ds, eta * power, f_max, a_res, b_aero, cell.wind, m_eff).sqrt();
        if v_free < p.stall_kmh / 3.6 && v < p.stall_kmh / 3.6 {
            // Plus assez de vitesse pour tenir l'équilibre : pied à terre.
            let dt = ds / c.v_walk.max(0.1);
            physio.ride(dt);
            moving += dt;
            out.push(CellSim { dt, v_in: v, v_out: c.v_walk, power_w: 0.0, walking: true, limit: Limit::Walk });
            v = c.v_walk;
            continue;
        }
        let mut v_out = v_free;
        let mut limit = Limit::Power;
        if node_cap[k + 1] < v_free {
            v_out = node_cap[k + 1];
            limit = node_kind[k + 1];
        }
        let v_avg = 0.5 * (v + v_out);
        let dt = if v_avg > 1e-3 { ds / v_avg } else { ds / 0.3 };
        let power_used = if limit == Limit::Power {
            power
        } else {
            let air = v_avg + cell.wind;
            ((a_res + b_aero * air * air.abs()) * v_avg / eta).clamp(0.0, power)
        };
        physio.ride(dt);
        moving += dt;
        out.push(CellSim { dt, v_in: v, v_out, power_w: power_used, walking: false, limit });
        v = v_out;
    }
    Simulation { cells: out, moving_s: moving }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;
    use crate::cycling::course::build_course;
    use crate::cycling::input::{sanitize, CourseInput, GeometrySource};
    use crate::cycling::presets::preset;
    use crate::types::Gender;

    const KY: f64 = 111_194.93;

    /// Tracé rectiligne vers le nord, profil d'altitude donné par une fonction.
    fn straight(len_m: f64, step: f64, ele: impl Fn(f64) -> f64, surface: u8) -> Course {
        let n = (len_m / step) as usize + 1;
        let input = CourseInput {
            lat: (0..n).map(|i| 45.0 + i as f64 * step / KY).collect(),
            lon: vec![6.0; n],
            ele: (0..n).map(|i| ele(i as f64 * step)).collect(),
            surface: vec![surface; n],
            geometry: GeometrySource::Planned,
            ..Default::default()
        };
        build_course(&sanitize(&input).unwrap(), &ModelParams::default())
    }

    #[test]
    fn flat_speed_converges_to_steady_state() {
        let r = preset("intermediaire", Gender::Female);
        let p = ModelParams::default();
        let course = straight(20_000.0, 50.0, |_| 100.0, 1);
        let sim = simulate(&course, &r, &p, &SimOptions { disable_physio: true, ..Default::default() });
        let v_end = sim.cells.last().unwrap().v_out;
        let expected = steady_speed(
            r.drivetrain_eff * r.p_flat_w * altitude_power_factor(100.0),
            0.0, r.mass_kg, r.crr * p.surface_crr[1], r.cda, air_density(100.0, None), 0.0,
        );
        assert!((v_end - expected).abs() < 0.05, "{v_end} vs {expected}");
        // Le temps total ne doit pas dépendre de la résolution des points source.
        let coarse = straight(20_000.0, 250.0, |_| 100.0, 1);
        let t2 = simulate(&coarse, &r, &p, &SimOptions { disable_physio: true, ..Default::default() }).moving_s;
        assert!((sim.moving_s / t2 - 1.0).abs() < 0.005);
    }

    #[test]
    fn steep_gravel_wall_is_walked() {
        let r = preset("intermediaire", Gender::Female);
        let p = ModelParams::default();
        // 300 m plat, 400 m à 20 %, 300 m plat.
        let course = straight(1000.0, 10.0, |d| if d < 300.0 { 0.0 } else if d < 700.0 { 0.2 * (d - 300.0) } else { 80.0 }, 3);
        let sim = simulate(&course, &r, &p, &SimOptions::default());
        let walked: f64 = sim.cells.iter().filter(|c| c.walking).count() as f64 * 10.0;
        assert!(walked > 250.0, "walked {walked} m");
        let v_walk = sim.cells.iter().find(|c| c.walking).map(|c| c.v_out * 3.6).unwrap();
        assert!(v_walk > 2.0 && v_walk < 4.5, "{v_walk}");
    }

    #[test]
    fn descent_respects_comfort_speed() {
        let r = preset("intermediaire", Gender::Female);
        let p = ModelParams::default();
        let course = straight(5000.0, 20.0, |d| 1000.0 - 0.08 * d, 1);
        let sim = simulate(&course, &r, &p, &SimOptions::default());
        let vmax = sim.cells.iter().map(|c| c.v_out).fold(0.0, f64::max) * 3.6;
        let comfort = r.comfort_kmh(-8.0).unwrap();
        assert!(vmax <= comfort + 0.01 && vmax > comfort - 1.0, "{vmax} vs {comfort}");
    }

    #[test]
    fn heavier_rider_is_slower_uphill() {
        let p = ModelParams::default();
        let course = straight(5000.0, 20.0, |d| 0.06 * d, 1);
        let a = preset("intermediaire", Gender::Female);
        let mut b = a.clone();
        b.mass_kg += 10.0;
        let ta = simulate(&course, &a, &p, &SimOptions::default()).moving_s;
        let tb = simulate(&course, &b, &p, &SimOptions::default()).moving_s;
        assert!(tb > ta);
    }
}
