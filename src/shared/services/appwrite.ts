import { Account, AppwriteException, Client, Databases, ID, OAuthProvider, Permission, Query, Role, Storage, type Models } from 'appwrite';

import { isSessionRejectedError } from '@/shared/lib/appwriteErrors';
import { createJwtCache } from './jwtCache';

const appwriteEndpoint =
  (import.meta.env.VITE_APPWRITE_ENDPOINT as string | undefined) ||
  'https://appwrite.redview.tech/v1';
const appwriteProjectId =
  (import.meta.env.VITE_APPWRITE_PROJECT_ID as string | undefined) || 'redview-prod';

export const APPWRITE_DATABASE_ID =
  (import.meta.env.VITE_APPWRITE_DATABASE_ID as string | undefined) || 'redview-db';
export const PROJECTS_COLLECTION_ID = 'projects';
/** Vue de chaque utilisateur sur chaque projet (projectViews.ts), à part du document partagé. */
export const PROJECT_VIEWS_COLLECTION_ID = 'project_views';
export const FOLDERS_COLLECTION_ID = 'project_folders';
export const THUMBNAILS_BUCKET_ID = 'project-thumbnails';
export const FIT_FILES_BUCKET_ID = 'itinerary-fit-files';
/** Charges utiles des gros projets (gzip), trop lourdes pour l'attribut `projects.data`. */
export const PROJECT_PAYLOADS_BUCKET_ID = 'project-payloads';

const APPWRITE_AUTH_STORAGE_KEY = 'redview:appwrite-session';

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

export { AppwriteException, ID, OAuthProvider, Permission, Query, Role,  };

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

interface AppwriteSessionExpiredDetail {
  reason: 'unauthorized';
  /** Identifiant de l'utilisateur dont la session a expiré. */
  userId: string | null;
}

/**
 * Invalide la session locale (instantané + cache mémoire) et notifie l'app.
 * N'émet rien s'il n'y avait aucune session connue (visiteur non connecté).
 */
function markAppwriteSessionExpired(): void {
  const userId = cachedSessionUserId ?? readStoredAppwriteSession()?.user.id ?? null;
  clearStoredAppwriteSession();
  if (!userId) return;
  const detail: AppwriteSessionExpiredDetail = { reason: 'unauthorized', userId };
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
    // on ignore les erreurs de stockage local
  }
}

