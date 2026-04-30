import type Stripe from 'stripe';

import { requireConfiguredPriceId, type BillingPlanId } from '../config.js';
import { getSupabaseAdmin } from '../supabase.js';
import { getStripeServer } from '../stripe.js';
import {
  getOrCreateStripeCustomer,
  getStripeCustomerId,
} from './customers.js';
import type {
  ExpandedInvoice,
  StoredSubscriptionRow,
  SubscriptionActionResult,
  SubscriptionSnapshot,
} from './types.js';
import { MANAGED_SUBSCRIPTION_STATUSES } from './types.js';

function isSubscriptionStatusViewError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: string;
    message?: string;
    details?: string;
    hint?: string;
  };

  const haystack = [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();

  return (
    candidate.code === '42P01' ||
    candidate.code === '42703' ||
    haystack.includes('user_subscription_status') ||
    haystack.includes('is_subscribed') ||
    haystack.includes('cancel_at_period_end')
  );
}

function toSnapshotFromStoredSubscription(
  row: Pick<
    StoredSubscriptionRow,
    'status' | 'price_id' | 'current_period_end' | 'cancel_at_period_end'
  > | null,
): SubscriptionSnapshot {
  const status = row?.status ?? 'demo';
  const isSubscribed = status === 'active' || status === 'trialing';

  return {
    isSubscribed,
    status,
    priceId: row?.price_id ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
  };
}

async function getSubscriptionSnapshotFromStoredSubscriptions(
  userId: string,
): Promise<SubscriptionSnapshot> {
  const rows = await listStoredSubscriptions(userId);
  const candidates = rows.filter((row) => MANAGED_SUBSCRIPTION_STATUSES.has(row.status ?? ''));

  candidates.sort((left, right) => {
    const leftTime = left.current_period_end ? Date.parse(left.current_period_end) : 0;
    const rightTime = right.current_period_end ? Date.parse(right.current_period_end) : 0;
    return rightTime - leftTime;
  });

  return toSnapshotFromStoredSubscription(candidates[0] ?? null);
}

export async function getSubscriptionSnapshot(userId: string): Promise<SubscriptionSnapshot> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_subscription_status')
    .select('is_subscribed, status, price_id, current_period_end, cancel_at_period_end')
    .eq('user_id', userId)
    .maybeSingle<{
      is_subscribed: boolean | null;
      status: string | null;
      price_id: string | null;
      current_period_end: string | null;
      cancel_at_period_end: boolean | null;
    }>();

  if (error) {
    if (isSubscriptionStatusViewError(error)) {
      return getSubscriptionSnapshotFromStoredSubscriptions(userId);
    }

    throw error;
  }

  return {
    isSubscribed: data?.is_subscribed ?? false,
    status: data?.status ?? 'demo',
    priceId: data?.price_id ?? null,
    currentPeriodEnd: data?.current_period_end ?? null,
    cancelAtPeriodEnd: data?.cancel_at_period_end ?? false,
  };
}

function toSnapshotFromStripeSubscription(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const firstItem = subscription.items.data[0];

  return {
    isSubscribed: subscription.status === 'active' || subscription.status === 'trialing',
    status: subscription.status,
    priceId: firstItem?.price?.id ?? null,
    currentPeriodEnd: firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000).toISOString()
      : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

function getLatestInvoicePaymentIntent(
  subscription: Stripe.Subscription,
): Stripe.PaymentIntent | null {
  const latestInvoice = subscription.latest_invoice as ExpandedInvoice | string | null;
  if (!latestInvoice || typeof latestInvoice === 'string') {
    return null;
  }

  const paymentIntent = latestInvoice.payment_intent;
  if (!paymentIntent || typeof paymentIntent === 'string') {
    return null;
  }

  return paymentIntent;
}

function getLatestInvoiceClientSecret(subscription: Stripe.Subscription): string | null {
  const paymentIntent = getLatestInvoicePaymentIntent(subscription);
  if (paymentIntent?.client_secret) {
    return paymentIntent.client_secret;
  }

  const latestInvoice = subscription.latest_invoice as ExpandedInvoice | string | null;
  if (!latestInvoice || typeof latestInvoice === 'string') {
    return null;
  }

  return latestInvoice.confirmation_secret?.client_secret ?? null;
}

function buildSubscriptionActionResult(
  subscription: Stripe.Subscription,
): SubscriptionActionResult {
  const paymentIntent = getLatestInvoicePaymentIntent(subscription);
  const paymentIntentStatus = paymentIntent?.status ?? null;
  const clientSecret = getLatestInvoiceClientSecret(subscription);
  const hasClientSecret = Boolean(clientSecret);
  const requiresPaymentConfirmation =
    hasClientSecret &&
    (subscription.status === 'incomplete' ||
      paymentIntentStatus === 'requires_action' ||
      paymentIntentStatus === 'requires_confirmation' ||
      paymentIntentStatus === 'requires_payment_method');

  return {
    subscriptionId: subscription.id,
    subscription: toSnapshotFromStripeSubscription(subscription),
    clientSecret,
    requiresPaymentConfirmation,
  };
}

function getStripeCustomerIdFromSubscription(subscription: Stripe.Subscription): string | null {
  const customer = subscription.customer;
  if (!customer) {
    return null;
  }

  return typeof customer === 'string' ? customer : customer.id;
}

async function listStoredSubscriptions(userId: string): Promise<StoredSubscriptionRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('subscriptions')
    .select('id, status, price_id, cancel_at_period_end, current_period_end')
    .eq('user_id', userId)
    .returns<StoredSubscriptionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getCurrentManagedSubscriptionRow(
  userId: string,
): Promise<StoredSubscriptionRow | null> {
  const rows = await listStoredSubscriptions(userId);
  const candidates = rows.filter((row) => MANAGED_SUBSCRIPTION_STATUSES.has(row.status ?? ''));

  candidates.sort((left, right) => {
    const leftTime = left.current_period_end ? Date.parse(left.current_period_end) : 0;
    const rightTime = right.current_period_end ? Date.parse(right.current_period_end) : 0;
    return rightTime - leftTime;
  });

  return candidates[0] ?? null;
}

export async function getCurrentManagedStripeSubscription(
  userId: string,
  expand: string[] = [],
): Promise<Stripe.Subscription | null> {
  const row = await getCurrentManagedSubscriptionRow(userId);
  if (!row) {
    return null;
  }

  return getStripeServer().subscriptions.retrieve(row.id, { expand });
}

export async function createManagedSubscription(
  userId: string,
  email: string | null,
  planId: BillingPlanId,
): Promise<SubscriptionActionResult> {
  const stripeCustomerId = await getOrCreateStripeCustomer(userId, email);
  const priceId = requireConfiguredPriceId(planId);

  const subscription = await getStripeServer().subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      save_default_payment_method: 'on_subscription',
    },
    expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret'],
    metadata: {
      user_id: userId,
      plan_id: planId,
    },
  });

  await upsertSubscription(subscription, userId);
  return buildSubscriptionActionResult(subscription);
}

