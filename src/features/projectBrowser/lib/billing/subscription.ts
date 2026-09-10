import { translateAppText } from '@/shared/i18n';
import { formatShortDate } from '../formatting';
import type {
  BillingContactPreference,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from '../../types';

export const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000';

const PLAN_PRICE_IDS: Partial<Record<SubscriptionPlanId, string>> = {
  founder: import.meta.env.VITE_STRIPE_PRICE_ID_FOUNDER,
  founderMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_FOUNDER_MONTHLY,
  patron: import.meta.env.VITE_STRIPE_PRICE_ID_PATRON,
  patronMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_PATRON_MONTHLY,
  explorer: import.meta.env.VITE_STRIPE_PRICE_ID_EXPLORER,
  proCommit: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_COMMIT,
  proMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_MONTHLY,
};

export const FREE_BULLETS = [
  'Moteur 3D & LiDAR 20 cm illimités sur le web',
  'Simulation météo, vent, ensoleillement & neige',
  'Routage intelligent & export GPX illimité',
  'Accès complet sans carte bancaire',
];

export const FOUNDER_BULLETS = [
  'Tout l’Accès Web Bêta inclus',
  'Accès prioritaire à la future App Mobile (iOS TestFlight & Android)',
  'Statut Fondateur : -50% à vie sur les futurs abonnements',
  'Droit de vote sur les prochains massifs 3D modélisés',
  'Salon Discord privé & échanges directs avec le développeur',
  'Soutenez directement le développement indépendant',
];

export const PATRON_BULLETS = [
  'Tous les privilèges du Pass Fondateur inclus',
  '1 An de compte PRO offert au lancement de la v1',
  'Accès VIP ultra-prioritaire aux premières versions mobiles',
  'Votre nom ou pseudo sur la page officielle des Soutiens',
  'Contact direct pour proposer de nouvelles zones ou fonctionnalités',
];

export const YEARLY_PLANS: SubscriptionPlan[] = [
  {
    id: 'demo',
    name: 'Accès Bêta Web',
    priceLabel: '0 €',
    pricePrefix: '',
    priceValue: 0,
    priceSuffix: '/ gratuit sur le web pendant la Bêta',
    billingPeriod: 'yearly',
    iconSrc: '/images/pricing/plans/pro-icon.webp',
    iconAlt: 'Icône accès gratuit',
    bullets: FREE_BULLETS,
    tags: [],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Lancer l’exploration Web (0€)',
  },
  {
    id: 'founder',
    name: 'Pass Fondateur',
    priceLabel: '10 €',
    pricePrefix: '',
    priceValue: 10,
    priceSuffix: '/ paiement unique · avantages à vie',
    billingPeriod: 'yearly',
    iconSrc: '/images/pricing/plans/organization-icon.webp',
    iconAlt: 'Icône pass fondateur',
    bullets: FOUNDER_BULLETS,
    highlighted: true,
    tags: ['Recommandé'],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Devenir Membre Fondateur (10€)',
  },
  {
    id: 'patron',
    name: 'Mécène & Soutien Majeur',
    priceLabel: 'dès 30 €',
    pricePrefix: 'dès ',
    priceValue: 30,
    priceSuffix: '/ don libre de soutien',
    billingPeriod: 'yearly',
    iconSrc: '/images/pricing/plans/enterprise-icon.webp',
    iconAlt: 'Icône mécène don libre',
    bullets: PATRON_BULLETS,
    tags: [],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Devenir Mécène (dès 30€)',
  },
];

export const MONTHLY_PLANS: SubscriptionPlan[] = [
  {
    id: 'demo',
    name: 'Accès Bêta Web',
    priceLabel: '0 €',
    pricePrefix: '',
    priceValue: 0,
    priceSuffix: '/ gratuit sur le web pendant la Bêta',
    billingPeriod: 'monthly',
    iconSrc: '/images/pricing/plans/pro-icon.webp',
    iconAlt: 'Icône accès gratuit',
    bullets: FREE_BULLETS,
    tags: [],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Lancer l’exploration Web (0€)',
  },
  {
    id: 'founderMonthly',
    name: 'Pass Fondateur',
    priceLabel: '5 €',
    pricePrefix: '',
    priceValue: 5,
    priceSuffix: '/ par mois (soutien libre)',
    billingPeriod: 'monthly',
    iconSrc: '/images/pricing/plans/organization-icon.webp',
    iconAlt: 'Icône pass fondateur',
    bullets: FOUNDER_BULLETS,
    highlighted: true,
    tags: ['Soutien libre'],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Devenir Membre Fondateur (5€/mois)',
  },
  {
    id: 'patronMonthly',
    name: 'Mécène & Soutien Majeur',
    priceLabel: 'dès 15 €',
    pricePrefix: 'dès ',
    priceValue: 15,
    priceSuffix: '/ par mois (soutien pro)',
    billingPeriod: 'monthly',
    iconSrc: '/images/pricing/plans/enterprise-icon.webp',
    iconAlt: 'Icône mécène don libre',
    bullets: PATRON_BULLETS,
    tags: [],
    iconBadges: [],
    description: '',
    ctaDefaultLabel: 'Devenir Mécène (15€/mois)',
  },
];

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  ...YEARLY_PLANS,
  MONTHLY_PLANS[1],
  MONTHLY_PLANS[2],
];

