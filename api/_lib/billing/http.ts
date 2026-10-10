import type { ApiRequest } from '../types.js';
import { getAppBaseUrl } from '../config.js';
import { PublicError } from '../errors.js';

/**
 * Origines où Stripe peut ramener l'utilisateur : l'app seulement, en https
 * (un sous-domaine oublié ou repris devenait une destination de redirection
 * depuis le portail Stripe, A2-3), et le serveur de dev hors production.
 */
const APP_ORIGINS = new Set(['https://app.redview.tech']);
const DEV_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function isAllowedBillingOrigin(origin: string): boolean {
  if (APP_ORIGINS.has(origin)) return true;
  return process.env.NODE_ENV !== 'production' && DEV_ORIGIN.test(origin);
}

/**
 * Page où Stripe ramène l'utilisateur (portail, paiement par redirection) :
 * l'onglet Abonnement de l'origine qui a fait la demande quand elle est à
 * nous (serveur de dev compris), sinon l'URL publique de l'app.
 */
export function billingReturnUrl(req: ApiRequest): string {
  const origin = req.headers.origin;
  const base = typeof origin === 'string' && isAllowedBillingOrigin(origin) ? origin : getAppBaseUrl(req);
  return `${base.replace(/\/+$/, '')}/?tab=subscription`;
}

/** Lien « gérer mon abonnement » des e-mails (hors requête : URL publique). */
export function billingManageUrl(): string {
  const base = process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech';
  return `${base.replace(/\/+$/, '')}/?tab=subscription`;
}

/** Stripe injoignable, en panne ou qui nous limite : rien à corriger chez RedView. */
const STRIPE_UNAVAILABLE_TYPES = new Set(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']);

/**
 * Erreurs Stripe attendues → réponses claires. Un identifiant inconnu (fourni
 * par le client) n'est pas une panne ; un refus de carte se montre tel quel
 * (Stripe rédige ces messages pour l'utilisateur final) ; Stripe injoignable
 * ou en panne donne 503 (la personne peut réessayer — c'était un 500 « erreur
 * interne », trouvé par bench:api-fuzz). Le reste reste une erreur interne,
 * journalisée et remontée à GlitchTip.
 */
export function toBillingError(error: unknown): unknown {
  const candidate = error as { type?: unknown; code?: unknown; message?: unknown } | null;
  if (typeof candidate?.type === 'string' && STRIPE_UNAVAILABLE_TYPES.has(candidate.type)) {
    return new PublicError('The payment service is temporarily unavailable. Try again in a moment.', 503);
  }
  if (candidate?.type === 'StripeCardError' && typeof candidate.message === 'string') {
    return new PublicError(candidate.message, 402);
  }
  if (candidate?.type === 'StripeInvalidRequestError' && candidate.code === 'resource_missing') {
    return new PublicError('Billing object not found.', 404);
  }
  return error;
}
