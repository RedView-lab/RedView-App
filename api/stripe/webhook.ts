import type { VercelRequest, VercelResponse } from '@vercel/node';
import type Stripe from 'stripe';

import {
  getSubscriptionIdFromInvoice,
  getUserIdFromCustomer,
  upsertSubscription,
} from '../_lib/billing.js';
import { readRawBody, sendMethodNotAllowed } from '../_lib/http.js';
import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getStripeServer } from '../_lib/stripe.js';
import { requireEnv } from '../_lib/config.js';

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;

  if (!userId || !subscriptionId) {
    return;
  }

  const subscription = await getStripeServer().subscriptions.retrieve(subscriptionId);
  await upsertSubscription(subscription, userId);
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId || typeof invoice.customer !== 'string') {
    return;
  }

  const [subscription, userId] = await Promise.all([
    getStripeServer().subscriptions.retrieve(subscriptionId),
    getUserIdFromCustomer(invoice.customer),
  ]);

  if (!userId) {
    return;
  }

  await upsertSubscription(subscription, userId);
  await syncDefaultPaymentMethodFromInvoice(invoice);
}

async function syncDefaultPaymentMethodFromInvoice(invoice: Stripe.Invoice) {
  if (invoice.billing_reason !== 'subscription_create' || typeof invoice.customer !== 'string') {
    return;
  }

  const paymentIntentRef = invoice.payment_intent;
  const paymentIntentId =
    typeof paymentIntentRef === 'string' ? paymentIntentRef : paymentIntentRef?.id ?? null;

  if (!paymentIntentId) {
    return;
  }

  const paymentIntent = await getStripeServer().paymentIntents.retrieve(paymentIntentId);
  const paymentMethodId =
    typeof paymentIntent.payment_method === 'string'
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null;

  if (!paymentMethodId) {
    return;
  }

  await getStripeServer().customers.update(invoice.customer, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (subscriptionId) {
    await getStripeServer().subscriptions.update(subscriptionId, {
      default_payment_method: paymentMethodId,
    });
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId || typeof invoice.customer !== 'string') {
    return;
  }

  const [subscription, userId] = await Promise.all([
    getStripeServer().subscriptions.retrieve(subscriptionId),
    getUserIdFromCustomer(invoice.customer),
  ]);

  if (!userId) {
    return;
  }

  await upsertSubscription(subscription, userId);
}

async function handleSubscriptionChanged(subscription: Stripe.Subscription) {
  const userId =
    subscription.metadata?.user_id ||
    (typeof subscription.customer === 'string'
      ? await getUserIdFromCustomer(subscription.customer)
      : null);

  if (!userId) {
    return;
  }

  await upsertSubscription(subscription, userId);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const { error } = await getSupabaseAdmin()
    .from('subscriptions')
    .update({
      status: 'canceled',
      cancel_at_period_end: false,
    })
    .eq('id', subscription.id);

  if (error) {
    throw error;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    event = getStripeServer().webhooks.constructEvent(
      rawBody,
      signature,
      requireEnv('STRIPE_WEBHOOK_SECRET'),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[stripe/webhook] Signature verification failed:', message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        console.log(`[stripe/webhook] Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error(`[stripe/webhook] Error handling ${event.type}:`, error);
  }

  return res.status(200).json({ received: true });
}
