import { translateAppText } from '@/shared/i18n';
import { logger } from '@/shared/lib/logger';
import { account, getAppwriteUser, getSessionUserIdSync } from '@/shared/services/appwrite';
import type { SavedCustomProfile } from '../../types';

export type { SavedCustomProfile } from '../../types';

/**
 * Bibliothèque des profils de tracé perso de l'utilisateur.
 *
 * Source de vérité : les préférences du compte Appwrite
 * (`prefs.routingProfiles`), communes à tous ses appareils. Copie locale
 * (localStorage, clé `redview:*` effacée à la déconnexion) pour une lecture
 * synchrone et hors-ligne. Une création / modification / suppression locale
 * reste en attente (`pending*`) jusqu'à son envoi, puis est rejouée par-dessus
 * la version du compte : un profil supprimé ici ne revient pas depuis un autre
 * appareil, un profil créé hors-ligne n'est pas écrasé par la synchro.
 *
 * Migration : l'ancienne clé `redview_custom_routing_profiles` (cet appareil
 * seulement, jamais effacée à la déconnexion) est reprise une fois, envoyée au
 * compte, puis supprimée.
 */
const STORAGE_KEY = 'redview:routing-profiles:v2';
const LEGACY_STORAGE_KEY = 'redview_custom_routing_profiles';
const PREFS_KEY = 'routingProfiles';
export const CUSTOM_PROFILES_CHANGED_EVENT = 'redview_custom_profiles_changed';

/** Regroupe les modifications rapprochées en un seul envoi. */
const PUSH_DELAY_MS = 800;
/**
 * Les préférences Appwrite tiennent en 64 Ko (toutes clés confondues) : au-delà
 * de ce budget la bibliothèque reste sur cet appareil plutôt que de faire
 * échouer l'enregistrement des autres préférences du compte.
 */
const MAX_PREFS_PROFILES_CHARS = 48_000;

interface LocalLibrary {
  /** Compte auquel appartient cette copie (null : pas de session connue). */
  ownerId: string | null;
  profiles: SavedCustomProfile[];
  /** Ids créés / modifiés ici, pas encore envoyés au compte. */
  pendingUpserts: string[];
  /** Ids supprimés ici, pas encore retirés du compte. */
  pendingDeletes: string[];
  /** Incrémenté à chaque modification locale (envoi concurrent d'une modification). */
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Profils valides d'une valeur stockée (localStorage, préférences du compte, fichier). */
function sanitizeSavedCustomProfiles(raw: unknown): SavedCustomProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedCustomProfile[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { id, name, roadTypes, priorities, createdAt } = entry;
    if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string') continue;
    if (!isRecord(roadTypes) || !isRecord(priorities)) continue;
    seen.add(id);
    out.push({
      ...(entry as unknown as SavedCustomProfile),
      createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    });
  }
  return out;
}

function emptyLibrary(ownerId: string | null): LocalLibrary {
  return { ownerId, profiles: [], pendingUpserts: [], pendingDeletes: [], revision: 0 };
}

function readStoredLibrary(): LocalLibrary | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalLibrary>;
    if (!isRecord(parsed)) return null;
    const ids = (value: unknown) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    return {
      ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : null,
      profiles: sanitizeSavedCustomProfiles(parsed.profiles),
      pendingUpserts: ids(parsed.pendingUpserts),
      pendingDeletes: ids(parsed.pendingDeletes),
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
    };
  } catch {
    return null;
  }
}

function writeLibrary(library: LocalLibrary): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch (error) {
    logger.projects.warn('[routing-profiles] local copy not written', error);
  }
}

/** Reprend une fois les profils de l'ancienne clé (en attente d'envoi au compte). */
function adoptLegacyProfiles(library: LocalLibrary): boolean {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return false;
  }
  if (raw == null) return false;
  let legacy: SavedCustomProfile[] = [];
  try {
    legacy = sanitizeSavedCustomProfiles(JSON.parse(raw));
  } catch {
    legacy = [];
  }
  const known = new Set(library.profiles.map((profile) => profile.id));
  for (const profile of legacy) {
    if (known.has(profile.id)) continue;
    library.profiles.push(profile);
    library.pendingUpserts.push(profile.id);
  }
  library.revision += 1;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // la clé sera reprise au prochain chargement (ids déjà connus ignorés)
  }
  return true;
}

/**
 * Copie locale de la bibliothèque de l'utilisateur courant. Celle d'un autre
 * compte (même navigateur) n'est jamais servie.
 */
function readLibrary(): LocalLibrary {
  if (typeof window === 'undefined') return emptyLibrary(null);
  const sessionUserId = getSessionUserIdSync();
  let library = readStoredLibrary();
  if (library && library.ownerId && sessionUserId && library.ownerId !== sessionUserId) {
    library = null;
  }
  library ??= emptyLibrary(sessionUserId);
  if (!library.ownerId && sessionUserId) library.ownerId = sessionUserId;
  if (adoptLegacyProfiles(library)) {
    writeLibrary(library);
    schedulePush();
  }
  return library;
}

function sortProfiles(profiles: SavedCustomProfile[]): SavedCustomProfile[] {
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => a.profile.createdAt - b.profile.createdAt || a.index - b.index)
    .map(({ profile }) => profile);
}

/** Version du compte + modifications locales en attente. */
function applyPending(base: SavedCustomProfile[], library: LocalLibrary): SavedCustomProfile[] {
  const byId = new Map(base.map((profile) => [profile.id, profile]));
  for (const id of library.pendingDeletes) byId.delete(id);
  const localById = new Map(library.profiles.map((profile) => [profile.id, profile]));
  for (const id of library.pendingUpserts) {
    const profile = localById.get(id);
    if (profile) byId.set(id, profile);
  }
  return sortProfiles([...byId.values()]);
}

