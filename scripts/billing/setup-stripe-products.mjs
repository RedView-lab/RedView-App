import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';

const envPath = path.resolve(process.cwd(), '.env');

if (!fs.existsSync(envPath)) {
  console.error('[stripe-setup] Le fichier .env est introuvable.');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');

function getEnvValue(key) {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

const secretKey = getEnvValue('STRIPE_SECRET_KEY');

if (!secretKey || secretKey === 'sk_test_xxx' || secretKey === 'sk_live_xxx') {
  console.error('[stripe-setup] Veuillez d\'abord renseigner STRIPE_SECRET_KEY dans votre fichier .env');
  process.exit(1);
}

const stripe = new Stripe(secretKey);

async function main() {
  console.log('[stripe-setup] Connexion à Stripe réussie...');

  // 1. Pass Fondateur (5 €)
  console.log('[stripe-setup] Création du produit Pass Fondateur (5 €)...');
  const founderProduct = await stripe.products.create({
    name: 'Pass Fondateur',
    description: 'Accès complet et avantages Fondateur à vie RedView',
    metadata: { plan_id: 'founder' },
  });

  const founderPrice = await stripe.prices.create({
    product: founderProduct.id,
    unit_amount: 500, // 5.00 EUR
    currency: 'eur',
    recurring: { interval: 'year' },
    metadata: { plan_id: 'founder' },
  });

  console.log(`[stripe-setup] Pass Fondateur créé : ${founderPrice.id}`);

  // 2. Mécène & Soutien Majeur (15 €)
  console.log('[stripe-setup] Création du produit Mécène & Soutien Majeur (15 €)...');
  const patronProduct = await stripe.products.create({
    name: 'Mécène & Soutien Majeur',
    description: 'Don libre de soutien avec accès VIP RedView',
    metadata: { plan_id: 'patron' },
  });

  const patronPrice = await stripe.prices.create({
    product: patronProduct.id,
    unit_amount: 1500, // 15.00 EUR
    currency: 'eur',
    recurring: { interval: 'year' },
    metadata: { plan_id: 'patron' },
  });

  console.log(`[stripe-setup] Mécène créé : ${patronPrice.id}`);

  // 3. Mise à jour du fichier .env
  let updatedEnv = envContent;

  const replaceOrAppend = (key, value) => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(updatedEnv)) {
      updatedEnv = updatedEnv.replace(regex, `${key}=${value}`);
    } else {
      updatedEnv += `\n${key}=${value}`;
    }
  };

  replaceOrAppend('STRIPE_PRICE_ID_FOUNDER', founderPrice.id);
  replaceOrAppend('STRIPE_PRICE_ID_PATRON', patronPrice.id);
  replaceOrAppend('VITE_STRIPE_PRICE_ID_FOUNDER', founderPrice.id);
  replaceOrAppend('VITE_STRIPE_PRICE_ID_PATRON', patronPrice.id);

  fs.writeFileSync(envPath, updatedEnv, 'utf8');
  console.log('[stripe-setup] Fichier .env mis à jour avec succès avec les Price IDs !');
  console.log(`- STRIPE_PRICE_ID_FOUNDER=${founderPrice.id}`);
  console.log(`- STRIPE_PRICE_ID_PATRON=${patronPrice.id}`);
}

main().catch((err) => {
  console.error('[stripe-setup] Erreur lors de la configuration Stripe :', err);
  process.exit(1);
});
