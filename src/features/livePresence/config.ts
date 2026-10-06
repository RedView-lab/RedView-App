/**
 * Réglages de la présence en direct (curseurs, suivre un éditeur, Spotlight).
 * Débits : ce qui est regardé part à 30 Hz, le reste juste assez pour être à
 * jour ; rien au repos. Le serveur tient 40 messages/s par client
 * (collab/room/motion.ts).
 */

/** Quelqu'un me suit (ou je présente) : caméra, pointeur et graphique à 30 Hz. */
export const WATCHED_SEND_INTERVAL_MS = 33;
/** Personne ne me suit : pointeur et graphique à 20 Hz (curseurs vus de tous). */
export const CURSOR_SEND_INTERVAL_MS = 50;
/** Personne ne me suit : la caméra seulement en image clé (de quoi démarrer un suivi tout de suite). */
export const CAMERA_KEYFRAME_INTERVAL_MS = 500;
/** Après l'arrêt d'un mouvement : état complet renvoyé (répare un message perdu). */
export const SETTLE_KEYFRAME_DELAY_MS = 250;

/** Démarrage du suivi : vol (van Wijk) si la vue est loin, sinon fondu. */
export const FOLLOW_FLY_MIN_SCREENS = 1.5;
export const FOLLOW_FLY_MIN_ZOOM_DELTA = 2;
/** Raccord vers la caméra suivie (après le vol, ou directement). */
export const FOLLOW_BLEND_MS = 350;
/**
 * L'éditeur suivi a disparu : on attend un autre onglet du même utilisateur
 * (rechargement de la page : chargement, carte, reconnexion ≈ 3 à 8 s).
 */
export const FOLLOW_GRACE_MS = 10_000;

/** Spotlight : délai avant de suivre la personne qui présente (« Pas maintenant » l'annule). */
export const SPOTLIGHT_COUNTDOWN_MS = 3_000;
