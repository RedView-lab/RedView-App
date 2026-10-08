import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApiRequest, ApiResponse } from '../types.js';

/**
 * Parcours d'abonnement de bout en bout sur le VRAI bac à sable Stripe :
 * essai (SetupIntent → abonnement en essai, idempotent), webhook signé
 * (évènements réels rejoués), résiliation / reprise et leurs e-mails, rappel
 * de fin d'essai, souscription payante sans essai, portail client, 3-D Secure.
 *
 * Sauté sauf avec `STRIPE_SANDBOX_E2E=1` (clé `sk_test_` + secret du webhook
 * lus dans `.env`) : `npm run test` et la CI ne touchent jamais Stripe.
 * Appwrite est un faux `node-appwrite` en mémoire (aucune autre variable du
 * `.env` n'est lue : jamais l'Appwrite de production) et le mailer est
 * remplacé (aucun e-mail envoyé). Les clients Stripe créés sont supprimés à
 * la fin.
 *
 *   STRIPE_SANDBOX_E2E=1 npx vitest run api/_lib/__tests__/billing.sandbox.test.ts
 */

const enabled = process.env.STRIPE_SANDBOX_E2E === '1';

type MailCall = { kind: 'canceled' | 'trialEnding' | 'renewal'; args: Record<string, unknown> };

const fake = vi.hoisted(() => ({
  collections: new Map<string, Map<string, Record<string, unknown> & { $id: string }>>(),
  /** JWT → compte, comme `account.get()` d'Appwrite. */
  sessions: new Map<string, { $id: string; email: string }>(),
  mails: [] as Array<{ kind: 'canceled' | 'trialEnding' | 'renewal'; args: Record<string, unknown> }>,
}));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  const error = (code: number) => Object.assign(new Error(`appwrite ${code}`), { code });
  const parse = (queries: string[] = []) =>
    queries.map((raw) => JSON.parse(raw) as { method: string; attribute?: string; values?: unknown[] });
  const collection = (id: string) => {
    if (!fake.collections.has(id)) fake.collections.set(id, new Map());
    return fake.collections.get(id)!;
  };
  class Client {
    jwt: string | null = null;
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
    setJWT(jwt: string) {
      this.jwt = jwt;
      return this;
    }
  }
  class Account {
    private readonly client: Client;
    constructor(client: Client) {
      this.client = client;
    }
    async get() {
      const user = this.client.jwt ? fake.sessions.get(this.client.jwt) : undefined;
      if (!user) throw error(401);
      return { ...user };
    }
  }
  class Databases {
    async getDocument(_db: string, col: string, id: string) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      return { ...doc };
    }
    async listDocuments(_db: string, col: string, queries: string[] = []) {
      let documents = [...collection(col).values()];
      let limit = 25;
      for (const query of parse(queries)) {
        if (query.method === 'equal') documents = documents.filter((doc) => doc[query.attribute!] === query.values![0]);
        if (query.method === 'limit') limit = query.values![0] as number;
      }
      documents = documents.slice(0, limit);
      return { total: documents.length, documents };
    }
    async createDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      const table = collection(col);
      if (table.has(id)) throw error(409);
      table.set(id, { ...data, $id: id });
      return table.get(id);
    }
    async updateDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      Object.assign(doc, data);
      return doc;
    }
  }
  return { ...actual, Client, Account, Databases };
});

vi.mock('../mailer.js', () => {
  const record = (kind: MailCall['kind']) => async (args: Record<string, unknown>) => {
    fake.mails.push({ kind, args });
    return { sent: true };
  };
  return {
    sendSubscriptionCanceledEmail: record('canceled'),
    sendTrialEndingEmail: record('trialEnding'),
    sendRenewalReminderEmail: record('renewal'),
  };
});

