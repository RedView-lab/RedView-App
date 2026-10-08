import type Stripe from 'stripe';

import { PublicError } from '../errors.js';
import { getStripeServer } from '../stripe.js';
import {
  BILLING_CURRENCY,
  BILLING_PLANS,
  getBillingPlan,
  planIdForLookupKey,
  type BillingPlanId,
} from './plans.js';

// ---------------------------------------------------------------------------
// Prix Stripe de la grille, retrouvés par `lookup_key` et gardés 10 min en
// mémoire. Un prix dont le montant ou la récurrence ne correspond pas à la
// grille est refusé : l'app afficherait un montant et Stripe en prélèverait
// un autre.
// ---------------------------------------------------------------------------

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

export type CatalogPrices = {
  productId: string;
  prices: Record<BillingPlanId, Stripe.Price>;
};

let cached: { value: CatalogPrices; expiresAt: number; key: string } | null = null;
let pending: Promise<CatalogPrices> | null = null;

/** Écart entre un prix Stripe et la grille, ou null s'il correspond. */
export function describePriceMismatch(planId: BillingPlanId, price: Stripe.Price): string | null {
  const plan = getBillingPlan(planId);
  if (!price.active) return 'inactive';
  if (price.currency !== BILLING_CURRENCY) return `currency ${price.currency}`;
  if (price.unit_amount !== plan.amountCents) return `amount ${price.unit_amount}`;
  if (price.type !== 'recurring' || !price.recurring) return 'not recurring';
  if (price.recurring.interval !== plan.interval || price.recurring.interval_count !== plan.intervalCount) {
    return `interval ${price.recurring.interval_count} ${price.recurring.interval}`;
  }
  if (price.recurring.usage_type !== 'licensed') return 'metered';
  return null;
}

async function loadCatalogPrices(): Promise<CatalogPrices> {
  const result = await getStripeServer().prices.list({
    lookup_keys: BILLING_PLANS.map((plan) => plan.lookupKey),
    active: true,
    limit: BILLING_PLANS.length,
  });

  const prices: Partial<Record<BillingPlanId, Stripe.Price>> = {};
  for (const price of result.data) {
    const planId = planIdForLookupKey(price.lookup_key);
    if (planId) prices[planId] = price;
  }

  const productIds = new Set<string>();
  for (const plan of BILLING_PLANS) {
    const price = prices[plan.id];
    const mismatch = price ? describePriceMismatch(plan.id, price) : 'missing';
    if (mismatch) {
      // Détail dans les journaux seulement ; le client reçoit un 503 générique.
      console.error(`[billing] Stripe price for ${plan.lookupKey} unusable: ${mismatch}. Run scripts/billing/setup-stripe.ts.`);
      throw new PublicError('Subscriptions are temporarily unavailable.', 503);
    }
    productIds.add(typeof price!.product === 'string' ? price!.product : price!.product.id);
  }
  if (productIds.size !== 1) {
    console.error('[billing] The three plan prices must belong to a single Stripe product.');
    throw new PublicError('Subscriptions are temporarily unavailable.', 503);
  }

  return { productId: [...productIds][0], prices: prices as Record<BillingPlanId, Stripe.Price> };
}

export async function getCatalogPrices(): Promise<CatalogPrices> {
  // Le cache suit la clé secrète : passer du bac à sable à la production
  // (ou l'inverse) ne réutilise jamais les prix de l'autre compte.
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.value;
  pending ??= loadCatalogPrices()
    .then((value) => {
      cached = { value, expiresAt: Date.now() + PRICE_CACHE_TTL_MS, key };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export async function getPlanPrice(planId: BillingPlanId): Promise<Stripe.Price> {
  return (await getCatalogPrices()).prices[planId];
}

/**
 * Formule d'un prix d'abonnement. La `lookup_key` suffit tant que le prix la
 * porte ; un ancien prix qui l'a cédée (montant changé) est reconnu par la
 * métadonnée `plan_id` que le script pose sur chaque prix.
 */
export function planIdForPrice(price: Stripe.Price | null | undefined): BillingPlanId | null {
  if (!price) return null;
  const fromLookup = planIdForLookupKey(price.lookup_key);
  if (fromLookup) return fromLookup;
  const fromMetadata = price.metadata?.plan_id;
  return fromMetadata === 'monthly' || fromMetadata === 'semiannual' || fromMetadata === 'annual'
    ? fromMetadata
    : null;
}

// Prix déjà résolus (identifiant → formule) : une poignée de prix par compte
// Stripe, borné pour la forme.
const MAX_RESOLVED_PRICE_IDS = 64;
const resolvedPriceIds = new Map<string, BillingPlanId | null>();

/** Formule d'un identifiant de prix stocké (ligne `subscriptions`). */
export async function planIdForPriceId(priceId: string | null | undefined): Promise<BillingPlanId | null> {
  if (!priceId) return null;
  if (resolvedPriceIds.has(priceId)) return resolvedPriceIds.get(priceId) ?? null;

  let planId: BillingPlanId | null = null;
  try {
    const catalog = await getCatalogPrices();
    const match = BILLING_PLANS.find((plan) => catalog.prices[plan.id].id === priceId);
    planId = match?.id ?? planIdForPrice(await getStripeServer().prices.retrieve(priceId));
  } catch (error) {
    // Affichage seulement : la formule reste inconnue, l'état de l'abonnement est juste.
    console.warn('[billing] Unable to resolve the plan of a price', error);
    return null;
  }

  if (resolvedPriceIds.size >= MAX_RESOLVED_PRICE_IDS) resolvedPriceIds.clear();
  resolvedPriceIds.set(priceId, planId);
  return planId;
}

/** Pour les tests : oublie les prix gardés en mémoire. */
export function resetCatalogPriceCache(): void {
  cached = null;
  pending = null;
  resolvedPriceIds.clear();
}
