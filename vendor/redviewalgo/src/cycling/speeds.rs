//! Table de vitesses du modèle (pente × revêtement), en régime établi, sans
//! virage ni fatigue : la lecture « tableau » du comportement d'un cycliste.

use serde::Serialize;

use crate::cycling::integrate::walk_kmh;
use crate::cycling::params::ModelParams;
use crate::cycling::physics::{air_density, steady_speed};
use crate::cycling::rider::RiderModel;

pub const TABLE_GRADES: [f64; 14] = [-12.0, -10.0, -8.0, -6.0, -4.0, -2.0, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 15.0];
/// Revêtements présentés : asphalte, gravier, terre.
pub const TABLE_SURFACES: [(u8, &str); 3] = [(1, "asphalt"), (3, "gravel"), (4, "dirt")];

#[derive(Debug, Clone, Serialize)]
pub struct SpeedTable {
    pub grades_pct: Vec<f64>,
    pub surfaces: Vec<String>,
    /// kmh[surface][pente]
    pub kmh: Vec<Vec<f64>>,
    /// walking[surface][pente] : à pied à cette pente.
    pub walking: Vec<Vec<bool>>,
}

pub fn speed_table(r: &RiderModel, p: &ModelParams) -> SpeedTable {
    let rho = air_density(200.0, None);
    let mut kmh = Vec::new();
    let mut walking = Vec::new();
    for (code, _) in TABLE_SURFACES {
        let s = ModelParams::surface_idx(code);
        let crr = r.crr * p.surface_crr[s] * p.rough_crr[1];
        let mut row = Vec::new();
        let mut wrow = Vec::new();
        for g in TABLE_GRADES {
            let up_thr = r.walk_up_pct + p.walk_up_offset[s];
            let down_thr = p.walk_down_pct[s];
            let mut v = steady_speed(r.drivetrain_eff * r.power_at(g), g / 100.0, r.mass_kg, crr, r.cda, rho, 0.0) * 3.6;
            if let Some(c) = r.comfort_kmh(g) {
                v = v.min(c * p.surface_desc[s]);
            }
            let walk = g > up_thr
                || -g > down_thr
                || (g > 3.0 && v < r.v_min_ride_kmh)
                || (g < -1.0 && v < p.walk_down_comfort_kmh);
            if walk {
                v = walk_kmh(g, p);
            }
            row.push((v * 10.0).round() / 10.0);
            wrow.push(walk);
        }
        kmh.push(row);
        walking.push(wrow);
    }
    SpeedTable {
        grades_pct: TABLE_GRADES.to_vec(),
        surfaces: TABLE_SURFACES.iter().map(|(_, n)| n.to_string()).collect(),
        kmh,
        walking,
    }
}
