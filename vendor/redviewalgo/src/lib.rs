mod cycling;
mod fit_parser;
mod gpx_parser;
mod knn;
mod math;
mod prediction;
mod running;
mod types;

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Log a message to the browser console.
#[allow(dead_code)]
fn log(msg: &str) {
    web_sys::console::log_1(&JsValue::from_str(msg));
}

/// Log with timing: returns elapsed ms since a given start.
#[allow(dead_code)]
fn log_timed(msg: &str, start: f64) -> f64 {
    let now = js_sys::Date::now();
    let elapsed = now - start;
    web_sys::console::log_1(&JsValue::from_str(&format!("[{:.0}ms] {}", elapsed, msg)));
    now
}

/// Initialize panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Main prediction function.
///
/// # Arguments
/// * `fit_files` - Array of FIT file contents as `Uint8Array`
/// * `gpx_data` - GPX file content as `Uint8Array`
/// * `config`   - JSON config object `{ mass_kg?, cda?, crr?, pacing_factor? }`
///
/// # Returns
/// A JS object (serialised `PredictionResult`) containing:
/// - `total_time_s`, `total_distance_m`, `avg_speed_kmh`
/// - `segments` — array of segment summaries
/// - `points`   — point-by-point predictions (for graphs)
/// - `rider_profile` — detected rider stats
#[wasm_bindgen]
pub fn predict(
    fit_files: Vec<js_sys::Uint8Array>,
    gpx_data: &[u8],
    config: JsValue,
    on_progress: Option<js_sys::Function>,
) -> Result<JsValue, JsValue> {
    let t0 = js_sys::Date::now();
    let progress = |msg: &str| {
        let elapsed = js_sys::Date::now() - t0;
        let text = format!("[{:.0}ms] {}", elapsed, msg);
        web_sys::console::log_1(&JsValue::from_str(&text));
        if let Some(ref cb) = on_progress {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&text));
        }
    };

    progress("Démarrage...");

    // 1. Parse config
    let cfg: types::PredictionConfig = if config.is_undefined() || config.is_null() {
        types::PredictionConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };

    // 2. Parse FIT files
    progress(&format!("Lecture de {} fichier(s) FIT...", fit_files.len()));
    let fit_buffers: Vec<Vec<u8>> = fit_files.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();

    let parsed = fit_parser::parse_fit_batch(&fit_slices)
        .map_err(|e| JsValue::from_str(&e))?;
    // Running / hiking recordings would teach the cycling model walking speeds.
    let (activities, ignored) = split_by_sport(parsed, |s| !s.is_foot_sport());
    if ignored > 0 {
        progress(&format!("{} fichier(s) ignoré(s) (autre sport)", ignored));
    }

    // 3. Parse GPX (points bruts : le moteur v2 fait son propre traitement)
    let raw = gpx_parser::parse_gpx_points(gpx_data).map_err(|e| JsValue::from_str(&e))?;
    let input = cycling::input::CourseInput {
        lat: raw.iter().map(|p| p.0).collect(),
        lon: raw.iter().map(|p| p.1).collect(),
        ele: raw.iter().map(|p| if p.3 { p.2 } else { f64::NAN }).collect(),
        ..Default::default()
    };

    // 4. Modèle du cycliste : config historique → prior, puis calibration .fit
    let (prior, v2_cfg) = cycling::from_legacy_config(&cfg);
    let (model, uncertainty) = if activities.is_empty() {
        (prior, None)
    } else {
        progress(&format!("Calibration sur {} sortie(s)...", activities.len()));
        let params = v2_cfg.model_params.clone().unwrap_or_default();
        let cal = cycling::calibrate::calibrate_activities(&activities, &prior, &params);
        let accuracy = cal.report.expected_accuracy_pct / 100.0;
        (cal.model, Some(accuracy))
    };

    // 5. Prédiction v2
    let v2_cfg = cycling::CyclingConfig { uncertainty: uncertainty.or(v2_cfg.uncertainty), ..v2_cfg };
    let result = cycling::predict_with_model(&input, &model, &v2_cfg).map_err(|e| JsValue::from_str(&e))?;
    progress(&format!("Terminé ! Temps de déplacement prédit : {}", format_duration(result.total_time_s)));

    // 6. Serialize result
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

