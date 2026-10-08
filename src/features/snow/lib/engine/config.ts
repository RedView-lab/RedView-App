// ============================================================================
// Moteur neige v2 — paramètres
// ----------------------------------------------------------------------------
// Chaque valeur par défaut vient d'une valeur publiée ; la référence est à côté.
//
//   Gruber (2007) WRR 43 W06412 — transport et dépôt conservant la masse
//   Bernhardt & Schulz (2010) GRL 37 L11502 — SnowSlide ; hauteur de maintien
//     paramétrée comme dans CHM (3178,4·S^−1,998, Marsh et al. 2020) et évaluée
//     contre la hauteur de neige ALS par Quéno et al. (2024)
//   Quéno et al. (2024) TC 18, 3533 — FSM2trans : SnowSlide + SnowTran-3D contre ALS
//   Grünewald et al. (2013) HESS 17, 3005 — hauteur de neige et terrain (ALS, 7 sites)
//   Grünewald, Bühler & Lehning (2014) TC 8, 2381 — dépendance à l'altitude
//   Helbig et al. (2015) HESS 19, 1339 — σ(HS) et fSCA en terrain complexe
//   Winstral, Elder & Davis (2002) J. Hydrometeor. 3, 524 — indice d'abri Sx
//   Liston & Elder (2006) J. Hydrometeor. 7, 217 — pondération du vent de MicroMet
//   Li & Pomeroy (1997) J. Appl. Meteor. 36, 205 — vent seuil du transport
//   Varhola et al. (2010) J. Hydrol. 392, 219 — couvert forestier, accumulation et ablation
//   Hock (1999) J. Glaciol. 45, 101 — indice de température + rayonnement direct potentiel
//   de Rosnay et al. (2014), ECMWF — interpolation optimale de la hauteur de neige
// ============================================================================

export interface SnowEngineConfig {
  /** Plafond de la grille de travail par axe (le MNT y est ramené par moyenne par blocs). */
  maxResolution: number;

  // ---- Champ grande échelle : profil d'altitude appris sur les cellules grossières ----
  /** Rayon de pondération horizontale des cellules grossières (e-fold gaussien), km. */
  profileRadiusKm: number;
  /** Demi-largeur minimale de la régression locale en altitude, m. */
  profileBandwidthM: number;
  /** Plafond du gradient extrapolé au-dessus / en dessous des cellules, cm par 100 m (Grünewald 2013 : 6 à 25 au cœur de l'hiver). */
  maxGradientCmPer100m: number;
  /** Bornage du rapport cellule / profil porté par le champ résiduel. */
  residualRatioClamp: number;
  /** Décalage de hauteur du résidu en rapport (le garde stable près de la limite de la neige), cm. */
  residualEpsilonCm: number;
  /** Au-delà, les valeurs grossières sont du névé pérenne, pas de la neige saisonnière (ajustement seulement), cm. */
  profileFitCapCm: number;

  // ---- Assimilation des mesures ----
  /** Rayon de recherche des stations de terrain plat, km. */
  stationRadiusKm: number;
  /** Longueur de corrélation horizontale de l'interpolation optimale, km (ECMWF : 55 ; plus court pour une ébauche à 1,3 km dans les Alpes). */
  oiHorizontalKm: number;
  /** Longueur de corrélation verticale de l'interpolation optimale, m (ECMWF : 800). */
  oiVerticalM: number;
  /** Erreur de mesure d'une station, cm (ECMWF : 4). */
  obsErrorCm: number;
  /** Erreur de représentativité d'une station de terrain plat, fraction de sa hauteur. */
  obsRepresentativenessRel: number;
  /** Erreur de l'ébauche (champ grossier descendu en échelle), fraction de sa hauteur. */
  backgroundErrorRel: number;
  /** Plancher de l'erreur d'ébauche, cm. */
  backgroundErrorMinCm: number;
  /** Innovation rejetée au-delà de ce nombre de σ (contrôle de première estimation de l'ECMWF). */
  qcSigma: number;
  /** Erreur des pseudo-observations du BRA : plancher (cm) et fraction de la hauteur. */
  braErrorCm: number;
  braErrorRel: number;
  /** Portée de corrélation des mesures ponctuelles dans la scène, m. */
  pointRangeM: number;
  pointErrorCm: number;

