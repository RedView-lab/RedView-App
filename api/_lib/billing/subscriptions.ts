import type Stripe from 'stripe';
import { Query } from 'node-appwrite';

import {
  APPWRITE_DATABASE_ID,
  SUBSCRIPTIONS_COLLECTION_ID,
  getAppwriteDatabases,
} from '../appwrite.js';
import { PublicError } from '../errors.js';
import { createKeyedLock } from '../keyedLock.js';
import { getStripeServer } from '../stripe.js';
import { getOrCreateStripeCustomer, getStripeCustomerId } from './customers.js';
import { isBillingPlanId, TRIAL_DAYS, type BillingPlanId } from './plans.js';
import { setupIntentPaymentMethodParams, subscriptionPaymentMethodTypes } from './paymentMethodConfig.js';
import { getPlanPrice, planIdForPrice, planIdForPriceId } from './prices.js';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
  isTrialEligible,
  pickCurrentSubscription,
  type ExpandedInvoice,
  type StoredSubscriptionRow,
  type SubscriptionActionResult,
  type SubscriptionSnapshot,
  type SubscriptionStartResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Cycle de vie de l'abonnement.
//
//  - Première souscription (essai) : un SetupIntent enregistre le moyen de
//    paiement sans rien prélever, puis l'abonnement est créé en essai de
//    7 jours avec ce moyen par défaut (`activateTrialSubscription`, appelé
//    par l'app après confirmation et par le webhook `setup_intent.succeeded`
//    en secours — même clé d'idempotence, donc un seul abonnement). Un essai
//    n'existe jamais sans moyen de paiement enregistré.
//  - Souscriptions suivantes (essai déjà consommé) : l'abonnement est créé
//    `default_incomplete` et l'app paie sa première facture.
//  - Changement de durée, factures : portail client Stripe (`portal.ts`).
//
// Stripe fait foi : les lignes `subscriptions` d'Appwrite en sont une copie
// tenue à jour par le webhook et par chaque action.
// ---------------------------------------------------------------------------

/** Métadonnée `purpose` des SetupIntents qui ouvrent un essai. */
export const TRIAL_SETUP_PURPOSE = 'redview_trial';

/**
 * Opérations d'abonnement en cours, par client Stripe. Sans elles, deux
 * onglets qui confirment chacun un essai (deux SetupIntents, donc deux clés
 * d'idempotence) au même instant lisaient tous deux « aucun abonnement » et
 * en créaient deux : deux prélèvements à la fin de l'essai. Idem pour deux
 * souscriptions payantes.
 */
const withCustomerLock = createKeyedLock('billing-customer');

