import type Stripe from 'stripe';

import { requireConfiguredPriceId, type BillingPlanId } from './config.js';
import { getSupabaseAdmin } from './supabase.js';
import { getStripeServer } from './stripe.js';

export type BillingContactPreference = {
  mode: 'account' | 'alternative';
  alternativeEmail: string;
};

export type PaymentMethodSummary = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type SubscriptionSnapshot = {
  isSubscribed: boolean;
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type CustomerRow = {
  stripe_customer_id: string | null;
  billing_email_mode?: string | null;
  billing_email?: string | null;
};

type StoredSubscriptionRow = {
  id: string;
  status: string | null;
  price_id: string | null;
  cancel_at_period_end: boolean | null;
  current_period_end: string | null;
};

type SetupIntentWithPaymentMethod = Stripe.SetupIntent & {
  payment_method: string | Stripe.PaymentMethod | null;
};

export type SubscriptionActionResult = {
  subscriptionId: string;
  subscription: SubscriptionSnapshot;
  clientSecret: string | null;
  requiresPaymentConfirmation: boolean;
};

const DEFAULT_CONTACT_PREFERENCE: BillingContactPreference = {
  mode: 'account',
  alternativeEmail: '',
};

const MANAGED_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);

function isMissingStripeCustomerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: string;
    param?: string;
    message?: string;
  };

  return (
    candidate.code === 'resource_missing' &&
    (candidate.param === 'customer' ||
      candidate.message?.toLowerCase().includes('no such customer') === true)
  );
}

async function createAndStoreStripeCustomer(userId: string, email: string | null): Promise<string> {
  const customer = await getStripeServer().customers.create({
    ...(email ? { email } : {}),
    metadata: { supabase_user_id: userId },
  });

  const { error: upsertError } = await getSupabaseAdmin().from('customers').upsert(
    {
      id: userId,
      stripe_customer_id: customer.id,
    },
    {
      onConflict: 'id',
    },
  );

  if (upsertError) {
    throw upsertError;
  }

  return customer.id;
}

async function getValidatedStripeCustomerId(stripeCustomerId: string): Promise<string | null> {
  try {
    const customer = await getStripeServer().customers.retrieve(stripeCustomerId);
    return customer.deleted ? null : customer.id;
  } catch (error) {
    if (isMissingStripeCustomerError(error)) {
      return null;
    }

    throw error;
  }
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const admin = getSupabaseAdmin();

  const { data: existing, error } = await admin
    .from('customers')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (error) {
    throw error;
  }

  if (existing?.stripe_customer_id) {
    const validatedCustomerId = await getValidatedStripeCustomerId(existing.stripe_customer_id);
    if (validatedCustomerId) {
      return validatedCustomerId;
    }
  }

  return createAndStoreStripeCustomer(userId, email);
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

async function getCustomerRow(userId: string): Promise<CustomerRow | null> {
  const admin = getSupabaseAdmin();
  const detailedQuery = await admin
    .from('customers')
    .select('stripe_customer_id, billing_email_mode, billing_email')
    .eq('id', userId)
    .maybeSingle<CustomerRow>();

  if (!detailedQuery.error) {
    return detailedQuery.data ?? null;
  }

  const message = detailedQuery.error.message.toLowerCase();
  if (!message.includes('billing_email')) {
    throw detailedQuery.error;
  }

  const fallbackQuery = await admin
    .from('customers')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (fallbackQuery.error) {
    throw fallbackQuery.error;
  }

  return fallbackQuery.data ?? null;
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

function toContactPreference(row: CustomerRow | null): BillingContactPreference {
  if (!row) return DEFAULT_CONTACT_PREFERENCE;

  return {
    mode: row.billing_email_mode === 'alternative' ? 'alternative' : 'account',
    alternativeEmail: row.billing_email ?? '',
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
  const latestInvoice = subscription.latest_invoice;
  if (!latestInvoice || typeof latestInvoice === 'string') {
    return null;
  }

  const paymentIntent = latestInvoice.payment_intent;
  if (!paymentIntent || typeof paymentIntent === 'string') {
    return null;
  }

  return paymentIntent;
}

function buildSubscriptionActionResult(
  subscription: Stripe.Subscription,
): SubscriptionActionResult {
  const paymentIntent = getLatestInvoicePaymentIntent(subscription);
  const paymentIntentStatus = paymentIntent?.status ?? null;
  const hasClientSecret = Boolean(paymentIntent?.client_secret);
  const requiresPaymentConfirmation =
    hasClientSecret &&
    (subscription.status === 'incomplete' ||
      paymentIntentStatus === 'requires_action' ||
      paymentIntentStatus === 'requires_confirmation' ||
      paymentIntentStatus === 'requires_payment_method');

  return {
    subscriptionId: subscription.id,
    subscription: toSnapshotFromStripeSubscription(subscription),
    clientSecret: paymentIntent?.client_secret ?? null,
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

async function getPaymentMethodSummary(
  stripeCustomerId: string | null,
): Promise<{ customerEmail: string | null; paymentMethod: PaymentMethodSummary | null }> {
  if (!stripeCustomerId) {
    return { customerEmail: null, paymentMethod: null };
  }

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await getStripeServer().customers.retrieve(stripeCustomerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
  } catch (error) {
    if (isMissingStripeCustomerError(error)) {
      return { customerEmail: null, paymentMethod: null };
    }

    throw error;
  }

  if (customer.deleted) {
    return { customerEmail: null, paymentMethod: null };
  }

  let paymentMethod = null as Stripe.PaymentMethod | null;
  const defaultPaymentMethod = customer.invoice_settings.default_payment_method;

  if (defaultPaymentMethod) {
    paymentMethod =
      typeof defaultPaymentMethod === 'string'
        ? await getStripeServer().paymentMethods.retrieve(defaultPaymentMethod)
        : defaultPaymentMethod;
  }

  if (!paymentMethod) {
    const subscriptions = await getStripeServer().subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 5,
      expand: ['data.default_payment_method'],
    });

    const managedSubscription = subscriptions.data.find((subscription) =>
      MANAGED_SUBSCRIPTION_STATUSES.has(subscription.status),
    );

    const subscriptionPaymentMethod = managedSubscription?.default_payment_method ?? null;
    if (subscriptionPaymentMethod) {
      paymentMethod =
        typeof subscriptionPaymentMethod === 'string'
          ? await getStripeServer().paymentMethods.retrieve(subscriptionPaymentMethod)
          : subscriptionPaymentMethod;
    }
  }

  if (!paymentMethod || paymentMethod.type !== 'card' || !paymentMethod.card) {
    return {
      customerEmail: customer.email ?? null,
      paymentMethod: null,
    };
  }

  return {
    customerEmail: customer.email ?? null,
    paymentMethod: {
      brand: paymentMethod.card.brand,
      last4: paymentMethod.card.last4,
      expMonth: paymentMethod.card.exp_month,
      expYear: paymentMethod.card.exp_year,
    },
  };
}

export async function buildBillingOverview(userId: string) {
  const [subscription, customerRow] = await Promise.all([
    getSubscriptionSnapshot(userId),
    getCustomerRow(userId),
  ]);

  const payment = await getPaymentMethodSummary(customerRow?.stripe_customer_id ?? null);

  return {
    subscription,
    contactPreference: toContactPreference(customerRow),
    customerEmail: payment.customerEmail,
    paymentMethod: payment.paymentMethod,
  };
}

export async function saveBillingContactPreference(
  userId: string,
  preference: BillingContactPreference,
): Promise<BillingContactPreference> {
  const payload = {
    id: userId,
    billing_email_mode: preference.mode,
    billing_email:
      preference.mode === 'alternative' && preference.alternativeEmail.trim()
        ? preference.alternativeEmail.trim()
        : null,
  };

  const { error } = await getSupabaseAdmin().from('customers').upsert(payload, {
    onConflict: 'id',
  });

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes('billing_email')) {
      throw new Error(
        'Supabase billing contact migration is missing. Run the billing contact SQL migration first.',
      );
    }
    throw error;
  }

  return {
    mode: preference.mode,
    alternativeEmail: payload.billing_email ?? '',
  };
}

export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const portalSession = await getStripeServer().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return portalSession.url;
}

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const row = await getCustomerRow(userId);
  if (!row?.stripe_customer_id) {
    return null;
  }

  return getValidatedStripeCustomerId(row.stripe_customer_id);
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

