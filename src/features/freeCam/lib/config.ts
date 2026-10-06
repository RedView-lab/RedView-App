/** Touche d'activation / sortie (position physique, indépendante du layout). */
export const FREECAM_TOGGLE_CODE = 'KeyF';

/** Degrés de rotation par pixel de souris. */
export const FREECAM_MOUSE_SENSITIVITY_DEG_PER_PX = 0.12;

/** FOV vertical fixe de Mapbox (0.6435 rad). */
export const MAPBOX_FOV_DEG = 36.8699;

/** Au-delà de maxPitch Mapbox (85, non relevable) l'orientation est rejetée par `setFreeCameraOptions`. */
export const FREECAM_MIN_PITCH = 0;
export const FREECAM_MAPBOX_MAX_PITCH = 84.9;

/** Padding haut max (fraction de la hauteur) pour regarder au-dessus de l'horizon (voir `lensShift`). */
export const FREECAM_LENS_SHIFT_MAX_PADDING_RATIO = 0.9;

/**
 * Pitch de regard max : pitch Mapbox + décalage optique max.
 * Décalage = ratio·H/2 et focale = (H/2)/tan(fov/2) ⇒ tan(extra) = ratio·tan(fov/2) (~16.7°).
 */
export const FREECAM_MAX_VIEW_PITCH =
  FREECAM_MAPBOX_MAX_PITCH
  + (Math.atan(FREECAM_LENS_SHIFT_MAX_PADDING_RATIO * Math.tan((MAPBOX_FOV_DEG * Math.PI) / 360)) * 180) / Math.PI;

/** Plafond du LOD forcé près de la caméra (au-delà : surcoût de re-découpage sans gain visible). */
export const FREECAM_LOD_MAX_ZOOM = 20;
/** Distance minimale prise en compte pour le LOD proche (m). */
export const FREECAM_LOD_MIN_DISTANCE_M = 2;

/** Hauteur minimale au-dessus du terrain rendu (exagéré), en mètres. */
export const FREECAM_MIN_GROUND_CLEARANCE_M = 1.5;

/** Anticipation du relief : on échantillonne le sol là où la caméra sera dans N secondes. */
export const FREECAM_GROUND_LOOKAHEAD_S = 0.15;

/** Vitesse horizontale = hauteur-sol × facteur, bornée (m/s). */
export const FREECAM_HORIZONTAL_SPEED_PER_AGL = 3;
export const FREECAM_HORIZONTAL_SPEED_MIN_MPS = 8;
export const FREECAM_HORIZONTAL_SPEED_MAX_MPS = 40_000;

/** Vitesse verticale = hauteur-sol × facteur, bornée (m/s). */
export const FREECAM_VERTICAL_SPEED_PER_AGL = 2.4;
export const FREECAM_VERTICAL_SPEED_MIN_MPS = 6;
export const FREECAM_VERTICAL_SPEED_MAX_MPS = 30_000;

/**
 * Vélocité (inertie) : constantes de temps de l'amortissement exponentiel.
 * Accélération : 95 % de la vitesse en ~0,4 s ; relâché : glisse ~1 s.
 */
export const FREECAM_ACCELERATE_TIME_S = 0.14;
export const FREECAM_BRAKE_TIME_S = 0.32;
/** Fin de glisse : arrêt net sous cette fraction de la vitesse horizontale du moment. */
export const FREECAM_REST_SPEED_RATIO = 0.01;

/** Multiplicateur de vitesse réglé à la molette. */
export const FREECAM_SPEED_MULTIPLIER_MIN = 0.25;
export const FREECAM_SPEED_MULTIPLIER_MAX = 16;
export const FREECAM_SPEED_MULTIPLIER_WHEEL_STEP = 1.25;

/**
 * En projection globe, Mapbox ne bascule en mercator (seule projection
 * supportant la free camera) qu'à partir du zoom 6 : on reste au-dessus.
 */
export const FREECAM_MIN_ZOOM = 6.3;
/** `GLOBE_ZOOM_THRESHOLD_MAX` de Mapbox : sous ce zoom, la carte est en globe. */
export const MAPBOX_GLOBE_TO_MERCATOR_ZOOM = 6;

/** Pas de temps max par frame (évite les téléportations après un onglet en pause). */
export const FREECAM_MAX_FRAME_DT_S = 0.05;

/** Après une libération du pointer lock par Échap, ignorer ce même Échap. */
export const FREECAM_ESCAPE_AFTER_UNLOCK_GRACE_MS = 250;