function notifyChanged(profiles: SavedCustomProfile[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CUSTOM_PROFILES_CHANGED_EVENT, { detail: profiles }));
}

export function getSavedCustomProfiles(): SavedCustomProfile[] {
  return readLibrary().profiles;
}

export function saveCustomProfileToStorage(profile: SavedCustomProfile): void {
  if (typeof window === 'undefined') return;
  const library = readLibrary();
  const index = library.profiles.findIndex((entry) => entry.id === profile.id);
  if (index >= 0) library.profiles[index] = profile;
  else library.profiles.push(profile);
  library.pendingUpserts = [...library.pendingUpserts.filter((id) => id !== profile.id), profile.id];
  library.pendingDeletes = library.pendingDeletes.filter((id) => id !== profile.id);
  library.revision += 1;
  writeLibrary(library);
  notifyChanged(library.profiles);
  schedulePush();
}

export function deleteCustomProfileFromStorage(id: string): void {
  if (typeof window === 'undefined') return;
  const library = readLibrary();
  library.profiles = library.profiles.filter((profile) => profile.id !== id);
  library.pendingUpserts = library.pendingUpserts.filter((entry) => entry !== id);
  library.pendingDeletes = [...library.pendingDeletes.filter((entry) => entry !== id), id];
  library.revision += 1;
  writeLibrary(library);
  notifyChanged(library.profiles);
  schedulePush();
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let syncedUserId: string | null = null;

function schedulePush(): void {
  if (typeof window === 'undefined') return;
  if (pushTimer != null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void syncCustomProfilesWithAccount();
  }, PUSH_DELAY_MS);
}

async function runSync(): Promise<void> {
  // Pas de session connue (mode local de développement) : bibliothèque locale seule.
  if (!getSessionUserIdSync()) return;
  const user = await getAppwriteUser();
  if (!user) return;

  const snapshot = readLibrary();
  const library = snapshot.ownerId === user.$id ? snapshot : emptyLibrary(user.$id);
  const prefs = isRecord(user.prefs) ? (user.prefs as Record<string, unknown>) : {};
  const merged = applyPending(sanitizeSavedCustomProfiles(prefs[PREFS_KEY]), library);
  const hasPending = library.pendingUpserts.length > 0 || library.pendingDeletes.length > 0;

  let pushed = !hasPending;
  if (hasPending) {
    if (JSON.stringify(merged).length > MAX_PREFS_PROFILES_CHARS) {
      logger.projects.warn('[routing-profiles] library too large for account prefs, kept on this device', {
        count: merged.length,
      });
    } else {
      try {
        await account.updatePrefs({ ...prefs, [PREFS_KEY]: merged });
        pushed = true;
      } catch (error) {
        logger.projects.warn('[routing-profiles] account sync failed, will retry', error);
      }
    }
  }
  syncedUserId = user.$id;

  // Modification locale pendant l'envoi : elle est rejouée sur le résultat et
  // repartira au prochain envoi (opérations idempotentes).
  const latest = readLibrary();
  const changedMeanwhile = latest.ownerId === user.$id && latest.revision !== library.revision;
  const next: LocalLibrary = changedMeanwhile
    ? { ...latest, profiles: applyPending(merged, latest) }
    : {
        ownerId: user.$id,
        profiles: merged,
        pendingUpserts: pushed ? [] : library.pendingUpserts,
        pendingDeletes: pushed ? [] : library.pendingDeletes,
        revision: library.revision,
      };
  const before = JSON.stringify(latest.profiles);
  writeLibrary(next);
  if (JSON.stringify(next.profiles) !== before) notifyChanged(next.profiles);
  if (changedMeanwhile) schedulePush();
}

/**
 * Récupère la bibliothèque du compte et y envoie les modifications locales en
 * attente. Un seul échange à la fois ; sans session, ne fait rien.
 */
function syncCustomProfilesWithAccount(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runSync()
    .catch((error: unknown) => {
      logger.projects.warn('[routing-profiles] sync failed', error);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Première synchronisation de la session (puis à chaque changement de compte). */
export function ensureCustomProfilesSynced(): void {
  const userId = getSessionUserIdSync();
  if (!userId || userId === syncedUserId) return;
  void syncCustomProfilesWithAccount();
}

export function getNextCustomProfileName(existingProfiles: SavedCustomProfile[]): string {
  const existingNames = new Set(existingProfiles.map((p) => p.name.trim().toLowerCase()));
  const nameFor = (num: number) => translateAppText('Profil {{number}}', { number: num });
  let num = 1;
  while (existingNames.has(`profil ${num}`) || existingNames.has(nameFor(num).toLowerCase())) {
    num++;
  }
  return nameFor(num);
}

/**
 * Profils proposés dans le sélecteur : la bibliothèque du compte, puis ceux
 * qu'embarque le projet ouvert sans être dans la bibliothèque (projet créé
 * sur un appareil pas encore synchronisé, ou par un collaborateur).
 */
export function mergeAvailableCustomProfiles(
  library: readonly SavedCustomProfile[],
  projectProfiles: readonly SavedCustomProfile[] | null | undefined,
): SavedCustomProfile[] {
  if (!projectProfiles || projectProfiles.length === 0) return [...library];
  const known = new Set(library.map((profile) => profile.id));
  return [...library, ...projectProfiles.filter((profile) => !known.has(profile.id))];
}
