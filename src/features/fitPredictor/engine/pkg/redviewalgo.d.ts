/* tslint:disable */
/* eslint-disable */

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
 * Run prediction on a validation FIT file and compare with actual data.
 *
 * The validation FIT is NOT included in the training data for the model.
 * This allows direct comparison of predicted vs actual speed.
 */
export function predict_vs_actual(training_fits: Uint8Array[], validation_fit: Uint8Array, config: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly predict: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
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
