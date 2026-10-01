/* tslint:disable */
/* eslint-disable */

/**
 * Calibration vélo v2 sur les .fit d'un cycliste.
 *
 * `config` : `CyclingConfig` dont `rider` sert de prior (préréglage ou
 * profil personnalisé : masse, pneus, FTP) et `model_params` éventuels.
 * Renvoie `{ engine_version, model, report }` ; `model` se passe ensuite à
 * `predict_cycling` via `{ rider: { model } }`.
 */
export function calibrate_cycling(fit_files: Uint8Array[], config: any, on_progress?: Function | null): any;

/**
 * Calibration vélo v2 sur des traces déjà extraites (banc de mesure, traces
 * étiquetées OSM) : `tracks` = `[{ lat, lon, ele, dist, t, surface?, way? }]`.
 */
export function calibrate_cycling_tracks(tracks: any, config: any): any;

/**
 * Version du moteur vélo (v2) : les prédictions persistées plus anciennes
 * doivent être recalculées.
 */
export function engine_version(): number;

/**
 * Initialize panic hook for better error messages in the browser console.
 */
export function init(): void;

/**
 * Main prediction function.
 *
 * # Arguments
 * * `fit_files` - Array of FIT file contents as `Uint8Array`
 * * `gpx_data` - GPX file content as `Uint8Array`
 * * `config`   - JSON config object `{ mass_kg?, cda?, crr?, pacing_factor? }`
 *
 * # Returns
 * A JS object (serialised `PredictionResult`) containing:
 * - `total_time_s`, `total_distance_m`, `avg_speed_kmh`
 * - `segments` — array of segment summaries
 * - `points`   — point-by-point predictions (for graphs)
 * - `rider_profile` — detected rider stats
 */
export function predict(fit_files: Uint8Array[], gpx_data: Uint8Array, config: any, on_progress?: Function | null): any;

/**
 * Prédiction vélo v2 sur un tracé passé en tableaux typés.
 *
 * * `lat`, `lon` — degrés ; `ele` — mètres (NaN = inconnue)
 * * `dist_m` — axe de distance de l'app (vide = haversine)
 * * `surface`, `way` — attributs par point (voir `cycling::input`), vides = inconnus
 * * `headwind_ms` — vent de face par point (vide = pas de vent)
 * * `config` — `CyclingConfig` : `{ rider, rider_override?,
 *   ambient_temperature_c?, geometry?, model_params?, output? }` (temps de
 *   déplacement seul : ni pauses ni heure de départ)
 */
export function predict_cycling(lat: Float64Array, lon: Float64Array, ele: Float64Array, dist_m: Float64Array, surface: Uint8Array, way: Uint8Array, headwind_ms: Float64Array, config: any): any;

/**
 * Running / trail-running prediction.
 *
 * Same inputs as [`predict`]; `config` is a `RunPredictionConfig`
 * `{ discipline: "running"|"trail", level?, vma_kmh?, ref_distance_m?,
 * ref_time_s?, mass_kg?, technicality?, start_time_h?, gender?, max_route_points? }`.
 * FIT files recorded as cycling are ignored.
 */
export function predict_run(fit_files: Uint8Array[], gpx_data: Uint8Array, config: any, on_progress?: Function | null): any;

/**
 * Prédit une sortie de validation (sa propre trace) avec un modèle calibré
 * sur les seules sorties d'entraînement, et renvoie le réel pour comparaison.
 */
export function predict_vs_actual(training_fits: Uint8Array[], validation_fit: Uint8Array, config: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly calibrate_cycling: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly calibrate_cycling_tracks: (a: number, b: number, c: number) => void;
    readonly engine_version: () => number;
    readonly predict: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly predict_cycling: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => void;
    readonly predict_run: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly predict_vs_actual: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly init: () => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
