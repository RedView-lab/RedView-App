import { getStripeServer } from '../stripe.js';
import { PublicError } from '../errors.js';
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
    throw new PublicError('No Stripe customer found for this account.', 404);
  }

  const setupIntent = (await getStripeServer().setupIntents.retrieve(setupIntentId, {
    expand: ['payment_method'],
  })) as SetupIntentWithPaymentMethod;

  const setupIntentCustomer =
    typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;

  if (setupIntentCustomer !== stripeCustomerId) {
    throw new PublicError('This setup intent does not belong to the current user.', 403);
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

export async function setDefaultPaymentMethod(userId: string, paymentMethodId: string) {
  const stripeCustomerId = await getStripeCustomerId(userId);
  if (!stripeCustomerId) {
    throw new PublicError('No Stripe customer found for this account.', 404);
  }

  const paymentMethod = await getStripeServer().paymentMethods.retrieve(paymentMethodId);
  const paymentMethodCustomer =
    typeof paymentMethod.customer === 'string' ? paymentMethod.customer : paymentMethod.customer?.id ?? null;

  if (paymentMethodCustomer !== stripeCustomerId) {
    throw new PublicError('This payment method does not belong to the current user.', 403);
  }

  if (paymentMethod.type !== 'card') {
    throw new PublicError('Only card payment methods can be set as default.', 400);
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