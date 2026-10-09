import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import type Stripe from 'stripe';

import { captureServerError } from '../../server/lib/observability.mjs';
import { createOldestKeyTaker } from '../../server/lib/oldest-key.mjs';
import {
  activateTrialSubscription,
  billingManageUrl,
  getSubscriptionIdFromInvoice,
  getUserIdFromCustomer,
  upsertSubscription,
} from '../_lib/billing.js';
import { getBillingPlan } from '../_lib/billing/plans.js';
import { planIdForPrice } from '../_lib/billing/prices.js';
import { TRIAL_SETUP_PURPOSE } from '../_lib/billing/subscriptions.js';
import { PublicError } from '../_lib/errors.js';
import { readRawBody, sendMethodNotAllowed } from '../_lib/http.js';
import { sendRenewalReminderEmail, sendSubscriptionCanceledEmail, sendTrialEndingEmail } from '../_lib/mailer.js';
import { getStripeServer } from '../_lib/stripe.js';
import { requireEnv } from '../_lib/config.js';

// ---------------------------------------------------------------------------
// Webhook Stripe : tient la copie Appwrite des abonnements à jour et envoie
// les e-mails d'abonnement. Chaque évènement relit l'objet chez Stripe au lieu
// de croire sa charge : l'ordre de livraison n'est pas garanti, l'état relu
// est toujours le dernier. Un échec répond 500 et Stripe relivre (jusqu'à
// 3 jours) ; un refus attendu (PublicError) est acquitté.
//
// Évènements à abonner sur le point de terminaison : WEBHOOK_EVENTS
// (api/_lib/billing/webhookEvents.ts, que scripts/billing/setup-stripe.ts utilise).
// ---------------------------------------------------------------------------

/**
 * Évènements déjà traités (relivraisons de Stripe), en mémoire du processus :
 * un redémarrage l'oublie, les traitements restent idempotents (upsert) ; ce
 * filtre évite surtout d'envoyer deux fois un même e-mail.
 */
const MAX_PROCESSED_EVENT_IDS = 2000;
const processedEventIds = new Map<string, true>();
const takeOldestEventId = createOldestKeyTaker(processedEventIds);

function markEventProcessed(eventId: string): void {
  processedEventIds.set(eventId, true);
  while (processedEventIds.size > MAX_PROCESSED_EVENT_IDS) {
    const oldest = takeOldestEventId();
    if (oldest === undefined) break;
    processedEventIds.delete(oldest);
  }
}

function customerIdOf(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

const PLAN_LABELS = { monthly: 'formule 1 mois', semiannual: 'formule 6 mois', annual: 'formule 1 an' } as const;

function formatDate(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' });
}

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

/** Destinataire des e-mails d'abonnement : l'e-mail de facturation du client Stripe. */
async function emailRecipient(customerId: string): Promise<{ to: string; name?: string } | null> {
  const customer = await getStripeServer().customers.retrieve(customerId);
  if (customer.deleted || !customer.email) return null;
  return { to: customer.email, ...(customer.name ? { name: customer.name } : {}) };
}

/** Compte RedView d'un abonnement (null : client supprimé avec son compte). */
async function syncSubscriptionById(subscriptionId: string): Promise<{ subscription: Stripe.Subscription; userId: string } | null> {
  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId);
  const customerId = customerIdOf(subscription.customer);
  const userId = customerId ? await getUserIdFromCustomer(customerId) : null;
  if (!userId) {
    console.warn(`[stripe/webhook] No RedView account for subscription ${subscription.id}`);
    return null;
  }
  await upsertSubscription(subscription, userId);
  return { subscription, userId };
}

function planOf(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  const planId = planIdForPrice(item?.price);
  return { item, planId, planLabel: planId ? PLAN_LABELS[planId] : 'abonnement RedView' };
}

/** Le moyen de paiement de l'abonnement devient celui du client s'il n'en a pas. */
async function adoptSubscriptionPaymentMethod(subscription: Stripe.Subscription): Promise<void> {
  const customerId = customerIdOf(subscription.customer);
  const paymentMethod = subscription.default_payment_method;
  const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id;
  if (!customerId || !paymentMethodId) return;
  const customer = await getStripeServer().customers.retrieve(customerId);
  if (customer.deleted || customer.invoice_settings?.default_payment_method) return;
  await getStripeServer().customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
}

async function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent): Promise<void> {
  if (setupIntent.metadata?.purpose !== TRIAL_SETUP_PURPOSE) return;
  const customerId = customerIdOf(setupIntent.customer);
  const userId = customerId ? await getUserIdFromCustomer(customerId) : null;
  if (!customerId || !userId || userId !== setupIntent.metadata.user_id) {
    console.warn(`[stripe/webhook] SetupIntent ${setupIntent.id} does not match a RedView account`);
    return;
  }
  // Secours : l'app crée l'abonnement après la confirmation ; si l'onglet a
  // été fermé entre-temps (redirection PayPal, réseau), il naît ici.
  await activateTrialSubscription(setupIntent.id, { userId, customerId });
}

