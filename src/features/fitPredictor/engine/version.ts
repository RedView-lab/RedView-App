/**
 * Version du moteur vélo (doit égaler `engine_version()` du WASM, vérifié par
 * le banc script-test-bench/pace-accuracy). Une prédiction vélo persistée sans
 * version ou d'une version inférieure est recalculée à l'ouverture.
 */
export const CYCLING_ENGINE_VERSION = 4;
