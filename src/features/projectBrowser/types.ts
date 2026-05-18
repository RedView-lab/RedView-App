export interface ProjectBrowserOverlayProps {
  open: boolean;
  displayName: string;
  onOpenProject: (projectId: string) => void;
  onRequestClose: () => void;
  canClose?: boolean;
}

export type OverlayTab = 'projects' | 'account' | 'subscription' | 'settings';
export type SubscriptionPlanId = 'demo' | 'explorer' | 'proCommit' | 'proMonthly';

export type SubscriptionSnapshot = {
  isSubscribed: boolean;
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type SubscriptionState = {
  isLoading: boolean;
  error: string | null;
  snapshot: SubscriptionSnapshot | null;
};

export type PaymentMethodSummary = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

export type SubscriptionPlan = {
  id: SubscriptionPlanId;
  name: string;
  priceLabel: string;
  tags: string[];
  iconBadges: Array<{
    icon: string;
    tone: 'gold' | 'brown' | 'blue' | 'teal' | 'green' | 'purple' | 'black' | 'gray';
  }>;
  description: string;
};