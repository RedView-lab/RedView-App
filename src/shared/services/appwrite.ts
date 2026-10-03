import {
  Account,
  Client,
  Databases,
  ID,
  ImageFormat,
  OAuthProvider,
  Permission,
  Query,
  Role,
  Storage,
  type Models,
} from 'appwrite';

const appwriteEndpoint =
  (import.meta.env.VITE_APPWRITE_ENDPOINT as string | undefined) ||
  'https://appwrite.redview.tech/v1';
const appwriteProjectId =
  (import.meta.env.VITE_APPWRITE_PROJECT_ID as string | undefined) || 'redview-prod';

export const APPWRITE_DATABASE_ID =
  (import.meta.env.VITE_APPWRITE_DATABASE_ID as string | undefined) || 'redview-db';
export const PROJECTS_COLLECTION_ID = 'projects';
export const FOLDERS_COLLECTION_ID = 'project_folders';
export const CUSTOMERS_COLLECTION_ID = 'customers';
export const SUBSCRIPTIONS_COLLECTION_ID = 'subscriptions';
export const THUMBNAILS_BUCKET_ID = 'project-thumbnails';
export const FIT_FILES_BUCKET_ID = 'itinerary-fit-files';
/** Charges utiles des gros projets (gzip), trop lourdes pour l'attribut `projects.data`. */
export const PROJECT_PAYLOADS_BUCKET_ID = 'project-payloads';

export const APPWRITE_AUTH_STORAGE_KEY = 'redview:appwrite-session';

export interface StoredAppwriteSessionSnapshot {
  user: {
    id: string;
    email?: string;
    name?: string;
  };
}

export const client = new Client();
client.setEndpoint(appwriteEndpoint).setProject(appwriteProjectId);

export const account = new Account(client);
export const databases = new Databases(client);
export const storage = new Storage(client);

export { ID, OAuthProvider, Permission, Query, Role, ImageFormat };

export function hasStoredAppwriteSession(): boolean {
  return readStoredAppwriteSession() !== null;
}

export function readStoredAppwriteSession(): StoredAppwriteSessionSnapshot | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(APPWRITE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAppwriteSessionSnapshot;
    if (!parsed?.user || typeof parsed.user.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Identité de session en mémoire ─────────────────────────────────────────
// Évite un GET /account à chaque sauvegarde : l'identifiant connu (dernier
// account.get() réussi ou instantané de session persisté) sert tant qu'aucun
// 401 ni déconnexion ne l'invalide. Une coupure réseau ne l'efface jamais.
let cachedSessionUserId: string | null = null;

/**
 * Événement DOM émis sur `window` quand la session Appwrite est réellement
 * expirée (401 confirmé par GET /account, jamais sur une erreur réseau).
 * Contrat avec App.tsx : `detail = { reason: 'unauthorized', userId }`.
 */
export const APPWRITE_SESSION_EXPIRED_EVENT = 'redview:session-expired';

export interface AppwriteSessionExpiredDetail {
  reason: 'unauthorized';
  /** Identifiant de l'utilisateur dont la session a expiré. */
  userId: string | null;
}

type SessionExpiredListener = (detail: AppwriteSessionExpiredDetail) => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/**
 * S'abonne à l'expiration de session (401 sur account.get(), y compris après un
 * 401 renvoyé par une écriture de projet). Renvoie la fonction de désabonnement.
 * L'événement DOM `APPWRITE_SESSION_EXPIRED_EVENT` est aussi émis sur `window`.
 */
export function onAppwriteSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

/**
 * Invalide la session locale (instantané + cache mémoire) et notifie l'app.
 * N'émet rien s'il n'y avait aucune session connue (visiteur non connecté).
 */
export function markAppwriteSessionExpired(): void {
  const userId = cachedSessionUserId ?? readStoredAppwriteSession()?.user.id ?? null;
  clearStoredAppwriteSession();
  if (!userId) return;
  const detail: AppwriteSessionExpiredDetail = { reason: 'unauthorized', userId };
  for (const listener of [...sessionExpiredListeners]) {
    try {
      listener(detail);
    } catch (error) {
      console.warn('[appwrite] session-expired listener failed', error);
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AppwriteSessionExpiredDetail>('redview:session-expired', { detail }));
  }
}

/**
 * Identifiant de l'utilisateur connecté sans aller-retour réseau : cache mémoire,
 * sinon instantané de session persisté. `null` s'il n'y a aucune session connue.
 */
export function getSessionUserIdSync(): string | null {
  return cachedSessionUserId ?? readStoredAppwriteSession()?.user.id ?? null;
}

function isAppwriteUnauthorized(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 401;
}

export function saveStoredAppwriteSession(user: { id: string; email?: string; name?: string }): void {
  cachedSessionUserId = user.id;
  if (typeof window === 'undefined') return;
  try {
    const snapshot: StoredAppwriteSessionSnapshot = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
    window.localStorage.setItem(APPWRITE_AUTH_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore local storage errors
  }
}

export function clearStoredAppwriteSession(): void {
  cachedSessionUserId = null;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(APPWRITE_AUTH_STORAGE_KEY);
    window.localStorage.removeItem('redview:dev-session');
  } catch {
    // ignore
  }
}

let inFlightUserPromise: Promise<Models.User<Models.Preferences> | null> | null = null;

/**
 * Interroge GET /account. Renvoie `null` si l'utilisateur n'est pas connecté ou
 * si le réseau est indisponible. Seul un vrai 401 (session absente / expirée)
 * efface la session locale et émet l'événement d'expiration ; une erreur réseau
 * conserve la session connue (les sauvegardes continuent sous le bon compte).
 */
export async function getAppwriteUser(): Promise<Models.User<Models.Preferences> | null> {
  if (!inFlightUserPromise) {
    inFlightUserPromise = (async () => {
      try {
        const user = await account.get();
        saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name });
        return user;
      } catch (error) {
        if (isAppwriteUnauthorized(error)) {
          markAppwriteSessionExpired();
        } else {
          console.warn('[appwrite] account.get failed (session kept)', error);
        }
        return null;
      }
    })();
  }

  try {
    return await inFlightUserPromise;
  } finally {
    inFlightUserPromise = null;
  }
}

export async function getAppwriteJwt(): Promise<string | null> {
  try {
    const { jwt } = await account.createJWT();
    return jwt;
  } catch (error) {
    console.warn('[appwrite] createJWT failed', error);
    return null;
  }
}
