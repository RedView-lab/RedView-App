import { formatShortDate } from '../formatting';
import type {
  BillingContactPreference,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from '../../types';

export const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'http://localhost:3000';

const PLAN_PRICE_IDS: Partial<Record<SubscriptionPlanId, string>> = {
  explorer: import.meta.env.VITE_STRIPE_PRICE_ID_EXPLORER,
  proCommit: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_COMMIT,
  proMonthly: import.meta.env.VITE_STRIPE_PRICE_ID_PRO_MONTHLY,
};

const FEATURE_BADGES = {
  cloudStorage: {
    id: 'cloud-storage',
    label: 'Stockage Cloud',
    icon: 'folder.svg',
    tone: 'gray' as const,
    featureItems: [{ icon: 'folder.svg', label: 'Gestionnaire de projet' }],
  },
  mapping3d: {
    id: 'mapping-3d',
    label: 'Cartographie 3D HD',
    icon: 'diamond.svg',
    tone: 'gold' as const,
    featureItems: [
      { icon: 'diamond.svg', label: 'Cartographie 3D haute fidélité' },
      { icon: 'cube-outline.svg', label: 'Analyse LIDAR 20cm' },
    ],
  },
  terrainAnalysis: {
    id: 'terrain-analysis',
    label: 'Analyse du terrain',
    icon: 'multi-layer.svg',
    tone: 'brown' as const,
    featureItems: [
      { icon: 'slope.svg', label: 'Analyse des pentes' },
      { icon: 'multi-layer.svg', label: 'Analyse de l’altitude' },
    ],
  },
  meteoSunlight: {
    id: 'meteo-sunlight',
    label: 'Météo et ensoleillement',
    icon: 'weather.svg',
    tone: 'blue' as const,
    featureItems: [
      { icon: 'sun.svg', label: 'Simulation ensoleillement' },
      { icon: 'cloud-sun-02.svg', label: 'Prévisions et tendances Météo' },
      { icon: 'wind-03.svg', label: 'Vent en temps réel' },
      { icon: 'snowflake.svg', label: 'Simulation de la neige en temps réel' },
    ],
  },
  routePlanning: {
    id: 'route-planning',
    label: 'Création d’itinéraire avancée',
    icon: 'route.svg',
    tone: 'teal' as const,
    featureItems: [
      { icon: 'settings-01.svg', label: 'Création d’itinéraire customisable' },
      { icon: 'route.svg', label: 'Comparaison d’itinéraire' },
    ],
  },
  routeAnalysis: {
    id: 'route-analysis',
    label: 'Analyse d’itinéraire',
    icon: 'line-chart.svg',
    tone: 'green' as const,
    featureItems: [
      { icon: 'line-chart.svg', label: 'Graphique customisable' },
      { icon: 'list.svg', label: 'Feuille de route et timeline exportables' },
      { icon: 'share-07.svg', label: 'Export multi format' },
    ],
  },
  poiManagement: {
    id: 'poi-management',
    label: 'Gestion des Points d’Intérêts',
    icon: 'poi-pin.svg',
    tone: 'purple' as const,
    featureItems: [{ icon: 'poi-pin.svg', label: 'Sélection et édition des POIs' }],
  },
  paceEstimation: {
    id: 'pace-estimation',
    label: 'Estimation du rythme',
    icon: 'stopwatch.svg',
    tone: 'black' as const,
    featureItems: [{ icon: 'stopwatch.svg', label: 'Pacing et gestion des pauses' }],
  },
};

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'demo',
    name: 'Démo',
    priceLabel: 'Gratuit',
    tags: [],
    iconBadges: [],
    description: '',
  },
  {
    id: 'explorer',
    name: 'Abonnement Explorer',
    priceLabel: '9.99€/mois',
    tags: [],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.terrainAnalysis,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.cloudStorage,
    ],
    description: '',
  },
  {
    id: 'proCommit',
    name: 'Abonnement Pro',
    priceLabel: '14.99€/mois',
    tags: ['Engagement de 6 mois', '-25%'],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.terrainAnalysis,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.routePlanning,
      FEATURE_BADGES.routeAnalysis,
      FEATURE_BADGES.poiManagement,
      FEATURE_BADGES.paceEstimation,
      FEATURE_BADGES.cloudStorage,
    ],
    description: '',
  },
  {
    id: 'proMonthly',
    name: 'Abonnement Pro',
    priceLabel: '19.99€/mois',
    tags: ['Sans engagement'],
    iconBadges: [
      FEATURE_BADGES.mapping3d,
      FEATURE_BADGES.terrainAnalysis,
      FEATURE_BADGES.meteoSunlight,
      FEATURE_BADGES.routePlanning,
      FEATURE_BADGES.routeAnalysis,
      FEATURE_BADGES.poiManagement,
      FEATURE_BADGES.paceEstimation,
      FEATURE_BADGES.cloudStorage,
    ],
    description: '',
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
  if (snapshot.status === 'demo') return 'Démo';
  if (snapshot.status === 'active') return 'Actif';
  if (snapshot.status === 'trialing') return 'Essai';
  return snapshot.status;
}