async function getCurrentManagedStripeSubscription(
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
    expand: ['latest_invoice.payment_intent'],
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
    expand: ['latest_invoice.payment_intent'],
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
    expand: ['latest_invoice.payment_intent'],
  });

  if (getStripeCustomerIdFromSubscription(subscription) !== expectedStripeCustomerId) {
    throw new Error('This Stripe subscription does not belong to the current user.');
  }

  await upsertSubscription(subscription, userId);
  return buildSubscriptionActionResult(subscription);
}

export async function createPaymentMethodSetupIntent(
  userId: string,
  email: string | null,
): Promise<{ clientSecret: string }> {
  const stripeCustomerId = await getOrCreateStripeCustomer(userId, email);
  const setupIntent = await getStripeServer().setupIntents.create({
    customer: stripeCustomerId,
    usage: 'off_session',
    automatic_payment_methods: {
      enabled: true,
    },
    metadata: {
      user_id: userId,
    },
  });

  if (!setupIntent.client_secret) {
    throw new Error('Unable to create a Stripe setup intent.');
  }

  return {
    clientSecret: setupIntent.client_secret,
  };
}

export async function applySetupIntentPaymentMethod(
  userId: string,
  setupIntentId: string,
) {
  const stripeCustomerId = await getStripeCustomerId(userId);
  if (!stripeCustomerId) {
    throw new Error('No Stripe customer found for this account.');
  }

  const setupIntent = (await getStripeServer().setupIntents.retrieve(setupIntentId, {
    expand: ['payment_method'],
  })) as SetupIntentWithPaymentMethod;

  const setupIntentCustomer =
    typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;

  if (setupIntentCustomer !== stripeCustomerId) {
    throw new Error('This setup intent does not belong to the current user.');
  }

  const paymentMethod = setupIntent.payment_method;
  const paymentMethodId =
    typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id ?? null;

  if (!paymentMethodId) {
    throw new Error('Stripe did not return a saved payment method.');
  }

  await getStripeServer().customers.update(stripeCustomerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  const currentSubscription = await getCurrentManagedStripeSubscription(userId);
  if (currentSubscription) {
    await getStripeServer().subscriptions.update(currentSubscription.id, {
      default_payment_method: paymentMethodId,
    });
  }

  return buildBillingOverview(userId);
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
  if (
    parent?.type === 'subscription_details' &&
    parent.subscription_details?.subscription
  ) {
    const subscription = parent.subscription_details.subscription;
    return typeof subscription === 'string' ? subscription : subscription.id;
  }

  return null;
}

export async function getUserIdFromCustomer(
  stripeCustomerId: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

export function hasPaidSubscription(snapshot: SubscriptionSnapshot): boolean {
  return snapshot.isSubscribed && snapshot.status !== 'demo';
}

export function normalizeRequestedPlanId(planId: BillingPlanId): BillingPlanId {
  return planId;
}
