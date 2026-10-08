/**
 * Session Appwrite inutilisable : absente ou expirée (401), ou compte bloqué —
 * 401 jusqu'à Appwrite 1.8, 403 `user_blocked` depuis 1.9 (p. ex. pendant la
 * suppression du compte, étiquette `deletionpending`). L'appareil doit alors
 * revenir à la connexion, pas garder la session comme si le réseau manquait.
 */
export function isSessionRejectedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  return code === 401 || type === 'user_blocked';
}
