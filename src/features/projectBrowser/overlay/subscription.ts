import { formatShortDate } from './utils';
import type {
  BillingContactPreference,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from './types';

export const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000';

const PLAN_PRICE_IDS: Partial<Record<SubscriptionPlanId, string>> = {
  explorer: import.meta.env.VITE_STRIPE_PRICE_ID_EXPLORER,
  proCommit: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_COMMIT,
  proMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_MONTHLY,
};

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'demo',
    name: 'Demo',
    priceLabel: 'Gratuit',
    tags: ['Compte par défaut'],
    iconBadges: [{ icon: 'layers-three-02.svg', tone: 'blue' }],
    description: 'Point d’entrée gratuit pour consulter vos projets et préparer la suite avant un upgrade.',
  },
  {
    id: 'explorer',
    name: 'Abonnement Explorer',
    priceLabel: '9.99€/mois',
    tags: ['Sans engagement', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
    ],
    description: 'Accès léger pour consulter vos projets et préparer vos prochaines sorties.',
  },
  {
    id: 'proCommit',
    name: 'Abonnement Pro',
    priceLabel: '14.99€/mois',
    tags: ['Engagement de 6 mois', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
      { icon: 'marker-pin-04.svg', tone: 'green' },
      { icon: 'clock-rewind.svg', tone: 'gray' },
    ],
    description: 'Le meilleur tarif pour un usage terrain intensif avec engagement.',
  },
  {
    id: 'proMonthly',
    name: 'Abonnement Pro',
    priceLabel: '19.99€/mois',
    tags: ['Sans engagement', '-25%'],
    iconBadges: [
      { icon: 'currency-euro.svg', tone: 'gold' },
      { icon: 'layers-three-02.svg', tone: 'blue' },
      { icon: 'marker-pin-04.svg', tone: 'green' },
      { icon: 'clock-rewind.svg', tone: 'gray' },
    ],
    description: 'Toute la stack RedView Pro avec une sortie possible à tout moment.',
  },
];

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
  if (isLoading) return 'Compte';
  return hasPaidSubscription(snapshot) ? 'Premium' : 'Demo';
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
    return 'Votre compte démarre sur le plan Demo. Ouvrez RedView Web depuis cet onglet pour passer à une offre payante quand vous le souhaitez.';
  }

  if (snapshot.cancelAtPeriodEnd) {
    return `Votre abonnement se terminera le ${formatShortDate(snapshot.currentPeriodEnd)}.`;
  }

  if (snapshot.currentPeriodEnd) {
    return `Votre abonnement se renouvelle automatiquement le ${formatShortDate(snapshot.currentPeriodEnd)}.`;
  }

  return 'Votre abonnement RedView Pro est actif.';
}

export function statusLabel(snapshot: SubscriptionSnapshot | null): string {
  if (!snapshot?.status) return 'Statut indisponible';
  if (snapshot.status === 'demo') return 'Demo';
  if (snapshot.status === 'active') return 'Actif';
  if (snapshot.status === 'trialing') return 'Essai';
  return snapshot.status;
}