/** Seules les clés Stripe sont prises dans `.env`. */
function loadStripeEnv(): { secretKey: string; webhookSecret: string } {
  const env = readFileSync(path.resolve(import.meta.dirname, '../../../.env'), 'utf8');
  const read = (name: string) => {
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') ?? '';
  };
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || read('STRIPE_SECRET_KEY');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || read('STRIPE_WEBHOOK_SECRET');
  if (!secretKey.startsWith('sk_test_')) throw new Error('STRIPE_SANDBOX_E2E needs a sandbox key (sk_test_…).');
  if (!webhookSecret.startsWith('whsec_')) throw new Error('STRIPE_SANDBOX_E2E needs STRIPE_WEBHOOK_SECRET (whsec_…).');
  return { secretKey, webhookSecret };
}

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<unknown>;
/** Union des réponses JSON des routes testées (un champ absent fait échouer son assertion). */
type ResponseBody = {
  error: string;
  intent: 'setup' | 'payment';
  clientSecret: string;
  setupIntentId: string;
  subscriptionId: string;
  trialDays: number;
  url: string;
  trialEligible: boolean;
  subscription: { status: string; planId: string | null; cancelAtPeriodEnd: boolean };
  paymentMethod: { last4: string } | null;
};
type Captured = { status: number; body: ResponseBody };

function makeRes(): { res: ApiResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {} as ResponseBody };
  const res = {
    setHeader: () => res,
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(data: unknown) {
      captured.body = data as ResponseBody;
      return res;
    },
  } as unknown as ApiResponse;
  return { res, captured };
}

function makeReq(method: string, headers: Record<string, string>, body?: unknown, raw?: string): ApiRequest {
  const stream = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
  return Object.assign(stream, { method, headers, query: {}, body }) as unknown as ApiRequest;
}

const ORIGIN = 'http://localhost:5173';
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Espaces fines / insécables de `Intl` (`\s` les couvre) ramenées à une espace simple. */
const plain = (value: unknown) => String(value).replace(/\s+/g, ' ');

