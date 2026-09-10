import type { ApiRequest } from './types.js';

export type BillingPlanId = 'founder' | 'patron';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function isBillingPlanId(value: string): value is BillingPlanId {
  return value === 'founder' || value === 'patron';
}

export function getConfiguredPriceId(planId: BillingPlanId): string | null {
  if (planId === 'founder') {
    return process.env.STRIPE_PRICE_ID_FOUNDER?.trim() || null;
  }
  if (planId === 'patron') {
    return process.env.STRIPE_PRICE_ID_PATRON?.trim() || null;
  }
  return null;
}

export function requireConfiguredPriceId(planId: BillingPlanId): string {
  const priceId = getConfiguredPriceId(planId);
  if (!priceId) {
    throw new Error(`Missing Stripe price ID for plan ${planId}`);
  }
  return priceId;
}

export function getAppBaseUrl(req: ApiRequest): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host;
  const protoHeader = req.headers['x-forwarded-proto'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;

  if (host) {
    return `${proto ?? 'https'}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:5173';
}
