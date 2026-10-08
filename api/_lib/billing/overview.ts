import type Stripe from 'stripe';

import {
  APPWRITE_DATABASE_ID,
  CUSTOMERS_COLLECTION_ID,
  getAppwriteDatabases,
} from '../appwrite.js';
import { getStripeServer } from '../stripe.js';
import { billingEmailFor, getCustomerRow, getValidatedStripeCustomerId, isStripeCustomer } from './customers.js';
import {
  NO_SUBSCRIPTION,
  getSubscriptionSnapshot,
  listCustomerSubscriptions,
  snapshotFromStripeSubscription,
  upsertSubscription,
} from './subscriptions.js';
import {
  DEFAULT_CONTACT_PREFERENCE,
  LIVE_SUBSCRIPTION_STATUSES,
  isTrialEligible,
  type BillingContactPreference,
  type CustomerRow,
  type PaymentMethodSummary,
  type SubscriptionSnapshot,
} from './types.js';

export type BillingOverview = {
  subscription: SubscriptionSnapshot;
  /** L'essai gratuit est encore disponible pour ce compte. */
  trialEligible: boolean;
  contactPreference: BillingContactPreference;
  customerEmail: string | null;
  paymentMethod: PaymentMethodSummary | null;
  paymentMethods: PaymentMethodSummary[];
};

function toContactPreference(row: CustomerRow | null): BillingContactPreference {
  if (!row) return DEFAULT_CONTACT_PREFERENCE;
  return {
    mode: row.billing_email_mode === 'alternative' ? 'alternative' : 'account',
    alternativeEmail: row.billing_email ?? '',
  };
}

export function summarizePaymentMethod(method: Stripe.PaymentMethod, defaultId: string | null): PaymentMethodSummary {
  const card = method.type === 'card' ? method.card : null;
  return {
    id: method.id,
    type: method.type,
    brand: card?.brand ?? method.type,
    last4: card?.last4 ?? (method.type === 'sepa_debit' ? method.sepa_debit?.last4 ?? '' : ''),
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
    isDefault: method.id === defaultId,
  };
}

function paymentMethodIdOf(value: string | Stripe.PaymentMethod | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

async function loadStripeBillingState(customerId: string): Promise<{
  customerEmail: string | null;
  paymentMethods: PaymentMethodSummary[];
  trialEligible: boolean;
  liveSubscription: Stripe.Subscription | null;
}> {
  const stripe = getStripeServer();
  const [customer, methods, subscriptions] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.customers.listPaymentMethods(customerId, { limit: 20 }),
    listCustomerSubscriptions(customerId),
  ]);
  if (!isStripeCustomer(customer)) {
    return { customerEmail: null, paymentMethods: [], trialEligible: true, liveSubscription: null };
  }

  // Le moyen par défaut : celui du client, sinon celui de l'abonnement vivant.
  const liveSubscription = subscriptions.find((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) ?? null;
  const defaultId =
    paymentMethodIdOf(customer.invoice_settings?.default_payment_method) ??
    paymentMethodIdOf(liveSubscription?.default_payment_method);

  const paymentMethods = methods.data
    .map((method) => summarizePaymentMethod(method, defaultId))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));

  return {
    customerEmail: customer.email ?? null,
    paymentMethods,
    trialEligible: isTrialEligible(subscriptions),
    liveSubscription,
  };
}

/**
 * Vue d'ensemble de la facturation. Avec un client Stripe, l'abonnement est lu
 * chez Stripe (jamais en retard sur un webhook, au retour du portail par
 * exemple) et la copie Appwrite est remise à jour au passage.
 */
export async function buildBillingOverview(userId: string): Promise<BillingOverview> {
  const customerRow = await getCustomerRow(userId);
  const customerId = customerRow?.stripe_customer_id
    ? await getValidatedStripeCustomerId(customerRow.stripe_customer_id)
    : null;

  if (!customerId) {
    return {
      subscription: await getSubscriptionSnapshot(userId),
      trialEligible: true,
      contactPreference: toContactPreference(customerRow),
      customerEmail: null,
      paymentMethod: null,
      paymentMethods: [],
    };
  }

  const stripeState = await loadStripeBillingState(customerId);
  if (stripeState.liveSubscription) await upsertSubscription(stripeState.liveSubscription, userId);

  return {
    subscription: stripeState.liveSubscription ? snapshotFromStripeSubscription(stripeState.liveSubscription) : NO_SUBSCRIPTION,
    trialEligible: stripeState.trialEligible,
    contactPreference: toContactPreference(customerRow),
    customerEmail: stripeState.customerEmail,
    paymentMethod: stripeState.paymentMethods.find((method) => method.isDefault) ?? stripeState.paymentMethods[0] ?? null,
    paymentMethods: stripeState.paymentMethods,
  };
}

/**
 * Enregistre l'e-mail de facturation et le reporte sur le client Stripe : c'est
 * là que Stripe envoie reçus et factures.
 */
export async function saveBillingContactPreference(
  userId: string,
  accountEmail: string | null,
  preference: BillingContactPreference,
): Promise<BillingContactPreference> {
  const db = getAppwriteDatabases();
  const payload = {
    billing_email_mode: preference.mode,
    billing_email:
      preference.mode === 'alternative' && preference.alternativeEmail.trim() ? preference.alternativeEmail.trim() : null,
  };

  const row = await getCustomerRow(userId);
  if (row) {
    await db.updateDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, payload);
  } else {
    await db.createDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, {
      user_id: userId,
      stripe_customer_id: '',
      ...payload,
    });
  }

  const customerId = row?.stripe_customer_id ? await getValidatedStripeCustomerId(row.stripe_customer_id) : null;
  const email = billingEmailFor({ stripe_customer_id: customerId, ...payload }, accountEmail);
  if (customerId && email) {
    await getStripeServer().customers.update(customerId, { email });
  }

  return { mode: preference.mode, alternativeEmail: payload.billing_email ?? '' };
}
