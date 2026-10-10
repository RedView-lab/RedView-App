/**
 * Consentement aux données de santé des fichiers .fit, côté compte : lu et
 * écrit dans les préférences Appwrite (`prefs.healthDataConsent`), miroir local
 * pour le hors-ligne (shared/lib/healthDataConsent.ts), et demande à
 * l'utilisateur par une pop-in (`HealthDataConsentHost`, monté une fois dans
 * App). Tout point d'entrée qui envoie ou lit un .fit choisi par l'utilisateur
 * passe par `ensureHealthDataConsent()` : sans accord, rien n'est lu ni envoyé.
 */
import type { Models } from 'appwrite';

import {
  createHealthDataConsent,
  isHealthDataConsentValid,
  parseHealthDataConsent,
  readHealthDataConsentMirror,
  resolveHealthDataConsent,
  writeHealthDataConsentMirror,
  type HealthDataConsent,
} from '@/shared/lib/healthDataConsent';
import { notify } from '@/shared/lib/notify';
import { account, getAppwriteUser, getSessionUserIdSync, rememberAppwriteUser } from '@/shared/services/appwrite';

const PREFS_KEY = 'healthDataConsent';

type Prefs = Record<string, unknown>;

/**
 * Dernier état connu, par compte (évite de relire le compte à chaque envoi).
 * Relu au-delà de CACHE_TTL_MS : un retrait fait sur un autre appareil est vu
 * sans recharger la page.
 */
let cached: { userId: string; consent: HealthDataConsent | null; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

function readPrefs(user: Models.User<Models.Preferences> | null): Prefs {
  return user?.prefs && typeof user.prefs === 'object' ? (user.prefs as Prefs) : {};
}

/** Consentement du compte connecté (null : aucun, ou d'une ancienne version — voir `isHealthDataConsentValid`). */
export async function loadHealthDataConsent(): Promise<HealthDataConsent | null> {
  const user = await getAppwriteUser({ reuseRecent: true });
  const userId = user?.$id ?? getSessionUserIdSync();
  if (!userId) return null;
  const fromAccount = user ? parseHealthDataConsent(readPrefs(user)[PREFS_KEY]) : null;
  const consent = resolveHealthDataConsent({
    account: fromAccount,
    accountReadable: user !== null,
    mirror: readHealthDataConsentMirror(userId),
  });
  if (user) writeHealthDataConsentMirror(userId, consent);
  cached = { userId, consent, at: Date.now() };
  return consent;
}

async function writeAccountConsent(consent: HealthDataConsent | null): Promise<void> {
  const user = await getAppwriteUser();
  if (!user) throw new Error('Session utilisateur introuvable.');
  // Les préférences sont remplacées en bloc : partir de celles du compte.
  rememberAppwriteUser(await account.updatePrefs({ ...readPrefs(user), [PREFS_KEY]: consent }));
  writeHealthDataConsentMirror(user.$id, consent);
  cached = { userId: user.$id, consent, at: Date.now() };
}

/** Enregistre l'accord (version courante) dans le compte. */
async function acceptHealthDataConsent(): Promise<HealthDataConsent> {
  const consent = createHealthDataConsent();
  await writeAccountConsent(consent);
  return consent;
}

/** Retire l'accord du compte : plus aucun .fit ne peut être ajouté. */
export async function withdrawHealthDataConsent(): Promise<void> {
  await writeAccountConsent(null);
}

/** Oublie l'état en mémoire (changement de compte, tests). */
export function resetHealthDataConsentCache(): void {
  cached = null;
}

// ── Demande à l'utilisateur ──────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
/** Demandes en attente de la réponse de l'utilisateur (une seule pop-in pour toutes). */
let waiting: Array<(accepted: boolean) => void> = [];

/** Une demande attend la réponse de l'utilisateur (lu par HealthDataConsentHost). */
export function isHealthDataConsentRequested(): boolean {
  return waiting.length > 0;
}

export function subscribeHealthDataConsentRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

/** Réponse de la pop-in : `true` pour « J'accepte », `false` pour « Refuser » ou fermer. */
export function answerHealthDataConsentRequest(accepted: boolean): void {
  const resolvers = waiting;
  waiting = [];
  emit();
  for (const resolve of resolvers) resolve(accepted);
}

function requestFromUser(): Promise<boolean> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (waiting.length === 1) emit();
  });
}

/**
 * Vrai si l'utilisateur a donné son accord (déjà, ou à l'instant dans la
 * pop-in). Faux s'il refuse, ferme la pop-in, ou si l'accord n'a pas pu être
 * enregistré dans son compte.
 */
export async function ensureHealthDataConsent(): Promise<boolean> {
  const userId = getSessionUserIdSync();
  const fresh = cached && cached.userId === userId && Date.now() - cached.at < CACHE_TTL_MS;
  const consent = fresh ? cached!.consent : await loadHealthDataConsent();
  if (isHealthDataConsentValid(consent)) return true;
  const accepted = await requestFromUser();
  if (!accepted) return false;
  try {
    await acceptHealthDataConsent();
    return true;
  } catch (error) {
    console.warn('[healthDataConsent] accept not saved', error);
    notify.error('Votre accord n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.');
    return false;
  }
}
