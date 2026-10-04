// ============================================================================
// Snow engine v2 — parameters
// ----------------------------------------------------------------------------
// Every default comes from a published value; the reference sits next to it.
//
//   Gruber (2007) WRR 43 W06412 — mass-conserving transport and deposition
//   Bernhardt & Schulz (2010) GRL 37 L11502 — SnowSlide; holding depth as
//     parameterised in CHM (3178.4·S^−1.998, Marsh et al. 2020) and evaluated
//     against ALS snow depth by Quéno et al. (2024)
//   Quéno et al. (2024) TC 18, 3533 — FSM2trans: SnowSlide + SnowTran-3D vs ALS
//   Grünewald et al. (2013) HESS 17, 3005 — snow depth vs terrain (ALS, 7 sites)
//   Grünewald, Bühler & Lehning (2014) TC 8, 2381 — elevation dependency
//   Helbig et al. (2015) HESS 19, 1339 — σ(HS) and fSCA over complex terrain
//   Winstral, Elder & Davis (2002) J. Hydrometeor. 3, 524 — Sx shelter index
//   Liston & Elder (2006) J. Hydrometeor. 7, 217 — MicroMet wind weighting
//   Li & Pomeroy (1997) J. Appl. Meteor. 36, 205 — threshold wind for transport
//   Varhola et al. (2010) J. Hydrol. 392, 219 — forest cover vs accumulation/ablation
//   Hock (1999) J. Glaciol. 45, 101 — temperature index + potential direct radiation
//   de Rosnay et al. (2014), ECMWF — snow depth optimal interpolation
// ============================================================================

export interface SnowEngineConfig {
  /** Work grid cap per axis (the DTM is box-averaged down to it). */
  maxResolution: number;

  // ---- Large-scale field: elevation profile learnt from the coarse cells ----
  /** Horizontal weighting radius of the coarse cells (Gaussian e-fold), km. */
  profileRadiusKm: number;
  /** Minimum half-width of the local regression in altitude, m. */
  profileBandwidthM: number;
  /** Cap on the extrapolated gradient above/below the cells, cm per 100 m (Grünewald 2013: 6–25 at peak of winter). */
  maxGradientCmPer100m: number;
  /** Clamp of the cell-to-profile ratio carried by the residual field. */
  residualRatioClamp: number;
  /** Depth offset of the ratio residual (keeps it stable near the snow line), cm. */
  residualEpsilonCm: number;
  /** Coarse values above this are perennial firn, not seasonal snow (fit only), cm. */
  profileFitCapCm: number;

  // ---- Assimilation of measurements ----
  /** Search radius for flat-field stations, km. */
  stationRadiusKm: number;
  /** OI horizontal correlation length, km (ECMWF: 55; shorter for a 1.3 km background in the Alps). */
  oiHorizontalKm: number;
  /** OI vertical correlation length, m (ECMWF: 800). */
  oiVerticalM: number;
  /** Station measurement error, cm (ECMWF: 4). */
  obsErrorCm: number;
  /** Representativeness error of a flat-field station, fraction of its depth. */
  obsRepresentativenessRel: number;
  /** Background (downscaled coarse field) error, fraction of its depth. */
  backgroundErrorRel: number;
  /** Background error floor, cm. */
  backgroundErrorMinCm: number;
  /** Innovation rejected beyond this many σ (ECMWF first-guess check). */
  qcSigma: number;
  /** BRA pseudo-observation error: floor (cm) and fraction of depth. */
  braErrorCm: number;
  braErrorRel: number;
  /** Correlation range of in-scene point measurements, m. */
  pointRangeM: number;
  pointErrorCm: number;

  // ---- Wind transport ----
  /** MicroMet slope and curvature weights γs, γc (Liston & Elder 2006: 0.5, 0.5). */
  windSlopeWeight: number;
  windCurvatureWeight: number;
  /** Smoothing of the DTM seen by the wind (buried roughness, smooth flow), m. */
  windSmoothM: number;
  /** Weight of the upwind shelter (Winstral Sx) on the local wind speed. */
  windShelterWeight: number;
  /** Sx search distance, local / outlying (Winstral 2002: 100 m / 1000 m). */
  shelterLocalM: number;
  shelterOutlyingM: number;
  /** Curvature length scales (drift features / ridge-valley half-wavelength), m. */
  curvatureSmallM: number;
  curvatureLargeM: number;
  /** Relaxation length of the drift flux towards the local transport capacity, m. */
  saturationLengthM: number;
  /** Share of the local snow the wind can strip from a cell. */
  erosionMaxFraction: number;
  /**
   * Drift flux on open flat terrain per unit of transport potential
   * Σ(U − Ut)·U² over the history, cm·m per (m/s)³·h. ≈ 4000 cm·m for a windy
   * week, the order of Pomeroy & Gray's saltation + suspension fluxes.
   */
  windFluxPerTransport: number;
  /** Upper bound of the mean share of the snow the wind moves (Quéno 2024: −50 % on windward ridges, +25 % in shelter). */
  maxWindRedistribution: number;
  /** Share moved when the weather history is unknown. */
  defaultWindRedistribution: number;
  /** Weight of the empirical exposure relation against the physical drift flux (0–1). */
  windStatisticalWeight: number;
  /** Default direction the snow-bearing wind blows from, deg true (NW: Alps, Pyrenees). */
  defaultWindFromDeg: number;

