import { supabase } from '@/lib/supabase';

import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from './types';

type BillingOverviewResponse = {
  subscription: SubscriptionSnapshot;
  contactPreference: BillingContactPreference;
  customerEmail: string | null;
  paymentMethod: PaymentMethodSummary | null;
};

export type SubscriptionActionResponse = {
  subscriptionId: string;
  subscription: SubscriptionSnapshot;
  clientSecret: string | null;
  requiresPaymentConfirmation: boolean;
};

type PaymentMethodSetupResponse = {
  clientSecret: string;
};

async function getAccessToken(): Promise<string> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }

  if (!session?.access_token) {
    throw new Error('Session expirée. Reconnectez-vous pour gérer votre abonnement.');
  }

  return session.access_token;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'La requête de facturation a échoué.',
    );
  }

  return data as T;
}

export async function fetchBillingOverview(): Promise<BillingOverviewResponse> {
  return apiRequest<BillingOverviewResponse>('/api/billing/overview', {
    method: 'GET',
  });
}

export async function createSubscriptionIntent(
  planId: Exclude<SubscriptionPlanId, 'demo'>,
): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({
      action: 'subscribe',
      planId,
    }),
  });
}

export async function changeSubscriptionPlan(
  planId: Exclude<SubscriptionPlanId, 'demo'>,
): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({
      action: 'change',
      planId,
    }),
  });
}

export async function cancelManagedSubscription(): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({ action: 'cancel' }),
  });
}

export async function resumeManagedSubscription(): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({ action: 'resume' }),
  });
}

export async function syncManagedSubscription(
  subscriptionId: string,
): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({
      action: 'sync',
      subscriptionId,
    }),
  });
}

export async function createPaymentMethodSetupIntent(): Promise<PaymentMethodSetupResponse> {
  return apiRequest<PaymentMethodSetupResponse>('/api/billing/payment-method', {
    method: 'POST',
  });
}

export async function applyPaymentMethodSetup(
  setupIntentId: string,
): Promise<BillingOverviewResponse> {
  return apiRequest<BillingOverviewResponse>('/api/billing/payment-method', {
    method: 'POST',
    body: JSON.stringify({ setupIntentId }),
  });
}

export async function persistBillingContactPreference(
  preference: BillingContactPreference,
): Promise<BillingContactPreference> {
  const data = await apiRequest<{ contactPreference: BillingContactPreference }>(
    '/api/billing/contact',
    {
      method: 'POST',
      body: JSON.stringify(preference),
    },
  );

  return data.contactPreference;
}

export type { BillingOverviewResponse };
