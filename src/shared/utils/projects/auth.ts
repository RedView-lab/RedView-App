import { getAppwriteUser, readStoredAppwriteSession } from '@/shared/services/appwrite';

export async function getCurrentUserId(): Promise<string> {
  const user = await getAppwriteUser();
  if (user?.$id) return user.$id;

  const storedSession = readStoredAppwriteSession();
  if (storedSession?.user.id) return storedSession.user.id;

  throw new Error('Not authenticated');
}

/** Identifiant utilisé hors session Appwrite (mode dev / non authentifié). */
export const LOCAL_FALLBACK_USER_ID = 'dev-user-001';

/**
 * Variante synchrone pour scoper les caches locaux (localStorage / IndexedDB)
 * sans aller-retour réseau : s'appuie sur l'instantané de session persisté par
 * `getAppwriteUser()`. Retombe sur l'identifiant local de dev en l'absence de session.
 */
export function getCachedCurrentUserIdSync(): string {
  return readStoredAppwriteSession()?.user.id ?? LOCAL_FALLBACK_USER_ID;
}

/** Une ligne en cache local n'est servie que si elle appartient à l'utilisateur courant. */
export function isOwnedBy(row: { user_id?: unknown } | null | undefined, userId: string): boolean {
  return Boolean(row) && typeof row?.user_id === 'string' && row.user_id === userId;
}
