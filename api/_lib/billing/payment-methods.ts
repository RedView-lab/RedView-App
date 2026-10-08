import { PublicError } from '../errors.js';
import { getStripeServer } from '../stripe.js';
import { getOrCreateStripeCustomer, getStripeCustomerId } from './customers.js';
import { setupIntentPaymentMethodParams } from './paymentMethodConfig.js';
import { buildBillingOverview, type BillingOverview } from './overview.js';
import { getLiveStripeSubscription } from './subscriptions.js';

// Ajout / remplacement du moyen de paiement dans l'app (SetupIntent + Payment
// Element). Le nouveau moyen devient celui du client et de l'abonnement vivant :
// la prochaine échéance est prélevée dessus.

export async function createPaymentMethodSetupIntent(
  userId: string,
  accountEmail: string | null,
): Promise<{ clientSecret: string }> {
  const customerId = await getOrCreateStripeCustomer(userId, accountEmail);
  const setupIntent = await getStripeServer().setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    ...(await setupIntentPaymentMethodParams()),
    metadata: { purpose: 'redview_payment_method', user_id: userId },
  });
  if (!setupIntent.client_secret) throw new Error('Stripe returned a SetupIntent without client secret.');
  return { clientSecret: setupIntent.client_secret };
}

async function makeDefaultPaymentMethod(userId: string, customerId: string, paymentMethodId: string): Promise<void> {
  const stripe = getStripeServer();
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const subscription = await getLiveStripeSubscription(userId);
  if (subscription) {
    await stripe.subscriptions.update(subscription.id, { default_payment_method: paymentMethodId });
  }
}

export async function applySetupIntentPaymentMethod(userId: string, setupIntentId: string): Promise<BillingOverview> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new PublicError('No billing profile found for this account.', 404);

  const setupIntent = await getStripeServer().setupIntents.retrieve(setupIntentId);
  const setupCustomer = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  if (setupCustomer !== customerId) {
    throw new PublicError('This payment setup does not belong to the current user.', 403);
  }
  if (setupIntent.status !== 'succeeded') {
    throw new PublicError('The payment method is not confirmed yet.', 409);
  }
  const paymentMethodId =
    typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method?.id;
  if (!paymentMethodId) throw new Error('Stripe did not return a saved payment method.');

  await makeDefaultPaymentMethod(userId, customerId, paymentMethodId);
  return buildBillingOverview(userId);
}

export async function setDefaultPaymentMethod(userId: string, paymentMethodId: string): Promise<BillingOverview> {
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new PublicError('No billing profile found for this account.', 404);

  const paymentMethod = await getStripeServer().paymentMethods.retrieve(paymentMethodId);
  const owner = typeof paymentMethod.customer === 'string' ? paymentMethod.customer : paymentMethod.customer?.id ?? null;
  if (owner !== customerId) {
    throw new PublicError('This payment method does not belong to the current user.', 403);
  }

  await makeDefaultPaymentMethod(userId, customerId, paymentMethodId);
  return buildBillingOverview(userId);
}
