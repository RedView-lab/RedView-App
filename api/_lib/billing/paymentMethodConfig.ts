import type Stripe from 'stripe';

import { getStripeServer } from '../stripe.js';

// ---------------------------------------------------------------------------
// Moyens de paiement proposés à la souscription. Sans configuration dédiée,
// un SetupIntent (qui n'a pas de devise) propose tout ce que le compte a
// activé : le bac à sable ouvrait le formulaire sur BLIK, puis Pix, Klarna…
// La configuration « RedView abonnements » (créée par
// scripts/billing/setup-stripe.ts) ne garde que les moyens adaptés à un
// prélèvement récurrent en euros ; ceux que le compte n'a pas encore activés
// (PayPal, SEPA) apparaissent d'eux-mêmes une fois activés dans le Dashboard.
// ---------------------------------------------------------------------------

export const PAYMENT_METHOD_CONFIGURATION_NAME = 'RedView abonnements';

/**
 * Moyens voulus pour un abonnement en euros, dans l'ordre d'affichage. Pas de
 * Link : son encart « Enregistrer mes informations » (e-mail, téléphone, nom)
 * se déplie à la fin de la saisie de la carte et décale le bouton de
 * validation sous le curseur — le premier clic tombait à côté (E2E navigateur).
 */
export const SUBSCRIPTION_PAYMENT_METHODS = ['card', 'paypal', 'sepa_debit'] as const;

type SubscriptionPaymentMethod = (typeof SUBSCRIPTION_PAYMENT_METHODS)[number];

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { value: ResolvedConfiguration | null; key: string; expiresAt: number } | null = null;

type ResolvedConfiguration = { id: string; available: SubscriptionPaymentMethod[] };

function availableMethods(configuration: Stripe.PaymentMethodConfiguration): SubscriptionPaymentMethod[] {
  return SUBSCRIPTION_PAYMENT_METHODS.filter((method) => {
    const entry = (configuration as unknown as Record<string, { available?: boolean } | undefined>)[method];
    return entry?.available === true;
  });
}

/** Configuration dédiée, ou null si le script ne l'a pas encore créée (repli : celle du compte). */
export async function getSubscriptionPaymentMethodConfiguration(): Promise<ResolvedConfiguration | null> {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.value;

  const list = await getStripeServer().paymentMethodConfigurations.list({ limit: 100 });
  const configuration = list.data.find((entry) => entry.name === PAYMENT_METHOD_CONFIGURATION_NAME && entry.active);
  const value = configuration ? { id: configuration.id, available: availableMethods(configuration) } : null;
  if (!value) console.warn('[billing] No dedicated payment method configuration: run scripts/billing/setup-stripe.ts.');

  cached = { value, key, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Paramètre `payment_method_configuration` d'un SetupIntent. */
export async function setupIntentPaymentMethodParams(): Promise<{ payment_method_configuration?: string }> {
  const configuration = await getSubscriptionPaymentMethodConfiguration();
  return configuration ? { payment_method_configuration: configuration.id } : {};
}

/**
 * Types de moyens de paiement de la première facture d'un abonnement payé
 * sans essai (les abonnements ne prennent pas de configuration) : les mêmes
 * que la configuration, carte au minimum.
 */
export async function subscriptionPaymentMethodTypes(): Promise<SubscriptionPaymentMethod[] | null> {
  const configuration = await getSubscriptionPaymentMethodConfiguration();
  if (!configuration) return null;
  return configuration.available.length > 0 ? configuration.available : ['card'];
}
