import type Stripe from 'stripe';

import { PublicError } from '../errors.js';
import { getStripeServer } from '../stripe.js';
import { getStripeCustomerId } from './customers.js';
import { BILLING_PLANS, type BillingPlanId } from './plans.js';
import { getCatalogPrices } from './prices.js';
import { getLiveStripeSubscription } from './subscriptions.js';

// ---------------------------------------------------------------------------
// Portail client Stripe : factures, moyens de paiement, coordonnées de
// facturation, et changement de durée (aperçu du prorata, paiement et 3-D
// Secure gérés par Stripe). La configuration est créée par ce code, jamais à
// la main dans le Dashboard : elle est retrouvée par sa métadonnée et remise
// d'accord avec les prix de la grille quand ils changent.
//
// La résiliation reste dans l'app (bouton « Résilier votre contrat »,
// art. L.215-1-1 du Code de la consommation) ; le portail la propose aussi,
// à la fin de l'échéance.
// ---------------------------------------------------------------------------

type PortalFeatures = Parameters<Stripe['billingPortal']['configurations']['create']>[0]['features'];
type PortalFlowData = NonNullable<NonNullable<Parameters<Stripe['billingPortal']['sessions']['create']>[0]>['flow_data']>;

const PORTAL_METADATA_KEY = 'redview_portal';
const PORTAL_METADATA_VERSION = '1';
const PORTAL_CACHE_TTL_MS = 10 * 60 * 1000;

let cachedConfiguration: { id: string; key: string; expiresAt: number } | null = null;

function portalFeatures(productId: string, priceIds: string[]): PortalFeatures {
  return {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: {
        enabled: true,
        options: ['too_expensive', 'missing_features', 'unused', 'switched_service', 'too_complex', 'other'],
      },
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      products: [{ product: productId, prices: priceIds }],
      // Changement immédiat, différence facturée tout de suite (prorata).
      // Pas de `schedule_at_period_end` : il attacherait un échéancier à
      // l'abonnement, que la résiliation en app ne saurait plus modifier.
      proration_behavior: 'always_invoice',
      // Changer de durée pendant l'essai garde les jours d'essai restants.
      trial_update_behavior: 'continue_trial',
    },
  };
}

export async function ensurePortalConfiguration(returnUrl: string): Promise<string> {
  const catalog = await getCatalogPrices();
  const priceIds = BILLING_PLANS.map((plan) => catalog.prices[plan.id].id);
  const pricesKey = priceIds.join(',');
  const cacheKey = `${process.env.STRIPE_SECRET_KEY?.trim() ?? ''}|${pricesKey}`;
  if (cachedConfiguration && cachedConfiguration.key === cacheKey && cachedConfiguration.expiresAt > Date.now()) {
    return cachedConfiguration.id;
  }

  const stripe = getStripeServer();
  const existing = (await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data.find(
    (configuration) => configuration.metadata?.[PORTAL_METADATA_KEY] === PORTAL_METADATA_VERSION,
  );
  const params = {
    business_profile: { headline: 'RedView — gérez votre abonnement' },
    default_return_url: returnUrl,
    features: portalFeatures(catalog.productId, priceIds),
    metadata: { [PORTAL_METADATA_KEY]: PORTAL_METADATA_VERSION, prices: pricesKey },
  };

  let id: string;
  if (!existing) {
    id = (await stripe.billingPortal.configurations.create(params)).id;
  } else if (existing.metadata?.prices !== pricesKey) {
    id = (await stripe.billingPortal.configurations.update(existing.id, params)).id;
  } else {
    id = existing.id;
  }

  cachedConfiguration = { id, key: cacheKey, expiresAt: Date.now() + PORTAL_CACHE_TTL_MS };
  return id;
}

/**
 * Session du portail. Avec `planId`, le client arrive directement sur la
 * confirmation du passage à cette durée, puis revient sur `returnUrl`.
 */
export async function createBillingPortalSession(
  userId: string,
  returnUrl: string,
  planId: BillingPlanId | null,
): Promise<string> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new PublicError('No billing profile found for this account.', 404);
  const configuration = await ensurePortalConfiguration(returnUrl);

  let flowData: PortalFlowData | undefined;
  if (planId) {
    const [subscription, catalog] = await Promise.all([getLiveStripeSubscription(userId), getCatalogPrices()]);
    const item = subscription?.items.data[0];
    if (!subscription || !item) throw new PublicError('No subscription found for this account.', 404);
    const price = catalog.prices[planId];
    if (item.price.id === price.id) throw new PublicError('This plan is already active.', 409);
    flowData = {
      type: 'subscription_update_confirm',
      subscription_update_confirm: { subscription: subscription.id, items: [{ id: item.id, price: price.id }] },
      after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
    };
  }

  const session = await getStripeServer().billingPortal.sessions.create({
    customer: customerId,
    configuration,
    return_url: returnUrl,
    locale: 'auto',
    ...(flowData ? { flow_data: flowData } : {}),
  });
  return session.url;
}
