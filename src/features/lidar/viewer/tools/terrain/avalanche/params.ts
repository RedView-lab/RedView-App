// ============================================
// LiDAR viewer tools — avalanche terrain model: published parameters
// ============================================
//
// A terrain rating (ATES), not a snow forecast: the result depends on the
// ground, its slopes and its forest only, never on the snowpack or the
// weather, exactly like the Avalanche Terrain Exposure Scale it reproduces.
//
// The chain is AutoATES v2.0 (Toft et al., 2024), run for one point:
//  1. potential release areas (PRA): fuzzy logic of Veitinger et al. (2016)
//     on slope, wind shelter (Plattner et al., 2006) and forest density,
//     combined with the "fuzzy AND" of Werners (1988); roughness left out
//     (needs a snow depth, unsuited to ≥ 5 m grids — Toft et al., 2024 §4.1.4);
//  2. runout: Flow-Py (D'Amboise et al., 2022) — energy line of angle α,
//     Holmgren (1994) multiple-flow routing with persistence, kinetic-energy
//     height zδ, forest friction and detrainment;
//  3. ATES class: slope, runout travel angle and forest criteria of
//     Toft et al. (2024), Tables 1–3.
// Two scenarios as in autoATES v3.0 (Sykes et al., 2026): "typical" (tighter
// release, α 30°) and "infrequent" (wider release, α 18°, large avalanches).
//
// References
//  - Toft, H. B., Sykes, J., Schauer, A., Hendrikx, J., Hetland, A. (2024).
//    AutoATES v2.0: Automated Avalanche Terrain Exposure Scale mapping.
//    NHESS 24, 1779–1793. doi:10.5194/nhess-24-1779-2024
//  - D'Amboise, C. J. L., Neuhauser, M., Teich, M., Huber, A., Kofler, A.,
//    Perzl, F., Fromm, R., Kleemayr, K., Fischer, J.-T. (2022). Flow-Py v1.0.
//    GMD 15, 2423–2439. doi:10.5194/gmd-15-2423-2022
//  - Veitinger, J., Purves, R. S., Sovilla, B. (2016). Potential slab avalanche
//    release area identification from estimated winter terrain. NHESS 16,
//    2211–2225. doi:10.5194/nhess-16-2211-2016
//  - Plattner, C., Braun, L. N., Brenning, A. (2006). The spatial variability of
//    snow accumulation at Vernagtferner. Geogr. Helv. (wind shelter index).
//  - Statham, G., Campbell, C. (2025). The Avalanche Terrain Exposure Scale
//    (ATES) v.2. NHESS 25, 1113–1136. doi:10.5194/nhess-25-1113-2025
//  - Sykes, J., Knies, D., Haegeli, P., Anthony-Malone, K., Statham, G. (2026).
//    AutoATES v3.0: Automated ATES mapping at scale across western Canada. ISSW.
//  - Holmgren, P. (1994). Multiple flow direction algorithms for runoff
//    modelling in grid based elevation models. Hydrol. Process. 8, 327–334.
//  - Werners, B. (1988). Aggregation models in mathematical programming.

/** Cauchy (generalised bell) membership 1 / (1 + ((x − c) / a)^(2b)). */
export interface CauchyParams {
  a: number;
  b: number;
  c: number;
}

export type AvalancheScenarioId = 'typical' | 'infrequent';

export interface AvalancheScenarioParams {
  id: AvalancheScenarioId;
  /** Slope membership of the release-area model (degrees). */
  slope: CauchyParams;
  /** PRA value from which a cell is a potential release area. */
  praThreshold: number;
  /** Runout angle α of the Flow-Py energy line, degrees. */
  alphaDeg: number;
}

/**
 * autoATES v3.0 (ISSW 2026) default scenarios. Typical = frequent avalanches
 * from the most likely start zones; infrequent = the envelope of larger,
 * rarer avalanches, including start zones below 30°.
 */
export const AVALANCHE_SCENARIOS: Readonly<Record<AvalancheScenarioId, AvalancheScenarioParams>> = {
  typical: { id: 'typical', slope: { a: 12, b: 4, c: 42.5 }, praThreshold: 0.25, alphaDeg: 30 },
  infrequent: { id: 'infrequent', slope: { a: 14, b: 4, c: 40 }, praThreshold: 0.05, alphaDeg: 18 },
};

/** Wind shelter membership (Veitinger et al., 2016, as in AutoATES v2.0/v3.0). */
export const WIND_SHELTER_MEMBERSHIP: CauchyParams = { a: 3, b: 10, c: 3 };
/** Search radius of the wind shelter index (Plattner et al., 2006 optimum), m. */
export const WIND_SHELTER_RADIUS_M = 60;
/** Quantile of the upwind angles taken as the index (median, all directions). */
export const WIND_SHELTER_QUANTILE = 0.5;
/** Forest membership on canopy cover 0–100 % (autoATES v3.0, `sen2cc`). */
export const FOREST_MEMBERSHIP: CauchyParams = { a: 50, b: 3, c: 0 };
/** Release areas smaller than this are dropped (autoATES v3.0 sieve), m². */
export const PRA_MIN_AREA_M2 = 1000;

/** Flow-Py routing exponent: lateral spread (8 for snow avalanches). */
export const FLOWPY_EXPONENT = 8;
/** Routing flux below this share is not routed on (limits the spread). */
export const FLOWPY_FLUX_THRESHOLD = 0.003;
/** Cap of the kinetic-energy height zδ (≈ 73 m/s), m. */
export const FLOWPY_MAX_Z_DELTA_M = 270;
/**
 * Forest friction (D'Amboise et al.; Flow-Py and AutoATES v2.0 defaults):
 * α grows by up to `maxAddedDeg`·FSI in forest, at least `minAddedDeg`,
 * fading out as the flow speed reaches `velocityLimit`.
 */
export const FLOWPY_FOREST_FRICTION = { maxAddedDeg: 10, minAddedDeg: 2, velocityLimit: 30 } as const;
/** Forest detrainment of routing flux per cell (AutoATES v2.0 Flow-Py). */
export const FLOWPY_FOREST_DETRAINMENT = { max: 0.0003, min: 0.00001, velocityLimit: 30 } as const;

/** ATES class thresholds of AutoATES v2.0 (Toft et al., 2024, Table 1). */
export const ATES_SLOPE_THRESHOLDS_DEG = { sat01: 15, sat12: 18, sat23: 28, sat34: 39 } as const;
/** Runout travel-angle thresholds (AAT); any infrequent (α 18°) runout is class 1. */
export const ATES_ALPHA_THRESHOLDS_DEG = { aat12: 24, aat23: 33 } as const;
/** Canopy cover classes, % (Toft et al., 2024, Table 2): open / sparse / moderate / dense. */
export const ATES_CANOPY_THRESHOLDS_PCT = { tree1: 20, tree2: 55, tree3: 75 } as const;

/** A return of the high-vegetation class this high above the ground is a tree crown, m. */
export const TREE_MIN_HEIGHT_M = 3;
