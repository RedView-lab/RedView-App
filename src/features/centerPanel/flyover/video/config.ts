/**
 * Export vidéo du flyover (MP4 H.264). Rendu image par image hors écran,
 * chaque image attendue jusqu'à ce que toutes ses tuiles soient chargées.
 */

export type FlyoverVideoOrientation = 'landscape' | 'portrait';

export const VIDEO_SIZES: Record<FlyoverVideoOrientation, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export const VIDEO_FPS = 30;

/**
 * Suréchantillonnage : la carte hors écran est rendue à 2× (3 840 × 2 160)
 * puis réduite. Tuiles, traits et textes gardent la taille d'un écran
 * 1 080p ; l'image gagne l'anticrénelage et la netteté des tuiles @2x.
 */
export const VIDEO_SUPERSAMPLING = 2;

/**
 * H.264 High, débit variable : ~0,32 bit/pixel à 30 i/s. Un survol
 * satellite est un contenu très détaillé qui bouge en permanence ; en dessous
 * de ~15 Mb/s les textures « bavent » à chaque mouvement de caméra.
 */
export const VIDEO_BITRATE_BPS = 20_000_000;
export const VIDEO_KEYFRAME_INTERVAL_S = 2;

/* ── Montage ─────────────────────────────────────────────────────────── */
/** Plan d'ouverture sur tout le parcours, avant le survol d'approche. */
export const INTRO_HOLD_S = 1.2;
/** Le tracé complet du plan d'ouverture s'efface pendant l'approche. */
export const INTRO_TRAIL_FADE_START = 0.15;
/** Plan final sur tout le parcours. */
export const OUTRO_HOLD_S = 2;

/* ── Rendu ───────────────────────────────────────────────────────────── */
/**
 * Une image qui n'a toujours pas toutes ses tuiles est prise telle quelle.
 * Bien au-dessus de l'attente du Service Worker pour une tuile de relief de
 * la vidéo (`rv-src=video` : la vraie tuile LiDAR plutôt qu'un remplaçant,
 * nouvelles tentatives lancées pendant 30 s, d'une quinzaine de secondes
 * chacune au pire ; `handleVideoDemRequest`,
 * public/sw-dem/runtime/dem-handler/index.js).
 */
export const FRAME_SETTLE_TIMEOUT_MS = 90_000;
/**
 * Après une image prise ainsi, les suivantes n'attendent plus que ce délai
 * tant qu'aucune n'est complète : une tuile bloquée ne coûte pas 25 s à
 * chaque image où elle reste à l'écran.
 */
export const FRAME_RETRY_TIMEOUT_MS = 3_000;
/** Chargement de la carte hors écran (style, sprite, premières tuiles). */
export const MAP_LOAD_TIMEOUT_MS = 90_000;
/**
 * Préchargement : les tuiles des poses à venir (secondes de vidéo) sont
 * demandées pendant le rendu des images courantes ; quand la caméra y
 * arrive elles sortent des caches (Service Worker, HTTP).
 */
export const PRELOAD_AHEAD_S = [0.75, 1.5, 2.5, 4] as const;
/** Fréquence de ces demandes (images). */
export const PRELOAD_EVERY_FRAMES = 4;
/**
 * Mise en route : les tuiles des premières secondes (ouverture et approche,
 * où le zoom change de dix niveaux) sont toutes téléchargées avant la
 * première image, poses prises tous les quarts de seconde, attente bornée.
 */
export const PRELOAD_WARMUP_S = 4;
export const PRELOAD_WARMUP_STEP_S = 0.25;
export const PRELOAD_WARMUP_MAX_MS = 45_000;

/** Point de tête dessiné sur la vidéo (diamètre du marqueur de l'app × ce facteur). */
export const HEAD_DOT_SCALE = 1.25;
