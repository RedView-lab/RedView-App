import { readDocumentAppLocale } from '@/shared/i18n';

import type { SubscriptionPlanId } from '../../types';

// ---------------------------------------------------------------------------
// Grille tarifaire affichée : un seul abonnement, trois durées, 7 jours
// d'essai. Copie de la référence serveur (api/_lib/billing/plans.ts) — le
// test `plans.test.ts` vérifie qu'elles ne divergent jamais : l'app afficherait
// un montant et Stripe en prélèverait un autre.
// ---------------------------------------------------------------------------

export type DisplayPlan = {
  id: SubscriptionPlanId;
  /** Libellé de durée, en capitales dans la carte (« 1 MOIS »). */
  durationLabel: string;
  amountCents: number;
  months: number;
};

export const TRIAL_DAYS = 7;

export const DISPLAY_PLANS: readonly DisplayPlan[] = [
  { id: 'monthly', durationLabel: '1 mois', amountCents: 1490, months: 1 },
  { id: 'semiannual', durationLabel: '6 mois', amountCents: 7000, months: 6 },
  { id: 'annual', durationLabel: '1 an', amountCents: 11900, months: 12 },
];

export function getDisplayPlan(planId: SubscriptionPlanId): DisplayPlan {
  return DISPLAY_PLANS.find((plan) => plan.id === planId) ?? DISPLAY_PLANS[0];
}

/** Prix mensuel équivalent, en centimes (arrondi au centime : 70 € / 6 = 11,67 €). */
export function monthlyEquivalentCents(plan: DisplayPlan): number {
  return Math.round(plan.amountCents / plan.months);
}

/**
 * Réduction par rapport au mois sans engagement, en pour cent entier
 * (6 mois : 70 € contre 6 × 14,90 € = 89,40 € → 22 %). 0 pour le mensuel.
 */
export function discountPercent(plan: DisplayPlan): number {
  const monthly = DISPLAY_PLANS[0];
  const fullPrice = monthly.amountCents * plan.months;
  if (plan.months <= monthly.months || fullPrice <= 0) return 0;
  return Math.round((1 - plan.amountCents / fullPrice) * 100);
}

/** Montant en euros dans la langue de l'app : « 14,90 € », « 70 € » (pas de décimales inutiles). */
export function formatEuros(cents: number): string {
  const locale = readDocumentAppLocale() === 'en' ? 'en-IE' : 'fr-FR';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** Montant seul, sans symbole : le symbole est dessiné plus petit à côté dans la carte. */
export function formatEuroAmount(cents: number): string {
  const locale = readDocumentAppLocale() === 'en' ? 'en-IE' : 'fr-FR';
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** Date longue (« 15 octobre 2026 ») pour les échéances. */
export function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = readDocumentAppLocale() === 'en' ? 'en-GB' : 'fr-FR';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** Date du premier prélèvement d'un essai qui commence maintenant. */
export function trialEndDate(now: Date = new Date()): string {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