function customerIdOf(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function toIso(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

export function snapshotFromStripeSubscription(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const item = subscription.items.data[0];
  return {
    subscriptionId: subscription.id,
    isSubscribed: ENTITLED_SUBSCRIPTION_STATUSES.has(subscription.status),
    status: subscription.status,
    planId: planIdForPrice(item?.price),
    priceId: item?.price?.id ?? null,
    currentPeriodEnd: toIso(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at != null,
  };
}

export const NO_SUBSCRIPTION: SubscriptionSnapshot = {
  subscriptionId: null,
  isSubscribed: false,
  status: 'none',
  planId: null,
  priceId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

async function listStoredSubscriptions(userId: string): Promise<StoredSubscriptionRow[]> {
  const res = await getAppwriteDatabases().listDocuments(APPWRITE_DATABASE_ID, SUBSCRIPTIONS_COLLECTION_ID, [
    Query.equal('user_id', userId),
    Query.limit(100),
  ]);
  return res.documents.map((doc) => ({
    id: doc.$id,
    status: typeof doc.status === 'string' ? doc.status : null,
    price_id: typeof doc.price_id === 'string' ? doc.price_id : null,
    cancel_at_period_end: Boolean(doc.cancel_at_period_end),
    current_period_end: typeof doc.current_period_end === 'string' ? doc.current_period_end : null,
  }));
}

/** État de l'abonnement d'un compte, lu dans la copie Appwrite (aucun appel Stripe). */
export async function getSubscriptionSnapshot(userId: string): Promise<SubscriptionSnapshot> {
  const row = pickCurrentSubscription(await listStoredSubscriptions(userId));
  if (!row?.status) return NO_SUBSCRIPTION;
  return {
    subscriptionId: row.id,
    isSubscribed: ENTITLED_SUBSCRIPTION_STATUSES.has(row.status),
    status: row.status,
    planId: await planIdForPriceId(row.price_id),
    priceId: row.price_id,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

/** Tous les abonnements d'un client Stripe, terminés compris (Stripe les garde). */
export async function listCustomerSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const result = await getStripeServer().subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  return result.data;
}

/** Abonnement vivant du compte, lu chez Stripe (pas dans la copie). */
export async function getLiveStripeSubscription(userId: string): Promise<Stripe.Subscription | null> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) return null;
  const subscriptions = await listCustomerSubscriptions(customerId);
  return subscriptions.find((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) ?? null;
}

export async function upsertSubscription(subscription: Stripe.Subscription, userId: string): Promise<void> {
  const item = subscription.items.data[0];
  const payload = {
    user_id: userId,
    status: subscription.status,
    price_id: item?.price?.id ?? null,
    current_period_start: toIso(item?.current_period_start),
    current_period_end: toIso(item?.current_period_end),
    cancel_at_period_end: subscription.cancel_at_period_end || subscription.cancel_at != null,
  };

  const db = getAppwriteDatabases();
  try {
    await db.createDocument(APPWRITE_DATABASE_ID, SUBSCRIPTIONS_COLLECTION_ID, subscription.id, payload);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 409) throw error;
    await db.updateDocument(APPWRITE_DATABASE_ID, SUBSCRIPTIONS_COLLECTION_ID, subscription.id, payload);
  }
}

function actionResult(subscription: Stripe.Subscription): SubscriptionActionResult {
  return { subscriptionId: subscription.id, subscription: snapshotFromStripeSubscription(subscription) };
}

/**
 * Lance une souscription. Refusée (409) si le compte a déjà un abonnement
 * vivant ; les tentatives de paiement abandonnées sont annulées.
 */
export async function startSubscription(
  userId: string,
  accountEmail: string | null,
  planId: BillingPlanId,
): Promise<SubscriptionStartResult> {
  const customerId = await getOrCreateStripeCustomer(userId, accountEmail);
  return withCustomerLock(customerId, () => startSubscriptionForCustomer(userId, customerId, planId));
}

async function startSubscriptionForCustomer(
  userId: string,
  customerId: string,
  planId: BillingPlanId,
): Promise<SubscriptionStartResult> {
  const stripe = getStripeServer();
  const [price, subscriptions] = await Promise.all([getPlanPrice(planId), listCustomerSubscriptions(customerId)]);

  if (subscriptions.some((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status))) {
    throw new PublicError('This account already has a subscription.', 409);
  }

  // Une souscription relancée remplace la tentative restée sans paiement.
  for (const subscription of subscriptions) {
    if (subscription.status !== 'incomplete') continue;
    try {
      await stripe.subscriptions.cancel(subscription.id);
    } catch (error) {
      console.warn('[billing] Unable to cancel an abandoned incomplete subscription', error);
    }
  }

  if (isTrialEligible(subscriptions)) {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      ...(await setupIntentPaymentMethodParams()),
      metadata: { purpose: TRIAL_SETUP_PURPOSE, user_id: userId, plan_id: planId },
    });
    if (!setupIntent.client_secret) throw new Error('Stripe returned a SetupIntent without client secret.');
    return {
      intent: 'setup',
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      planId,
      trialDays: TRIAL_DAYS,
    };
  }

  const paymentMethodTypes = await subscriptionPaymentMethodTypes();
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.id }],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      save_default_payment_method: 'on_subscription',
      ...(paymentMethodTypes ? { payment_method_types: paymentMethodTypes } : {}),
    },
    expand: ['latest_invoice.confirmation_secret'],
    metadata: { user_id: userId, plan_id: planId },
  });
  await upsertSubscription(subscription, userId);

  const clientSecret = (subscription.latest_invoice as ExpandedInvoice | null)?.confirmation_secret?.client_secret;
  if (!clientSecret) throw new Error('Stripe returned a subscription without payment to confirm.');
  return { intent: 'payment', clientSecret, subscriptionId: subscription.id, planId };
}

function isIdempotencyConflict(error: unknown): boolean {
  const candidate = error as { type?: unknown; statusCode?: unknown } | null;
  return candidate?.type === 'StripeIdempotencyError' || candidate?.statusCode === 409;
}

/**
 * Crée l'abonnement en essai à partir d'un SetupIntent confirmé. Idempotent :
 * l'app et le webhook peuvent l'appeler tous les deux, dans n'importe quel
 * ordre, et un seul abonnement existe.
 */