  // ---- Transport par le vent ----
  /** Poids de pente et de courbure de MicroMet γs, γc (Liston & Elder 2006 : 0,5, 0,5). */
  windSlopeWeight: number;
  windCurvatureWeight: number;
  /** Lissage du MNT vu par le vent (rugosité enfouie, écoulement lisse), m. */
  windSmoothM: number;
  /** Poids de l'abri amont (Sx de Winstral) sur la vitesse locale du vent. */
  windShelterWeight: number;
  /** Distance de recherche du Sx, locale / éloignée (Winstral 2002 : 100 m / 1000 m). */
  shelterLocalM: number;
  shelterOutlyingM: number;
  /** Échelles de longueur de la courbure (formes de congères / demi-longueur d'onde crête-vallée), m. */
  curvatureSmallM: number;
  curvatureLargeM: number;
  /** Longueur de relaxation du flux de transport vers la capacité locale de transport, m. */
  saturationLengthM: number;
  /** Part de la neige locale que le vent peut arracher à une cellule. */
  erosionMaxFraction: number;
  /**
   * Flux de transport sur terrain plat dégagé par unité de potentiel de
   * transport Σ(U − Ut)·U² sur l'historique, cm·m par (m/s)³·h. ≈ 4000 cm·m pour
   * une semaine venteuse, l'ordre des flux de saltation + suspension de Pomeroy & Gray.
   */
  windFluxPerTransport: number;
  /** Borne supérieure de la part moyenne de la neige que le vent déplace (Quéno 2024 : −50 % sur les crêtes au vent, +25 % à l'abri). */
  maxWindRedistribution: number;
  /** Part déplacée quand l'historique météo est inconnu. */
  defaultWindRedistribution: number;
  /** Poids de la relation empirique d'exposition face au flux de transport physique (0–1). */
  windStatisticalWeight: number;
  /** Direction par défaut d'où souffle le vent porteur de neige, degrés vrais (NO : Alpes, Pyrénées). */
  defaultWindFromDeg: number;

  // ---- Transport gravitaire (SnowSlide) ----
  /**
   * Vertical holding depth h = mult·S^pow, m, S in degrees: CHM's curve, the
   * one evaluated against ALS snow-depth maps (Quéno et al. 2024; the original
   * snowslide.f 45538·S^−2.982 strips steep terrain far more). 3.5 m at 30°,
   * 2.0 m at 40°, 1.3 m at 50°, 0.9 m at 60°.
   */
  holdingMult: number;
  holdingPow: number;
  /** Sous cette pente, la neige ne glisse jamais (Bernhardt & Schulz : 25°). */
  triggerSlopeDeg: number;
  /**
   * Échelle de la pente à laquelle la hauteur de maintien est lue, m. Les courbes
   * ont été calibrées sur des grilles de 25 à 30 m ; lues au pixel LiDAR, les
   * ressauts rocheux et les blocs (enfouis sous la neige) feraient glisser
   * l'essentiel du manteau.
   */
  gravitySlopeScaleM: number;
  /** Facteur de hauteur de maintien d'une cellule frappée par autant de neige glissante qu'elle en retient (Quéno 2024 : −30 %). */
  holdingReceiveFactor: number;
  /** Angle d'arrêt α de la ligne d'énergie, degrés (AutoATES / Flow-Py : 30° pour les avalanches fréquentes). */
  runoutAlphaDeg: number;
  /** Dépôt d'arrêt par cellule et par passe : Dmax·(1 − S/Slim) (forme de Gruber 2007), cm et degrés. */
  depositMaxCm: number;
  depositLimitDeg: number;
  /** Angle de repos des débris d'avalanche, degrés (les cônes de dépôt s'y affaissent ; sous la pente de déclenchement, pour qu'un cône ne reparte pas). */
  debrisReposeDeg: number;
  gravityPasses: number;

  // ---- Forêt (Varhola 2010 : ΔAcc = −0,396·FC, ΔAbl = −0,536·FC) ----
  forestAccumulationSlope: number;
  forestAblationSlope: number;

  // ---- Fonte (indice de température de Hock 1999 avec rayonnement direct potentiel) ----
  /** Melt factor, mm w.e. d⁻¹ °C⁻¹. */
  meltFactor: number;
  /** Facteur de rayonnement de la neige, mm é.e. m² W⁻¹ j⁻¹ °C⁻¹ (0,5·10⁻³ par heure). */
  radiationFactor: number;
  /** Gradient vertical de température de l'air, °C m⁻¹. */
  lapseRate: number;
  /** Transmissivité atmosphérique par ciel clair. */
  transmissivity: number;
  /** Les précipitations sont entièrement de la neige en dessous / entièrement de la pluie au-dessus, °C. */
  snowTempC: number;
  rainTempC: number;

  // ---- Sub-grid variability (Helbig 2015: σ = HS^a·μ^b·exp(−(ξ/L)²), m) ----
  helbigA: number;
  helbigB: number;
  /**
   * Le σ de Helbig est un plafond : quand la scène sort plus variable, l'amplitude
   * du vent est abaissée, jusqu'à cette part de son estimation physique.
   */
  windAmplitudeMin: number;

  /** Lissage gaussien final, pixels de travail (0 = désactivé). */
  finalSmoothSigmaPx: number;
  /** Plafond de la sortie, cm. */
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
