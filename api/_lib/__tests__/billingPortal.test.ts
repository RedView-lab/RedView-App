import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Configuration du portail client Stripe (A11-3, audit du 2026-10-10) :
 * l'adresse qui reçoit les reçus a une seule source de vérité, le réglage de
 * l'app (`customers.billing_email_mode`), qui réécrit l'e-mail Stripe à chaque
 * changement d'adresse du compte. Le portail ne doit donc pas permettre de le
 * modifier — et une configuration déjà créée qui le permettait est remise
 * d'accord, même quand les prix n'ont pas changé.
 */

type Configuration = { id: string; metadata: Record<string, string>; features: { customer_update: { allowed_updates: string[] } } };

const stripe = vi.hoisted(() => ({
  configurations: [] as Configuration[],
  created: 0,
  updated: [] as string[],
}));

vi.mock('../billing/prices', () => ({
  getCatalogPrices: async () => ({
    productId: 'prod_redview',
    prices: { monthly: { id: 'price_m' }, semiannual: { id: 'price_s' }, annual: { id: 'price_y' } },
  }),
}));

vi.mock('../stripe', () => ({
  getStripeServer: () => ({
    billingPortal: {
      configurations: {
        list: async () => ({ data: stripe.configurations }),
        create: async (params: Omit<Configuration, 'id'>) => {
          stripe.created += 1;
          const configuration = { ...params, id: `bpc_${stripe.created}` };
          stripe.configurations.push(configuration);
          return configuration;
        },
        update: async (id: string, params: Omit<Configuration, 'id'>) => {
          stripe.updated.push(id);
          const configuration = stripe.configurations.find((candidate) => candidate.id === id)!;
          Object.assign(configuration, params);
          return configuration;
        },
      },
    },
  }),
}));

// Dépendances de la session du portail, hors sujet ici (et lourdes à importer).
vi.mock('../billing/customers', () => ({ getStripeCustomerId: async () => null }));
vi.mock('../billing/subscriptions', () => ({ getLiveStripeSubscription: async () => null }));

const { ensurePortalConfiguration } = await import('../billing/portal');
let secretKey = 0;

/** Le module garde la configuration 10 min par clé Stripe : une clé neuve par appel la fait relire. */
async function ensure(): Promise<string> {
  vi.stubEnv('STRIPE_SECRET_KEY', `sk_test_${++secretKey}`);
  return ensurePortalConfiguration('https://app.test/?tab=subscription');
}

describe('portail Stripe — adresse de facturation (A11-3)', () => {
  beforeEach(() => {
    stripe.configurations = [];
    stripe.created = 0;
    stripe.updated = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('une nouvelle configuration ne laisse pas modifier l’e-mail du client', async () => {
    await ensure();
    expect(stripe.created).toBe(1);
    const allowed = stripe.configurations[0]!.features.customer_update.allowed_updates;
    expect(allowed).not.toContain('email');
    expect(allowed).toEqual(expect.arrayContaining(['name', 'address', 'tax_id']));
  });

  it('une ancienne configuration qui le permettait est mise à jour, prix inchangés', async () => {
    // Prix déjà d'accord (même grille) : seul le contenu de la configuration a changé.
    const pricesKey = 'price_m,price_s,price_y';
    stripe.configurations.push({
      id: 'bpc_old',
      metadata: { redview_portal: '1', prices: pricesKey },
      features: { customer_update: { allowed_updates: ['email', 'name', 'address', 'tax_id'] } },
    });
    const id = await ensure();
    expect(id).toBe('bpc_old');
    expect(stripe.created).toBe(0);
    expect(stripe.updated).toEqual(['bpc_old']);
    expect(stripe.configurations[0]!.features.customer_update.allowed_updates).not.toContain('email');
  });

  it('une configuration à jour n’est pas réécrite', async () => {
    await ensure();
    await ensure();
    expect(stripe.created).toBe(1);
    expect(stripe.updated).toEqual([]);
  });
});