  // ---- Gravitational transport (SnowSlide) ----
  /**
   * Vertical holding depth h = mult·S^pow, m, S in degrees: CHM's curve, the
   * one evaluated against ALS snow-depth maps (Quéno et al. 2024; the original
   * snowslide.f 45538·S^−2.982 strips steep terrain far more). 3.5 m at 30°,
   * 2.0 m at 40°, 1.3 m at 50°, 0.9 m at 60°.
   */
  holdingMult: number;
  holdingPow: number;
  /** Slopes below this never shed snow (Bernhardt & Schulz: 25°). */
  triggerSlopeDeg: number;
  /**
   * Scale of the slope the holding depth is read at, m. The curves were
   * calibrated on 25–30 m grids; read at the LiDAR pixel, rock steps and
   * boulders (buried by the snow) would shed most of the pack.
   */
  gravitySlopeScaleM: number;
  /** Holding depth factor of a cell hit by as much sliding snow as it holds (Quéno 2024: −30 %). */
  holdingReceiveFactor: number;
  /** Runout angle α of the energy line, degrees (AutoATES/Flow-Py: 30° for frequent avalanches). */
  runoutAlphaDeg: number;
  /** Runout deposition per cell and pass: Dmax·(1 − S/Slim) (Gruber 2007 form), cm and degrees. */
  depositMaxCm: number;
  depositLimitDeg: number;
  /** Angle of repose of avalanche debris, degrees (deposit cones slump to it; below the trigger slope so a cone does not release again). */
  debrisReposeDeg: number;
  gravityPasses: number;

  // ---- Forest (Varhola 2010: ΔAcc = −0.396·FC, ΔAbl = −0.536·FC) ----
  forestAccumulationSlope: number;
  forestAblationSlope: number;

  // ---- Melt (Hock 1999 temperature index with potential direct radiation) ----
  /** Melt factor, mm w.e. d⁻¹ °C⁻¹. */
  meltFactor: number;
  /** Radiation factor for snow, mm w.e. m² W⁻¹ d⁻¹ °C⁻¹ (0.5·10⁻³ per hour). */
  radiationFactor: number;
  /** Air temperature lapse rate, °C m⁻¹. */
  lapseRate: number;
  /** Clear-sky atmospheric transmissivity. */
  transmissivity: number;
  /** Precipitation is all snow below / all rain above, °C. */
  snowTempC: number;
  rainTempC: number;

  // ---- Sub-grid variability (Helbig 2015: σ = HS^a·μ^b·exp(−(ξ/L)²), m) ----
  helbigA: number;
  helbigB: number;
  /**
   * Helbig's σ is a ceiling: when the scene comes out more variable, the wind
   * amplitude is lowered, down to this share of its physical estimate.
   */
  windAmplitudeMin: number;

  /** Final Gaussian smoothing, work pixels (0 = off). */
  finalSmoothSigmaPx: number;
  /** Output cap, cm. */
  maxDepthCm: number;
}

export const DEFAULT_SNOW_ENGINE_CONFIG: SnowEngineConfig = {
  maxResolution: 640,

  profileRadiusKm: 12,
  profileBandwidthM: 250,
  maxGradientCmPer100m: 30,
  residualRatioClamp: 2.5,
  residualEpsilonCm: 15,
  profileFitCapCm: 600,

  stationRadiusKm: 60,
  oiHorizontalKm: 30,
  oiVerticalM: 600,
  obsErrorCm: 4,
  obsRepresentativenessRel: 0.1,
  backgroundErrorRel: 0.35,
  backgroundErrorMinCm: 8,
  qcSigma: 4,
  braErrorCm: 12,
  braErrorRel: 0.2,
  pointRangeM: 60,
  pointErrorCm: 5,

  windSlopeWeight: 0.5,
  windCurvatureWeight: 0.5,
  windSmoothM: 10,
  windShelterWeight: 0.4,
  shelterLocalM: 100,
  shelterOutlyingM: 1000,
  curvatureSmallM: 15,
  curvatureLargeM: 150,
  saturationLengthM: 120,
  erosionMaxFraction: 0.9,
  windFluxPerTransport: 0.13,
  maxWindRedistribution: 0.4,
  defaultWindRedistribution: 0.12,
  windStatisticalWeight: 0.5,
  defaultWindFromDeg: 300,

  holdingMult: 3178.4,
  holdingPow: -1.998,
  triggerSlopeDeg: 25,
  gravitySlopeScaleM: 30,
  holdingReceiveFactor: 0.7,
  runoutAlphaDeg: 30,
  depositMaxCm: 200,
  depositLimitDeg: 40,
  debrisReposeDeg: 24,
  gravityPasses: 2,

  forestAccumulationSlope: 0.396,
  forestAblationSlope: 0.536,

  meltFactor: 1.8,
  radiationFactor: 0.012,
  lapseRate: -0.0065,
  transmissivity: 0.75,
  snowTempC: 0,
  rainTempC: 2,

  helbigA: 0.549,
  helbigB: 0.309,
  windAmplitudeMin: 0.4,

  finalSmoothSigmaPx: 0.7,
  maxDepthCm: 1200,
};
