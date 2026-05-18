import { getStripeServer } from '../stripe.js';
import { buildBillingOverview } from './overview.js';
import { getCurrentManagedStripeSubscription } from './subscriptions.js';
import { getOrCreateStripeCustomer, getStripeCustomerId } from './customers.js';
import type { SetupIntentWithPaymentMethod } from './types.js';

export async function createPaymentMethodSetupIntent(
  userId: string,
  email: string | null,
): Promise<{ clientSecret: string }> {
  const stripeCustomerId = await getOrCreateStripeCustomer(userId, email);
  const setupIntent = await getStripeServer().setupIntents.create({
    customer: stripeCustomerId,
    usage: 'off_session',
    payment_method_types: ['card'],
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

export async function applySetupIntentPaymentMethod(userId: string, setupIntentId: string) {
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