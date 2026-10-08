// ============================================
// Outils du viewer LiDAR — modèle de terrain avalancheux : paramètres publiés
// ============================================
//
// Une note du terrain (ATES), pas une prévision nivologique : le résultat ne
// dépend que du sol, de ses pentes et de sa forêt, jamais du manteau neigeux ni
// de la météo, exactement comme l'Avalanche Terrain Exposure Scale qu'il reproduit.
//
// La chaîne est AutoATES v2.0 (Toft et al., 2024), lancée pour un point :
//  1. zones de départ potentielles (PRA) : logique floue de Veitinger et al.
//     (2016) sur la pente, l'abri au vent (Plattner et al., 2006) et la densité
//     de forêt, combinées par le « ET flou » de Werners (1988) ; rugosité
//     écartée (elle demande une hauteur de neige, inadaptée aux grilles ≥ 5 m —
//     Toft et al., 2024 §4.1.4) ;
//  2. écoulement : Flow-Py (D'Amboise et al., 2022) — ligne d'énergie d'angle α,
//     acheminement multidirectionnel de Holmgren (1994) avec persistance,
//     hauteur d'énergie cinétique zδ, frottement et détraînement en forêt ;
//  3. classe ATES : critères de pente, d'angle de parcours de l'écoulement et
//     de forêt de Toft et al. (2024), tableaux 1–3.
// Deux scénarios comme dans autoATES v3.0 (Sykes et al., 2026) : « typique »
// (départ plus resserré, α 30°) et « peu fréquent » (départ plus large, α 18°,
// grandes avalanches).
//
// Références
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
//    snow accumulation at Vernagtferner. Geogr. Helv. (indice d'abri au vent).
//  - Statham, G., Campbell, C. (2025). The Avalanche Terrain Exposure Scale
//    (ATES) v.2. NHESS 25, 1113–1136. doi:10.5194/nhess-25-1113-2025
//  - Sykes, J., Knies, D., Haegeli, P., Anthony-Malone, K., Statham, G. (2026).
//    AutoATES v3.0: Automated ATES mapping at scale across western Canada. ISSW.
//  - Holmgren, P. (1994). Multiple flow direction algorithms for runoff
//    modelling in grid based elevation models. Hydrol. Process. 8, 327–334.
//  - Werners, B. (1988). Aggregation models in mathematical programming.

/** Appartenance de Cauchy (cloche généralisée) 1 / (1 + ((x − c) / a)^(2b)). */
export interface CauchyParams {
  a: number;
  b: number;
  c: number;
}

export type AvalancheScenarioId = 'typical' | 'infrequent';

export interface AvalancheScenarioParams {
  id: AvalancheScenarioId;
  /** Appartenance de pente du modèle de zone de départ (degrés). */
  slope: CauchyParams;
  /** Valeur PRA à partir de laquelle une cellule est une zone de départ potentielle. */
  praThreshold: number;
  /** Angle d'arrêt α de la ligne d'énergie de Flow-Py, degrés. */
  alphaDeg: number;
}

/**
 * Scénarios par défaut d'autoATES v3.0 (ISSW 2026). Typique = avalanches
 * fréquentes depuis les zones de départ les plus probables ; peu fréquent =
 * l'enveloppe des avalanches plus grandes et plus rares, y compris des zones
 * de départ sous 30°.
 */
export const AVALANCHE_SCENARIOS: Readonly<Record<AvalancheScenarioId, AvalancheScenarioParams>> = {
  typical: { id: 'typical', slope: { a: 12, b: 4, c: 42.5 }, praThreshold: 0.25, alphaDeg: 30 },
  infrequent: { id: 'infrequent', slope: { a: 14, b: 4, c: 40 }, praThreshold: 0.05, alphaDeg: 18 },
};

/** Wind shelter membership (Veitinger et al., 2016, as in AutoATES v2.0/v3.0). */
export const WIND_SHELTER_MEMBERSHIP: CauchyParams = { a: 3, b: 10, c: 3 };
/** Rayon de recherche de l'indice d'abri au vent (optimum de Plattner et al., 2006), m. */
export const WIND_SHELTER_RADIUS_M = 60;
/** Quantile des angles au vent retenu comme indice (médiane, toutes directions). */
export const WIND_SHELTER_QUANTILE = 0.5;
/** Forest membership on canopy cover 0–100 % (autoATES v3.0, `sen2cc`). */
export const FOREST_MEMBERSHIP: CauchyParams = { a: 50, b: 3, c: 0 };
/** Les zones de départ plus petites que ceci sont écartées (tamis d'autoATES v3.0), m². */
export const PRA_MIN_AREA_M2 = 1000;

/** Exposant d'acheminement de Flow-Py : étalement latéral (8 pour les avalanches de neige). */
export const FLOWPY_EXPONENT = 8;
/** Le flux d'acheminement sous cette part n'est pas acheminé plus loin (limite l'étalement). */
export const FLOWPY_FLUX_THRESHOLD = 0.003;
/** Plafond de la hauteur d'énergie cinétique zδ (≈ 73 m/s), m. */
export const FLOWPY_MAX_Z_DELTA_M = 270;
/**
 * Frottement en forêt (D'Amboise et al. ; valeurs par défaut de Flow-Py et
 * d'AutoATES v2.0) : α augmente jusqu'à `maxAddedDeg`·FSI en forêt, d'au moins
 * `minAddedDeg`, en s'estompant à mesure que la vitesse de l'écoulement atteint `velocityLimit`.
 */
export const FLOWPY_FOREST_FRICTION = { maxAddedDeg: 10, minAddedDeg: 2, velocityLimit: 30 } as const;
/** Détraînement en forêt du flux d'acheminement par cellule (Flow-Py d'AutoATES v2.0). */
export const FLOWPY_FOREST_DETRAINMENT = { max: 0.0003, min: 0.00001, velocityLimit: 30 } as const;

/** ATES class thresholds of AutoATES v2.0 (Toft et al., 2024, Table 1). */
export const ATES_SLOPE_THRESHOLDS_DEG = { sat01: 15, sat12: 18, sat23: 28, sat34: 39 } as const;
/** Seuils d'angle de parcours de l'écoulement (AAT) ; tout écoulement peu fréquent (α 18°) est de classe 1. */
export const ATES_ALPHA_THRESHOLDS_DEG = { aat12: 24, aat23: 33 } as const;
/** Canopy cover classes, % (Toft et al., 2024, Table 2): open / sparse / moderate / dense. */
export const ATES_CANOPY_THRESHOLDS_PCT = { tree1: 20, tree2: 55, tree3: 75 } as const;

/** Un retour de la classe haute végétation à cette hauteur au-dessus du sol est une couronne d'arbre, m. */
export const TREE_MIN_HEIGHT_M = 3;
