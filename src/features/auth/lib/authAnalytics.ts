import {
  accountAgeBucket,
  setAnalyticsContext,
  trackAnalyticsEvent,
  type AuthFailureReason,
  type AuthMethod,
} from '@/shared/lib/analytics';
import { ApiNetworkError } from '@/shared/lib/apiFetch';

/**
 * Mesure de la connexion Google : la page quitte l'app pour Google puis revient
 * (OAuth). L'intention est notée au clic, l'issue est décidée au retour, sur la
 * date d'inscription du compte : créé à l'instant → inscription, sinon
 * connexion (le clic seul ne prouve ni l'une ni l'autre).
 */

const OAUTH_INTENT_KEY = 'rv:auth-intent';
const INTENT_MAX_AGE_MS = 30 * 60 * 1000;
const NEW_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/** Libellé Appwrite des comptes de l'équipe et de test : exclus de la mesure (et du rapport d'activation). */
const INTERNAL_ACCOUNT_LABEL = 'internal';

interface OAuthIntent {
  method: AuthMethod;
  at: number;
}

export function rememberOAuthIntent(method: AuthMethod, now = Date.now()): void {
  try {
    sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify({ method, at: now } satisfies OAuthIntent));
  } catch {
    /* stockage bloqué : le retour ne sera pas compté */
  }
}

function takeOAuthIntent(): OAuthIntent | null {
  try {
    const raw = sessionStorage.getItem(OAUTH_INTENT_KEY);
    sessionStorage.removeItem(OAUTH_INTENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<OAuthIntent>) : null;
    if (parsed?.method !== 'google' && parsed?.method !== 'email') return null;
    return typeof parsed.at === 'number' ? { method: parsed.method, at: parsed.at } : null;
  } catch {
    return null;
  }
}

/** Issue d'un retour OAuth (pure, testée). */
export function resolveOAuthCompletion(
  intent: OAuthIntent | null,
  registeredAt: string | null | undefined,
  now = Date.now(),
): { name: 'signup_completed' | 'login_completed'; method: AuthMethod } | null {
  if (!intent || now - intent.at > INTENT_MAX_AGE_MS || now < intent.at) return null;
  const registered = registeredAt ? Date.parse(registeredAt) : Number.NaN;
  const isNew = Number.isFinite(registered) && now - registered < NEW_ACCOUNT_WINDOW_MS;
  return { name: isNew ? 'signup_completed' : 'login_completed', method: intent.method };
}

/**
 * Session connue : contexte de compte de la mesure (ancienneté par tranche,
 * compte interne) et issue d'un retour OAuth en attente.
 */
export function syncAnalyticsAccount(user: { registration?: string; $createdAt?: string; labels?: string[] }): void {
  const registeredAt = user.registration || user.$createdAt;
  setAnalyticsContext({
    account_age: accountAgeBucket(registeredAt),
    internal: Array.isArray(user.labels) && user.labels.includes(INTERNAL_ACCOUNT_LABEL),
  });
  const completion = resolveOAuthCompletion(takeOAuthIntent(), registeredAt);
  if (completion) trackAnalyticsEvent({ name: completion.name, data: { method: completion.method } });
}

/** Catégorie d'un échec de connexion / inscription (jamais le message, qui peut citer l'adresse). */
export function authFailureReason(error: unknown): AuthFailureReason {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 401 || code === 400) return 'credentials';
  if (code === 409) return 'exists';
  if (code === 429) return 'rate_limited';
  if (error instanceof TypeError || error instanceof ApiNetworkError || code === 0) return 'network';
  return 'other';
}
