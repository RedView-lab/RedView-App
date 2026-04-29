import type Stripe from 'stripe';

import { getSupabaseAdmin } from '../supabase.js';
import { getStripeServer } from '../stripe.js';
import {
  getCustomerRow,
  isStripeCustomer,
  getValidatedStripeCustomerId,
} from './customers.js';
import { getSubscriptionSnapshot } from './subscriptions.js';
import type {
  BillingContactPreference,
  CustomerRow,
  PaymentMethodSummary,
} from './types.js';
import {
  DEFAULT_CONTACT_PREFERENCE,
  MANAGED_SUBSCRIPTION_STATUSES,
} from './types.js';

function toContactPreference(row: CustomerRow | null): BillingContactPreference {
  if (!row) return DEFAULT_CONTACT_PREFERENCE;

  return {
    mode: row.billing_email_mode === 'alternative' ? 'alternative' : 'account',
    alternativeEmail: row.billing_email ?? '',
  };
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
  } catch {
    const validatedCustomerId = await getValidatedStripeCustomerId(stripeCustomerId);
    if (!validatedCustomerId) {
      return { customerEmail: null, paymentMethod: null };
    }

    customer = await getStripeServer().customers.retrieve(validatedCustomerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
  }

  if (!isStripeCustomer(customer)) {
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