async function handleSubscriptionUpdated(event: Stripe.CustomerSubscriptionUpdatedEvent): Promise<void> {
  const synced = await syncSubscriptionById(event.data.object.id);
  if (!synced) return;
  const { subscription } = synced;

  // Résiliation demandée (app ou portail) : confirmation sur support durable.
  const previous = event.data.previous_attributes ?? {};
  const wasCanceling = previous.cancel_at_period_end === true || ('cancel_at' in previous && previous.cancel_at != null);
  const becameCanceling =
    ('cancel_at_period_end' in previous || 'cancel_at' in previous) &&
    !wasCanceling &&
    (subscription.cancel_at_period_end || subscription.cancel_at != null);
  if (!becameCanceling) return;

  const { item, planLabel } = planOf(subscription);
  const endDate = formatDate(subscription.cancel_at ?? item?.current_period_end);
  const recipient = await emailRecipient(customerIdOf(subscription.customer)!);
  if (!recipient || !endDate) return;
  await sendSubscriptionCanceledEmail({ ...recipient, planLabel, endDate, manageUrl: billingManageUrl() });
}

async function handleTrialWillEnd(subscriptionId: string): Promise<void> {
  const synced = await syncSubscriptionById(subscriptionId);
  if (!synced) return;
  const { subscription } = synced;
  if (subscription.status !== 'trialing' || subscription.cancel_at_period_end || subscription.cancel_at != null) return;

  const { item, planLabel } = planOf(subscription);
  const chargeDate = formatDate(subscription.trial_end);
  const recipient = await emailRecipient(customerIdOf(subscription.customer)!);
  if (!recipient || !chargeDate || item?.price.unit_amount == null) return;
  await sendTrialEndingEmail({
    ...recipient,
    planLabel,
    amount: formatAmount(item.price.unit_amount, item.price.currency),
    chargeDate,
    manageUrl: billingManageUrl(),
  });
}

/**
 * Reconduction tacite des formules 6 mois et 1 an : information entre 3 mois
 * et 1 mois avant l'échéance (art. L.215-1). Le délai de `invoice.upcoming`
 * se règle dans le Dashboard seulement (Billing → Paramètres → évènements de
 * renouvellement à venir) : 30 jours ou plus — le défaut est J−7.
 */
async function handleInvoiceUpcoming(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId);
  if (subscription.status !== 'active' || subscription.cancel_at_period_end || subscription.cancel_at != null) return;

  const { item, planId, planLabel } = planOf(subscription);
  if (!planId || getBillingPlan(planId).months < 6) return;
  const renewalDate = formatDate(item?.current_period_end);
  const recipient = await emailRecipient(customerIdOf(subscription.customer)!);
  if (!recipient || !renewalDate) return;
  await sendRenewalReminderEmail({
    ...recipient,
    planLabel,
    amount: formatAmount(invoice.amount_due, invoice.currency),
    renewalDate,
    manageUrl: billingManageUrl(),
  });
}

async function handleInvoiceEvent(invoice: Stripe.Invoice, paid: boolean): Promise<void> {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  const synced = await syncSubscriptionById(subscriptionId);
  if (synced && paid && invoice.billing_reason === 'subscription_create') {
    await adoptSubscriptionPaymentMethod(synced.subscription);
  }
}

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'setup_intent.succeeded':
      return handleSetupIntentSucceeded(event.data.object);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event);
    case 'customer.subscription.created':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      await syncSubscriptionById(event.data.object.id);
      return;
    case 'customer.subscription.trial_will_end':
      return handleTrialWillEnd(event.data.object.id);
    case 'invoice.paid':
      return handleInvoiceEvent(event.data.object, true);
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
      return handleInvoiceEvent(event.data.object, false);
    case 'invoice.upcoming':
      return handleInvoiceUpcoming(event.data.object);
    default:
      // Évènement non abonné (ou ajouté au point de terminaison) : acquitté.
      return;
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendMethodNotAllowed(res, ['POST']);
  }

  const signature = req.headers['stripe-signature'];
  if (!signature || Array.isArray(signature)) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  const rawBody = await readRawBody(req);

  let event: Stripe.Event;
  try {
    event = getStripeServer().webhooks.constructEvent(rawBody, signature, requireEnv('STRIPE_WEBHOOK_SECRET'));
  } catch (error) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[stripe/webhook] Signature verification failed:', error instanceof Error ? error.message : error);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  if (processedEventIds.has(event.id)) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    await dispatch(event);
  } catch (error) {
    if (error instanceof PublicError && error.status < 500) {
      // Refus attendu (essai déjà consommé, objet d'un autre compte) : relivrer n'y changerait rien.
      console.warn(`[stripe/webhook] ${event.type} (${event.id}) refused: ${error.message}`);
    } else {
      console.error(`[stripe/webhook] Error handling ${event.type} (${event.id}):`, error);
      // Rattrapée ici, elle n'atteindrait jamais GlitchTip : un abonnement
      // pas synchronisé ou un e-mail pas envoyé doit se voir avant que Stripe
      // abandonne ses relivraisons.
      captureServerError(error, { route: 'stripe/webhook', requestId: req.requestId });
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
  }

  markEventProcessed(event.id);
  return res.status(200).json({ received: true });
}