/// Version du moteur vélo (v2) : les prédictions persistées plus anciennes
/// doivent être recalculées.
#[wasm_bindgen]
pub fn engine_version() -> u32 {
    cycling::ENGINE_VERSION
}

/// Prédiction vélo v2 sur un tracé passé en tableaux typés.
///
/// * `lat`, `lon` — degrés ; `ele` — mètres (NaN = inconnue)
/// * `dist_m` — axe de distance de l'app (vide = haversine)
/// * `surface`, `way` — attributs par point (voir `cycling::input`), vides = inconnus
/// * `headwind_ms` — vent de face par point (vide = pas de vent)
/// * `config` — `CyclingConfig` : `{ rider, rider_override?,
///   ambient_temperature_c?, geometry?, model_params?, output? }` (temps de
///   déplacement seul : ni pauses ni heure de départ)
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn predict_cycling(
    lat: &[f64],
    lon: &[f64],
    ele: &[f64],
    dist_m: &[f64],
    surface: &[u8],
    way: &[u8],
    headwind_ms: &[f64],
    config: JsValue,
) -> Result<JsValue, JsValue> {
    let cfg: cycling::CyclingConfig = if config.is_undefined() || config.is_null() {
        cycling::CyclingConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };
    let input = cycling::input::CourseInput {
        lat: lat.to_vec(),
        lon: lon.to_vec(),
        ele: ele.to_vec(),
        dist: dist_m.to_vec(),
        surface: surface.to_vec(),
        way: way.to_vec(),
        headwind_ms: headwind_ms.to_vec(),
        geometry: cycling::input::GeometrySource::Auto,
    };
    let result = cycling::predict_course(&input, &cfg).map_err(|e| JsValue::from_str(&e))?;
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

/// Calibration vélo v2 sur les .fit d'un cycliste.
///
/// `config` : `CyclingConfig` dont `rider` sert de prior (préréglage ou
/// profil personnalisé : masse, pneus, FTP) et `model_params` éventuels.
/// Renvoie `{ engine_version, model, report }` ; `model` se passe ensuite à
/// `predict_cycling` via `{ rider: { model } }`.
#[wasm_bindgen]
pub fn calibrate_cycling(
    fit_files: Vec<js_sys::Uint8Array>,
    config: JsValue,
    on_progress: Option<js_sys::Function>,
) -> Result<JsValue, JsValue> {
    let progress = |msg: &str| {
        if let Some(ref cb) = on_progress {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(msg));
        }
    };
    let cfg: cycling::CyclingConfig = if config.is_undefined() || config.is_null() {
        cycling::CyclingConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };
    progress(&format!("Lecture de {} fichier(s) FIT...", fit_files.len()));
    let fit_buffers: Vec<Vec<u8>> = fit_files.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();
    let parsed = fit_parser::parse_fit_batch(&fit_slices).map_err(|e| JsValue::from_str(&e))?;
    let (activities, foot) = split_by_sport(parsed, |s| !s.is_foot_sport());
    progress(&format!("Calibration sur {} sortie(s)...", activities.len()));
    let prior = cycling::resolve_rider(cfg.rider.as_ref(), cfg.rider_override.as_ref());
    let params = cfg.model_params.clone().unwrap_or_default();
    let mut result = cycling::calibrate::calibrate_activities(&activities, &prior, &params);
    result.report.n_ignored += foot;
    progress(&format!(
        "Calibration terminée : précision attendue ±{:.1} %",
        result.report.expected_accuracy_pct
    ));
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

/// Calibration vélo v2 sur des traces déjà extraites (banc de mesure, traces
/// étiquetées OSM) : `tracks` = `[{ lat, lon, ele, dist, t, surface?, way? }]`.
#[wasm_bindgen]
pub fn calibrate_cycling_tracks(tracks: JsValue, config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: cycling::CyclingConfig = if config.is_undefined() || config.is_null() {
        cycling::CyclingConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };
    let tracks: Vec<cycling::calibrate::TrackInput> = serde_wasm_bindgen::from_value(tracks)
        .map_err(|e| JsValue::from_str(&format!("Invalid tracks: {e}")))?;
    let prior = cycling::resolve_rider(cfg.rider.as_ref(), cfg.rider_override.as_ref());
    let params = cfg.model_params.clone().unwrap_or_default();
    let result = cycling::calibrate::calibrate_tracks(&tracks, &prior, &params);
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

/// Keep activities whose summary passes `keep`; returns (kept, dropped count).
fn split_by_sport(
    activities: Vec<types::ActivityData>,
    keep: impl Fn(&types::ActivitySummary) -> bool,
) -> (Vec<types::ActivityData>, usize) {
    let total = activities.len();
    let kept: Vec<types::ActivityData> =
        activities.into_iter().filter(|a| keep(&a.summary)).collect();
    let dropped = total - kept.len();
    (kept, dropped)
}

/// Running / trail-running prediction.
///
/// Same inputs as [`predict`]; `config` is a `RunPredictionConfig`
/// `{ discipline: "running"|"trail", level?, vma_kmh?, ref_distance_m?,
/// ref_time_s?, mass_kg?, technicality?, start_time_h?, gender?, max_route_points? }`.
/// FIT files recorded as cycling are ignored.
#[wasm_bindgen]
pub fn predict_run(
    fit_files: Vec<js_sys::Uint8Array>,
    gpx_data: &[u8],
    config: JsValue,
    on_progress: Option<js_sys::Function>,
) -> Result<JsValue, JsValue> {
    let t0 = js_sys::Date::now();
    let progress = |msg: &str| {
        let elapsed = js_sys::Date::now() - t0;
        let text = format!("[{:.0}ms] {}", elapsed, msg);
        web_sys::console::log_1(&JsValue::from_str(&text));
        if let Some(ref cb) = on_progress {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&text));
        }
    };

    progress("Démarrage (course à pied)...");

    let cfg: running::RunPredictionConfig = if config.is_undefined() || config.is_null() {
        running::RunPredictionConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };

    progress(&format!("Parsing {} fichier(s) FIT...", fit_files.len()));
    let fit_buffers: Vec<Vec<u8>> = fit_files.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();
    let parsed = fit_parser::parse_fit_batch(&fit_slices)
        .map_err(|e| JsValue::from_str(&e))?;
    let (activities, ignored) = split_by_sport(parsed, |s| !s.is_cycling_sport());
    if ignored > 0 {
        progress(&format!("{} fichier(s) ignoré(s) (autre sport)", ignored));
    }
    progress(&format!("{} activité(s) course retenue(s)", activities.len()));

    progress(&format!("Parsing GPX ({:.1} MB)...", gpx_data.len() as f64 / 1_048_576.0));
    let route = gpx_parser::parse_gpx(gpx_data, cfg.max_route_points, cfg.smoothing_window_m)
        .map_err(|e| JsValue::from_str(&e))?;
    progress(&format!("Route: {} points, {:.1} km, D+ {:.0}m",
        route.points.len(),
        route.total_distance_m / 1000.0,
        route.total_elevation_gain_m));

    progress(&format!("Prédiction sur {} points de route...", route.points.len()));
    let result = running::predict_run(&activities, ignored, &route, &cfg);
    progress(&format!("Profil: allure ref {:.1} km/h ({}), marche > {:.0}%, VAM {:.0} m/h, k={:.3}",
        result.runner_profile.v_ref_kmh,
        result.runner_profile.v_ref_source,
        result.runner_profile.walk_threshold_pct,
        result.runner_profile.walk_vam_mh,
        result.runner_profile.riegel_k));
    progress(&format!("Terminé! Temps prédit: {}", format_duration(result.total_time_s)));

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

fn format_duration(seconds: f64) -> String {
    let h = (seconds / 3600.0).floor() as u32;
    let m = ((seconds % 3600.0) / 60.0).floor() as u32;
    let s = (seconds % 60.0).round() as u32;
    format!("{}h{:02}m{:02}s", h, m, s)
}

// ─── Comparison / Validation mode ───────────────────────────────────────────

/// An actual speed point from a FIT file, used for comparison.
#[derive(serde::Serialize)]
struct ActualSpeedPoint {
    distance_m: f64,
    speed_kmh: f64,
    elapsed_time_s: f64,
    elevation_m: f64,
}

/// Result of a "predict vs actual" comparison.
#[derive(serde::Serialize)]
struct ComparisonResult {
    prediction: cycling::output::CyclingResult,
    actual_points: Vec<ActualSpeedPoint>,
    actual_total_time_s: f64,
    actual_riding_time_s: f64,
    actual_avg_speed_kmh: f64,
    actual_distance_m: f64,
}

/// Prédit une sortie de validation (sa propre trace) avec un modèle calibré
/// sur les seules sorties d'entraînement, et renvoie le réel pour comparaison.
#[wasm_bindgen]
pub fn predict_vs_actual(
    training_fits: Vec<js_sys::Uint8Array>,
    validation_fit: &[u8],
    config: JsValue,
) -> Result<JsValue, JsValue> {
    let cfg: types::PredictionConfig = if config.is_undefined() || config.is_null() {
        types::PredictionConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };

    let fit_buffers: Vec<Vec<u8>> = training_fits.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();
    let training = fit_parser::parse_fit_batch(&fit_slices).map_err(|e| JsValue::from_str(&e))?;
    let (training, _) = split_by_sport(training, |s| !s.is_foot_sport());
    let val_activity = fit_parser::parse_fit(validation_fit).map_err(|e| JsValue::from_str(&e))?;

    let (prior, v2_cfg) = cycling::from_legacy_config(&cfg);
    let params = v2_cfg.model_params.clone().unwrap_or_default();
    let model = if training.is_empty() {
        prior
    } else {
        cycling::calibrate::calibrate_activities(&training, &prior, &params).model
    };

    // Trace de la sortie de validation en mouvement (arrêts retirés).
    let truth = cycling::calibrate::truth::ride_truth(&val_activity, &params)
        .ok_or_else(|| JsValue::from_str("Sortie de validation trop courte ou sans GPS"))?;
    let raw: Vec<_> = val_activity.points.iter().filter(|p| p.lat.abs() > 0.001 && p.lon.abs() > 0.001).collect();
    let input = cycling::input::CourseInput {
        lat: raw.iter().map(|p| p.lat).collect(),
        lon: raw.iter().map(|p| p.lon).collect(),
        ele: raw.iter().map(|p| p.altitude_m).collect(),
        geometry: cycling::input::GeometrySource::Gps,
        ..Default::default()
    };
    let prediction = cycling::predict_with_model(&input, &model, &v2_cfg).map_err(|e| JsValue::from_str(&e))?;

    let actual_points: Vec<ActualSpeedPoint> = val_activity
        .points
        .iter()
        .filter(|p| p.speed_ms >= 0.0 && p.distance_m >= 0.0)
        .map(|p| ActualSpeedPoint {
            distance_m: p.distance_m,
            speed_kmh: p.speed_ms * 3.6,
            elapsed_time_s: p.timestamp_s,
            elevation_m: p.altitude_m,
        })
        .collect();
    let actual_total_time = val_activity.summary.duration_s;
    let actual_distance = val_activity.summary.distance_m;
    let comparison = ComparisonResult {
        prediction,
        actual_points,
        actual_total_time_s: actual_total_time,
        actual_riding_time_s: truth.moving_s,
        actual_avg_speed_kmh: if truth.moving_s > 0.0 { truth.distance_m / truth.moving_s * 3.6 } else { 0.0 },
        actual_distance_m: actual_distance,
    };
    comparison
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}
