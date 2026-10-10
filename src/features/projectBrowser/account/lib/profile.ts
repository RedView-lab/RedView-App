import {
  account,
  clearStoredAppwriteSession,
  getAppwriteUser,
  rememberAppwriteUser,
} from '@/shared/services/appwrite';
import { normalizeAccountSportLabel } from '@/shared/services/accountPrefs';
import {
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  readDocumentAppLocale,
  translateAppText,
} from '@/shared/i18n';
import { APP_CACHE_EPOCH_STORAGE_KEY } from '@/shared/lib/appCacheEpoch';
import { appwriteFailureMessage } from '@/shared/lib/appwriteErrors';
import { clearAnalyticsContext, trackAnalyticsEvent } from '@/shared/lib/analytics';
import { syncDirtyProjects } from '@/shared/services/projects';
import { clearProjectStore } from '@/shared/services/storage/idbProjectStore';

import {
  DEFAULT_COUNTRY,
  DEFAULT_LEVEL,
  DEFAULT_SPORT,
} from './options';
import type {
  AccountIdentityForm,
  AccountPracticeForm,
  AccountProfile,
  AccountSportEntry,
} from '../types';

type AccountMetadata = {
  first_name?: unknown;
  last_name?: unknown;
  country?: unknown;
  sports?: unknown;
};

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function readMetadata(user: { prefs?: unknown } | null | undefined): AccountMetadata {
  return user?.prefs && typeof user.prefs === 'object' ? (user.prefs as AccountMetadata) : {};
}

function buildSportEntry(value: Partial<AccountSportEntry> | null | undefined, index: number): AccountSportEntry {
  return {
    id: typeof value?.id === 'string' && value.id ? value.id : `sport-${index + 1}`,
    sport: normalizeAccountSportLabel(readString(value?.sport, DEFAULT_SPORT)),
    level: readString(value?.level, DEFAULT_LEVEL),
    annualDistanceKm: readString(value?.annualDistanceKm, '500'),
  };
}

function readSports(value: unknown): AccountSportEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [buildSportEntry(null, 0)];
  }

  return value.map((entry, index) => buildSportEntry(entry as Partial<AccountSportEntry>, index));
}

function buildFallbackName(email: string, fallbackDisplayName: string) {
  if (fallbackDisplayName.trim()) return fallbackDisplayName.trim();
  const localPart = email.split('@')[0] ?? 'Utilisateur';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function splitFallbackName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const [firstName, ...rest] = trimmed.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(' '),
  };
}

export function formatAccountDisplayName(profile: Pick<AccountProfile, 'firstName' | 'lastName' | 'email'>, fallbackDisplayName: string) {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  if (fullName) return fullName;
  return buildFallbackName(profile.email, fallbackDisplayName);
}

export function formatLastConnection(lastSignInAt: string | null) {
  if (!lastSignInAt) return translateAppText('Dernière connexion indisponible');

  const date = new Date(lastSignInAt);
  if (Number.isNaN(date.getTime())) return translateAppText('Dernière connexion indisponible');

  const locale = readDocumentAppLocale();
  const formatterLocale = locale === 'fr' ? 'fr-FR' : 'en-US';
  const day = new Intl.DateTimeFormat(formatterLocale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat(formatterLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale !== 'fr',
  }).format(date);

  return translateAppText('Dernière connexion le {{date}} à {{time}}', {
    date: day,
    time,
  });
}

export async function loadAccountProfile(fallbackEmail: string, fallbackDisplayName: string): Promise<AccountProfile> {
  // Ouverture du gestionnaire de projets : souvent juste après la vérification de session.
  const user = await getAppwriteUser({ reuseRecent: true });
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  const metadata = readMetadata(user);
  const email = readString(user.email, fallbackEmail);
  const nameParts = splitFallbackName(readString(user.name, buildFallbackName(email, fallbackDisplayName)));

  return {
    firstName: readString(metadata.first_name, nameParts.firstName),
    lastName: readString(metadata.last_name, nameParts.lastName),
    email,
    country: readString(metadata.country, DEFAULT_COUNTRY),
    sports: readSports(metadata.sports),
    lastSignInAt: typeof user.accessedAt === 'string' ? user.accessedAt : null,
    hasPassword: Boolean(user.passwordUpdate),
  };
}

export async function saveAccountIdentity(form: AccountIdentityForm) {
  const user = await getAppwriteUser();
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  // L'adresse e-mail n'est pas modifiable ici (champ en lecture seule) :
  // Appwrite demanderait le mot de passe et la marquerait non vérifiée.
  // Un échec est remonté : « Coordonnées enregistrées » ne s'affichait
  // jusqu'ici même quand rien n'était parti.
  const fullName = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();
  try {
    if (fullName && fullName !== user.name) await account.updateName(fullName);
    const updated = await account.updatePrefs({
      ...readMetadata(user),
      first_name: form.firstName.trim(),
      last_name: form.lastName.trim(),
    });
    rememberAppwriteUser(updated);
    return updated;
  } catch (error) {
    console.warn('[profile] saveAccountIdentity failed', error);
    throw new Error(appwriteFailureMessage(error, 'Impossible d’enregistrer le compte.'));
  }
}

export async function saveAccountPractice(form: AccountPracticeForm) {
  const user = await getAppwriteUser();
  if (!user) throw new Error(translateAppText('Session utilisateur introuvable.'));

  const currentPrefs = readMetadata(user);
  const updatedPrefs = {
    ...currentPrefs,
    country: form.country,
    sports: form.sports.map((sport, index) => buildSportEntry(sport, index)),
  };

  try {
    const updated = await account.updatePrefs(updatedPrefs);
    rememberAppwriteUser(updated);
    return updated;
  } catch (err) {
    console.warn('[profile] updatePrefs failed', err);
    return user;
  }
}

