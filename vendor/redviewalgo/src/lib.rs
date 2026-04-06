mod fit_parser;
mod gpx_parser;
mod knn;
mod math;
mod prediction;
mod profile;
mod types;

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
    progress(&format!("Parsing {} fichier(s) FIT...", fit_files.len()));
    let fit_buffers: Vec<Vec<u8>> = fit_files.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();

    let activities = fit_parser::parse_fit_batch(&fit_slices)
        .map_err(|e| JsValue::from_str(&e))?;

    let total_pts: usize = activities.iter().map(|a| a.points.len()).sum();
    progress(&format!("{} activité(s) parsées ({} points)", activities.len(), total_pts));

    // 3. Parse GPX
    progress(&format!("Parsing GPX ({:.1} MB)...", gpx_data.len() as f64 / 1_048_576.0));
    let route = gpx_parser::parse_gpx(
        gpx_data,
        cfg.max_route_points,
        cfg.smoothing_window_m,
    )
        .map_err(|e| JsValue::from_str(&e))?;
    progress(&format!("Route: {} points, {:.1} km, D+ {:.0}m",
        route.points.len(),
        route.total_distance_m / 1000.0,
        route.total_elevation_gain_m));

    // 4. Build rider profile
    progress("Construction du profil rider...");
    let profile = profile::build_rider_profile(&activities, &cfg);
    progress(&format!("Profil: FTP={:.0}W, masse={:.1}kg (coureur {:.1}kg + vélo {:.1}kg), W/kg={:.2}, {} bins",
        profile.ftp_w, profile.mass_kg, profile.rider_weight_kg, profile.bike_weight_kg,
        profile.wkg, profile.gradient_bins.len()));

    // 4b. Build KNN model from activity data
    progress("Construction du modèle KNN...");
    let mut knn = knn::build_knn_model(&activities);
    progress(&format!("KNN: {} samples (usable: {})", knn.samples.len(), knn.is_usable()));

    // 5. Run prediction
    progress(&format!("Prédiction sur {} points de route...", route.points.len()));
    let result = prediction::predict(&profile, &route, &cfg, &mut knn);
    progress(&format!("Terminé! Temps prédit: {}",
        format_duration(result.total_time_s)));

    // 6. Serialize result
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
    prediction: types::PredictionResult,
    actual_points: Vec<ActualSpeedPoint>,
    actual_total_time_s: f64,
    actual_riding_time_s: f64,
    actual_avg_speed_kmh: f64,
    actual_distance_m: f64,
}

/// Build a Route from an ActivityData's GPS track.
fn route_from_activity(
    activity: &types::ActivityData,
    smooth_window_m: f64,
    max_route_points: usize,
) -> Result<types::Route, String> {
    let raw_points: Vec<(f64, f64, f64)> = activity
        .points
        .iter()
        .filter(|p| p.lat.abs() > 0.001 && p.lon.abs() > 0.001)
        .map(|p| (p.lat, p.lon, p.altitude_m))
        .collect();

    if raw_points.len() < 2 {
        return Err("FIT file has fewer than 2 valid GPS points".to_string());
    }

    gpx_parser::build_route(raw_points, max_route_points, smooth_window_m)
}

/// Run prediction on a validation FIT file and compare with actual data.
///
/// The validation FIT is NOT included in the training data for the model.
/// This allows direct comparison of predicted vs actual speed.
#[wasm_bindgen]
pub fn predict_vs_actual(
    training_fits: Vec<js_sys::Uint8Array>,
    validation_fit: &[u8],
    config: JsValue,
) -> Result<JsValue, JsValue> {
    let t0 = js_sys::Date::now();
    let progress = |msg: &str| {
        let elapsed = js_sys::Date::now() - t0;
        web_sys::console::log_1(&JsValue::from_str(&format!("[{:.0}ms] {}", elapsed, msg)));
    };

    let cfg: types::PredictionConfig = if config.is_undefined() || config.is_null() {
        types::PredictionConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
    };

    // Parse training FIT files
    progress(&format!("Parsing {} training FIT file(s)...", training_fits.len()));
    let fit_buffers: Vec<Vec<u8>> = training_fits.iter().map(|f| f.to_vec()).collect();
    let fit_slices: Vec<&[u8]> = fit_buffers.iter().map(|b| b.as_slice()).collect();
    let training_activities = fit_parser::parse_fit_batch(&fit_slices)
        .map_err(|e| JsValue::from_str(&e))?;

    // Parse validation FIT file — NOT used for training
    progress("Parsing validation FIT file...");
    let val_activity = fit_parser::parse_fit(validation_fit)
        .map_err(|e| JsValue::from_str(&e))?;

    // Extract route from validation FIT
    progress("Extracting route from validation FIT...");
    let smooth_w = cfg.smoothing_window_m.unwrap_or(50.0);
    let max_pts = cfg.max_route_points.unwrap_or(15_000);
    let route = route_from_activity(&val_activity, smooth_w, max_pts)
        .map_err(|e| JsValue::from_str(&e))?;
    progress(&format!("Route: {} points, {:.1} km", route.points.len(), route.total_distance_m / 1000.0));

    // Build profile + KNN from TRAINING ONLY
    progress("Building rider profile from training data...");
    let rider_profile = profile::build_rider_profile(&training_activities, &cfg);

    progress("Building KNN model from training data...");
    let mut knn_model = knn::build_knn_model(&training_activities);
    progress(&format!("KNN: {} samples (usable: {})", knn_model.samples.len(), knn_model.is_usable()));

    // Run prediction on the extracted route
    progress("Running prediction...");
    let pred_result = prediction::predict(&rider_profile, &route, &cfg, &mut knn_model);
    progress(&format!("Predicted: {}", format_duration(pred_result.total_time_s)));

    // Extract actual speed data from validation FIT
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
    let mut actual_riding_s = 0.0_f64;
    for i in 1..val_activity.points.len() {
        if val_activity.points[i].speed_ms > 0.5 {
            let dt = val_activity.points[i].timestamp_s - val_activity.points[i - 1].timestamp_s;
            if dt > 0.0 && dt < 300.0 {
                actual_riding_s += dt;
            }
        }
    }
    if actual_riding_s < 1.0 {
        actual_riding_s = actual_total_time;
    }

    let actual_distance = val_activity.summary.distance_m;
    let actual_avg_speed = if actual_total_time > 0.0 {
        (actual_distance / actual_total_time) * 3.6
    } else {
        0.0
    };

    progress(&format!("Actual: {} (avg {:.1} km/h)", format_duration(actual_total_time), actual_avg_speed));

    let comparison = ComparisonResult {
        prediction: pred_result,
        actual_points,
        actual_total_time_s: actual_total_time,
        actual_riding_time_s: actual_riding_s,
        actual_avg_speed_kmh: actual_avg_speed,
        actual_distance_m: actual_distance,
    };

    serde_wasm_bindgen::to_value(&comparison)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}
