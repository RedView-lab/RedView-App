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

const NETWORK_FAILURE_MESSAGE = 'Impossible de joindre le serveur RedView. Vérifiez votre connexion puis réessayez.';

/** Messages par `type` d'AppwriteException (stable d'une version du serveur à l'autre). */
const APPWRITE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  user_invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
  user_blocked: 'Ce compte est désactivé.',
  user_already_exists: 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.',
  user_email_already_exists: 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.',
  password_recently_used: 'Ce mot de passe a déjà été utilisé récemment. Choisissez-en un autre.',
  password_personal_data: 'Le mot de passe ne doit pas reprendre votre nom ni votre adresse e-mail.',
  general_rate_limit_exceeded: 'Trop de tentatives. Réessayez dans quelques minutes.',
  general_unauthorized_scope: 'Session expirée. Reconnectez-vous puis réessayez.',
  user_unauthorized: 'Action refusée pour ce compte. Reconnectez-vous puis réessayez.',
  document_not_found: 'Cet élément n’existe plus : il a peut-être été supprimé depuis un autre appareil.',
  storage_file_not_found: 'Ce fichier n’existe plus : il a peut-être été supprimé depuis un autre appareil.',
};

/**
 * Message à montrer pour un échec, en texte source FR (traduit par l'écran
 * ou `notify`). Une AppwriteException n'affiche jamais son message anglais,
 * écrit pour un développeur (« …by making a request to the User API's… ») :
 * son `type` connu donne un message, sinon `fallback`. Une panne réseau donne
 * le message réseau ; une autre `Error` (les nôtres, déjà rédigées) garde le
 * sien, sauf une erreur du moteur JS (bug : repli). `overrides` adapte un `type` au contexte (« mot de passe actuel
 * incorrect » dans Compte).
 */
export function appwriteFailureMessage(
  error: unknown,
  fallback: string,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const { code, type } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; type?: unknown };
  // fetch rejeté (« Failed to fetch », « Load failed », « NetworkError… ») ou
  // AppwriteException de réseau (code 0) — pas un TypeError de notre code.
  const networkFailure = (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) || code === 0;
  if (networkFailure) return NETWORK_FAILURE_MESSAGE;
  if (typeof type === 'string') return overrides[type] ?? APPWRITE_FAILURE_MESSAGES[type] ?? fallback;
  // Erreur du moteur JS (bug) : son message ne dit rien à l'utilisateur.
  const engineError = error instanceof TypeError || error instanceof RangeError
    || error instanceof ReferenceError || error instanceof SyntaxError;
  if (error instanceof Error && error.message && !engineError) return error.message;
  return fallback;
}
