//! Moteur de temps de déplacement vélo, v2.
//!
//! Modèle physique + comportement simulé sur une grille de ~10 m :
//! puissance visée selon la pente (plat / montée / roue libre), confort de
//! descente, virages (√(a_lat·R)) avec freinage avant et relance après,
//! revêtement (Crr, confort, adhérence), marche à pied, échauffement, fatigue
//! d'endurance. Temps de déplacement seul : les pauses sont l'affaire du
//! planning de l'app, jamais du moteur. Les paramètres d'un
//! cycliste viennent d'un préréglage de niveau, d'une saisie ou de ses .fit.

pub mod calibrate;
pub mod course;
pub mod geometry;
pub mod input;
pub mod integrate;
pub mod output;
pub mod params;
pub mod physics;
pub mod physio;
pub mod presets;
pub mod rider;
pub mod speeds;

use serde::Deserialize;

use crate::types::Gender;
use course::build_course;
use input::{sanitize, CourseInput, GeometrySource};
use integrate::{duration_pacing, simulate, SimOptions};
use output::{build_result, CyclingResult, OutputOptions};
use params::ModelParams;
use rider::{RiderModel, RiderOverride};

/// Version du moteur vélo : une prédiction persistée plus ancienne est recalculée.
pub const ENGINE_VERSION: u32 = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiderSpec {
    Preset {
        level: String,
        #[serde(default)]
        gender: Gender,
    },
    Model(RiderModel),
    Custom {
        #[serde(default)]
        level: Option<String>,
        #[serde(default)]
        gender: Gender,
        #[serde(default)]
        ftp_w: Option<f64>,
        #[serde(default)]
        mass_kg: Option<f64>,
        #[serde(default)]
        tires_mm: Option<f64>,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct OutputConfig {
    /// Calcule aussi le coût des virages / du contexte / de la physiologie
    /// (trois simulations de plus).
    pub diagnostics: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CyclingConfig {
    pub rider: Option<RiderSpec>,
    pub rider_override: Option<RiderOverride>,
    pub start_time_h: Option<f64>,
    pub ambient_temperature_c: Option<f64>,
    pub geometry: Option<GeometrySource>,
    pub model_params: Option<ModelParams>,
    pub output: OutputConfig,
    /// Demi-largeur relative de la fourchette de temps (défaut 0,08).
    pub uncertainty: Option<f64>,
}

pub fn resolve_rider(spec: Option<&RiderSpec>, over: Option<&RiderOverride>) -> RiderModel {
    let mut model = match spec {
        Some(RiderSpec::Preset { level, gender }) => presets::preset(level, *gender),
        Some(RiderSpec::Model(m)) => m.clone(),
        Some(RiderSpec::Custom { level, gender, ftp_w, mass_kg, tires_mm }) => {
            presets::custom(level.as_deref(), *gender, *ftp_w, *mass_kg, *tires_mm)
        }
        None => presets::preset("intermediaire", Gender::Unspecified),
    };
    if let Some(o) = over {
        o.apply(&mut model);
    }
    model
}

/// Config historique de `predict(fits, gpx, config)` → prior du moteur v2.
/// FTP / masse / pneus saisis sont appliqués comme en profil Personnalisé ;
/// CdA et Crr explicites l'emportent ; `pacing_factor` module la puissance.
pub fn from_legacy_config(cfg: &crate::types::PredictionConfig) -> (RiderModel, CyclingConfig) {
    let mass = cfg.mass_kg.or_else(|| match (cfg.rider_weight_kg, cfg.bike_weight_kg) {
        (Some(r), b) => Some(r + b.unwrap_or(10.0)),
        _ => None,
    });
    let mut model = if cfg.ftp_w.is_some() || mass.is_some() {
        presets::custom(None, cfg.gender, cfg.ftp_w, mass, None)
    } else {
        presets::preset("intermediaire", cfg.gender)
    };
    if let Some(cda) = cfg.cda.filter(|v| v.is_finite() && *v > 0.1 && *v < 1.0) {
        model.cda = cda;
    }
    if let Some(crr) = cfg.crr.filter(|v| v.is_finite() && *v > 0.001 && *v < 0.05) {
        model.crr = crr;
    }
    if cfg.pacing_factor.is_finite() && cfg.pacing_factor > 0.3 {
        model.p_flat_w *= cfg.pacing_factor.clamp(0.5, 1.5);
    }
    let v2 = CyclingConfig {
        start_time_h: cfg.start_time_h,
        ambient_temperature_c: cfg.ambient_temperature_c,
        ..Default::default()
    };
    (model, v2)
}

pub fn sim_options(cfg: &CyclingConfig) -> SimOptions {
    SimOptions {
        start_time_h: cfg.start_time_h.filter(|h| h.is_finite()).map(|h| h.rem_euclid(24.0)),
        temperature_c: cfg.ambient_temperature_c.filter(|t| t.is_finite()),
        ..Default::default()
    }
}

/// Prédiction complète d'un tracé pour un modèle de cycliste donné.
pub fn predict_with_model(input: &CourseInput, rider: &RiderModel, cfg: &CyclingConfig) -> Result<CyclingResult, String> {
    let params = cfg.model_params.clone().unwrap_or_default();
    let mut input_geo = input.clone();
    if let Some(g) = cfg.geometry {
        input_geo.geometry = g;
    }
    let clean = sanitize(&input_geo)?;
    let course = build_course(&clean, &params);
    // Allure selon la durée de l'effort : point fixe T = f(allure(T)), atteint
    // en deux ou trois simulations.
    let mut opts = sim_options(cfg);
    let mut sim = simulate(&course, rider, &params, &opts);
    for _ in 0..3 {
        let scale = duration_pacing(sim.moving_s, &params);
        if (scale - opts.power_scale.unwrap_or(1.0)).abs() < 0.002 {
            break;
        }
        opts.power_scale = Some(scale);
        sim = simulate(&course, rider, &params, &opts);
    }
    let diagnostics = if cfg.output.diagnostics {
        let t = sim.moving_s;
        let no_corner = simulate(&course, rider, &params, &SimOptions { disable_corners: true, ..opts.clone() }).moving_s;
        let no_way = simulate(&course, rider, &params, &SimOptions { disable_way: true, ..opts.clone() }).moving_s;
        let no_physio = simulate(&course, rider, &params, &SimOptions { disable_physio: true, ..opts.clone() }).moving_s;
        Some((t - no_corner, t - no_way, t - no_physio))
    } else {
        None
    };
    Ok(build_result(
        ENGINE_VERSION,
        &course,
        &sim,
        rider,
        &params,
        &OutputOptions { uncertainty: cfg.uncertainty.unwrap_or(0.08).clamp(0.0, 0.5), diagnostics },
    ))
}

pub fn predict_course(input: &CourseInput, cfg: &CyclingConfig) -> Result<CyclingResult, String> {
    let rider = resolve_rider(cfg.rider.as_ref(), cfg.rider_override.as_ref());
    predict_with_model(input, &rider, cfg)
}
