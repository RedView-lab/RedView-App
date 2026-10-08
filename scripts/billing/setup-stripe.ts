// ---------------------------------------------------------------------------
// Met le compte Stripe (bac à sable par défaut) d'accord avec la grille
// tarifaire d'api/_lib/billing/plans.ts. Idempotent : relancé, il ne crée que
// ce qui manque ou a changé.
//
//   npx tsx scripts/billing/setup-stripe.ts                    # bac à sable (sk_test_)
//   npx tsx scripts/billing/setup-stripe.ts --webhook-url=https://app.redview.tech/api/stripe/webhook
//   npx tsx scripts/billing/setup-stripe.ts --live             # production : à faire exprès
//
//  1. Produit « RedView » (retrouvé par sa métadonnée).
//  2. Trois prix récurrents TTC, retrouvés par `lookup_key` ; un montant changé
//     donne un nouveau prix qui reprend la clé, l'ancien est archivé (les
//     abonnés existants le gardent jusqu'à ce qu'on les migre).
//  3. Moyens de paiement proposés (configuration « RedView abonnements » :
//     carte, Link, PayPal et SEPA quand le compte les a activés ; le reste
//     — BLIK, Pix, Klarna… — coupé) et configuration du portail client.
//  4. Avec --webhook-url : point de terminaison abonné aux évènements traités
//     par api/stripe/webhook.ts. Son secret n'est affiché qu'à la création :
//     le mettre dans STRIPE_WEBHOOK_SECRET de l'environnement qui reçoit.
//     En local : `stripe listen --forward-to localhost:5173/api/stripe/webhook`.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

import { BILLING_CURRENCY, BILLING_PLANS, BILLING_PRODUCT_LOOKUP } from '../../api/_lib/billing/plans.ts';
import { describePriceMismatch } from '../../api/_lib/billing/prices.ts';
import {
  PAYMENT_METHOD_CONFIGURATION_NAME,
  SUBSCRIPTION_PAYMENT_METHODS,
} from '../../api/_lib/billing/paymentMethodConfig.ts';
import { ensurePortalConfiguration } from '../../api/_lib/billing/portal.ts';
import { WEBHOOK_EVENTS } from '../../api/_lib/billing/webhookEvents.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // Variables déjà dans l'environnement.
}

const args = process.argv.slice(2);
const live = args.includes('--live');
const webhookUrl = args.find((arg) => arg.startsWith('--webhook-url='))?.slice('--webhook-url='.length) ?? null;

const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
if (!/^(sk|rk)_(test|live)_/.test(secretKey)) {
  console.error('[stripe-setup] STRIPE_SECRET_KEY manquante ou invalide dans .env');
  process.exit(1);
}
if (secretKey.includes('_live_') && !live) {
  console.error('[stripe-setup] Clé de production détectée : relancer avec --live pour modifier le compte réel.');
  process.exit(1);
}

const stripe = new Stripe(secretKey);
const mode = secretKey.includes('_live_') ? 'PRODUCTION' : 'bac à sable';

async function ensureProduct(): Promise<Stripe.Product> {
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata?.[BILLING_PRODUCT_LOOKUP.metadataKey] === BILLING_PRODUCT_LOOKUP.metadataValue) {
      if (!product.active) return stripe.products.update(product.id, { active: true });
      console.log(`[stripe-setup] Produit existant : ${product.id}`);
      return product;
    }
  }
  const product = await stripe.products.create({
    name: BILLING_PRODUCT_LOOKUP.name,
    description: 'Abonnement RedView : planification 3D, LiDAR, météo et routage.',
    metadata: { [BILLING_PRODUCT_LOOKUP.metadataKey]: BILLING_PRODUCT_LOOKUP.metadataValue },
  });
  console.log(`[stripe-setup] Produit créé : ${product.id}`);
  return product;
}

async function ensurePrices(product: Stripe.Product): Promise<void> {
  for (const plan of BILLING_PLANS) {
    const existing = (await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 1 })).data[0];
    const productId = existing ? (typeof existing.product === 'string' ? existing.product : existing.product.id) : null;
    if (existing && productId === product.id && !describePriceMismatch(plan.id, existing) && existing.tax_behavior === 'inclusive') {
      console.log(`[stripe-setup] ${plan.lookupKey} : ${existing.id} (à jour)`);
      continue;
    }

    const price = await stripe.prices.create({
      product: product.id,
      currency: BILLING_CURRENCY,
      unit_amount: plan.amountCents,
      // Prix affichés TTC : la TVA éventuelle est incluse, jamais ajoutée.
      tax_behavior: 'inclusive',
      recurring: { interval: plan.interval, interval_count: plan.intervalCount },
      lookup_key: plan.lookupKey,
      transfer_lookup_key: true,
      nickname: `RedView ${plan.id}`,
      metadata: { plan_id: plan.id },
    });
    console.log(`[stripe-setup] ${plan.lookupKey} : ${price.id} créé (${plan.amountCents / 100} €)`);
    if (existing) {
      await stripe.prices.update(existing.id, { active: false });
      console.log(`[stripe-setup]   ancien prix ${existing.id} archivé`);
    }
  }
}

