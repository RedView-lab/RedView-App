/**
 * Consentement explicite au traitement des données de santé des fichiers .fit
 * (trace GPS, fréquence cardiaque, puissance, cadence) — RGPD art. 9 § 2 a).
 *
 * Fonctions pures et miroir local : le consentement vit dans les préférences
 * du compte Appwrite (`prefs.healthDataConsent`), recopié dans le
 * `localStorage` par compte pour le mode hors ligne. Il est versionné : changer
 * le texte présenté demande d'augmenter `HEALTH_DATA_CONSENT_VERSION`, et un
 * consentement d'une autre version ne vaut plus (on redemande).
 */

/** Version du texte du consentement : à augmenter quand le texte change. */
export const HEALTH_DATA_CONSENT_VERSION = 1;

export interface HealthDataConsent {
  /** Version du texte accepté. */
  version: number;
  /** Date d'acceptation (ISO 8601). */
  acceptedAt: string;
}

const MIRROR_PREFIX = 'redview:health-data-consent:';

/** Lit un consentement stocké (préférences ou miroir) ; null s'il est absent ou mal formé. */
export function parseHealthDataConsent(value: unknown): HealthDataConsent | null {
  if (!value || typeof value !== 'object') return null;
  const { version, acceptedAt } = value as { version?: unknown; acceptedAt?: unknown };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (typeof acceptedAt !== 'string' || Number.isNaN(Date.parse(acceptedAt))) return null;
  return { version, acceptedAt };
}

/** Le consentement couvre le texte actuel. */
export function isHealthDataConsentValid(
  consent: HealthDataConsent | null | undefined,
  currentVersion = HEALTH_DATA_CONSENT_VERSION,
): consent is HealthDataConsent {
  return consent != null && consent.version === currentVersion;
}

export function createHealthDataConsent(now: Date = new Date()): HealthDataConsent {
  return { version: HEALTH_DATA_CONSENT_VERSION, acceptedAt: now.toISOString() };
}

/** Clé du miroir local d'un compte. */
export function healthDataConsentMirrorKey(userId: string): string {
  return `${MIRROR_PREFIX}${userId}`;
}

export function readHealthDataConsentMirror(userId: string, storage: Storage | null = safeLocalStorage()): HealthDataConsent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(healthDataConsentMirrorKey(userId));
    return raw ? parseHealthDataConsent(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeHealthDataConsentMirror(
  userId: string,
  consent: HealthDataConsent | null,
  storage: Storage | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    if (consent) storage.setItem(healthDataConsentMirrorKey(userId), JSON.stringify(consent));
    else storage.removeItem(healthDataConsentMirrorKey(userId));
  } catch {
    // Au mieux seulement : le consentement du compte fait foi.
  }
}

/**
 * Consentement à retenir : celui du compte fait foi dès qu'il est lisible (un
 * retrait fait sur un autre appareil l'emporte sur le miroir) ; le miroir ne
 * sert que hors ligne. Accepter et retirer passent toujours par le compte.
 */
export function resolveHealthDataConsent(input: {
  account: HealthDataConsent | null;
  accountReadable: boolean;
  mirror: HealthDataConsent | null;
}): HealthDataConsent | null {
  return input.accountReadable ? input.account : input.mirror;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