export function getPlansForPeriod(period: 'yearly' | 'monthly'): SubscriptionPlan[] {
  return period === 'yearly' ? YEARLY_PLANS : MONTHLY_PLANS;
}

export const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

function getBillingContactStorageKey(userId: string | null | undefined): string | null {
  return userId ? `redview:billing-contact:${userId}` : null;
}

export function readBillingContactPreference(
  userId: string | null | undefined,
): BillingContactPreference {
  const key = getBillingContactStorageKey(userId);
  if (!key) return DEFAULT_CONTACT_PREFERENCE;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_CONTACT_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<BillingContactPreference>;
    return {
      mode: parsed.mode === 'alternative' ? 'alternative' : 'account',
      alternativeEmail:
        typeof parsed.alternativeEmail === 'string' ? parsed.alternativeEmail : '',
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
    // Best effort only.
  }
}

export function isDemoPlan(snapshot: SubscriptionSnapshot | null): boolean {
  if (!snapshot) return true;
  return snapshot.status === 'demo' || (!snapshot.isSubscribed && snapshot.status == null);
}

export function hasPaidSubscription(snapshot: SubscriptionSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.isSubscribed && !isDemoPlan(snapshot);
}

export function accountTierLabel(snapshot: SubscriptionSnapshot | null, isLoading: boolean): string {
  if (isLoading) return translateAppText('Compte');
  if (!hasPaidSubscription(snapshot)) return translateAppText('Accès Bêta');

  const activePlanId = resolveActivePlanId(snapshot);
  if (activePlanId === 'patron' || activePlanId === 'patronMonthly') {
    return translateAppText('Mécène');
  }
  return translateAppText('Membre Fondateur');
}

export function resolveActivePlanId(snapshot: SubscriptionSnapshot | null): SubscriptionPlanId {
  if (!snapshot || !hasPaidSubscription(snapshot)) return 'demo';

  const matchedPlan = (
    Object.entries(PLAN_PRICE_IDS) as Array<[SubscriptionPlanId, string | undefined]>
  ).find(([, priceId]) => priceId && snapshot.priceId === priceId);

  return matchedPlan?.[0] ?? 'demo';
}

export function buildSubscriptionHeadline(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot || isDemoPlan(snapshot)) {
    return translateAppText('Votre compte bénéficie de l’accès complet à la Bêta Web. Devenez Membre Fondateur pour débloquer vos avantages à vie.');
  }

  if (snapshot.cancelAtPeriodEnd) {
    return translateAppText('Votre abonnement se terminera le {{date}}.', {
      date: formatShortDate(snapshot.currentPeriodEnd),
    });
  }

  if (snapshot.currentPeriodEnd) {
    return translateAppText('Votre abonnement se renouvelle automatiquement le {{date}}.', {
      date: formatShortDate(snapshot.currentPeriodEnd),
    });
  }

  return translateAppText('Votre statut Fondateur est actif.');
}

export function statusLabel(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot?.status) return translateAppText('Statut indisponible');
  if (snapshot.status === 'demo') return translateAppText('Accès Bêta');
  if (snapshot.status === 'active') return translateAppText('Actif');
  if (snapshot.status === 'trialing') return translateAppText('Essai');
  return snapshot.status;
}