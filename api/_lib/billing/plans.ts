// ---------------------------------------------------------------------------
// Grille tarifaire : un seul abonnement RedView, trois durées. Référence pour
// le serveur et pour `scripts/billing/setup-stripe.ts`, qui crée le produit et
// ses prix dans Stripe ; l'app affiche la même grille
// (`src/features/projectBrowser/lib/billing/plans.ts`, test de parité).
//
// Les prix Stripe sont retrouvés par `lookup_key`, jamais par identifiant :
// le même code tourne sur le bac à sable et en production, et changer un
// montant = un nouveau prix qui reprend la clé (`transfer_lookup_key`).
// ---------------------------------------------------------------------------

export type BillingPlanId = 'monthly' | 'semiannual' | 'annual';

export type BillingPlan = {
  id: BillingPlanId;
  lookupKey: string;
  /** Montant TTC prélevé à chaque échéance, en centimes d'euro. */
  amountCents: number;
  interval: 'month' | 'year';
  intervalCount: number;
  /** Durée d'une échéance en mois (calcul du prix mensuel équivalent). */
  months: number;
};

export const BILLING_CURRENCY = 'eur';

/** Essai gratuit à la première souscription d'un client (jamais deux fois). */
export const TRIAL_DAYS = 7;

export const BILLING_PRODUCT_LOOKUP = {
  name: 'RedView',
  /** Métadonnée qui identifie le produit dans Stripe (le script le retrouve par elle). */
  metadataKey: 'redview_product',
  metadataValue: 'subscription',
} as const;

export const BILLING_PLANS: readonly BillingPlan[] = [
  { id: 'monthly', lookupKey: 'redview_monthly', amountCents: 1490, interval: 'month', intervalCount: 1, months: 1 },
  { id: 'semiannual', lookupKey: 'redview_semiannual', amountCents: 7000, interval: 'month', intervalCount: 6, months: 6 },
  { id: 'annual', lookupKey: 'redview_annual', amountCents: 11900, interval: 'year', intervalCount: 1, months: 12 },
];

export function isBillingPlanId(value: unknown): value is BillingPlanId {
  return value === 'monthly' || value === 'semiannual' || value === 'annual';
}

export function getBillingPlan(planId: BillingPlanId): BillingPlan {
  const plan = BILLING_PLANS.find((entry) => entry.id === planId);
  if (!plan) throw new Error(`Unknown billing plan ${planId}`);
  return plan;
}

export function planIdForLookupKey(lookupKey: string | null | undefined): BillingPlanId | null {
  return BILLING_PLANS.find((plan) => plan.lookupKey === lookupKey)?.id ?? null;
}
