import { sharedProjectTeamId } from './liveSessions';

/**
 * Quelles lignes `projects` (et dossiers) sont vraiment à l'utilisateur ou
 * partagées avec lui. Appwrite renvoie toute ligne qu'on peut LIRE : un autre
 * compte peut créer une ligne lisible par tous (`read("users")`) avec
 * `user_id` = la victime — elle apparaîtrait dans « Mes projets », et si elle
 * est aussi modifiable par tous, ce que la victime y saisirait serait lu par
 * son auteur. On ne garde donc que :
 *  - mes lignes : `user_id` = moi ET une permission sur mon rôle
 *    (`user:<moi>`), qu'Appwrite interdit à tout autre compte d'accorder ;
 *  - les lignes partagées avec moi : équipe `p<projet>` (jamais un autre
 *    `team_id`), lecture accordée à cette équipe, dont je suis membre
 *    (accessQueries.ts, chargé à la demande).
 * Le reste est ignoré dans les listes et vaut « introuvable » à l'ouverture.
 */

export interface AccessCheckedDoc {
  $id: string;
  user_id?: string;
  team_id?: string | null;
  $permissions?: string[];
}

/** La ligne m'appartient : `user_id` corroboré par une permission sur mon rôle. */
export function isOwnDocument(doc: AccessCheckedDoc, userId: string): boolean {
  if (doc.user_id !== userId) return false;
  const role = `"user:${userId}"`;
  return (doc.$permissions ?? []).some((permission) => permission.endsWith(`(${role})`));
}

/** Équipe de partage de la ligne si elle est partagée par son équipe `p<projet>`, sinon null. */
export function sharingTeamOf(doc: AccessCheckedDoc): string | null {
  const teamId = sharedProjectTeamId(doc.$id);
  if (!teamId || doc.team_id !== teamId) return null;
  return (doc.$permissions ?? []).includes(`read("team:${teamId}")`) ? teamId : null;
}

/**
 * Contrôles qui interrogent Appwrite (équipes, vue dont l'id est pris),
 * chargés à la demande : un seul point d'import dynamique pour tous.
 */
export function loadAccessQueries(): Promise<typeof import('./accessQueries')> {
  return import('./accessQueries');
}

/** La ligne est-elle à moi ou partagée avec moi ? */
export async function isAccessibleDocument(doc: AccessCheckedDoc, userId: string): Promise<boolean> {
  if (isOwnDocument(doc, userId)) return true;
  const teamId = sharingTeamOf(doc);
  return teamId !== null && (await loadAccessQueries()).isTeamMember(userId, teamId);
}

/** Erreur « introuvable » (code 404) : la ligne n'est ni à moi ni partagée avec moi. */
export function inaccessibleProjectError(id: string): Error {
  return Object.assign(new Error(`Project ${id} not found`), { code: 404 });
}