type DisplayPreferenceParams = Record<string, { display_preference: { preference: 'on' | 'off' } }>;

/**
 * Configuration des moyens de paiement : chaque moyen que connaît la
 * configuration par défaut du compte est coupé, sauf ceux d'un abonnement en
 * euros. Un moyen voulu que le compte refuse (pas encore activé) est retiré
 * de la demande et signalé : il suffira de relancer le script après l'avoir
 * activé dans le Dashboard.
 */
async function ensurePaymentMethodConfiguration(): Promise<void> {
  const configurations = (await stripe.paymentMethodConfigurations.list({ limit: 100 })).data;
  const defaultConfiguration = configurations.find((entry) => entry.is_default);
  const existing = configurations.find((entry) => entry.name === PAYMENT_METHOD_CONFIGURATION_NAME);

  // Seuls les moyens que le compte propose réellement peuvent être réglés
  // (un moyen indisponible, comme afterpay_clearpay, est refusé même « off »).
  const known = new Set<string>(SUBSCRIPTION_PAYMENT_METHODS);
  for (const configuration of [defaultConfiguration, existing]) {
    for (const [key, value] of Object.entries(configuration ?? {})) {
      if (value && typeof value === 'object' && (value as { available?: boolean }).available === true) known.add(key);
    }
  }
  const wanted = new Set<string>(SUBSCRIPTION_PAYMENT_METHODS);
  const preferences: DisplayPreferenceParams = {};
  for (const method of known) {
    preferences[method] = { display_preference: { preference: wanted.has(method) ? 'on' : 'off' } };
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const configuration = existing
        ? await stripe.paymentMethodConfigurations.update(existing.id, {
            ...preferences,
            active: true,
          } as Parameters<typeof stripe.paymentMethodConfigurations.update>[1])
        : await stripe.paymentMethodConfigurations.create({
            ...preferences,
            name: PAYMENT_METHOD_CONFIGURATION_NAME,
          } as Parameters<typeof stripe.paymentMethodConfigurations.create>[0]);
      const available = SUBSCRIPTION_PAYMENT_METHODS.filter(
        (method) => (configuration as unknown as Record<string, { available?: boolean } | undefined>)[method]?.available,
      );
      console.log(`[stripe-setup] Moyens de paiement : ${configuration.id} (disponibles : ${available.join(', ') || 'aucun'})`);
      const missing = SUBSCRIPTION_PAYMENT_METHODS.filter((method) => !available.includes(method));
      if (missing.length) console.log(`[stripe-setup]   à activer dans le Dashboard si voulu : ${missing.join(', ')} (puis relancer)`);
      return;
    } catch (error) {
      // Moyen refusé par le compte : nommé dans `param` (« paypal[display_preference]… »)
      // ou dans le message (« `afterpay_clearpay` is not available to this merchant »).
      const { param = '', message = '' } = (error ?? {}) as { param?: string; message?: string };
      const named = param.split('[')[0] || /`([a-z_]+)`/.exec(message)?.[1] || '';
      if (!named || named === 'card' || !preferences[named]) throw error;
      console.log(`[stripe-setup]   ${named} refusé par le compte : retiré de la configuration`);
      delete preferences[named];
    }
  }
}

async function ensureWebhook(url: string): Promise<void> {
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (endpoint.url !== url) continue;
    await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: [...WEBHOOK_EVENTS], disabled: false });
    console.log(`[stripe-setup] Webhook existant mis à jour : ${endpoint.id} (secret inchangé)`);
    return;
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...WEBHOOK_EVENTS],
    description: 'RedView — abonnements',
  });
  console.log(`[stripe-setup] Webhook créé : ${endpoint.id}`);
  console.log(`[stripe-setup] STRIPE_WEBHOOK_SECRET=${endpoint.secret}  ← à mettre dans l'environnement de ${url}`);
}

async function main(): Promise<void> {
  console.log(`[stripe-setup] Compte Stripe : ${mode}`);
  const product = await ensureProduct();
  await ensurePrices(product);
  await ensurePaymentMethodConfiguration();

  const appBase = (process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech').replace(/\/+$/, '');
  const configuration = await ensurePortalConfiguration(`${appBase}/?tab=subscription`);
  console.log(`[stripe-setup] Portail client : ${configuration}`);

  if (webhookUrl) await ensureWebhook(webhookUrl);
  else console.log('[stripe-setup] Webhook : --webhook-url=<url> pour créer le point de terminaison (en local : stripe listen).');

  console.log('[stripe-setup] Terminé. Évènements du webhook :', WEBHOOK_EVENTS.join(', '));
}

main().catch((error: unknown) => {
  console.error('[stripe-setup] Échec :', error);
  process.exit(1);
});
