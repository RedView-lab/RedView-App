// ---------------------------------------------------------------------------
// Qui possède un projet et avec quelle équipe il est partagé : règles
// communes à l'API de partage (api/_lib/projectSharing.ts) et au serveur
// temps réel (server/multiplayer/appwriteStorage.ts).
//
// Les attributs d'une ligne `projects` (`user_id`, `team_id`, `collab`,
// `data`) sont écrits par le client : ils ne prouvent rien. Seules les
// `$permissions` font foi, parce qu'Appwrite refuse qu'un client accorde un
// droit à un rôle qu'il n'a pas lui-même (`user:<autre>`, équipe dont il
// n'est pas membre) :
//   - propriétaire = `user_id` SEULEMENT si la ligne donne aussi un droit
//     d'écriture ou de suppression à `user:<user_id>` ;
//   - équipe = toujours `p<projectId>` (jamais le `team_id` de la ligne),
//     partagée SEULEMENT si la ligne donne la lecture à cette équipe.
// Une ligne partagée ne donne à l'équipe que la LECTURE : le document est
// écrit par le serveur temps réel (clé admin). Avec un droit d'écriture,
// n'importe quel éditeur pouvait réécrire `user_id`, `team_id`, `data` et les
// permissions, donc se déclarer propriétaire (ancien format, nettoyé par
// scripts/secure-shared-projects.mjs).
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';

/** Ids Appwrite (projets, utilisateurs, fichiers) : 1–36 car., sans caractère spécial en tête. */
export const APPWRITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

/** Équipe d'un projet partagé : `p<projectId>` (id Appwrite ≤ 36 car., haché au-delà). */
export function projectTeamId(projectId) {
  const id = `p${projectId}`;
  return id.length <= 36 ? id : `p${createHash('sha256').update(projectId).digest('hex').slice(0, 35)}`;
}

/** Chaîne de permission Appwrite (`read("user:abc")`), identique à `Permission.read(Role.user('abc'))`. */
export function permission(action, role) {
  return `${action}("${role}")`;
}

/** @param {readonly string[] | undefined} permissions */
function permissionsOf(permissions) {
  return Array.isArray(permissions) ? permissions : [];
}

/**
 * Permission accordée à une équipe en écriture (`update`/`delete`) : ancien
 * format des projets partagés, où tout éditeur pouvait réécrire la ligne.
 * @param {readonly string[] | undefined} permissions
 */
export function grantsTeamWrite(permissions) {
  return permissionsOf(permissions).some((entry) => /^(update|delete|write)\("team:/.test(entry));
}

/**
 * Propriétaire déclaré par la ligne, s'il est corroboré par ses permissions
 * (écriture ou suppression pour `user:<user_id>`), sinon null.
 * @param {{ user_id?: unknown, $permissions?: readonly string[] }} row
 * @returns {string | null}
 */
export function corroboratedOwnerId(row) {
  const userId = typeof row?.user_id === 'string' ? row.user_id : '';
  if (!userId || !APPWRITE_ID_PATTERN.test(userId)) return null;
  const permissions = permissionsOf(row.$permissions);
  const role = `user:${userId}`;
  return permissions.includes(permission('update', role)) || permissions.includes(permission('delete', role))
    ? userId
    : null;
}

/**
 * Projet partagé avec son équipe `p<projectId>` (lecture accordée par la ligne).
 * @param {{ $id: string, $permissions?: readonly string[] }} row
 */
export function isTeamShared(row) {
  return permissionsOf(row?.$permissions).includes(permission('read', `team:${projectTeamId(row.$id)}`));
}

/**
 * Permissions d'une ligne partagée : tout au propriétaire, lecture seule à
 * l'équipe (rien d'autre : ni `any`, ni `users`, ni écriture d'équipe).
 * @param {string} ownerId
 * @param {string} teamId
 */
export function canonicalSharedPermissions(ownerId, teamId) {
  const owner = `user:${ownerId}`;
  return [
    permission('read', owner),
    permission('update', owner),
    permission('delete', owner),
    permission('read', `team:${teamId}`),
  ];
}

/** Permissions de la ligne différentes de celles attendues (ordre ignoré). */
export function samePermissions(a, b) {
  const left = new Set(permissionsOf(a));
  const right = new Set(permissionsOf(b));
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/**
 * Fichier lisible par le propriétaire ou l'équipe du projet (ses permissions
 * le disent) : le serveur ne suit jamais, avec sa clé admin, un fichier que
 * le projet ne pouvait pas déjà lire.
 * @param {readonly string[] | undefined} filePermissions
 * @param {string} ownerId
 * @param {string | null} teamId
 */
export function fileReadableBy(filePermissions, ownerId, teamId) {
  const permissions = permissionsOf(filePermissions);
  if (permissions.includes(permission('read', `user:${ownerId}`))) return true;
  return teamId !== null && permissions.includes(permission('read', `team:${teamId}`));
}

/** Nom du fichier de charge utile d'un projet (bucket `project-payloads`). */
export function projectPayloadFileName(projectId) {
  return `${projectId}.json.gz`;
}

/** Nom du point de sauvegarde exact d'une salle (écrit par le serveur, sans permission). */
export function projectSnapshotFileName(projectId) {
  return `${projectId}.collab.gz`;
}
