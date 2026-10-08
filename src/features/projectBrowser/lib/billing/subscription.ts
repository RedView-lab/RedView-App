import { translateAppText } from '@/shared/i18n';

import type { BillingContactPreference, SubscriptionSnapshot } from '../../types';
import { formatLongDate, getDisplayPlan } from './plans';

export const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'https://redview.tech';

const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

function getBillingContactStorageKey(userId: string | null | undefined): string | null {
  return userId ? `redview:billing-contact:${userId}` : null;
}

export function readBillingContactPreference(userId: string | null | undefined): BillingContactPreference {
  const key = getBillingContactStorageKey(userId);
  if (!key) return DEFAULT_CONTACT_PREFERENCE;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_CONTACT_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<BillingContactPreference>;
    return {
      mode: parsed.mode === 'alternative' ? 'alternative' : 'account',
      alternativeEmail: typeof parsed.alternativeEmail === 'string' ? parsed.alternativeEmail : '',
    };
  } catch {
    return DEFAULT_CONTACT_PREFERENCE;
  }
}

export function writeBillingContactPreference(
  userId: string | null | undefined,
  preference: BillingContactPreference,
) {
  const key = getBillingContactStorageKey(userId);
  if (!key) return;

  try {
    window.localStorage.setItem(key, JSON.stringify(preference));
  } catch {
    // Confort seulement : la préférence fait foi côté serveur.
  }
}

/** Statuts Stripe d'un abonnement encore en cours (même en impayé). */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

/** Le compte a un abonnement en cours : on gère, on ne souscrit plus. */
export function hasLiveSubscription(snapshot: SubscriptionSnapshot | null): boolean {
  return Boolean(snapshot && LIVE_STATUSES.has(snapshot.status));
}

function isTrialing(snapshot: SubscriptionSnapshot | null): boolean {
  return snapshot?.status === 'trialing';
}

/** Impayé que Stripe relance : le moyen de paiement doit être remplacé. */
export function hasPaymentIssue(snapshot: SubscriptionSnapshot | null): boolean {
  return snapshot?.status === 'past_due' || snapshot?.status === 'unpaid';
}

/** Libellé du compte dans l'en-tête du gestionnaire de projets. */
export function accountTierLabel(snapshot: SubscriptionSnapshot | null, isLoading: boolean): string {
  if (isLoading) return translateAppText('Compte');
  if (!hasLiveSubscription(snapshot)) return translateAppText('Accès Bêta');
  if (isTrialing(snapshot)) return translateAppText('Essai gratuit');
  return translateAppText('Abonné RedView');
}

/** Formule pour le contexte des statistiques (jamais l'abonnement lui-même). */
export function analyticsPlanOf(snapshot: SubscriptionSnapshot | null): string {
  if (!hasLiveSubscription(snapshot)) return 'demo';
  return snapshot?.planId ?? 'unknown';
}

/** Phrase d'état de l'abonnement en cours. */
export function subscriptionStatusLine(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot || !hasLiveSubscription(snapshot)) return '';
  const date = formatLongDate(snapshot.currentPeriodEnd);
  const plan = snapshot.planId ? getDisplayPlan(snapshot.planId) : null;
  const durationLabel = plan ? translateAppText(plan.durationLabel) : '';

  if (hasPaymentIssue(snapshot)) {
    return translateAppText('Le dernier paiement a échoué. Mettez à jour votre moyen de paiement pour garder votre accès.');
  }
  if (snapshot.cancelAtPeriodEnd) {
    return snapshot.status === 'trialing'
      ? translateAppText('Résilié : votre essai prend fin le {{date}}, aucun prélèvement ne sera effectué.', { date })
      : translateAppText('Résilié : votre abonnement prend fin le {{date}}. Vous gardez l’accès jusqu’à cette date.', { date });
  }
  if (snapshot.status === 'trialing') {
    return translateAppText('Essai gratuit jusqu’au {{date}}. Premier prélèvement ce jour-là, sauf résiliation avant.', { date });
  }
  return plan
    ? translateAppText('Formule {{plan}}, renouvelée automatiquement le {{date}}.', { plan: durationLabel, date })
    : translateAppText('Renouvellement automatique le {{date}}.', { date });
}