/** Refus d'Appwrite propres au mot de passe (le reste : appwriteFailureMessage). */
const PASSWORD_FAILURE_OVERRIDES = {
  user_invalid_credentials: 'Mot de passe actuel incorrect.',
  general_argument_invalid: 'Mot de passe refusé : 8 caractères minimum, et pas un mot de passe trop courant.',
  user_unauthorized: 'Session expirée. Reconnectez-vous puis réessayez.',
  user_blocked: 'Session expirée. Reconnectez-vous puis réessayez.',
};

/** Message d'un échec du changement de mot de passe (texte source FR, traduit par l'écran). */
export function accountUpdateFailureMessage(error: unknown, fallback: string): string {
  return appwriteFailureMessage(error, fallback, PASSWORD_FAILURE_OVERRIDES);
}

/** `currentPassword` : exigé par Appwrite quand le compte a déjà un mot de passe. */
export async function updateAccountPassword(newPassword: string, currentPassword?: string) {
  try {
    rememberAppwriteUser(await account.updatePassword(newPassword, currentPassword || undefined));
  } catch (error) {
    console.warn('[profile] updatePassword failed', error);
    throw new Error(accountUpdateFailureMessage(error, 'Impossible de mettre à jour le mot de passe.'));
  }
}

/**
 * Clés `redview:*` purement UI (langue/réglages d'affichage, époque de cache,
 * contournement mobile) conservées à la déconnexion. Toute autre clé `redview:*`
 * (caches de projets, dossiers, abonnement, facturation, overlay LiDAR, session…)
 * est considérée comme propre à l'utilisateur et supprimée.
 */
const SIGN_OUT_PRESERVED_KEYS = new Set<string>([
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  APP_CACHE_EPOCH_STORAGE_KEY,
  'redview:bypass-mobile-block',
]);

function isUserScopedStorageKey(key: string): boolean {
  if (key.startsWith('cookieFallback')) return true;
  // Legacy Supabase auth tokens (backend migré vers Appwrite).
  if (key.startsWith('sb-')) return true;
  return key.startsWith('redview:') && !SIGN_OUT_PRESERVED_KEYS.has(key);
}

function clearUserScopedLocalStorage() {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && isUserScopedStorageKey(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // on ignore les erreurs d'accès au stockage
  }
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Après la suppression du compte : tout ce qu'il a laissé sur cet appareil —
 * session, clés `redview:*` du compte, projets en cache (IndexedDB) et lots de
 * co-édition non envoyés (`redview-collab`, gardés à la déconnexion pour être
 * renvoyés à la session suivante du même compte).
 */
export async function clearLocalAccountData(): Promise<void> {
  clearStoredAppwriteSession();
  clearUserScopedLocalStorage();
  await Promise.race([
    Promise.allSettled([clearProjectStore(), deleteIndexedDb('redview-collab')]),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Déconnexion refusée : des projets ont des modifications locales que le cloud
 * n'a pas confirmées (la purge d'IndexedDB les détruirait).
 */
export class UnsyncedProjectsError extends Error {
  readonly projects: ReadonlyArray<{ id: string; name: string }>;

  constructor(projects: ReadonlyArray<{ id: string; name: string }>) {
    super('Des modifications ne sont pas synchronisées.');
    this.name = 'UnsyncedProjectsError';
    this.projects = projects;
  }
}

/**
 * Avant de purger les données locales : tente une dernière synchronisation des
 * copies locales non synchronisées. Renvoie celles qui restent en attente.
 */
async function syncPendingProjectsBeforeSignOut(): Promise<Array<{ id: string; name: string }>> {
  try {
    const failures = await syncDirtyProjects();
    return failures.map(({ meta, error }) => {
      console.warn('[auth] project still unsynced before sign-out', meta.id, error);
      return { id: meta.id, name: meta.name || 'Untitled' };
    });
  } catch (error) {
    // Impossible de lister les copies locales (pas d'IndexedDB / pas de session) :
    // rien de vérifiable, la déconnexion suit son cours.
    console.warn('[auth] unsynced projects check failed', error);
    return [];
  }
}

/**
 * Déconnexion. Sans `force`, lève `UnsyncedProjectsError` si des projets ont
 * encore des modifications non synchronisées après une dernière tentative
 * (l'UI propose alors d'exporter / réessayer / se déconnecter quand même).
 */
export async function signOutAccount({ force = false }: { force?: boolean } = {}) {
  if (!force) {
    const pending = await syncPendingProjectsBeforeSignOut();
    if (pending.length > 0) throw new UnsyncedProjectsError(pending);
  }

  // 1. Révoquer la session serveur EN PREMIER : le SDK Appwrite a besoin du
  //    `cookieFallback` (header X-Fallback-Cookies) pour authentifier cet appel
  //    lorsque les cookies tiers sont bloqués.
  try {
    await Promise.race([
      account.deleteSession('current'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (err) {
    console.warn('[auth] Appwrite deleteSession error (ignored):', err);
  }

  // 2. Puis purger l'état d'authentification local et les données propres à l'utilisateur.
  trackAnalyticsEvent({ name: 'logout' });
  clearAnalyticsContext();
  clearStoredAppwriteSession();
  clearUserScopedLocalStorage();

  try {
    await Promise.race([
      clearProjectStore(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (err) {
    console.warn('[auth] Failed to clear local project store (ignored):', err);
  }
}