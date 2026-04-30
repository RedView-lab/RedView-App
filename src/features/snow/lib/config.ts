// ============================================================================
// Snow redistribution config
// ----------------------------------------------------------------------------
// Port direct de RedView v0.1: crates/redview-scene/.../snow/config.rs
// Tous les paramètres ont des défauts physiquement motivés (Alpes).
// ============================================================================

export interface SnowRedistributionConfig {
  // ---- Gravitational transport (SnowSlide) ----
  /** Angle de friction interne du manteau (°). 35–45 frais, 50–60 tassé. */
  frictionAngleDeg: number;
  /** Holding depth de référence sur terrain plat (cm). */
  holdingDepthRefCm: number;
  /** Itérations de routing gravitationnel. */
  gravityIterations: number;

  // ---- Régression terrain ----
  /** Gradient orographique (frac/σ), ex 0.07 = +7% par σ d'altitude. */
  precipitationGradient: number;
  /** Force aspect (N/S). */
  aspectStrength: number;
  /** Force courbure plan. */
  curvatureStrength: number;
  /** Force TPI. */
  tpiStrength: number;
  /** Force flow accumulation D-inf. */
  flowAccumulationStrength: number;
  /** Force radiation solaire. */
  solarRadiationStrength: number;
  /** Force courbure profil. */
  profileCurvatureStrength: number;
  /** Force ancrage rugosité (TRI). */
  roughnessAnchoringStrength: number;
  /** Force cold-air pooling. */
  coldPoolStrength: number;

  // ---- Wind transport (Winstral Sx) ----
  /** Direction vent dominant (0=N, 90=E, 180=S, 270=W). */
  windDirectionDeg: number;
  /** Force transport éolien. */
  windStrength: number;

  // ---- Processing ----
  /** Résolution max de travail par axe. Heightmap downsamplée si plus grande. */
  maxResolution: number;
  /** Sigma du smoothing gaussien final (px). 0 = désactivé. */
  finalSmoothSigma: number;
}

export const DEFAULT_SNOW_CONFIG: SnowRedistributionConfig = {
  frictionAngleDeg: 40.0,
  holdingDepthRefCm: 400.0,
  gravityIterations: 25,
  precipitationGradient: 0.07,
  aspectStrength: 0.20,
  curvatureStrength: 0.30,
  tpiStrength: 0.30,
  flowAccumulationStrength: 0.15,
  solarRadiationStrength: 0.18,
  profileCurvatureStrength: 0.20,
  roughnessAnchoringStrength: 0.12,
  coldPoolStrength: 0.10,
  windDirectionDeg: 315.0, // NW (Alpes)
  windStrength: 0.15,
  maxResolution: 512, // Tuile 1km LiDAR → ~2m/px à 512
  finalSmoothSigma: 2.0,
};
