import type Stripe from 'stripe';
import { Query } from 'node-appwrite';

import {
  APPWRITE_DATABASE_ID,
  CUSTOMERS_COLLECTION_ID,
  getAppwriteDatabases,
  getAppwriteUsers,
} from '../appwrite.js';
import { getStripeServer } from '../stripe.js';
import { DELETION_PENDING_LABEL } from '../accountLabels.js';
import type { CustomerRow } from './types.js';

function appwriteCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

function isMissingStripeCustomerError(error: unknown): boolean {
  const candidate = error as { code?: unknown; param?: unknown; message?: unknown } | null;
  return (
    candidate?.code === 'resource_missing' &&
    (candidate.param === 'customer' ||
      (typeof candidate.message === 'string' && candidate.message.toLowerCase().includes('no such customer')))
  );
}

export function isStripeCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.Customer {
  return !customer.deleted;
}

/** E-mail où Stripe envoie reçus et factures : l'adresse choisie, sinon celle du compte. */
export function billingEmailFor(row: CustomerRow | null, accountEmail: string | null): string | null {
  if (row?.billing_email_mode === 'alternative' && row.billing_email?.trim()) return row.billing_email.trim();
  return accountEmail?.trim() || null;
}

async function createAndStoreStripeCustomer(
  userId: string,
  email: string | null,
  replacedCustomerId: string | null,
): Promise<string> {
  const customer = await getStripeServer().customers.create(
    {
      ...(email ? { email } : {}),
      preferred_locales: ['fr'],
      metadata: { appwrite_user_id: userId },
    },
    // Deux requêtes simultanées ne créent qu'un client (sinon l'abonnement
    // pourrait naître sur celui que la ligne Appwrite ne retient pas). La clé
    // change avec le client remplacé : un client supprimé n'est jamais rendu.
    { idempotencyKey: `redview-customer-${userId}-${replacedCustomerId ?? 'none'}` },
  );

  const db = getAppwriteDatabases();
  try {
    await db.createDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, {
      user_id: userId,
      stripe_customer_id: customer.id,
    });
  } catch (error) {
    if (appwriteCode(error) !== 409) throw error;
    await db.updateDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, {
      stripe_customer_id: customer.id,
    });
  }

  return customer.id;
}

export async function getValidatedStripeCustomerId(
  stripeCustomerId: string,
): Promise<string | null> {
  try {
    const customer = await getStripeServer().customers.retrieve(stripeCustomerId);
    return customer.deleted ? null : customer.id;
  } catch (error) {
    if (isMissingStripeCustomerError(error)) return null;
    throw error;
  }
}

export async function getCustomerRow(userId: string): Promise<CustomerRow | null> {
  const db = getAppwriteDatabases();
  try {
    const doc = await db.getDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId);
    return {
      stripe_customer_id: typeof doc.stripe_customer_id === 'string' && doc.stripe_customer_id ? doc.stripe_customer_id : null,
      billing_email_mode: typeof doc.billing_email_mode === 'string' ? doc.billing_email_mode : null,
      billing_email: typeof doc.billing_email === 'string' ? doc.billing_email : null,
    };
  } catch (error) {
    if (appwriteCode(error) === 404) return null;
    throw error;
  }
}

/**
 * Client Stripe du compte, créé au besoin. Un client supprimé côté Stripe (ou
 * d'un autre compte Stripe : bac à sable ↔ production) est remplacé.
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  accountEmail: string | null,
): Promise<string> {
  const row = await getCustomerRow(userId);
  if (row?.stripe_customer_id) {
    const validated = await getValidatedStripeCustomerId(row.stripe_customer_id);
    if (validated) return validated;
  }
  return createAndStoreStripeCustomer(userId, billingEmailFor(row, accountEmail), row?.stripe_customer_id ?? null);
}

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const row = await getCustomerRow(userId);
  if (!row?.stripe_customer_id) return null;
  return getValidatedStripeCustomerId(row.stripe_customer_id);
}

/**
 * Compte RedView d'un client Stripe, null s'il n'y en a pas, s'il est supprimé
 * ou en cours de suppression : la suppression du client Stripe déclenche
 * `customer.subscription.deleted`, et un webhook arrivé pendant la purge
 * recréait la ligne `subscriptions` d'un compte effacé (A2-2). Lève sur une
 * erreur d'Appwrite : le webhook répond alors 500 et Stripe relivre
 * l'évènement, au lieu de le perdre.
 */
export async function getUserIdFromCustomer(stripeCustomerId: string): Promise<string | null> {
  const db = getAppwriteDatabases();
  const result = await db.listDocuments(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, [
    Query.equal('stripe_customer_id', stripeCustomerId),
    Query.limit(1),
  ]);
  const userId = result.documents[0]?.user_id;
  if (typeof userId !== 'string' || !userId) return null;
  try {
    const user = await getAppwriteUsers().get(userId);
    if (Array.isArray(user.labels) && user.labels.includes(DELETION_PENDING_LABEL)) return null;
  } catch (error) {
    if (appwriteCode(error) === 404) return null;
    throw error;
  }
  return userId;
}