describe.skipIf(!enabled)('facturation sur le bac à sable Stripe', { timeout: 120_000 }, () => {
  let stripe: Stripe;
  let webhookSecret: string;
  let subscriptionHandler: Handler;
  let overviewHandler: Handler;
  let portalHandler: Handler;
  let webhookHandler: Handler;
  const createdCustomers = new Set<string>();
  const startedAt = Math.floor(Date.now() / 1000) - 5;

  const alice = { id: `sbx-alice-${runId}`, email: `sandbox+alice-${runId}@example.com`, jwt: `jwt-alice-${runId}` };
  const carol = { id: `sbx-carol-${runId}`, email: `sandbox+carol-${runId}@example.com`, jwt: `jwt-carol-${runId}` };
  let aliceCustomerId = '';
  let aliceSetupIntentId = '';
  let aliceTrialSubscriptionId = '';

  async function call(handler: Handler, user: { jwt: string }, method: string, body?: unknown): Promise<Captured> {
    const { res, captured } = makeRes();
    await handler(makeReq(method, { authorization: `Bearer ${user.jwt}`, origin: ORIGIN }, body), res);
    return captured;
  }

  async function postWebhook(event: { id: string; type: string; data: unknown; [key: string]: unknown }): Promise<Captured> {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const { res, captured } = makeRes();
    await webhookHandler(makeReq('POST', { 'stripe-signature': header }, undefined, payload), res);
    return captured;
  }

  /** Évènement forgé (même forme qu'un vrai), pour un type que le bac à sable n'émet pas à la demande. */
  function forgeEvent(type: string, object: unknown, previous?: Record<string, unknown>) {
    return {
      id: `evt_sbx_${runId}_${Math.random().toString(36).slice(2, 10)}`,
      object: 'event',
      api_version: '2026-04-22.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type,
      data: { object, ...(previous ? { previous_attributes: previous } : {}) },
    };
  }

  function customerOfEvent(event: Stripe.Event): string | null {
    const customer = (event.data.object as { customer?: unknown }).customer;
    if (typeof customer === 'string') return customer;
    return (customer as { id?: string } | null)?.id ?? null;
  }

  /** Évènements réels du client depuis le début du test ; attend ceux qu'on exige (Stripe les publie en différé). */
  async function eventsFor(customerId: string, required: string[]): Promise<Stripe.Event[]> {
    let events: Stripe.Event[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      events = [];
      for await (const event of stripe.events.list({ created: { gte: startedAt }, limit: 100 })) {
        if (customerOfEvent(event) === customerId) events.push(event);
      }
      if (required.every((type) => events.some((event) => event.type === type))) break;
      await sleep(1500);
    }
    return events.sort((left, right) => left.created - right.created);
  }

  async function listAll(customerId: string) {
    return (await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })).data;
  }

  beforeAll(async () => {
    const keys = loadStripeEnv();
    webhookSecret = keys.webhookSecret;
    // Appwrite factice : `node-appwrite` est remplacé, ces valeurs ne sont jamais contactées.
    Object.assign(process.env, {
      STRIPE_SECRET_KEY: keys.secretKey,
      STRIPE_WEBHOOK_SECRET: keys.webhookSecret,
      APPWRITE_ENDPOINT: 'http://appwrite.invalid/v1',
      APPWRITE_PROJECT_ID: 'sandbox-test',
      APPWRITE_API_KEY: 'sandbox-test-key',
      APPWRITE_DATABASE_ID: 'sandbox-db',
      APP_BASE_URL: ORIGIN,
      SENTRY_DSN_SERVER: '',
    });
    stripe = new Stripe(keys.secretKey);
    fake.sessions.set(alice.jwt, { $id: alice.id, email: alice.email });
    fake.sessions.set(carol.jwt, { $id: carol.id, email: carol.email });

    subscriptionHandler = (await import('../../billing/subscription.ts')).default;
    overviewHandler = (await import('../../billing/overview.ts')).default;
    portalHandler = (await import('../../billing/portal.ts')).default;
    webhookHandler = (await import('../../stripe/webhook.ts')).default;
  });

  afterAll(async () => {
    if (!stripe) return;
    for (const customerId of createdCustomers) {
      try {
        await stripe.customers.del(customerId);
      } catch (error) {
        console.warn(`[sandbox] could not delete ${customerId}`, error);
      }
    }
  });

  it('a) essai : start → SetupIntent, activate → abonnement en essai, idempotent ; overview', async () => {
    const start = await call(subscriptionHandler, alice, 'POST', { action: 'start', planId: 'monthly' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.intent).toBe('setup');
    expect(start.body.trialDays).toBe(7);
    expect(start.body.setupIntentId).toMatch(/^seti_/);
    aliceSetupIntentId = start.body.setupIntentId;

    const setupIntent = await stripe.setupIntents.retrieve(aliceSetupIntentId);
    aliceCustomerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer!.id;
    createdCustomers.add(aliceCustomerId);

    const confirmed = await stripe.setupIntents.confirm(aliceSetupIntentId, {
      payment_method: 'pm_card_visa',
      return_url: `${ORIGIN}/?tab=subscription`,
    });
    expect(confirmed.status).toBe('succeeded');

    const activate = await call(subscriptionHandler, alice, 'POST', { action: 'activate', setupIntentId: aliceSetupIntentId });
    expect(activate.status, JSON.stringify(activate.body)).toBe(200);
    expect(activate.body.subscription.status).toBe('trialing');
    expect(activate.body.subscription.planId).toBe('monthly');
    aliceTrialSubscriptionId = activate.body.subscriptionId;

    const subscription = await stripe.subscriptions.retrieve(aliceTrialSubscriptionId);
    const sevenDays = Date.now() / 1000 + 7 * 86_400;
    expect(Math.abs((subscription.trial_end ?? 0) - sevenDays)).toBeLessThan(3600);
    expect(subscription.default_payment_method).toBe(confirmed.payment_method);

    const again = await call(subscriptionHandler, alice, 'POST', { action: 'activate', setupIntentId: aliceSetupIntentId });
    expect(again.status).toBe(200);
    expect(again.body.subscriptionId).toBe(aliceTrialSubscriptionId);
    expect((await listAll(aliceCustomerId)).length).toBe(1);

    const overview = await call(overviewHandler, alice, 'GET');
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.subscription.planId).toBe('monthly');
    expect(overview.body.subscription.status).toBe('trialing');
    expect(overview.body.trialEligible).toBe(false);
    expect(overview.body.paymentMethod?.last4).toBe('4242');
  });

  it('b) webhook : les vrais évènements signés passent (200), setup_intent.succeeded rejoué ne crée rien', async () => {
    const events = await eventsFor(aliceCustomerId, ['setup_intent.succeeded', 'customer.subscription.created']);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = await postWebhook(event as unknown as Parameters<typeof postWebhook>[0]);
      expect(result.status, `${event.type} ${JSON.stringify(result.body)}`).toBe(200);
    }

    // Même SetupIntent sous un nouvel identifiant d'évènement : pas de filtre
    // des relivraisons, c'est l'idempotence de l'activation qui est testée.
    const setupIntent = await stripe.setupIntents.retrieve(aliceSetupIntentId);
    const replay = await postWebhook(forgeEvent('setup_intent.succeeded', setupIntent));
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const subscriptions = await listAll(aliceCustomerId);
    expect(subscriptions.map((subscription) => subscription.id)).toEqual([aliceTrialSubscriptionId]);

    // Signature fausse : refusée.
    const { res, captured } = makeRes();
    await webhookHandler(makeReq('POST', { 'stripe-signature': 't=1,v1=00' }, undefined, JSON.stringify(forgeEvent('invoice.paid', {}))), res);
    expect(captured.status).toBe(400);
  });

  it('c) résiliation : cancel → fin d’échéance + e-mail de confirmation ; resume', async () => {
    fake.mails.length = 0;
    const cancel = await call(subscriptionHandler, alice, 'POST', { action: 'cancel' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.subscription.cancelAtPeriodEnd).toBe(true);

    const subscription = await stripe.subscriptions.retrieve(aliceTrialSubscriptionId);
    expect(subscription.cancel_at_period_end || subscription.cancel_at != null).toBe(true);

    const events = await eventsFor(aliceCustomerId, ['customer.subscription.updated']);
    const cancelEvent = [...events]
      .reverse()
      .find((event) => {
        if (event.type !== 'customer.subscription.updated') return false;
        const object = event.data.object as Stripe.Subscription;
        return object.cancel_at_period_end || object.cancel_at != null;
      });
    expect(cancelEvent, 'customer.subscription.updated de la résiliation').toBeTruthy();
    const result = await postWebhook(cancelEvent as unknown as Parameters<typeof postWebhook>[0]);
    expect(result.status).toBe(200);

    const mail = fake.mails.find((entry) => entry.kind === 'canceled');
    expect(mail, `previous_attributes: ${JSON.stringify((cancelEvent as Stripe.CustomerSubscriptionUpdatedEvent).data.previous_attributes)}`).toBeTruthy();
    expect(mail!.args.to).toBe(alice.email);
    const expectedEnd = new Date(((subscription.cancel_at ?? subscription.items.data[0].current_period_end) as number) * 1000)
      .toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' });
    expect(mail!.args.endDate).toBe(expectedEnd);
    expect(mail!.args.planLabel).toBe('formule 1 mois');

    const resume = await call(subscriptionHandler, alice, 'POST', { action: 'resume' });
    expect(resume.status, JSON.stringify(resume.body)).toBe(200);
    expect(resume.body.subscription.cancelAtPeriodEnd).toBe(false);
    const resumed = await stripe.subscriptions.retrieve(aliceTrialSubscriptionId);
    expect(resumed.cancel_at_period_end).toBe(false);
    expect(resumed.cancel_at).toBeNull();
  });

  it('d) trial_will_end → e-mail de fin d’essai à 14,90 €', async () => {
    fake.mails.length = 0;
    const subscription = await stripe.subscriptions.retrieve(aliceTrialSubscriptionId);
    const result = await postWebhook(forgeEvent('customer.subscription.trial_will_end', subscription));
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const mail = fake.mails.find((entry) => entry.kind === 'trialEnding');
    expect(mail, 'sendTrialEndingEmail appelé').toBeTruthy();
    expect(mail!.args.to).toBe(alice.email);
    expect(plain(mail!.args.amount)).toBe('14,90 €');
    const expectedCharge = new Date(subscription.trial_end! * 1000)
      .toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' });
    expect(mail!.args.chargeDate).toBe(expectedCharge);
  });

  it('e) sans essai (essai déjà consommé) : start → paiement, confirmé → actif', async () => {
    await stripe.subscriptions.cancel(aliceTrialSubscriptionId);

    const start = await call(subscriptionHandler, alice, 'POST', { action: 'start', planId: 'monthly' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.intent).toBe('payment');
    expect(start.body.clientSecret).toMatch(/^pi_.+_secret_/);
    const paymentIntentId = String(start.body.clientSecret).split('_secret_')[0];

    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: 'pm_card_visa',
      return_url: `${ORIGIN}/?tab=subscription`,
    });
    expect(confirmed.status).toBe('succeeded');

    let status = '';
    for (let attempt = 0; attempt < 10 && status !== 'active'; attempt++) {
      const sync = await call(subscriptionHandler, alice, 'POST', { action: 'sync', subscriptionId: start.body.subscriptionId });
      expect(sync.status, JSON.stringify(sync.body)).toBe(200);
      status = sync.body.subscription.status;
      if (status !== 'active') await sleep(1000);
    }
    expect(status).toBe('active');

    const overview = await call(overviewHandler, alice, 'GET');
    expect(overview.body.subscription.status).toBe('active');
    expect(overview.body.trialEligible).toBe(false);

    // Deuxième souscription alors qu'une est vivante : refusée.
    const twice = await call(subscriptionHandler, alice, 'POST', { action: 'start', planId: 'annual' });
    expect(twice.status).toBe(409);
  });

  it('f) portail : session simple et confirmation du passage à 1 an', async () => {
    const plainPortal = await call(portalHandler, alice, 'POST', {});
    expect(plainPortal.status, JSON.stringify(plainPortal.body)).toBe(200);
    expect(plainPortal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);

    const annual = await call(portalHandler, alice, 'POST', { planId: 'annual' });
    expect(annual.status, JSON.stringify(annual.body)).toBe(200);
    expect(annual.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);

    const same = await call(portalHandler, alice, 'POST', { planId: 'monthly' });
    expect(same.status).toBe(409);
  });

  it('g) 3-D Secure : SetupIntent en requires_action, activate → 409', async () => {
    const start = await call(subscriptionHandler, carol, 'POST', { action: 'start', planId: 'semiannual' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.intent).toBe('setup');
    const setupIntent = await stripe.setupIntents.retrieve(start.body.setupIntentId);
    createdCustomers.add(typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer!.id);

    const confirmed = await stripe.setupIntents.confirm(start.body.setupIntentId, {
      payment_method: 'pm_card_authenticationRequired',
      return_url: `${ORIGIN}/?tab=subscription`,
    });
    expect(confirmed.status).toBe('requires_action');

    const activate = await call(subscriptionHandler, carol, 'POST', { action: 'activate', setupIntentId: start.body.setupIntentId });
    expect(activate.status).toBe(409);
    expect(activate.body.error).toBe('The payment method is not confirmed yet.');
  });

  it('auth : sans jeton → 401, jeton inconnu → 401', async () => {
    const { res, captured } = makeRes();
    await subscriptionHandler(makeReq('POST', {}, { action: 'cancel' }), res);
    expect(captured.status).toBe(401);
    const unknown = await call(subscriptionHandler, { jwt: 'nope' }, 'POST', { action: 'cancel' });
    expect(unknown.status).toBe(401);
  });
});
