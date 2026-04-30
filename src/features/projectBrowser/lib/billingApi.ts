import { supabase } from '@/shared/services/supabase';

import { logBillingUi, logBillingUiError } from './debug';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from '../types';

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

function summarizeResponse(data: Record<string, unknown>) {
  return {
    keys: Object.keys(data),
    error: typeof data.error === 'string' ? data.error : null,
    subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : null,
    hasClientSecret: typeof data.clientSecret === 'string' && data.clientSecret.length > 0,
    requiresPaymentConfirmation: data.requiresPaymentConfirmation === true,
    subscriptionStatus:
      data.subscription && typeof data.subscription === 'object' && data.subscription
        ? (data.subscription as Record<string, unknown>).status ?? null
        : null,
  };
}

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
  logBillingUi('api-request-start', {
    path,
    method: init?.method ?? 'GET',
    hasBody: Boolean(init?.body),
    body: typeof init?.body === 'string' ? init.body : null,
  });

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
  logBillingUi('api-request-response', {
    path,
    method: init?.method ?? 'GET',
    status: response.status,
    ok: response.ok,
    ...summarizeResponse(data),
  });

  if (!response.ok) {
    const error = new Error(
      typeof data.error === 'string' ? data.error : 'La requête de facturation a échoué.',
    );
    logBillingUiError('api-request-failed', error, {
      path,
      method: init?.method ?? 'GET',
      status: response.status,
      ...summarizeResponse(data),
    });
    throw error;
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
