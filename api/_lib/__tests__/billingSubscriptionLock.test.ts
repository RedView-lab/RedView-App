import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deux confirmations d'essai simultanées pour le même client (deux onglets,
 * deux SetupIntents différents) : un seul abonnement doit être créé, sinon
 * deux prélèvements partent à la fin de l'essai. Même règle pour deux
 * souscriptions payantes lancées en même temps.
 */

const fake = vi.hoisted(() => {
  interface FakeSubscription {
    id: string;
    status: string;
    trial_start: number | null;
    metadata: Record<string, string>;
    cancel_at_period_end: boolean;
    cancel_at: null;
    items: { data: Array<{ price: { id: string }; current_period_start: number; current_period_end: number }> };
    latest_invoice?: unknown;
  }
  const subscriptions: FakeSubscription[] = [];
  const createdKeys = new Set<string>();
  const stripe = {
    setupIntents: {
      retrieve: async (id: string) => ({
        id,
        customer: 'cus_1',
        status: 'succeeded',
        payment_method: `pm_${id}`,
        metadata: { purpose: 'redview_trial', user_id: 'u1', plan_id: 'monthly' },
      }),
      create: async () => ({ id: 'seti_new', client_secret: 'seti_secret' }),
    },
    subscriptions: {
      list: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: [...subscriptions] };
      },
      create: async (params: { metadata: Record<string, string>; trial_period_days?: number }, options?: { idempotencyKey?: string }) => {
        if (options?.idempotencyKey) {
          if (createdKeys.has(options.idempotencyKey)) throw Object.assign(new Error('idempotency'), { type: 'StripeIdempotencyError' });
          createdKeys.add(options.idempotencyKey);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        const subscription: FakeSubscription = {
          id: `sub_${subscriptions.length + 1}`,
          status: params.trial_period_days ? 'trialing' : 'incomplete',
          trial_start: params.trial_period_days ? 1 : null,
          metadata: params.metadata,
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ price: { id: 'price_monthly' }, current_period_start: 1, current_period_end: 2 }] },
          latest_invoice: { confirmation_secret: { client_secret: 'pi_secret' } },
        };
        subscriptions.push(subscription);
        return subscription;
      },
      cancel: async (id: string) => {
        const subscription = subscriptions.find((candidate) => candidate.id === id);
        if (subscription) subscription.status = 'canceled';
        return subscription;
      },
    },
    customers: { update: async () => ({}) },
  };
  return { subscriptions, createdKeys, stripe };
});

vi.mock('../stripe.js', () => ({ getStripeServer: () => fake.stripe }));
vi.mock('../appwrite.js', () => ({
  APPWRITE_DATABASE_ID: 'db',
  SUBSCRIPTIONS_COLLECTION_ID: 'subscriptions',
  getAppwriteDatabases: () => ({ createDocument: async () => ({}), updateDocument: async () => ({}), listDocuments: async () => ({ documents: [] }) }),
}));
vi.mock('../billing/customers.js', () => ({
  getOrCreateStripeCustomer: async () => 'cus_1',
  getStripeCustomerId: async () => 'cus_1',
}));
vi.mock('../billing/paymentMethodConfig.js', () => ({
  setupIntentPaymentMethodParams: async () => ({}),
  subscriptionPaymentMethodTypes: async () => null,
}));
vi.mock('../billing/prices.js', () => ({
  getPlanPrice: async () => ({ id: 'price_monthly' }),
  planIdForPrice: () => 'monthly',
  planIdForPriceId: async () => 'monthly',
}));

const { activateTrialSubscription, startSubscription } = await import('../billing/subscriptions.js');

beforeEach(() => {
  fake.subscriptions.length = 0;
  fake.createdKeys.clear();
});

describe('abonnements : un seul à la fois par client', () => {
  it('deux essais confirmés au même instant (deux SetupIntents) ne créent qu’un abonnement', async () => {
    const owner = { userId: 'u1', customerId: 'cus_1' };
    const [first, second] = await Promise.all([
      activateTrialSubscription('seti_tab_a', owner),
      activateTrialSubscription('seti_tab_b', owner),
    ]);
    expect(fake.subscriptions).toHaveLength(1);
    expect(second.subscriptionId).toBe(first.subscriptionId);
  });

  it('deux souscriptions payantes lancées au même instant : la seconde est refusée ou réutilise la tentative', async () => {
    // Essai déjà consommé : abonnement payant direct.
    fake.subscriptions.push({
      id: 'sub_old', status: 'canceled', trial_start: 1, metadata: {}, cancel_at_period_end: false, cancel_at: null,
      items: { data: [{ price: { id: 'price_monthly' }, current_period_start: 1, current_period_end: 2 }] },
    });
    const results = await Promise.allSettled([
      startSubscription('u1', 'u1@example.test', 'monthly'),
      startSubscription('u1', 'u1@example.test', 'monthly'),
    ]);
    const incomplete = fake.subscriptions.filter((subscription) => subscription.status === 'incomplete');
    expect(incomplete).toHaveLength(1);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});
