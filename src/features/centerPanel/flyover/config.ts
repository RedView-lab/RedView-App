/**
 * Réglages du flyover. Toutes les durées sont en secondes de lecture à 1×,
 * les distances en mètres, les angles en degrés sauf mention contraire.
 *
 * Repères de confort : la « règle des 7 s » de la prise de vue (une largeur
 * d'image traversée en ≥ 7 s à 24 i/s, environ deux fois plus vite toléré à
 * 60 i/s) donne, pour le champ horizontal Mapbox (~62° en 16:9), une
 * rotation de cap d'au plus ~14°/s.
 */

/** Paliers de vitesse de la barre d'outils (× la vitesse cinématique de base). */
export const FLYOVER_SPEED_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;
export const FLYOVER_DEFAULT_SPEED_INDEX = 2;

/* ── Durée de lecture à 1× : 22 s · √(L / 10 km), bornée ─────────────────── */
export const DURATION_REFERENCE_S = 22;
export const DURATION_REFERENCE_KM = 10;
export const DURATION_MIN_S = 15;
export const DURATION_MAX_S = 240;

/* ── Rail (pré-calcul) ───────────────────────────────────────────────────── */
/**
 * Pas du ré-échantillonnage : L / 12 000, borné à [5, 60] m. La caméra n'est
 * jamais à moins de 350 m (et à plusieurs km sur un long parcours) ; la tête
 * suit la trace d'origine, pas le rail.
 */
export const RAIL_TARGET_SAMPLES = 12_000;
export const RAIL_SPACING_MIN_M = 5;
export const RAIL_SPACING_MAX_M = 60;
/** Passes de l'itération point fixe vitesse ↔ distance caméra ↔ cap. */
export const RAIL_FIXED_POINT_PASSES = 2;

/* ── Distance caméra ↔ vitesse : flux d'image constant ───────────────────── */
/** D = REF · (v / REF_SPEED)^EXPONENT, borné. */
export const CAMERA_DISTANCE_REFERENCE_M = 1_000;
export const CAMERA_DISTANCE_REFERENCE_SPEED_MPS = 250;
export const CAMERA_DISTANCE_SPEED_EXPONENT = 0.75;
export const CAMERA_DISTANCE_MIN_M = 350;
export const CAMERA_DISTANCE_MAX_M = 30_000;

/* ── Cadrage ─────────────────────────────────────────────────────────────── */
/** Lissage de la ligne visée (σ, en fraction de la distance caméra). */
export const CENTERLINE_SMOOTHING_PER_DISTANCE = 0.5;
/** Écart latéral max tête ↔ ligne visée (fraction de la distance caméra) : la tête reste cadrée. */
export const CENTERLINE_MAX_OFFSET_PER_DISTANCE = 0.2;
/** Point visé en avance sur la tête (fraction de la distance caméra) : tête vers ~68 % de la hauteur. */
export const TARGET_LEAD_PER_DISTANCE = 0.2;
/** Lissage de l'altitude du profil utilisée pour viser (σ, fraction de la distance caméra). */
export const ELEVATION_SMOOTHING_PER_DISTANCE = 0.25;

/* ── Cap ─────────────────────────────────────────────────────────────────── */
export const HEADING_MAX_RATE_DEG_S = 14;
/** Lissage à phase nulle du cap (σ, secondes de lecture) sur une trace rectiligne. */
export const HEADING_SMOOTHING_S = 1.2;
/**
 * Rectitude de la trace (|moyenne des tangentes| sur ± 1,5 distance caméra) :
 * le lissage du cap est divisé par son carré. Lacets → la caméra suit l'axe
 * de la montée ; boucles serrées (piste) → cap tenu au lieu de tourner à
 * chaque tour. Plancher : lissage au plus ×100.
 */
export const STRAIGHTNESS_WINDOW_PER_DISTANCE = 1.5;
export const STRAIGHTNESS_MIN = 0.1;
/**
 * Confiance du cap = norme du vecteur de direction lissé. En dessous de ce
 * seuil la rotation permise décroît (boucles serrées : cap tenu, pas de
 * toupie) ; jamais sous HEADING_MIN_RATE_RATIO de la rotation max.
 */
export const HEADING_CONFIDENCE_FULL = 0.35;
export const HEADING_MIN_RATE_RATIO = 0.05;
/** Second lissage après limitation de vitesse angulaire (adoucit l'accélération angulaire). */
export const HEADING_POST_SMOOTHING_S = 0.6;
/** Le plafond de vitesse vise cette fraction de la rotation max : le limiteur n'est qu'un filet. */
export const HEADING_TARGET_RATE_RATIO = 0.8;

/* ── Courbe de vitesse ───────────────────────────────────────────────────── */
/** Fenêtre de mesure de la sinuosité et de la pente (multiple de la distance caméra). */
export const INTEREST_WINDOW_PER_DISTANCE = 3;
export const INTEREST_TORTUOSITY_WEIGHT = 0.8;
export const INTEREST_TORTUOSITY_CAP = 2;
export const INTEREST_GRADE_WEIGHT = 1;
/** Pente nette (fraction) qui vaut un point d'intérêt. */
export const INTEREST_GRADE_REFERENCE = 0.08;
export const INTEREST_GRADE_CAP = 1.5;
/** Contraste max entre la vitesse la plus rapide et la plus lente (hors plafond de rotation). */
export const SPEED_CONTRAST_MAX = 2.8;
/** Une vitesse ne double (ou ne se divise par deux) pas en moins de ce temps. */
export const SPEED_DOUBLING_MIN_S = 1.5;

