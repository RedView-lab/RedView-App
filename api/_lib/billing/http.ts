import type { ApiRequest } from '../types.js';
import { getAppBaseUrl } from '../config.js';
import { PublicError } from '../errors.js';

const ALLOWED_ORIGIN = /^https?:\/\/(?:(?:[a-zA-Z0-9-]+\.)*redview\.tech|localhost|127\.0\.0\.1)(?::\d+)?$/;

/**
 * Page où Stripe ramène l'utilisateur (portail, paiement par redirection) :
 * l'onglet Abonnement de l'origine qui a fait la demande quand elle est à
 * nous (serveur de dev compris), sinon l'URL publique de l'app.
 */
export function billingReturnUrl(req: ApiRequest): string {
  const origin = req.headers.origin;
  const base = typeof origin === 'string' && ALLOWED_ORIGIN.test(origin) ? origin : getAppBaseUrl(req);
  return `${base.replace(/\/+$/, '')}/?tab=subscription`;
}

/** Lien « gérer mon abonnement » des e-mails (hors requête : URL publique). */
export function billingManageUrl(): string {
  const base = process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech';
  return `${base.replace(/\/+$/, '')}/?tab=subscription`;
}

/**
 * Erreurs Stripe attendues → réponses claires. Un identifiant inconnu (fourni
 * par le client) n'est pas une panne ; un refus de carte se montre tel quel
 * (Stripe rédige ces messages pour l'utilisateur final). Le reste reste une
 * erreur interne, journalisée et remontée à GlitchTip.
 */
export function toBillingError(error: unknown): unknown {
  const candidate = error as { type?: unknown; code?: unknown; message?: unknown } | null;
  if (candidate?.type === 'StripeCardError' && typeof candidate.message === 'string') {
    return new PublicError(candidate.message, 402);
  }
  if (candidate?.type === 'StripeInvalidRequestError' && candidate.code === 'resource_missing') {
    return new PublicError('Billing object not found.', 404);
  }
  return error;
}