export async function changeManagedSubscriptionPlan(
  userId: string,
  planId: BillingPlanId,
): Promise<SubscriptionActionResult> {
  const currentSubscription = await getCurrentManagedStripeSubscription(userId, [
    'latest_invoice.payment_intent',
    'latest_invoice.confirmation_secret',
  ]);

  if (!currentSubscription) {
    throw new Error('No managed subscription found for this account.');
  }

  const currentItem = currentSubscription.items.data[0];
  if (!currentItem) {
    throw new Error('No Stripe subscription item found for this account.');
  }

  const nextPriceId = requireConfiguredPriceId(planId);
  if (currentItem.price?.id === nextPriceId && !currentSubscription.cancel_at_period_end) {
    return buildSubscriptionActionResult(currentSubscription);
  }

  const updatedSubscription = await getStripeServer().subscriptions.update(currentSubscription.id, {
    cancel_at_period_end: false,
    items: [
      {
        id: currentItem.id,
        price: nextPriceId,
      },
    ],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      save_default_payment_method: 'on_subscription',
    },
    proration_behavior: 'always_invoice',
    expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret'],
    metadata: {
      ...currentSubscription.metadata,
      user_id: userId,
      plan_id: planId,
    },
  });

  await upsertSubscription(updatedSubscription, userId);
  return buildSubscriptionActionResult(updatedSubscription);
}

export async function setManagedSubscriptionCancellation(
  userId: string,
  cancelAtPeriodEnd: boolean,
): Promise<SubscriptionActionResult> {
  const currentSubscription = await getCurrentManagedStripeSubscription(userId);
  if (!currentSubscription) {
    throw new Error('No managed subscription found for this account.');
  }

  const updatedSubscription = await getStripeServer().subscriptions.update(currentSubscription.id, {
    cancel_at_period_end: cancelAtPeriodEnd,
  });

  await upsertSubscription(updatedSubscription, userId);
  return buildSubscriptionActionResult(updatedSubscription);
}

export async function syncManagedSubscription(
  userId: string,
  subscriptionId: string,
): Promise<SubscriptionActionResult> {
  const expectedStripeCustomerId = await getStripeCustomerId(userId);
  if (!expectedStripeCustomerId) {
    throw new Error('No Stripe customer found for this account.');
  }

  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret'],
  });

  if (getStripeCustomerIdFromSubscription(subscription) !== expectedStripeCustomerId) {
    throw new Error('This Stripe subscription does not belong to the current user.');
  }

  await upsertSubscription(subscription, userId);
  return buildSubscriptionActionResult(subscription);
}

export async function upsertSubscription(
  subscription: Stripe.Subscription,
  userId: string,
): Promise<void> {
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price?.id ?? null;
  const periodStart = firstItem?.current_period_start;
  const periodEnd = firstItem?.current_period_end;

  const { error } = await getSupabaseAdmin().from('subscriptions').upsert({
    id: subscription.id,
    user_id: userId,
    status: subscription.status,
    price_id: priceId,
    current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: subscription.cancel_at_period_end,
  });

  if (error) {
    throw error;
  }
}

export function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (parent?.type === 'subscription_details' && parent.subscription_details?.subscription) {
    const subscription = parent.subscription_details.subscription;
    return typeof subscription === 'string' ? subscription : subscription.id;
  }

  return null;
}