export function clearStoredAppwriteSession(): void {
  cachedSessionUserId = null;
  recentUser = null;
  jwtCache.clear();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(APPWRITE_AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Dernier compte lu ──────────────────────────────────────────────────────
// GET /account renvoie tout le compte. Les lectures d'affichage qui suivent de
// peu une autre (vérification de session au démarrage, connexion, mesure
// d'audience, profil du gestionnaire de projets, état de l'accord .fit)
// reprennent la dernière réponse (`reuseRecent`) : le parcours principal
// (e2e:journey) faisait 19 GET /account. Chaque modification du compte
// (préférences, nom, mot de passe, e-mail) remplace ou oublie ce compte ; une
// lecture suivie d'une réécriture des préférences (remplacées en bloc) lit
// toujours le compte frais.
type AppwriteUser = Models.User<Models.Preferences>;

const RECENT_USER_MAX_AGE_MS = 15_000;
let recentUser: { user: AppwriteUser; at: number } | null = null;

/** Retient un compte que le serveur vient de renvoyer (GET /account, ou réponse d'une modification). */
export function rememberAppwriteUser(user: AppwriteUser): void {
  recentUser = { user, at: Date.now() };
  saveStoredAppwriteSession({ id: user.$id, email: user.email, name: user.name });
}

/** Le compte a changé sans que sa nouvelle version soit connue (changement d'e-mail par l'API). */
export function forgetRecentAppwriteUser(): void {
  recentUser = null;
}

function readRecentUser(): AppwriteUser | null {
  if (!recentUser || Date.now() - recentUser.at > RECENT_USER_MAX_AGE_MS) return null;
  return recentUser.user.$id === getSessionUserIdSync() ? recentUser.user : null;
}

/** GET /account en cours, partagé par les appelants simultanés. */
type AccountRequest = { raw: Promise<AppwriteUser>; handled: Promise<AppwriteUser | null> | null };
let inFlightAccount: AccountRequest | null = null;

function accountRequest(): AccountRequest {
  if (inFlightAccount) return inFlightAccount;
  const raw = account.get().then((user) => {
    rememberAppwriteUser(user);
    return user;
  });
  const request: AccountRequest = { raw, handled: null };
  inFlightAccount = request;
  const clear = () => {
    if (inFlightAccount === request) inFlightAccount = null;
  };
  raw.then(clear, clear);
  return request;
}

/**
 * GET /account brut (rejette sur toute erreur, pour qui doit distinguer un 401
 * d'une coupure : vérification de session au démarrage), partagé avec les
 * `getAppwriteUser` simultanés.
 */
export function fetchAppwriteUser(): Promise<AppwriteUser> {
  return accountRequest().raw;
}

/**
 * Interroge GET /account. Renvoie `null` si l'utilisateur n'est pas connecté ou
 * si le réseau est indisponible. Seul un vrai 401 (session absente / expirée)
 * efface la session locale et émet l'événement d'expiration ; une erreur réseau
 * conserve la session connue (les sauvegardes continuent sous le bon compte).
 *
 * `reuseRecent` : un compte lu il y a moins de 15 s suffit (affichage, mesure
 * d'audience). Les préférences se réécrivent par `updateAccountPrefs`.
 */
export async function getAppwriteUser(options: { reuseRecent?: boolean } = {}): Promise<AppwriteUser | null> {
  if (options.reuseRecent) {
    const recent = readRecentUser();
    if (recent) return recent;
  }
  const request = accountRequest();
  request.handled ??= request.raw.catch((error: unknown) => {
    if (isSessionRejectedError(error)) {
      markAppwriteSessionExpired();
    } else {
      console.warn('[appwrite] account.get failed (session kept)', error);
    }
    return null;
  });
  return request.handled;
}

type AccountPrefs = Record<string, unknown>;

/** Écritures des préférences de cet onglet, l'une après l'autre. */
let prefsWrites: Promise<unknown> = Promise.resolve();

/**
 * Réécrit les préférences du compte, qu'Appwrite remplace en bloc : `update`
 * reçoit celles d'un compte relu juste avant et rend les nouvelles (null : rien
 * à écrire). Une écriture à la fois dans l'onglet, chacune sur une lecture
 * faite après la précédente (jamais une lecture déjà en cours, qui peut la
 * précéder) : deux écritures lancées ensemble (profils de routage, accord
 * .fit, compte) partaient du même état et la dernière effaçait la clé de
 * l'autre — un retrait de l'accord .fit pouvait être annulé par la
 * synchronisation des profils.
 *
 * Rend le compte écrit (ou relu, sans écriture) ; null sans session (401) ;
 * lève sur une autre erreur.
 */
export function updateAccountPrefs(
  update: (prefs: AccountPrefs, user: AppwriteUser) => AccountPrefs | null | Promise<AccountPrefs | null>,
): Promise<AppwriteUser | null> {
  const run = prefsWrites.then(async () => {
    let user: AppwriteUser;
    try {
      user = await account.get();
    } catch (error) {
      if (!isSessionRejectedError(error)) throw error;
      markAppwriteSessionExpired();
      return null;
    }
    rememberAppwriteUser(user);
    const prefs = user.prefs && typeof user.prefs === 'object' ? { ...(user.prefs as AccountPrefs) } : {};
    const next = await update(prefs, user);
    if (!next) return user;
    const updated = await account.updatePrefs(next);
    rememberAppwriteUser(updated);
    return updated;
  });
  prefsWrites = run.catch(() => undefined);
  return run;
}

/** JWT réutilisé tant qu'il est frais (jwtCache.ts : Appwrite en limite la création à 100/h par utilisateur). */
const jwtCache = createJwtCache(async () => (await account.createJWT()).jwt, getSessionUserIdSync);

/**
 * JWT de la session (null : pas de session, ou création refusée). `fresh` :
 * le précédent a été refusé par un serveur (401) — on en crée un autre.
 */
export async function getAppwriteJwt(options: { fresh?: boolean } = {}): Promise<string | null> {
  try {
    return await jwtCache.get(options);
  } catch (error) {
    console.warn('[appwrite] createJWT failed', error);
    return null;
  }
}
