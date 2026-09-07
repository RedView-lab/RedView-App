import type Stripe from 'stripe';
import { Query } from 'node-appwrite';

import {
  APPWRITE_DATABASE_ID,
  CUSTOMERS_COLLECTION_ID,
  getAppwriteDatabases,
} from '../appwrite.js';
import { getStripeServer } from '../stripe.js';
import type { CustomerRow } from './types.js';

function isMissingStripeCustomerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: string;
    param?: string;
    message?: string;
  };

  return (
    candidate.code === 'resource_missing' &&
    (candidate.param === 'customer' ||
      candidate.message?.toLowerCase().includes('no such customer') === true)
  );
}

export function isStripeCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.Customer {
  return !customer.deleted;
}

async function createAndStoreStripeCustomer(userId: string, email: string | null): Promise<string> {
  const customer = await getStripeServer().customers.create({
    ...(email ? { email } : {}),
    metadata: { appwrite_user_id: userId },
  });

  const db = getAppwriteDatabases();
  try {
    await db.createDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, {
      user_id: userId,
      stripe_customer_id: customer.id,
    });
  } catch (error: any) {
    if (error?.code === 409) {
      await db.updateDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId, {
        stripe_customer_id: customer.id,
      });
    } else {
      throw error;
    }
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
    if (isMissingStripeCustomerError(error)) {
      return null;
    }

    throw error;
  }
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const db = getAppwriteDatabases();

  try {
    const existing = await db.getDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId);
    if (existing?.stripe_customer_id && typeof existing.stripe_customer_id === 'string') {
      const validatedCustomerId = await getValidatedStripeCustomerId(existing.stripe_customer_id);
      if (validatedCustomerId) {
        return validatedCustomerId;
      }
    }
  } catch (error: any) {
    if (error?.code !== 404) {
      throw error;
    }
  }

  return createAndStoreStripeCustomer(userId, email);
}

export async function getCustomerRow(userId: string): Promise<CustomerRow | null> {
  const db = getAppwriteDatabases();
  try {
    const doc = await db.getDocument(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, userId);
    return {
      stripe_customer_id: (doc.stripe_customer_id as string) ?? null,
      billing_email_mode: (doc.billing_email_mode as string) ?? null,
      billing_email: (doc.billing_email as string) ?? null,
    };
  } catch (error: any) {
    if (error?.code === 404) {
      return null;
    }
    throw error;
  }
}

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const row = await getCustomerRow(userId);
  if (!row?.stripe_customer_id) {
    return null;
  }

  return getValidatedStripeCustomerId(row.stripe_customer_id);
}

export async function getUserIdFromCustomer(stripeCustomerId: string): Promise<string | null> {
  const db = getAppwriteDatabases();
  try {
    const result = await db.listDocuments(APPWRITE_DATABASE_ID, CUSTOMERS_COLLECTION_ID, [
      Query.equal('stripe_customer_id', stripeCustomerId),
      Query.limit(1),
    ]);

    const first = result.documents[0];
    return (first?.user_id as string) ?? null;
  } catch (error) {
    console.warn('[customers] getUserIdFromCustomer failed', error);
    return null;
  }
}