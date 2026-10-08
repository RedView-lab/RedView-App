import { getAppwriteJwt } from '@/shared/services/appwrite';
import { translateAppText } from '@/shared/i18n';

import { logBillingUi, logBillingUiError } from './debug';
import type {
  BillingContactPreference,
  PaymentMethodSummary,
  SubscriptionPlanId,
  SubscriptionSnapshot,
} from '../../types';

type BillingOverviewResponse = {
  subscription: SubscriptionSnapshot;
  trialEligible: boolean;
  contactPreference: BillingContactPreference;
  customerEmail: string | null;
  paymentMethod: PaymentMethodSummary | null;
  paymentMethods: PaymentMethodSummary[];
};

export type SubscriptionActionResponse = {
  subscriptionId: string;
  subscription: SubscriptionSnapshot;
};

/** Ce que le Payment Element doit confirmer pour souscrire. */
export type SubscriptionStartResponse =
  | { intent: 'setup'; clientSecret: string; setupIntentId: string; planId: SubscriptionPlanId; trialDays: number }
  | { intent: 'payment'; clientSecret: string; subscriptionId: string; planId: SubscriptionPlanId };

type PaymentMethodSetupResponse = {
  clientSecret: string;
};

function summarizeResponse(data: Record<string, unknown>) {
  return {
    keys: Object.keys(data),
    error: typeof data.error === 'string' ? data.error : null,
    subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : null,
    hasClientSecret: typeof data.clientSecret === 'string' && data.clientSecret.length > 0,
    intent: typeof data.intent === 'string' ? data.intent : null,
    subscriptionStatus:
      data.subscription && typeof data.subscription === 'object' && data.subscription
        ? (data.subscription as Record<string, unknown>).status ?? null
        : null,
  };
}

async function getAccessToken(fresh = false): Promise<string> {
  const token = await getAppwriteJwt({ fresh });

  if (!token) {
    throw new Error(translateAppText('Session expirée. Reconnectez-vous pour gérer votre abonnement.'));
  }

  return token;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  logBillingUi('api-request-start', {
    path,
    method: init?.method ?? 'GET',
    hasBody: Boolean(init?.body),
    // Request bodies may contain billing contact details: only log them in dev.
    ...(import.meta.env.DEV ? { body: typeof init?.body === 'string' ? init.body : null } : {}),
  });

  const send = async (fresh: boolean) => fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getAccessToken(fresh)}`,
      ...(init?.headers ?? {}),
    },
  });
  let response = await send(false);
  // JWT réutilisé mais refusé (session renouvelée entre-temps) : un nouveau, une fois.
  if (response.status === 401) response = await send(true);

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const responseSummary = `${init?.method ?? 'GET'} ${path} -> ${response.status}${typeof data.error === 'string' ? ` ${data.error}` : ''}`;
  logBillingUi('api-request-response', {
    path,
    method: init?.method ?? 'GET',
    status: response.status,
    ok: response.ok,
    ...summarizeResponse(data),
  }, responseSummary);

  if (!response.ok) {
    const errorMessage =
      typeof data.error === 'string'
        ? translateAppText(data.error)
        : translateAppText('La requête de facturation a échoué.');
    const error = new Error(
      errorMessage,
    );
    const errorSummary = `${init?.method ?? 'GET'} ${path} -> ${response.status} ${errorMessage}`;
    logBillingUiError('api-request-failed', error, {
      path,
      method: init?.method ?? 'GET',
      status: response.status,
      ...summarizeResponse(data),
    }, errorSummary);
    throw error;
  }

  return data as T;
}

export async function fetchBillingOverview(): Promise<BillingOverviewResponse> {
  return apiRequest<BillingOverviewResponse>('/api/billing/overview', {
    method: 'GET',
  });
}

export async function startSubscription(planId: SubscriptionPlanId): Promise<SubscriptionStartResponse> {
  return apiRequest<SubscriptionStartResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({ action: 'start', planId }),
  });
}

export async function activateTrialSubscription(setupIntentId: string): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({ action: 'activate', setupIntentId }),
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

export async function syncManagedSubscription(subscriptionId: string): Promise<SubscriptionActionResponse> {
  return apiRequest<SubscriptionActionResponse>('/api/billing/subscription', {
    method: 'POST',
    body: JSON.stringify({ action: 'sync', subscriptionId }),
  });
}

/** URL du portail client Stripe ; avec `planId`, la confirmation du passage à cette durée. */
export async function openBillingPortal(planId?: SubscriptionPlanId): Promise<string> {
  const data = await apiRequest<{ url: string }>('/api/billing/portal', {
    method: 'POST',
    body: JSON.stringify(planId ? { planId } : {}),
  });
  return data.url;
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

export async function setDefaultBillingPaymentMethod(
  paymentMethodId: string,
): Promise<BillingOverviewResponse> {
  return apiRequest<BillingOverviewResponse>('/api/billing/payment-method', {
    method: 'POST',
    body: JSON.stringify({ paymentMethodId }),
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