/* ── Inclinaison ─────────────────────────────────────────────────────────── */
export const PITCH_NEAR_DEG = 63;
export const PITCH_NEAR_DISTANCE_M = 600;
export const PITCH_FAR_DEG = 55;
export const PITCH_FAR_DISTANCE_M = 12_000;
/** Inclinaison retirée en relief marqué (vue plus plongeante). */
export const PITCH_RELIEF_DEG = 6;
/** Relief (écart-type d'altitude × 4 / distance caméra) où la correction commence / est pleine. */
export const PITCH_RELIEF_START = 0.04;
export const PITCH_RELIEF_FULL = 0.25;
export const PITCH_SMOOTHING_S = 2;
export const PITCH_MIN_DEG = 45;
export const PITCH_MAX_DEG = 70;

/* ── Transport ───────────────────────────────────────────────────────────── */
export const EASE_IN_START_S = 1.4;
export const EASE_IN_RESUME_S = 0.8;
export const PAUSE_DECELERATION_S = 0.4;
/** Freinage d'arrivée (accélération nulle aux deux bouts, tombe exactement sur la fin). */
export const ARRIVAL_BRAKING_S = 2.4;
/** Demi-vie du ressort qui suit le palier de vitesse choisi. */
export const SPEED_SPRING_HALF_LIFE_S = 0.25;
/**
 * Fondu du cap lors d'un changement de palier de vitesse : au moins cette
 * durée, allongée pour que l'écart s'efface à moins de 40 % de la rotation max.
 */
export const HEADING_TRACK_BLEND_S = 0.8;
export const HEADING_TRACK_BLEND_RATE_RATIO = 0.4;
/** Pas de temps max par frame (onglet en arrière-plan, gel du thread). */
export const MAX_FRAME_DT_S = 0.05;

/* ── Approche (Play, seek, reprise) ──────────────────────────────────────── */
export const APPROACH_MIN_MS = 1_200;
export const APPROACH_MAX_MS = 3_200;
/** Vitesse de survol au sens de van Wijk & Nuij (largeurs d'écran / s), comme `flyTo`. */
export const APPROACH_SPEED = 1.2;
export const APPROACH_CURVE = 1.42;
/** Raccord FreeCamera entre la fin de l'approche et le rail. */
export const HANDOFF_S = 0.5;
/** Caméra déjà « sur » la pose : écart de position (fraction de la distance) et d'angles. */
export const HANDOFF_POSITION_TOLERANCE = 0.03;
export const HANDOFF_ANGLE_TOLERANCE_DEG = 2;

/* ── Garde-relief ────────────────────────────────────────────────────────── */
/** Fractions du segment œil → tête où le relief est échantillonné. */
export const GUARD_SAMPLE_FRACTIONS = [0.15, 0.3, 0.5, 0.7, 0.85] as const;
export const GUARD_SIGHT_MARGIN_M = 15;
export const GUARD_SIGHT_MARGIN_PER_DISTANCE = 0.02;
export const GUARD_EYE_CLEARANCE_M = 30;
export const GUARD_EYE_CLEARANCE_PER_DISTANCE = 0.08;
/** Relèvement : monte vite, redescend lentement (pas de pompage). */
export const GUARD_RISE_HALF_LIFE_S = 0.25;
export const GUARD_FALL_HALF_LIFE_S = 1.5;
/** Repli quand l'altitude n'est pas connue : ressort sur le relief rendu à la cible. */
export const FALLBACK_ELEVATION_HALF_LIFE_S = 0.4;

/* ── Arrivée ─────────────────────────────────────────────────────────────── */
export const ARRIVAL_HOLD_S = 0.6;
export const OVERVIEW_DURATION_MS = 2_600;
export const OVERVIEW_PITCH_DEG = 40;
export const OVERVIEW_PADDING_RATIO = 0.12;

/* ── Diffusion vers React ────────────────────────────────────────────────── */
export const CURSOR_EMIT_INTERVAL_MS = 33;
export const STATUS_EMIT_INTERVAL_MS = 250;
/** Vérification périodique du contexte d'élévation des couches (exagération, qualité DEM). */
export const LAYER_CONTEXT_CHECK_INTERVAL_MS = 1_000;

/* ── Objectif ────────────────────────────────────────────────────────── */
/** Champ vertical par défaut de Mapbox. */
export const MAPBOX_DEFAULT_FOV_DEG = 36.87;
/**
 * Champ vertical pendant la lecture : un peu plus large, la caméra se
 * rapproche d'autant (même cadrage, même niveau de détail des tuiles) et la
 * perspective du relief se creuse. Mapbox le borne à 60°.
 */
export const FLYOVER_FOV_DEG = 44;
/** Retour au champ d'origine quand la lecture se ferme. */
export const FOV_RESTORE_MS = 600;

/* ── Plan hélico (montées sinueuses, lacets) ─────────────────────────── */
/**
 * Là où le parcours est sinueux et pentu, la caméra orbite lentement autour
 * de la cible sur un petit arc (amplitude × sinus, période réelle) et prend
 * un peu de hauteur. Le limiteur de cap se réserve la vitesse d'orbite : la
 * rotation totale reste sous HEADING_MAX_RATE_DEG_S.
 */
export const ORBIT_AMPLITUDE_DEG = 26;
export const ORBIT_PERIOD_S = 36;
/** Intérêt normalisé (0 plat → 1 lacets raides) où l'orbite commence / est pleine. */
export const ORBIT_INTEREST_START = 0.3;
export const ORBIT_INTEREST_FULL = 0.75;
/** Montée en orbite lissée sur ce temps de lecture (pas d'entrée brusque). */
export const ORBIT_SMOOTHING_S = 3;
export const ORBIT_EXTRA_DISTANCE_RATIO = 0.12;
export const ORBIT_PITCH_DEG = 4;
