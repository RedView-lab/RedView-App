import { getAppwriteUser, getSessionUserIdSync } from '@/shared/services/appwrite';
import { isSessionRejectedError } from '@/shared/lib/appwriteErrors';
import { logger } from '@/shared/lib/logger';

import { ProjectCloudError, toProjectCloudError } from './errors';

/**
 * Classe et journalise (warn) l'échec d'une opération cloud. Sur un 401 (ou un
 * compte bloqué, 403 depuis Appwrite 1.9), vérifie la session via GET /account :
 * si elle est réellement expirée ou refusée, `getAppwriteUser`
 * invalide la session locale et émet l'événement d'expiration (un 401 sur un
 * document peut aussi être un simple refus de permission).
 */
export function toCloudFailure(operation: string, cause: unknown): ProjectCloudError {
  const error = toProjectCloudError(cause);
  logger.projects.warn(`Appwrite ${operation} failed (${error.kind})`, cause);
  if (error.kind === 'unauthorized' && (error.status === 401 || isSessionRejectedError(cause))) {
    void getAppwriteUser();
  }
  return error;
}

/** Identifiant utilisé hors session Appwrite, en développement local uniquement. */
const LOCAL_FALLBACK_USER_ID = 'dev-user-001';

/**
 * Utilisateur propriétaire des projets.
 *
 * Ordre : identifiant en mémoire / instantané de session (aucun aller-retour
 * réseau, donc pas de GET /account par sauvegarde) → GET /account (session
 * cookie sans instantané local) → en développement uniquement, l'identifiant
 * local `dev-user-001`. Sans utilisateur en production, lève une erreur
 * `unauthorized` : aucune ligne n'est écrite sous un propriétaire factice.
 */
export async function getCurrentUserId(): Promise<string> {
  const known = getSessionUserIdSync();
  if (known) return known;

  const user = await getAppwriteUser();
  if (user?.$id) return user.$id;

  if (import.meta.env.DEV) return LOCAL_FALLBACK_USER_ID;
  throw new ProjectCloudError('unauthorized');
}

/** Vrai pour l'utilisateur local de développement (projets `local-*`, sans cloud). */
export function isLocalFallbackUser(userId: string): boolean {
  return Boolean(import.meta.env.DEV) && userId === LOCAL_FALLBACK_USER_ID;
}

/**
 * Variante synchrone pour scoper les caches locaux (localStorage / IndexedDB)
 * sans aller-retour réseau. Hors session : identifiant local de dev en
 * développement, sinon un propriétaire « anonyme » qui ne correspond à aucun
 * compte (cache miss garanti, rien n'est envoyé au cloud sous cet identifiant).
 */
export function getCachedCurrentUserIdSync(): string {
  return getSessionUserIdSync() ?? (import.meta.env.DEV ? LOCAL_FALLBACK_USER_ID : 'anonymous');
}

/** Une ligne en cache local n'est servie que si elle appartient à l'utilisateur courant. */
export function isOwnedBy(row: { user_id?: unknown } | null | undefined, userId: string): boolean {
  return Boolean(row) && typeof row?.user_id === 'string' && row.user_id === userId;
}
