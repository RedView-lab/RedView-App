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
import { getAppwriteUser, getSessionUserIdSync, updateAccountPrefs } from '@/shared/services/appwrite';

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
  const user = await updateAccountPrefs((prefs) => ({ ...prefs, [PREFS_KEY]: consent }));
  if (!user) throw new Error('Session utilisateur introuvable.');
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
interface Waiting {
  /** Refus, ou l'issue de l'écriture de l'accord. */
  resolve: (accepted: boolean | Promise<boolean>) => void;
  /** Lancée dans le clic même sur « J'accepte », avant toute attente (A10-2). */
  onAccept?: () => void;
}

/** Demandes en attente de la réponse de l'utilisateur (une seule pop-in pour toutes). */
let waiting: Waiting[] = [];
/** Écriture en cours de l'accord donné à l'instant : une lecture des fichiers l'attend. */
let savingAccept: Promise<boolean> | null = null;

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

/**
 * Réponse de la pop-in : `true` pour « J'accepte », `false` pour « Refuser » ou
 * fermer. Appelée dans le gestionnaire du clic : sur un accord, les actions
 * `onAccept` (ouvrir le sélecteur de fichiers) partent ici, de façon synchrone,
 * tant que le navigateur compte encore le clic comme un geste de l'utilisateur.
 */
export function answerHealthDataConsentRequest(accepted: boolean): void {
  const requests = waiting;
  waiting = [];
  const saving = accepted && requests.length > 0 ? saveAccept() : null;
  if (saving) {
    savingAccept = saving;
    void saving.finally(() => {
      if (savingAccept === saving) savingAccept = null;
    });
  }
  emit();
  for (const request of requests) {
    if (saving) request.onAccept?.();
    request.resolve(saving ?? false);
  }
}

async function saveAccept(): Promise<boolean> {
  try {
    await acceptHealthDataConsent();
    return true;
  } catch (error) {
    console.warn('[healthDataConsent] accept not saved', error);
    notify.error('Votre accord n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.');
    return false;
  }
}

function requestFromUser(onAccept?: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    waiting.push({ resolve, onAccept });
    if (waiting.length === 1) emit();
  });
}

/**
 * Vrai si l'utilisateur a donné son accord (déjà, ou à l'instant dans la
 * pop-in). Faux s'il refuse, ferme la pop-in, ou si l'accord n'a pas pu être
 * enregistré dans son compte.
 */
export async function ensureHealthDataConsent(): Promise<boolean> {
  return ensureConsent();
}

async function ensureConsent(onAccept?: () => void): Promise<boolean> {
  // Un accord donné à l'instant et en cours d'écriture : on attend son issue.
  if (savingAccept) return savingAccept;
  const userId = getSessionUserIdSync();
  const fresh = cached && cached.userId === userId && Date.now() - cached.at < CACHE_TTL_MS;
  const consent = fresh ? cached!.consent : await loadHealthDataConsent();
  if (isHealthDataConsentValid(consent)) return true;
  return requestFromUser(onAccept);
}

/**
 * Accord connu sans attendre le réseau : en mémoire (quel que soit son âge) ou
 * dans le miroir local du compte. Il suffit pour ouvrir le sélecteur de
 * fichiers ; la lecture des fichiers choisis revérifie par
 * `ensureHealthDataConsent()`, donc un retrait fait ailleurs l'emporte encore.
 */
function isHealthDataConsentKnown(): boolean {
  const userId = getSessionUserIdSync();
  if (!userId) return false;
  if (cached && cached.userId === userId) return isHealthDataConsentValid(cached.consent);
  return isHealthDataConsentValid(readHealthDataConsentMirror(userId));
}

/** Le clic qui a lancé la demande compte encore comme un geste de l'utilisateur. */
function userActivationLost(): boolean {
  const activation = (globalThis.navigator as (Navigator & { userActivation?: { isActive: boolean } }) | undefined)?.userActivation;
  return activation ? !activation.isActive : false;
}

/**
 * Lance `action` (ouvrir un sélecteur de fichiers .fit) une fois l'accord
 * acquis, toujours dans un geste de l'utilisateur : `input.click()` est ignoré
 * sans erreur quand le navigateur ne compte plus le clic, ce que WebKit fait
 * après environ 1 s d'attente réseau, Chromium après 5 s (A10-2, audit du
 * 2026-10-10).
 *  - Accord connu sur l'appareil : tout de suite, dans le clic.
 *  - Pop-in : dans le clic sur « J'accepte », avant l'écriture de l'accord.
 *  - Accord trouvé dans le compte après une lecture qui a fait perdre le
 *    geste : un toast « Choisir les fichiers » le redonne.
 * À appeler de façon synchrone dans le gestionnaire du clic.
 */
export function runWithHealthDataConsent(action: () => void): void {
  if (!savingAccept && isHealthDataConsentKnown()) {
    action();
    return;
  }
  let ran = false;
  const runOnce = () => {
    if (ran) return;
    ran = true;
    action();
  };
  void ensureConsent(runOnce).then((accepted) => {
    if (!accepted || ran) return;
    if (!userActivationLost()) {
      runOnce();
      return;
    }
    notify.prompt('Accord enregistré : choisissez vos fichiers .fit.', undefined, {
      actionLabel: 'Choisir les fichiers',
      onAction: runOnce,
      durationMs: 15_000,
    });
  });
}
