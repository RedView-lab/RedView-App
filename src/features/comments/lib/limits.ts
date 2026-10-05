/**
 * Limites des commentaires, partagées par l'interface, le fichier `.redview`
 * et les règles du serveur temps réel (collab/model/commentRules.ts). Sans
 * dépendance : le serveur les importe sans tirer la feature.
 */

/** Caractères d'un message (texte brut). */
export const MAX_COMMENT_TEXT_CHARS = 5_000;
/** Sommets de l'empreinte d'une zone commentée. */
export const MAX_COMMENT_ZONE_VERTICES = 64;
export const MIN_COMMENT_ZONE_VERTICES = 3;
/** Utilisateurs mentionnés dans un message. */
export const MAX_COMMENT_MENTIONS = 50;
/** Fils d'un projet et messages d'un fil (fichier `.redview` venu d'un tiers). */
export const MAX_COMMENT_THREADS = 500;
export const MAX_COMMENT_MESSAGES = 200;
