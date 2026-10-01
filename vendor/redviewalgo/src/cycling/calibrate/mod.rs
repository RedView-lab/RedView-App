//! Calibration du modèle vélo v2 sur les .fit d'un cycliste.

pub mod fit;
pub mod truth;

use serde::{Deserialize, Serialize};

use crate::cycling::input::{CourseInput, GeometrySource};
use crate::cycling::params::ModelParams;
use crate::cycling::rider::RiderModel;
use crate::types::ActivityData;
use fit::{calibrate, CalibrationReport};
use truth::{build_truth, ride_truth, RideTruth};

#[derive(Debug, Clone, Serialize)]
pub struct CalibrationResult {
    pub engine_version: u32,
    pub model: RiderModel,
    pub report: CalibrationReport,
}

/// Taille visée de la grille de calibration, toutes sorties confondues : au-
/// delà (beaucoup de longues sorties), le pas s'élargit pour borner le temps
/// de calcul (chaque évaluation rejoue toutes les sorties).
const CALIBRATION_TARGET_CELLS: f64 = 40_000.0;
const CALIBRATION_MAX_CELL_M: f64 = 60.0;

/// Grille de la calibration : plus grossière que la prédiction (deux fois
/// moins de cellules à rejouer à chaque évaluation), sans effet mesurable sur
/// les temps par kilomètre.
pub fn calibration_params(p: &ModelParams) -> ModelParams {
    let mut q = p.clone();
    q.cell_m = p.calibration_cell_m.max(1.0);
    q
}

/// Construit les vérités terrain, en élargissant la grille si le volume total
/// de sorties le demande.
fn build_rides<T>(items: &[T], p: &ModelParams, build: impl Fn(&T, &ModelParams) -> Option<RideTruth>) -> (Vec<RideTruth>, usize, ModelParams) {
    let mut q = calibration_params(p);
    let collect = |q: &ModelParams| {
        let mut rides = Vec::new();
        let mut ignored = 0usize;
        for item in items {
            match build(item, q) {
                Some(r) => rides.push(r),
                None => ignored += 1,
            }
        }
        (rides, ignored)
    };
    let (mut rides, mut ignored) = collect(&q);
    let total_m: f64 = rides.iter().map(|r| r.distance_m).sum();
    let cell = (total_m / CALIBRATION_TARGET_CELLS).clamp(q.cell_m, CALIBRATION_MAX_CELL_M);
    if cell > q.cell_m * 1.05 {
        q.cell_m = cell;
        (rides, ignored) = collect(&q);
    }
    (rides, ignored, q)
}

pub fn calibrate_activities(activities: &[ActivityData], prior: &RiderModel, p: &ModelParams) -> CalibrationResult {
    let (rides, ignored, q) = build_rides(activities, p, |a, q| ride_truth(a, q));
    let (model, report) = calibrate(&rides, ignored, prior, &q);
    CalibrationResult { engine_version: crate::cycling::ENGINE_VERSION, model, report }
}

/// Trace en mouvement déjà extraite (et éventuellement étiquetée OSM).
#[derive(Debug, Clone, Deserialize)]
pub struct TrackInput {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    pub ele: Vec<f64>,
    /// Distance cumulée (m).
    pub dist: Vec<f64>,
    /// Temps de déplacement cumulé (s).
    pub t: Vec<f64>,
    #[serde(default)]
    pub surface: Vec<u8>,
    #[serde(default)]
    pub way: Vec<u8>,
}

pub fn calibrate_tracks(tracks: &[TrackInput], prior: &RiderModel, p: &ModelParams) -> CalibrationResult {
    let (rides, ignored, q) = build_rides(tracks, p, |tr, q| {
        let input = CourseInput {
            lat: tr.lat.clone(),
            lon: tr.lon.clone(),
            ele: tr.ele.clone(),
            dist: tr.dist.clone(),
            surface: tr.surface.clone(),
            way: tr.way.clone(),
            headwind_ms: Vec::new(),
            geometry: GeometrySource::Gps,
        };
        build_truth(input, &tr.t, q)
    });
    let (model, report) = calibrate(&rides, ignored, prior, &q);
    CalibrationResult { engine_version: crate::cycling::ENGINE_VERSION, model, report }
}
