/* tslint:disable */
/* eslint-disable */

export class CopcDecoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * min x, y, z, max x, y, z des points décodés, relatifs à l'origine.
     */
    bounds(): Float64Array;
    /**
     * Décode un chunk et ajoute ses points à la suite des précédents.
     */
    decode(chunk: Uint8Array, point_count: number): void;
    /**
     * Plus grande composante RVB 16 bits lue (0 sans couleur).
     */
    max_rgb(): number;
    /**
     * `local_offset` = décalage de l'en-tête LAS − origine de la tuile.
     */
    constructor(point_format: number, record_length: number, scale: Float64Array, local_offset: Float64Array);
    take_classifications(): Uint8Array;
    /**
     * Octets de poids fort du RVB 16 bits (vide pour le format 6).
     */
    take_colors(): Uint8Array;
    take_intensities(): Uint16Array;
    take_positions(): Float32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_copcdecoder_free: (a: number, b: number) => void;
    readonly copcdecoder_bounds: (a: number, b: number) => void;
    readonly copcdecoder_decode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly copcdecoder_max_rgb: (a: number) => number;
    readonly copcdecoder_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly copcdecoder_take_classifications: (a: number, b: number) => void;
    readonly copcdecoder_take_colors: (a: number, b: number) => void;
    readonly copcdecoder_take_intensities: (a: number, b: number) => void;
    readonly copcdecoder_take_positions: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
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