export function activateTrialSubscription(
  setupIntentId: string,
  owner: { userId: string; customerId: string },
): Promise<SubscriptionActionResult> {
  return withCustomerLock(owner.customerId, () => activateTrialSubscriptionForCustomer(setupIntentId, owner));
}

async function activateTrialSubscriptionForCustomer(
  setupIntentId: string,
  owner: { userId: string; customerId: string },
): Promise<SubscriptionActionResult> {
  const stripe = getStripeServer();
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

  if (customerIdOf(setupIntent.customer) !== owner.customerId) {
    throw new PublicError('This payment setup does not belong to the current user.', 403);
  }
  if (setupIntent.metadata?.purpose !== TRIAL_SETUP_PURPOSE || setupIntent.metadata.user_id !== owner.userId) {
    throw new PublicError('This payment setup does not start a subscription.', 400);
  }
  if (setupIntent.status !== 'succeeded') {
    throw new PublicError('The payment method is not confirmed yet.', 409);
  }
  const planId = setupIntent.metadata.plan_id;
  const paymentMethodId =
    typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method?.id;
  if (!isBillingPlanId(planId) || !paymentMethodId) {
    throw new Error(`SetupIntent ${setupIntent.id} misses its plan or payment method.`);
  }

  const findExisting = async () => {
    const subscriptions = await listCustomerSubscriptions(owner.customerId);
    return {
      subscriptions,
      fromThisSetup: subscriptions.find((subscription) => subscription.metadata?.setup_intent === setupIntent.id) ?? null,
      live: subscriptions.find((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) ?? null,
    };
  };

  const existing = await findExisting();
  const already = existing.fromThisSetup ?? existing.live;
  if (already) {
    await upsertSubscription(already, owner.userId);
    return actionResult(already);
  }
  if (!isTrialEligible(existing.subscriptions)) {
    throw new PublicError('The free trial has already been used on this account.', 409);
  }

  const price = await getPlanPrice(planId);
  await stripe.customers.update(owner.customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.create(
      {
        customer: owner.customerId,
        items: [{ price: price.id }],
        default_payment_method: paymentMethodId,
        trial_period_days: TRIAL_DAYS,
        // Moyen de paiement retiré pendant l'essai : l'abonnement s'arrête
        // au lieu de passer en impayé.
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata: { user_id: owner.userId, plan_id: planId, setup_intent: setupIntent.id },
      },
      { idempotencyKey: `redview-trial-${setupIntent.id}` },
    );
  } catch (error) {
    // L'autre appelant (app ou webhook) crée le même abonnement au même instant.
    if (!isIdempotencyConflict(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const retry = await findExisting();
    if (!retry.fromThisSetup) throw error;
    subscription = retry.fromThisSetup;
  }

  await upsertSubscription(subscription, owner.userId);
  return actionResult(subscription);
}

/** Version « compte » de l'activation, pour l'API : le client est celui du compte. */
export async function activateTrialForUser(userId: string, setupIntentId: string): Promise<SubscriptionActionResult> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new PublicError('No billing profile found for this account.', 404);
  return activateTrialSubscription(setupIntentId, { userId, customerId });
}

/** Relit un abonnement du compte chez Stripe et met la copie à jour. */
export async function syncSubscription(userId: string, subscriptionId: string): Promise<SubscriptionActionResult> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new PublicError('No billing profile found for this account.', 404);

  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId);
  if (customerIdOf(subscription.customer) !== customerId) {
    throw new PublicError('This subscription does not belong to the current user.', 403);
  }
  await upsertSubscription(subscription, userId);
  return actionResult(subscription);
}

/** Résiliation à la fin de l'échéance (ou de l'essai), et son annulation. */
export async function setSubscriptionCancellation(
  userId: string,
  cancelAtPeriodEnd: boolean,
): Promise<SubscriptionActionResult> {
  const current = await getLiveStripeSubscription(userId);
  if (!current) throw new PublicError('No subscription found for this account.', 404);

  // Stripe refuse `cancel_at_period_end` et `cancel_at` ensemble ; en mode de
  // facturation `flexible` (défaut de l'API dahlia), `cancel_at_period_end:
  // false` lève aussi une date de fin posée seule par le portail.
  const updated = await getStripeServer().subscriptions.update(current.id, {
    cancel_at_period_end: cancelAtPeriodEnd,
  });
  await upsertSubscription(updated, userId);
  return actionResult(updated);
}

export function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}
