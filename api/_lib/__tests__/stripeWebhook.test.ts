import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

/**
 * Webhook Stripe : un e-mail d'abonnement dû au client (confirmation de
 * résiliation, rappel de reconduction, fin d'essai) qui ne part pas fait
 * échouer l'évènement (500) pour que Stripe le relivre — sauf sans clé
 * Resend (développement), où rien ne part de toute façon.
 */

const mocks = vi.hoisted(() => ({
  event: null as unknown,
  sendSubscriptionCanceledEmail: vi.fn(),
  captureServerError: vi.fn(),
  upsertSubscription: vi.fn(async () => {}),
}));

const SUBSCRIPTION = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: true,
  cancel_at: null,
  items: { data: [{ current_period_end: 1_790_000_000, price: { id: 'price_m', unit_amount: 1490, currency: 'eur' } }] },
};

vi.mock('../stripe.js', () => ({
  getStripeServer: () => ({
    webhooks: { constructEvent: () => mocks.event },
    subscriptions: { retrieve: async () => SUBSCRIPTION },
    customers: { retrieve: async () => ({ email: 'client@example.com', name: 'Client' }) },
  }),
}));
vi.mock('../config.js', () => ({ requireEnv: () => 'whsec_test' }));
vi.mock('../billing.js', () => ({
  activateTrialSubscription: vi.fn(),
  billingManageUrl: () => 'https://app.redview.tech/?billing=1',
  getSubscriptionIdFromInvoice: () => 'sub_1',
  getUserIdFromCustomer: async () => 'u1',
  upsertSubscription: mocks.upsertSubscription,
}));
vi.mock('../billing/prices.js', () => ({ planIdForPrice: () => 'monthly' }));
vi.mock('../mailer.js', () => ({
  sendSubscriptionCanceledEmail: mocks.sendSubscriptionCanceledEmail,
  sendRenewalReminderEmail: vi.fn(async () => ({ sent: true })),
  sendTrialEndingEmail: vi.fn(async () => ({ sent: true })),
}));
vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError: mocks.captureServerError }));

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  return (await import('../../stripe/webhook')).default as Handler;
}

function cancellationEvent(id: string) {
  return {
    id,
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1' }, previous_attributes: { cancel_at_period_end: false } },
  };
}

async function deliver(handler: Handler): Promise<number> {
  let status = 200;
  const res = {
    status(code: number) { status = code; return res; },
    json() { return res; },
    setHeader() { return res; },
  } as unknown as ApiResponse;
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=sig' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); },
  } as unknown as ApiRequest;
  await handler(req, res);
  return status;
}

describe('api/stripe/webhook — e-mails dus au client', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.sendSubscriptionCanceledEmail.mockReset();
    mocks.captureServerError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fait relivrer l’évènement (500, signalé) quand la confirmation de résiliation ne part pas, puis l’envoie à la relivraison', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    const handler = await loadHandler();
    mocks.event = cancellationEvent('evt_cancel_1');
    mocks.sendSubscriptionCanceledEmail.mockResolvedValueOnce({ sent: false });
    expect(await deliver(handler)).toBe(500);
    expect(mocks.captureServerError).toHaveBeenCalledTimes(1);

    mocks.sendSubscriptionCanceledEmail.mockResolvedValueOnce({ sent: true });
    expect(await deliver(handler)).toBe(200);
    expect(mocks.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendSubscriptionCanceledEmail.mock.calls[1]?.[0]).toMatchObject({ to: 'client@example.com' });

    // Évènement traité : une nouvelle relivraison n'envoie plus rien.
    expect(await deliver(handler)).toBe(200);
    expect(mocks.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(2);
  });

  it('sans clé Resend (développement), acquitte l’évènement : rien ne partirait de toute façon', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const handler = await loadHandler();
    mocks.event = cancellationEvent('evt_cancel_dev');
    mocks.sendSubscriptionCanceledEmail.mockResolvedValueOnce({ sent: false });
    expect(await deliver(handler)).toBe(200);
    expect(mocks.captureServerError).not.toHaveBeenCalled();
  });
});
