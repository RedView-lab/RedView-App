/**
 * Garde vie privée appliqué à toute donnée d'événement avant l'envoi (appels
 * typés comme clics `data-umami-event-*`) : la mesure ne transporte que des
 * catégories, des tranches et des valeurs arrondies. Un e-mail, un id (Appwrite,
 * UUID) ou un texte libre qui passerait par erreur est remplacé, pas envoyé.
 */

type AnalyticsValue = string | number | boolean;
export type AnalyticsData = Record<string, AnalyticsValue>;

export const REDACTED = 'redacted';

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;
const MAX_KEYS = 30;
const MAX_STRING_LENGTH = 64;
const EMAIL_PATTERN = /@/;
// Ids Appwrite (20 caractères hexadécimaux), UUID, jetons et secrets.
const HEX_ID_PATTERN = /[0-9a-f]{16,}/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_-]{32,}/;

function isSafeAnalyticsString(value: string): boolean {
  return value.length <= MAX_STRING_LENGTH
    && !EMAIL_PATTERN.test(value)
    && !HEX_ID_PATTERN.test(value)
    && !UUID_PATTERN.test(value)
    && !LONG_TOKEN_PATTERN.test(value);
}

export interface SanitizedAnalyticsData {
  data: AnalyticsData | undefined;
  /** Clés dont la valeur a été remplacée ou retirée (avertissement en dev). */
  rejected: string[];
}

export function sanitizeAnalyticsData(input: unknown): SanitizedAnalyticsData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { data: undefined, rejected: [] };
  const data: AnalyticsData = {};
  const rejected: string[] = [];
  let count = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    if (!KEY_PATTERN.test(key) || count >= MAX_KEYS) {
      rejected.push(key);
      continue;
    }
    if (typeof raw === 'boolean') {
      data[key] = raw;
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        rejected.push(key);
        continue;
      }
      // Umami garde 4 décimales.
      data[key] = Math.round(raw * 1e4) / 1e4;
    } else if (typeof raw === 'string') {
      const value = raw.trim();
      if (isSafeAnalyticsString(value)) {
        data[key] = value;
      } else {
        data[key] = REDACTED;
        rejected.push(key);
      }
    } else {
      rejected.push(key);
      continue;
    }
    count += 1;
  }
  return { data: count > 0 ? data : undefined, rejected };
}
