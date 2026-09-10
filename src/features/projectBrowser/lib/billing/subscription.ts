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
  patron: import.meta.env.VITE_STRIPE_PRICE_ID_PATRON,
};

const FEATURE_BADGES = {
  mapping3d: {
    id: 'mapping-3d',
    label: 'Moteur 3D & LiDAR',
    icon: 'diamond.svg',
    tone: 'gold' as const,
    featureItems: [
      { icon: 'diamond.svg', label: 'Moteur 3D temps réel illimité' },
      { icon: 'cube-outline.svg', label: 'LiDAR HD 20 cm sur le web' },
    ],
  },
  meteoSunlight: {
    id: 'meteo-sunlight',
    label: 'Météo et ensoleillement',
    icon: 'weather.svg',
    tone: 'blue' as const,
    featureItems: [
      { icon: 'sun.svg', label: 'Simulation ensoleillement & ombres' },
      { icon: 'cloud-sun-02.svg', label: 'Prévisions météo & vent direct' },
      { icon: 'snowflake.svg', label: 'Simulation neige temps réel' },
    ],
  },
  routePlanning: {
    id: 'route-planning',
    label: 'Routage & GPX',
    icon: 'route.svg',
    tone: 'teal' as const,
    featureItems: [
      { icon: 'route.svg', label: 'Routage intelligent' },
      { icon: 'share-07.svg', label: 'Export GPX illimité' },
    ],
  },
  cloudStorage: {
    id: 'cloud-storage',
    label: 'Accès Web & Projets',
    icon: 'folder.svg',
    tone: 'gray' as const,
    featureItems: [
      { icon: 'folder.svg', label: 'Gestionnaire de projets' },
      { icon: 'check.svg', label: 'Accès sans carte bancaire' },
    ],
  },
  founderPrivileges: {
    id: 'founder-privileges',
    label: 'Avantages Fondateur',
    icon: 'multi-layer.svg',
    tone: 'brown' as const,
    featureItems: [
      { icon: 'navigation-pointer-01.svg', label: 'Accès anticipé App Mobile' },
      { icon: 'currency-euro.svg', label: 'Statut Fondateur : -50% à vie' },
    ],
  },
  communitySupport: {
    id: 'community-support',
    label: 'Communauté & Soutien',
    icon: 'poi-pin.svg',
    tone: 'purple' as const,
    featureItems: [
      { icon: 'check-circle.svg', label: 'Vote sur les prochains massifs 3D' },
      { icon: 'user-circle.svg', label: 'Discord privé & contact direct dev' },
      { icon: 'heart.svg', label: 'Soutien direct dev indépendant' },
    ],
  },
  proYear: {
    id: 'pro-year',
    label: 'Privilèges Mécène',
    icon: 'line-chart.svg',
    tone: 'green' as const,
    featureItems: [
      { icon: 'diamond.svg', label: '1 An de compte PRO offert (v1)' },
      { icon: 'star-01.svg', label: 'Accès VIP ultra-prioritaire mobile' },
    ],
  },
  patronCircle: {
    id: 'patron-circle',
    label: 'Cercle des Soutiens',
    icon: 'stopwatch.svg',
    tone: 'black' as const,
    featureItems: [
      { icon: 'user-circle.svg', label: 'Nom sur la page des Soutiens' },
      { icon: 'mail-02.svg', label: 'Propositions de zones & features' },
    ],
  },
};

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'demo',
    name: 'Accès Bêta Web',
    priceLabel: '0 €',
    tags: [],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.routePlanning,
      FEATURE_BADGES.cloudStorage,
    ],
    description: 'Gratuit sur le web pendant la Bêta',
  },
  {
    id: 'founder',
    name: 'Pass Fondateur',
    priceLabel: '5 €',
    tags: [],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.routePlanning,
      FEATURE_BADGES.cloudStorage,
      FEATURE_BADGES.founderPrivileges,
      FEATURE_BADGES.communitySupport,
    ],
    description: 'Paiement unique · avantages à vie',
  },
  {
    id: 'patron',
    name: 'Mécène & Soutien Majeur',
    priceLabel: 'dès 15 €',
    tags: [],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.routePlanning,
      FEATURE_BADGES.cloudStorage,
      FEATURE_BADGES.founderPrivileges,
      FEATURE_BADGES.communitySupport,
      FEATURE_BADGES.proYear,
      FEATURE_BADGES.patronCircle,
    ],
    description: 'Don libre de soutien',
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
  if (isLoading) return translateAppText('Compte');
  if (!hasPaidSubscription(snapshot)) return translateAppText('Accès Bêta');

  const activePlanId = resolveActivePlanId(snapshot);
  if (activePlanId === 'patron') {
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
    return translateAppText('Votre compte bénéficie de l\'accès complet à la Bêta Web. Devenez Membre Fondateur pour débloquer vos avantages à vie.');
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