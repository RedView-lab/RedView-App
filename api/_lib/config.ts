import type { VercelRequest } from '@vercel/node';

export type BillingPlanId = 'explorer' | 'proCommit' | 'proMonthly';

const PRICE_ID_BY_PLAN: Record<BillingPlanId, string | undefined> = {
  explorer: process.env.STRIPE_PRICE_ID_EXPLORER,
  proCommit: process.env.STRIPE_PRICE_ID_PRO_COMMIT,
  proMonthly: process.env.STRIPE_PRICE_ID_PRO_MONTHLY,
};

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function isBillingPlanId(value: string): value is BillingPlanId {
  return value === 'explorer' || value === 'proCommit' || value === 'proMonthly';
}

export function getConfiguredPriceId(planId: BillingPlanId): string | null {
  const value = PRICE_ID_BY_PLAN[planId]?.trim();
  return value ? value : null;
}

export function requireConfiguredPriceId(planId: BillingPlanId): string {
  const priceId = getConfiguredPriceId(planId);
  if (!priceId) {
    throw new Error(`Missing Stripe price ID for plan ${planId}`);
  }
  return priceId;
}

export function getAppBaseUrl(req: VercelRequest): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host ?? process.env.VERCEL_URL;
  const protoHeader = req.headers['x-forwarded-proto'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;

  if (host) {
    return `${proto ?? 'https'}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:5173';
}
